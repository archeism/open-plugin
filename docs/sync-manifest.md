# Batch sync manifest v1

Issue [#35](https://github.com/archeism/plugnz/issues/35) defines authoritative Sync; [#40](https://github.com/archeism/plugnz/issues/40) freezes its batch input contract. `parseSyncManifest` is the pure, non-mutating boundary. CLI file loading and lifecycle execution are separate work.

```json
{
  "schemaVersion": 1,
  "entries": [
    {
      "operation": "sync",
      "source": {
        "kind": "git",
        "locator": "https://example.test/plugins.git",
        "ref": "main"
      },
      "target": {
        "kind": "dcode",
        "instance": "default"
      },
      "selectors": [
        { "package": "addy", "adoptExisting": true },
        { "package": "toolbox" }
      ]
    },
    {
      "operation": "sync",
      "source": { "kind": "local", "locator": "/srv/plugins" },
      "target": {
        "kind": "hermes",
        "instance": "work",
        "context": {
          "root": "/profiles/work/.hermes",
          "configPath": "/profiles/work/.hermes/config.yaml"
        }
      }
    },
    {
      "operation": "retire-source",
      "scopeId": "scope-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "target": { "kind": "hermes", "instance": "old" }
    }
  ]
}
```

All objects are closed: unknown fields and schema versions are rejected. Sources reuse the canonical credential-free `SourceBinding`. Entry order and explicit selector order are preserved.

For `sync`, omitted `selectors` means every package in the frozen Source snapshot. A nonempty selector list is the complete Desired set in that order. `adoptExisting` is per package and defaults to `false`; it only requests later ownership validation. An empty selector list is invalid. After Source freeze, `selectManifestPackages` rejects zero discovered packages, duplicate discovered names, and unknown selectors instead of producing deletion evidence.

`retire-source` is the only empty-Desired representation. It carries a recorded `scope-v1` identifier plus target kind and instance. It cannot carry a Source, selectors, adoption, or adapter context. Execution must load the bounded context already recorded for that scope, so a retirement request cannot retarget it.

Current target context is deliberately closed and uses the same credential-free, stable scalar validator as lifecycle state v2:

| Target | Instance | Sync context |
| --- | --- | --- |
| `claude-code`, `codex`, `kimi`, `cursor`, `omp`, `dcode`, `grok`, `zcode-cli` | exactly `default` | none |
| `hermes` | any nonempty stable identity | canonical absolute `root` and `configPath` |

Adapter context is not part of the canonical Deployment-scope identifier, which remains Source binding × target kind × target instance. Repeating that scope identifier anywhere in one manifest—including `sync` plus `retire-source`, or two entries with different selectors—is a usage/selection failure before Source or host work.

Across different Sources, every repeated target kind/instance must carry byte-equivalent canonical context. A target instance cannot drift between adapter contexts. Each adapter also owns its physical-overlap rule: Hermes treats both canonical `root` and `configPath` as exclusive resources, so two different Hermes instance IDs cannot share either one. These consistency checks do not fold context into the Deployment-scope ID.
