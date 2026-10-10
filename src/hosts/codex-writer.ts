/**
 * codex host writer — add/pin/remove for the store documented in
 * docs/hosts/codex.md.
 *
 * A sibling of the reader module so doctor's import graph never loads writer
 * code (AGENTS.md: doctor is read-only by construction;
 * test/doctor-imports.test.ts pins it).
 */
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseToml } from 'smol-toml';
import { createCapabilityEvidenceProfile, type CapabilityEvidenceProfile, type CapabilityStatus } from '../capability-evidence';
import { projectPluginForCodex } from '../conversion';
import { fingerprintTree } from '../fingerprint';
import type { AddOptions, HostWriter, InstalledPlugin, PinOptions, PinOutcome } from '../host';
import type {
  ActivationPreparationCapture,
  CleanupReference,
  CleanupResultData,
  DirectivesAppliedProjection,
  DurableLifecycleOperation,
  LifecycleHostDefinition,
  LifecycleReadbackData,
  LifecycleTargetIdentity,
  MutationResultData,
  NativeMutationScopeData,
  NativeProjectionData,
  NativeProjectionRequest,
  PinsAppliedProjection,
  PreparedActivationMutation,
  PreparedRetirementMutation,
  RetirementPreparationCapture,
  TargetInstallationData,
  TargetInventoryData,
} from '../lifecycle-host';
import { createLifecycleHostAdapter, createTargetInventoryObservation } from '../lifecycle-runtime';
import { pinPluginMcpFiles } from '../mcp-write';
import { codexHome } from '../paths';
import { CryptoHasher, spawnSync } from '../runtime';
import { PACKAGE_SEMANTICS, type CapabilityOperation, type PackageSemantic } from '../semantic-inventory';
import { readPluginManifest, type PluginSource, type ResolvedSource } from '../source';
import { codex, configFile, mcpCandidates, probeCodexVersion, resolveCodexBinary } from './codex';

const OWNERSHIP = '.plgnz-install.json';

export const codexWriter: HostWriter = {
  ...codex,
  supportsAdoption: true,
  plannedNativeId: (plugin) => `${plugin.name}@${plugin.marketplace || 'local'}`,
  legacyNativeIds: (plugin) => plugin.marketplace === undefined ? [plugin.name] : [],
  persistedNativeIdMayAlias: (persisted, requested) =>
    !persisted.includes('@') && (requested === persisted || requested === `${persisted}@local`),
  async add(plugin: PluginSource, resolved: ResolvedSource, opts?: AddOptions): Promise<void | 'unchanged'> {
    const marketplace = plugin.marketplace || 'local';
    const id = `${plugin.name}@${marketplace}`;
    const version = pluginVersion(plugin.dir);
    if (!validVersionSegment(version)) throw new Error(`unsafe Codex plugin version: ${version}`);
    const slot = join(codexHome(), 'plugins', 'cache', marketplace, plugin.name);
    const targetDir = join(slot, version);
    const configPath = configFile();
    assertManagedConfigPath(codexHome(), configPath);

    if (opts?.dryRun) {
      const stage = mkdtempSync(join(tmpdir(), 'plgnz-codex-dry-run-'));
      try {
        projectPluginForCodex(plugin.dir, stage);
        ensureNativeManifest(stage, plugin.name, version);
        validateStage(stage);
        writeFileSync(join(stage, OWNERSHIP), JSON.stringify({ source: resolved.sourceUri, pluginId: id, fingerprint: plugin.contentFingerprint ?? '' }));
        assertManagedPath(codexHome(), slot);
        if (existsSync(slot)) {
          assertNoSymlinks(slot);
          assertNoWinningForeignVersion(slot, version, id, resolved.sourceUri);
          const marker = readOwnership(targetDir);
          if (marker !== null && (marker.source !== resolved.sourceUri || marker.pluginId !== id)) throw new Error(`codex cache slot ${targetDir} has a different owned source identity; refusing to replace it`);
          if (existsSync(targetDir) && marker === null && !sameTree(stage, targetDir)) {
            if (!opts.adoptExisting) throw new Error(`codex cache slot ${targetDir} is unowned and differs from the staged representation; pass --adopt-existing to take ownership explicitly`);
            validateCachedIdentity(targetDir, plugin.name, version);
          }
        }
      }
      finally { rmSync(stage, { recursive: true, force: true }); }
      console.log(`[codex] would activate directory: ${targetDir}`);
      console.log(`[codex] would update config: ${configPath}`);
      return;
    }
    assertManagedPath(codexHome(), slot);
    mkdirSync(slot, { recursive: true });
    assertNoSymlinks(slot);
    assertNoWinningForeignVersion(slot, version, id, resolved.sourceUri);
    const marker = readOwnership(targetDir);
    if (marker !== null && (marker.source !== resolved.sourceUri || marker.pluginId !== id)) throw new Error(`codex cache slot ${targetDir} has a different owned source identity; refusing to replace it`);
    const stage = mkdtempSync(join(slot, '.plgnz-stage-'));
    try {
      projectPluginForCodex(plugin.dir, stage);
      ensureNativeManifest(stage, plugin.name, version);
      validateStage(stage);
      writeFileSync(join(stage, OWNERSHIP), JSON.stringify({ source: resolved.sourceUri, pluginId: id, fingerprint: plugin.contentFingerprint ?? '' }));
      const identicalUnowned = existsSync(targetDir) && marker === null && sameTree(stage, targetDir);
      if (existsSync(targetDir) && marker === null && !identicalUnowned) {
        if (!opts?.adoptExisting) throw new Error(`codex cache slot ${targetDir} is unowned and differs from the staged representation; pass --adopt-existing to take ownership explicitly`);
        validateCachedIdentity(targetDir, plugin.name, version);
      }
      const unchanged = marker !== null && marker.fingerprint === plugin.contentFingerprint && sameTree(stage, targetDir);
      if (unchanged) {
        const alreadyEnabled = isEnabled(configPath, id);
        try { if (!alreadyEnabled) enable(configPath, id); }
        finally { rmSync(stage, { recursive: true, force: true }); }
        return alreadyEnabled ? 'unchanged' : undefined;
      }
      const configBefore = readConfigSnapshot(configPath);
      const activation = activate(stage, targetDir, slot);
      try {
        enable(configPath, id);
      } catch (error) {
        try { restoreConfig(configPath, configBefore); }
        finally { activation.rollback(); }
        throw error;
      }
      // The new slot and config are now the active install. Backup disposal and
      // old-version cleanup may fail, but must never roll back by deleting the
      // new active slot after its backup has been partially or fully removed.
      activation.commit();
      cleanupOwnedVersions(slot, targetDir, id, resolved.sourceUri);
      return;
    } catch (error) {
      rmSync(stage, { recursive: true, force: true });
      throw error;
    }


  },
  async pin(plugin: InstalledPlugin, opts?: PinOptions): Promise<PinOutcome> {
    if (plugin.path === undefined || !existsSync(plugin.path)) return { changes: [], refusals: [] };
    return pinPluginMcpFiles(plugin.path, mcpCandidates(), opts);
  },
  async remove(id: string): Promise<void> {
    const configPath = configFile();
    assertManagedConfigPath(codexHome(), configPath);
    const at = id.indexOf('@');
    const owned: string[] = [];
    if (at !== -1) {
      const slot = join(codexHome(), 'plugins', 'cache', id.slice(at + 1), id.slice(0, at));
      if (existsSync(slot)) {
        assertNoSymlinks(slot);
        for (const version of readdirSync(slot)) {
          const candidate = join(slot, version);
          if (!statSync(candidate).isDirectory()) continue;
          if (readOwnership(candidate)?.pluginId === id) owned.push(candidate);
        }
      }
    }
    if (existsSync(configPath)) {
      const toml = readFileSync(configPath, 'utf8');
      const header = `[plugins."${id}"]`;
      const idx = toml.indexOf(header);
      if (idx !== -1) {
        const nextTable = toml.indexOf('\n[', idx + header.length);
        const end = nextTable === -1 ? toml.length : nextTable;
        const block = toml.slice(idx, end);
        const withoutEnabled = block.replace(/^enabled\s*=\s*(true|false)\s*\n?/mu, '');
        const remaining = withoutEnabled.slice(header.length).trim();
        const replacement = remaining === '' ? '' : `${withoutEnabled.trimEnd()}\nenabled = false\n`;
        writeFileSync(configPath, toml.slice(0, idx) + replacement + toml.slice(end));
      }
    }
    for (const candidate of owned) rmSync(candidate, { recursive: true, force: true });
  }
};

