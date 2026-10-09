---
id: native-plugin-update-capabilities-2026-10-09
type: research
summary: >-
  Tests whether current Agent Plugin hosts can natively update an exact remote
  snapshot while satisfying plugnz sync, verification, rollback, and retention
  requirements.
author:
  harness: codex
  model_family: gpt-5
read_when:
  - deciding whether plugnz should delegate remote plugin updates to a host
  - changing sync, update, removal, or route-selection behavior for Claude Code, Codex, or dcode
keywords: [plugins, marketplace, update, sync, claude-code, codex, dcode, lifecycle]
---

# Native plugin update capabilities, 2026-10-09

## Verdict

The user's claim is **proved in the broad sense and disproved as a portable
contract**.

All three deep-dive hosts have some native way for remote marketplace content to
advance:

- Claude Code has an exact-plugin `plugin update` command.
- Codex has a marketplace-scoped `plugin marketplace upgrade` command and an
  exact-plugin `plugin add` command that also reinstalls.
- dcode can reinstall an exact package from an already-refreshed marketplace
  when its declared version advances, and also has an opt-in background
  updater.

But “open-source Agent Plugin” does not imply any lifecycle API, and none of
those facts alone proves the operation required by plugnz. The present fit is:

| Current host | Native update surface | Meets the complete plugnz remote-update contract today? |
| --- | --- | --- |
| Claude Code 2.1.295 | `claude plugin update <plugin>@<marketplace> --json` | **Conditional.** Exact package scope and a synchronous result exist. Exact bytes require a source already pinned to the desired snapshot. Ordinary versioned sources do not refresh changed bytes at the same version. Content readback and failed-update rollback are not documented. |
| Codex 0.162.0 | `codex plugin marketplace upgrade [marketplace] --json`; exact-plugin `plugin add` reinstalls | **Conditional.** An upgraded Git marketplace force-reinstalls installed plugins, including same-version changes, and a configured full SHA can freeze the marketplace. Upgrade is marketplace-scoped, has no per-call revision, emits no JSON on failure, and has only per-plugin rather than batch rollback. |
| deepagents-code 0.1.83 (`dcode`) | Exact-package `plugin install` can reinstall content from an already-refreshed marketplace; background `auto_update_plugins()` runs after the first prompt | **No.** There is no public update command. A versioned-package reinstall reuses an already-cached declared version, while unversioned content is recopied; the background updater is asynchronous, package-opt-in, and version-change-only. Sources are branch/tag based, and neither route provides the complete structured/readback contract. |

The durable policy can therefore be **native-first only after a versioned host
capability check proves the whole operation**, not native-first merely because
the package is OSS or uses `plugin.json`. A host-native operation that cannot
consume the preflighted snapshot, refresh the required bytes, or be verified
must remain a visible unsupported route or use an already-proven Managed route
chosen before mutation. This report does not choose which routes to implement.

## What was tested

The published/current versions on 2026-10-09 were:

