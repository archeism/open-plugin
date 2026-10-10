import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fingerprintTree } from '../src/fingerprint';
import { createLifecycleHostAdapter, createTargetInventoryObservation } from '../src/lifecycle-runtime';
import type {
  ActivationTransitionObservation,
  CleanupDisposition,
  CleanupReference,
  DurableLifecycleOperation,
  LifecycleHostAdapter,
  LifecycleHostDefinition,
  LifecycleReadbackData,
  LifecycleTargetIdentity,
  NativeMutationScopeData,
  NativeProjectionData,
  NativeProjectionRequest,
  TargetInventoryData,
  TargetVersionObservation,
} from '../src/lifecycle-host';
import type { CapabilityEvidenceProfile } from '../src/capability-evidence';

declare const Bun: {
  CryptoHasher: new (algorithm: 'sha256') => {
    update(input: string | Uint8Array): void;
    digest(encoding: 'hex'): string;
  };
};

interface RegistryRow {
  scopeId: string;
  packageName: string;
  enabled: boolean;
  route: 'native' | 'managed';
  installedVersion: string | null;
  sourceType: 'local' | 'git';
  sourceRevision: string;
  sourceLocator: string | null;
}

type Registry = Record<string, RegistryRow>;

export class FakeLifecycleHost {
  readonly events: string[] = [];
  readonly adapter: LifecycleHostAdapter;
  version = '1.0.0';
  probeId = 'fixture-runtime-1';
  nativeScope: NativeMutationScopeData = { kind: 'unavailable' };
  nativeProjection: NativeProjectionData = { kind: 'equivalent', proofId: 'fixture-projection-equivalence' };
  nativeProjectionFor: ((request: NativeProjectionRequest) => NativeProjectionData) | null = null;
  failPhase: string | null = null;
  failureValue: unknown = new Error('injected fake lifecycle failure');
  readbackFingerprintOverride: string | null = null;
  omitObservedSource = false;
  transition: ActivationTransitionObservation = { requirement: 'none', status: 'effective' };
  expectedTransition: ActivationTransitionObservation = { requirement: 'none', status: 'effective' };
  activationExpectation: {
    enablement: 'enabled' | 'disabled' | 'unknown';
    activation: 'active' | 'inactive' | 'unknown';
  } = { enablement: 'enabled', activation: 'active' };

  private readonly activeRoot: string;
  private readonly preparationRoot: string;
  private readonly registryFile: string;
  private readonly stateSentinel: string;
  private readonly nativeMutationLog: string;
  private readonly pluginDataRoot: string;
  private readonly inactiveMetadataRoot: string;

