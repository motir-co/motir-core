import { readFileSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import type {
  AiJobsFixture,
  AskJobOutcome,
  PlanJobOutcome,
  SubmittedJob,
} from '@/lib/test-ai-jobs-mock';
import { adminDb } from './db-reset';
import { E2E_CORE_CALLBACK_SECRET } from './log-bug-as-ai';

// THE MID-RUN SEAM (Story MOTIR-7990 · MOTIR-8004).
//
// What a spec needs to type into a planning run that is STILL WORKING and to play
// motir-ai's side of that run, with no motir-ai in the lane:
//
//   - the FIXTURE the server-side jobs mock (`lib/test-ai-jobs-mock.ts`) re-reads
//     on every request — write it, HOLD a run in progress, END it, read the journal
//     of what the server submitted;
//   - a run's MAILBOX, read straight from Postgres (the committed row is the
//     authoritative signal, not the rail's rendering of it);
//   - the doors motir-ai itself calls for a running job — the mailbox read at a
//     tool-call gap, the run-pause post, the proposal append / re-title / withdraw —
//     each presented with the two credentials motir-ai holds: the §4a service
//     bearer and the §4b job token the submit's envelope carried (which the mock
//     recorded as `readBackToken`).
//
// Nothing is written into a table by hand. Every move below goes through a route
// the product ships, so what the spec proves is motir-core's side of each door.

// ── The fixture ──────────────────────────────────────────────────────────────

function fixturePath(): string {
  const path = process.env['MOTIR_AI_JOBS_FIXTURE_PATH'];
  if (!path)
    throw new Error('MOTIR_AI_JOBS_FIXTURE_PATH is unset — this is not the acceptance lane');
  return path;
}

/** The fixture as the mock last wrote it. An absent / unreadable file reads as empty. */
export function readFixture(): AiJobsFixture {
  try {
    return JSON.parse(readFileSync(fixturePath(), 'utf8')) as AiJobsFixture;
  } catch {
    return {};
  }
}

function patchFixture(patch: (f: AiJobsFixture) => void): void {
  const f = readFixture();
  patch(f);
  writeFileSync(fixturePath(), JSON.stringify(f, null, 2));
}

/**
 * Declare what a run does and RESET the journal.
 *
 * ⚠️ THE RESET IS LOAD-BEARING: the fixture file is shared by every spec in the
 * lane and persists across runs (`cloud-one-planning-kind.spec.ts`'s `resetSeam`
 * says why), so a claim about THIS test's submits has to be measured over entries
 * this test produced.
 *
 * `ask` is consumed in order, one entry per `ask_project` submit — the first turn
 * of an ANCHORED conversation goes straight to the planning submit and consumes
 * none, so the entries here are for the turns typed INTO the run. `plan` entry 0 is
 * the run itself, held in progress; entry 1 (and the entries after it, because the
 * last one repeats) is a plain success, so a revision submitted for a late change
 * settles at once instead of being held too.
 */
export function declareSeam(opts: { ask?: AskJobOutcome[]; plan?: PlanJobOutcome[] }): void {
  writeFileSync(
    fixturePath(),
    JSON.stringify(
      {
        ask: opts.ask ?? [],
        plan: opts.plan ?? [{ status: 'running' }, {}],
        submitted: [],
      } satisfies AiJobsFixture,
      null,
      2,
    ),
  );
}

/** APPEND the next `ask_project` outcome(s) the server will settle as. */
export function queueAsk(...outcomes: AskJobOutcome[]): void {
  patchFixture((f) => {
    f.ask = [...(f.ask ?? []), ...outcomes];
  });
}

/** Rewrite the `n`-th planning run's outcome, keeping the journal. */
export function setPlanRun(n: number, outcome: PlanJobOutcome): void {
  patchFixture((f) => {
    const queue = [...(f.plan ?? [])];
    while (queue.length <= n) queue.push({});
    queue[n] = outcome;
    f.plan = queue;
  });
}

/**
 * END a held run the way motir-ai ends a finished walk: the job succeeds and its
 * stream reports the terminal `status` frame, which is what makes the rail run its
 * end-of-walk work (the late-changes claim). The relay picks the change up on its
 * next stream window.
 */
export function endRun(n: number, utterance?: { message: string }): void {
  setPlanRun(n, {
    status: 'succeeded',
    statusFrame: true,
    ...(utterance ? { turn: utterance } : {}),
  });
}

/** Every submit the mock accepted, in order. */
export function submitted(): SubmittedJob[] {
  return readFixture().submitted ?? [];
}

export const submitsOf = (kind: string): SubmittedJob[] =>
  submitted().filter((s) => s.kind === kind && !s.refused);

/** A planning run the server submitted, with the credentials motir-ai would hold for it. */
export interface RunHandle {
  jobId: string;
  /** The §4b job token the submit's envelope carried. */
  token: string;
}

/** The `n`-th planning (`plan`) submit's handle. */
export function planRun(n: number): RunHandle {
  const job = submitsOf('plan')[n];
  if (!job?.jobId || !job.readBackToken) {
    throw new Error(`the jobs mock recorded no plan submit #${n} with a job token`);
  }
  return { jobId: job.jobId, token: job.readBackToken };
}

// ── Persisted state ──────────────────────────────────────────────────────────

/** A run's mailbox rows, in `seq` order — straight from Postgres. */
export const mailboxRows = (jobId: string) =>
  adminDb.planChangeMailboxEntry.findMany({ where: { jobId }, orderBy: { seq: 'asc' } });

/** The plan a run writes (resolved by the job that opened it). */
export const planOfRun = (jobId: string) =>
  adminDb.plan.findFirstOrThrow({ where: { sourceJobId: jobId } });

/** The titles a plan currently proposes (`add`s by their fields, others by target). */
export async function proposalTitles(planId: string): Promise<string[]> {
  const items = await adminDb.planItem.findMany({ where: { planId } });
  return items.map((i) => {
    const fields = (i.proposedFields ?? {}) as { title?: unknown };
    const patch = (i.patch ?? {}) as { title?: unknown };
    return typeof fields.title === 'string'
      ? fields.title
      : typeof patch.title === 'string'
        ? patch.title
        : `${i.op}:${i.workItemId ?? ''}`;
  });
}

// ── The doors motir-ai calls ─────────────────────────────────────────────────

function asAi(run: RunHandle) {
  return {
    authorization: `Bearer ${E2E_CORE_CALLBACK_SECRET}`,
    'x-motir-job-token': run.token,
  };
}

export interface GapRead {
  turns: Array<{
    id: string;
    text: string;
    disposition: 'fold' | 'restart';
    target: string | null;
    declinesPause?: string;
    answersQuestion?: string;
  }>;
  stopped: boolean;
}

/**
 * THE WALK'S TOOL-CALL GAP: `POST /api/internal/ai/plan-change-mailbox { jobId }`.
 * It CONSUMES — every entry it returns is stamped `consumed_at` in the same
 * transaction, which is how the rail learns the change was read.
 */
export async function readGap(page: Page, run: RunHandle): Promise<GapRead> {
  const res = await page.request.post('/api/internal/ai/plan-change-mailbox', {
    headers: asAi(run),
    data: { jobId: run.jobId },
  });
  if (res.status() !== 200) {
    throw new Error(`plan-change-mailbox answered ${res.status()}: ${await res.text()}`);
  }
  return (await res.json()) as GapRead;
}

export interface RecordedPause {
  outcome: 'recorded' | 'already_open';
  pause: {
    id: string;
    kind: 'replan' | 'unclear' | 'code_unsearchable';
    changeTurnIds: string[];
  };
}

/** THE HOSTED PAUSE: `POST /api/internal/ai/plan-change-run-pause`, idempotent on its key. */
export async function postPause(
  page: Page,
  run: RunHandle,
  pause:
    | { kind: 'replan'; changeTurnIds: string[]; reason: string }
    | { kind: 'unclear'; changeTurnIds: string[]; question: string }
    | { kind: 'code_unsearchable'; repos: Array<{ repoRef: string; state: string }> },
): Promise<RecordedPause> {
  // A code stop names no change turn; its key is the blocked set, as motir-ai's is.
  const changeTurnIds = pause.kind === 'code_unsearchable' ? [] : pause.changeTurnIds;
  const subject =
    pause.kind === 'code_unsearchable'
      ? pause.repos
          .map((r) => `${r.repoRef}:${r.state}`)
          .sort()
          .join(',')
      : changeTurnIds.join(',');
  const res = await page.request.post('/api/internal/ai/plan-change-run-pause', {
    headers: asAi(run),
    data: {
      jobId: run.jobId,
      ...pause,
      changeTurnIds,
      idempotencyKey: `pause:${run.jobId}:${pause.kind}:${subject}`,
    },
  });
  if (res.status() !== 200) {
    throw new Error(`plan-change-run-pause answered ${res.status()}: ${await res.text()}`);
  }
  return (await res.json()) as RecordedPause;
}

/** A proposal the planner appends. */
export type AppendedProposal =
  | { op: 'add'; title: string; kind?: string; parentRef?: string }
  | { op: 'remove'; workItemId: string; reason?: string };

/**
 * THE RUN'S APPEND: `POST /api/internal/ai/plan-proposals`, the door a planning
 * run's callbacks write through. `final` closes the plan (`planned`), which a walk
 * does as its last act. Resolves with the created PlanItem ids IN APPEND ORDER.
 *
 * `summary` is the planner's BRIEFING, which rides only a final append. `revision`
 * marks the append as a REVISION pass of a plan core re-opened for it (Story
 * MOTIR-11515 · MOTIR-11524): its `final` closes the revision and gives the plan back
 * `planned`, which is the close motir-ai's revision handler makes.
 */
export async function appendAsAi(
  page: Page,
  run: RunHandle,
  proposals: AppendedProposal[],
  opts: { final?: boolean; summary?: string; revision?: boolean } = {},
): Promise<string[]> {
  const res = await page.request.post('/api/internal/ai/plan-proposals', {
    headers: asAi(run),
    data: {
      jobId: run.jobId,
      proposals: proposals.map((p) =>
        p.op === 'add'
          ? {
              op: 'add',
              proposedFields: { title: p.title, kind: p.kind ?? 'story' },
              ...(p.parentRef ? { parentRef: p.parentRef } : {}),
            }
          : { op: 'remove', workItemId: p.workItemId, ...(p.reason ? { reason: p.reason } : {}) },
      ),
      ...(opts.final ? { final: true } : {}),
      ...(opts.final && opts.summary !== undefined ? { summary: opts.summary } : {}),
      ...(opts.revision ? { revision: true } : {}),
    },
  });
  if (res.status() !== 200) {
    throw new Error(`plan-proposals answered ${res.status()}: ${await res.text()}`);
  }
  return ((await res.json()) as { planItemIds: string[] }).planItemIds;
}

/** RE-TITLE a proposal the run already wrote: `PATCH /api/internal/ai/plan-proposals/:itemId`. */
export async function retitleAsAi(
  page: Page,
  run: RunHandle,
  planItemId: string,
  title: string,
): Promise<void> {
  const res = await page.request.patch(`/api/internal/ai/plan-proposals/${planItemId}`, {
    headers: asAi(run),
    data: { jobId: run.jobId, patch: { title } },
  });
  if (res.status() !== 200) {
    throw new Error(`plan-proposals PATCH answered ${res.status()}: ${await res.text()}`);
  }
}

/** WITHDRAW a proposal off the plan: `DELETE /api/internal/ai/plan-proposals/:itemId`. */
export async function withdrawAsAi(page: Page, run: RunHandle, planItemId: string): Promise<void> {
  const res = await page.request.delete(
    `/api/internal/ai/plan-proposals/${planItemId}?jobId=${encodeURIComponent(run.jobId)}`,
    { headers: asAi(run) },
  );
  if (res.status() !== 200) {
    throw new Error(`plan-proposals DELETE answered ${res.status()}: ${await res.text()}`);
  }
}
