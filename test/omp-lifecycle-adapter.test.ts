import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fingerprintTree } from '../src/fingerprint';
import { ompLifecycle } from '../src/hosts/omp-writer';
import type { FrozenPackageSnapshot, NativeMutationScopeObservation, NativeProjectionObservation, PreparedActivationMutation, RecordedOwnedActivation } from '../src/lifecycle-host';
import {
  LifecycleHostPhaseError,
  createFrozenPackageSnapshot,
  createLifecyclePlanCoverage,
  createRecordedOwnedActivation,
  createResolvedLifecyclePins,
} from '../src/lifecycle-runtime';
import type { PackageSemanticInventory } from '../src/semantic-inventory';
import { emptyInventory } from './lifecycle-fixtures';
import { writeFiles } from './util';

const target = { kind: 'omp', instance: 'default' } as const;
const packageName = 'demo-plugin';
const nativeId = 'demo-plugin@personal';
const scopeId = 'scope-demo-plugin';
const managedGap = 'frozen-catalog-binding+synchronous-readback+rollback+operation-specific-retirement';

type PackageAction = 'install' | 'update';

function snapshot<Action extends PackageAction>(root: string, input: {
  action: Action;
  operationId: string;
  attemptId: string;
  version: string;
  revision: string;
  resource: string;
}): FrozenPackageSnapshot & { readonly action: Action } {
  const snapshotRoot = resolve(join(root, `snapshot-${input.attemptId}`));
  const packageRoot = resolve(join(snapshotRoot, 'packages', packageName));
  writeFiles(packageRoot, {
    'plugin.json': `${JSON.stringify({ name: packageName, version: input.version })}\n`,
    'skills/ordinary/SKILL.md': '---\nname: ordinary\ndescription: ordinary skill\n---\nordinary body\n',
    'resources/value.txt': input.resource,
  });
  const packageFingerprint = fingerprintTree(packageRoot);
  const inventory: PackageSemanticInventory = {
    ...emptyInventory,
    package: { name: packageName, version: input.version, fingerprint: packageFingerprint },
    requiredSemantics: ['ordinary-skills'],
  };
  return createFrozenPackageSnapshot({
    operationId: input.operationId,
    attemptId: input.attemptId,
    scopeId,
    target,
    action: input.action,
    packageName,
    nativeId,
    sourceType: 'local',
    immutableRevision: input.revision,
    snapshotRoot,
    packageRoot,
    relativePackagePath: relative(snapshotRoot, packageRoot),
    snapshotFingerprint: fingerprintTree(snapshotRoot),
    packageFingerprint,
    inventory,
  }) as FrozenPackageSnapshot & { readonly action: Action };
}

function assertManagedCandidate(scope: NativeMutationScopeObservation, projection: NativeProjectionObservation): void {
  expect(scope.kind).toBe('unavailable');
  expect(projection.kind).toBe('requires-managed');
  if (projection.kind === 'requires-managed') expect(projection.reasonId).toBe(managedGap);
}

async function sealInstall(root: string, input: {
  operationId: string;
  attemptId: string;
  version: string;
  revision: string;
  resource: string;
  authorization: 'planned-create' | 'observed-owned';
}) {
  const shot = snapshot(root, { ...input, action: 'install' as const });
  const pins = createResolvedLifecyclePins([]);
  const version = await ompLifecycle.probeVersion(target);
  const observed = await ompLifecycle.observeTarget(target);
  const nativeScope = await ompLifecycle.observeNativeMutationScope({
    targetObservation: observed, operation: 'install', packageName, nativeId, sourceType: 'local',
  });
  const nativeProjection = await ompLifecycle.observeNativeProjection({
    targetObservation: observed, operation: 'install', snapshot: shot, pins,
  });
  assertManagedCandidate(nativeScope, nativeProjection);
  const decision = ompLifecycle.decideRoute({
    target, operation: 'install', operationId: shot.operationId, attemptId: shot.attemptId, scopeId,
    packageName, nativeId, version, sourceType: 'local', targetObservation: observed, nativeScope,
    nativeProjection, snapshot: shot, pins,
    planCoverage: createLifecyclePlanCoverage(observed, [{
      nativeId, operationId: shot.operationId, operation: 'install', mutationGroupId: `group:${shot.operationId}`,
      authorization: input.authorization,
    }]),
  });
  if (decision.kind !== 'selected' || decision.route !== 'managed') throw new Error(`OMP install route was not managed: ${JSON.stringify(decision)}`);
  expect(decision.affectedNativeIds).toEqual([nativeId]);
  const staged = await ompLifecycle.stageActivation({ selection: decision, snapshot: shot, pins });
  const directed = await ompLifecycle.applyLifecycleDirectives(staged);
  return ompLifecycle.sealActivation(await ompLifecycle.applyPins(directed));
}

