/** Hermes portable package plus native discovery/command companion lifecycle. */
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createCapabilityEvidenceProfile } from '../capability-evidence';
import { projectPluginForHermes } from '../conversion';
import { fingerprintTree } from '../fingerprint';
import type { AddOptions, HostWriter, InstalledPlugin, PinOptions, PinOutcome } from '../host';
import {
  HERMES_PORTABLE_SURFACE_PROBE,
  HERMES_PORTABLE_SURFACE_VERSION,
  decideHermesNativeUpdate,
  hermesCommandCompanionId,
  hermesNativeUpdateProof,
  hermesPluginDataNamespace,
} from '../hermes-identity';
import type {
  ActivationPreparationRequest,
  CleanupDisposition,
  CleanupReference,
  DurableLifecycleOperation,
  LifecycleHostDefinition,
  LifecycleMutationAction,
  LifecycleReadbackData,
  LifecycleTargetIdentity,
  NativeMutationScopeRequest,
  NativeProjectionRequest,
  RetentionObservation,
} from '../lifecycle-host';
import { createLifecycleHostAdapter, createTargetInventoryObservation } from '../lifecycle-runtime';
import { hermesConfigPath, hermesRoot } from '../paths';
import { CryptoHasher } from '../runtime';
import type { PluginSource, ResolvedSource } from '../source';
import { PACKAGE_SEMANTICS, type PackageSemantic } from '../semantic-inventory';
import { hermes, hermesInstanceIdentity, hermesPluginsDir, listHermesInstance } from './hermes';
import { pinPluginMcpFiles } from '../mcp-write';

import { yamlParse, yamlStringify } from '../yaml';


const MARKER = '.plgnz-install.json';
type Ownership = { source: string; pluginId: string; fingerprint: string };
type Change = { commit(): void; rollback(): void };

export const hermesWriter: HostWriter = {
  ...hermes,
  supportsAdoption: true,
  plannedNativeId: (plugin) => plugin.marketplace === undefined ? plugin.name : `${plugin.name}@${plugin.marketplace}`,
  async add(plugin: PluginSource, resolved: ResolvedSource, opts?: AddOptions): Promise<void | 'unchanged'> {
    const id = plugin.name;
    const ownershipId = plugin.marketplace === undefined ? id : `${id}@${plugin.marketplace}`;
    const companionId = hermesCommandCompanionId(id);
    assertId(id); assertId(companionId);
    const root = hermesPluginsDir();
    const target = join(root, id); const companion = join(root, companionId);
    assertManagedPath(root, target); assertManagedPath(root, companion);
    effectiveConfigPath();
    if (!opts?.dryRun) mkdirSync(root, { recursive: true });
    const stageRoot = mkdtempSync(join(opts?.dryRun ? tmpdir() : root, '.plgnz-hermes-stage-'));
    const packageStage = join(stageRoot, 'package'); const companionStage = join(stageRoot, 'commands');
    mkdirSync(packageStage); mkdirSync(companionStage);
    try {
      projectPluginForHermes(plugin.dir, packageStage, companionStage);
      validatePackage(packageStage, id);
      const hasCompanion = readdirSync(companionStage).length > 0;
      if (hasCompanion) validateCompanion(companionStage, companionId);
      const ownership: Ownership = { source: resolved.sourceUri, pluginId: ownershipId, fingerprint: plugin.contentFingerprint ?? '' };
      writeFileSync(join(packageStage, MARKER), JSON.stringify(ownership));
      if (hasCompanion) writeFileSync(join(companionStage, MARKER), JSON.stringify(ownership));
      assertReplaceable(target, packageStage, id, ownershipId, resolved.sourceUri, opts?.adoptExisting === true, validatePackage);
      if (hasCompanion) assertReplaceable(companion, companionStage, companionId, ownershipId, resolved.sourceUri, opts?.adoptExisting === true, validateCompanion);
      else if (existsSync(companion)) assertReplaceable(companion, undefined, companionId, ownershipId, resolved.sourceUri, opts?.adoptExisting === true, validateCompanion);
      const primaryMarker = readOwnership(target); const companionMarker = readOwnership(companion);
      const unchangedPrimary = primaryMarker?.pluginId === ownershipId && primaryMarker.fingerprint === ownership.fingerprint && sameTree(packageStage, target);
      const unchangedCompanion = hasCompanion
        ? companionMarker?.pluginId === ownershipId && companionMarker.fingerprint === ownership.fingerprint && sameTree(companionStage, companion)
        : !existsSync(companion);
      if (opts?.dryRun) return unchangedPrimary && unchangedCompanion ? 'unchanged' : undefined;
      if (unchangedPrimary && unchangedCompanion) {
        updatePluginConfig(effectiveConfigPath(), [id, ...(hasCompanion ? [companionId] : [])], []);
        return 'unchanged';
      }
      const changes: Change[] = [];
      try {
        changes.push(replaceTarget(packageStage, target, root));
        if (hasCompanion) changes.push(replaceTarget(companionStage, companion, root));
        else if (existsSync(companion)) changes.push(removeTarget(companion, root));
        updatePluginConfig(effectiveConfigPath(), [id, ...(hasCompanion ? [companionId] : [])], hasCompanion ? [] : [companionId]);
        for (const change of changes) change.commit();
      } catch (error) {
        for (const change of changes.reverse()) change.rollback();
        throw error;
      }
      return;
    } finally { rmSync(stageRoot, { recursive: true, force: true }); }
  },
  async pin(plugin: InstalledPlugin, opts?: PinOptions): Promise<PinOutcome> {
    return plugin.path === undefined ? { changes: [], refusals: [] } : pinPluginMcpFiles(plugin.path, [{ kind: 'spec', file: 'mcp.json' }], opts);
  },
  async remove(id: string): Promise<void> {
    const nativeId = nativePluginId(id);
    const root = hermesPluginsDir(); const target = join(root, nativeId); const companionId = hermesCommandCompanionId(nativeId); const companion = join(root, companionId);
    assertManagedPath(root, target); assertManagedPath(root, companion);
    effectiveConfigPath();
    const marker = readOwnership(target);
    if (marker === null || marker.pluginId !== id) return;
    const changes: Change[] = [];
    try {
      if (existsSync(target)) changes.push(removeTarget(target, root));
      const companionMarker = readOwnership(companion); const disable = [nativeId];
      if (companionMarker !== null && companionMarker.pluginId === marker.pluginId && companionMarker.source === marker.source && companionMarker.fingerprint === marker.fingerprint) { changes.push(removeTarget(companion, root)); disable.push(companionId); }
      else if (!existsSync(companion)) disable.push(companionId);
      updatePluginConfig(effectiveConfigPath(), [], disable);
      for (const change of changes) change.commit();
    } catch (error) {
      for (const change of changes.reverse()) change.rollback();
      throw error;
    }
  },
};

