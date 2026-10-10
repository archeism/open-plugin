/**
 * omp host reader.
 *
 * Reader only — the writer (add/pin/remove) lives in
 * src/hosts/omp-writer.ts so loading a reader never evaluates writer code
 * (AGENTS.md: doctor is read-only by construction).
 *
 * Real store layout (measured 2026-09-16, evidence in docs/hosts/omp.md):
 *   ~/.omp/plugins/installed_plugins.json — claude-code-shaped registry:
 *                                           {version:2, plugins:{"<name>@<marketplace>":
 *                                           [{scope, installPath, version, …}]}
 *   ~/.omp/plugins/cache/plugins/<marketplace>___<name>___<version>/ — install dirs
 *                                           (flat triple-underscore keys, unlike
 *                                           claude-code's nested cache layout)
 *   ~/.omp/plugins/omp-plugins.lock.json  — {plugins:{<name>:{version, enabled, …}}}
 *   ~/.omp/plugins/node_modules/<name>    — symlinks into the cache
 *   ~/.omp/marketplaces.json              — {marketplaces:[{name, sourceType, sourceUri, catalogPath}]}
 *
 * omp is a native plugin host with its own store (AGENTS.md hosts list; ground
 * truth "Correction", 2026-09-16) — never routed through a repo-root
 * `.mcp.json`, which is the Claude Code project convention, not omp's plugin
 * surface. omp has no measured user-level MCP config (no ~/.omp/mcp.json on
 * this machine), so doctor's MCP surface is the installed plugins'
 * mcp.json/.mcp.json alone; the shadow check therefore has no user side to
 * trip on until such a config is verified to exist.
 */
