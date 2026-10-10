import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprintTree } from '../src/fingerprint';
import { hermesCommandCompanionId, hermesPluginDataNamespace } from '../src/hermes-identity';
import { listHermesInstance } from '../src/hosts/hermes';
import { hermesLifecycle } from '../src/hosts/hermes-writer';
import type { SelectedRouteDecision } from '../src/lifecycle-host';
import {
  createFrozenPackageSnapshot,
  createLifecyclePlanCoverage,
  createRecordedOwnedActivation,
  createResolvedLifecyclePins,
} from '../src/lifecycle-runtime';
import { inventoryPackageSemantics } from '../src/semantic-inventory';
import type { PersistedTargetIdentity } from '../src/target-identity';

const PACKAGE = 'demo-plugin';
const VERSION = '1.2.0';
const REVISION = 'local-revision-1';
const PINS = createResolvedLifecyclePins([]);
const homes: string[] = [];

afterAll(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function targetFor(instance: string, root: string): PersistedTargetIdentity {
  return { kind: 'hermes', instance, context: { root, configPath: join(root, 'config.yaml') } };
}

function prepareHome(root: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'config.yaml'), [
    'model: preserved',
    'plugins:',
    '  entries:',
    `    ${PACKAGE}:`,
    '      settings:',
    '        value: keep',
    '',
  ].join('\n'));
  const dataDir = join(root, 'plugin-data', hermesPluginDataNamespace(PACKAGE));
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'state.json'), '{"kept":true}\n');
}

function freezePackage(sandbox: string, target: PersistedTargetIdentity, guide: string, input: {
  operationId: string;
  attemptId: string;
  scopeId: string;
  nativeId: string;
  action: 'install' | 'update';
}) {
  const snapshotRoot = join(sandbox, 'snapshots', input.attemptId);
  const packageRoot = join(snapshotRoot, 'packages', PACKAGE);
  mkdirSync(packageRoot, { recursive: true });
  const files: Record<string, string> = {
    'plugin.json': `${JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: PACKAGE,
      version: VERSION,
      description: 'demo',
    })}\n`,
    'skills/ordinary/SKILL.md': '---\nname: ordinary\ndescription: ordinary skill\n---\nordinary body\n',
    'commands/run.toml': 'description = "Run"\nprompt = "body $ARGUMENTS"\n',
    'references/guide.md': guide,
  };
  for (const [relative, bytes] of Object.entries(files)) {
    const path = join(packageRoot, relative);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, bytes);
  }
  const packageFingerprint = fingerprintTree(packageRoot);
  const inventoried = inventoryPackageSemantics({ dir: packageRoot, name: PACKAGE, version: VERSION });
  return createFrozenPackageSnapshot({
    operationId: input.operationId,
    attemptId: input.attemptId,
    scopeId: input.scopeId,
    target,
    action: input.action,
    packageName: PACKAGE,
    nativeId: input.nativeId,
    sourceType: 'local',
    immutableRevision: REVISION,
    snapshotRoot,
    packageRoot,
    relativePackagePath: `packages/${PACKAGE}`,
    snapshotFingerprint: fingerprintTree(snapshotRoot),
    packageFingerprint,
    inventory: { ...inventoried, package: { name: PACKAGE, version: VERSION, fingerprint: packageFingerprint } },
  });
}

function assertSelected(decision: { kind: string }): asserts decision is SelectedRouteDecision<'managed'> {
  if (decision.kind !== 'selected') throw new Error(`expected a selected Hermes route, received ${decision.kind}`);
}

async function activate(target: PersistedTargetIdentity, sandbox: string, guide: string, input: {
  operationId: string;
  attemptId: string;
  scopeId: string;
  nativeId: string;
  action: 'install' | 'update';
}) {
  const snapshot = freezePackage(sandbox, target, guide, input);
  const version = await hermesLifecycle.probeVersion(target);
  const observed = await hermesLifecycle.observeTarget(target);
  const nativeScope = await hermesLifecycle.observeNativeMutationScope({
    targetObservation: observed,
    operation: input.action,
    packageName: PACKAGE,
    nativeId: input.nativeId,
    sourceType: 'local',
  });
  const nativeProjection = await hermesLifecycle.observeNativeProjection({
    targetObservation: observed,
    operation: input.action,
    snapshot,
    pins: PINS,
  });
  const decision = hermesLifecycle.decideRoute({
    target,
    operationId: input.operationId,
    attemptId: input.attemptId,
    scopeId: input.scopeId,
    packageName: PACKAGE,
    nativeId: input.nativeId,
    version,
    sourceType: 'local',
    targetObservation: observed,
    nativeScope,
    nativeProjection,
    planCoverage: createLifecyclePlanCoverage(observed, [{
      nativeId: input.nativeId,
      operationId: input.operationId,
      operation: input.action,
      mutationGroupId: input.operationId,
      authorization: input.action === 'install' ? 'planned-create' : 'observed-owned',
    }]),
    operation: input.action,
    snapshot,
    pins: PINS,
  });
  assertSelected(decision);
  const staged = await hermesLifecycle.stageActivation({ selection: decision, snapshot, pins: PINS });
  const directed = await hermesLifecycle.applyLifecycleDirectives(staged);
  const pinned = await hermesLifecycle.applyPins(directed);
  const prepared = await hermesLifecycle.sealActivation(pinned);
  const receipt = await hermesLifecycle.apply(prepared);
  const readback = await hermesLifecycle.readback(prepared.handle);
  const verified = hermesLifecycle.verify(prepared.handle, readback);
  return { decision, nativeProjection, prepared, readback, receipt, verified };
}

