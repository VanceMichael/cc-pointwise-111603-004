import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { startSource } from '../source/server.js';
import { parsePage, entryPath } from '../src/adapter.js';
import { SourceClient } from '../src/source-client.js';

async function observe(stage = 'opening', path = entryPath) {
  const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
  try {
    source.publish(stage);
    return parsePage(await new SourceClient(source.url).read(path));
  } finally { await source.close(); }
}

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));
}

test('warehouses are separate source ranges and incomplete batches are observable', async () => {
  const first = (await observe()).records[0].attributes;
  const second = (await observe('opening', '/stock?supplier=S1&warehouse=W2&page=1')).records[0].attributes;
  assert.equal(first.sku, second.sku);
  assert.notEqual(first.warehouse, second.warehouse);
  assert.equal(first.batch, second.batch);
  const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
  try {
    source.publish('incomplete');
    const manifest = await (await fetch(`${source.url}/stock/manifest`)).json();
    assert.equal(manifest.complete, false);
    assert.equal((await fetch(`${source.url}/stock?supplier=S1&warehouse=W2&page=1`)).status, 503);
  } finally { await source.close(); }
});
