import { collectSupplier, snapshotRecords } from './collector.js';
import { findRecords, mergeRecords, normalizeRecord } from './records.js';

const HISTORY_LIMIT = 50;

function historyOf(state) {
  return Array.isArray(state?.attempts) ? state.attempts : [];
}

/**
 * Supplier stock is an organised collection, not a row-by-row upsert:
 *
 * - A complete batch snapshot is the only state used for purchasing
 *   reconciliation.
 * - A failed pagination run keeps the previous complete snapshot untouched and
 *   records exactly which warehouses were not confirmed.
 * - Attempts from different source batches are never merged into one snapshot.
 */
export class CollectionService {
  constructor(repository) { this.repository = repository; }

  /** Structured local import kept for the existing CLI. */
  async ingest(inputs) {
    if (!Array.isArray(inputs)) throw new TypeError('ingest input must be an array');
    const accepted = inputs.map(normalizeRecord);
    const current = await this.repository.read();
    const merged = mergeRecords(current, accepted);
    await this.repository.replace(merged);
    return { accepted: accepted.length, stored: merged.length };
  }

  async query(filters) { return findRecords(await this.repository.read(), filters); }

  async ingestSupplier(client, { supplier = 'S1', manifest } = {}) {
    const state = await this.repository.readState();
    const previous = state?.current ?? null;
    const { snapshot, attempt } = await collectSupplier(client, {
      supplier,
      ...(manifest ? { manifest } : {}),
      previousSnapshot: previous,
    });

    const attempts = [...historyOf(state), attempt].slice(-HISTORY_LIMIT);
    if (!snapshot) {
      attempt.applied = false;
      const records = await this.repository.read();
      await this.repository.commit(records, { current: previous, attempts });
      return {
        supplier,
        batch: attempt.batch,
        complete: false,
        applied: false,
        accepted: 0,
        stored: records.length,
        status: attempt.status,
        coverage: attempt.warehouses,
        unconfirmedWarehouses: attempt.unconfirmedWarehouses,
        attempt,
      };
    }

    const records = snapshotRecords(snapshot);
    attempt.applied = true;
    await this.repository.commit(records, { current: snapshot, attempts });
    return {
      supplier,
      batch: snapshot.batch,
      complete: true,
      applied: true,
      accepted: records.length,
      stored: records.length,
      status: 'complete',
      coverage: attempt.warehouses,
      unconfirmedWarehouses: [],
      attempt,
    };
  }
}
