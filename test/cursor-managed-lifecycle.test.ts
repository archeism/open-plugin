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
import { fixturesRoot, writeFiles } from './util';

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
      writeFileSync(process.env['OPEN_PLUGIN_CURSOR_BIN'], cursorVersionCommand('2.4.0'));
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
      expect(installedObservation.transition).toEqual({ requirement: 'reload', status: 'effective' });
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

  test('updates an owned install and rolls the previous bytes back by swap', async () => {
    await withCursorHome(async (home) => {
      writeCursorBin(home, '2.4.0');
      const installed = await installOwned(home, 'one\n');
      const updatedBody = 'two\n';
      const update = await prepareOwned(home, {
        action: 'update',
        operationId: 'update-demo-plugin',
        attemptId: 'attempt-update-demo',
        scopeId,
        body: updatedBody,
        authorization: 'observed-owned',
        version: installed.version,
      });
      const applied = await cursorManagedLifecycle.apply(update.prepared);
      expect(applied.changed).toBe(true);
      expect(readFileSync(join(home.pluginDir, 'resources', 'value.txt'), 'utf8')).toBe(updatedBody);
      const verified = cursorManagedLifecycle.verify(applied.handle, await cursorManagedLifecycle.readback(applied.handle));
      expect(verified.phase).toBe('verified');

      const rolled = await cursorManagedLifecycle.rollback(applied.handle);
      expect(rolled.changed).toBe(true);
      expect(readFileSync(join(home.pluginDir, 'resources', 'value.txt'), 'utf8')).toBe('one\n');
      const restored = await cursorManagedLifecycle.readback(applied.handle);
      expect(cursorManagedLifecycle.verifyRollback(applied.handle, restored).phase).toBe('rollback-verified');
      const again = await cursorManagedLifecycle.rollback(applied.handle);
      expect(again.changed).toBe(false);
      expect(readFileSync(join(home.pluginDir, 'resources', 'value.txt'), 'utf8')).toBe('one\n');
    });
  });

  test('refuses a foreign scope and an unmarked directory', async () => {
    await withCursorHome(async (home) => {
      writeCursorBin(home, '2.4.0');
      const installed = await installOwned(home, 'one\n');
      const foreign = await prepareOwned(home, {
        action: 'update',
        operationId: 'update-foreign-demo',
        attemptId: 'attempt-foreign-demo',
        scopeId: 'scope-foreign',
        body: 'foreign\n',
        authorization: 'observed-owned',
        version: installed.version,
      });
      const refused = await failure(cursorManagedLifecycle.apply(foreign.prepared));
      expect(refused.message).toContain('not owned by deployment scope scope-foreign');
      expect(readFileSync(join(home.pluginDir, 'resources', 'value.txt'), 'utf8')).toBe('one\n');
    });
    await withCursorHome(async (home) => {
      writeCursorBin(home, '2.4.0');
      const sealed = await prepareOwned(home, {
        action: 'install',
        operationId: 'install-unmarked-demo',
        attemptId: 'attempt-unmarked-demo',
        scopeId,
        body: 'one\n',
        authorization: 'planned-create',
        version: await cursorManagedLifecycle.probeVersion(target),
      });
      writeFiles(home.pluginDir, { 'README': 'foreign\n' });
      const unmarked = await failure(cursorManagedLifecycle.apply(sealed.prepared));
      expect(unmarked.message).toContain('not owned by deployment scope');
      expect(readFileSync(join(home.pluginDir, 'README'), 'utf8')).toBe('foreign\n');
      expect(existsSync(join(home.pluginDir, '.plgnz-install.json'))).toBe(false);
    });
  });

  test('keeps a legacy scope-less marker unmanaged and continues past an unreadable neighbor', async () => {
    await withCursorHome(async (home) => {
      writeCursorBin(home, '2.4.0');
      const legacyDir = join(home.cursorRoot, 'plugins', 'local', 'legacy-plugin');
      const neighborDir = join(home.cursorRoot, 'plugins', 'local', 'neighbor');
      const corruptDir = join(home.cursorRoot, 'plugins', 'local', 'corrupt');
      writeFiles(legacyDir, {
        '.cursor-plugin/plugin.json': '{"name":"legacy-plugin","version":"0.1.0"}\n',
        '.plgnz-install.json': '{"source":"file:///legacy","pluginId":"legacy-plugin","fingerprint":"abc"}\n',
      });
      writeFiles(neighborDir, { '.cursor-plugin/plugin.json': '{\n' });
      writeFiles(corruptDir, {
        '.cursor-plugin/plugin.json': '{"name":"corrupt","version":"0.1.0"}\n',
        '.plgnz-install.json': '{\n',
      });
      const observed = await cursorManagedLifecycle.observeTarget(target);
      const legacy = observed.installations.find((installation) => installation.nativeId === 'legacy-plugin');
      const neighbor = observed.installations.find((installation) => installation.nativeId === 'neighbor');
      const corrupt = observed.installations.find((installation) => installation.nativeId === 'corrupt');
      expect(legacy?.ownership).toEqual({ kind: 'unmanaged' });
      expect(neighbor?.ownership).toEqual({ kind: 'ambiguous', proofIds: ['cursor-unreadable-neighbor'] });
      expect(neighbor?.packageName).toBe(null);
      expect(corrupt?.ownership).toEqual({ kind: 'ambiguous', proofIds: ['cursor-unreadable-corrupt'] });
      expect(corrupt?.packageName).toBe('corrupt');
      const installed = await installOwned(home, 'one\n');
      expect(installed.verified.phase).toBe('verified');
      const after = await cursorManagedLifecycle.observeTarget(target);
      expect(after.installations.find((installation) => installation.nativeId === 'neighbor')?.ownership.kind).toBe('ambiguous');
      expect(after.installations.find((installation) => installation.nativeId === nativeId)?.ownership.kind).toBe('owned');
    });
  });

  test('refuses a non-2.4.0 probe and disable, and admits a directory copy when no binary resolves', async () => {
    await withCursorHome(async (home) => {
      const script = join(home.home, 'bin', 'cursor');
      const observed = readFileSync(observedCursorVersion, 'utf8');
      expect(observed).toBe('2.4.21\ndc8361355d709f306d5159635a677a571b277bc0\narm64\n');
      writeFiles(home.home, { 'bin/cursor': shellEcho(observed) });
      chmodSync(script, 0o755);
      const decoyDir = join(home.home, 'decoy');
      const stamp = join(decoyDir, 'ran');
      writeFiles(decoyDir, { cursor: `#!/bin/sh\ntouch ${JSON.stringify(stamp)}\nprintf '%s\\n' '9.9.9' 'deadbeef' 'x64'\n` });
      chmodSync(join(decoyDir, 'cursor'), 0o755);
      const savedPath = process.env['PATH'];
      process.env['PATH'] = `${decoyDir}${savedPath === undefined ? '' : `:${savedPath}`}`;
      try {
        const detected = await cursorManagedLifecycle.probeVersion(target);
        expect(detected).toEqual({ kind: 'detected', version: '2.4.21', probeId: 'cursor-2.4.21' });
        expect(existsSync(stamp)).toBe(false);
        const gap = await installDecision(home, detected, 'install-gap', 'attempt-gap', 'planned-create');
        expect(gap.kind).toBe('capability-gap');
        if (gap.kind !== 'capability-gap') throw new Error('a non-2.4.0 probe selected a route');
        expect(gap.gaps.some((item) => item.capabilityId === 'profile')).toBe(true);
      } finally {
        if (savedPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = savedPath;
      }

      delete process.env['OPEN_PLUGIN_CURSOR_BIN'];
      rmSync(script, { force: true });
      const absent = await cursorManagedLifecycle.probeVersion(target);
      expect(absent).toEqual({ kind: 'detected', version: 'directory', probeId: 'cursor-directory' });
      const directoryCopy = await installDecision(home, absent, 'install-absent', 'attempt-absent', 'planned-create');
      expect(directoryCopy.kind).toBe('selected');
      if (directoryCopy.kind !== 'selected') throw new Error('a missing cursor binary refused the managed copy');
      expect(directoryCopy.route).toBe('managed');
      expect(directoryCopy.detectedVersion).toBe('directory');
      const resourceGap = await installDecision(home, absent, 'install-resources', 'attempt-resources', 'planned-create', {
        'plugin.json': '{"name":"demo-plugin","version":"1.2.0"}\n',
        '.cursor-plugin/plugin.json': '{"name":"demo-plugin","version":"1.2.0"}\n',
        'resources/value.txt': 'resource\n',
      });
      expect(resourceGap.kind).toBe('capability-gap');
      if (resourceGap.kind !== 'capability-gap') throw new Error('a directory copy claimed resource support');
      expect(resourceGap.gaps.some((item) => item.capabilityId === 'resources')).toBe(true);

      writeCursorBin(home, '2.4.0');
      const installed = await installOwned(home, 'one\n');
      const disable = cursorManagedLifecycle.decideRoute({
        target,
        operation: 'disable',
        operationId: 'disable-demo-plugin',
        attemptId: 'attempt-disable-demo',
        scopeId,
        packageName,
        nativeId,
        version: installed.version,
        sourceType: 'local',
        targetObservation: installed.observed,
        nativeScope: await cursorManagedLifecycle.observeNativeMutationScope({
          targetObservation: installed.observed,
          operation: 'disable',
          packageName,
          nativeId,
          sourceType: 'local',
        }),
        nativeProjection: await cursorManagedLifecycle.observeNativeProjection({
          targetObservation: installed.observed,
          operation: 'disable',
          operationId: 'disable-demo-plugin',
          attemptId: 'attempt-disable-demo',
          activation: recordedActivation(installed.observation, installed.decision),
        }),
        planCoverage: createLifecyclePlanCoverage(installed.observed, [{
          nativeId,
          operationId: 'disable-demo-plugin',
          operation: 'disable',
          mutationGroupId: 'disable-demo-plugin',
          authorization: 'observed-owned',
        }]),
        activation: recordedActivation(installed.observation, installed.decision),
      });
      expect(disable.kind).toBe('capability-gap');
      if (disable.kind !== 'capability-gap') throw new Error('disable selected a route');
      expect(disable.gaps.some((item) => item.capabilityId === 'reversible-disable')).toBe(true);
    });
  });
});

