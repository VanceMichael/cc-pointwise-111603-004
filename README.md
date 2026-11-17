# 供应商库存观察器

Node.js 本地数据接入项目。接入把供应商库存按**完整批次**组织：一次采集读取 manifest 声明的全部仓库及其分页，只有完整批次才会替换业务库存并用于新的采购对账；失败的分页不会成为库存。`sourceId` 只是来源行标识，库存粒度为 supplier/sku/warehouse，同一 SKU 在不同仓库的数量并存。

## 运行

需要 Node.js 22，无第三方包、远程服务或账户凭据。

- `npm test`：行为与本地接口测试。
- `npm run demo`：启动临时来源，采集完整批次并展示业务查询，结束时关闭监听并清理临时数据。
- `npm start -- ingest`：从 `fixtures/records.json` 做结构化导入（保留的本地运维入口，按 sourceId 合并）。
- `npm start -- ingest --source URL [--supplier S1] [--store 路径]`：从本地回环来源采集整个供应商批次。
- `npm start -- query [来源]`：读取本地集合，默认 `var/records.json`；`--store` 或 `RECORD_STORE` 可指定状态文件。
- `npm run acceptance`：在临时目录验证首批导入、重启回读、重放、整批采集、失败分页后保留上一完整批次，以及业务查询，完成后清理临时状态。

演示数据不访问生产站点。

## 采集语义

来源入口 `/stock?supplier=S1&warehouse=W1&page=1`（仓库分页）与 `/stock/manifest`（批次、仓库清单、完整性）见 [CONTRACT.md](CONTRACT.md)。

采集逐仓库跟随 `rel=next` 分页，只接受同一 supplier/warehouse 范围、且批次号等于 manifest 批次的记录。任意页面失败、批次不一致、manifest 声明不完整，或同一仓库中出现上次有而本次缺失的条目时，本次采集**不提交**：

- 上一份完整批次的库存原样保留并继续作为唯一对账依据；
- 本次各仓库状态写入采集记录：`confirmed`、`empty`（成功读取的空范围）、`missing-items`（页面缺项）、`failed` / `partial`（读取失败）、`unconfirmed`（未读取）；
- 业务读取 `readOperations` 返回上一完整批次的 `batch`、`warehouses` 和 `lastAttempt`；`lastAttempt.unconfirmedWarehouses` 明确列出本次没有确认的仓库。

三种容易混淆的情况被分开表示：真实零库存是 `confirmed` 且该 SKU 的 `quantity` 为 0（`zeroCount` 计数）；仓库确实没有任何库存是 `empty`；页面本来应当有某 SKU 却缺席是 `missing-items`，不会当成零。失败或未覆盖的仓库不会补 0，也不会用后读到的一行覆盖全局库存。

重试会重新读取 manifest 开始一次新采集；不同批次、不同来源的页面不会被拼成一份"看似完整"的快照。记录与批次状态作为一次原子替换写入，`src/operations.js` 的业务视图不会出现半份快照。

## 组件和数据

`source/server.js` 读取 `fixtures/source.json` 并监听随机回环端口。`startSource()` 返回 url、publish(stage)、failNext(path,status) 和 close()；publish 切换可观察来源版本而不修改业务仓库，failNext 可返回 503 或使用 disconnect 断开连接。它记录请求路径并支持来源 ETag/304。

`src/source-client.js` 只接受同一回环来源。`src/adapter.js` 解析来源行、分页链接与 manifest。`src/records.js` 定义按 supplier/sku/warehouse 的库存粒度和合并规则。`src/collector.js` 执行整批采集并产出快照或带覆盖清单的失败尝试。`src/service.js` 与 `src/repository.js` 维护持久集合和批次状态；`src/operations.js` 是业务消费入口。

状态目录属于运行产物。测试直接使用随机端口来源，不需要等待真实时间或接入外网。