import { existsSync, lstatSync, readdirSync, readlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { HostReader, InstalledPlugin, McpServerEntry } from '../host';
import { ompRoot } from '../paths';
import { singleInstanceTargetProfile } from '../target-profile';

export const ompTargetProfile = singleInstanceTargetProfile('omp');
import { collectPluginServers, readJson, type PluginMcpCandidate } from '../mcp';

export function pluginsDir(): string {
  return join(ompRoot(), 'plugins');
}

/** Where a plugin copy declares MCP servers (spec `mcp.json`, plus the `.mcp.json` twin). */
export function mcpCandidates(): PluginMcpCandidate[] {
  return [
    { kind: 'spec', file: '.mcp.json' },
    { kind: 'spec', file: 'mcp.json' },
  ];
}

/** enabled state from omp-plugins.lock.json, keyed by bare plugin name. */
function lockEnabled(name: string): boolean | undefined {
  const root = readJson(join(pluginsDir(), 'omp-plugins.lock.json'));
  if (root === null) return undefined;
  const plugins = root['plugins'];
  if (typeof plugins !== 'object' || plugins === null || Array.isArray(plugins)) return undefined;
  const entry = (plugins as Record<string, unknown>)[name];
  if (typeof entry !== 'object' || entry === null) return undefined;
  return (entry as Record<string, unknown>)['enabled'] === false ? false : undefined;
}

type ManagedMarker = {
  pluginId: string;
  packageName: string;
};

function managedMarker(path: string): ManagedMarker | null {
  const value = readJson(join(path, '.plgnz-install.json'));
  if (value === null || typeof value['pluginId'] !== 'string' || typeof value['packageName'] !== 'string') return null;
  return { pluginId: value['pluginId'], packageName: value['packageName'] };
}

function managedInstalled(): InstalledPlugin[] {
  const managed = join(pluginsDir(), 'plgnz');
  if (!existsSync(managed)) return [];
  const out: InstalledPlugin[] = [];
  for (const entry of readdirSync(managed).sort()) {
    const path = join(managed, entry);
    if (!lstatSync(path).isDirectory()) continue;
    const marker = managedMarker(path);
    const manifest = readJson(join(path, 'package.json'));
    if (marker === null || manifest === null || manifest['name'] !== marker.packageName) continue;
    const link = join(pluginsDir(), 'node_modules', marker.packageName);
    try {
      if (!lstatSync(link).isSymbolicLink() || resolve(dirname(link), readlinkSync(link)) !== resolve(path)) continue;
    } catch {
      continue;
    }
    const at = marker.pluginId.indexOf('@');
    const name = at === -1 ? marker.pluginId : marker.pluginId.slice(0, at);
    const marketplace = at === -1 ? undefined : marker.pluginId.slice(at + 1);
    const plugin: InstalledPlugin = { id: marker.pluginId, name, path };
    if (marketplace !== undefined) plugin.marketplace = marketplace;
    if (typeof manifest['version'] === 'string') plugin.version = manifest['version'];
    if (lockEnabled(marker.packageName) === false) plugin.enabled = false;
    out.push(plugin);
  }
  return out;
}

export const omp: HostReader = {
  id: 'omp',
  gui: false,

  /** omp is present iff its native store is — a stray repo .mcp.json must not conjure the host. */
  detect(): boolean {
    return existsSync(pluginsDir());
  },

  stores(): string[] {
    return [pluginsDir()];
  },

  listInstalled(): InstalledPlugin[] {
    const managed = managedInstalled();
    const managedIds = new Set(managed.map(plugin => plugin.id));
    const root = readJson(join(pluginsDir(), 'installed_plugins.json'));
    if (root === null) return managed;
    const plugins = root['plugins'];
    if (typeof plugins !== 'object' || plugins === null || Array.isArray(plugins)) return managed;
    const out: InstalledPlugin[] = [...managed];
    for (const [id, value] of Object.entries(plugins as Record<string, unknown>)) {
      if (managedIds.has(id)) continue;
      const at = id.indexOf('@');
      const name = at === -1 ? id : id.slice(0, at);
      const marketplace = at === -1 ? undefined : id.slice(at + 1);
      if (!Array.isArray(value)) continue;
      for (const raw of value) {
        if (typeof raw !== 'object' || raw === null) continue;
        const rec = raw as Record<string, unknown>;
        const version = typeof rec['version'] === 'string' ? rec['version'] : undefined;
        const recordedPath = typeof rec['installPath'] === 'string' ? rec['installPath'] : undefined;
        // Cache slots are flat: cache/plugins/<marketplace>___<name>___<version>.
        const fallback =
          marketplace !== undefined && version !== undefined
            ? join(pluginsDir(), 'cache', 'plugins', `${marketplace}___${name}___${version}`)
            : undefined;
        const path = recordedPath !== undefined && existsSync(recordedPath) ? recordedPath : fallback;
        const plugin: InstalledPlugin = { id, name };
        if (marketplace !== undefined) plugin.marketplace = marketplace;
        if (path !== undefined) plugin.path = path;
        if (version !== undefined) plugin.version = version;
        const enabled = lockEnabled(name);
        if (enabled === false) plugin.enabled = false;
        out.push(plugin);
      }
    }
    return out;
  },

  mcpEntries(): McpServerEntry[] {
    const entries: McpServerEntry[] = [];
    for (const plugin of this.listInstalled()) {
      if (plugin.path === undefined || !existsSync(plugin.path)) continue;
      entries.push(...collectPluginServers(plugin.id, plugin.path, mcpCandidates()));
    }
    return entries;
  },
};

export type OmpUpgradeTarget = {
  readonly marketplace: string;
  readonly pluginId: string;
};

export type OmpFrozenCatalogBinding = {
  readonly marketplace: string;
  readonly pluginId: string;
  readonly immutableRevision: string;
};

export type OmpSynchronousReadbackCapability = {
  readonly synchronous: true;
};

export type OmpRollbackCapability = {
  readonly restoresPriorActivation: true;
};

export type OmpRetirementSafety =
  | { readonly kind: 'operation-specific'; readonly preserves: readonly ['disabled', 'features', 'settings'] }
  | { readonly kind: 'marketplace-removal' };

export type OmpNativeUpgradeCandidate =
  | {
      readonly kind: 'exact-package';
      readonly target: OmpUpgradeTarget;
      readonly catalog: OmpFrozenCatalogBinding | null;
      readonly readback: OmpSynchronousReadbackCapability | null;
      readonly rollback: OmpRollbackCapability | null;
      readonly retirement: OmpRetirementSafety | null;
    }
  | { readonly kind: 'all-plugins' };

export type OmpNativeUpgradeGap =
  | 'all-plugin-upgrade'
  | 'frozen-catalog-binding'
  | 'synchronous-readback'
  | 'rollback'
  | 'operation-specific-retirement';

export type OmpNativeUpgradeDecision =
  | { readonly status: 'eligible'; readonly route: 'native'; readonly mode: 'exact-package' }
  | {
      readonly status: 'ineligible';
      readonly route: 'managed';
      readonly scope: 'unbounded' | 'unavailable';
      readonly missing: readonly OmpNativeUpgradeGap[];
    };

export type OmpNativeUpgradeScope =
  | { readonly kind: 'bounded'; readonly mode: 'exact-package'; readonly affectedNativeIds: readonly [string] }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'unbounded' };

