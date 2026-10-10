/** Transactional writer for OMP's native npm/link extension-package lane. */
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddOptions, HostWriter, InstalledPlugin, PinOptions, PinOutcome } from '../host';
import type { PluginSource, ResolvedSource } from '../source';
import { createCapabilityEvidenceProfile, type CapabilityStatus } from '../capability-evidence';
import { projectPluginForOmp } from '../conversion';
import { fingerprintTree } from '../fingerprint';
import type {
  ActivationTransitionObservation,
  CleanupDisposition,
  CleanupReference,
  CleanupResultData,
  DurableLifecycleOperation,
  LifecycleHostDefinition,
  LifecycleReadbackData,
  LifecycleTargetIdentity,
  MutationResultData,
  NativeProjectionRequest,
  RetirementPreparationCapture,
  TargetInstallationData,
  TargetInventoryData,
  TargetVersionObservation,
} from '../lifecycle-host';
import { createLifecycleHostAdapter, createTargetInventoryObservation } from '../lifecycle-runtime';
import { pinPluginMcpFiles } from '../mcp-write';
import { CryptoHasher, spawnSync, which } from '../runtime';
import { PACKAGE_SEMANTICS, type PackageSemantic } from '../semantic-inventory';
import { omp, mcpCandidates, ompUpgradeMutationScope, ompUpgradeProjection, pluginsDir, type OmpNativeUpgradeCandidate } from './omp';

const MARKER = '.plgnz-install.json';
const MANAGED = 'plgnz';
type Ownership = {
  source: string;
  pluginId: string;
  fingerprint: string;
  packageName: string;
  scopeId?: string;
  sourceType?: 'local' | 'git';
  sourceRevision?: string;
  sourceLocator?: string | null;
};
type Doc = Record<string, unknown>;

declare const TextEncoder: { new (): { encode(input?: string): Uint8Array } };

