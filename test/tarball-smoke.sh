#!/bin/sh
# Tarball smoke: prove the artifact npm actually ships installs and runs the
# lifecycle under plain Node with bun provably absent. Companion to
# node-smoke.sh, which runs the in-tree dist/ bundle; this runs the packed
# tarball through npm install into a clean prefix, exactly what `npx
# plugnz@<version>` executes on a stranger's machine.
set -eu
cd "$(dirname "$0")/.."
NODE_DIR="$(dirname "$(command -v node)")"
STRICT="/usr/bin:/bin:$NODE_DIR"
# npm may be a logging shim on this machine; use nvm's real npm when present.
NPM_BIN="$(command -v npm)"
NVM_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort | tail -1 || true)"
if [ -n "$NVM_BIN" ] && [ -x "$NVM_BIN/npm" ]; then NPM_BIN="$NVM_BIN/npm"; STRICT="/usr/bin:/bin:$NVM_BIN"; fi
if env PATH="$STRICT" sh -c 'command -v bun' >/dev/null 2>&1; then echo "bun on PATH — smoke invalid"; exit 1; fi

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
# Pack into the smoke's temp dir and take the exact filename npm prints —
# a stale sibling tarball must never shadow the fresh one.
PACK_OUTPUT="$("$NPM_BIN" pack --pack-destination "$T" --ignore-scripts 2>/dev/null | tail -1)"
TARBALL="$T/${PACK_OUTPUT##*/}"
test -f "$TARBALL"
env PATH="$STRICT" "$NPM_BIN" install --prefix "$T/prefix" --no-save "$TARBALL" >/dev/null
BIN="$T/prefix/node_modules/.bin/plugnz"
test -x "$BIN"

echo "== shipped files =="
ls "$T/prefix/node_modules/plugnz" | sort | tr '\n' ' '; echo
test -f "$T/prefix/node_modules/plugnz/dist/plugnz.mjs"
test ! -d "$T/prefix/node_modules/plugnz/src"

echo "== version via shebang exec (env-resolved node) =="
EXPECTED="$(env PATH="$STRICT" "$BIN" --version --json)"
echo "$EXPECTED" | grep -q '"name":"plugnz"'

echo "== npx launcher (bun absent) =="
# Real npx, not the .bin path: resolves the installed package's bin through
# npm's launcher under the bun-free PATH.
test "$(cd "$T/prefix" && env PATH="$STRICT" "$NVM_BIN/npx" --no-install plugnz --version --json)" = "$EXPECTED"
echo "ok: npx launcher byte-equal"

echo "== bunx launcher =="
# The bundle must run under Bun's launcher as well, closing the both-ways
# promise (this leg intentionally has bun on PATH).
test "$(cd "$T/prefix" && bunx --no-install plugnz --version --json)" = "$EXPECTED"
echo "ok: bunx launcher byte-equal"

mkdir -p "$T/home/source/plugins/demo/skills/example" "$T/home/.cursor"
printf '{ "name": "demo", "version": "1.0.0", "description": "tarball smoke" }\n' > "$T/home/source/plugins/demo/plugin.json"
printf -- '---\nname: example\ndescription: Tarball smoke skill\n---\nBody.\n' > "$T/home/source/plugins/demo/skills/example/SKILL.md"
printf '{ "name": "smoke", "plugins": [{ "name": "demo", "source": "./plugins/demo" }] }\n' > "$T/home/source/marketplace.json"
export OPEN_PLUGIN_HOME="$T/home"

echo "== lifecycle via installed bin =="
env PATH="$STRICT" "$BIN" add "$T/home/source" --target cursor --json | grep -q '"result": "succeeded"'
env PATH="$STRICT" "$BIN" list --json | grep -q '"id": "demo"'
env PATH="$STRICT" "$BIN" doctor --json | grep -q '✓'
env PATH="$STRICT" "$BIN" remove 'demo@smoke' --json | grep -q '"result": "succeeded"'

echo "== legacy bin alias =="
env PATH="$STRICT" "$T/prefix/node_modules/.bin/plgnz" --version --json | grep -q '"name":"plugnz"'
echo "tarball-smoke: ALL GREEN (npx-installation shape verified)"
