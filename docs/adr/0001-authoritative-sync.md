---
id: adr-0001-authoritative-sync
type: adr
summary: Keep add and update non-pruning while sync authoritatively reconciles one source and target host.
status: accepted
author:
  harness: codex
  model_family: gpt-5
read_when:
  - changing add, update, sync, selection, or orphan-removal semantics
keywords: [sync, add, update, desired-set, orphan, lifecycle]
---

# Keep add additive and make sync authoritative

`add` and `update` remain non-pruning operations. `sync` treats the complete package selection for each requested Source × target host as authoritative, automatically retires omitted installations only when plugnz can prove ownership, and offers `--dry-run` as the non-mutating preview; a `--plugin` selection is therefore the complete Desired set for those requested scopes rather than a one-package touch operation. Explicit adoption grants full future lifecycle authority, while ending an entire scope requires `retire-source`; an unavailable, malformed, or simply uninvoked Source is never deletion evidence.
