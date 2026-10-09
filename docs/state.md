# `state.json` lifecycle ledger

The ledger lives at `$OPEN_PLUGIN_HOME/state.json` when that test/isolation
override is set and at `~/.open-plugin/state.json` otherwise. All readers use
`src/state.ts`; all mutation stays in `src/state-write.ts` so `doctor` remains
reader-only by construction.

## Version 2

Version 2 separates desired intent, observed activation, recovery, and retained
history. Its top level is:

```json
{
  "version": 2,
  "stateGeneration": 1,
  "scopes": [],
  "activations": [],
  "attempts": [],
  "tombstones": []
}
```

- A Deployment scope binds one credential-free Source to one target kind and
  stable target instance. It records whether the scope came from a legacy
  import or an authoritative sync, its lifecycle and selector mode, the latest
  validated Desired generation, the last converged generation, its last
  attempt, and known lifecycle timestamps. Its `scope-v1-…` identifier is the
  canonical length-framed hash of Source kind/locator/ref plus target
  kind/instance. Snapshot revision and bounded adapter context are deliberately
  excluded, so an update stays in the same scope while a changed Source binding
  or target instance cannot silently reuse one.
- A Desired generation records the immutable Source revision and fingerprint,
  the complete selected package/native identities, their required capability
  keys, per-package adoption intent, and validation time. An empty Desired
  generation is invalid; ending a scope uses explicit Source retirement.
- An Activation is keyed by scope, package, and native identity. It records the
  Source-relative directory and revision, Source/projected/installed
  fingerprints, lifecycle route and evidence key, ownership proof,
  activation/readback state, pending operation, pins, and known timestamps.
- An Attempt contains command/phase/mutation state and a recovery journal with
  stable operation IDs. Pending Activation entries reference a durable Attempt.
- A tombstone retains only lifecycle proof and history: identities, route and
  evidence, verified ownership/adoption proof, fingerprints, pins, retention
  state, and timestamps. The schema has no field for credentials,
  plugin-created data, or arbitrary host metadata.

Every object is closed: unknown fields, malformed enum values, duplicates, and
broken references fail the complete read. Source locators reject embedded
credentials. Adapter context is restricted to bounded scalar entries and
secret-bearing key names are rejected. Pins and capability keys are sorted and
unique so persisted state is deterministic.

`readLifecycleState()` returns the strict v2 document plus the source file
version. `readState()` remains a temporary compatibility projection for the
existing additive verbs and `doctor`; v2 legacy ownership projects as
`legacy-unverified`, never as owned.

## Ownership and retirement authority

Ownership proof is a closed union:

- `legacy-claim` records only that a v1 row existed. It has no deletion
  authority and can use only the `legacy-unverified` route.
- `created` records a verified plugnz creation proof.
- `adopted` records a verified adoption proof and adoption timestamp.

Only `created` and `adopted` pass `hasRetirementAuthority()`. The planner must
also require an authoritative scope and successful Desired convergence before
retirement; the ownership helper alone is necessary, not sufficient. A
tombstone cannot be constructed from a legacy claim.

## Atomic write contract

`writeLifecycleState()` accepts only an explicit
`{ globalPreflight: "succeeded" }` authorization. It validates the complete
document before creating a same-directory temporary file, requires
`stateGeneration` to advance exactly once, then atomically renames the file.
The first v2 save is generation 1; each later save is the previous generation
plus one. Validation or replacement failure leaves the prior file intact and
removes the temporary file.

The v1 compatibility writer refuses to overwrite a v2 document. This prevents
automatic downgrade while the later lifecycle-executor tickets move additive
commands onto the v2 write path.

## Version 1 import

Version 1 remains strict: malformed JSON, unknown fields, invalid rows,
duplicates, and unsupported versions are errors. A read imports rows in memory
without changing the file:

- rows are grouped into Source × host/default-instance scopes using the same
  canonical scope identity as newly resolved Sources; an explicit remote
  `#ref` is separated from the credential-free repository locator;
- scopes use `legacy-import` authority, have no Desired or last-converged
  generation, and cannot establish omission/prune authority;
- every row becomes a `legacy-claim` Activation with unverified route and
  readback, while preserving its Source revision, safe relative directory,
  fingerprints, pins, and known timestamps;
- legacy `pending: install|remove` becomes an explicit recovery Attempt,
  journal entry, and pending Activation operation.

Dry-run and read-only commands never persist that import. After command-global
preflight succeeds, the caller may advance generation 0 to 1 and atomically
write v2. There is no automatic downgrade to v1.

The legacy fields were `host`, `id`, `source`, `sourceSha`, optional
`installedAt`, `pins`, `fingerprint`, `sourceDir`, `installedFingerprint`,
`ownership`, and `pending`. They remain documented here only for strict import
and transition compatibility.