async function sealUpdate(root: string, input: {
  operationId: string;
  attemptId: string;
  version: string;
  revision: string;
  resource: string;
}) {
  const shot = snapshot(root, { ...input, action: 'update' as const });
  const pins = createResolvedLifecyclePins([]);
  const version = await ompLifecycle.probeVersion(target);
  const observed = await ompLifecycle.observeTarget(target);
  const nativeScope = await ompLifecycle.observeNativeMutationScope({
    targetObservation: observed, operation: 'update', packageName, nativeId, sourceType: 'local',
  });
  const nativeProjection = await ompLifecycle.observeNativeProjection({
    targetObservation: observed, operation: 'update', snapshot: shot, pins,
  });
  assertManagedCandidate(nativeScope, nativeProjection);
  const decision = ompLifecycle.decideRoute({
    target, operation: 'update', operationId: shot.operationId, attemptId: shot.attemptId, scopeId,
    packageName, nativeId, version, sourceType: 'local', targetObservation: observed, nativeScope,
    nativeProjection, snapshot: shot, pins,
    planCoverage: createLifecyclePlanCoverage(observed, [{
      nativeId, operationId: shot.operationId, operation: 'update', mutationGroupId: `group:${shot.operationId}`,
      authorization: 'observed-owned',
    }]),
  });
  if (decision.kind !== 'selected' || decision.route !== 'managed') throw new Error(`OMP update route was not managed: ${JSON.stringify(decision)}`);
  const staged = await ompLifecycle.stageActivation({ selection: decision, snapshot: shot, pins });
  const directed = await ompLifecycle.applyLifecycleDirectives(staged);
  return ompLifecycle.sealActivation(await ompLifecycle.applyPins(directed));
}

async function commitPrepared(prepared: PreparedActivationMutation): Promise<boolean> {
  const receipt = await ompLifecycle.apply(prepared);
  const observation = await ompLifecycle.readback(prepared.handle);
  ompLifecycle.verify(prepared.handle, observation);
  return receipt.changed;
}

async function packagePath(): Promise<string> {
  const observed = await ompLifecycle.observeTarget(target);
  const installed = observed.installations.find((item) => item.nativeId === nativeId);
  const path = installed?.contentRoots[0]?.path;
  if (path === undefined) throw new Error('OMP package path is missing');
  return path;
}

async function recordedActivation(input: {
  activation: 'active' | 'inactive' | 'nonconforming';
  enablement: 'enabled' | 'disabled';
}): Promise<RecordedOwnedActivation> {
  const observed = await ompLifecycle.observeTarget(target);
  const installed = observed.installations.find((item) => item.nativeId === nativeId);
  if (installed === undefined || installed.source === null || installed.installedFingerprint === null || installed.ownership.kind !== 'owned') {
    throw new Error('OMP installation is not an owned activation');
  }
  return createRecordedOwnedActivation({
    scopeId: installed.ownership.scopeId,
    target,
    packageName,
    nativeId,
    sourceType: installed.source.type,
    sourceRevision: installed.source.immutableRevision,
    sourceLocator: installed.source.locator,
    installedVersion: installed.installedVersion,
    route: 'managed',
    evidenceId: 'recorded-omp-activation',
    ownership: { kind: 'created', proofId: installed.ownership.proofId },
    activation: input.activation,
    enablement: input.enablement,
    installedFingerprint: installed.installedFingerprint,
    contentRoots: installed.contentRoots,
  });
}

