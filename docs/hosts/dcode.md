# dcode store layout

The dcode adapter reads the native `DEEPAGENTS_HOME` store recorded by
deepagents-code 0.1.71 (`store.py` at upstream commit `59408ebe`). Its root is
`OPEN_PLUGIN_DCODE_ROOT`, then `OPEN_PLUGIN_HOME/.deepagents`, then
`$HOME/.deepagents`; this keeps tests isolated.

```
<root>/.state/installed_plugins.json  # {version:1|2, plugins:{name@market:[{installPath,…}]}}
<root>/.state/plugin_state.json       # {version:0|1, enabledPlugins:{name@market:true}}
<root>/plugins/cache/<market>/<name>/<version>/
```

`src/hosts/dcode.ts` is reader-only. `src/hosts/dcode-writer.ts` stages a
byte-preserving copy, adds a source/id/fingerprint marker, swaps the managed
cache copy, and commits the registry and enablement metadata together. A
same-version content change therefore refreshes the cache. Metadata failures
roll the swap back; cleanup after metadata commit does not undo the active
copy. Removal only handles marker-owned records.

An explicit `add --adopt-existing` can take over one legacy native record
when its ID, cache location, manifest name, and manifest version agree. The
legacy cache remains in place during the transition; the registry points to
the newly staged, marker-owned copy only after the metadata commit succeeds.
If staging or metadata commit fails, the old record and cache remain active.
Callers must verify the legacy copy's bytes against their expected source
before requesting adoption. Ordinary adds do not take over unmarked records.

dcode has native-loader evidence for ordinary plugin skills in
`docs/evidence/dcode-native-loader-20260922.json` and current lifecycle evidence
for deepagents-code 0.1.83 in
`docs/evidence/dcode-native-update-0.1.83-20261009.json`. Source semantics are
inventoried generically before this writer can activate anything. The 0.1.83
Managed evidence profile admits ordinary skills, MCP, hooks and resources, but
returns separate typed gaps for commands, agents, model-invocation control,
user-invocation control, and permission/preprocessing semantics. Frontmatter
aliases and a Codex `agents/openai.yaml` sidecar remain distinct declarations;
malformed or contradictory policy is invalid input rather than a capability
gap. Unknown detected versions have no optimistic fallback profile.
The legacy writer bridge still supplies the catalog's pinned observed version;
actual runtime version discovery belongs to the lifecycle host SPI and must use
the same profile lookup before activation.

Hooks and MCP declarations remain in the staged package unchanged; the writer
does not translate or drop them, and the native inventory accepts root
`mcpServers` / `hooks`, `.mcp.json`, and `hooks/hooks.json`. Its manifest reader
accepts only `plugin.json`, `.claude-plugin/plugin.json`, and
`.codex-plugin/plugin.json`; a `.plugin/plugin.json`-only package is rejected
instead of silently losing its manifest semantics.