function assertReplaceable(target: string, stage: string | undefined, expected: string, ownershipId: string, source: string, adopt: boolean, validate: (root: string, expected: string) => void): void {
  if (!existsSync(target)) return;
  const marker = readOwnership(target);
  if (marker !== null) {
    const packageId = expected.replace(/\.plgnz-commands$/u, '');
    if (marker.source !== source || !matches(marker.pluginId, packageId, ownershipId)) throw new Error(`Hermes plugin ${expected} belongs to another source; refusing to replace it`);
    return;
  }
  if (stage !== undefined && sameTree(stage, target)) return;
  if (!adopt) throw new Error(`Hermes plugin ${expected} is unowned and differs from the staged representation; pass --adopt-existing to take ownership explicitly`);
  validate(target, expected);
}

function validatePackage(root: string, expected: string): void {
  assertTree(root);
  const manifest = join(root, 'plugin.json');
  if (!existsSync(manifest)) throw new Error('Hermes stage has no Agent Plugins manifest');
  let value: unknown;
  try { value = JSON.parse(readFileSync(manifest, 'utf8')); } catch (error) { throw new Error(`invalid Hermes plugin manifest: ${(error as Error).message}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value as Record<string, unknown>).name !== expected) throw new Error(`Hermes manifest identity does not match ${expected}`);
  if ((value as Record<string, unknown>)['$schema'] !== 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json') throw new Error(`Hermes portable manifest must use the Agent Plugins v1 schema: ${manifest}`);
}

function validateCompanion(root: string, expected: string): void {
  assertTree(root);
  const manifest = join(root, 'plugin.yaml');
  if (!existsSync(manifest) || !existsSync(join(root, '__init__.py'))) throw new Error(`Hermes native companion is incomplete: ${root}`);
  const value: unknown = yamlParse(readFileSync(manifest, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value as Record<string, unknown>).name !== expected) throw new Error(`Hermes companion identity does not match ${expected}`);
}

function readOwnership(target: string): Ownership | null {
  const file = join(target, MARKER); if (!existsSync(file)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('marker must be an object');
    const row = value as Record<string, unknown>;
    if (typeof row.source !== 'string' || typeof row.pluginId !== 'string' || typeof row.fingerprint !== 'string') throw new Error('marker fields are invalid');
    return row as Ownership;
  } catch (error) { throw new Error(`invalid Hermes ownership marker: ${file} (${(error as Error).message})`); }
}

function replaceTarget(stage: string, target: string, root: string): Change {
  if (!existsSync(target)) { renameSync(stage, target); return { commit: () => {}, rollback: () => rmSync(target, { recursive: true, force: true }) }; }
  const backupRoot = mkdtempSync(join(root, '.plgnz-hermes-backup-')); const backup = join(backupRoot, 'previous');
  renameSync(target, backup);
  try { renameSync(stage, target); } catch (error) { renameSync(backup, target); rmSync(backupRoot, { recursive: true, force: true }); throw error; }
  return { commit: () => rmSync(backupRoot, { recursive: true, force: true }), rollback: () => { rmSync(target, { recursive: true, force: true }); renameSync(backup, target); rmSync(backupRoot, { recursive: true, force: true }); } };
}

function removeTarget(target: string, root: string): Change {
  const backupRoot = mkdtempSync(join(root, '.plgnz-hermes-remove-')); const backup = join(backupRoot, 'previous');
  renameSync(target, backup);
  return { commit: () => rmSync(backupRoot, { recursive: true, force: true }), rollback: () => { if (!existsSync(target)) renameSync(backup, target); rmSync(backupRoot, { recursive: true, force: true }); } };
}

function updatePluginConfig(configured: string, enable: string[], disable: string[]): void {
  const actual = existsSync(configured) && lstatSync(configured).isSymbolicLink() ? realpathSync(configured) : configured;
  const exists = existsSync(actual); const original = exists ? readFileSync(actual, 'utf8') : '';
  let parsed: Record<string, unknown> = {};
  if (original.trim() !== '') {
    const value: unknown = yamlParse(original);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Hermes config is not a mapping: ${configured}`);
    parsed = value as Record<string, unknown>;
  }
  const pluginsValue = parsed['plugins'];
  if (pluginsValue !== undefined && pluginsValue !== null && (typeof pluginsValue !== 'object' || Array.isArray(pluginsValue))) throw new Error(`Hermes plugins config is not a mapping: ${configured}`);
  const plugins = (pluginsValue ?? {}) as Record<string, unknown>;
  const list = (key: 'enabled' | 'disabled'): string[] => {
    const value = plugins[key];
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(`Hermes plugins.${key} is not a string list: ${configured}`);
    return [...new Set(value as string[])];
  };
  const enabled = new Set(list('enabled')); const disabled = new Set(list('disabled'));
  for (const id of enable) { enabled.add(id); disabled.delete(id); }
  for (const id of disable) { enabled.delete(id); disabled.add(id); }
  plugins['enabled'] = [...enabled].sort(); plugins['disabled'] = [...disabled].sort(); parsed['plugins'] = plugins;
  const next = yamlStringify(parsed);
  const verified: unknown = yamlParse(next);
  if (!verified || typeof verified !== 'object' || Array.isArray(verified)) throw new Error(`Hermes config serialization failed: ${configured}`);
  const verifiedPlugins = (verified as Record<string, unknown>)['plugins'];
  if (!verifiedPlugins || typeof verifiedPlugins !== 'object' || Array.isArray(verifiedPlugins) ||
      JSON.stringify((verifiedPlugins as Record<string, unknown>)['enabled']) !== JSON.stringify(plugins['enabled']) ||
      JSON.stringify((verifiedPlugins as Record<string, unknown>)['disabled']) !== JSON.stringify(plugins['disabled'])) {
    throw new Error(`Hermes config serialization changed plugin activation: ${configured}`);
  }
  mkdirSync(dirname(actual), { recursive: true });
  const temp = join(dirname(actual), `.plgnz-hermes-config-${Date.now()}-${Math.random().toString(16).slice(2)}.yaml`);
  try {
    writeFileSync(temp, next);
    if (exists) chmodSync(temp, (statSync(actual) as unknown as { mode: number }).mode & 0o777);
    renameSync(temp, actual);
  } finally { rmSync(temp, { force: true }); }
}

