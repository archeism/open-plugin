---
id: spec-runtime-agnostic-distribution
type: spec
summary: >-
  Requirements and acceptance criteria for publishing plugnz as a built,
  runtime-agnostic plain-JavaScript artifact so npx and bunx both work, with
  byte-proven YAML parity and unchanged installed content.
read_when:
  - changing the published artifact shape, bin launcher, build/publish pipeline, or Bun-API usage
keywords: [npx, bunx, node, bundle, distribution, yaml-parity, engines]
---

# Spec: runtime-agnostic distribution (npx + bunx)

Status: draft — awaiting approval. Single-PR initiative; npm publication and
fleet rollout remain separately authorized per the root SPEC.md. Complies with
ADR-0001 (authoritative sync), ADR-0004 (retain state on removal).

The root SPEC.md's public interface already promises `npx plgnz add …`;
today's published package cannot honor that promise — it ships raw TypeScript
whose bin shebangs `#!/usr/bin/env bun`. This spec closes that gap.

## Capability map (Phase 0)

| Module id | Responsibility | Depends on |
| --- | --- | --- |
| `yaml-parity` | Golden-corpus harness proving a Node YAML writer emits byte-identical output to `Bun.YAML` across every projection plugnz generates for the house packages; also proves sha256 hex parity (`Bun.CryptoHasher` vs `node:crypto`) | — |
| `runtime-bridge` | Node implementations for all `Bun.*` call sites (38 today: YAML ×18, spawnSync ×7, CryptoHasher ×7, sleep ×3, which ×1, spawn ×1, serve ×1), behind the smallest shims that keep bun tests green | `yaml-parity` |
| `publish-bundle` | `bun build --target=node` build step producing `dist/` plain JS; bin → bundle; `files`, `engines` (node ≥ 22), `prepublishOnly` wiring; trusted-publishing workflow publishes the build, not the source tree | `runtime-bridge` |
| `node-smoke` | Contract smoke under plain Node ≥ 22 and ≥ 24: `--version --json` byte shape, fixture add/doctor/list against isolated stores, fingerprint hex equality vs bun-run installs | `publish-bundle` |

Build order: `yaml-parity` → `runtime-bridge` → `publish-bundle` →
`node-smoke`. The `personal-cutover` follow-up (below) is a separate repo and
PR, not part of this initiative's PR.

## Objective

Any user — stranger or house machine — can run `npx plugnz@<version> add …`
on a machine with **no Bun installed**, and `bunx plugnz@<version>` keeps
working unchanged. House machines stop needing locally built 61 MB binaries
(follow-up PR). Success is: the published artifact is plain JavaScript, the
pin/version contract is byte-stable, and **not one installed byte of plugin
content changes anywhere** (parity proven, not hoped).

## Tech stack

- Runtime target: plain-JavaScript ESM bundle; engines `node >= 22`.
- Build tool: `bun build --target=node` (proven this session: produced a
  working 0.39 MB Node bundle from this exact source tree, zero new deps).
- Dev/test stack unchanged: Bun, `bun test`, existing toolchain.
- The YAML library is chosen by the `yaml-parity` harness: whichever of the
  candidate Node writers achieves byte parity wins; if none can, the
  initiative halts at the gate and returns for a re-decision (content
  migration is explicitly out of scope for this PR).

## Commands

```sh
bun install                                  # dev deps
bun test                                     # full suite (must stay green)
bun run check                                # tsc --noEmit
bun run build                                # NEW: dist/plugnz.mjs via --target=node
node dist/plugnz.mjs --version --json        # contract smoke (no bun on PATH)
npm pack --dry-run --ignore-scripts          # artifact shape inspection
bash test/node-smoke.sh                      # NEW: Node 22/24 fixture install + doctor
```

## Project structure

```text
src/                  # unchanged layout; Bun.* call sites gain node-safe equivalents
scripts/build.mjs     # thin wrapper pinning bun build flags
test/parity/          # golden-corpus YAML + hash parity harness
test/node-smoke.sh    # plain-Node contract smoke (uses system node, no bun)
dist/                 # build output only — gitignored, never committed
docs/specs/           # this spec; capability map is the index for module work
```

## Code style

Follows the existing repo style — dense single-purpose modules, comment lines
stating the invariant, no new abstraction layers. Bridge shape:

```ts
// One seam, not a dozen: everything the bundle needs from the host runtime.
export const shasumHex = (input: string): string =>
  createHash("sha256").update(input).digest("hex");
```

No `Bun.*` reference may survive in any module reachable from the bundle
entry; `declare const Bun` shims are deleted, not silenced.

## Testing strategy

- `bun test` stays the suite of record; tests are not migrated.
- `test/parity/` generates every projection for the nine house packages under
  both implementations and diffs bytes; zero diffs is the gate.
- `test/node-smoke.sh` runs add/doctor/list against isolated fixture stores
  under Node 22 and 24 with no Bun on PATH, and asserts `--version --json`
  output is byte-identical to the bun-run output.
- Fingerprints: identical hex for identical trees across both runtimes.

## Boundaries

- **Always**: parity harness + full suite green before every push; ordered
  commits, one per module id; PR description traces to this spec; keep the
  dual `plgnz`/`plugnz` bin alias.
- **Ask first**: any change that alters generated-content bytes; adding any
  runtime dependency; touching CI beyond the publish workflow; landing while
  a milestone integration branch is mid-flight (coordinate first).
- **Never**: squash commits; commit `dist/`; weaken the `--version --json`
  contract; delete or skip tests; special-case any house package in plugnz.

## Success criteria

1. `npx plugnz@<version> --version --json` succeeds on a machine with no Bun
   (CI or container proof), printing the byte-identical JSON personal's pin
   check parses.
2. `bunx plugnz@<version>` behaves identically (same suite, same smoke).
3. Parity harness: zero byte diffs across all projections, all nine house
   packages; sha256 hex parity asserted.
4. The Node bundle and the Bun dev CLI report **identical doctor finding
   sets** (order-insensitive) against the real home stores — the artifact
   contributes zero new drift. (Amended during implementation: absolute
   finding counts track fleet state and the current milestone's doctor
   semantics — 121 pre-existing stale findings under both runtimes — not the
   distribution artifact. test/node-smoke.sh enforces the set-equality gate.)
5. Published tarball contains `dist/` (not `src/`), `engines.node >= 22`,
   and the dual bin entries.
6. `bun test` and `bun run check` green; repo's own `tsc` untouched.

## Follow-up (separate repo, separate PR — archeism/personal)

`personal-cutover`: resolve the plugnz tool as `bunx plugnz@<PLGNZ_VERSION>`
(the `PlgnzTool.args` seam already exists), retire the local hash-dir binary
convention and its pruning burden. Acceptance: personal deploy/status fully
green on this Mac with `~/.local/bin/plugnz` removed; version-pin mismatch
still fails loudly. Explicitly out of scope here.

## Open questions

- None blocking. Library choice inside `yaml-parity` is decided by the
  harness, not by preference. Milestone-interference sequencing is a
  coordination note in the PR, not a spec unknown.
