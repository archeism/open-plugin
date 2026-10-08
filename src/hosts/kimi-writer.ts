/** Transactional native Kimi Code plugin writer. */
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddOptions, HostWriter, InstalledPlugin, PinOptions, PinOutcome } from '../host';
import type { PluginSource, ResolvedSource } from '../source';
import { normalizeCommandSources } from '../conversion';
import { kimi, mcpCandidates, pluginsDir } from './kimi';
import { pinPluginMcpFiles } from '../mcp-write';

declare const Bun: any;
declare const TextDecoder: any;
declare const Response: any;

const MARKER = '.plgnz-install.json';
type Ownership = { source: string; pluginId: string; fingerprint: string };
type Registry = { version: 1; plugins: Array<Record<string, unknown>> };

export const kimiWriter: HostWriter = {
  ...kimi,
  supportsAdoption: true,
  async add(plugin: PluginSource, resolved: ResolvedSource, opts?: AddOptions): Promise<void | 'unchanged'> {
    const id = plugin.name;
    const ownedId = plugin.marketplace === undefined ? id : `${id}@${plugin.marketplace}`;
    assertId(id);
    const root = pluginsDir();
    const managedRoot = join(root, 'managed');
    const target = join(managedRoot, id);
    const registryFile = join(root, 'installed.json');
    assertManagedPath(kimiRootPath(), root);
    assertManagedPath(kimiRootPath(), managedRoot);
    assertManagedPath(kimiRootPath(), target);
    assertFilePath(kimiRootPath(), registryFile);
    const stageRoot = mkdtempSync(join(opts?.dryRun ? tmpdir() : (mkdirSync(root, { recursive: true }), root), '.plgnz-kimi-stage-'));
    const stage = join(stageRoot, id);
    try {
      stagePlugin(plugin.dir, stage, id);
      writeFileSync(join(stage, MARKER), JSON.stringify({ source: resolved.sourceUri, pluginId: ownedId, fingerprint: plugin.contentFingerprint ?? '' } satisfies Ownership));
      const prior = readRegistry(registryFile);
      const priorRow = prior.plugins.find(row => row.id === id);
      const marker = readOwnership(target);
      const markerHasExpectedIdentity = marker?.pluginId === ownedId || (plugin.marketplace !== undefined && marker?.pluginId === id);
      if (marker !== null && (marker.source !== resolved.sourceUri || !markerHasExpectedIdentity)) throw new Error(`Kimi plugin ${id} belongs to another source; refusing to replace it`);
      const same = existsSync(target) && sameTree(stage, target);
      if (existsSync(target) && marker === null && !same) {
        if (!opts?.adoptExisting) throw new Error(`Kimi managed plugin ${id} is unowned and differs from the staged representation; pass --adopt-existing to take ownership explicitly`);
        validateNativeIdentity(target, id);
      }
      const unchanged = marker !== null && marker.fingerprint === (plugin.contentFingerprint ?? '') && same && priorRow?.enabled === true && sameRoot(priorRow.root, target);
      if (opts?.dryRun) {
        console.log(`[kimi] would install and enable staged plugin: ${target}`);
        console.log(`[kimi] would let Kimi update registry: ${registryFile}`);
        return unchanged ? 'unchanged' : undefined;
      }
      if (unchanged) return 'unchanged';

      // Kimi's documented API removes its existing managed copy during re-install.
      // Keep both active bytes and registry aside until its native readback succeeds.
      // Capture all rollback bytes before renaming the active tree. A registry
      // read failure must leave the old target in place.
      const registryBefore = existsSync(registryFile) ? readFileSync(registryFile, 'utf8') : undefined;
      const backup = moveAside(target, managedRoot);
      try {
        await nativeInstall(stage, kimiRootPath(), resolveKimiBinary());
        const after = readRegistry(registryFile);
        const row = after.plugins.find(candidate => candidate.id === id);
        if (row === undefined || row.enabled !== true || !sameRoot(row.root, target) || !existsSync(target) || !sameTree(stage, target)) {
          throw new Error(`Kimi native install did not produce enabled managed plugin ${id}`);
        }
      } catch (error) {
        rmSync(target, { recursive: true, force: true });
        backup.rollback();
        restore(registryFile, registryBefore);
        throw error;
      }
      // Native registry now selects the new tree. Cleanup is deliberately after
      // that commit: its failure must never roll back a working installation.
      backup.commit();
    } finally {
      rmSync(stageRoot, { recursive: true, force: true });
    }
  },
  async pin(plugin: InstalledPlugin, opts?: PinOptions): Promise<PinOutcome> {
    if (plugin.path === undefined || !existsSync(plugin.path)) return { changes: [], refusals: [] };
    return pinPluginMcpFiles(plugin.path, mcpCandidates(), opts);
  },
  async remove(id: string): Promise<void> {
    const nativeId = id.split('@', 1)[0] ?? '';
    assertId(nativeId);
    const root = pluginsDir(); const target = join(root, 'managed', nativeId); const registryFile = join(root, 'installed.json');
    assertManagedPath(kimiRootPath(), root); assertManagedPath(kimiRootPath(), dirname(target)); assertManagedPath(kimiRootPath(), target); assertFilePath(kimiRootPath(), registryFile);
    const row = readRegistry(registryFile).plugins.find(candidate => candidate.id === nativeId);
    const marker = readOwnership(target);
    if (row === undefined || marker === null || marker.pluginId !== id || !sameRoot(row.root, target)) throw new Error(`Kimi plugin ${id} is not wholly plgnz-owned; refusing native removal`);
    await nativeRemove(kimiRootPath(), resolveKimiBinary(), nativeId);
    if (readRegistry(registryFile).plugins.some(candidate => candidate.id === nativeId)) throw new Error(`Kimi native removal did not deactivate plugin ${id}`);
  },
};

