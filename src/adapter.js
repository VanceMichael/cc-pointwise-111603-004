export const entryPath = "/stock?supplier=S1&warehouse=W1&page=1";
export const manifestPath = "/stock/manifest";

export function warehousePath(supplier, warehouse, page = 1) {
  const query = new URLSearchParams({ supplier: String(supplier), warehouse: String(warehouse), page: String(page) });
  return `/stock?${query}`;
}

function hasPageLayout(text) {
  return /<!doctype\s+html/i.test(text) || /<html[\s>]/i.test(text);
}

export function parsePage(response) {
  const items = [...response.text.matchAll(/<script type="application\/json" class="source-record">([\s\S]*?)<\/script>/g)]
    .map((match) => JSON.parse(match[1]));
  // A successfully read page with no record nodes is an empty range, not a
  // broken layout. Both are different from a page that could not be read.
  if (!items.length && !hasPageLayout(response.text)) throw new Error('source layout contains no records');
  const next = response.text.match(/rel="next" href="([^"]+)"/)?.[1] ?? null;
  return { next, records: items.map((item) => ({
    sourceId: String(item["sku"]),
    source: "供应商库存观察器",
    observedAt: item["capturedAt"],
    label: String(item["sku"]),
    attributes: structuredClone(item),
  })) };
}

export function parseManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('source manifest must be an object');
  const supplier = String(value.supplier ?? '').trim();
  const batch = String(value.batch ?? '').trim();
  if (!supplier) throw new Error('source manifest has no supplier');
  if (!batch) throw new Error('source manifest has no batch');
  if (!Array.isArray(value.warehouses) || !value.warehouses.length) {
    throw new Error('source manifest has no warehouse coverage');
  }
  const warehouses = value.warehouses.map((warehouse) => String(warehouse ?? '').trim());
  if (warehouses.some((warehouse) => !warehouse)) throw new Error('source manifest has an empty warehouse');
  if (new Set(warehouses).size !== warehouses.length) throw new Error('source manifest repeats a warehouse');
  if (typeof value.complete !== 'boolean') throw new Error('source manifest has no completeness flag');
  return { supplier, batch, warehouses, complete: value.complete };
}
