---
id: plugnz-spec
type: spec
summary: >-
  Product boundary, lifecycle contract, migration scope, and verification requirements
  for distributing plugins across native agent-harness stores.
read_when:
  - changing plugnz product scope, CLI behavior, lifecycle, or host migration requirements
keywords: [plugnz, plugins, lifecycle, hosts, migration, verification]
---

# Spec: one plugin distributor — plgnz

Status: approved for the milestone implementation. Source pushes are authorized for verified work; npm publication and fleet rollout remain separately authorized.

Personal prepares the plugins; plgnz distributes them. The same public CLI accepts a GitHub/Git source or a local package/collection, adapts it for the selected harness, installs it, and verifies the installation. Personal calls authoritative `sync` instead of maintaining a second distributor.

## Objective and ownership

Serve plugin authors and users across harnesses; Personal is the first production consumer and dogfood case. Eliminate the observed drift between Personal's richer local deployment and Open Plugin's separate installers.

| Owner | Responsibility |
| --- | --- |
| Personal | Adoption, vendor pins/provenance, house metadata, renaming/namespaces, bundling, target selection, and non-plugin setup (global instructions, indexes, machine configuration). It vendors and may amend upstream skill bytes; those amended canonical bytes and their provenance are its authority. |
| plgnz | Source resolution, harness capability profiles, command/skill conversion, resource packaging, native installation, content refresh, owned cleanup, installation records, and read-only verification. |

Personal must invoke the same public CLI available to other users. Its local bundled tree is a first-class `add` source, not an instruction to fetch a pristine upstream replacement; plgnz must never overwrite Personal's amended bytes or provenance on refresh. No Personal-specific runtime dependency or Addy special case belongs in plgnz. Port verified behavior and tests from Personal, not its entire implementation. Remove migrated Personal installers and harness-specific projections after parity passes; do not retain an active fallback distributor.

## Public interface

Proposed interface (not a claim that every option already exists):

```sh
npx plgnz add owner/repo --target codex
npx plgnz add https://github.com/owner/repo.git --target codex
npx plgnz add ./dist/plugins --target codex --json
npx plgnz add ./dist/plugins --target codex --dry-run --json
npx plgnz sync ./dist/plugins --target codex --dry-run --json
npx plgnz retire-source ./dist/plugins --target codex --dry-run --json
npx plgnz update --target codex --json
npx plgnz list --target codex --json
npx plgnz remove <installed-id> --target codex --json
npx plgnz doctor --target codex --json
```

- `add` accepts a plugin directory, local collection/marketplace, or remote source. Repeating it refreshes selected installations, including changed local bytes without a version/commit bump, but never prunes omissions. `update` refreshes recorded installations and is also non-pruning.
- `sync` authoritatively reconciles the complete package selection for each requested source × target scope. A `--plugin` selection is the complete desired set for those scopes; applied sync retires omitted installations only when plgnz can prove ownership, while `--dry-run` previews the same plan without mutation.
- `retire-source` explicitly ends recorded source × target scopes and removes only ownership-proven installations. It removes deployed code and active registration but preserves plugin-created data and inactive host metadata. An unavailable, malformed, or merely uninvoked source preserves its installations and fails or remains untouched; absence is never inferred as retirement.
- Missing sources, zero discovered packages, unknown/absent requested targets, collisions and incompatible conversions cannot report success.
- `--json` emits structured per-package/per-target outcomes and actionable diagnostics; automation uses these plus a nonzero exit status for required failures. A capability-limited pair fails closed and remains visibly red while independent pairs may proceed, but no unsupported or unverified result is reported as success, deferral, or a warning-only deployment. Logs go to stderr. Dry-run must not alter active installs/configuration.
- Personal bundles once, then invokes `sync` with its chosen local source and targets; the pinned CLI version is explicit. Local development can invoke that same CLI from the checkout without an npm release. Remote refresh applies only to a source explicitly supplied as remote.
- Preserve established marketplace/plugin identity during migration so previously installed packages are refreshed, not duplicated. Remove only recorded/verified owned artifacts; never remove unrelated user configuration.

## Compatibility and lifecycle requirements

