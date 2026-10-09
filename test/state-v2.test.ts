import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeploymentScopeIdentity } from '../src/deployment-scope';
import {
  hasRetirementAuthority,
  readLifecycleState,
  readState,
  type LifecycleStateV2,
} from '../src/state';
import { writeLifecycleState, writeState } from '../src/state-write';
import type { SourceBinding } from '../src/source-reference';
import { withLifecycleCliHarness } from './lifecycle-cli-harness';

const now = '2026-10-09T02:00:00.000Z';
const earlier = '2026-10-09T01:00:00.000Z';
const fixtureSource: SourceBinding = { kind: 'git', locator: 'https://github.com/acme/plugins.git', ref: 'main' };
const fixtureTarget = { kind: 'dcode', instance: 'default' };
const fixtureScopeId = createDeploymentScopeIdentity(fixtureSource, fixtureTarget).id;

function stateFixture(): LifecycleStateV2 {
  return {
    version: 2,
    stateGeneration: 1,
    scopes: [{
      id: fixtureScopeId,
      source: { ...fixtureSource },
      target: { kind: 'dcode', instance: 'default', context: { profile: 'default' } },
      authority: 'authoritative',
      lifecycle: 'active',
      selectorMode: 'explicit',
      desired: {
        generation: 3,
        revision: '3333333333333333333333333333333333333333',
        sourceFingerprint: 'source-generation-three',
        packages: [{
          packageId: 'addy@personal',
          nativeId: 'addy@personal',
          sourceRelativeDir: 'plugins/addy',
          requiredCapabilities: ['agents', 'commands', 'skills'],
          adoptionRequested: false,
        }],
        validatedAt: now,
      },
      lastConverged: {
        generation: 2,
        revision: '2222222222222222222222222222222222222222',
        sourceFingerprint: 'source-generation-two',
        packages: [{
          packageId: 'addy@personal',
          nativeId: 'addy@personal',
          sourceRelativeDir: 'plugins/addy',
          requiredCapabilities: ['agents', 'commands', 'skills'],
          adoptionRequested: false,
        }],
        validatedAt: earlier,
      },
      lastAttemptId: 'attempt-7',
      createdAt: earlier,
      updatedAt: now,
    }],
    activations: [{
      scopeId: fixtureScopeId,
      packageId: 'addy@personal',
      nativeId: 'addy@personal',
      sourceRelativeDir: 'plugins/addy',
      sourceRevision: '2222222222222222222222222222222222222222',
      route: { kind: 'managed', evidenceKey: { kind: 'capability-profile', key: 'dcode/0.1.83/managed/update' } },
      ownership: { kind: 'created', proofKey: { kind: 'managed-marker', key: 'addy' }, verifiedAt: earlier },
      fingerprints: { source: 'source-v2', projected: 'projected-v2', installed: 'installed-v2' },
      activationState: 'active',
      readbackState: 'verified',
      pins: ['addy-mcp'],
      activatedAt: earlier,
      readbackAt: now,
      createdAt: earlier,
      updatedAt: now,
    }],
    attempts: [{
      id: 'attempt-7',
      command: 'sync',
      phase: 'completed',
      mutationStarted: true,
      scopeIds: [fixtureScopeId],
      journal: [{
        operationId: 'operation-7',
        scopeId: fixtureScopeId,
        packageId: 'addy@personal',
        nativeId: 'addy@personal',
        action: 'update',
        state: 'completed',
        route: { kind: 'managed', evidenceKey: { kind: 'capability-profile', key: 'dcode/0.1.83/managed/update' } },
        startedAt: earlier,
        updatedAt: now,
      }],
      startedAt: earlier,
      updatedAt: now,
      completedAt: now,
    }],
    tombstones: [{
      id: 'tombstone-old-toolbox',
      scopeId: fixtureScopeId,
      packageId: 'toolbox@personal',
      nativeId: 'toolbox@personal',
      sourceRelativeDir: 'plugins/toolbox',
      sourceRevision: '1111111111111111111111111111111111111111',
      route: { kind: 'managed', evidenceKey: { kind: 'capability-profile', key: 'dcode/0.1.83/managed/retire' } },
      ownership: { kind: 'adopted', proofKey: { kind: 'native-record', key: 'toolbox' }, verifiedAt: earlier, adoptedAt: earlier },
      fingerprints: { source: 'toolbox-source', projected: 'toolbox-projected', installed: 'toolbox-installed' },
      pins: [],
      retentionState: 'plugin-state-retained',
      activatedAt: earlier,
      retiredAt: now,
    }],
  };
}

