import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fingerprintTree } from '../src/fingerprint';
import type { LifecycleReadbackObservation, SelectedLifecycleRoute, SelectedRouteDecision } from '../src/lifecycle-host';
import {
  createFrozenPackageSnapshot,
  createLifecyclePlanCoverage,
  createRecordedOwnedActivation,
  createResolvedLifecyclePins,
} from '../src/lifecycle-runtime';
import { inventoryPackageSemantics } from '../src/semantic-inventory';
import type { PluginSource } from '../src/source';
import { cursorManagedLifecycle } from '../src/hosts/cursor-writer';
import { writeFiles } from './util';

const target = { kind: 'cursor', instance: 'default' } as const;
const packageName = 'demo-plugin';
const nativeId = 'demo-plugin';
const scopeId = 'scope-demo-plugin';
const revision = 'local-demo-plugin-1';
const installOperationId = 'install-demo-plugin';
const installAttemptId = 'attempt-install-demo';
const retireOperationId = 'retire-demo-plugin';
const retireAttemptId = 'attempt-retire-demo';

const manualSkill = '---\nname: manual\ndescription: manual skill\ndisable-model-invocation: true\n---\nmanual body\n';
const launchSkill = '---\nname: "launch"\ndescription: "launch"\n---\nbody\n';
const userMcp = '{"mcpServers":{"user":{"url":"https://keep.example"}}}\n';
const pluginData = 'plugin-data\n';
const inactiveMetadata = 'inactive-metadata\n';
const cursorManifest = '{"name":"demo-plugin","version":"1.2.0","native":"keep"}\n';