function enable(configPath: string, id: string): void {
    let toml = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
    parseConfigToml(toml, configPath);

    let newToml = toml;
    const header = `[plugins."${id}"]`;
    const idx = toml.indexOf(header);
    if (idx !== -1) {
      const nextTable = toml.indexOf('\n[', idx + header.length);
      const blockEnd = nextTable !== -1 ? nextTable : toml.length;
      const block = toml.slice(idx, blockEnd);
      const enabled = /^([ \t]*enabled[ \t]*=[ \t]*)(true|false)([ \t]*(?:#.*)?)$/gmu;
      const matches = [...block.matchAll(enabled)];
      if (matches.length > 1) throw new Error(`duplicate enabled keys in Codex plugin config: ${id}`);
      if (matches[0]?.[2] === 'false') {
        const newBlock = block.replace(enabled, '$1true$3');
        newToml = toml.slice(0, idx) + newBlock + toml.slice(blockEnd);
      } else if (matches.length === 0) {
        newToml = toml.slice(0, idx + header.length) + '\nenabled = true' + toml.slice(idx + header.length);
      }
    } else {
      if (!newToml.endsWith('\n') && newToml.length > 0) newToml += '\n';
      newToml += `[plugins."${id}"]\nenabled = true\n`;
    }

    mkdirSync(dirname(configPath), { recursive: true });
    parseConfigToml(newToml, configPath);
    writeFileSync(configPath, newToml);
}

function parseConfigToml(text: string, path: string): void {
  if (text.trim() === '') return;
  try { parseToml(text); }
  catch (error) { throw new Error(`invalid Codex config TOML: ${path} (${(error as Error).message})`); }
}

function isEnabled(configPath: string, id: string): boolean {
  if (!existsSync(configPath)) return false;
  const toml = readFileSync(configPath, 'utf8');
  const header = `[plugins."${id}"]`;
  const idx = toml.indexOf(header);
  if (idx === -1) return false;
  const nextTable = toml.indexOf('\n[', idx + header.length);
  const block = toml.slice(idx, nextTable === -1 ? toml.length : nextTable);
  return !/^enabled\s*=\s*false\s*$/mu.test(block);
}

type ConfigSnapshot = { existed: false } | { existed: true; bytes: Uint8Array };

function readConfigSnapshot(path: string): ConfigSnapshot {
  if (!existsSync(path)) return { existed: false };
  const read = readFileSync as unknown as (file: string) => Uint8Array;
  return { existed: true, bytes: read(path) };
}

function restoreConfig(path: string, snapshot: ConfigSnapshot): void {
  if (!snapshot.existed) {
    rmSync(path, { force: true });
    return;
  }
  const write = writeFileSync as unknown as (file: string, bytes: Uint8Array) => void;
  write(path, snapshot.bytes);
}

function pluginVersion(dir: string): string {
  return readPluginManifest(dir)?.version ?? 'local';
}

function validVersionSegment(value: string): boolean {
  return value === 'local' || /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value);
}

function readOwnership(dir: string): { source: string; pluginId: string; fingerprint: string } | null {
  const file = join(dir, OWNERSHIP);
  if (!existsSync(file)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof value !== 'object' || value === null) throw new Error('marker must be an object');
    const record = value as Record<string, unknown>;
    if (typeof record['source'] !== 'string' || typeof record['pluginId'] !== 'string' || typeof record['fingerprint'] !== 'string') throw new Error('marker fields are invalid');
    return { source: record['source'], pluginId: record['pluginId'], fingerprint: record['fingerprint'] };
  } catch (error) {
    throw new Error(`invalid plgnz ownership marker: ${file} (${(error as Error).message})`);
  }
}

function validateStage(stage: string): void {
  if (readPluginManifest(stage) === undefined) throw new Error('Codex stage has no Agent Plugins manifest');
  const skills = join(stage, 'skills');
  if (existsSync(skills) && !statSync(skills).isDirectory()) throw new Error('Codex stage skills path is not a directory');
}

function validateCachedIdentity(target: string, expectedName: string, expectedVersion: string): void {
  const candidates = [join(target, '.codex-plugin', 'plugin.json'), join(target, 'plugin.json'), join(target, '.plugin', 'plugin.json')];
  const manifest = candidates.find(existsSync);
  if (manifest === undefined) throw new Error(`unowned Codex cache slot has no manifest: ${target}`);
  const value: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`invalid cached Codex manifest: ${manifest}`);
  const record = value as Record<string, unknown>;
  if (record['name'] === expectedName && record['version'] === expectedVersion) return;
  if (manifest === candidates[0] && record['name'] === expectedName && nativeBuildVariant(expectedVersion, record['version'])) {
    const canonical = candidates.slice(1).find(existsSync);
    if (canonical !== undefined) {
      const canonicalValue: unknown = JSON.parse(readFileSync(canonical, 'utf8'));
      if (typeof canonicalValue === 'object' && canonicalValue !== null && !Array.isArray(canonicalValue)) {
        const identity = canonicalValue as Record<string, unknown>;
        if (identity['name'] === expectedName && identity['version'] === expectedVersion) return;
      }
    }
  }
  throw new Error(`cached Codex manifest identity does not match ${expectedName}@${expectedVersion}`);
}

