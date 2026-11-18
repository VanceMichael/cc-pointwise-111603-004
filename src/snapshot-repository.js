import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const MAX_ATTEMPTS = 20;

// 批次状态与旧的记录集合分开组织：active 只指向完整批次，attempts 保留
// 每次采集尝试（包括分页失败的那一次）。写入是整文件原子替换，因此
// 一次失败绝不会让仓库停留在半个批次的状态。
export class SnapshotRepository {
  constructor(path) {
    this.path = path;
  }

  async readState() {
    try {
      const state = JSON.parse(await readFile(this.path, 'utf8'));
      return {
        active: state.active ?? null,
        attempts: Array.isArray(state.attempts) ? state.attempts : [],
      };
    } catch (error) {
      if (error.code === 'ENOENT') return { active: null, attempts: [] };
      throw error;
    }
  }

  async readActive() {
    return (await this.readState()).active;
  }

  async saveAttempt(attempt) {
    const state = await this.readState();
    state.attempts.push(attempt.summary);
    if (state.attempts.length > MAX_ATTEMPTS) {
      state.attempts = state.attempts.slice(state.attempts.length - MAX_ATTEMPTS);
    }
    if (attempt.complete) state.active = attempt.snapshot;
    await this.#write(state);
    return state;
  }

  async #write(state) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, this.path);
  }
}
