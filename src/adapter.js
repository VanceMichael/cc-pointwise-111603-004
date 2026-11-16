export const entryPath = "/stock?supplier=S1&warehouse=W1&page=1";

export function parsePage(response) {
  const items = [...response.text.matchAll(/<script type="application\/json" class="source-record">([\s\S]*?)<\/script>/g)]
    .map((match) => JSON.parse(match[1]));
  if (!items.length) throw new Error('source layout contains no records');
  const next = response.text.match(/rel="next" href="([^"]+)"/)?.[1] ?? null;
  return { next, records: items.map((item) => ({
    sourceId: String(item["sku"]),
    source: "供应商库存观察器",
    observedAt: item["capturedAt"],
    label: String(item["sku"]),
    attributes: structuredClone(item),
  })) };
}