export const ompWriter: HostWriter = {
  ...omp,
  supportsAdoption: true,
  plannedNativeId: (plugin) => `${plugin.name}@${plugin.marketplace ?? 'local'}`,
  legacyNativeIds: (plugin) => plugin.marketplace === undefined ? [plugin.name] : [],
  persistedNativeIdMayAlias: (persisted, requested) =>
    !persisted.includes('@') && (requested === persisted || requested === `${persisted}@local`),
  async add(plugin: PluginSource, resolved: ResolvedSource, opts?: AddOptions): Promise<void | 'unchanged'> {
    const market = plugin.marketplace ?? 'local'; const id = `${plugin.name}@${market}`;
    assertIdentity(market, 'marketplace'); assertIdentity(plugin.name, 'plugin');
    const packageName = nativePackageName(market, plugin.name); const version = plugin.version ?? resolved.sha;
    const managed = join(pluginsDir(), MANAGED); const target = join(managed, nativeSlug(market, plugin.name));
    const link = join(pluginsDir(), 'node_modules', '@plgnz', nativeSlug(market, plugin.name));
    const lockFile = join(pluginsDir(), 'omp-plugins.lock.json'); const registryFile = join(pluginsDir(), 'installed_plugins.json');
    const lock = readDoc(lockFile, { plugins: {}, settings: {} }, 'lockfile'); const lockPlugins = object(lock.plugins, 'lockfile plugins');
    const registry = readDoc(registryFile, { version: 2, plugins: {} }, 'registry'); const registryPlugins = object(registry.plugins, 'registry plugins');
    const rows = userRows(registryPlugins[id]);
    if (rows.length > 0) validateLegacy(rows, id, plugin.name, version, opts?.adoptExisting === true);
    const owner = ownership(target);
    if (owner === null && lstatExists(target)) throw new Error(`OMP managed package slot is unowned; refusing to replace it: ${target}`);
    if (owner !== null && (owner.source !== resolved.sourceUri || owner.pluginId !== id || owner.packageName !== packageName)) throw new Error(`OMP plugin ${id} belongs to another source; refusing to replace it`);
    assertOwnedLink(link, target, owner !== null);

    // Activation uses rename, so real installs must stage on the target's
    // filesystem. Dry-runs still project in system temp without creating a store.
    const stageParent = opts?.dryRun ? tmpdir() : managed;
    if (!opts?.dryRun) mkdirSafe(stageParent);
    const stage = mkdtempSync(join(stageParent, '.plgnz-omp-package-'));
    try {
      projectPluginForOmp(plugin.dir, stage, { packageName, version, activeRoot: target, namespace: plugin.name });
      writeFileSync(join(stage, MARKER), JSON.stringify({ source: resolved.sourceUri, pluginId: id, fingerprint: plugin.contentFingerprint ?? '', packageName } satisfies Ownership));
      const unchanged = owner !== null && owner.fingerprint === (plugin.contentFingerprint ?? '') && sameTree(stage, target) && linkPointsTo(link, target) && lockEnabled(lockPlugins[packageName]);
      if (opts?.dryRun) return unchanged ? 'unchanged' : undefined;
      if (unchanged && rows.length === 0) return 'unchanged';

      mkdirSafe(managed); mkdirSafe(dirname(link));
      const beforeLock = snapshot(lockFile); const beforeRegistry = snapshot(registryFile);
      let active: Move | null = null; let previousLink: Move | null = null; let createdLink = false;
      try {
        if (!unchanged) active = activate(stage, target);
        if (!unchanged) previousLink = moveExisting(link);
        if (!unchanged) { symlinkSync(target, link, 'dir'); createdLink = true; }
        const nextLockPlugins = { ...lockPlugins, [packageName]: activatedEntry(entry(lockPlugins[packageName]), version) };
        const retained = nonUserRows(registryPlugins[id]);
        if (retained.length === 0) delete nextLockPlugins[plugin.name];
        const nextRegistryPlugins = { ...registryPlugins };
        if (retained.length > 0) nextRegistryPlugins[id] = retained; else delete nextRegistryPlugins[id];
        writeDoc(lockFile, { ...lock, plugins: nextLockPlugins });
        if (rows.length > 0) writeDoc(registryFile, { ...registry, plugins: nextRegistryPlugins });
      } catch (error) {
        if (createdLink) rmSync(link, { recursive: true, force: true }); previousLink?.rollback(); active?.rollback();
        restore(lockFile, beforeLock); restore(registryFile, beforeRegistry); throw error;
      }
      previousLink?.commit(); active?.commit();
      const retainedPaths = registryInstallPaths(nextRegistryPlugins(registryPlugins, id));
      for (const row of rows) cleanupLegacy(row, plugin.name, retainedPaths);
      return unchanged ? 'unchanged' : undefined;
    } finally { rmSync(stage, { recursive: true, force: true }); }
  },
  async pin(plugin: InstalledPlugin, opts?: PinOptions): Promise<PinOutcome> {
    if (plugin.path === undefined || !existsSync(plugin.path)) return { changes: [], refusals: [] };
    return pinPluginMcpFiles(plugin.path, mcpCandidates(), opts);
  },
  async remove(id: string): Promise<void> {
    const owned = findOwned(id); if (owned === null) throw new Error(`OMP plugin ${id} is not plgnz-owned; refusing to remove it`);
    const link = join(pluginsDir(), 'node_modules', owned.owner.packageName);
    if (!linkPointsTo(link, owned.path)) throw new Error(`OMP native link for ${id} is missing or redirected; refusing to remove it`);
    let movedRoot: Move | null = null; let movedLink: Move | null = null;
    try { movedRoot = moveExisting(owned.path); movedLink = moveExisting(link); }
    catch (error) { movedLink?.rollback(); movedRoot?.rollback(); throw error; }
    movedLink?.commit(); movedRoot?.commit();
  },
};

function activatedEntry(previous: Doc, version: string): Doc {
  return {
    ...previous,
    version,
    enabled: true,
    enabledFeatures: 'enabledFeatures' in previous ? previous.enabledFeatures : null,
  };
}

function nativePackageName(market: string, plugin: string): string { return `@plgnz/${nativeSlug(market, plugin)}`; }
function nativeSlug(market: string, plugin: string): string { return `${hex(market)}-${hex(plugin)}`; }
function hex(value: string): string { return Array.from(new TextEncoder().encode(value), byte => byte.toString(16).padStart(2, '0')).join(''); }
function lockEnabled(value: unknown): boolean { return isDoc(value) && value.enabled === true; }
function entry(value: unknown): Doc { return isDoc(value) ? value : {}; }

