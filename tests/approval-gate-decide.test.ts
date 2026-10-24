import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import {
  ApprovalGateAlreadyDecidedError,
  ApprovalGateNotAuthorisedError,
  ApprovalGateNotFoundError,
  ApprovalGateSupersededError,
} from '@/lib/approvalGates/errors';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { PermissionDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { makeWorkItemFixture, createTestLink, type WorkItemFixture } from './fixtures';
import { createTestUser } from './fixtures/userFixtures';
import { adminDb } from './helpers/adminDb';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { truncateAuthTables } from './helpers/db';
import { expectEachHopAnnounced } from './helpers/transitionedEvents';
import {
  addToProjectAs,
  createCustomRoleAs,
  setProjectRoleAs,
  setWorkspaceRoleFor,
} from './helpers/workspaceRoleFixtures';
import { projectAccessData } from '@/tests/helpers/projectAccess';

// THE DECIDE DOOR (Story MOTIR-4778 · Subtask MOTIR-4790; ADR
// docs/decisions/approval-gates.md), against a REAL Postgres.
//
// The door is the one place a gate's state ever changes, for every kind that
// will ever exist, so what is asserted here is the SHARED half — the lock, the
// actor gate, the state refusals, the decision write — plus the one registered
// kind's effect. A per-kind test would prove the design gate works and say
// nothing about the claim the story rests on.
//
// The load-bearing assertions, in the order they were hardest to get right:
//
//   · THE RACE. Two decides on one gate produce exactly ONE decision, and the
//     loser receives `ApprovalGateAlreadyDecidedError` naming the winner and the
//     time. Driven with genuine concurrency against a warm pool — a serial
//     assertion passes with no lock at all, which is precisely the bug.
//   · THE EFFECT'S REACH. Approving does not merely flip a status: it must leave
//     a card `blocked_by` the design subtask CLAIMABLE in the same request. The
//     dependent's readiness is asserted BEFORE and AFTER, because a test that
//     only reads the subtask's own status would pass while the thing approval
//     exists to do had not happened.
//   · THE DISCRIMINATOR. `done` has exactly ONE writer (ADR §8). An approval on
//     a card with a linked OPEN pull request must write NO status and leave it
//     to the merge — the arm that, wired the other way, produces the
//     "approved but still in_review" collision the two workflows exist to end.
//   · THE TWO REFUSALS THAT LOOK ALIKE. A decided gate and a superseded one are
//     different sentences: somebody's answer, versus a withdrawn question.

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A workspace member with no administrative role — see `designSubtaskWithGate`'s
 *  note on why the fixture OWNER cannot stand in for one. */
async function plainMember() {
  const user = await createTestUser();
  await adminDb.workspaceMembership.create({
    data: { userId: user.id, workspaceId: fx.workspaceId, workspaceRole: 'member' },
  });
  return user;
}

/** A design subtask sitting in review with an `awaiting` design-result gate on
 *  it — the shape the publish path produces.
 *
 *  ⚠️ `reporterId` EXISTS BECAUSE `fx.ownerId` IS ALSO A WORKSPACE OWNER, and
 *  that overlap made the reporter arm untestable in isolation (MOTIR-5192).
 *  Everything the fixture creates is reported by `fx.ownerId`, for whom
 *  `approval:decide_any` resolves (the always-pass rail) — so the ADMIN arm authorises them whatever
 *  the reporter arm says. Under the old `assignee OR reporter OR admin` rule the
 *  reporter term short-circuited first and the overlap was invisible; the moment
 *  that term became conditional, every "the reporter is refused" assertion
 *  started passing through the admin arm instead. So a test about the REPORTER
 *  arm reports the item as a PLAIN MEMBER. */
async function designSubtaskWithGate(
  opts: { assigneeId?: string | null; reporterId?: string } = {},
) {
  // A subtask must have a parent (`lib/issues/parentRules.ts`), which is also
  // the real shape: a design card hangs under the story it draws.
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Approve a design' },
    fx.ctx,
  );
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', parentId: story.id, title: 'Draw the frame' },
    fx.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);
  if (opts.assigneeId !== undefined || opts.reporterId !== undefined) {
    await adminDb.workItem.update({
      where: { id: item.id },
      data: {
        ...(opts.assigneeId !== undefined ? { assigneeId: opts.assigneeId } : {}),
        ...(opts.reporterId !== undefined ? { reporterId: opts.reporterId } : {}),
      },
    });
  }
  const gate = await withWorkspaceContext(fx.ctx, (tx) =>
    approvalGateRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: item.id,
        kind: 'design_result',
        subjectId: `design-evidence-${item.id}`,
      },
      tx,
    ),
  );
  return { story, item, gate };
}

