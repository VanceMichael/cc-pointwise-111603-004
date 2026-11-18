import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { SnapshotRepository } from './snapshot-repository.js';
import { SourceClient } from './source-client.js';
import { BatchService } from './batch-service.js';
import { readBatchOperations } from './operations.js';

const here = dirname(fileURLToPath(import.meta.url));
const stateDir = resolve(here, '../var');
const service = new CollectionService(new RecordRepository(resolve(stateDir, 'records.json')));
const snapshots = new SnapshotRepository(resolve(stateDir, 'snapshots.json'));
const action = process.argv[2] ?? '--help';
if (action === '--help' || action === '-h') {
  console.log(JSON.stringify({
    usage: 'npm start -- ingest [文件] | query [来源] | collect <来源URL> | coverage',
    commands: ['ingest', 'query'],
    batchCommands: ['collect', 'coverage'],
  }));
  process.exit(0);
}
if (action === 'ingest') {
  const records = JSON.parse(await readFile(process.argv[3] ?? resolve(here, '../fixtures/records.json'), 'utf8'));
  console.log(JSON.stringify(await service.ingest(records), null, 2));
} else if (action === 'query') {
  console.log(JSON.stringify(await service.query({ source: process.argv[3] }), null, 2));
} else if (action === 'collect') {
  const baseUrl = process.argv[3];
  if (!baseUrl) throw new Error('collect requires a local source URL, e.g. npm start -- collect http://127.0.0.1:PORT');
  const result = await new BatchService(new SourceClient(baseUrl), snapshots).collect();
  console.log(JSON.stringify(result, null, 2));
} else if (action === 'coverage') {
  console.log(JSON.stringify(await readBatchOperations(snapshots), null, 2));
} else {
  throw new Error('action must be ingest or query');
}