const observedCursorVersion = join(fixturesRoot, 'cursor-version-2.4.21.txt');

function cursorVersionCommand(version: string): string {
  const lines = readFileSync(observedCursorVersion, 'utf8').split('\n');
  lines[0] = version;
  return shellEcho(lines.join('\n'));
}

function shellEcho(text: string): string {
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  return `#!/bin/sh\nprintf '%s\\n' ${lines.map((line) => JSON.stringify(line)).join(' ')}\n`;
}

function writeCursorBin(home: CursorHome, version: string): void {
  const binary = join(home.home, 'cursor-bin');
  writeFileSync(binary, cursorVersionCommand(version));
  chmodSync(binary, 0o755);
  process.env['OPEN_PLUGIN_CURSOR_BIN'] = binary;
}

type CursorHome = { home: string; cursorRoot: string; pluginDir: string };

function freshCursorHome(): CursorHome {
  const home = mkdtempSync(join(tmpdir(), 'plgnz-cursor-managed-'));
  const cursorRoot = join(home, '.cursor');
  return { home, cursorRoot, pluginDir: join(cursorRoot, 'plugins', 'local', nativeId) };
}

async function withCursorHome(run: (home: CursorHome) => Promise<void>): Promise<void> {
  const home = freshCursorHome();
  const previousHome = process.env['OPEN_PLUGIN_HOME'];
  const previousRoot = process.env['OPEN_PLUGIN_CURSOR_ROOT'];
  const previousBin = process.env['OPEN_PLUGIN_CURSOR_BIN'];
  process.env['OPEN_PLUGIN_HOME'] = home.home;
  process.env['OPEN_PLUGIN_CURSOR_ROOT'] = home.cursorRoot;
  delete process.env['OPEN_PLUGIN_CURSOR_BIN'];
  try {
    await run(home);
  } finally {
    if (previousHome === undefined) delete process.env['OPEN_PLUGIN_HOME'];
    else process.env['OPEN_PLUGIN_HOME'] = previousHome;
    if (previousRoot === undefined) delete process.env['OPEN_PLUGIN_CURSOR_ROOT'];
    else process.env['OPEN_PLUGIN_CURSOR_ROOT'] = previousRoot;
    if (previousBin === undefined) delete process.env['OPEN_PLUGIN_CURSOR_BIN'];
    else process.env['OPEN_PLUGIN_CURSOR_BIN'] = previousBin;
    rmSync(home.home, { recursive: true, force: true });
  }
}

