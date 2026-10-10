/** Official ZCode CLI marketplace writer. */
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createCapabilityEvidenceProfile, type CapabilityEvidenceProfile, type CapabilityStatus } from '../capability-evidence';
import { normalizeCommandTree } from '../conversion';
import { fingerprintTree } from '../fingerprint';
import type { AddOptions, HostWriter, InstalledPlugin, PinOptions, PinOutcome } from '../host';
import type {
  CleanupDisposition,
  CleanupReference,
  CleanupResultData,
  DurableLifecycleOperation,
  LifecycleHostDefinition,
  LifecycleReadbackData,
  LifecycleTargetIdentity,
  NativeMutationScopeData,
  NativeProjectionData,
  NativeProjectionRequest,
  RetentionObservation,
  TargetInstallationData,
  TargetInventoryData,
  TargetVersionObservation,
} from '../lifecycle-host';
import { createLifecycleHostAdapter, createTargetInventoryObservation } from '../lifecycle-runtime';
import { zcodeCliConfigRoot, zcodeCliRoot } from '../paths';
import { CryptoHasher, spawnSync as bunShapedSpawnSync } from '../runtime';
import { PACKAGE_SEMANTICS, type PackageSemantic } from '../semantic-inventory';
import type { PluginSource, ResolvedSource } from '../source';
import { yamlParse, yamlStringify } from '../yaml';
import { assertZcodeNativeRegistryReadable, readZcodeEnabledPluginIds, readZcodeNativeRecords, readZcodeOwnership, resolveOfficialZcodeCli, runOfficialZcode, zcodeCli, zcodeCliEnv, zcodeMarketplaceRoot, zcodeRegistryFile, zcodeResourceRoot, zcodeSafeInstallRoot } from './zcode-cli';

declare const TextDecoder: { new (): { decode(input: Uint8Array): string } };


const MARKER = '.plgnz-install.json';
type Ownership = { owner: 'plgnz'; schema: 1; logicalId: string; nativeId: string; fingerprint: string; source: string; resourcePath: string };

export const zcodeCliWriter: HostWriter = {
  ...zcodeCli,
  supportsAdoption: false,
  plannedNativeId: (plugin) => plugin.marketplace === undefined ? plugin.name : `${plugin.name}@${plugin.marketplace}`,
  async add(plugin: PluginSource, resolved: ResolvedSource, opts?: AddOptions): Promise<void | 'unchanged'> {
    if (opts?.adoptExisting) throw new Error('Official ZCode adoption is not implemented; refusing an unowned native install');
    assertName(plugin.name, 'plugin name');
    const logicalId = plugin.marketplace === undefined ? plugin.name : `${plugin.name}@${plugin.marketplace}`;
    const fingerprint = requireFingerprint(plugin);
    const nativeVersion = versionFor(plugin, fingerprint);
    const market = ownedMarketplace(logicalId);
    const nativeId = `${plugin.name}@${market}`;
    assertZcodeNativeRegistryReadable();
    const prior = nativeById(nativeId);
    if (prior !== undefined) provePrior(prior, logicalId, nativeId, resolved.sourceUri);
    const stageParent = join(zcodeCliRoot(), '.plgnz-zcode-stage');
    mkdirSync(opts?.dryRun ? tmpdir() : stageParent, { recursive: true });
    const stage = mkdtempSync(join(opts?.dryRun ? tmpdir() : stageParent, 'candidate-'));
    const stagedMarket = join(stage, market); const stagedResources = join(stage, 'resources');
    const marketRoot = join(zcodeMarketplaceRoot(), market); const resourceRoot = join(zcodeResourceRoot(), market, fingerprint);
    try {
      stagePackage(plugin, stagedMarket, stagedResources, resourceRoot, logicalId, nativeId, nativeVersion, fingerprint, resolved.sourceUri);
      rejectCommandCollisions(stagedMarket, nativeId, prior?.installPath);
      assertReplaceableOwnedRoots(marketRoot, resourceRoot, plugin.name, prior, logicalId, nativeId, resolved.sourceUri);
      if (prior !== undefined && prior.version === nativeVersion && readZcodeEnabledPluginIds().get(nativeId) === true && sameCandidate(prior, stagedMarket, stagedResources, resourceRoot, logicalId, nativeId, resolved.sourceUri, fingerprint)) return 'unchanged';
      if (opts?.dryRun) return;
      const marketBackup = moveAside(marketRoot);
      const resourceBackup = moveAside(resourceRoot);
      try {
        mkdirSync(dirname(marketRoot), { recursive: true }); mkdirSync(dirname(resourceRoot), { recursive: true });
        renameSync(stagedMarket, marketRoot);
        renameSync(stagedResources, resourceRoot);
        const expectedResourceFingerprint = fingerprintTree(resourceRoot);
        if (prior === undefined) {
          runOfficialZcode(['plugins', 'marketplace', 'add', marketRoot]);
          runOfficialZcode(['plugins', 'install', nativeId]);
        } else {
          runOfficialZcode(['plugins', 'marketplace', 'update', market]);
          runOfficialZcode(['plugins', 'update', nativeId]);
        }
        proveActive(nativeId, logicalId, resolved.sourceUri, fingerprint, nativeVersion, join(marketRoot, 'plugins', plugin.name), resourceRoot, expectedResourceFingerprint);
      } catch (error) {
        // The old cache remains native-selected on documented update failure.
        // Restore the old marketplace source before trying a compensating refresh.
        rmSync(marketRoot, { recursive: true, force: true }); marketBackup.rollback();
        rmSync(resourceRoot, { recursive: true, force: true }); resourceBackup.rollback();
        if (prior !== undefined) restorePrior(nativeId, market, prior);
        else removeCandidate(nativeId, logicalId, resolved.sourceUri, fingerprint);
        throw error;
      }
      marketBackup.commit(); resourceBackup.commit();
    } finally { rmSync(stage, { recursive: true, force: true }); }
  },
  async remove(id: string): Promise<void> {
    assertZcodeNativeRegistryReadable();
    const native = nativeForLogical(id);
    if (native === undefined) throw new Error(`Official ZCode plugin ${id} is not a proven plgnz-owned install`);
    retireOwned(native.id);
    if (nativeById(native.id) !== undefined) throw new Error(`Official ZCode did not remove ${id}`);
  },
  async pin(_plugin: InstalledPlugin, _opts?: PinOptions): Promise<PinOutcome> { return { changes: [], refusals: [] }; },
};

