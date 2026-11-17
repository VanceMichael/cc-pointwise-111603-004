import { parseManifest, parsePage, warehousePath } from './adapter.js';
import { mergeRecords, stockFields } from './records.js';

const MAX_PAGES = 100;

/**
 * A page from another batch cannot be combined with the pages already read in
 * this attempt: the attempt is abandoned instead of producing a snapshot that
 * looks complete but mixes source batches.
 */
export class MixedBatchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MixedBatchError';
    this.code = 'mixed-batch';
  }
}

function latestCapture(record) {
  const stock = stockFields(record);
  const value = Date.parse(stock?.capturedAt ?? record?.observedAt ?? '');
  return Number.isFinite(value) ? value : -Infinity;
}

function deduplicate(records) {
  const bySku = new Map();
  for (const record of records) {
    const sku = stockFields(record)?.sku ?? record.sourceId;
    const current = bySku.get(sku);
    if (!current || latestCapture(record) >= latestCapture(current)) bySku.set(sku, record);
  }
  return [...bySku.values()].sort((left, right) => String(left.sourceId).localeCompare(String(right.sourceId)));
}

function quantityOf(record) {
  const quantity = stockFields(record)?.quantity;
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity < 0) {
    throw new Error(`record ${record.sourceId} has no usable quantity`);
  }
  return quantity;
}

function validateRecord(record, batch) {
  const stock = stockFields(record);
  if (!stock || !stock.sku) throw new Error(`record ${record.sourceId} has no supplier/sku/warehouse`);
  if (!Number.isFinite(Date.parse(stock.capturedAt ?? ''))) {
    throw new Error(`record ${record.sourceId} has no usable capturedAt`);
  }
  if (stock.batch !== batch) {
    throw new MixedBatchError(`page returned batch ${stock.batch}, manifest batch is ${batch}`);
  }
  quantityOf(record);
  return stock;
}

function readCoverage(warehouses) {
  return warehouses.map((warehouse) => ({ warehouse, status: 'unconfirmed', recordCount: 0, zeroCount: 0,
    reason: 'warehouse was not read in this attempt' }));
}

/**
 * Read every warehouse named by the source manifest, following only pages that
 * stay inside that same supplier/warehouse range. The result is an attempt with
 * a coverage report; a snapshot is produced only for a complete batch.
 */
