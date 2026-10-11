/** Cursor's native local-plugin lifecycle writer. */
import { accessSync, constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createCapabilityEvidenceProfile } from '../capability-evidence';
import { discoverCommands } from '../conversion';
import { fingerprintTree } from '../fingerprint';
import type { AddOptions, HostWriter, InstalledPlugin, PinOptions, PinOutcome } from '../host';
import type {
  CleanupDisposition,
  CleanupReference,
  DurableLifecycleOperation,
  LifecycleHostDefinition,
  LifecycleReadbackData,
  LifecycleTargetIdentity,
  TargetInventoryData,
  TargetOwnershipObservation,
  TargetVersionObservation,
} from '../lifecycle-host';
import { createLifecycleHostAdapter, createTargetInventoryObservation } from '../lifecycle-runtime';
import { pinPluginMcpFiles } from '../mcp-write';
import { cursorRoot, homeRoot } from '../paths';
import { CryptoHasher, spawnSync } from '../runtime';
import type { SourceType } from '../semantic-inventory';
import type { PluginSource, ResolvedSource } from '../source';
import { cursor, cursorInstanceRoot, localDir, mcpCandidates } from './cursor';

const OWNERSHIP = '.plgnz-install.json';
const CURSOR_MANAGED_VERSION = '2.4.0';
const CURSOR_DIRECTORY_SURFACE = 'directory';
const MARKETPLACE_REFRESH_UNVERIFIED = 'cursor-marketplace-refresh';
const RELOAD_REQUIRED: LifecycleReadbackData['transition'] = { requirement: 'reload', status: 'effective' };

type Ownership = {
  source: string;
  pluginId: string;
  fingerprint: string;
  scopeId?: string;
  sourceType?: SourceType;
  sourceRevision?: string;
  sourceLocator?: string | null;
  proof?: 'created' | 'adopted';
};

