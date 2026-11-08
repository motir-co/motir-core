import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  approvePlanRequest,
  declinePlanRequest,
  PlanRequestError,
} from '@/lib/planning/planReviewClient';
import {
  isPlanDecisionRefusal,
  planDecisionErrorCode,
  planDecisionRefusal,
  readPendingProposal,
  summarizePlanApproval,
} from '@/lib/planning/planReview';
import { planReview, planReviewItem } from '../helpers/planReview';
import type { PlanWithItemsDto } from '@/lib/dto/plans';

// The helpers EVERY AI-planning surface shares (MOTIR-1747). They are small, and
// that is the point: the rail, the item-scoped dock and the `/ready` nudge must
// answer "is there a proposal pending?" identically, or the three entrances drift
// into three different ideas of what a settled run means.

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
  } as unknown as Response);
}

describe('readPendingProposal', () => {
  it('returns the review when the plan is `planned` AND carries items', async () => {
    respond(planReview([planReviewItem({ title: 'A proposed story' })]));

    const pending = await readPendingProposal('plan_1');

    expect(pending?.items).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/plans/plan_1', expect.anything());
  });

  // `generating` is still filling its frontier; `approved` / `declined` is
  // history, not a review.
  it.each(['generating', 'approved', 'declined'] as const)(
    'returns null for a `%s` plan',
    async (status) => {
      respond(planReview([planReviewItem()], { status }));

      expect(await readPendingProposal('plan_1')).toBeNull();
    },
  );

  it('returns null for a `planned` plan with NO proposals — the empty run', async () => {
    // The case the old delta read reported for EVERY run. It is still a real
    // outcome (a planner can genuinely propose nothing); it just has to be rare
    // rather than universal.
    respond(planReview([]));

    expect(await readPendingProposal('plan_1')).toBeNull();
  });

  it('propagates a failed read as a typed error rather than a null', async () => {
    // "Nothing pending" and "we could not tell" are different states; a surface
    // that cannot distinguish them silently swallows an outage.
    respond({ code: 'PLAN_NOT_FOUND' }, 404);

    await expect(readPendingProposal('plan_1')).rejects.toBeInstanceOf(PlanRequestError);
  });
});

describe('summarizePlanApproval', () => {
  it('reports created / updated / removed from the materialized plan', () => {
    const plan = {
      items: [
        { id: 'pi_1', op: 'add', workItemId: 'wi_1' },
        { id: 'pi_2', op: 'add', workItemId: null },
        { id: 'pi_3', op: 'modify', workItemId: 'wi_9' },
        { id: 'pi_4', op: 'remove', workItemId: 'wi_8' },
      ],
    } as unknown as PlanWithItemsDto;

    expect(summarizePlanApproval(plan)).toEqual({
      // A materialized `add` names the work item it BECAME; one that somehow has
      // no id falls back to the proposal id rather than dropping out of the count.
      created: ['wi_1', 'pi_2'],
      updated: ['wi_9'],
      removed: ['wi_8'],
    });
  });
});

