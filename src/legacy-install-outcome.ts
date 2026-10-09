import type { LifecycleOperationOutcome, LifecycleReport } from './lifecycle-report';

/** One-release transition shape used only by `--legacy-json`. */
export type LegacyInstallStatus = 'installed' | 'unchanged' | 'unsupported' | 'unverified' | 'failed';

/** The pre-v1 mutation response. Do not use this as an execution model. */
export interface LegacyInstallOutcome {
  plugin: string;
  target: string;
  status: LegacyInstallStatus;
  dryRun: boolean;
  diagnostic?: string;
  nativeId?: string;
  action?: 'install' | 'update' | 'remove';
}

/** Serialize schema-v1 outcomes into the one-release compatibility array. */
export function serializeLegacyInstallOutcomes(report: LifecycleReport): LegacyInstallOutcome[] {
  const rows = report.outcomes.map((outcome) => ({
    plugin: outcome.package,
    target: outcome.scope.target.kind,
    status: legacyStatus(outcome),
    dryRun: report.command.dryRun,
    ...(outcome.reason === null ? {} : { diagnostic: outcome.reason.diagnostic }),
    ...(outcome.nativeId === null ? {} : { nativeId: outcome.nativeId }),
    action: legacyAction(report.command.name, outcome),
  }));
  if (report.summary.reason !== null && !report.outcomes.some((outcome) => sameReason(outcome.reason, report.summary.reason))) {
    rows.push({
      plugin: '*',
      target: '*',
      status: legacyFailureStatus(report.summary.reason.code),
      dryRun: report.command.dryRun,
      diagnostic: report.summary.reason.diagnostic,
      action: legacyCommandAction(report.command.name),
    });
  }
  return rows;
}

function sameReason(left: LifecycleOperationOutcome['reason'], right: LifecycleOperationOutcome['reason']): boolean {
  return left !== null && right !== null && left.category === right.category && left.code === right.code &&
    left.diagnostic === right.diagnostic && left.capabilityId === right.capabilityId && left.evidenceId === right.evidenceId;
}

function legacyStatus(outcome: LifecycleOperationOutcome): LegacyInstallStatus {
  if (outcome.result === 'succeeded') return outcome.action === 'unchanged' ? 'unchanged' : 'installed';
  return legacyFailureStatus(outcome.reason?.code);
}

function legacyFailureStatus(code: string | undefined): LegacyInstallStatus {
  if (code === 'capability.unsupported') return 'unsupported';
  if (code === 'capability.unverified') return 'unverified';
  return 'failed';
}

function legacyAction(command: LifecycleReport['command']['name'], outcome: LifecycleOperationOutcome): 'install' | 'update' | 'remove' {
  if (outcome.action === 'retire-orphan' || command === 'remove' || command === 'retire-source') return 'remove';
  if (outcome.action === 'install' || command === 'add') return 'install';
  return 'update';
}

function legacyCommandAction(command: LifecycleReport['command']['name']): 'install' | 'update' | 'remove' {
  if (command === 'remove' || command === 'retire-source') return 'remove';
  if (command === 'add') return 'install';
  return 'update';
}
