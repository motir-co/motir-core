import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  answerRestart,
  answerRunPause,
  attachMidRunTurn,
  findResumableSession,
  getPlanChangeSession,
  startPlanChangeSession,
  appendPlanChangeTurn,
  peekMailbox,
  readRunPause,
  stopPlanChangeRun,
  skipPlanFinalCheck,
  recordPlannerTurn,
  rerunAskTurn,
  resubmitContextualPlan,
  resumeContextualSession,
  settleAskJob,
  submitAskTurn,
  submitContextualPlan,
  submitLateChanges,
  submitMidRunAskTurn,
  submitPlanChange,
  resumePlanSession,
  resumeAlreadyStartedJobId,
} from '@/lib/planning/planChangeClient';
import { PlanEditsClientError } from '@/lib/planning/planEditsClient';

// The conversation's CLIENT transport (Story 7.30 · MOTIR-1728's routes, consumed
// by MOTIR-1730's rail) — the one module in this story that shipped with NO test
// at all, so the story-level coverage gate (MOTIR-1732) writes its floor here.
//
// What it must prove is the contract the rail leans on and the hook's mocks hide:
// every call is an HTTP hop to a SHIPPED `/api/ai/plan-change/session*` endpoint
// (never a service import — the client/service boundary guard asserts the other
// direction), the request shape each endpoint expects, and the single error type
// a caller branches on. `fetch` is the boundary, so `fetch` is what is stubbed —
// nothing else is.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The single request `fetch` was called with. */
function lastCall(): [string, RequestInit] {
  const call = fetchMock.mock.calls.at(-1)!;
  return [call[0] as string, call[1] as RequestInit];
}

const SESSION = {
  id: 's1',
  projectId: 'p1',
  turnCount: 1,
  lastJobId: null,
  lastSubmittedAt: null,
  createdAt: '2026-07-27T09:00:00.000Z',
  updatedAt: '2026-07-27T09:00:00.000Z',
  turns: [],
};

