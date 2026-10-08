# plugnz

Open-source installer **and doctor** for agent plugins (Agent Plugins / OpenPlugin spec 1.0.0) and MCP configs — Claude Code, Codex, Cursor, Kimi, and more.

```
npx plugnz add <plugin-dir-or-marketplace-or-git-url>  # native plugin stores
npx plugnz doctor                          # dead commands, shadowed entries, stale installs
npx plugnz pin                             # absolute command paths for GUI hosts
npx plugnz update                          # re-add from the recorded source, re-pin
```

`pin` rewrites a plugin's bare stdio `command` to the absolute path it resolves
to right now — a macOS GUI host like Cursor starts with no shell PATH, so a
spec-valid bare `command` never launches there. `update` is an idempotent
re-`add` from the source recorded in `state.json`, plus the pins that install
carried. Both refuse rather than guess, and neither will touch a plugin this
tool did not install. Details: `docs/pin-and-update.md`.

Why another tool: `npx plugins` is closed-source and its Cursor target does not install into Cursor; nothing in the ecosystem checks that an installed plugin still *works*. See `docs/research/`.

The `npx` command requires Node.js/npm and Bun on PATH; the CLI runs under Bun. `add` accepts a local plugin or marketplace directory as well as a Git URL. Native plugin targets currently include Claude Code, Codex, Kimi, Cursor, OMP, Hermes, Grok, DCode, and ZCode CLI. Run `plugnz targets --all` to see supported and unsupported capabilities for each host; standalone skill distribution is outside this CLI's scope.

Published on npm as `plugnz`; source repository: `archeism/plugnz`.

Maintainers: see [publishing instructions](docs/publishing.md) for the manual npm release workflow.
