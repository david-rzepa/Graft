/** Unity text-serialization indexer. No editor, model, or network required. */
import { basename, extname } from 'node:path';
import { parse } from 'yaml';
import { Parser, type Language, type Node as SyntaxNode } from 'web-tree-sitter';
import { loadWasmLanguage } from '../graph/generic.js';
import { contentHash } from '../util/id.js';
import type { EdgeV1, NodeV1 } from '../graph/types.js';
import type { GraphPlugin, PluginContext, PluginResult } from './types.js';

type Obj = Record<string, unknown>;
interface Document {
  path: string; id: string; type: string; data: Obj; node: NodeV1;
}
const object = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const scalar = (v: unknown): string => typeof v === 'string' || typeof v === 'number' ? String(v) : '';
const guidOf = (v: unknown): string => /^[a-f\d]{32}$/i.test(scalar(v)) ? scalar(v).toLowerCase() : '';
const nullGuid = (g: string) => !g || /^0+$/.test(g);
const assetId = (path: string) => `${path}#plugin:unity:asset`;
const docId = (path: string, id: string) => `${path}#plugin:unity:object:${id}`;

function node(path: string, id: string, name: string, role: string, text: string, start = 1, end = Math.max(1, text.split('\n').length), kind: NodeV1['kind'] = 'variable'): NodeV1 {
  return { id, path, name, kind, role, span: `L${start}-L${end}`, signature: `${role} ${name}`, origin: 'plugin', exported: true,
    body_hash: contentHash(text), body_text: `${role} ${name} ${text}`.slice(0, 4096), summary_state: 'pending', summary: null, crux: null };
}

/** Enumerate mappings and their full serialized property paths; never evaluate YAML aliases. */
function visit(value: unknown, fn: (v: Obj, path: string) => void, path = '', depth = 0): void {
  if (depth > 128) throw new Error('serialized nesting exceeds 128 levels');
  if (Array.isArray(value)) value.forEach((v, i) => visit(v, fn, `${path}[${i}]`, depth + 1));
  else if (object(value)) {
    fn(value, path);
    for (const [k, v] of Object.entries(value)) visit(v, fn, path ? `${path}.${k}` : k, depth + 1);
  }
}

function parseDocuments(path: string, text: string): Document[] {
  const lines = text.split('\n');
  const heads: { at: number; id: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^--- !u!\d+ &(-?\d+)(?: stripped)?\s*$/.exec(lines[i]);
    if (m) heads.push({ at: i, id: m[1] });
  }
  const result: Document[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < heads.length; i++) {
    const head = heads[i], end = heads[i + 1]?.at ?? lines.length;
    if (ids.has(head.id)) throw new Error(`duplicate fileID ${head.id}`);
    ids.add(head.id);
    const body = lines.slice(head.at + 1, end).join('\n');
    // failsafe preserves GUIDs with only digits and 64-bit fileIDs exactly.
    const value: unknown = parse(body, { schema: 'failsafe', maxAliasCount: 0, logLevel: 'error' });
    if (!object(value) || Object.keys(value).length !== 1) throw new Error(`invalid Unity object at line ${head.at + 1}`);
    const type = Object.keys(value)[0];
    const data = value[type];
    if (!object(data)) throw new Error(`invalid ${type} at line ${head.at + 1}`);
    const name = scalar(data.m_Name) || `${type} ${head.id}`;
    result.push({ path, id: head.id, type, data, node: node(path, docId(path, head.id), name, `Unity ${type}`, body, head.at + 1, end) });
  }
  return result;
}