describe('planChangeClient — the session calls hit the SHIPPED endpoints, by session id', () => {
  it('RESUMES with a bodyless GET — looking creates nothing (MOTIR-6023)', async () => {
    const EARLIER = {
      id: 's0',
      targetKeys: ['MOTIR-812'],
      lastActivityAt: '2026-09-20T10:00:00.000Z',
      startedBy: { id: 'u2', name: 'Mara' },
      mine: false,
    };
    fetchMock.mockResolvedValue(jsonResponse({ session: SESSION, earlier: EARLIER }));

    // `{ session, earlier }` (MOTIR-6024) — the earlier conversation rides along.
    await expect(findResumableSession()).resolves.toEqual({
      session: SESSION,
      earlier: EARLIER,
      copyable: null,
    });

    const [url, init] = lastCall();
    expect(url).toBe('/api/ai/plan-change/session');
    expect(init.method).toBeUndefined();
    expect(init.body).toBeUndefined();
    expect(init.headers).toMatchObject({ Accept: 'application/json' });
  });

  it('reads NO resumable session as a null session, not an error — and tolerates a bare null body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ session: null, earlier: null }));
    await expect(findResumableSession()).resolves.toEqual({
      session: null,
      earlier: null,
      copyable: null,
    });

    fetchMock.mockResolvedValue(jsonResponse(null));
    await expect(findResumableSession()).resolves.toEqual({
      session: null,
      earlier: null,
      copyable: null,
    });
  });

  it('reopens ONE session by id, encoded into the query', async () => {
    fetchMock.mockResolvedValue(jsonResponse(SESSION));

    await expect(getPlanChangeSession('s 1')).resolves.toEqual(SESSION);

    const [url, init] = lastCall();
    expect(url).toBe('/api/ai/plan-change/session?id=s%201');
    expect(init.method).toBeUndefined();
  });

  it('STARTS a session with its first turn as a POST { body, isAnswer }', async () => {
    // A fresh Response per call — a body may only be read once.
    fetchMock.mockImplementation(async () => jsonResponse(SESSION));

    await expect(startPlanChangeSession('Plan billing')).resolves.toEqual(SESSION);

    const [url, init] = lastCall();
    expect(url).toBe('/api/ai/plan-change/session');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(init.body as string)).toEqual({ body: 'Plan billing', isAnswer: false });

    await startPlanChangeSession('money in', undefined, true);
    expect(JSON.parse(lastCall()[1].body as string)).toEqual({ body: 'money in', isAnswer: true });
  });

  it('flags a reply sent from the ANSWER BAR (MOTIR-2226)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(SESSION));

    await appendPlanChangeTurn('s1', 'Taking money from customers.', undefined, true);

    expect(JSON.parse(lastCall()[1].body as string)).toEqual({
      sessionId: 's1',
      body: 'Taking money from customers.',
      isAnswer: true,
    });
  });

  it('records the PLANNER’s turn for a settled job — the project thread', async () => {
    fetchMock.mockResolvedValue(jsonResponse(SESSION));

    await expect(recordPlannerTurn('s1', 'job-1', null)).resolves.toEqual(SESSION);

    const [url, init] = lastCall();
    expect(url).toBe('/api/ai/plan-change/session/planner-turn');
    expect(init.method).toBe('POST');
    // No anchor: the session is named by id alone.
    expect(JSON.parse(init.body as string)).toEqual({ sessionId: 's1', jobId: 'job-1' });
  });

  it('records it on an ANCHORED thread by its anchor set', async () => {
    fetchMock.mockResolvedValue(jsonResponse(SESSION));

    await recordPlannerTurn('s1', 'job-1', { anchorId: 'wi_812', targetKeys: ['MOTIR-918'] });

    // The scope key is never computed client-side — the anchor set travels and
    // the contextual service resolves (and view-gates) it.
    expect(JSON.parse(lastCall()[1].body as string)).toEqual({
      sessionId: 's1',
      jobId: 'job-1',
      anchorId: 'wi_812',
      targetKeys: ['MOTIR-918'],
    });
  });

  it('surfaces a failed recording as a typed client error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 'MOTIR_AI_UNAVAILABLE' }, 502));

    await expect(recordPlannerTurn('s1', 'job-1', null)).rejects.toBeInstanceOf(
      PlanEditsClientError,
    );
  });

  it('appends a turn as { sessionId, body } to the turns endpoint', async () => {
    fetchMock.mockResolvedValue(jsonResponse(SESSION));

    await expect(appendPlanChangeTurn('s1', 'Split the billing epic')).resolves.toEqual(SESSION);

    const [url, init] = lastCall();
    expect(url).toBe('/api/ai/plan-change/session/turns');
    // `isAnswer` rides on every turn (MOTIR-2226) — false unless the composer
    // sent it from the answer bar.
    expect(JSON.parse(init.body as string)).toEqual({
      sessionId: 's1',
      body: 'Split the billing epic',
      isAnswer: false,
    });
  });

  it('submits the accumulated intent and returns the shipped job id + session', async () => {
    const result = { jobId: 'job-augment-1', session: SESSION };
    fetchMock.mockResolvedValue(jsonResponse(result));

    await expect(submitPlanChange('s1')).resolves.toEqual(result);

    const [url, init] = lastCall();
    expect(url).toBe('/api/ai/plan-change/session/submit');
    expect(init.method).toBe('POST');
    // Submit names the session and nothing else — the intent is the PERSISTED
    // thread, not a client-side payload. That is the whole point of the seam.
    expect(JSON.parse(init.body as string)).toEqual({ sessionId: 's1' });
  });

  it('forwards the abort signal so an unmounting rail cancels in flight', async () => {
    // A fresh Response per call — a body may only be read once.
    fetchMock.mockImplementation(async () => jsonResponse(SESSION));
    const controller = new AbortController();

    await findResumableSession(controller.signal);
    expect(lastCall()[1].signal).toBe(controller.signal);

    await getPlanChangeSession('s1', controller.signal);
    expect(lastCall()[1].signal).toBe(controller.signal);

    await startPlanChangeSession('x', controller.signal);
    expect(lastCall()[1].signal).toBe(controller.signal);

    await appendPlanChangeTurn('s1', 'x', controller.signal);
    expect(lastCall()[1].signal).toBe(controller.signal);

    await submitPlanChange('s1', controller.signal);
    expect(lastCall()[1].signal).toBe(controller.signal);
  });
});

