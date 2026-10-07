# zcode-desktop-bundle-default-detection — 2026-10-07

Probe: `zcode-desktop-bundle-default-detection-10bbcea5-20261007.sh`
(raw: `.raw.txt`; app build `10bbcea5`, CLI 0.16.9, darwin/arm64)

## Claim

The ZCode desktop app ships the official CLI at
`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs` (and the
user-local `~/Applications/…` equivalent). It satisfies every gate the
`zcode-cli` adapter already applies to an explicit `OPEN_PLUGIN_ZCODE_CLI_BIN`:

- direct exec works (executable, `#!/usr/bin/env node` shebang);
- `--version` prints a bare semver (`0.16.9`);
- `doctor --json` reports `cli.name === "zcode"`, `cli.processName === "zcode-cli"`;
- it serves the same store as the desktop app: `~/.zcode/cli/plugins`.

Therefore the adapter's default candidates now include the desktop bundles on
darwin, so a fresh checkout installs into ZCode with no environment
configuration. An explicit `OPEN_PLUGIN_ZCODE_CLI_BIN` override stays
exclusive (isolated homes and tests never reach a real bundle), and an
`OPEN_PLUGIN_HOME` root never falls through to the system-wide bundle.

## Result (live)

```
resolved: /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs detect: true
```

## Why this is the official CLI and not a community build

ZCode is open source (github.com/zai-org/ZCode, Apache-2.0). The app bundles
the same `apps/zcode-cli` package that ships as the official terminal CLI;
its `plugins` subcommands wrap the same service layer as the desktop
app-server (`apps/zcode-cli/packages/cli/src/plugins-command*.ts`,
`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/plugins.ts`), and the
community `zcode-app-cli` identity is rejected by the existing
`zcode-app-cli` gate either way.

## Tests

`test/zcode-cli-lifecycle.test.ts` › "official ZCode CLI default detection":
override exclusivity, isolated-home bundle detection, no system fallback
under `OPEN_PLUGIN_HOME`.
