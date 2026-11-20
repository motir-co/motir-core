import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import {
  approvalGateRepository,
  translateApprovalGateWriteError,
} from '@/lib/repositories/approvalGateRepository';
import { designResultGateHandler } from '@/lib/approvalGates/designResultHandler';
import {
  ApprovalGateAlreadyDecidedError,
  ApprovalGateNotFoundError,
} from '@/lib/approvalGates/errors';
import { hostNonAnswerRefusal, toGateRefusal } from '@/lib/approvalGates/refusals';
import { routedToDisplayName, routingTargetId } from '@/lib/approvalGates/routing';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from './fixtures';
import { createTestUser } from './fixtures/userFixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// STORY MOTIR-4778's COVERAGE FLOOR — the arms the per-subtask suites left
// (Subtask MOTIR-4796).
//
// ⚠️ WHAT THIS FILE IS, AND WHAT IT DELIBERATELY IS NOT. It is NOT a second
// pass over behaviour the code subtasks already proved — `decide`'s race, its
// refusals, its authority ladder, the retention pin and the registry's
// promotion probe are each covered by their own card's suite, and re-asserting
// them here would be exactly the re-covering this card is told not to do.
//
// It is the residue: the arms that no single card's suite reached, found by
// MEASURING the assembled surface rather than by reading it. Each one was
// sorted before a line was written — the card's own instruction — and the
// verdict for each was read off the PRODUCER of the value, not off the arm:
//
//   COVERED HERE (the producer really can produce this):
//     · `toGateRefusal`, all eight arms — the client's narrowing of the
//       server's refusal codes, which had NO test at all;
//     · the design handler's `resolvedStatusKey === null` arm — the resolver
//       returns null for a workflow with nothing in the target category;
//     · `ApprovalGateAlreadyDecidedError` with a null `decidedAt`;
//     · `getForWorkItem`'s ADMIN arm of `canDecide`;
//     · `decide`'s post-lock tenant gate.
//
//   UNREACHABLE, and marked at the arm with a `v8 ignore` citing the invariant
//   test that proves it (never a fixture nobody can build):
//     · the frame's `default:` over the total `GateRefusal` union;
//     · the repository's two defensive rethrows.
//
// ⚠️ AND THE DIRECTIVES HAD TO BE RE-SPELLED, WHICH IS A FINDING RATHER THAN A
// TIDY-UP. Two arms in `approvalGateRepository.ts` already carried
// `/* istanbul ignore next */`. The coverage provider is **v8**
// (`vitest.config.ts`), which does not read istanbul's pragma — so both
// directives were inert and both arms were being counted as uncovered. A
// directive that does not suppress is worse than none: it tells a reader the
// arm has been dispositioned while the number keeps saying otherwise.

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

