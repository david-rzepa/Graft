import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readLargeJson, writeLargeJson } from '../src/util/large-json.js';

test('large JSON round-trips chunk boundaries, Unicode, escapes and nested values', t => {
  const dir = mkdtempSync(join(tmpdir(), 'graft-large-json-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'graph.json');
  const value = { meta: { version: 1, unicode: '🎲' }, nodes: Array.from({length: 3000}, (_, i) => ({ id: String(i), text: 'é🎲\n"\\'.repeat(20), nested: [null, true, false, -12.5e10, {x: ']}{['}] })), edges: [], empty: null };
  writeLargeJson(path, value);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), value);
  assert.deepEqual(readLargeJson(path), value);
  writeFileSync(path, JSON.stringify(value, null, 2));
  assert.deepEqual(readLargeJson(path), value);
});

test('large JSON rejects corruption and keeps the previous file after a serialization failure', t => {
  const dir = mkdtempSync(join(tmpdir(), 'graft-large-json-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'graph.json');
  writeLargeJson(path, { nodes: [1] });
  assert.throws(() => writeLargeJson(path, {nodes: [2, BigInt(3)]}));
  assert.deepEqual(readLargeJson(path), {nodes: [1]});
  assert.deepEqual(readdirSync(dir), ['graph.json']);
  for (const text of ['{"nodes":[1,]}', '{"nodes":[1]', '{"nodes":[1]} garbage', '{"nodes":[],}', '{"nodes":[{"x":"unterminated}]}', '{"nodes":[1 2]}']) {
    writeFileSync(path, text); assert.throws(() => readLargeJson(path), undefined, text);
  }
  writeFileSync(path, '{"__proto__":{"value":1},"nodes":[]}');
  assert(Object.hasOwn(readLargeJson(path), '__proto__'));
});
