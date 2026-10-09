/** Hermes portable package plus native discovery/command companion lifecycle. */
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddOptions, HostWriter, InstalledPlugin, PinOptions, PinOutcome } from '../host';
import type { PluginSource, ResolvedSource } from '../source';
import { projectPluginForHermes } from '../conversion';
import { hermesCommandCompanionId } from '../hermes-identity';
import { hermes, hermesPluginsDir } from './hermes';
import { hermesConfigPath, hermesRoot } from '../paths';
import { pinPluginMcpFiles } from '../mcp-write';

declare const Bun: { YAML: { parse(input: string): unknown; stringify(value: unknown): string } };

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
        updatePluginConfig([id, ...(hasCompanion ? [companionId] : [])], []);
        return 'unchanged';
      }
      const changes: Change[] = [];
      try {
        changes.push(replaceTarget(packageStage, target, root));
        if (hasCompanion) changes.push(replaceTarget(companionStage, companion, root));
        else if (existsSync(companion)) changes.push(removeTarget(companion, root));
        updatePluginConfig([id, ...(hasCompanion ? [companionId] : [])], hasCompanion ? [] : [companionId]);
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
      updatePluginConfig([], disable);
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
  const value: unknown = Bun.YAML.parse(readFileSync(manifest, 'utf8'));
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

function updatePluginConfig(enable: string[], disable: string[]): void {
  const configured = effectiveConfigPath();
  const actual = existsSync(configured) && lstatSync(configured).isSymbolicLink() ? realpathSync(configured) : configured;
  const exists = existsSync(actual); const original = exists ? readFileSync(actual, 'utf8') : '';
  let parsed: Record<string, unknown> = {};
  if (original.trim() !== '') {
    const value: unknown = Bun.YAML.parse(original);
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
  const next = Bun.YAML.stringify(parsed);
  const verified: unknown = Bun.YAML.parse(next);
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
