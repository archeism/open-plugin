# AGENTS.md · plugnz

`plugnz` installs, diagnoses and updates agent plugins (Agent Plugins / "OpenPlugin" spec 1.0.0) and MCP configs across coding-agent hosts. It is the open-source counterpart of `npx plugins`, plus the verbs that tool lacks: `doctor`, `pin`, `update`.

## Verbs
- `add <source> [--target <host>…]` — install a plugin from a marketplace dir or git URL into each host's **native** store.
- `doctor` — read-only. (1) every configured stdio `command` resolves to an executable; (2) no hand-written entry shadows/duplicates a plugin-provided server of the same name; (3) installs are at the marketplace head. Prints findings, exits non-zero on ✗, never edits.
- `pin [--target <host>…|--all] [--dry-run]` — rewrite a plugin-provided bare `command` to its absolute path for GUI hosts (macOS GUI apps have no shell PATH). Refuses (✗) a command that does not resolve; never touches a host's user-level config.
- `update [name]` — idempotent re-`add` from the recorded `state.json` source; re-materializes copy-based hosts and re-applies recorded pins. Never modifies a plugin with no record — reports it instead.
- `list`, `remove`, `targets`.

## Hosts and approved scope
The current implemented native adapters are claude-code, codex, kimi, cursor, omp, hermes, grok, dcode, and zcode-cli. The approved migration scope is native plugin-compatible routes documented in `SPEC.md`; each additional route requires its own evidence-backed adapter or visible unsupported/unverified result. Standalone skill/command distribution is excluded: Pi and OpenCode readers/removers remain only for safe cleanup of old plugnz-owned installs, and no standalone route may be added or updated. Gemini CLI's possible native extension surface remains unverified and is not classified as standalone. Bare-MCP configuration remains the separate `add-mcp` API boundary.

## Rules
- Bun + TypeScript. Run the relevant focused check for each increment and save its command/result; run `bun test` and `bun run check` before a direct push to `main`. Direct pushes are the authorized integration path; do not create a PR unless later directed.
- One module per host under `src/hosts/<host>.ts`, all implementing the `Host` interface in `src/host.ts`. No host-specific branches outside its module.
- Tests never touch the real home directory: every path is resolved through `src/paths.ts`, which honours `OPEN_PLUGIN_HOME` (tests point it at a temp dir with fixture stores).
- `doctor` is read-only by construction — it must not import any writer.
- Every spec claim in code or docs cites the section (`spec §7.2.1`). Spec: https://agentplugins.org (Agent Plugins Specification 1.0.0).
- Commit history is an asset: never squash. Work in small verified commits and push directly to `main` when authorized.
- While the package is `0.0.x`, published version changes are patch-only. npm publication and fleet rollout require separate authorization.
- `CLAUDE.md` is a symlink to this file; do not maintain a second copy.
- Research and decisions live in `docs/`; this file is rules only.