describe('approvalGatesService.decide — approve, the terminal act (ADR §8 Workflow A)', () => {
  it('records the decision and returns the updated DTO', async () => {
    const { gate } = await designSubtaskWithGate();

    const before = Date.now();
    const result = await approvalGatesService.decide(
      {
        stamp: DECIDED_WITHOUT_A_READER,
        gateId: gate.id,
        decision: 'approve',
        source: 'ui',
        noteMd: 'Ship it.',
      },
      fx.ctx,
    );

    expect(result.gate.state).toBe('approved');
    expect(result.gate.decidedById).toBe(fx.ownerId);
    expect(result.gate.noteMd).toBe('Ship it.');
    expect(Date.parse(result.gate.decidedAt!)).toBeGreaterThanOrEqual(before - 1000);

    // Read the ROW back, not the DTO the call returned — a mapper that dropped a
    // field would agree with itself.
    const row = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } });
    expect(row.state).toBe('approved');
    expect(row.decidedById).toBe(fx.ownerId);
    expect(row.decidedAt).not.toBeNull();
    expect(row.noteMd).toBe('Ship it.');
  });

  it('transitions the design subtask into the project done status THROUGH the one status funnel, and a dependent leaves `blocked` in the SAME request', async () => {
    const { story, item, gate } = await designSubtaskWithGate();

    // A card that cannot start until the design lands — the whole point of
    // approving one.
    const dependent = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'subtask', parentId: story.id, title: 'Build to the frame' },
      fx.ctx,
    );
    await createTestLink({
      workspaceId: fx.workspaceId,
      fromId: dependent.id,
      toId: item.id,
      kind: 'is_blocked_by',
      createdById: fx.ownerId,
    });

    // BEFORE: the blocker is not done, so the dependent is not startable.
    await expect(workItemsService.isReady(dependent.id, fx.ctx)).resolves.toBe(false);

    // The `done` it writes is announced after the commit (Bug MOTIR-9415).
    const { result, hops } = await expectEachHopAnnounced(
      item.id,
      { workspaceId: fx.workspaceId, actorId: fx.ownerId },
      () =>
        approvalGatesService.decide(
          { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, decision: 'approve', source: 'ui' },
          fx.ctx,
        ),
    );
    expect(hops).toEqual([{ fromStatusKey: 'in_review', toStatusKey: 'done' }]);

    expect(result.effect.statusWritten).toBe('done');

    // AFTER: readiness is COMPUTED from the edges against the project's terminal
    // set, so this is the assertion that says approval actually unblocked work
    // rather than merely writing a word into a column.
    await expect(workItemsService.isReady(dependent.id, fx.ctx)).resolves.toBe(true);

    const moved = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(moved.status).toBe('done');
    // The `completedAt` stamp is inherited from `applyStatusTransition` — the
    // evidence that the move went through the one shipped status funnel rather
    // than a raw `work_item.status` write, which is the difference this card is
    // most likely to get wrong invisibly.
    expect(moved.completedAt).not.toBeNull();
  });

  it('the transition and the decision are ONE transaction — a failing effect rolls the decision back', async () => {
    const { item, gate } = await designSubtaskWithGate();
    // Put the card back at `todo` behind the funnel's back: the default workflow has
    // no `todo → done` edge, so the effect's transition is refused.
    //
    // ⚠️ NOT CANCELLED, since MOTIR-7109. This test used to cancel the card as a
    // SYSTEM write, which MOTIR-5527's pull-back rule exempted — but a move to
    // Cancelled now withdraws the question whoever writes it, and the door refuses
    // a gate on a cancelled card outright. Either refusal lands before the effect
    // runs, which is a different refusal from the rollback this test is about. A
    // raw status write keeps the gate `awaiting` and the effect the thing that fails.
    await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'todo' } });

    await expect(
      approvalGatesService.decide(
        { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, decision: 'approve', source: 'ui' },
        fx.ctx,
      ),
    ).rejects.toThrow();

    const row = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } });
    expect(row.state).toBe('awaiting');
    expect(row.decidedById).toBeNull();
    expect(row.decidedAt).toBeNull();
  });
});

