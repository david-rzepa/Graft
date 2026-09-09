import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MAX_FILE_BYTES, walkDir } from '../ingest/fs.js';
import { filterByOnlyDirs } from '../graph/source-files.js';
import { readFollowNestedRepos, readFollowSubmodules, readIncludeDirs } from '../util/state.js';
import { readSourceFile } from '../util/source.js';
import { contentHash } from '../util/id.js';
import { relPosix } from '../util/paths.js';
import { stampDir } from '../graph/extract-cache.js';
import { checkGraphInvariants } from '../graph/invariants.js';
import type { GraphV1, NodeV1, EdgeV1 } from '../graph/types.js';
import { runExternal } from './external.js';
import type { GraphPlugin, PluginSpec } from './types.js';

export const PLUGIN_CONFIG = '.graft/plugins.json';
const UNITY_EXTENSIONS = ['.cs', '.meta', '.unity', '.prefab', '.asset', '.mat', '.controller', '.overridecontroller', '.anim'];
export interface PluginPlan {
  signature: string;
  plugins: { spec: PluginSpec; entry: string; identity: string; files: string[] }[];
}
export interface PluginSnapshot {
  signature: string;
  files: Record<string, [number, number, string]>;
}

function inside(root: string, path: string): boolean {
  const r = relative(root, path);
  return r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r);
}

/** Planning never executes repository code. Configuration and module bytes are fingerprinted. */
export function planPlugins(root: string, outDir: string, repoFiles?: string[], onlyDirs?: ReadonlySet<string>): PluginPlan {
  const configPath = join(root, PLUGIN_CONFIG);
  if (!existsSync(configPath)) return { signature: '', plugins: [] };
  const text = readFileSync(configPath, 'utf8');
  let config;
  try { config = JSON.parse(text); } catch { throw new Error(`${PLUGIN_CONFIG}: invalid JSON`); }
  if (!config || config.version !== 1 || !Array.isArray(config.plugins)) throw new Error(`${PLUGIN_CONFIG}: expected version: 1 and plugins array`);
  const specs = config.plugins as PluginSpec[];
  const limits = specs.map(s => s?.maxFileBytes ?? (s?.module === 'unity' ? 16_000_000 : MAX_FILE_BYTES));
  if (limits.some(n => !Number.isInteger(n) || n <= 0 || n > 64_000_000)) throw new Error('plugin maxFileBytes must be 1..64000000');
  const maxFileBytes = Math.max(MAX_FILE_BYTES, ...limits);
  const walked = specs.length ? filterByOnlyDirs((maxFileBytes === MAX_FILE_BYTES ? repoFiles : undefined) ?? walkDir(root, readIncludeDirs(root), {
    followSubmodules: readFollowSubmodules(root), followNestedRepos: readFollowNestedRepos(root), maxFileBytes,
  }), root, onlyDirs).filter(f => !inside(outDir, f)) : [];
  const seen = new Set<string>();
  const plugins = specs.map((spec, index) => {
    if (!spec || typeof spec.module !== 'string' || !spec.module) throw new Error('plugin module must be a nonempty string');
    if (seen.has(spec.module)) throw new Error(`duplicate plugin: ${spec.module}`);
    seen.add(spec.module);
    if (spec.options !== undefined && (!spec.options || typeof spec.options !== 'object' || Array.isArray(spec.options))) throw new Error(`invalid options for ${spec.module}`);
    const extensions = spec.extensions ?? (spec.module === 'unity' ? UNITY_EXTENSIONS : undefined);
    if (!extensions || !Array.isArray(extensions) || extensions.some(e => typeof e !== 'string' || !/^\.[\w.-]+$/.test(e))) throw new Error(`plugin ${spec.module}: declare extensions, e.g. [".yaml"]`);
    let entry: string;
    if (spec.module === 'unity') entry = fileURLToPath(new URL(`./unity${extname(import.meta.url)}`, import.meta.url));
    else if (spec.module.startsWith('./')) {
      entry = resolve(root, spec.module);
      if (!inside(root, entry)) throw new Error('plugin module must stay inside repository');
    } else {
      if (isAbsolute(spec.module) || spec.module.startsWith('../')) throw new Error('use an installed package or ./relative module');
      entry = createRequire(join(root, 'package.json')).resolve(spec.module);
    }
    if (spec.watch !== undefined && (!Array.isArray(spec.watch) || spec.watch.some(p => typeof p !== 'string' || !inside(root, resolve(root, p))))) throw new Error('plugin watch paths must stay inside repository');
    const identity = contentHash(JSON.stringify(spec) + readFileSync(entry, 'utf8') + (spec.watch ?? []).map(p => readFileSync(resolve(root, p), 'utf8')).join('\0'));
    const suffixes = new Set(extensions.map(e => e.toLowerCase()));
    const files = walked.filter(f => suffixes.has(extname(f).toLowerCase()) && statSync(f).size <= limits[index]).sort();
    return { spec, entry, identity, files };
  });
  return { signature: contentHash(text + plugins.map(p => p.identity).join('\0') + (stampDir(dirname(fileURLToPath(import.meta.url)), extname(import.meta.url)) ?? '')), plugins };
}

