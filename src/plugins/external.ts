import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import type { NodeV1 } from '../graph/types.js';
import type { PluginResult } from './types.js';

/** A fresh process gives external plugins a fresh module/dependency cache on each
 * rebuild. Console output cannot corrupt MCP's stdout. This is isolation, not a
 * security sandbox: enabled plugins have the same filesystem/network permissions
 * as Graft. Only enable code you trust. */
const RUNNER = `
let text = '';
for await (const chunk of process.stdin) text += chunk;
try {
  const input = JSON.parse(text);
  const plugin = (await import(input.entry)).default;
  if (plugin?.apiVersion !== 1 || !/^[a-z][a-z0-9-]*$/.test(plugin.id) || typeof plugin.version !== 'string' || !plugin.version || typeof plugin.analyze !== 'function') throw new Error('invalid graph plugin API (expected v1 default export)');
  const result = await plugin.analyze({ root: input.root, files: new Map(input.files), nodes: input.nodes, options: input.options });
  process.send({ id: plugin.id, version: plugin.version, result }, () => process.exit(0));
} catch (error) {
  process.send({ error: error instanceof Error ? error.message : String(error) }, () => process.exit(1));
}
`;
export function runExternal(entry: string, root: string, files: Map<string, string>, nodes: readonly Readonly<NodeV1>[], options: Record<string, unknown>): Promise<{ id: string; version: string; result: PluginResult }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', RUNNER], { stdio: ['pipe', 'ignore', 'pipe', 'ipc'] });
    let response: { id: string; version: string; result: PluginResult; error?: string } | undefined;
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 60_000);
    child.on('message', message => { response = message as typeof response; });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      if (response?.error) reject(new Error(`plugin ${entry}: ${response.error}`));
      else if (code !== 0 || !response?.result) reject(new Error(`plugin ${entry} exited ${code ?? 'by signal'}: ${stderr}`));
      else resolve(response);
    });
    child.stdin?.on('error', () => { /* early process exit is handled above */ });
    child.stdin?.end(JSON.stringify({ entry: pathToFileURL(entry).href, root, files: [...files], nodes, options }));
  });
}