describe('planChangeClient — the MULTI-TARGET anchors (MOTIR-1491)', () => {
  it('carries the ADDITIONAL targets beside the prompt; the primary stays the path item', async () => {
    const result = { jobId: 'job-ctx-1', sessionId: 's-ctx', session: SESSION };
    fetchMock.mockResolvedValue(jsonResponse(result));

    await expect(
      submitContextualPlan('wi_812', 'Expand billing.', ['MOTIR-918', 'MOTIR-922']),
    ).resolves.toEqual(result);

    const [url, init] = lastCall();
    // The SHIPPED 7.12.3 endpoint — the picker adds no route of its own.
    expect(url).toBe('/api/work-items/wi_812/ai/plan');
    expect(JSON.parse(init.body as string)).toEqual({
      prompt: 'Expand billing.',
      isAnswer: false,
      // The primary is NOT repeated: it travels as the path item and the service
      // adds it to the scope itself.
      targetKeys: ['MOTIR-918', 'MOTIR-922'],
    });
  });

  it('OMITS the field entirely with no additional targets — the single-anchor request is unchanged', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ jobId: 'j', sessionId: 's', session: SESSION }));

    await submitContextualPlan('wi_812', 'Re-plan this story.');

    expect(JSON.parse(lastCall()[1].body as string)).toEqual({
      prompt: 'Re-plan this story.',
      isAnswer: false,
    });
  });

  it('sends seedGuideTurnId on a first turn only, and never beside a gate seed (MOTIR-8693)', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ jobId: 'j', sessionId: 's', session: SESSION }),
    );

    await submitContextualPlan(
      'wi_812',
      'Re-plan.',
      ['MOTIR-31'],
      undefined,
      false,
      null,
      null,
      't1',
    );
    expect(JSON.parse(lastCall()[1].body as string)).toEqual({
      prompt: 'Re-plan.',
      isAnswer: false,
      targetKeys: ['MOTIR-31'],
      seedGuideTurnId: 't1',
    });

    // A named session is a later turn: the seed is dropped.
    await submitContextualPlan('wi_812', 'More.', [], undefined, false, 's-1', null, 't1');
    expect(JSON.parse(lastCall()[1].body as string)).not.toHaveProperty('seedGuideTurnId');

    // The two seeds are exclusive on a session: nothing is sent.
    fetchMock.mockClear();
    await expect(
      submitContextualPlan('wi_812', 'x', [], undefined, false, null, 'g1', 't1'),
    ).rejects.toThrow(/never both/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a RESUBMIT re-sends to the same anchor SET — retrying must not re-aim the turn', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ jobId: 'j', sessionId: 's', session: SESSION }));

    await resubmitContextualPlan('wi_812', ['MOTIR-918']);

    expect(JSON.parse(lastCall()[1].body as string)).toEqual({
      resubmit: true,
      targetKeys: ['MOTIR-918'],
    });
  });

  it('RESUMES a multi-anchor thread through repeated ?targetKey= params', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ session: SESSION }));

    await resumeContextualSession('wi_812', ['MOTIR-918', 'MOTIR-922']);

    expect(lastCall()[0]).toBe(
      '/api/work-items/wi_812/ai/plan?targetKey=MOTIR-918&targetKey=MOTIR-922',
    );
  });
});

describe('planChangeClient — the planId echo is read DEFENSIVELY (MOTIR-1745)', () => {
  it('carries the submit’s planId when the response has one', async () => {
    const result = { jobId: 'job-ctx-1', planId: 'plan_1', sessionId: 's-ctx', session: SESSION };
    fetchMock.mockResolvedValue(jsonResponse(result));

    await expect(submitContextualPlan('wi_812', 'Expand billing.')).resolves.toEqual(result);
  });

  it('still parses a submit response carrying ONLY a jobId', async () => {
    // The whole reason the browser-facing type keeps `planId` optional: an E2E
    // stub, a fixture, or a pre-1745 deployment answers without it, and the rail
    // must degrade to "nothing to confirm" rather than fail to parse.
    fetchMock.mockResolvedValue(jsonResponse({ jobId: 'job-ctx-1', session: SESSION }));

    const res = await submitPlanChange('s1');
    expect(res.jobId).toBe('job-ctx-1');
    expect(res.planId).toBeUndefined();
  });

  it('returns the resume ENVELOPE, normalizing a missing planId to null', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ session: SESSION, planId: 'plan_7' }));
    await expect(resumeContextualSession('wi_812')).resolves.toEqual({
      session: SESSION,
      planId: 'plan_7',
      earlier: null,
      copyable: null,
      heldBy: null,
    });

    // No thread, and a response predating the field, both read as "nothing
    // pending" — the caller branches on one shape, never on `undefined`.
    fetchMock.mockResolvedValue(jsonResponse({ session: null }));
    await expect(resumeContextualSession('wi_812')).resolves.toEqual({
      session: null,
      planId: null,
      earlier: null,
      copyable: null,
      heldBy: null,
    });
  });
});