/** Stages a namespaced command projection without invoking the native CLI. */
export function projectZcodePlugin(source: string, destination: string, resourceCopy: string, resourceLinkRoot: string, logicalId: string, nativeId: string, nativeVersion: string, fingerprint: string, sourceUri: string): void {
  const input = resolve(source); const target = resolve(destination); const ownedResources = resolve(resourceCopy); const links = resolve(resourceLinkRoot);
  if (!existsSync(input) || !statSync(input).isDirectory()) throw new Error(`ZCode plugin source is not a directory: ${input}`);
  if (target.startsWith(`${input}/`) || ownedResources.startsWith(`${input}/`)) throw new Error('ZCode projected outputs must not be inside the source');
  assertNoSymlinks(input); cpSync(input, target, { recursive: true });
  validateRootManifest(target);
  projectCommands(target, sourceName(target));
  projectUserOnlySkills(target, ownedResources, links, sourceName(target));
  const manifest: Record<string, unknown> = { name: sourceName(target), version: nativeVersion };
  const rootManifest = readJson(join(target, 'plugin.json'));
  for (const key of ['description', 'author', 'license']) if (typeof rootManifest?.[key] === 'string') manifest[key] = rootManifest[key];
  if (hasSkill(target)) manifest['skills'] = 'skills';
  if (hasCommand(target)) manifest['commands'] = 'commands';
  mkdirSync(join(target, '.zcode-plugin'), { recursive: true });
  writeFileSync(join(target, '.zcode-plugin', 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(target, MARKER), `${JSON.stringify({ owner: 'plgnz', schema: 1, logicalId, nativeId, fingerprint, source: sourceUri, resourcePath: resourceLinkRoot } satisfies Ownership, null, 2)}\n`);
  assertNoSymlinks(target); assertNoSymlinks(ownedResources);
}

function stagePackage(plugin: PluginSource, market: string, resources: string, resourceLinkRoot: string, logicalId: string, nativeId: string, nativeVersion: string, fingerprint: string, source: string): void {
  const packageRoot = join(market, 'plugins', plugin.name);
  mkdirSync(dirname(packageRoot), { recursive: true }); mkdirSync(resources, { recursive: true });
  projectZcodePlugin(plugin.dir, packageRoot, resources, resourceLinkRoot, logicalId, nativeId, nativeVersion, fingerprint, source);
  writeFileSync(join(market, 'marketplace.json'), `${JSON.stringify({ name: nativeId.slice(nativeId.indexOf('@') + 1), plugins: [{ name: plugin.name, source: `./plugins/${plugin.name}` }] }, null, 2)}\n`);
}

function projectCommands(root: string, pluginName: string): void {
  const source = join(root, 'commands'); if (!existsSync(source)) return;
  if (!statSync(source).isDirectory()) throw new Error(`ZCode commands path is not a directory: ${source}`);
  const temp = join(root, '.plgnz-zcode-commands'); renameSync(source, temp);
  try {
    normalizeCommandTree(temp);
    copyCommandTree(temp, join(root, 'commands', pluginName));
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
function copyCommandTree(source: string, dest: string): void {
  for (const entry of readdirSync(source)) {
    const from = join(source, entry); const to = join(dest, entry); const stat = lstatSync(from);
    if (stat.isSymbolicLink()) throw new Error(`ZCode command source contains symlink: ${from}`);
    if (stat.isDirectory()) { copyCommandTree(from, to); continue; }
    if (!stat.isFile() || !entry.endsWith('.md')) throw new Error(`ZCode command source must be Markdown: ${from}`);
    const text = readFileSync(from, 'utf8'); validateCommand(text, from); mkdirSync(dirname(to), { recursive: true }); writeFileSync(to, text);
  }
}
function projectUserOnlySkills(root: string, resources: string, resourceLinks: string, pluginName: string): void {
  const skills = join(root, 'skills'); if (!existsSync(skills)) return;
  if (!statSync(skills).isDirectory()) throw new Error(`ZCode skills path is not a directory: ${skills}`);
  for (const entry of readdirSync(skills)) {
    const dir = join(skills, entry); if (!statSync(dir).isDirectory()) throw new Error(`ZCode skill is not a directory: ${dir}`);
    const skill = join(dir, 'SKILL.md'); if (!existsSync(skill)) continue;
    const raw = readFileSync(skill, 'utf8'); const fm = frontmatter(raw, skill);
    const hidden = fm.values['disable-model-invocation'] ?? fm.values['disable_model_invocation'];
    const invocable = fm.values['user-invocable'] ?? fm.values['user_invocable'];
    if (hidden !== undefined && typeof hidden !== 'boolean') throw new Error(`ZCode disable-model-invocation must be boolean: ${skill}`);
    if (invocable !== undefined && typeof invocable !== 'boolean') throw new Error(`ZCode user-invocable must be boolean: ${skill}`);
    if (hidden !== true) continue;
    if (invocable === false) throw new Error(`ZCode cannot represent user-invocable: false as a command: ${skill}`);
    const name = typeof fm.values['name'] === 'string' ? fm.values['name'] : entry; assertName(name, 'user-only skill name');
    const command = join(root, 'commands', pluginName, `${name}.md`);
    if (existsSync(command)) throw new Error(`ZCode command collision for user-only skill ${name}`);
    for (const key of Object.keys(fm.values)) if (!['name', 'description', 'disable-model-invocation', 'disable_model_invocation', 'user-invocable', 'user_invocable', 'argument-hint', 'allowed-tools', 'disable-noninteractive', 'model', 'skills'].includes(key)) throw new Error(`ZCode unsupported user-only skill metadata ${key}: ${skill}`);
    const resource = join(resources, 'skills', entry); const linkResource = join(resourceLinks, 'skills', entry); copyResources(dir, resource);
    const commandMeta: string[] = [`description: ${JSON.stringify(typeof fm.values['description'] === 'string' ? fm.values['description'] : name)}`];
    for (const key of ['argument-hint', 'allowed-tools', 'disable-noninteractive', 'model', 'skills']) {
      const value = fm.values[key]; if (value === undefined) continue;
      commandMeta.push(`${key}: ${key === 'argument-hint' ? argumentHint(value, skill) : JSON.stringify(value)}`);
    }
    const body = raw.slice(fm.end); validateCommand(`---\n${commandMeta.join('\n')}\n---\n${body}`, skill);
    mkdirSync(dirname(command), { recursive: true });
    writeFileSync(command, `---\n${commandMeta.join('\n')}\n---\n${rewriteLinks(body, dir, linkResource, skill)}`);
    rmSync(dir, { recursive: true, force: true });
  }
}
function copyResources(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const name of readdirSync(source)) {
    if (name === 'SKILL.md') continue;
    const from = join(source, name); const stat = lstatSync(from); if (stat.isSymbolicLink()) throw new Error(`ZCode resource contains symlink: ${from}`);
    cpSync(from, join(destination, name), { recursive: true });
  }
}
function rewriteLinks(body: string, source: string, resources: string, label: string): string {
  if (/\]\s*\[[^\]]+\]/u.test(body)) throw new Error(`ZCode unsupported reference-style Markdown link: ${label}`);
  // Inline code spans are not links; mask them before rewriting so example
  // syntax like `[title](link)` inside backticks stays literal (CommonMark).
  const spans: string[] = [];
  const masked = body.replace(/(`+)([\s\S]*?)\1/gu, (all) => { spans.push(all); return `\u0000${spans.length - 1}\u0000`; });
  const rewritten = masked.replace(/(!?\[[^\]]*\])\(([^)\s]+)(\s+[^)]*)?\)/gu, (all, text: string, target: string, suffix: string | undefined) => {
    if (/^(?:https?:|mailto:|#)/iu.test(target)) return all;
    if (target.startsWith('/') || target.includes('\\')) throw new Error(`ZCode unsupported absolute resource reference: ${label}`);
    const absolute = resolve(source, target); const rel = relative(source, absolute);
    if (rel === '' || rel.startsWith('..') || !existsSync(absolute) || !statSync(absolute).isFile()) throw new Error(`ZCode resource reference escapes or is missing: ${label} (${target})`);
    return `${text}(${join(resources, rel)}${suffix ?? ''})`;
  });
  return rewritten.replace(/\u0000(\d+)\u0000/gu, (_, index: string) => spans[Number(index)] ?? '');
}
function validateCommand(raw: string, file: string): void {
  const fm = frontmatter(raw, file);
  for (const key of Object.keys(fm.values)) if (!['description', 'argument-hint', 'disable-noninteractive', 'model', 'skills'].includes(key)) throw new Error(`ZCode unsupported command metadata ${key}: ${file}`);
  if (/(?:^|\n)\s*!|!`/u.test(raw.slice(fm.end))) throw new Error(`ZCode shell command expansion is unsupported: ${file}`);
}
function validateRootManifest(root: string): void {
  const manifest = readJson(join(root, 'plugin.json'));
  if (manifest === null || typeof manifest['name'] !== 'string') throw new Error(`ZCode projection requires plugin.json name: ${root}`);
  for (const key of Object.keys(manifest)) if (['hooks', 'mcpServers', 'agents', 'agent', 'executables'].includes(key)) throw new Error(`ZCode root plugin semantic is unsupported: ${key}`);
}
function sourceName(root: string): string { const name = readJson(join(root, 'plugin.json'))?.['name']; if (typeof name !== 'string') throw new Error(`ZCode projection requires plugin.json name: ${root}`); return name; }
function readJson(file: string): Record<string, unknown> | null { try { const value: unknown = JSON.parse(readFileSync(file, 'utf8')); return isObject(value) ? value : null; } catch { return null; } }
function frontmatter(raw: string, file: string): { values: Record<string, unknown>; end: number } { const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw); if (match === null) throw new Error(`ZCode command or user-only skill needs YAML frontmatter: ${file}`); let value: unknown; try { value = yamlParse(match[1] ?? ''); } catch { throw new Error(`ZCode invalid YAML frontmatter: ${file}`); } if (!isObject(value)) throw new Error(`ZCode YAML frontmatter must be a mapping: ${file}`); return { values: value, end: match[0].length }; }
function hasSkill(root: string): boolean { const dir = join(root, 'skills'); return existsSync(dir) && readdirSync(dir).some(name => existsSync(join(dir, name, 'SKILL.md'))); }
function hasCommand(root: string): boolean { const dir = join(root, 'commands'); return existsSync(dir) && commandNames(dir).length > 0; }
function commandNames(dir: string, prefix = ''): string[] { if (!existsSync(dir)) return []; const out: string[] = []; for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) out.push(...commandNames(path, prefix === '' ? name : `${prefix}:${name}`)); else if (name.endsWith('.md')) out.push(`${prefix === '' ? '' : `${prefix}:`}${name.slice(0, -3)}`); } return out; }
function rejectCommandCollisions(stagedMarket: string, nativeId: string, ownPrior?: string): void {
  const candidate = commandNames(join(stagedMarket, 'plugins'));
  const own = ownPrior === undefined ? undefined : resolve(ownPrior);
  const enabled = readZcodeEnabledPluginIds();
  for (const native of readZcodeNativeRecords()) {
    if (enabled.get(native.id) !== true) continue;
    if (own !== undefined && resolve(native.installPath) === own) continue;
    const root = zcodeSafeInstallRoot(native.installPath); if (root === undefined) throw new Error(`Official ZCode native root is unsafe: ${native.installPath}`);
    const overlap = commandNames(join(root, 'commands')).find(name => candidate.includes(name));
    if (overlap !== undefined) throw new Error(`ZCode command ${overlap} collides with enabled native plugin ${native.id}`);
  }
}
function nativeById(id: string) { const rows = readZcodeNativeRecords().filter(row => row.id === id); if (rows.length > 1) throw new Error(`Official ZCode native id is ambiguous: ${id}`); return rows[0]; }
function nativeForLogical(logicalId: string) {
  const rows = readZcodeNativeRecords().filter(row => zcodeSafeInstallRoot(row.installPath) !== undefined && readZcodeOwnership(row.installPath)?.logicalId === logicalId && readZcodeOwnership(row.installPath)?.nativeId === row.id);
  if (rows.length > 1) throw new Error(`Official ZCode logical install is ambiguous: ${logicalId}`);
  if (rows[0]?.scope !== undefined && rows[0].scope !== 'user') throw new Error(`Official ZCode workspace-scoped install is unsupported: ${logicalId}`);
  return rows[0];
}
function sameCandidate(prior: NonNullable<ReturnType<typeof nativeById>>, market: string, resources: string, resourceRoot: string, logical: string, native: string, source: string, fingerprint: string): boolean {
  const marker = readZcodeOwnership(prior.installPath);
  if (marker?.logicalId !== logical || marker.nativeId !== native || marker.source !== source || marker.fingerprint !== fingerprint || marker.resourcePath !== resourceRoot || !existsSync(resourceRoot)) return false;
  try { return fingerprintTree(join(market, 'plugins', prior.name)) === fingerprintTree(prior.installPath) && fingerprintTree(resources) === fingerprintTree(resourceRoot); }
  catch { return false; }
}
function assertReplaceableOwnedRoots(market: string, resources: string, name: string, prior: ReturnType<typeof nativeById>, logical: string, native: string, source: string): void {
  if (!existsSync(market) && !existsSync(resources)) return;
  if (prior === undefined) throw new Error(`Official ZCode owned path already exists without a proven native install: ${existsSync(market) ? market : resources}`);
  const priorRoot = zcodeSafeInstallRoot(prior.installPath); const marker = priorRoot === undefined ? null : readZcodeOwnership(priorRoot);
  if (marker?.logicalId !== logical || marker.nativeId !== native || marker.source !== source) throw new Error(`Official ZCode existing paths are not proven owned: ${native}`);
  if (existsSync(market)) {
    assertNoSymlinks(market); const staged = readZcodeOwnership(join(market, 'plugins', name));
    if (staged?.logicalId !== logical || staged.nativeId !== native || staged.source !== source) throw new Error(`Official ZCode marketplace root is not proven owned: ${market}`);
  }
  if (existsSync(resources) && marker.resourcePath !== resources) throw new Error(`Official ZCode resource root is not proven owned: ${resources}`);
}
function provePrior(prior: ReturnType<typeof nativeById>, logical: string, native: string, source: string): void { if (prior === undefined) return; const root = zcodeSafeInstallRoot(prior.installPath); const marker = root === undefined ? null : readZcodeOwnership(root); if (prior.scope !== 'user' || marker?.logicalId !== logical || marker.nativeId !== native || marker.source !== source) throw new Error(`Official ZCode ${native} is not a proven user-scoped plgnz-owned install`); }
function proveActive(native: string, logical: string, source: string, fingerprint: string, version: string, expectedPackage: string, expectedResources: string, expectedResourceFingerprint: string): void { const row = nativeById(native); const root = row === undefined ? undefined : zcodeSafeInstallRoot(row.installPath); const marker = root === undefined ? null : readZcodeOwnership(root); if (row === undefined || root === undefined || row.version !== version || readZcodeEnabledPluginIds().get(native) !== true || marker?.logicalId !== logical || marker.nativeId !== native || marker.source !== source || marker.fingerprint !== fingerprint || marker.resourcePath !== expectedResources || fingerprintTree(root) !== fingerprintTree(expectedPackage) || fingerprintTree(expectedResources) !== expectedResourceFingerprint) throw new Error(`Official ZCode native readback did not activate ${native}`); }
function restorePrior(native: string, market: string, prior: NonNullable<ReturnType<typeof nativeById>>): void { runOfficialZcode(['plugins', 'marketplace', 'update', market]); runOfficialZcode(['plugins', 'update', native]); const restored = nativeById(native); if (restored?.version !== prior.version || readZcodeEnabledPluginIds().get(native) !== true) throw new Error(`Official ZCode could not restore prior ${native}`); }
function removeCandidate(native: string, logical: string, source: string, fingerprint: string): void { const row = nativeById(native); const marker = row === undefined ? null : readZcodeOwnership(row.installPath); if (row !== undefined && marker?.logicalId === logical && marker.source === source && marker.fingerprint === fingerprint) retireOwned(native); }
function retireOwned(nativeId: string): boolean { const row = nativeById(nativeId); const root = row === undefined ? undefined : zcodeSafeInstallRoot(row.installPath); if (root !== undefined) rmSync(root, { recursive: true, force: true }); const removed = removeRegistryPlugin(nativeId); removeEnabledFlag(nativeId); return removed || root !== undefined; }
function versionFor(plugin: PluginSource, fingerprint: string): string { const canonical = plugin.version ?? '0.0.0'; if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(canonical)) throw new Error(`ZCode needs canonical semver before plgnz metadata: ${canonical}`); return `${canonical}+plgnz.${fingerprint.slice(0, 16).toLowerCase()}`; }
function ownedMarketplace(logical: string): string { const h = new CryptoHasher('sha256'); h.update(logical); return `plgnz-${h.digest('hex').slice(0, 16)}`; }
function requireFingerprint(plugin: PluginSource): string { const fp = plugin.contentFingerprint ?? fingerprintTree(plugin.dir); if (!/^[0-9a-f]{16,}$/iu.test(fp)) throw new Error('ZCode requires a content fingerprint'); return fp.toLowerCase(); }
function moveAside(path: string): { rollback(): void; commit(): void } { if (!existsSync(path)) return { rollback: () => {}, commit: () => {} }; const backup = `${path}.plgnz-backup-${Date.now()}`; renameSync(path, backup); return { rollback: () => { if (!existsSync(path)) renameSync(backup, path); }, commit: () => rmSync(backup, { recursive: true, force: true }) }; }
function assertName(value: string, label: string): void { if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(value)) throw new Error(`ZCode unsafe ${label}: ${value}`); }
function argumentHint(value: unknown, file: string): string { if (typeof value === 'string') return JSON.stringify(value); if (Array.isArray(value) && value.every(item => typeof item === 'string')) return `[${value.join(' ')}]`; throw new Error(`ZCode argument-hint must be text or text list: ${file}`); }
function assertNoSymlinks(root: string): void { const visit = (path: string): void => { const stat = lstatSync(path); if (stat.isSymbolicLink()) throw new Error(`ZCode source contains symlink: ${path}`); if (stat.isDirectory()) for (const child of readdirSync(path)) visit(join(path, child)); }; visit(root); }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