async function installOwned(home: CursorHome, body: string) {
  const version = await cursorManagedLifecycle.probeVersion(target);
  const prepared = await prepareOwned(home, {
    action: 'install',
    operationId: installOperationId,
    attemptId: installAttemptId,
    scopeId,
    body,
    authorization: 'planned-create',
    version,
  });
  const receipt = await cursorManagedLifecycle.apply(prepared.prepared);
  const observation = await cursorManagedLifecycle.readback(receipt.handle);
  return {
    version,
    decision: prepared.decision,
    observed: await cursorManagedLifecycle.observeTarget(target),
    observation,
    verified: cursorManagedLifecycle.verify(receipt.handle, observation),
  };
}

async function prepareOwned(home: CursorHome, input: {
  action: 'install' | 'update';
  operationId: string;
  attemptId: string;
  scopeId: string;
  body: string;
  authorization: 'planned-create' | 'observed-owned';
  version: Awaited<ReturnType<typeof cursorManagedLifecycle.probeVersion>>;
}) {
  const snapshotRoot = join(home.home, 'snapshot', input.operationId);
  const packageRoot = join(snapshotRoot, 'plugins', packageName);
  writeFiles(packageRoot, {
    'plugin.json': `{"name":"demo-plugin","version":"1.2.0"}\n`,
    '.cursor-plugin/plugin.json': '{"name":"demo-plugin","version":"1.2.0"}\n',
    'resources/value.txt': input.body,
  });
  const packageFingerprint = fingerprintTree(packageRoot);
  const plugin: PluginSource = { dir: packageRoot, name: packageName, version: '1.2.0', contentFingerprint: packageFingerprint };
  const snapshot = createFrozenPackageSnapshot({
    operationId: input.operationId,
    attemptId: input.attemptId,
    scopeId: input.scopeId,
    target,
    action: input.action,
    packageName,
    nativeId,
    sourceType: 'local',
    immutableRevision: input.action === 'install' ? revision : `${revision}-next`,
    snapshotRoot,
    packageRoot,
    relativePackagePath: 'plugins/demo-plugin',
    snapshotFingerprint: fingerprintTree(snapshotRoot),
    packageFingerprint,
    inventory: inventoryPackageSemantics(plugin),
  });
  const pins = createResolvedLifecyclePins([]);
  const observed = await cursorManagedLifecycle.observeTarget(target);
  const nativeScope = await cursorManagedLifecycle.observeNativeMutationScope({
    targetObservation: observed,
    operation: input.action,
    packageName,
    nativeId,
    sourceType: 'local',
  });
  const nativeProjection = await cursorManagedLifecycle.observeNativeProjection({
    targetObservation: observed,
    operation: input.action,
    snapshot,
    pins,
  });
  const decision = cursorManagedLifecycle.decideRoute({
    target,
    operation: input.action,
    operationId: input.operationId,
    attemptId: input.attemptId,
    scopeId: input.scopeId,
    packageName,
    nativeId,
    version: input.version,
    sourceType: 'local',
    targetObservation: observed,
    nativeScope,
    nativeProjection,
    planCoverage: createLifecyclePlanCoverage(observed, [{
      nativeId,
      operationId: input.operationId,
      operation: input.action,
      mutationGroupId: input.operationId,
      authorization: input.authorization,
    }]),
    snapshot,
    pins,
  });
  if (decision.kind !== 'selected' || decision.route !== 'managed') {
    throw new Error(decision.kind === 'capability-gap' ? decision.gaps.map((gap) => gap.diagnostic).join('\n') : 'route was not managed');
  }
  const staged = await cursorManagedLifecycle.stageActivation({ selection: decision, snapshot, pins });
  const prepared = await cursorManagedLifecycle.sealActivation(await cursorManagedLifecycle.applyPins(await cursorManagedLifecycle.applyLifecycleDirectives(staged)));
  return { decision, prepared };
}

