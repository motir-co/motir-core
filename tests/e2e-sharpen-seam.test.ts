import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';

import { parseSharpenTurn, type SharpenTurnResult } from '@/lib/ai/sharpenTurn';
import type { SharpenAction, SharpenJobContext, SharpenQuestion } from '@/lib/ai/types';
import { installAiJobsBoundaryMock } from '@/lib/test-ai-jobs-mock';
import { installSharpenBoundaryMock, type SharpenControl } from '@/lib/test-sharpen-mock';

// Task MOTIR-1101 · Subtask MOTIR-8180 — the Sharpen E2E seam, driven over the
// wire through every mode: determinate, scripted (pick / skip / you-decide /
// stop, and the end of the script), and error. Every turn is read back through
// core's REAL parser (`parseSharpenTurn`), so a shape the seam got wrong fails
// here rather than as a failed turn in the browser. The write-back is asserted
// as the request core receives — headers and body — because that call is what
// the E2E exists to prove.
//
// The jobs seam is installed AFTER this one, as `E2E_MOCK_SEAMS` orders them,
// and the last test proves a non-Sharpen submit still reaches it.

const AI = 'https://ai.mock.test';
const CORE = 'https://core.mock.test';
const dir = mkdtempSync(path.join(tmpdir(), 'sharpen-seam-'));
const controlPath = path.join(dir, 'control.json');
const jobsFixturePath = path.join(dir, 'jobs.json');

const core = {
  status: 200,
  calls: [] as { headers: Record<string, string>; body: unknown }[],
};
let previous: Dispatcher;

const q = (id: string, topic: SharpenQuestion['topic'], text: string): SharpenQuestion => ({
  id,
  text,
  topic,
  because: null,
  quote: null,
  readings: [
    { id: 'a', label: `${id} reading A`, detail: `why ${id} A`, recommended: true },
    { id: 'b', label: `${id} reading B`, detail: '', recommended: false },
  ],
});

const SCRIPT = [
  q('q1', 'workflow', 'Who starts the export?'),
  q('q2', 'non_happy', 'What happens when the export is empty?'),
  q('q3', 'alternative', 'Is a scheduled export in scope?'),
];

/** undici hands a mock its headers as an object or a flat pair array; key them lower-case. */
function lowerHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (let i = 0; i + 1 < raw.length; i += 2)
      out[String(raw[i]).toLowerCase()] = String(raw[i + 1]);
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) out[k.toLowerCase()] = String(v);
  }
  return out;
}

function seed(control: SharpenControl) {
  writeFileSync(controlPath, JSON.stringify(control));
}

function control(): SharpenControl {
  return JSON.parse(readFileSync(controlPath, 'utf8')) as SharpenControl;
}

beforeAll(() => {
  process.env['MOTIR_AI_URL'] = AI;
  process.env['MOTIR_BASE_URL'] = CORE;
  process.env['CORE_CALLBACK_SECRET'] = 'callback-secret';
  process.env['MOTIR_AI_SHARPEN_CONTROL_PATH'] = controlPath;
  process.env['MOTIR_AI_JOBS_FIXTURE_PATH'] = jobsFixturePath;
  previous = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  installSharpenBoundaryMock(agent);
  installAiJobsBoundaryMock(agent);
  // Core's write-back door, standing in for the real route.
  agent
    .get(CORE)
    .intercept({ path: '/api/internal/ai/plan-sharpening', method: 'PUT' })
    .reply<object>((req) => {
      core.calls.push({
        headers: lowerHeaders(req.headers),
        body: JSON.parse(String(req.body)),
      });
      return core.status === 200
        ? { statusCode: 200, data: { settledAt: 'now' } }
        : { statusCode: core.status, data: { code: 'SHARPENING_PLAN_CLOSED', message: 'closed' } };
    })
    .persist();
  setGlobalDispatcher(agent);
});

afterAll(() => {
  setGlobalDispatcher(previous);
  for (const k of [
    'MOTIR_AI_SHARPEN_CONTROL_PATH',
    'MOTIR_AI_JOBS_FIXTURE_PATH',
    'CORE_CALLBACK_SECRET',
    'MOTIR_BASE_URL',
  ]) {
    delete process.env[k];
  }
});

beforeEach(() => {
  core.status = 200;
  core.calls = [];
  writeFileSync(jobsFixturePath, '{}');
});

