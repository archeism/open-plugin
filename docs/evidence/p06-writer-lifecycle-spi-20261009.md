# P06 writer lifecycle SPI checkpoint · 2026-10-09

## Frozen scope

- Integration base: `25a4445aedc0e5f11bbf6a0ce36dca036672e34c`.
- Reviewed code checkpoint: `c6f831ed311f7c4972ce7d2c93c026998f46e18a`.
- Issues: [#42](https://github.com/archeism/plugnz/issues/42), bounded hook-inventory repair from [#41](https://github.com/archeism/plugnz/issues/41).
- This checkpoint defines and tests the writer-side lifecycle contract and a fake reference adapter. It does not register a production lifecycle adapter, replace the legacy CLI executor, publish a package, or roll anything out.

## Delivered contract

- Frozen operation/attempt identity, Source snapshot, directives, pins, target observation, native mutation scope, and ownership-proven plan coverage.
- Live version and inventory observations before route selection, plus CAS revalidation before the first mutation.
- Pure profile-backed Managed/Native route selection; absent planned creates are explicit, and collateral Native mutations must be owned, in-plan, mutating group members.
- Zero-active/store/state prepare, sealed staged artifact fingerprint, single grouped Native invocation leader, independent exact readback, and no post-mutation fallback.
- Durable, resumable rollback/disable/retire/cleanup handles with exact identity, action, enum, retention, and affected-operation validation.
- Reload/restart observation remains distinct from byte/readback conformance.
- `doctor` remains read-only by import-boundary tests and cannot import lifecycle writers or Source resolution.

## Hook inventory correction

- Scripts and documentation merely located under `hooks/` are resources, not active hooks. The real Addy source therefore inventories zero hooks and nine hook resources; no hook activation was authored.
- Hook inventory follows validated default or manifest declarations and retains manifest/form plus structured event, matcher, handler, and narrow option facts.
- Dcode 0.1.83 admission follows its actual manifest precedence, directory-or-file resolution, event/handler schema, matcher behavior, and synchronous command-handler constraints. Proven native rejection or masking is `capability.unsupported` with a concrete diagnostic. The Python-regex matcher surface remains `capability.unverified` rather than guessed.
- Primary source anchors: [manifest discovery](https://github.com/langchain-ai/deepagents/blob/caaa7e7c12d214afa5cf0a1afed8eb6232aa6f7b/libs/code/deepagents_code/plugins/manifest.py#L325-L336), [command handler schema](https://github.com/langchain-ai/deepagents/blob/caaa7e7c12d214afa5cf0a1afed8eb6232aa6f7b/libs/code/deepagents_code/hooks/models/config.py#L20-L59), and [matcher compilation](https://github.com/langchain-ai/deepagents/blob/caaa7e7c12d214afa5cf0a1afed8eb6232aa6f7b/libs/code/deepagents_code/hooks/snapshot.py#L114-L146).

## Verification

Focused contract command:

```sh
bun test test/semantic-inventory.test.ts test/dcode-lifecycle.test.ts test/lifecycle-host.test.ts test/lifecycle-route-contract.test.ts test/lifecycle-mutation-contract.test.ts test/doctor-imports.test.ts
```

Final focused result: `64 pass, 0 fail, 425 assertions`. `bun run check` and `git diff --check` also pass.

Full candidate at `c6f831e`:

```text
445 pass, 2 skip, 9 fail, 2392 assertions; 456 tests across 40 files
```

Fresh detached integration base at `25a4445`:

```text
420 pass, 2 skip, 9 fail, 2190 assertions; 431 tests across 37 files
```

The candidate adds 25 passing tests and no new full-suite failure. Both trees have the same nine pre-existing environment/platform failures:

1. Five `remove` cases (`claude-code`, `codex`, `kimi`, `cursor`, `omp`).
2. `add > actual CLI ignores absent unverified adapters and fails cleanly when no writer target is detected`.
3. `codex lifecycle > keeps the new active slot when cleanup of an older owned version fails`.
4. Two official ZCode CLI default-detection cases on this Linux runner.

Independent P06 Spec review passed the durable identity/action, immutable Git revision, retention, transition, and recovery boundaries. Independent Standards review passed the lifecycle/import contract. A separate hook-contract review drove and rechecked the source-fidelity, actionable-diagnostic, and unsupported-versus-unverified repairs.

## Deliberately deferred

- P07+ owns the real planner/executor/state integration, operation-ID generation, group journaling, and production adapter registration. This checkpoint makes those flows expressible; it does not claim they are wired.
- Native host update commands remain eligible only after a host/version adapter proves exact frozen-source and projection equivalence plus bounded mutation scope. This SPI does not turn an upstream command into verified support by itself.
- Dcode 0.1.83 still has proven native limitations for commands, agents, and non-default invocation policy. Addy and the other blocked packages are not silently projected or delivered by this checkpoint.
- No npm publication, fleet rollout, issue closure, real-home write, or Personal deployment occurred.
