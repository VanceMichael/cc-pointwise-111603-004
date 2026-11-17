import { schema } from './schema.js';

export function normalizeRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`${schema.entity} must be an object`);
  }
  const record = {
    sourceId: String(input.sourceId ?? '').trim(),
    source: String(input.source ?? '').trim(),
    observedAt: String(input.observedAt ?? '').trim(),
    label: String(input.label ?? '').trim(),
    attributes: input.attributes && typeof input.attributes === 'object' && !Array.isArray(input.attributes)
      ? structuredClone(input.attributes) : {},
  };
  for (const field of schema.required) {
    if (!record[field]) throw new Error(`missing ${field} for ${schema.entity}`);
  }
  if (!Number.isFinite(Date.parse(record.observedAt))) {
    throw new Error(`invalid observedAt for ${schema.entity}`);
  }
  return record;
}

function text(value) {
  return String(value ?? '').trim();
}

/**
 * The operational grain of a supplier stock record is supplier/sku/warehouse.
 * A source can legitimately return the same SKU from several warehouses, so the
 * raw sourceId (which is only the SKU in the supplier page) is not an identity.
 */
export function stockFields(record) {
  const attributes = record?.attributes && typeof record.attributes === 'object' ? record.attributes : {};
  const supplier = text(attributes.supplier);
  const sku = text(attributes.sku ?? record?.label ?? record?.sourceId);
  const warehouse = text(attributes.warehouse);
  if (!supplier || !sku || !warehouse) return null;
  return {
    supplier,
    sku,
    warehouse,
    quantity: attributes.quantity ?? null,
    batch: text(attributes.batch) || null,
    capturedAt: text(attributes.capturedAt) || null,
  };
}

export function inventoryKey(record) {
  const stock = stockFields(record);
  return stock
    ? ['stock', stock.supplier, stock.sku, stock.warehouse].join('\u0000')
    : ['source', record?.sourceId ?? ''].join('\u0000');
}

export function sortRecords(records) {
  return records.sort((left, right) => {
    const result = inventoryKey(left).localeCompare(inventoryKey(right));
    return result || String(left.sourceId).localeCompare(String(right.sourceId));
  });
}

/**
 * Merge by the storage grain, not by the raw source identity. This keeps the
 * quantities of the same SKU in different warehouses side by side.
 */
export function mergeRecords(existing, incoming) {
  const merged = new Map(existing.map((record) => [inventoryKey(record), record]));
  for (const record of incoming) {
    const key = inventoryKey(record);
    const current = merged.get(key);
    if (!current || Date.parse(record.observedAt) >= Date.parse(current.observedAt)) {
      merged.set(key, record);
    }
  }
  return sortRecords([...merged.values()]);
}

export function findRecords(records, { source, from, to } = {}) {
  return records.filter((record) => {
    if (source && record.source !== source) return false;
    const timestamp = Date.parse(record.observedAt);
    if (from && timestamp < Date.parse(from)) return false;
    if (to && timestamp > Date.parse(to)) return false;
    return true;
  });
}
