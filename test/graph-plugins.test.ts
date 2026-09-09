import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildGraph } from '../src/graph/build.js';
import { checkGraph } from '../src/graph/check.js';
import { readGraph, wiringPath } from '../src/graph/write.js';
import { ensureFreshGraph } from '../src/graph/refresh.js';
import { probeDrift, isClean } from '../src/graph/fingerprint.js';
import { planPlugins } from '../src/plugins/loader.js';
import { runCli } from './helpers.js';

const external = `import { version } from './helper.mjs';
export default {
  apiVersion: 1, id: 'example', version,
  analyze({ files, options }) {
    console.log('plugin stdout must not leak into MCP');
    return { nodes: [...files].map(([path, text]) => ({
      id: path, path, name: options.name ?? version, kind: 'file', origin: 'plugin',
      span: 'L1-L1', signature: null, exported: true, body_hash: text + version,
      summary_state: 'pending', summary: null, crux: null
    })), edges: [] };
  }
};
`;
function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'graft-plugins-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path: string, text: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  const config = (extra: object = {}) => put('.graft/plugins.json', JSON.stringify({ version: 1, plugins: [{ module: './index.mjs', extensions: ['.custom'], watch: ['helper.mjs'], ...extra }] }));
  put('index.mjs', external); put('helper.mjs', `export const version = '1';`); put('data.custom', 'hello');
  config();
  return { root, put, config, graph: () => readGraph(wiringPath(join(root, 'graft')))! };
}

test('external graph plugins load, track inputs/options/modules/dependencies, and reload through MCP freshness', async t => {
  const { root, put, config, graph } = fixture(t);
  await buildGraph(root);
  assert.equal(graph().meta.plugins?.example, '1');
  assert.ok(graph().nodes.some(n => n.path === 'data.custom' && n.name === '1'));
  assert.equal((await checkGraph(root)).ok, true);
  assert.ok(isClean(probeDrift(root, join(root, 'graft'))!));
  put('data.custom', 'changed');
  assert.ok((await ensureFreshGraph(root)).refreshed);
  assert.equal((await checkGraph(root)).ok, true);
  // A changed imported module must be reloaded even in this SAME long-lived process.
  put('helper.mjs', `export const version = '2';`);
  assert.equal((await checkGraph(root)).ok, false);
  assert.ok((await ensureFreshGraph(root)).refreshed);
  assert.equal(graph().meta.plugins?.example, '2');
  assert.ok(graph().nodes.some(n => n.path === 'data.custom' && n.name === '2'));
  config({ options: { name: 'configured' } });
  assert.ok((await ensureFreshGraph(root)).refreshed);
  assert.ok(graph().nodes.some(n => n.path === 'data.custom' && n.name === 'configured'));
  put('new.custom', 'new');
  assert.ok((await ensureFreshGraph(root)).refreshed);
  rmSync(join(root, 'data.custom'));
  assert.ok((await ensureFreshGraph(root)).refreshed);
  assert.ok(!graph().nodes.some(n => n.path === 'data.custom'));
  rmSync(join(root, '.graft/plugins.json'));
  assert.ok((await ensureFreshGraph(root)).refreshed);
  assert.ok(!graph().nodes.some(n => n.origin === 'plugin'));
});

test('external plugins cannot overwrite core nodes or publish dangling edges; last valid graph survives failure', async t => {
  const { root, put } = fixture(t);
  await buildGraph(root);
  const file = wiringPath(join(root, 'graft')), saved = readFileSync(file, 'utf8');
  put('index.mjs', external.replace('edges: []', `edges: [{source: 'data.custom', target: 'missing', relation: 'calls', confidence: 'extracted'}]`));
  await assert.rejects(buildGraph(root), /dangling edge/);
  assert.equal(readFileSync(file, 'utf8'), saved);
  put('index.mjs', external.replace('id: path,', `id: 'index.mjs',`));
  await assert.rejects(buildGraph(root), /duplicate node/);
  assert.equal(readFileSync(file, 'utf8'), saved);
  put('index.mjs', `export default { apiVersion: 2, id: 'example', version: '1', analyze() {} };`);
  await assert.rejects(buildGraph(root), /invalid graph plugin API/);
  assert.equal(readFileSync(file, 'utf8'), saved);
});

test('plugin discovery obeys Git ignores, directory scope and configurable input limits', async t => {
  const { root, put, config, graph } = fixture(t);
  execFileSync('git', ['init', '-q', root]);
  put('.gitignore', 'ignored/\n'); put('ignored/hidden.custom', 'hidden');
  put('keep/big.custom', 'x'.repeat(1_100_000)); put('other/outside.custom', 'outside');
  config({ maxFileBytes: 2_000_000 });
  await buildGraph(root, { onlyDirs: ['keep'] });
  assert.deepEqual(graph().nodes.map(n => n.path), ['keep/big.custom']);
  assert.equal((await checkGraph(root)).ok, true);
  assert.ok(isClean(probeDrift(root, join(root, 'graft'))!));
  put('ignored/hidden.custom', 'changed but ignored');
  assert.ok(isClean(probeDrift(root, join(root, 'graft'))!));
  await buildGraph(root);
  assert.ok(!graph().nodes.some(n => n.path.startsWith('ignored/')));
  assert.ok(graph().nodes.some(n => n.path === 'keep/big.custom'));
});

test('invalid plugin configuration is actionable and the CLI loads the same plugin configuration', async t => {
  const { root, put, config } = fixture(t);
  const r = runCli(['build', root]);
  assert.equal(r.status, 0, r.describe());
  assert.ok(!r.stdout.includes('plugin stdout must not leak'));
  put('.graft/plugins.json', '{not json}');
  assert.throws(() => planPlugins(root, join(root, 'graft')));
  config({ extensions: undefined });
  assert.throws(() => planPlugins(root, join(root, 'graft')), /declare extensions/);
  config({ maxFileBytes: -1 });
  assert.throws(() => planPlugins(root, join(root, 'graft')), /maxFileBytes/);
  config({ watch: ['../outside.mjs'] });
  assert.throws(() => planPlugins(root, join(root, 'graft')), /watch paths/);
});

test('large plugin results build without exceeding JavaScript argument limits', async t => {
  const { root, put, graph } = fixture(t);
  put('index.mjs', `export default {
    apiVersion: 1, id: 'large', version: '1',
    analyze() {
      const nodes = Array.from({ length: 150000 }, (_, i) => ({
        id: 'data.custom#plugin:large:' + i, path: 'data.custom', name: 'object' + i,
        kind: 'variable', origin: 'plugin', span: 'L1-L1', signature: null,
        exported: true, body_hash: 'synthetic', summary_state: 'pending', summary: null, crux: null
      }));
      return { nodes, edges: nodes.map(n => ({ source: nodes[0].id, target: n.id, relation: 'references', confidence: 'extracted' })) };
    }
  };`);
  await buildGraph(root, { graphOnly: true });
  const g = graph();
  assert.equal(g.nodes.filter(n => n.origin === 'plugin').length, 150000);
  assert.equal(g.edges.filter(e => e.plugin === 'large').length, 150000);
});