async function sealRecorded(operation: 'disable' | 'retire', operationId: string, attemptId: string, activation: RecordedOwnedActivation) {
  const version = await ompLifecycle.probeVersion(target);
  const observed = await ompLifecycle.observeTarget(target);
  const nativeScope = await ompLifecycle.observeNativeMutationScope({
    targetObservation: observed, operation, packageName, nativeId, sourceType: activation.sourceType,
  });
  const nativeProjection = await ompLifecycle.observeNativeProjection({
    targetObservation: observed, operation, operationId, attemptId, activation,
  });
  assertManagedCandidate(nativeScope, nativeProjection);
  const common = {
    target, operationId, attemptId, scopeId, packageName, nativeId, version, sourceType: activation.sourceType,
    targetObservation: observed, nativeScope, nativeProjection, activation,
    planCoverage: createLifecyclePlanCoverage(observed, [{
      nativeId, operationId, operation, mutationGroupId: `group:${operationId}`, authorization: 'observed-owned' as const,
    }]),
  };
  const decision = operation === 'disable'
    ? ompLifecycle.decideRoute({ ...common, operation: 'disable' })
    : ompLifecycle.decideRoute({ ...common, operation: 'retire' });
  if (decision.kind !== 'selected' || decision.route !== 'managed') throw new Error(`OMP ${operation} route was not managed: ${JSON.stringify(decision)}`);
  if (decision.operation === 'disable') return ompLifecycle.prepareDisable({ operationId, attemptId, selection: decision, activation });
  return ompLifecycle.prepareRetirement({ operationId, attemptId, action: 'remove', selection: decision, activation });
}

function lockFile(root: string): string {
  return join(root, '.omp/plugins/omp-plugins.lock.json');
}

function writeLockMetadata(root: string, npm: string, enabled: boolean): void {
  const file = lockFile(root);
  const lock = JSON.parse(readFileSync(file, 'utf8')) as { plugins: Record<string, Record<string, unknown>>; settings: unknown };
  lock.plugins[npm] = { ...lock.plugins[npm], enabled, enabledFeatures: ['skills'], settings: { theme: 'quiet' } };
  lock.settings = { telemetry: false };
  writeFileSync(file, JSON.stringify(lock, null, 2));
}

async function isolated(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'plgnz-omp-adapter-'));
  const previousRoot = process.env['OPEN_PLUGIN_OMP_ROOT'];
  const previousBin = process.env['OPEN_PLUGIN_OMP_BIN'];
  const previousFailure = process.env['OPEN_PLUGIN_TEST_OMP_ACTIVATION_FAILURE'];
  process.env['OPEN_PLUGIN_OMP_ROOT'] = join(root, '.omp');
  const binary = join(root, 'omp');
  writeFileSync(binary, '#!/bin/sh\nprintf "18.1.4\\n"\n');
  chmodSync(binary, 0o755);
  process.env['OPEN_PLUGIN_OMP_BIN'] = binary;
  try {
    await run(root);
  } finally {
    if (previousRoot === undefined) delete process.env['OPEN_PLUGIN_OMP_ROOT'];
    else process.env['OPEN_PLUGIN_OMP_ROOT'] = previousRoot;
    if (previousBin === undefined) delete process.env['OPEN_PLUGIN_OMP_BIN'];
    else process.env['OPEN_PLUGIN_OMP_BIN'] = previousBin;
    if (previousFailure === undefined) delete process.env['OPEN_PLUGIN_TEST_OMP_ACTIVATION_FAILURE'];
    else process.env['OPEN_PLUGIN_TEST_OMP_ACTIVATION_FAILURE'] = previousFailure;
    rmSync(root, { recursive: true, force: true });
  }
}