/**
 * Official `plugins update` tells a running ZCode process to restart.
 * Store readback is effective for the next process, which is the lifecycle contract.
 */
const ZCODE_ACTIVATION: LifecycleReadbackData['transition'] = { requirement: 'restart', status: 'effective' };
const ZCODE_PROVEN_VERSION = '0.16.9';
const ZCODE_EVIDENCE = [
  'docs/evidence/zcode-official-cli-872ad960-20260923.json',
  'docs/hosts/zcode-cli.md',
] as const;

function zcodeSemantics(overrides: Partial<Record<PackageSemantic, CapabilityStatus>>): Record<PackageSemantic, CapabilityStatus> {
  const unsupported = Object.fromEntries(PACKAGE_SEMANTICS.map((semantic) => [semantic, 'unsupported'])) as Record<PackageSemantic, CapabilityStatus>;
  return { ...unsupported, ...overrides };
}

function zcodeRetireProfile(
  route: 'native' | 'managed',
  operationStatus: CapabilityStatus,
  lifecycle: CapabilityStatus,
  retention: CapabilityStatus,
): CapabilityEvidenceProfile {
  return createCapabilityEvidenceProfile({
    host: 'zcode-cli',
    detectedVersion: ZCODE_PROVEN_VERSION,
    sourceTypes: ['local', 'git'],
    operations: ['retire'],
    route,
    operationStatus,
    semantics: zcodeSemantics({
      retirement: operationStatus,
      'retention-safety': retention,
      readback: lifecycle,
      rollback: lifecycle,
      'activation-reload': lifecycle,
    }),
    evidence: [...ZCODE_EVIDENCE],
  });
}

