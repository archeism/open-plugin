import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readLifecycleState, readState } from '../src/state';
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

  test('legacy reader and writer reject non-canonical Source refs without mutation', () => {
    const cases = [
      ['feature#evil', 'Invalid git ref'],
      ['-bad', 'Invalid git ref'],
      ['bad..ref', 'Invalid git ref'],
      ['bad@{ref', 'Invalid git ref'],
      ['bad~ref', 'Invalid git ref'],
      ['bad^ref', 'Invalid git ref'],
      ['bad:ref', 'Invalid git ref'],
      ['bad?ref', 'Invalid git ref'],
      ['bad*ref', 'Invalid git ref'],
      ['bad\\ref', 'Invalid git ref'],
      ['bad[ref', 'Invalid git ref'],
      ['.bad', 'Invalid git ref'],
      ['bad.', 'Invalid git ref'],
      ['bad.lock', 'Invalid git ref'],
      ['a//b', 'Invalid git ref'],
      ['/bad', 'Invalid git ref'],
      ['bad/', 'Invalid git ref'],
      ['a/.bad', 'Invalid git ref'],
      ['a/b.lock', 'Invalid git ref'],
      ['bad\uD800ref', 'well-formed UTF-16'],
    ] as const;

    for (const [ref, message] of cases) {
      const root = mkdtempSync(join(tmpdir(), 'plgnz-state-ref-'));
      const file = join(root, 'state.json');
      const record = {
        host: 'codex',
        id: 'x',
        source: 'https://example.invalid/owner/repo.git#' + ref,
        sourceSha: 's',
      };
      expectThrow(() => writeState([record], file), message);
      expect(existsSync(file)).toBe(false);
      writeFileSync(file, JSON.stringify({ version: 1, installs: [record] }));
      expectThrow(() => readState(file), message);
    }

    const root = mkdtempSync(join(tmpdir(), 'plgnz-state-ref-existing-'));
    const file = join(root, 'state.json');
    writeState([{ host: 'codex', id: 'x', source: '/source', sourceSha: 's' }], file);
    const before = readFileSync(file, 'utf8');
    expectThrow(() => writeState([{
      host: 'codex',
      id: 'x',
      source: 'https://example.invalid/owner/repo.git#feature#evil',
      sourceSha: 's',
    }], file), 'Invalid git ref');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  test('legacy writer rejects Git transport identity changes without creating state', () => {
    for (const source of [
      'http://127.0.0.1:19420/owner/repo.git?token=synthetic#main',
      'https://example.invalid/owner/repo.git?token=synthetic#main',
      'ssh://git@example.invalid/owner/repo.git?token=synthetic#main',
      'git://127.0.0.1:19418/owner/repo.git?token=synthetic#main',
      'git@example.invalid:owner/repo.git?token=synthetic#main',
      'ssh://alice:secret@example.invalid/owner/repo.git#main',
      'git://alice@example.invalid:9418/owner/repo.git#main',
      'git://alice:secret@example.invalid:9418/owner/repo.git#main',
      'https://user:synthetic@example.invalid\\@evil.invalid/owner/repo.git#main',
    ]) {
      const root = mkdtempSync(join(tmpdir(), 'plgnz-state-transport-'));
      const file = join(root, 'state.json');
      const record = { host: 'codex', id: 'x', source, sourceSha: 's' };
      expectThrow(() => writeState([record], file), 'credential-free canonical git locator');
      expect(existsSync(file)).toBe(false);
      writeFileSync(file, JSON.stringify({ version: 1, installs: [record] }));
      expectThrow(() => readState(file), 'credential-free canonical git locator');
      expectThrow(() => readLifecycleState(file), 'credential-free canonical git locator');
    }
  });
});

function expectThrow(fn: () => void, message: string): void {
  let error: Error | undefined;
  try { fn(); } catch (caught) { error = caught as Error; }
  expect(error?.message).toContain(message);
}
