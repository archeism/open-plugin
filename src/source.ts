import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, basename, isAbsolute, relative, resolve } from 'node:path';
import { cacheRoot } from './paths';
import { isGitUrl } from './exec';
import { fingerprintTree } from './fingerprint';
import { validateGitRef, validateSourceBinding, type SourceBinding, type SourceSnapshotReference } from './source-reference';

export type { SourceBinding, SourceSnapshotReference } from './source-reference';

export interface PluginSource {
  /** Immutable package bytes inside the resolved Source snapshot. */
  dir: string;
  /** Canonical authored package path for local-source provenance. */
  sourceDir?: string;
  /** Package directory relative to the Source snapshot root (`.` for its root). */
  relativeDir?: string;
  name: string;
  version?: string;
  marketplace?: string;
  /** Stable digest of the source directory bytes, independent of version/SHA. */
  contentFingerprint?: string;
}

/** Identity fields shared by canonical Agent Plugins and supported native inputs. */
export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
}

export interface ResolvedSource {
  sourceUri: string;
  sha: string;
  isGit: boolean;
  /** Present on sources returned by `resolveSource`; optional for legacy adapter fixtures. */
  snapshot?: SourceSnapshotReference;
  /** Ephemeral immutable filesystem root consumed by lifecycle adapters. */
  snapshotDir?: string;
  plugins: PluginSource[];
}

/** A Source whose lifecycle inputs have been copied into an immutable byte view. */
export interface FrozenSource extends ResolvedSource {
  snapshot: SourceSnapshotReference;
  snapshotDir: string;
}

export function resolveSource(source: string): FrozenSource {
  const parsed = parseSource(source);
  let sourceUri = parsed.sourceUri;
  const isGit = parsed.binding.kind === 'git';
  let targetDir = sourceUri;
  let sourceRoot: string | undefined;
  let sha = 'local';
  let binding = parsed.binding;
  
  if (parsed.binding.kind === 'git') {
    sha = resolveRemoteRevision(parsed.fetchLocator!, parsed.binding.ref, parsed.binding.locator);
    targetDir = freezeRemoteSource(parsed.fetchLocator!, sha, parsed.binding.locator);
  } else {
    // An absolute source (what `add` records in state.json, and what `update`
    // feeds back) must not be re-rooted at the cwd — path.join does not reset
    // on an absolute second argument.
    targetDir = sourceUri;
    if (!existsSync(targetDir)) throw new Error(`Local source not found: ${targetDir}`);
    targetDir = assertSafeSourceTree(targetDir);
    sourceRoot = targetDir;
    sourceUri = targetDir;
    binding = { kind: 'local', locator: targetDir };
    const rev = spawnSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    if (rev.status === 0) {
      const match = rev.stdout.trim().match(/^[0-9a-f]{40}$/i);
      if (match) sha = match[0];
    }
    targetDir = freezeLocalSource(targetDir);
  }
  targetDir = assertSafeSourceTree(targetDir);
  const snapshotFingerprint = fingerprintTree(targetDir);
  const snapshot: SourceSnapshotReference = {
    binding,
    revision: isGit ? sha : snapshotFingerprint,
    fingerprint: snapshotFingerprint,
  };

  const plugins: PluginSource[] = [];
  
  // 1. Marketplace index
  const mp1 = join(targetDir, '.claude-plugin', 'marketplace.json');
  const mp2 = join(targetDir, '.omp-plugin', 'marketplace.json');
  const mp3 = join(targetDir, 'marketplace.json');
  const mpPath = existsSync(mp1) ? mp1 : existsSync(mp2) ? mp2 : existsSync(mp3) ? mp3 : null;
  
  if (mpPath !== null) {
    const data = parseMarketplace(mpPath);
    const marketplaceName = typeof data['name'] === 'string' ? data['name'] : 'local';
    assertSafeIdentity(marketplaceName, 'marketplace name');
    const entries = data['plugins'];
    if (!Array.isArray(entries)) throw new Error(`Malformed marketplace manifest: plugins must be an array (${mpPath})`);
    if (entries.length === 0) throw new Error(`No plugins discovered in marketplace: ${mpPath}`);
    for (const entry of entries) {
      if (!isRecord(entry) || typeof entry['source'] !== 'string' || entry['source'].trim() === '') {
        throw new Error(`Malformed marketplace manifest: every plugin needs a source (${mpPath})`);
      }
      const pDir = resolve(targetDir, entry['source']);
      if (!isInside(targetDir, pDir)) throw new Error(`Marketplace plugin source escapes collection root: ${entry['source']}`);
      if (!existsSync(pDir) || !statSync(pDir).isDirectory()) throw new Error(`Marketplace plugin source is not a directory: ${entry['source']}`);
      plugins.push(pluginFromDir(pDir, marketplaceName, targetDir, sourceRoot));
    }
  }
  
  if (plugins.length > 0) return resolvedSource(sourceUri, sha, isGit, snapshot, targetDir, plugins);

  // 2. Root plugin
  if (isPluginDir(targetDir)) {
    plugins.push(pluginFromDir(targetDir, undefined, targetDir, sourceRoot));
    return resolvedSource(sourceUri, sha, isGit, snapshot, targetDir, plugins);
  }

  // 3. Recursive scan (1 level deep)
  for (const entry of readdirSync(targetDir)) {
    const subDir = join(targetDir, entry);
    if (statSync(subDir).isDirectory() && isPluginDir(subDir)) {
      plugins.push(pluginFromDir(subDir, undefined, targetDir, sourceRoot));
    }
  }
  
  if (plugins.length === 0) throw new Error(`No plugins discovered in source: ${sourceUri}`);
  return resolvedSource(sourceUri, sha, isGit, snapshot, targetDir, plugins);
}