describe('planDecisionErrorCode', () => {
  it('names the refusal the persist gate raises', () => {
    expect(planDecisionErrorCode(new PlanRequestError(409, 'PLAN_TARGET_IMMUTABLE'))).toBe(
      'immutable',
    );
  });

  it('names an already-decided plan, by code or by 404', () => {
    expect(planDecisionErrorCode(new PlanRequestError(409, 'PLAN_NOT_IN_EXPECTED_STATUS'))).toBe(
      'decided',
    );
    expect(planDecisionErrorCode(new PlanRequestError(404, null))).toBe('decided');
  });

  it('answers a decided or withdrawn gate the same as a decided plan', () => {
    expect(planDecisionErrorCode(new PlanRequestError(409, 'APPROVAL_GATE_ALREADY_DECIDED'))).toBe(
      'decided',
    );
    expect(planDecisionErrorCode(new PlanRequestError(409, 'APPROVAL_GATE_SUPERSEDED'))).toBe(
      'decided',
    );
  });

  it("names the decide door's plan refusals: held, stale and not decidable yet", () => {
    expect(planDecisionErrorCode(new PlanRequestError(409, 'PLAN_REVISION_IN_FLIGHT'))).toBe(
      'held',
    );
    expect(planDecisionErrorCode(new PlanRequestError(409, 'APPROVAL_GATE_STALE_SUBJECT'))).toBe(
      'stale',
    );
    expect(planDecisionErrorCode(new PlanRequestError(409, 'PLAN_GATE_AWAITING'))).toBe('stale');
    expect(planDecisionErrorCode(new PlanRequestError(409, 'PLAN_NOT_DECIDABLE_YET'))).toBe(
      'notDecidable',
    );
  });

  it('falls back for anything else, so no raw server code reaches the screen', () => {
    expect(planDecisionErrorCode(new PlanRequestError(500, 'BOOM'))).toBe('APPROVE_ERROR');
    expect(planDecisionErrorCode(new Error('network'))).toBe('APPROVE_ERROR');
    expect(planDecisionErrorCode(new Error('network'), 'discard')).toBe('discard');
    // A 4xx with no code is not a refusal the server explained.
    expect(planDecisionErrorCode(new PlanRequestError(400, null))).toBe('APPROVE_ERROR');
  });

  // MOTIR-10657 — every refusal the approve route returns that the keys above do not
  // name gets a decision-specific key, never the conversation's generic line.
  it.each([
    ['PLAN_ITEM_FIELD_REJECTED', 422, 'proposalRejected'],
    ['INVALID_PROPOSAL', 422, 'proposalRejected'],
    ['PLAN_ITEM_UNKNOWN_TARGET_REPO', 422, 'proposalRejected'],
    ['PLAN_ITEM_UNKNOWN_TARGET_REPO_ROLE', 422, 'proposalRejected'],
    ['PLAN_GRAMMAR_VIOLATION', 400, 'proposalRejected'],
    ['INVALID_PLAN_REF_GRAPH', 400, 'proposalRejected'],
    ['UNRESOLVED_PLAN_REF', 422, 'proposalRejected'],
    ['PLAN_ITEM_TARGET_MISSING', 422, 'proposalRejected'],
    ['PLAN_PROPOSAL_REPO_PIN_MOVED', 409, 'repoPinMoved'],
    ['WORK_ITEM_LINK_CYCLE', 409, 'linkRefused'],
    ['SELF_LINK', 409, 'linkRefused'],
    ['DUPLICATE_LINK', 409, 'linkRefused'],
    ['APPROVAL_GATE_NOT_AUTHORISED', 403, 'notAuthorised'],
    ['PROJECT_ACCESS_DENIED', 403, 'notAuthorised'],
    ['PLAN_DECISION_STAMP_REQUIRED', 400, 'refused'],
    ['PLAN_HAS_NO_PROPOSALS', 409, 'refused'],
  ])('maps %s (%i) to %s, for approve and discard alike', (code, status, key) => {
    const err = new PlanRequestError(status, code);
    expect(planDecisionErrorCode(err)).toBe(key);
    expect(planDecisionErrorCode(err, 'discard')).toBe(key);
    expect(isPlanDecisionRefusal(key)).toBe(true);
  });

  it('isPlanDecisionRefusal is false for the older keys and for no code', () => {
    expect(isPlanDecisionRefusal('decided')).toBe(false);
    expect(isPlanDecisionRefusal('APPROVE_ERROR')).toBe(false);
    expect(isPlanDecisionRefusal(null)).toBe(false);
  });
});