describe('planChangeClient — failures surface as ONE error type', () => {
  it('throws PlanEditsClientError carrying the status and the typed code', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 'PLAN_CHANGE_SESSION_NOT_FOUND' }, 404));

    const err = await appendPlanChangeTurn('s1', 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanEditsClientError);
    expect((err as PlanEditsClientError).status).toBe(404);
    expect((err as PlanEditsClientError).code).toBe('PLAN_CHANGE_SESSION_NOT_FOUND');
  });

  it('degrades to a null code when the error body is not JSON', async () => {
    // A proxy/edge 502 with an HTML body must still raise the typed error, not
    // an unhandled parse throw — the rail branches on the class, not the body.
    fetchMock.mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502 }));

    const err = await submitPlanChange('s1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanEditsClientError);
    expect((err as PlanEditsClientError).status).toBe(502);
    expect((err as PlanEditsClientError).code).toBeNull();
  });

  it('degrades to a null code when the JSON error body carries no code', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'nope' }, 400));

    const err = await startPlanChangeSession('x').catch((e: unknown) => e);
    expect((err as PlanEditsClientError).code).toBeNull();
  });

  it('reports the metered-AI refusal through the SHARED isOutOfCredits flag', async () => {
    // The reason this module reuses `PlanEditsClientError` rather than minting
    // its own: the rail's out-of-credits branch is one check for every AI call.
    fetchMock.mockResolvedValue(jsonResponse({ code: 'MOTIR_AI_OUT_OF_CREDITS' }, 402));

    const err = (await submitPlanChange('s1').catch((e: unknown) => e)) as PlanEditsClientError;
    expect(err.isOutOfCredits).toBe(true);
  });
});

// ─── The ITEM-ANCHORED calls (MOTIR-910 → the MOTIR-909 endpoints) ───────────

describe('the anchored transport — a work item’s own thread', () => {
  it('resumes by GET, and reads an unplanned item as null rather than an error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ session: null }));
    // The ENVELOPE, not the bare session (MOTIR-1745) — a resume also reports the
    // thread's pending proposal, so an unplanned item reads as null on both.
    expect(await resumeContextualSession('wi_123')).toEqual({
      session: null,
      planId: null,
      earlier: null,
      copyable: null,
      heldBy: null,
    });

    const [url, init] = lastCall();
    expect(url).toBe('/api/work-items/wi_123/ai/plan');
    expect(init?.method ?? 'GET').toBe('GET');
  });

  it('returns the thread when the item has one', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ session: SESSION }));
    expect(await resumeContextualSession('wi_123')).toMatchObject({
      session: { id: SESSION.id },
    });
  });

  it('submits a turn as ONE POST carrying the prompt — the reason IS the turn', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ jobId: 'job-1', sessionId: 's1', session: SESSION }),
    );
    const result = await submitContextualPlan('wi_123', 'Split this story.');

    expect(result.jobId).toBe('job-1');
    const [url, init] = lastCall();
    expect(url).toBe('/api/work-items/wi_123/ai/plan');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      prompt: 'Split this story.',
      isAnswer: false,
    });
  });

  it('retries with the resubmit flag and NO prompt — nothing new is said', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ jobId: 'job-2', sessionId: 's1', session: SESSION }),
    );
    await resubmitContextualPlan('wi_123');

    const [, init] = lastCall();
    expect(JSON.parse(init.body as string)).toEqual({ resubmit: true });
  });

  it('names the HELD session on a resume, a turn and a retry (MOTIR-6023)', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ jobId: 'j', sessionId: 's1', session: SESSION }),
    );

    await resumeContextualSession('wi_123', [], undefined, 's1');
    expect(lastCall()[0]).toBe('/api/work-items/wi_123/ai/plan?sessionId=s1');

    await resumeContextualSession('wi_123', ['MOTIR-9'], undefined, 's1');
    expect(lastCall()[0]).toBe('/api/work-items/wi_123/ai/plan?targetKey=MOTIR-9&sessionId=s1');

    await submitContextualPlan('wi_123', 'Split.', [], undefined, false, 's1');
    expect(JSON.parse(lastCall()[1].body as string)).toEqual({
      prompt: 'Split.',
      isAnswer: false,
      sessionId: 's1',
    });

    await resubmitContextualPlan('wi_123', [], undefined, 's1');
    expect(JSON.parse(lastCall()[1].body as string)).toEqual({ resubmit: true, sessionId: 's1' });
  });

  it('encodes the anchor id into the path', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ session: null }));
    await resumeContextualSession('wi/123');
    expect(lastCall()[0]).toBe('/api/work-items/wi%2F123/ai/plan');
  });

  it('raises the ONE error type a caller branches on, carrying the typed code', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 'WORK_ITEM_NOT_FOUND' }, 404));
    await expect(resumeContextualSession('wi_gone')).rejects.toBeInstanceOf(PlanEditsClientError);

    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 'MOTIR_AI_OUT_OF_CREDITS' }, 402));
    await expect(submitContextualPlan('wi_123', 'x')).rejects.toMatchObject({
      isOutOfCredits: true,
    });
  });
});