function tempStateFile(prefix = 'plgnz-state-v2-'): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return { root, file: join(root, 'state.json') };
}

function addOtherScope(state: LifecycleStateV2): string {
  const source: SourceBinding = { kind: 'local', locator: '/tmp/other-source' };
  const target = { kind: 'codex', instance: 'default' };
  const id = createDeploymentScopeIdentity(source, target).id;
  state.scopes.push({
    id,
    source,
    target,
    authority: 'legacy-import',
    lifecycle: 'active',
    selectorMode: 'legacy-unknown',
  });
  return id;
}

function expectThrow(fn: () => void, message: string): void {
  let error: Error | undefined;
  try { fn(); } catch (caught) { error = caught as Error; }
  expect(error?.message).toContain(message);
}

describe('state v2 public reader and writer', () => {
  test('round-trips every lifecycle entity only after successful global preflight', () => {
    const { file } = tempStateFile();
    const state = stateFixture();

    expectThrow(
      () => writeLifecycleState(state, { globalPreflight: 'not-run' } as unknown as { globalPreflight: 'succeeded' }, file),
      'successful global preflight',
    );
    expect(existsSync(file)).toBe(false);

    writeLifecycleState(state, { globalPreflight: 'succeeded' }, file);
    expect(readLifecycleState(file)).toEqual({ sourceVersion: 2, state });
    expect(hasRetirementAuthority(state.activations[0]!)).toBe(true);
    expect(readState(file)[0]).toEqual({
      host: 'dcode',
      id: 'addy@personal',
      source: 'https://github.com/acme/plugins.git#main',
      sourceSha: '2222222222222222222222222222222222222222',
      pins: ['addy-mcp'],
      fingerprint: 'source-v2',
      installedFingerprint: 'installed-v2',
      ownership: 'plgnz',
      installedAt: earlier,
    });

    expectThrow(() => writeLifecycleState(state, { globalPreflight: 'succeeded' }, file), 'stateGeneration must advance from 1 to 2');
    expect(readLifecycleState(file).state.stateGeneration).toBe(1);
    writeLifecycleState({ ...state, stateGeneration: 2 }, { globalPreflight: 'succeeded' }, file);
    expect(readLifecycleState(file).state.stateGeneration).toBe(2);
  });

  test('rejects malformed, unsupported, unknown, and unsafe v2 fields', () => {
    const { file } = tempStateFile();
    writeFileSync(file, '{bad json');
    expectThrow(() => readLifecycleState(file), 'Invalid state.json');

    const cases: Array<{ mutate(value: Record<string, unknown>): void; message: string }> = [
      { mutate: value => { value['version'] = 99; }, message: 'Unsupported state.json version' },
      { mutate: value => { value['unexpected'] = true; }, message: "unsupported root field 'unexpected'" },
      { mutate: value => { (value['scopes'] as Array<Record<string, unknown>>)[0]!['unexpected'] = true; }, message: "unsupported deployment scope field 'unexpected'" },
      { mutate: value => { ((value['scopes'] as Array<Record<string, unknown>>)[0]!['source'] as Record<string, unknown>)['unexpected'] = true; }, message: "unsupported source binding field 'unexpected'" },
      { mutate: value => { ((value['scopes'] as Array<Record<string, unknown>>)[0]!['target'] as Record<string, unknown>)['unexpected'] = true; }, message: "unsupported target identity field 'unexpected'" },
      { mutate: value => { ((value['scopes'] as Array<Record<string, unknown>>)[0]!['desired'] as Record<string, unknown>)['unexpected'] = true; }, message: "unsupported desired generation field 'unexpected'" },
      { mutate: value => { ((((value['scopes'] as Array<Record<string, unknown>>)[0]!['desired'] as Record<string, unknown>)['packages'] as Array<Record<string, unknown>>)[0]!)['unexpected'] = true; }, message: "unsupported desired package field 'unexpected'" },
      { mutate: value => { (value['activations'] as Array<Record<string, unknown>>)[0]!['unexpected'] = true; }, message: "unsupported activation field 'unexpected'" },
      { mutate: value => { ((value['activations'] as Array<Record<string, unknown>>)[0]!['route'] as Record<string, unknown>)['unexpected'] = true; }, message: "unsupported route field 'unexpected'" },
      { mutate: value => { ((((value['activations'] as Array<Record<string, unknown>>)[0]!['route'] as Record<string, unknown>)['evidenceKey'] as Record<string, unknown>))['metadata'] = 'secret'; }, message: "unsupported capability evidence reference field 'metadata'" },
      { mutate: value => { ((value['activations'] as Array<Record<string, unknown>>)[0]!['ownership'] as Record<string, unknown>)['unexpected'] = true; }, message: "unsupported ownership proof field 'unexpected'" },
      { mutate: value => { ((((value['activations'] as Array<Record<string, unknown>>)[0]!['ownership'] as Record<string, unknown>)['proofKey'] as Record<string, unknown>))['metadata'] = 'secret'; }, message: "unsupported ownership proof reference field 'metadata'" },
      { mutate: value => { ((value['activations'] as Array<Record<string, unknown>>)[0]!['fingerprints'] as Record<string, unknown>)['unexpected'] = true; }, message: "unsupported fingerprints field 'unexpected'" },
      { mutate: value => { const activation = (value['activations'] as Array<Record<string, unknown>>)[0]!; activation['pending'] = { operation: 'update', phase: 'readback', attemptId: 'attempt-7', unexpected: true }; }, message: "unsupported pending operation field 'unexpected'" },
      { mutate: value => { (value['attempts'] as Array<Record<string, unknown>>)[0]!['unexpected'] = true; }, message: "unsupported lifecycle attempt field 'unexpected'" },
      { mutate: value => { (((value['attempts'] as Array<Record<string, unknown>>)[0]!['journal'] as Array<Record<string, unknown>>)[0]!)['unexpected'] = true; }, message: "unsupported journal entry field 'unexpected'" },
      { mutate: value => { ((value['scopes'] as Array<Record<string, unknown>>)[0]!['source'] as Record<string, unknown>)['locator'] = 'https://token@example.invalid/repo.git'; }, message: 'credential-free' },
      { mutate: value => { (((value['scopes'] as Array<Record<string, unknown>>)[0]!['target'] as Record<string, unknown>)['context'] as Record<string, unknown>)['apiToken'] = 'secret'; }, message: 'secret-bearing target context key' },
      { mutate: value => { ((value['activations'] as Array<Record<string, unknown>>)[0]!['ownership'] as Record<string, unknown>)['kind'] = 'legacy-claim'; }, message: 'legacy ownership cannot use a verified route' },
      { mutate: value => { ((value['tombstones'] as Array<Record<string, unknown>>)[0]!['ownership'] as Record<string, unknown>)['kind'] = 'legacy-claim'; }, message: 'tombstone ownership must be revalidated' },
      { mutate: value => { (value['tombstones'] as Array<Record<string, unknown>>)[0]!['pluginData'] = '/secret'; }, message: "unsupported tombstone field 'pluginData'" },
    ];

    for (const item of cases) {
      const value = JSON.parse(JSON.stringify(stateFixture())) as Record<string, unknown>;
      item.mutate(value);
      writeFileSync(file, JSON.stringify(value));
      expectThrow(() => readLifecycleState(file), item.message);
    }
  });

  test('rejects duplicate identities, broken references, and forged lifecycle authority', () => {
    const { file } = tempStateFile();
    const cases: Array<{ mutate(value: LifecycleStateV2): void; message: string }> = [
      { mutate: value => { value.scopes.push(JSON.parse(JSON.stringify(value.scopes[0])) as LifecycleStateV2['scopes'][number]); }, message: 'duplicate deployment scope id' },
      { mutate: value => { value.activations[0]!.scopeId = 'missing-scope'; }, message: "references unknown scope 'missing-scope'" },
      { mutate: value => { value.activations[0]!.pending = { operation: 'update', phase: 'readback', attemptId: 'missing-attempt' }; }, message: "references unknown pending attempt 'missing-attempt'" },
      { mutate: value => { value.scopes[0]!.authority = 'legacy-import'; }, message: 'legacy import cannot carry desired or converged authority' },
      { mutate: value => { value.tombstones[0]!.fingerprints.projected = undefined; }, message: 'requires source, projected, and installed fingerprints' },
      { mutate: value => { value.activations[0]!.pins = ['z', 'a']; }, message: 'pins must be sorted and unique' },
    ];
    for (const item of cases) {
      const value = JSON.parse(JSON.stringify(stateFixture())) as LifecycleStateV2;
      item.mutate(value);
      writeFileSync(file, JSON.stringify(value));
      expectThrow(() => readLifecycleState(file), item.message);
    }
  });

  test('rejects recovery references that do not resolve to the same exact activation scope and identity', () => {
    const { file } = tempStateFile();
    const cases: Array<{ mutate(value: LifecycleStateV2): void; message: string }> = [
      {
        mutate: value => {
          const otherScopeId = addOtherScope(value);
          value.attempts[0]!.scopeIds = [otherScopeId];
          value.attempts[0]!.journal[0]!.scopeId = otherScopeId;
        },
        message: 'last attempt does not include that scope',
      },
      {
        mutate: value => {
          const otherScopeId = addOtherScope(value);
          value.scopes[0]!.lastAttemptId = undefined;
          value.activations[0]!.pending = { operation: 'update', phase: 'readback', attemptId: 'attempt-7' };
          value.attempts[0]!.scopeIds = [otherScopeId];
          value.attempts[0]!.journal[0]!.scopeId = otherScopeId;
        },
        message: 'pending attempt does not include its scope',
      },
      {
        mutate: value => {
          value.scopes[0]!.lastAttemptId = undefined;
          value.activations[0]!.pending = { operation: 'update', phase: 'readback', attemptId: 'attempt-7' };
          value.attempts[0]!.journal[0]!.packageId = 'different@personal';
        },
        message: 'pending attempt must contain exactly one matching package/native journal entry',
      },
    ];

    for (const item of cases) {
      const value = JSON.parse(JSON.stringify(stateFixture())) as LifecycleStateV2;
      item.mutate(value);
      writeFileSync(file, JSON.stringify(value));
      expectThrow(() => readLifecycleState(file), item.message);
    }
  });

  test('rejects credential-bearing route evidence and ownership proof in retained history', () => {
    const { file } = tempStateFile();
    const cases: Array<(value: LifecycleStateV2) => void> = [
      value => {
        value.tombstones[0]!.route = {
          kind: 'managed',
          evidenceKey: { kind: 'capability-profile', key: 'https://token@example.invalid/evidence' },
        };
      },
      value => {
        value.tombstones[0]!.ownership = {
          kind: 'adopted',
          proofKey: { kind: 'native-record', key: 'https://token@example.invalid/proof' },
          verifiedAt: earlier,
          adoptedAt: earlier,
        };
      },
      value => {
        value.tombstones[0]!.route = {
          kind: 'managed',
          evidenceKey: { kind: 'capability-profile', key: 'x'.repeat(257) },
        };
      },
      value => {
        value.tombstones[0]!.ownership = {
          kind: 'adopted',
          proofKey: { kind: 'native-record', key: 'api-token-secret' },
          verifiedAt: earlier,
          adoptedAt: earlier,
        };
      },
    ];

    for (const mutate of cases) {
      const value = JSON.parse(JSON.stringify(stateFixture())) as LifecycleStateV2;
      mutate(value);
      writeFileSync(file, JSON.stringify(value));
      expectThrow(() => readLifecycleState(file), 'credential-free bounded reference');
    }
  });

  test('requires persisted state and desired generations to be positive safe integers without rollover', () => {
    const { file } = tempStateFile();
    const zero = stateFixture();
    zero.stateGeneration = 0;
    writeFileSync(file, JSON.stringify(zero));
    expectThrow(() => readLifecycleState(file), 'stateGeneration must be a safe integer >= 1');

    const unsafeDesired = stateFixture();
    unsafeDesired.scopes[0]!.desired!.generation = Number.MAX_SAFE_INTEGER + 1;
    writeFileSync(file, JSON.stringify(unsafeDesired));
    expectThrow(() => readLifecycleState(file), 'desired.generation must be a safe integer >= 1');

    const unsafeState = stateFixture();
    unsafeState.stateGeneration = Number.MAX_SAFE_INTEGER + 1;
    writeFileSync(file, JSON.stringify(unsafeState));
    const before = readFileSync(file, 'utf8');
    expectThrow(
      () => writeLifecycleState(unsafeState, { globalPreflight: 'succeeded' }, file),
      'stateGeneration must be a safe integer >= 1',
    );
    expect(readFileSync(file, 'utf8')).toBe(before);

    const maximum = stateFixture();
    maximum.stateGeneration = Number.MAX_SAFE_INTEGER;
    writeFileSync(file, JSON.stringify(maximum));
    expectThrow(
      () => writeLifecycleState(maximum, { globalPreflight: 'succeeded' }, file),
      'cannot advance beyond the maximum safe integer',
    );
  });

  test('rejects traversal and every non-canonical Source-relative path shape', () => {
    const { file } = tempStateFile();
    const cases: Array<(value: LifecycleStateV2) => void> = [
      value => { value.scopes[0]!.desired!.packages[0]!.sourceRelativeDir = 'dir/..'; },
      value => { value.activations[0]!.sourceRelativeDir = 'plugins/./addy'; },
      value => { value.tombstones[0]!.sourceRelativeDir = 'plugins\\toolbox'; },
      value => { value.activations[0]!.sourceRelativeDir = './plugins/addy'; },
      value => { value.activations[0]!.sourceRelativeDir = 'plugins//addy'; },
      value => { value.activations[0]!.sourceRelativeDir = 'plugins/addy/'; },
    ];

    for (const mutate of cases) {
      const value = JSON.parse(JSON.stringify(stateFixture())) as LifecycleStateV2;
      mutate(value);
      writeFileSync(file, JSON.stringify(value));
      expectThrow(() => readLifecycleState(file), 'must be a canonical Source-relative path');
    }
  });

  test('binds every stored scope id to its canonical Source and target identity', () => {
    const { file } = tempStateFile();
    const cases: Array<(value: LifecycleStateV2) => void> = [
      value => { value.scopes[0]!.source = { kind: 'git', locator: 'https://github.com/acme/other.git', ref: 'main' }; },
      value => { value.scopes[0]!.source = { kind: 'git', locator: fixtureSource.locator, ref: 'release' }; },
      value => { value.scopes[0]!.target.instance = 'work'; },
    ];

    for (const mutate of cases) {
      const value = JSON.parse(JSON.stringify(stateFixture())) as LifecycleStateV2;
      mutate(value);
      writeFileSync(file, JSON.stringify(value));
      expectThrow(() => readLifecycleState(file), 'does not match canonical Source and target identity');
    }
  });

  test('validates before atomic replacement and removes its temporary file on failure', () => {
    const { root, file } = tempStateFile();
    const original = '{"version":1,"installs":[]}\n';
    writeFileSync(file, original);
    const invalid = stateFixture() as LifecycleStateV2 & { unexpected?: boolean };
    invalid.unexpected = true;

    expectThrow(() => writeLifecycleState(invalid, { globalPreflight: 'succeeded' }, file), "unsupported root field 'unexpected'");
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(readdirSync(root)).toEqual(['state.json']);
  });

  test('imports v1 in memory as non-authoritative claims and preserves pending recovery', () => {
    const { file } = tempStateFile();
    const original = JSON.stringify({
      version: 1,
      installs: [{
        host: 'dcode',
        id: 'karakeep@personal',
        source: '/srv/personal',
        sourceSha: 'abc123',
        installedAt: earlier,
        pins: ['karakeep-mcp'],
        fingerprint: 'legacy-source',
        sourceDir: '/srv/personal/plugins/karakeep',
        installedFingerprint: 'legacy-installed',
        ownership: 'plgnz',
        pending: 'remove',
      }],
    }, null, 2);
    writeFileSync(file, original);

    const loaded = readLifecycleState(file);
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(loaded.sourceVersion).toBe(1);
    expect(loaded.state.stateGeneration).toBe(0);
    expect(loaded.state.scopes).toHaveLength(1);
    expect(loaded.state.scopes[0]?.authority).toBe('legacy-import');
    expect(loaded.state.scopes[0]?.desired).toBeUndefined();
    expect(loaded.state.scopes[0]?.lastConverged).toBeUndefined();
    expect(loaded.state.scopes[0]?.createdAt).toBeUndefined();
    expect(loaded.state.activations[0]?.ownership).toEqual({ kind: 'legacy-claim' });
    expect(loaded.state.activations[0]?.sourceRevision).toBe('abc123');
    expect(loaded.state.activations[0]?.activatedAt).toBe(earlier);
    expect(loaded.state.activations[0]?.createdAt).toBe(earlier);
    expect(loaded.state.activations[0]?.updatedAt).toBe(earlier);
    expect(loaded.state.activations[0]?.pending?.operation).toBe('retire');
    expect(loaded.state.attempts[0]?.command).toBe('legacy-recovery');
    expect(loaded.state.attempts[0]?.journal[0]?.action).toBe('remove');
    expect(loaded.state.attempts[0]?.startedAt).toBe(earlier);
    expect(hasRetirementAuthority(loaded.state.activations[0]!)).toBe(false);

    writeLifecycleState({ ...loaded.state, stateGeneration: 1 }, { globalPreflight: 'succeeded' }, file);
    expect(readLifecycleState(file).sourceVersion).toBe(2);
  });

  test('rejects a malformed legacy installedAt rather than silently erasing it on import', () => {
    const { file } = tempStateFile();
    writeFileSync(file, JSON.stringify({
      version: 1,
      installs: [{
        host: 'codex',
        id: 'demo@personal',
        source: '/srv/personal',
        sourceSha: 'abc123',
        installedAt: 'sometime yesterday',
      }],
    }));

    expectThrow(() => readLifecycleState(file), 'installedAt must be an ISO-8601 UTC timestamp');
  });

  test('imports a legacy remote ref into its canonical Source binding and scope id', () => {
    const { file } = tempStateFile();
    writeFileSync(file, JSON.stringify({
      version: 1,
      installs: [{
        host: 'codex',
        id: 'demo@personal',
        source: 'https://github.com/acme/plugins.git#release',
        sourceSha: 'abc123',
      }],
    }));

    const loaded = readLifecycleState(file);
    const binding: SourceBinding = { kind: 'git', locator: 'https://github.com/acme/plugins.git', ref: 'release' };
    expect(loaded.state.scopes[0]?.source).toEqual(binding);
    expect(loaded.state.scopes[0]?.id).toBe(createDeploymentScopeIdentity(binding, { kind: 'codex', instance: 'default' }).id);
  });

  test('never downgrades an existing v2 document through the legacy writer', () => {
    const { file } = tempStateFile();
    writeLifecycleState(stateFixture(), { globalPreflight: 'succeeded' }, file);
    const before = readFileSync(file, 'utf8');

    expectThrow(() => writeState([], file), 'refusing to downgrade state.json version 2');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('state v1 CLI migration boundary', () => {
  test('a real CLI dry-run leaves v1 bytes and every host store unchanged', async () => {
    await withLifecycleCliHarness(async harness => {
      const original = '{\n  "version": 1,\n  "installs": []\n}\n';
      harness.writeHome({ 'state.json': original, '.cursor/.keep': '' });
      const source = harness.source('state-v1-dry-run', {
        'plugin.json': '{"name":"demo","version":"1.0.0"}\n',
        'skills/demo/SKILL.md': '---\nname: demo\ndescription: demo\n---\n\nBody.\n',
      });

      const result = harness.run(['add', source, '--target', 'cursor', '--dry-run', '--json']);

      expect(result.exitCode).toBe(0);
      expect(result.state.before).toEqual(result.state.after);
      expect(result.stores['cursor'].before).toEqual(result.stores['cursor'].after);
    });
  });
});