function zcodeInstallProfile(): CapabilityEvidenceProfile {
  return createCapabilityEvidenceProfile({
    host: 'zcode-cli',
    detectedVersion: ZCODE_PROVEN_VERSION,
    sourceTypes: ['local', 'git'],
    operations: ['install', 'update'],
    route: 'native',
    operationStatus: 'supported',
    semantics: zcodeSemantics({
      'ordinary-skills': 'supported',
      commands: 'supported',
      'model-invocation-control': 'supported',
      'auto-update-control': 'supported',
      resources: 'supported',
      'retention-safety': 'supported',
      readback: 'supported',
      rollback: 'supported',
      'activation-reload': 'supported',
    }),
    evidence: [...ZCODE_EVIDENCE],
  });
}

/** Native uninstall deletes plugin data and options. Managed retirement is the retention-safe route. */
export const zcodeCliEvidenceProfiles: readonly CapabilityEvidenceProfile[] = Object.freeze([
  zcodeRetireProfile('native', 'unsupported', 'unsupported', 'unsupported'),
  zcodeRetireProfile('managed', 'supported', 'supported', 'supported'),
  zcodeInstallProfile(),
]);

function assertZcodeTarget(target: LifecycleTargetIdentity): void {
  if (target.kind !== 'zcode-cli' || target.instance !== 'default' || target.context !== undefined) {
    throw new Error('Official ZCode CLI lifecycle target must be zcode-cli/default without context');
  }
}