function validateLegacy(rows: Array<Doc & { installPath?: unknown }>, id: string, name: string, version: string, adopt: boolean): void {
  if (!adopt) throw new Error(`OMP marketplace install ${id} exists; pass --adopt-existing to migrate it to the native extension-package lane`);
  const [marketplace] = id.split('@').slice(1); const cache = join(pluginsDir(), 'cache', 'plugins');
  for (const row of rows) {
    if (typeof row.installPath !== 'string' || typeof row.version !== 'string' || row.version !== version || marketplace === undefined) throw new Error(`OMP marketplace install ${id} has no safe native copy`);
    const expected = join(cache, `${marketplace}___${name}___${version}`);
    if (resolve(row.installPath) !== resolve(expected)) throw new Error(`OMP marketplace install ${id} is outside its approved cache slot`);
    assertExistingDirectoryTree(cache, row.installPath, `OMP marketplace install ${id}`);
    const manifest = readDoc(join(row.installPath, 'plugin.json'), {}, 'legacy plugin manifest');
    if (manifest.name !== name || (typeof manifest.version === 'string' && manifest.version !== version)) throw new Error(`OMP marketplace install ${id} identity differs from the selected source`);
  }
}
function cleanupLegacy(row: Doc & { installPath?: unknown }, name: string, retainedPaths: Set<string>): void {
  if (typeof row.installPath !== 'string' || retainedPaths.has(resolve(row.installPath))) return;
  const legacyLink = join(pluginsDir(), 'node_modules', name);
  if (linkPointsTo(legacyLink, row.installPath)) rmSync(legacyLink, { force: true });
  rmSync(row.installPath, { recursive: true, force: true });
}
function nextRegistryPlugins(registry: Doc, id: string): Doc { const next = { ...registry }; const retained = nonUserRows(registry[id]); if (retained.length > 0) next[id] = retained; else delete next[id]; return next; }
function registryInstallPaths(registry: Doc): Set<string> { const paths = new Set<string>(); for (const value of Object.values(registry)) if (Array.isArray(value)) for (const row of value) if (isDoc(row) && typeof row.installPath === 'string') paths.add(resolve(row.installPath)); return paths; }
function findOwned(id: string): { path: string; owner: Ownership } | null {
  const root = join(pluginsDir(), MANAGED); if (!existsSync(root)) return null;
  for (const name of readdirSync(root)) { const path = join(root, name); const owner = ownership(path); if (owner?.pluginId === id) return { path, owner }; }
  return null;
}
function assertOwnedLink(path: string, target: string, owned: boolean): void {
  if (!lstatExists(path)) return;
  if (!owned || !linkPointsTo(path, target)) throw new Error(`OMP native package slot is unowned or redirected: ${path}`);
}
function lstatExists(path: string): boolean { try { lstatSync(path); return true; } catch { return false; } }
function linkPointsTo(path: string, target: string): boolean { try { return lstatSync(path).isSymbolicLink() && resolve(dirname(path), readlinkSync(path)) === resolve(target); } catch { return false; } }