describe('approvalGatesService.decide — the DISCRIMINATOR: `done` has exactly one writer (ADR §8)', () => {
  it('a card with a linked OPEN pull request reaches NO status from the approval — the merge writes `done`', async () => {
    const { item, gate } = await designSubtaskWithGate();

    // The delivery row `link_pull_request` writes, with its pull request OPEN.
    // This is the set the discriminator READS — there is no setting and no field
    // on the card, which is what makes it impossible for a planner to get wrong.
    const installation = await adminDb.githubInstallation.create({
      data: {
        workspaceId: fx.workspaceId,
        installationId: 'inst-4790',
        accountLogin: 'acme',
        accountType: 'Organization',
        provider: 'github',
      },
    });
    const repo = await adminDb.githubRepo.create({
      data: {
        workspaceId: fx.workspaceId,
        organizationId: fx.workspace.organizationId,
        installationId: installation.id,
        repoId: 'repo-4790',
        owner: 'acme',
        name: 'web',
        defaultBranch: 'main',
        provider: 'github',
      },
    });
    const pr = await adminDb.githubPullRequest.create({
      data: {
        repoId: repo.id,
        number: 7,
        title: 'draw the frame',
        state: 'open',
        headRef: 'design/frame',
        baseRef: 'main',
        provider: 'github',
      },
    });
    await adminDb.workItemDelivery.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: item.id,
        githubPullRequestId: pr.id,
        repoId: repo.id,
      },
    });

    const result = await approvalGatesService.decide(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, decision: 'approve', source: 'ui' },
      fx.ctx,
    );

    // The DECISION still lands — that is the audit artefact, and the reviewer
    // did press the button.
    expect(result.gate.state).toBe('approved');
    // The STATUS does not. `done` belongs to the merge.
    expect(result.effect.statusWritten).toBeNull();
    expect(result.effect.statusDeferredReason).toBe('merge_writes_done');

    const unmoved = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(unmoved.status).toBe('in_review');
    expect(unmoved.completedAt).toBeNull();
  });
});

describe('approvalGatesService.decide — request_changes records the decision and returns the design to To do (design-refusal-verdict.md §1)', () => {
  it('records the decision and writes the project’s initial To-do status', async () => {
    const { item, gate } = await designSubtaskWithGate();

    const result = await approvalGatesService.decide(
      {
        stamp: DECIDED_WITHOUT_A_READER,
        gateId: gate.id,
        decision: 'request_changes',
        refusalVerdict: 'revise',
        source: 'ui',
        noteMd: 'The port is too short.',
      },
      fx.ctx,
    );

    expect(result.gate.state).toBe('changes_requested');
    expect(result.gate.noteMd).toBe('The port is too short.');
    // MOTIR-6423: a design sent back goes to To do on either verdict, and the decided
    // row names it — the ADR §3 "moves nothing" rule is amended by
    // `design-refusal-verdict.md` §1.
    expect(result.effect).toEqual({ statusWritten: 'todo' });
    expect(result.gate.outcomeRef).toBe('todo');

    const moved = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(moved.status).toBe('todo');
  });
});