function nativeBuildVariant(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(expected)) return false;
  const base = expected.split('+')[0]!;
  return actual.startsWith(`${base}+`) && /^(?:[0-9A-Za-z-]+)(?:\.[0-9A-Za-z-]+)*$/u.test(actual.slice(base.length + 1));
}

/** Codex's native loader requires its own manifest path; project only safe, relevant fields. */
function ensureNativeManifest(stage: string, fallbackName: string, fallbackVersion: string): void {
  const native = join(stage, '.codex-plugin', 'plugin.json');
  const sourceManifest = readPluginManifest(stage);
  if (sourceManifest === undefined) throw new Error('Codex stage has no Agent Plugins manifest');
  const name = sourceManifest.name ?? fallbackName;
  const version = sourceManifest.version ?? fallbackVersion;
  const description = sourceManifest.description ?? `Plugin ${name}`;
  let overlay: Record<string, unknown> = {};
  if (existsSync(native)) {
    const value: unknown = JSON.parse(readFileSync(native, 'utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Codex native plugin manifest must be an object');
    overlay = value as Record<string, unknown>;
    if (overlay['name'] !== undefined && overlay['name'] !== name) throw new Error(`Codex native plugin name conflicts with Agent Plugins manifest: ${String(overlay['name'])}`);
    if (overlay['version'] !== undefined && overlay['version'] !== version) throw new Error(`Codex native plugin version conflicts with Agent Plugins manifest: ${String(overlay['version'])}`);
    if (overlay['skills'] !== undefined && overlay['skills'] !== './skills/' && overlay['skills'] !== './skills') {
      throw new Error(`unsupported Codex native skills pointer: ${String(overlay['skills'])}`);
    }
  }
  mkdirSync(dirname(native), { recursive: true });
  writeFileSync(native, JSON.stringify({ ...overlay, name, version, description, skills: overlay['skills'] ?? './skills/' }));
}

function assertManagedPath(root: string, target: string): void {
  if (target !== root && !target.startsWith(`${root}/`)) throw new Error(`Codex managed path escapes its home: ${target}`);
  const suffix = target === root ? '' : target.slice(root.length + 1);
  let current = root;
  for (const part of ['', ...suffix.split('/').filter(Boolean)]) {
    if (part !== '') current = join(current, part);
    if (!existsSync(current)) continue;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Codex managed path component is a symlink: ${current}`);
    if (!stat.isDirectory()) throw new Error(`Codex managed path component is not a directory: ${current}`);
  }
}

function assertManagedConfigPath(root: string, path: string): void {
  assertManagedPath(root, dirname(path));
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`Codex managed config is a symlink: ${path}`);
  if (!stat.isFile()) throw new Error(`Codex managed config is not a file: ${path}`);
}

function activate(stage: string, target: string, slot: string): { commit(): void; rollback(): void } {
  if (!existsSync(target)) {
    renameSync(stage, target);
    return { commit: () => {}, rollback: () => rmSync(target, { recursive: true, force: true }) };
  }
  const backup = mkdtempSync(join(slot, '.plgnz-backup-'));
  const previous = join(backup, 'previous');
  renameSync(target, previous);
  try { renameSync(stage, target); }
  catch (error) {
    renameSync(previous, target);
    rmSync(backup, { recursive: true, force: true });
    throw error;
  }
  return {
    commit: () => rmSync(backup, { recursive: true, force: true }),
    rollback: () => {
      rmSync(target, { recursive: true, force: true });
      renameSync(previous, target);
      rmSync(backup, { recursive: true, force: true });
    },
  };
}

function sameTree(left: string, right: string): boolean {
  const listing = (dir: string): string[] => {
    const out: string[] = [];
    const walk = (current: string, prefix: string): void => {
      for (const entry of readdirSync(current).sort()) {
        if (entry === OWNERSHIP) continue;
        const path = join(current, entry);
        const relative = prefix === '' ? entry : `${prefix}/${entry}`;
        const stat = statSync(path);
        if (stat.isDirectory()) walk(path, relative);
        else if (stat.isFile()) out.push(`${relative}:${bytesKey(path)}`);
      }
    };
    walk(dir, '');
    return out;
  };
  return JSON.stringify(listing(left)) === JSON.stringify(listing(right));
}

function bytesKey(path: string): string {
  const read = readFileSync as unknown as (file: string) => Uint8Array;
  return Array.from(read(path)).join(',');
}

function assertNoWinningForeignVersion(slot: string, requested: string, id: string, source: string): void {
  for (const version of readdirSync(slot)) {
    const candidate = join(slot, version);
    if (!statSync(candidate).isDirectory() || version === requested) continue;
    const marker = readOwnership(candidate);
    if (wins(version, requested) && (marker?.pluginId !== id || marker.source !== source)) {
      throw new Error(`foreign Codex cache version ${version} would remain active over ${requested}`);
    }
  }
}

function cleanupOwnedVersions(slot: string, active: string, id: string, source: string): void {
  for (const version of readdirSync(slot)) {
    const candidate = join(slot, version);
    if (candidate === active || !statSync(candidate).isDirectory()) continue;
    const marker = readOwnership(candidate);
    if (marker?.pluginId === id && marker.source === source) rmSync(candidate, { recursive: true, force: true });
  }
}

function assertNoSymlinks(dir: string): void {
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Codex managed slot contains symlink: ${path}`);
      if (stat.isDirectory()) walk(path);
    }
  };
  walk(dir);
}

function wins(left: string, right: string): boolean {
  if (left === 'local') return right !== 'local';
  if (right === 'local') return false;
  const parse = (value: string): { numbers: number[]; prerelease?: string } | null => {
    const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u);
    return match === null ? null : { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], ...(match[4] === undefined ? {} : { prerelease: match[4] }) };
  };
  const l = parse(left); const r = parse(right);
  if (l !== null && r !== null) {
    for (let i = 0; i < 3; i += 1) if (l.numbers[i] !== r.numbers[i]) return (l.numbers[i] ?? 0) > (r.numbers[i] ?? 0);
    if (l.prerelease === undefined && r.prerelease !== undefined) return true;
    if (l.prerelease !== undefined && r.prerelease === undefined) return false;
    if (l.prerelease !== undefined && r.prerelease !== undefined) return comparePrerelease(l.prerelease, r.prerelease) > 0;
    return false;
  }
  return left > right;
}

/**
 * Catalog binding is the native-upgrade gate. A branch or tag is unbound.
 * A full 40-character object id is the only ref Codex treats as already resolved.
 */
