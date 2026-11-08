import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlanRequestError, revisePlanRequest } from '@/lib/planning/planReviewClient';

// Story MOTIR-3595 · Subtask MOTIR-3601 — the client half of the revision submit.
//
// Small, and the reason it is tested at all is the SECOND case: the surface
// branches on the code this function throws. A refusal that arrives as a
// `PLAN_REVISION_IN_FLIGHT` renders "a revision is changing this plan"; anything
// else renders the generic action error. So the code has to survive the trip
// intact, and the fallback has to be a code rather than an undefined.

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

afterEach(() => {
  fetchMock.mockReset();
});

function respond(body: unknown, status = 200): void {
  fetchMock.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

describe('revisePlanRequest', () => {
  it('posts the plan id and the instruction, and returns the SAME plan id', async () => {
    respond({ jobId: 'job_1', planId: 'plan_1' });

    const result = await revisePlanRequest('plan_1', 'Split the second story in two');

    expect(result).toEqual({ jobId: 'job_1', planId: 'plan_1' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/ai/revise');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      planId: 'plan_1',
      prompt: 'Split the second story in two',
    });
  });

  it('carries the server’s CODE through — the surface branches on it', async () => {
    respond({ code: 'PLAN_REVISION_IN_FLIGHT', error: 'held' }, 409);

    const err = await revisePlanRequest('plan_1', 'Split it').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanRequestError);
    expect((err as PlanRequestError).code).toBe('PLAN_REVISION_IN_FLIGHT');
    expect((err as PlanRequestError).status).toBe(409);
  });

  it('falls back to a CODE, never undefined, when the body carries none', async () => {
    respond({}, 500);
    const err = await revisePlanRequest('plan_1', 'Split it').catch((e: unknown) => e);
    expect((err as PlanRequestError).code).toBe('REVISE_FAILED');
  });

  it('survives a body that is not JSON at all — a proxy’s HTML error page', async () => {
    // The `.catch(() => ({}))` arm. Without it a 502 from something in front of
    // the app throws a SyntaxError out of the client, and the surface reports a
    // parse failure instead of the refusal the reader can act on.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    });

    const err = await revisePlanRequest('plan_1', 'Split it').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanRequestError);
    expect((err as PlanRequestError).code).toBe('REVISE_FAILED');
    expect((err as PlanRequestError).status).toBe(502);
  });
});

describe('declinePlanRequest — the decline’s OPTIONAL reason (Story MOTIR-6012 · MOTIR-6037)', () => {
  it('sends the reason beside the stamp when the reader gave one', async () => {
    const { declinePlanRequest } = await import('@/lib/planning/planReviewClient');
    respond({ id: 'plan_1', status: 'declined' });
    await declinePlanRequest('plan_1', 'stamp_1', 'Not this quarter');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/plans/plan_1/decline');
    expect(JSON.parse(init.body)).toEqual({ stamp: 'stamp_1', noteMd: 'Not this quarter' });
  });

  it('sends only the stamp when there is no reason', async () => {
    const { declinePlanRequest } = await import('@/lib/planning/planReviewClient');
    respond({ id: 'plan_1', status: 'declined' });
    await declinePlanRequest('plan_1', 'stamp_1');
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ stamp: 'stamp_1' });
  });
});

describe('the PRESS body — the stamp the reader was shown rides every decision (MOTIR-6038)', () => {
  it('approve hands back the stamp, as JSON', async () => {
    const { approvePlanRequest } = await import('@/lib/planning/planReviewClient');
    respond({ id: 'plan_1', status: 'approved', items: [] });
    await approvePlanRequest('plan_1', 'stamp_1');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/plans/plan_1/approve');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ stamp: 'stamp_1' });
  });

  it('a press made with NO question shown sends an explicit null stamp — the server decides', async () => {
    const { approvePlanRequest, declinePlanRequest } =
      await import('@/lib/planning/planReviewClient');
    respond({ id: 'plan_1', status: 'approved', items: [] });
    await approvePlanRequest('plan_1');
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ stamp: null });

    respond({ id: 'plan_1', status: 'declined' });
    await declinePlanRequest('plan_1', undefined, 'Not this quarter');
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({
      stamp: null,
      noteMd: 'Not this quarter',
    });
  });

  it('an approve refused by the door carries its code, the proposal and the sentence', async () => {
    const { approvePlanRequest } = await import('@/lib/planning/planReviewClient');
    respond(
      { code: 'APPROVAL_GATE_STALE_SUBJECT', planItemId: 'pi_1', error: 'The plan moved.' },
      409,
    );
    const err = await approvePlanRequest('plan_1', 'stamp_old').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanRequestError);
    expect((err as PlanRequestError).code).toBe('APPROVAL_GATE_STALE_SUBJECT');
    expect((err as PlanRequestError).detail).toEqual({
      planItemId: 'pi_1',
      message: 'The plan moved.',
      // The column a PLAN_ITEM_FIELD_REJECTED names (MOTIR-10657); this refusal names none.
      field: null,
    });
  });

  it('an approve refusal with no readable body is a code-less refusal, not a parse error', async () => {
    const { approvePlanRequest } = await import('@/lib/planning/planReviewClient');
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    });
    const err = await approvePlanRequest('plan_1', 'stamp_1').catch((e: unknown) => e);
    expect((err as PlanRequestError).status).toBe(502);
    expect((err as PlanRequestError).code).toBeNull();
  });

  it('a decline refused by the door carries its code', async () => {
    const { declinePlanRequest } = await import('@/lib/planning/planReviewClient');
    respond({ code: 'PLAN_REVISION_IN_FLIGHT' }, 409);
    const err = await declinePlanRequest('plan_1', 'stamp_1').catch((e: unknown) => e);
    expect((err as PlanRequestError).code).toBe('PLAN_REVISION_IN_FLIGHT');
  });

  it('a decline refusal with no readable body is a code-less refusal, not a parse error', async () => {
    const { declinePlanRequest } = await import('@/lib/planning/planReviewClient');
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    });
    const err = await declinePlanRequest('plan_1', 'stamp_1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanRequestError);
    expect((err as PlanRequestError).status).toBe(502);
    expect((err as PlanRequestError).code).toBeNull();
  });

  it('a refusal whose body names nothing carries nulls — never an undefined', async () => {
    const { approvePlanRequest, declinePlanRequest } =
      await import('@/lib/planning/planReviewClient');
    respond({ planItemId: 42 }, 409);
    const approveErr = await approvePlanRequest('plan_1', 'stamp_1').catch((e: unknown) => e);
    expect((approveErr as PlanRequestError).code).toBeNull();
    expect((approveErr as PlanRequestError).detail).toEqual({
      planItemId: null,
      message: null,
      field: null,
    });

    respond({}, 409);
    const declineErr = await declinePlanRequest('plan_1', 'stamp_1').catch((e: unknown) => e);
    expect((declineErr as PlanRequestError).code).toBeNull();
  });
});
