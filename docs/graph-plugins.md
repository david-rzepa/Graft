# Graph plugins and Unity

Graph plugins add deterministic nodes and dependency edges to Graft's structural
code graph. They run during `graft build` and automatic query refresh, before
search indexes and markdown cards are written. No separate MCP server is needed:
`graft_find_code`, `graft_trace_calls`, `graft_file_api`, and the CLI see the
combined graph.

## Enable Unity

Create `.graft/plugins.json` in the project root:

```json
{
  "version": 1,
  "plugins": [{ "module": "unity" }]
}
```

Then run:

```sh
graft build
graft check
graft callers Controller --depth 3
graft ask "Card Button prefab"
```

Use a Graft build containing this feature. Older Graft versions do not understand
plugin configuration and can replace the combined graph with a code-only graph.
Keep the CLI and MCP server on the same build. Unity indexing is local and needs
neither the Unity editor nor an API key. An explicit `graft build --deep` also
includes plugin input text in the configured model's summary pass; automatic
refresh remains structural and never invokes that pass. Commit the configuration if teammates
should enable the same built-in plugin; keep `graft/` as a local cache.

The Unity plugin supports:

- `.meta` GUID mapping, preserving all 64-bit fileIDs and all-digit GUIDs.
- Text-serialized scenes, prefabs, ScriptableObjects, materials, animation clips,
  animator controllers and override controllers. Each YAML document becomes an
  object node; local and external object references become dependency edges.
- MonoBehaviour/ScriptableObject script references to C# classes. GameObject
  component lists connect objects to their components.
- Public fields and private `[SerializeField]` / `[SerializeReference]` fields on
  Unity classes, including inherited fields. Static, constant, readonly and
  `[NonSerialized]` fields are excluded. Inspector assignments connect those
  declarations to the assigned object or asset.
- Prefab source dependencies, stripped-object correspondence, nested instances
  and override object references. Override property paths link back to fields
  when the source component and declaration resolve unambiguously.
- Enabled persistent UnityEvent callbacks. Target components are resolved before
  method lookup; overloaded or unresolved methods are reported, not guessed.
- Convention-based engine entry points: `Awake`, `Start`, `Update`, `FixedUpdate`,
  `LateUpdate`, `OnEnable`, `OnDisable`, `OnDestroy`, `Reset`, `OnValidate`, and
  `OnApplicationQuit`, where applicable to MonoBehaviour/ScriptableObject. These
  include locally resolvable inherited callbacks and exclude static methods and
  methods with parameters.
- Literal `Resources.Load`, `LoadAsync`, `LoadAll` keys and literal Addressables
  `LoadAssetAsync`, `InstantiateAsync`, `LoadSceneAsync` keys. Addressable addresses
  come from serialized group entries. Resources keys are case-insensitive. Calls are parsed as C#, so comments and
  strings containing example code do not create dependencies.

`references` and `calls` carry these relationships through Graft's existing
traversal and ranking. Edge labels explain their evidence, e.g. `m_Script`,
`serialized field icon`, or `UnityEvent …`. Name-based C# callback and asset-load
resolution is marked `inferred`; serialized object links are `extracted`.

### Coverage boundaries

This is static asset understanding, not an emulation of Unity's runtime or a
compiler. It does not flatten every prefab variant into an effective instantiated
scene. It records source correspondence and overrides as dependencies. It cannot
resolve runtime-created objects, dynamic asset keys, custom loading wrappers,
Addressables label-based call targets, imported DLL types, or callbacks registered
only at runtime. Event overload resolution and ambiguous class names are
conservative. Auto-property backing-field serialization and FormerlySerializedAs
rename mapping are not currently resolved to C# declarations. Serialized
references themselves remain indexed.

Unity plugin 1.1.1 also accepts Unity's multiline quoted fields whose standalone
closing quote is unindented. Normalization happens in memory, preserves source
line numbers, and leaves malformed YAML validation enabled. Version 1.1.2 also
preserves legacy Unity maps with repeated `data` keys containing `first`/`second`
pairs as ordered collections. All entries contribute dependency edges; ordinary
duplicate keys remain errors.

