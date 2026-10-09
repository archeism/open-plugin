---
id: plugnz-glossary
type: glossary
summary: >-
  Canonical language for source resolution, authoritative plugin deployment, ownership,
  and host-native lifecycle operations in plugnz.
read_when:
  - designing or changing plugin installation lifecycle behavior
  - discussing sync, ownership, native updates, or orphaned installations
keywords: [source, snapshot, deployment, sync, ownership, orphan, native]
---

# plugnz glossary

Canonical language for distributing plugin packages into agent harnesses.

## Sources and intent

**Source**:
A stable local or remote locator for one plugin package or collection.
_Avoid_: Checkout, snapshot, package directory

**Source snapshot**:
One resolved, immutable revision and byte view of a Source.
_Avoid_: Source, latest

**Deployment scope**:
The pairing of one Source with one target host, governed by one authoritative Desired set.
_Avoid_: Install, target

**Desired set**:
The complete selected package set intended for a Deployment scope at a Source snapshot.
_Avoid_: Filter, discovered packages

**Sync**:
Authoritative reconciliation of a Deployment scope to its Desired set, including retirement of omitted Managed installations.
_Avoid_: Add, update

## Installation authority

**Managed installation**:
An installation for which plugnz has sufficient Ownership proof to modify or retire it.
_Avoid_: Installed plugin, known plugin

**Ownership proof**:
Durable evidence that plugnz has authority over a particular installed representation.
_Avoid_: State row, marker

**Unmanaged installation**:
An observed installation for which plugnz lacks Ownership proof.
_Avoid_: Foreign plugin, orphan

**Orphaned installation**:
A Managed installation omitted from the Desired set established by a successful Sync of the same Deployment scope.
_Avoid_: Missing source, stale install, unmanaged install

## Host lifecycle

**Native lifecycle route**:
A host-provided operation that can activate an exact Source snapshot with its required semantics and expose a verifiable result.
_Avoid_: Native store, native loader, updater command

**Managed materialization**:
Activation performed by plugnz when no capable Native lifecycle route exists for the exact operation.
_Avoid_: Native update, fallback after failure