// ── The ASK door (MOTIR-1343) ────────────────────────────────────────────────
//
// The project thread's ONE entrance. What these prove is the half the hook's
// mocks hide, and it is the same property the ADR rests on: the client sends
// TEXT and never an intent. A request body growing an `intent` key is the mode
// the design deliberately does not have, arriving through the back door — so the
// shape of what goes out is asserted exactly, not merely that a call was made.

describe('the ask door', () => {
  it('sends a NEW turn as text plus the affordance flag — and nothing else', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ jobId: 'j1', turnId: 't0', session: SESSION }));

    await expect(submitAskTurn('why is it blocked?')).resolves.toEqual({
      jobId: 'j1',
      turnId: 't0',
      session: SESSION,
    });

    const [url, init] = lastCall();
    expect(url).toBe('/api/ai/ask');
    expect(init.method).toBe('POST');
    // EXACTLY these two keys. `isAnswer` is not an intent — it records which
    // affordance sent the turn — and there is no third field for one to hide in.
    expect(JSON.parse(init.body as string)).toEqual({
      body: 'why is it blocked?',
      isAnswer: false,
    });
  });

  it('carries `isAnswer` when the ANSWER bar sent it', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ jobId: 'j1', turnId: 't0', session: SESSION }));

    await submitAskTurn('money in', undefined, true);

    expect(JSON.parse(lastCall()[1].body as string)).toEqual({ body: 'money in', isAnswer: true });
  });

  it('RE-RUNS a turn by naming it — the retry, which asks for no flip', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ jobId: 'j2', turnId: 't0', session: SESSION }));

    await expect(rerunAskTurn('t0')).resolves.toEqual({
      jobId: 'j2',
      turnId: 't0',
      session: SESSION,
    });

    const [url, init] = lastCall();
    expect(url).toBe('/api/ai/ask');
    // No `flip` key at all, rather than `flip: false` — the two mean different
    // things to the route, and a retry is not a correction.
    expect(JSON.parse(init.body as string)).toEqual({ turnId: 't0' });
  });

  it('asks for a FLIP by naming the turn — never the direction', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ jobId: 'j3', turnId: 't0', session: SESSION }));

    await rerunAskTurn('t0', { flip: true });

    // Which intent to flip TO is derived server-side from what the turn ran as.
    // A direction on the wire would be the client resolving the intent.
    expect(JSON.parse(lastCall()[1].body as string)).toEqual({ turnId: 't0', flip: true });
  });

  it('accepts the REDIRECT shape from either entrance', async () => {
    // A turn can be handed straight to the plan-change submit — a reply to the
    // planner's pending question, or a flip — so both helpers can answer with a
    // redirect instead of a job to stream.
    const redirect = { outcome: 'redirected', jobId: 'aug-1', planId: 'plan-1', session: SESSION };
    // A FRESH Response per call: a body can only be read once, so reusing one
    // instance across two awaits fails on the second with "Body is unusable".
    fetchMock.mockImplementation(async () => jsonResponse(redirect));

    await expect(submitAskTurn('money in', undefined, true)).resolves.toEqual(redirect);
    await expect(rerunAskTurn('t0', { flip: true })).resolves.toEqual(redirect);
  });

  it('files a settled job by id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ outcome: 'answered', session: SESSION }));

    await expect(settleAskJob('j1')).resolves.toEqual({ outcome: 'answered', session: SESSION });

    const [url, init] = lastCall();
    expect(url).toBe('/api/ai/ask/settle');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ jobId: 'j1' });
  });

  it('names the HELD session on a new turn, a re-run and a settle (MOTIR-6023)', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ jobId: 'j1', turnId: 't0', session: SESSION }),
    );

    await submitAskTurn('why?', undefined, false, 's1');
    expect(JSON.parse(lastCall()[1].body as string)).toEqual({
      body: 'why?',
      isAnswer: false,
      sessionId: 's1',
    });

    await rerunAskTurn('t0', { sessionId: 's1' });
    expect(JSON.parse(lastCall()[1].body as string)).toEqual({ turnId: 't0', sessionId: 's1' });

    await rerunAskTurn('t0', { flip: true, sessionId: 's1' });
    expect(JSON.parse(lastCall()[1].body as string)).toEqual({
      turnId: 't0',
      flip: true,
      sessionId: 's1',
    });

    await settleAskJob('j1', undefined, 's1');
    expect(JSON.parse(lastCall()[1].body as string)).toEqual({ jobId: 'j1', sessionId: 's1' });

    // A null session is OMITTED, never sent as `null`.
    await submitAskTurn('why?', undefined, false, null);
    expect(JSON.parse(lastCall()[1].body as string)).toEqual({ body: 'why?', isAnswer: false });
  });

  it('raises the ONE error type a caller branches on', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 'MOTIR_AI_OUT_OF_CREDITS' }, 402));

    const err = await submitAskTurn('why?').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PlanEditsClientError);
    expect((err as PlanEditsClientError).isOutOfCredits).toBe(true);
  });
});