Use Unity's Force Text serialization for scene/prefab internals. Binary/imported
assets are represented by their `.meta` records; imported subasset internals are
not decoded. Metadata is evidence of an asset identity, not a check that the binary
is present locally. Missing GUIDs, missing subobjects, ambiguous callbacks and
non-text assets are reported as coverage diagnostics in `graft build` and
`graft check`, and stored in graph metadata. A fresh graph can still have coverage
gaps. Malformed YAML fails the build and leaves the last valid graph in place.

Plugin files obey Git ignore rules, Graft's directory exclusions, and
`--only-dir` / submodule / nested-repository choices. The built-in Unity plugin's
input size ceiling is 16 MB per file (core code parsing retains its 1 MB ceiling).
Larger files are excluded by the walker. To raise the Unity ceiling up to 64 MB:

```json
{
  "version": 1,
  "plugins": [{ "module": "unity", "maxFileBytes": 64000000 }]
}
```

## Write a plugin

The public TypeScript interfaces are exported from `@nanonets/graft`:
`GraphPlugin`, `PluginContext`, `PluginResult`, `PluginSpec`, `NodeV1`, and `EdgeV1`.
Plugins export a default object with `apiVersion: 1`, a unique lowercase `id`, a
nonempty `version`, and an `analyze(context)` function (sync or async).

Example `tools/catalog-plugin.mjs`:

```js
import { createHash } from 'node:crypto';

export default {
  apiVersion: 1,
  id: 'catalog',
  version: '1.0.0',
  analyze({ files }) {
    return {
      nodes: [...files].map(([path, text]) => ({
        id: path,
        path,
        name: path,
        kind: 'file',
        origin: 'plugin',
        span: `L1-L${Math.max(1, text.split('\n').length)}`,
        signature: null,
        exported: true,
        body_hash: createHash('sha256').update(text).digest('hex'),
        summary_state: 'pending',
        summary: null,
        crux: null
      })),
      edges: []
    };
  }
};
```

Enable it alongside Unity:

```json
{
  "version": 1,
  "plugins": [
    { "module": "unity" },
    {
      "module": "./tools/catalog-plugin.mjs",
      "extensions": [".catalog"],
      "options": {},
      "watch": ["package-lock.json"]
    }
  ]
}
```

`module` can also name an installed Node package with a resolvable entry point.
Publish compiled JavaScript (for example `.mjs`), not raw TypeScript. External
plugins have the same permissions as Graft; enable only trusted modules. They
run in a fresh process on each build, with a 60-second timeout. Their console
output does not enter the MCP protocol, and imported helpers reload rather than
remaining stale in a long-lived MCP process. This is not a security sandbox.

### Contract

- `files` is a read-only map of declared input paths to decoded text. Paths are
  repo-relative and use `/`. External plugins must declare `extensions`; their
  default input size ceiling is 1 MB. They should inspect these supplied inputs
  instead of walking the repository independently.
- `nodes` contains core code definitions before LLM enrichment, not outputs from
  other plugins. `options` contains the plugin's JSON configuration. Implement
  local, deterministic analysis; refresh must not perform paid model calls.
- Return **additions**. Core node replacement and duplicate IDs are rejected.
  A new file node may use its path as its ID. Other IDs must use
  `<path>#plugin:<id>:<local-id>`. Every node must refer to a declared input,
  have a valid source span and nonempty `body_hash`, and use `origin: "plugin"`.
  `role` can give a human-readable semantic role; put searchable descriptions in
  `signature` or `body_text` as well.
- Use existing node kinds and edge relations. Asset dependencies normally use
  `references`; a callback uses `calls`; structural membership uses `contains`.
  `contains` does not participate in dependency walks. All plugin edge endpoints
  must exist in the combined graph. The host attaches the plugin ID to edges.
  Optional `label` describes the field, key or callback that establishes an edge.
- Return bounded `diagnostics` for coverage gaps. Throw for failures that would
  invalidate the analysis. Graft publishes no replacement graph on plugin failure;
  query refresh reports its failure and retains the previous graph.
