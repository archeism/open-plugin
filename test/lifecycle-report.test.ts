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
      actions: ['install', 'update', 'unchanged', 'route-migrate', 'disable-nonconforming', 'retain-prior', 'retire-orphan', 'not-attempted'],
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
      readbackId: 'op-1',
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
    multiPair.summary = { ...multiPair.summary, mutationStarted: true, changed: true, readbackId: 'op-2' };
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

  test('keeps preflight refusal actions distinct from later runtime-skipped results', () => {
    const preflight = validReport();
    const capabilityReason = {
      category: 'capability',
      code: 'capability.unsupported',
      diagnostic: 'target cannot deliver the required package semantics',
      capabilityId: 'install',
      evidenceId: null,
    } as const;
    preflight.plan[0] = { ...preflight.plan[0]!, action: 'not-attempted', route: 'none' };
    preflight.outcomes[0] = {
      ...preflight.outcomes[0]!,
      action: 'not-attempted',
      route: 'none',
      result: 'failed',
      resourceState: 'unknown',
      activationState: 'unknown',
      changed: false,
      reason: capabilityReason,
    };
    preflight.summary = {
      ...preflight.summary,
      result: 'incomplete',
      terminalPhase: 'preflight',
      mutationStarted: false,
      changed: false,
      failureCategory: 'capability',
      reason: null,
    };

    const stopped = validReport();
    const runtimeReason = {
      category: 'runtime',
      code: 'runtime.operation-failed',
      diagnostic: 'not attempted after an earlier operation failed',
      capabilityId: null,
      evidenceId: null,
    } as const;
    stopped.plan[0] = { ...stopped.plan[0]!, action: 'update' };
    stopped.outcomes[0] = {
      ...stopped.outcomes[0]!,
      action: 'update',
      result: 'not-attempted',
      resourceState: 'unknown',
      activationState: 'unknown',
      changed: false,
      reason: runtimeReason,
    };
    stopped.summary = {
      ...stopped.summary,
      result: 'incomplete',
      terminalPhase: 'apply',
      mutationStarted: true,
      changed: false,
      failureCategory: 'runtime',
      reason: runtimeReason,
    };

    expect(parseLifecycleReport(preflight)).toEqual(preflight);
    expect(parseLifecycleReport(stopped)).toEqual(stopped);

    const retirementPreflight: LifecycleReport = {
      ...preflight,
      command: { ...preflight.command, name: 'remove' },
      plan: [{ ...preflight.plan[0]!, coverage: 'retirement' }],
      outcomes: [{ ...preflight.outcomes[0]!, coverage: 'retirement' }],
    };
    expect(parseLifecycleReport(retirementPreflight)).toEqual(retirementPreflight);
  });

  test('rejects cross-field reports that lie about mutation, recovery, or readback', () => {
    const runtimeReason = {
      category: 'runtime',
      code: 'runtime.operation-failed',
      diagnostic: 'native operation failed',
      capabilityId: null,
      evidenceId: null,
    } as const;
    const recoveryReason = {
      category: 'recovery',
      code: 'recovery.required',
      diagnostic: 'durable pending intent requires recovery',
      capabilityId: null,
      evidenceId: null,
    } as const;
    const readbackReason = {
      category: 'readback',
      code: 'readback.failed',
      diagnostic: 'native readback failed',
      capabilityId: null,
      evidenceId: null,
    } as const;

    const routeNoneSuccess = validReport();
    routeNoneSuccess.plan[0] = { ...routeNoneSuccess.plan[0]!, route: 'none' };
    routeNoneSuccess.outcomes[0] = { ...routeNoneSuccess.outcomes[0]!, route: 'none', changed: false };
    routeNoneSuccess.summary = { ...routeNoneSuccess.summary, mutationStarted: false, changed: false };

    const disableWithoutMutation = validReport();
    disableWithoutMutation.plan[0] = { ...disableWithoutMutation.plan[0]!, action: 'disable-nonconforming' };
    disableWithoutMutation.outcomes[0] = {
      ...disableWithoutMutation.outcomes[0]!,
      action: 'disable-nonconforming',
      result: 'failed',
      resourceState: 'retained',
      activationState: 'inactive',
      changed: false,
      reason: runtimeReason,
    };
    disableWithoutMutation.summary = {
      ...disableWithoutMutation.summary,
      result: 'incomplete',
      terminalPhase: 'apply',
      mutationStarted: false,
      changed: false,
      failureCategory: 'runtime',
      reason: null,
    };

    const pendingWithoutRecovery = validReport();
    pendingWithoutRecovery.outcomes[0] = {
      ...pendingWithoutRecovery.outcomes[0]!,
      result: 'pending',
      resourceState: 'potentially-changed',
      activationState: 'unknown',
      changed: false,
      reason: recoveryReason,
    };
    pendingWithoutRecovery.summary = {
      ...pendingWithoutRecovery.summary,
      result: 'incomplete',
      terminalPhase: 'apply',
      changed: false,
      failureCategory: 'recovery',
      reason: recoveryReason,
      recoveryId: null,
    };
    const pendingWithWrongRecovery: LifecycleReport = {
      ...pendingWithoutRecovery,
      summary: { ...pendingWithoutRecovery.summary, recoveryId: 'not-the-pending-operation' },
    };
    const pendingPreflightRefusal: LifecycleReport = {
      ...pendingWithoutRecovery,
      plan: [{ ...pendingWithoutRecovery.plan[0]!, action: 'not-attempted', route: 'none' }],
      outcomes: [{
        ...pendingWithoutRecovery.outcomes[0]!,
        action: 'not-attempted',
        route: 'none',
        resourceState: 'unknown',
      }],
      summary: {
        ...pendingWithoutRecovery.summary,
        terminalPhase: 'preflight',
        mutationStarted: false,
        recoveryId: 'op-1',
      },
    };

    const readbackWithoutIdentity = validReport();
    readbackWithoutIdentity.outcomes[0] = {
      ...readbackWithoutIdentity.outcomes[0]!,
      result: 'failed',
      resourceState: 'potentially-changed',
      activationState: 'unknown',
      changed: false,
      reason: readbackReason,
    };
    readbackWithoutIdentity.summary = {
      ...readbackWithoutIdentity.summary,
      result: 'incomplete',
      terminalPhase: 'readback',
      changed: false,
      failureCategory: 'readback',
      reason: readbackReason,
      readbackId: null,
    };
    const readbackWithWrongIdentity: LifecycleReport = {
      ...readbackWithoutIdentity,
      summary: { ...readbackWithoutIdentity.summary, readbackId: 'not-the-readback-operation' },
    };
    const ghostRecovery = validReport();
    ghostRecovery.summary.recoveryId = 'op-1';
    const ghostReadback = validReport();
    ghostReadback.summary.readbackId = 'op-1';

    const earlyMutationReports = (['parse', 'resolve', 'freeze', 'preflight'] as const).map((terminalPhase) => {
      const report = validReport();
      report.outcomes[0] = {
        ...report.outcomes[0]!,
        result: 'failed',
        resourceState: 'potentially-changed',
        activationState: 'unknown',
        reason: runtimeReason,
      };
      report.summary = {
        ...report.summary,
        result: 'incomplete',
        terminalPhase,
        failureCategory: 'runtime',
        reason: runtimeReason,
      };
      return report;
    });

    expect([
      routeNoneSuccess,
      disableWithoutMutation,
      pendingWithoutRecovery,
      pendingWithWrongRecovery,
      pendingPreflightRefusal,
      readbackWithoutIdentity,
      readbackWithWrongIdentity,
      ghostRecovery,
      ghostReadback,
      ...earlyMutationReports,
    ].map((report) => {
      try {
        parseLifecycleReport(report);
        return 'accepted';
      } catch (error) {
        return (error as LifecycleReportValidationError).reason.code;
      }
    })).toEqual(Array(13).fill('protocol.contradictory-outcome'));
  });

  test('requires recovery.required to identify pending mutated work', () => {
    const recoveryReason = {
      category: 'recovery',
      code: 'recovery.required',
      diagnostic: 'durable pending intent requires recovery',
      capabilityId: null,
      evidenceId: null,
    } as const;
    const recoveryReport = (): LifecycleReport => {
      const report = validReport();
      report.outcomes[0] = {
        ...report.outcomes[0]!,
        result: 'pending',
        resourceState: 'unknown',
        activationState: 'unknown',
        changed: false,
        reason: recoveryReason,
      };
      report.summary = {
        ...report.summary,
        result: 'incomplete',
        terminalPhase: 'finalize',
        mutationStarted: true,
        changed: false,
        failureCategory: 'recovery',
        reason: null,
        recoveryId: 'op-1',
      };
      return report;
    };

    const noMutation = recoveryReport();
    noMutation.summary.mutationStarted = false;
    const noPendingRecovery = recoveryReport();
    const runtimeReason = {
      category: 'runtime',
      code: 'runtime.operation-failed',
      diagnostic: 'native operation failed',
      capabilityId: null,
      evidenceId: null,
    } as const;
    noPendingRecovery.outcomes[0] = {
      ...noPendingRecovery.outcomes[0]!,
      result: 'failed',
      reason: runtimeReason,
    };

    expect([noMutation, noPendingRecovery].map((report) => {
      try {
        parseLifecycleReport(report);
        return 'accepted';
      } catch (error) {
        return (error as LifecycleReportValidationError).reason.code;
      }
    })).toEqual([
      'protocol.contradictory-outcome',
      'protocol.contradictory-outcome',
    ]);
    const pending = recoveryReport();
    expect(parseLifecycleReport(pending)).toEqual(pending);
  });

  test('keeps durable readback failures pending with orthogonal readback and recovery identities', () => {
    const report = validReport();
    const readbackReason = {
      category: 'readback',
      code: 'readback.mismatch',
      diagnostic: 'native readback did not find the applied representation',
      capabilityId: null,
      evidenceId: null,
    } as const;
    report.outcomes[0] = {
      ...report.outcomes[0]!,
      result: 'pending',
      resourceState: 'potentially-changed',
      activationState: 'unknown',
      reason: readbackReason,
    };
    report.summary = {
      ...report.summary,
      result: 'incomplete',
      terminalPhase: 'readback',
      failureCategory: 'readback',
      reason: readbackReason,
      recoveryId: 'op-1',
      readbackId: 'op-1',
    };

    expect(parseLifecycleReport(report)).toEqual(report);

    const missingRecoveryIdentity: LifecycleReport = {
      ...report,
      summary: { ...report.summary, recoveryId: null },
    };
    let missingRecoveryDiagnostic = '';
    try { parseLifecycleReport(missingRecoveryIdentity); }
    catch (error) { missingRecoveryDiagnostic = (error as Error).message; }
    expect(missingRecoveryDiagnostic).toContain('recoveryId');
  });

  test('rejects unresolved readback as terminal while allowing a proven-safe terminal failure', () => {
    const readbackReason = {
      category: 'readback',
      code: 'readback.mismatch',
      diagnostic: 'native readback did not establish a safe terminal state',
      capabilityId: null,
      evidenceId: null,
    } as const;
    const unresolved = validReport();
    unresolved.outcomes[0] = {
      ...unresolved.outcomes[0]!,
      result: 'failed',
      resourceState: 'potentially-changed',
      activationState: 'unknown',
      reason: readbackReason,
    };
    unresolved.summary = {
      ...unresolved.summary,
      result: 'incomplete',
      terminalPhase: 'readback',
      failureCategory: 'readback',
      reason: readbackReason,
      recoveryId: null,
      readbackId: 'op-1',
    };

    let unresolvedDiagnostic = '';
    try { parseLifecycleReport(unresolved); }
    catch (error) { unresolvedDiagnostic = (error as Error).message; }
    expect(unresolvedDiagnostic).toContain('pending');

    const safeTerminal: LifecycleReport = {
      ...unresolved,
      outcomes: [{
        ...unresolved.outcomes[0]!,
        resourceState: 'retained',
        activationState: 'retained-prior',
        changed: false,
      }],
      summary: {
        ...unresolved.summary,
        changed: false,
      },
    };
    expect(parseLifecycleReport(safeTerminal)).toEqual(safeTerminal);
  });

  test('distinguishes pending recovery requirements from terminal recovery failures', () => {
    const recoveryReport = (code: 'recovery.required' | 'recovery.failed', result: 'pending' | 'failed'): LifecycleReport => {
      const report = validReport();
      const recoveryReason = {
        category: 'recovery',
        code,
        diagnostic: code === 'recovery.required' ? 'recovery remains pending' : 'recovery attempt failed',
        capabilityId: null,
        evidenceId: null,
      } as const;
      report.outcomes[0] = {
        ...report.outcomes[0]!,
        result,
        resourceState: code === 'recovery.required' ? 'potentially-changed' : 'unknown',
        activationState: 'unknown',
        reason: recoveryReason,
      };
      report.summary = {
        ...report.summary,
        result: 'incomplete',
        terminalPhase: 'finalize',
        failureCategory: 'recovery',
        reason: recoveryReason,
        recoveryId: 'op-1',
      };
      return report;
    };

    const pendingRequired = recoveryReport('recovery.required', 'pending');
    const failedRequired = recoveryReport('recovery.required', 'failed');
    const failedRecovery = recoveryReport('recovery.failed', 'failed');
    const pendingFailedRecovery = recoveryReport('recovery.failed', 'pending');

    expect(parseLifecycleReport(pendingRequired)).toEqual(pendingRequired);
    expect(parseLifecycleReport(failedRecovery)).toEqual(failedRecovery);
    expect([failedRequired, pendingFailedRecovery].map((report) => {
      try {
        parseLifecycleReport(report);
        return 'accepted';
      } catch (error) {
        return (error as LifecycleReportValidationError).reason.code;
      }
    })).toEqual([
      'protocol.contradictory-outcome',
      'protocol.contradictory-outcome',
    ]);
  });

  test('requires an exact native identity for every converged Desired outcome', () => {
    const missingNativeIdentity = validReport();
    missingNativeIdentity.plan[0] = { ...missingNativeIdentity.plan[0]!, nativeId: null };
    missingNativeIdentity.outcomes[0] = { ...missingNativeIdentity.outcomes[0]!, nativeId: null };

    let missingNativeDiagnostic = '';
    try { parseLifecycleReport(missingNativeIdentity); }
    catch (error) { missingNativeDiagnostic = (error as Error).message; }
    expect(missingNativeDiagnostic).toContain('native identity');
  });

  test('previews disable-nonconforming without claiming the containment mutation ran', () => {
    const report = validReport();
    const capabilityReason = {
      category: 'capability',
      code: 'capability.unsupported',
      diagnostic: 'the target cannot preserve the required invocation policy',
      capabilityId: 'invocation-policy',
      evidenceId: null,
    } as const;
    report.command = { ...report.command, dryRun: true };
    report.plan[0] = { ...report.plan[0]!, action: 'disable-nonconforming' };
    report.outcomes[0] = {
      ...report.outcomes[0]!,
      action: 'disable-nonconforming',
      result: 'failed',
      resourceState: 'retained',
      activationState: 'active-nonconforming',
      changed: false,
      reason: capabilityReason,
    };
    report.summary = {
      ...report.summary,
      result: 'incomplete',
      terminalPhase: 'preflight',
      mutationStarted: false,
      changed: false,
      failureCategory: 'capability',
      reason: null,
    };

    expect(parseLifecycleReport(report)).toEqual(report);
  });

  test('rejects capability outcomes that imply pair mutation except applied disablement containment', () => {
    const capabilityReason = {
      category: 'capability',
      code: 'capability.unsupported',
      diagnostic: 'target cannot preserve the required semantics',
      capabilityId: 'commands',
      evidenceId: null,
    } as const;
    const capabilityReport = (): LifecycleReport => {
      const report = validReport();
      report.plan[0] = { ...report.plan[0]!, action: 'not-attempted', route: 'none' };
      report.outcomes[0] = {
        ...report.outcomes[0]!,
        action: 'not-attempted',
        route: 'none',
        result: 'failed',
        resourceState: 'unknown',
        activationState: 'unknown',
        changed: false,
        reason: capabilityReason,
      };
      report.summary = {
        ...report.summary,
        result: 'incomplete',
        terminalPhase: 'apply',
        mutationStarted: true,
        changed: false,
        failureCategory: 'capability',
        reason: null,
      };
      return report;
    };

    const potentiallyChangedRefusal = capabilityReport();
    potentiallyChangedRefusal.outcomes[0] = {
      ...potentiallyChangedRefusal.outcomes[0]!,
      resourceState: 'potentially-changed',
    };
    const knownTerminalRefusal = capabilityReport();
    knownTerminalRefusal.outcomes[0] = {
      ...knownTerminalRefusal.outcomes[0]!,
      resourceState: 'present',
      activationState: 'active-conforming',
    };
    const changedUpdate = capabilityReport();
    changedUpdate.plan[0] = { ...changedUpdate.plan[0]!, action: 'update', route: 'managed' };
    changedUpdate.outcomes[0] = {
      ...changedUpdate.outcomes[0]!,
      action: 'update',
      route: 'managed',
      resourceState: 'potentially-changed',
      changed: true,
    };
    changedUpdate.summary.changed = true;
    const preMutationUpdate = capabilityReport();
    preMutationUpdate.plan[0] = { ...preMutationUpdate.plan[0]!, action: 'update', route: 'managed' };
    preMutationUpdate.outcomes[0] = {
      ...preMutationUpdate.outcomes[0]!,
      action: 'update',
      route: 'managed',
    };

    expect([potentiallyChangedRefusal, knownTerminalRefusal, changedUpdate, preMutationUpdate].map((report) => {
      try {
        parseLifecycleReport(report);
        return 'accepted';
      } catch (error) {
        return (error as LifecycleReportValidationError).reason.code;
      }
    })).toEqual(Array(4).fill('protocol.contradictory-outcome'));

    const appliedDisablement = capabilityReport();
    appliedDisablement.plan[0] = { ...appliedDisablement.plan[0]!, action: 'disable-nonconforming', route: 'managed' };
    appliedDisablement.outcomes[0] = {
      ...appliedDisablement.outcomes[0]!,
      action: 'disable-nonconforming',
      route: 'managed',
      resourceState: 'retained',
      activationState: 'inactive',
      changed: true,
    };
    appliedDisablement.summary.changed = true;
    appliedDisablement.summary.readbackId = 'op-1';
    expect(parseLifecycleReport(appliedDisablement)).toEqual(appliedDisablement);
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
