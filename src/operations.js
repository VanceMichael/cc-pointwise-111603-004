import { schema } from './schema.js';

const fields = ["supplier", "sku", "warehouse", "quantity", "batch", "capturedAt"];

function toRow(record) {
  return {
    sourceId: record.sourceId,
    source: record.source,
    observedAt: record.observedAt,
    attributes: Object.fromEntries(fields.map((field) => [field, record.attributes[field] ?? null])),
  };
}

// 旧的结构化导入集合入口，保持现有 CLI 与测试行为不变。
export async function readOperations(repository) {
  const records = await repository.read();
  return { product: schema.product, rows: records.map(toRow) };
}

// 批次采集的采购视图：只暴露当前“完整批次”的快照。空范围不出现库存行、
// 缺项仓库不会被归零，而是在 coverage 中以状态和原因明确标注。
export async function readBatchOperations(snapshotRepository) {
  const active = await snapshotRepository.readActive();
  if (!active) {
    return {
      product: schema.product,
      status: 'no-complete-batch',
      supplier: null,
      batch: null,
      rows: [],
      coverage: { warehouses: [], unconfirmedWarehouses: [] },
      notice: '尚无完整批次，采购对账不可用；最近的失败尝试见采集状态',
    };
  }
  return {
    product: schema.product,
    status: 'complete',
    supplier: active.supplier,
    batch: active.batch,
    observedAt: active.observedAt,
    rows: active.records.map(toRow),
    coverage: {
      // data：读到库存行（含真实零库存）；empty：成功读取的空范围；
      // missing：页面暂时缺项，该仓未确认，不参与对账。
      warehouses: active.coverage.warehouses,
      unconfirmedWarehouses: active.coverage.unconfirmedWarehouses,
    },
  };
}
