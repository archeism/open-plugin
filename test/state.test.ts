import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readState } from '../src/state';
import { writeState } from '../src/state-write';

describe('state ledger failures', () => {
  test('malformed JSON is surfaced instead of treated as an empty ledger', () => {
    const root = mkdtempSync(join(tmpdir(), 'plgnz-state-'));
    const file = join(root, 'state.json');
    writeFileSync(file, '{bad json');
    let error: Error | undefined;
    try { readState(file); } catch (caught) { error = caught as Error; }
    expect(error?.message).toContain('Invalid state.json');
  });

  test('write errors are surfaced', () => {
    const root = mkdtempSync(join(tmpdir(), 'plgnz-state-'));
    const blocker = join(root, 'not-a-directory');
    writeFileSync(blocker, 'file');
    let error: Error | undefined;
    try { writeState([], join(blocker, 'state.json')); } catch (caught) { error = caught as Error; }
    expect(error === undefined).toBe(false);
  });

  test('invalid install records are surfaced instead of skipped', () => {
    const root = mkdtempSync(join(tmpdir(), 'plgnz-state-'));
    const file = join(root, 'state.json');
    writeFileSync(file, JSON.stringify({ version: 1, installs: [{ host: 'claude-code' }] }));
    let error: Error | undefined;
    try { readState(file); } catch (caught) { error = caught as Error; }
    expect(error?.message).toContain('Invalid state.json: install record is missing required fields');
  });

  test('unsupported versions and invalid optional fields are rejected without filtering', () => {
    const root = mkdtempSync(join(tmpdir(), 'plgnz-state-'));
    const file = join(root, 'state.json');
    writeFileSync(file, JSON.stringify({ version: 3, installs: [] }));
    expectThrow(() => readState(file), 'Unsupported state.json version');
    writeFileSync(file, JSON.stringify({ version: 1, installs: [{ host: 'codex', id: 'x', source: '/x', sourceSha: 's', pins: ['ok', 7] }] }));
    expectThrow(() => readState(file), 'pins must be non-empty strings');
  });

  test('pending intent round-trips through the atomic writer', () => {
    const root = mkdtempSync(join(tmpdir(), 'plgnz-state-'));
    const file = join(root, 'state.json');
    writeState([{ host: 'codex', id: 'x', source: '/x', sourceSha: 's', ownership: 'plgnz', pending: 'install' }], file);
    expect(readState(file)[0]?.pending).toBe('install');
  });

  test('content proof fields round-trip and reject invalid metadata', () => {
    const root = mkdtempSync(join(tmpdir(), 'plgnz-state-proof-'));
    const file = join(root, 'state.json');
    writeState([{ host: 'codex', id: 'x', source: '/source', sourceSha: 's', sourceDir: '/source/x', fingerprint: 'source-bytes', installedFingerprint: 'native-bytes' }], file);
    expect(readState(file)[0]?.sourceDir).toBe('/source/x');
    expect(readState(file)[0]?.installedFingerprint).toBe('native-bytes');
    writeFileSync(file, JSON.stringify({ version: 1, installs: [{ host: 'codex', id: 'x', source: '/x', sourceSha: 's', installedFingerprint: 7 }] }));
    expectThrow(() => readState(file), 'installedFingerprint must be a string');
  });
});

function expectThrow(fn: () => void, message: string): void {
  let error: Error | undefined;
  try { fn(); } catch (caught) { error = caught as Error; }
  expect(error?.message).toContain(message);
}