export type OmpNativeUpgradeProjection =
  | { readonly kind: 'equivalent'; readonly proofId: 'omp-exact-package-upgrade' }
  | { readonly kind: 'requires-managed'; readonly reasonId: string };

const preservedRetirement = ['disabled', 'features', 'settings'] as const;

export function selectOmpNativeUpgrade(candidate: OmpNativeUpgradeCandidate): OmpNativeUpgradeDecision {
  switch (candidate.kind) {
    case 'all-plugins':
      return { status: 'ineligible', route: 'managed', scope: 'unbounded', missing: ['all-plugin-upgrade'] };
    case 'exact-package':
      return exactPackageDecision(candidate);
    default: {
      const unreachable: never = candidate;
      throw new Error(`OMP native upgrade candidate kind is unknown: ${String((unreachable as { kind?: unknown }).kind)}`);
    }
  }
}

export function ompUpgradeMutationScope(candidate: OmpNativeUpgradeCandidate, nativeId: string): OmpNativeUpgradeScope {
  const decision = selectOmpNativeUpgrade(candidate);
  if (decision.status === 'eligible') return { kind: 'bounded', mode: 'exact-package', affectedNativeIds: [nativeId] };
  if (decision.scope === 'unbounded') return { kind: 'unbounded' };
  return { kind: 'unavailable' };
}

export function ompUpgradeProjection(candidate: OmpNativeUpgradeCandidate): OmpNativeUpgradeProjection {
  const decision = selectOmpNativeUpgrade(candidate);
  if (decision.status === 'eligible') return { kind: 'equivalent', proofId: 'omp-exact-package-upgrade' };
  return { kind: 'requires-managed', reasonId: decision.missing.join('+') };
}

function exactPackageDecision(candidate: Extract<OmpNativeUpgradeCandidate, { kind: 'exact-package' }>): OmpNativeUpgradeDecision {
  const missing: OmpNativeUpgradeGap[] = [];
  if (!catalogBindsTarget(candidate.target, candidate.catalog)) missing.push('frozen-catalog-binding');
  if (candidate.readback?.synchronous !== true) missing.push('synchronous-readback');
  if (candidate.rollback?.restoresPriorActivation !== true) missing.push('rollback');
  if (!isOperationSpecificRetirement(candidate.retirement)) missing.push('operation-specific-retirement');
  if (missing.length > 0) return { status: 'ineligible', route: 'managed', scope: 'unavailable', missing };
  return { status: 'eligible', route: 'native', mode: 'exact-package' };
}

function catalogBindsTarget(target: OmpUpgradeTarget, catalog: OmpFrozenCatalogBinding | null): boolean {
  if (!isBareIdentity(target.marketplace) || !isBareIdentity(target.pluginId) || catalog === null) return false;
  return catalog.marketplace === target.marketplace
    && catalog.pluginId === target.pluginId
    && isBareIdentity(catalog.marketplace)
    && isBareIdentity(catalog.pluginId)
    && /^[0-9a-f]{40}$|^[0-9a-f]{64}$/u.test(catalog.immutableRevision);
}

function isOperationSpecificRetirement(retirement: OmpRetirementSafety | null): boolean {
  return retirement?.kind === 'operation-specific'
    && retirement.preserves.length === preservedRetirement.length
    && preservedRetirement.every((field, index) => retirement.preserves[index] === field);
}

function isBareIdentity(value: string): boolean {
  return value.trim() === value && value.length > 0 && !value.includes('@') && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}
