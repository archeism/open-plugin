import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCapabilityEvidenceProfile, type CapabilityStatus } from '../src/capability-evidence';
import { fingerprintTree } from '../src/fingerprint';
import { createFrozenPackageSnapshot } from '../src/lifecycle-runtime';
import {
  PACKAGE_SEMANTICS,
  type CapabilityOperation,
  type PackageSemantic,
  type PackageSemanticInventory,
} from '../src/semantic-inventory';
import type { ActivationMutationAction, FrozenPackageSnapshot, SelectedLifecycleRoute } from '../src/lifecycle-host';

export const fixtureTarget = { kind: 'fixture', instance: 'default' } as const;

export const emptyInventory: PackageSemanticInventory = {
  schemaVersion: 1,
  package: { name: 'demo', version: '1.0.0', fingerprint: null },
  components: { skills: [], mcp: [], hooks: [], commands: [], agents: [], resources: [], permissionsPreprocessing: [] },
  componentDefinitions: [],
  invocationPolicies: [],
  componentInvocationPolicies: [],
  autoUpdate: [],
  manifestPaths: [],
  hookDeclarations: [],
  requiredSemantics: [],
};

const allSupported = Object.fromEntries(PACKAGE_SEMANTICS.map((semantic) => [semantic, 'supported'])) as Record<
  PackageSemantic,
  CapabilityStatus
>;

export function fixtureProfile(input: {
  route: SelectedLifecycleRoute;
  operations: readonly CapabilityOperation[];
  version?: string;
  semantics?: Partial<Record<PackageSemantic, CapabilityStatus>>;
}) {
  return createCapabilityEvidenceProfile({
    host: 'fixture',
    detectedVersion: input.version ?? '1.0.0',
    sourceTypes: ['git'],
    operations: input.operations,
    route: input.route,
    operationStatus: 'supported',
    semantics: { ...allSupported, ...input.semantics },
    evidence: ['docs/adr/0002-preflight-before-native-activation.md'],
  });
}

export function fixtureSnapshot<Action extends ActivationMutationAction>(root: string, input: {
  operationId: string;
  attemptId: string;
  scopeId?: string;
  action: Action;
  packageName?: string;
  nativeId?: string;
  version?: string;
  revision?: string;
  files?: Readonly<Record<string, string>>;
  inventory?: PackageSemanticInventory;
}): FrozenPackageSnapshot & { readonly action: Action } {
  const packageName = input.packageName ?? 'demo';
  const nativeId = input.nativeId ?? `${packageName}@market`;
  const snapshotRoot = join(root, `snapshot-${input.attemptId}`);
  const packageRoot = join(snapshotRoot, 'packages', packageName);
  mkdirSync(packageRoot, { recursive: true });
  const files = input.files ?? {
    'plugin.json': `${JSON.stringify({ name: packageName, version: input.version ?? '1.0.0' })}\n`,
    'payload.txt': `payload:${input.attemptId}\n`,
  };
  for (const [relative, bytes] of Object.entries(files)) {
    const path = join(packageRoot, relative);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, bytes);
  }
  const packageFingerprint = fingerprintTree(packageRoot);
  const semanticInventory: PackageSemanticInventory = {
    ...(input.inventory ?? emptyInventory),
    package: {
      name: packageName,
      version: input.version ?? input.inventory?.package.version ?? '1.0.0',
      fingerprint: packageFingerprint,
    },
  };
  const revision = input.revision ?? '1'.repeat(40);
  return createFrozenPackageSnapshot({
    operationId: input.operationId,
    attemptId: input.attemptId,
    scopeId: input.scopeId ?? `scope-${packageName}`,
    target: fixtureTarget,
    action: input.action,
    packageName,
    nativeId,
    sourceType: 'git',
    immutableRevision: revision,
    snapshotRoot,
    packageRoot,
    relativePackagePath: `packages/${packageName}`,
    snapshotFingerprint: fingerprintTree(snapshotRoot),
    packageFingerprint,
    nativeGit: { locator: 'https://github.com/example/plugins.git', resolvedRevision: revision },
    inventory: semanticInventory,
  }) as FrozenPackageSnapshot & { readonly action: Action };
}