type CodexCatalogBinding =
  | { readonly kind: 'sha-bound'; readonly marketplace: string; readonly sha: string; readonly source: string }
  | { readonly kind: 'unbound'; readonly marketplace: string }
  | { readonly kind: 'absent'; readonly marketplace: string };

const CODEX_ROUTE_VERSION = '0.162.0';
const NATIVE_UPGRADE_TIMEOUT_MS = 120_000;
/** Codex advances the marketplace checkout itself. plgnz does not capture that git state. */
export const codexMarketplaceCheckoutRollback = 'unverified' as const;

function nativeUpgradeTimeout(): number {
  const raw = process.env['OPEN_PLUGIN_CODEX_UPGRADE_TIMEOUT_MS'];
  if (raw === undefined || raw.trim() === '') return NATIVE_UPGRADE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < NATIVE_UPGRADE_TIMEOUT_MS) return NATIVE_UPGRADE_TIMEOUT_MS;
  return parsed;
}
const RELOAD_EFFECTIVE = { requirement: 'reload', status: 'effective' } as const;
const UPDATE_SEMANTICS = ['auto-update-control', 'readback', 'rollback', 'activation-reload'] as const satisfies readonly PackageSemantic[];
const MANAGED_SEMANTICS = [...UPDATE_SEMANTICS, 'retirement', 'retention-safety'] as const satisfies readonly PackageSemantic[];

const codexEvidenceProfiles: readonly CapabilityEvidenceProfile[] = [
  codexRouteProfile('native', ['update'], UPDATE_SEMANTICS, ['docs/research/native-plugin-update-capabilities-2026-10-09.md']),
  codexRouteProfile('managed', ['update', 'retire'], MANAGED_SEMANTICS, [
    'docs/hosts/codex.md',
    'docs/adr/0004-retain-plugin-state-on-removal.md',
  ]),
];

const codexLifecycleDefinition = {
  id: 'codex',
  evidenceProfiles: codexEvidenceProfiles,
  probeVersion: async () => probeCodexVersion(),
  observeTarget: async (target): Promise<TargetInventoryData> => ({
    target,
    installations: codex.listInstalled().map(installationRecord),
  }),
  observeNativeMutationScope: async (request): Promise<NativeMutationScopeData> => {
    const marketplace = marketplaceOf(request.nativeId);
    if (marketplace === null) return { kind: 'unavailable' };
    const affected = request.targetObservation.installations
      .map((installation) => installation.nativeId)
      .filter((nativeId) => marketplaceOf(nativeId) === marketplace);
    const [first, ...rest] = affected;
    if (first === undefined) return { kind: 'unavailable' };
    return { kind: 'bounded', mode: 'marketplace-wide', affectedNativeIds: [first, ...rest] };
  },
  observeNativeProjection: async (request): Promise<NativeProjectionData> => nativeProjection(request),
  revalidateTargetPrecondition: async (handle) => revalidateCodexTarget(handle),
  stageActivation: async (request) => stageCodexActivation(request),
  applyLifecycleDirectives: async () => [],
  applyPins: async (projection) => applyCodexPins(projection),
  captureActivationPreparation: async (projection, projectedFingerprint) => captureCodexActivation(projection, projectedFingerprint),
  captureDisablePreparation: async () => {
    throw new Error('codex lifecycle disable is not routed yet');
  },
  captureRetirementPreparation: async (request) => captureCodexRetirement(request),
  apply: async (prepared) => applyCodexActivation(prepared),
  disable: async () => {
    throw new Error('codex lifecycle disable is not routed yet');
  },
  retire: async (prepared) => retireCodex(prepared),
  readback: async (handle) => readCodexInstall(handle),
  rollback: async (handle) => restoreCodexRollback(handle),
  cleanup: async (reference) => cleanupCodexStage(reference),
} satisfies LifecycleHostDefinition;

export const codexLifecycle = createLifecycleHostAdapter(codexLifecycleDefinition);

function codexRouteProfile(
  route: 'native' | 'managed',
  operations: readonly CapabilityOperation[],
  supportedSemantics: readonly PackageSemantic[],
  evidence: readonly string[],
): CapabilityEvidenceProfile {
  const checkoutRollback = route === 'native' ? codexMarketplaceCheckoutRollback : 'supported';
  if (checkoutRollback !== 'unverified' && route === 'native') {
    throw new Error('codex marketplace checkout rollback must stay unverified');
  }
  const supported = new Set<PackageSemantic>(supportedSemantics);
  const semantics = {} as Record<PackageSemantic, CapabilityStatus>;
  for (const semantic of PACKAGE_SEMANTICS) semantics[semantic] = supported.has(semantic) ? 'supported' : 'unsupported';
  return createCapabilityEvidenceProfile({
    host: 'codex',
    detectedVersion: CODEX_ROUTE_VERSION,
    sourceTypes: ['git', 'local'],
    operations,
    route,
    operationStatus: 'supported',
    semantics,
    evidence,
  });
}

function revalidateCodexTarget(handle: DurableLifecycleOperation): { version: ReturnType<typeof probeCodexVersion>; targetObservationId: string } {
  const version = probeCodexVersion();
  const observation = createTargetInventoryObservation('codex', {
    target: handle.target,
    installations: codex.listInstalled().map(installationRecord),
  });
  return { version, targetObservationId: observation.observationId };
}

function stageCodexActivation(request: Parameters<LifecycleHostDefinition['stageActivation']>[0]): { stagingId: string; stagingRoot: string } {
  const stagingId = `${request.snapshot.attemptId}:${request.snapshot.operationId}`;
  const stagingRoot = resolve(join(codexHome(), '.plgnz-lifecycle', stagingId));
  assertManagedPath(codexHome(), stagingRoot);
  rmSync(stagingRoot, { recursive: true, force: true });
  mkdirSync(stagingRoot, { recursive: true });
  projectPluginForCodex(request.snapshot.packageRoot, stagingRoot);
  const version = pluginVersion(stagingRoot);
  if (!validVersionSegment(version)) throw new Error(`unsafe Codex plugin version: ${version}`);
  ensureNativeManifest(stagingRoot, request.snapshot.packageName, version);
  validateStage(stagingRoot);
  const source = request.snapshot.nativeGit?.locator ?? request.snapshot.immutableRevision;
  writeFileSync(join(stagingRoot, OWNERSHIP), JSON.stringify({
    source,
    pluginId: request.snapshot.nativeId,
    fingerprint: request.snapshot.packageFingerprint,
  }));
  return { stagingId, stagingRoot };
}

function applyCodexPins(projection: DirectivesAppliedProjection): readonly string[] {
  if (projection.pins.length === 0) return [];
  const outcome = pinPluginMcpFiles(projection.stagingRoot, mcpCandidates());
  if (outcome.refusals.length > 0) throw new Error(`codex pin refused ${outcome.refusals.map((refusal) => refusal.server).join(', ')}`);
  return projection.pins.map((pin) => pin.server);
}

