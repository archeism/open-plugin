/**
 * Node-safe implementations of the exact Bun runtime surfaces plugnz calls,
 * so the published bundle runs under plain Node (>= 22) and Bun alike.
 * Every call site swaps `Bun.x` for the same-named export here and keeps its
 * downstream logic byte-identical: spawnSync returns Bun-shaped results
 * (exitCode plus stdout/stderr as Uint8Array), CryptoHasher chains the same
 * way, `which` scans PATH with X_OK, `sleep` is a plain setTimeout promise,
 * and `reservePort`/`spawn` back the Kimi lifecycle with node:net and
 * node:child_process. YAML parse/stringify live in ./yaml (byte parity
 * proven by test/yaml-parity.test.ts).
 */
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash, type Hash } from 'node:crypto';

export interface SpawnOptions {
  stdout?: 'pipe';
  stderr?: 'pipe';
  stdin?: 'ignore';
  env?: Record<string, string | undefined>;
  cwd?: string;
  timeout?: number;
}

export interface SpawnSyncResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export function spawnSync(command: readonly string[], options: SpawnOptions = {}): SpawnSyncResult {
  const result = nodeSpawnSync(command[0]!, [...command.slice(1)], {
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout, killSignal: 'SIGKILL' as const }),
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'buffer',
  } as never) as { status: number | null; stdout?: Uint8Array; stderr?: Uint8Array };
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? new Uint8Array(0),
    stderr: result.stderr ?? new Uint8Array(0),
  };
}

export interface ChildHandle {
  readonly exitCode: number | null;
  readonly exited: Promise<number>;
  kill(): void;
}

export function spawn(command: readonly string[], options: SpawnOptions = {}): ChildHandle {
  const child = nodeSpawn(command[0]!, [...command.slice(1)], {
    ...(options.env === undefined ? {} : { env: options.env }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise<number>((resolve) => { child.on('exit', (code) => resolve(code ?? -1)); });
  return {
    get exitCode() { return child.exitCode; },
    exited,
    kill: () => { child.kill(); },
  };
}

export class CryptoHasher {
  private readonly hash: Hash;
  constructor(algorithm: string) { this.hash = createHash(algorithm); }
  update(value: string | Uint8Array): this {
    this.hash.update(value);
    return this;
  }
  digest(format: 'hex'): string { return this.hash.digest(format); }
}

export function which(name: string): string | null {
  const path = process.env.PATH ?? '';
  for (const dir of path.split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* not executable here; keep scanning */ }
  }
  return null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : undefined;
      server.close(() => { if (port === undefined) reject(new Error('could not reserve a loopback port')); else resolve(port); });
    });
  });
}