1. A consumer profile identifies harness, surface/loader, applicable versions, capabilities and evidence. CLI, desktop and ACP are not assumed equivalent. The `zcode-cli` target means the official CLI from [`zai-org/ZCode`](https://github.com/zai-org/ZCode), under `apps/zcode-cli/`. The community `kingsword09/zcode-cli` / `zcode-app-cli` wrapper is not this target. Its earlier probes remain historical evidence and cannot establish official CLI compatibility; official CLI and Desktop still require separate runtime evidence.
2. Accept existing Markdown/TOML prompt commands and skill directories. Preserve explicit invocation restrictions, names, descriptions, supported arguments, sibling references and plugin-owned resources. Commands and user-only skills may map into each other's native form when semantics are equivalent. Ordinary skills retain automatic discovery.
3. Do not substitute prose for unsupported executable handlers, permission semantics or template preprocessing. Report unsupported or unverified requirements before replacing the affected plugin. Never silently strip user-only restrictions or install a partial dependency set as a success. Exact, evidenced projections are allowed; missing runtime primitives should be added upstream rather than approximated.
4. Stage and validate each plugin/target before activation. A failed candidate retains a previously conforming active installation. A proven-owned active installation already known to violate required semantics may be reversibly disabled while its bytes are retained; if safe disablement cannot be proven, preserve it and fail visibly. Runtime mutation failure stops later mutations, and obsolete owned representations are removed only after every desired operation in that scope succeeds. Removal clears deployed code and active registration but preserves plugin-created data and inactive host metadata unless a separate exact-scope purge is explicitly requested. Report partial multi-target outcomes honestly; no global transaction is promised.
5. Resolve and preflight an immutable source snapshot, then prefer a native lifecycle route only when it can activate those exact bytes and expose a synchronous, verifiable result. Managed installations may not update autonomously outside that preflight. A known native limitation may select a proven managed route before writes; an attempted native failure never silently falls back. A later automatic migration to a better native route requires proven semantic equivalence, ownership, verification, rollback, and an explicit plan entry. No simultaneous plugin and standalone skill delivery for the same content. `doctor` remains read-only; it distinguishes installed-content checks from actual runtime conformance evidence.
6. Freeze the migration scope from Personal HEAD `610c4e47cfb7750aa1da4221754eaafb76dc974c` to native plugin-compatible routes: the eleven `PLUGIN_HOSTS` routes (`claude-code`, `codex`, `omp`, `dcode`, `hermes`, `openclaw`, `grok`, `kimi`, `zcode-cli`, `zcode-desktop`, `cursor`) and any verified native Gemini CLI extension route. Every migrated route needs matching lifecycle coverage and an evidence-backed supported/unsupported/unverified result. Unknown is not success. Standalone skill/command distribution is out of scope: `opencode`, `pi`, `factory`, and `grokbot` have no migration obligation, and old plgnz-owned Pi/OpenCode installs may only be read or removed safely. Gemini CLI's native extension possibility remains unverified; it is not treated as a standalone route. Unsupported cases must be visible, never silently weakened; unresolved required native parity blocks removal of that route's existing implementation and completion of this consolidation. This is an OSS harness scope, not an operating-system expansion.

## Structure, stack and style

Bun + TypeScript, existing repository conventions. plgnz's `src/source.ts` and CLI own generic orchestration; `src/hosts/` owns consumer profiles/adapters and native lifecycle behavior; shared conversion logic has no Personal imports. Tests remain under `test/`. Personal retains its house bundler and replaces installation branches with one CLI client in `src/cli/`; its tests stay under `tests/`.

Prefer small explicit interfaces and existing modules; no new daemon, agent framework or mandatory replacement authoring manifest. Example outcome shape to finalize with the CLI contract:

```ts
type InstallOutcome = {
  plugin: string;
  target: string;
  status: 'installed' | 'unchanged' | 'unsupported' | 'unverified' | 'failed';
  diagnostic?: string;
};
```

Before CLI/source/conversion/adapter implementation, inspect the pinned source and command surface of `vercel-labs/skills` and `neon-solutions/add-mcp`, then record an adopt/reject rationale. The current decision is in `docs/research/prior-art-2026-09-22.md`; the frozen worker interface is `docs/implementation-contract.md`. Reuse only a proven fitting surface; do not copy a feature set, add an OS/harness, or make an add-on manifest mandatory. `add-mcp` remains a separate API boundary unless a separately approved contract changes that.

## Verification and completion

### Current milestone priority (owner update, 2026-09-23)

Finish the remaining required migrations in two batches: **OMP + Hermes**, then
**Grok Build + dcode**. Already shipped routes retain their acceptance requirements.
OpenClaw, ZCode Desktop, and Gemini native extension verification are deferred to
[follow-up #27](https://github.com/archeism/plgnz/issues/27); their existing routes
remain until proven replacement parity. This deferral narrows this milestone's
completion gate, not their eventual migration requirements. Standalone exclusions
remain unchanged. Close each shipped issue with its acceptance evidence; close the
milestone only after the required routes and final acceptance issue pass.

Existing plgnz gates: `bun run check` and `bun test`. Personal's full gate: `bun run check`; distinguish pre-existing unrelated failures from regressions.

- Public CLI integration tests use isolated homes, not production agent configuration. Local and Git fixtures traverse the same install pipeline.
- Exercise install → unchanged re-add → changed local content at the same version → representation migration → failed update → removal. Assert active content, ownership and preservation of unrelated configuration.
- Prove command/skill semantics through real loaders/transcripts: ordinary discovery works, user-only entries are excluded from automatic discovery, explicit invocation loads the correct body and arguments, and references/resources resolve. A copied file or plausible model answer alone is insufficient.
- Addy's nine commands and 25 skills are the first real case. Preserve the verified Codex behavior and regression for `tasks/plan.md`; then exercise the remaining claimed harness routes. One harness per worker; cheaper bounded workers, independent review, coordinator acceptance.
- Run `personal deploy` through the plgnz CLI and verify the resulting native installations. Completion requires deleting the replaced Personal distribution implementations, not merely adding an optional call to plgnz.
- Save successful and failed attempts, versions, configuration, transcripts, elapsed time and available usage/resource evidence. Record unknown measurements honestly. Apply RSI only to demonstrated substrate misses; an unchanged operating skill is a valid result.

## Boundaries and naming

Always preserve unrelated working-tree changes and user configuration; commit logical tested increments. Direct push to `main` is authorized for verified work; do not use PR-only or squash workflow. No npm publication, remote repository rename, or fleet rollout is in scope. While the version is `0.0.x`, any published version change is patch-only. Further changes to product scope require review.

Use **plgnz** for public branding, npm package and command. GitHub repository: `archeism/plgnz` (rename approved by Charles). Generic plugin standards remain distinct from our product name.

This document is the shared source of requirements for both repositories; Personal should link to its approved revision rather than maintain a divergent second spec.