function captureCodexActivation(projection: PinsAppliedProjection, projectedFingerprint: string): ActivationPreparationCapture {
  const version = pluginVersion(projection.stagingRoot);
  const destination = cacheDestination(projection.nativeId, version);
  const prior = readInstall({
    target: projection.target,
    scopeId: projection.scopeId,
    packageName: projection.packageName,
    nativeId: projection.nativeId,
  });
  saveCodexRollback(projection.attemptId, projection.operationId, projection.affectedNativeIds);
  return {
    prior,
    expected: {
      ...prior,
      route: projection.route,
      presence: 'present',
      enablement: 'enabled',
      activation: 'active',
      transition: RELOAD_EFFECTIVE,
      installedFingerprint: projectedFingerprint,
      contentRoots: [{ label: 'plugin', path: destination, fingerprint: projectedFingerprint }],
    },
    rollbackReference: codexRollbackReference(projection.attemptId, projection.operationId),
    rollbackCoverageOperationIds: projection.affectedOperationIds,
  };
}

function captureCodexRetirement(request: Parameters<LifecycleHostDefinition['captureRetirementPreparation']>[0]): RetirementPreparationCapture {
  const prior = readInstall({
    target: request.activation.target,
    scopeId: request.activation.scopeId,
    packageName: request.activation.packageName,
    nativeId: request.activation.nativeId,
    route: 'managed',
  });
  saveCodexRollback(request.attemptId, request.operationId, request.selection.affectedNativeIds);
  return {
    prior,
    rollbackReference: codexRollbackReference(request.attemptId, request.operationId),
    rollbackCoverageOperationIds: request.selection.affectedOperationIds,
    transition: RELOAD_EFFECTIVE,
  };
}

function applyCodexActivation(prepared: PreparedActivationMutation): MutationResultData {
  switch (prepared.handle.route) {
    case 'native':
      return applyNativeMarketplaceUpgrade(prepared);
    case 'managed':
      return applyManagedCodexActivation(prepared);
    default: {
      const unreachable: never = prepared.handle.route;
      throw new Error(`unreachable Codex lifecycle route: ${String(unreachable)}`);
    }
  }
}

function applyManagedCodexActivation(prepared: PreparedActivationMutation): MutationResultData {
  const { handle, stagingRoot } = prepared;
  const version = pluginVersion(stagingRoot);
  if (!validVersionSegment(version)) throw new Error(`unsafe Codex plugin version: ${version}`);
  const marketplace = marketplaceOf(handle.nativeId);
  if (marketplace === null) throw new Error(`codex native id has no marketplace: ${handle.nativeId}`);
  const name = handle.nativeId.slice(0, handle.nativeId.indexOf('@'));
  const slot = join(codexHome(), 'plugins', 'cache', marketplace, name);
  const targetDir = join(slot, version);
  const configPath = configFile();
  assertManagedConfigPath(codexHome(), configPath);
  assertManagedPath(codexHome(), slot);
  mkdirSync(slot, { recursive: true });
  assertNoSymlinks(slot);
  const source = readOwnership(stagingRoot)?.source ?? handle.sourceLocator ?? handle.sourceRevision;
  assertNoWinningForeignVersion(slot, version, handle.nativeId, source);
  const marker = readOwnership(targetDir);
  if (marker !== null && (marker.source !== source || marker.pluginId !== handle.nativeId)) {
    throw new Error(`codex cache slot ${targetDir} has a different owned source identity; refusing to replace it`);
  }
  const before = cacheFingerprint(handle.nativeId);
  const configBefore = readConfigSnapshot(configPath);
  const activation = activate(stagingRoot, targetDir, slot);
  try {
    enable(configPath, handle.nativeId);
  } catch (error) {
    try { restoreConfig(configPath, configBefore); }
    finally { activation.rollback(); }
    throw error;
  }
  activation.commit();
  cleanupOwnedVersions(slot, targetDir, handle.nativeId, source);
  return {
    receiptId: `apply:${handle.attemptId}:${handle.operationId}`,
    changed: before !== cacheFingerprint(handle.nativeId),
  };
}

function applyNativeMarketplaceUpgrade(prepared: PreparedActivationMutation): MutationResultData {
  const marketplace = marketplaceOf(prepared.handle.nativeId);
  if (marketplace === null) throw new Error(`codex native id has no marketplace: ${prepared.handle.nativeId}`);
  const binding = catalogBinding(marketplace);
  if (binding.kind !== 'sha-bound' || prepared.handle.sourceLocator !== binding.source || prepared.handle.sourceRevision !== binding.sha) {
    throw new Error(`codex marketplace upgrade refused: ${catalogRefusal(binding, prepared.handle.sourceLocator === null ? undefined : { locator: prepared.handle.sourceLocator, resolvedRevision: prepared.handle.sourceRevision })}`);
  }
  const before = fingerprintAffected(prepared.handle.affectedNativeIds);
  const binary = resolveCodexBinary();
  if (binary === null) throw new Error('codex marketplace upgrade stderr-only failure: codex binary is unavailable');
  const result = spawnSync([binary, 'plugin', 'marketplace', 'upgrade', marketplace, '--json'], {
    env: codexCommandEnv(),
    timeout: nativeUpgradeTimeout(),
  });
  const stdout = decodeBytes(result.stdout);
  const stderr = decodeBytes(result.stderr).trim();
  const parsed = parseUpgradeJson(stdout);
  const rewritten = fingerprintAffected(prepared.handle.affectedNativeIds);
  const errors = parsed?.errors ?? [];
  const success = result.exitCode === 0 && parsed !== null && errors.length === 0;
  if (!success) {
    const changed = prepared.handle.affectedNativeIds.filter((nativeId) => before.get(nativeId) !== rewritten.get(nativeId));
    if (changed.length > 0 || errors.length > 0) {
      const unchanged = prepared.handle.affectedNativeIds.filter((nativeId) => !changed.includes(nativeId));
      const detail = errors.length > 0 ? errors.map((error) => error.message).join('; ') : stderr;
      throw new Error(`codex marketplace upgrade partial mutation changed ${changed.join(', ')}; unchanged ${unchanged.join(', ')}: ${detail}`);
    }
    throw new Error(`codex marketplace upgrade stderr-only failure: ${stderr}`);
  }
  restampNativeUpgrade(prepared);
  const after = fingerprintAffected(prepared.handle.affectedNativeIds);
  const missed = prepared.handle.affectedNativeIds.filter((nativeId) => before.get(nativeId) !== null && after.get(nativeId) === null);
  if (missed.length > 0) throw new Error(`codex marketplace upgrade readback missed ${missed.join(', ')}`);
  return {
    receiptId: `apply:${prepared.handle.attemptId}:${prepared.handle.operationId}`,
    changed: before.get(prepared.handle.nativeId) !== after.get(prepared.handle.nativeId),
  };
}

