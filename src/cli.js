import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { SourceClient } from './source-client.js';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const action = argv[0] ?? '--help';

if (action === '--help' || action === '-h') {
  console.log(JSON.stringify({
    usage: 'npm start -- ingest [文件] [--store 路径] | ingest --source URL [--supplier S1] [--store 路径] | query [来源] [--store 路径]',
    commands: ['ingest', 'query'],
    environment: { RECORD_STORE: '运行状态目录内的记录文件路径' },
  }));
  process.exit(0);
}

function takeOptions(args, names) {
  const rest = [...args];
  const options = {};
  for (const name of names) {
    const index = rest.indexOf(`--${name}`);
    if (index < 0) continue;
    if (!rest[index + 1]) throw new Error(`--${name} requires a value`);
    options[name] = rest[index + 1];
    rest.splice(index, 2);
  }
  return { args: rest, options };
}

const { args, options } = takeOptions(argv.slice(1), ['store', 'source', 'supplier']);
const repository = new RecordRepository(options.store ?? process.env.RECORD_STORE ?? resolve(here, '../var/records.json'));
const service = new CollectionService(repository);

if (action === 'ingest') {
  if (options.source) {
    console.log(JSON.stringify(await service.ingestSupplier(new SourceClient(options.source), {
      supplier: options.supplier ?? 'S1',
    }), null, 2));
  } else {
    const records = JSON.parse(await readFile(args[0] ?? resolve(here, '../fixtures/records.json'), 'utf8'));
    console.log(JSON.stringify(await service.ingest(records), null, 2));
  }
} else if (action === 'query') {
  console.log(JSON.stringify(await service.query({ source: args[0] }), null, 2));
} else {
  throw new Error('action must be ingest or query');
}