function officialVersionText(): string | undefined {
  const binary = resolveOfficialZcodeCli();
  if (binary === undefined) return undefined;
  const result = bunShapedSpawnSync([binary, '--version'], { stdout: 'pipe', stderr: 'pipe', env: zcodeCliEnv(), timeout: 10_000 });
  if (result.exitCode !== 0 || !(result.stdout instanceof Uint8Array)) return undefined;
  return new TextDecoder().decode(result.stdout).trim();
}

async function probeZcodeVersion(target: LifecycleTargetIdentity): Promise<TargetVersionObservation> {
  assertZcodeTarget(target);
  const version = officialVersionText();
  if (version === undefined) return { kind: 'unknown' };
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) return { kind: 'unparseable' };
  return { kind: 'detected', version, probeId: 'zcode-cli:--version' };
}

function zcodePluginDataDir(nativeId: string): string {
  return join(zcodeCliRoot(), 'plugins', 'data', nativeId.replace(/[^a-zA-Z0-9_.@-]/g, '-'));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function sha256(text: string): string {
  const hash = new CryptoHasher('sha256');
  hash.update(text);
  return hash.digest('hex');
}

function readConfigObject(): Record<string, unknown> | null {
  const file = join(zcodeCliConfigRoot(), 'config.json');
  if (!existsSync(file)) return null;
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!isObject(value)) throw new Error(`Official ZCode config is unsupported: ${file}`);
  return value;
}

function optionValue(nativeId: string): unknown {
  const config = readConfigObject();
  if (config === null || !isObject(config['plugins'])) return undefined;
  const options = config['plugins']['options'];
  if (!isObject(options) || !Object.hasOwn(options, nativeId)) return undefined;
  return options[nativeId];
}

function retainedState(nativeId: string): RetentionObservation {
  const dataDir = zcodePluginDataDir(nativeId);
  const pluginData = existsSync(dataDir) && statSync(dataDir).isDirectory()
    ? { state: 'present' as const, fingerprint: fingerprintTree(dataDir) }
    : { state: 'absent' as const, fingerprint: null };
  const options = optionValue(nativeId);
  const inactiveMetadata = options === undefined
    ? { state: 'absent' as const, fingerprint: null }
    : { state: 'present' as const, fingerprint: sha256(canonicalJson(options)) };
  return { pluginData, inactiveMetadata };
}

function installationFor(native: ReturnType<typeof readZcodeNativeRecords>[number]): TargetInstallationData {
  const root = zcodeSafeInstallRoot(native.installPath);
  if (root === undefined) throw new Error(`Official ZCode native root is unsafe: ${native.installPath}`);
  const marker = readZcodeOwnership(root);
  const owned = marker !== null && marker.nativeId === native.id && native.scope === 'user';
  const digest = fingerprintTree(root);
  const enabled = readZcodeEnabledPluginIds().get(native.id) === true;
  return {
    nativeId: native.id,
    packageName: native.name,
    ownership: owned
      ? { kind: 'owned', proof: 'created', scopeId: marker.logicalId, proofId: `marker:${native.id}` }
      : { kind: 'unmanaged' },
    presence: 'present',
    enablement: enabled ? 'enabled' : 'disabled',
    activation: enabled ? 'active' : 'inactive',
    installedFingerprint: digest,
    installedVersion: native.version,
    source: owned
      ? { type: 'local', immutableRevision: marker.fingerprint, locator: null }
      : null,
    contentRoots: [{ label: 'native', path: root, fingerprint: digest }],
  };
}

function inventoryFor(target: LifecycleTargetIdentity): TargetInventoryData {
  assertZcodeTarget(target);
  assertZcodeNativeRegistryReadable();
  return { target, installations: readZcodeNativeRecords().map(installationFor) };
}

function readbackFor(
  handle: Pick<DurableLifecycleOperation, 'adapterId' | 'target' | 'scopeId' | 'packageName' | 'nativeId'>,
  absentRoute: LifecycleReadbackData['route'],
): LifecycleReadbackData {
  const row = nativeById(handle.nativeId);
  const root = row === undefined ? undefined : zcodeSafeInstallRoot(row.installPath);
  const retention = retainedState(handle.nativeId);
  if (row === undefined || root === undefined) {
    return {
      adapterId: handle.adapterId,
      target: handle.target,
      scopeId: handle.scopeId,
      packageName: handle.packageName,
      nativeId: handle.nativeId,
      route: absentRoute,
      presence: 'absent',
      enablement: 'disabled',
      activation: 'inactive',
      transition: ZCODE_ACTIVATION,
      installedFingerprint: null,
      contentRoots: [],
      retention,
    };
  }
  const digest = fingerprintTree(root);
  const enabled = readZcodeEnabledPluginIds().get(handle.nativeId) === true;
  return {
    adapterId: handle.adapterId,
    target: handle.target,
    scopeId: handle.scopeId,
    packageName: handle.packageName,
    nativeId: handle.nativeId,
    route: 'native',
    presence: 'present',
    enablement: enabled ? 'enabled' : 'disabled',
    activation: enabled ? 'active' : 'inactive',
    transition: ZCODE_ACTIVATION,
    installedFingerprint: digest,
    contentRoots: contentRootsFor(root, digest),
    retention,
  };
}

function contentRootsFor(root: string, digest: string): LifecycleReadbackData['contentRoots'] {
  const roots: Array<{ label: string; path: string; fingerprint: string }> = [{ label: 'native', path: root, fingerprint: digest }];
  const resourcePath = readZcodeOwnership(root)?.resourcePath;
  if (resourcePath === undefined) return roots;
  const resource = realpathSync(resourcePath);
  const owned = realpathSync(zcodeResourceRoot());
  if (!resource.startsWith(`${owned}/`) || !statSync(resource).isDirectory()) return roots;
  roots.push({ label: 'resources', path: resource, fingerprint: fingerprintTree(resource) });
  return roots;
}