export const cursorWriter: HostWriter = {
  ...cursor,
  supportsAdoption: true,
  plannedNativeId: (plugin) => plugin.name,
  legacyNativeIds: (plugin) => plugin.marketplace === undefined ? [] : [`${plugin.name}@${plugin.marketplace}`],
  persistedNativeIdMayAlias: (persisted, requested) => {
    const name = persisted.split('@', 1)[0] ?? persisted;
    return requested !== persisted && (requested === name || requested.startsWith(`${name}@`));
  },
  async add(plugin: PluginSource, resolved: ResolvedSource, opts?: AddOptions): Promise<void | 'unchanged'> {
    const id = plugin.name;
    const ownershipId = plugin.marketplace === undefined ? id : `${id}@${plugin.marketplace}`;
    assertSafeIdentity(id);
    const root = localDir();
    const target = join(root, id);
    assertManagedDirectory(root, target);

    if (!opts?.dryRun) mkdirSync(root, { recursive: true });
    const stage = mkdtempSync(join(opts?.dryRun ? tmpdir() : root, '.plgnz-cursor-stage-'));
    try {
      stagePlugin(plugin.dir, stage, id);
      // Preserve an unresolved bare command for the existing read-only `pin`
      // diagnosis path; activation must not rewrite it into a guessed command.
      await pinPluginMcpFiles(stage, mcpCandidates(), { dryRun: false });
      writeOwnership(stage, { source: resolved.sourceUri, pluginId: ownershipId, fingerprint: plugin.contentFingerprint ?? '' });

      const marker = readOwnership(target);
      if (marker !== null && (marker.source !== resolved.sourceUri || !matchesOwnership(marker.pluginId, id, ownershipId))) {
        throw new Error(`Cursor local plugin ${id} belongs to another source; refusing to replace it`);
      }
      const identicalUnowned = existsSync(target) && marker === null && sameTree(stage, target);
      if (existsSync(target) && marker === null && !identicalUnowned) {
        if (!opts?.adoptExisting) throw new Error(`Cursor local plugin ${id} is unowned and differs from the staged representation; pass --adopt-existing to take ownership explicitly`);
        validateExistingIdentity(target, id, sourceVersion(plugin.dir));
      }

      // A bare legacy marker has no collection identity. Re-write it on the
      // next successful add so reader metadata and the durable state agree.
      const unchanged = marker !== null && marker.pluginId === ownershipId && marker.fingerprint === (plugin.contentFingerprint ?? '') && sameTree(stage, target);
      if (opts?.dryRun) {
        console.log(`[cursor] would activate directory: ${target}`);
        return unchanged ? 'unchanged' : undefined;
      }
      if (unchanged) return 'unchanged';
      activate(stage, target, root).commit();
      return;
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  },
  async pin(plugin: InstalledPlugin, opts?: PinOptions): Promise<PinOutcome> {
    if (plugin.path === undefined || !existsSync(plugin.path)) return { changes: [], refusals: [] };
    return pinPluginMcpFiles(plugin.path, mcpCandidates(), opts);
  },
  async remove(id: string): Promise<void> {
    assertSafeIdentity(id);
    const root = localDir();
    const target = join(root, id);
    assertManagedDirectory(root, target);
    const marker = readOwnership(target);
    if (marker === null || !ownsNativeDirectory(marker.pluginId, id)) return;
    rmSync(target, { recursive: true, force: true });
  },
};

function stagePlugin(source: string, stage: string, expectedName: string): void {
  assertNoSymlinks(source);
  cpSync(source, stage, { recursive: true });
  projectCommandsToSkills(stage);
  ensureCursorManifest(stage, expectedName);
  validateStage(stage, expectedName);
}

/**
 * Cursor folded commands into skills: every skill is `/`-invocable and
 * Cursor 2.4's /migrate-to-skills preserves command invocation behavior
 * (Cursor docs → Skills). Command sources therefore project into the
 * plugin's skills tree. A command that is not user-invocable cannot be
 * represented — every Cursor skill is /-invocable — and is refused rather
 * than silently weakened.
 */
function projectCommandsToSkills(stage: string): void {
  if (!hasCommands(stage)) return;
  const commands = discoverCommands(stage);
  const seen = new Set<string>();
  for (const command of commands) {
    if (command.userInvocable === false) throw new Error(`Cursor skill projection cannot represent user-invocable: false: ${command.source}`);
    if (seen.has(command.name)) throw new Error(`Cursor command projection collision: ${command.name}`);
    seen.add(command.name);
    const target = join(stage, 'skills', command.name, 'SKILL.md');
    if (existsSync(target)) throw new Error(`Cursor command collides with an existing skill: ${command.name}`);
    mkdirSync(join(stage, 'skills', command.name), { recursive: true });
    const body = command.body.endsWith('\n') ? command.body : `${command.body}\n`;
    writeFileSync(target, `---\nname: ${JSON.stringify(command.name)}\ndescription: ${JSON.stringify(command.description)}\n---\n${body}`);
  }
  if (commands.length > 0) {
    rmSync(join(stage, 'commands'), { recursive: true, force: true });
    rmSync(join(stage, '.claude', 'commands'), { recursive: true, force: true });
  }
}

function hasCommands(root: string): boolean {
  return existsSync(join(root, 'commands')) || existsSync(join(root, '.claude', 'commands'));
}

function ensureCursorManifest(stage: string, expectedName: string): void {
  const cursorManifest = join(stage, '.cursor-plugin', 'plugin.json');
  if (existsSync(cursorManifest)) return;
  const source = manifestCandidates(stage).find(existsSync);
  if (source === undefined) throw new Error('Cursor stage has no Agent Plugins manifest');
  mkdirSync(join(stage, '.cursor-plugin'), { recursive: true });
  cpSync(source, cursorManifest);
  if (parseManifest(cursorManifest).name !== expectedName) throw new Error(`Cursor manifest identity does not match ${expectedName}`);
}

function validateStage(stage: string, expectedName: string): void {
  assertNoSymlinks(stage);
  const native = parseManifest(join(stage, '.cursor-plugin', 'plugin.json'));
  if (native.name !== expectedName) throw new Error(`Cursor manifest identity does not match ${expectedName}`);
  const canonicalPath = manifestCandidates(stage).find(existsSync);
  if (canonicalPath !== undefined) {
    const canonical = parseManifest(canonicalPath);
    if (native.name !== canonical.name || (canonical.version !== undefined && native.version !== canonical.version)) {
      throw new Error('Cursor native manifest identity does not match the canonical manifest');
    }
  }
  const skills = join(stage, 'skills');
  if (existsSync(skills) && !statSync(skills).isDirectory()) throw new Error('Cursor stage skills path is not a directory');
}

function manifestCandidates(root: string): string[] {
  return [join(root, '.claude-plugin', 'plugin.json'), join(root, 'plugin.json'), join(root, '.plugin', 'plugin.json')];
}

function sourceVersion(root: string): string | undefined {
  const manifest = [join(root, '.cursor-plugin', 'plugin.json'), ...manifestCandidates(root)].find(existsSync);
  return manifest === undefined ? undefined : parseManifest(manifest).version;
}

function parseManifest(path: string): { name: string; version?: string } {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`invalid Cursor plugin manifest: ${path} (${(error as Error).message})`); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`invalid Cursor plugin manifest: ${path}`);
  const record = value as Record<string, unknown>;
  if (typeof record['name'] !== 'string' || !validIdentity(record['name'])) throw new Error(`invalid Cursor plugin manifest identity: ${path}`);
  if (record['version'] !== undefined && typeof record['version'] !== 'string') throw new Error(`invalid Cursor plugin manifest version: ${path}`);
  return { name: record['name'], ...(typeof record['version'] === 'string' ? { version: record['version'] } : {}) };
}

