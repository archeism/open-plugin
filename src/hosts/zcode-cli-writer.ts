/** Official ZCode CLI marketplace writer. */
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddOptions, HostWriter, InstalledPlugin, PinOptions, PinOutcome } from '../host';
import type { PluginSource, ResolvedSource } from '../source';
import { fingerprintTree } from '../fingerprint';
import { assertZcodeNativeRegistryReadable, readZcodeEnabledPluginIds, readZcodeNativeRecords, readZcodeOwnership, runOfficialZcode, zcodeCli, zcodeMarketplaceRoot, zcodeResourceRoot, zcodeSafeInstallRoot } from './zcode-cli';
import { normalizeCommandTree } from '../conversion';
import { zcodeCliRoot } from '../paths';

declare const Bun: any;

const MARKER = '.plgnz-install.json';
type Ownership = { owner: 'plgnz'; schema: 1; logicalId: string; nativeId: string; fingerprint: string; source: string; resourcePath: string };

export const zcodeCliWriter: HostWriter = {
  ...zcodeCli,
  supportsAdoption: false,
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
    runOfficialZcode(['plugins', 'uninstall', native.id, '--force']);
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
function frontmatter(raw: string, file: string): { values: Record<string, unknown>; end: number } { const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw); if (match === null) throw new Error(`ZCode command or user-only skill needs YAML frontmatter: ${file}`); let value: unknown; try { value = Bun.YAML.parse(match[1] ?? ''); } catch { throw new Error(`ZCode invalid YAML frontmatter: ${file}`); } if (!isObject(value)) throw new Error(`ZCode YAML frontmatter must be a mapping: ${file}`); return { values: value, end: match[0].length }; }
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
function removeCandidate(native: string, logical: string, source: string, fingerprint: string): void { const row = nativeById(native); const marker = row === undefined ? null : readZcodeOwnership(row.installPath); if (row !== undefined && marker?.logicalId === logical && marker.source === source && marker.fingerprint === fingerprint) runOfficialZcode(['plugins', 'uninstall', native, '--force']); }
function versionFor(plugin: PluginSource, fingerprint: string): string { const canonical = plugin.version ?? '0.0.0'; if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(canonical)) throw new Error(`ZCode needs canonical semver before plgnz metadata: ${canonical}`); return `${canonical}+plgnz.${fingerprint.slice(0, 16).toLowerCase()}`; }
function ownedMarketplace(logical: string): string { const h = new Bun.CryptoHasher('sha256'); h.update(logical); return `plgnz-${h.digest('hex').slice(0, 16)}`; }
function requireFingerprint(plugin: PluginSource): string { const fp = plugin.contentFingerprint ?? fingerprintTree(plugin.dir); if (!/^[0-9a-f]{16,}$/iu.test(fp)) throw new Error('ZCode requires a content fingerprint'); return fp.toLowerCase(); }
function moveAside(path: string): { rollback(): void; commit(): void } { if (!existsSync(path)) return { rollback: () => {}, commit: () => {} }; const backup = `${path}.plgnz-backup-${Date.now()}`; renameSync(path, backup); return { rollback: () => { if (!existsSync(path)) renameSync(backup, path); }, commit: () => rmSync(backup, { recursive: true, force: true }) }; }
function assertName(value: string, label: string): void { if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(value)) throw new Error(`ZCode unsafe ${label}: ${value}`); }
function argumentHint(value: unknown, file: string): string { if (typeof value === 'string') return JSON.stringify(value); if (Array.isArray(value) && value.every(item => typeof item === 'string')) return `[${value.join(' ')}]`; throw new Error(`ZCode argument-hint must be text or text list: ${file}`); }
function assertNoSymlinks(root: string): void { const visit = (path: string): void => { const stat = lstatSync(path); if (stat.isSymbolicLink()) throw new Error(`ZCode source contains symlink: ${path}`); if (stat.isDirectory()) for (const child of readdirSync(path)) visit(join(path, child)); }; visit(root); }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
