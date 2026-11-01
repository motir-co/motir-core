import type { TenantEcsTask } from './ecsClient';

// A container release's FARGATE USAGE (MOTIR-10009). Fargate bills each task's
// vCPU and memory for its life, and ECS keeps a stopped task listed only for a
// short while — so task lifetimes alone lose the tasks that stopped before the
// next look. The release's ACCRUAL, ONE SSM parameter per release, keeps every
// stopped task this module has seen: its start, stop and size. A HIGH-WATER
// MARK (the latest stop time counted, and the tasks stopped at that instant)
// makes a replayed sweep count no task twice.
//
// Usage over a window is the accrued tasks' and the running tasks' lives,
// each clipped to the window, times the task's own CPU and memory (the template
// took them from the size table). Past `MAX_ENTRIES` the oldest entries fold
// into one total, counted whole by any window that begins before it ends.

export const MAX_ACCRUAL_ENTRIES = 40;

/** One stopped task: start and stop (ms), CPU units, memory MiB. */
export type AccruedTask = readonly [number, number, number, number];

export interface UsageTotals {
  readonly vcpuSeconds: number;
  readonly gbSeconds: number;
}

export interface UsageAccrual {
  readonly entries: readonly AccruedTask[];
  readonly folded: (UsageTotals & { readonly untilMs: number }) | null;
  readonly mark: { readonly at: number; readonly tasks: readonly string[] };
  /** A destroy's measured total, kept until the stack is gone. */
  readonly final: (UsageTotals & { readonly sinceMs: number; readonly untilMs: number }) | null;
}

export const EMPTY_ACCRUAL: UsageAccrual = {
  entries: [],
  folded: null,
  mark: { at: 0, tasks: [] },
  final: null,
};

/** The accrual the parameter holds; none is the empty one. */
export function parseAccrual(value: string | null): UsageAccrual {
  return value === null ? EMPTY_ACCRUAL : { ...EMPTY_ACCRUAL, ...(JSON.parse(value) as object) };
}

const taskId = (arn: string) => arn.slice(arn.lastIndexOf('/') + 1);

function totalsOf(task: AccruedTask, since: number, until: number): UsageTotals {
  const [start, stop, cpu, memory] = task;
  const seconds = Math.max(0, Math.min(stop, until) - Math.max(start, since)) / 1000;
  return { vcpuSeconds: (seconds * cpu) / 1024, gbSeconds: (seconds * memory) / 1024 };
}

const add = (a: UsageTotals, b: UsageTotals): UsageTotals => ({
  vcpuSeconds: a.vcpuSeconds + b.vcpuSeconds,
  gbSeconds: a.gbSeconds + b.gbSeconds,
});

/** The accrual with the listed stopped tasks it has not counted yet; `changed`
 *  says whether it must be written. */
export function accrueStoppedTasks(
  accrual: UsageAccrual,
  tasks: readonly TenantEcsTask[],
): { accrual: UsageAccrual; changed: boolean } {
  const fresh = tasks
    .filter((t) => t.lastStatus === 'STOPPED' && t.stoppedAt)
    .filter((t) => {
      const at = t.stoppedAt!.getTime();
      return (
        at > accrual.mark.at ||
        (at === accrual.mark.at && !accrual.mark.tasks.includes(taskId(t.taskArn)))
      );
    })
    .sort((a, b) => a.stoppedAt!.getTime() - b.stoppedAt!.getTime());
  if (fresh.length === 0) return { accrual, changed: false };

  let entries: AccruedTask[] = [...accrual.entries];
  for (const t of fresh) {
    const stop = t.stoppedAt!.getTime();
    // A task that never started was never billed.
    entries.push([t.startedAt?.getTime() ?? stop, stop, t.cpu, t.memory]);
  }
  let folded = accrual.folded;
  if (entries.length > MAX_ACCRUAL_ENTRIES) {
    const old = entries.slice(0, entries.length - MAX_ACCRUAL_ENTRIES);
    entries = entries.slice(old.length);
    const sum = old.reduce<UsageTotals>(
      (s, e) => add(s, totalsOf(e, -Infinity, Infinity)),
      folded ?? { vcpuSeconds: 0, gbSeconds: 0 },
    );
    folded = { ...sum, untilMs: Math.max(folded?.untilMs ?? 0, ...old.map((e) => e[1])) };
  }
  const last = fresh[fresh.length - 1]!.stoppedAt!.getTime();
  const atLast = fresh.filter((t) => t.stoppedAt!.getTime() === last).map((t) => taskId(t.taskArn));
  const mark = {
    at: last,
    tasks: last === accrual.mark.at ? [...accrual.mark.tasks, ...atLast] : atLast,
  };
  return { accrual: { ...accrual, entries, folded, mark }, changed: true };
}

/** The usage within `[since, until]` of the accrued tasks and the running ones. */
export function windowUsage(
  accrual: UsageAccrual,
  tasks: readonly TenantEcsTask[],
  since: Date,
  until: Date,
): UsageTotals {
  const from = since.getTime();
  const to = until.getTime();
  let totals: UsageTotals = { vcpuSeconds: 0, gbSeconds: 0 };
  if (accrual.folded && accrual.folded.untilMs > from) totals = add(totals, accrual.folded);
  for (const entry of accrual.entries) totals = add(totals, totalsOf(entry, from, to));
  for (const t of tasks) {
    if (t.lastStatus === 'STOPPED' || !t.startedAt) continue;
    totals = add(totals, totalsOf([t.startedAt.getTime(), to, t.cpu, t.memory], from, to));
  }
  return totals;
}