function resolvedSource(sourceUri: string, sha: string, isGit: boolean, snapshot: SourceSnapshotReference, snapshotDir: string, plugins: PluginSource[]): FrozenSource {
  const seen = new Set<string>();
  for (const plugin of plugins) {
    const identity = `${plugin.name}@${plugin.marketplace ?? 'local'}`;
    if (seen.has(identity)) throw new Error(`Duplicate plugin identity discovered: ${identity}`);
    seen.add(identity);
  }
  return { sourceUri, sha, isGit, snapshot, snapshotDir, plugins };
}

/** Owner/repo is the public GitHub shorthand; all local roots become absolute. */
export function normalizeSource(source: string): string {
  return parseSource(source).sourceUri;
}

function withFingerprint(plugin: PluginSource): PluginSource {
  return { ...plugin, contentFingerprint: fingerprintTree(plugin.dir) };
}

function pluginFromDir(dir: string, marketplace?: string, snapshotRoot: string = dir, sourceRoot?: string): PluginSource {
  const manifest = readPluginManifest(dir);
  const name = manifest?.name ?? inferredPluginName(dir);
  const relativeDir = relative(snapshotRoot, dir) || '.';
  const sourceDir = sourceRoot === undefined ? undefined : relativeDir === '.' ? sourceRoot : join(sourceRoot, relativeDir);
  return withFingerprint({ dir, name, relativeDir, ...(sourceDir === undefined ? {} : { sourceDir }), ...(manifest?.version === undefined ? {} : { version: manifest.version }), ...(marketplace === undefined ? {} : { marketplace }) });
}

/** Copy a local Source twice and retain one content-addressed immutable byte view. */
function freezeLocalSource(source: string): string {
  const snapshots = join(cacheRoot(), 'source-snapshots');
  if (isInside(source, snapshots)) throw new Error(`Local source contains plugnz's snapshot cache: ${source}`);
  mkdirSync(snapshots, { recursive: true });
  const candidate = mkdtempSync(join(snapshots, '.candidate-'));
  const verification = mkdtempSync(join(snapshots, '.verification-'));
  try {
    copySourceTree(source, candidate);
    copySourceTree(source, verification);
    const fingerprint = fingerprintTree(candidate);
    if (fingerprintTree(verification) !== fingerprint) throw new Error(`Local source changed while it was being frozen: ${source}`);
    const target = join(snapshots, fingerprint);
    if (existsSync(target)) {
      if (fingerprintTree(assertSafeSourceTree(target)) !== fingerprint) throw new Error(`Cached Source snapshot is corrupt: ${target}`);
      return target;
    }
    renameSync(candidate, target);
    return target;
  } finally {
    rmSync(candidate, { recursive: true, force: true });
    rmSync(verification, { recursive: true, force: true });
  }
}

function copySourceTree(source: string, destination: string): void {
  for (const entry of readdirSync(source).sort()) {
    if (entry === '.git') continue;
    const from = join(source, entry);
    const to = join(destination, entry);
    const stat = lstatSync(from);
    if (stat.isSymbolicLink()) throw new Error(`Symlink resources are not supported: ${from}`);
    if (stat.isDirectory()) {
      mkdirSync(to, { recursive: true });
      copySourceTree(from, to);
    } else if (stat.isFile()) cpSync(from, to);
    else throw new Error(`Source contains a non-file resource: ${from}`);
  }
}

interface ParsedSource {
  binding: SourceBinding;
  sourceUri: string;
  /** Authentication-bearing transport locator; never returned or persisted. */
  fetchLocator?: string;
}