function effectiveConfigPath(): string {
  const native = resolve(join(hermesRoot(), 'config.yaml'));
  const configured = resolve(hermesConfigPath());
  if (native === configured) return configured;
  if (!existsSync(native) || !existsSync(configured)) throw new Error(`Hermes only reads ${native}; configured path ${configured} must already resolve to the same file`);
  const nativeReal = realpathSync(native); const configuredReal = realpathSync(configured);
  if (nativeReal === configuredReal) return configured;
  throw new Error(`Hermes only reads ${native}; configured path ${configured} is a different file`);
}

function sameTree(left: string, right: string): boolean {
  if (!existsSync(right)) return false;
  const list = (root: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string, prefix: string): void => { for (const name of readdirSync(dir).sort()) { if (name === MARKER) continue; const path = join(dir, name), relative = prefix ? `${prefix}/${name}` : name, stat = lstatSync(path); if (stat.isSymbolicLink()) throw new Error(`Hermes plugin contains symlink: ${path}`); if (stat.isDirectory()) walk(path, relative); else if (stat.isFile()) out.push(`${relative}:${Array.from(readBytes(path)).join(',')}`); else throw new Error(`Hermes plugin contains unsupported file: ${path}`); } };
    walk(root, ''); return out;
  };
  return JSON.stringify(list(left)) === JSON.stringify(list(right));
}

