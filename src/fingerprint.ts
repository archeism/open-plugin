/** Stable tree fingerprint shared by source capture and read-only verification. */
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { InstalledPlugin } from './host';

declare const Bun: {
  CryptoHasher: new (algorithm: 'sha256') => {
    update(input: string | Uint8Array): void;
    digest(encoding: 'hex'): string;
  };
};

declare const TextEncoder: {
  new (): { encode(input?: string): Uint8Array };
};

export function fingerprintTree(root: string): string {
  return fingerprint(root, false);
}

/** Source proof excludes repository metadata that is not distributed to hosts. */
export function fingerprintSourceTree(root: string): string {
  return fingerprint(root, true);
}

function fingerprint(root: string, ignoreGitMetadata: boolean): string {
  if (lstatSync(root).isSymbolicLink()) throw new Error('cannot fingerprint symlink: .');
  const hash = new Bun.CryptoHasher('sha256');
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      if (ignoreGitMetadata && entry === '.git') continue;
      const path = join(dir, entry);
      const relative = prefix === '' ? entry : `${prefix}/${entry}`;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`cannot fingerprint symlink: ${relative}`);
      if (stat.isDirectory()) {
        hash.update(`d\0${relative}\0`);
        walk(path, relative);
      } else if (stat.isFile()) {
        hash.update(`f\0${relative}\0`);
        // Git and host loaders distinguish regular files from executables.
        // Normalize to that portable semantic instead of hashing platform-
        // specific read/write permission bits.
        hash.update(stat.mode & 0o111 ? 'x\0' : '-\0');
        const content = new Bun.CryptoHasher('sha256');
        content.update(readBytes(path));
        hash.update(content.digest('hex'));
        hash.update('\0');
      } else {
        throw new Error(`cannot fingerprint non-file resource: ${relative}`);
      }
    }
  };
  walk(root, '');
  return hash.digest('hex');
}

/**
 * Fingerprint the bytes that make an installation active for its host.
 * Legacy hosts expose one native tree through `path`; multi-root hosts label
 * every active root so their separate stores cannot silently escape proof.
 */
export function fingerprintInstallation(plugin: InstalledPlugin): string {
  if (plugin.contentRoots === undefined) {
    if (plugin.path === undefined) throw new Error('cannot fingerprint installation without a native path');
    return fingerprintTree(plugin.path);
  }
  const roots = Object.entries(plugin.contentRoots).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (roots.length === 0) throw new Error('cannot fingerprint installation with no content roots');
  const hash = new Bun.CryptoHasher('sha256');
  for (const [label, root] of roots) {
    if (label.length === 0) throw new Error('cannot fingerprint installation with an empty content root label');
    if (!isAbsolute(root)) throw new Error(`content root '${label}' is not absolute: ${root}`);
    const fingerprint = fingerprintTree(root);
    frame(hash, label);
    frame(hash, fingerprint);
  }
  return hash.digest('hex');
}

function frame(hash: InstanceType<typeof Bun.CryptoHasher>, value: string): void {
  const bytes = new TextEncoder().encode(value);
  const size = new Uint8Array([bytes.byteLength >>> 24, bytes.byteLength >>> 16, bytes.byteLength >>> 8, bytes.byteLength]);
  hash.update(size);
  hash.update(bytes);
}

function readBytes(path: string): Uint8Array {
  const read = readFileSync as unknown as (file: string) => Uint8Array;
  return read(path);
}
