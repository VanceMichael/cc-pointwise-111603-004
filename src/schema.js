export const schema = Object.freeze({
  "product": "供应商库存观察器",
  "entity": "库存条目",
  "identity": "sourceId",
  "required": [
    "sourceId",
    "source",
    "observedAt",
    "label"
  ],
  "description": "供应商库存页面的批次对账"
});
