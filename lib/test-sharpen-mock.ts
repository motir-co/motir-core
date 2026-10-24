// Node-only motir-ai SHARPEN boundary mock for E2E (Task MOTIR-1101 · Subtask
// MOTIR-8180).
//
// A Sharpen session crosses the motir-core → motir-ai seam from INSIDE the Next
// server: `POST /api/ai/sharpen` submits a `sharpen_turn` job and `POST
// /api/ai/sharpen/settle` calls `getJob`, so a browser-level `page.route` reaches
// neither. And the session's last act — motir-ai calling core's write-back,
// `PUT /api/internal/ai/plan-sharpening` — is what the E2E exists to prove, so
// the fake has to MAKE that call, through the real route, rather than skip it.
//
// What it intercepts (on the MOTIR_AI_URL origin):
//   - POST /v1/jobs whose envelope says `jobKind: "sharpen_turn"` → `{ jobId }`,
//     and RECORDS the envelope (context + job token) in the control file.
//   - GET  /v1/jobs/e2e-sharpen-<n> → the turn, computed from that record and
//     the target's fixture.
//
// ⚠️ IT CLAIMS ONLY SHARPEN TRAFFIC, AND IT MUST BE INSTALLED BEFORE
// `E2E_TEST_AI_JOBS`. Both seams answer `/v1/jobs` on the same origin, undici
// tries interceptors in REGISTRATION order, and the jobs seam accepts any kind
// (MOTIR-4137 is what that costs when two seams compete). So the submit
// intercept matches on the envelope's `jobKind`, the read matches only the ids
// this seam minted, and `E2E_MOCK_SEAMS` lists this row first.
//
// The fake keeps NO in-memory state (the seam table's per-process rule): the
// spec writes the control file (MOTIR_AI_SHARPEN_CONTROL_PATH) per test, this
// seam appends each submit and each write-back to it, and every reply is a pure
// function of what the file holds. Re-read on every request.
//
// The turn logic MIRRORS motir-ai's grilling session (`src/jobs/handlers/
// sharpenTurn.ts` in motir-ai — `recordSharpenAction`, `buildSharpenWriteBack`,
// the `end()` that writes back only when something was settled). Whether the
// REAL session asks the right questions is motir-ai's to prove (MOTIR-8178);
// this seam only has to speak its wire shape.

import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import type {
  GrillingBranch,
  SettledAnswer,
  SharpenAssumption,
  SharpenJobContext,
  SharpenQuestion,
  SubmittedRequirement,
} from '@/lib/ai/types';
import type { SharpeningWriteBackInput } from '@/lib/dto/plans';
import { readFixtureFileSync, writeFixtureFileSync } from '@/lib/test-fixture-file';
import type { MockAgent } from 'undici';

/** How one target's session behaves. */
export interface SharpenTargetFixture {
  /**
   * `determinate` — the request needs no question: `start` ends `nothing_to_ask`.
   * `scripted` — ask `questions` in order, skipping any already answered or assumed.
   * `error` — every turn fails with motir-ai's job-failure problem.
   */
  mode: 'determinate' | 'scripted' | 'error';
  /** The script (`scripted`), asked in order. Each needs 2–4 readings, one recommended. */
  questions?: SharpenQuestion[];
  /** The failure detail (`error`). */
  detail?: string;
}

/** One recorded `sharpen_turn` submit (written by the seam). */
export interface SharpenSubmitRecord {
  jobId: string;
  readBackToken: string;
  context: SharpenJobContext;
}

/** One write-back the seam issued to core (written by the seam). */
export interface SharpenWriteBackRecord {
  jobId: string;
  status: number;
  body: SharpeningWriteBackInput;
}

/** The control file: the spec writes the fixtures, the seam appends the journals. */
export interface SharpenControl {
  /** Fixtures keyed by the session's scope ref — a plan id or a conversation id. */
  targets?: Record<string, SharpenTargetFixture>;
  /** For a target with no entry. Absent ⇒ `determinate`. */
  default?: SharpenTargetFixture;
  submitted?: SharpenSubmitRecord[];
  writeBacks?: SharpenWriteBackRecord[];
}

/** The `sharpenTurn` result unit, as motir-ai returns it. */
export interface SharpenTurnWire {
  kind: 'question' | 'nothing_to_ask' | 'finished' | 'stopped';
  question: SharpenQuestion | null;
  settled: SettledAnswer[];
  assumptions: SharpenAssumption[];
  writeBack: { ok: boolean; error?: string } | null;
}

/** What one turn comes to, before any write-back is made. */
export type SharpenTurnPlan =
  | { failed: true; detail: string }
  | { failed: false; turn: SharpenTurnWire; writeBack: SharpeningWriteBackInput | null };

const JOB_ID = /^e2e-sharpen-(\d+)$/;

/** motir-ai's topic → requirement-field mapping (`SHARPEN_TOPIC_FIELD`). */
const TOPIC_FIELD: Record<GrillingBranch, Exclude<keyof SubmittedRequirement, 'assumptions'>> = {
  workflow: 'behaviour',
  non_happy: 'acceptance',
  alternative: 'scopeEdge',
  technical_thread: 'constraints',
};