export async function collectSupplier(client, {
  supplier = 'S1', manifest = '/stock/manifest', previousSnapshot = null, now = () => new Date(),
} = {}) {
  const startedAt = now().toISOString();
  const finish = () => now().toISOString();
  const previousCoverage = previousSnapshot?.warehouses?.map((entry) => entry.warehouse) ?? [];

  let declaration;
  try {
    declaration = parseManifest(await client.readManifest(manifest));
  } catch (error) {
    const attempt = {
      supplier, batch: null, startedAt, finishedAt: finish(), status: 'manifest-failed',
      manifestComplete: null, reason: error.message, applied: false,
      warehouses: readCoverage(previousCoverage),
      unconfirmedWarehouses: previousCoverage,
    };
    return { snapshot: null, attempt };
  }

  if (declaration.supplier !== supplier) {
    const attempt = {
      supplier, batch: declaration.batch, startedAt, finishedAt: finish(), status: 'manifest-failed',
      manifestComplete: declaration.complete,
      reason: `manifest supplier ${declaration.supplier} does not match ${supplier}`,
      applied: false, warehouses: readCoverage(declaration.warehouses),
      unconfirmedWarehouses: declaration.warehouses,
    };
    return { snapshot: null, attempt };
  }

  const coverage = declaration.warehouses.map((warehouse) => ({
    warehouse, status: 'unconfirmed', recordCount: 0, zeroCount: 0,
    reason: 'warehouse was not read in this attempt',
  }));
  const collected = new Map();
  const uncoveredLinks = new Set();
  let abort = null;

  for (const entry of coverage) {
    if (abort) {
      entry.reason = `attempt stopped: ${abort.message}`;
      continue;
    }
    const warehouse = entry.warehouse;
    const records = [];
    const visited = new Set();
    let path = warehousePath(supplier, warehouse, 1);
    let pages = 0;
    let failure = null;

    try {
      while (path) {
        if (visited.has(path)) throw new Error('source pagination repeats a page');
        visited.add(path);
        pages += 1;
        if (pages > MAX_PAGES) throw new Error('source pagination exceeds page limit');
        const page = parsePage(await client.read(path));
        for (const record of page.records) {
          const stock = validateRecord(record, declaration.batch);
          if (stock.supplier !== supplier || stock.warehouse !== warehouse) {
            throw new MixedBatchError(`page for ${supplier}/${warehouse} returned ${stock.supplier}/${stock.warehouse}`);
          }
          records.push(record);
        }
        if (!page.next) break;
        let next;
        try { next = new URL(page.next, client.baseUrl); } catch { throw new Error(`unreadable next link for ${warehouse}`); }
        const nextSupplier = next.searchParams.get('supplier');
        const nextWarehouse = next.searchParams.get('warehouse');
        if (nextWarehouse && (nextWarehouse !== warehouse || (nextSupplier && nextSupplier !== supplier))) {
          if (!declaration.warehouses.includes(nextWarehouse)) uncoveredLinks.add(nextWarehouse);
          break;
        }
        path = `${next.pathname}${next.search}`;
      }
    } catch (error) {
      if (error instanceof MixedBatchError) {
        abort = error;
        entry.status = 'unconfirmed';
        entry.reason = error.message;
        continue;
      }
      failure = error;
    }

    if (failure) {
      entry.status = pages > 1 ? 'partial' : 'failed';
      entry.recordCount = records.length;
      entry.zeroCount = records.filter((record) => stockFields(record)?.quantity === 0).length;
      entry.reason = failure.message;
      continue;
    }

    const unique = deduplicate(records);
    collected.set(warehouse, unique);
    entry.recordCount = unique.length;
    entry.zeroCount = unique.filter((record) => stockFields(record)?.quantity === 0).length;
    entry.reason = null;
    const prior = previousSnapshot?.batch === declaration.batch
      ? previousSnapshot.warehouses.find((candidate) => candidate.warehouse === warehouse)
      : null;
    const notReported = [];
    if (prior) {
      // Within one batch the item set is stable, so an item reported earlier
      // that is now absent means the page did not deliver everything. Across
      // batches an absent item can be a genuine delisting and is not an error.
      const reported = new Set(unique.map((record) => stockFields(record)?.sku));
      for (const sku of prior.records.map((record) => stockFields(record)?.sku)) {
        if (sku && !reported.has(sku)) notReported.push(sku);
      }
    }
    if (notReported.length) {
      // An item that was reported before and is now absent is not the same as a
      // zero quantity or a fully read empty range: keep the batch from being
      // used for reconciliation until the omission is confirmed.
      entry.notReportedSkus = notReported;
      entry.status = 'missing-items';
      entry.reason = `previously reported items are absent: ${notReported.join(', ')}`;
    } else {
      entry.status = unique.length ? 'confirmed' : 'empty';
    }
  }

  // A page that was read but omitted a previously reported item cannot be
  // proven complete, so the warehouse stays unconfirmed. A batch is usable for
  // reconciliation only when every manifest warehouse was confirmed or read as
  // an explicitly empty range.
  const readStatuses = new Set(['confirmed', 'empty']);
  const unconfirmedWarehouses = coverage
    .filter((entry) => !readStatuses.has(entry.status))
    .map((entry) => entry.warehouse);
  let status = 'complete';
  let reason = null;
  if (abort) {
    status = 'mixed-batch';
    reason = abort.message;
  } else if (!declaration.complete) {
    status = 'incomplete';
    reason = 'source manifest does not declare this batch complete';
  } else if (unconfirmedWarehouses.length) {
    status = 'incomplete';
    reason = `warehouses not confirmed: ${unconfirmedWarehouses.join(', ')}`;
  } else if (uncoveredLinks.size) {
    status = 'incomplete';
    reason = `source links to warehouses outside the manifest: ${[...uncoveredLinks].join(', ')}`;
  }

  const finishedAt = finish();
  const attempt = {
    supplier, batch: declaration.batch, startedAt, finishedAt, status,
    manifestComplete: declaration.complete, reason, applied: false,
    warehouses: coverage, unconfirmedWarehouses,
    ...(uncoveredLinks.size ? { uncoveredWarehouses: [...uncoveredLinks] } : {}),
  };

  if (status !== 'complete') return { snapshot: null, attempt };

  const snapshot = {
    supplier,
    batch: declaration.batch,
    complete: true,
    manifestComplete: true,
    collectedAt: finishedAt,
    warehouses: coverage.map((entry) => ({
      warehouse: entry.warehouse,
      status: entry.status,
      records: collected.get(entry.warehouse) ?? [],
    })),
  };
  return { snapshot, attempt };
}

export function snapshotRecords(snapshot) {
  return mergeRecords([], snapshot.warehouses.flatMap((entry) => structuredClone(entry.records)));
}
