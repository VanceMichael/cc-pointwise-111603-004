import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from './source-client.js';
import { parsePage, entryPath } from './adapter.js';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { readOperations } from './operations.js';

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

  // Whole supplier batch: both warehouses of the same SKU stay separate.
  const service = new CollectionService(reopened);
  const client = new SourceClient(source.url);
  const collected = await service.ingestSupplier(client, { supplier: 'S1' });
  assert.equal(collected.complete, true);
  assert.equal(collected.stored, 2);
  source.publish('incomplete');
  const failed = await service.ingestSupplier(client, { supplier: 'S1' });
  assert.equal(failed.complete, false);
  assert.deepEqual(failed.unconfirmedWarehouses, ['W2']);
  const operations = await readOperations(reopened);
  assert.equal(operations.batch, 'B1', '失败的分页保留上次完整批次');
  assert.deepEqual(operations.rows.map((row) => row.sourceId), ['A-100', 'A-100']);
  assert.deepEqual(operations.rows.map((row) => row.attributes.quantity), [8, 13]);
  for (const row of operations.rows) {
    assert.equal(row.source, '供应商库存观察器');
    assert.ok(row.observedAt);
  }
  console.log(JSON.stringify({
    accepted: first.accepted,
    persisted: stored.length,
    replayStored: second.stored,
    batch: operations.batch,
    operationRows: operations.rows.length,
    lastAttempt: {batch: failed.batch, status: failed.status, unconfirmedWarehouses: failed.unconfirmedWarehouses},
    status: 'ok',
  }));
} finally {
  await source.close();
  await rm(directory, {recursive: true, force: true});
}
