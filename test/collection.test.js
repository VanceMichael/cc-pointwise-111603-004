import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from '../src/source-client.js';
import { RecordRepository } from '../src/repository.js';
import { CollectionService } from '../src/service.js';
import { readOperations } from '../src/operations.js';

const scenarioPath = new URL('../fixtures/source.json', import.meta.url);
const page = (records, next = null) => ({
  contentType: 'text/html; charset=utf-8',
  body: `<!doctype html><html><body>${records.map((record) =>
    `<script type="application/json" class="source-record">${JSON.stringify(record)}</script>`).join('')}` +
    `${next ? `<a rel="next" href="${next}">More</a>` : ''}</body></html>`,
});
const record = (warehouse, { sku = 'A-100', quantity = 1, batch = 'B1', capturedAt = '2026-11-16T08:00:00Z', supplier = 'S1' } = {}) =>
  ({ supplier, sku, warehouse, quantity, batch, capturedAt });
const manifest = (body) => ({ contentType: 'application/json', body });
const pathFor = (warehouse, pageNumber = 1) => `/stock?supplier=S1&warehouse=${warehouse}&page=${pageNumber}`;

async function withCollection(run, routes) {
  const directory = await mkdtemp(join(tmpdir(), 'batch-'));
  const server = createServer((request, response) => {
    const route = routes[request.url];
    if (!route) { response.writeHead(404); response.end('not found'); return; }
    if (typeof route === 'number') { response.writeHead(route); response.end('unavailable'); return; }
    response.writeHead(200, { 'content-type': route.contentType });
    response.end(typeof route.body === 'string' ? route.body : JSON.stringify(route.body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const service = new CollectionService(new RecordRepository(join(directory, 'records.json')));
    return await run(service, `http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

test('同一个 SKU 在多个仓库的数量并存，业务按仓位而不是按行覆盖', async () => {
  const source = await startSource(scenarioPath);
  const directory = await mkdtemp(join(tmpdir(), 'warehouse-'));
  try {
    const repository = new RecordRepository(join(directory, 'records.json'));
    const service = new CollectionService(repository);
    const result = await service.ingestSupplier(new SourceClient(source.url), { supplier: 'S1' });
    assert.equal(result.complete, true);
    assert.equal(result.applied, true);
    assert.equal(result.accepted, 2);
    const view = await readOperations(repository);
    assert.deepEqual(view.rows.map((row) => [row.attributes.warehouse, row.attributes.quantity]), [['W1', 8], ['W2', 13]]);
    assert.deepEqual(view.warehouses.map((entry) => [entry.warehouse, entry.status]), [['W1', 'confirmed'], ['W2', 'confirmed']]);
  } finally { await source.close(); await rm(directory, { recursive: true, force: true }); }
});

test('分页失败时保留上次完整结果并明确未确认仓库', async () => {
  const source = await startSource(scenarioPath);
  const directory = await mkdtemp(join(tmpdir(), 'recovery-'));
  try {
    const repository = new RecordRepository(join(directory, 'records.json'));
    const service = new CollectionService(repository);
    await service.ingestSupplier(new SourceClient(source.url), { supplier: 'S1' });
    source.publish('incomplete');
    const failed = await service.ingestSupplier(new SourceClient(source.url), { supplier: 'S1' });
    assert.equal(failed.complete, false);
    assert.equal(failed.applied, false);
    assert.equal(failed.batch, 'B2');
    assert.deepEqual(failed.unconfirmedWarehouses, ['W2']);
    const coverage = Object.fromEntries(failed.coverage.map((entry) => [entry.warehouse, entry]));
    assert.equal(coverage.W1.status, 'confirmed');
    assert.equal(coverage.W2.status, 'failed');
    assert.match(coverage.W2.reason, /503/);
    const view = await readOperations(repository);
    assert.equal(view.batch, 'B1', '上一完整批次仍然有效');
    assert.deepEqual(view.rows.map((row) => row.attributes.quantity), [8, 13]);
    assert.equal(view.lastAttempt.batch, 'B2');
    assert.deepEqual(view.lastAttempt.unconfirmedWarehouses, ['W2']);
  } finally { await source.close(); await rm(directory, { recursive: true, force: true }); }
});

test('零库存、成功空范围与缺项分别是可区分的状态，且完整批次仍可用于对账', async () => {
  const routes = {
    '/stock/manifest': manifest({ supplier: 'S1', batch: 'B1', warehouses: ['W1', 'W2', 'W3'], complete: true }),
    [pathFor('W1')]: page([record('W1', { sku: 'A-100', quantity: 0 })]),
    [pathFor('W2')]: page([]),
    [pathFor('W3')]: page([]),
  };
  await withCollection(async (service, baseUrl) => {
    const first = await service.ingestSupplier(new SourceClient(baseUrl), { supplier: 'S1' });
    assert.equal(first.applied, true);
    assert.deepEqual(first.coverage.map((entry) => [entry.warehouse, entry.status, entry.zeroCount]),
      [['W1', 'confirmed', 1], ['W2', 'empty', 0], ['W3', 'empty', 0]]);
    const view = await readOperations(service.repository);
    assert.deepEqual(view.rows.map((row) => [row.attributes.warehouse, row.attributes.quantity]), [['W1', 0]]);
    assert.deepEqual(view.warehouses.map((entry) => [entry.warehouse, entry.status, entry.zeroCount]),
      [['W1', 'confirmed', 1], ['W2', 'empty', 0], ['W3', 'empty', 0]]);
  }, routes);
});

test('未确认仓库不会把上一批次的数量归零，也不会被空页覆盖', async () => {
  const routes = {
    '/stock/manifest': manifest({ supplier: 'S1', batch: 'B1', warehouses: ['W1', 'W2'], complete: true }),
    [pathFor('W1')]: page([record('W1', { quantity: 8 })]),
    [pathFor('W2')]: page([record('W2', { quantity: 13 })]),
  };
  await withCollection(async (service, baseUrl) => {
    const repository = service.repository;
    const client = new SourceClient(baseUrl);
    await service.ingestSupplier(client, { supplier: 'S1' });
    routes[pathFor('W2')] = 503;
    const failed = await service.ingestSupplier(client, { supplier: 'S1' });
    assert.deepEqual(failed.unconfirmedWarehouses, ['W2']);
    const view = await readOperations(repository);
    assert.deepEqual(view.rows.map((row) => [row.attributes.warehouse, row.attributes.quantity]), [['W1', 8], ['W2', 13]]);
    assert.deepEqual(view.warehouses.map((entry) => entry.warehouse), ['W1', 'W2'], '上一完整快照仍按仓位展示');
  }, routes);
});

test('重试不能把不同批次的页面拼成一份看似完整的快照', async () => {
  const routes = {
    '/stock/manifest': manifest({ supplier: 'S1', batch: 'B2', warehouses: ['W1', 'W2'], complete: true }),
    [pathFor('W1')]: page([record('W1', { batch: 'B2', quantity: 5 })]),
    [pathFor('W2')]: page([record('W2', { batch: 'B1', quantity: 13 })]),
  };
  await withCollection(async (service, baseUrl) => {
    const repository = service.repository;
    const result = await service.ingestSupplier(new SourceClient(baseUrl), { supplier: 'S1' });
    assert.equal(result.complete, false);
    assert.equal(result.applied, false);
    assert.equal(result.attempt.status, 'mixed-batch');
    assert.deepEqual(await repository.read(), []);
  }, routes);
});

test('同一仓库分页重试时不会混入另一批次，损坏的下一页中止整次采集', async () => {
  let switched = false;
  const routes = {
    '/stock/manifest': manifest({ supplier: 'S1', batch: 'B1', warehouses: ['W1'], complete: true }),
    [pathFor('W1', 1)]: page([record('W1', { quantity: 8 })], pathFor('W1', 2)),
    [pathFor('W1', 2)]: () => (switched ? page([record('W1', { batch: 'B2', quantity: 4 })]) : 503),
  };
  const directory = await mkdtemp(join(tmpdir(), 'retry-'));
  const server = createServer((request, response) => {
    const route = routes[request.url];
    const value = typeof route === 'function' ? route() : route;
    if (!value || typeof value === 'number') { response.writeHead(value ?? 404); response.end('unavailable'); return; }
    response.writeHead(200, { 'content-type': value.contentType });
    response.end(typeof value.body === 'string' ? value.body : JSON.stringify(value.body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const repository = new RecordRepository(join(directory, 'records.json'));
    const service = new CollectionService(repository);
    const client = new SourceClient(`http://127.0.0.1:${server.address().port}`);
    const first = await service.ingestSupplier(client, { supplier: 'S1' });
    assert.equal(first.complete, false);
    assert.equal(first.coverage[0].status, 'partial');
    switched = true;
    const second = await service.ingestSupplier(client, { supplier: 'S1' });
    assert.equal(second.complete, false);
    assert.equal(second.attempt.status, 'mixed-batch');
    assert.deepEqual(await repository.read(), [], '半次抓取从未成为库存');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('声明不完整的批次不会替换完整结果', async () => {
  const routes = {
    '/stock/manifest': manifest({ supplier: 'S1', batch: 'B1', warehouses: ['W1'], complete: false }),
    [pathFor('W1')]: page([record('W1', { quantity: 8 })]),
  };
  await withCollection(async (service, baseUrl) => {
    const result = await service.ingestSupplier(new SourceClient(baseUrl), { supplier: 'S1' });
    assert.equal(result.complete, false);
    assert.equal(result.attempt.status, 'incomplete');
    assert.deepEqual(await service.repository.read(), []);
  }, routes);
});

test('上次有、本次成功页面中消失的条目不会被当作零库存，而是未确认', async () => {
  const routes = {
    '/stock/manifest': manifest({ supplier: 'S1', batch: 'B1', warehouses: ['W1'], complete: true }),
    [pathFor('W1')]: page([record('W1', { sku: 'A-100', quantity: 8 }), record('W1', { sku: 'A-200', quantity: 2 })]),
  };
  await withCollection(async (service, baseUrl) => {
    const repository = service.repository;
    const client = new SourceClient(baseUrl);
    assert.equal((await service.ingestSupplier(client, { supplier: 'S1' })).applied, true);
    routes[pathFor('W1')] = page([record('W1', { sku: 'A-100', quantity: 8 })]);
    const result = await service.ingestSupplier(client, { supplier: 'S1' });
    assert.equal(result.complete, false);
    assert.equal(result.applied, false);
    assert.equal(result.coverage[0].status, 'missing-items');
    assert.deepEqual(result.coverage[0].notReportedSkus, ['A-200']);
    assert.deepEqual(result.unconfirmedWarehouses, ['W1']);
    const rows = await repository.read();
    assert.deepEqual(rows.map((row) => row.attributes.sku), ['A-100', 'A-200'], '上次完整结果保留');
  }, routes);
});

test('一个仓库的下一页若指向另一个仓库，不会被拼进当前仓库', async () => {
  const routes = {
    '/stock/manifest': manifest({ supplier: 'S1', batch: 'B1', warehouses: ['W1', 'W2'], complete: true }),
    [pathFor('W1')]: page([record('W1', { sku: 'A-100', quantity: 8 })], pathFor('W2')),
    [pathFor('W2')]: page([record('W2', { sku: 'A-100', quantity: 13 })]),
  };
  await withCollection(async (service, baseUrl) => {
    const repository = service.repository;
    const result = await service.ingestSupplier(new SourceClient(baseUrl), { supplier: 'S1' });
    assert.equal(result.complete, true);
    const rows = await repository.read();
    assert.deepEqual(rows.map((row) => [row.attributes.warehouse, row.attributes.quantity]), [['W1', 8], ['W2', 13]]);
  }, routes);
});

test('失败采集的覆盖清单与上一完整批次在重启后仍可读取', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'restart-'));
  const routes = {
    '/stock/manifest': manifest({ supplier: 'S1', batch: 'B1', warehouses: ['W1', 'W2'], complete: true }),
    [pathFor('W1')]: page([record('W1', { quantity: 8 })]),
    [pathFor('W2')]: page([record('W2', { quantity: 13 })]),
  };
  const server = createServer((request, response) => {
    const route = routes[request.url];
    if (!route) { response.writeHead(404); response.end('not found'); return; }
    if (typeof route === 'number') { response.writeHead(route); response.end('unavailable'); return; }
    response.writeHead(200, { 'content-type': route.contentType });
    response.end(typeof route.body === 'string' ? route.body : JSON.stringify(route.body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const path = join(directory, 'records.json');
  try {
    const client = new SourceClient(`http://127.0.0.1:${server.address().port}`);
    await new CollectionService(new RecordRepository(path)).ingestSupplier(client, { supplier: 'S1' });
    routes[pathFor('W2')] = 503;
    await new CollectionService(new RecordRepository(path)).ingestSupplier(client, { supplier: 'S1' });
    const reopened = new CollectionService(new RecordRepository(path));
    const view = await readOperations(reopened.repository);
    assert.equal(view.batch, 'B1');
    assert.equal(view.rows.length, 2);
    assert.deepEqual(view.lastAttempt.unconfirmedWarehouses, ['W2']);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('新的完整批次整体替换库存，不残留上一批次的行', async () => {
  const source = await startSource(scenarioPath);
  const directory = await mkdtemp(join(tmpdir(), 'batch-switch-'));
  try {
    const repository = new RecordRepository(join(directory, 'records.json'));
    const service = new CollectionService(repository);
    const client = new SourceClient(source.url);
    await service.ingestSupplier(client, { supplier: 'S1' });
    source.publish('updated');
    const next = await service.ingestSupplier(client, { supplier: 'S1' });
    assert.equal(next.batch, 'B2');
    assert.equal(next.applied, true);
    const view = await readOperations(repository);
    assert.equal(view.batch, 'B2');
    assert.deepEqual(view.rows.map((row) => [row.attributes.batch, row.attributes.quantity]), [['B2', 5], ['B2', 11]]);
  } finally { await source.close(); await rm(directory, { recursive: true, force: true }); }
});

test('manifest 读取失败也保留上次完整批次并列出未确认仓库', async () => {
  const routes = {
    '/stock/manifest': manifest({ supplier: 'S1', batch: 'B1', warehouses: ['W1'], complete: true }),
    [pathFor('W1')]: page([record('W1', { quantity: 8 })]),
  };
  await withCollection(async (service, baseUrl) => {
    const repository = service.repository;
    const client = new SourceClient(baseUrl);
    await service.ingestSupplier(client, { supplier: 'S1' });
    routes['/stock/manifest'] = 503;
    const failed = await service.ingestSupplier(client, { supplier: 'S1' });
    assert.equal(failed.complete, false);
    assert.equal(failed.status, 'manifest-failed');
    assert.deepEqual(failed.unconfirmedWarehouses, ['W1']);
    const view = await readOperations(repository);
    assert.equal(view.batch, 'B1');
    assert.deepEqual(view.rows.map((row) => row.attributes.quantity), [8]);
    assert.equal(view.lastAttempt.status, 'manifest-failed');
  }, routes);
});
