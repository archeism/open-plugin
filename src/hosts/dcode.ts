/**
 * Read-only dcode (deepagents-code) plugin store reader.
 *
 * Evidence: deepagents-code 0.1.71 / upstream store.py at 59408ebe.  The
 * supported native state is `<DEEPAGENTS_HOME>/.state/{installed_plugins,
 * plugin_state}.json`; commands and invocation gating are deliberately not
 * inferred from the loader.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { HostReader, InstalledPlugin, McpServerEntry } from '../host';
import { singleInstanceTargetProfile } from '../target-profile';

export const dcodeTargetProfile = singleInstanceTargetProfile('dcode');

export function dcodeRoot(): string {
  const explicit = process.env['OPEN_PLUGIN_DCODE_ROOT'];
  if (explicit && explicit.length > 0) return resolve(explicit);
  const home = process.env['OPEN_PLUGIN_HOME'] || process.env['HOME'] || '.';
  return join(home, '.deepagents');
}

export function dcodeStateDir(): string { return join(dcodeRoot(), '.state'); }
export function dcodeRegistryFile(): string { return join(dcodeStateDir(), 'installed_plugins.json'); }
export function dcodeEnablementFile(): string { return join(dcodeStateDir(), 'plugin_state.json'); }

type Registry = { version: 1 | 2; plugins: Record<string, unknown> };
type Enablement = { version?: number; enabledPlugins: Record<string, boolean> };

function registry(): Registry | null {
  const file = dcodeRegistryFile();
  if (!existsSync(file)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const doc = value as Record<string, unknown>;
    if ((doc.version !== 1 && doc.version !== 2) || typeof doc.plugins !== 'object' || doc.plugins === null || Array.isArray(doc.plugins)) return null;
    return { version: doc.version, plugins: doc.plugins as Record<string, unknown> };
  } catch { return null; }
}

function enablement(): Enablement | null {
  const file = dcodeEnablementFile();
  if (!existsSync(file)) return { enabledPlugins: {} };
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const doc = value as Record<string, unknown>;
    if ((doc.version !== undefined && (!Number.isInteger(doc.version) || (doc.version as number) > 1)) || typeof doc.enabledPlugins !== 'object' || doc.enabledPlugins === null || Array.isArray(doc.enabledPlugins)) return null;
    const entries = doc.enabledPlugins as Record<string, unknown>;
    if (Object.values(entries).some((enabled) => typeof enabled !== 'boolean')) return null;
    return { ...(typeof doc.version === 'number' ? { version: doc.version } : {}), enabledPlugins: entries as Record<string, boolean> };
  } catch { return null; }
}

export const dcode: HostReader = {
  id: 'dcode', gui: false,
  detect: () => existsSync(dcodeRoot()),
  stores: () => [dcodeRoot(), dcodeStateDir()],
  listInstalled(): InstalledPlugin[] {
    const installs = registry(); const enabled = enablement();
    if (installs === null || enabled === null) return [];
    const result: InstalledPlugin[] = [];
    for (const [id, entries] of Object.entries(installs.plugins)) {
      if (!Array.isArray(entries) || entries.length === 0) continue;
      const entry = entries[0];
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
      const row = entry as Record<string, unknown>;
      const path = typeof row.installPath === 'string' ? row.installPath : typeof row.install_path === 'string' ? row.install_path : undefined;
      const at = id.indexOf('@'); const name = at < 0 ? id : id.slice(0, at); const marketplace = at < 0 ? undefined : id.slice(at + 1);
      const plugin: InstalledPlugin = { id, name, ...(marketplace ? { marketplace } : {}), ...(path && existsSync(path) ? { path } : {}), ...(typeof row.version === 'string' ? { version: row.version } : {}), ...(enabled.enabledPlugins[id] === true ? { enabled: true } : { enabled: false }) };
      result.push(plugin);
    }
    return result;
  },
  mcpEntries(): McpServerEntry[] { return []; },
};