function readBytes(path: string): Uint8Array { return (readFileSync as unknown as (file: string) => Uint8Array)(path); }
function assertTree(root: string): void { const stat = lstatSync(root); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Hermes plugin source is not a real directory: ${root}`); for (const name of readdirSync(root)) { if (name === MARKER) continue; const path = join(root, name), entry = lstatSync(path); if (entry.isSymbolicLink()) throw new Error(`Hermes plugin contains symlink: ${path}`); if (entry.isDirectory()) assertTree(path); else if (!entry.isFile()) throw new Error(`Hermes plugin contains unsupported entry: ${path}`); } }
function assertManagedPath(root: string, target: string): void { const base = resolve(root), selected = resolve(target); if (selected !== base && !selected.startsWith(`${base}/`)) throw new Error(`Hermes managed path escapes its store: ${target}`); let current = base; for (const part of selected.slice(base.length).split('/').filter(Boolean)) { if (existsSync(current)) { const stat = lstatSync(current); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Hermes managed path component is unsafe: ${current}`); } current = join(current, part); } if (existsSync(current)) { const stat = lstatSync(current); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Hermes managed path component is unsafe: ${current}`); } }
function assertId(id: string): void { if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(id)) throw new Error(`unsafe Hermes plugin identity: ${id}`); }
function nativePluginId(logicalId: string): string {
  const parts = logicalId.split('@');
  if (parts.length > 2 || parts[0] === undefined || parts[0] === '') throw new Error(`unsafe Hermes plugin identity: ${logicalId}`);
  assertId(parts[0]);
  if (parts[1] !== undefined) assertId(parts[1]);
  return parts[0];
}
function matches(marker: string, id: string, ownership: string): boolean { return marker === id || marker === ownership; }

const EFFECTIVE = { requirement: 'none' as const, status: 'effective' as const };
const HERMES_SUPPORTED = new Set<PackageSemantic>([
  'ordinary-skills', 'mcp', 'commands', 'model-invocation-control', 'auto-update-control', 'resources',
  'retirement', 'retention-safety', 'readback', 'rollback', 'activation-reload', 'reversible-disable',
]);

const hermesManagedProfile = createCapabilityEvidenceProfile({
  host: 'hermes',
  detectedVersion: HERMES_PORTABLE_SURFACE_VERSION,
  sourceTypes: ['local', 'git'],
  operations: ['install', 'update', 'disable', 'retire'],
  route: 'managed',
  operationStatus: 'supported',
  semantics: Object.fromEntries(PACKAGE_SEMANTICS.map(semantic => [semantic, HERMES_SUPPORTED.has(semantic) ? 'supported' : 'unsupported'])) as Record<PackageSemantic, 'supported' | 'unsupported'>,
  evidence: [
    'docs/evidence/hermes-native-loader-c0d7294-20260923.json',
    'docs/hosts/hermes.md',
    'docs/research/native-plugin-update-capabilities-2026-10-09.md',
  ],
});

type HermesStore = { readonly root: string; readonly configPath: string; readonly pluginsDir: string };
type ConfigSnapshot = { readonly existed: boolean; readonly text: string; readonly mode: number | null };
type Marker = Ownership & { sourceType?: 'local' | 'git'; sourceRevision?: string; sourceLocator?: string | null; scopeId?: string };

function storeFor(target: LifecycleTargetIdentity): HermesStore {
  const identity = hermesInstanceIdentity({ kind: target.kind, instance: target.instance, ...(target.context === undefined ? {} : { context: { ...target.context } }) });
  return { root: identity.root, configPath: resolveInstanceConfig(identity.root, identity.configPath), pluginsDir: join(identity.root, 'plugins') };
}

function resolveInstanceConfig(root: string, configPath: string): string {
  const native = resolve(join(root, 'config.yaml'));
  const configured = resolve(configPath);
  if (native === configured) return configured;
  if (!existsSync(native) || !existsSync(configured)) throw new Error(`Hermes only reads ${native}; configured path ${configured} must already resolve to the same file`);
  if (realpathSync(native) === realpathSync(configured)) return configured;
  throw new Error(`Hermes only reads ${native}; configured path ${configured} is a different file`);
}

function actualConfig(configPath: string): string {
  return existsSync(configPath) && lstatSync(configPath).isSymbolicLink() ? realpathSync(configPath) : configPath;
}

function workDir(store: HermesStore, attemptId: string, operationId: string): string {
  return join(store.root, '.plgnz-lifecycle', encodeURIComponent(attemptId), encodeURIComponent(operationId));
}

function packagePaths(store: HermesStore, packageName: string): { packageDir: string; companionId: string; companionDir: string } {
  assertId(packageName);
  const companionId = hermesCommandCompanionId(packageName);
  assertId(companionId);
  return { packageDir: join(store.pluginsDir, packageName), companionId, companionDir: join(store.pluginsDir, companionId) };
}

function assertPackageIdentity(packageName: string, nativeId: string): void {
  const companionId = hermesCommandCompanionId(packageName);
  assertId(packageName);
  assertId(companionId);
  if (nativeId === packageName) return;
  if (!nativeId.startsWith(`${packageName}@`)) throw new Error(`Hermes native id does not match package ${packageName}`);
  const market = nativeId.slice(packageName.length + 1);
  if (market === '' || market.includes('@')) throw new Error(`Hermes native id does not match package ${packageName}`);
  assertId(market);
}

function readMarker(target: string): Marker | null {
  const marker = readOwnership(target);
  if (marker === null) return null;
  const value = JSON.parse(readFileSync(join(target, MARKER), 'utf8')) as Record<string, unknown>;
  const sourceType = value.sourceType;
  const sourceRevision = value.sourceRevision;
  const sourceLocator = value.sourceLocator;
  const scopeId = value.scopeId;
  if (sourceType !== undefined && sourceType !== 'local' && sourceType !== 'git') throw new Error(`invalid Hermes ownership marker: ${join(target, MARKER)}`);
  if (sourceRevision !== undefined && typeof sourceRevision !== 'string') throw new Error(`invalid Hermes ownership marker: ${join(target, MARKER)}`);
  if (sourceLocator !== undefined && sourceLocator !== null && typeof sourceLocator !== 'string') throw new Error(`invalid Hermes ownership marker: ${join(target, MARKER)}`);
  if (scopeId !== undefined && typeof scopeId !== 'string') throw new Error(`invalid Hermes ownership marker: ${join(target, MARKER)}`);
  return {
    ...marker,
    ...(sourceType === 'local' || sourceType === 'git' ? { sourceType } : {}),
    ...(typeof sourceRevision === 'string' ? { sourceRevision } : {}),
    ...(sourceLocator === null || typeof sourceLocator === 'string' ? { sourceLocator } : {}),
    ...(typeof scopeId === 'string' ? { scopeId } : {}),
  };
}

function assertLifecycleOwned(target: string, nativeId: string, source: string): void {
  if (!existsSync(target)) return;
  const marker = readMarker(target);
  if (marker === null) throw new Error(`Hermes plugin ${nativeId} is unowned and differs from the staged representation; pass --adopt-existing to take ownership explicitly`);
  if (marker.pluginId !== nativeId || marker.source !== source) throw new Error(`Hermes plugin ${nativeId} belongs to another source; refusing to replace it`);
}

function copyReplace(stage: string, target: string, root: string): Change {
  const scratch = mkdtempSync(join(root, '.plgnz-hermes-copy-'));
  const copy = join(scratch, 'copy');
  cpSync(stage, copy, { recursive: true });
  const swapped = replaceTarget(copy, target, root);
  return {
    commit() { swapped.commit(); rmSync(scratch, { recursive: true, force: true }); },
    rollback() { swapped.rollback(); rmSync(scratch, { recursive: true, force: true }); },
  };
}

function flagSet(configPath: string, key: 'enabled' | 'disabled'): Set<string> {
  const actual = actualConfig(configPath);
  if (!existsSync(actual)) return new Set();
  const parsed: unknown = yamlParse(readFileSync(actual, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Hermes config is not a mapping: ${configPath}`);
  const plugins = (parsed as Record<string, unknown>)['plugins'];
  if (plugins === undefined || plugins === null) return new Set();
  if (typeof plugins !== 'object' || Array.isArray(plugins)) throw new Error(`Hermes plugins config is not a mapping: ${configPath}`);
  const values = (plugins as Record<string, unknown>)[key];
  if (values === undefined || values === null) return new Set();
  if (!Array.isArray(values) || values.some(item => typeof item !== 'string')) throw new Error(`Hermes plugins.${key} is not a string list: ${configPath}`);
  return new Set(values as string[]);
}