/** motir-ai's cap on a reported write-back error. */
const WRITE_BACK_ERROR_MAX = 500;

function controlPath(): string | null {
  return process.env['MOTIR_AI_SHARPEN_CONTROL_PATH'] ?? null;
}

function readControl(): SharpenControl {
  const p = controlPath();
  if (!p) return {};
  try {
    return JSON.parse(readFixtureFileSync(p)) as SharpenControl;
  } catch {
    return {};
  }
}

function writeControl(control: SharpenControl): void {
  const p = controlPath();
  if (p) writeFixtureFileSync(p, JSON.stringify(control, null, 2));
}

function fixtureFor(control: SharpenControl, ref: string): SharpenTargetFixture {
  return control.targets?.[ref] ?? control.default ?? { mode: 'determinate' };
}

/** The person's action applied to the pending question — `recordSharpenAction`. */
export function recordAction(ctx: SharpenJobContext): {
  settled: SettledAnswer[];
  assumptions: SharpenAssumption[];
} {
  const settled = [...ctx.settled];
  const assumptions = [...ctx.assumptions];
  const q = ctx.pendingQuestion;
  if (!q) return { settled, assumptions };
  const known =
    settled.some((s) => s.questionId === q.id) || assumptions.some((a) => a.questionId === q.id);
  if (known) return { settled, assumptions };
  if (ctx.action === 'answer') {
    const reading = q.readings.find((r) => r.id === ctx.readingId);
    if (reading) {
      settled.push({
        questionId: q.id,
        question: q.text,
        answer: reading.label,
        topic: q.topic,
        readingId: reading.id,
        source: 'person',
      });
    }
  } else if (ctx.action === 'own_words' && ctx.text) {
    settled.push({
      questionId: q.id,
      question: q.text,
      answer: ctx.text,
      topic: q.topic,
      readingId: null,
      source: 'person',
    });
  } else if (ctx.action === 'skip' || ctx.action === 'you_decide') {
    const rec = q.readings.find((r) => r.recommended);
    if (rec) {
      assumptions.push({
        questionId: q.id,
        question: q.text,
        recommendation: rec.label,
        why: rec.detail,
        source: 'planner',
      });
    }
  }
  return { settled, assumptions };
}

/** The write-back body — `buildSharpenWriteBack`, byte for byte. */
export function buildWriteBack(
  jobId: string,
  planId: string,
  settled: SettledAnswer[],
  assumptions: SharpenAssumption[],
): SharpeningWriteBackInput {
  const requirement: Partial<SubmittedRequirement> = {};
  for (const s of settled) {
    const field = TOPIC_FIELD[s.topic];
    const line = `- ${s.question} — ${s.answer}`;
    requirement[field] = requirement[field] ? `${requirement[field]}\n${line}` : line;
  }
  return {
    jobId,
    scope: { planId },
    requirement,
    plannerAssumptions: assumptions.map((a) => ({
      question: a.question,
      recommendation: a.recommendation,
    })),
  };
}

/** motir-ai's request normalisation (`normaliseRequest`). */
function normaliseRequest(s: string): string {
  return s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
}

/** Do the run's carried answers cover every one of its requests —
 *  `carriedCoversRequests`, as motir-ai reads it. */
function carriedCoversRun(ctx: SharpenJobContext): boolean {
  const run = ctx.run;
  if (!run?.carried) return false;
  const known = new Set(run.carried.requests.map(normaliseRequest));
  return run.requests.every((r) => known.has(normaliseRequest(r)));
}

/**
 * The turn a submit comes to, as a pure function of the fixture and the
 * envelope's context. The write-back it owes (if any) is returned, not made.
 */
export function planSharpenTurn(
  fixture: SharpenTargetFixture,
  jobId: string,
  ctx: SharpenJobContext,
): SharpenTurnPlan {
  if (fixture.mode === 'error') {
    return { failed: true, detail: fixture.detail ?? 'The fixture failed this sharpen turn.' };
  }
  const recorded = recordAction(ctx);
  const end = (kind: 'nothing_to_ask' | 'finished' | 'stopped'): SharpenTurnPlan => {
    const nothing = recorded.settled.length === 0 && recorded.assumptions.length === 0;
    return {
      failed: false,
      turn: { kind, question: null, ...recorded, writeBack: null },
      // A conversation has no plan yet, so it owes no write-back (MOTIR-9314).
      writeBack:
        nothing || ctx.scope.kind !== 'plan'
          ? null
          : buildWriteBack(jobId, ctx.scope.ref, recorded.settled, recorded.assumptions),
    };
  };
  if (ctx.action === 'stop') return end('stopped');
  // The conversation already grilled this very request (`carriedAnswersCoverRun`,
  // MOTIR-9313): nothing is left to ask.
  if (ctx.action === 'start' && carriedCoversRun(ctx)) return end('nothing_to_ask');
  if (fixture.mode === 'determinate')
    return end(ctx.action === 'start' ? 'nothing_to_ask' : 'finished');

  // What is already settled — the carried answers, then this session's own
  // (`knownAnswers`): a carried question is never asked again.
  const carried = ctx.run?.carried;
  const done = new Set([
    ...(carried?.settled ?? []).map((s) => s.questionId),
    ...(carried?.assumptions ?? []).map((a) => a.questionId),
    ...recorded.settled.map((s) => s.questionId),
    ...recorded.assumptions.map((a) => a.questionId),
  ]);
  const next = (fixture.questions ?? []).find((q) => !done.has(q.id));
  if (!next) return end(ctx.action === 'start' ? 'nothing_to_ask' : 'finished');
  return {
    failed: false,
    turn: { kind: 'question', question: next, ...recorded, writeBack: null },
    writeBack: null,
  };
}

