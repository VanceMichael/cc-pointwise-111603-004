import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from './source-client.js';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { readOperations } from './operations.js';

const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'collection-demo-'));
try {
  const repository = new RecordRepository(join(directory, 'records.json'));
  const service = new CollectionService(repository);
  const result = await service.ingestSupplier(new SourceClient(source.url), { supplier: 'S1' });
  console.log(JSON.stringify({ collected: result, operations: await readOperations(repository) }, null, 2));
} finally { await source.close(); await rm(directory, { recursive: true, force: true }); }
