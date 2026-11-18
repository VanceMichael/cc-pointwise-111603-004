import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from './source-client.js';
import { SnapshotRepository } from './snapshot-repository.js';
import { BatchService } from './batch-service.js';
import { readBatchOperations } from './operations.js';

const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'collection-demo-'));
try {
  const snapshots = new SnapshotRepository(join(directory, 'snapshots.json'));
  const service = new BatchService(new SourceClient(source.url), snapshots);

  async function run(stage, title) {
    source.publish(stage);
    const result = await service.collect();
    const view = await readBatchOperations(snapshots);
    console.log(`\n=== ${title}（来源阶段 ${stage}）===`);
    console.log(JSON.stringify({
      批次: result.batch,
      完整: result.complete,
      已提升: result.promoted,
      原因: result.reasons,
      未确认仓库: result.coverage.unconfirmedWarehouses,
      当前对账批次: view.batch,
      库存行: view.rows.map((row) => ({
        仓库: row.attributes.warehouse,
        SKU: row.attributes.sku,
        数量: row.attributes.quantity,
      })),
      仓库覆盖: view.coverage.warehouses,
    }, null, 2));
  }

  await run('opening', '完整批次：两个仓库都确认，成为对账快照');
  await run('incomplete', '分页失败：W2 缺项，半次抓取不提升，B1 继续生效');
  await run('zeroEmpty', '新完整批次：真实零库存保留为行，空范围只标记不补零');
} finally {
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