describe('OMP managed extension-package lifecycle', () => {
  test('installs through the managed route and leaves a repeated install unchanged', async () => isolated(async (root) => {
    expect(await ompLifecycle.probeVersion(target)).toEqual({ kind: 'detected', version: '18.1.4', probeId: 'omp:18.1.4' });
    const prepared = await sealInstall(root, {
      operationId: 'install-demo', attemptId: 'attempt-install', version: '1.2.0', revision: 'local-install', resource: 'one\n',
      authorization: 'planned-create',
    });
    expect(await commitPrepared(prepared)).toBe(true);
    const installed = await packagePath();
    expect(readFileSync(join(installed, 'skills/ordinary/SKILL.md'), 'utf8')).toContain('ordinary body');
    expect(readFileSync(join(installed, 'resources/value.txt'), 'utf8')).toBe('one\n');
    const repeated = await sealInstall(root, {
      operationId: 'install-again', attemptId: 'attempt-install-again', version: '1.2.0', revision: 'local-install', resource: 'one\n',
      authorization: 'observed-owned',
    });
    expect(await commitPrepared(repeated)).toBe(false);
    expect(readFileSync(join(installed, 'resources/value.txt'), 'utf8')).toBe('one\n');
  }));

  test('update keeps features and settings, then rollback restores the prior package and lock', async () => isolated(async (root) => {
    expect(await commitPrepared(await sealInstall(root, {
      operationId: 'install-update', attemptId: 'attempt-install-update', version: '1.2.0', revision: 'local-install', resource: 'one\n',
      authorization: 'planned-create',
    }))).toBe(true);
    const installed = await packagePath();
    const npm = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).name as string;
    writeLockMetadata(root, npm, false);
    const before = readFileSync(lockFile(root), 'utf8');
    const prepared = await sealUpdate(root, {
      operationId: 'update-demo', attemptId: 'attempt-update', version: '1.3.0', revision: 'local-update', resource: 'two\n',
    });
    expect(await commitPrepared(prepared)).toBe(true);
    const updated = JSON.parse(readFileSync(lockFile(root), 'utf8')) as {
      plugins: Record<string, { version: string; enabled: boolean; enabledFeatures: string[]; settings: { theme: string } }>;
      settings: { telemetry: boolean };
    };
    expect(updated.plugins[npm]?.version).toBe('1.3.0');
    expect(updated.plugins[npm]?.enabled).toBe(true);
    expect(updated.plugins[npm]?.enabledFeatures).toEqual(['skills']);
    expect(updated.plugins[npm]?.settings).toEqual({ theme: 'quiet' });
    expect(updated.settings).toEqual({ telemetry: false });
    expect(readFileSync(join(await packagePath(), 'resources/value.txt'), 'utf8')).toBe('two\n');
    const rolled = await ompLifecycle.rollback(prepared.handle);
    expect(rolled.changed).toBe(true);
    const restored = await ompLifecycle.readback(prepared.handle);
    ompLifecycle.verifyRollback(prepared.handle, restored);
    expect(readFileSync(join(installed, 'resources/value.txt'), 'utf8')).toBe('one\n');
    expect(readFileSync(lockFile(root), 'utf8')).toBe(before);
  }));

  test('a forced activation failure restores the previous package', async () => isolated(async (root) => {
    expect(await commitPrepared(await sealInstall(root, {
      operationId: 'install-fail', attemptId: 'attempt-install-fail', version: '1.2.0', revision: 'local-install', resource: 'one\n',
      authorization: 'planned-create',
    }))).toBe(true);
    const installed = await packagePath();
    const link = join(root, '.omp/plugins/node_modules', JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).name as string);
    const prepared = await sealUpdate(root, {
      operationId: 'update-fail', attemptId: 'attempt-update-fail', version: '1.3.0', revision: 'local-fail', resource: 'two\n',
    });
    process.env['OPEN_PLUGIN_TEST_OMP_ACTIVATION_FAILURE'] = 'after-old-move';
    let error: unknown;
    try {
      await ompLifecycle.apply(prepared);
    } catch (caught) {
      error = caught;
    } finally {
      delete process.env['OPEN_PLUGIN_TEST_OMP_ACTIVATION_FAILURE'];
    }
    if (!(error instanceof LifecycleHostPhaseError)) throw new Error('expected an OMP activation phase error');
    expect(error.phase).toBe('apply');
    expect(error.message).toContain('forced OMP activation failure');
    expect(readFileSync(join(installed, 'resources/value.txt'), 'utf8')).toBe('one\n');
    expect(resolve(dirname(link), readlinkSync(link))).toBe(resolve(installed));
  }));

  test('disable keeps features and settings, and a second disable is unchanged', async () => isolated(async (root) => {
    expect(await commitPrepared(await sealInstall(root, {
      operationId: 'install-disable', attemptId: 'attempt-install-disable', version: '1.2.0', revision: 'local-disable', resource: 'one\n',
      authorization: 'planned-create',
    }))).toBe(true);
    const installed = await packagePath();
    const npm = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).name as string;
    writeLockMetadata(root, npm, true);
    const first = await sealRecorded('disable', 'disable-demo', 'attempt-disable', await recordedActivation({ activation: 'nonconforming', enablement: 'enabled' }));
    if (!('handle' in first) || first.kind !== 'disable') throw new Error('expected a prepared disable');
    const disabled = await ompLifecycle.disable(first);
    expect(disabled.changed).toBe(true);
    ompLifecycle.verify(first.handle, await ompLifecycle.readback(first.handle));
    const after = JSON.parse(readFileSync(lockFile(root), 'utf8')) as {
      plugins: Record<string, { enabled: boolean; enabledFeatures: string[]; settings: { theme: string } }>;
      settings: { telemetry: boolean };
    };
    expect(after.plugins[npm]?.enabled).toBe(false);
    expect(after.plugins[npm]?.enabledFeatures).toEqual(['skills']);
    expect(after.plugins[npm]?.settings).toEqual({ theme: 'quiet' });
    expect(after.settings).toEqual({ telemetry: false });
    expect(readFileSync(join(installed, 'resources/value.txt'), 'utf8')).toBe('one\n');
    const second = await sealRecorded('disable', 'disable-again', 'attempt-disable-again', await recordedActivation({ activation: 'nonconforming', enablement: 'enabled' }));
    if (!('handle' in second) || second.kind !== 'disable') throw new Error('expected a prepared disable');
    const repeated = await ompLifecycle.disable(second);
    expect(repeated.changed).toBe(false);
    ompLifecycle.verify(second.handle, await ompLifecycle.readback(second.handle));
    expect(JSON.parse(readFileSync(lockFile(root), 'utf8'))).toEqual(after);
  }));

  test('retire keeps disabled, features, settings, and plugin data', async () => isolated(async (root) => {
    expect(await commitPrepared(await sealInstall(root, {
      operationId: 'install-retire', attemptId: 'attempt-install-retire', version: '1.2.0', revision: 'local-retire', resource: 'one\n',
      authorization: 'planned-create',
    }))).toBe(true);
    const installed = await packagePath();
    const npm = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).name as string;
    writeLockMetadata(root, npm, false);
    writeFiles(join(root, '.omp/plugins/data', npm), { 'keep.txt': 'keep\n' });
    const before = readFileSync(lockFile(root), 'utf8');
    const prepared = await sealRecorded('retire', 'retire-demo', 'attempt-retire', await recordedActivation({ activation: 'inactive', enablement: 'disabled' }));
    if (!('handle' in prepared) || prepared.kind !== 'retirement') throw new Error('expected a prepared retirement');
    const retired = await ompLifecycle.retire(prepared);
    expect(retired.changed).toBe(true);
    ompLifecycle.verify(prepared.handle, await ompLifecycle.readback(prepared.handle));
    expect(existsSync(installed)).toBe(false);
    expect(existsSync(join(root, '.omp/plugins/node_modules', npm))).toBe(false);
    expect(readFileSync(lockFile(root), 'utf8')).toBe(before);
    expect(readFileSync(join(root, '.omp/plugins/data', npm, 'keep.txt'), 'utf8')).toBe('keep\n');
    let error: unknown;
    try {
      await ompLifecycle.retire(prepared);
    } catch (caught) {
      error = caught;
    }
    if (!(error instanceof LifecycleHostPhaseError)) throw new Error('expected an OMP retirement precondition error');
    expect(error.phase).toBe('apply-precondition');
    expect(error.message).toContain('inventory identity changed');
    expect(readFileSync(lockFile(root), 'utf8')).toBe(before);
    expect(readFileSync(join(root, '.omp/plugins/data', npm, 'keep.txt'), 'utf8')).toBe('keep\n');
  }));
});