/** Fail before publishing any graph if a plugin throws or violates the additive contract. */
export async function runPlugins(root: string, plan: PluginPlan, coreNodes: NodeV1[]) {
  const snapshot: PluginSnapshot = { signature: plan.signature, files: {} };
  const sources = new Map<string, string>();
  const nodes: NodeV1[] = [];
  const edges: EdgeV1[] = [];
  const diagnostics: string[] = [];
  const versions: Record<string, string> = {};
  const ids = new Set(coreNodes.map(n => n.id));
  if (!plan.plugins.length) return { snapshot, sources, nodes, edges, diagnostics, versions };
  const base = Object.freeze(coreNodes.map(n => Object.freeze(structuredClone(n))));
  for (const p of plan.plugins) {
    const files = new Map<string, string>();
    for (const abs of p.files) {
      const stat = statSync(abs);
      const text = readSourceFile(abs);
      if (text === null) throw new Error(`unsupported plugin input encoding: ${relPosix(root, abs)}`);
      files.set(relPosix(root, abs), text);
      sources.set(relPosix(root, abs), text);
      snapshot.files[relPosix(root, abs)] = [stat.size, stat.mtimeMs, contentHash(text)];
    }
    let plugin: { id: string; version: string }, result: import('./types.js').PluginResult;
    if (p.spec.module === 'unity') {
      const url = pathToFileURL(p.entry);
      url.searchParams.set('graft', p.identity);
      const implementation = (await import(url.href)).default as GraphPlugin;
      plugin = implementation;
      result = await implementation.analyze({ root, files, nodes: base, options: Object.freeze(structuredClone(p.spec.options ?? {})) });
    } else {
      const executed = await runExternal(p.entry, root, files, base, p.spec.options ?? {});
      plugin = executed; result = executed.result;
    }
    if (versions[plugin.id]) throw new Error(`duplicate plugin id: ${plugin.id}`);
    if (result?.diagnostics !== undefined && (!Array.isArray(result.diagnostics) || result.diagnostics.some(d => typeof d !== 'string'))) throw new Error(`plugin ${plugin.id}: diagnostics must be strings`);
    if (!Array.isArray(result?.nodes) || !Array.isArray(result?.edges)) throw new Error(`plugin ${plugin.id}: expected nodes and edges arrays`);
    for (const n of result.nodes) {
      if (!n || typeof n.id !== 'string' || typeof n.path !== 'string') throw new Error(`plugin ${plugin.id}: invalid node identity`);
      if (ids.has(n.id)) throw new Error(`plugin ${plugin.id}: duplicate node ${n.id}`);
      if (!files.has(n.path)) throw new Error(`plugin ${plugin.id}: node outside declared inputs: ${n.path}`);
      if (n.id === n.path && n.kind !== 'file') throw new Error(`plugin ${plugin.id}: bare path IDs are reserved for file nodes`);
      if (n.id !== n.path && !n.id.startsWith(`${n.path}#plugin:${plugin.id}:`)) throw new Error(`plugin ${plugin.id}: node must use path#plugin:${plugin.id}: namespace`);
      if (n.origin !== 'plugin' || !n.body_hash) throw new Error(`plugin ${plugin.id}: node requires plugin origin and body_hash`);
      ids.add(n.id);
    }
    // No unresolved plugin targets: omissions must be diagnostics, never phantom dependencies.
    for (const e of result.edges) if (!ids.has(e.source) || !ids.has(e.target)) throw new Error(`plugin ${plugin.id}: dangling edge ${e.source} -> ${e.target}`);
    for (const node of result.nodes) nodes.push(node);
    for (const edge of result.edges) edges.push({ ...edge, plugin: plugin.id });
    diagnostics.push(...(result.diagnostics ?? []).map(d => `${plugin.id}: ${d}`));
    versions[plugin.id] = plugin.version;
  }
  const graph: GraphV1 = { meta: { version: 1, nodeCount: nodes.length + coreNodes.length, edgeCount: edges.length, languages: [] }, nodes: [...coreNodes, ...nodes], edges };
  const problems = checkGraphInvariants(graph).problems;
  if (problems.length) throw new Error(`invalid plugin graph: ${problems.slice(0, 8).join('; ')}`);
  const unique = new Map(edges.map(e => [`${e.source}\0${e.relation}\0${e.target}\0${e.label ?? ''}`, e]));
  return { snapshot, sources, nodes, edges: [...unique.values()], diagnostics: [...new Set(diagnostics)].sort(), versions };
}