function validateExistingIdentity(target: string, expectedName: string, expectedVersion: string | undefined): void {
  const manifest = join(target, '.cursor-plugin', 'plugin.json');
  if (!existsSync(manifest)) throw new Error(`unowned Cursor local plugin has no native manifest: ${target}`);
  const parsed = parseManifest(manifest);
  if (parsed.name !== expectedName || parsed.version !== expectedVersion) throw new Error(`unowned Cursor local plugin identity does not match ${expectedName}`);
}

function readOwnership(target: string): Ownership | null {
  const marker = join(target, OWNERSHIP);
  if (!existsSync(marker)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(marker, 'utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('marker must be an object');
    const record = value as Record<string, unknown>;
    if (typeof record['source'] !== 'string' || typeof record['pluginId'] !== 'string' || typeof record['fingerprint'] !== 'string') throw new Error('marker fields are invalid');
    const ownership: Ownership = { source: record['source'], pluginId: record['pluginId'], fingerprint: record['fingerprint'] };
    const scopeId = optionalMarkerString(record, 'scopeId');
    if (scopeId !== undefined) ownership.scopeId = scopeId;
    const sourceRevision = optionalMarkerString(record, 'sourceRevision');
    if (sourceRevision !== undefined) ownership.sourceRevision = sourceRevision;
    if (record['sourceType'] !== undefined) ownership.sourceType = markerSourceType(record['sourceType']);
    if (record['sourceLocator'] === null) ownership.sourceLocator = null;
    else if (typeof record['sourceLocator'] === 'string') ownership.sourceLocator = record['sourceLocator'];
    else if (record['sourceLocator'] !== undefined) throw new Error('marker fields are invalid');
    if (record['proof'] !== undefined) ownership.proof = markerProof(record['proof']);
    return ownership;
  } catch (error) {
    throw new Error(`invalid plgnz ownership marker: ${marker} (${(error as Error).message})`);
  }
}

function writeOwnership(stage: string, ownership: Ownership): void {
  writeFileSync(join(stage, OWNERSHIP), JSON.stringify(ownership));
}

/** A legacy bare marker remains owned only for this exact native directory. */
function matchesOwnership(markerId: string, nativeId: string, ownershipId: string): boolean {
  return markerId === nativeId || markerId === ownershipId;
}

function ownsNativeDirectory(markerId: string, nativeId: string): boolean {
  if (markerId === nativeId) return true;
  const prefix = `${nativeId}@`;
  return markerId.startsWith(prefix) && validIdentity(markerId.slice(prefix.length));
}

function activate(stage: string, target: string, root: string): { commit(): void } {
  if (!existsSync(target)) {
    renameSync(stage, target);
    return { commit: () => {} };
  }
  const backupRoot = mkdtempSync(join(root, '.plgnz-cursor-backup-'));
  const backup = join(backupRoot, 'previous');
  renameSync(target, backup);
  try { renameSync(stage, target); }
  catch (error) {
    renameSync(backup, target);
    rmSync(backupRoot, { recursive: true, force: true });
    throw error;
  }
  return { commit: () => rmSync(backupRoot, { recursive: true, force: true }) };
}

function sameTree(left: string, right: string): boolean {
  if (!existsSync(right)) return false;
  const entries = (root: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string, prefix: string): void => {
      for (const name of readdirSync(dir).sort()) {
        if (name === OWNERSHIP) continue;
        const path = join(dir, name);
        const relative = prefix === '' ? name : `${prefix}/${name}`;
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) throw new Error(`Cursor managed plugin contains symlink: ${path}`);
        if (stat.isDirectory()) walk(path, relative);
        else if (stat.isFile()) out.push(`${relative}:${hashBytes(path)}`);
        else throw new Error(`Cursor managed plugin contains unsupported file: ${path}`);
      }
    };
    walk(root, '');
    return out;
  };
  return JSON.stringify(entries(left)) === JSON.stringify(entries(right));
}

function hashBytes(path: string): string {
  const read = readFileSync as unknown as (file: string) => Uint8Array;
  return Array.from(read(path)).join(',');
}

