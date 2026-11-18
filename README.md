# 供应商库存观察器

Node.js 本地数据接入项目。具备两条互不干扰的接入路径：结构化导入（以 sourceId 保存最新观察的 records 集合）与按供应商批次组织的来源采集（manifest 覆盖清单 + 分页完整性）。来源服务和业务存储独立，来源变化不会自动刷新本地集合。批次采集只有在完整批次确认后才提升为采购对账快照，分页失败保留上次完整结果。

## 运行

需要 Node.js 22，无第三方包、远程服务或账户凭据。`npm test` 运行现有行为与本地接口测试；`npm run demo` 启动临时来源，依次演示完整批次提升、分页失败保留上次结果、真实零库存与空范围区分，结束时自动关闭监听并清理临时数据，通常两秒内完成。`npm start -- ingest` 从 `fixtures/records.json` 导入，`npm start -- query` 读取本地 `var/records.json`；`npm start -- collect <来源URL>` 执行一次批次采集，`npm start -- coverage` 输出当前完整批次的采购视图与未确认仓库。演示数据不访问生产站点。

## 组件和数据

`source/server.js` 读取 `fixtures/source.json` 并监听随机回环端口。`startSource()` 返回 url、publish(stage)、failNext(path,status) 和 close()；publish 切换可观察来源版本而不修改业务仓库，failNext 可返回 503 或使用 disconnect 断开连接。它记录请求路径并支持来源 ETag/304。`src/source-client.js` 只接受同一回环来源；`src/adapter.js` 解析来源页面并保留原始来源属性，返回 records、next 与 empty（成功读取的空页是合法结果，不再抛错），并结构化解析 manifest。

批次采集由 `src/batch-ingest.js` 编排：先读 `/stock/manifest` 取得批次号与仓库覆盖清单，再按仓库逐页读取，只跟随同仓分页链接；每条记录校验批次、供应商与仓库归属，分页失败记为该仓 missing 并结束本次尝试。`src/batch-service.js` 把完整尝试构建为按 `supplier|sku|warehouse` 标识的快照（同 SKU 不同仓互不覆盖），`src/snapshot-repository.js` 在独立的 `var/snapshots.json` 中原子维护 active 完整快照与历次 attempts（含失败尝试）。`src/operations.js` 的 `readBatchOperations` 只暴露 active 快照，按仓位列出可供量并附 coverage：data（含真实零库存）、empty（成功读取的空范围，不补零）、missing（页面暂时缺项，列入 unconfirmedWarehouses）。重试从 manifest 重新开始，不同来源批次的分页不会拼成一份快照。

状态目录属于运行产物。扩展导入时应保留现有 CLI 和现有集合查询能力；新增状态可以另行组织。测试可直接使用随机端口来源，不需要等待真实时间或接入外网。运行录制可用 test 和 demo，无需安装浏览器或外部数据库。

`npm start` 或 `npm start -- --help` 查看命令；原导入和查询使用显式的 ingest、query 动作，批次采集使用 collect、coverage。`npm run acceptance` 在临时目录中验证本地来源读取、首批导入、重启回读、重放、业务查询，以及完整批次提升、分页失败保留与新批次恢复的批次生命周期，完成后清理临时状态。