function kimiRootPath(): string { return dirname(pluginsDir()); }
function assertId(value: string): void { if (!/^[a-z0-9][a-z0-9_-]{0,63}$/iu.test(value)) throw new Error(`invalid Kimi plugin id: ${value}`); }
function sameRoot(value: unknown, target: string): boolean {
  if (typeof value !== 'string') return false;
  try {
    const left = statSync(value) as unknown as { dev: number; ino: number };
    const right = statSync(target) as unknown as { dev: number; ino: number };
    return left.dev === right.dev && left.ino === right.ino;
  }
  catch { return resolve(value) === resolve(target); }
}
function readRegistry(path: string): Registry {
  if (!existsSync(path)) return { version: 1, plugins: [] };
  let raw: unknown; try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch (error) { throw new Error(`invalid Kimi installed registry: ${(error as Error).message}`); }
  if (!isObject(raw) || raw.version !== 1 || !Array.isArray(raw.plugins) || raw.plugins.some(row => !isObject(row) || typeof row.id !== 'string' || typeof row.root !== 'string' || typeof row.enabled !== 'boolean')) throw new Error(`unsupported Kimi installed registry: ${path}`);
  return raw as Registry;
}
function restore(path: string, value: string | undefined): void { if (value === undefined) rmSync(path, { force: true }); else writeFileSync(path, value); }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

