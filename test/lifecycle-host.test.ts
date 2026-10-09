import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PACKAGE_SEMANTICS, type PackageSemanticInventory } from '../src/semantic-inventory';
import { createCapabilityEvidenceProfile } from '../src/capability-evidence';
import { fingerprintTree } from '../src/fingerprint';
import {
  createFrozenPackageSnapshot,
  createLifecyclePlanCoverage,
  createNativeProjectionObservation,
  createNativeMutationScopeObservation,
  createResolvedLifecyclePins,
  createTargetInventoryObservation,
  selectLifecycleRoute,
} from '../src/lifecycle-runtime';
import { FakeLifecycleHost } from './fake-lifecycle-adapter';

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

const target = { kind: 'fixture', instance: 'default' } as const;
const inventory: PackageSemanticInventory = {
  schemaVersion: 1,
  package: { name: 'demo', version: '1.0.0', fingerprint: 'a'.repeat(64) },
  components: { skills: [], mcp: [], hooks: [], commands: [], agents: [], resources: [], permissionsPreprocessing: [] },
  componentDefinitions: [],
  invocationPolicies: [],
  componentInvocationPolicies: [],
  autoUpdate: [],
  requiredSemantics: [],
};

const supported = Object.fromEntries(PACKAGE_SEMANTICS.map((semantic) => [semantic, 'supported'])) as Record<
  (typeof PACKAGE_SEMANTICS)[number],
  'supported'
>;

function profile(route: 'native' | 'managed') {
  return createCapabilityEvidenceProfile({
    host: 'fixture',
    detectedVersion: '1.0.0',
    sourceTypes: ['git'],
    operations: ['install'],
    route,
    operationStatus: 'supported',
    semantics: supported,
    evidence: ['docs/adr/0002-preflight-before-native-activation.md'],
  });
}

