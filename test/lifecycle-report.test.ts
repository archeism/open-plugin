import { describe, expect, test } from 'bun:test';
import {
  LIFECYCLE_ACTIVATION_STATES,
  LIFECYCLE_COVERAGE_KINDS,
  LIFECYCLE_EXIT_CODES,
  LIFECYCLE_OPERATION_RESULTS,
  LIFECYCLE_PLAN_ACTIONS,
  LIFECYCLE_REASON_CATEGORIES,
  LIFECYCLE_REASON_CODES,
  LIFECYCLE_REPORT_SCHEMA_VERSION,
  LIFECYCLE_RESOURCE_STATES,
  LIFECYCLE_ROUTES,
  createLifecycleReason,
  LifecycleReportValidationError,
  exitCodeForLifecycleReport,
  parseLifecycleReport,
  type LifecycleReport,
} from '../src/lifecycle-report';
import { serializeLegacyInstallOutcomes } from '../src/legacy-install-outcome';
import { createDeploymentScopeIdentity } from '../src/deployment-scope';

const sourceBinding = { kind: 'local', locator: '/sources/personal' } as const;

function scope(target = 'dcode') {
  return createDeploymentScopeIdentity(sourceBinding, { kind: target, instance: 'default' });
}

function validReport(): LifecycleReport {
  return {
    schemaVersion: 1,
    command: {
      name: 'sync',
      dryRun: false,
      sourceSnapshots: [{
        id: 'snapshot-1',
        reference: { binding: sourceBinding, revision: 'revision-1', fingerprint: 'fingerprint-1' },
      }],
    },
    plan: [{
      operationId: 'op-1',
      coverage: 'desired-pair',
      scope: scope(),
      sourceSnapshotId: 'snapshot-1',
      package: 'addy',
      nativeId: 'addy@personal',
      action: 'install',
      route: 'managed',
    }],
    outcomes: [{
      operationId: 'op-1',
      coverage: 'desired-pair',
      scope: scope(),
      sourceSnapshotId: 'snapshot-1',
      package: 'addy',
      nativeId: 'addy@personal',
      action: 'install',
      route: 'managed',
      result: 'succeeded',
      resourceState: 'present',
      activationState: 'active-conforming',
      changed: true,
      reason: null,
    }],
    summary: {
      result: 'converged',
      terminalPhase: 'complete',
      mutationStarted: true,
      changed: true,
      failureCategory: null,
      reason: null,
      recoveryId: null,
      readbackId: null,
    },
  };
}