function activationMatches(configPath: string, packageName: string, companionId: string, hasCompanion: boolean): boolean {
  const enabled = flagSet(configPath, 'enabled');
  const disabled = flagSet(configPath, 'disabled');
  const packageOn = enabled.has(packageName) && !disabled.has(packageName);
  const companionOn = enabled.has(companionId) && !disabled.has(companionId);
  return packageOn && companionOn === hasCompanion;
}

function entryValue(configPath: string, packageName: string): unknown {
  const actual = actualConfig(configPath);
  if (!existsSync(actual)) return undefined;
  const parsed: unknown = yamlParse(readFileSync(actual, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const plugins = (parsed as Record<string, unknown>)['plugins'];
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return undefined;
  const entries = (plugins as Record<string, unknown>)['entries'];
  if (entries === undefined || entries === null) return undefined;
  if (typeof entries !== 'object' || Array.isArray(entries)) throw new Error(`Hermes plugins.entries is not a mapping: ${configPath}`);
  if (!Object.hasOwn(entries, packageName)) return undefined;
  return (entries as Record<string, unknown>)[packageName];
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonicalValue(record[key])]));
  }
  return value;
}

function sha256(value: string): string {
  const hash = new CryptoHasher('sha256');
  hash.update(value);
  return hash.digest('hex');
}

function retentionFor(store: HermesStore, packageName: string): RetentionObservation {
  const dataDir = join(store.root, 'plugin-data', hermesPluginDataNamespace(packageName));
  const pluginData = existsSync(dataDir) && lstatSync(dataDir).isDirectory()
    ? { state: 'present' as const, fingerprint: fingerprintTree(dataDir) }
    : { state: 'absent' as const, fingerprint: null };
  const entry = entryValue(store.configPath, packageName);
  const inactiveMetadata = entry === undefined
    ? { state: 'absent' as const, fingerprint: null }
    : { state: 'present' as const, fingerprint: sha256(JSON.stringify(canonicalValue(entry))) };
  return { pluginData, inactiveMetadata };
}

