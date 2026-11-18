import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from '../src/source-client.js';
import { parsePage, parseManifest, manifestPath } from '../src/adapter.js';
import { SnapshotRepository } from '../src/snapshot-repository.js';
import { BatchService } from '../src/batch-service.js';
import { readBatchOperations } from '../src/operations.js';

const scenarioPath = new URL('../fixtures/source.json', import.meta.url);

async function harness(stage) {
  const source = await startSource(scenarioPath);
  source.publish(stage);
  const directory = await mkdtemp(join(tmpdir(), 'batch-test-'));
  const snapshots = new SnapshotRepository(join(directory, 'snapshots.json'));
  const service = new BatchService(new SourceClient(source.url), snapshots);
  return {
    source,
    snapshots,
    service,
    async cleanup() { await source.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test('完整批次按 supplier/sku/warehouse 组织并提升为采购快照', async () => {
  const h = await harness('opening');
  try {
    const result = await h.service.collect();
    assert.equal(result.complete, true);
    assert.equal(result.promoted, true);
    assert.deepEqual(result.coverage.unconfirmedWarehouses, []);
    const state = await h.snapshots.readState();
    assert.equal(state.active.batch, 'B1');
    // 同一 SKU 在两个仓库各占一行，后读到的 W2 不覆盖 W1。
    assert.deepEqual(state.active.records.map((r) => r.sourceId), ['S1|A-100|W1', 'S1|A-100|W2']);
    assert.deepEqual(
      state.active.records.map((r) => r.attributes.quantity),
      [8, 13],
    );
    const view = await readBatchOperations(h.snapshots);
    assert.equal(view.status, 'complete');
    assert.deepEqual(view.coverage.warehouses.map((w) => w.status), ['data', 'data']);
    assert.deepEqual(view.rows.map((row) => row.attributes.warehouse), ['W1', 'W2']);
  } finally { await h.cleanup(); }
});

test('分页失败的半次抓取不提升，上次完整结果保留且未确认仓库可见', async () => {
  const h = await harness('opening');
  try {
    await h.service.collect();
    h.source.publish('incomplete');
    const result = await h.service.collect();
    assert.equal(result.complete, false);
    assert.equal(result.promoted, false);
    assert.ok(result.reasons.includes('page-failures'));
    assert.deepEqual(result.coverage.unconfirmedWarehouses, ['W2']);
    const missing = result.coverage.warehouses.find((w) => w.warehouse === 'W2');
    assert.equal(missing.status, 'missing');
    assert.match(missing.failure, /503/);
    const state = await h.snapshots.readState();
    // 业务快照仍是上一完整批次 B1，失败尝试只进 attempts。
    assert.equal(state.active.batch, 'B1');
    assert.equal(state.attempts.length, 2);
    assert.equal(state.attempts[1].complete, false);
    assert.equal(state.attempts[1].promoted, false);
    const view = await readBatchOperations(h.snapshots);
    assert.equal(view.batch, 'B1');
    assert.deepEqual(view.rows.map((row) => row.attributes.quantity), [8, 13]);
  } finally { await h.cleanup(); }
});

test('真实零库存、成功读取的空范围、页面缺项是三种不同状态', async () => {
  const zeroEmpty = await harness('zeroEmpty');
  try {
    const result = await zeroEmpty.service.collect();
    assert.equal(result.complete, true);
    const coverage = Object.fromEntries(result.coverage.warehouses.map((w) => [w.warehouse, w.status]));
    assert.equal(coverage.W1, 'data'); // 读到数据行（quantity 0 是真实零库存）
    assert.equal(coverage.W2, 'empty'); // 成功读取但该范围为空
    const view = await readBatchOperations(zeroEmpty.snapshots);
    const w1 = view.rows.find((row) => row.attributes.warehouse === 'W1');
    assert.equal(w1.attributes.quantity, 0);
    assert.equal(view.rows.some((row) => row.attributes.warehouse === 'W2'), false);
    assert.ok(view.coverage.warehouses.some((w) => w.warehouse === 'W2' && w.status === 'empty'));
  } finally { await zeroEmpty.cleanup(); }

  const failed = await harness('incomplete');
  try {
    const result = await failed.service.collect();
    const w2 = result.coverage.warehouses.find((w) => w.warehouse === 'W2');
    assert.equal(w2.status, 'missing'); // 页面暂时缺项，既不是零库存也不是空范围
    assert.equal(await failed.snapshots.readActive(), null);
    const view = await readBatchOperations(failed.snapshots);
    assert.equal(view.status, 'no-complete-batch');
    assert.deepEqual(view.rows, []);
  } finally { await failed.cleanup(); }
});

test('manifest 自己声明不完整的批次不能用于对账', async () => {
  const h = await harness('declaredIncomplete');
  try {
    const result = await h.service.collect();
    assert.equal(result.complete, false);
    assert.ok(result.reasons.includes('manifest-declared-incomplete'));
    assert.equal(await h.snapshots.readActive(), null);
  } finally { await h.cleanup(); }
});

test('记录批次号与 manifest 不一致时拒绝拼接并登记违规', async () => {
  const h = await harness('mismatch');
  try {
    const result = await h.service.collect();
    assert.equal(result.complete, false);
    assert.ok(result.reasons.includes('consistency-violations'));
    assert.ok(result.violations.some((v) => v.kind === 'batch-mismatch' && v.expected === 'B5' && v.actual === 'B4'));
    assert.equal(await h.snapshots.readActive(), null);
  } finally { await h.cleanup(); }
});

test('重试不会把不同来源批次的分页拼成一份快照', async () => {
  const h = await harness('incomplete');
  try {
    const first = await h.service.collect();
    assert.equal(first.batch, 'B2');
    assert.equal(first.complete, false);
    // 来源随后发布新批次 B6；每次采集都重新读 manifest 并重新翻页，
    // B2 已读到的 W1 分页不会被带进 B6 的尝试。
    h.source.publish('paged');
    const second = await h.service.collect();
    assert.equal(second.batch, 'B6');
    assert.equal(second.complete, true);
    const state = await h.snapshots.readState();
    assert.equal(state.active.batch, 'B6');
    assert.equal(state.attempts.length, 2);
    assert.deepEqual([...new Set(state.active.records.map((r) => r.attributes.batch))], ['B6']);
    assert.equal(state.active.records.find((r) => r.sourceId === 'S1|A-100|W1').attributes.quantity, 4);
  } finally { await h.cleanup(); }
});

test('同仓多页中的空页只证明该页为空，不影响整仓确认', async () => {
  const h = await harness('paged');
  try {
    const result = await h.service.collect();
    assert.equal(result.complete, true);
    assert.equal(result.pageCount, 3); // W1 两页 + W2 一页
    const w1 = result.coverage.warehouses.find((entry) => entry.warehouse === 'W1');
    assert.equal(w1.status, 'data');
    assert.equal(w1.pages, 2);
    assert.ok(result.pages.some((page) => page.empty === true));
  } finally { await h.cleanup(); }
});

test('快照状态持久化到独立文件并可在重启后回读', async () => {
  const h = await harness('opening');
  try {
    await h.service.collect();
    const reopened = new SnapshotRepository(h.snapshots.path);
    const view = await readBatchOperations(reopened);
    assert.equal(view.batch, 'B1');
    assert.equal(view.rows.length, 2);
    const state = await reopened.readState();
    assert.equal(state.attempts.length, 1);
  } finally { await h.cleanup(); }
});

test('适配器区分成功空页与真实记录页，manifest 被结构化解析', async () => {
  const source = await startSource(scenarioPath);
  try {
    const client = new SourceClient(source.url);
    source.publish('zeroEmpty');
    const emptyPage = parsePage(await client.read('/stock?supplier=S1&warehouse=W2&page=1'));
    assert.equal(emptyPage.empty, true);
    assert.deepEqual(emptyPage.records, []);
    const dataPage = parsePage(await client.read('/stock?supplier=S1&warehouse=W1&page=1'));
    assert.equal(dataPage.empty, false);
    assert.equal(dataPage.records[0].attributes.quantity, 0);
    const manifest = parseManifest(await client.read(manifestPath));
    assert.equal(manifest.batch, 'B3');
    assert.deepEqual(manifest.warehouses, ['W1', 'W2']);
    assert.equal(manifest.complete, true);
  } finally { await source.close(); }
});
