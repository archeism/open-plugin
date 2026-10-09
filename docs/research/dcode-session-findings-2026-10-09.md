---
id: dcode-session-findings-2026-10-09
type: research
summary: >-
  Complete investigation of dcode delivery, compatibility, error reporting,
  native lifecycle, and orphan handling across plugnz and Personal.
author:
  harness: codex
  model_family: GPT-5
read_when:
  - changing plugnz's dcode adapter or compatibility model
  - changing Personal's dcode deployment or status reporting
  - implementing authoritative sync, native-first updates, or orphan retirement
keywords: [dcode, deepagents-code, plugins, sync, lifecycle, compatibility, errors]
---

# dcode session findings, 2026-10-09

## Executive verdict

All six reported problems are real, but they do not have one owner or one
failure mode:

| Finding | Classification | Current conclusion |
| --- | --- | --- |
| Hashed native cache paths | **Verified plugnz bug** | The reader accepts dcode's real hashed registry paths, while the writer rejects them before adoption. The bug remains on `main`. |
| Commands and agents | **Verified current dcode limitation**, plus plugnz modeling debt | dcode 0.1.83 and current upstream still inventory `commands/` and `agents/` as unsupported. Plugnz correctly refuses silent loss, but uses a static 0.1.74 profile and does not model agents as a typed capability. |
| Invocation policy | **Verified current dcode limitation**, plus an over-broad plugnz capability label | dcode does not consume `disable-model-invocation`, `user-invocable`, or Codex's sidecar equivalent. Plugnz's refusal protects semantics, but one `userOnlySkills` flag conflates manual-only and model-only policies. |
| One unsupported package stopped deployment | **Historical Personal orchestration bug; current workaround is still wrong** | `f2f5aad` made command-policy gaps skippable, so unrelated dcode packages continue. The skipped desired pairs now look successful, which violates the accepted loud/nonzero/red behavior and still delivers no functionality. |
| Useful diagnostic was hidden | **Verified current Personal bug** | Personal preserves plugnz's per-pair JSON diagnostic, then dcode's caller chooses the generic process diagnostic first. The exact failure was reproduced. |
| Addy absent from dcode | **Stale Personal selection policy, not an unexplained install failure** | Addy's host allowlist deliberately omits dcode. That conflicts with the user's now-explicit desired state. Selecting it currently exposes separate command and agent gaps; its 25 ordinary skills are otherwise supportable. |

The remote-update claim is also now proved precisely: **most of the tested
current hosts have a native update command, dcode does not, and the Agent
Plugins specification does not require any lifecycle API**. Claude Code and
Codex provide conditionally usable native operations; dcode 0.1.83 has an
exact-package `plugin install` path that can apply a newer declared version
from an already-refreshed marketplace or recopy unversioned content, plus an
opt-in background updater. Neither route satisfies plugnz's exact-snapshot,
synchronous-result, readback, and rollback contract. See the full
[native capability proof](native-plugin-update-capabilities-2026-10-09.md).

No implementation scope is selected in this report. The options and their
tradeoffs are recorded at the end so that none of the problems is silently
fixed, deferred, or excluded.

## Scope and evidence

The code audit is pinned to:

- plugnz `e8fe285d22d570a18abdb9ab631a609ffed6b4ad`;
- Personal `73053d5d04be5935dcc27f94df06cd42f682852f`;
- the installed plugnz checkout `ff00c075244cd3da2e2ef70ab7857a3245624726`
  and installed CLI `0.0.4`;
- the real installed `deepagents-code 0.1.56` and SDK `0.7.6`; and
- current isolated `deepagents-code 0.1.83`, release commit
  `caaa7e7c12d214afa5cf0a1afed8eb6232aa6f7b`, plus current upstream source.

Vercel authentication was verified before the isolated work. Behavioral native
update tests ran in Vercel Sandbox `plugnz-native-update-proof-20261009`, using
controlled Git sources and isolated home directories. The real installation
was not used as an update target and was not mutated. The existing backup at
`/home/charlesfengyc/.local/state/personal-backups/dcode-karakeep-20261008/`
was inspected only for provenance and was not changed.

