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

A deterministic plugnz bug, corrupt state, invalid input, or ambiguous ownership blocks the entire command before writes. A genuine unsupported or unverified package × host capability remains a nonzero, visibly red outcome without being converted to success or deferral, while independent package × host operations may still proceed.
