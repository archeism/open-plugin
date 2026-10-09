---
id: adr-0002-preflight-before-native-activation
type: adr
summary: Resolve and validate exact source bytes before preferring a verifiable host-native activation route.
status: accepted
author:
  harness: codex
  model_family: gpt-5
read_when:
  - adding or changing remote update and host-native lifecycle behavior
keywords: [native, update, source-snapshot, preflight, verification, fallback]
---

# Preflight exact snapshots before native activation

plugnz resolves and validates the exact Source snapshot before mutation, then prefers a Native lifecycle route only when it can consume those exact bytes and return a synchronous, verifiable result. A known native capability gap may select Managed materialization before writes begin, but a native route that has already been attempted may not silently fall back after failure or incorrect readback.
