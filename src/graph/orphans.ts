/** Conservative asset reachability. Never deletes or marks an asset safe to delete. */
import type { GraphV1 } from './types.js';
import { loadGraphCached } from './load.js';
import { contextDirFor } from '../context/node-file.js';
import { readFingerprint, probeDrift, isClean } from './fingerprint.js';

export interface OrphanReport {
  status: 'candidate-analysis';
  indexedAssets: number;
  reachableAssets: number;
  roots: { path: string; reason: string; evidence: string }[];
  totalCandidates: number;
  candidates: { path: string; reason: string; referencedBy: string[] }[];
  gaps: string[];
}
const assetPath = (path: string) => path.endsWith('.meta') ? path.slice(0, -5) : path;

export function findOrphans(graph: GraphV1, opts: { in?: string; limit?: number; gaps?: string[] } = {}): OrphanReport {
  const version = (graph.meta.plugins?.unity ?? '').split('.').map(Number);
  if (!(version[0] > 1 || (version[0] === 1 && version[1] >= 2))) {
    throw new Error('Rebuild with the Unity plugin version 1.2 or later to analyze orphan candidates.');
  }
  const nodes = new Map(graph.nodes.map(n => [n.id, n]));
  const assets = new Set<string>();
  const folders = new Set(graph.nodes.filter(n => n.role === 'Unity folder metadata').map(n => assetPath(n.path)));
  for (const n of graph.nodes) if (n.role === 'Unity asset metadata' || n.role === 'Unity serialized asset' || (n.kind === 'file' && n.path.endsWith('.cs'))) assets.add(assetPath(n.path));
  const outgoing = new Map<string, Set<string>>(), incoming = new Map<string, Set<string>>();
  const roots: OrphanReport['roots'] = [];
  for (const e of graph.edges) {
    const source = nodes.get(e.source), target = nodes.get(e.target);
    if (!source || !target) continue;
    const a = assetPath(source.path), b = assetPath(target.path);
    if (source.role === 'Unity asset entry point') roots.push({ path: b, reason: source.name, evidence: e.label ?? source.name });
    if (a === b) continue;
    const out = outgoing.get(a) ?? new Set(); out.add(b); outgoing.set(a, out);
    const inc = incoming.get(b) ?? new Set(); inc.add(a); incoming.set(b, inc);
  }
  const reachable = new Set(roots.map(r => r.path));
  const queue = [...reachable];
  for (let i = 0; i < queue.length; i++) for (const path of outgoing.get(queue[i]) ?? []) {
    if (!reachable.has(path)) { reachable.add(path); queue.push(path); }
  }
  const candidates = [...assets].filter(p => !reachable.has(p) && !folders.has(p) && /(?:^|\/)Assets\//.test(p))
    .sort().filter(p => !opts.in || p === opts.in || p.startsWith(opts.in.replace(/\/$/, '') + '/'))
    .map(path => {
      const referencedBy = [...(incoming.get(path) ?? [])].sort();
      return { path, reason: referencedBy.length ? 'Referenced only by assets outside the reachable set.' : 'No indexed incoming asset references.', referencedBy };
    });
  const gaps = [...new Set([
    'Candidates require review; static analysis does not establish that deletion is safe.',
    'Coverage is limited to indexed, non-ignored inputs within the configured scope and file-size limit; missing metadata and excluded files can hide dependencies.',
    'Binary asset contents, custom importers/build scripts, reflection and arbitrary runtime loading are not fully analyzed. Scripts are analyzed at file granularity using indexed references; C# type resolution and dynamically invoked code are incomplete. Configure roots for entry points the index cannot discover.',
    'Resources, Addressables entries, AssetBundles and non-script editor assets are conservatively retained. Platform-specific build profiles and remote content may need configured roots.',
    ...(graph.meta.diagnostics ?? []), ...(opts.gaps ?? []),
  ])];
  if (!roots.some(r => r.reason === 'Enabled build scene')) gaps.push('No enabled build scene roots were found; configure runtime entry points if this project uses another build pipeline.');
  const limit = opts.limit ?? candidates.length;
  if (!Number.isInteger(limit) || limit < 0) throw new Error('limit must be a nonnegative integer');
  return { status: 'candidate-analysis', indexedAssets: assets.size, reachableAssets: [...assets].filter(p => reachable.has(p)).length,
    roots: roots.sort((a, b) => a.path.localeCompare(b.path) || a.reason.localeCompare(b.reason)),
    totalCandidates: candidates.length, candidates: candidates.slice(0, limit), gaps };
}

export function orphanReport(root: string, contextDir?: string, opts: { in?: string; limit?: number } = {}): OrphanReport {
  const out = contextDirFor(root, contextDir), graph = loadGraphCached(out);
  if (!graph) throw new Error('No graph found — run graft build first.');
  const drift = probeDrift(root, out);
  if (!drift || !isClean(drift)) throw new Error('Graph is stale; rebuild successfully before analyzing orphan candidates.');
  const scope = readFingerprint(out)?.onlyDirs;
  return findOrphans(graph, { ...opts, gaps: scope?.length ? [`Partial build scope: ${scope.join(', ')}. Dependencies outside this scope were not analyzed.`] : [] });
}

export function formatOrphans(report: OrphanReport): string {
  return [
    `${report.totalCandidates} Unity orphan candidates (${report.candidates.length} shown); ${report.reachableAssets}/${report.indexedAssets} indexed assets reachable from ${report.roots.length} entry points.`,
    ...report.candidates.map(c => `${c.path}\n  ${c.reason}${c.referencedBy.length ? ` Referenced by: ${c.referencedBy.slice(0, 5).join(', ')}${c.referencedBy.length > 5 ? ' …' : ''}` : ''}`),
    '', 'Coverage:', ...report.gaps.map(g => `- ${g}`),
  ].join('\n');
}