/** One turn over the wire: the submit core makes, then the read its settle makes. */
async function turn(
  ctx: SharpenJobContext,
): Promise<{ jobId: string; status: string; result: SharpenTurnResult | null; error: unknown }> {
  const submit = await fetch(`${AI}/v1/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      envelopeVersion: 'v1',
      jobKind: 'sharpen_turn',
      tenant: {},
      context: { sharpen: ctx },
      readBackToken: 'job-token',
    }),
  });
  expect(submit.status).toBe(200);
  const { jobId } = (await submit.json()) as { jobId: string };
  const read = await fetch(`${AI}/v1/jobs/${jobId}?coreProjectId=p1`);
  expect(read.status).toBe(200);
  const body = (await read.json()) as {
    status: string;
    result: { sharpenTurn?: unknown } | null;
    error: unknown;
  };
  return {
    jobId,
    status: body.status,
    result: body.result ? parseSharpenTurn(body.result.sharpenTurn) : null,
    error: body.error,
  };
}

/** The context core sends next, built from the previous turn the way the door does. */
function next(
  prev: SharpenTurnResult | null,
  action: SharpenAction,
  extra: Partial<SharpenJobContext> = {},
  ref = 'plan-1',
): SharpenJobContext {
  return {
    scope: { kind: 'plan', ref },
    turns: [],
    settled: prev?.settled ?? [],
    assumptions: prev?.assumptions ?? [],
    pendingQuestion: prev?.question ?? null,
    action,
    ...extra,
  };
}

describe('determinate', () => {
  it('start ends nothing_to_ask with no question and makes no write-back', async () => {
    seed({ targets: { 'plan-1': { mode: 'determinate' } } });
    const t = await turn(next(null, 'start'));
    expect(t.status).toBe('succeeded');
    expect(t.result).toEqual({
      kind: 'nothing_to_ask',
      question: null,
      settled: [],
      assumptions: [],
      writeBack: null,
    });
    expect(core.calls).toEqual([]);
  });

  it('a target with no fixture and no default is determinate', async () => {
    seed({});
    expect((await turn(next(null, 'start'))).result?.kind).toBe('nothing_to_ask');
  });
});

describe('scripted', () => {
  it('pick → skip → you-decide walks the script, and its end writes everything back', async () => {
    seed({ default: { mode: 'scripted', questions: SCRIPT } });

    const t1 = await turn(next(null, 'start'));
    expect(t1.result?.kind).toBe('question');
    expect(t1.result?.question?.id).toBe('q1');
    expect(t1.result?.question?.readings.length).toBeGreaterThanOrEqual(2);
    expect(t1.result?.question?.readings.filter((r) => r.recommended)).toHaveLength(1);

    const t2 = await turn(next(t1.result, 'answer', { readingId: 'b' }));
    expect(t2.result?.question?.id).toBe('q2');
    expect(t2.result?.settled).toEqual([
      {
        questionId: 'q1',
        question: 'Who starts the export?',
        answer: 'q1 reading B',
        topic: 'workflow',
        readingId: 'b',
        source: 'person',
      },
    ]);

    const t3 = await turn(next(t2.result, 'skip'));
    expect(t3.result?.question?.id).toBe('q3');
    expect(t3.result?.assumptions).toEqual([
      {
        questionId: 'q2',
        question: 'What happens when the export is empty?',
        recommendation: 'q2 reading A',
        why: 'why q2 A',
        source: 'planner',
      },
    ]);
    expect(core.calls).toEqual([]);

    const t4 = await turn(next(t3.result, 'you_decide'));
    expect(t4.result?.kind).toBe('finished');
    expect(t4.result?.question).toBeNull();
    expect(t4.result?.assumptions.map((a) => a.questionId)).toEqual(['q2', 'q3']);
    expect(t4.result?.writeBack).toEqual({ ok: true });
    expect(core.calls).toHaveLength(1);
    expect(core.calls[0]!.body).toEqual({
      jobId: t4.jobId,
      scope: { planId: 'plan-1' },
      requirement: { behaviour: '- Who starts the export? — q1 reading B' },
      plannerAssumptions: [
        { question: 'What happens when the export is empty?', recommendation: 'q2 reading A' },
        { question: 'Is a scheduled export in scope?', recommendation: 'q3 reading A' },
      ],
    });
    expect(control().writeBacks?.map((w) => w.jobId)).toEqual([t4.jobId]);
  });

  it('stop writes back exactly what was settled before it, with core’s two credentials', async () => {
    seed({ targets: { 'plan-7': { mode: 'scripted', questions: SCRIPT } } });
    const item = (prev: SharpenTurnResult | null, a: SharpenAction, x = {}) =>
      next(prev, a, x, 'plan-7');
    const t1 = await turn(item(null, 'start'));
    const t2 = await turn(item(t1.result, 'own_words', { text: 'Only admins.' }));
    expect(t2.result?.question?.id).toBe('q2');

    const stop = await turn(item(t2.result, 'stop'));
    expect(stop.result?.kind).toBe('stopped');
    // The pending q2 was neither answered nor assumed: stop records nothing for it.
    expect(stop.result?.settled.map((s) => s.questionId)).toEqual(['q1']);
    expect(stop.result?.assumptions).toEqual([]);
    expect(core.calls).toHaveLength(1);
    expect(core.calls[0]!.headers['authorization']).toBe('Bearer callback-secret');
    expect(core.calls[0]!.headers['x-motir-job-token']).toBe('job-token');
    expect(core.calls[0]!.body).toEqual({
      jobId: stop.jobId,
      scope: { planId: 'plan-7' },
      requirement: { behaviour: '- Who starts the export? — Only admins.' },
      plannerAssumptions: [],
    });
  });

  it('a conversation’s grilling settles answers and writes nothing back (MOTIR-9314)', async () => {
    seed({ targets: { 'conv-1': { mode: 'scripted', questions: SCRIPT } } });
    const conv = (prev: SharpenTurnResult | null, a: SharpenAction, x = {}) => ({
      ...next(prev, a, x, 'conv-1'),
      scope: { kind: 'conversation' as const, ref: 'conv-1' },
    });
    const t1 = await turn(conv(null, 'start'));
    const t2 = await turn(conv(t1.result, 'answer', { readingId: 'a' }));
    const stop = await turn(conv(t2.result, 'stop'));
    expect(stop.result?.kind).toBe('stopped');
    expect(stop.result?.settled.map((s) => s.questionId)).toEqual(['q1']);
    expect(stop.result?.writeBack).toBeNull();
    expect(core.calls).toEqual([]);
  });

  it('an in-run turn never asks a carried question, and ends at once when the carried answers cover its requests (MOTIR-9319)', async () => {
    seed({ default: { mode: 'scripted', questions: SCRIPT } });
    const q1 = SCRIPT[0]!;
    const carried = {
      requests: ['Export the board'],
      settled: [
        {
          questionId: q1.id,
          question: q1.text,
          answer: q1.readings[0]!.label,
          topic: q1.topic,
          readingId: q1.readings[0]!.id,
        },
      ],
      assumptions: [],
    };
    const run = (requests: string[]) => ({
      run: { planId: 'plan-1', requests, card: null, carried },
    });
    const covered = await turn(next(null, 'start', run(['export  the BOARD'])));
    expect(covered.result?.kind).toBe('nothing_to_ask');
    expect(covered.result?.question).toBeNull();
    const later = await turn(next(null, 'start', run(['Export the board', 'Also weekly'])));
    expect(later.result?.kind).toBe('question');
    expect(later.result?.question?.id).toBe(SCRIPT[1]!.id);
  });

  it('stop with nothing settled ends with no write-back', async () => {
    seed({ default: { mode: 'scripted', questions: SCRIPT } });
    const t1 = await turn(next(null, 'start'));
    const stop = await turn(next(t1.result, 'stop'));
    expect(stop.result?.kind).toBe('stopped');
    expect(stop.result?.writeBack).toBeNull();
    expect(core.calls).toEqual([]);
  });

  it('a refused write-back keeps the answers and reports ok: false', async () => {
    seed({ default: { mode: 'scripted', questions: SCRIPT } });
    core.status = 409;
    const t1 = await turn(next(null, 'start'));
    const t2 = await turn(next(t1.result, 'answer', { readingId: 'a' }));
    const stop = await turn(next(t2.result, 'stop'));
    expect(stop.result?.settled).toHaveLength(1);
    expect(stop.result?.writeBack?.ok).toBe(false);
    expect(stop.result?.writeBack?.error).toContain('409');
    expect(control().writeBacks?.[0]?.status).toBe(409);
  });
});

describe('error', () => {
  it('fails the turn with motir-ai’s job-failure problem', async () => {
    seed({ default: { mode: 'error', detail: 'gateway down' } });
    const t = await turn(next(null, 'start'));
    expect(t.status).toBe('failed');
    expect(t.result).toBeNull();
    expect(t.error).toMatchObject({ code: 'ai_job_failed', status: 500, detail: 'gateway down' });
    expect(core.calls).toEqual([]);
  });
});

describe('ownership', () => {
  it('a submit of any other kind still reaches the jobs seam', async () => {
    seed({ default: { mode: 'scripted', questions: SCRIPT } });
    const res = await fetch(`${AI}/v1/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ envelopeVersion: 'v1', jobKind: 'augment', context: {} }),
    });
    expect(((await res.json()) as { jobId: string }).jobId).toMatch(/^e2e-augment-/);
    expect(control().submitted ?? []).toEqual([]);
  });
});
