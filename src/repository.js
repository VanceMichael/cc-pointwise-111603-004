import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

function normalizeStore(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.records)) {
    throw new Error('record file has no records array');
  }
  const state = value.state && typeof value.state === 'object' && !Array.isArray(value.state) ? value.state : null;
  return { records: value.records, state };
}

export class RecordRepository {
  constructor(path) { this.path = path; }

  async #readStore() {
    try {
      return normalizeStore(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') return { records: [], state: null };
      throw error;
    }
  }

  async read() {
    return (await this.#readStore()).records;
  }

  async readState() {
    return (await this.#readStore()).state;
  }

  async #write(store) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, this.path);
  }

  /**
   * Legacy local import: replaces the record collection but carries no batch
   * coverage, so any previous complete-batch state is dropped rather than
   * paired with unrelated rows.
   */
  async replace(records) {
    await this.#write({ records, state: null });
  }

  /**
   * A batch commit replaces the accepted records and the collection state in a
   * single atomic rename, so the business view can never pair one batch's rows
   * with another batch's coverage report.
   */
  async commit(records, state) {
    await this.#write({ records, state });
  }
}