function assertManagedDirectory(root: string, target: string): void {
  const resolvedRoot = resolve(cursorRoot());
  const resolvedTarget = resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}/`)) throw new Error(`Cursor managed path escapes its store: ${target}`);
  let current = resolvedRoot;
  for (const part of resolvedTarget.slice(resolvedRoot.length).split('/').filter(Boolean)) {
    if (existsSync(current)) assertDirectoryNotLink(current);
    current = join(current, part);
  }
  if (existsSync(current)) assertDirectoryNotLink(current);
}

function assertDirectoryNotLink(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`Cursor managed path component is a symlink: ${path}`);
  if (!stat.isDirectory()) throw new Error(`Cursor managed path component is not a directory: ${path}`);
}

function assertNoSymlinks(root: string): void {
  const walk = (dir: string): void => {
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink()) throw new Error(`Cursor plugin source contains symlink: ${dir}`);
    if (!stat.isDirectory()) throw new Error(`Cursor plugin source is not a directory: ${dir}`);
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const entry = lstatSync(path);
      if (entry.isSymbolicLink()) throw new Error(`Cursor plugin source contains symlink: ${path}`);
      if (entry.isDirectory()) walk(path);
      else if (!entry.isFile()) throw new Error(`Cursor plugin source contains unsupported file: ${path}`);
    }
  };
  walk(root);
}

function assertSafeIdentity(id: string): void {
  if (!validIdentity(id)) throw new Error(`unsafe Cursor plugin identity: ${id}`);
}

function validIdentity(id: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/iu.test(id);
}

function optionalMarkerString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) throw new Error('marker fields are invalid');
  return value;
}

function markerSourceType(value: unknown): SourceType {
  if (value === 'local' || value === 'git') return value;
  throw new Error('marker fields are invalid');
}

function markerProof(value: unknown): 'created' | 'adopted' {
  if (value === 'created' || value === 'adopted') return value;
  throw new Error('marker fields are invalid');
}

const cursorManagedProfile = createCapabilityEvidenceProfile({
  host: 'cursor',
  detectedVersion: CURSOR_MANAGED_VERSION,
  sourceTypes: ['local', 'git'],
  operations: ['install', 'update', 'disable', 'retire'],
  route: 'managed',
  operationStatus: 'supported',
  semantics: {
    'ordinary-skills': 'supported',
    mcp: 'supported',
    hooks: 'unverified',
    commands: 'supported',
    agents: 'unverified',
    'model-invocation-control': 'supported',
    'user-invocation-control': 'unsupported',
    'auto-update-control': 'supported',
    resources: 'supported',
    'permissions-preprocessing': 'unverified',
    retirement: 'supported',
    'retention-safety': 'supported',
    readback: 'supported',
    rollback: 'supported',
    'activation-reload': 'supported',
    'reversible-disable': 'unverified',
  },
  evidence: [
    'docs/hosts/cursor.md',
    'docs/evidence/personal-cursor-composition-20260923.md',
    'docs/research/native-plugin-update-capabilities-2026-10-09.md',
  ],
});

const cursorDirectoryProfile = createCapabilityEvidenceProfile({
  host: 'cursor',
  detectedVersion: CURSOR_DIRECTORY_SURFACE,
  sourceTypes: ['local', 'git'],
  operations: ['install', 'update', 'retire'],
  route: 'managed',
  operationStatus: 'supported',
  semantics: {
    'ordinary-skills': 'supported',
    mcp: 'unverified',
    hooks: 'unverified',
    commands: 'unverified',
    agents: 'unverified',
    'model-invocation-control': 'unverified',
    'user-invocation-control': 'unverified',
    'auto-update-control': 'supported',
    resources: 'unverified',
    'permissions-preprocessing': 'unverified',
    retirement: 'supported',
    'retention-safety': 'supported',
    readback: 'supported',
    rollback: 'supported',
    'activation-reload': 'supported',
    'reversible-disable': 'unverified',
  },
  evidence: ['docs/hosts/cursor.md'],
});

const cursorLifecycleDefinition: LifecycleHostDefinition = {
  id: 'cursor',
  evidenceProfiles: [cursorManagedProfile, cursorDirectoryProfile],
  async probeVersion(target) {
    assertCursorTarget(target);
    return probeCursorVersion();
  },
  async observeTarget(target) {
    assertCursorTarget(target);
    return inventoryLocalStore(target);
  },
  async observeNativeMutationScope() {
    return { kind: 'unavailable' };
  },
  async observeNativeProjection() {
    return { kind: 'unverified', reasonId: MARKETPLACE_REFRESH_UNVERIFIED };
  },
  async revalidateTargetPrecondition(handle) {
    assertCursorTarget(handle.target);
    return {
      version: probeCursorVersion(),
      targetObservationId: createTargetInventoryObservation('cursor', inventoryLocalStore(handle.target)).observationId,
    };
  },
  async stageActivation(request) {
    assertSafeIdentity(request.snapshot.nativeId);
    const preparation = lifecycleDir(request.snapshot.target.instance, 'prepare', request.snapshot.attemptId, request.snapshot.operationId);
    const stagingRoot = resolve(join(preparation, 'stage'));
    rmSync(stagingRoot, { recursive: true, force: true });
    mkdirSync(preparation, { recursive: true });
    stagePlugin(request.snapshot.packageRoot, stagingRoot, request.snapshot.nativeId);
    writeOwnership(stagingRoot, lifecycleMarker(request));
    return { stagingId: operationKey(request.snapshot.attemptId, request.snapshot.operationId), stagingRoot };
  },
  async applyLifecycleDirectives() {
    return ['cursor-local-no-native-updater'];
  },
  async applyPins(projection) {
    return applyRecordedPins(projection.stagingRoot, projection.pins);
  },
  async captureActivationPreparation(projection, projectedFingerprint) {
    const prior = projectReadback({
      adapterId: projection.adapterId,
      target: projection.target,
      scopeId: projection.scopeId,
      packageName: projection.packageName,
      nativeId: projection.nativeId,
      routeWhenAbsent: 'none',
    });
    const active = resolve(managedPluginDir(projection.target.instance, projection.nativeId));
    return {
      prior,
      expected: {
        adapterId: projection.adapterId,
        target: projection.target,
        scopeId: projection.scopeId,
        packageName: projection.packageName,
        nativeId: projection.nativeId,
        route: projection.route,
        presence: 'present',
        enablement: 'enabled',
        activation: 'active',
        transition: RELOAD_REQUIRED,
        installedFingerprint: projectedFingerprint,
        contentRoots: [{ label: 'local', path: active, fingerprint: projectedFingerprint }],
        retention: prior.retention,
      },
      rollbackReference: captureRollback(projection.target.instance, projection.attemptId, projection.operationId, projection.nativeId, prior),
      rollbackCoverageOperationIds: projection.affectedOperationIds,
    };
  },
  async captureDisablePreparation() {
    throw new Error('Cursor local projection has no reversible disable switch');
  },
  async captureRetirementPreparation(request) {
    const prior = projectReadback({
      adapterId: 'cursor',
      target: request.activation.target,
      scopeId: request.activation.scopeId,
      packageName: request.activation.packageName,
      nativeId: request.activation.nativeId,
      routeWhenAbsent: request.selection.route,
    });
    return {
      prior,
      rollbackReference: captureRollback(request.activation.target.instance, request.attemptId, request.operationId, request.activation.nativeId, prior),
      rollbackCoverageOperationIds: request.selection.affectedOperationIds,
      transition: RELOAD_REQUIRED,
    };
  },
  async apply(prepared) {
    const handle = prepared.handle;
    const target = managedPluginDir(handle.target.instance, handle.nativeId);
    refuseForeignScope(target, handle.scopeId, handle.nativeId);
    if (existsSync(target) && fingerprintTree(target) === fingerprintTree(prepared.stagingRoot)) {
      return { receiptId: receipt('apply', handle), changed: false };
    }
    const root = localDir(handle.target.instance);
    mkdirSync(root, { recursive: true });
    const scratch = join(root, `.plgnz-cursor-stage-${operationKey(handle.attemptId, handle.operationId)}`);
    rmSync(scratch, { recursive: true, force: true });
    try {
      cpSync(prepared.stagingRoot, scratch, { recursive: true });
      activate(scratch, target, root).commit();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    return { receiptId: receipt('apply', handle), changed: true };
  },
  async disable() {
    throw new Error('Cursor local projection has no reversible disable switch');
  },
  async retire(prepared) {
    const handle = prepared.handle;
    const target = managedPluginDir(handle.target.instance, handle.nativeId);
    if (!existsSync(target)) return { receiptId: receipt('retire', handle), changed: false };
    refuseForeignScope(target, handle.scopeId, handle.nativeId);
    rmSync(target, { recursive: true, force: true });
    return { receiptId: receipt('retire', handle), changed: true };
  },
  async readback(handle) {
    return projectReadback({
      adapterId: handle.adapterId,
      target: handle.target,
      scopeId: handle.scopeId,
      packageName: handle.packageName,
      nativeId: handle.nativeId,
      routeWhenAbsent: absentRoute(handle.action, handle.route),
    });
  },
  async rollback(handle) {
    const priorPath = join(handle.rollbackReference, 'prior.json');
    const prior = JSON.parse(readFileSync(priorPath, 'utf8')) as LifecycleReadbackData;
    const root = localDir(handle.target.instance);
    const target = managedPluginDir(handle.target.instance, handle.nativeId);
    const backup = join(handle.rollbackReference, 'active');
    const restore = prior.presence === 'present' && existsSync(backup);
    if (!restore) {
      if (prior.presence === 'present' || !existsSync(target)) return { receiptId: receipt('rollback', handle), changed: false };
      refuseForeignScope(target, handle.scopeId, handle.nativeId);
      rmSync(target, { recursive: true, force: true });
      return { receiptId: receipt('rollback', handle), changed: true };
    }
    if (existsSync(target)) {
      refuseForeignScope(target, handle.scopeId, handle.nativeId);
      if (fingerprintTree(target) === fingerprintTree(backup)) return { receiptId: receipt('rollback', handle), changed: false };
    }
    mkdirSync(root, { recursive: true });
    const scratch = join(root, `.plgnz-cursor-stage-${operationKey(handle.attemptId, handle.operationId)}`);
    rmSync(scratch, { recursive: true, force: true });
    try {
      cpSync(backup, scratch, { recursive: true });
      activate(scratch, target, root).commit();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    return { receiptId: receipt('rollback', handle), changed: true };
  },
  async cleanup(reference: CleanupReference, _disposition: CleanupDisposition) {
    rmSync(lifecycleDir(reference.target.instance, 'prepare', reference.attemptId, reference.operationId), { recursive: true, force: true });
    rmSync(lifecycleDir(reference.target.instance, 'rollback', reference.attemptId, reference.operationId), { recursive: true, force: true });
    return { cleanupId: `cleanup:${reference.attemptId}:${reference.operationId}`, completed: true };
  },
};

export const cursorManagedLifecycle = createLifecycleHostAdapter(cursorLifecycleDefinition);

function assertCursorTarget(target: LifecycleTargetIdentity): void {
  if (target.kind !== 'cursor' || !/^[a-z0-9][a-z0-9._-]*$/iu.test(target.instance)) {
    throw new Error('Cursor lifecycle target must name a cursor instance');
  }
}

function probeCursorVersion(): TargetVersionObservation {
  const located = locateCursorProbeBinary();
  if (located.kind === 'refused') return { kind: 'unknown' };
  if (located.kind === 'absent') return { kind: 'detected', version: CURSOR_DIRECTORY_SURFACE, probeId: 'cursor-directory' };
  if (located.kind !== 'path') {
    const unreachable: never = located;
    return unreachable;
  }
  const result = spawnSync([located.path, '--version'], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10_000,
    env: { ...process.env, HOME: homeRoot(), PATH: cursorProbePath() },
  });
  const version = cursorVersion(decodeStdout(result.stdout));
  if (result.exitCode !== 0 || version === undefined) return { kind: 'unparseable' };
  return { kind: 'detected', version, probeId: `cursor-${version}` };
}

function locateCursorProbeBinary():
  | { readonly kind: 'refused' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'path'; readonly path: string } {
  const override = process.env['OPEN_PLUGIN_CURSOR_BIN'];
  if (override !== undefined) {
    if (override.length === 0 || !existsSync(override)) return { kind: 'refused' };
    return { kind: 'path', path: override };
  }
  const found = whichOnPath(cursorProbePath(), 'cursor');
  return found === undefined ? { kind: 'absent' } : { kind: 'path', path: found };
}

function cursorProbePath(): string {
  const isolated = process.env['OPEN_PLUGIN_HOME'];
  if (isolated !== undefined && isolated.length > 0) return join(homeRoot(), 'bin');
  return process.env['PATH'] ?? '';
}

function whichOnPath(pathEnv: string, name: string): string | undefined {
  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

function cursorVersion(stdout: string): string | undefined {
  const line = stdout.split(/\r?\n/u).map((item) => item.trim()).find((item) => item.length > 0);
  if (line === undefined) return undefined;
  const branded = /^Cursor (\d+\.\d+\.\d+)$/u.exec(line);
  if (branded?.[1] !== undefined) return branded[1];
  const bare = /^(\d+\.\d+\.\d+)$/u.exec(line);
  return bare?.[1];
}

function decodeStdout(bytes: Uint8Array): string {
  return [...bytes].map((byte) => String.fromCharCode(byte)).join('');
}

function inventoryLocalStore(target: LifecycleTargetIdentity): TargetInventoryData {
  const root = localDir(target.instance);
  if (!existsSync(root)) return { target, installations: [] };
  const installations: TargetInventoryData['installations'][number][] = [];
  for (const entry of readdirSync(root)) {
    if (!validIdentity(entry)) continue;
    const dir = join(root, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const installation = readLocalInstallation(entry, dir);
    if (installation !== undefined) installations.push(installation);
  }
  return { target, installations };
}

function readLocalInstallation(entry: string, dir: string): TargetInventoryData['installations'][number] | undefined {
  const manifestPath = join(dir, '.cursor-plugin', 'plugin.json');
  if (!existsSync(manifestPath)) return undefined;
  let manifest: { name: string; version?: string } | undefined;
  let marker: Ownership | null = null;
  let unreadable = false;
  try {
    manifest = parseManifest(manifestPath);
  } catch {
    unreadable = true;
  }
  try {
    marker = readOwnership(dir);
  } catch {
    unreadable = true;
    marker = null;
  }
  let digest: string;
  try {
    digest = fingerprintTree(dir);
  } catch {
    unreadable = true;
    digest = unreadableFingerprint(entry);
  }
  if (manifest === undefined || unreadable) {
    return {
      nativeId: entry,
      packageName: manifest?.name ?? null,
      ownership: { kind: 'ambiguous', proofIds: [`cursor-unreadable-${entry}`] },
      presence: 'present',
      enablement: 'unknown',
      activation: 'unknown',
      installedFingerprint: digest,
      installedVersion: manifest?.version ?? null,
      source: null,
      contentRoots: [{ label: 'local', path: resolve(dir), fingerprint: digest }],
    };
  }
  return {
    nativeId: entry,
    packageName: manifest.name,
    ownership: ownershipOf(entry, marker),
    presence: 'present',
    enablement: 'enabled',
    activation: 'active',
    installedFingerprint: digest,
    installedVersion: manifest.version ?? null,
    source: sourceOf(marker),
    contentRoots: [{ label: 'local', path: resolve(dir), fingerprint: digest }],
  };
}

function unreadableFingerprint(nativeId: string): string {
  const hash = new CryptoHasher('sha256');
  hash.update('cursor-unreadable\0');
  hash.update(nativeId);
  return hash.digest('hex');
}

function ownershipOf(nativeId: string, marker: Ownership | null): TargetOwnershipObservation {
  if (marker === null || marker.scopeId === undefined) return { kind: 'unmanaged' };
  if (!ownsNativeDirectory(marker.pluginId, nativeId)) return { kind: 'ambiguous', proofIds: [`cursor-marker-${nativeId}`] };
  return {
    kind: 'owned',
    proof: marker.proof === 'adopted' ? 'adopted' : 'created',
    scopeId: marker.scopeId,
    proofId: `cursor-${nativeId}-${marker.scopeId}`,
  };
}

function sourceOf(marker: Ownership | null): TargetInventoryData['installations'][number]['source'] {
  if (marker?.sourceType === undefined || marker.sourceRevision === undefined) return null;
  switch (marker.sourceType) {
    case 'local':
      return { type: 'local', immutableRevision: marker.sourceRevision, locator: null };
    case 'git':
      return { type: 'git', immutableRevision: marker.sourceRevision, locator: marker.sourceLocator ?? null };
    default: {
      const unreachable: never = marker.sourceType;
      throw new Error(`unsupported cursor source type: ${String(unreachable)}`);
    }
  }
}

function lifecycleMarker(request: { snapshot: { nativeId: string; scopeId: string; sourceType: SourceType; immutableRevision: string; packageFingerprint: string; nativeGit?: { locator: string } } }): Ownership {
  const locator = request.snapshot.nativeGit?.locator ?? null;
  return {
    source: locator ?? request.snapshot.immutableRevision,
    pluginId: request.snapshot.nativeId,
    fingerprint: request.snapshot.packageFingerprint,
    scopeId: request.snapshot.scopeId,
    sourceType: request.snapshot.sourceType,
    sourceRevision: request.snapshot.immutableRevision,
    sourceLocator: request.snapshot.sourceType === 'local' ? null : locator,
    proof: 'created',
  };
}

function applyRecordedPins(stage: string, pins: readonly { server: string; executable: string }[]): string[] {
  for (const pin of pins) {
    let found = false;
    for (const file of [join(stage, '.mcp.json'), join(stage, 'mcp.json')]) {
      if (!existsSync(file)) continue;
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      const servers = (parsed as Record<string, unknown>)['mcpServers'];
      if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) continue;
      const definition = (servers as Record<string, unknown>)[pin.server];
      if (typeof definition !== 'object' || definition === null || Array.isArray(definition)) continue;
      if (typeof (definition as Record<string, unknown>)['command'] !== 'string') continue;
      (definition as Record<string, unknown>)['command'] = pin.executable;
      writeFileSync(file, JSON.stringify(parsed, null, 2));
      found = true;
    }
    if (!found) throw new Error(`Cursor pin server is absent from the staged projection: ${pin.server}`);
  }
  return pins.map((pin) => pin.server);
}

function projectReadback(identity: {
  adapterId: string;
  target: LifecycleTargetIdentity;
  scopeId: string;
  packageName: string;
  nativeId: string;
  routeWhenAbsent: LifecycleReadbackData['route'];
}): LifecycleReadbackData {
  const instance = identity.target.instance;
  const retention = {
    pluginData: retainedResource(instance, identity.nativeId, 'data'),
    inactiveMetadata: retainedResource(instance, identity.nativeId, 'metadata'),
  };
  const dir = join(localDir(instance), identity.nativeId);
  if (!existsSync(dir)) {
    return {
      adapterId: identity.adapterId,
      target: identity.target,
      scopeId: identity.scopeId,
      packageName: identity.packageName,
      nativeId: identity.nativeId,
      route: identity.routeWhenAbsent,
      presence: 'absent',
      enablement: 'disabled',
      activation: 'inactive',
      transition: RELOAD_REQUIRED,
      installedFingerprint: null,
      contentRoots: [],
      retention,
    };
  }
  const digest = fingerprintTree(dir);
  return {
    adapterId: identity.adapterId,
    target: identity.target,
    scopeId: identity.scopeId,
    packageName: identity.packageName,
    nativeId: identity.nativeId,
    route: 'managed',
    presence: 'present',
    enablement: 'enabled',
    activation: 'active',
    transition: RELOAD_REQUIRED,
    installedFingerprint: digest,
    contentRoots: [{ label: 'local', path: resolve(dir), fingerprint: digest }],
    retention,
  };
}

function retainedResource(instance: string, nativeId: string, kind: 'data' | 'metadata'): LifecycleReadbackData['retention']['pluginData'] {
  const dir = retentionDir(instance, nativeId, kind);
  if (!existsSync(dir)) return { state: 'absent', fingerprint: null };
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Cursor retained ${kind} is not a directory: ${dir}`);
  return { state: 'present', fingerprint: fingerprintTree(dir) };
}