function parseSource(source: string): ParsedSource {
  if (source.startsWith('./') || source.startsWith('../') || isAbsolute(source)) {
    const locator = resolve(source);
    const binding: SourceBinding = { kind: 'local', locator };
    validateSourceBinding(binding);
    return { binding, sourceUri: locator };
  }
  if (isGitUrl(source)) {
    const hash = source.indexOf('#');
    const rawLocator = hash === -1 ? source : source.slice(0, hash);
    const ref = validateGitRef(hash === -1 ? 'HEAD' : source.slice(hash + 1));
    const fetchLocator = withoutFragment(rawLocator);
    const locator = credentialFreeLocator(fetchLocator);
    const binding: SourceBinding = { kind: 'git', locator, ref };
    validateSourceBinding(binding);
    return { binding, sourceUri: formatSourceBinding(binding), fetchLocator };
  }
  const shorthand = /^([^/\s#]+)\/([^/\s#]+?)(?:#([\s\S]*))?$/u.exec(source);
  if (shorthand !== null) {
    const owner = shorthand[1]!;
    const repository = shorthand[2]!.endsWith('.git') ? shorthand[2]! : `${shorthand[2]!}.git`;
    const ref = validateGitRef(shorthand[3] ?? 'HEAD');
    const locator = `https://github.com/${owner}/${repository}`;
    const binding: SourceBinding = { kind: 'git', locator, ref };
    validateSourceBinding(binding);
    return { binding, sourceUri: formatSourceBinding(binding), fetchLocator: locator };
  }
  const locator = resolve(source);
  const binding: SourceBinding = { kind: 'local', locator };
  validateSourceBinding(binding);
  return { binding, sourceUri: locator };
}

function formatSourceBinding(binding: SourceBinding): string {
  return binding.kind === 'git' && binding.ref !== 'HEAD' ? `${binding.locator}#${binding.ref}` : binding.locator;
}

function withoutFragment(locator: string): string {
  if (!locator.startsWith('http://') && !locator.startsWith('https://')) return locator;
  const value = new URL(locator);
  value.hash = '';
  return value.toString();
}

function credentialFreeLocator(locator: string): string {
  const scheme = /^(http|https|ssh|git):\/\//u.exec(locator)?.[1];
  if (scheme === undefined) return locator;
  const value = new URL(locator);
  if (scheme !== 'ssh') value.username = '';
  value.password = '';
  value.search = '';
  value.hash = '';
  return value.toString();
}

function resolveRemoteRevision(fetchLocator: string, ref: string, displayLocator: string): string {
  if (/^[0-9a-f]{40}$/iu.test(ref)) return ref.toLowerCase();
  const queries = ref === 'HEAD'
    ? ['HEAD']
    : ref.startsWith('refs/')
      ? [ref, `${ref}^{}`]
      : [`refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`];
  const result = spawnSync(gitExecutable(), ['ls-remote', fetchLocator, ...queries], { encoding: 'utf8' });
  if (result.status !== 0) {
    const detail = safeGitDiagnostic(result.stderr, fetchLocator, displayLocator);
    throw new Error(`Failed to resolve git remote: ${displayLocator}${detail === '' ? '' : ` (${detail})`}`);
  }
  const rows = result.stdout.split('\n').map((line) => {
    const [revision, name] = line.trim().split(/\s+/u);
    return revision !== undefined && /^[0-9a-f]{40}$/iu.test(revision) && name !== undefined ? { revision: revision.toLowerCase(), name } : undefined;
  }).filter((row): row is { revision: string; name: string } => row !== undefined);
  let selected: string | undefined;
  if (ref === 'HEAD') selected = rows.find((row) => row.name === 'HEAD')?.revision;
  else if (ref.startsWith('refs/')) selected = rows.find((row) => row.name === `${ref}^{}`)?.revision ?? rows.find((row) => row.name === ref)?.revision;
  else {
    const branch = rows.find((row) => row.name === `refs/heads/${ref}`)?.revision;
    const tag = rows.find((row) => row.name === `refs/tags/${ref}^{}`)?.revision ?? rows.find((row) => row.name === `refs/tags/${ref}`)?.revision;
    if (branch !== undefined && tag !== undefined) throw new Error(`Ambiguous git ref '${ref}' at ${displayLocator}`);
    selected = branch ?? tag;
  }
  if (selected === undefined) throw new Error(`Git ref '${ref}' was not found at ${displayLocator}`);
  return selected;
}

function freezeRemoteSource(fetchLocator: string, revision: string, displayLocator: string): string {
  const snapshots = join(cacheRoot(), 'source-snapshots');
  mkdirSync(snapshots, { recursive: true });
  const candidate = mkdtempSync(join(snapshots, '.candidate-'));
  try {
    requireGit(['init', '--quiet', candidate], `Failed to initialize Source snapshot for ${displayLocator}`);
    requireGit(['-C', candidate, 'fetch', '--quiet', '--depth=1', fetchLocator, revision], `Failed to fetch resolved revision ${revision} from ${displayLocator}`);
    requireGit(['-C', candidate, 'checkout', '--quiet', '--detach', 'FETCH_HEAD'], `Failed to materialize resolved revision ${revision} from ${displayLocator}`);
    const head = spawnSync(gitExecutable(), ['-C', candidate, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    if (head.status !== 0 || head.stdout.trim().toLowerCase() !== revision) throw new Error(`Git materialization did not produce resolved revision ${revision} from ${displayLocator}`);
    rmSync(join(candidate, '.git'), { recursive: true, force: true });
    const fingerprint = fingerprintTree(candidate);
    const target = join(snapshots, fingerprint);
    if (existsSync(target)) {
      if (fingerprintTree(assertSafeSourceTree(target)) !== fingerprint) throw new Error(`Cached Source snapshot is corrupt: ${target}`);
      return target;
    }
    renameSync(candidate, target);
    return target;
  } finally {
    rmSync(candidate, { recursive: true, force: true });
  }
}

function requireGit(args: string[], message: string): void {
  const result = spawnSync(gitExecutable(), args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(message);
}

function gitExecutable(): string {
  return process.env['OPEN_PLUGIN_GIT_BIN'] ?? 'git';
}

function safeGitDiagnostic(stderr: string, fetchLocator: string, displayLocator: string): string {
  return stderr.trim()
    .replaceAll(fetchLocator, displayLocator)
    .replace(/https?:\/\/[^/@\s]+@/giu, (prefix) => prefix.slice(0, prefix.indexOf('//') + 2));
}

function assertSafeSourceTree(path: string): string {
  assertNoSymlinks(path);
  const canonical = realpath(path);
  assertNoSymlinks(canonical);
  return canonical;
}

function assertNoSymlinks(path: string): void {
  const links = spawnSync('find', [path, '-type', 'l', '-print'], { encoding: 'utf8' });
  if (links.status !== 0) throw new Error(`Could not inspect source tree: ${path}`);
  if (links.stdout.trim() !== '') throw new Error(`Symlink resources are not supported: ${links.stdout.trim()}`);
}

function parseMarketplace(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(parsed)) throw new Error('manifest must be an object');
    return parsed;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Malformed marketplace manifest: ${path} (${detail})`);
  }
}

function realpath(path: string): string {
  const result = spawnSync('realpath', [path], { encoding: 'utf8' });
  if (result.status !== 0 || result.stdout.trim() === '') throw new Error(`Could not resolve source path: ${path}`);
  return result.stdout.trim();
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPluginDir(dir: string): boolean {
  return manifestPaths(dir).some(existsSync) || existsSync(join(dir, '.mcp.json')) || existsSync(join(dir, 'mcp.json'));
}

/**
 * Canonical manifests take precedence. `.claude-plugin/plugin.json` is a
 * supported source-only fallback; it is never rewritten into a source tree.
 */
export function readPluginManifest(dir: string): PluginManifest | undefined {
  let selected: PluginManifest | undefined;
  for (const path of manifestPaths(dir)) {
    if (!existsSync(path)) continue;
    const current = parsePluginManifest(path);
    if (selected === undefined) {
      selected = current;
      continue;
    }
    if (current.name !== selected.name || (current.version !== undefined && selected.version !== undefined && current.version !== selected.version)) {
      throw new Error(`Conflicting plugin manifest identity: ${path}`);
    }
  }
  return selected;
}

function manifestPaths(dir: string): string[] {
  return [join(dir, 'plugin.json'), join(dir, '.plugin', 'plugin.json'), join(dir, '.claude-plugin', 'plugin.json')];
}

function parsePluginManifest(path: string): PluginManifest {
  let data: unknown;
  try { data = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`Malformed plugin manifest: ${path} (${(error as Error).message})`); }
  if (!isRecord(data) || typeof data['name'] !== 'string') throw new Error(`Plugin manifest needs a name: ${path}`);
  assertSafeIdentity(data['name'], 'plugin name');
  if (data['version'] !== undefined && (typeof data['version'] !== 'string' || data['version'].trim() === '')) throw new Error(`Plugin manifest version is invalid: ${path}`);
  if (data['description'] !== undefined && typeof data['description'] !== 'string') throw new Error(`Plugin manifest description is invalid: ${path}`);
  return { name: data['name'], ...(typeof data['version'] === 'string' ? { version: data['version'] } : {}), ...(typeof data['description'] === 'string' ? { description: data['description'] } : {}) };
}

function inferredPluginName(dir: string): string {
  const inferred = basename(dir);
  assertSafeIdentity(inferred, 'plugin name');
  return inferred;
}

function assertSafeIdentity(value: string, label: string): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(value)) throw new Error(`Unsafe ${label}: ${value}`);
}
