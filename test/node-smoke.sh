#!/bin/sh
# node-smoke capability: prove the built bundle honors its contracts under
# plain Node with no Bun on PATH. Legs: version JSON shape, an isolated
# add/list/doctor/remove lifecycle on the copy-based cursor target, Node 22
# via npx, and a no-drift doctor against the real home stores.
set -eu
cd "$(dirname "$0")/.."
BUNDLE=dist/plugnz.mjs
NODE_BIN="$(command -v node)"
[ -x "$BUNDLE" ] || { echo "missing $BUNDLE — run: bun scripts/build.mjs"; exit 1; }
STRICT_PATH="/usr/bin:/bin:$(dirname "$NODE_BIN")"
if env PATH="$STRICT_PATH" sh -c 'command -v bun' >/dev/null 2>&1; then echo "bun still on PATH — smoke must prove a Bun-free runtime"; exit 1; fi
echo "ok: bun absent from smoke PATH"

echo "== version contract (ambient node, no bun on PATH) =="
env PATH="$STRICT_PATH" node "$BUNDLE" --version --json | grep -q '"name":"plugnz"'
echo "ok: ambient $("$NODE_BIN" --version), identity byte-stable"

echo "== version contract (node@22 via npx) =="
# Node 22 is mandatory somewhere: this leg runs it when a local v22 exists
# (nvm), and the node-compat workflow always runs this script under Node 22.
# CI must never take the absent branch.
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
NODE22=""
for candidate in "$HOME"/.nvm/versions/node/v22*/bin/node; do
  [ -x "$candidate" ] && NODE22="$candidate"
done
if [ "$NODE_MAJOR" = "22" ]; then
  echo "ok: ambient Node 22 job — the version-contract leg above already proved v22"
elif [ -n "$NODE22" ]; then
  env PATH="/usr/bin:/bin:$(dirname "$NODE22")" "$NODE22" "$BUNDLE" --version --json | grep -q '"name":"plugnz"'
  echo "ok: $("$NODE22" --version) identity byte-stable (bun-free PATH)"
elif [ "${REQUIRE_LOCAL_22:-}" = "true" ]; then
  echo "this job requires an on-path Node 22 and none was found"; exit 1
else
  echo "note: no local node@22; enforcement lives in the node-compat workflow's 22 leg (REQUIRE_LOCAL_22)"
fi

echo "== isolated lifecycle under plain node (cursor target) =="
SMOKE_HOME="$(mktemp -d)"
trap 'rm -rf "$SMOKE_HOME"' EXIT
mkdir -p "$SMOKE_HOME/source/plugins/demo/skills/example"
printf '{ "name": "demo", "version": "1.0.0", "description": "smoke fixture" }\n' > "$SMOKE_HOME/source/plugins/demo/plugin.json"
printf -- '---\nname: example\ndescription: Smoke fixture skill\n---\nBody.\n' > "$SMOKE_HOME/source/plugins/demo/skills/example/SKILL.md"
printf '{ "name": "smoke", "plugins": [{ "name": "demo", "source": "./plugins/demo" }] }\n' > "$SMOKE_HOME/source/marketplace.json"
# Cursor detection is directory-based; an empty store dir makes the target
# present with no external binaries — exactly the plain-Node constraint.
mkdir -p "$SMOKE_HOME/.cursor"
export OPEN_PLUGIN_HOME="$SMOKE_HOME"
env PATH="$STRICT_PATH" node "$BUNDLE" add "$SMOKE_HOME/source" --target cursor --json | grep -q '"result": "succeeded"'
env PATH="$STRICT_PATH" node "$BUNDLE" list --json | grep -q '"id": "demo"'
env PATH="$STRICT_PATH" node "$BUNDLE" doctor --json | grep -q '✓'
env PATH="$STRICT_PATH" node "$BUNDLE" remove 'demo@smoke' --json | grep -q '"result": "succeeded"'
echo "ok: add/list/doctor/remove lifecycle green under plain node"

echo "== runtime parity doctor against the real home stores =="
unset OPEN_PLUGIN_HOME
# Absolute finding counts belong to the fleet's state, not to the artifact:
# the gate is that the Node bundle and the Bun dev CLI report the IDENTICAL
# finding set (order-insensitive) on the same stores.
BUN_JSON="$(bun bin/plugnz.mjs doctor --json 2>/dev/null || true)"
NODE_JSON="$(PATH="$PATH" node "$BUNDLE" doctor --json 2>/dev/null || true)"
[ -n "$NODE_JSON" ] || { echo "doctor produced no output on real stores"; exit 1; }
# Whole-document comparison with finding arrays order-normalized: a field
# change (host, mark, pluginId) must fail the gate, not just message text.
printf '%s' "$BUN_JSON" > /tmp/doctor-bun.json
printf '%s' "$NODE_JSON" > /tmp/doctor-node.json
if node <<'NODE'
const fs = require("node:fs");
const normalize = (doc) => { const value = JSON.parse(doc); const entries = Array.isArray(value) ? [value] : Object.values(value).filter(Array.isArray); for (const entry of entries) entry.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))); return JSON.stringify(value); };
process.exit(normalize(fs.readFileSync("/tmp/doctor-bun.json", "utf8")) === normalize(fs.readFileSync("/tmp/doctor-node.json", "utf8")) ? 0 : 1);
NODE
then
  echo "ok: doctor documents identical (order-normalized) between bun and node artifacts ($(printf '%s' "$NODE_JSON" | grep -c '✗' || true) pre-existing stale findings, unchanged by the artifact)"
else
  echo "runtime parity failed: bun and node doctor documents differ"; exit 1
fi
rm -f /tmp/doctor-bun.json /tmp/doctor-node.json
echo "node-smoke: ALL GREEN"