async function retireCodex(prepared: PreparedRetirementMutation): Promise<MutationResultData> {
  const before = cacheFingerprint(prepared.handle.nativeId);
  await codexWriter.remove(prepared.handle.nativeId);
  return {
    receiptId: `retire:${prepared.handle.attemptId}:${prepared.handle.operationId}`,
    changed: before !== cacheFingerprint(prepared.handle.nativeId),
  };
}

function restampNativeUpgrade(prepared: PreparedActivationMutation): void {
  const markerPath = join(prepared.stagingRoot, OWNERSHIP);
  if (!existsSync(markerPath)) return;
  const marker = readFileSync(markerPath, 'utf8');
  const version = pluginVersion(prepared.stagingRoot);
  if (validVersionSegment(version)) {
    const destination = cacheDestination(prepared.handle.nativeId, version);
    if (existsSync(destination) && statSync(destination).isDirectory()) {
      assertManagedPath(codexHome(), destination);
      writeFileSync(join(destination, OWNERSHIP), marker);
    }
  }
  const staged = readOwnership(prepared.stagingRoot);
  const source = staged?.source ?? prepared.handle.sourceLocator ?? prepared.handle.sourceRevision;
  for (const nativeId of prepared.handle.affectedNativeIds) {
    if (nativeId === prepared.handle.nativeId) continue;
    const path = codex.listInstalled().find((plugin) => plugin.id === nativeId)?.path;
    if (path === undefined || !existsSync(path)) continue;
    const existing = readOwnership(path);
    if (existing?.pluginId === nativeId) continue;
    assertManagedPath(codexHome(), path);
    writeFileSync(join(path, OWNERSHIP), JSON.stringify({
      source,
      pluginId: nativeId,
      fingerprint: existing?.fingerprint ?? staged?.fingerprint ?? '',
    }));
  }
}

function readCodexInstall(handle: DurableLifecycleOperation): LifecycleReadbackData {
  return readInstall({
    target: handle.target,
    scopeId: handle.scopeId,
    packageName: handle.packageName,
    nativeId: handle.nativeId,
    route: handle.route,
  });
}

function cleanupCodexStage(reference: CleanupReference): CleanupResultData {
  const stage = resolve(join(codexHome(), '.plgnz-lifecycle', `${reference.attemptId}:${reference.operationId}`));
  if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
  return { cleanupId: `cleanup:${reference.attemptId}:${reference.operationId}`, completed: true };
}

function readInstall(identity: {
  readonly target: LifecycleTargetIdentity;
  readonly scopeId: string;
  readonly packageName: string;
  readonly nativeId: string;
  readonly route?: LifecycleReadbackData['route'];
}): LifecycleReadbackData {
  const plugin = codex.listInstalled().find((item) => item.id === identity.nativeId);
  const retention = retentionObservation(identity.nativeId);
  const shared = {
    adapterId: 'codex',
    target: identity.target,
    scopeId: identity.scopeId,
    packageName: identity.packageName,
    nativeId: identity.nativeId,
    transition: RELOAD_EFFECTIVE,
    retention,
  };
  if (plugin?.path === undefined) {
    return {
      ...shared,
      route: identity.route ?? 'none',
      presence: 'absent',
      enablement: plugin?.enabled === false ? 'disabled' : 'unknown',
      activation: 'inactive',
      installedFingerprint: null,
      contentRoots: [],
    };
  }
  const installedFingerprint = fingerprintTree(plugin.path);
  const owned = readOwnership(plugin.path)?.pluginId === identity.nativeId;
  return {
    ...shared,
    route: identity.route ?? (owned ? 'managed' : 'none'),
    presence: 'present',
    enablement: plugin.enabled ? 'enabled' : 'disabled',
    activation: plugin.enabled ? 'active' : 'inactive',
    installedFingerprint,
    contentRoots: [{ label: 'plugin', path: plugin.path, fingerprint: installedFingerprint }],
  };
}

function retentionObservation(nativeId: string): LifecycleReadbackData['retention'] {
  return {
    pluginData: retainedTree(pluginDataRoots(nativeId)),
    inactiveMetadata: inactiveMetadata(nativeId),
  };
}

function pluginDataRoots(nativeId: string): readonly string[] {
  const marketplace = marketplaceOf(nativeId);
  if (marketplace === null) return [];
  const name = nativeId.slice(0, nativeId.indexOf('@'));
  const hash = new CryptoHasher('sha256');
  hash.update(`${marketplace}\0${name}`);
  const prefix = hash.digest('hex').slice(0, 32);
  return [
    join(codexHome(), 'plugins', 'data', `${name}-${marketplace}`),
    join(codexHome(), 'plugins', 'data', 'agent-plugins', prefix),
  ];
}

function retainedTree(paths: readonly string[]): LifecycleReadbackData['retention']['pluginData'] {
  const present = paths.filter((path) => existsSync(path));
  const [only, ...rest] = present;
  if (only === undefined) return { state: 'absent', fingerprint: null };
  if (rest.length === 0) return { state: 'present', fingerprint: fingerprintTree(only) };
  const hash = new CryptoHasher('sha256');
  for (const path of [only, ...rest].sort()) hash.update(`${fingerprintTree(path)}\0`);
  return { state: 'present', fingerprint: hash.digest('hex') };
}

function inactiveMetadata(nativeId: string): LifecycleReadbackData['retention']['inactiveMetadata'] {
  const extra = pluginConfigExtras(nativeId);
  const keys = Object.keys(extra).sort();
  if (keys.length === 0) return { state: 'absent', fingerprint: null };
  const hash = new CryptoHasher('sha256');
  hash.update(JSON.stringify(Object.fromEntries(keys.map((key) => [key, extra[key]]))));
  return { state: 'present', fingerprint: hash.digest('hex') };
}

function pluginConfigExtras(nativeId: string): Record<string, unknown> {
  const entry = table(table(readConfigDocument()?.['plugins'])?.[nativeId]);
  if (entry === null) return {};
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'enabled') continue;
    extra[key] = value;
  }
  return extra;
}

function cacheDestination(nativeId: string, version: string): string {
  const marketplace = marketplaceOf(nativeId);
  if (marketplace === null) throw new Error(`codex native id has no marketplace: ${nativeId}`);
  const name = nativeId.slice(0, nativeId.indexOf('@'));
  return join(codexHome(), 'plugins', 'cache', marketplace, name, version);
}