describe('approvalGatesService.decide — CONCURRENCY: two presses, one decision', () => {
  it('two SIMULTANEOUS decides produce exactly one decision; the loser is told who won and when', async () => {
    const { gate } = await designSubtaskWithGate();

    // Genuine concurrency against a warm pool, NOT two serial calls. A
    // check-then-write with no `FOR UPDATE` passes a serial assertion perfectly
    // — it reads `awaiting` twice only when the two overlap, which is the
    // ordinary case on a shared queue and never the case in a serial test.
    const results = await Promise.allSettled([
      approvalGatesService.decide(
        { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, decision: 'approve', source: 'ui' },
        fx.ctx,
      ),
      approvalGatesService.decide(
        {
          stamp: DECIDED_WITHOUT_A_READER,
          gateId: gate.id,
          decision: 'request_changes',
          refusalVerdict: 'revise',
          noteMd: 'Needs changes.',
          source: 'ui',
        },
        fx.ctx,
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // WHICH verb wins is the scheduler's business; the assertion pins the COUNT,
    // the TYPE and what the refusal CARRIES, never the identity of the winner.
    const reason = (rejected[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(ApprovalGateAlreadyDecidedError);
    const err = reason as ApprovalGateAlreadyDecidedError;
    expect(['approved', 'changes_requested']).toContain(err.state);
    expect(err.decidedById).toBe(fx.ownerId);
    expect(err.decidedAt).toBeInstanceOf(Date);
    // The surface has to be able to SAY who and when, in place — a bare 409
    // cannot draw ADR §4's "somebody decided it while this was on screen".
    expect(err.message).toContain(err.decidedAt!.toISOString());

    const row = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } });
    expect(row.state).toBe(err.state);
  });
});

describe('approvalGatesService.decide — state refusals', () => {
  it('a gate already decided is refused with the typed error, naming the decider and the time', async () => {
    const { gate } = await designSubtaskWithGate();
    await approvalGatesService.decide(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, decision: 'approve', source: 'ui' },
      fx.ctx,
    );

    await expect(
      approvalGatesService.decide(
        {
          stamp: DECIDED_WITHOUT_A_READER,
          gateId: gate.id,
          decision: 'request_changes',
          refusalVerdict: 'revise',
          noteMd: 'Needs changes.',
          source: 'ui',
        },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(ApprovalGateAlreadyDecidedError);
  });

  it('a `changes_requested` gate is refused with the SAME typed error', async () => {
    const { gate } = await designSubtaskWithGate();
    await approvalGatesService.decide(
      {
        stamp: DECIDED_WITHOUT_A_READER,
        gateId: gate.id,
        decision: 'request_changes',
        refusalVerdict: 'revise',
        noteMd: 'Needs changes.',
        source: 'ui',
      },
      fx.ctx,
    );

    await expect(
      approvalGatesService.decide(
        { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, decision: 'approve', source: 'ui' },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(ApprovalGateAlreadyDecidedError);
  });

  it("a SUPERSEDED gate is a DIFFERENT refusal — a withdrawn question, not somebody's answer", async () => {
    const { gate } = await designSubtaskWithGate();
    // Nothing WRITES this state yet — the supersede predicate is MOTIR-4913's,
    // `blocked_by` this card. The door refuses it regardless, because the state
    // is in the Prisma enum today and a door that is total over its kinds owes
    // the same totality over its states.
    await adminDb.approvalGate.update({ where: { id: gate.id }, data: { state: 'superseded' } });

    await expect(
      approvalGatesService.decide(
        { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, decision: 'approve', source: 'ui' },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(ApprovalGateSupersededError);
  });

  it('an unknown gate id is a not-found', async () => {
    await expect(
      approvalGatesService.decide(
        {
          stamp: DECIDED_WITHOUT_A_READER,
          gateId: 'no-such-gate',
          decision: 'approve',
          source: 'ui',
        },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(ApprovalGateNotFoundError);
  });
});

describe('approvalGatesService.decide — AUTHORITY is the ASSIGNEE, the REPORTER only when UNASSIGNED, or an ADMIN (ADR §2, 2026-09-11)', () => {
  // ⚠️ THIS BLOCK WAS REVERSED ON 2026-09-11 (MOTIR-5192). Until then the
  // reporter arm was UNCONDITIONAL — §2's MOTIR-4911 amendment of 2026-09-08 —
  // and these tests asserted that a reporter could press a gate on an ASSIGNED
  // item. The narrowing collapses authority onto the routing rule for the two
  // relationship arms: the gate is pressed by the person it is SHOWN to, or by
  // an admin. The superseded reasoning stays visible in the ADR rather than
  // being deleted from it.
  //
  // ⚠️ EVERY ARM IS ASSERTED FOR BOTH VERBS. The rule is stated for approve and
  // request_changes alike, and a conditional applied to one branch of the decide
  // path would pass an approve-only suite while leaving the refusal unreachable
  // on the other.
  const VERBS = ['approve', 'request_changes'] as const;
  const STATE_OF = { approve: 'approved', request_changes: 'changes_requested' } as const;

  for (const verb of VERBS) {
    it(`the REPORTER may \`${verb}\` when the item has NO assignee`, async () => {
      // A PLAIN MEMBER reports the item, so this exercises the reporter arm and
      // only that arm. With no assignee §2 routes the gate to them, so authority
      // and routing name the same person — the whole shape of the amendment.
      const reporter = await plainMember();
      const { gate } = await designSubtaskWithGate({
        assigneeId: null,
        reporterId: reporter.id,
      });

      const result = await approvalGatesService.decide(
        {
          stamp: DECIDED_WITHOUT_A_READER,
          gateId: gate.id,
          decision: verb,
          source: 'ui',
          noteMd: verb === 'request_changes' ? 'Needs changes.' : null,
          refusalVerdict: verb === 'request_changes' ? 'revise' : null,
        },
        { userId: reporter.id, workspaceId: fx.workspaceId },
      );
      expect(result.gate.state).toBe(STATE_OF[verb]);
    });

    it(`the SAME reporter may NOT \`${verb}\` once the item HAS an assignee — the pair of the case above`, async () => {
      // ⚠️ THE DISCRIMINATING PAIR. These two tests differ in exactly one field,
      // so together they show the condition SELECTS rather than merely forbids:
      // an implementation that refused the reporter outright would pass this one
      // and fail its twin.
      const reporter = await plainMember();
      const assignee = await plainMember();
      const { gate } = await designSubtaskWithGate({
        assigneeId: assignee.id,
        reporterId: reporter.id,
      });

      await expect(
        approvalGatesService.decide(
          {
            stamp: DECIDED_WITHOUT_A_READER,
            gateId: gate.id,
            decision: verb,
            source: 'ui',
            noteMd: verb === 'request_changes' ? 'Needs changes.' : null,
            refusalVerdict: verb === 'request_changes' ? 'revise' : null,
          },
          { userId: reporter.id, workspaceId: fx.workspaceId },
        ),
      ).rejects.toBeInstanceOf(ApprovalGateNotAuthorisedError);

      const row = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } });
      expect(row.state).toBe('awaiting');
      expect(row.decidedUnderAuthority).toBeNull();
    });

    it(`the ASSIGNEE may \`${verb}\` when they are not the reporter`, async () => {
      const assignee = await plainMember();
      const { gate } = await designSubtaskWithGate({ assigneeId: assignee.id });

      const result = await approvalGatesService.decide(
        {
          stamp: DECIDED_WITHOUT_A_READER,
          gateId: gate.id,
          decision: verb,
          source: 'ui',
          noteMd: verb === 'request_changes' ? 'Needs changes.' : null,
          refusalVerdict: verb === 'request_changes' ? 'revise' : null,
        },
        { userId: assignee.id, workspaceId: fx.workspaceId },
      );
      expect(result.gate.state).toBe(STATE_OF[verb]);
    });

    it(`a workspace ADMIN may \`${verb}\` an item that HAS an assignee — the escape hatch SURVIVES`, async () => {
      // ⚠️ ASSIGNED, DELIBERATELY. This assertion used to run on an UNASSIGNED
      // item, where the admin arm is never the only thing standing between the
      // work and a stall. The narrowing makes admins the ONLY remaining
      // unblocker for a gate routed to somebody unavailable, so the case that
      // has to be pinned is exactly the one with an assignee on the item.
      const assignee = await plainMember();
      const admin = await createTestUser();
      await adminDb.workspaceMembership.create({
        data: {
          userId: admin.id,
          workspaceId: fx.workspaceId,
          workspaceRole: 'manager',
        },
      });
      const { gate } = await designSubtaskWithGate({ assigneeId: assignee.id });

      const result = await approvalGatesService.decide(
        {
          stamp: DECIDED_WITHOUT_A_READER,
          gateId: gate.id,
          decision: verb,
          source: 'ui',
          noteMd: verb === 'request_changes' ? 'Needs changes.' : null,
          refusalVerdict: verb === 'request_changes' ? 'revise' : null,
        },
        { userId: admin.id, workspaceId: fx.workspaceId },
      );
      expect(result.gate.state).toBe(STATE_OF[verb]);
    });
  }

  it('a plain MEMBER who is neither assignee nor reporter is refused — and it is a 403-shaped refusal, not a 404', async () => {
    const bystander = await createTestUser();
    await adminDb.workspaceMembership.create({
      data: {
        userId: bystander.id,
        workspaceId: fx.workspaceId,
        workspaceRole: 'member',
      },
    });
    const { gate } = await designSubtaskWithGate({ assigneeId: null });

    // They cleared the permission FLOOR (`work_item:edit` on an `open` project)
    // and failed the RELATIONSHIP test. Saying "not found" here would be a lie
    // the surface cannot render: they can see the gate perfectly well.
    await expect(
      approvalGatesService.decide(
        { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, decision: 'approve', source: 'ui' },
        { userId: bystander.id, workspaceId: fx.workspaceId },
      ),
    ).rejects.toBeInstanceOf(ApprovalGateNotAuthorisedError);

    const row = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } });
    expect(row.state).toBe('awaiting');
  });

  it('an actor who cannot BROWSE the project gets a not-found, so neither refusal leaks the other', async () => {
    // A `private` project admits only its own members. An outsider must not be
    // able to tell "this gate exists but you may not decide it" from "no such
    // gate" — finding #26's no-existence-leak posture, inherited from the shared
    // project gate rather than re-implemented here.
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: projectAccessData('members'),
    });
    const outsider = await createTestUser();
    await adminDb.workspaceMembership.create({
      data: {
        userId: outsider.id,
        workspaceId: fx.workspaceId,
        workspaceRole: 'member',
      },
    });
    const { gate } = await designSubtaskWithGate({ assigneeId: null });

    await expect(
      approvalGatesService.decide(
        { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, decision: 'approve', source: 'ui' },
        { userId: outsider.id, workspaceId: fx.workspaceId },
      ),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('a VIEWER on a private project can browse but not edit — refused at the permission FLOOR, before the relationship test', async () => {
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: projectAccessData('members'),
    });
    const viewer = await createTestUser();
    await adminDb.workspaceMembership.create({
      data: {
        userId: viewer.id,
        workspaceId: fx.workspaceId,
        workspaceRole: 'member',
      },
    });
    await adminDb.projectMembership.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        userId: viewer.id,
      },
    });
    await setWorkspaceRoleFor(viewer.id, fx.workspaceId, 'viewer');
    const { gate } = await designSubtaskWithGate({ assigneeId: viewer.id });

    // Assigned to them, and still refused: the relationship rule is applied ON
    // TOP of the kind's permission floor, never instead of it.
    await expect(
      approvalGatesService.decide(
        { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, decision: 'approve', source: 'ui' },
        { userId: viewer.id, workspaceId: fx.workspaceId },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('a gate in ANOTHER workspace is a not-found, never a permission error', async () => {
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const { gate } = await designSubtaskWithGate();

    await expect(
      approvalGatesService.decide(
        { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, decision: 'approve', source: 'ui' },
        other.ctx,
      ),
    ).rejects.toBeInstanceOf(ApprovalGateNotFoundError);
  });
});

describe('the ESCAPE HATCH is the `approval:decide_any` PERMISSION, never a workspace ROLE (MOTIR-5292)', () => {
  // ⚠️ UNTIL MOTIR-5292 THE THIRD ARM ASKED `isWorkspaceManagerFor` — owner or
  // admin of the WORKSPACE — and there was no key a team could grant. So every
  // case below that turns on HOLDING THE KEY was unreachable: a custom role could
  // carry any key in the catalog and none of them reached the arm, and a project
  // Admin whose workspace role is `member` was refused. Each actor here is a
  // PLAIN WORKSPACE MEMBER, so nothing can pass through the always-pass rail by
  // accident (the `designSubtaskWithGate` note on why the fixture owner cannot
  // stand in for one).
  //
  // ⚠️ `canDecide` AND THE DOOR ARE ASSERTED TOGETHER on every holder, because
  // they call one function and the failure to prevent is one of them moving
  // without the other — a verb drawn that the door refuses, or the reverse.
  const FLOOR: PermissionKey[] = ['project:browse', 'work_item:edit'];
  let roleSeq = 0;

  function scoped() {
    return { key: fx.projectIdentifier, actorUserId: fx.ownerId, ctx: fx.ctx };
  }

  /** A plain workspace member seated on the project with a CUSTOM role. */
  async function onCustomRole(permissions: PermissionKey[]) {
    const user = await plainMember();
    roleSeq += 1;
    const role = await createCustomRoleAs({
      projectId: fx.projectId,
      ctx: fx.ctx,
      name: `Unblocker ${roleSeq}`,
      permissions,
    });
    await addToProjectAs({ ...scoped(), targetUserId: user.id, role: 'member' });
    await setProjectRoleAs({ ...scoped(), targetUserId: user.id, role: role.id });
    return user;
  }

  /** A plain workspace member seated on the project with a BUILT-IN role. */
  async function onBuiltInRole(role: 'admin' | 'member') {
    const user = await plainMember();
    await addToProjectAs({ ...scoped(), targetUserId: user.id, role });
    return user;
  }

  async function gateRoutedToSomebodyElse() {
    const assignee = await plainMember();
    return designSubtaskWithGate({ assigneeId: assignee.id, reporterId: assignee.id });
  }

  it('a CUSTOM role holding the key decides a gate routed to somebody else — `canDecide` and the door agree', async () => {
    const holder = await onCustomRole([...FLOOR, 'approval:decide_any']);
    const { item, gate } = await gateRoutedToSomebodyElse();
    const ctx = { userId: holder.id, workspaceId: fx.workspaceId };

    const read = await approvalGatesService.getForWorkItem(
      { workItemId: item.id, kind: 'design_result' },
      ctx,
    );
    expect(read.canDecide).toBe(true);

    const result = await approvalGatesService.decide(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, decision: 'approve', source: 'ui' },
      ctx,
    );
    expect(result.gate.state).toBe('approved');

    // The recorded vocabulary is KEPT: `admin` now MEANS "decided under
    // `approval:decide_any`" (ADR §2's third amendment), so a key-holder who is
    // no kind of workspace admin is recorded under it.
    const row = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } });
    expect(row.decidedUnderAuthority).toBe('admin');
    expect(row.decidedById).toBe(holder.id);
  });

  it('the SAME role WITHOUT the key is refused — the pair of the case above, differing in one key', async () => {
    const withoutKey = await onCustomRole([...FLOOR]);
    const { item, gate } = await gateRoutedToSomebodyElse();
    const ctx = { userId: withoutKey.id, workspaceId: fx.workspaceId };

    const read = await approvalGatesService.getForWorkItem(
      { workItemId: item.id, kind: 'design_result' },
      ctx,
    );
    expect(read.canDecide).toBe(false);

    // Cleared the FLOOR (`work_item:edit` is in the role), failed the authority
    // test — the 403-shaped refusal, not a 404 and not a permission error.
    await expect(
      approvalGatesService.decide(
        { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, decision: 'approve', source: 'ui' },
        ctx,
      ),
    ).rejects.toBeInstanceOf(ApprovalGateNotAuthorisedError);

    const row = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } });
    expect(row.state).toBe('awaiting');
    expect(row.decidedUnderAuthority).toBeNull();
  });

  it('a project ADMIN whose WORKSPACE role is `member` decides an unrouted gate — the widening this card makes', async () => {
    const projectAdmin = await onBuiltInRole('admin');
    const { item, gate } = await gateRoutedToSomebodyElse();
    const ctx = { userId: projectAdmin.id, workspaceId: fx.workspaceId };

    const read = await approvalGatesService.getForWorkItem(
      { workItemId: item.id, kind: 'design_result' },
      ctx,
    );
    expect(read.canDecide).toBe(true);

    for (const verb of ['request_changes', 'approve'] as const) {
      // Both verbs, each on its own gate: a decision is terminal for the gate,
      // and the rule is stated for approve and request_changes alike.
      const fresh = verb === 'approve' ? gate : (await gateRoutedToSomebodyElse()).gate;
      const result = await approvalGatesService.decide(
        {
          stamp: DECIDED_WITHOUT_A_READER,
          gateId: fresh.id,
          decision: verb,
          source: 'ui',
          noteMd: verb === 'request_changes' ? 'Needs changes.' : null,
          refusalVerdict: verb === 'request_changes' ? 'revise' : null,
        },
        ctx,
      );
      expect(result.gate.state).toBe(verb === 'approve' ? 'approved' : 'changes_requested');
    }
  });

  it('a project MEMBER does NOT hold the key — refused on a gate routed to somebody else', async () => {
    const member = await onBuiltInRole('member');
    const { item, gate } = await gateRoutedToSomebodyElse();
    const ctx = { userId: member.id, workspaceId: fx.workspaceId };

    const read = await approvalGatesService.getForWorkItem(
      { workItemId: item.id, kind: 'design_result' },
      ctx,
    );
    expect(read.canDecide).toBe(false);
    await expect(
      approvalGatesService.decide(
        { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, decision: 'approve', source: 'ui' },
        ctx,
      ),
    ).rejects.toBeInstanceOf(ApprovalGateNotAuthorisedError);
  });

  it('a WORKSPACE admin still decides — they hold the key through the always-pass rail, so nothing regressed', async () => {
    const wsAdmin = await createTestUser();
    await adminDb.workspaceMembership.create({
      data: {
        userId: wsAdmin.id,
        workspaceId: fx.workspaceId,
        workspaceRole: 'manager',
      },
    });
    const ctx = { userId: wsAdmin.id, workspaceId: fx.workspaceId };
    // Asserted as a PERMISSION the model resolves, which is the whole change: the
    // arm now asks the model, so this is the fact that keeps them unblockers.
    const held = await projectAccessService.getPermissions(fx.projectId, ctx);
    expect(held.has('approval:decide_any')).toBe(true);

    const { gate } = await gateRoutedToSomebodyElse();
    const result = await approvalGatesService.decide(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, decision: 'approve', source: 'ui' },
      ctx,
    );
    expect(result.gate.state).toBe('approved');
    const row = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } });
    expect(row.decidedUnderAuthority).toBe('admin');
  });

  it('the ARM ORDER is unchanged — an ASSIGNEE who also holds the key is recorded as the assignee', async () => {
    // Holding the key must not relabel a press the routing rule already
    // explains. §2 routes to the assignee, so that is what the row must say.
    const assigneeAdmin = await onBuiltInRole('admin');
    const { gate } = await designSubtaskWithGate({
      assigneeId: assigneeAdmin.id,
      reporterId: assigneeAdmin.id,
    });

    await approvalGatesService.decide(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, decision: 'approve', source: 'ui' },
      { userId: assigneeAdmin.id, workspaceId: fx.workspaceId },
    );
    const row = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } });
    expect(row.decidedUnderAuthority).toBe('assignee');
  });
});