function retirementSnapshot(attemptId: string, operationId: string, nativeId: string): string {
  const dir = join(zcodeCliRoot(), 'plgnz-lifecycle', attemptId, operationId);
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) throw new Error(`ZCode rollback snapshot already exists and is not a directory: ${dir}`);
    return dir;
  }
  mkdirSync(dir, { recursive: true });
  const row = nativeById(nativeId);
  const root = row === undefined ? undefined : zcodeSafeInstallRoot(row.installPath);
  if (root !== undefined) cpSync(root, join(dir, 'cache'), { recursive: true });
  writeFileSync(join(dir, 'install-path.txt'), root ?? '');
  const registry = zcodeRegistryFile();
  if (existsSync(registry)) cpSync(registry, join(dir, 'installed_plugins.json'));
  const config = join(zcodeCliConfigRoot(), 'config.json');
  if (existsSync(config)) cpSync(config, join(dir, 'config.json'));
  return dir;
}

function canonicalExistingPath(path: string): string {
  const missing: string[] = [];
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw new Error(`ZCode path does not exist: ${path}`);
    missing.push(basename(current));
    current = parent;
  }
  return join(realpathSync(current), ...missing.reverse());
}

function isCacheInstallPath(path: string): boolean {
  const cache = canonicalExistingPath(join(zcodeCliRoot(), 'plugins', 'cache'));
  const target = canonicalExistingPath(path);
  return target.startsWith(`${cache}/`);
}

function removeRegistryPlugin(nativeId: string): boolean {
  const file = zcodeRegistryFile();
  if (!existsSync(file)) return false;
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!isObject(value) || !Array.isArray(value['plugins'])) throw new Error(`Official ZCode registry is unsupported: ${file}`);
  const plugins = value['plugins'];
  const next = plugins.filter((row) => !isObject(row) || row['id'] !== nativeId);
  if (next.length === plugins.length) return false;
  value['plugins'] = next;
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return true;
}

function removeEnabledFlag(nativeId: string): void {
  const file = join(zcodeCliConfigRoot(), 'config.json');
  if (!existsSync(file)) return;
  const value = readConfigObject();
  if (value === null || !isObject(value['plugins']) || !isObject(value['plugins']['enabledPlugins'])) return;
  if (!Object.hasOwn(value['plugins']['enabledPlugins'], nativeId)) return;
  delete value['plugins']['enabledPlugins'][nativeId];
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function snapshotRegistryRow(file: string, nativeId: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!isObject(value) || !Array.isArray(value['plugins'])) throw new Error(`Official ZCode registry snapshot is unsupported: ${file}`);
  const rows = value['plugins'].filter((row) => isObject(row) && row['id'] === nativeId);
  if (rows.length > 1) throw new Error(`Official ZCode registry snapshot is ambiguous: ${nativeId}`);
  return rows[0];
}

function restoreRegistryPlugin(nativeId: string, snapshotFile: string): void {
  const saved = snapshotRegistryRow(snapshotFile, nativeId);
  const file = zcodeRegistryFile();
  if (!existsSync(file) && saved === undefined) return;
  const live: unknown = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 1, plugins: [] };
  if (!isObject(live) || !Array.isArray(live['plugins'])) throw new Error(`Official ZCode registry is unsupported: ${file}`);
  const plugins = live['plugins'].filter((row) => !isObject(row) || row['id'] !== nativeId);
  if (saved !== undefined) plugins.push(saved);
  live['plugins'] = plugins;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(live, null, 2)}\n`);
}

function configSection(config: Record<string, unknown>, key: 'enabledPlugins' | 'options'): Record<string, unknown> {
  const plugins = isObject(config['plugins']) ? config['plugins'] : {};
  config['plugins'] = plugins;
  const section = isObject(plugins[key]) ? plugins[key] : {};
  plugins[key] = section;
  return section;
}

function restorePluginConfig(nativeId: string, snapshotFile: string): void {
  const file = join(zcodeCliConfigRoot(), 'config.json');
  const snapshot = existsSync(snapshotFile) ? readConfigObjectFrom(snapshotFile) : null;
  const live = existsSync(file) ? readConfigObject() : {};
  if (live === null) throw new Error(`Official ZCode config is unsupported: ${file}`);
  const savedPlugins = snapshot !== null && isObject(snapshot['plugins']) ? snapshot['plugins'] : undefined;
  const savedEnabled = savedPlugins !== undefined && isObject(savedPlugins['enabledPlugins']) ? savedPlugins['enabledPlugins'][nativeId] : undefined;
  const savedOptions = savedPlugins !== undefined && isObject(savedPlugins['options']) && Object.hasOwn(savedPlugins['options'], nativeId)
    ? savedPlugins['options'][nativeId]
    : undefined;
  const enabled = configSection(live, 'enabledPlugins');
  if (typeof savedEnabled === 'boolean') enabled[nativeId] = savedEnabled;
  else delete enabled[nativeId];
  const options = configSection(live, 'options');
  if (savedOptions === undefined) delete options[nativeId];
  else options[nativeId] = savedOptions;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(live, null, 2)}\n`);
}

function readConfigObjectFrom(file: string): Record<string, unknown> | null {
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!isObject(value)) throw new Error(`Official ZCode config is unsupported: ${file}`);
  return value;
}

function notInSlice(): Promise<never> {
  return Promise.reject(new Error('ZCode CLI lifecycle slice does not expose this operation'));
}

function marketplaceName(nativeId: string): string {
  const at = nativeId.indexOf('@');
  if (at < 1 || at === nativeId.length - 1) throw new Error(`ZCode native id needs a marketplace: ${nativeId}`);
  return nativeId.slice(at + 1);
}

function predictedCachePath(nativeId: string, packageName: string, nativeVersion: string): string {
  return join(realpathSync(zcodeCliRoot()), 'plugins', 'cache', marketplaceName(nativeId), packageName, nativeVersion.replace(/\+/gu, '-'));
}

function stageLayout(stagingRoot: string): { marketStage: string; resourcesStage: string } {
  const marketStage = dirname(dirname(stagingRoot));
  return { marketStage, resourcesStage: join(dirname(marketStage), 'resources') };
}

function recordTree(dir: string, name: string, path: string): void {
  const existed = existsSync(path);
  writeFileSync(join(dir, `${name}-path.txt`), path);
  writeFileSync(join(dir, `${name}-existed.txt`), existed ? '1' : '0');
  if (existed) cpSync(path, join(dir, name), { recursive: true });
}

