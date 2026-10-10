---
id: runtime-agnostic-recipe
type: reference
summary: >-
  The four-part recipe that made plugnz publishable as one plain-JavaScript
  artifact runnable by npx and bunx alike, with the verification gates that
  make it trustworthy. Validated once; a second independent CLI should
  exercise it before any of it hardens into a package.
read_when:
  - porting another Bun CLI to a runtime-agnostic npm artifact
  - changing the runtime bridge, parity harness, or publish workflow shape
keywords: [recipe, npx, bunx, node, bridge, parity, scaffold, migration]
---

# The runtime-agnostic recipe (one reference implementation)

Status: validated on plugnz only. Per review guidance, extract nothing into
package boundaries until a second independent CLI has run this recipe end to
end.

## 1. Build step

`scripts/build.mjs` bundles a dedicated `scripts/cli-entry.ts` with
`bun build --target=node` into `dist/<name>.mjs`, prepends a `node` shebang,
marks it executable. `package.json`: `files: [dist, README, LICENSE]`,
`bin` entries pointing at the bundle, `engines.node >= 22`, `prepublishOnly`
build. The dev tree keeps its Bun shim at `bin/`; only the tarball ships
`dist/`. Source never ships.

## 2. Runtime bridge

One module (`src/runtime.ts`) mirrors the Bun APIs the CLI actually calls —
exact result shapes, exact null-vs-undefined contracts (a `which` returning
`undefined` instead of `null` silently flipped a host detector), spawn
failure settlement for BOTH runtimes' shapes (Node emits async `error`; Bun's
node-compat spawn throws synchronously), explicit `maxBuffer` (Node's 1 MiB
default kills large output), unread pipes ignored. Typecheck without
`@types/*` via a minimal hand-written `globals.d.ts` extended as needed.

## 3. Parity harness (the actual product)

Differential testing against the real Bun until the byte contract is pinned:
a grammar table of probed cases, a golden corpus of every real document the
system generates, and an exhaustive codepoint sweep (BMP). Expect the
harness to find divergences the corpus misses — merge keys, Unicode escapes,
and trim-vs-grammar edge rules were all sweep discoveries. Grammars derived
from an implementation (not a spec) need an explicit version contract: this
writer's grammar is verified under Bun >= 1.4 and the gate fails loudly
elsewhere with re-derivation instructions.

## 4. Proof gates

Bun-free smoke (PATH proof, not assumption), tarball smoke through the real
npm install + actual npx and bunx launchers with byte-equal full documents,
runtime-parity doctor on populated isolated fixture stores, and a CI matrix
(Node 22/24) that owns the minimum-version enforcement.

## Failure modes this recipe already survived

- silently no-op'd patch scripts claiming fixes in commit messages (twice)
- parse-side semantic gaps invisible to byte-parity (merge keys, tagged
  scalars)
- a differential suite passing on one Bun version and failing on another
  (U+2028) — hence the version contract