describe('toGateRefusal — the client reads the SERVER’s vocabulary (MOTIR-4796)', () => {
  // ⚠️ WHY THIS BELONGS IN THE STORY'S GATE RATHER THAN A COMPONENT SUITE. It
  // is the ONE-LANGUAGE claim on the failure axis, at runtime. The union's own
  // header says so: *"the whole claim of this story is that approving means ONE
  // thing everywhere — which has to be true of the failures as much as of the
  // verbs"*, and its totality is proven at the TYPE level by
  // `REFUSAL_TAGS_ARE_TOTAL`. What no type can prove is that the mapping
  // FUNCTION agrees with the union it narrows to — and that function had no
  // test, so a tag added to both sides and mistyped in the `case` would fall to
  // `UNEXPECTED` and render the generic copy, with every compile-time proof
  // still green.

  it('passes each server tag through UNCHANGED', () => {
    for (const tag of [
      'APPROVAL_GATE_NOT_AUTHORISED',
      'APPROVAL_GATE_NOT_FOUND',
      'APPROVAL_GATE_KIND_UNREGISTERED',
      'APPROVAL_GATE_DECISION_UNRESOLVABLE',
      'APPROVAL_GATE_ALREADY_AWAITING',
      'APPROVAL_GATE_DELIVERY_UNREADABLE',
      'APPROVAL_GATE_DECIDED_IMMUTABLE',
      'MERGE_CHECKS_NOT_GREEN',
      'MERGE_ALREADY_MERGED',
      'MERGE_ALREADY_REQUEUED',
    ] as const) {
      expect(toGateRefusal(tag)).toEqual({ tag });
    }
    // The conflict alone carries where it was met and which members (MOTIR-5915), and a
    // bare code reads as the merge's own refusal, with nobody named.
    expect(toGateRefusal('MERGE_CONFLICT')).toEqual({
      tag: 'MERGE_CONFLICT',
      atPress: false,
      conflicts: [],
    });
  });

  it('TRANSITION_REFUSED carries whether the card is closed, false when unsaid (MOTIR-11835)', () => {
    expect(toGateRefusal('APPROVAL_GATE_TRANSITION_REFUSED', { closed: true })).toEqual({
      tag: 'APPROVAL_GATE_TRANSITION_REFUSED',
      closed: true,
    });
    for (const extra of [undefined, {}, { closed: null }] as const) {
      expect(toGateRefusal('APPROVAL_GATE_TRANSITION_REFUSED', extra)).toEqual({
        tag: 'APPROVAL_GATE_TRANSITION_REFUSED',
        closed: false,
      });
    }
  });

  it('SUPERSEDED carries the cause when the door read one, and null when it did not (MOTIR-5667)', () => {
    // A FIELD on an existing member, not a new tag: `REFUSAL_TAGS_ARE_TOTAL` is
    // unchanged, which is MOTIR-5232's deliberate compile-break to make.
    expect(toGateRefusal('APPROVAL_GATE_SUPERSEDED', { supersedeCause: 'head_moved' })).toEqual({
      tag: 'APPROVAL_GATE_SUPERSEDED',
      supersedeCause: 'head_moved',
    });
    // Null is a real answer — the caller had only the state — and the copy then
    // says the reason was not recorded rather than guessing one.
    for (const extra of [undefined, {}, { supersedeCause: null }] as const) {
      expect(toGateRefusal('APPROVAL_GATE_SUPERSEDED', extra)).toEqual({
        tag: 'APPROVAL_GATE_SUPERSEDED',
        supersedeCause: null,
      });
    }
  });

  it('carries what the two merge refusals with a payload can SAY (MOTIR-5512)', () => {
    expect(
      toGateRefusal('MERGE_APP_PERMISSION_MISSING', { permission: 'contents: write' }),
    ).toEqual({
      tag: 'MERGE_APP_PERMISSION_MISSING',
      permission: 'contents: write',
    });
    // No header, or an empty one, is the unnamed arm — never a blank in the sentence.
    for (const extra of [undefined, {}, { permission: null }, { permission: '' }]) {
      expect(toGateRefusal('MERGE_APP_PERMISSION_MISSING', extra)).toEqual({
        tag: 'MERGE_APP_PERMISSION_MISSING',
        permission: null,
      });
    }
    expect(toGateRefusal('MERGE_BRANCH_PROTECTED', { reason: 'A review is required' })).toEqual({
      tag: 'MERGE_BRANCH_PROTECTED',
      reason: 'A review is required',
    });
    expect(toGateRefusal('MERGE_BRANCH_PROTECTED')).toStrictEqual({
      tag: 'MERGE_BRANCH_PROTECTED',
    });
  });

  it('carries the wait a THROTTLE named, and reads the host non-answers (Bug MOTIR-11841)', () => {
    expect(toGateRefusal('MERGE_RATE_LIMITED', { retryAfterSeconds: 60 })).toEqual({
      tag: 'MERGE_RATE_LIMITED',
      retryAfterSeconds: 60,
    });
    // No wait named is the unnamed arm, never a guessed number.
    expect(toGateRefusal('MERGE_RATE_LIMITED')).toEqual({
      tag: 'MERGE_RATE_LIMITED',
      retryAfterSeconds: null,
    });
    expect(hostNonAnswerRefusal({ reason: 'rate_limited', retryAfterSeconds: 90 })).toEqual({
      tag: 'MERGE_RATE_LIMITED',
      retryAfterSeconds: 90,
    });
    for (const reason of ['timeout', 'unreachable', 'unexpected_status']) {
      expect(hostNonAnswerRefusal({ reason, retryAfterSeconds: null })).toEqual({
        tag: 'UNEXPECTED',
      });
    }
  });

  it('has NO member for a changed subject — that is the shipped SUPERSEDED, not a sixth merge refusal (MOTIR-5512)', () => {
    // §4's second amendment, decision 8: a moved head, a closed pull request or a
    // lost link SUPERSEDES the gate. A `MERGE_SUBJECT_CHANGED` would be the second
    // vocabulary `refusals.ts`'s header forbids, so the client must not know it.
    expect(toGateRefusal('MERGE_SUBJECT_CHANGED')).toEqual({ tag: 'UNEXPECTED' });
    expect(toGateRefusal('APPROVAL_GATE_SUPERSEDED')).toEqual({
      tag: 'APPROVAL_GATE_SUPERSEDED',
      supersedeCause: null,
    });
  });

  it('carries the decider’s surviving label on ALREADY_DECIDED', () => {
    expect(
      toGateRefusal('APPROVAL_GATE_ALREADY_DECIDED', { decidedByLabel: 'Ada <a@b.c>' }),
    ).toEqual({ tag: 'APPROVAL_GATE_ALREADY_DECIDED', decidedByLabel: 'Ada <a@b.c>' });
  });

  it('reads a MISSING label as null, never as a placeholder name', () => {
    // The union's own note: a decider whose account was removed leaves
    // `decidedById` null and may leave no surviving label either, so the copy
    // has an unattributed arm. Inventing a name here would fill that arm with a
    // person who did not decide it.
    expect(toGateRefusal('APPROVAL_GATE_ALREADY_DECIDED')).toEqual({
      tag: 'APPROVAL_GATE_ALREADY_DECIDED',
      decidedByLabel: null,
    });
    expect(toGateRefusal('APPROVAL_GATE_ALREADY_DECIDED', { decidedByLabel: null })).toEqual({
      tag: 'APPROVAL_GATE_ALREADY_DECIDED',
      decidedByLabel: null,
    });
  });

  it('narrows ANYTHING it does not recognise to UNEXPECTED — never renders a server string', () => {
    // A transport failure carries no tag at all, and a tag from a newer server
    // than this client is the same case from the client's side. Both must reach
    // drawn copy rather than a raw sentence on a decision surface.
    for (const code of [undefined, null, '', 'SOMETHING_NEWER', 42, {}, ['x']]) {
      expect(toGateRefusal(code)).toEqual({ tag: 'UNEXPECTED' });
    }
  });
});

