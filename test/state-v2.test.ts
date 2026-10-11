import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeploymentScopeIdentity, type TargetIdentity } from '../src/deployment-scope';
import { normalizeSource } from '../src/source';
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
const evidenceAddress = `sha256:${'a'.repeat(64)}`;
const proofAddress = `sha256:${'b'.repeat(64)}`;

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
      route: { kind: 'managed', evidenceKey: { kind: 'capability-profile', key: evidenceAddress } },
      ownership: { kind: 'created', proofKey: { kind: 'managed-marker', key: proofAddress }, verifiedAt: earlier },
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
        route: { kind: 'managed', evidenceKey: { kind: 'capability-profile', key: evidenceAddress } },
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
      route: { kind: 'managed', evidenceKey: { kind: 'capability-profile', key: evidenceAddress } },
      ownership: { kind: 'adopted', proofKey: { kind: 'native-record', key: proofAddress }, verifiedAt: earlier, adoptedAt: earlier },
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

function rebindFixtureSource(state: LifecycleStateV2, source: SourceBinding): void {
  rebindFixtureIdentity(state, source, fixtureTarget);
}

function rebindFixtureIdentity(state: LifecycleStateV2, source: SourceBinding, target: TargetIdentity): void {
  const id = createDeploymentScopeIdentity(source, target).id;
  setFixtureIdentity(state, source, target, id);
}

function setFixtureIdentity(state: LifecycleStateV2, source: SourceBinding, target: TargetIdentity, id: string): void {
  state.scopes[0]!.id = id;
  state.scopes[0]!.source = source;
  state.scopes[0]!.target = target;
  state.activations[0]!.scopeId = id;
  state.attempts[0]!.scopeIds = [id];
  state.attempts[0]!.journal[0]!.scopeId = id;
  state.tombstones[0]!.scopeId = id;
}

function setPendingTuple(
  state: LifecycleStateV2,
  tuple: {
    operation: string;
    pendingPhase: string;
    attemptPhase: string;
    journalState: string;
    mutationStarted: boolean;
  },
): void {
  const activation = state.activations[0]! as unknown as Record<string, unknown>;
  activation['pending'] = { operation: tuple.operation, phase: tuple.pendingPhase, attemptId: 'attempt-7' };
  const attempt = state.attempts[0]! as unknown as Record<string, unknown>;
  attempt['command'] = tuple.operation === 'remove' ? 'remove' : 'sync';
  attempt['phase'] = tuple.attemptPhase;
  attempt['mutationStarted'] = tuple.mutationStarted;
  if (tuple.attemptPhase === 'completed') attempt['completedAt'] = now;
  else delete attempt['completedAt'];
  const journal = state.attempts[0]!.journal[0]! as unknown as Record<string, unknown>;
  journal['action'] = tuple.operation;
  journal['state'] = tuple.journalState;
}

