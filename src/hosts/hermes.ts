/**
 * Hermes portable Agent Plugin reader.
 *
 * Evidence: Hermes Agent `c0d7294769`, `hermes_cli/plugins_cmd.py` accepts a
 * root `plugin.json` under `$HERMES_HOME/plugins`; portable packages are active
 * only when their native name is in `plugins.enabled` and absent from
 * `plugins.disabled`.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { HostReader, InstalledPlugin, McpServerEntry } from '../host';
import { hermesRoot } from '../paths';
import { collectPluginServers } from '../mcp';
import { hermesCommandCompanionId } from '../hermes-identity';
import { parsePersistedTargetIdentity, type PersistedTargetIdentity } from '../target-identity';
import {
  canonicalProfileContext,
  invalidTargetArgument,
  invalidTargetSelection,
  type TargetProfile,
} from '../target-profile';

import { yamlParse, yamlStringify } from '../yaml';


export const hermesTargetProfile: TargetProfile<'hermes'> = {
  kind: 'hermes',
  parseSyncTarget(value, label) {
    const target = parseHermesIdentity(value, label);
    if (target.context === undefined) invalidTargetArgument(`${label} hermes requires target context`);
    const unknown = Object.keys(target.context).find(key => key !== 'root' && key !== 'configPath');
    if (unknown !== undefined) invalidTargetArgument(`${label} hermes context has unsupported field '${unknown}'`);
    const root = canonicalAbsolutePath(target.context['root'], `${label} context root`);
    const configPath = canonicalAbsolutePath(target.context['configPath'], `${label} context configPath`);
    return { kind: 'hermes', instance: target.instance, context: { configPath, root } };
  },
  parseRetirementTarget(value, label) {
    const target = parseHermesIdentity(value, label);
    if (target.context !== undefined) invalidTargetArgument(`${label} hermes retirement target must not contain context`);
    return { kind: 'hermes', instance: target.instance };
  },
  canonicalContext: canonicalProfileContext,
  physicalKey(target) {
    return hermesPhysicalKey(target);
  },
  overlaps(left, right) {
    const leftContext = hermesContext(left);
    const rightContext = hermesContext(right);
    return leftContext.root === rightContext.root || leftContext.configPath === rightContext.configPath;
  },
};

export function hermesPluginsDir(): string { return join(hermesRoot(), 'plugins'); }

export function hermesInstanceIdentity(target: PersistedTargetIdentity): { readonly root: string; readonly configPath: string } {
  if (target.kind !== 'hermes') invalidTargetSelection('hermes instance kind must be hermes');
  const unknown = Object.keys(target.context ?? {}).find(key => key !== 'root' && key !== 'configPath');
  if (unknown !== undefined) invalidTargetArgument(`hermes instance context has unsupported field '${unknown}'`);
  const context = hermesContext(target);
  return {
    root: canonicalAbsolutePath(context.root, 'hermes instance root'),
    configPath: canonicalAbsolutePath(context.configPath, 'hermes instance configPath'),
  };
}

/** Plugin store for one manifest target. The process Hermes root is not a key. */
export function hermesInstancePluginsDir(target: PersistedTargetIdentity): string {
  return join(hermesInstanceIdentity(target).root, 'plugins');
}

export function listHermesInstance(root: string, configPath: string): InstalledPlugin[] {
  const plugins = join(root, 'plugins');
  if (!existsSync(plugins)) return [];
  const enabled = namesAt(configPath, 'enabled');
  const disabled = namesAt(configPath, 'disabled');
  const result: InstalledPlugin[] = [];
  for (const entry of readdirSync(plugins).sort()) {
    if (entry.startsWith('.')) continue;
    const dir = join(plugins, entry);
    if (lstatSync(dir).isSymbolicLink() || !statSync(dir).isDirectory()) continue;
    const manifest = readManifest(dir);
    if (manifest === undefined) continue;
    const id = ownedId(dir, manifest.name);
    const at = id.indexOf('@');
    const companion = join(plugins, hermesCommandCompanionId(manifest.name));
    const hasCompanion = existsSync(join(companion, 'plugin.yaml'));
    const companionId = hermesCommandCompanionId(manifest.name);
    const contentRoots: Record<string, string> = hasCompanion ? { package: dir, commands: companion } : { package: dir };
    const active = enabled.has(manifest.name) && !disabled.has(manifest.name) && (!hasCompanion || (enabled.has(companionId) && !disabled.has(companionId)));
    result.push({ id, name: manifest.name, ...(at < 0 ? {} : { marketplace: id.slice(at + 1) }), path: dir, contentRoots, ...(manifest.version ? { version: manifest.version } : {}), enabled: active });
  }
  return result;
}

type Manifest = { name: string; version?: string };

function parseHermesIdentity(value: unknown, label: string): PersistedTargetIdentity {
  const target = parsePersistedTargetIdentity(value, label);
  if (target.kind !== 'hermes') invalidTargetSelection(`${label} kind must be 'hermes'`);
  return target;
}

function canonicalAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value) {
    invalidTargetArgument(`${label} must be a canonical absolute path`);
  }
  return value;
}

function hermesContext(target: PersistedTargetIdentity): { root: string; configPath: string } {
  const root = target.context?.['root'];
  const configPath = target.context?.['configPath'];
  if (typeof root !== 'string' || typeof configPath !== 'string') {
    invalidTargetArgument('canonical hermes target is missing root/configPath context');
  }
  return { root, configPath };
}

function hermesPhysicalKey(target: PersistedTargetIdentity): string {
  const context = hermesContext(target);
  return JSON.stringify([context.root, context.configPath]);
}

function ownedId(dir: string, fallback: string): string {
  const file = join(dir, '.plgnz-install.json');
  if (!existsSync(file)) return fallback;
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
    const id = (value as Record<string, unknown>).pluginId;
    return typeof id === 'string' && (id === fallback || id.startsWith(`${fallback}@`)) ? id : fallback;
  } catch { return fallback; }
}

function readManifest(dir: string): Manifest | undefined {
  const file = join(dir, 'plugin.json');
  if (!existsSync(file) || !statSync(file).isFile()) return undefined;
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record.name !== 'string' || !validId(record.name)) return undefined;
    if (record.version !== undefined && typeof record.version !== 'string') return undefined;
    return { name: record.name, ...(typeof record.version === 'string' ? { version: record.version } : {}) };
  } catch { return undefined; }
}

function namesAt(config: string, key: 'enabled' | 'disabled'): Set<string> {
  if (!existsSync(config)) return new Set();
  try {
    const parsed: unknown = yamlParse(readFileSync(config, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Set();
    const plugins = (parsed as Record<string, unknown>)['plugins'];
    if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return new Set();
    const values = (plugins as Record<string, unknown>)[key];
    return new Set(Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string' && validId(value)) : []);
  } catch { return new Set(); }
}

function validId(value: string): boolean { return /^[a-z0-9][a-z0-9._-]*$/iu.test(value); }

export const hermes: HostReader = {
  id: 'hermes', gui: false,
  detect: () => existsSync(join(hermesRoot(), 'config.yaml')) || existsSync(hermesPluginsDir()),
  stores: () => [hermesRoot(), hermesPluginsDir()],
  listInstalled(): InstalledPlugin[] {
    const root = hermesRoot();
    return listHermesInstance(root, join(root, 'config.yaml'));
  },
  mcpEntries(): McpServerEntry[] {
    return this.listInstalled().flatMap(plugin => plugin.path === undefined ? [] : collectPluginServers(plugin.id, plugin.path, [{ kind: 'spec', file: 'mcp.json' }]));
  },
};