describe('the design handler’s NO-STATUS arm — a workflow with nothing in `done` (MOTIR-4796)', () => {
  it('records the decision and writes no status, naming the reason', async () => {
    // ⚠️ DRIVEN THROUGH THE HANDLER, NOT THROUGH A MUTILATED PROJECT, and the
    // card's own rule is why: read the verdict off the PRODUCER of the value.
    // The producer is `workflowsService.resolveStatusKey`, which returns null
    // when a project has no status carrying the key AND none in the category —
    // a real answer its own contract calls *"a legitimate answer the callers
    // turn into a logged no-op, never a crash"*. So the honest fixture is that
    // null, handed to the arm that consumes it. Deleting a project's done
    // statuses would test the same arm through a database state no tenant can
    // reach, which is the *"fixture nobody can build"* this card warns against.
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'A card in a done-less workflow' },
      fx.ctx,
    );
    const statusBefore = (await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } }))
      .status;

    const effect = await withWorkspaceContext(fx.ctx, async (tx) => {
      const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
      return designResultGateHandler.approve({
        gate: {
          id: 'gate-x',
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          workItemId: item.id,
          subjectId: 'ev-x',
        },
        item: row,
        ctx: fx.ctx,
        tx,
        resolvedStatusKey: null,
        refusalVerdict: null,
      });
    });

    expect(effect).toEqual({
      statusWritten: null,
      statusDeferredReason: 'no_status_in_target_category',
    });

    // AND THE DECISION IS NOT THROWN AWAY OVER ITS OWN FOOTNOTE. The card is
    // left exactly where it was rather than moved somewhere invented — measured
    // against the status read BEFORE the call, which is the only comparison
    // that can fail.
    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.status).toBe(statusBefore);
  });
});