  constructor(readonly root: string, evidenceProfiles: readonly CapabilityEvidenceProfile[]) {
    this.activeRoot = join(root, 'host', 'active');
    this.preparationRoot = join(root, 'preparation');
    this.registryFile = join(root, 'host', 'registry.json');
    this.stateSentinel = join(root, 'plugnz-state.json');
    this.nativeMutationLog = join(root, 'host', 'native-mutations.log');
    this.pluginDataRoot = join(root, 'host', 'plugin-data');
    this.inactiveMetadataRoot = join(root, 'host', 'inactive-metadata');
    mkdirSync(this.activeRoot, { recursive: true });
    mkdirSync(dirname(this.registryFile), { recursive: true });
    mkdirSync(this.pluginDataRoot, { recursive: true });
    mkdirSync(this.inactiveMetadataRoot, { recursive: true });
    if (!existsSync(this.registryFile)) writeFileSync(this.registryFile, '{}\n');
    if (!existsSync(this.stateSentinel)) writeFileSync(this.stateSentinel, '{"generation":7}\n');
    if (!existsSync(this.nativeMutationLog)) writeFileSync(this.nativeMutationLog, '');

    const definition: LifecycleHostDefinition = {
      id: 'fixture',
      evidenceProfiles,
      probeVersion: async () => {
        this.hit('version');
        return this.versionObservation();
      },
      observeTarget: async (target) => {
        this.hit('inventory');
        return this.targetInventory(target);
      },
      observeNativeMutationScope: async () => {
        this.hit('native-scope');
        return this.nativeScope;
      },
      observeNativeProjection: async (request) => {
        this.hit('native-projection');
        return this.nativeProjectionFor?.(request) ?? this.nativeProjection;
      },
      revalidateTargetPrecondition: async (handle) => {
        this.hit('precondition');
        return {
          version: this.versionObservation(),
          targetObservationId: createTargetInventoryObservation('fixture', this.targetInventory(handle.target)).observationId,
        };
      },
      stageActivation: async (request) => {
        this.hit('stage');
        const stagingRoot = this.stagePath(request.snapshot.attemptId, request.snapshot.operationId);
        rmSync(stagingRoot, { recursive: true, force: true });
        mkdirSync(dirname(stagingRoot), { recursive: true });
        cpSync(request.snapshot.packageRoot, stagingRoot, { recursive: true });
        return { stagingId: `${request.snapshot.attemptId}:${request.snapshot.operationId}`, stagingRoot };
      },
      applyLifecycleDirectives: async (projection) => {
        this.hit('directives');
        writeFileSync(join(projection.stagingRoot, '.fixture-lifecycle.json'), '{"autoUpdate":false}\n');
        return ['fixture.auto-update=false'];
      },
      applyPins: async (projection) => {
        this.hit('pins');
        const commands = join(projection.stagingRoot, 'commands.txt');
        let text = existsSync(commands) ? readFileSync(commands, 'utf8') : '';
        for (const pin of projection.pins) text = text.replace(`${pin.server}=tool`, `${pin.server}=${pin.executable}`);
        if (projection.pins.length > 0) writeFileSync(commands, text);
        return projection.pins.map(({ server }) => server);
      },
      captureActivationPreparation: async (projection, projectedFingerprint) => {
        this.hit('fingerprint');
        const rollbackReference = this.rollbackPath(projection.attemptId, projection.operationId);
        rmSync(rollbackReference, { recursive: true, force: true });
        mkdirSync(rollbackReference, { recursive: true });
        const prior = this.observe({
          adapterId: projection.adapterId,
          target: projection.target,
          scopeId: projection.scopeId,
          packageName: projection.packageName,
          nativeId: projection.nativeId,
          route: projection.route,
        });
        writeFileSync(join(rollbackReference, 'prior.json'), `${JSON.stringify(prior)}\n`);
        const active = this.activePath(projection.nativeId);
        if (existsSync(active)) cpSync(active, join(rollbackReference, 'active'), { recursive: true });
        writeFileSync(join(rollbackReference, 'registry.json'), `${JSON.stringify(this.registry())}\n`);
        return {
          prior,
          expected: {
            adapterId: projection.adapterId,
            target: projection.target,
            scopeId: projection.scopeId,
            packageName: projection.packageName,
            nativeId: projection.nativeId,
            route: projection.route,
            presence: 'present',
            enablement: this.activationExpectation.enablement,
            activation: this.activationExpectation.activation,
            transition: this.expectedTransition,
            installedFingerprint: projectedFingerprint,
            contentRoots: [{ label: 'plugin', path: active, fingerprint: projectedFingerprint }],
            retention: this.retention(projection.nativeId),
          },
          rollbackReference,
          rollbackCoverageOperationIds: projection.affectedOperationIds,
        };
      },
      captureDisablePreparation: async (request) => {
        this.hit('disable-prepare');
        const prior = this.observeActivation(request.activation);
        const rollbackReference = this.captureRecorded(request.attemptId, request.operationId, request.activation.nativeId, prior);
        return {
          prior,
          rollbackReference,
          rollbackCoverageOperationIds: request.selection.affectedOperationIds,
          transition: this.expectedTransition,
        };
      },
      captureRetirementPreparation: async (request) => {
        this.hit('retire-prepare');
        const prior = this.observeActivation(request.activation);
        const rollbackReference = this.captureRecorded(request.attemptId, request.operationId, request.activation.nativeId, prior);
        return {
          prior,
          rollbackReference,
          rollbackCoverageOperationIds: request.selection.affectedOperationIds,
          transition: this.expectedTransition,
        };
      },
      apply: async (prepared) => {
        this.hit(`${prepared.handle.route}:apply`);
        const target = this.activePath(prepared.handle.nativeId);
        const candidate = `${target}.candidate`;
        rmSync(candidate, { recursive: true, force: true });
        cpSync(prepared.stagingRoot, candidate, { recursive: true });
        rmSync(target, { recursive: true, force: true });
        renameSync(candidate, target);
        const registry = this.registry();
        registry[prepared.handle.nativeId] = {
          scopeId: prepared.handle.scopeId,
          packageName: prepared.handle.packageName,
          enabled: true,
          route: prepared.handle.route,
          installedVersion: prepared.handle.packageVersion,
          sourceType: prepared.handle.sourceType,
          sourceRevision: prepared.handle.sourceRevision,
          sourceLocator: prepared.handle.sourceLocator,
        };
        this.writeRegistry(registry);
        this.logMutation(`${prepared.handle.route}:apply:${prepared.handle.nativeId}`);
        return { receiptId: `apply:${prepared.handle.attemptId}:${prepared.handle.operationId}`, changed: true };
      },
      disable: async (prepared) => {
        this.hit(`${prepared.handle.route}:disable`);
        const registry = this.registry();
        const row = registry[prepared.handle.nativeId];
        if (row !== undefined) row.enabled = false;
        this.writeRegistry(registry);
        this.logMutation(`${prepared.handle.route}:disable:${prepared.handle.nativeId}`);
        return { receiptId: `disable:${prepared.handle.attemptId}:${prepared.handle.operationId}`, changed: true };
      },
      retire: async (prepared) => {
        this.hit(`${prepared.handle.route}:retire`);
        rmSync(this.activePath(prepared.handle.nativeId), { recursive: true, force: true });
        const registry = this.registry();
        delete registry[prepared.handle.nativeId];
        this.writeRegistry(registry);
        this.logMutation(`${prepared.handle.route}:retire:${prepared.handle.nativeId}`);
        return { receiptId: `retire:${prepared.handle.attemptId}:${prepared.handle.operationId}`, changed: true };
      },
      readback: async (handle) => {
        this.hit('readback');
        return this.observe(handle);
      },
      rollback: async (handle) => {
        this.hit('rollback');
        const reference = handle.rollbackReference;
        const prior = JSON.parse(readFileSync(join(reference, 'prior.json'), 'utf8')) as LifecycleReadbackData;
        const target = this.activePath(handle.nativeId);
        rmSync(target, { recursive: true, force: true });
        const backup = join(reference, 'active');
        if (existsSync(backup)) cpSync(backup, target, { recursive: true });
        writeFileSync(this.registryFile, readFileSync(join(reference, 'registry.json'), 'utf8'));
        this.logMutation(`rollback:${handle.nativeId}`);
        if (prior.presence === 'absent') rmSync(target, { recursive: true, force: true });
        return { receiptId: `rollback:${handle.attemptId}:${handle.operationId}`, changed: true };
      },
      cleanup: async (reference, disposition) => {
        this.hit(`cleanup:${disposition}`);
        rmSync(join(this.preparationRoot, safe(reference.attemptId), safe(reference.operationId)), { recursive: true, force: true });
        return { cleanupId: `cleanup:${reference.attemptId}:${reference.operationId}`, completed: true };
      },
    };
    this.adapter = createLifecycleHostAdapter(definition);
  }

