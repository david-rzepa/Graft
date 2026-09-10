import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildGraph } from '../src/graph/build.js';
import { checkGraph } from '../src/graph/check.js';
import { readGraph, wiringPath } from '../src/graph/write.js';
import { probeDrift, isClean } from '../src/graph/fingerprint.js';
import { ensureFreshGraph } from '../src/graph/refresh.js';
import { checkGraphInvariants } from '../src/graph/invariants.js';
import { callTool } from '../src/mcp/tools.js';

const SCRIPT = '11111111111111111111111111111111';
const PREFAB = '22222222222222222222222222222222';
const ICON = '33333333333333333333333333333333';
const id = '9223372036854775806';
const controller = `using UnityEngine;
public class Controller : MonoBehaviour
{
    [SerializeField] private UnityEngine.Object icon;
    private UnityEngine.Object notSerialized;
    [System.NonSerialized] public UnityEngine.Object ignored;
    void Awake() { }
    public void OnClick() { }
    public void Load()
    {
        Resources.Load<UnityEngine.Object>("Icons/icon");
        UnityEngine.AddressableAssets.Addressables.LoadAssetAsync<UnityEngine.Object>("card-icon");
        // Resources.Load<UnityEngine.Object>("not-real");
    }
}
public class Ordinary
{
    void Update() { }
}
`;
const prefab = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &1
GameObject:
  m_Name: Card Button
  m_Component:
  - component: {fileID: ${id}}
--- !u!114 &${id}
MonoBehaviour:
  m_GameObject: {fileID: 1}
  m_Script: {fileID: 11500000, guid: ${SCRIPT}, type: 3}
  icon: {fileID: 2800000, guid: ${ICON}, type: 3}
  clicked:
    m_PersistentCalls:
      m_Calls:
      - m_Target: {fileID: ${id}}
        m_MethodName: OnClick
        m_CallState: 2
`;
function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'graft-unity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (p: string, s: string) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), s); };
  put('.graft/plugins.json', JSON.stringify({ version: 1, plugins: [{ module: 'unity' }] }));
  put('Assets/Controller.cs', controller);
  put('Assets/Controller.cs.meta', `fileFormatVersion: 2\nguid: ${SCRIPT}\n`);
  put('Assets/Resources/Icons/icon.png.meta', `fileFormatVersion: 2\nguid: ${ICON}\n`);
  put('Assets/Button.prefab', prefab);
  put('Assets/Button.prefab.meta', `fileFormatVersion: 2\nguid: ${PREFAB}\n`);
  put('Assets/Level.unity', `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1001 &8
PrefabInstance:
  m_SourcePrefab: {fileID: 100100000, guid: ${PREFAB}, type: 3}
  m_Modification:
    m_Modifications:
    - target: {fileID: ${id}, guid: ${PREFAB}, type: 3}
      propertyPath: icon
      objectReference: {fileID: 2800000, guid: ${ICON}, type: 3}
--- !u!114 &9 stripped
MonoBehaviour:
  m_CorrespondingSourceObject: {fileID: ${id}, guid: ${PREFAB}, type: 3}
  m_PrefabInstance: {fileID: 8}
`);
  put('Assets/AddressableAssetsData/AssetGroups/Default.asset', `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!114 &1
MonoBehaviour:
  m_Name: Default
  m_SerializeEntries:
  - m_GUID: ${ICON}
    m_Address: card-icon