function activationSnapshot(attemptId: string, operationId: string, nativeId: string, marketplace: string, resources: string): string {
  const dir = retirementSnapshot(attemptId, operationId, nativeId);
  if (!existsSync(join(dir, 'marketplace-path.txt'))) recordTree(dir, 'marketplace', marketplace);
  if (!existsSync(join(dir, 'resources-path.txt'))) recordTree(dir, 'resources', resources);
  return dir;
}

function restoreRecordedTree(dir: string, name: string, ownedRoot: string): void {
  const pathFile = join(dir, `${name}-path.txt`);
  const existedFile = join(dir, `${name}-existed.txt`);
  if (!existsSync(pathFile) || !existsSync(existedFile)) return;
  const path = readFileSync(pathFile, 'utf8');
  const existed = readFileSync(existedFile, 'utf8') === '1';
  if (path.length === 0) throw new Error(`ZCode rollback ${name} path is empty`);
  const owned = canonicalExistingPath(ownedRoot);
  const target = canonicalExistingPath(path);
  if (!target.startsWith(`${owned}/`)) throw new Error(`ZCode rollback ${name} path is outside its root`);
  const copy = join(dir, name);
  if (existed && !existsSync(copy)) throw new Error(`ZCode rollback ${name} copy is missing`);
  if (!existed && existsSync(copy)) throw new Error(`ZCode rollback ${name} copy has no path`);
  rmSync(target, { recursive: true, force: true });
  if (!existed) return;
  mkdirSync(dirname(target), { recursive: true });
  cpSync(copy, target, { recursive: true });
}

const ZCODE_INSTALL_SEMANTICS = new Set<PackageSemantic>([
  'ordinary-skills',
  'commands',
  'model-invocation-control',
  'resources',
]);

function installProjection(request: NativeProjectionRequest): NativeProjectionData | undefined {
  if (request.operation !== 'install' && request.operation !== 'update') return undefined;
  if (!('snapshot' in request) || request.pins.length > 0) return { kind: 'unverified', reasonId: 'zcode-native-projection-unverified' };
  const unsupported = request.snapshot.inventory.requiredSemantics.find((semantic) => !ZCODE_INSTALL_SEMANTICS.has(semantic));
  if (unsupported !== undefined) return { kind: 'unverified', reasonId: `zcode-semantic-unverified:${unsupported}` };
  return { kind: 'equivalent', proofId: 'zcode-marketplace-projection' };
}

