/**
 * Command-resolution and git helpers shared by doctor.
 */
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';

/** A path that exists and is an executable regular file. */
export function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a bare command on *this process's* PATH; null when not found. */
export function which(command: string): string | null {
  const pathEnv = process.env['PATH'] ?? '';
  for (const dir of pathEnv.split(':')) {
    if (dir.length === 0) continue;
    const candidate = join(dir, command);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve a command containing `/` (spec §7.2.1 allows bare names or
 * plugin-relative `./` paths). Absolute paths pass through; relative paths
 * resolve against `baseDir` (the plugin root, or the config file's root).
 */
export function resolveCommandPath(command: string, baseDir: string): string {
  return isAbsolute(command) ? command : join(baseDir, command);
}

/**
 * Root placeholders hosts expand at launch: spec §9.2 defines `${PLUGIN_ROOT}`;
 * the CLAUDE_/CODEX_/CURSOR_ variants are host-native conventions measured in
 * real caches (e.g. `${CODEX_PLUGIN_ROOT}/scripts/air-launcher.sh`). spec
 * §7.2.1 forbids placeholder expansion in a spec `command`, so these only
 * occur in host-native config files. Unknown placeholders are reported back
 * so doctor can mark the entry unverifiable instead of dead.
 */
const ROOT_PLACEHOLDERS = new Set(['PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT', 'CODEX_PLUGIN_ROOT', 'CURSOR_PLUGIN_ROOT']);

export function expandRootPlaceholders(command: string, root: string): { expanded: string; unknown: string | null } {
  let unknown: string | null = null;
  const expanded = command.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => {
    if (ROOT_PLACEHOLDERS.has(name)) return root;
    unknown = whole;
    return whole;
  });
  return { expanded, unknown };
}

/** Current HEAD sha of a local git checkout, or null when unavailable. */
export function gitHead(dir: string): string | null {
  try {
    const r = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    const sha = r.stdout.trim();
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * A remote git source — the URL prefixes `add` accepts (src/source.ts
 * `resolveSource`). One predicate shared by `add` and doctor so the source
 * kinds that get recorded and the source kinds doctor can freshness-check
 * cannot drift apart.
 */
export function isGitUrl(source: string): boolean {
  return source.startsWith('http://')
    || source.startsWith('https://')
    || source.startsWith('ssh://')
    || source.startsWith('git://')
    || source.startsWith('git@');
}

/** Current HEAD sha of a git remote via `git ls-remote`, or null when unreachable. */
export function gitRemoteHead(url: string): string | null {
  try {
    const hash = url.lastIndexOf('#');
    const locator = hash === -1 ? url : url.slice(0, hash);
    const ref = hash === -1 ? 'HEAD' : url.slice(hash + 1);
    if (/^[0-9a-f]{40}$/iu.test(ref)) return ref.toLowerCase();
    const queries = ref === 'HEAD'
      ? ['HEAD']
      : ref.startsWith('refs/')
        ? [ref, `${ref}^{}`]
        : [`refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`];
    const r = spawnSync(process.env['OPEN_PLUGIN_GIT_BIN'] ?? 'git', ['ls-remote', locator, ...queries], { encoding: 'utf8', env: { ...process.env } });
    if (r.status !== 0) return null;
    const rows = r.stdout.split('\n').map((line) => {
      const [revision, name] = line.trim().split(/\s+/u);
      return revision !== undefined && /^[0-9a-f]{40}$/iu.test(revision) && name !== undefined ? { revision: revision.toLowerCase(), name } : undefined;
    }).filter((row): row is { revision: string; name: string } => row !== undefined);
    if (ref === 'HEAD') return rows.find((row) => row.name === 'HEAD')?.revision ?? null;
    if (ref.startsWith('refs/')) return rows.find((row) => row.name === `${ref}^{}`)?.revision ?? rows.find((row) => row.name === ref)?.revision ?? null;
    const branch = rows.find((row) => row.name === `refs/heads/${ref}`)?.revision;
    const tag = rows.find((row) => row.name === `refs/tags/${ref}^{}`)?.revision ?? rows.find((row) => row.name === `refs/tags/${ref}`)?.revision;
    return branch !== undefined && tag !== undefined ? null : branch ?? tag ?? null;
  } catch {
    return null;
  }
}