`);
  return { root, put, graph: () => readGraph(wiringPath(join(root, 'graft')))! };
}

test('Unity plugin joins C# fields/lifecycle, prefabs, scene instances, events and asset keys through MCP', async t => {
  const { root, graph } = fixture(t);
  const result = await buildGraph(root);
  assert.deepEqual(result.errors, []);
  const g = graph();
  assert.deepEqual(checkGraphInvariants(g).problems, []);
  assert.equal(g.meta.plugins?.unity, '1.2.0');
  const component = g.nodes.find(n => n.id === `Assets/Button.prefab#plugin:unity:object:${id}`)!;
  assert.ok(component, '64-bit fileID is exact');
  assert.ok(g.edges.some(e => e.source === component.id && e.target === 'Assets/Controller.cs#Controller'));
  const field = g.nodes.find(n => n.origin === 'plugin' && n.name === 'icon')!;
  assert.ok(field, 'private SerializeField field indexed');
  assert.ok(!g.nodes.some(n => n.origin === 'plugin' && ['notSerialized', 'ignored'].includes(n.name)));
  assert.ok(g.edges.some(e => e.source === field.id && e.target.endsWith('icon.png.meta#plugin:unity:asset')));
  assert.ok(g.edges.some(e => e.label?.startsWith('prefab override icon')));
  assert.ok(g.edges.some(e => e.source === 'Assets/Level.unity#plugin:unity:object:9' && e.target === 'Assets/Controller.cs#Controller'));
  assert.ok(g.edges.some(e => e.relation === 'calls' && e.label?.startsWith('UnityEvent') && e.target === 'Assets/Controller.cs#OnClick'));
  assert.ok(g.nodes.some(n => n.name === 'Unity Controller.Awake'));
  assert.ok(!g.nodes.some(n => n.name === 'Unity Ordinary.Update'));
  assert.ok(g.edges.some(e => e.label === 'Resources.Load("Icons/icon")'));
  assert.ok(g.edges.some(e => e.label === 'Addressables.LoadAssetAsync("card-icon")'));
  assert(g.meta.diagnostics?.every(d => d.includes('missing EditorBuildSettings coverage')));
  assert.equal((await checkGraph(root)).ok, true);
  assert.ok(isClean(probeDrift(root, join(root, 'graft'))!));
  const traced = await callTool(root, 'graft_trace_calls', { symbol: 'OnClick' });
  assert.equal(traced.isError, false); assert.match(traced.text, /Button.prefab/); assert.match(traced.text, /UnityEvent/);
  const found = await callTool(root, 'graft_find_code', { query: 'Card Button prefab', limit: 3 });
  assert.equal(found.isError, false); assert.match(found.text, /Button.prefab/);
});

test('prefab-only edits, GUID remaps, deletes and disabling plugin refresh without losing core nodes', async t => {
  const { root, put, graph } = fixture(t);
  await buildGraph(root);
  const graphFile = wiringPath(join(root, 'graft'));
  const first = readFileSync(graphFile, 'utf8');
  await buildGraph(root);
  assert.equal(readFileSync(graphFile, 'utf8'), first, 'incremental equals cold');
  await buildGraph(root, { reuse: false });
  assert.equal(readFileSync(graphFile, 'utf8'), first, 'forced cold equals incremental');
  put('Assets/Button.prefab', prefab.replace('m_CallState: 2', 'm_CallState: 0'));
  assert.equal((await checkGraph(root)).ok, false);
  assert.ok((await ensureFreshGraph(root)).refreshed);
  assert.ok(!graph().edges.some(e => e.label?.startsWith('UnityEvent')));
  put('Assets/Resources/Icons/icon.png.meta', `guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n`);
  assert.equal((await checkGraph(root)).ok, false, 'edge drift from metadata alone');
  assert.ok((await ensureFreshGraph(root)).refreshed);
  assert.ok(!graph().edges.some(e => e.source.endsWith(':icon') && e.target.endsWith('icon.png.meta#plugin:unity:asset')));
  rmSync(join(root, 'Assets/Button.prefab'));
  assert.ok((await ensureFreshGraph(root)).refreshed);
  assert.ok(!graph().nodes.some(n => n.path === 'Assets/Button.prefab'));
  put('.graft/plugins.json', JSON.stringify({ version: 1, plugins: [] }));
  assert.ok((await ensureFreshGraph(root)).refreshed);
  assert.ok(!graph().nodes.some(n => n.origin === 'plugin'));
  assert.ok(graph().nodes.some(n => n.id === 'Assets/Controller.cs#Controller'));
  assert.equal((await checkGraph(root)).ok, true);
});

