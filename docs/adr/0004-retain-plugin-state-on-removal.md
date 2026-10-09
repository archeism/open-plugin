---
id: adr-0004-retain-plugin-state-on-removal
type: adr
summary: Preserve plugin-created data and inactive host metadata when removing deployed plugin code.
status: accepted
author:
  harness: codex
  model_family: gpt-5
read_when:
  - changing remove, orphan retirement, source retirement, or plugin-data cleanup behavior
keywords: [remove, retire, data, metadata, purge, recovery]
---

# Retain plugin state when removing deployed code

`sync`, `remove`, and `retire-source` remove ownership-proven deployed code and the active registry or enablement records required to stop the host from loading it, but preserve plugin-created data and inactive host metadata by default. Deleting that retained state requires a separate, explicit, exact-scope purge operation.