describe('the design handler’s ROUTING falls all the way through (MOTIR-4796)', () => {
  // ADR §2's rule is `assigneeId ?? reporterId`, and its THIRD arm — a card
  // with neither — was the handler's one unreached branch. It is not a
  // hypothetical: `routeTo` is called by the PUBLISH path on whatever card is
  // publishing, and `routed_to_id` is nullable precisely so that "nobody" is
  // expressible. The arm that matters is that it yields null rather than
  // throwing or inventing a recipient, because a gate routed to nobody must
  // still be raised — it is decidable by an admin (the authority rule is wider
  // than the routing rule), and a publish that threw here would lose the gate.
  const routing = (item: { assigneeId: string | null; reporterId: string | null }) =>
    designResultGateHandler.routeTo({
      item: item as never,
      ctx: null as never,
      tx: null as never,
    });

  it('prefers the assignee, falls back to the reporter, then to NOBODY', () => {
    expect(routing({ assigneeId: 'u-assignee', reporterId: 'u-reporter' })).toBe('u-assignee');
    expect(routing({ assigneeId: null, reporterId: 'u-reporter' })).toBe('u-reporter');
    expect(routing({ assigneeId: null, reporterId: null })).toBeNull();
  });

  // ⚠️ AND THE HANDLER NOW DELEGATES TO THE SHARED RULE (MOTIR-5191), so the
  // three arms above exercise `routingTargetId` too. These pin it directly as
  // well, because its SECOND caller is the Approvals queue — which reaches it
  // through a repository projection rather than through this handler, and would
  // otherwise have no arm of its own here.
  it('is the SAME rule the shared helper states — the handler is a delegation now', () => {
    expect(routingTargetId({ assigneeId: 'u-assignee', reporterId: 'u-reporter' })).toBe(
      'u-assignee',
    );
    expect(routingTargetId({ assigneeId: null, reporterId: 'u-reporter' })).toBe('u-reporter');
    expect(routingTargetId({ assigneeId: null, reporterId: null })).toBeNull();
  });
});

describe('routedToDisplayName — the *waiting on* name degrades honestly (MOTIR-5191)', () => {
  // The display rule, pinned as a pure function because its two degradations
  // are exactly the arms a fixture with well-formed users never reaches — and
  // they are the arms that decide whether the sentence reads *"Waiting on
  // Mara S."*, *"Waiting on ."*, or the generic fallback.

  it('uses the name when there is one', () => {
    expect(routedToDisplayName({ name: 'Mara Sandoval', email: 'mara@example.com' })).toBe(
      'Mara Sandoval',
    );
  });

  it('falls back to the EMAIL on a blank name — `||`, never `??`', () => {
    // `User.name` is non-nullable but not non-EMPTY. A nullish-coalescing rule
    // would keep the blank and render *"Waiting on ."*, which is worse than the
    // generic fallback it replaced: it looks like a bug rather than an absence.
    expect(routedToDisplayName({ name: '   ', email: 'mara@example.com' })).toBe(
      'mara@example.com',
    );
    expect(routedToDisplayName({ name: '', email: 'mara@example.com' })).toBe('mara@example.com');
  });

  it('yields NULL for a user row that no longer resolves — the fallback copy’s case', () => {
    // This is the arm ADR §3 relies on when it declines to denormalise a
    // surviving label beside `routedToId`: the surface has somewhere honest to
    // land, so the routing column may be `onDelete: SetNull` without stranding
    // anybody.
    expect(routedToDisplayName(null)).toBeNull();
  });
});