function retentionDir(instance: string, nativeId: string, kind: 'data' | 'metadata'): string {
  assertSafeIdentity(nativeId);
  const dir = resolve(join(cursorInstanceRoot(instance), 'plugins', 'retained', nativeId, kind));
  const root = resolve(cursorRoot());
  if (dir !== root && !dir.startsWith(`${root}/`)) throw new Error(`Cursor retention path escapes its store: ${dir}`);
  return dir;
}

function captureRollback(instance: string, attemptId: string, operationId: string, nativeId: string, prior: LifecycleReadbackData): string {
  const reference = lifecycleDir(instance, 'rollback', attemptId, operationId);
  rmSync(reference, { recursive: true, force: true });
  mkdirSync(reference, { recursive: true });
  const active = join(localDir(instance), nativeId);
  if (existsSync(active)) cpSync(active, join(reference, 'active'), { recursive: true });
  writeFileSync(join(reference, 'prior.json'), `${JSON.stringify(prior)}\n`);
  return reference;
}

function lifecycleDir(instance: string, kind: 'prepare' | 'rollback', attemptId: string, operationId: string): string {
  return resolve(join(cursorInstanceRoot(instance), 'plugins', '.plgnz-lifecycle', kind, operationKey(attemptId, operationId)));
}

function operationKey(attemptId: string, operationId: string): string {
  const hash = new CryptoHasher('sha256');
  hash.update(attemptId);
  hash.update('\0');
  hash.update(operationId);
  return hash.digest('hex');
}

