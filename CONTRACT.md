# 来源与消费契约

## 来源

入口 `/stock?supplier=S1&warehouse=W1&page=1`，HTML 内的 source-record JSON 节点保留了门户输出字段；rel=next 链接表示下一页。`fixtures/source.json` 的 opening 与 updated 是两个可切换的来源观察，不代表业务库必须得出某个预设结论；可添加新的来源观察验证行为。

库存粒度为 supplier/sku/warehouse。来源 manifest 描述本批仓库清单、批次号与分页完整性，空页仅证明该页为空；单仓成功不能证明全批完成。采购视图按仓位列出可供量，不把失败或未覆盖仓库归零。

## 业务消费

`readOperations(repository)` 当前返回 product 和 rows，每行带 sourceId/source/observedAt/attributes。现有 CLI 和结构化导入用于本地运维；新增采集结果也需要让业务读取入口看到一致状态，必要的解释信息可扩展返回。原始来源身份与 observedAt 不是通用的业务版本、完整性或成功证明。来源接口契约是兼容边界，采集、状态管理和新业务表达由实现决定。

### 批次接入语义

库存接入以“供应商批次 + manifest 覆盖清单”为单位（`src/batch-ingest.js`、`src/batch-service.js`、`src/snapshot-repository.js`）：

- 每次采集先读 manifest 取得批次号与仓库清单，再按仓库逐页读取；只跟随同仓的 rel=next，跨仓导航不改变覆盖清单。
- 库存行的身份是 `supplier|sku|warehouse`：同一 SKU 在不同仓库是独立库存行，后读到的行不得覆盖其他仓库。
- 只有 manifest 声明完整、清单内仓库全部确认且无批次/供应商/仓库一致性违规的尝试才是完整批次，才提升为采购对账快照；不完整的尝试只登记到 attempts，当前 active 快照保持不变，因此分页失败会保留上次完整结果。
- 三种库存状态严格分开：真实零库存是 `quantity:0` 的数据行（仓库状态 data）；成功读取但无记录的范围标记为 empty，不补零行；读取失败的页面使该仓标记为 missing（页面暂时缺项），采购员可在 coverage.unconfirmedWarehouses 看到未确认仓库与失败原因。
- 每次采集都重新读取 manifest 并独立翻页，记录的批次号与 manifest 不一致即登记 batch-mismatch 并拒绝提升，不同来源批次的分页不会被拼成同一份快照。
- 业务读取入口 `readBatchOperations` 只暴露 active 完整批次；尚无完整批次时返回 `no-complete-batch` 且 rows 为空，而不是把部分抓取当作库存。