// THE BOUNDARY MAILBOX's client half (Story MOTIR-4054 · MOTIR-4067 / MOTIR-4068 /
// MOTIR-4274). Same contract as every door above: an HTTP hop to the shipped
// route, the exact request shape, the one error type.
describe('the mailbox doors', () => {
  const DELIVERY = {
    turns: [
      { id: 'm1', text: 'Also drop it.', receivedAt: 'x', disposition: 'fold', target: null },
    ],
    stopped: false,
  };

  it('attaches a mid-run turn — job, body and the PER-SEND idempotency key, nothing else', async () => {
    fetchMock.mockResolvedValue(jsonResponse(DELIVERY));

    await expect(
      attachMidRunTurn('s1', 'job-1', 'Also drop it.', 'turn:job-1:k1'),
    ).resolves.toEqual(DELIVERY);

    const [url, init] = lastCall();
    expect(url).toBe('/api/ai/plan-change/session/mailbox');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      sessionId: 's1',
      jobId: 'job-1',
      body: 'Also drop it.',
      idempotencyKey: 'turn:job-1:k1',
    });
  });

  it('PEEKS the mailbox as a GET keyed on the job — the read the composer polls', async () => {
    fetchMock.mockResolvedValue(jsonResponse(DELIVERY));

    await expect(peekMailbox('s 1', 'job 1')).resolves.toEqual(DELIVERY);

    const [url, init] = lastCall();
    // Encoded, so neither id is ever a path or query injection.
    expect(url).toBe('/api/ai/plan-change/session/mailbox?jobId=job%201&sessionId=s%201');
    expect(init.method).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it('a failed peek raises the ONE error type, carrying the door’s code', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 'PLAN_CHANGE_JOB_NOT_RUNNING' }, 409));

    const err = await peekMailbox('s1', 'job-1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PlanEditsClientError);
    expect((err as PlanEditsClientError).status).toBe(409);
    expect((err as PlanEditsClientError).code).toBe('PLAN_CHANGE_JOB_NOT_RUNNING');
  });

  it('raises a STOP through the same mailbox, keyed per click', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ turns: [], stopped: true }));

    await expect(stopPlanChangeRun('s1', 'job-1', 'stop:job-1')).resolves.toEqual({
      turns: [],
      stopped: true,
    });

    const [url, init] = lastCall();
    expect(url).toBe('/api/ai/plan-change/session/mailbox/stop');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      sessionId: 's1',
      jobId: 'job-1',
      idempotencyKey: 'stop:job-1',
    });
  });

  it('raises a SKIP of the final check through the same mailbox (MOTIR-11266)', async () => {
    const answer = {
      outcome: 'skipped',
      mailbox: { turns: [], stopped: false, skipFinalCheck: true },
    };
    fetchMock.mockResolvedValue(jsonResponse(answer));

    await expect(skipPlanFinalCheck('s1', 'job-1', 'skip-final-check:job-1')).resolves.toEqual(
      answer,
    );

    const [url, init] = lastCall();
    expect(url).toBe('/api/ai/plan-change/session/mailbox/skip-final-check');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      sessionId: 's1',
      jobId: 'job-1',
      idempotencyKey: 'skip-final-check:job-1',
    });
  });

  it('forwards the caller’s abort signal on every door', async () => {
    // A fresh Response per call: a body reads once.
    fetchMock.mockImplementation(async () => jsonResponse(DELIVERY));
    const controller = new AbortController();

    await attachMidRunTurn('s1', 'job-1', 'x', 'k', controller.signal);
    expect(lastCall()[1].signal).toBe(controller.signal);
    await peekMailbox('s1', 'job-1', controller.signal);
    expect(lastCall()[1].signal).toBe(controller.signal);
    await stopPlanChangeRun('s1', 'job-1', 'k', controller.signal);
    expect(lastCall()[1].signal).toBe(controller.signal);
  });
});