async function analyze(ctx: PluginContext): Promise<PluginResult> {
  const nodes: NodeV1[] = [], edges: EdgeV1[] = [];
  const diagnostics: string[] = [];
  const issues = new Map<string, { count: number; samples: string[] }>();
  const issue = (kind: string, detail: string) => {
    const r = issues.get(kind) ?? { count: 0, samples: [] };
    r.count++; if (r.samples.length < 3) r.samples.push(detail); issues.set(kind, r);
  };
  const coreByPath = new Map<string, NodeV1[]>();
  for (const n of ctx.nodes) {
    const list = coreByPath.get(n.path) ?? []; list.push(n); coreByPath.set(n.path, list);
  }
  const allById = new Map(ctx.nodes.map(n => [n.id, n]));
  const addNode = (n: NodeV1) => { if (!allById.has(n.id)) { nodes.push(n); allById.set(n.id, n); } return n.id; };
  const edge = (source: string, target: string, label: string, relation: EdgeV1['relation'] = 'references', confidence: EdgeV1['confidence'] = 'extracted') => {
    edges.push({ source, target, label, relation, confidence });
  };
  const fileNodes = new Map<string, string>();
  for (const n of ctx.nodes) if (n.kind === 'file') fileNodes.set(n.path, n.id);
  const documents = new Map<string, Document>();
  const byPath = new Map<string, Document[]>();
  const guidPaths = new Map<string, string[]>();
  const assetTargets = new Map<string, string>();
  const folders = new Set<string>();

  for (const [path, text] of ctx.files) {
    if (path.endsWith('.cs')) continue;
    if (path.endsWith('.meta')) {
      const guid = guidOf(/^guid:\s*([a-f\d]{32})\s*$/im.exec(text)?.[1]);
      if (!guid) { issue('metadata without a valid GUID', path); continue; }
      const asset = path.slice(0, -5);
      if (/^folderAsset:\s*yes\s*$/m.test(text)) folders.add(asset);
      const paths = guidPaths.get(guid) ?? []; paths.push(asset); guidPaths.set(guid, paths);
      // Binary/imported assets are represented by their textual metadata, not read as code.
      const id = addNode(node(path, assetId(path), basename(asset), folders.has(asset) ? 'Unity folder metadata' : 'Unity asset metadata', text));
      assetTargets.set(asset, id);
      continue;
    }
    if (!text.startsWith('%YAML') && !/^--- !u!/m.test(text)) {
      issue('non-text Unity assets skipped (use Force Text serialization)', path); continue;
    }
    let docs: Document[];
    try { docs = parseDocuments(path, text); }
    catch (err) { throw new Error(`Unity ${path}: ${err instanceof Error ? err.message : String(err)}`); }
    if (!docs.length) { issue('Unity YAML without serialized objects', path); continue; }
    const id = addNode(node(path, path, basename(path), 'Unity serialized asset', text, 1, undefined, 'file'));
    fileNodes.set(path, id); assetTargets.set(path, id);
    byPath.set(path, docs);
    for (const doc of docs) {
      addNode(doc.node); documents.set(doc.node.id, doc);
      edge(id, doc.node.id, 'serialized object', 'contains');
      // A file-level dependent makes asset-to-script tracing useful in either direction.
    }
  }
  // Metadata enumeration may occur after its asset; real file nodes always win.
  for (const [path, id] of fileNodes) assetTargets.set(path, id);
  for (const [guid, paths] of guidPaths) if (paths.length > 1) issue('duplicate GUIDs (not resolved)', `${guid}: ${paths.join(', ')}`);

  const resolveRef = (ref: unknown, path: string, report = true): string | undefined => {
    if (!object(ref)) return;
    const id = scalar(ref.fileID);
    if (!id || id === '0') return;
    const guid = guidOf(ref.guid);
    if (nullGuid(guid)) {
      const local = docId(path, id);
      if (documents.has(local)) return local;
      if (report) issue('unresolved local fileIDs', `${path}#${id}`);
      return;
    }
    const matches = guidPaths.get(guid);
    if (!matches || matches.length !== 1) {
      // Unity's builtin-resource GUIDs aren't repository assets.
      if (report && !/^0{16}[def]0{15}$/.test(guid)) issue('unresolved external GUIDs', `${path}: ${guid}`);
      return;
    }
    const targetPath = matches[0];
    const exact = docId(targetPath, id);
    if (documents.has(exact)) return exact;
    // Imported subassets and scripts lack text object IDs; retain an asset-level dependency.
    if (byPath.has(targetPath)) {
      // Prefab source refs use virtual main-asset fileID 100100000.
      if (id !== '100100000') {
        if (report) issue('unresolved serialized subobjects', `${targetPath}#${id}`);
        return;
      }
    }
    return assetTargets.get(targetPath);
  };

  const classes = ctx.nodes.filter(n => n.kind === 'class' && n.path.endsWith('.cs'));
  const classByName = new Map<string, NodeV1[]>();
  for (const c of classes) { const list = classByName.get(c.name) ?? []; list.push(c); classByName.set(c.name, list); }
  const uniqueClass = (name: string): NodeV1 | undefined => {
    const list = classByName.get(name.split('.').pop() ?? name) ?? [];
    return list.length === 1 ? list[0] : undefined;
  };
  const bases = new Map<string, string>();
  const classMembers = new Map<string, NodeV1[]>();
  const fieldCandidates = new Map<string, NodeV1[]>();
  const callbacksByMethod = new Set<string>();
  const literalLoads: { path: string; line: number; api: string; key: string }[] = [];
  const language = await loadWasmLanguage('c_sharp') as Language | null;
  if (!language) throw new Error('Unity plugin requires the bundled C# grammar');
  const parser = new Parser(); parser.setLanguage(language);
  const matchCore = (path: string, ast: SyntaxNode, kind: string, name: string) =>
    (coreByPath.get(path) ?? []).find(n => n.kind === kind && n.name === name && n.span === `L${ast.startPosition.row + 1}-L${ast.endPosition.row + 1}`);
  try {
    for (const [path, source] of ctx.files) {
      if (!path.endsWith('.cs')) continue;
      const tree = parser.parse(source);
      if (!tree) throw new Error(`cannot parse ${path}`);
      try {
        if (tree.rootNode.hasError) issue('C# files with parser errors (partial coverage)', path);
        const walk = (ast: SyntaxNode, owner?: NodeV1) => {
          if (ast.type === 'class_declaration') {
            const name = ast.childForFieldName('name')?.text ?? '';
            owner = matchCore(path, ast, 'class', name);
            const base = ast.namedChildren.find(n => n.type === 'base_list')?.text.replace(/^:\s*/, '').split(',')[0]?.trim();
            if (owner && base) bases.set(owner.id, base);
          }
          if (owner && ast.type === 'method_declaration') {
            const name = ast.childForFieldName('name')?.text ?? '';
            const method = matchCore(path, ast, 'method', name);
            if (method) {
              const list = classMembers.get(owner.id) ?? []; list.push(method); classMembers.set(owner.id, list);
              const params = ast.childForFieldName('parameters');
              if (params?.namedChildCount === 0 && !ast.namedChildren.some(n => n.type === 'modifier' && n.text === 'static')) callbacksByMethod.add(method.id);
            }
          }
          if (owner && ast.type === 'field_declaration') {
            const modifiers = ast.namedChildren.filter(n => n.type === 'modifier').map(n => n.text);
            const attributes = ast.namedChildren.filter(n => n.type === 'attribute_list').map(n => n.text).join(' ');
            const serializable = (modifiers.includes('public') || /\bSerialize(?:Field|Reference)\b/.test(attributes)) &&
              !modifiers.some(m => ['static', 'const', 'readonly'].includes(m)) && !/\bNonSerialized\b/.test(attributes);
            if (serializable) {
              const declaration = ast.namedChildren.find(n => n.type === 'variable_declaration');
              for (const variable of declaration?.namedChildren.filter(n => n.type === 'variable_declarator') ?? []) {
                const name = variable.childForFieldName('name')?.text ?? variable.namedChildren.find(n => n.type === 'identifier')?.text;
                if (!name) continue;
                const id = `${path}#plugin:unity:field:${encodeURIComponent(owner.id)}:${name}`;
                const field = node(path, id, name, 'Unity serialized field', ast.text, ast.startPosition.row + 1, ast.endPosition.row + 1);
                field.owner = owner.name; field.signature = ast.text.replace(/\s+/g, ' ');
                const list = fieldCandidates.get(owner.id) ?? []; list.push(field); fieldCandidates.set(owner.id, list);
              }
            }
          }
          if (ast.type === 'invocation_expression') {
            const fn = ast.childForFieldName('function')?.text.replace(/\s+/g, '') ?? '';
            const api = /^(?:UnityEngine\.)?(Resources\.Load(?:Async|All)?)(?:<.*>)?$/.exec(fn)?.[1] ??
              /^(?:UnityEngine\.AddressableAssets\.)?(Addressables\.(?:LoadAssetAsync|InstantiateAsync|LoadSceneAsync))(?:<.*>)?$/.exec(fn)?.[1];
            const arg = ast.childForFieldName('arguments')?.namedChildren[0]?.namedChildren.at(-1);
            if (api && arg && ['string_literal', 'verbatim_string_literal'].includes(arg.type)) {
              try {
                const key = arg.text.startsWith('@"') ? arg.text.slice(2, -1).replace(/""/g, '"') : JSON.parse(arg.text);
                if (typeof key === 'string') literalLoads.push({ path, line: ast.startPosition.row + 1, api, key });
              } catch { issue('unsupported asset key literals', `${path}:${ast.startPosition.row + 1}`); }
            } else if (api) {
              issue('dynamic asset loads', `${path}:${ast.startPosition.row + 1}: ${api}`);
            }
          }
          for (const child of ast.namedChildren) walk(child, owner);
        };
        walk(tree.rootNode);
      } finally { tree.delete(); }
    }
  } finally { parser.delete(); }
  const baseName = (c: NodeV1) => bases.get(c.id);
  const chain = (c: NodeV1): NodeV1[] => {
    const out: NodeV1[] = [], seen = new Set<string>();
    for (let at: NodeV1 | undefined = c; at && !seen.has(at.id); ) {
      out.push(at); seen.add(at.id); const base = baseName(at); at = base ? uniqueClass(base) : undefined;
    }
    return out;
  };
  for (const c of classes) {
    const unityType = chain(c).some(n => /^(?:UnityEngine\.)?(?:MonoBehaviour|ScriptableObject)$/.test(baseName(n) ?? ''));
    if (!unityType) continue;
    for (const field of fieldCandidates.get(c.id) ?? []) {
      addNode(field); edge(c.id, field.id, 'serialized field', 'contains');
      const list = classMembers.get(c.id) ?? []; list.push(field); classMembers.set(c.id, list);
    }
  }
  const scriptClass = (ref: unknown): NodeV1 | undefined => {
    if (!object(ref) || !scalar(ref.fileID) || scalar(ref.fileID) === '0') return;
    const paths = guidPaths.get(guidOf(ref.guid));
    if (paths?.length !== 1 || !paths[0].endsWith('.cs')) return;
    const path = paths[0], name = basename(path, '.cs');
    const matches = (coreByPath.get(path) ?? []).filter(n => n.kind === 'class' && n.name === name);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const componentClass = (doc: Document, seen = new Set<string>()): NodeV1 | undefined => {
    if (seen.has(doc.node.id)) return; seen.add(doc.node.id);
    const direct = scriptClass(doc.data.m_Script);
    if (direct) return direct;
    const source = resolveRef(doc.data.m_CorrespondingSourceObject, doc.path, false);
    const parent = source ? documents.get(source) : undefined;
    return parent ? componentClass(parent, seen) : undefined;
  };
  const members = (c: NodeV1, name: string, kind?: string): NodeV1[] => {
    for (const owner of chain(c)) {
      const found = (classMembers.get(owner.id) ?? []).filter(n => n.name === name && (!kind || n.kind === kind));
      if (found.length) return found;
    }
    return [];
  };

  for (const doc of documents.values()) {
    const cls = componentClass(doc);
    if (cls) {
      doc.node.name = `${doc.type} ${cls.name} (${doc.id})`;
      doc.node.signature = `Unity ${doc.type} ${cls.name}`;
      edge(doc.node.id, cls.id, 'm_Script');
      edge(fileNodes.get(doc.path)!, cls.id, 'uses script');
      // Scalar assignments also depend on their declaration; m_ is a common user
      // field prefix, so match actual fields rather than excluding that prefix.
      for (const property of Object.keys(doc.data)) {
        const fields = members(cls, property).filter(n => n.kind === 'variable');
        if (fields.length === 1) edge(doc.node.id, fields[0].id, `serialized field ${property}`);
      }
    }
    visit(doc.data, (value, property) => {
      if ('fileID' in value) {
        const target = resolveRef(value, doc.path);
        if (target) {
          edge(doc.node.id, target, property || 'reference');
          if (allById.get(target)?.path !== doc.path) edge(fileNodes.get(doc.path)!, target, property || 'asset reference');
          if (cls && property) {
            const fieldName = property.split(/[.\[]/)[0];
            const fields = members(cls, fieldName).filter(n => n.kind === 'variable');
            if (fields.length === 1) {
              edge(doc.node.id, fields[0].id, `serialized field ${property}`);
              edge(fields[0].id, target, `Inspector assignment in ${doc.path}`, 'references', 'inferred');
            }
          }
        }
      }
      // Only persistent UnityEvent call records, not similarly named user data.
      if (property.includes('m_PersistentCalls.m_Calls[') && 'm_MethodName' in value && 'm_Target' in value && ['1', '2'].includes(scalar(value.m_CallState))) {
        const target = resolveRef(value.m_Target, doc.path, false);
        const targetDoc = target ? documents.get(target) : undefined;
        const targetClass = targetDoc ? componentClass(targetDoc) : undefined;
        const method = scalar(value.m_MethodName);
        const candidates = targetClass ? members(targetClass, method, 'method') : [];
        if (candidates.length === 1) edge(doc.node.id, candidates[0].id, `UnityEvent ${property}: ${method}`, 'calls', 'inferred');
        else if (method) issue('unresolved or ambiguous UnityEvent callbacks', `${doc.path}: ${method}`);
      }
      // Prefab variants/nested instances: relate override properties to source fields.
      if ('propertyPath' in value && 'target' in value) {
        const target = resolveRef(value.target, doc.path, false);
        const sourceDoc = target ? documents.get(target) : undefined;
        const owner = sourceDoc ? componentClass(sourceDoc) : undefined;
        const field = scalar(value.propertyPath).split(/[.\[]/)[0];
        const fields = owner ? members(owner, field).filter(n => n.kind === 'variable') : [];
        if (fields.length === 1) {
          edge(doc.node.id, fields[0].id, `prefab override ${scalar(value.propertyPath)}`);
          const assigned = resolveRef(value.objectReference, doc.path, false);
          if (assigned) edge(fields[0].id, assigned, `prefab override in ${doc.path}`, 'references', 'inferred');
        }
      }
    });
  }

  // Name-based engine entry points are explicitly inferred, not compiler-resolved calls.
  const callbacks = new Set(['Awake', 'Start', 'Update', 'FixedUpdate', 'LateUpdate', 'OnEnable', 'OnDisable', 'OnDestroy', 'Reset', 'OnValidate', 'OnApplicationQuit']);
  for (const c of classes) {
    const bases = chain(c).map(baseName).filter(n => /^(?:UnityEngine\.)?(?:MonoBehaviour|ScriptableObject)$/.test(n ?? '')).map(n => n!.split('.').pop());
    const behaviour = bases.includes('MonoBehaviour');
    const scriptable = bases.includes('ScriptableObject');
    if (!behaviour && !scriptable) continue;
    for (const name of callbacks) {
      if (!behaviour && !['Awake', 'OnEnable', 'OnDisable', 'OnDestroy', 'OnValidate'].includes(name)) continue;
      for (const method of members(c, name, 'method')) {
        if (!callbacksByMethod.has(method.id)) continue;
        const id = `${method.path}#plugin:unity:lifecycle:${encodeURIComponent(c.id)}:${name}`;
        const entry = node(method.path, id, `Unity ${c.name}.${name}`, 'Unity lifecycle entry point', method.signature ?? name);
        entry.span = method.span;
        addNode(entry); edge(id, method.id, 'engine callback (convention)', 'calls', 'inferred');
      }
    }
  }

  // Explicit asset roots are separate from lifecycle callbacks: a callback alone
  // does not prove that its scene or prefab is used.
  const rootAsset = (path: string, reason: string, evidence = path) => {
    const target = assetTargets.get(path);
    if (!target) { issue('unresolved entry points', `${evidence}: ${path}`); return; }
    const input = allById.get(target)!.path;
    const id = `${input}#plugin:unity:root:${encodeURIComponent(reason + ':' + evidence)}`;
    addNode(node(input, id, reason, 'Unity asset entry point', evidence));
    edge(id, target, `${reason}: ${evidence}`, 'references', 'inferred');
  };
  const rootTree = (path: string, reason: string, evidence = path) => {
    rootAsset(path, reason, evidence);
    if (folders.has(path)) for (const child of assetTargets.keys()) {
      if (child.startsWith(path + '/') && !folders.has(child)) rootAsset(child, reason, evidence);
    }
  };
  for (const [path] of assetTargets) {
    if (folders.has(path)) continue;
    if (/(?:^|\/)ProjectSettings\//.test(path)) rootAsset(path, 'Project settings');
    if (/(?:^|\/)Resources\//.test(path)) rootAsset(path, 'Resources');
    if (/(?:^|\/)StreamingAssets\//.test(path)) rootAsset(path, 'StreamingAssets');
    if (/(?:^|\/)Editor(?: Default Resources)?\//.test(path) || /(?:^|\/)Gizmos\//.test(path)) rootAsset(path, 'Editor assets');
    // This report finds asset candidates, not unused C# types. Keep code and its
    // discovered asset dependencies conservatively alive, including reflection.
    if (path.endsWith('.cs')) rootAsset(path, 'C# code (conservative)');
    if (/\.(?:dll|asmdef|asmref|rsp|so|dylib|bundle)$/.test(path) || /(?:^|\/)Plugins\//.test(path)) rootAsset(path, 'Plugin or assembly input (conservative)');
  }
  let sawBuildSettings = false;
  for (const doc of documents.values()) {
    if (doc.type === 'EditorBuildSettings') {
      sawBuildSettings = true;
      for (const scene of Array.isArray(doc.data.m_Scenes) ? doc.data.m_Scenes : []) {
        if (!object(scene) || !['1', 'true'].includes(scalar(scene.enabled))) continue;
        const path = scalar(scene.path), matches = guidPaths.get(guidOf(scene.guid));
        const byGuid = matches?.length === 1 ? matches[0] : undefined;
        if (byGuid && path && byGuid !== path) issue('build scene path/GUID disagreement', path);
        for (const p of new Set([byGuid, path].filter((p): p is string => !!p))) rootAsset(p, 'Enabled build scene', doc.path);
        if (!byGuid && !path) issue('unresolved entry points', `${doc.path}: enabled scene without path or resolvable GUID`);
      }
    }
    visit(doc.data, value => {
      const guid = guidOf(value.m_AssetGUID);
      if (!guid || nullGuid(guid)) return;
      const paths = guidPaths.get(guid);
      const target = paths?.length === 1 ? assetTargets.get(paths[0]) : undefined;
      if (target) edge(doc.node.id, target, 'Addressables AssetReference');
      else issue('unresolved AssetReference GUIDs', `${doc.path}: ${guid}`);
    });
  }
  if (!sawBuildSettings) issue('missing EditorBuildSettings coverage', 'enabled build scenes are unknown');
  // Importer references may carry dependencies even for binary assets.
  for (const [path, text] of ctx.files) {
    if (!path.endsWith('.meta')) continue;
    const asset = path.slice(0, -5), from = assetTargets.get(asset);
    if (!from) continue;
    try {
      const metadata: unknown = parse(text, { schema: 'failsafe', maxAliasCount: 0, logLevel: 'error' });
      visit(metadata, value => {
        const target = resolveRef(value, asset);
        if (target) edge(from, target, 'importer dependency');
        if (scalar(value.assetBundleName)) rootTree(asset, 'AssetBundle', path);
      });
    } catch { issue('unparsed importer metadata', path); }
  }
  const custom = ctx.options.roots;
  if (custom !== undefined && (!Array.isArray(custom) || custom.some(p => typeof p !== 'string'))) {
    throw new Error('Unity options.roots must be an array of repository-relative asset paths or directory prefixes');
  }
  for (const raw of (custom ?? []) as string[]) {
    const path = raw.replace(/\\/g, '/').replace(/\/$/, '');
    if (!path || path.startsWith('/') || path.split('/').includes('..')) throw new Error(`Invalid Unity root: ${raw}`);
    const matches = [...assetTargets.keys()].filter(p => p === path || p.startsWith(path + '/'));
    if (!matches.length) issue('unresolved custom roots', raw);
    for (const match of matches) if (!folders.has(match)) rootAsset(match, 'Configured root', raw);
  }

  // Resource keys can be resolved from asset paths without an editor. Addressable
  // keys are taken only from serialized group entries, never guessed from filenames.
  const resources = new Map<string, Set<string>>(), addresses = new Map<string, Set<string>>();
  const addKey = (map: Map<string, Set<string>>, key: string, target: string) => { const set = map.get(key) ?? new Set<string>(); set.add(target); map.set(key, set); };
  for (const [path, target] of assetTargets) {
    const m = /(?:^|\/)Resources\/(.+)$/.exec(path);
    if (m) addKey(resources, m[1].slice(0, m[1].length - extname(m[1]).length).toLowerCase(), target);
  }
  for (const doc of documents.values()) visit(doc.data, value => {
    if (!Array.isArray(value.m_SerializeEntries)) return;
    for (const entry of value.m_SerializeEntries) {
      if (!object(entry)) continue;
      const paths = guidPaths.get(guidOf(entry.m_GUID));
      const address = scalar(entry.m_Address);
      const target = paths?.length === 1 ? assetTargets.get(paths[0]) : undefined;
      if (!target) issue('unresolved Addressables entries', `${doc.path}: ${scalar(entry.m_GUID)}`);
      if (target && paths?.length === 1) rootTree(paths[0], 'Addressables entry', doc.path);
      if (address && target) { addKey(addresses, address, target); edge(doc.node.id, target, `Addressables address ${address}`); }
    }
  });
  for (const { path, line, api, key } of literalLoads) {
    const candidates = (coreByPath.get(path) ?? []).filter(n => {
      const m = /^L(\d+)-L(\d+)$/.exec(n.span); return m && Number(m[1]) <= line && Number(m[2]) >= line;
    }).sort((a, b) => spanSize(a) - spanSize(b));
    const from = candidates[0]?.id;
    if (!from) continue;
    const map = api.startsWith('Resources') ? resources : addresses;
    const lookup = api.startsWith('Resources') ? key.toLowerCase() : key;
    const targets = api === 'Resources.LoadAll'
      ? new Set([...resources].filter(([k]) => !lookup || k === lookup || k.startsWith(lookup + '/')).flatMap(([, ids]) => [...ids]))
      : map.get(lookup);
    if (targets?.size && (api === 'Resources.LoadAll' || targets.size === 1)) {
      for (const target of targets) edge(from, target, `${api}("${key}")`, 'references', 'inferred');
    } else issue('unresolved or ambiguous literal asset keys', `${path}:${line}: ${key}`);
  }
  for (const [kind, r] of issues) diagnostics.push(`${r.count} ${kind}: ${r.samples.join('; ')}`);
  return { nodes, edges, diagnostics };
}
function spanSize(n: NodeV1): number { const m = /^L(\d+)-L(\d+)$/.exec(n.span); return m ? Number(m[2]) - Number(m[1]) : Infinity; }

const unity: GraphPlugin = { apiVersion: 1, id: 'unity', version: '1.1.0', analyze };
export default unity;