function stagePlugin(source: string, stage: string, expectedName: string): void {
  assertNoSymlinks(source); cpSync(source, stage, { recursive: true });
  normalizeCommandSources(stage);
  const manifest = readSourceManifest(stage);
  if (manifest.name !== expectedName) throw new Error(`Kimi manifest identity does not match ${expectedName}`);
  for (const key of ['hooks', 'agents', 'agent', 'executables']) if (manifest[key] !== undefined) throw new Error(`Kimi root manifest ${key} is unsupported without an explicit native declaration`);
  const skills = join(stage, 'skills'); if (existsSync(skills) && !statSync(skills).isDirectory()) throw new Error(`Kimi skills path is not a directory: ${skills}`);
  if (existsSync(skills)) assertKimiSkillPolicies(skills);
  const native = join(stage, 'kimi.plugin.json');
  let supplied: Record<string, unknown> = {};
  if (existsSync(native)) {
    supplied = parseJson(native, 'Kimi native manifest');
    if (supplied.name !== undefined && supplied.name !== expectedName) throw new Error(`Kimi native manifest name conflicts with ${expectedName}`);
    if (supplied.version !== undefined && supplied.version !== manifest.version) throw new Error('Kimi native manifest version conflicts with Agent Plugins manifest');
    if (supplied.skills !== undefined && supplied.skills !== './skills/' && supplied.skills !== './skills') throw new Error(`unsupported Kimi native skills pointer: ${String(supplied.skills)}`);
    if (supplied.commands !== undefined && !['./commands/', './commands', './.claude/commands/', './.claude/commands'].includes(String(supplied.commands))) throw new Error(`unsupported Kimi native commands pointer: ${String(supplied.commands)}`);
    for (const key of Object.keys(supplied)) if (!['name', 'version', 'description', 'skills', 'commands', 'mcpServers'].includes(key)) throw new Error(`unsupported Kimi native manifest field: ${key}`);
    if (supplied.mcpServers !== undefined && !isObject(supplied.mcpServers)) throw new Error('Kimi native manifest mcpServers must be an object');
  }
  const commands = prepareCommands(stage, typeof supplied.commands === 'string' ? supplied.commands : undefined);
  const mcpServers = collectMcpServers(stage, manifest, supplied);
  const nativeManifest: Record<string, unknown> = { name: expectedName, ...(typeof manifest.version === 'string' ? { version: manifest.version } : {}), ...(typeof manifest.description === 'string' ? { description: manifest.description } : {}), ...(existsSync(skills) ? { skills: './skills/' } : {}), ...(commands !== undefined ? { commands } : {}), ...(mcpServers !== undefined ? { mcpServers } : {}) };
  writeFileSync(native, JSON.stringify(nativeManifest, null, 2));
  assertNoSymlinks(stage);
}
function collectMcpServers(stage: string, manifest: Record<string, unknown>, supplied: Record<string, unknown>): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = {};
  let found = false;
  const add = (label: string, value: unknown): void => {
    if (value === undefined) return;
    if (!isObject(value)) throw new Error(`Kimi ${label} mcpServers must be an object`);
    found = true;
    for (const [name, server] of Object.entries(value)) {
      if (!isObject(server)) throw new Error(`Kimi ${label} MCP server ${name} must be an object`);
      if (merged[name] !== undefined && JSON.stringify(merged[name]) !== JSON.stringify(server)) throw new Error(`Kimi MCP server ${name} conflicts between supported source declarations`);
      merged[name] = server;
    }
  };
  // A native declaration is already Kimi's active representation; canonical
  // source declarations must agree with it rather than being silently lost.
  add('native manifest', supplied.mcpServers);
  const legacyNative = join(stage, '.kimi-plugin', 'plugin.json');
  if (existsSync(legacyNative)) add('.kimi-plugin/plugin.json', parseJson(legacyNative, '.kimi-plugin/plugin.json').mcpServers);
  add('root plugin manifest', manifest.mcpServers);
  for (const file of ['.mcp.json', 'mcp.json']) {
    const path = join(stage, file);
    if (!existsSync(path)) continue;
    add(file, parseJson(path, file).mcpServers);
  }
  return found ? merged : undefined;
}
function prepareCommands(stage: string, supplied?: string): string | undefined {
  const commands = join(stage, 'commands');
  if (existsSync(commands) && !statSync(commands).isDirectory()) throw new Error(`Kimi commands path is not a directory: ${commands}`);
  const claude = join(stage, '.claude', 'commands');
  const selected = supplied === undefined ? (existsSync(claude) ? './.claude/commands/' : existsSync(commands) ? './commands/' : undefined) : supplied.endsWith('/') ? supplied : `${supplied}/`;
  if (selected === undefined) return undefined;
  const dir = selected.startsWith('./.claude/') ? claude : commands;
  if (!existsSync(dir)) throw new Error(`Kimi native commands pointer has no directory: ${selected}`);
  assertMarkdownCommandTree(dir);
  if (!containsMarkdown(dir)) throw new Error(`Kimi native commands pointer has no Markdown commands: ${selected}`);
  return selected;
}
function assertKimiSkillPolicies(dir: string): void { for (const name of readdirSync(dir)) { const path = join(dir, name); const stat = lstatSync(path); if (stat.isDirectory()) assertKimiSkillPolicies(path); else if (stat.isFile() && name === 'SKILL.md') { const frontmatter = openingFrontmatter(readFileSync(path, 'utf8'), path); if (frontmatter !== undefined && ['user-invocable', 'user_invocable'].some(key => Object.hasOwn(frontmatter, key))) throw new Error(`Kimi does not support user-invocable skill policy: ${path}`); const hyphen = frontmatter?.['disable-model-invocation'], underscore = frontmatter?.disable_model_invocation; if (hyphen !== undefined && underscore !== undefined && hyphen !== underscore) throw new Error(`Kimi disable-model-invocation aliases conflict: ${path}`); for (const value of [hyphen, underscore]) if (value !== undefined && typeof value !== 'boolean') throw new Error(`Kimi disable-model-invocation must be boolean: ${path}`); } } }
function openingFrontmatter(raw: string, path: string): Record<string, unknown> | undefined { const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw); if (match === null) return undefined; let parsed: unknown; try { parsed = Bun.YAML.parse(match[1] ?? ''); } catch { throw new Error(`Kimi skill frontmatter has invalid YAML: ${path}`); } if (!isObject(parsed)) throw new Error(`Kimi skill frontmatter must be an object: ${path}`); return parsed; }
function assertMarkdownCommandTree(dir: string): void { for (const name of readdirSync(dir)) { const path = join(dir, name); const stat = lstatSync(path); if (stat.isSymbolicLink()) throw new Error(`Kimi command source contains symlink: ${path}`); if (stat.isDirectory()) assertMarkdownCommandTree(path); else if (!stat.isFile() || !name.endsWith('.md')) throw new Error(`Kimi command projection cannot preserve non-Markdown resource: ${path}`); else assertKimiCommand(path); } }
function assertKimiCommand(path: string): void { const raw = readFileSync(path, 'utf8'); const frontmatter = openingFrontmatter(raw, path); if (frontmatter === undefined) throw new Error(`Kimi command needs YAML frontmatter: ${path}`); for (const key of Object.keys(frontmatter)) if (!['name', 'description'].includes(key)) throw new Error(`Kimi command metadata is unsupported: ${key} in ${path}`); const body = raw.slice(raw.indexOf('\n---', 4) + 4); if (/!`[\s\S]*?`|@\{|\$\d+(?!\w)/u.test(body)) throw new Error(`Kimi command preprocessing is unsupported: ${path}`); }
function containsMarkdown(dir: string): boolean { return readdirSync(dir).some(name => { const path = join(dir, name); return statSync(path).isDirectory() ? containsMarkdown(path) : name.endsWith('.md'); }); }
function readSourceManifest(stage: string): Record<string, unknown> {
  const file = [join(stage, 'plugin.json'), join(stage, '.plugin', 'plugin.json')].find(existsSync);
  if (file === undefined) throw new Error('Kimi stage has no Agent Plugins manifest');
  return parseJson(file, 'Agent Plugins manifest');
}
function parseJson(path: string, label: string): Record<string, unknown> { try { const raw: unknown = JSON.parse(readFileSync(path, 'utf8')); if (!isObject(raw)) throw new Error('must be an object'); return raw; } catch (error) { throw new Error(`invalid ${label}: ${path} (${(error as Error).message})`); } }
function validateNativeIdentity(target: string, id: string): void { const file = join(target, 'kimi.plugin.json'); if (!existsSync(file) || parseJson(file, 'Kimi native manifest').name !== id) throw new Error(`unowned Kimi managed plugin has no matching native manifest: ${target}`); }
function readOwnership(target: string): Ownership | null { const file = join(target, MARKER); const stat = lstatIfPresent(file); if (stat === undefined) return null; if (stat.isSymbolicLink()) throw new Error(`plgnz ownership marker is a symlink: ${file}`); if (!stat.isFile()) throw new Error(`plgnz ownership marker is not a file: ${file}`); const value = parseJson(file, 'plgnz ownership marker'); if (typeof value.source !== 'string' || typeof value.pluginId !== 'string' || typeof value.fingerprint !== 'string') throw new Error(`invalid plgnz ownership marker: ${file}`); return { source: value.source, pluginId: value.pluginId, fingerprint: value.fingerprint }; }
function sameTree(left: string, right: string): boolean { if (!existsSync(right)) return false; const readBytes = readFileSync as unknown as (path: string) => Uint8Array; const list = (root: string): string[] => { const out: string[] = []; const walk = (dir: string, prefix: string): void => { for (const name of readdirSync(dir).sort()) { if (name === MARKER) continue; const path = join(dir, name); const rel = prefix ? `${prefix}/${name}` : name; const stat = lstatSync(path); if (stat.isSymbolicLink()) throw new Error(`Kimi plugin contains symlink: ${path}`); if (stat.isDirectory()) walk(path, rel); else if (stat.isFile()) out.push(`${rel}:${Array.from(readBytes(path)).join(',')}`); else throw new Error(`Kimi plugin contains unsupported file: ${path}`); } }; walk(root, ''); return out; }; return JSON.stringify(list(left)) === JSON.stringify(list(right)); }
function assertNoSymlinks(root: string): void { const walk = (dir: string): void => { const stat = lstatSync(dir); if (stat.isSymbolicLink()) throw new Error(`Kimi plugin contains symlink: ${dir}`); if (!stat.isDirectory()) throw new Error(`Kimi plugin path is not a directory: ${dir}`); for (const name of readdirSync(dir)) { const path = join(dir, name); const child = lstatSync(path); if (child.isSymbolicLink()) throw new Error(`Kimi plugin contains symlink: ${path}`); if (child.isDirectory()) walk(path); else if (!child.isFile()) throw new Error(`Kimi plugin contains unsupported file: ${path}`); } }; walk(root); }
function moveAside(target: string, root: string): { commit(): void; rollback(): void } { if (!existsSync(target)) return { commit: () => {}, rollback: () => {} }; mkdirSync(root, { recursive: true }); const dir = mkdtempSync(join(root, '.plgnz-kimi-backup-')); const previous = join(dir, 'previous'); renameSync(target, previous); return { commit: () => rmSync(dir, { recursive: true, force: true }), rollback: () => { renameSync(previous, target); rmSync(dir, { recursive: true, force: true }); } }; }
function lstatIfPresent(path: string) { try { return lstatSync(path); } catch (error) { if ((error as { code?: string }).code === 'ENOENT') return undefined; throw error; } }
function assertManagedPath(root: string, target: string): void { const base = resolve(root); const selected = resolve(target); if (selected !== base && !selected.startsWith(`${base}/`)) throw new Error(`Kimi managed path escapes its home: ${target}`); let current = base; for (const part of selected.slice(base.length).split('/').filter(Boolean)) { if (lstatIfPresent(current) === undefined) break; const stat = lstatSync(current); if (stat.isSymbolicLink()) throw new Error(`Kimi managed path component is a symlink: ${current}`); if (!stat.isDirectory()) throw new Error(`Kimi managed path component is not a directory: ${current}`); current = join(current, part); } const stat = lstatIfPresent(current); if (stat !== undefined) { if (stat.isSymbolicLink()) throw new Error(`Kimi managed path component is a symlink: ${current}`); if (current !== selected && !stat.isDirectory()) throw new Error(`Kimi managed path component is not a directory: ${current}`); } }
function assertFilePath(root: string, path: string): void { assertManagedPath(root, dirname(path)); const stat = lstatIfPresent(path); if (stat === undefined) return; if (stat.isSymbolicLink()) throw new Error(`Kimi managed metadata is a symlink: ${path}`); if (!stat.isFile()) throw new Error(`Kimi managed metadata is not a file: ${path}`); }

function resolveKimiBinary(): string {
  const explicit = process.env['OPEN_PLUGIN_KIMI_BIN'];
  const binary = explicit ?? join(process.env['HOME'] ?? '.', '.local', 'share', 'kimi-code', 'bin', 'kimi');
  if (!existsSync(binary)) throw new Error(`current Kimi Code binary not found: ${binary}`);
  const result = Bun.spawnSync([binary, '--version'], { stdout: 'pipe', stderr: 'pipe' });
  const version = new TextDecoder().decode(result.stdout).trim();
  const match = /^(\d+)\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.exec(version);
  if (result.exitCode !== 0 || match === null || Number(match[1]) === 0) throw new Error(`current Kimi Code binary required; legacy or unsupported binary: ${binary}`);
  return binary;
}
async function reservePort(): Promise<number> { const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') }); const port = server.port; server.stop(true); return port; }
async function nativeInstall(source: string, home: string, binary: string): Promise<void> {
  if (!isAbsolute(home) || !isAbsolute(source)) throw new Error('Kimi native source and home must be absolute');
  await withKimiServer(home, binary, request => { request('POST', '/api/v1/plugins', { source }); request('POST', `/api/v1/plugins/${encodeURIComponent(source.split('/').at(-1) ?? '')}:enable`); });
}
async function nativeRemove(home: string, binary: string, id: string): Promise<void> {
  if (!isAbsolute(home)) throw new Error('Kimi native home must be absolute');
  await withKimiServer(home, binary, request => { request('POST', `/api/v1/plugins/${encodeURIComponent(id)}:remove`); });
}
async function withKimiServer(home: string, binary: string, operation: (request: (method: string, path: string, body?: unknown) => Record<string, unknown>) => void): Promise<void> {
  const port = await reservePort(); const base = `http://127.0.0.1:${port}`;
  const child = Bun.spawn([binary, 'web', '--no-open', '--port', String(port), '--log-level', 'silent'], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, KIMI_CODE_HOME: home, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' } });
  let token: string | undefined;
  try {
    let healthy = false;
    for (let attempt = 0; attempt < 90; attempt += 1) { if (child.exitCode !== null) throw new Error(`Kimi web exited before becoming healthy (exit ${child.exitCode})`); try { const value = curlJson(`${base}/api/v1/healthz`); if (value.code === 0 && isObject(value.data) && value.data.ok === true) { healthy = true; break; } } catch {} await Bun.sleep(50); }
    if (!healthy) throw new Error('Kimi web server did not become healthy within the lifecycle deadline');
    token = readFileSync(join(home, 'server.token'), 'utf8').trim(); if (!token) throw new Error('Kimi server did not create its bearer token');
    const request = (method: string, path: string, body?: unknown): Record<string, unknown> => { const value = curlJson(`${base}${path}`, method, token, body); if (value.code !== 0) throw new Error(`Kimi ${method} ${path}: ${String(value.msg ?? value.code)}`); return value; };
    operation(request);
  } finally {
    if (token) { try { curlJson(`${base}/api/v1/shutdown`, 'POST', token); } catch {} }
    await Promise.race([child.exited, Bun.sleep(100)]); if (child.exitCode === null) { child.kill(); await Promise.race([child.exited, Bun.sleep(1_000)]); }
  }
}
function curlJson(url: string, method = 'GET', token?: string, body?: unknown): Record<string, unknown> { const args = ['--noproxy', '*', '--silent', '--show-error', '--max-time', '2', '--request', method, ...(token === undefined ? [] : ['--header', `Authorization: Bearer ${token}`]), ...(body === undefined ? [] : ['--header', 'Content-Type: application/json', '--data', JSON.stringify(body)]), url]; const result = Bun.spawnSync(['curl', ...args], { stdout: 'pipe', stderr: 'pipe' }); const text = new TextDecoder().decode(result.stdout); if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr).trim() || `curl exit ${result.exitCode}`); try { const value: unknown = JSON.parse(text); if (!isObject(value)) throw new Error('must be an object'); return value; } catch (error) { throw new Error(`Kimi returned invalid JSON: ${(error as Error).message}`); } }