describe('planChangeClient — Plan something new (Story MOTIR-7631 · MOTIR-7650; MOTIR-11261)', () => {
  // The dialog's confirm and a legacy confirm turn's answers both post the one
  // restart door; nothing raises a confirm turn any more (MOTIR-11261).
  it('answers the confirm as a POST { sessionId, answer } — keep and confirm alike', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(SESSION));
    await expect(answerRestart('s1', 'keep')).resolves.toEqual(SESSION);
    let [url, init] = lastCall();
    expect(url).toBe('/api/ai/plan-change/session/restart');
    expect(JSON.parse(init.body as string)).toEqual({ sessionId: 's1', answer: 'keep' });

    const swapped = {
      outcome: 'restarted',
      endedSessionId: 's1',
      session: { ...SESSION, id: 's2' },
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(swapped));
    await expect(answerRestart('s1', 'confirm')).resolves.toEqual(swapped);
    [url, init] = lastCall();
    expect(url).toBe('/api/ai/plan-change/session/restart');
    expect(JSON.parse(init.body as string)).toEqual({ sessionId: 's1', answer: 'confirm' });
  });

  it('a refused answer is the typed client error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 'PLAN_SESSION_ENDED' }, 409));
    await expect(answerRestart('s1', 'confirm')).rejects.toBeInstanceOf(PlanEditsClientError);
  });
});

describe('resumePlanSession (MOTIR-7916)', () => {
  it('posts { sessionId } to the resume door and returns { jobId, planId, session }', async () => {
    const result = { jobId: 'job-2', planId: 'plan-1', session: { id: 's1' } };
    fetchMock.mockResolvedValue(jsonResponse(result));

    await expect(resumePlanSession('s1')).resolves.toEqual(result);

    const [url, init] = lastCall();
    expect(url).toBe('/api/ai/plan-change/session/resume');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ sessionId: 's1' });
  });

  it('surfaces the code, and on RESUME_ALREADY_STARTED the winning jobId', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ code: 'RESUME_ALREADY_STARTED', error: 'already', jobId: 'job-winner' }, 409),
    );

    const err = await resumePlanSession('s1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PlanEditsClientError);
    expect((err as PlanEditsClientError).status).toBe(409);
    expect((err as PlanEditsClientError).code).toBe('RESUME_ALREADY_STARTED');
    expect(resumeAlreadyStartedJobId(err)).toBe('job-winner');
  });

  it('reads no job from any other refusal', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 'NOT_SESSION_OWNER', error: 'no' }, 403));

    const err = await resumePlanSession('s1').catch((e: unknown) => e);

    expect((err as PlanEditsClientError).code).toBe('NOT_SESSION_OWNER');
    expect(resumeAlreadyStartedJobId(err)).toBeNull();
    expect(resumeAlreadyStartedJobId(new Error('x'))).toBeNull();
  });
});