describe('lifecycle report contract', () => {
  test('pins schema version and orthogonal machine-readable fields', () => {
    expect({
      schemaVersion: LIFECYCLE_REPORT_SCHEMA_VERSION,
      actions: LIFECYCLE_PLAN_ACTIONS,
      results: LIFECYCLE_OPERATION_RESULTS,
      resourceStates: LIFECYCLE_RESOURCE_STATES,
      activationStates: LIFECYCLE_ACTIVATION_STATES,
      routes: LIFECYCLE_ROUTES,
      coverageKinds: LIFECYCLE_COVERAGE_KINDS,
      parsed: parseLifecycleReport(validReport()),
    }).toEqual({
      schemaVersion: 1,
      actions: ['install', 'update', 'unchanged', 'route-migrate', 'disable-nonconforming', 'retain-prior', 'retire-orphan'],
      results: ['succeeded', 'failed', 'pending', 'not-attempted'],
      resourceStates: ['present', 'absent', 'retained', 'unknown', 'potentially-changed'],
      activationStates: ['active-conforming', 'active-nonconforming', 'inactive', 'retained-prior', 'unknown'],
      routes: ['native', 'managed', 'none'],
      coverageKinds: ['desired-pair', 'retirement'],
      parsed: validReport(),
    });
  });

  test('rejects missing, duplicate, unexpected, and contradictory outcomes', () => {
    const missing = validReport();
    missing.outcomes = [];

    const duplicate = validReport();
    duplicate.outcomes.push({ ...duplicate.outcomes[0]! });

    const unexpected = validReport();
    unexpected.outcomes[0] = { ...unexpected.outcomes[0]!, operationId: 'not-in-plan' };

    const contradictory = validReport();
    contradictory.outcomes[0] = { ...contradictory.outcomes[0]!, scope: scope('codex') };

    expect([missing, duplicate, unexpected, contradictory].map((report) => {
      try {
        parseLifecycleReport(report);
        return 'accepted';
      } catch (error) {
        expect(error instanceof LifecycleReportValidationError).toBe(true);
        return (error as LifecycleReportValidationError).reason.code;
      }
    })).toEqual([
      'protocol.missing-outcome',
      'protocol.duplicate-outcome',
      'protocol.unexpected-outcome',
      'protocol.contradictory-outcome',
    ]);
  });

  test('rejects duplicate package pairs even when their operation ids differ', () => {
    const duplicatePair = validReport();
    duplicatePair.plan.push({ ...duplicatePair.plan[0]!, operationId: 'op-2' });
    duplicatePair.outcomes.push({ ...duplicatePair.outcomes[0]!, operationId: 'op-2' });

    let duplicateCode = 'accepted';
    try {
      parseLifecycleReport(duplicatePair);
    } catch (error) {
      duplicateCode = (error as LifecycleReportValidationError).reason.code;
    }
    expect(duplicateCode).toBe('protocol.invalid-report');
  });

  test('rejects command coverage that contradicts additive and retirement semantics', () => {
    const additiveRetirement = validReport();
    additiveRetirement.command = { ...additiveRetirement.command, name: 'add' };
    additiveRetirement.plan[0] = { ...additiveRetirement.plan[0]!, coverage: 'retirement', action: 'retire-orphan' };
    additiveRetirement.outcomes[0] = { ...additiveRetirement.outcomes[0]!, coverage: 'retirement', action: 'retire-orphan' };

    const retirementInstall = validReport();
    retirementInstall.command = { ...retirementInstall.command, name: 'retire-source' };

    expect([additiveRetirement, retirementInstall].map((report) => {
      try {
        parseLifecycleReport(report);
        return 'accepted';
      } catch (error) {
        return (error as LifecycleReportValidationError).reason.code;
      }
    })).toEqual(['protocol.invalid-report', 'protocol.invalid-report']);
  });

  test('rejects successful operations whose resource or activation remains unknown', () => {
    const unknownResource = validReport();
    unknownResource.outcomes[0] = { ...unknownResource.outcomes[0]!, resourceState: 'unknown' };

    const unknownActivation = validReport();
    unknownActivation.outcomes[0] = { ...unknownActivation.outcomes[0]!, activationState: 'unknown' };

    expect([unknownResource, unknownActivation].map((report) => {
      try {
        parseLifecycleReport(report);
        return 'accepted';
      } catch (error) {
        return (error as LifecycleReportValidationError).reason.code;
      }
    })).toEqual(['protocol.contradictory-outcome', 'protocol.contradictory-outcome']);
  });

  test('rejects successful desired and retirement operations with the opposite terminal state', () => {
    const absentInstall = validReport();
    absentInstall.outcomes[0] = {
      ...absentInstall.outcomes[0]!,
      resourceState: 'absent',
      activationState: 'inactive',
    };

    const activeRetirement = validReport();
    activeRetirement.command = { ...activeRetirement.command, name: 'remove' };
    activeRetirement.plan[0] = {
      ...activeRetirement.plan[0]!,
      coverage: 'retirement',
      action: 'retire-orphan',
    };
    activeRetirement.outcomes[0] = {
      ...activeRetirement.outcomes[0]!,
      coverage: 'retirement',
      action: 'retire-orphan',
      resourceState: 'present',
      activationState: 'active-conforming',
    };

    expect([absentInstall, activeRetirement].map((report) => {
      try {
        parseLifecycleReport(report);
        return 'accepted';
      } catch (error) {
        return (error as LifecycleReportValidationError).reason.code;
      }
    })).toEqual(['protocol.contradictory-outcome', 'protocol.contradictory-outcome']);
  });

  test('keeps retained-prior and disabled containment as failed desired operations with pair-local reasons', () => {
    const retained = validReport();
    const capabilityReason = {
      category: 'capability',
      code: 'capability.unsupported',
      diagnostic: 'candidate route cannot preserve required semantics',
      capabilityId: 'commands',
      evidenceId: null,
    } as const;
    retained.plan[0] = { ...retained.plan[0]!, action: 'retain-prior' };
    retained.outcomes[0] = {
      ...retained.outcomes[0]!,
      action: 'retain-prior',
      result: 'failed',
      resourceState: 'retained',
      activationState: 'retained-prior',
      changed: false,
      reason: capabilityReason,
    };
    retained.summary = {
      ...retained.summary,
      result: 'incomplete',
      mutationStarted: false,
      changed: false,
      failureCategory: 'capability',
      reason: null,
    };

    const disabled = validReport();
    const readbackReason = {
      category: 'readback',
      code: 'readback.mismatch',
      diagnostic: 'owned activation is nonconforming and was disabled',
      capabilityId: null,
      evidenceId: null,
    } as const;
    disabled.plan[0] = { ...disabled.plan[0]!, action: 'disable-nonconforming' };
    disabled.outcomes[0] = {
      ...disabled.outcomes[0]!,
      action: 'disable-nonconforming',
      result: 'failed',
      resourceState: 'retained',
      activationState: 'inactive',
      reason: readbackReason,
    };
    disabled.summary = {
      ...disabled.summary,
      result: 'incomplete',
      failureCategory: 'readback',
      reason: null,
    };

    const convergedRetained = {
      ...retained,
      summary: { ...retained.summary, result: 'converged', failureCategory: null, reason: null },
    } satisfies LifecycleReport;
    const convergedDisabled = {
      ...disabled,
      summary: { ...disabled.summary, result: 'converged', failureCategory: null, reason: null },
    } satisfies LifecycleReport;

    expect(parseLifecycleReport(retained)).toEqual(retained);
    expect(parseLifecycleReport(disabled)).toEqual(disabled);
    expect([convergedRetained, convergedDisabled].map((report) => {
      try {
        parseLifecycleReport(report);
        return 'accepted';
      } catch (error) {
        return (error as LifecycleReportValidationError).reason.code;
      }
    })).toEqual(['protocol.contradictory-outcome', 'protocol.contradictory-outcome']);

    const falselySuccessfulContainment: LifecycleReport = {
      ...retained,
      outcomes: [{ ...retained.outcomes[0]!, result: 'succeeded', reason: null }],
      summary: {
        ...retained.summary,
        result: 'converged',
        terminalPhase: 'complete',
        failureCategory: null,
        reason: null,
      },
    };
    let containmentDiagnostic = '';
    try { parseLifecycleReport(falselySuccessfulContainment); }
    catch (error) { containmentDiagnostic = (error as Error).message; }
    expect(containmentDiagnostic).toContain('must fail the desired operation');

    const multiPair: LifecycleReport = {
      ...retained,
      command: { ...retained.command, sourceSnapshots: [...retained.command.sourceSnapshots] },
      plan: [...retained.plan],
      outcomes: [...retained.outcomes],
      summary: { ...retained.summary },
    };
    const secondScope = scope('codex');
    multiPair.plan.push({
      ...disabled.plan[0]!,
      operationId: 'op-2',
      scope: secondScope,
    });
    multiPair.outcomes.push({
      ...disabled.outcomes[0]!,
      operationId: 'op-2',
      scope: secondScope,
    });
    multiPair.summary = { ...multiPair.summary, mutationStarted: true, changed: true };
    expect(serializeLegacyInstallOutcomes(parseLifecycleReport(multiPair))).toEqual([
      {
        plugin: 'addy',
        target: 'dcode',
        status: 'unsupported',
        dryRun: false,
        diagnostic: 'candidate route cannot preserve required semantics',
        nativeId: 'addy@personal',
        action: 'update',
      },
      {
        plugin: 'addy',
        target: 'codex',
        status: 'failed',
        dryRun: false,
        diagnostic: 'owned activation is nonconforming and was disabled',
        nativeId: 'addy@personal',
        action: 'update',
      },
    ]);
  });

  test('rejects potentially changed work when mutation did not start', () => {
    const runtimeReason = {
      category: 'runtime',
      code: 'runtime.operation-failed',
      diagnostic: 'native boundary failed',
      capabilityId: null,
      evidenceId: null,
    } as const;
    const reportFor = (result: 'failed' | 'not-attempted'): LifecycleReport => {
      const report = validReport();
      report.outcomes[0] = {
        ...report.outcomes[0]!,
        result,
        resourceState: 'potentially-changed',
        activationState: 'unknown',
        changed: false,
        reason: runtimeReason,
      };
      report.summary = {
        ...report.summary,
        result: 'incomplete',
        mutationStarted: false,
        changed: false,
        failureCategory: 'runtime',
        reason: runtimeReason,
      };
      return report;
    };

    expect(['not-attempted', 'failed'].map((result) => {
      try {
        parseLifecycleReport(reportFor(result as 'failed' | 'not-attempted'));
        return 'accepted';
      } catch (error) {
        return (error as LifecycleReportValidationError).reason.code;
      }
    })).toEqual(['protocol.contradictory-outcome', 'protocol.contradictory-outcome']);
  });

  test('rejects an aggregate failure category unrelated to every failed pair', () => {
    const report = validReport();
    const runtimeReason = {
      category: 'runtime',
      code: 'runtime.operation-failed',
      diagnostic: 'native command failed',
      capabilityId: null,
      evidenceId: null,
    } as const;
    report.outcomes[0] = {
      ...report.outcomes[0]!,
      result: 'failed',
      resourceState: 'unknown',
      activationState: 'unknown',
      changed: false,
      reason: runtimeReason,
    };
    report.summary = {
      ...report.summary,
      result: 'incomplete',
      mutationStarted: false,
      changed: false,
      failureCategory: 'capability',
      reason: null,
    };

    let summaryCode = 'accepted';
    try {
      parseLifecycleReport(report);
    } catch (error) {
      summaryCode = (error as LifecycleReportValidationError).reason.code;
    }
    expect(summaryCode).toBe('protocol.contradictory-outcome');
  });

  test('pins distinct stable reason categories and codes', () => {
    expect({ categories: LIFECYCLE_REASON_CATEGORIES, codes: LIFECYCLE_REASON_CODES }).toEqual({
      categories: ['capability', 'internal', 'protocol', 'runtime', 'readback', 'recovery', 'usage'],
      codes: [
        'capability.unsupported',
        'capability.unverified',
        'internal.defect',
        'internal.invariant',
        'internal.corrupt-state',
        'internal.ambiguous-ownership',
        'protocol.invalid-report',
        'protocol.missing-outcome',
        'protocol.duplicate-outcome',
        'protocol.unexpected-outcome',
        'protocol.contradictory-outcome',
        'runtime.operation-failed',
        'readback.failed',
        'readback.mismatch',
        'recovery.required',
        'recovery.failed',
        'usage.invalid-argument',
        'usage.invalid-selection',
      ],
    });

    expect(createLifecycleReason('capability', 'capability.unsupported', 'commands are unavailable', 'commands')).toEqual({
      category: 'capability',
      code: 'capability.unsupported',
      diagnostic: 'commands are unavailable',
      capabilityId: 'commands',
      evidenceId: null,
    });
    if (false) {
      // @ts-expect-error A reason code cannot widen the category inferred from the first argument.
      createLifecycleReason('capability', 'runtime.operation-failed', 'mismatch', 'commands');
      // @ts-expect-error Capability reasons require a capability identifier.
      createLifecycleReason('capability', 'capability.unsupported', 'missing identifier');
      // @ts-expect-error Non-capability reasons cannot carry capability fields.
      createLifecycleReason('runtime', 'runtime.operation-failed', 'unexpected field', 'commands');
    }
  });

  test('rejects malformed enum values and mismatched reason category codes', () => {
    const unknownAction = validReport() as unknown as Record<string, any>;
    unknownAction.plan[0].action = 'ship';
    unknownAction.outcomes[0].action = 'ship';

    const mismatchedReason = validReport() as unknown as Record<string, any>;
    mismatchedReason.outcomes[0].result = 'failed';
    mismatchedReason.outcomes[0].reason = {
      category: 'capability',
      code: 'runtime.operation-failed',
      diagnostic: 'wrong category',
      capabilityId: 'commands',
      evidenceId: null,
    };
    mismatchedReason.summary = {
      ...mismatchedReason.summary,
      result: 'incomplete',
      failureCategory: 'capability',
      reason: mismatchedReason.outcomes[0].reason,
    };

    const blankDiagnostic = validReport() as unknown as Record<string, any>;
    blankDiagnostic.outcomes[0] = {
      ...blankDiagnostic.outcomes[0],
      result: 'failed',
      resourceState: 'unknown',
      activationState: 'unknown',
      changed: false,
      reason: {
        category: 'runtime',
        code: 'runtime.operation-failed',
        diagnostic: '   ',
        capabilityId: null,
        evidenceId: null,
      },
    };
    blankDiagnostic.summary = {
      ...blankDiagnostic.summary,
      result: 'incomplete',
      terminalPhase: 'apply',
      mutationStarted: false,
      changed: false,
      failureCategory: 'runtime',
      reason: blankDiagnostic.outcomes[0].reason,
    };

    expect([unknownAction, mismatchedReason, blankDiagnostic].map((report) => {
      try {
        parseLifecycleReport(report);
        return 'accepted';
      } catch (error) {
        return (error as LifecycleReportValidationError).reason.code;
      }
    })).toEqual(['protocol.invalid-report', 'protocol.invalid-report', 'protocol.invalid-report']);
  });

  test('rejects unknown fields at every nested public JSON object', () => {
    const clone = (): Record<string, any> => JSON.parse(JSON.stringify(validReport())) as Record<string, any>;
    const cases: Array<Record<string, any>> = [];

    const add = (mutate: (report: Record<string, any>) => void): void => {
      const report = clone();
      mutate(report);
      cases.push(report);
    };

    add(report => { report.unexpected = true; });
    add(report => { report.command.unexpected = true; });
    add(report => { report.command.sourceSnapshots[0].unexpected = true; });
    add(report => { report.command.sourceSnapshots[0].reference.unexpected = true; });
    add(report => { report.command.sourceSnapshots[0].reference.binding.credential = 'secret-value'; });
    add(report => { report.plan[0].unexpected = true; });
    add(report => { report.plan[0].scope.unexpected = true; });
    add(report => { report.plan[0].scope.source.credential = 'secret-value'; });
    add(report => { report.plan[0].scope.target.context = { authorization: 'secret-value' }; });
    add(report => { report.outcomes[0].unexpected = true; });
    add(report => { report.outcomes[0].scope.unexpected = true; });
    add(report => { report.summary.unexpected = true; });

    const outcomeReason = clone();
    const runtimeReason = {
      category: 'runtime',
      code: 'runtime.operation-failed',
      diagnostic: 'failed',
      capabilityId: null,
      evidenceId: null,
    };
    outcomeReason.outcomes[0] = {
      ...outcomeReason.outcomes[0],
      result: 'failed',
      changed: false,
      reason: { ...runtimeReason, unexpected: true },
    };
    outcomeReason.summary = {
      ...outcomeReason.summary,
      result: 'incomplete',
      mutationStarted: false,
      changed: false,
      failureCategory: 'runtime',
      reason: runtimeReason,
    };
    cases.push(outcomeReason);

    const summaryReason = clone();
    summaryReason.outcomes[0] = {
      ...summaryReason.outcomes[0],
      result: 'failed',
      changed: false,
      reason: runtimeReason,
    };
    summaryReason.summary = {
      ...summaryReason.summary,
      result: 'incomplete',
      mutationStarted: false,
      changed: false,
      failureCategory: 'runtime',
      reason: { ...runtimeReason, unexpected: true },
    };
    cases.push(summaryReason);

    expect(cases.map((report) => {
      try {
        parseLifecycleReport(report);
        return 'accepted';
      } catch (error) {
        return (error as LifecycleReportValidationError).reason.code;
      }
    })).toEqual(cases.map(() => 'protocol.invalid-report'));
  });

  test('requires a canonical scope for pair rows and keeps command-global failures in the summary', () => {
    const malformedPair = validReport() as unknown as Record<string, any>;
    malformedPair.plan[0].scope = null;
    malformedPair.outcomes[0].scope = null;

    const forgedScope = validReport();
    forgedScope.plan[0] = { ...forgedScope.plan[0]!, scope: { ...forgedScope.plan[0]!.scope, id: 'scope-v1-forged' } };
    forgedScope.outcomes[0] = { ...forgedScope.outcomes[0]!, scope: forgedScope.plan[0]!.scope };

    const snapshotMismatch = validReport();
    const otherScope = createDeploymentScopeIdentity({ kind: 'local', locator: '/sources/other' }, { kind: 'dcode', instance: 'default' });
    snapshotMismatch.plan[0] = { ...snapshotMismatch.plan[0]!, scope: otherScope };
    snapshotMismatch.outcomes[0] = { ...snapshotMismatch.outcomes[0]!, scope: otherScope };

    const unsafeSource = validReport() as unknown as Record<string, any>;
    unsafeSource.command.sourceSnapshots[0].reference.binding = {
      kind: 'git',
      locator: 'https://user:secret@example.test/repo.git',
      ref: 'main',
    };

    const commandFailure = validReport();
    commandFailure.command = { ...commandFailure.command, name: 'update' };
    const defect = {
      category: 'internal',
      code: 'internal.defect',
      diagnostic: 'planner invariant failed before pair planning',
      capabilityId: null,
      evidenceId: null,
    } as const;
    commandFailure.plan = [];
    commandFailure.outcomes = [];
    commandFailure.summary = {
      result: 'incomplete',
      terminalPhase: 'preflight',
      mutationStarted: false,
      changed: false,
      failureCategory: 'internal',
      reason: defect,
      recoveryId: null,
      readbackId: null,
    };

    expect([malformedPair, forgedScope, snapshotMismatch, unsafeSource].map((report) => {
      try {
        parseLifecycleReport(report);
        return 'accepted';
      } catch (error) {
        return (error as LifecycleReportValidationError).reason.code;
      }
    })).toEqual([
      'protocol.invalid-report',
      'protocol.invalid-report',
      'protocol.invalid-report',
      'protocol.invalid-report',
    ]);
    expect(parseLifecycleReport(commandFailure)).toEqual(commandFailure);
    expect(serializeLegacyInstallOutcomes(parseLifecycleReport(commandFailure))).toEqual([{
      plugin: '*',
      target: '*',
      status: 'failed',
      dryRun: false,
      diagnostic: 'planner invariant failed before pair planning',
      action: 'update',
    }]);
  });

  test('freezes success, incomplete, and usage exit semantics at 0, 1, and 2', () => {
    const incomplete = validReport();
    const runtimeReason = {
      category: 'runtime',
      code: 'runtime.operation-failed',
      diagnostic: 'native command failed',
      capabilityId: null,
      evidenceId: null,
    } as const;
    incomplete.outcomes[0] = {
      ...incomplete.outcomes[0]!,
      result: 'failed',
      resourceState: 'unknown',
      activationState: 'unknown',
      changed: false,
      reason: runtimeReason,
    };
    incomplete.summary = {
      ...incomplete.summary,
      result: 'incomplete',
      terminalPhase: 'apply',
      mutationStarted: false,
      changed: false,
      failureCategory: 'runtime',
      reason: runtimeReason,
    };

    const usage = validReport();
    const usageReason = {
      category: 'usage',
      code: 'usage.invalid-argument',
      diagnostic: 'missing source',
      capabilityId: null,
      evidenceId: null,
    } as const;
    usage.plan = [];
    usage.outcomes = [];
    usage.summary = {
      result: 'usage-error',
      terminalPhase: 'parse',
      mutationStarted: false,
      changed: false,
      failureCategory: 'usage',
      reason: usageReason,
      recoveryId: null,
      readbackId: null,
    };

    expect({
      constants: LIFECYCLE_EXIT_CODES,
      converged: exitCodeForLifecycleReport(parseLifecycleReport(validReport())),
      incomplete: exitCodeForLifecycleReport(parseLifecycleReport(incomplete)),
      usage: exitCodeForLifecycleReport(parseLifecycleReport(usage)),
    }).toEqual({ constants: { success: 0, incomplete: 1, usage: 2 }, converged: 0, incomplete: 1, usage: 2 });

    const premature = validReport();
    premature.summary = { ...premature.summary, terminalPhase: 'apply' };
    let prematureDiagnostic = '';
    try { parseLifecycleReport(premature); }
    catch (error) { prematureDiagnostic = (error as Error).message; }
    expect(prematureDiagnostic).toContain('must reach the complete phase');
  });

  test('rejects usage reasons outside an outcome-free parse failure', () => {
    const usageReason = {
      category: 'usage',
      code: 'usage.invalid-selection',
      diagnostic: 'unknown target',
      capabilityId: null,
      evidenceId: null,
    } as const;

    const commandGlobalIncomplete = validReport();
    commandGlobalIncomplete.plan = [];
    commandGlobalIncomplete.outcomes = [];
    commandGlobalIncomplete.summary = {
      result: 'incomplete',
      terminalPhase: 'preflight',
      mutationStarted: false,
      changed: false,
      failureCategory: 'usage',
      reason: usageReason,
      recoveryId: null,
      readbackId: null,
    };

    const pairUsage = validReport();
    pairUsage.outcomes[0] = {
      ...pairUsage.outcomes[0]!,
      result: 'failed',
      resourceState: 'unknown',
      activationState: 'unknown',
      changed: false,
      reason: usageReason,
    };
    pairUsage.summary = {
      ...commandGlobalIncomplete.summary,
      terminalPhase: 'apply',
    };

    const wrongPhase = validReport();
    wrongPhase.plan = [];
    wrongPhase.outcomes = [];
    wrongPhase.summary = {
      ...commandGlobalIncomplete.summary,
      result: 'usage-error',
      terminalPhase: 'preflight',
    };

    expect([commandGlobalIncomplete, pairUsage, wrongPhase].map((report) => {
      try {
        parseLifecycleReport(report);
        return 'accepted';
      } catch (error) {
        return (error as LifecycleReportValidationError).reason.code;
      }
    })).toEqual([
      'protocol.contradictory-outcome',
      'protocol.contradictory-outcome',
      'protocol.contradictory-outcome',
    ]);
  });

  test('serializes the legacy InstallOutcome array only through the named transition adapter', () => {
    const report = validReport();
    report.command = { ...report.command, name: 'add', dryRun: true };
    report.outcomes[0] = { ...report.outcomes[0]!, changed: false };
    report.summary = { ...report.summary, mutationStarted: false, changed: false };

    expect(serializeLegacyInstallOutcomes(parseLifecycleReport(report))).toEqual([{
      plugin: 'addy',
      target: 'dcode',
      status: 'installed',
      dryRun: true,
      nativeId: 'addy@personal',
      action: 'install',
    }]);
  });

  test('legacy serialization keeps a command-global failure after successful pair outcomes', () => {
    const report = validReport();
    const defect = {
      category: 'internal',
      code: 'internal.invariant',
      diagnostic: 'another detected target has no owned install record',
      capabilityId: null,
      evidenceId: null,
    } as const;
    report.summary = {
      ...report.summary,
      result: 'incomplete',
      failureCategory: 'internal',
      reason: defect,
    };

    expect(serializeLegacyInstallOutcomes(parseLifecycleReport(report))).toEqual([
      {
        plugin: 'addy',
        target: 'dcode',
        status: 'installed',
        dryRun: false,
        nativeId: 'addy@personal',
        action: 'install',
      },
      {
        plugin: '*',
        target: '*',
        status: 'failed',
        dryRun: false,
        diagnostic: 'another detected target has no owned install record',
        action: 'update',
      },
    ]);
  });
});