function atomicFingerprint(packageDir: string, companionDir: string | undefined): string {
  const temp = mkdtempSync(join(tmpdir(), 'plgnz-hermes-atomic-'));
  try {
    cpSync(packageDir, join(temp, 'package'), { recursive: true });
    if (companionDir !== undefined && existsSync(companionDir)) cpSync(companionDir, join(temp, 'commands'), { recursive: true });
    return fingerprintTree(temp);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

function readConfigSnapshot(configPath: string): ConfigSnapshot {
  const actual = actualConfig(configPath);
  if (!existsSync(actual)) return { existed: false, text: '', mode: null };
  return { existed: true, text: readFileSync(actual, 'utf8'), mode: (statSync(actual) as unknown as { mode: number }).mode & 0o777 };
}

function writeConfigSnapshot(configPath: string, snapshot: ConfigSnapshot): void {
  const actual = actualConfig(configPath);
  if (!snapshot.existed) { if (existsSync(actual)) rmSync(actual); return; }
  mkdirSync(dirname(actual), { recursive: true });
  const temp = join(dirname(actual), `.plgnz-hermes-rollback-${Date.now()}.yaml`);
  try {
    writeFileSync(temp, snapshot.text);
    if (snapshot.mode !== null) chmodSync(temp, snapshot.mode);
    renameSync(temp, actual);
  } finally { rmSync(temp, { force: true }); }
}

function saveRollback(store: HermesStore, reference: string, packageDir: string, companionDir: string, prior: LifecycleReadbackData): void {
  rmSync(reference, { recursive: true, force: true });
  mkdirSync(reference, { recursive: true });
  writeFileSync(join(reference, 'config.json'), JSON.stringify(readConfigSnapshot(store.configPath)));
  writeFileSync(join(reference, 'prior.json'), JSON.stringify(prior));
  if (existsSync(packageDir)) cpSync(packageDir, join(reference, 'package'), { recursive: true });
  if (existsSync(companionDir)) cpSync(companionDir, join(reference, 'commands'), { recursive: true });
}

function restoreRollback(store: HermesStore, reference: string, packageDir: string, companionDir: string): void {
  const snapshot = JSON.parse(readFileSync(join(reference, 'config.json'), 'utf8')) as ConfigSnapshot;
  rmSync(packageDir, { recursive: true, force: true });
  rmSync(companionDir, { recursive: true, force: true });
  if (existsSync(join(reference, 'package'))) cpSync(join(reference, 'package'), packageDir, { recursive: true });
  if (existsSync(join(reference, 'commands'))) cpSync(join(reference, 'commands'), companionDir, { recursive: true });
  writeConfigSnapshot(store.configPath, snapshot);
}

function sourceIdentity(marker: Marker | null): { type: 'local' | 'git'; immutableRevision: string; locator: string | null } | null {
  if (marker?.sourceType === 'local' && marker.sourceRevision !== undefined) return { type: 'local', immutableRevision: marker.sourceRevision, locator: null };
  if (marker?.sourceType === 'git' && marker.sourceRevision !== undefined && typeof marker.sourceLocator === 'string') return { type: 'git', immutableRevision: marker.sourceRevision, locator: marker.sourceLocator };
  return null;
}

function inspect(store: HermesStore, nativeId: string, packageName: string, routeWhenAbsent: LifecycleReadbackData['route']): LifecycleReadbackData {
  const installed = listHermesInstance(store.root, store.configPath).find(plugin => plugin.id === nativeId);
  const present = installed?.path !== undefined;
  const disabled = flagSet(store.configPath, 'disabled');
  const contentRoots = present && installed?.contentRoots !== undefined
    ? Object.entries(installed.contentRoots).map(([label, path]) => ({ label, path, fingerprint: fingerprintTree(path) }))
    : [];
  const companion = installed?.contentRoots?.['commands'];
  return {
    adapterId: 'hermes',
    target: { kind: 'hermes', instance: '', context: { root: store.root, configPath: store.configPath } },
    scopeId: '',
    packageName,
    nativeId,
    route: present ? 'managed' : routeWhenAbsent,
    presence: present ? 'present' : 'absent',
    enablement: present ? (installed?.enabled === true ? 'enabled' : 'disabled') : (disabled.has(packageName) ? 'disabled' : 'not-applicable'),
    activation: present && installed?.enabled === true ? 'active' : 'inactive',
    transition: EFFECTIVE,
    installedFingerprint: present && installed?.path !== undefined ? atomicFingerprint(installed.path, companion) : null,
    contentRoots,
    retention: retentionFor(store, packageName),
  };
}

function withIdentity(base: LifecycleReadbackData, target: LifecycleTargetIdentity, scopeId: string, packageName: string, nativeId: string): LifecycleReadbackData {
  return { ...base, target, scopeId, packageName, nativeId };
}

function retirementAction(action: LifecycleMutationAction): boolean {
  return action === 'remove' || action === 'retire-orphan';
}

function markerBody(input: { nativeId: string; fingerprint: string; sourceType: 'local' | 'git'; revision: string; locator: string | null; scopeId: string }): Marker {
  return { source: input.locator ?? input.revision, pluginId: input.nativeId, fingerprint: input.fingerprint, sourceType: input.sourceType, sourceRevision: input.revision, sourceLocator: input.locator, scopeId: input.scopeId };
}

const hermesLifecycleDefinition: LifecycleHostDefinition = {
  id: 'hermes',
  evidenceProfiles: [hermesManagedProfile],
  async probeVersion(target) {
    try {
      const store = storeFor(target);
      if (!existsSync(actualConfig(store.configPath))) return { kind: 'unknown' };
      return { kind: 'detected', version: HERMES_PORTABLE_SURFACE_VERSION, probeId: HERMES_PORTABLE_SURFACE_PROBE };
    } catch { return { kind: 'unknown' }; }
  },
  async observeTarget(target) {
    const store = storeFor(target);
    const installations = listHermesInstance(store.root, store.configPath).map(plugin => {
      const packageDir = plugin.path ?? join(store.pluginsDir, plugin.name);
      const marker = readMarker(packageDir);
      const companion = plugin.contentRoots?.['commands'];
      const contentRoots = Object.entries(plugin.contentRoots ?? { package: packageDir }).map(([label, path]) => ({ label, path, fingerprint: fingerprintTree(path) }));
      return {
        nativeId: plugin.id,
        packageName: plugin.name,
        ownership: marker === null
          ? { kind: 'unmanaged' as const }
          : { kind: 'owned' as const, proof: 'created' as const, scopeId: marker.scopeId ?? 'legacy', proofId: `hermes:${marker.pluginId}` },
        presence: 'present' as const,
        enablement: plugin.enabled === true ? 'enabled' as const : 'disabled' as const,
        activation: plugin.enabled === true ? 'active' as const : 'inactive' as const,
        installedFingerprint: atomicFingerprint(packageDir, companion),
        installedVersion: plugin.version ?? null,
        source: sourceIdentity(marker),
        contentRoots,
      };
    });
    return { target, installations };
  },
  async observeNativeMutationScope(request: NativeMutationScopeRequest) {
    assertPackageIdentity(request.packageName, request.nativeId);
    return { kind: 'bounded', mode: 'exact-package', affectedNativeIds: [request.nativeId] };
  },
  async observeNativeProjection(_request: NativeProjectionRequest) {
    const decision = decideHermesNativeUpdate(hermesNativeUpdateProof);
    switch (decision.route) {
      case 'managed': return { kind: 'requires-managed', reasonId: decision.refusedGate };
      case 'native': return { kind: 'equivalent', proofId: 'hermes-native-update-gates' };
      default: { const unreachable: never = decision; return unreachable; }
    }
  },
  async revalidateTargetPrecondition(handle) {
    const version = await hermesLifecycleDefinition.probeVersion(handle.target);
    const data = await hermesLifecycleDefinition.observeTarget(handle.target);
    return { version, targetObservationId: createTargetInventoryObservation('hermes', data).observationId };
  },
  async stageActivation(request: ActivationPreparationRequest<'managed' | 'native'>) {
    const store = storeFor(request.snapshot.target);
    assertPackageIdentity(request.snapshot.packageName, request.snapshot.nativeId);
    const stagingRoot = join(workDir(store, request.snapshot.attemptId, request.snapshot.operationId), 'stage');
    rmSync(stagingRoot, { recursive: true, force: true });
    const packageStage = join(stagingRoot, 'package');
    const companionStage = join(stagingRoot, 'commands');
    mkdirSync(packageStage, { recursive: true });
    projectPluginForHermes(request.snapshot.packageRoot, packageStage, companionStage);
    if (existsSync(companionStage) && readdirSync(companionStage).length === 0) rmSync(companionStage, { recursive: true });
    const hasCompanion = existsSync(companionStage);
    validatePackage(packageStage, request.snapshot.packageName);
    if (hasCompanion) validateCompanion(companionStage, hermesCommandCompanionId(request.snapshot.packageName));
    const marker = markerBody({
      nativeId: request.snapshot.nativeId,
      fingerprint: request.snapshot.packageFingerprint,
      sourceType: request.snapshot.sourceType,
      revision: request.snapshot.immutableRevision,
      locator: request.snapshot.nativeGit?.locator ?? null,
      scopeId: request.snapshot.scopeId,
    });
    writeFileSync(join(packageStage, MARKER), JSON.stringify(marker));
    if (hasCompanion) writeFileSync(join(companionStage, MARKER), JSON.stringify(marker));
    return { stagingId: `${request.snapshot.attemptId}:${request.snapshot.operationId}`, stagingRoot };
  },
  async applyLifecycleDirectives() { return []; },
  async applyPins(projection) {
    if (projection.pins.length === 0) return [];
    const mcp = join(projection.stagingRoot, 'package', 'mcp.json');
    if (!existsSync(mcp)) throw new Error(`Hermes pin set has no mcp.json: ${mcp}`);
    const value = JSON.parse(readFileSync(mcp, 'utf8')) as { mcpServers?: Record<string, { command?: string }> };
    const servers = value.mcpServers ?? {};
    for (const pin of projection.pins) {
      const server = servers[pin.server];
      if (server === undefined || typeof server.command !== 'string') throw new Error(`Hermes pin server is not in mcp.json: ${pin.server}`);
      server.command = pin.executable;
    }
    writeFileSync(mcp, `${JSON.stringify(value, null, 2)}\n`);
    return projection.pins.map(pin => pin.server);
  },
  async captureActivationPreparation(projection, projectedFingerprint) {
    const store = storeFor(projection.target);
    const paths = packagePaths(store, projection.packageName);
    const prior = withIdentity(inspect(store, projection.nativeId, projection.packageName, 'none'), projection.target, projection.scopeId, projection.packageName, projection.nativeId);
    const hasCompanion = existsSync(join(projection.stagingRoot, 'commands'));
    const contentRoots = [{ label: 'package', path: paths.packageDir, fingerprint: fingerprintTree(join(projection.stagingRoot, 'package')) }];
    if (hasCompanion) contentRoots.push({ label: 'commands', path: paths.companionDir, fingerprint: fingerprintTree(join(projection.stagingRoot, 'commands')) });
    const rollbackReference = join(workDir(store, projection.attemptId, projection.operationId), 'rollback');
    saveRollback(store, rollbackReference, paths.packageDir, paths.companionDir, prior);
    return {
      prior,
      expected: { ...prior, route: projection.route, presence: 'present', enablement: 'enabled', activation: 'active', transition: EFFECTIVE, installedFingerprint: projectedFingerprint, contentRoots, retention: prior.retention },
      rollbackReference,
      rollbackCoverageOperationIds: projection.affectedOperationIds,
    };
  },
  async captureDisablePreparation(request) {
    const store = storeFor(request.activation.target);
    const paths = packagePaths(store, request.activation.packageName);
    const prior = withIdentity(inspect(store, request.activation.nativeId, request.activation.packageName, 'none'), request.activation.target, request.activation.scopeId, request.activation.packageName, request.activation.nativeId);
    const rollbackReference = join(workDir(store, request.attemptId, request.operationId), 'rollback');
    saveRollback(store, rollbackReference, paths.packageDir, paths.companionDir, prior);
    return { prior, rollbackReference, rollbackCoverageOperationIds: request.selection.affectedOperationIds, transition: EFFECTIVE };
  },
  async captureRetirementPreparation(request) {
    const store = storeFor(request.activation.target);
    const paths = packagePaths(store, request.activation.packageName);
    const prior = withIdentity(inspect(store, request.activation.nativeId, request.activation.packageName, 'none'), request.activation.target, request.activation.scopeId, request.activation.packageName, request.activation.nativeId);
    const rollbackReference = join(workDir(store, request.attemptId, request.operationId), 'rollback');
    saveRollback(store, rollbackReference, paths.packageDir, paths.companionDir, prior);
    return { prior, rollbackReference, rollbackCoverageOperationIds: request.selection.affectedOperationIds, transition: EFFECTIVE };
  },
  async apply(prepared) {
    const store = storeFor(prepared.handle.target);
    const paths = packagePaths(store, prepared.handle.packageName);
    assertPackageIdentity(prepared.handle.packageName, prepared.handle.nativeId);
    assertManagedPath(store.pluginsDir, paths.packageDir);
    assertManagedPath(store.pluginsDir, paths.companionDir);
    const stagedPackage = join(prepared.stagingRoot, 'package');
    const stagedCompanion = join(prepared.stagingRoot, 'commands');
    const hasCompanion = existsSync(stagedCompanion);
    const source = prepared.handle.sourceLocator ?? prepared.handle.sourceRevision;
    assertLifecycleOwned(paths.packageDir, prepared.handle.nativeId, source);
    if (hasCompanion) assertLifecycleOwned(paths.companionDir, prepared.handle.nativeId, source);
    else if (existsSync(paths.companionDir)) assertLifecycleOwned(paths.companionDir, prepared.handle.nativeId, source);
    mkdirSync(store.pluginsDir, { recursive: true });
    const unchanged = existsSync(paths.packageDir)
      && atomicFingerprint(paths.packageDir, hasCompanion ? paths.companionDir : undefined) === fingerprintTree(prepared.stagingRoot)
      && activationMatches(store.configPath, prepared.handle.packageName, paths.companionId, hasCompanion);
    if (unchanged) return { receiptId: `apply:${prepared.handle.attemptId}:${prepared.handle.operationId}`, changed: false };
    const changes: Change[] = [];
    try {
      changes.push(copyReplace(stagedPackage, paths.packageDir, store.pluginsDir));
      if (hasCompanion) changes.push(copyReplace(stagedCompanion, paths.companionDir, store.pluginsDir));
      else if (existsSync(paths.companionDir)) changes.push(removeTarget(paths.companionDir, store.pluginsDir));
      updatePluginConfig(store.configPath, [prepared.handle.packageName, ...(hasCompanion ? [paths.companionId] : [])], hasCompanion ? [] : [paths.companionId]);
      for (const change of changes) change.commit();
    } catch (error) {
      for (const change of [...changes].reverse()) change.rollback();
      throw error;
    }
    return { receiptId: `apply:${prepared.handle.attemptId}:${prepared.handle.operationId}`, changed: true };
  },
  async disable(prepared) {
    const store = storeFor(prepared.handle.target);
    const paths = packagePaths(store, prepared.handle.packageName);
    updatePluginConfig(store.configPath, [], [prepared.handle.packageName, paths.companionId]);
    return { receiptId: `disable:${prepared.handle.attemptId}:${prepared.handle.operationId}`, changed: true };
  },
  async retire(prepared) {
    const store = storeFor(prepared.handle.target);
    const paths = packagePaths(store, prepared.handle.packageName);
    assertManagedPath(store.pluginsDir, paths.packageDir);
    assertManagedPath(store.pluginsDir, paths.companionDir);
    const source = prepared.handle.sourceLocator ?? prepared.handle.sourceRevision;
    const changes: Change[] = [];
    try {
      if (existsSync(paths.packageDir)) {
        assertLifecycleOwned(paths.packageDir, prepared.handle.nativeId, source);
        changes.push(removeTarget(paths.packageDir, store.pluginsDir));
      }
      if (existsSync(paths.companionDir)) {
        const marker = readMarker(paths.companionDir);
        if (marker !== null && marker.pluginId === prepared.handle.nativeId && marker.source === source) changes.push(removeTarget(paths.companionDir, store.pluginsDir));
      }
      updatePluginConfig(store.configPath, [], [prepared.handle.packageName, paths.companionId]);
      for (const change of changes) change.commit();
    } catch (error) {
      for (const change of [...changes].reverse()) change.rollback();
      throw error;
    }
    return { receiptId: `retire:${prepared.handle.attemptId}:${prepared.handle.operationId}`, changed: true };
  },
  async readback(handle) {
    const store = storeFor(handle.target);
    const absentRoute = retirementAction(handle.action) ? handle.route : 'none';
    return withIdentity(inspect(store, handle.nativeId, handle.packageName, absentRoute), handle.target, handle.scopeId, handle.packageName, handle.nativeId);
  },
  async rollback(handle) {
    const store = storeFor(handle.target);
    const paths = packagePaths(store, handle.packageName);
    restoreRollback(store, handle.rollbackReference, paths.packageDir, paths.companionDir);
    return { receiptId: `rollback:${handle.attemptId}:${handle.operationId}`, changed: true };
  },
  async cleanup(reference: CleanupReference, _disposition: CleanupDisposition) {
    const store = storeFor(reference.target);
    rmSync(workDir(store, reference.attemptId, reference.operationId), { recursive: true, force: true });
    return { cleanupId: `cleanup:${reference.attemptId}:${reference.operationId}`, completed: true };
  },
};

export const hermesLifecycle = createLifecycleHostAdapter(hermesLifecycleDefinition);
