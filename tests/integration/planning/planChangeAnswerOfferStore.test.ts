import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { SubmittedRequirement } from '@/lib/ai/types';
import { buildScope } from '@/lib/planChange/scope';
import { toPlanChangeSessionDto } from '@/lib/mappers/planChangeMappers';
import { planChangeTurnRepository } from '@/lib/repositories/planChangeTurnRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// THE ANSWER OFFER, STORED (Story MOTIR-9219 · MOTIR-9288), on real Postgres with RLS
// on: an offer appended with its answer re-reads identical through the thread, an
// answer without one stores NULL, and `setAnswerOffer` rewrites only that column,
// only in its own workspace.

const { planOfferService } = await import('@/lib/services/planOfferService');
const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');
const { workItemsService } = await import('@/lib/services/workItemsService');

const T = { timeout: 120_000 };

let fx: WorkItemFixture;
let jobSeq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function me(f: WorkItemFixture = fx): ProjectContext {
  return {
    userId: f.ownerId,
    workspaceId: f.workspaceId,
    projectId: f.projectId,
    project: f.project,
  };
}

const OFFER = {
  kind: 'plan' as const,
  requestMd: 'Plan a fix for the CSV export dropping custom fields.',
  targetKey: null as string | null,
};

const REQUIREMENT: SubmittedRequirement = {
  outcome: 'A person plans a fix from the overlay.',
  behaviour: 'The requirement shows before Confirm.',
  scopeEdge: '',
  constraints: '',
  acceptance: 'Six headings.',
  assumptions: [{ id: 'r1', text: 'One pane.' }],
};

/** A conversation with one answer turn, the offer on it when given. */
async function answered(answerOffer?: typeof OFFER | null) {
  const target = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'CSV export' },
    fx.ctx,
  );
  const s = await planChangeSessionsService.startWithFirstTurn(
    me(),
    buildScope([target.identifier]),
    'Plan a fix for the export',
  );
  const offer = answerOffer ? { ...answerOffer, targetKey: target.identifier } : answerOffer;
  await planChangeSessionsService.appendAnswerTurn(
    {
      jobId: `job-${++jobSeq}`,
      body: 'I can plan that.',
      ...(offer ? { answerOffer: offer } : {}),
    },
    me(),
    { sessionId: s.id },
  );
  const turn = await adminDb.planChangeTurn.findFirstOrThrow({
    where: { sessionId: s.id, role: 'assistant' },
  });
  return { sessionId: s.id, turn, offer };
}

/** The thread re-read on its own connection, through the repository and the mapper. */
async function reread(sessionId: string) {
  const row = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sessionId } });
  const turns = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
    planChangeTurnRepository.listBySessionId(sessionId, fx.workspaceId, tx),
  );
  return toPlanChangeSessionDto(row, turns);
}

const UNDECIDED = {
  declinedAt: null,
  declinedById: null,
  confirmedAt: null,
  confirmedById: null,
  confirmedSessionId: null,
};

describe('the answer offer is stored with its turn', () => {
  it('persists all eight keys, every disposition null, and re-reads identical', T, async () => {
    const { sessionId, turn, offer } = await answered(OFFER);

    expect(turn.answerOffer).toEqual({ ...offer, ...UNDECIDED });
    expect(Object.keys(turn.answerOffer as object).sort()).toEqual(
      [
        'confirmedAt',
        'confirmedById',
        'confirmedSessionId',
        'declinedAt',
        'declinedById',
        'kind',
        'requestMd',
        'targetKey',
      ].sort(),
    );

    const dto = await reread(sessionId);
    const assistant = dto.turns.find((t) => t.role === 'assistant')!;
    expect(assistant.offer).toEqual({ ...offer, ...UNDECIDED });
    expect(assistant.forwardOffer).toBeNull();
    // The service's own read agrees, plus the two fields it derives (MOTIR-9290).
    const viaService = await planChangeSessionsService.getById(me(), sessionId);
    expect(viaService.turns.find((t) => t.role === 'assistant')!.offer).toEqual({
      ...offer,
      ...UNDECIDED,
      state: 'undecided',
      cannotStart: expect.toBeOneOf([null, 'planning_unavailable']),
    });
  });

  it(
    'stores NULL for an answer with no offer, and every other turn reads no offer',
    T,
    async () => {
      const { sessionId, turn } = await answered();
      expect(turn.answerOffer).toBeNull();
      const dto = await reread(sessionId);
      expect(dto.turns.every((t) => t.offer === null)).toBe(true);
    },
  );
});