describe('ApprovalGateAlreadyDecidedError — the message degrades honestly (MOTIR-4796)', () => {
  it('names the time when it has one', () => {
    const at = new Date('2026-09-10T12:00:00.000Z');
    const err = new ApprovalGateAlreadyDecidedError('g1', 'approved', 'u1', at, 'Ada <a@b.c>');
    expect(err.message).toContain('2026-09-10T12:00:00.000Z');
    expect(err.name).toBe('ApprovalGateAlreadyDecidedError');
  });

  it('says the rest WITHOUT a time rather than printing an empty one', () => {
    // The null arm. A decided row always carries `decidedAt` today, so this is
    // the constructor's own contract being kept rather than a state the door
    // produces — but the parameter is nullable and public, so the arm is the
    // class's to honour and cheap to pin.
    const err = new ApprovalGateAlreadyDecidedError('g1', 'changes_requested', null, null, null);
    expect(err.message).toContain('g1');
    expect(err.message).toContain('changes_requested');
    expect(err.message).not.toContain('at ');
    expect(err.message).not.toContain('undefined');
    expect(err.message).not.toContain('null');
  });
});

describe('getForWorkItem — `canDecide` resolves the ADMIN arm too (MOTIR-4796)', () => {
  it('is true for a workspace admin who is neither assignee nor reporter', async () => {
    // The frame's own read and the door now call the SAME function
    // (`approvalGatesService.resolveGateAuthority`, MOTIR-5192), and its ADMIN
    // arm is the one the per-card suite never reached:
    // `approval-gate-read.test.ts` drives the assignee and reporter arms, so an
    // admin opening somebody else's card would have been shown a port with no
    // verbs by a read nothing had exercised — while the door would have
    // honoured their press.
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Approve a design' },
      fx.ctx,
    );
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'subtask', parentId: story.id, title: 'Draw it' },
      fx.ctx,
    );
    const other = await createTestUser();
    await adminDb.workItem.update({
      where: { id: item.id },
      data: { assigneeId: other.id, reporterId: other.id },
    });
    await withWorkspaceContext(fx.ctx, (tx) =>
      approvalGateRepository.create(
        {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          workItemId: item.id,
          kind: 'design_result',
          subjectId: `ev-${item.id}`,
        },
        tx,
      ),
    );

    // `fx.ctx` is the fixture's OWNER — neither assignee nor reporter now.
    const read = await approvalGatesService.getForWorkItem(
      { workItemId: item.id, kind: 'design_result' },
      fx.ctx,
    );
    expect(read.gate?.state).toBe('awaiting');
    expect(read.canDecide).toBe(true);
  });
});

