import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from './source-client.js';
import { parsePage, entryPath } from './adapter.js';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { SnapshotRepository } from './snapshot-repository.js';
import { BatchService } from './batch-service.js';
import { readOperations, readBatchOperations } from './operations.js';

const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'collection-acceptance-'));
try {
  const page = parsePage(await new SourceClient(source.url).read(entryPath));
  assert.ok(page.records.length > 0, '初始来源须有可接收的业务记录');
  const path = join(directory, 'records.json');
  const repository = new RecordRepository(path);
  const first = await new CollectionService(repository).ingest(page.records);
  assert.equal(first.accepted, page.records.length);
  const stored = await repository.read();
  const reopened = new RecordRepository(path);
  assert.deepEqual(await new CollectionService(reopened).query({}), stored, '重新打开后读取同一份业务记录');
  const second = await new CollectionService(reopened).ingest(page.records);
  assert.equal(second.stored, stored.length, '重放首批记录不重复保存');
  const operations = await readOperations(reopened);
  assert.deepEqual(operations.rows.map(row => row.sourceId), stored.map(row => row.sourceId));
  for (const row of operations.rows) {
    const original = stored.find(record => record.sourceId === row.sourceId);
    assert.equal(row.source, original.source);
    assert.equal(row.observedAt, original.observedAt);
    for (const [field, value] of Object.entries(row.attributes)) assert.deepEqual(value, original.attributes[field] ?? null);
  }

  // 批次接入生命周期：完整批次提升、分页失败保留上次结果、新批次重新对账。
  const snapshotPath = join(directory, 'snapshots.json');
  const batchService = new BatchService(new SourceClient(source.url), new SnapshotRepository(snapshotPath));
  const opening = await batchService.collect();
  assert.equal(opening.complete, true);
  assert.equal(opening.promoted, true);
  assert.deepEqual(opening.coverage.unconfirmedWarehouses, []);

  source.publish('incomplete');
  const failed = await batchService.collect();
  assert.equal(failed.complete, false);
  assert.equal(failed.promoted, false);
  assert.deepEqual(failed.coverage.unconfirmedWarehouses, ['W2']);
  const afterFailure = new SnapshotRepository(snapshotPath);
  assert.equal((await afterFailure.readActive()).batch, 'B1', '分页失败须保留上次完整批次');
  const keptBatch = (await afterFailure.readActive()).batch;
  const blockedView = await readBatchOperations(afterFailure);
  assert.equal(blockedView.batch, 'B1');
  assert.ok(blockedView.coverage.warehouses.find((w) => w.warehouse === 'W1'));

  source.publish('updated');
  const recovered = await batchService.collect();
  assert.equal(recovered.complete, true);
  assert.equal(recovered.previousBatch, 'B1');
  const afterRecovery = new SnapshotRepository(snapshotPath);
  const active = await afterRecovery.readActive();
  assert.equal(active.batch, 'B2');
  assert.deepEqual(active.records.map((record) => record.sourceId), ['S1|A-100|W1', 'S1|A-100|W2']);
  const view = await readBatchOperations(afterRecovery);
  assert.equal(view.rows.length, 2);
  assert.deepEqual(view.coverage.unconfirmedWarehouses, []);

  console.log(JSON.stringify({
    accepted: first.accepted,
    persisted: stored.length,
    replayStored: second.stored,
    operationRows: operations.rows.length,
    openingBatch: opening.batch,
    failedBatchKept: keptBatch,
    recoveredBatch: active.batch,
    recoveredRows: view.rows.length,
    status: 'ok',
  }));
} finally {
  await source.close();
  await rm(directory, {recursive: true, force: true});
}
