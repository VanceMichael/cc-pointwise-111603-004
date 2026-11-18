export const entryPath = "/stock?supplier=S1&warehouse=W1&page=1";
export const manifestPath = "/stock/manifest";

function toRecord(item) {
  return {
    sourceId: String(item["sku"]),
    source: "供应商库存观察器",
    observedAt: item["capturedAt"],
    label: String(item["sku"]),
    attributes: structuredClone(item),
  };
}

// 成功读取但不含任何记录的页面是合法的“空范围”：它只证明该页为空，
// 与布局损坏（非 source-record 节点的响应）分开处理。
export function parsePage(response) {
  const text = response?.text ?? '';
  const nodes = [...text.matchAll(/<script type="application\/json" class="source-record">([\s\S]*?)<\/script>/g)];
  const records = nodes.map((match) => toRecord(JSON.parse(match[1])));
  const next = text.match(/rel="next" href="([^"]+)"/)?.[1] ?? null;
  return { next, records, empty: nodes.length === 0 };
}

export function parseManifest(response) {
  const manifest = JSON.parse(response.text);
  for (const field of ['supplier', 'batch', 'warehouses']) {
    if (field === 'warehouses') {
      if (!Array.isArray(manifest[field]) || manifest[field].some((value) => typeof value !== 'string' || !value)) {
        throw new Error(`manifest ${field} must be a non-empty string list`);
      }
    } else if (typeof manifest[field] !== 'string' || !manifest[field]) {
      throw new Error(`manifest missing ${field}`);
    }
  }
  return {
    supplier: manifest.supplier,
    batch: manifest.batch,
    warehouses: [...manifest.warehouses],
    complete: manifest.complete === true,
  };
}

// 从分页 URL 中取出仓库参数，作为该页所属覆盖范围的依据。
export function warehouseOf(path) {
  return new URL(path, 'http://127.0.0.1').searchParams.get('warehouse');
}