describe('Hermes managed lifecycle route', () => {
  test('installs one atomic package and command companion on each home', async () => {
    const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'plgnz-hermes-route-')));
    homes.push(sandbox);
    const workRoot = join(sandbox, 'work');
    const personalRoot = join(sandbox, 'personal');
    const unusedRoot = join(sandbox, 'unused');
    prepareHome(workRoot);
    prepareHome(personalRoot);
    mkdirSync(unusedRoot, { recursive: true });
    const previous = process.env.OPEN_PLUGIN_HERMES_ROOT;
    process.env.OPEN_PLUGIN_HERMES_ROOT = unusedRoot;
    try {
      const work = targetFor('work', workRoot);
      const personal = targetFor('personal', personalRoot);
      const workInstall = await activate(work, sandbox, 'work guide\n', {
        operationId: 'op-install-work',
        attemptId: 'attempt-install-work',
        scopeId: 'scope-work',
        nativeId: 'demo-plugin@work',
        action: 'install',
      });
      const personalInstall = await activate(personal, sandbox, 'personal guide\n', {
        operationId: 'op-install-personal',
        attemptId: 'attempt-install-personal',
        scopeId: 'scope-personal',
        nativeId: 'demo-plugin@personal',
        action: 'install',
      });

      expect(workInstall.decision.route).toBe('managed');
      expect(workInstall.nativeProjection.kind).toBe('requires-managed');
      expect(workInstall.nativeProjection.kind === 'requires-managed' ? workInstall.nativeProjection.reasonId : undefined).toBe('pinned-sha');
      expect(personalInstall.decision.route).toBe('managed');
      expect(workInstall.receipt.changed).toBe(true);
      expect(personalInstall.receipt.changed).toBe(true);
      expect(existsSync(join(unusedRoot, 'plugins'))).toBe(false);

      for (const [root, guide, nativeId] of [
        [workRoot, 'work guide\n', 'demo-plugin@work'],
        [personalRoot, 'personal guide\n', 'demo-plugin@personal'],
      ] as const) {
        const packageDir = join(root, 'plugins', PACKAGE);
        const companionDir = join(root, 'plugins', hermesCommandCompanionId(PACKAGE));
        expect(readFileSync(join(packageDir, 'references/guide.md'), 'utf8')).toBe(guide);
        expect(readFileSync(join(companionDir, 'plugin.yaml'), 'utf8')).toContain(`name: ${hermesCommandCompanionId(PACKAGE)}`);
        expect(readFileSync(join(companionDir, '__init__.py'), 'utf8')).toContain('ctx.register_command');
        expect(JSON.parse(readFileSync(join(packageDir, '.plgnz-install.json'), 'utf8')).pluginId).toBe(nativeId);
        expect(JSON.parse(readFileSync(join(companionDir, '.plgnz-install.json'), 'utf8')).pluginId).toBe(nativeId);
        const config = readFileSync(join(root, 'config.yaml'), 'utf8');
        expect(config).toContain('model: preserved');
        expect(config).toContain('value: keep');
        expect(readFileSync(join(root, 'plugin-data', hermesPluginDataNamespace(PACKAGE), 'state.json'), 'utf8')).toBe('{"kept":true}\n');
        const installed = listHermesInstance(root, join(root, 'config.yaml'));
        expect(installed.map(plugin => ({ id: plugin.id, enabled: plugin.enabled, contentRoots: plugin.contentRoots }))).toEqual([{
          id: nativeId,
          enabled: true,
          contentRoots: { package: packageDir, commands: companionDir },
        }]);
      }
      await hermesLifecycle.cleanup(workInstall.prepared.handle, 'verified-commit');
      await hermesLifecycle.cleanup(personalInstall.prepared.handle, 'verified-commit');
    } finally {
      if (previous === undefined) delete process.env.OPEN_PLUGIN_HERMES_ROOT;
      else process.env.OPEN_PLUGIN_HERMES_ROOT = previous;
    }
  });

  test('rolls an update back and then retires both companions without deleting plugin-created data', async () => {
    const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'plgnz-hermes-retire-')));
    homes.push(sandbox);
    const root = join(sandbox, 'work');
    prepareHome(root);
    const target = targetFor('work', root);
    const packageDir = join(root, 'plugins', PACKAGE);
    const companionDir = join(root, 'plugins', hermesCommandCompanionId(PACKAGE));
    const dataFile = join(root, 'plugin-data', hermesPluginDataNamespace(PACKAGE), 'state.json');
    const installed = await activate(target, sandbox, 'version one\n', {
      operationId: 'op-install-work',
      attemptId: 'attempt-install-work',
      scopeId: 'scope-work',
      nativeId: 'demo-plugin@work',
      action: 'install',
    });
    await hermesLifecycle.cleanup(installed.prepared.handle, 'verified-commit');

    const updated = await activate(target, sandbox, 'version two\n', {
      operationId: 'op-update-work',
      attemptId: 'attempt-update-work',
      scopeId: 'scope-work',
      nativeId: 'demo-plugin@work',
      action: 'update',
    });
    expect(updated.receipt.changed).toBe(true);
    expect(readFileSync(join(packageDir, 'references/guide.md'), 'utf8')).toBe('version two\n');
    expect(readFileSync(dataFile, 'utf8')).toBe('{"kept":true}\n');
    expect(existsSync(companionDir)).toBe(true);

    await hermesLifecycle.rollback(updated.prepared.handle);
    const rolled = await hermesLifecycle.readback(updated.prepared.handle);
    expect(hermesLifecycle.verifyRollback(updated.prepared.handle, rolled).phase).toBe('rollback-verified');
    expect(readFileSync(join(packageDir, 'references/guide.md'), 'utf8')).toBe('version one\n');
    expect(readFileSync(join(companionDir, '__init__.py'), 'utf8')).toContain('ctx.register_command');
    expect(readFileSync(dataFile, 'utf8')).toBe('{"kept":true}\n');
    await hermesLifecycle.cleanup(updated.prepared.handle, 'verified-rollback');

    const repeated = await activate(target, sandbox, 'version one\n', {
      operationId: 'op-update-same',
      attemptId: 'attempt-update-same',
      scopeId: 'scope-work',
      nativeId: 'demo-plugin@work',
      action: 'update',
    });
    expect(repeated.receipt.changed).toBe(false);
    await hermesLifecycle.cleanup(repeated.prepared.handle, 'verified-commit');

    const version = await hermesLifecycle.probeVersion(target);
    const observed = await hermesLifecycle.observeTarget(target);
    const current = await hermesLifecycle.readback(repeated.prepared.handle);
    if (current.installedFingerprint === null) throw new Error('installed Hermes package has no fingerprint');
    const activation = createRecordedOwnedActivation({
      scopeId: 'scope-work',
      target,
      packageName: PACKAGE,
      nativeId: 'demo-plugin@work',
      sourceType: 'local',
      sourceRevision: REVISION,
      sourceLocator: null,
      installedVersion: VERSION,
      route: 'managed',
      evidenceId: installed.decision.evidenceId,
      ownership: { kind: 'created', proofId: 'hermes:demo-plugin@work' },
      activation: 'active',
      enablement: 'enabled',
      installedFingerprint: current.installedFingerprint,
      contentRoots: current.contentRoots,
    });
    const nativeScope = await hermesLifecycle.observeNativeMutationScope({
      targetObservation: observed,
      operation: 'retire',
      packageName: PACKAGE,
      nativeId: 'demo-plugin@work',
      sourceType: 'local',
    });
    const nativeProjection = await hermesLifecycle.observeNativeProjection({
      targetObservation: observed,
      operation: 'retire',
      operationId: 'op-retire-work',
      attemptId: 'attempt-retire-work',
      activation,
    });
    const decision = hermesLifecycle.decideRoute({
      target,
      operationId: 'op-retire-work',
      attemptId: 'attempt-retire-work',
      scopeId: 'scope-work',
      packageName: PACKAGE,
      nativeId: 'demo-plugin@work',
      version,
      sourceType: 'local',
      targetObservation: observed,
      nativeScope,
      nativeProjection,
      planCoverage: createLifecyclePlanCoverage(observed, [{
        nativeId: 'demo-plugin@work',
        operationId: 'op-retire-work',
        operation: 'retire',
        mutationGroupId: 'op-retire-work',
        authorization: 'observed-owned',
      }]),
      operation: 'retire',
      activation,
    });
    assertSelected(decision);
    expect(decision.route).toBe('managed');
    const prepared = await hermesLifecycle.prepareRetirement({
      operationId: 'op-retire-work',
      attemptId: 'attempt-retire-work',
      action: 'remove',
      selection: decision,
      activation,
    });
    const receipt = await hermesLifecycle.retire(prepared);
    const readback = await hermesLifecycle.readback(prepared.handle);
    expect(hermesLifecycle.verify(prepared.handle, readback).phase).toBe('verified');
    expect(receipt.changed).toBe(true);
    expect(existsSync(packageDir)).toBe(false);
    expect(existsSync(companionDir)).toBe(false);
    expect(readFileSync(dataFile, 'utf8')).toBe('{"kept":true}\n');
    const config = readFileSync(join(root, 'config.yaml'), 'utf8');
    expect(config).toContain('value: keep');
    expect(config).toContain('model: preserved');
    expect(readback.presence).toBe('absent');
    expect(readback.enablement).toBe('disabled');
    expect(readback.route).toBe('managed');
    await hermesLifecycle.cleanup(prepared.handle, 'verified-commit');
  });
});