describe('planChangeClient — talking to the planner mid-run (Story MOTIR-7990)', () => {
  const PAUSE = {
    id: 'pause-1',
    jobId: 'job-1',
    kind: 'replan',
    question: 'Start over or apply to what is written?',
    status: 'open',
  };

  it('sends a turn typed WHILE a run plans to the ASK door, with the run and its plan (MOTIR-7996)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ jobId: 'ask-1', sessionId: 's1' }));

    await expect(submitMidRunAskTurn('s1', 'job-1', 'plan-1', 'Is it on track?')).resolves.toEqual({
      jobId: 'ask-1',
      sessionId: 's1',
    });

    const [url, init] = lastCall();
    // NOT the mailbox: the answering session hears it first.
    expect(url).toBe('/api/ai/ask');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      body: 'Is it on track?',
      sessionId: 's1',
      runJobId: 'job-1',
      planId: 'plan-1',
    });
  });

  it('turns a finished run’s stranded changes into ONE late revision (MOTIR-7997)', async () => {
    const revised = { outcome: 'revised', planId: 'plan-1', revisionJobId: 'rev-1', texts: ['x'] };
    fetchMock.mockResolvedValue(jsonResponse(revised));

    await expect(submitLateChanges('s1', 'job-1')).resolves.toEqual(revised);

    const [url, init] = lastCall();
    expect(url).toBe('/api/ai/plan-change/session/late-changes');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ sessionId: 's1', runJobId: 'job-1' });
  });

  it('READS the run’s pause as a GET keyed on session and job, encoded (MOTIR-8007)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(PAUSE));

    await expect(readRunPause('s 1', 'job/1')).resolves.toEqual(PAUSE);

    const [url, init] = lastCall();
    expect(url).toBe('/api/ai/plan-change/session/run-pause?sessionId=s%201&jobId=job%2F1');
    expect(init.method).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it('reads NO pause as null, not an error', async () => {
    fetchMock.mockResolvedValue(jsonResponse(null));
    await expect(readRunPause('s1', 'job-1')).resolves.toBeNull();
  });

  it('answers a replan pause with a CHOICE alone — no text key at all', async () => {
    const answered = { outcome: 'answered', pause: PAUSE, delivery: { turns: [], stopped: false } };
    fetchMock.mockResolvedValue(jsonResponse(answered));

    await expect(answerRunPause('s1', 'job-1', 'pause-1', 'start_over')).resolves.toEqual(answered);

    const [url, init] = lastCall();
    expect(url).toBe('/api/ai/plan-change/session/run-pause');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      sessionId: 's1',
      jobId: 'job-1',
      pauseId: 'pause-1',
      choice: 'start_over',
    });
  });

  it('answers an unclear pause with the typed REPLY text', async () => {
    const refused = {
      outcome: 'refused',
      code: 'PLAN_CHANGE_JOB_NOT_RUNNING',
      jobStatus: 'succeeded',
      choice: 'reply',
      text: 'The billing one.',
      pause: PAUSE,
    };
    fetchMock.mockResolvedValue(jsonResponse(refused));

    await expect(
      answerRunPause('s1', 'job-1', 'pause-1', 'reply', 'The billing one.'),
    ).resolves.toEqual(refused);

    expect(JSON.parse(lastCall()[1].body as string)).toEqual({
      sessionId: 's1',
      jobId: 'job-1',
      pauseId: 'pause-1',
      choice: 'reply',
      text: 'The billing one.',
    });
  });

  it('forwards the abort signal on every mid-run door, and fails with the ONE error type', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(PAUSE));
    const controller = new AbortController();

    await submitMidRunAskTurn('s1', 'job-1', 'plan-1', 'x', controller.signal);
    expect(lastCall()[1].signal).toBe(controller.signal);
    await submitLateChanges('s1', 'job-1', controller.signal);
    expect(lastCall()[1].signal).toBe(controller.signal);
    await readRunPause('s1', 'job-1', controller.signal);
    expect(lastCall()[1].signal).toBe(controller.signal);
    await answerRunPause('s1', 'job-1', 'pause-1', 'apply', undefined, controller.signal);
    expect(lastCall()[1].signal).toBe(controller.signal);

    fetchMock.mockImplementation(async () =>
      jsonResponse({ code: 'PLAN_CHANGE_RUN_PAUSE_NOT_FOUND' }, 404),
    );
    const err = await readRunPause('s1', 'job-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanEditsClientError);
    expect((err as PlanEditsClientError).status).toBe(404);
  });
});
