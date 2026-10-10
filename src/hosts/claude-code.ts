/**
 * claude-code host reader.
 *
 * Reader only — the writer (add/pin/remove) lives in
 * src/hosts/claude-code-writer.ts so loading a reader never evaluates writer
 * code (AGENTS.md: doctor is read-only by construction).
 *
 * Real store layout (measured 2026-09-16, evidence in docs/hosts/claude-code.md):
 *   ~/.claude/plugins/installed_plugins.json   — {version:2, plugins:{"<name>@<marketplace>":
 *                                                   [{scope, installPath, version, gitCommitSha, …}]}
 *   ~/.claude/plugins/cache/<marketplace>/<name>/<version-or-sha>/  — install dirs
 *   ~/.claude.json                             — user-level top-level `mcpServers`
 *
 * Plugin MCP is declared in `.mcp.json` at the plugin root (the plugins CLI
 * also writes a spec `mcp.json`; both are read, identical entries deduped —
 * spec §7.2.1 fixes the spec path as `mcp.json`).
 */
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { HostReader, InstalledPlugin, McpServerEntry } from '../host';
import { claudeCodeRoot, homeRoot } from '../paths';
import { collectPluginServers, collectUserServers, readJson, type PluginMcpCandidate } from '../mcp';
import { singleInstanceTargetProfile } from '../target-profile';

import { spawnSync as bunShapedSpawnSync } from '../runtime';

export const claudeCodeTargetProfile = singleInstanceTargetProfile('claude-code');

/** Where a plugin copy declares MCP servers (spec `mcp.json`, plus the `npx plugins` `.mcp.json` twin). */
export function mcpCandidates(): PluginMcpCandidate[] {
  return [
    { kind: 'spec', file: '.mcp.json' },
    { kind: 'spec', file: 'mcp.json' },
  ];
}

interface InstallRecordShape {
  scope?: string;
  installPath?: string;
  version?: string;
  gitCommitSha?: string;
}

export function pluginsDir(): string {
  return join(claudeCodeRoot(), 'plugins');
}

const CLAUDE_CODE_VERSION = /^(\d+\.\d+\.\d+) \(Claude Code\)\s*$/u;

export type ClaudeCodeVersionObservation =
  | { readonly kind: 'detected'; readonly version: string; readonly probeId: string }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'unparseable' };

export function observeClaudeCodeVersion(
  env: Record<string, string | undefined> = process.env,
): ClaudeCodeVersionObservation {
  const binary = claudeBinary(env);
  if (binary === undefined || !existsSync(binary)) return { kind: 'unknown' };
  try {
    const result = bunShapedSpawnSync([binary, '--version'], { stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
    if (result.exitCode !== 0) return { kind: 'unparseable' };
    const stdout = [...result.stdout].map((byte) => String.fromCharCode(byte)).join('');
    const version = CLAUDE_CODE_VERSION.exec(stdout)?.[1];
    if (version === undefined) return { kind: 'unparseable' };
    return { kind: 'detected', version, probeId: `claude-code-cli-${version}` };
  } catch {
    return { kind: 'unknown' };
  }
}

function claudeBinary(env: Record<string, string | undefined>): string | undefined {
  const explicit = env['OPEN_PLUGIN_CLAUDE_CODE_BIN'];
  if (explicit !== undefined) return explicit;
  const pathEnv = env['PATH'];
  if (pathEnv === undefined) return undefined;
  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, 'claude');
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

export function hasCurrentClaudeCodeBinary(env: Record<string, string | undefined> = process.env): boolean {
  return observeClaudeCodeVersion(env).kind === 'detected';
}

function userConfigFile(): string {
  // The user-level config is `~/.claude.json` — a sibling of `~/.claude`, so
  // it follows OPEN_PLUGIN_HOME, not the per-host root override.
  return join(homeRoot(), '.claude.json');
}

export const claudeCode: HostReader = {
  id: 'claude-code',
  gui: false,

  detect(): boolean {
    return existsSync(claudeCodeRoot()) || hasCurrentClaudeCodeBinary();
  },

  stores(): string[] {
    return [pluginsDir()];
  },

  listInstalled(): InstalledPlugin[] {
    const file = join(pluginsDir(), 'installed_plugins.json');
    const root = readJson(file);
    if (root === null) return [];
    const plugins = root['plugins'];
    if (typeof plugins !== 'object' || plugins === null || Array.isArray(plugins)) return [];
    const settings = readJson(join(claudeCodeRoot(), 'settings.json'));
    const enabled = settings?.['enabledPlugins'];
    const enabledPlugins = typeof enabled === 'object' && enabled !== null && !Array.isArray(enabled)
      ? enabled as Record<string, unknown> : {};
    const out: InstalledPlugin[] = [];
    for (const [id, value] of Object.entries(plugins as Record<string, unknown>)) {
      const at = id.indexOf('@');
      const name = at === -1 ? id : id.slice(0, at);
      const marketplace = at === -1 ? undefined : id.slice(at + 1);
      if (!Array.isArray(value)) continue;
      for (const raw of value) {
        if (typeof raw !== 'object' || raw === null) continue;
        const rec = raw as InstallRecordShape;
        const version = typeof rec.version === 'string' ? rec.version : undefined;
        const recordedPath = typeof rec.installPath === 'string' ? rec.installPath : undefined;
        // Real records store absolute installPaths; fall back to the computed
        // cache slot so relocated/fixture stores still resolve.
        const fallback =
          marketplace !== undefined && version !== undefined
            ? join(pluginsDir(), 'cache', marketplace, name, version)
            : undefined;
        const path = recordedPath !== undefined && existsSync(recordedPath) ? recordedPath : fallback;
        const sha = typeof rec.gitCommitSha === 'string' ? rec.gitCommitSha : undefined;
        // Native user-scope installs are disabled unless explicitly enabled in settings.
        const plugin: InstalledPlugin = { id, name, enabled: enabledPlugins[id] === true };
        if (marketplace !== undefined) plugin.marketplace = marketplace;
        if (path !== undefined) plugin.path = path;
        if (version !== undefined) plugin.version = version;
        if (sha !== undefined) plugin.sha = sha;
        out.push(plugin);
      }
    }
    return out;
  },

  mcpEntries(): McpServerEntry[] {
    const entries: McpServerEntry[] = [];
    entries.push(...collectUserServers(userConfigFile(), claudeCodeRoot()));
    for (const plugin of this.listInstalled()) {
      if (plugin.path === undefined || !existsSync(plugin.path)) continue;
      entries.push(...collectPluginServers(plugin.id, plugin.path, mcpCandidates()));
    }
    return entries;
  },
};