async function installDecision(
  home: CursorHome,
  version: Awaited<ReturnType<typeof cursorManagedLifecycle.probeVersion>>,
  operationId: string,
  attemptId: string,
  authorization: 'planned-create' | 'observed-owned',
  files?: Record<string, string>,
) {
  const snapshotRoot = join(home.home, 'snapshot', operationId);
  const packageRoot = join(snapshotRoot, 'plugins', packageName);
  writeFiles(packageRoot, files ?? {
    'plugin.json': '{"name":"demo-plugin","version":"1.2.0"}\n',
    '.cursor-plugin/plugin.json': '{"name":"demo-plugin","version":"1.2.0"}\n',
  });
  const packageFingerprint = fingerprintTree(packageRoot);
  const plugin: PluginSource = { dir: packageRoot, name: packageName, version: '1.2.0', contentFingerprint: packageFingerprint };
  const snapshot = createFrozenPackageSnapshot({
    operationId,
    attemptId,
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
    inventory: inventoryPackageSemantics(plugin),
  });
  const pins = createResolvedLifecyclePins([]);
  const observed = await cursorManagedLifecycle.observeTarget(target);
  return cursorManagedLifecycle.decideRoute({
    target,
    operation: 'install',
    operationId,
    attemptId,
    scopeId,
    packageName,
    nativeId,
    version,
    sourceType: 'local',
    targetObservation: observed,
    nativeScope: await cursorManagedLifecycle.observeNativeMutationScope({
      targetObservation: observed,
      operation: 'install',
      packageName,
      nativeId,
      sourceType: 'local',
    }),
    nativeProjection: await cursorManagedLifecycle.observeNativeProjection({
      targetObservation: observed,
      operation: 'install',
      snapshot,
      pins,
    }),
    planCoverage: createLifecyclePlanCoverage(observed, [{
      nativeId,
      operationId,
      operation: 'install',
      mutationGroupId: operationId,
      authorization,
    }]),
    snapshot,
    pins,
  });
}

async function failure(run: Promise<unknown>): Promise<Error> {
  try {
    await run;
    throw new Error('expected operation to fail');
  } catch (error) {
    if (error instanceof Error && error.message === 'expected operation to fail') throw error;
    return error as Error;
  }
}

function recordedActivation(
  observation: LifecycleReadbackObservation,
  decision: SelectedRouteDecision<SelectedLifecycleRoute, 'install' | 'update'>,
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