function cacheFingerprint(nativeId: string): string | null {
  const path = codex.listInstalled().find((plugin) => plugin.id === nativeId)?.path;
  if (path === undefined || !existsSync(path)) return null;
  try {
    return fingerprintTree(path);
  } catch {
    return null;
  }
}

function fingerprintAffected(nativeIds: readonly string[]): Map<string, string | null> {
  return new Map(nativeIds.map((nativeId) => [nativeId, cacheFingerprint(nativeId)]));
}

function codexCommandEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  env['CODEX_HOME'] = codexHome();
  return env;
}

function decodeBytes(bytes: Uint8Array): string {
  return [...bytes].map((byte) => String.fromCharCode(byte)).join('');
}

function parseUpgradeJson(stdout: string): { readonly errors: readonly { readonly marketplaceName: string; readonly message: string }[] } | null {
  try {
    const value: unknown = JSON.parse(stdout);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (!Array.isArray(record['errors']) || !Array.isArray(record['selectedMarketplaces'])) return null;
    const errors: { marketplaceName: string; message: string }[] = [];
    for (const item of record['errors']) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
      const error = item as Record<string, unknown>;
      if (typeof error['marketplaceName'] !== 'string' || typeof error['message'] !== 'string') return null;
      errors.push({ marketplaceName: error['marketplaceName'], message: error['message'] });
    }
    if (record['selectedMarketplaces'].some((name) => typeof name !== 'string')) return null;
    return { errors };
  } catch {
    return null;
  }
}

function codexRollbackReference(attemptId: string, operationId: string): string {
  return `codex:${attemptId}:${operationId}`;
}

function rollbackBundle(attemptId: string, operationId: string): string {
  return resolve(join(codexHome(), '.plgnz-rollback', attemptId, operationId));
}

function saveCodexRollback(attemptId: string, operationId: string, nativeIds: readonly string[]): void {
  const bundle = rollbackBundle(attemptId, operationId);
  assertManagedPath(codexHome(), bundle);
  rmSync(bundle, { recursive: true, force: true });
  mkdirSync(bundle, { recursive: true });
  const toml = existsSync(configFile()) ? readFileSync(configFile(), 'utf8') : '';
  const tables = nativeIds.map((nativeId) => ({ nativeId, block: extractPluginTable(toml, nativeId) }));
  const installs = nativeIds.map((nativeId, index) => {
    const slot = pluginSlot(nativeId);
    const versions = slot === null ? [] : slotVersions(slot);
    const cachePath = codex.listInstalled().find((plugin) => plugin.id === nativeId)?.path;
    if (cachePath === undefined) return { nativeId, existed: false as const, slot, versions };
    const saved = String(index);
    cpSync(cachePath, join(bundle, 'cache', saved), { recursive: true });
    return { nativeId, existed: true as const, cachePath, saved, slot, versions };
  });
  writeFileSync(join(bundle, 'manifest.json'), JSON.stringify({ tables, installs }));
}

function restoreCodexRollback(handle: DurableLifecycleOperation): MutationResultData {
  const bundle = rollbackBundle(handle.attemptId, handle.operationId);
  const manifestPath = join(bundle, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`codex lifecycle rollback bundle is missing: ${handle.operationId}`);
  const manifest = parseRollbackManifest(readFileSync(manifestPath, 'utf8'));
  const before = rollbackSurface(manifest.installs.map((install) => install.nativeId));
  restorePluginTables(manifest.tables);
  for (const install of manifest.installs) {
    if (!install.existed) {
      const current = codex.listInstalled().find((plugin) => plugin.id === install.nativeId)?.path;
      if (current !== undefined) {
        assertManagedPath(codexHome(), current);
        rmSync(current, { recursive: true, force: true });
      }
    } else {
      assertManagedPath(codexHome(), install.cachePath);
      rmSync(install.cachePath, { recursive: true, force: true });
      mkdirSync(dirname(install.cachePath), { recursive: true });
      cpSync(join(bundle, 'cache', install.saved), install.cachePath, { recursive: true });
    }
    removeUnsnapshotVersions(install.slot, install.versions);
  }
  const after = rollbackSurface(manifest.installs.map((install) => install.nativeId));
  return { receiptId: `rollback:${handle.attemptId}:${handle.operationId}`, changed: before !== after };
}

function pluginSlot(nativeId: string): string | null {
  const marketplace = marketplaceOf(nativeId);
  if (marketplace === null) return null;
  const name = nativeId.slice(0, nativeId.indexOf('@'));
  if (name.length === 0) return null;
  return join(codexHome(), 'plugins', 'cache', marketplace, name);
}

function slotVersions(slot: string): string[] {
  if (!existsSync(slot)) return [];
  return readdirSync(slot).filter((version) => {
    try {
      return lstatSync(join(slot, version)).isDirectory();
    } catch {
      return false;
    }
  }).sort();
}

function removeUnsnapshotVersions(slot: string | null, versions: readonly string[]): void {
  if (slot === null || !existsSync(slot)) return;
  assertManagedPath(codexHome(), slot);
  const kept = new Set(versions);
  for (const version of slotVersions(slot)) {
    if (kept.has(version)) continue;
    const dir = join(slot, version);
    assertManagedPath(codexHome(), dir);
    rmSync(dir, { recursive: true, force: true });
  }
}

function rollbackSurface(nativeIds: readonly string[]): string {
  const config = existsSync(configFile()) ? readFileSync(configFile(), 'utf8') : 'absent';
  const slots = nativeIds.map((nativeId) => {
    const slot = pluginSlot(nativeId);
    if (slot === null || !existsSync(slot)) return `${nativeId}:`;
    return `${nativeId}:${slotVersions(slot).map((version) => {
      const path = join(slot, version);
      try {
        return `${version}=${fingerprintTree(path)}`;
      } catch {
        return `${version}=unreadable`;
      }
    }).join(',')}`;
  }).join('\n');
  return `${config}\n${slots}`;
}

function pluginTableHeader(id: string): string {
  return `[plugins."${id}"]`;
}

function extractPluginTable(toml: string, id: string): string | null {
  const header = pluginTableHeader(id);
  const idx = toml.indexOf(header);
  if (idx === -1) return null;
  const next = toml.indexOf('\n[', idx + header.length);
  const end = next === -1 ? toml.length : next;
  return toml.slice(idx, end).trim();
}

function restorePluginTables(tables: readonly { readonly nativeId: string; readonly block: string | null }[]): void {
  const configPath = configFile();
  const current = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  let next = current;
  for (const table of tables) next = applyPluginTable(next, table.nativeId, table.block);
  if (next === current) return;
  if (next.trim() === '') {
    rmSync(configPath, { force: true });
    return;
  }
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, next.endsWith('\n') ? next : `${next}\n`);
}

