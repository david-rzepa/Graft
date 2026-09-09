import type { EdgeV1, NodeV1 } from '../graph/types.js';

/** Versioned, additive graph extension. Runs on every structural rebuild, including MCP refresh. */
export interface GraphPlugin {
  apiVersion: 1;
  id: string;
  /** Change when extraction semantics or bundled dependencies change. */
  version: string;
  analyze(context: PluginContext): PluginResult | Promise<PluginResult>;
}

export interface PluginContext {
  root: string;
  /** Declared inputs only, repo-relative POSIX paths. No ignored or out-of-scope files. */
  files: ReadonlyMap<string, string>;
  /** Core code nodes, before enrichment. Plugins cannot replace core nodes. */
  nodes: readonly Readonly<NodeV1>[];
  options: Readonly<Record<string, unknown>>;
}

export interface PluginResult {
  nodes: NodeV1[];
  edges: EdgeV1[];
  /** Coverage limitations, not fatal errors. Stored in graph metadata and shown by check/build. */
  diagnostics?: string[];
}

export interface PluginSpec {
  /** Built-in "unity", an installed package, or a repo-relative ES module (./...). */
  module: string;
  /** Required for external plugins. Declares all input suffixes, including leading dots. */
  extensions?: string[];
  options?: Record<string, unknown>;
  /** Input ceiling (default 16 MB for Unity, 1 MB otherwise), maximum 64 MB. */
  maxFileBytes?: number;
  /** Additional repo-relative implementation files whose changes invalidate the plugin. */
  watch?: string[];
}
