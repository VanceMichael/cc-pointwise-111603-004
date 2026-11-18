import { normalizeRecord } from './records.js';
import { collectBatch } from './batch-ingest.js';

function granularKey(attributes) {
  return [attributes.supplier, attributes.sku, attributes.warehouse]
    .map((value) => String(value ?? ''))
    .join('|');
}

function buildSnapshot(attempt) {
  const rowByKey = new Map();
  for (const record of attempt.records) {
    const normalized = normalizeRecord({
      ...record,
      // 同一 SKU 在不同仓库是不同库存行，键必须含仓库，避免后读行覆盖全局。
      sourceId: granularKey(record.attributes),
    });
    const key = granularKey(normalized.attributes);
    const current = rowByKey.get(key);
    if (!current || Date.parse(normalized.observedAt) >= Date.parse(current.observedAt)) {
      rowByKey.set(key, normalized);
    }
  }
  const rows = [...rowByKey.values()]
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  const observedAt = rows.reduce(
    (latest, row) => (Date.parse(row.observedAt) > Date.parse(latest) ? row.observedAt : latest),
    attempt.finishedAt,
  );
  return {
    supplier: attempt.manifest.supplier,
    batch: attempt.manifest.batch,
    observedAt,
    capturedAt: attempt.finishedAt,
    // 空范围（成功读取但无记录）与页面缺项（读取失败）作为覆盖状态呈现，
    // 不被写成数量 0 的库存行；真实零库存是带 quantity:0 的数据行，照常保留。
    coverage: structuredClone(attempt.coverage),
    records: rows,
  };
}

function summarizeAttempt(attempt, promoted) {
  return {
    supplier: attempt.manifest.supplier,
    batch: attempt.manifest.batch,
    complete: attempt.complete,
    promoted,
    reasons: attempt.reasons,
    startedAt: attempt.startedAt,
    finishedAt: attempt.finishedAt,
    recordCount: attempt.records.length,
    pageCount: attempt.pages.length,
    coverage: structuredClone(attempt.coverage),
    failures: structuredClone(attempt.failures),
    violations: structuredClone(attempt.violations),
  };
}

export class BatchService {
  constructor(client, snapshotRepository) {
    this.client = client;
    this.snapshots = snapshotRepository;
  }

  // 每次调用都是一个独立批次尝试：读取失败只登记尝试，不触碰当前有效快照。
  // 重试从 manifest 重新开始，因此不同来源批次的分页永远不会拼成一份快照。
  async collect() {
    const before = await this.snapshots.readState();
    const previousBatch = before.active?.batch ?? null;
    const attempt = await collectBatch(this.client);
    const promoted = attempt.complete;
    const state = await this.snapshots.saveAttempt({
      complete: attempt.complete,
      snapshot: promoted ? buildSnapshot(attempt) : null,
      summary: summarizeAttempt(attempt, promoted),
    });
    return {
      complete: attempt.complete,
      promoted,
      reasons: attempt.reasons,
      supplier: attempt.manifest.supplier,
      batch: attempt.manifest.batch,
      previousBatch,
      activeBatch: state.active?.batch ?? null,
      recordCount: attempt.records.length,
      pageCount: attempt.pages.length,
      pages: structuredClone(attempt.pages),
      coverage: attempt.coverage,
      failures: attempt.failures,
      violations: attempt.violations,
    };
  }
}
