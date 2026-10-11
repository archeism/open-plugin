import { executeLifecycle } from './executor';
import { exitCodeForLifecycleReport, parseLifecycleReport, type LifecycleReport } from './lifecycle-report';
import type { PlannerHost } from './planner';
import { planLifecycle } from './planner';
import type { SyncManifest } from './sync-manifest';

export interface FrozenLifecycleCommand {
  readonly manifest: SyncManifest;
  readonly dryRun: boolean;
  readonly hosts: readonly PlannerHost[];
  readonly now: string;
  readonly command?: 'add' | 'update' | 'remove';
}

export async function runFrozenLifecycle(command: FrozenLifecycleCommand): Promise<{
  readonly report: LifecycleReport;
  readonly exitCode: number;
}> {
  const plan = await planLifecycle({
    manifest: command.manifest,
    dryRun: command.dryRun,
    validatedAt: command.now,
    hosts: command.hosts,
    ...(command.command === undefined ? {} : { command: command.command }),
  });
  const executed = await executeLifecycle({
    plan,
    hosts: command.hosts,
    now: command.now,
  });
  const report = parseLifecycleReport(executed.report);
  return { report, exitCode: exitCodeForLifecycleReport(report) };
}
