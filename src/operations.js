const fields = ["supplier", "sku", "warehouse", "quantity", "batch", "capturedAt"];

export async function readOperations(repository) {
  const records = await repository.read();
  const state = await repository.readState();
  const snapshot = state?.current ?? null;
  const attempts = Array.isArray(state?.attempts) ? state.attempts : [];
  return {
    product: "供应商库存观察器",
    complete: Boolean(snapshot),
    supplier: snapshot?.supplier ?? null,
    batch: snapshot?.batch ?? null,
    collectedAt: snapshot?.collectedAt ?? null,
    rows: records.map((record) => ({
      sourceId: record.sourceId,
      source: record.source,
      observedAt: record.observedAt,
      attributes: Object.fromEntries(fields.map((field) => [field, record.attributes[field] ?? null])),
    })),
    warehouses: (snapshot?.warehouses ?? []).map((entry) => ({
      warehouse: entry.warehouse,
      status: entry.status,
      recordCount: entry.records.length,
      zeroCount: entry.records.filter((record) => record.attributes?.quantity === 0).length,
    })),
    lastAttempt: attempts.at(-1) ?? null,
  };
}