describe('setAnswerOffer rewrites the offer and nothing else', () => {
  it('changes only the offer column of its own turn', T, async () => {
    const { sessionId, turn, offer } = await answered(OFFER);
    const confirmed = {
      ...offer!,
      ...UNDECIDED,
      confirmedAt: '2026-10-22T19:14:00.000Z',
      confirmedById: fx.ownerId,
      confirmedSessionId: sessionId,
    };

    await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planChangeTurnRepository.setAnswerOffer(turn.id, fx.workspaceId, confirmed, tx),
    );

    const after = await adminDb.planChangeTurn.findUniqueOrThrow({ where: { id: turn.id } });
    expect(after.answerOffer).toEqual(confirmed);
    const { answerOffer: _a, ...rest } = after;
    const { answerOffer: _b, ...before } = turn;
    expect(rest).toEqual(before);
    const dto = await reread(sessionId);
    expect(dto.turns.find((t) => t.id === turn.id)!.offer).toEqual(confirmed);
  });

  it("writes nothing for another workspace's turn id", T, async () => {
    const { turn } = await answered(OFFER);
    const other = await makeWorkItemFixture();
    const declined = {
      ...(turn.answerOffer as Record<string, unknown>),
      declinedAt: 'x',
      declinedById: other.ownerId,
    };

    await withWorkspaceServiceContext(other.workspaceId, (tx) =>
      planChangeTurnRepository.setAnswerOffer(turn.id, other.workspaceId, declined, tx),
    );
    // Scoped by workspace id even where row security would let the write through.
    await adminDb.$transaction((tx) =>
      planChangeTurnRepository.setAnswerOffer(turn.id, other.workspaceId, declined, tx),
    );

    const after = await adminDb.planChangeTurn.findUniqueOrThrow({ where: { id: turn.id } });
    expect(after).toEqual(turn);
  });
});

describe('the composed requirement rides the stored offer (MOTIR-9432)', () => {
  /** A no-target offer carrying the requirement, appended with its answer. */
  async function withRequirement() {
    const s = await planChangeSessionsService.startWithFirstTurn(
      me(),
      buildScope([]),
      'Plan something new',
    );
    await planChangeSessionsService.appendAnswerTurn(
      {
        jobId: `job-${++jobSeq}`,
        body: 'I can plan that.',
        answerOffer: {
          kind: 'plan',
          requestMd: OFFER.requestMd,
          targetKey: null,
          requirement: REQUIREMENT,
        },
      },
      me(),
      { sessionId: s.id },
    );
    const turn = await adminDb.planChangeTurn.findFirstOrThrow({
      where: { sessionId: s.id, role: 'assistant' },
    });
    return { sessionId: s.id, turnId: turn.id };
  }

  const storedRequirement = async (turnId: string) =>
    (
      (await adminDb.planChangeTurn.findUniqueOrThrow({ where: { id: turnId } }))
        .answerOffer as Record<string, unknown>
    ).requirement;

  const servedRequirement = async (sessionId: string, turnId: string) =>
    (await reread(sessionId)).turns.find((t) => t.id === turnId)!.offer?.requirement;

  it('is stored on the turn and served on the session DTO', T, async () => {
    const { sessionId, turnId } = await withRequirement();
    expect(await storedRequirement(turnId)).toEqual(REQUIREMENT);
    expect(await servedRequirement(sessionId, turnId)).toEqual(REQUIREMENT);
  });

  it('survives the decline door', T, async () => {
    const { sessionId, turnId } = await withRequirement();
    await planOfferService.declinePlanOffer(turnId, me(), { sessionId });
    expect(await storedRequirement(turnId)).toEqual(REQUIREMENT);
    expect(await servedRequirement(sessionId, turnId)).toEqual(REQUIREMENT);
  });

  it('survives a recorded refusal', T, async () => {
    const { sessionId, turnId } = await withRequirement();
    await planOfferService.recordCannotStart(turnId, 'out_of_credits', null, me(), { sessionId });
    expect(await storedRequirement(turnId)).toEqual(REQUIREMENT);
    expect(await servedRequirement(sessionId, turnId)).toEqual(REQUIREMENT);
  });

  it('survives the start claim, its release and a stamped session', T, async () => {
    const { sessionId, turnId } = await withRequirement();
    const claimed = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planChangeTurnRepository.claimAnswerOfferStart(turnId, fx.workspaceId, fx.ownerId, tx),
    );
    expect(claimed).toBe(true);
    expect(await storedRequirement(turnId)).toEqual(REQUIREMENT);

    await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planChangeTurnRepository.releaseAnswerOfferStart(turnId, fx.workspaceId, tx),
    );
    expect(await storedRequirement(turnId)).toEqual(REQUIREMENT);

    // The stamp spreads the stored JSON the way `stampOffer` does.
    const row = await adminDb.planChangeTurn.findUniqueOrThrow({ where: { id: turnId } });
    await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planChangeTurnRepository.setAnswerOffer(
        turnId,
        fx.workspaceId,
        {
          ...(row.answerOffer as Record<string, unknown>),
          confirmedSessionId: sessionId,
          start: { jobId: 'job-x', planId: null },
        },
        tx,
      ),
    );
    expect(await servedRequirement(sessionId, turnId)).toEqual(REQUIREMENT);
  });

  it('is absent, with no key, on an offer stored without one', T, async () => {
    const { sessionId, turn } = await answered(OFFER);
    expect('requirement' in (turn.answerOffer as object)).toBe(false);
    const offer = (await reread(sessionId)).turns.find((t) => t.role === 'assistant')!.offer!;
    expect('requirement' in offer).toBe(false);
  });
});