describe('planDecisionRefusal', () => {
  const review = planReview([
    planReviewItem({ planItemId: 'pi_1', identifier: null, title: 'Recurring invoices' }),
    planReviewItem({ planItemId: 'pi_2', identifier: 'PAY-21', title: 'Dunning' }),
  ]);

  it('names the refused proposal by its title, and the column the server named', () => {
    const err = new PlanRequestError(422, 'PLAN_ITEM_FIELD_REJECTED', {
      planItemId: 'pi_1',
      message: 'Proposal pi_1 has an invalid priority.',
      field: 'priority',
    });
    expect(planDecisionRefusal(err, review)).toEqual({
      item: 'Recurring invoices',
      fieldKind: 'named',
      field: 'priority',
      reason: 'Proposal pi_1 has an invalid priority.',
    });
  });

  it('labels a proposal about a committed work item with its key', () => {
    const err = new PlanRequestError(409, 'PLAN_PROPOSAL_REPO_PIN_MOVED', {
      planItemId: 'pi_2',
      message: null,
    });
    expect(planDecisionRefusal(err, review)?.item).toBe('PAY-21 Dunning');
  });

  it('reads the field off the code for the two repository refusals', () => {
    const repo = new PlanRequestError(422, 'PLAN_ITEM_UNKNOWN_TARGET_REPO', {
      planItemId: 'pi_1',
      message: 'unknown repo',
    });
    const role = new PlanRequestError(422, 'PLAN_ITEM_UNKNOWN_TARGET_REPO_ROLE', {
      planItemId: 'pi_1',
      message: 'unknown role',
    });
    expect(planDecisionRefusal(repo, review)?.fieldKind).toBe('repository');
    expect(planDecisionRefusal(role, review)?.fieldKind).toBe('repositoryRole');
  });

  it('names no proposal when the response carries none, or one the review does not hold', () => {
    const none = new PlanRequestError(422, 'INVALID_PROPOSAL');
    const unknown = new PlanRequestError(422, 'INVALID_PROPOSAL', {
      planItemId: 'pi_gone',
      message: 'x',
    });
    expect(planDecisionRefusal(none, review)).toEqual({
      item: null,
      fieldKind: 'other',
      field: null,
      reason: null,
    });
    expect(planDecisionRefusal(unknown, null)?.item).toBeNull();
    expect(planDecisionRefusal(unknown, review)?.item).toBeNull();
  });

  it('is null for anything the older keys or the recoverable fallback answer', () => {
    expect(planDecisionRefusal(new PlanRequestError(409, 'PLAN_TARGET_IMMUTABLE'), review)).toBe(
      null,
    );
    expect(planDecisionRefusal(new PlanRequestError(500, 'BOOM'), review)).toBeNull();
    expect(planDecisionRefusal(new Error('network'), review)).toBeNull();
  });
});

// MOTIR-10657 — both decision calls carry the refusal's detail, the column included.
describe('the decision calls read the refusal detail', () => {
  it('approve carries planItemId, the sentence and the field', async () => {
    respond(
      {
        code: 'PLAN_ITEM_FIELD_REJECTED',
        planItemId: 'pi_1',
        field: 'priority',
        error: 'Proposal pi_1: priority is invalid.',
      },
      422,
    );
    const err = (await approvePlanRequest('plan_1').catch((e: unknown) => e)) as PlanRequestError;
    expect(err.code).toBe('PLAN_ITEM_FIELD_REJECTED');
    expect(err.detail).toEqual({
      planItemId: 'pi_1',
      message: 'Proposal pi_1: priority is invalid.',
      field: 'priority',
    });
  });

  it('decline carries the sentence, with no proposal or field when the body names none', async () => {
    respond({ code: 'APPROVAL_GATE_NOT_AUTHORISED', error: 'Not yours to decide.' }, 403);
    const err = (await declinePlanRequest('plan_1').catch((e: unknown) => e)) as PlanRequestError;
    expect(err.status).toBe(403);
    expect(err.detail).toEqual({ planItemId: null, message: 'Not yours to decide.', field: null });
  });

  it('a body that is not JSON leaves every detail null', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('not json');
      },
    } as unknown as Response);
    const err = (await declinePlanRequest('plan_1').catch((e: unknown) => e)) as PlanRequestError;
    expect(err.code).toBeNull();
    expect(err.detail).toEqual({ planItemId: null, message: null, field: null });
  });
});