describe('cursor managed local projection', () => {
  test('prepares, applies, reads back, and retires the local store while marketplace refresh stays unverified', async () => {
    const root = mkdtempSync(join(tmpdir(), 'plgnz-cursor-managed-'));
    const cursorRoot = join(root, '.cursor');
    const pluginDir = join(cursorRoot, 'plugins', 'local', nativeId);
    const dataDir = join(cursorRoot, 'plugins', 'retained', nativeId, 'data');
    const metadataDir = join(cursorRoot, 'plugins', 'retained', nativeId, 'metadata');
    const pinExecutable = resolve(root, 'bin', 'demo-tool');
    const previousRoot = process.env['OPEN_PLUGIN_CURSOR_ROOT'];
    const previousBin = process.env['OPEN_PLUGIN_CURSOR_BIN'];
    process.env['OPEN_PLUGIN_CURSOR_ROOT'] = cursorRoot;
    process.env['OPEN_PLUGIN_CURSOR_BIN'] = join(root, 'cursor-bin');
    try {
      writeFileSync(process.env['OPEN_PLUGIN_CURSOR_BIN'], '#!/bin/sh\necho "Cursor 2.4.0"\n');
      chmodSync(process.env['OPEN_PLUGIN_CURSOR_BIN'], 0o755);
      writeFiles(cursorRoot, { 'mcp.json': userMcp });
      writeFiles(dataDir, { 'note.txt': pluginData });
      writeFiles(metadataDir, { 'note.txt': inactiveMetadata });
      writeFiles(join(root, 'bin'), { 'demo-tool': '#!/bin/sh\n' });
      chmodSync(pinExecutable, 0o755);

      const snapshotRoot = join(root, 'snapshot');
      const packageRoot = join(snapshotRoot, 'plugins', packageName);
      writeFiles(packageRoot, {
        'plugin.json': '{"name":"demo-plugin","version":"1.2.0"}\n',
        '.cursor-plugin/plugin.json': cursorManifest,
        'skills/manual/SKILL.md': manualSkill,
        'commands/launch.md': '---\ndescription: launch\n---\nbody\n',
        'resources/value.txt': 'one\n',
        '.mcp.json': '{"mcpServers":{"demo":{"command":"demo-tool","args":[]}}}\n',
      });
      const packageFingerprint = fingerprintTree(packageRoot);
      const plugin: PluginSource = {
        dir: packageRoot,
        name: packageName,
        version: '1.2.0',
        contentFingerprint: packageFingerprint,
      };
      const inventory = inventoryPackageSemantics(plugin);
      const snapshot = createFrozenPackageSnapshot({
        operationId: installOperationId,
        attemptId: installAttemptId,
        scopeId,
        target,
        action: 'install',
        packageName,
        nativeId,
        sourceType: 'local',
        immutableRevision: revision,
        snapshotRoot,
        packageRoot,
        relativePackagePath: 'plugins/demo-plugin',
        snapshotFingerprint: fingerprintTree(snapshotRoot),
        packageFingerprint,
        inventory,
      });
      const pins = createResolvedLifecyclePins([{ server: 'demo', executable: pinExecutable }]);

      const version = await cursorManagedLifecycle.probeVersion(target);
      expect(version).toEqual({ kind: 'detected', version: '2.4.0', probeId: 'cursor-2.4.0' });
      const observed = await cursorManagedLifecycle.observeTarget(target);
      expect(observed.installations).toEqual([]);
      const nativeScope = await cursorManagedLifecycle.observeNativeMutationScope({
        targetObservation: observed,
        operation: 'install',
        packageName,
        nativeId,
        sourceType: 'local',
      });
      expect(nativeScope.kind).toBe('unavailable');
      const nativeProjection = await cursorManagedLifecycle.observeNativeProjection({
        targetObservation: observed,
        operation: 'install',
        snapshot,
        pins,
      });
      expect(nativeProjection.kind).toBe('unverified');
      if (nativeProjection.kind !== 'unverified') throw new Error('marketplace refresh was treated as a proven native projection');
      expect(nativeProjection.reasonId).toBe('cursor-marketplace-refresh');

      const decision = cursorManagedLifecycle.decideRoute({
        target,
        operation: 'install',
        operationId: installOperationId,
        attemptId: installAttemptId,
        scopeId,
        packageName,
        nativeId,
        version,
        sourceType: 'local',
        targetObservation: observed,
        nativeScope,
        nativeProjection,
        planCoverage: createLifecyclePlanCoverage(observed, [{
          nativeId,
          operationId: installOperationId,
          operation: 'install',
          mutationGroupId: 'group-install-demo-plugin',
          authorization: 'planned-create',
        }]),
        snapshot,
        pins,
      });
      if (decision.kind !== 'selected' || decision.route !== 'managed') {
        throw new Error(decision.kind === 'capability-gap' ? decision.gaps.map((gap) => gap.diagnostic).join('\n') : 'install route was not managed');
      }
      expect(decision.route).toBe('managed');

      const staged = await cursorManagedLifecycle.stageActivation({ selection: decision, snapshot, pins });
      const directed = await cursorManagedLifecycle.applyLifecycleDirectives(staged);
      const pinned = await cursorManagedLifecycle.applyPins(directed);
      const prepared = await cursorManagedLifecycle.sealActivation(pinned);
      expect(existsSync(pluginDir)).toBe(false);
      expect(readFileSync(join(cursorRoot, 'mcp.json'), 'utf8')).toBe(userMcp);
      expect(readFileSync(join(dataDir, 'note.txt'), 'utf8')).toBe(pluginData);

      const receipt = await cursorManagedLifecycle.apply(prepared);
      expect(receipt.changed).toBe(true);
      expect(readFileSync(join(pluginDir, 'skills', 'manual', 'SKILL.md'), 'utf8')).toBe(manualSkill);
      expect(readFileSync(join(pluginDir, 'skills', 'launch', 'SKILL.md'), 'utf8')).toBe(launchSkill);
      expect(existsSync(join(pluginDir, 'commands'))).toBe(false);
      expect(readFileSync(join(pluginDir, '.cursor-plugin', 'plugin.json'), 'utf8')).toBe(cursorManifest);
      expect(readFileSync(join(pluginDir, 'resources', 'value.txt'), 'utf8')).toBe('one\n');
      expect(JSON.parse(readFileSync(join(pluginDir, '.mcp.json'), 'utf8')).mcpServers.demo.command).toBe(pinExecutable);
      expect(readFileSync(join(cursorRoot, 'mcp.json'), 'utf8')).toBe(userMcp);

      const installedObservation = await cursorManagedLifecycle.readback(receipt.handle);
      const verified = cursorManagedLifecycle.verify(receipt.handle, installedObservation);
      expect(verified.phase).toBe('verified');
      expect(installedObservation.presence).toBe('present');
      expect(installedObservation.enablement).toBe('enabled');
      expect(installedObservation.activation).toBe('active');
      expect(installedObservation.route).toBe('managed');
      expect(installedObservation.installedFingerprint).toBe(fingerprintTree(pluginDir));
      expect(installedObservation.contentRoots).toEqual([{
        label: 'local',
        path: resolve(pluginDir),
        fingerprint: fingerprintTree(pluginDir),
      }]);
      expect(installedObservation.retention).toEqual({
        pluginData: { state: 'present', fingerprint: fingerprintTree(dataDir) },
        inactiveMetadata: { state: 'present', fingerprint: fingerprintTree(metadataDir) },
      });

      const inventoryAfter = await cursorManagedLifecycle.observeTarget(target);
      expect(inventoryAfter.installations).toEqual([{
        nativeId,
        packageName,
        ownership: { kind: 'owned', proof: 'created', scopeId, proofId: `cursor-${nativeId}-${scopeId}` },
        presence: 'present',
        enablement: 'enabled',
        activation: 'active',
        installedFingerprint: fingerprintTree(pluginDir),
        installedVersion: '1.2.0',
        source: { type: 'local', immutableRevision: revision, locator: null },
        contentRoots: [{ label: 'local', path: resolve(pluginDir), fingerprint: fingerprintTree(pluginDir) }],
      }]);

      const retireProjection = await cursorManagedLifecycle.observeNativeProjection({
        targetObservation: inventoryAfter,
        operation: 'retire',
        operationId: retireOperationId,
        attemptId: retireAttemptId,
        activation: recordedActivation(installedObservation, decision),
      });
      expect(retireProjection.kind).toBe('unverified');
      if (retireProjection.kind !== 'unverified') throw new Error('marketplace refresh was treated as a proven native projection');
      expect(retireProjection.reasonId).toBe('cursor-marketplace-refresh');

      const retireDecision = cursorManagedLifecycle.decideRoute({
        target,
        operation: 'retire',
        operationId: retireOperationId,
        attemptId: retireAttemptId,
        scopeId,
        packageName,
        nativeId,
        version,
        sourceType: 'local',
        targetObservation: inventoryAfter,
        nativeScope: await cursorManagedLifecycle.observeNativeMutationScope({
          targetObservation: inventoryAfter,
          operation: 'retire',
          packageName,
          nativeId,
          sourceType: 'local',
        }),
        nativeProjection: retireProjection,
        planCoverage: createLifecyclePlanCoverage(inventoryAfter, [{
          nativeId,
          operationId: retireOperationId,
          operation: 'retire',
          mutationGroupId: 'group-retire-demo-plugin',
          authorization: 'observed-owned',
        }]),
        activation: recordedActivation(installedObservation, decision),
      });
      expect(retireDecision.kind).toBe('selected');
      if (retireDecision.kind !== 'selected') throw new Error(retireDecision.gaps.map((gap) => gap.diagnostic).join('\n'));
      expect(retireDecision.route).toBe('managed');

      const retirement = await cursorManagedLifecycle.prepareRetirement({
        operationId: retireOperationId,
        attemptId: retireAttemptId,
        action: 'remove',
        selection: retireDecision,
        activation: recordedActivation(installedObservation, decision),
      });
      const retired = await cursorManagedLifecycle.retire(retirement);
      expect(retired.changed).toBe(true);
      const retiredObservation = await cursorManagedLifecycle.readback(retired.handle);
      expect(cursorManagedLifecycle.verify(retired.handle, retiredObservation).phase).toBe('verified');
      expect(existsSync(pluginDir)).toBe(false);
      expect(retiredObservation.presence).toBe('absent');
      expect(retiredObservation.installedFingerprint).toBe(null);
      expect(readFileSync(join(dataDir, 'note.txt'), 'utf8')).toBe(pluginData);
      expect(readFileSync(join(metadataDir, 'note.txt'), 'utf8')).toBe(inactiveMetadata);
      expect(readFileSync(join(cursorRoot, 'mcp.json'), 'utf8')).toBe(userMcp);
      expect(retiredObservation.retention).toEqual({
        pluginData: { state: 'present', fingerprint: fingerprintTree(dataDir) },
        inactiveMetadata: { state: 'present', fingerprint: fingerprintTree(metadataDir) },
      });
    } finally {
      if (previousRoot === undefined) delete process.env['OPEN_PLUGIN_CURSOR_ROOT'];
      else process.env['OPEN_PLUGIN_CURSOR_ROOT'] = previousRoot;
      if (previousBin === undefined) delete process.env['OPEN_PLUGIN_CURSOR_BIN'];
      else process.env['OPEN_PLUGIN_CURSOR_BIN'] = previousBin;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function recordedActivation(
  observation: LifecycleReadbackObservation,
  decision: SelectedRouteDecision<SelectedLifecycleRoute, 'install'>,
) {
  if (observation.installedFingerprint === null) throw new Error('installed projection has no fingerprint');
  return createRecordedOwnedActivation({
    scopeId,
    target,
    packageName,
    nativeId,
    sourceType: 'local',
    sourceRevision: revision,
    sourceLocator: null,
    installedVersion: '1.2.0',
    route: 'managed',
    evidenceId: decision.evidenceId,
    ownership: { kind: 'created', proofId: `cursor-${nativeId}-${scopeId}` },
    activation: 'active',
    enablement: 'enabled',
    installedFingerprint: observation.installedFingerprint,
    contentRoots: observation.contentRoots,
  });
}
