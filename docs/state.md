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
  Generation numbers are positive safe integers.
- An Activation is keyed by scope, package, and native identity. It records the
  canonical Source-relative directory and revision, Source/projected/installed
  fingerprints, lifecycle route and evidence key, ownership proof,
  activation/readback state, pending operation, pins, and known timestamps.
- An Attempt contains command/phase/mutation state and a recovery journal with
  stable operation IDs. A scope's last Attempt must include that scope. A
  pending Activation's Attempt must include its scope and exactly one journal
  entry for the same package and native identity. Pending operations use the
  same mutating action vocabulary as the journal: `install`, `update`,
  `route-migrate`, `disable-nonconforming`, `retire-orphan`, or `remove`.
- A tombstone retains only lifecycle proof and history: identities, route and
  evidence, verified ownership/adoption proof, fingerprints, pins, retention
  state, and timestamps. The schema has no field for credentials,
  plugin-created data, or arbitrary host metadata.

Every object is closed: unknown fields, malformed enum values, duplicates, and
broken references fail the complete read. Source locators reject embedded
credentials. Adapter context is restricted to bounded scalar entries and
secret-bearing key names are rejected. Pins and capability keys are sorted and
unique so persisted state is deterministic. Source-relative directories use
`/`, contain no empty, `.` or `..` segments, and use `.` alone for the Source
root.

Canonical remote Source bindings use HTTP(S), SSH, Git protocol, or the exact
SCP-style `git@host:path` form. URL locators contain no password, query, or
fragment, and remote locators contain no percent signs or escapes because Git
can decode them into a different transport identity after validation. HTTP(S)
and Git protocol locators contain no userinfo; SSH may retain a username
because it identifies the transport account, but never a password. SCP-style
locators are control- and whitespace-free, use the literal `git` username, and
keep query/fragment-like suffixes out of the locator because the ref is a
separate field. Public Source parsing may remove HTTP(S) userinfo into the
ephemeral fetch locator; it preserves every other transport byte for canonical
validation, and rejects queries for every transport rather than erasing them.
Git refs use the same canonical grammar at public Source parsing and
durable-state boundaries; `HEAD` is the explicit sentinel, components obey
Git's branch ref rules, and `#` is forbidden because the transition projection
encodes a binding as `locator#ref`. Every Source and target identity string is
well-formed UTF-16 before it is framed for hashing, so lone surrogates cannot
collapse to U+FFFD and alias another Deployment scope.

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

Verified routes use a closed `capability-profile` evidence reference. Verified
ownership uses a closed `managed-marker` or `native-record` proof reference.
Each reference key is exactly `sha256:` plus 64 lowercase hexadecimal
characters. Producers hash credential-free canonical evidence or proof
material before constructing state; raw host values, credentials, URLs, and
arbitrary metadata are never persisted. The same constraint applies to active
records, journals, and tombstones.

Pending recovery is also closed across all three records:

- `accepted` uses journal `pending`, Attempt `accepted`, and
  `mutationStarted: false`;
- `applying` uses journal `applying` and `mutationStarted: true`. Desired
  mutations (`install`, `update`, `route-migrate`, and
  `disable-nonconforming`) require Attempt `applying`; retirement mutations
  (`retire-orphan` and `remove`) require Attempt `pruning`;
- `readback` uses journal `applied` and `mutationStarted: true`. Desired
  mutations require Attempt `readback`; retirement mutations remain in
  Attempt `pruning`;
- `cleanup` uses journal `cleanup-pending`, Attempt `finalizing`, and
  `mutationStarted: true`;
- `rollback` uses journal `rollback`, Attempt `recovery-required`, and
  `mutationStarted: true`.

The pending operation must equal the matching journal action. Terminal and
non-mutating journal states cannot remain pending. Cleanup is a phase, explicit
adoption is ownership proof within `route-migrate`, and reversible safety
containment is the explicit `disable-nonconforming` mutation.

Attempt commands also close the journal vocabulary. `sync` permits every plan
action except manual `remove`; `retire-source` permits only `retire-orphan`;
`add` and `update` permit Desired actions plus `unchanged` and `retain-prior`,
but no retirement or manual removal; `remove` permits only `remove`.
`legacy-recovery` can represent any imported journal action.

Journal states that prove mutation began (`applying`, `applied`,
`readback-verified`, `rollback`, `rolled-back`, `cleanup-pending`, `completed`,
or `failed`) require `mutationStarted: true`, and `true` requires at least one
such row. A completed no-op Attempt containing only `unchanged`,
`retain-prior`, or `not-attempted` work can remain false.

Only `created` and `adopted` pass `hasRetirementAuthority()`. The planner must
also require an authoritative scope and successful Desired convergence before
retirement; the ownership helper alone is necessary, not sufficient. A
tombstone cannot be constructed from a legacy claim.

## Atomic write contract

`writeLifecycleState()` accepts only an explicit
`{ globalPreflight: "succeeded" }` authorization. It validates the complete
document before creating a same-directory temporary file, requires
`stateGeneration` to advance exactly once, then atomically renames the file.
Every persisted generation is a positive safe integer. The first v2 save is
generation 1; each later save is the previous generation plus one, and the
maximum safe integer cannot advance. Validation or replacement failure leaves
the prior file intact and removes the temporary file.

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
  journal entry, and matching pending Activation operation. The imported tuple
  conservatively uses pending/journal `applying` with
  `mutationStarted: true`; its Attempt is `applying` for install and `pruning`
  for remove, because v1 proves intent was persisted before a mutation but
  cannot prove where interruption occurred.

Dry-run and read-only commands never persist that import. After command-global
preflight succeeds, the caller may advance generation 0 to 1 and atomically
write v2. There is no automatic downgrade to v1.

The legacy fields were `host`, `id`, `source`, `sourceSha`, optional
`installedAt`, `pins`, `fingerprint`, `sourceDir`, `installedFingerprint`,
`ownership`, and `pending`. They remain documented here only for strict import
and transition compatibility. A present `installedAt` must be the canonical
UTC timestamp emitted by v1 writers; it is preserved in imported Activation
and recovery history, while malformed legacy timestamps are rejected instead
of silently discarded.