The dcode behavior was rerun in a second fresh sandbox with the corrected,
pinned [manifest](../evidence/dcode-native-update-0.1.83-20261009.json),
[script](../evidence/dcode-native-update-0.1.83-20261009.sh), and
[raw output](../evidence/dcode-native-update-0.1.83-20261009.raw.txt) retained.
The earlier Claude and Codex behavior remains exact session evidence backed by
release-pinned source, but its disposable sandbox, raw streams, and replay
scripts were not retained; those observations are not independently replayable
from a stored artifact.

The focused current-code suites pass, but expose coverage gaps:

- plugnz dcode lifecycle/public/target tests: 23 pass, 0 fail, 102 assertions;
- Personal plugnz/dcode/plugin-host tests: 23 pass, 1 skip, 0 fail, 91
  assertions; and
- Personal's only real plugnz-to-dcode composition test is environment-gated
  and skipped by default.

Passing tests therefore do not contradict the reproduced failures below.

## 1. Hashed native cache paths cannot be adopted

### Verified behavior

dcode's real cache identity is hashed at every level. Current native code
normalizes the marketplace, plugin, and version into
`<slug>-<sha256-prefix>` segments before producing the cache path. The same
implementation exists in the inspected 0.1.56, 0.1.71, 0.1.74, and 0.1.83
releases. This is current native behavior, not a malformed legacy layout.
[dcode 0.1.83 cache-path source](https://github.com/langchain-ai/deepagents/blob/caaa7e7c12d214afa5cf0a1afed8eb6232aa6f7b/libs/code/deepagents_code/plugins/store.py#L93-L149)

Plugnz instead constructs only
`plugins/cache/<market>/<plugin>/<resolved.sha>` in
[`dcode-writer.ts` lines 23–24](https://github.com/archeism/plugnz/blob/e8fe285d22d570a18abdb9ab631a609ffed6b4ad/src/hosts/dcode-writer.ts#L20-L33).
When checking prior rows, it first asserts that the recorded installation path
is under that un-hashed plugin directory and then requires adoption to equal
the exact un-hashed version path.
[`dcode-writer.ts` lines 119–128](https://github.com/archeism/plugnz/blob/e8fe285d22d570a18abdb9ab631a609ffed6b4ad/src/hosts/dcode-writer.ts#L119-L128)

That ordering makes a legitimate native row impossible to adopt. An isolated
current-`main` reproduction supplied
`plugins/cache/personal-a1b2/karakeep-c3d4/0-1-0-e5f6` with
`adoptExisting: true`; it failed exactly with `dcode path escapes managed
cache`. The read side can list the same row, so the adapter's reader and writer
disagree. [Issue #29](https://github.com/archeism/plugnz/issues/29) records the
same Karakeep failure and the later Toolbox occurrence.

The existing adoption test uses only the assumed un-hashed layout, so it
cannot catch the regression.
[`dcode-lifecycle.test.ts` lines 38–55](https://github.com/archeism/plugnz/blob/e8fe285d22d570a18abdb9ab631a609ffed6b4ad/test/dcode-lifecycle.test.ts#L38-L55)
The host documentation also freezes the incorrect layout and adoption rule.
[`docs/hosts/dcode.md` lines 3–27](https://github.com/archeism/plugnz/blob/e8fe285d22d570a18abdb9ab631a609ffed6b4ad/docs/hosts/dcode.md#L3-L27)

### Remedy options and tradeoffs

1. **Adopt the native row after strong identity and containment proof.** Resolve
   the global dcode cache root, reject symlink/realpath escape, verify the
   registry ID, marketplace, plugin, declared version, and desired content,
   then record the native path rather than reconstructing it. This directly
   fixes native adoption. A hash-looking path segment is not itself identity or
   ownership proof.
2. **Delegate creation to dcode, then read the native row back.** This avoids
   duplicating its path algorithm. It is not sufficient on its own: current
   dcode can reuse stale same-version cache bytes and cannot consume an exact
   preflighted snapshot through a public update API.
3. **Keep the Managed writer but teach it dcode's hashed layout.** This is
   deterministic for the known version but couples plugnz to a private native
   algorithm. It needs version gating and readback to remain durable.

Every option needs regression cases for a valid hashed row, an outside-cache
row, a symlink escape, mismatched identity/version/content, and rollback. The
accepted explicit `--adopt-existing` action must be the point that grants
plugnz future lifecycle authority; discovery alone must not grant ownership.

## 2. Commands and agents are not native dcode components

### Verified behavior

The installed 0.1.56 behavior was not merely an old-version limitation.
Current dcode 0.1.83 still declares `agents` and `commands` as unsupported
component directories and records them as such during inventory.
[manifest declaration](https://github.com/langchain-ai/deepagents/blob/caaa7e7c12d214afa5cf0a1afed8eb6232aa6f7b/libs/code/deepagents_code/plugins/manifest.py#L21-L31),
[inventory logic](https://github.com/langchain-ai/deepagents/blob/caaa7e7c12d214afa5cf0a1afed8eb6232aa6f7b/libs/code/deepagents_code/plugins/manifest.py#L360-L423)
The current official plugin documentation lists skills, MCP servers, hooks,
and experimental Python extensions, but no plugin command or agent component.
[Official dcode plugin documentation](https://docs.langchain.com/oss/deepagents/code/plugins)

Plugnz detects any `commands/` directory before it detects `agents/`.
Commands produce a typed `CompatibilityError`; agents produce a raw `Error`
because the capability model has no `agentProjection` dimension.
[`dcode-writer.ts` lines 71–109](https://github.com/archeism/plugnz/blob/e8fe285d22d570a18abdb9ab631a609ffed6b4ad/src/hosts/dcode-writer.ts#L71-L109)
The dcode profile is a hard-coded 0.1.74 snapshot with no runtime version
probe.
[`consumer-profiles.ts` lines 54–59](https://github.com/archeism/plugnz/blob/e8fe285d22d570a18abdb9ab631a609ffed6b4ad/src/consumer-profiles.ts#L54-L59)
Its conclusion is still accurate at 0.1.83, but only by coincidence; the code
cannot notice a later native capability change.

Vercel has three Markdown commands. Addy has nine TOML commands and four
agents, so its command refusal currently masks a second, untyped agent refusal.

### Remedy options and tradeoffs

1. **Keep the pair blocked until dcode supports the components.** This has the
   strongest semantic guarantee but delivers none of that package to dcode.
2. **Represent a package as component-level results.** Install the natively
   supported skills/hooks while keeping commands/agents loud and red. This
   delivers useful regular content but is not a successful full-package
   install; it changes the product's current all-or-nothing unit and therefore
   needs an explicit decision.
3. **Project commands or agents onto a dcode surface only after equivalence is
   proved.** `/skill:` or a Python extension may look similar, but command
   arguments, preprocessing, permissions, agent isolation, tool/model choices,
   and invocation policy must survive. A rename or lossy copy is not an exact
   projection.
4. **Add the missing primitives upstream.** This gives the cleanest native
   route and benefits other clients, but has external timing and review risk.
   Until released and version-detected, desired pairs remain undelivered.

Independently of route choice, plugnz should model commands and agents as
separate typed capabilities and determine them from the installed dcode
version or a proven runtime probe.

## 3. User/model invocation policies are not preserved

### Verified behavior

dcode reads a skill's `name` and `description`, model-discovers it by
description, and exposes plugin skills through `/skill:`. The official docs do
not define `disable-model-invocation`, `user-invocable`, or the Codex sidecar
policy. [Official skills documentation](https://docs.langchain.com/oss/deepagents/code/memory-and-skills)

Source and isolated probes found no native consumption of:

- `disable-model-invocation: true` or aliases, which mean manual-only;
- `user-invocable: false` or aliases, which mean model-only; or
- `agents/openai.yaml` with `policy.allow_implicit_invocation: false`.

Ignoring these fields changes both directions of policy: manual-only content
becomes model-discoverable, while model-only content becomes directly
user-invocable. A generic slash command therefore does not preserve
manual-only semantics.

Plugnz detects all three forms and refuses them.
[`dcode-writer.ts` lines 79–109](https://github.com/archeism/plugnz/blob/e8fe285d22d570a18abdb9ab631a609ffed6b4ad/src/hosts/dcode-writer.ts#L79-L109)
That refusal is the correct non-lossy result against current dcode. The defect
is in modeling and versioning: `userOnlySkills` conflates two opposite policy
directions and remains tied to a static 0.1.74 profile. The earlier probe is
preserved in
[`dcode-native-batch2-20260923.md`](../evidence/dcode-native-batch2-20260923.md),
but its old Matt Pocock package counts are no longer current; today's package
has 22 restricted skills and 22 sidecars, while Try Skill has one restricted
skill.

### Remedy options and tradeoffs

1. **Continue to hard-refuse any policy dcode cannot express.** Safe and
   simple, but leaves Matt Pocock and Try Skill undelivered.
2. **Use an experimental Python extension to filter model discovery while
   retaining `/skill:`.** Existing evidence shows a plausible seam for the
   manual-only direction. It is experimental, restart-sensitive, and not proof
   of a complete route. It does not yet prove the inverse model-only policy.
3. **Contribute stable policy primitives upstream.** Durable, but externally
   dependent.
4. **Build a Managed exact projection.** Potentially complete, but plugnz would
   own compatibility with internal dcode APIs and would need per-version
   behavioral tests.

Whichever route is selected, capabilities should be split at least into
`modelInvocationControl` and `userInvocationControl`, with structured evidence
and an exact per-skill diagnostic.

## 4. Unsupported packages and deployment containment

### Verified behavior

Before Personal commit
[`f2f5aad`](https://github.com/archeism/personal/commit/f2f5aad86c93b87911547bd8747109942b4eb4fe),
only `userOnlySkills` was recognized as a deferrable dcode gap. Vercel's
`commandProjection` failure escaped and stopped the remaining deployment.

That commit expanded a diagnostic-text regular expression to
`(userOnlySkills|commandProjection)`. Current Personal preflights each dcode
package, skips matching failures, and applies eligible packages.
[`dcode.ts` lines 26–99](https://github.com/archeism/personal/blob/73053d5d04be5935dcc27f94df06cd42f682852f/src/cli/dcode.ts#L26-L99)
The status layer then explicitly exempts both deferred reasons from problems.
[`plugin-hosts.ts` lines 123–145](https://github.com/archeism/personal/blob/73053d5d04be5935dcc27f94df06cd42f682852f/src/cli/plugin-hosts.ts#L123-L145)

This is a useful containment workaround, not functionality delivery. It also
does not satisfy the now-settled policy:

- a deterministic plugnz bug, corrupt state, invalid input, or ambiguous
  ownership must hard-block before any write;
- a genuine unsupported/unverified package-host pair may not block independent
  pairs, but must make the overall run nonzero and remain visibly red; and
- skipped desired content may not become a note, a green status, or an audit
  exemption.

Current Personal can also mutate ZCode and Cursor before dcode preflight, so an
unexpected dcode bug can still leave a globally partial deployment.
[`plugins.ts` lines 549–559](https://github.com/archeism/personal/blob/73053d5d04be5935dcc27f94df06cd42f682852f/src/cli/plugins.ts#L549-L559)

### Proposed durable shape

Plugnz needs typed failure classes rather than prose matching. A global
resolve/freeze/validate/preflight phase should classify every requested pair
before mutation. Deterministic bugs and ambiguous state abort that plan with
zero writes. Genuine capability gaps are recorded per pair, independent pairs
may apply, and the aggregate result remains nonzero. If apply fails at runtime,
later mutations stop and the result distinguishes completed, pending, and
not-attempted work; no scope is pruned unless all desired operations in that
scope succeeded.

The tradeoff is a more explicit batch transaction model. It is necessary to
obtain both properties the user asked for: bug failures are globally hard,
while known capability gaps are locally contained but loud.

## 5. Actionable errors are masked by Personal

### Verified behavior

Personal successfully parses plugnz's JSON outcomes and retains their useful
diagnostics.
[`plgnz.ts` lines 111–127](https://github.com/archeism/personal/blob/73053d5d04be5935dcc27f94df06cd42f682852f/src/cli/plgnz.ts#L111-L127)
On a nonzero process exit it also sets the aggregate diagnostic to stderr or
the fallback `plugnz exited nonzero`.
[`plgnz.ts` lines 148–169](https://github.com/archeism/personal/blob/73053d5d04be5935dcc27f94df06cd42f682852f/src/cli/plgnz.ts#L148-L169)
Dcode's caller then prefers that aggregate message over the per-pair outcome,
opposite the other host callers.
[`dcode.ts` lines 26–33](https://github.com/archeism/personal/blob/73053d5d04be5935dcc27f94df06cd42f682852f/src/cli/dcode.ts#L26-L33)

The end-to-end fake-runner reproduction returned valid plugnz JSON with
`dcode path escapes managed cache: /native/hashed`, exit 1, and empty stderr.
Personal threw exactly `dcode karakeep: plugnz exited nonzero`.

### Remedy and tradeoffs

For a package-host failure, the structured outcome diagnostic should be
primary; process stderr is supplemental. The aggregate process diagnostic is
primary only when JSON is absent, malformed, or describes a transport/protocol
failure. Tests must cover valid nonzero JSON with empty stderr, generic stderr,
and useful stderr.

This exposes a deeper plugnz result-contract gap. `InstallOutcome.status`
currently mixes operation result, installed resource state, compatibility, and
plan state. Successful and dry-run removal can report `status: "installed"`.
[`cli.ts` lines 257–270](https://github.com/archeism/plugnz/blob/e8fe285d22d570a18abdb9ab631a609ffed6b4ad/src/cli.ts#L257-L270)
Because compatibility evidence is flattened into diagnostic prose, Personal
has to regex English text. Separating `action`, `result`, `resourceState`,
`activationState`, and structured `reason` is a larger but durable remedy;
fixing diagnostic precedence alone is smaller and immediately removes the
masking bug. These are compatible options, not a scope decision.

## 6. Addy is absent because Personal did not select it

### Verified behavior

Addy's current `hosts.yaml` explicitly includes every implemented normal
plugin host except dcode and OpenClaw.
[`hosts.yaml` lines 1–12](https://github.com/archeism/personal/blob/73053d5d04be5935dcc27f94df06cd42f682852f/plugins/addy/hosts.yaml#L1-L12)
With a sidecar present, Personal treats the list as an allowlist; it does not
run dcode preflight for an unselected plugin.
[`plugin-hosts.ts` lines 63–106](https://github.com/archeism/personal/blob/73053d5d04be5935dcc27f94df06cd42f682852f/src/cli/plugin-hosts.ts#L63-L106)
Status consequently emits `dcode: false` without a `dcodeDeferred` reason.
That output cannot distinguish “not desired” from “desired but failed.”

History shows the omission was intentional at the time: dcode command
projection was deferred while other hosts were progressively added. It is now
stale relative to the user's explicit decision that Addy should deploy to
dcode like other regular plugin and skill packages.

Addy contains 25 ordinary skills, nine TOML commands, four agents, and hooks.
It has no current invocation-policy flags. If dcode is added to the allowlist
today, plugnz refuses `commandProjection` first; after that is addressed, the
raw agents refusal remains. The ordinary skills and supported hook surface are
not the blocker.

### Delivery options and tradeoffs

The same command/agent options from finding 2 apply: block the whole pair,
report and install supported components as an explicitly incomplete result,
build an exact projection, or wait for/contribute native support. There must
not be an Addy-specific silent exception. Until one route is selected and
verified, Addy is desired for dcode but undelivered and should stay red.

## Lifecycle and orphan handling

### Current implementation gaps

Plugnz does not yet implement the accepted authoritative `sync` or
`retire-source` operations. Its state schema records source/source SHA,
source-directory, fingerprints, ownership, and installed rows, but not the
complete desired scope and selected set or a complete canonical source, route,
activation, and retention model.
[`state.ts` lines 29–49](https://github.com/archeism/plugnz/blob/e8fe285d22d570a18abdb9ab631a609ffed6b4ad/src/state.ts#L29-L49)
Therefore removing a package from Personal cannot currently prove that the
corresponding deployed package is an orphan and retire it automatically.

`update` walks existing installed records and, when an exact ID is absent from
the new collection, falls back to a same-named package. That can bind an old
record to a different marketplace package; if no match exists it tells the
operator to re-add manually rather than ending the lifecycle.
[`update.ts` lines 65–89 and 129–136](https://github.com/archeism/plugnz/blob/e8fe285d22d570a18abdb9ab631a609ffed6b4ad/src/update.ts#L65-L89)

Current dcode removal does verify plugnz ownership, then deletes the cache,
registry row, and enablement key.
[`dcode-writer.ts` lines 52–67](https://github.com/archeism/plugnz/blob/e8fe285d22d570a18abdb9ab631a609ffed6b4ad/src/hosts/dcode-writer.ts#L52-L67)
It leaves dcode's separate plugin-created data root. The inspected native
registry entry contains only install path/version and enablement is a boolean,
so there is no demonstrated inactive-metadata loss: removing those active
records is permitted by the accepted retention ADR. A broader retention audit
remains unresolved if dcode adds other metadata surfaces.
[dcode uninstall source](https://github.com/langchain-ai/deepagents/blob/caaa7e7c12d214afa5cf0a1afed8eb6232aa6f7b/libs/code/deepagents_code/plugins/store.py#L562-L579)

### Accepted lifecycle behavior

The following direction is already settled and should not be reopened without
new contradictory evidence:

- `add` and `update` remain non-pruning.
- `sync` treats the complete selected set for a source and requested host set as
  authoritative. It is noninvasive outside that scope and never edits the
  source.
- Applied sync may retire only ownership-proven omissions. `--dry-run` reports
  the plan without mutation.
- A missing, unreachable, malformed, or simply uninvoked source never implies
  deletion. Whole-source retirement is explicit through `retire-source`.
- Explicit `--adopt-existing` grants future lifecycle authority after identity
  proof.
- Removal retires deployed code and active registration but preserves
  plugin-created data and inactive metadata. Destructive data purge is a
  separate exact operation.
- Remote routes prefer a host's native update/remove primitive only where its
  complete semantics are proved for that host version. A native attempt that
  mutates and then fails may not silently fall back to another route.

These decisions are captured in the
[authoritative-sync ADR](../adr/0001-authoritative-sync.md),
[preflight ADR](../adr/0002-preflight-before-native-activation.md),
[failure-containment ADR](../adr/0003-contain-bugs-globally-and-capability-gaps-locally.md),
and [state-retention ADR](../adr/0004-retain-plugin-state-on-removal.md).

### Orphan options and tradeoffs

| Option | Benefit | Cost / risk |
| --- | --- | --- |
| Report-only orphans | Safest before ownership and scope are modeled | Does not converge; stale deployed code remains indefinitely |
| Explicit per-plugin `remove` | Precise and operator-controlled | Manual, easy to forget, and cannot express source retirement cleanly |
| Authoritative `sync` retirement | Converges selected source×host scope and works for local or remote sources | Requires durable desired-set, source, ownership, route, activation, and content records plus all-pairs preflight |
| Host-native marketplace pruning | Reuses host behavior where it exists | Not portable; may be too broad, may delete metadata/data, and still requires plugnz ownership/readback proof |

The accepted direction is authoritative sync, but implementation details remain
to be selected. A durable state record needs at least a credential-free
canonical source, explicit ref and resolved immutable snapshot, requested host,
complete selected plugin IDs, native IDs, ownership/adoption proof, chosen
route, fingerprints/readback, and activation status.

A live symlink from the native store back to a local distribution source would
make edits appear immediately, bypassing preflight, atomic activation, and
rollback; it also has no remote equivalent. Tracking the local source while
materializing a frozen snapshot is more consistent with remote sync. A symlink
route remains possible only for a host whose native semantics, containment,
and readback have been separately proved; it should be reported explicitly as
source-linked rather than treated as an ordinary copied install.

## Native update and removal proof

The user's intuition is broadly correct: open-source marketplaces often do
ship native update commands. It is not guaranteed by the package format and is
not uniformly safe enough for authoritative sync.

| Current tested host | Native mechanism | Result for plugnz |
| --- | --- | --- |
| Claude Code 2.1.295 | Exact-package `claude plugin update` | Conditionally usable after marketplace snapshot pinning; same-version changed bytes can remain stale, and content readback/rollback are not documented. |
| Codex 0.162.0 | Marketplace `upgrade`; exact-plugin `add` reinstalls | Conditionally usable with a full-SHA marketplace, but upgrade is marketplace-wide, lacks a per-call revision, has partial batch behavior, and emits no JSON on failure. |
| dcode 0.1.83 | Exact-package `plugin install` applies a newer entry from an already-refreshed marketplace or recopies unversioned content; opt-in `auto_update_plugins()` runs after first prompt | **Does not meet the complete contract.** There is no dedicated update command. A versioned reinstall reuses an already-cached declared version; the updater is async, package-opt-in, and version-change-only. Sources are branch/tag based, and neither route provides complete structured readback. |

The normative format leaves distribution and lifecycle to clients. dcode's
public parser has no marketplace-update command, despite the LangChain
marketplace README documenting one. The corrected sandbox replay proved that
same-version re-add retained stale bytes, the opt-in background route advanced
a declared version, explicit opt-out prevented that background advance, and
public exact-package reinstall then applied the newer entry from the already-
refreshed marketplace. The immutable source,
command results, and full
tradeoff analysis are in the
[native capability proof](native-plugin-update-capabilities-2026-10-09.md).

`npx skills` 1.7.1 is useful precedent, but it does not solve authoritative
plugin lifecycle: stable `update` tracks source hashes and re-adds itself;
symlink mode targets a copied canonical store rather than the distribution
source; noninteractive update does not remove deleted skills; and experimental
`sync` is additive with no prune/dry-run contract. The primary-source links and
reproductions are also collected in the native capability proof.

The resulting durable rule is evidence-gated native-first, not
native-at-all-costs: choose the route during preflight from a versioned
capability profile, freeze the exact source snapshot, and use a native
update/remove only when exact scope, content refresh, readback, rollback, and
state retention are proved. For current dcode, native update is not such a
route. Whether to build a Managed route or hard-block it remains an
implementation choice.

## Decisions required before implementation scope is chosen

The behavioral constraints above are settled; these scope and product choices
are not. No item below is implicitly included or excluded:

1. Which workstreams should be implemented in the first tranche: hashed-path
   correctness, structured/loud errors, Addy and other capability delivery,
   authoritative lifecycle, and/or upstream dcode work?
2. Is a package allowed to reach a deliberate **partial component** state—for
   example Addy's 25 skills installed while its commands and agents remain
   loud/red—or must every package-host pair remain atomic?
3. For commands, agents, and invocation policy, which route should be pursued:
   Managed exact projection, experimental dcode extension, upstream native
   primitives, or hard block pending native support?
4. Should desired-but-currently-unsupported pairs be persisted in plugnz state
   so `status` remains red across runs, or should Personal remain the owner of
   desired intent until sync state exists?
5. Should an explicit selected package list be frozen as the complete source
   set, or should newly added source siblings auto-enroll on the next sync?

Those answers determine implementation scope. They do not alter the verified
classification of the six findings.