describe('the repository translates the write failures it OWNS (MOTIR-4796)', () => {
  // ⚠️ THIS IS THE INVARIANT TEST THE `v8 ignore` DIRECTIVES IN
  // `approvalGateRepository.ts` CITE BY NAME, and it is what makes those
  // directives a disposition rather than a silencing. The card's rule: a dead
  // arm's criterion is a test that asserts the INVARIANT plus a directive
  // citing that test — never a fixture nobody can build.
  //
  // The invariant is that the repository's error translator has exactly TWO
  // failures to name, both of which the database produces and both of which are
  // asserted here through the real path. Everything the translator does BEYOND
  // those two — the final rethrow, the `originalCode` driver fallback, the
  // non-Error message arms — is unreachable while that holds. So this test is
  // the thing that would go red if it stopped holding, and the ignored arms are
  // ignored on its authority.

  it('names the partial-unique race — never a raw P2002', async () => {
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'One awaiting per subject' },
      fx.ctx,
    );
    const create = () =>
      withWorkspaceContext(fx.ctx, (tx) =>
        approvalGateRepository.create(
          {
            workspaceId: fx.workspaceId,
            projectId: fx.projectId,
            workItemId: story.id,
            kind: 'design_result',
            subjectId: 'ev-dup',
          },
          tx,
        ),
      );
    await create();
    // The typed refusal, from the index rather than from a service-side check.
    await expect(create()).rejects.toMatchObject({ code: 'APPROVAL_GATE_ALREADY_AWAITING' });
  });

  it('names the immutability trigger — never a raw check violation', async () => {
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'A decided gate is immutable' },
      fx.ctx,
    );
    const gate = await adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: story.id,
        kind: 'design_result',
        subjectId: 'ev-frozen',
        state: 'approved',
        decidedById: fx.ctx.userId,
        decidedAt: new Date(),
      },
    });

    await expect(
      withWorkspaceContext(fx.ctx, (tx) =>
        approvalGateRepository.decide(
          gate.id,
          {
            state: 'changes_requested',
            decidedById: fx.ctx.userId,
            decidedAt: new Date(),
            noteMd: null,
            subjectVersion: null,
            decidedByLabel: null,
            decidedUnderAuthority: 'assignee',
            decisionSource: 'ui',
            outcomeRef: null,
            confirmedRecord: null,
            refusalVerdict: null,
            chosenOption: null,
          },
          tx,
        ),
      ),
      // The database refuses it, and the repository gives that refusal a name.
      // This is the second of the translator's two owned failures.
    ).rejects.toMatchObject({ code: 'APPROVAL_GATE_DECIDED_IMMUTABLE' });
  });

  it('accepts the SQLSTATE alone — the fallback the marker normally shadows', () => {
    // ⚠️ THE ARM THE INTEGRATION TEST ABOVE CANNOT REACH, AND IT IS A REAL
    // CONTRACT RATHER THAN A COVERAGE CHORE. The translator's own header says
    // *"Either signal alone is accepted, because a driver upgrade can drop
    // `cause` without changing the message"* — and the marker is checked FIRST,
    // so on the shipped adapter the SQLSTATE branch never evaluates. The
    // promised fallback therefore had nothing asserting it: drop `cause`
    // handling and every test above still passes, until the driver upgrade the
    // sentence was written for arrives and the refusal stops being typed.
    //
    // The function is EXPORTED for exactly this, in its own words: *"so a test
    // can assert the pair the guard actually consists of … without either half
    // standing in for the other."*
    expect(() =>
      translateApprovalGateWriteError(
        Object.assign(new Error('update on relation "approval_gate" refused'), {
          cause: { code: '23514' },
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'APPROVAL_GATE_DECIDED_IMMUTABLE' }));
  });

  it('accepts a driver that exposes `originalCode` instead of `code`', () => {
    // The second half of the same fallback — a future adapter shape. Cheap to
    // pin, and it is the difference between a documented fallback and a hopeful
    // one.
    expect(() =>
      translateApprovalGateWriteError(
        Object.assign(new Error('refused'), { cause: { originalCode: '23514' } }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'APPROVAL_GATE_DECIDED_IMMUTABLE' }));
  });

  it('rethrows anything it does not own, UNCHANGED', () => {
    // The boundary of the two owned failures, asserted rather than assumed —
    // this is what the `v8 ignore` on the final rethrow rests on. A write
    // failure this domain cannot name must arrive at the caller as itself, not
    // as a plausible approval-gate error.
    const foreign = Object.assign(new Error('connection terminated'), {
      cause: { code: '57P01' },
    });
    expect(() => translateApprovalGateWriteError(foreign)).toThrowError(foreign);
  });

  it('survives a non-Error throw without inventing a message', () => {
    // The `extractMessage` fallbacks. A thrown object with a `message`, and a
    // thrown primitive with none: neither may be mistaken for an owned failure.
    expect(() => translateApprovalGateWriteError({ message: 'AG_DECIDED_IMMUTABLE' })).toThrowError(
      expect.objectContaining({ code: 'APPROVAL_GATE_DECIDED_IMMUTABLE' }),
    );
    expect(() => translateApprovalGateWriteError('a bare string')).toThrow();
  });
});

