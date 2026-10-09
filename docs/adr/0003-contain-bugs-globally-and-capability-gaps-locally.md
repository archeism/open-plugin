---
id: adr-0003-contain-bugs-globally-and-capability-gaps-locally
type: adr
summary: Block all writes for deterministic plugnz safety failures while allowing independent capability-limited scopes to proceed visibly red.
status: accepted
author:
  harness: codex
  model_family: gpt-5
read_when:
  - changing compatibility preflight, deployment failure, or multi-target outcome behavior
keywords: [preflight, bug, unsupported, unverified, failure, atomicity]
---

# Contain bugs globally and capability gaps locally

A deterministic plugnz bug, corrupt state, invalid input, or ambiguous ownership blocks the entire command before writes. The sole safety-containment exception is a proven-owned Nonconforming activation: plugnz may reversibly disable it while retaining its bytes, then fail; a failed candidate update instead preserves a genuinely conforming Retained activation. A genuine unsupported or unverified package × host capability fails closed for that pair and remains a nonzero, persistently visible outcome with its actionable diagnostic, while independent pairs may proceed; an unexpected runtime failure stops later mutations, reports completed, pending, and unattempted work, and prevents orphan pruning in any scope whose Desired set did not finish successfully.