test('Unity inputs obey only-dir and malformed YAML fails without replacing the last good graph', async t => {
  const { root, put, graph } = fixture(t);
  await buildGraph(root, { onlyDirs: ['Assets/Resources'] });
  assert.ok(graph().nodes.every(n => n.path.startsWith('Assets/Resources/')));
  assert.equal((await checkGraph(root)).ok, true);
  assert.ok(isClean(probeDrift(root, join(root, 'graft'))!));
  await buildGraph(root);
  const saved = readFileSync(wiringPath(join(root, 'graft')), 'utf8');
  put('Assets/Button.prefab', '%YAML 1.1\n--- !u!114 &1\nMonoBehaviour:\n  broken: [\n');
  await assert.rejects(buildGraph(root), /Unity Assets\/Button.prefab/);
  assert.equal(readFileSync(wiringPath(join(root, 'graft')), 'utf8'), saved);
  const refresh = await ensureFreshGraph(root);
  assert.equal(refresh.refreshed, false); assert.ok(refresh.note);
});

test('inherited Unity classes, ambiguous callbacks, duplicate GUIDs and binary assets report conservative coverage', async t => {
  const { root, put, graph } = fixture(t);
  put('Assets/Base.cs', `using UnityEngine;
public class Base : MonoBehaviour
{
  protected void Update() { }
  [SerializeField] private Object inheritedIcon;
}
`);
  put('Assets/Controller.cs', controller.replace('Controller : MonoBehaviour', 'Controller : Base').replace('public void OnClick() { }', 'public void OnClick() { }\n    public void OnClick(int value) { }'));
  put('Assets/Button.prefab', prefab.replace('  icon:', '  inheritedIcon:'));
  put('Assets/Binary.asset', '\0binary Unity data');
  await buildGraph(root);
  assert.ok(graph().nodes.some(n => n.name === 'Unity Controller.Update'));
  assert.ok(graph().edges.some(e => e.label === 'serialized field inheritedIcon'));
  assert.ok(!graph().edges.some(e => e.label?.startsWith('UnityEvent')));
  assert.ok(graph().meta.diagnostics?.some(d => d.includes('ambiguous UnityEvent')));
  assert.ok(graph().meta.diagnostics?.some(d => d.includes('non-text Unity assets')));
  put('Assets/Duplicate.cs.meta', `guid: ${SCRIPT}\n`);
  await buildGraph(root);
  assert.ok(graph().meta.diagnostics?.some(d => d.includes('duplicate GUIDs')));
  assert.ok(!graph().edges.some(e => e.label === 'm_Script' && e.target === 'Assets/Controller.cs#Controller'));
  assert.equal((await checkGraph(root)).ok, true, 'coverage gaps are distinct from drift');
});

test('large Unity YAML is indexed beyond the core source limit and aliases cannot expand unboundedly', async t => {
  const { root, put, graph } = fixture(t);
  put('Assets/Large.unity', '%YAML 1.1\n--- !u!1 &1\nGameObject:\n  m_Name: Large\n  payload: ' + 'x'.repeat(1_100_000) + '\n');
  await buildGraph(root);
  assert.ok(graph().nodes.some(n => n.path === 'Assets/Large.unity'));
  assert.equal((await checkGraph(root)).ok, true);
  put('Assets/Large.unity', '%YAML 1.1\n--- !u!1 &1\nGameObject:\n  m_Name: &a [x,x]\n  value: *a\n');
  await assert.rejects(buildGraph(root), /alias/i);
});

test('scalar and m_-prefixed user fields bind to prefab assignments, and null script refs do not resolve', async t => {
  const { root, put, graph } = fixture(t);
  put('Assets/Controller.cs', controller.replace('private UnityEngine.Object icon;', 'private UnityEngine.Object m_icon;\n    public int health;'));
  put('Assets/Button.prefab', prefab.replace('  icon:', '  health: 10\n  m_icon:'));
  await buildGraph(root);
  assert.ok(graph().edges.some(e => e.label === 'serialized field health'));
  assert.ok(graph().edges.some(e => e.label === 'serialized field m_icon'));
  put('Assets/Button.prefab', prefab.replace('fileID: 11500000', 'fileID: 0'));
  await buildGraph(root);
  assert.ok(!graph().edges.some(e => e.source.startsWith('Assets/Button.prefab') && e.target === 'Assets/Controller.cs#Controller'));
});