| Product | Current version examined | Primary release evidence |
| --- | --- | --- |
| Claude Code | 2.1.295 | [official release](https://github.com/anthropics/claude-code/releases/tag/v2.1.295) |
| Codex CLI | 0.162.0, commit `c1382380de69521303b416720a52f42d51af6248` | [official release](https://github.com/openai/codex/releases/tag/rust-v0.162.0) |
| deepagents-code | 0.1.83, commit `caaa7e7c12d214afa5cf0a1afed8eb6232aa6f7b` | [PyPI release](https://pypi.org/project/deepagents-code/0.1.83/) and [source tag](https://github.com/langchain-ai/deepagents/tree/deepagents-code%3D%3D0.1.83) |

Documentation and release-pinned source were checked together. Behavioral
reproductions ran in the Vercel Sandbox
`plugnz-native-update-proof-20261009`, against controlled HTTPS Git sources and
isolated home directories. The real installation was not read as an update
source and was not mutated.

The original Claude and Codex sandbox results are retained here as exact
session observations, but their disposable sandbox, raw streams, and replay
scripts were not retained. Their source-level conclusions were independently
checked against the pinned implementations above; the behavioral observations
are not independently replayable from a stored artifact. The dcode probe was
subsequently rerun in a fresh sandbox and is fully retained as a
[manifest](../evidence/dcode-native-update-0.1.83-20261009.json),
[script](../evidence/dcode-native-update-0.1.83-20261009.sh), and
[raw output](../evidence/dcode-native-update-0.1.83-20261009.raw.txt).

## The contract being tested

This is stricter than “the host eventually gets a newer version.” The accepted
plugnz contract requires the route to:

1. operate on the immutable Source snapshot that plugnz resolved and validated;
2. consume those exact desired bytes rather than independently resolving a
   moving remote;
3. refresh changed content even when a producer did not change its declared
   version;
4. return a synchronous, actionable result and support installed-content
   readback before success;
5. make activation timing explicit;
6. retain the last conforming activation on candidate failure and never
   silently switch routes after a native mutation starts; and
7. remove only ownership-proven orphaned code while preserving plugin-created
   data and inactive host metadata.

These requirements come from the approved [source-preflight ADR](../adr/0002-preflight-before-native-activation.md),
[authoritative-sync ADR](../adr/0001-authoritative-sync.md), [failure-containment
ADR](../adr/0003-contain-bugs-globally-and-capability-gaps-locally.md), and
[state-retention ADR](../adr/0004-retain-plugin-state-on-removal.md). A host may
still supply part of the route; plugnz must prove and fill the remaining pieces
rather than treating command exit zero as convergence.

## The format and OSS status guarantee no lifecycle

Agent Plugins 1.0.0 calls itself a portable package format and explicitly
leaves “distribution, installation, permissions, user experience, and
client-specific capabilities” to each client. Open development and an open
license do not add a lifecycle contract. [Official overview, lines
6–12](https://github.com/agentplugins/agent-plugins-site/blob/f399975c2ac012961df4a8edfd9036bb017da95f/content/docs/index.mdx#L6-L12)

The normative specification only says that clients **may** use `version` for
update availability and cache staleness. Minimum conformance is directory
loading, manifest validation, discovery of supported components, and support
for at least one component type; clients must ignore unsupported component
types. It requires no marketplace, install, update, remove, package selection,
same-version refresh, or rollback API. [Agent Plugins 1.0.0
§10.2–§11.3](https://github.com/agentplugins/agent-plugins-spec/blob/ff8ab5e392cc87bd88d87c060815a87490e51003/spec/1.0.0.md#L514-L548)

The specification's future-considerations document places standardized
install, enable, disable, update, and uninstall events in future work. [Future
considerations, lines
41–48](https://github.com/agentplugins/agent-plugins-spec/blob/ff8ab5e392cc87bd88d87c060815a87490e51003/FUTURE_CONSIDERATIONS.md#L41-L48)

Therefore a capability profile must be keyed by at least host, host version,
source type, and operation. Format conformance and repository visibility are
not evidence for lifecycle equivalence.

## Claude Code 2.1.295

### What is native

`claude plugin update <plugin> [--scope ...] [--json]` updates one qualified
plugin to the latest version its marketplace offers. Scope is auto-detected in
current versions, and a bare name is refused when it is ambiguous. The JSON
result has `command`, `outcome`, and `message`, with fields such as `pluginId`,
`scope`, and `failureCode` when applicable; usage errors can still exit 1 with
stderr and no JSON result. [Official CLI reference: JSON
results](https://code.claude.com/docs/en/plugins/cli-reference#plugin-json-result)
and [`plugin update`](https://code.claude.com/docs/en/plugins/cli-reference#plugin-update)

The shell command `claude plugin marketplace update <name>` refreshes a catalog
but does not update its installed plugins. The interactive **Update
marketplace** action does both, except that command-source and
`headersHelper`-protected plugins are left for exact-plugin updates. There is no
shell command that updates all installed plugins. [Official install guide:
Update plugins now](https://code.claude.com/docs/en/plugins/install#update-plugins-now)

That distinction makes the exact-plugin command the relevant native primitive
for plugnz; the similarly named shell marketplace command is not a substitute.

### Exact snapshots and same-version bytes

Claude marketplace plugin sources support a full 40-character commit `sha` for
`github`, Git URL, and `git-subdir` entries. With both `ref` and `sha`, Claude
checks out the SHA. [Official marketplace source
reference](https://code.claude.com/docs/en/plugins/marketplace-reference#plugin-sources)

However, `plugin update` takes no revision argument. It can consume plugnz's
preflighted snapshot only when the configured marketplace entry already names
that exact SHA (or otherwise resolves immutably to the same bytes). A moving
branch selected independently by Claude is not the frozen input merely because
plugnz resolved that branch immediately beforehand.

Claude's update detection is version based. A copied plugin is not replaced
when its computed version matches `installed_plugins.json`; a manifest version
has priority over marketplace version and source identity. For ordinary Git,
archive, and relative-path sources, same declared version means changed bytes
remain stale. Omitting both version fields makes Git commit SHA or archive hash
the version; command sources use a content hash and can therefore detect
changed output. [Official loading reference: Versions and
updates](https://code.claude.com/docs/en/plugins/loading#versions-and-updates)

Consequently, native update covers an exact changed snapshot when its computed
version changes or is content-derived. It does **not** provide a force-refresh
primitive for an ordinary source whose explicit version stayed the same.

### Isolated Vercel Sandbox reproduction

The controlled Claude probe established the composed command behavior on
2.1.295:

1. Native install put version `0.1.0` / marker V1 at
   `~/.claude/plugins/cache/probe-market/probe/0.1.0`; marker SHA-256 was
   `2f440d4928f04f4b36c61bc44a44d33eb95a8ef0233fa1949860958b2813937d`.
2. The remote marketplace commit changed the plugin to marker V2 without
   changing version `0.1.0`. `plugin marketplace update probe-market --json`
   refreshed the marketplace clone, but not the installed cache. The following exact-plugin
   update returned `outcome: "ok"`, `updateOutcome: "up_to_date"`, and
   `oldVersion: "0.1.0"` / `newVersion: "0.1.0"`; the cache remained V1.
3. The remote then changed to version `0.1.1` / marker V3. Exact-plugin update
   **without** a prior marketplace refresh remained `up_to_date` at `0.1.0`.
   Thus `plugin update` did not itself advance this configured marketplace
   snapshot.
4. After `plugin marketplace update probe-market --json`, exact-plugin update returned
   `updateOutcome: "updated"`, old `0.1.0`, new `0.1.1`, and `Restart to apply
   changes`. The new cache contained V3, SHA-256
   `954d79a6113f4c85d17c071d6820d54170249d1cb65f404f1af5e559513429a4`;
   the old `0.1.0` cache remained on disk.

The usable native sequence for this source class is therefore marketplace
refresh followed by exact-plugin update. Neither command repairs explicit
same-version drift.

### Result, activation, rollback, and removal

The command completes synchronously and has machine-readable success/failure,
but its documented JSON does not include an installed path or content digest.
plugnz would still need to locate and hash the native cache, then compare it with
the preflighted projection. A new version loads in the next session or after
`/reload-plugins`; some monitors still require a session restart. [Official
loading reference: active-session behavior](https://code.claude.com/docs/en/plugins/loading#when-auto-update-runs)

Anthropic's public documentation does not promise that a failed copied-plugin
update transactionally retains the prior cache entry. That is unresolved until
an isolated failure probe or an authoritative source contract proves it.

Removal also needs a wrapper. `claude plugin uninstall` is exact-plugin and
scope-aware, but last-scope uninstall normally deletes saved options, secrets,
and plugin data. `--keep-data` preserves the data directory; the documentation
does not say it preserves options and secrets. [Official CLI reference: What an
uninstall deletes and keeps](https://code.claude.com/docs/en/plugins/cli-reference#what-an-uninstall-deletes-and-keeps)
The marketplace-level `forceRemoveDeletedPlugins` policy automatically removes
missing entries but has no ownership proof or state-retention option. [Official
marketplace guide](https://code.claude.com/docs/en/plugins/host-marketplace#uninstall-removed-plugins-from-users-machines)

Thus native update is a plausible conditional route, while native orphan
removal does not by itself meet the accepted metadata-retention rule.

## Codex 0.162.0

### What is native

The current CLI has `plugin add`, `list`, `marketplace`, and `remove`; it has no
`plugin update` subcommand. `codex plugin marketplace upgrade
[MARKETPLACE_NAME] --json` refreshes one configured Git marketplace, or every
configured Git marketplace when no name is passed. Exact-plugin `plugin add`
is an install/reinstall primitive and returns plugin identity, version, and
installed path as JSON. [Release-pinned CLI
source](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/cli/src/plugin_cmd.rs#L49-L135)
and [official marketplace
documentation](https://developers.openai.com/plugins/build/plugins#add-a-marketplace-from-the-cli)

After a configured marketplace revision changes, the manual upgrade path
force-reinstalls every configured non-curated plugin found in the upgraded
marketplace. It does not stop at a version equality check. [Release-pinned
upgrade orchestration](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/core-plugins/src/manager.rs#L2941-L3018)
and [force-reinstall loop](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/core-plugins/src/loader.rs#L542-L709)

This proves a real native remote-update mechanism, including same-version
content refresh. It is marketplace scoped, not package scoped: invoking it may
refresh installed plugins in that marketplace that are outside the requested
plugnz package set. A following exact-plugin `add` can reinstall one plugin, but
it reads the already-configured marketplace snapshot and does not itself
advance that snapshot.

### Exact snapshots and same-version bytes

Codex marketplace configuration accepts `--ref`, and marketplace plugin entries
may use `ref` or `sha`. Its Git implementation recognizes a full 40-character
SHA as already resolved and checks it out directly. [Official plugin
documentation](https://developers.openai.com/plugins/build/plugins#marketplace-metadata)
and [release-pinned Git
implementation](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/core-plugins/src/marketplace_upgrade/git.rs#L9-L150)

The upgrade command itself has no revision argument. Exact-snapshot use is
therefore conditional on the marketplace configuration and every external
plugin source already being bound to the preflighted revision. If an external
plugin branch moves but the marketplace repository does not, marketplace
upgrade reports no upgraded root and does not run the force-reinstall loop.
An exact-plugin `add` after independently establishing the desired marketplace
snapshot is the narrower native reinstall operation.

### Isolated Vercel Sandbox reproduction

The controlled Codex probe established behavior, not merely command presence:

1. `codex plugin add probe@probe-market --json` installed version `0.1.0` at
   `~/.codex/plugins/cache/probe-market/probe/0.1.0`. Marker V1 had SHA-256
   `2f440d4928f04f4b36c61bc44a44d33eb95a8ef0233fa1949860958b2813937d`.
2. The remote marketplace commit changed the plugin to marker V2 while keeping
   manifest version `0.1.0`.
3. `codex plugin marketplace upgrade probe-market --json` returned
   `selectedMarketplaces: ["probe-market"]`, a non-empty `upgradedRoots`, and
   `errors: []`. That command alone replaced the installed bytes with V2,
   SHA-256
   `1c54d9e09b3a7c53a4fd7b596c6f804d371392f75558d39d7d87ed25e8a433bb`.
   A subsequent `plugin add` was redundant.
4. After the remote changed to version `0.1.1` / marker V3, `plugin add` before
   marketplace upgrade remained at stale `0.1.0` / V2. Marketplace upgrade
   alone then moved the install to `0.1.1` / V3, SHA-256
   `954d79a6113f4c85d17c071d6820d54170249d1cb65f404f1af5e559513429a4`.
5. `plugin list --json` then reported `0.1.1`, enabled, and the configured Git
   marketplace source. Running-session hot reload was not tested.

A second probe installed two plugins from the same marketplace, changed both
at version `0.1.0`, and ran one marketplace upgrade. Both caches advanced from
V1 to V2. This confirms that the upgrade syntax's marketplace scope is also its
mutation scope; there is no package selector.

A third probe added the marketplace once with `--ref main` and once in a fresh
home with a full commit SHA. The moving-branch install advanced on upgrade. The
SHA-pinned install remained at its original bytes after the branch advanced,
proving exact marketplace pinning at configuration time. `plugin marketplace
list --json` omitted the configured ref, however; `config.toml` was required to
read it back. Upgrade offers no `--ref` override for a new desired snapshot.

### Result, activation, rollback, and removal

Success is synchronous, but the `--json` failure path is defective for an
orchestrator: it prints individual errors to stderr and bails before serializing
the JSON object whose schema includes `errors`. plugnz must capture stderr or an
upstream fix must make failure JSON reachable. [Release-pinned JSON
implementation](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/cli/src/marketplace_cmd.rs#L448-L490)

Each plugin install is staged, validated, and atomically swapped, with rollback
if activation rename fails. The marketplace advances first, then plugins are
refreshed one by one; errors are accumulated and later plugins continue. The
whole marketplace plus plugin set is therefore not transactional. [Release-pinned
store implementation](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/core-plugins/src/store.rs#L554-L690)

The native cache update is proven on disk. No official CLI contract found here
proves activation in an already-running Codex session, so live activation is
unresolved and must not be reported as verified.

`codex plugin remove` removes the exact plugin cache and clears its user config
row. Plugin data lives under a separate data root and is not deleted by that
store operation, but `clear_user_plugin` removes the entire
`[plugins."id@market"]` table, including fields other than `enabled`. [Release-pinned
uninstall flow](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/core-plugins/src/manager.rs#L2323-L2378),
[data-root separation](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/core-plugins/src/store.rs#L87-L147),
and [config-row deletion](https://github.com/openai/codex/blob/c1382380de69521303b416720a52f42d51af6248/codex-rs/config/src/plugin_edit.rs#L105-L114)

Native removal consequently preserves plugin-created data but can violate the
accepted rule to preserve inactive host metadata. It needs a metadata-preserving
wrapper or an upstream removal mode before it can own orphan retirement.

## dcode 0.1.83

### What is native

The current public CLI exposes plugin `list`, `install`, `uninstall`, `enable`,
and `disable`, plus marketplace `list`, `add`, and `remove`. It exposes no
plugin or marketplace update command. This remains true on current upstream
main commit `efd88ff8fd1279361de77a83c9f75d98ed2f36d5`. [Release-pinned command
parser](https://github.com/langchain-ai/deepagents/blob/caaa7e7c12d214afa5cf0a1afed8eb6232aa6f7b/libs/code/deepagents_code/plugins/commands_cli.py#L62-L91)
and [current-main command
parser](https://github.com/langchain-ai/deepagents/blob/efd88ff8fd1279361de77a83c9f75d98ed2f36d5/libs/code/deepagents_code/plugins/commands_cli.py#L62-L91)

dcode's public `plugin install <name>@<marketplace>` can advance an existing
versioned package when its already-refreshed marketplace exposes a different
version.
It is not a versioned-package force-refresh primitive: repeated install reuses
a non-empty cache for an already-cached declared version. An unversioned source
does not take that cache-reuse branch and is recopied. dcode also has a
background updater. After the first prompt it refreshes
remote marketplaces and considers every enabled installed plugin. A plugin is
updated only when it has a non-empty version, its manifest opts in with
`extensions.com.langchain.deepagents.code.autoUpdate: true`, and the newly
resolved version differs from the installed version. Errors are logged per
marketplace or plugin and the loop continues. [Official dcode
documentation](https://docs.langchain.com/oss/deepagents/code/plugins#automatically-update-plugins)
and [release-pinned updater](https://github.com/langchain-ai/deepagents/blob/caaa7e7c12d214afa5cf0a1afed8eb6232aa6f7b/libs/code/deepagents_code/plugins/discovery.py#L317-L462)

This is useful end-user auto-update behavior, but it is not a synchronous,
package-scoped deployment API.

### Exact snapshots, same-version bytes, and readback

Repository marketplace `ref` explicitly means a branch or tag; full commit SHA
checkout is not part of dcode's shallow-clone flow. The clone implementation
passes it to `git clone --depth 1 --branch`. [Release-pinned source
model](https://github.com/langchain-ai/deepagents/blob/caaa7e7c12d214afa5cf0a1afed8eb6232aa6f7b/libs/code/deepagents_code/plugins/models.py#L27-L37)
and [clone
implementation](https://github.com/langchain-ai/deepagents/blob/caaa7e7c12d214afa5cf0a1afed8eb6232aa6f7b/libs/code/deepagents_code/plugins/marketplace.py#L278-L315)

For versioned packages, both the background updater and repeated public install
skip same-version refresh in practice. The updater skips equal versions. The
cache installer, on finding a non-empty existing version directory, validates
and re-registers the existing cache rather than copying the newly fetched
source; unversioned installs bypass that reuse branch. [Release-pinned
cache implementation](https://github.com/langchain-ai/deepagents/blob/caaa7e7c12d214afa5cf0a1afed8eb6232aa6f7b/libs/code/deepagents_code/plugins/store.py#L485-L559)

`plugin list --json` reports only `id`, `description`, and `enabled`, not the
installed version, path, source revision, or content digest. [Release-pinned
list output](https://github.com/langchain-ai/deepagents/blob/caaa7e7c12d214afa5cf0a1afed8eb6232aa6f7b/libs/code/deepagents_code/plugins/commands_cli.py#L94-L126)
Successful background updates notify the user to run `/reload`; Python
extensions require `/restart`. [Release-pinned app
behavior](https://github.com/langchain-ai/deepagents/blob/caaa7e7c12d214afa5cf0a1afed8eb6232aa6f7b/libs/code/deepagents_code/app.py#L18994-L19021)

### Isolated Vercel Sandbox reproduction

The controlled dcode probe used `deepagents-code 0.1.83`, an isolated home, and
a controlled HTTPS Git marketplace:

1. Version `0.1.0`, marker V1 installed under dcode's current hashed native
   cache layout:
   `proof-market-cd9f423ff3061dae749b94f13389ee37/proof-plugin-5491552c13c89a0b05ab1afb3cbcb782/0-1-0-6ad9613a455798d6d92e5f5f390ab4ba`.
2. `dcode plugin marketplace update proof-market` exited 2: argparse reported
   an invalid choice and listed only `list`, `ls`, `add`, and `remove`.
3. After the remote changed to marker V2 but retained version `0.1.0`, re-adding
   the marketplace and reinstalling the plugin left marker V1 in place. Calling
   the internal `auto_update_plugins()` returned `()`.
4. After the remote changed to version `0.1.1`, marker V3, and opted in with the
   dcode-specific `autoUpdate: true`, `auto_update_plugins()` returned
   `('proof-plugin@proof-market',)` and installed marker V3 under the new hashed
   `0-1-1-11ee23b8fc2fc619d6eab6277adb5a52` cache path.
5. Version `0.1.2` with `autoUpdate: false` produced `()` and left `0.1.1`
   active. This proves explicit opt-out, not behavior when the extension field
   is absent.
6. With that refreshed marketplace still at `0.1.2`, public exact-package
   `plugin install proof-plugin@proof-market` advanced the active record from
   `0.1.1` to `0.1.2` despite `autoUpdate: false`. This proves install can
   apply a newer catalog entry; it does not prove install alone refreshes a
   stale marketplace clone.

The corrected replay, exact paths, command output, hashes, resource use, and
cleanup proof are preserved in the linked dcode evidence artifacts above.

One official LangChain-owned marketplace README currently tells users to run
the nonexistent `dcode plugin marketplace update langchain-plugins`, while its
Claude and Codex examples use real commands. That is a verified upstream
documentation/product mismatch, not evidence that plugnz is invoking the CLI
incorrectly. [LangChain Plugins README at the examined
commit](https://github.com/langchain-ai/langchain-plugins/blob/29a7cebc797eb099cbd9c311cbd927289c656e96/README.md#L100-L110)

### Rollback and removal

dcode stages a new cache copy and restores the old one if the filesystem swap
fails, but its background loop updates packages independently, logs failures,
and continues. It has neither a batch rollback boundary nor a synchronous
failure result for plugnz.

Native uninstall removes the install record, active enablement, and recorded
cache path while leaving the separate plugin data directory in place. It does
not establish plugnz ownership or containment before deleting the recorded
path, so an orchestrator must prove both before calling it. [Release-pinned
data-root and uninstall
implementation](https://github.com/langchain-ai/deepagents/blob/caaa7e7c12d214afa5cf0a1afed8eb6232aa6f7b/libs/code/deepagents_code/plugins/store.py#L74-L90)
and [cache deletion](https://github.com/langchain-ai/deepagents/blob/caaa7e7c12d214afa5cf0a1afed8eb6232aa6f7b/libs/code/deepagents_code/plugins/store.py#L562-L579)

## Other implemented hosts: native surface check

The same primary-source check across plugnz's other implemented native hosts
strengthens the broad claim: native update mechanisms are common. It also
strengthens the qualification: their contracts differ materially. These rows
are source findings, not fresh sandbox acceptance tests, so any unproved cell
must remain version-gated and unverified in an adapter.

| Host | Current native surface | Contract consequence |
| --- | --- | --- |
| OMP | `omp plugin marketplace update <market>` refreshes the catalog; `omp plugin upgrade <id>` reinstalls one plugin. Forced reinstall replaces same-version content and preserves disabled state, feature selection, and settings. | Strong candidate after binding the catalog/plugin source to the preflighted SHA and proving synchronous readback. All-plugin upgrade can partially succeed. Removing a marketplace explicitly does **not** uninstall its plugins, so authoritative pruning needs exact-plugin uninstall. [Pinned official marketplace guide](https://github.com/can1357/oh-my-pi/blob/e26e089c6e92caa6c5d29290272ab3b0e409777c/docs/marketplace.md#updates-removal-and-scope) |
| Hermes | `hermes plugins update <name>` is package scoped. Catalog installs re-pin to a reviewed SHA; custom Git installs update a staged copy and publish through a recoverable handoff. Pinned arbitrary installs refuse a moving update and require an explicit new SHA. | Strong exact-source and rollback primitives, but capability/dependency expansion can require consent and the public update command is human-oriented rather than a documented JSON receipt. [Pinned update command](https://github.com/NousResearch/hermes-agent/blob/1e0c7730d791f5ce855c5c78935cfea6fb1e43a9/hermes_cli/plugins_cmd_update.py#L23-L115) and [transaction](https://github.com/NousResearch/hermes-agent/blob/1e0c7730d791f5ce855c5c78935cfea6fb1e43a9/hermes_cli/plugins_transaction.py#L90-L208) |
| Grok | `grok plugin update [<name>]` updates one or all plugins. Sources accept exact commit SHA, policy can require SHA, and the marketplace updater stages, validates, swaps, and rolls back an exact plugin even when the manifest version is unchanged. | Strong native candidate; plugnz still needs a machine-readable receipt/readback plan and must report that the running session needs `r` reload or a new session. [Pinned user guide](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/09-plugins.md#L64-L123) and [transactional updater](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-plugin-marketplace/src/installer.rs#L185-L410) |
| ZCode CLI | `zcode plugins update <plugin>` refreshes the owning marketplace and reinstalls the same entry; its JSON mode returns previous/current versions plus diagnostics. Archives are SHA-256 verified and installed by atomic replacement. | Strong synchronous exact-package candidate. Official distribution declares a published version immutable, so changed bytes under one version are a producer error to reject, not a supported repair case. Restart is required. [Pinned CLI implementation](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/cli/src/plugins-command.ts#L170-L208), [update composition](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/plugins.ts#L824-L857), and [immutable distribution contract](https://github.com/zai-org/zcode-plugins/blob/8b8c69c1b73be497d0e4865e6b74b5c05898d5d7/docs/distribution.md#L60-L89) |
| Kimi Code | The `/plugins` manager offers per-plugin update when a newer marketplace version is available. `/plugins install <URL>` can reinstall from a branch, tag, short SHA, or exact commit URL. | Native capability exists but is interactive/slash-command oriented, not a documented synchronous automation API. Marketplace update detection is version based; direct exact-source reinstall is the same-version escape hatch. Changes require `/reload` or `/new`. [Pinned official plugin guide](https://github.com/MoonshotAI/kimi-code/blob/5b936697670ed15444bcb4720bd91e6ee776a941/docs/en/customization/plugins.md#installation-and-management) |
| Cursor | Team marketplaces can auto-refresh or be manually refreshed/re-indexed, and installed plugins are managed through Customize. Current public documentation does not expose an exact-package update CLI or an installed-byte receipt. | Marketplace refresh is native, but it is not enough evidence for a plugnz package-update route. Keep exact activation/readback unverified until a stable client API or isolated proof exists. [Official plugin update documentation](https://cursor.com/docs/plugins#keep-plugins-up-to-date) |

Across all nine implemented native hosts, five expose an explicit exact-package
update command (Claude, OMP, Hermes, Grok, and ZCode). Codex is
marketplace-batch plus exact-package reinstall; Kimi's route is
interactive/reinstall-oriented; dcode's public exact-package reinstall can
advance a declared version or recopy unversioned content but reuses an
already-cached declared version, and its dedicated updater is background-only;
Cursor publicly documents marketplace re-index rather than an exact package
operation. That is strong evidence for
**native-first capability discovery**, not for a universal native-update
adapter.

## What `npx skills` proves, and what it does not

Vercel Labs `skills` 1.7.1 is useful prior art for provenance and refresh, but it
does not delegate updates to harness-native plugin marketplaces. It tracks
source metadata, compares folder/tree hashes, and invokes its own `add` flow
again when content changes. [Release](https://github.com/vercel-labs/skills/releases/tag/v1.7.1)
and [release-pinned update
implementation](https://github.com/vercel-labs/skills/blob/958f4b7389ba698b0a6a26a1e505ae2af82364d2/src/update.ts#L632-L733)

Its default symlink mode first copies a skill into the canonical
`.agents/skills` location, then links agent-specific paths to that canonical
copy; it is not a live link back to the remote or original checkout. [Release-pinned
installer](https://github.com/vercel-labs/skills/blob/958f4b7389ba698b0a6a26a1e505ae2af82364d2/src/installer.ts#L295-L430)

Deleted tracked skills prompt interactively; `--yes` and other noninteractive
runs explicitly skip deletion. The update walk starts from lock entries, so it
does not make newly added upstream skills part of an authoritative desired set.
[Release-pinned deletion
behavior](https://github.com/vercel-labs/skills/blob/958f4b7389ba698b0a6a26a1e505ae2af82364d2/src/update.ts#L244-L294)

Its `experimental_sync` command solves a different problem: it discovers
skills in the current project's `node_modules`, copies them into the canonical
project skill store, and links selected agents to them. It is additive and has
no authoritative prune or dry-run phase. [Release-pinned sync
implementation](https://github.com/vercel-labs/skills/blob/958f4b7389ba698b0a6a26a1e505ae2af82364d2/src/sync.ts#L134-L430)

So `npx skills` supports content hashes, source tracking, and explicit deletion
as design precedents. It does not prove a portable native plugin updater, exact
snapshot activation, or authoritative remote orphan pruning.

## Verified bugs, capability limits, and unresolved questions

### Verified bugs or interface defects

- The LangChain-owned marketplace README documents a dcode marketplace-update
  command absent from both dcode 0.1.83 and current upstream main.
- Codex's `marketplace upgrade --json` failure path exits before emitting its
  defined JSON error object. Actionable stderr exists, but structured failure
  output does not.

These are upstream issues. A plugnz adapter that assumes either nonexistent or
structured behavior would also be a plugnz bug and, under the accepted failure
policy, must hard-block before writes.

### Verified native capability limits

- Agent Plugins 1.0.0 does not specify lifecycle commands.
- Claude ordinary versioned sources cannot force-refresh same-version content;
  native remove does not preserve all plugin state/metadata.
- Codex upgrade is marketplace-scoped and revision-less per invocation; its
  batch can partially advance, and native remove deletes the plugin config row.
- dcode has no manual update CLI, no commit-SHA marketplace checkout, no
  same-version refresh, no exact installed-state readback, and package authors
  control whether its asynchronous update happens.
- None of the three native CLIs returns a cryptographic digest of the installed
  package that can replace plugnz content verification.

These are not evidence that the hosts are broken. They are mismatches between
their current interfaces and the stricter plugnz contract.

### Unresolved and requiring direct proof

- Claude copied-plugin rollback after a fetch, validation, dependency, or
  activation failure.
- Claude's exact on-disk content readback for every supported source type after
  `plugin update`.
- Live-session activation of a CLI-driven Codex marketplace upgrade.
- Whether a future host release changes any capability above; every route needs
  a version gate rather than a timeless boolean.

## Remedy options and tradeoffs

No implementation scope is selected here. The evidence supports these options:

### 1. Capability-gated native-first orchestration

Resolve and validate the immutable snapshot first. Use a native route only when
the host/version/source profile proves exact revision binding, required package
scope, same-version behavior, synchronous diagnostics, verifiable readback,
activation semantics, rollback, and retention-safe removal.

- **Benefit:** lets the host own its supported cache, registry, dependency, and
  reload semantics.
- **Cost:** route logic is conditional and versioned; “native” is not one
  cross-host capability.
- **Safety boundary:** choose Native or Managed before writes. Once a native
  mutation begins, a bad result is reported and retained/recovered according to
  that route; it never silently falls through to Managed.

### 2. Claude conditional native route

Use exact-plugin update only when the controlled marketplace entry is already
pinned to the preflighted SHA and the computed version will change (or is
content-derived). Hash the installed native cache before reporting success.
Use another proven route for explicit-version same-version repair and for
orphan removal that must preserve options/secrets.

- **Benefit:** precise package scope and official JSON/reload behavior.
- **Cost:** controlled catalog rewriting or immutable catalog publication may
  be needed; same-version versioned packages and retention-safe removal remain
  gaps.
- **Upstream alternative:** request force reinstall/exact-revision input,
  installed digest/path output, documented rollback, and a keep-all-state
  uninstall mode.

### 3. Codex native marketplace plus exact-plugin reinstall

Bind a controlled marketplace and its external entries to the exact resolved
SHAs. Upgrade that marketplace, then use exact-plugin `add` only where package
scoping or explicit readback is needed. Verify returned installed paths and
content; parse stderr on upgrade failures.

- **Benefit:** current source and sandbox evidence prove atomic per-plugin
  same-version replacement.
- **Cost:** marketplace upgrade can touch unrelated installed packages and can
  partially succeed. Rebinding pinned revisions and preserving plugin config
  metadata need explicit orchestration.
- **Upstream alternative:** request `plugin update <id> --ref <sha> --json`,
  always-serialized error output, a content digest, and metadata-preserving
  remove.

### 4. Complete a dcode Managed route until its native API grows

Have plugnz own remote source resolution, exact-byte staging, same-version
replacement, verification, and reporting. This route is not complete today:
the writer must safely recognize dcode's hashed native cache layout, and it must
disable or avoid dcode auto-update for plugnz-owned installs so dcode cannot
advance them outside plugnz preflight.

- **Benefit if completed:** can satisfy deterministic source authority and
  handle current dcode cache naming without waiting for a new native API.
- **Cost:** plugnz continues to own host-specific lifecycle code instead of
  delegating it.
- **Upstream alternative:** add a synchronous package-scoped update command
  accepting an exact commit, a force-same-version mode, JSON version/path/digest
  readback, and explicit reload status.

### 5. Refuse the mismatched package × host operation

When neither a complete native route nor a proven Managed route exists, report
that pair as unsupported/unverified and nonzero while allowing independent
pairs to proceed. Do not relabel it “deferred” or “success.” A deterministic
plugnz safety bug, corrupt state, or ambiguous ownership remains a global
preflight hard block.

- **Benefit:** preserves semantics instead of shipping stale or partial
  functionality.
- **Cost:** the package remains unavailable on that host until one of the
  product routes is completed.

The implementation decision should be made per host and operation after these
tradeoffs are accepted; the mere existence of a native update feature is not
enough to choose it.