function useContentAddresses(state: LifecycleStateV2): void {
  const activation = state.activations[0]!;
  if (activation.route.kind !== 'legacy-unverified') activation.route.evidenceKey.key = evidenceAddress;
  if (activation.ownership.kind !== 'legacy-claim') activation.ownership.proofKey.key = proofAddress;
  const journalRoute = state.attempts[0]!.journal[0]!.route;
  if (journalRoute !== undefined && journalRoute.kind !== 'legacy-unverified') journalRoute.evidenceKey.key = evidenceAddress;
  state.tombstones[0]!.route.evidenceKey.key = evidenceAddress;
  state.tombstones[0]!.ownership.proofKey.key = proofAddress;
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
      { mutate: value => { (((value['scopes'] as Array<Record<string, unknown>>)[0]!['target'] as Record<string, unknown>)['context'] as Record<string, unknown>)['profile'] = '/profiles/work?token=synthetic'; }, message: 'must not contain credentials' },
      { mutate: value => { (((value['scopes'] as Array<Record<string, unknown>>)[0]!['target'] as Record<string, unknown>)['context'] as Record<string, unknown>)['profile'] = 'work-\uD800'; }, message: 'well-formed UTF-16' },
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

  test('accepts only exact pending operation, journal state, and attempt phase tuples', () => {
    const { file } = tempStateFile();
    const tuples = [
      { operation: 'install', pendingPhase: 'accepted', attemptPhase: 'accepted', journalState: 'pending', mutationStarted: false },
      { operation: 'update', pendingPhase: 'applying', attemptPhase: 'applying', journalState: 'applying', mutationStarted: true },
      { operation: 'disable-nonconforming', pendingPhase: 'applying', attemptPhase: 'applying', journalState: 'applying', mutationStarted: true },
      { operation: 'retire-orphan', pendingPhase: 'applying', attemptPhase: 'pruning', journalState: 'applying', mutationStarted: true },
      { operation: 'route-migrate', pendingPhase: 'readback', attemptPhase: 'readback', journalState: 'applied', mutationStarted: true },
      { operation: 'disable-nonconforming', pendingPhase: 'readback', attemptPhase: 'readback', journalState: 'applied', mutationStarted: true },
      { operation: 'retire-orphan', pendingPhase: 'readback', attemptPhase: 'pruning', journalState: 'applied', mutationStarted: true },
      { operation: 'remove', pendingPhase: 'readback', attemptPhase: 'pruning', journalState: 'applied', mutationStarted: true },
      { operation: 'remove', pendingPhase: 'cleanup', attemptPhase: 'finalizing', journalState: 'cleanup-pending', mutationStarted: true },
      { operation: 'update', pendingPhase: 'rollback', attemptPhase: 'recovery-required', journalState: 'rollback', mutationStarted: true },
    ];

    for (const tuple of tuples) {
      const value = stateFixture();
      setPendingTuple(value, tuple);
      writeFileSync(file, JSON.stringify(value));
      expect(readLifecycleState(file).state.activations[0]?.pending?.operation).toBe(tuple.operation);
    }
  });

  test('rejects all desired-versus-retirement pending phase mismatches', () => {
    const { file } = tempStateFile();
    const cases = [
      { operation: 'install', pendingPhase: 'applying', attemptPhase: 'pruning', journalState: 'applying', mutationStarted: true },
      { operation: 'update', pendingPhase: 'applying', attemptPhase: 'pruning', journalState: 'applying', mutationStarted: true },
      { operation: 'route-migrate', pendingPhase: 'applying', attemptPhase: 'pruning', journalState: 'applying', mutationStarted: true },
      { operation: 'disable-nonconforming', pendingPhase: 'applying', attemptPhase: 'pruning', journalState: 'applying', mutationStarted: true },
      { operation: 'install', pendingPhase: 'readback', attemptPhase: 'pruning', journalState: 'applied', mutationStarted: true },
      { operation: 'retire-orphan', pendingPhase: 'applying', attemptPhase: 'applying', journalState: 'applying', mutationStarted: true },
      { operation: 'remove', pendingPhase: 'applying', attemptPhase: 'applying', journalState: 'applying', mutationStarted: true },
      { operation: 'retire-orphan', pendingPhase: 'readback', attemptPhase: 'readback', journalState: 'applied', mutationStarted: true },
      { operation: 'remove', pendingPhase: 'readback', attemptPhase: 'readback', journalState: 'applied', mutationStarted: true },
    ];

    for (const tuple of cases) {
      const value = stateFixture();
      setPendingTuple(value, tuple);
      writeFileSync(file, JSON.stringify(value));
      expectThrow(() => readLifecycleState(file), `pending phase ${tuple.pendingPhase} requires attempt`);
    }
  });

  test('rejects contradictory or terminal pending recovery semantics', () => {
    const { file } = tempStateFile();
    const cases = [
      {
        tuple: { operation: 'update', pendingPhase: 'applying', attemptPhase: 'applying', journalState: 'applying', mutationStarted: true },
        mutate: (value: LifecycleStateV2): void => { value.attempts[0]!.journal[0]!.action = 'install'; },
        message: 'pending operation must match journal action',
      },
      {
        tuple: { operation: 'update', pendingPhase: 'applying', attemptPhase: 'applying', journalState: 'completed', mutationStarted: true },
        mutate: (_value: LifecycleStateV2): void => {},
        message: 'pending phase applying requires journal applying',
      },
      {
        tuple: { operation: 'update', pendingPhase: 'applying', attemptPhase: 'applying', journalState: 'failed', mutationStarted: true },
        mutate: (_value: LifecycleStateV2): void => {},
        message: 'pending phase applying requires journal applying',
      },
      {
        tuple: { operation: 'update', pendingPhase: 'applying', attemptPhase: 'applying', journalState: 'not-attempted', mutationStarted: true },
        mutate: (_value: LifecycleStateV2): void => {},
        message: 'mutationStarted is true but no journal row shows mutation began',
      },
      {
        tuple: { operation: 'update', pendingPhase: 'applying', attemptPhase: 'applying', journalState: 'readback-verified', mutationStarted: true },
        mutate: (_value: LifecycleStateV2): void => {},
        message: 'pending phase applying requires journal applying',
      },
      {
        tuple: { operation: 'update', pendingPhase: 'accepted', attemptPhase: 'accepted', journalState: 'pending', mutationStarted: true },
        mutate: (_value: LifecycleStateV2): void => {},
        message: 'mutationStarted is true but no journal row shows mutation began',
      },
      {
        tuple: { operation: 'update', pendingPhase: 'readback', attemptPhase: 'completed', journalState: 'applied', mutationStarted: true },
        mutate: (_value: LifecycleStateV2): void => {},
        message: 'pending phase readback requires attempt readback',
      },
      {
        tuple: { operation: 'update', pendingPhase: 'readback', attemptPhase: 'failed', journalState: 'applied', mutationStarted: true },
        mutate: (_value: LifecycleStateV2): void => {},
        message: 'pending phase readback requires attempt readback',
      },
      {
        tuple: { operation: 'update', pendingPhase: 'rollback', attemptPhase: 'recovery-required', journalState: 'rolled-back', mutationStarted: true },
        mutate: (_value: LifecycleStateV2): void => {},
        message: 'pending phase rollback requires journal rollback',
      },
      {
        tuple: { operation: 'remove', pendingPhase: 'cleanup', attemptPhase: 'finalizing', journalState: 'cleanup-pending', mutationStarted: false },
        mutate: (_value: LifecycleStateV2): void => {},
        message: 'journal shows mutation began but mutationStarted is false',
      },
    ];

    for (const item of cases) {
      const value = stateFixture();
      setPendingTuple(value, item.tuple);
      item.mutate(value);
      writeFileSync(file, JSON.stringify(value));
      expectThrow(() => readLifecycleState(file), item.message);
    }
  });

  test('rejects ambiguous or non-mutating actions as pending operations', () => {
    const { file } = tempStateFile();
    for (const operation of ['retire', 'disable', 'cleanup', 'adopt', 'unchanged', 'retain-prior']) {
      const value = stateFixture();
      setPendingTuple(value, {
        operation,
        pendingPhase: 'applying',
        attemptPhase: 'applying',
        journalState: 'applying',
        mutationStarted: true,
      });
      writeFileSync(file, JSON.stringify(value));
      expectThrow(() => readLifecycleState(file), 'pending.operation must be one of: install, update, route-migrate, disable-nonconforming, retire-orphan, remove');
    }
  });

  test('enforces exact command and journal action compatibility', () => {
    const { file } = tempStateFile();
    const commands = ['sync', 'retire-source', 'add', 'update', 'remove', 'legacy-recovery'] as const;
    const lifecycleActions = [
      'install',
      'update',
      'unchanged',
      'route-migrate',
      'retain-prior',
      'disable-nonconforming',
      'retire-orphan',
      'remove',
    ] as const;
    type Command = typeof commands[number];
    type Action = typeof lifecycleActions[number];
    const desiredAndNoOp = lifecycleActions.filter(action => action !== 'retire-orphan' && action !== 'remove');
    const allowedByCommand: Record<Command, readonly Action[]> = {
      sync: lifecycleActions.filter(action => action !== 'remove'),
      'retire-source': ['retire-orphan'],
      add: desiredAndNoOp,
      update: desiredAndNoOp,
      remove: ['remove', 'retire-orphan'],
      'legacy-recovery': lifecycleActions,
    };
    let rejectedCount = 0;

    for (const command of commands) {
      for (const action of lifecycleActions) {
        const value = stateFixture();
        value.attempts[0]!.command = command;
        value.attempts[0]!.journal[0]!.action = action;
        if (action === 'unchanged' || action === 'retain-prior') {
          value.attempts[0]!.journal[0]!.state = 'not-attempted';
          value.attempts[0]!.mutationStarted = false;
        }
        writeFileSync(file, JSON.stringify(value));
        if (allowedByCommand[command].includes(action)) {
          expect(readLifecycleState(file).state.attempts[0]?.command).toBe(command);
        } else {
          rejectedCount += 1;
          expectThrow(() => readLifecycleState(file), `command ${command} cannot journal action ${action}`);
        }
      }
    }
    expect(rejectedCount).toBe(18);
  });

  test('cross-checks mutationStarted against every journal row', () => {
    const { file } = tempStateFile();
    const beganStates = [
      'applying',
      'applied',
      'readback-verified',
      'rollback',
      'rolled-back',
      'cleanup-pending',
      'completed',
      'failed',
    ] as const;

    for (const state of beganStates) {
      const value = stateFixture();
      value.attempts[0]!.journal[0]!.state = state;
      value.attempts[0]!.mutationStarted = false;
      writeFileSync(file, JSON.stringify(value));
      expectThrow(() => readLifecycleState(file), 'journal shows mutation began but mutationStarted is false');
    }

    const unsupportedTrue = stateFixture();
    unsupportedTrue.attempts[0]!.journal[0]!.state = 'pending';
    unsupportedTrue.attempts[0]!.mutationStarted = true;
    writeFileSync(file, JSON.stringify(unsupportedTrue));
    expectThrow(() => readLifecycleState(file), 'mutationStarted is true but no journal row shows mutation began');

    const noOp = stateFixture();
    noOp.attempts[0]!.mutationStarted = false;
    noOp.attempts[0]!.journal = [
      {
        operationId: 'operation-unchanged',
        scopeId: fixtureScopeId,
        packageId: 'addy@personal',
        nativeId: 'addy@personal',
        action: 'unchanged',
        state: 'not-attempted',
      },
      {
        operationId: 'operation-retain',
        scopeId: fixtureScopeId,
        packageId: 'prior@personal',
        nativeId: 'prior@personal',
        action: 'retain-prior',
        state: 'not-attempted',
      },
    ];
    writeFileSync(file, JSON.stringify(noOp));
    expect(readLifecycleState(file).state.attempts[0]?.mutationStarted).toBe(false);
  });

  test('round-trips only content-addressed evidence and proof references', () => {
    const { file } = tempStateFile();
    const valid = stateFixture();
    useContentAddresses(valid);
    writeFileSync(file, JSON.stringify(valid));
    expect(readLifecycleState(file).state).toEqual(valid);

    for (const raw of [
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'sk-proj-abcdefghijklmnopqrstuvwxyz',
      'AKIAIOSFODNN7EXAMPLE',
      'https://token@example.invalid/proof',
      `sha256:${'A'.repeat(64)}`,
      `sha256:${'a'.repeat(63)}`,
    ]) {
      const value = stateFixture();
      useContentAddresses(value);
      value.tombstones[0]!.ownership.proofKey.key = raw;
      writeFileSync(file, JSON.stringify(value));
      expectThrow(() => readLifecycleState(file), 'must be sha256 followed by 64 lowercase hexadecimal characters');
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
      expectThrow(() => readLifecycleState(file), 'must be sha256 followed by 64 lowercase hexadecimal characters');
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

  test('round-trips only canonical credential-free remote Source bindings', () => {
    for (const locator of [
      'https://example.invalid/owner/repo.git',
      'ssh://git@example.invalid/owner/repo.git',
      'git://example.invalid/owner/repo.git',
      'git@example.invalid:owner/repo.git',
    ]) {
      const { file } = tempStateFile();
      const value = stateFixture();
      rebindFixtureSource(value, { kind: 'git', locator, ref: 'main' });
      writeLifecycleState(value, { globalPreflight: 'succeeded' }, file);
      expect(readLifecycleState(file).state.scopes[0]?.source).toEqual({ kind: 'git', locator, ref: 'main' });
    }
  });

  test('projects canonical remote transports and refs through the public Source parser unchanged', () => {
    for (const locator of [
      'http://example.invalid/owner/repo.git',
      'https://example.invalid/owner/repo.git',
      'ssh://git@example.invalid/owner/repo.git',
      'git://example.invalid/owner/repo.git',
      'git@example.invalid:owner/repo.git',
    ]) {
      for (const ref of [
        'HEAD',
        'main',
        'feature/release',
        'v1.2.3',
        '0123456789abcdef0123456789abcdef01234567',
      ]) {
        const { file } = tempStateFile();
        const value = stateFixture();
        const source: SourceBinding = { kind: 'git', locator, ref };
        rebindFixtureSource(value, source);
        writeLifecycleState(value, { globalPreflight: 'succeeded' }, file);
        expect(readLifecycleState(file).state.scopes[0]?.source).toEqual(source);
        const projection = readState(file)[0]!.source;
        const expected = ref === 'HEAD' ? locator : locator + '#' + ref;
        expect(projection).toBe(expected);
        expect(normalizeSource(projection)).toBe(expected);
      }
    }
  });

  test('rejects every non-canonical Git ref before creating state', () => {
    // Fixed pre-validation IDs make these complete documents, proving rejection
    // happens at the public writer boundary rather than at an unrelated ID check.
    const cases = [
      ['feature#evil', 'scope-v1-7bc315dfb4def57ab53c4e17f0a8267c5bb0a28384965a689ad0178155f6ee1e'],
      ['-bad', 'scope-v1-eb80d444b33c5e9d165a0c2df08ff6e6e4720189d1265a7c592c167fdb6e34e2'],
      ['bad..ref', 'scope-v1-beab613c0728e7baed5fba4382f3878346de3cdd31823783e9d1eee5a1467b9c'],
      ['bad@{ref', 'scope-v1-1e0bd06a4f61439680be2506e43284e46a4da0ec3959174d99da2d42b007b3cf'],
      ['bad~ref', 'scope-v1-157dd2849012131e4b5d0be581b15b589d56a7750e4d7cd9348f2553a2be4078'],
      ['bad^ref', 'scope-v1-048c5a26d21f300b86232188e155c4ad0eb1e166d21a0a0012f87ff405605ac5'],
      ['bad:ref', 'scope-v1-1173d20651ad0625ccec93d548232445eecc3b7db080b9d22d7a5045f55cf506'],
      ['bad?ref', 'scope-v1-6817f0b17120c468d9686ffadfd6cb455958f6b060bd9bc2e0f8e7e75044505b'],
      ['bad*ref', 'scope-v1-f35036a6a988ae8d8908ea55416f4b819b0b64a8ec7421b4ac0ff9f77f7f46f1'],
      ['bad\\ref', 'scope-v1-1f44be616664e67eb5038f9f1358fc649dfe267434bfd739d7503d092d8cfe70'],
      ['bad[ref', 'scope-v1-bfabd664c265072ae10fa5a876bba6fe65d1064380f24e2381518c74c35513c5'],
      ['.bad', 'scope-v1-30d29c1fddc3cd3f17a9a4e0e4044dd52f077f4f0bea0ef50773cfb32ce8502d'],
      ['bad.', 'scope-v1-378cc1a314bc17deb089d0905afd6d8937aeafc140032b1773031b61a3dd42d9'],
      ['bad.lock', 'scope-v1-a339dc011f3d07a26efe5ce79b02df5007945d21136924f6b3ad9b6cc6470d77'],
      ['a//b', 'scope-v1-555c07b34d117e1e64b009db0c067f75f18444e4ec7b41bbac56dbbf4661736a'],
      ['/bad', 'scope-v1-cf22cb1157459dda0df1a4beccc2aa7aece8fc0fd60c039df83e4182f373d17e'],
      ['bad/', 'scope-v1-ead65ee478f9df6cbead065a585bcf8f4065db0bec89d4ddc7e8d67ef7f60d90'],
      ['a/.bad', 'scope-v1-05073466f82053ab364e305205bd81ea9b8490c3df78feb75806bfd67ce19ecd'],
      ['a/b.lock', 'scope-v1-000c255b2e4b5f0665a5cbe699377188777cdf7a84e4be3399a3e149d803a140'],
    ] as const;

    for (const [ref, id] of cases) {
      const { file } = tempStateFile();
      const value = stateFixture();
      const source: SourceBinding = { kind: 'git', locator: 'https://example.invalid/owner/repo.git', ref };
      setFixtureIdentity(value, source, fixtureTarget, id);
      expectThrow(
        () => writeLifecycleState(value, { globalPreflight: 'succeeded' }, file),
        'Invalid git ref',
      );
      expect(existsSync(file)).toBe(false);
    }
  });

  test('never persists password, query, fragment, or malformed SCP Source locators', () => {
    const locators = [
      'https://alice@example.invalid/owner/repo.git',
      'https://example.invalid/owner/repo.git?token=synthetic',
      'http://127.0.0.1:19420/owner/repo.git?token=synthetic',
      'https://example.invalid/owner/repo.git#synthetic-secret',
      'ssh://alice:secret@example.invalid/owner/repo.git',
      'ssh://git@example.invalid/owner/repo.git?token=synthetic',
      'ssh://example.invalid/owner/repo.git?token=synthetic',
      'ssh://example.invalid/owner/repo.git#synthetic-secret',
      'git://alice@example.invalid/owner/repo.git',
      'git://alice:secret@example.invalid/owner/repo.git',
      'git://127.0.0.1:19418/owner/repo.git?token=synthetic',
      'git://example.invalid/owner/repo.git?token=synthetic',
      'git://example.invalid/owner/repo.git#synthetic-secret',
      'git@example.invalid:owner/repo.git?token=synthetic',
      'git@example.invalid:owner/repo.git#synthetic-secret',
      'http://example.invalid/owner/%2Frepo.git',
      'https://example.invalid/owner/%2Frepo.git',
      'ssh://alice%3Asupersecret@example.invalid/owner/repo.git',
      'ssh://alice%0Ainjected@example.invalid/owner/repo.git',
      'ssh://git@example.invalid/owner/%C2%85repo.git',
      'ssh://alice%2Fsecret@example.invalid/owner/repo.git',
      'ssh://git@example.invalid/owner/%.git',
      'ssh://git@example.invalid/owner/%GG.git',
      'ssh://git@example.invalid/owner/%F0%9F%9A%80.git',
      'git://example.invalid/owner/%2Frepo.git',
      'git@example.invalid:owner/%2Frepo.git',
    ];

    for (const locator of locators) {
      const { file } = tempStateFile();
      const value = stateFixture();
      value.scopes[0]!.source = { kind: 'git', locator, ref: 'main' };
      expectThrow(
        () => writeLifecycleState(value, { globalPreflight: 'succeeded' }, file),
        'credential-free',
      );
      expect(existsSync(file)).toBe(false);
    }

    const { file } = tempStateFile();
    const value = stateFixture();
    value.scopes[0]!.source = { kind: 'git', locator: 'git@example.invalid:owner/\u0085repo.git', ref: 'main' };
    expectThrow(
      () => writeLifecycleState(value, { globalPreflight: 'succeeded' }, file),
      'stable value',
    );
    expect(existsSync(file)).toBe(false);
  });

  test('cannot derive or persist a Source binding from raw HTTP authority smuggling', () => {
    const rawLocator = 'https://user:synthetic@example.invalid\\@evil.invalid/owner/repo.git';
    expectThrow(() => normalizeSource(rawLocator + '#main'), 'Source locator');

    const { file } = tempStateFile();
    const value = stateFixture();
    value.scopes[0]!.source = { kind: 'git', locator: rawLocator, ref: 'main' };
    expectThrow(
      () => writeLifecycleState(value, { globalPreflight: 'succeeded' }, file),
      'credential-free canonical git locator',
    );
    expect(existsSync(file)).toBe(false);
  });

  test('never persists an unpaired UTF-16 surrogate in any scope identity field', () => {
    const replacement = '\uFFFD';
    const remote: SourceBinding = { kind: 'git', locator: 'git@example.invalid:owner/repo.git', ref: 'main' };
    const target: TargetIdentity = { kind: 'dcode', instance: 'default' };

    function expectIdentityNotWritten(
      acceptedSource: SourceBinding,
      rejectedSource: SourceBinding,
      acceptedTarget: TargetIdentity,
      rejectedTarget: TargetIdentity,
    ): void {
      const { file } = tempStateFile();
      const value = stateFixture();
      rebindFixtureIdentity(value, acceptedSource, acceptedTarget);
      value.scopes[0]!.source = rejectedSource;
      value.scopes[0]!.target = rejectedTarget;
      expectThrow(
        () => writeLifecycleState(value, { globalPreflight: 'succeeded' }, file),
        'well-formed UTF-16',
      );
      expect(existsSync(file)).toBe(false);
    }

    for (const unpaired of ['\uD800', '\uDC00']) {
      expectIdentityNotWritten(
        { kind: 'git', locator: 'git@example.invalid:owner/repo-' + replacement + '.git', ref: 'main' },
        { kind: 'git', locator: 'git@example.invalid:owner/repo-' + unpaired + '.git', ref: 'main' },
        target,
        target,
      );
      expectIdentityNotWritten(
        { ...remote, ref: 'release-' + replacement },
        { ...remote, ref: 'release-' + unpaired },
        target,
        target,
      );
      expectIdentityNotWritten(
        remote,
        remote,
        { kind: 'dcode-' + replacement, instance: 'default' },
        { kind: 'dcode-' + unpaired, instance: 'default' },
      );
      expectIdentityNotWritten(
        remote,
        remote,
        { kind: 'dcode', instance: 'work-' + replacement },
        { kind: 'dcode', instance: 'work-' + unpaired },
      );
    }
  });

  test('round-trips percent signs outside remote locators and well-formed non-BMP identity text', () => {
    const cases: Array<{ source: SourceBinding; target: TargetIdentity }> = [
      {
        source: { kind: 'local', locator: '/tmp/100%/plugin-\uD83D\uDE80' },
        target: { kind: 'dcode-\uD83D\uDE80', instance: 'work-\uD83D\uDCBB' },
      },
      {
        source: {
          kind: 'git',
          locator: 'git@example.invalid:owner/repo-\uD83D\uDE80.git',
          ref: 'release%candidate-\uD83D\uDE80',
        },
        target: { kind: 'dcode-\uD83D\uDE80', instance: 'work-\uD83D\uDCBB' },
      },
    ];

    for (const { source, target } of cases) {
      const { file } = tempStateFile();
      const value = stateFixture();
      rebindFixtureIdentity(value, source, target);
      writeLifecycleState(value, { globalPreflight: 'succeeded' }, file);
      const scope = readLifecycleState(file).state.scopes[0]!;
      expect(scope.source).toEqual(source);
      expect(scope.target).toEqual(target);
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
      }, {
        host: 'dcode',
        id: 'addy@personal',
        source: '/srv/personal',
        sourceSha: 'def456',
        installedAt: earlier,
        sourceDir: '/srv/personal/plugins/addy',
        pending: 'install',
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
    expect(loaded.state.activations[0]?.pending?.operation).toBe('remove');
    expect(loaded.state.activations[0]?.pending?.phase).toBe('applying');
    expect(loaded.state.attempts[0]?.command).toBe('legacy-recovery');
    expect(loaded.state.attempts[0]?.phase).toBe('pruning');
    expect(loaded.state.attempts[0]?.mutationStarted).toBe(true);
    expect(loaded.state.attempts[0]?.journal[0]?.action).toBe('remove');
    expect(loaded.state.attempts[0]?.journal[0]?.state).toBe('applying');
    expect(loaded.state.attempts[0]?.startedAt).toBe(earlier);
    expect(hasRetirementAuthority(loaded.state.activations[0]!)).toBe(false);
    expect(loaded.state.activations[1]?.pending?.operation).toBe('install');
    expect(loaded.state.activations[1]?.pending?.phase).toBe('applying');
    expect(loaded.state.attempts[1]?.command).toBe('legacy-recovery');
    expect(loaded.state.attempts[1]?.phase).toBe('applying');
    expect(loaded.state.attempts[1]?.mutationStarted).toBe(true);
    expect(loaded.state.attempts[1]?.journal[0]?.action).toBe('install');
    expect(loaded.state.attempts[1]?.journal[0]?.state).toBe('applying');

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

  test('rejects non-canonical Git refs while importing legacy state', () => {
    const { file } = tempStateFile();
    for (const ref of [
      'feature#evil',
      '-bad',
      'bad..ref',
      'bad@{ref',
      'bad~ref',
      'bad^ref',
      'bad:ref',
      'bad?ref',
      'bad*ref',
      'bad\\ref',
      'bad[ref',
      '.bad',
      'bad.',
      'bad.lock',
      'a//b',
      '/bad',
      'bad/',
      'a/.bad',
      'a/b.lock',
    ]) {
      writeFileSync(file, JSON.stringify({
        version: 1,
        installs: [{
          host: 'codex',
          id: 'demo@personal',
          source: 'https://example.invalid/owner/repo.git#' + ref,
          sourceSha: 'abc123',
        }],
      }));
      expectThrow(() => readLifecycleState(file), 'Invalid git ref');
    }
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
