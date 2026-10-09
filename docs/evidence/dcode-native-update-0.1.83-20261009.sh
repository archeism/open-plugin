#!/usr/bin/env bash
set -euo pipefail

probe_root=/tmp/dcode-native-update-proof
rm -rf "$probe_root"
mkdir -p "$probe_root/source/plugins/proof-plugin/.claude-plugin"
mkdir -p "$probe_root/source/plugins/proof-plugin/skills/proof-skill"
mkdir -p "$probe_root/web"

write_marketplace() {
  local version="$1"
  local marker="$2"
  local auto_update="${3:-true}"
  cat >"$probe_root/source/.gitignore" <<'EOF'
*.pem
EOF
  mkdir -p "$probe_root/source/.claude-plugin"
  cat >"$probe_root/source/.claude-plugin/marketplace.json" <<'EOF'
{
  "name": "proof-market",
  "owner": {"name": "plugnz proof"},
  "plugins": [
    {
      "name": "proof-plugin",
      "source": "./plugins/proof-plugin",
      "description": "Controlled dcode native update probe"
    }
  ]
}
EOF
  cat >"$probe_root/source/plugins/proof-plugin/.claude-plugin/plugin.json" <<EOF
{
  "name": "proof-plugin",
  "version": "$version",
  "description": "Controlled dcode native update probe",
  "extensions": {
    "com.langchain.deepagents.code": {
      "autoUpdate": $auto_update
    }
  }
}
EOF
  cat >"$probe_root/source/plugins/proof-plugin/skills/proof-skill/SKILL.md" <<EOF
---
name: proof-skill
description: Controlled native update proof
---
$marker
EOF
}

push_source() {
  local message="$1"
  git -C "$probe_root/source" add .
  git -C "$probe_root/source" commit -m "$message" >/dev/null
  git -C "$probe_root/source" push origin main >/dev/null
  git --git-dir="$probe_root/web/repo.git" update-server-info
}

show_state() {
  local label="$1"
  printf '\n=== %s ===\n' "$label"
  "$probe_root/venv/bin/python" - <<'PY'
import json
import os
from pathlib import Path

root = Path(os.environ["HOME"]) / ".deepagents"
installed_file = root / ".state" / "installed_plugins.json"
print("installed_state=", installed_file.read_text() if installed_file.exists() else "<missing>")
for marker in sorted(root.glob("plugins/cache/**/SKILL.md")):
    print(f"marker_path={marker}")
    print(f"marker_body={marker.read_text().splitlines()[-1]}")
PY
}

write_marketplace "0.1.0" "marker-v1"
git -C "$probe_root/source" init -b main >/dev/null
git -C "$probe_root/source" config user.name "plugnz proof"
git -C "$probe_root/source" config user.email "proof@example.invalid"
git -C "$probe_root/source" add .
git -C "$probe_root/source" commit -m "initial" >/dev/null
git clone --bare "$probe_root/source" "$probe_root/web/repo.git" >/dev/null
git -C "$probe_root/source" remote add origin "$probe_root/web/repo.git"
git --git-dir="$probe_root/web/repo.git" update-server-info

openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -keyout "$probe_root/key.pem" -out "$probe_root/cert.pem" \
  -subj '/CN=localhost' >/dev/null 2>&1
cat >"$probe_root/https_server.py" <<'PY'
import http.server
import os
import ssl
import subprocess
from urllib.parse import urlsplit

root = os.environ["PROBE_ROOT"]

class GitHttpHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        self._run_backend()

    def do_POST(self):
        self._run_backend()

    def _run_backend(self):
        parsed = urlsplit(self.path)
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else b""
        env = {
            **os.environ,
            "GIT_PROJECT_ROOT": os.path.join(root, "web"),
            "GIT_HTTP_EXPORT_ALL": "1",
            "REQUEST_METHOD": self.command,
            "PATH_INFO": parsed.path,
            "QUERY_STRING": parsed.query,
            "CONTENT_TYPE": self.headers.get("Content-Type", ""),
            "CONTENT_LENGTH": str(length),
            "REMOTE_ADDR": self.client_address[0],
        }
        result = subprocess.run(
            ["git", "http-backend"], input=body, env=env, capture_output=True
        )
        header_blob, _, response_body = result.stdout.partition(b"\r\n\r\n")
        if not response_body:
            header_blob, _, response_body = result.stdout.partition(b"\n\n")
        status = 200
        headers = []
        for line in header_blob.decode("latin-1").splitlines():
            key, _, value = line.partition(":")
            if key.lower() == "status":
                status = int(value.strip().split()[0])
            elif key:
                headers.append((key.strip(), value.strip()))
        self.send_response(status)
        for key, value in headers:
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(response_body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(response_body)
        self.wfile.flush()
        self.close_connection = True

server = http.server.ThreadingHTTPServer(("127.0.0.1", 8443), GitHttpHandler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(os.path.join(root, "cert.pem"), os.path.join(root, "key.pem"))
server.socket = context.wrap_socket(server.socket, server_side=True)
server.serve_forever()
PY
PROBE_ROOT="$probe_root" python3 "$probe_root/https_server.py" >"$probe_root/server.log" 2>&1 &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT

uv venv --python 3.13 "$probe_root/venv" >/dev/null
uv pip install --quiet --python "$probe_root/venv/bin/python" deepagents-code==0.1.83
export HOME="$probe_root/home"
export GIT_SSL_NO_VERIFY=1
mkdir -p "$HOME"
dcode="$probe_root/venv/bin/dcode"

"$dcode" --version
"$dcode" plugin marketplace add https://localhost:8443/repo.git
"$dcode" plugin install proof-plugin@proof-market
show_state "initial install"

write_marketplace "0.1.0" "marker-v2-same-version"
push_source "same-version content change"
set +e
"$dcode" plugin marketplace update proof-market >"$probe_root/manual-update.out" 2>"$probe_root/manual-update.err"
manual_rc=$?
set -e
printf '\n=== documented manual command ===\n'
printf 'exit=%s\n' "$manual_rc"
sed -n '1,20p' "$probe_root/manual-update.err"

"$dcode" plugin marketplace add https://localhost:8443/repo.git
"$dcode" plugin install proof-plugin@proof-market
show_state "re-add plus reinstall, same version"

"$probe_root/venv/bin/python" - <<'PY'
from deepagents_code.plugins.discovery import auto_update_plugins
print("internal_auto_update_same_version=", auto_update_plugins())
PY
show_state "internal updater, same version"

write_marketplace "0.1.1" "marker-v3-version-bump"
push_source "version bump"
"$probe_root/venv/bin/python" - <<'PY'
from deepagents_code.plugins.discovery import auto_update_plugins
print("internal_auto_update_version_bump=", auto_update_plugins())
PY
show_state "internal updater, version bump"

write_marketplace "0.1.2" "marker-v4-auto-update-false" "false"
push_source "version bump with dcode autoUpdate false"
"$probe_root/venv/bin/python" - <<'PY'
from deepagents_code.plugins.discovery import auto_update_plugins
print("internal_auto_update_opted_out=", auto_update_plugins())
PY
show_state "internal updater, dcode autoUpdate false"

"$dcode" plugin install proof-plugin@proof-market
show_state "public exact-plugin reinstall, dcode autoUpdate false"

printf '\n=== public commands ===\n'
"$dcode" plugin marketplace --help