describe('writer-side lifecycle route preflight', () => {
  test('uses immutable observed blast radius and ownership-proven plan coverage before selecting Native', () => {
    const root = mkdtempSync(join(tmpdir(), 'plgnz-lifecycle-route-'));
    roots.push(root);
    const packageRoot = join(root, 'snapshot', 'demo');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, 'payload.txt'), 'route-input\n');
    const packageFingerprint = fingerprintTree(packageRoot);
    const snapshot = createFrozenPackageSnapshot({
      operationId: 'op-demo',
      attemptId: 'attempt-demo',
      scopeId: 'scope-a',
      target,
      action: 'install',
      packageName: 'demo',
      nativeId: 'demo@market',
      sourceType: 'git',
      immutableRevision: '1'.repeat(40),
      snapshotRoot: join(root, 'snapshot'),
      packageRoot,
      relativePackagePath: 'demo',
      snapshotFingerprint: fingerprintTree(join(root, 'snapshot')),
      packageFingerprint,
      nativeGit: { locator: 'https://github.com/example/plugins.git', resolvedRevision: '1'.repeat(40) },
      inventory: { ...inventory, package: { ...inventory.package, fingerprint: packageFingerprint } },
    });
    const observation = createTargetInventoryObservation('fixture', {
      target,
      installations: [
        {
          nativeId: 'demo@market',
          packageName: 'demo',
          ownership: { kind: 'owned', proof: 'created', scopeId: 'scope-a', proofId: 'proof-a' },
          presence: 'present',
          enablement: 'enabled',
          activation: 'active',
          installedFingerprint: 'b'.repeat(64),
          installedVersion: '0.9.0',
          source: { type: 'git', immutableRevision: '2'.repeat(40), locator: 'https://github.com/example/plugins.git' },
          contentRoots: [{ label: 'plugin', path: '/fixture/demo', fingerprint: 'b'.repeat(64) }],
        },
        {
          nativeId: 'sibling@market',
          packageName: 'sibling',
          ownership: { kind: 'owned', proof: 'created', scopeId: 'scope-b', proofId: 'proof-b' },
          presence: 'present',
          enablement: 'enabled',
          activation: 'active',
          installedFingerprint: 'c'.repeat(64),
          installedVersion: '0.9.0',
          source: { type: 'git', immutableRevision: '3'.repeat(40), locator: 'https://github.com/example/plugins.git' },
          contentRoots: [{ label: 'plugin', path: '/fixture/sibling', fingerprint: 'c'.repeat(64) }],
        },
      ],
    });
    const nativeScope = createNativeMutationScopeObservation(observation, {
      kind: 'bounded',
      mode: 'marketplace-wide',
      affectedNativeIds: ['demo@market', 'sibling@market'],
    });
    const incompleteCoverage = createLifecyclePlanCoverage(observation, [
      { nativeId: 'demo@market', operationId: 'op-demo', operation: 'install', mutationGroupId: 'group-market', authorization: 'observed-owned' },
    ]);
    const completeCoverage = createLifecyclePlanCoverage(observation, [
      { nativeId: 'demo@market', operationId: 'op-demo', operation: 'install', mutationGroupId: 'group-market', authorization: 'observed-owned' },
      { nativeId: 'sibling@market', operationId: 'op-sibling', operation: 'install', mutationGroupId: 'group-market', authorization: 'observed-owned' },
    ]);
    const splitGroupCoverage = createLifecyclePlanCoverage(observation, [
      { nativeId: 'demo@market', operationId: 'op-demo', operation: 'install', mutationGroupId: 'group-a', authorization: 'observed-owned' },
      { nativeId: 'sibling@market', operationId: 'op-sibling', operation: 'install', mutationGroupId: 'group-b', authorization: 'observed-owned' },
    ]);
    const incompatibleCoverage = createLifecyclePlanCoverage(observation, [
      { nativeId: 'demo@market', operationId: 'op-demo', operation: 'install', mutationGroupId: 'group-market', authorization: 'observed-owned' },
      { nativeId: 'sibling@market', operationId: 'op-sibling', operation: 'update', mutationGroupId: 'group-market', authorization: 'observed-owned' },
    ]);
    const pins = createResolvedLifecyclePins([]);
    const nativeProjection = createNativeProjectionObservation({
      targetObservation: observation,
      operation: 'install',
      snapshot,
      pins,
    }, { kind: 'equivalent', proofId: 'fixture-exact-projection' });
    const base = {
      target,
      operationId: 'op-demo',
      attemptId: 'attempt-demo',
      scopeId: 'scope-a',
      packageName: 'demo',
      nativeId: 'demo@market',
      version: { kind: 'detected', version: '1.0.0', probeId: 'fixture-runtime-1' } as const,
      sourceType: 'git' as const,
      targetObservation: observation,
      nativeScope,
      nativeProjection,
      operation: 'install' as const,
      snapshot,
      pins,
    };

    const managed = selectLifecycleRoute('fixture', [profile('native'), profile('managed')], {
      ...base,
      planCoverage: incompleteCoverage,
    });
    const native = selectLifecycleRoute('fixture', [profile('native'), profile('managed')], {
      ...base,
      planCoverage: completeCoverage,
    });
    const splitGroup = selectLifecycleRoute('fixture', [profile('native'), profile('managed')], {
      ...base,
      planCoverage: splitGroupCoverage,
    });
    const incompatible = selectLifecycleRoute('fixture', [profile('native'), profile('managed')], {
      ...base,
      planCoverage: incompatibleCoverage,
    });

    expect(managed.kind === 'selected' ? managed.route : managed.kind).toBe('managed');
    expect(native.kind === 'selected' ? native.route : native.kind).toBe('native');
    expect(splitGroup.kind === 'selected' ? splitGroup.route : splitGroup.kind).toBe('managed');
    expect(incompatible.kind === 'selected' ? incompatible.route : incompatible.kind).toBe('managed');
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(observation.installations)).toBe(true);
    expect(nativeScope.kind === 'bounded' && Object.isFrozen(nativeScope.affectedNativeIds)).toBe(true);
    expect(Object.isFrozen(completeCoverage.operations)).toBe(true);
    expect(native.kind === 'selected' ? native.affectedOperationIds : []).toEqual(['op-demo', 'op-sibling']);
  });

  test('prepares directives and pins without host writes, then applies the exact sealed artifact and verifies independent readback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'plgnz-lifecycle-host-'));
    roots.push(root);
    const authoredPackage = join(root, 'authored', 'packages', 'demo');
    mkdirSync(authoredPackage, { recursive: true });
    writeFileSync(join(authoredPackage, 'plugin.json'), '{"name":"demo","version":"1.0.0"}\n');
    writeFileSync(join(authoredPackage, 'commands.txt'), 'fixture=tool\n');
    writeFileSync(join(authoredPackage, 'payload.txt'), 'frozen-v1\n');
    const snapshotRoot = join(root, 'source-snapshot');
    cpSync(join(root, 'authored'), snapshotRoot, { recursive: true });
    const packageRoot = join(snapshotRoot, 'packages', 'demo');
    const packageFingerprint = fingerprintTree(packageRoot);
    const packageInventory: PackageSemanticInventory = {
      ...inventory,
      package: { name: 'demo', version: '1.0.0', fingerprint: packageFingerprint },
    };
    const snapshot = createFrozenPackageSnapshot({
      operationId: 'op-install-demo',
      attemptId: 'attempt-unique-1',
      scopeId: 'scope-demo',
      target,
      action: 'install',
      packageName: 'demo',
      nativeId: 'demo@market',
      sourceType: 'git',
      immutableRevision: '1'.repeat(40),
      snapshotRoot,
      packageRoot,
      relativePackagePath: 'packages/demo',
      snapshotFingerprint: fingerprintTree(snapshotRoot),
      packageFingerprint,
      nativeGit: { locator: 'https://github.com/example/plugins.git', resolvedRevision: '1'.repeat(40) },
      inventory: packageInventory,
    });
    const pins = createResolvedLifecyclePins([{ server: 'fixture', executable: '/opt/bin/fixture' }]);
    const managedProfile = profile('managed');
    const fake = new FakeLifecycleHost(join(root, 'fake-host'), [managedProfile]);
    const version = await fake.adapter.probeVersion(target);
    const observed = await fake.adapter.observeTarget(target);
    const nativeScope = await fake.adapter.observeNativeMutationScope({
      targetObservation: observed,
      operation: 'install',
      packageName: 'demo',
      nativeId: 'demo@market',
      sourceType: 'git',
    });
    const nativeProjection = await fake.adapter.observeNativeProjection({
      targetObservation: observed,
      operation: 'install',
      snapshot,
      pins,
    });
    const decision = fake.adapter.decideRoute({
      target,
      operationId: 'op-install-demo',
      attemptId: 'attempt-unique-1',
      scopeId: 'scope-demo',
      packageName: 'demo',
      nativeId: 'demo@market',
      version,
      sourceType: 'git',
      targetObservation: observed,
      nativeScope,
      nativeProjection,
      planCoverage: createLifecyclePlanCoverage(observed, []),
      operation: 'install',
      snapshot,
      pins,
    });
    if (decision.kind !== 'selected') throw new Error('fixture route should be selected');
    const hostBefore = fake.hostMutationState();
    const staged = await fake.adapter.stageActivation({ selection: decision, snapshot, pins });
    const directed = await fake.adapter.applyLifecycleDirectives(staged);
    const beforePins = fingerprintTree(directed.stagingRoot);
    const pinned = await fake.adapter.applyPins(directed);
    const prepared = await fake.adapter.sealActivation(pinned);

    expect(fake.hostMutationState()).toBe(hostBefore);
    expect(prepared.handle.projectedFingerprint === beforePins).toBe(false);
    expect(prepared.handle.artifactId).toBe(`sha256:${prepared.handle.projectedFingerprint}`);
    writeFileSync(join(authoredPackage, 'payload.txt'), 'authored-v2-after-freeze\n');

    const receipt = await fake.adapter.apply(prepared);
    expect(receipt.phase).toBe('mutated');
    const readback = await fake.adapter.readback(prepared.handle);
    const verified = fake.adapter.verify(prepared.handle, readback);
    expect(verified.phase).toBe('verified');
    expect(readback.installedFingerprint).toBe(prepared.handle.projectedFingerprint);
    expect(fake.readInstalled('demo@market')).toBe('fixture=/opt/bin/fixture\n');
    await fake.adapter.cleanup(prepared.handle, 'verified-commit');
    expect(fake.events).toEqual([
      'version',
      'inventory',
      'native-scope',
      'native-projection',
      'stage',
      'directives',
      'pins',
      'fingerprint',
      'precondition',
      'managed:apply',
      'readback',
      'cleanup:verified-commit',
    ]);

    if (false) {
      // @ts-expect-error apply consumes only a sealed PreparedActivationMutation.
      await fake.adapter.apply(staged);
      // @ts-expect-error sealActivation requires pins to have been applied.
      await fake.adapter.sealActivation(directed);
    }
  });
});