- Configuration, entry-module bytes and declared `watch` file bytes are part of
  plugin identity. Add imported implementation files and dependency lockfiles to
  `watch` so changing them triggers refresh. Bump the plugin version when its
  semantics change. Only declaring `version` in an un-watched imported helper
  cannot detect that helper's edits.
- Input content and file membership are fingerprinted. Added, changed and deleted
  assets trigger refresh; `graft check` re-extracts plugin nodes and compares
  plugin dependency edges too. Removing a plugin prunes its contributions on the
  next build/refresh. `GRAFT_REFRESH=hash` also applies to plugin inputs.
- Configuration lives at the repository root and follows that repository into
  worktrees. Graph outputs and freshness metadata live in the selected cache
  directory. No plugin is enabled implicitly in an ordinary code repository.

## Verification

```sh
node --import tsx --test test/graph-plugins.test.ts test/unity-plugin.test.ts
npm run build
npm test
```

The tests exercise real C# extraction, Unity YAML references, inherited fields and
callbacks, prefab overrides, asset keys, malformed inputs, external module reload,
Git ignores, large assets, cold/incremental equivalence and the MCP query path.

Unity serialization references:
[Text serialization format](https://docs.unity3d.com/2022.3/Documentation/Manual/FormatDescription.html),
[UnityEvents](https://docs.unity3d.com/2022.3/Documentation/Manual/UnityEvents.html).

### Orphan candidates (Unity plugin 1.1+)

```sh
graft orphans                     # first 100 candidates, with coverage gaps
graft orphans --json              # structured entry points and reference evidence
graft orphans --in Assets/UI --limit 500
```

Codex can use `graft_find_orphans` with optional `in` and `limit` arguments.
Restart an existing MCP session after installing this version to discover the tool.
The command refreshes the graph and refuses stale or missing fingerprints. Run it
on a single Unity repository, not a workspace parent. `--in` filters the output;
it never narrows the graph used for reachability. JSON `totalCandidates` counts
all matching candidates before the display limit.

Roots include enabled `EditorBuildSettings` scenes (path and GUID), serialized
project settings (including preloaded assets), every Resources/StreamingAssets
asset, Addressables entries and folder descendants, AssetBundle importer labels,
editor assets, and plugin/assembly inputs. C# code is conservatively retained; this is not unused-script
analysis. Importer fileID/GUID references and serialized Addressables AssetReferences
add dependency edges. Reachability is computed across whole assets, so unreachable
cycles remain candidates even when they have incoming references from each other.

Declare extra asset paths or directory prefixes for custom build/runtime loading:

```json
{
  "version": 1,
  "plugins": [{ "module": "unity", "options": {
    "roots": ["Assets/RuntimeCatalog.asset", "Assets/CustomLoadedContent"]
  }}]
}
```

These roots are repository-specific configuration; the Unity behavior is shared
by the built-in plugin. Paths are relative, case-sensitive, and do not use globs.
Missing configured roots are reported. JSON includes each root's reason/evidence,
candidate incoming asset paths, and analysis gaps. No assets are deleted.

A candidate means no indexed route from these roots, **not safe to delete**.
Ignored files, partial builds, size limits, absent metadata, binary contents,
custom importers/build scripts, platform build profiles, remote content, reflection
and dynamic loading can hide dependencies. Known unresolved references and dynamic
Resources/Addressables calls are included in the report. Use a complete project
index and verify candidates in Unity before removing anything.

Version 1.1.3 also removes JavaScript argument-count limits when assembling large
plugin graphs, preserving all nodes and edges in large Unity projects. Version
1.1.4 anchors native-code entry-point annotations in declared `.meta` inputs;
missing metadata produces a coverage diagnostic instead of an invalid node.

### Large-project heap size

Large Unity graphs may exceed Node's default heap. For a 16 GB heap ceiling:

```sh
NODE_OPTIONS="--max-old-space-size=16384" graft build /path/to/project
```

This is a ceiling, not a preallocation. It does not fix parser errors or reduce
Graft's memory usage. An MCP server that automatically rebuilds the same project
needs the equivalent Node flag or `NODE_OPTIONS` environment setting at startup;
a larger heap on a separate CLI invocation does not change an existing server.