test('plugin asset cards cannot overwrite same-stem script cards, and explicit summaries receive plugin source', async t => {
  const { root, put, graph } = fixture(t);
  put('Assets/Controller.prefab', prefab);
  const summarized = new Set<string>();
  const result = await buildGraph(root, {
    summarizer: { async describeFile(input) {
      summarized.add(input.path);
      return input.nodes.map(n => ({ id: n.id, summary: 'Fixture explanation.', crux_start: 0, crux_end: 0 }));
    } },
  });
  assert.equal(result.meaning.failedFiles, 0);
  assert.ok(summarized.has('Assets/Controller.prefab'));
  assert.ok(graph().nodes.filter(n => n.path === 'Assets/Controller.prefab').every(n => n.summary_state === 'ready'));
  assert.match(readFileSync(join(root, 'graft/Assets/Controller.md'), 'utf8'), /^# Assets\/Controller.cs/);
  assert.match(readFileSync(join(root, 'graft/Assets/Controller.prefab.md'), 'utf8'), /^# Assets\/Controller.prefab/);
  await buildGraph(root);
  assert.ok(graph().nodes.filter(n => n.path === 'Assets/Controller.prefab').every(n => n.summary_state === 'ready'), 'structural rebuild keeps summaries');
});


test('Resources keys are case-insensitive and LoadAll connects every asset in a folder', async t => {
  const { root, put, graph } = fixture(t);
  put('Assets/Resources/Icons/second.png.meta', 'guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
  put('Assets/Controller.cs', controller.replace('"Icons/icon"', '"ICONS/ICON"').replace('void Awake() { }', 'void Awake() { Resources.LoadAll<UnityEngine.Object>("icons"); }'));
  await buildGraph(root);
  assert.ok(graph().edges.some(e => e.label === 'Resources.Load("ICONS/ICON")'));
  assert.equal(graph().edges.filter(e => e.label === 'Resources.LoadAll("icons")').length, 2);
});

test('orphan reachability retains build/preload/resource/addressable/custom roots and finds unused cycles', async t => {
  const { root, put, graph } = fixture(t);
  const yaml = (type: string, body: string) => `%YAML 1.1\n--- !u!114 &1\n${type}:\n${body}\n`;
  const ga = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', gb = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  put('ProjectSettings/EditorBuildSettings.asset', yaml('EditorBuildSettings', '  m_Scenes:\n  - enabled: 1\n    path: Assets/Level.unity\n  - enabled: 0\n    path: Assets/Disabled.unity'));
  put('Assets/Disabled.unity', yaml('SceneRoots', '  m_Roots: []'));
  put('Assets/A.asset.meta', `guid: ${ga}\n`);
  put('Assets/B.asset.meta', `guid: ${gb}\n`);
  put('Assets/A.asset', yaml('MonoBehaviour', `  other: {fileID: 1, guid: ${gb}}`));
  put('Assets/B.asset', yaml('MonoBehaviour', `  other: {fileID: 1, guid: ${ga}}`));
  put('Assets/Preloaded.asset.meta', 'guid: cccccccccccccccccccccccccccccccc\n');
  put('Assets/Preloaded.asset', yaml('MonoBehaviour', '  m_Name: Preloaded'));
  put('ProjectSettings/ProjectSettings.asset', yaml('PlayerSettings', '  preloadedAssets:\n  - {fileID: 1, guid: cccccccccccccccccccccccccccccccc}'));
  put('Assets/RuntimeOnly.prefab', yaml('MonoBehaviour', '  m_Name: RuntimeOnly'));
  put('Assets/AddressableFolder.meta', 'guid: dddddddddddddddddddddddddddddddd\nfolderAsset: yes\n');
  put('Assets/AddressableFolder/texture.png.meta', 'guid: eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\n');
  put('Assets/Groups.asset', yaml('MonoBehaviour', '  m_SerializeEntries:\n  - m_GUID: dddddddddddddddddddddddddddddddd\n    m_Address: folder'));
  put('Assets/Controller.cs', controller.replace('// Resources.Load', 'Resources.Load<UnityEngine.Object>(dynamicKey); // Resources.Load'));
  put('.graft/plugins.json', JSON.stringify({ version: 1, plugins: [{ module: 'unity', options: { roots: ['Assets/RuntimeOnly.prefab'] } }] }));
  await buildGraph(root);
  const { findOrphans, orphanReport } = await import('../src/graph/orphans.js');
  const report = orphanReport(root);
  const paths = report.candidates.map(c => c.path);
  assert(paths.includes('Assets/A.asset'));
  assert(paths.includes('Assets/B.asset'));
  assert(paths.includes('Assets/Disabled.unity'));
  for (const path of ['Assets/Level.unity', 'Assets/Button.prefab', 'Assets/Preloaded.asset', 'Assets/RuntimeOnly.prefab', 'Assets/Resources/Icons/icon.png', 'Assets/AddressableFolder/texture.png', 'Assets/AddressableFolder']) assert(!paths.includes(path), path);
  assert.deepEqual(report.candidates.find(c => c.path === 'Assets/A.asset')?.referencedBy, ['Assets/B.asset']);
  assert(report.gaps.some(g => g.includes('dynamic asset loads')));
  assert(report.roots.some(r => r.reason === 'Enabled build scene'));
  assert.deepEqual(findOrphans(graph(), { in: 'Assets/A.asset' }).candidates.map(c => c.path), ['Assets/A.asset']);
  const mcp = await callTool(root, 'graft_find_orphans', { limit: 1 });
  assert.equal(mcp.isError, false, mcp.text);
  assert.equal(JSON.parse(mcp.text).candidates.length, 1);
  put('Assets/A.asset', yaml('MonoBehaviour', '  m_Name: changed'));
  assert.throws(() => orphanReport(root), /stale/);
});

test('orphan analysis follows importer and AssetReference edges, retains bundled folders and reports bad custom roots', async t => {
  const { root, put } = fixture(t);
  put('Assets/Imported.fbx.meta', 'guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nModelImporter:\n  externalObjects:\n  - second: {fileID: 2800000, guid: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb}\n');
  put('Assets/Texture.png.meta', 'guid: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n');
  put('Assets/Bundled.meta', 'guid: cccccccccccccccccccccccccccccccc\nfolderAsset: yes\nDefaultImporter:\n  assetBundleName: content\n');
  put('Assets/Bundled/Child.png.meta', 'guid: dddddddddddddddddddddddddddddddd\n');
  put('Assets/Plugins/native.dll.meta', 'guid: eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\n');
  put('Assets/Catalog.asset', '%YAML 1.1\n--- !u!114 &1\nMonoBehaviour:\n  entry:\n    m_AssetGUID: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
  put('.graft/plugins.json', JSON.stringify({ version: 1, plugins: [{ module: 'unity', options: { roots: ['Assets/Catalog.asset', 'Assets/Missing'] } }] }));
  await buildGraph(root);
  const { orphanReport } = await import('../src/graph/orphans.js');
  const r = orphanReport(root);
  const paths = new Set(r.candidates.map(c => c.path));
  for (const p of ['Assets/Imported.fbx', 'Assets/Texture.png', 'Assets/Bundled/Child.png', 'Assets/Plugins/native.dll']) assert(!paths.has(p), p);
  assert(r.gaps.some(g => g.includes('unresolved custom roots')));
  const { execFileSync } = await import('node:child_process');
  const cli = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'orphans', root, '--json', '--limit', '0'], { encoding: 'utf8' }));
  assert.equal(cli.candidates.length, 0);
  assert.equal(cli.totalCandidates, r.totalCandidates);
});


test('Unity multiline quoted text preserves following references and original spans', async t => {
  const { root, put, graph } = fixture(t);
  const text = `%YAML 1.1
--- !u!114 &1
MonoBehaviour:
  m_Name: 'A multiline

    display name

'
  m_text: "A multiline
    double-quoted value
"
  icon: {fileID: 2800000, guid: ${ICON}, type: 3}
--- !u!1 &2
GameObject:
  m_Name: Next object
`;
  put('Assets/Multiline.prefab', text);
  await buildGraph(root);
  const g = graph();
  assert(g.edges.some(e => e.source === 'Assets/Multiline.prefab' && e.label === 'icon'));
  const object = g.nodes.find(n => n.id === 'Assets/Multiline.prefab#plugin:unity:object:1')!;
  assert.equal(object.name, 'A multiline\ndisplay name\n');
  assert.equal(object.span, 'L2-L12');
  assert(g.nodes.some(n => n.name === 'Next object' && n.span === 'L13-L16'));
  const old = JSON.stringify(g);
  put('Assets/Multiline.prefab', text.replace('  m_Name: Next object', "  m_Name: 'Never closed"));
  await assert.rejects(() => buildGraph(root), /Missing closing/);
  assert.equal(JSON.stringify(graph()), old);
});


test('legacy controller transitions preserve references from every repeated data entry', async t => {
  const { root, put, graph } = fixture(t);
  put('Assets/Legacy.controller', `%YAML 1.1
--- !u!1107 &1
StateMachine:
  m_OrderedTransitions:
    data:
      first: {fileID: 0}
      second: [{fileID: 100100000, guid: ${PREFAB}}]
    data:
      first: {fileID: 0}
      second: [{fileID: 2800000, guid: ${ICON}}]
    data:
      first: {fileID: 0}
      second: []
`);
  await buildGraph(root);
  const refs = graph().edges.filter(e => e.source === 'Assets/Legacy.controller');
  assert(refs.some(e => e.label?.includes('data[0].second[0]') && e.target === 'Assets/Button.prefab'));
  assert(refs.some(e => e.label?.includes('data[1].second[0]') && e.target.includes('icon.png')));
});

test('Unity roots for native code use declared metadata inputs rather than core code paths', async t => {
  const { root, put, graph } = fixture(t);
  put('Assets/Plugins/native.h', 'int native_function(void);\n');
  put('Assets/Plugins/native.h.meta', 'guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
  put('Assets/Plugins/unmanaged.h', 'int another_function(void);\n');
  await buildGraph(root);
  const g = graph();
  assert(g.nodes.some(n => n.path === 'Assets/Plugins/native.h' && n.origin !== 'plugin'));
  assert(g.nodes.some(n => n.path === 'Assets/Plugins/native.h.meta' && n.role === 'Unity asset entry point'));
  assert(!g.nodes.some(n => n.path.endsWith('.h') && n.origin === 'plugin'));
  const { findOrphans } = await import('../src/graph/orphans.js');
  assert(!findOrphans(g).candidates.some(c => c.path === 'Assets/Plugins/native.h'));
  assert(g.meta.diagnostics?.some(d => d.includes('entry points without declared inputs')));
});

test('orphan analysis does not root unused scripts, even in special Unity folders', async t => {
  const {root, put, graph} = fixture(t);
  const scripts = ['Assets/Unused.cs', 'Assets/Plugins/VendorUnused.cs', 'Assets/Editor/UnusedEditor.cs', 'Assets/Resources/UnusedResource.cs'];
  for (const [i, path] of scripts.entries()) {
    put(path, `using UnityEngine; public class ${path.split('/').pop()!.slice(0, -3)} : MonoBehaviour { void Awake() {} }`);
    put(path + '.meta', `guid: ${String(i + 4).repeat(32)}\n`);
  }
  put('Assets/NoMetadata.cs', 'public class NoMetadata {}');
  put('Assets/Unreferenced.png.meta', 'guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
  put('Assets/Unused.cs.meta', 'guid: 44444444444444444444444444444444\nMonoImporter:\n  defaultReferences:\n  - picture: {fileID: 2800000, guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}\n');
  put('ProjectSettings/EditorBuildSettings.asset', '%YAML 1.1\n--- !u!1045 &1\nEditorBuildSettings:\n  m_Scenes:\n  - enabled: 1\n    path: Assets/Level.unity\n');
  await buildGraph(root);
  const {findOrphans} = await import('../src/graph/orphans.js');
  const report = findOrphans(graph());
  const candidates = new Set(report.candidates.map(c => c.path));
  for (const path of [...scripts, 'Assets/Unreferenced.png', 'Assets/NoMetadata.cs']) assert(candidates.has(path), path);
  assert(!candidates.has('Assets/Controller.cs'), 'scene -> prefab -> m_Script stays reachable');
  for (const path of scripts) assert(!report.roots.some(r => r.path === path), path);
  assert(!report.roots.some(r => r.reason === 'C# code (conservative)'));
  const old = graph();
  old.meta.plugins!.unity = '1.1.4';
  assert.throws(() => findOrphans(old), /Rebuild.*version 1.2/);
  const mcp = await callTool(root, 'graft_find_orphans', {in: 'Assets/Unused.cs'});
  assert.equal(mcp.isError, false, mcp.text);
  assert.equal(JSON.parse(mcp.text).candidates[0].path, 'Assets/Unused.cs');
});

test('explicit Unity entry attributes and configured roots retain scripts, not comments or ordinary lifecycle methods', async t => {
  const {root, put, graph} = fixture(t);
  const files: Record<string,string> = {
    'Bootstrap': '[UnityEngine.RuntimeInitializeOnLoadMethodAttribute(UnityEngine.RuntimeInitializeLoadType.BeforeSceneLoad)] static void Boot() { Helper.Run(); }',
    'EditorBoot': '[UnityEditor.InitializeOnLoadMethod] static void Init() {}',
    'Menu': '[UnityEditor.MenuItem("Tools/Do thing")] static void Execute() {}',
    'Fake': '// [RuntimeInitializeOnLoadMethod]\n void Awake() {}\n string example = "[InitializeOnLoadMethod]";',
    'WrongNamespace': '[SomethingElse.RuntimeInitializeOnLoadMethod] static void Init() {}',
    'InvalidSignature': '[UnityEngine.RuntimeInitializeOnLoadMethod] void Init() {}',
    'Helper': 'public static void Run() {}',
    'Explicit': 'void NeverCalled() {}',
  };
  for (const [i, [name, body]] of Object.entries(files).entries()) {
    put(`Assets/${name}.cs`, `public class ${name} { ${body} }`);
    put(`Assets/${name}.cs.meta`, `guid: ${(i+10).toString(16).repeat(32).slice(0,32)}\n`);
  }
  put('Assets/EditorClass.cs', '[UnityEditor.InitializeOnLoad] public class EditorClass { static EditorClass() {} }');
  put('Assets/EditorClass.cs.meta', 'guid: 99999999999999999999999999999999\n');
  put('.graft/plugins.json', JSON.stringify({version:1,plugins:[{module:'unity',options:{roots:['Assets/Explicit.cs']}}]}));
  await buildGraph(root);
  const {findOrphans} = await import('../src/graph/orphans.js');
  const report = findOrphans(graph()), candidates = new Set(report.candidates.map(c => c.path));
  for (const name of ['Bootstrap','Helper','EditorBoot','Menu','EditorClass','Explicit']) assert(!candidates.has(`Assets/${name}.cs`), name);
  for (const name of ['Fake','WrongNamespace','InvalidSignature']) assert(candidates.has(`Assets/${name}.cs`), name);
  assert(report.roots.some(r => r.path === 'Assets/Bootstrap.cs' && r.reason.includes('RuntimeInitializeOnLoadMethod')));
  assert(report.roots.some(r => r.path === 'Assets/Explicit.cs' && r.reason === 'Configured root'));
});