function absentRoute(action: DurableLifecycleOperation['action'], route: DurableLifecycleOperation['route']): LifecycleReadbackData['route'] {
  switch (action) {
    case 'remove':
    case 'retire-orphan':
      return route;
    case 'install':
    case 'update':
    case 'route-migrate':
    case 'disable-nonconforming':
      return 'none';
    default: {
      const unreachable: never = action;
      throw new Error(`unsupported cursor lifecycle action: ${String(unreachable)}`);
    }
  }
}

function refuseForeignScope(target: string, scopeId: string, nativeId: string): void {
  if (!existsSync(target)) return;
  const marker = readOwnership(target);
  if (marker === null || marker.scopeId !== scopeId || !ownsNativeDirectory(marker.pluginId, nativeId)) {
    throw new Error(`Cursor local plugin ${nativeId} is not owned by deployment scope ${scopeId}`);
  }
}

function managedPluginDir(instance: string, nativeId: string): string {
  assertSafeIdentity(nativeId);
  const root = localDir(instance);
  const target = join(root, nativeId);
  assertManagedDirectory(root, target);
  return target;
}

function receipt(kind: 'apply' | 'retire' | 'rollback', handle: { attemptId: string; operationId: string }): string {
  return `${kind}:${handle.attemptId}:${handle.operationId}`;
}