/** Core's write-back, made exactly as motir-ai's `writeBackSharpenAnswers` makes it. */
async function issueWriteBack(
  record: SharpenSubmitRecord,
  body: SharpeningWriteBackInput,
): Promise<{ ok: boolean; error?: string }> {
  let status = 0;
  let error: string | undefined;
  try {
    const res = await fetch(`${resolveBaseUrlTrimmed()}/api/internal/ai/plan-sharpening`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${process.env['CORE_CALLBACK_SECRET'] ?? ''}`,
        'X-Motir-Job-Token': record.readBackToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    status = res.status;
    if (!res.ok) {
      error = `plan-sharpening write-back failed: ${res.status} ${await res.text()}`.slice(
        0,
        WRITE_BACK_ERROR_MAX,
      );
    }
  } catch (err) {
    error = `plan-sharpening write-back failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  const control = readControl();
  control.writeBacks = [...(control.writeBacks ?? []), { jobId: record.jobId, status, body }];
  writeControl(control);
  return error === undefined ? { ok: true } : { ok: false, error };
}

function isSharpenSubmit(body: unknown): boolean {
  try {
    return (JSON.parse(String(body ?? '')) as { jobKind?: unknown }).jobKind === 'sharpen_turn';
  } catch {
    return false;
  }
}

const JSON_HEADERS = { headers: { 'content-type': 'application/json' } };

export function installSharpenBoundaryMock(agent: MockAgent): void {
  const origin = (process.env['MOTIR_AI_URL'] ?? '').replace(/\/+$/, '');
  if (!origin) return;
  const pool = agent.get(origin);

  // POST /v1/jobs — sharpen_turn submits only; every other kind falls through.
  pool
    .intercept({
      path: (p) => p === '/v1/jobs' || p.startsWith('/v1/jobs?'),
      method: 'POST',
      body: isSharpenSubmit,
    })
    .reply<object>((req) => {
      const envelope = JSON.parse(String(req.body)) as {
        readBackToken?: string;
        context?: { sharpen?: SharpenJobContext };
      };
      const control = readControl();
      const submitted = control.submitted ?? [];
      const jobId = `e2e-sharpen-${submitted.length}`;
      control.submitted = [
        ...submitted,
        {
          jobId,
          readBackToken: envelope.readBackToken ?? '',
          context: envelope.context?.sharpen as SharpenJobContext,
        },
      ];
      writeControl(control);
      return { statusCode: 200, data: { jobId }, responseOptions: JSON_HEADERS };
    })
    .persist();

  // GET /v1/jobs/e2e-sharpen-<n> — the turn. Async, because an ending turn makes
  // core's write-back BEFORE it answers, as the real session does.
  pool
    .intercept({
      path: (p) => JOB_ID.test(decodeURIComponent(p.split('?')[0]!.split('/').pop() ?? '')),
      method: 'GET',
    })
    .reply(
      200,
      async (req: { path: string }) => {
        const jobId = decodeURIComponent(req.path.split('?')[0]!.split('/').pop()!);
        const index = Number(JOB_ID.exec(jobId)![1]);
        const control = readControl();
        const record = control.submitted?.[index];
        if (!record?.context) {
          return JSON.stringify({
            jobId,
            status: 'failed',
            result: null,
            error: problem(jobId, `No sharpen submit recorded for ${jobId}.`),
          });
        }
        const plan = planSharpenTurn(
          fixtureFor(control, record.context.scope.ref),
          jobId,
          record.context,
        );
        if (plan.failed) {
          return JSON.stringify({
            jobId,
            status: 'failed',
            result: null,
            error: problem(jobId, plan.detail),
          });
        }
        const turn = plan.writeBack
          ? { ...plan.turn, writeBack: await issueWriteBack(record, plan.writeBack) }
          : plan.turn;
        return JSON.stringify({
          jobId,
          status: 'succeeded',
          result: { sharpenTurn: turn },
          error: null,
        });
      },
      JSON_HEADERS,
    )
    .persist();
}

/** motir-ai's job-failure problem (`ai_job_failed`, contract §5). */
function problem(jobId: string, detail: string) {
  return {
    type: 'about:blank',
    title: 'Planning job failed',
    status: 500,
    code: 'ai_job_failed',
    detail,
    jobId,
  };
}