describe('lockById answers null for a row that is not there (MOTIR-4796)', () => {
  // ⚠️ THIS BLOCK USED TO OPEN WITH AN UNBOUND-READ TEST, AND
  // `tests/rls/test-call-site-guard.test.ts` WAS RIGHT TO REFUSE IT. That test
  // called the repository's four reads with no `tx` and asserted each returned
  // nothing — reaching for the `tx ?? dbRead` branch and dressing it as a policy
  // assertion. The guard's message is the exact diagnosis: *"if it expects
  // emptiness it will PASS while checking nothing, which is worse."* An unbound
  // read under `motir_app` returns empty because nothing is bound, which is true
  // whether or not the policy works — so the assertion could not fail for the
  // reason it claimed to be testing.
  //
  // The property it was pretending to assert is ALREADY asserted, at the right
  // altitude, by `tests/approval-gate-rls.test.ts` — *"with NO GUC set, the
  // motir_app role sees zero gate rows"* — which measures the POLICY as the app
  // role rather than a repository call shape no production path uses.
  //
  // The `tx ?? dbRead` branch is therefore left uncovered ON PURPOSE, and the
  // repository's branch threshold is pinned at the measured value with that
  // reason in `vitest.config.ts`. Manufacturing an assertion to move a number is
  // the failure this card's own instruction warns about: a dead arm gets a
  // VERDICT, never a fixture nobody can build.

  it('`lockById` answers null for a row that is not there', async () => {
    // The `rows[0] ?? null` arm. The door depends on it: a lock that returned
    // `undefined` would fail the `if (!locked)` check by accident rather than by
    // contract, and the difference shows up the day the query shape changes.
    const locked = await withWorkspaceContext(fx.ctx, (tx) =>
      approvalGateRepository.lockById('cmzzzzzzzzzzzzzzzzzzzzzzzz', tx),
    );
    expect(locked).toBeNull();
  });
});

describe('decide — the POST-LOCK tenant gate (MOTIR-4796)', () => {
  it('refuses a gate whose WORK ITEM is not this workspace’s, as a not-found', async () => {
    // ⚠️ DEFENCE IN DEPTH, AND THE ONE ARM THE CROSS-WORKSPACE TEST DOES NOT
    // REACH. `approval-gate-decide.test.ts` asserts a gate in another workspace
    // is a not-found — and that refusal comes from the PRE-READ, because RLS
    // hides the whole row. The door ALSO re-checks after taking the lock, and
    // that second check is only reachable by a row the pre-read could see: a
    // gate carrying THIS workspace's id whose work item belongs to another.
    // Nothing in the schema forbids that pairing, which is exactly why the
    // check is there.
    const foreign = await makeWorkItemFixture();
    const story = await workItemsService.createWorkItem(
      { projectId: foreign.projectId, kind: 'story', title: 'Elsewhere' },
      foreign.ctx,
    );

    // Written with the admin client on purpose: a mismatched pair is the state
    // under test, so it must be constructed past the policy that prevents it.
    const gate = await adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: story.id,
        kind: 'design_result',
        subjectId: 'ev-foreign',
        state: 'awaiting',
      },
    });

    await expect(
      approvalGatesService.decide(
        { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, decision: 'approve', source: 'ui' },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(ApprovalGateNotFoundError);

    // AND NOTHING WAS DECIDED — the refusal is a refusal, not a rollback of a
    // partial write.
    const after = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } });
    expect(after.state).toBe('awaiting');
    expect(after.decidedById).toBeNull();
  });
});
