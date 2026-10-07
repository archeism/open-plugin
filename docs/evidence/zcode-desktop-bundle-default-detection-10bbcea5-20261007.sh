#!/bin/sh
# Evidence: the ZCode desktop app's bundled CLI is an official CLI.
# Probed live on darwin/arm64, ZCode.app 3.14.4 (build 10bbcea5), CLI 0.16.9.
set -u
BUNDLE=/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs
echo "== direct exec (node shebang) =="
"$BUNDLE" --version
echo "== official identity =="
"$BUNDLE" doctor --json
echo "== storage root the CLI serves =="
ls -d "$HOME/.zcode/cli/plugins" 2>/dev/null || echo "no plugins store yet"
echo "== plgnz default detection (no OPEN_PLUGIN_ZCODE_CLI_BIN) =="
unset OPEN_PLUGIN_ZCODE_CLI_BIN
cd "$(dirname "$0")/../.." && bun -e 'import("./src/hosts/zcode-cli.ts").then((m) => console.log("resolved:", m.resolveOfficialZcodeCli(), "detect:", m.zcodeCli.detect()))'
