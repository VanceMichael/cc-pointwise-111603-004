const fields = ["supplier", "sku", "warehouse", "quantity", "batch", "capturedAt"];

export async function readOperations(repository) {
  const records = await repository.read();
  return { product: "供应商库存观察器", rows: records.map((record) => ({
    sourceId: record.sourceId,
    source: record.source,
    observedAt: record.observedAt,
    attributes: Object.fromEntries(fields.map((field) => [field, record.attributes[field] ?? null])),
  })) };
}