function applyPluginTable(toml: string, id: string, block: string | null): string {
  if (extractPluginTable(toml, id) === block) return toml;
  const header = pluginTableHeader(id);
  const idx = toml.indexOf(header);
  let removed = toml;
  if (idx !== -1) {
    const next = toml.indexOf('\n[', idx + header.length);
    const end = next === -1 ? toml.length : next;
    removed = toml.slice(0, idx) + toml.slice(end);
  }
  if (block === null) return removed;
  const base = removed.replace(/\s+$/u, '');
  return base.length === 0 ? `${block}\n` : `${base}\n\n${block}\n`;
}

function parseRollbackManifest(text: string): {
  readonly tables: readonly { readonly nativeId: string; readonly block: string | null }[];
  readonly installs: readonly (
    | { readonly nativeId: string; readonly existed: false; readonly slot: string | null; readonly versions: readonly string[] }
    | { readonly nativeId: string; readonly existed: true; readonly cachePath: string; readonly saved: string; readonly slot: string | null; readonly versions: readonly string[] }
  )[];
} {
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('codex rollback manifest is invalid');
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record['tables']) || !Array.isArray(record['installs'])) throw new Error('codex rollback manifest is invalid');
  const tables = record['tables'].map((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error('codex rollback manifest table is invalid');
    const table = item as Record<string, unknown>;
    if (typeof table['nativeId'] !== 'string' || (table['block'] !== null && typeof table['block'] !== 'string')) {
      throw new Error('codex rollback manifest table is invalid');
    }
    return { nativeId: table['nativeId'], block: table['block'] };
  });
  const installs = record['installs'].map((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error('codex rollback manifest install is invalid');
    const install = item as Record<string, unknown>;
    if (typeof install['nativeId'] !== 'string' || typeof install['existed'] !== 'boolean') throw new Error('codex rollback manifest install is invalid');
    const slot = parseRollbackSlot(install['slot']);
    const versions = parseRollbackVersions(install['versions']);
    if (!install['existed']) return { nativeId: install['nativeId'], existed: false as const, slot, versions };
    if (typeof install['cachePath'] !== 'string' || typeof install['saved'] !== 'string') throw new Error('codex rollback manifest install is invalid');
    return { nativeId: install['nativeId'], existed: true as const, cachePath: install['cachePath'], saved: install['saved'], slot, versions };
  });
  return { tables, installs };
}

function parseRollbackSlot(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0) throw new Error('codex rollback manifest install is invalid');
  return value;
}

function parseRollbackVersions(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error('codex rollback manifest install is invalid');
  return value;
}

function installationRecord(plugin: InstalledPlugin): TargetInstallationData {
  const owned = plugin.path === undefined ? null : readOwnership(plugin.path);
  const ownership = owned?.pluginId === plugin.id
    ? { kind: 'owned' as const, proof: 'created' as const, scopeId: `codex:${plugin.id}`, proofId: `marker:${plugin.id}` }
    : { kind: 'unmanaged' as const };
  if (plugin.path === undefined) {
    return {
      nativeId: plugin.id,
      packageName: plugin.name,
      ownership,
      presence: 'absent',
      enablement: plugin.enabled ? 'enabled' : 'disabled',
      activation: 'inactive',
      installedFingerprint: null,
      installedVersion: plugin.version ?? null,
      source: null,
      contentRoots: [],
    };
  }
  const installedFingerprint = fingerprintTree(plugin.path);
  return {
    nativeId: plugin.id,
    packageName: plugin.name,
    ownership,
    presence: 'present',
    enablement: plugin.enabled ? 'enabled' : 'disabled',
    activation: plugin.enabled ? 'active' : 'inactive',
    installedFingerprint,
    installedVersion: plugin.version ?? null,
    source: null,
    contentRoots: [{ label: 'plugin', path: plugin.path, fingerprint: installedFingerprint }],
  };
}

function nativeProjection(request: NativeProjectionRequest): NativeProjectionData {
  if (!('snapshot' in request) || request.operation !== 'update') {
    return { kind: 'requires-managed', reasonId: 'native-upgrade-update-only' };
  }
  const marketplace = marketplaceOf(request.snapshot.nativeId);
  if (marketplace === null) return { kind: 'requires-managed', reasonId: 'catalog-absent' };
  const binding = catalogBinding(marketplace);
  const git = request.snapshot.nativeGit;
  if (binding.kind === 'sha-bound' && git !== undefined && git.resolvedRevision === binding.sha && git.locator === binding.source) {
    return { kind: 'equivalent', proofId: `codex-marketplace:${binding.marketplace}:${binding.sha}` };
  }
  return { kind: 'requires-managed', reasonId: catalogRefusal(binding, git) };
}

function catalogBinding(marketplace: string): CodexCatalogBinding {
  const config = readConfigDocument();
  const entry = table(table(config?.['marketplaces'])?.[marketplace]);
  if (entry === null) return { kind: 'absent', marketplace };
  const ref = typeof entry['ref_name'] === 'string' ? entry['ref_name'] : null;
  const source = typeof entry['source'] === 'string' ? entry['source'] : null;
  const sha = ref?.toLowerCase() ?? '';
  if (source !== null && /^[0-9a-f]{40}$/u.test(sha)) return { kind: 'sha-bound', marketplace, sha, source };
  return { kind: 'unbound', marketplace };
}

function catalogRefusal(
  binding: CodexCatalogBinding,
  git: { readonly resolvedRevision: string; readonly locator: string } | undefined,
): string {
  switch (binding.kind) {
    case 'absent':
      return 'catalog-absent';
    case 'unbound':
      return 'catalog-unbound';
    case 'sha-bound':
      if (git === undefined || git.resolvedRevision !== binding.sha) return 'catalog-sha-mismatch';
      return 'catalog-source-mismatch';
    default: {
      const unreachable: never = binding;
      throw new Error(`unreachable Codex catalog binding: ${String(unreachable)}`);
    }
  }
}

function marketplaceOf(nativeId: string): string | null {
  const at = nativeId.indexOf('@');
  if (at <= 0 || at === nativeId.length - 1) return null;
  return nativeId.slice(at + 1);
}

function readConfigDocument(): Record<string, unknown> | null {
  if (!existsSync(configFile())) return null;
  try {
    const parsed: unknown = parseToml(readFileSync(configFile(), 'utf8'));
    return table(parsed);
  } catch {
    return null;
  }
}

function table(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function comparePrerelease(left: string, right: string): number {
  const l = left.split('.'); const r = right.split('.');
  for (let index = 0; index < Math.max(l.length, r.length); index += 1) {
    const a = l[index]; const b = r[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const an = /^\d+$/u.test(a); const bn = /^\d+$/u.test(b);
    if (an && bn) return Number(a) - Number(b);
    if (an) return -1;
    if (bn) return 1;
    return a.localeCompare(b);
  }
  return 0;
}