  hostMutationState(): string {
    const active = existsSync(this.activeRoot)
      ? readdirSync(this.activeRoot).sort().map((name) => `${name}:${fingerprintTree(join(this.activeRoot, name))}`)
      : [];
    return JSON.stringify({
      active,
      registry: readFileSync(this.registryFile, 'utf8'),
      state: readFileSync(this.stateSentinel, 'utf8'),
      native: readFileSync(this.nativeMutationLog, 'utf8'),
    });
  }

  readInstalled(nativeId: string): string {
    return readFileSync(join(this.activePath(nativeId), 'commands.txt'), 'utf8');
  }

  seedActivation(input: {
    nativeId: string;
    scopeId: string;
    packageName: string;
    route?: 'native' | 'managed';
    enabled?: boolean;
    files?: Record<string, string>;
    pluginData?: string;
    inactiveMetadata?: string;
    installedVersion?: string | null;
    sourceType?: 'local' | 'git';
    sourceRevision?: string;
    sourceLocator?: string | null;
  }): string {
    const active = this.activePath(input.nativeId);
    rmSync(active, { recursive: true, force: true });
    mkdirSync(active, { recursive: true });
    for (const [path, bytes] of Object.entries(input.files ?? { 'payload.txt': 'prior\n' })) {
      const file = join(active, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
    }
    const registry = this.registry();
    const sourceType = input.sourceType ?? 'git';
    registry[input.nativeId] = {
      scopeId: input.scopeId,
      packageName: input.packageName,
      enabled: input.enabled ?? true,
      route: input.route ?? 'managed',
      installedVersion: input.installedVersion ?? '1.0.0',
      sourceType,
      sourceRevision: input.sourceRevision ?? '0'.repeat(40),
      sourceLocator: input.sourceLocator === undefined
        ? sourceType === 'git' ? 'https://github.com/example/plugins.git' : null
        : input.sourceLocator,
    };
    this.writeRegistry(registry);
    if (input.pluginData !== undefined) {
      writeFileSync(join(this.pluginDataRoot, safe(input.nativeId)), input.pluginData);
    }
    if (input.inactiveMetadata !== undefined) {
      writeFileSync(join(this.inactiveMetadataRoot, `${safe(input.nativeId)}.json`), input.inactiveMetadata);
    }
    return fingerprintTree(active);
  }

  pluginData(nativeId: string): string {
    return readFileSync(join(this.pluginDataRoot, safe(nativeId)), 'utf8');
  }

  inactiveMetadata(nativeId: string): string {
    return readFileSync(join(this.inactiveMetadataRoot, `${safe(nativeId)}.json`), 'utf8');
  }

  installedFingerprint(nativeId: string): string | null {
    const active = this.activePath(nativeId);
    return existsSync(active) ? fingerprintTree(active) : null;
  }

  private versionObservation(): TargetVersionObservation {
    return { kind: 'detected', version: this.version, probeId: this.probeId };
  }

  private targetInventory(target: LifecycleTargetIdentity): TargetInventoryData {
    const registry = this.registry();
    return {
      target,
      installations: Object.entries(registry).map(([nativeId, row]) => {
        const active = this.activePath(nativeId);
        const digest = fingerprintTree(active);
        return {
          nativeId,
          packageName: row.packageName,
          ownership: { kind: 'owned' as const, proof: 'created' as const, scopeId: row.scopeId, proofId: `proof:${nativeId}` },
          presence: 'present' as const,
          enablement: row.enabled ? 'enabled' as const : 'disabled' as const,
          activation: row.enabled ? 'active' as const : 'inactive' as const,
          installedFingerprint: digest,
          installedVersion: row.installedVersion,
          source: this.omitObservedSource ? null : {
            type: row.sourceType,
            immutableRevision: row.sourceRevision,
            locator: row.sourceLocator,
          },
          contentRoots: [{ label: 'plugin', path: active, fingerprint: digest }],
        };
      }),
    };
  }

  private observe(handle: Pick<DurableLifecycleOperation, 'adapterId' | 'target' | 'scopeId' | 'packageName' | 'nativeId' | 'route'>): LifecycleReadbackData {
    const active = this.activePath(handle.nativeId);
    const row = this.registry()[handle.nativeId];
    if (!existsSync(active) || row === undefined) {
      return {
        adapterId: handle.adapterId,
        target: handle.target,
        scopeId: handle.scopeId,
        packageName: handle.packageName,
        nativeId: handle.nativeId,
        route: 'action' in handle && (handle.action === 'retire-orphan' || handle.action === 'remove')
          ? handle.route
          : 'none',
        presence: 'absent',
        enablement: 'disabled',
        activation: 'inactive',
        transition: this.transition,
        installedFingerprint: null,
        contentRoots: [],
        retention: this.retention(handle.nativeId),
      };
    }
    const actualDigest = fingerprintTree(active);
    const digest = this.readbackFingerprintOverride ?? actualDigest;
    return {
      adapterId: handle.adapterId,
      target: handle.target,
      scopeId: handle.scopeId,
      packageName: handle.packageName,
      nativeId: handle.nativeId,
      route: row.route,
      presence: 'present',
      enablement: row.enabled ? 'enabled' : 'disabled',
      activation: row.enabled ? 'active' : 'inactive',
      transition: this.transition,
      installedFingerprint: digest,
      contentRoots: [{ label: 'plugin', path: active, fingerprint: digest }],
      retention: this.retention(handle.nativeId),
    };
  }

  private observeActivation(activation: Parameters<LifecycleHostDefinition['captureDisablePreparation']>[0]['activation']): LifecycleReadbackData {
    return this.observe({
      adapterId: 'fixture',
      target: activation.target,
      scopeId: activation.scopeId,
      packageName: activation.packageName,
      nativeId: activation.nativeId,
      route: activation.route,
    });
  }

  private captureRecorded(
    attemptId: string,
    operationId: string,
    nativeId: string,
    prior: LifecycleReadbackData,
  ): string {
    const reference = this.rollbackPath(attemptId, operationId);
    rmSync(reference, { recursive: true, force: true });
    mkdirSync(reference, { recursive: true });
    const active = this.activePath(nativeId);
    if (existsSync(active)) cpSync(active, join(reference, 'active'), { recursive: true });
    writeFileSync(join(reference, 'prior.json'), `${JSON.stringify(prior)}\n`);
    writeFileSync(join(reference, 'registry.json'), `${JSON.stringify(this.registry())}\n`);
    return reference;
  }

  private retention(nativeId: string): LifecycleReadbackData['retention'] {
    const observe = (path: string): LifecycleReadbackData['retention']['pluginData'] => {
      if (!existsSync(path)) return { state: 'absent', fingerprint: null };
      const hash = new Bun.CryptoHasher('sha256');
      hash.update(readFileSync(path, 'utf8'));
      return { state: 'present', fingerprint: hash.digest('hex') };
    };
    return {
      pluginData: observe(join(this.pluginDataRoot, safe(nativeId))),
      inactiveMetadata: observe(join(this.inactiveMetadataRoot, `${safe(nativeId)}.json`)),
    };
  }

  private hit(phase: string): void {
    this.events.push(phase);
    if (this.failPhase === phase) throw this.failureValue;
  }

  private registry(): Registry {
    return JSON.parse(readFileSync(this.registryFile, 'utf8')) as Registry;
  }

  private writeRegistry(value: Registry): void {
    writeFileSync(this.registryFile, `${JSON.stringify(value)}\n`);
  }

  private logMutation(value: string): void {
    writeFileSync(this.nativeMutationLog, `${readFileSync(this.nativeMutationLog, 'utf8')}${value}\n`);
  }

  private activePath(nativeId: string): string {
    return join(this.activeRoot, safe(nativeId));
  }

  private stagePath(attemptId: string, operationId: string): string {
    return join(this.preparationRoot, safe(attemptId), safe(operationId), 'stage');
  }

  private rollbackPath(attemptId: string, operationId: string): string {
    return join(this.preparationRoot, safe(attemptId), safe(operationId), 'rollback');
  }
}

function safe(value: string): string {
  return encodeURIComponent(value);
}