const zcodeCliLifecycleDefinition: LifecycleHostDefinition = {
  id: 'zcode-cli',
  evidenceProfiles: zcodeCliEvidenceProfiles,
  probeVersion: probeZcodeVersion,
  observeTarget: async (target) => inventoryFor(target),
  observeNativeMutationScope: async (request): Promise<NativeMutationScopeData> => ({
    kind: 'bounded',
    mode: 'exact-package',
    affectedNativeIds: [request.nativeId],
  }),
  observeNativeProjection: async (request: NativeProjectionRequest): Promise<NativeProjectionData> => {
    const version = await probeZcodeVersion(request.targetObservation.target);
    if (version.kind !== 'detected' || version.version !== ZCODE_PROVEN_VERSION) {
      return { kind: 'unverified', reasonId: 'zcode-native-projection-unverified' };
    }
    if (request.operation === 'retire') return { kind: 'requires-managed', reasonId: 'native-uninstall-drops-retained-state' };
    return installProjection(request) ?? { kind: 'unverified', reasonId: 'zcode-native-projection-unverified' };
  },
  revalidateTargetPrecondition: async (handle) => {
    const version = await probeZcodeVersion(handle.target);
    return {
      version,
      targetObservationId: createTargetInventoryObservation(handle.adapterId, inventoryFor(handle.target)).observationId,
    };
  },
  stageActivation: async (request) => {
    const snapshot = request.snapshot;
    assertName(snapshot.packageName, 'plugin name');
    const market = marketplaceName(snapshot.nativeId);
    assertName(market, 'marketplace name');
    mkdirSync(zcodeCliRoot(), { recursive: true });
    const nativeVersion = versionFor({
      name: snapshot.packageName,
      dir: snapshot.packageRoot,
      version: snapshot.inventory.package.version ?? undefined,
      contentFingerprint: snapshot.packageFingerprint,
    }, snapshot.packageFingerprint);
    const resourceRoot = join(realpathSync(zcodeCliRoot()), 'plgnz-resources', market, snapshot.packageFingerprint);
    const stageParent = join(zcodeCliRoot(), '.plgnz-zcode-stage');
    mkdirSync(stageParent, { recursive: true });
    const stage = mkdtempSync(join(stageParent, 'activation-'));
    const marketStage = join(stage, 'marketplace');
    const resourcesStage = join(stage, 'resources');
    const pluginStage = join(marketStage, 'plugins', snapshot.packageName);
    mkdirSync(dirname(pluginStage), { recursive: true });
    mkdirSync(resourcesStage, { recursive: true });
    projectZcodePlugin(snapshot.packageRoot, pluginStage, resourcesStage, resourceRoot, snapshot.nativeId, snapshot.nativeId, nativeVersion, snapshot.packageFingerprint, snapshot.immutableRevision);
    writeFileSync(join(marketStage, 'marketplace.json'), `${JSON.stringify({ name: market, plugins: [{ name: snapshot.packageName, source: `./plugins/${snapshot.packageName}` }] }, null, 2)}\n`);
    rejectCommandCollisions(marketStage, snapshot.nativeId, nativeById(snapshot.nativeId)?.installPath);
    return { stagingId: `stage:${request.selection.attemptId}:${request.selection.operationId}`, stagingRoot: pluginStage };
  },
  applyLifecycleDirectives: async () => [],
  applyPins: async (projection) => {
    if (projection.pins.length > 0) throw new Error('ZCode cannot represent MCP pins in a native marketplace install');
    return [];
  },
  captureActivationPreparation: async (projection, projectedFingerprint) => {
    const versionFile = readJson(join(projection.stagingRoot, '.zcode-plugin', 'plugin.json'));
    const nativeVersion = versionFile?.['version'];
    if (typeof nativeVersion !== 'string') throw new Error('staged ZCode plugin has no native version');
    const marker = readZcodeOwnership(projection.stagingRoot);
    if (marker?.resourcePath === undefined) throw new Error('staged ZCode plugin has no resource path');
    const prior = readbackFor({
      adapterId: 'zcode-cli',
      target: projection.target,
      scopeId: projection.scopeId,
      packageName: projection.packageName,
      nativeId: projection.nativeId,
    }, 'none');
    const resourcesStage = stageLayout(projection.stagingRoot).resourcesStage;
    return {
      prior,
      expected: {
        ...prior,
        route: projection.route,
        presence: 'present',
        enablement: 'enabled',
        activation: 'active',
        transition: ZCODE_ACTIVATION,
        installedFingerprint: projectedFingerprint,
        contentRoots: [
          { label: 'native', path: predictedCachePath(projection.nativeId, projection.packageName, nativeVersion), fingerprint: projectedFingerprint },
          { label: 'resources', path: marker.resourcePath, fingerprint: fingerprintTree(resourcesStage) },
        ],
      },
      rollbackReference: activationSnapshot(projection.attemptId, projection.operationId, projection.nativeId, join(realpathSync(zcodeCliRoot()), 'plgnz-marketplaces', marketplaceName(projection.nativeId)), marker.resourcePath),
      rollbackCoverageOperationIds: projection.affectedOperationIds,
    };
  },
  captureDisablePreparation: notInSlice,
  captureRetirementPreparation: async (request) => ({
    prior: readbackFor({
      adapterId: 'zcode-cli',
      target: request.activation.target,
      scopeId: request.activation.scopeId,
      packageName: request.activation.packageName,
      nativeId: request.activation.nativeId,
    }, 'none'),
    rollbackReference: retirementSnapshot(request.attemptId, request.operationId, request.activation.nativeId),
    rollbackCoverageOperationIds: request.selection.affectedOperationIds,
    transition: ZCODE_ACTIVATION,
  }),
  apply: async (prepared) => {
    const nativeId = prepared.handle.nativeId;
    const { marketStage, resourcesStage } = stageLayout(prepared.stagingRoot);
    const marker = readZcodeOwnership(prepared.stagingRoot);
    const nativeVersion = readJson(join(prepared.stagingRoot, '.zcode-plugin', 'plugin.json'))?.['version'];
    if (marker === null || marker.nativeId !== nativeId || marker.resourcePath === undefined || typeof nativeVersion !== 'string') {
      throw new Error(`staged ZCode plugin is not a proven projection: ${nativeId}`);
    }
    const market = marketplaceName(nativeId);
    const marketRoot = join(zcodeMarketplaceRoot(), market);
    const resourceRoot = marker.resourcePath;
    const prior = nativeById(nativeId);
    const priorRoot = prior === undefined ? undefined : zcodeSafeInstallRoot(prior.installPath);
    const unchanged = prior !== undefined
      && priorRoot !== undefined
      && prior.version === nativeVersion
      && readZcodeEnabledPluginIds().get(nativeId) === true
      && fingerprintTree(priorRoot) === fingerprintTree(prepared.stagingRoot)
      && existsSync(resourceRoot)
      && fingerprintTree(resourceRoot) === fingerprintTree(resourcesStage);
    if (unchanged) return { receiptId: `apply:${prepared.handle.attemptId}:${prepared.handle.operationId}`, changed: false };
    const marketBackup = moveAside(marketRoot);
    const resourceBackup = moveAside(resourceRoot);
    try {
      mkdirSync(dirname(marketRoot), { recursive: true });
      mkdirSync(dirname(resourceRoot), { recursive: true });
      cpSync(marketStage, marketRoot, { recursive: true });
      cpSync(resourcesStage, resourceRoot, { recursive: true });
      if (prior === undefined) {
        runOfficialZcode(['plugins', 'marketplace', 'add', marketRoot]);
        runOfficialZcode(['plugins', 'install', nativeId]);
      } else {
        runOfficialZcode(['plugins', 'marketplace', 'update', market]);
        runOfficialZcode(['plugins', 'update', nativeId]);
      }
      proveActive(nativeId, marker.logicalId, marker.source, marker.fingerprint, nativeVersion, prepared.stagingRoot, resourceRoot, fingerprintTree(resourcesStage));
    } catch (error) {
      rmSync(marketRoot, { recursive: true, force: true });
      marketBackup.rollback();
      rmSync(resourceRoot, { recursive: true, force: true });
      resourceBackup.rollback();
      if (prior !== undefined) restorePrior(nativeId, market, prior);
      else removeCandidate(nativeId, marker.logicalId, marker.source, marker.fingerprint);
      throw error;
    }
    marketBackup.commit();
    resourceBackup.commit();
    return { receiptId: `apply:${prepared.handle.attemptId}:${prepared.handle.operationId}`, changed: true };
  },
  disable: notInSlice,
  retire: async (prepared) => {
    if (prepared.handle.route !== 'managed') throw new Error('Official ZCode retire is managed; native uninstall deletes retained plugin data');
    return {
      receiptId: `retire:${prepared.handle.attemptId}:${prepared.handle.operationId}`,
      changed: retireOwned(prepared.handle.nativeId),
    };
  },
  readback: async (handle) => readbackFor(
    handle,
    handle.action === 'remove' || handle.action === 'retire-orphan' ? handle.route : 'none',
  ),
  rollback: async (handle) => {
    const dir = handle.rollbackReference;
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error('ZCode rollback snapshot is missing');
    const installPath = existsSync(join(dir, 'install-path.txt')) ? readFileSync(join(dir, 'install-path.txt'), 'utf8') : '';
    const cache = join(dir, 'cache');
    const cachePresent = existsSync(cache);
    if (installPath.length > 0 && !cachePresent) throw new Error('ZCode rollback cache copy is missing');
    if (installPath.length === 0 && cachePresent) throw new Error('ZCode rollback cache copy has no install path');
    if (installPath.length > 0 && !isCacheInstallPath(installPath)) throw new Error('ZCode rollback cache path is outside the native cache');
    const current = nativeById(handle.nativeId);
    const currentRoot = current === undefined ? undefined : zcodeSafeInstallRoot(current.installPath);
    if (currentRoot !== undefined && currentRoot !== installPath) {
      if (!isCacheInstallPath(currentRoot)) throw new Error('ZCode rollback cache path is outside the native cache');
      rmSync(currentRoot, { recursive: true, force: true });
    }
    restoreRegistryPlugin(handle.nativeId, join(dir, 'installed_plugins.json'));
    restorePluginConfig(handle.nativeId, join(dir, 'config.json'));
    if (installPath.length > 0) {
      rmSync(installPath, { recursive: true, force: true });
      mkdirSync(dirname(installPath), { recursive: true });
      cpSync(cache, installPath, { recursive: true });
    }
    restoreRecordedTree(dir, 'marketplace', zcodeMarketplaceRoot());
    restoreRecordedTree(dir, 'resources', zcodeResourceRoot());
    return { receiptId: `rollback:${handle.attemptId}:${handle.operationId}`, changed: true };
  },
  cleanup: async (reference: CleanupReference, _disposition: CleanupDisposition): Promise<CleanupResultData> => {
    rmSync(join(zcodeCliRoot(), 'plgnz-lifecycle', reference.attemptId, reference.operationId), { recursive: true, force: true });
    return { cleanupId: `cleanup:${reference.attemptId}:${reference.operationId}`, completed: true };
  },
};

export const zcodeCliLifecycle = createLifecycleHostAdapter(zcodeCliLifecycleDefinition);
