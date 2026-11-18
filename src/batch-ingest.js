import { parsePage, parseManifest, warehouseOf, manifestPath } from './adapter.js';

// 单次采集是一次“批次尝试”：先读 manifest 确认批次号与仓库覆盖清单，
// 再按仓库逐页读取。读取只产出带状态标记的尝试结果，绝不把尝试中的
// 分页直接写进业务仓库；是否提升为业务快照交给批次服务按完整性决定。
export async function collectBatch(client) {
  const startedAt = new Date().toISOString();
  const manifestResponse = await client.read(manifestPath);
  const manifest = parseManifest(manifestResponse);

  const pages = [];
  const records = [];
  const warehouses = [];
  const violations = [];
  const failures = [];
  const visited = new Set();
  let failed = false;

  function recordPage(path, page, warehouse) {
    pages.push({
      path,
      warehouse,
      empty: page.empty,
      recordCount: page.records.length,
    });
    for (const record of page.records) {
      const attributes = record.attributes;
      if (attributes.batch !== manifest.batch) {
        violations.push({
          kind: 'batch-mismatch',
          path,
          expected: manifest.batch,
          actual: String(attributes.batch ?? ''),
        });
      }
      if (attributes.supplier !== undefined && String(attributes.supplier) !== manifest.supplier) {
        violations.push({
          kind: 'supplier-mismatch',
          path,
          expected: manifest.supplier,
          actual: String(attributes.supplier),
        });
      }
      const rowWarehouse = attributes.warehouse === undefined ? warehouse : String(attributes.warehouse);
      if (warehouse !== null && rowWarehouse !== warehouse) {
        violations.push({
          kind: 'warehouse-mismatch',
          path,
          expected: warehouse,
          actual: rowWarehouse,
        });
      }
      if (rowWarehouse && !manifest.warehouses.includes(rowWarehouse)) {
        violations.push({
          kind: 'warehouse-not-covered',
          path,
          warehouse: rowWarehouse,
        });
      }
      records.push(record);
    }
  }

  for (const warehouse of manifest.warehouses) {
    const entry = `/stock?supplier=${encodeURIComponent(manifest.supplier)}&warehouse=${encodeURIComponent(warehouse)}&page=1`;
    let path = entry;
    let sawData = false;
    let pageCount = 0;
    let warehouseFailure = null;

    while (path !== null) {
      if (visited.has(path)) {
        violations.push({ kind: 'pagination-cycle', path, warehouse });
        break;
      }
      visited.add(path);
      const scopedWarehouse = warehouseOf(path);
      try {
        const page = parsePage(await client.read(path));
        pageCount += 1;
        if (!page.empty) sawData = true;
        recordPage(path, page, scopedWarehouse ?? warehouse);
        // 只跟随仍在同一仓库范围内的分页链接；跨仓链接是门户导航，
        // 仓库覆盖清单以 manifest 为权威，避免把 W2 的页计入 W1 的分页。
        path = page.next !== null && warehouseOf(page.next) === warehouse ? page.next : null;
      } catch (error) {
        failed = true;
        warehouseFailure = {
          path,
          warehouse,
          reason: error?.message ? String(error.message) : String(error),
        };
        failures.push(warehouseFailure);
        path = null;
      }
    }

    if (warehouseFailure) {
      warehouses.push({
        warehouse,
        status: 'missing',
        pages: pageCount,
        failure: warehouseFailure.reason,
      });
    } else {
      warehouses.push({
        warehouse,
        status: sawData ? 'data' : 'empty',
        pages: pageCount,
      });
    }
  }

  const confirmed = new Set(
    warehouses.filter((entry) => entry.status !== 'missing').map((entry) => entry.warehouse),
  );
  const unconfirmedWarehouses = manifest.warehouses.filter((warehouse) => !confirmed.has(warehouse));
  const reasons = [];
  if (!manifest.complete) reasons.push('manifest-declared-incomplete');
  if (failed) reasons.push('page-failures');
  if (violations.length) reasons.push('consistency-violations');
  const complete = reasons.length === 0 && unconfirmedWarehouses.length === 0;
  if (!complete && !reasons.length) reasons.push('warehouses-unconfirmed');

  return {
    manifest,
    complete,
    reasons,
    startedAt,
    finishedAt: new Date().toISOString(),
    records,
    coverage: {
      warehouses,
      unconfirmedWarehouses,
    },
    pages,
    failures,
    violations,
  };
}
