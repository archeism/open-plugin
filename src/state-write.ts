/**
 * The write side of the install ledger (src/state.ts) — `add`, `pin` and
 * `update` write through this; doctor imports only the readers, and a module
 * is evaluated whole, so keeping `writeState` out of src/state.ts keeps
 * writer code out of doctor's import graph (AGENTS.md;
 * test/doctor-imports.test.ts pins it).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { stateFile } from './paths';
import { readLifecycleState, validateLifecycleState, type InstallRecord, type LifecycleStateV2 } from './state';

export interface LifecycleStateWriteAuthorization {
  /** Callers may persist accepted intent only after command-global preflight. */
  globalPreflight: 'succeeded';
}

export function writeState(records: InstallRecord[], file: string = stateFile()): void {
  const existing = readLifecycleState(file);
  if (existing.sourceVersion === 2) throw new Error('refusing to downgrade state.json version 2 through the legacy writer');
  atomicWrite(file, JSON.stringify({ version: 1, installs: records }, null, 2));
}

/**
 * Validate the complete v2 document before creating a temporary file, then
 * atomically replace state.json on its own filesystem.
 */
export function writeLifecycleState(
  state: LifecycleStateV2,
  authorization: LifecycleStateWriteAuthorization,
  file: string = stateFile(),
): void {
  if (authorization.globalPreflight !== 'succeeded') {
    throw new Error('state v2 writes require successful global preflight');
  }
  validateLifecycleState(state);
  const previous = readLifecycleState(file);
  if (previous.sourceVersion === 2 && previous.state.stateGeneration === Number.MAX_SAFE_INTEGER) {
    throw new Error('stateGeneration cannot advance beyond the maximum safe integer');
  }
  const expectedGeneration = previous.sourceVersion === 2 ? previous.state.stateGeneration + 1 : 1;
  if (state.stateGeneration !== expectedGeneration) {
    throw new Error(`stateGeneration must advance from ${previous.state.stateGeneration} to ${expectedGeneration}`);
  }
  atomicWrite(file, JSON.stringify(state, null, 2));
}

function atomicWrite(file: string, contents: string): void {
  const parent = dirname(file);
  mkdirSync(parent, { recursive: true });
  const temporary = join(parent, `.${basename(file)}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    writeFileSync(temporary, contents);
    (fs as unknown as { renameSync(from: string, to: string): void }).renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