type Move = { commit(): void; rollback(): void };
function moveExisting(path: string): Move | null {
  if (!lstatExists(path)) return null;
  const root = mkdtempSync(join(dirname(path), '.plgnz-omp-backup-')); const backup = join(root, 'previous'); renameSync(path, backup);
  return { commit: () => rmSync(root, { recursive: true, force: true }), rollback: () => { rmSync(path, { recursive: true, force: true }); renameSync(backup, path); rmSync(root, { recursive: true, force: true }); } };
}
function activate(stage: string, target: string): Move {
  const old = moveExisting(target);
  try {
    if (process.env['OPEN_PLUGIN_TEST_OMP_ACTIVATION_FAILURE'] === 'after-old-move') throw new Error('forced OMP activation failure');
    renameSync(stage, target);
  } catch (error) {
    old?.rollback();
    throw error;
  }
  return { commit: () => old?.commit(), rollback: () => { rmSync(target, { recursive: true, force: true }); old?.rollback(); } };
}
function mkdirSafe(path: string): void {
  const boundary = resolve(pluginsDir()); const target = resolve(path);
  if (target !== boundary && !target.startsWith(`${boundary}/`)) throw new Error(`OMP managed path escapes the plugin store: ${target}`);
  const parentBoundary = dirname(boundary);
  for (let current = target; ; current = dirname(current)) {
    if (lstatExists(current)) { const stat = lstatSync(current); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`OMP managed path is unsafe: ${current}`); }
    if (current === parentBoundary) break;
  }
  mkdirSync(path, { recursive: true }); let current = target;
  while (true) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`OMP managed path is unsafe: ${current}`);
    if (current === boundary) return;
    current = dirname(current);
  }
}
function assertExistingDirectoryTree(boundaryPath: string, targetPath: string, label: string): void {
  const boundary = resolve(boundaryPath); const target = resolve(targetPath);
  if (target !== boundary && !target.startsWith(`${boundary}/`)) throw new Error(`${label} escapes its approved cache root`);
  for (let current = target; ; current = dirname(current)) {
    if (!lstatExists(current)) throw new Error(`${label} has no safe native copy`);
    const stat = lstatSync(current); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} contains a symlink or non-directory component: ${current}`);
    if (current === boundary) return;
  }
}
function sameTree(left: string, right: string): boolean {
  if (!existsSync(right)) return false; const bytes = readFileSync as unknown as (path: string) => Uint8Array;
  const list = (root: string): string[] => { const out: string[] = []; const walk = (dir: string, prefix: string): void => { for (const name of readdirSync(dir).sort()) { if (name === MARKER) continue; const path = join(dir, name); const rel = prefix ? `${prefix}/${name}` : name; const stat = lstatSync(path); if (stat.isSymbolicLink()) throw new Error(`OMP managed plugin contains symlink: ${path}`); if (stat.isDirectory()) walk(path, rel); else if (stat.isFile()) out.push(`${rel}:${Array.from(bytes(path)).join(',')}`); else throw new Error(`OMP managed plugin contains unsupported file: ${path}`); } }; walk(root, ''); return out; };
  return JSON.stringify(list(left)) === JSON.stringify(list(right));
}
function ownership(path: string): Ownership | null {
  const marker = join(path, MARKER);
  if (!existsSync(marker)) return null;
  const value = readDoc(marker, {}, 'ownership marker');
  if (typeof value.source !== 'string' || typeof value.pluginId !== 'string' || typeof value.fingerprint !== 'string' || typeof value.packageName !== 'string') throw new Error(`invalid plgnz ownership marker: ${marker}`);
  const sourceType = value.sourceType === 'local' || value.sourceType === 'git' ? value.sourceType : undefined;
  const sourceLocator = value.sourceLocator === null || typeof value.sourceLocator === 'string' ? value.sourceLocator : undefined;
  return {
    source: value.source,
    pluginId: value.pluginId,
    fingerprint: value.fingerprint,
    packageName: value.packageName,
    ...(typeof value.scopeId === 'string' ? { scopeId: value.scopeId } : {}),
    ...(sourceType === undefined ? {} : { sourceType }),
    ...(typeof value.sourceRevision === 'string' ? { sourceRevision: value.sourceRevision } : {}),
    ...(sourceLocator === undefined ? {} : { sourceLocator }),
  };
}
function readDoc(path: string, fallback: Doc, label: string): Doc { if (!existsSync(path)) return fallback; try { const value: unknown = JSON.parse(readFileSync(path, 'utf8')); if (!isDoc(value)) throw new Error('expected object'); return value; } catch (error) { throw new Error(`invalid OMP ${label}: ${path} (${(error as Error).message})`); } }
function object(value: unknown, label: string): Doc { if (!isDoc(value)) throw new Error(`invalid OMP ${label}`); return value; }
function isDoc(value: unknown): value is Doc { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function userRows(value: unknown): Array<Doc & { installPath?: unknown }> { return Array.isArray(value) ? value.filter((row): row is Doc & { installPath?: unknown } => isDoc(row) && row.scope === 'user') : []; }
function nonUserRows(value: unknown): unknown[] { return Array.isArray(value) ? value.filter(row => !isDoc(row) || row.scope !== 'user') : []; }
function writeDoc(path: string, value: unknown): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2)); }
function snapshot(path: string): string | undefined { return existsSync(path) ? readFileSync(path, 'utf8') : undefined; }
function restore(path: string, value: string | undefined): void { if (value === undefined) rmSync(path, { force: true }); else writeFileSync(path, value); }
function assertIdentity(value: string, label: string): void { if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(value)) throw new Error(`unsafe OMP ${label}: ${value}`); }

const hostTransition: ActivationTransitionObservation = { requirement: 'none', status: 'effective' };
const supportedSemantics = new Set<PackageSemantic>([
  'ordinary-skills', 'mcp', 'commands', 'model-invocation-control', 'auto-update-control', 'resources',
  'retirement', 'retention-safety', 'readback', 'rollback', 'activation-reload', 'reversible-disable',
]);
const ompManagedProfile = createCapabilityEvidenceProfile({
  host: 'omp',
  detectedVersion: '18.1.4',
  sourceTypes: ['local', 'git'],
  operations: ['install', 'update', 'disable', 'retire'],
  route: 'managed',
  operationStatus: 'supported',
  semantics: Object.fromEntries(PACKAGE_SEMANTICS.map((semantic) => [semantic, supportedSemantics.has(semantic) ? 'supported' : 'unsupported'])) as Record<PackageSemantic, CapabilityStatus>,
  evidence: [
    'docs/evidence/omp-native-extension-package-20260923.json',
    'docs/hosts/omp.md',
    'docs/research/native-plugin-update-capabilities-2026-10-09.md',
  ],
});

const ompLifecycleDefinition: LifecycleHostDefinition = {
  id: 'omp',
  evidenceProfiles: [ompManagedProfile],
  probeVersion: (target) => probeOmpVersion(target),
  observeTarget: (target) => observeInventory(target),
  observeNativeMutationScope: (request) => Promise.resolve(ompUpgradeMutationScope(unprovenCandidate(request.nativeId), request.nativeId)),
  observeNativeProjection: (request) => Promise.resolve(ompUpgradeProjection(unprovenCandidate(nativeIdOfProjection(request)))),
  revalidateTargetPrecondition: async (handle) => ({
    version: await probeOmpVersion(handle.target),
    targetObservationId: createTargetInventoryObservation('omp', await observeInventory(handle.target)).observationId,
  }),
  stageActivation: async (request) => {
    const nativeId = request.snapshot.nativeId;
    const { marketplace, plugin } = parsePublicId(nativeId);
    if (request.snapshot.packageName !== plugin) throw new Error(`OMP package name does not match native id: ${request.snapshot.packageName}`);
    const npm = nativePackageName(marketplace, plugin);
    const version = request.snapshot.inventory.package.version ?? request.snapshot.packageFingerprint;
    const parent = preparationDir(request.snapshot.attemptId, request.snapshot.operationId);
    mkdirSafe(parent);
    const stage = join(parent, 'stage');
    rmSync(stage, { recursive: true, force: true });
    projectPluginForOmp(request.snapshot.packageRoot, stage, { packageName: npm, version, activeRoot: managedPackageDir(nativeId), namespace: plugin });
    const locator = request.snapshot.sourceType === 'git' ? request.snapshot.nativeGit?.locator ?? null : null;
    writeFileSync(join(stage, MARKER), JSON.stringify({
      source: locator ?? request.snapshot.immutableRevision,
      pluginId: nativeId,
      fingerprint: request.snapshot.packageFingerprint,
      packageName: npm,
      scopeId: request.snapshot.scopeId,
      sourceType: request.snapshot.sourceType,
      sourceRevision: request.snapshot.immutableRevision,
      sourceLocator: locator,
    } satisfies Ownership));
    return { stagingId: `${request.snapshot.attemptId}:${request.snapshot.operationId}`, stagingRoot: resolve(stage) };
  },
  applyLifecycleDirectives: () => Promise.resolve([]),
  applyPins: async (projection) => {
    if (projection.pins.length === 0) return [];
    const outcome = pinPluginMcpFiles(projection.stagingRoot, mcpCandidates(), {});
    const applied = outcome.changes.map((change) => change.server);
    if (JSON.stringify(applied) !== JSON.stringify(projection.pins.map((pin) => pin.server))) throw new Error('OMP pin proof does not match the requested servers');
    return applied;
  },
  captureActivationPreparation: async (projection, projectedFingerprint) => ({
    prior: observeReadback(projection),
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
      transition: hostTransition,
      installedFingerprint: projectedFingerprint,
      contentRoots: [{ label: 'package', path: managedPackageDir(projection.nativeId), fingerprint: projectedFingerprint }],
      retention: {
        pluginData: resourceObservation(join(pluginsDir(), 'data', npmName(projection.nativeId))),
        inactiveMetadata: plannedLockMetadata(projection.nativeId, projection.packageVersion ?? '0.0.0'),
      },
    },
    rollbackReference: captureRollback(projection.nativeId, projection.attemptId, projection.operationId),
    rollbackCoverageOperationIds: projection.affectedOperationIds,
  }),
  captureDisablePreparation: async (request) => captureRecorded(request.activation, request.selection.route, request.attemptId, request.operationId, request.selection.affectedOperationIds),
  captureRetirementPreparation: async (request) => captureRecorded(request.activation, request.selection.route, request.attemptId, request.operationId, request.selection.affectedOperationIds),
  apply: async (prepared) => applyManaged(prepared.handle, prepared.stagingRoot),
  disable: async (prepared) => disableManaged(prepared.handle),
  retire: async (prepared) => retireManaged(prepared.handle),
  readback: (handle) => Promise.resolve(observeReadback(handle)),
  rollback: async (handle) => {
    restoreRollback(handle.nativeId, handle.rollbackReference);
    return { receiptId: `rollback:${handle.attemptId}:${handle.operationId}`, changed: true };
  },
  cleanup: async (reference, disposition) => {
    assertDisposition(disposition);
    rmSync(preparationDir(reference.attemptId, reference.operationId), { recursive: true, force: true });
    return { cleanupId: `cleanup:${reference.attemptId}:${reference.operationId}`, completed: true };
  },
};

export const ompLifecycle = createLifecycleHostAdapter(ompLifecycleDefinition);

function assertDisposition(disposition: CleanupDisposition): void {
  switch (disposition) {
    case 'aborted-preparation':
    case 'verified-commit':
    case 'verified-rollback':
      return;
    default: {
      const unreachable: never = disposition;
      throw new Error(`unknown OMP cleanup disposition: ${String(unreachable)}`);
    }
  }
}

function parsePublicId(id: string): { marketplace: string; plugin: string } {
  const at = id.indexOf('@');
  if (at <= 0 || at !== id.lastIndexOf('@')) throw new Error(`OMP native id must be plugin@marketplace: ${id}`);
  const plugin = id.slice(0, at);
  const marketplace = id.slice(at + 1);
  assertIdentity(marketplace, 'marketplace');
  assertIdentity(plugin, 'plugin');
  return { marketplace, plugin };
}

function npmName(nativeId: string): string {
  const { marketplace, plugin } = parsePublicId(nativeId);
  return nativePackageName(marketplace, plugin);
}

function managedPackageDir(nativeId: string): string {
  const { marketplace, plugin } = parsePublicId(nativeId);
  return resolve(join(pluginsDir(), MANAGED, nativeSlug(marketplace, plugin)));
}

function managedLink(nativeId: string): string {
  return resolve(join(pluginsDir(), 'node_modules', npmName(nativeId)));
}

function lockPath(): string { return join(pluginsDir(), 'omp-plugins.lock.json'); }

function preparationDir(attemptId: string, operationId: string): string {
  return resolve(join(pluginsDir(), '.plgnz-lifecycle', encodeURIComponent(attemptId), encodeURIComponent(operationId)));
}

function unprovenCandidate(nativeId: string): OmpNativeUpgradeCandidate {
  const { marketplace, plugin } = parsePublicId(nativeId);
  return { kind: 'exact-package', target: { marketplace, pluginId: plugin }, catalog: null, readback: null, rollback: null, retirement: null };
}

function nativeIdOfProjection(request: NativeProjectionRequest): string {
  return 'snapshot' in request ? request.snapshot.nativeId : request.activation.nativeId;
}

async function probeOmpVersion(target: LifecycleTargetIdentity): Promise<TargetVersionObservation> {
  assertOmpTarget(target);
  const binary = process.env['OPEN_PLUGIN_OMP_BIN'] ?? which('omp');
  if (binary === null) return { kind: 'unknown' };
  const home = mkdtempSync(join(tmpdir(), 'plgnz-omp-probe-'));
  try {
    const result = spawnSync([binary, '--version'], {
      cwd: home,
      timeout: 5000,
      env: { PATH: process.env['PATH'] ?? '', HOME: home, PI_CONFIG_DIR: join(home, '.omp') },
    });
    if (result.exitCode !== 0) return { kind: 'unknown' };
    const stdout = Array.from(result.stdout, (byte) => String.fromCharCode(byte)).join('');
    const match = stdout.match(/\d+\.\d+\.\d+/u);
    if (match === null) return { kind: 'unparseable' };
    return { kind: 'detected', version: match[0], probeId: `omp:${match[0]}` };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function assertOmpTarget(target: LifecycleTargetIdentity): void {
  if (target.kind !== 'omp' || target.instance !== 'default' || target.context !== undefined) throw new Error('OMP lifecycle target must be the default instance without context');
}

async function observeInventory(target: LifecycleTargetIdentity): Promise<TargetInventoryData> {
  assertOmpTarget(target);
  return { target, installations: omp.listInstalled().map((plugin) => installationOf(plugin)) };
}

function installationOf(plugin: InstalledPlugin): TargetInstallationData {
  const path = plugin.path !== undefined && existsSync(plugin.path) ? resolve(plugin.path) : undefined;
  if (path === undefined) {
    return {
      nativeId: plugin.id, packageName: plugin.name, ownership: { kind: 'unmanaged' }, presence: 'absent',
      enablement: 'unknown', activation: 'unknown', installedFingerprint: null, installedVersion: plugin.version ?? null,
      source: null, contentRoots: [],
    };
  }
  const owner = ownership(path);
  const digest = fingerprintTree(path);
  const enabled = plugin.enabled !== false;
  return {
    nativeId: plugin.id,
    packageName: plugin.name,
    ownership: owner?.scopeId !== undefined ? { kind: 'owned', proof: 'created', scopeId: owner.scopeId, proofId: owner.fingerprint } : { kind: 'unmanaged' },
    presence: 'present',
    enablement: enabled ? 'enabled' : 'disabled',
    activation: enabled ? 'active' : 'inactive',
    installedFingerprint: digest,
    installedVersion: plugin.version ?? null,
    source: sourceOf(owner),
    contentRoots: [{ label: 'package', path, fingerprint: digest }],
  };
}

function sourceOf(owner: Ownership | null): TargetInstallationData['source'] {
  if (owner?.sourceType === 'local' && owner.sourceRevision !== undefined) return { type: 'local', immutableRevision: owner.sourceRevision, locator: null };
  if (owner?.sourceType === 'git' && owner.sourceRevision !== undefined && typeof owner.sourceLocator === 'string') return { type: 'git', immutableRevision: owner.sourceRevision, locator: owner.sourceLocator };
  return null;
}

function observeReadback(identity: Pick<DurableLifecycleOperation, 'adapterId' | 'target' | 'scopeId' | 'packageName' | 'nativeId' | 'route'>): LifecycleReadbackData {
  const target = managedPackageDir(identity.nativeId);
  const present = existsSync(target) && linkPointsTo(managedLink(identity.nativeId), target);
  const retention = retentionOf(identity.nativeId);
  if (!present) {
    return {
      adapterId: identity.adapterId, target: identity.target, scopeId: identity.scopeId, packageName: identity.packageName,
      nativeId: identity.nativeId, route: identity.route, presence: 'absent', enablement: 'disabled', activation: 'inactive',
      transition: hostTransition, installedFingerprint: null, contentRoots: [], retention,
    };
  }
  const digest = fingerprintTree(target);
  const enabled = packageEnabled(identity.nativeId);
  return {
    adapterId: identity.adapterId, target: identity.target, scopeId: identity.scopeId, packageName: identity.packageName,
    nativeId: identity.nativeId, route: identity.route, presence: 'present', enablement: enabled ? 'enabled' : 'disabled',
    activation: enabled ? 'active' : 'inactive', transition: hostTransition, installedFingerprint: digest,
    contentRoots: [{ label: 'package', path: target, fingerprint: digest }], retention,
  };
}

function retentionOf(nativeId: string): LifecycleReadbackData['retention'] {
  return {
    pluginData: resourceObservation(join(pluginsDir(), 'data', npmName(nativeId))),
    inactiveMetadata: lockMetadataObservation(nativeId),
  };
}

function resourceObservation(path: string): LifecycleReadbackData['retention']['pluginData'] {
  if (!existsSync(path)) return { state: 'absent', fingerprint: null };
  return { state: 'present', fingerprint: fingerprintTree(path) };
}

function lockMetadataObservation(nativeId: string): LifecycleReadbackData['retention']['inactiveMetadata'] {
  if (!existsSync(lockPath())) return { state: 'absent', fingerprint: null };
  return { state: 'present', fingerprint: sha256(canonical(metadataView(readDoc(lockPath(), {}, 'lockfile'), npmName(nativeId)))) };
}

function plannedLockMetadata(nativeId: string, version: string): LifecycleReadbackData['retention']['inactiveMetadata'] {
  const lock = existsSync(lockPath()) ? readDoc(lockPath(), {}, 'lockfile') : { plugins: {}, settings: {} };
  const plugins = isDoc(lock.plugins) ? lock.plugins : {};
  const npm = npmName(nativeId);
  const next = { ...lock, plugins: { ...plugins, [npm]: activatedEntry(entry(plugins[npm]), version) } };
  return { state: 'present', fingerprint: sha256(canonical(metadataView(next, npm))) };
}

function metadataView(lock: Doc, packageName: string): { enabledFeatures: unknown; settings: unknown; lockSettings: unknown } {
  const plugins = isDoc(lock.plugins) ? lock.plugins : {};
  const row = entry(plugins[packageName]);
  return {
    enabledFeatures: 'enabledFeatures' in row ? row.enabledFeatures : null,
    settings: 'settings' in row ? row.settings : null,
    lockSettings: 'settings' in lock ? lock.settings : null,
  };
}

function packageEnabled(nativeId: string): boolean {
  const lock = readDoc(lockPath(), { plugins: {}, settings: {} }, 'lockfile');
  const plugins = isDoc(lock.plugins) ? lock.plugins : {};
  return lockEnabled(plugins[npmName(nativeId)]);
}

function sha256(value: string): string {
  const hash = new CryptoHasher('sha256');
  hash.update(value);
  return hash.digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  if (isDoc(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function captureRollback(nativeId: string, attemptId: string, operationId: string): string {
  const reference = join(preparationDir(attemptId, operationId), 'rollback');
  rmSync(reference, { recursive: true, force: true });
  mkdirSafe(preparationDir(attemptId, operationId));
  mkdirSync(reference, { recursive: true });
  const target = managedPackageDir(nativeId);
  if (existsSync(target)) cpSync(target, join(reference, 'package'), { recursive: true });
  writeFileSync(join(reference, 'state.json'), JSON.stringify({ lock: snapshot(lockPath()) ?? null, link: currentLinkTarget(managedLink(nativeId)) } satisfies RollbackState));
  return resolve(reference);
}

function restoreRollback(nativeId: string, reference: string): void {
  const state = JSON.parse(readFileSync(join(reference, 'state.json'), 'utf8')) as RollbackState;
  const target = managedPackageDir(nativeId);
  rmSync(target, { recursive: true, force: true });
  const backup = join(reference, 'package');
  if (existsSync(backup)) { mkdirSafe(dirname(target)); cpSync(backup, target, { recursive: true }); }
  const link = managedLink(nativeId);
  rmSync(link, { recursive: true, force: true });
  if (state.link !== null) { mkdirSafe(dirname(link)); symlinkSync(state.link, link, 'dir'); }
  restore(lockPath(), state.lock ?? undefined);
}

function currentLinkTarget(path: string): string | null {
  try { return lstatSync(path).isSymbolicLink() ? resolve(dirname(path), readlinkSync(path)) : null; } catch { return null; }
}

async function applyManaged(handle: DurableLifecycleOperation, stagingRoot: string): Promise<MutationResultData> {
  const version = handle.packageVersion ?? '0.0.0';
  const receiptId = `apply:${handle.attemptId}:${handle.operationId}`;
  if (activationAlreadyCurrent(handle.nativeId, stagingRoot, version)) return { receiptId, changed: false };
  const npm = npmName(handle.nativeId);
  const target = managedPackageDir(handle.nativeId);
  const link = managedLink(handle.nativeId);
  const file = lockPath();
  const lock = readDoc(file, { plugins: {}, settings: {} }, 'lockfile');
  const plugins = object(lock.plugins, 'lockfile plugins');
  const before = snapshot(file);
  mkdirSafe(dirname(target));
  mkdirSafe(dirname(link));
  let active: Move | null = null;
  let previousLink: Move | null = null;
  let createdLink = false;
  try {
    active = activate(stagingRoot, target);
    previousLink = moveExisting(link);
    symlinkSync(target, link, 'dir');
    createdLink = true;
    writeDoc(file, { ...lock, plugins: { ...plugins, [npm]: activatedEntry(entry(plugins[npm]), version) } });
  } catch (error) {
    if (createdLink) rmSync(link, { recursive: true, force: true });
    previousLink?.rollback();
    active?.rollback();
    restore(file, before);
    throw error;
  }
  previousLink?.commit();
  active?.commit();
  return { receiptId, changed: true };
}

function activationAlreadyCurrent(nativeId: string, stage: string, version: string): boolean {
  const target = managedPackageDir(nativeId);
  if (!existsSync(target) || !existsSync(stage) || fingerprintTree(stage) !== fingerprintTree(target) || !linkPointsTo(managedLink(nativeId), target)) return false;
  const lock = readDoc(lockPath(), { plugins: {}, settings: {} }, 'lockfile');
  const plugins = object(lock.plugins, 'lockfile plugins');
  const row = entry(plugins[npmName(nativeId)]);
  return row.enabled === true && row.version === version;
}

async function disableManaged(handle: DurableLifecycleOperation): Promise<MutationResultData> {
  const receiptId = `disable:${handle.attemptId}:${handle.operationId}`;
  const file = lockPath();
  const lock = readDoc(file, { plugins: {}, settings: {} }, 'lockfile');
  const plugins = object(lock.plugins, 'lockfile plugins');
  const npm = npmName(handle.nativeId);
  const previous = entry(plugins[npm]);
  if (previous.enabled === false) return { receiptId, changed: false };
  const before = snapshot(file);
  try { writeDoc(file, { ...lock, plugins: { ...plugins, [npm]: { ...previous, enabled: false } } }); }
  catch (error) { restore(file, before); throw error; }
  return { receiptId, changed: true };
}

async function retireManaged(handle: DurableLifecycleOperation): Promise<MutationResultData> {
  const receiptId = `retire:${handle.attemptId}:${handle.operationId}`;
  const owned = findOwned(handle.nativeId);
  const link = managedLink(handle.nativeId);
  if (owned === null && !lstatExists(link)) return { receiptId, changed: false };
  if (owned !== null && lstatExists(link) && !linkPointsTo(link, owned.path)) throw new Error(`OMP native link for ${handle.nativeId} is missing or redirected; refusing to retire it`);
  let movedRoot: Move | null = null;
  let movedLink: Move | null = null;
  try {
    if (owned !== null) movedRoot = moveExisting(owned.path);
    if (lstatExists(link)) movedLink = moveExisting(link);
  } catch (error) {
    movedLink?.rollback();
    movedRoot?.rollback();
    throw error;
  }
  movedLink?.commit();
  movedRoot?.commit();
  return { receiptId, changed: true };
}

type RollbackState = { lock: string | null; link: string | null };

function captureRecorded(
  activation: { target: LifecycleTargetIdentity; scopeId: string; packageName: string; nativeId: string },
  route: 'managed' | 'native',
  attemptId: string,
  operationId: string,
  affectedOperationIds: readonly string[],
): RetirementPreparationCapture {
  return {
    prior: observeReadback({ adapterId: 'omp', target: activation.target, scopeId: activation.scopeId, packageName: activation.packageName, nativeId: activation.nativeId, route }),
    rollbackReference: captureRollback(activation.nativeId, attemptId, operationId),
    rollbackCoverageOperationIds: affectedOperationIds,
    transition: hostTransition,
  };
}
