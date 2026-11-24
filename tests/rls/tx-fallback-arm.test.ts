import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { attachmentRepository } from '@/lib/repositories/attachmentRepository';
import { automationRuleExecutionRepository } from '@/lib/repositories/automationRuleExecutionRepository';
import { automationRuleRepository } from '@/lib/repositories/automationRuleRepository';
import { customFieldDefinitionRepository } from '@/lib/repositories/customFieldDefinitionRepository';
import { dashboardRepository } from '@/lib/repositories/dashboardRepository';
import { dashboardWidgetRepository } from '@/lib/repositories/dashboardWidgetRepository';
import { workflowsRepository } from '@/lib/repositories/workflowsRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { sprintRepository } from '@/lib/repositories/sprintRepository';
import { customFieldOptionRepository } from '@/lib/repositories/customFieldOptionRepository';
import { labelRepository } from '@/lib/repositories/labelRepository';
import { workItemLabelRepository } from '@/lib/repositories/workItemLabelRepository';
import { componentRepository } from '@/lib/repositories/componentRepository';
import { workItemComponentRepository } from '@/lib/repositories/workItemComponentRepository';
import { watcherRepository } from '@/lib/repositories/watcherRepository';
import { commentRepository } from '@/lib/repositories/commentRepository';
import { commentMentionRepository } from '@/lib/repositories/commentMentionRepository';
import { notificationRepository } from '@/lib/repositories/notificationRepository';
import { customFieldValueRepository } from '@/lib/repositories/customFieldValueRepository';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { planChangeTurnRepository } from '@/lib/repositories/planChangeTurnRepository';
import { codeGraphOffboardingRepository } from '@/lib/repositories/codeGraphOffboardingRepository';
import { ciPeriodChargeRepository } from '@/lib/repositories/ciPeriodChargeRepository';
import { sprintsService } from '@/lib/services/sprintsService';
import { savedFilterRepository } from '@/lib/repositories/savedFilterRepository';
import { savedFilterSubscriptionRepository } from '@/lib/repositories/savedFilterSubscriptionRepository';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { savedFilterSubscriptionsService } from '@/lib/services/savedFilterSubscriptionsService';
import { encodeFilterParam } from '@/lib/filters/ast';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { UnknownFilterOperatorError } from '@/lib/filters/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '@/tests/fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The `tx ?? dbRead` FALLBACK ARM (MOTIR-2815 part 1).
//
// Every read this story bound has two arms and the coverage gate counts both.
// Binding the production callers left the `db` one with NO caller at all, so it
// went uncovered and eight repositories dropped under the ≥90% branch floor —
// `workflowsRepository` to 75%, `automationRuleRepository` to 80%,
// `dashboardWidgetRepository` to 81%. The card predicted exactly this, and named
// the honest fix: exercise the arm deliberately rather than lower the floor.
//
// ⚠️ WHAT THE ARM IS FOR, AND WHAT IT OWES. The fallback is not dead code to be
// deleted — it is what a repository does when nobody has bound a transaction,
// and the whole point of this story is that the ANSWER in that state is wrong.
// So the assertion is the one MOTIR-2805 established: an UNBOUND read comes back
// EMPTY, and that is CORRECT. Asserting rows here would be asserting that a path
// with no binding somehow works — the exact false claim the story exists to
// remove.
//
// ⚠️ AND THAT MAKES THE FIXTURE LOAD-BEARING. `expect([]).toEqual([])` also passes
// when nothing was ever seeded, so every case below seeds through `adminDb` and
// the bound path is proved elsewhere (`app-role-bound-context-reads.test.ts`) —
// emptiness here is only evidence because the row demonstrably exists.
//
// Until MOTIR-2734 each assertion below had a second arm, taken when
// `TEST_DB_APP_ROLE` was unset: under the BYPASSRLS owner RLS is inert and the
// rows come back. `@/lib/db` is now always `motir_app`, so that arm is
// unreachable and has been removed rather than left as a branch nothing selects.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Nothing comes back unbound under `motir_app`. The whole contract, once. */
function expectFallbackAnswer<T>(rows: T[]): void {
  expect(
    rows,
    'an UNBOUND read must come back empty under `motir_app` — if it returns rows, ' +
      'the policy is not gating this table and the verdict list is wrong about it',
  ).toEqual([]);
}

/** …and the scalar form, for the counts. */
function expectFallbackCount(value: number): void {
  expect(value).toBe(0);
}

/** A trivially-valid stored filter — the criteria are not what these cases test. */
const KIND_TASK_FILTER_PARAM = encodeFilterParam({
  combinator: 'and',
  conditions: [{ field: 'kind', operator: 'is_any_of', value: ['task'] }],
});

async function seedItem(identifier: string): Promise<{ fx: WorkItemFixture; itemId: string }> {
  const fx = await makeWorkItemFixture({ identifier });
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'Subject' },
    fx.ctx,
  );
  return { fx, itemId: item.id };
}

describe('workflowsRepository — the arm every workflow read now falls back to', () => {
  it('statuses, transitions and the by-key / by-id lookups, all unbound', async () => {
    const { fx } = await seedItem('FA1');

    const statuses = await workflowsRepository.findStatuses(fx.projectId, fx.workspaceId);
    expectFallbackAnswer(statuses);

    const transitions = await workflowsRepository.findTransitions(fx.projectId, fx.workspaceId);
    expectFallbackAnswer(transitions);

    const byProjects = await workflowsRepository.findStatusesByProjects(
      [fx.projectId],
      fx.workspaceId,
    );
    expectFallbackAnswer(byProjects);

    const byKey = await workflowsRepository.findStatusByKey(fx.projectId, 'todo', fx.workspaceId);
    expect(byKey).toBeNull();

    // …and the id-keyed pair, which needs a real id to be worth anything: read it
    // through the OWNER so the lookup below is a genuine miss-or-hit rather than
    // a lookup of nothing.
    const seeded = await adminDb.workflowStatus.findFirst({ where: { projectId: fx.projectId } });
    const byId = await workflowsRepository.findStatusById(seeded!.id, fx.workspaceId);
    expect(byId).toBeNull();

    const seededTransition = await adminDb.workflowTransition.findFirst({
      where: { projectId: fx.projectId },
    });
    const transition = await workflowsRepository.findTransitionById(
      seededTransition!.id,
      fx.workspaceId,
    );
    expect(transition).toBeNull();

    const found = await workflowsRepository.findTransition(
      fx.projectId,
      seededTransition!.fromStatusId,
      seededTransition!.toStatusId,
      fx.workspaceId,
    );
    expect(found).toBeNull();
  });
});

describe('the remaining fallback arms this story left without a caller', () => {
  it('attachmentRepository — the item’s files, its count, and the id lookups', async () => {
    const { fx, itemId } = await seedItem('FA2');
    const attachment = await adminDb.attachment.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: itemId,
        uploaderUserId: fx.ownerId,
        blobPathname: `k/${itemId}`,
        originalFilename: 'a.png',
        mimeType: 'image/png',
        sizeBytes: 10,
      },
    });

    // Only the methods that still HAVE a fallback arm. `findById` and
    // `findManyByIds` now REQUIRE a `tx` (tightened on `main` while this branch
    // was open), which is the better end state — a required parameter cannot be
    // forgotten — and it removes them from this file's subject rather than
    // needing a case here.
    expectFallbackAnswer(await attachmentRepository.listByWorkItem(itemId, {}));
    expectFallbackCount(await attachmentRepository.countByWorkItem(itemId));
    expect(attachment.id).toBeTruthy();
  });

  it('customFieldDefinitionRepository — the project’s fields and one by id', async () => {
    const { fx, itemId } = await seedItem('FA3');
    const field = await adminDb.customFieldDefinition.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        key: 'team',
        label: 'Team',
        fieldType: 'text',
        position: 'a0',
      },
    });

    expectFallbackAnswer(
      await customFieldDefinitionRepository.listByProject(fx.projectId, fx.workspaceId),
    );
    expectFallbackCount(
      await customFieldDefinitionRepository.countByProject(fx.projectId, fx.workspaceId),
    );
    expectFallbackAnswer(
      await customFieldDefinitionRepository.listWithValuesForWorkItem(
        fx.projectId,
        fx.workspaceId,
        itemId,
      ),
    );

    const byId = await customFieldDefinitionRepository.findById(field.id, fx.workspaceId);
    expect(byId).toBeNull();
  });

  it('dashboardRepository + dashboardWidgetRepository — the grid and its widgets', async () => {
    const { fx } = await seedItem('FA4');
    const dashboard = await adminDb.dashboard.create({
      data: {
        workspaceId: fx.workspaceId,
        ownerId: fx.ownerId,
        name: 'Board',
        access: 'private',
        layout: 'two',
      },
    });
    const widget = await adminDb.dashboardWidget.create({
      data: {
        dashboardId: dashboard.id,
        type: 'distribution',
        column: 0,
        position: 'a0',
        config: {},
        projectId: fx.projectId,
      },
    });

    const row = await dashboardRepository.findByIdWithFacts(fx.workspaceId, dashboard.id);
    expect(row).toBeNull();

    expectFallbackAnswer(await dashboardRepository.listVisible(fx.workspaceId, fx.ownerId, 20));
    expectFallbackAnswer(await dashboardWidgetRepository.listByDashboard(dashboard.id));

    const named = await dashboardWidgetRepository.findByIdWithNames(dashboard.id, widget.id);
    expect(named).toBeNull();
  });

  it('automationRule + its executions — the rule list, and the audit trail', async () => {
    const { fx, itemId } = await seedItem('FA5');
    const rule = await adminDb.automationRule.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        ownerId: fx.ownerId,
        name: 'On create',
        triggerType: 'created',
        enabled: true,
        triggerConfig: {},
        conditionAst: {},
        actions: [],
      },
    });
    await adminDb.automationRuleExecution.create({
      data: {
        ruleId: rule.id,
        workItemId: itemId,
        eventId: 'evt-1',
        status: 'success',
      },
    });

    expectFallbackAnswer(await automationRuleRepository.listByProject(fx.projectId));
    void itemId;
    expectFallbackAnswer(
      await automationRuleRepository.listEnabledByProjectAndTrigger(fx.projectId, 'created'),
    );

    const byId = await automationRuleRepository.findByIdInProject(rule.id, fx.projectId);
    expect(byId).toBeNull();

    expectFallbackAnswer(
      await automationRuleExecutionRepository.listByRule(rule.id, { skip: 0, take: 10 }),
    );
    expectFallbackCount(await automationRuleExecutionRepository.countByRule(rule.id));

    // The idempotency probe, and the one whose unbound answer is actively
    // dangerous rather than merely empty: `false` means "never ran", so a
    // replayed event re-applies every action.
    const already = await automationRuleExecutionRepository.existsByRuleAndEvent(rule.id, 'evt-1');
    expect(already).toBe(false);
  });
});

// ── The write-error translation the fallback sweep left uncovered ────────────

describe('workItemRepository.setStoryPoints — the P2025 translation', () => {
  it('turns a missing row into WorkItemNotFoundError rather than leaking Prisma', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'FA6' });

    // Not a fallback arm — a defensive CATCH the coverage sweep surfaced beside
    // them, and the only branch of `setStoryPoints` no test reached. It is worth
    // covering rather than ignoring: a raw `PrismaClientKnownRequestError`
    // escaping the repository would reach a route as a 500 instead of the 404
    // the service contract promises.
    await expect(
      withWorkspaceContext({ userId: fx.ownerId, workspaceId: fx.workspaceId }, (tx) =>
        workItemRepository.setStoryPoints('cl00000000000000000000000', 5, tx),
      ),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });
});

describe('workItemRepository — an invalid operator never reaches the SQL compiler', () => {
  it('REFUSES a text operator on a non-text field with a typed error', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'FA7' });

    // ⚠️ WHAT THIS DOES AND DOES NOT PROVE — corrected on the record, because the
    // first version of this comment was wrong in a way worth keeping visible.
    //
    // It asserts the CONTRACT: a repository handed a nonsense operator refuses it
    // with a typed error instead of compiling it into SQL a column cannot
    // support. That is real and worth holding.
    //
    // It does NOT reach `compileConditionSql`'s `case 'contains'` guard, which is
    // what it originally claimed. `resolveFilterAst` -> `validateResolvedCondition`
    // throws the SAME error class one layer earlier, so the assertion is satisfied
    // before the compiler runs. The repository branch is genuinely unreachable and
    // now carries a `v8 ignore` directive saying so.
    //
    // The general lesson, and the reason this is written out: an assertion on an
    // ERROR CLASS does not pin WHERE the error came from. CI's coverage report is
    // what caught it; the green test could not.
    await expect(
      workItemRepository.countProjectIssues(fx.projectId, fx.workspaceId, {
        ast: {
          combinator: 'and',
          conditions: [{ field: 'status', operator: 'contains', value: 'do' }],
        },
      }),
    ).rejects.toBeInstanceOf(UnknownFilterOperatorError);
  });
});

// ── Moved here from `app-role-bound-context-reads.test.ts` (MOTIR-2815) ──────
//
// It is the same subject as everything above — a deliberately UNBOUND read with
// a per-role assertion — and it was the only such case in a file whose whole job
// is BOUND reads. MOTIR-2797's test-call-site guard adjudicates at FILE level, so
// leaving it there would have meant exempting 46 bound assertions to excuse four
// unbound ones. Moving it lets that file stay fully guarded and puts this one
// where its adjudication is honest.

describe('the `tx ?? dbRead` fallback arm of the saved-filter reads', () => {
  // ⚠️ DELIBERATELY UNBOUND, and both arms are asserted. The optional `tx` is what
  // `tests/rls/singletonReadScan.ts` recognises as BINDABLE, so it has to stay —
  // but once every production call site threads a `tx`, the `db` arm has no
  // caller left and would go uncovered against the file's ≥90% branch floor.
  //
  // The assertion is split by role rather than weakened, because the two answers
  // are BOTH the contract: on the bypass role the fallback reads normally; on
  // `motir_app` it binds nothing, the policy sees NULL, and the honest answer is
  // the EMPTY one. Asserting rows here would be asserting that a path with no
  // binding at all somehow works — the vacuous-pass shape this story exists to
  // remove.
  it('resolves to the singleton, and returns the empty answer under the app role', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SFE' });
    const filter = await savedFiltersService.create(
      fx.projectIdentifier,
      { name: 'Fallback', visibility: 'private', filterParam: KIND_TASK_FILTER_PARAM },
      fx.ctx,
    );
    await savedFilterSubscriptionsService.subscribe(
      fx.projectIdentifier,
      filter.id,
      { schedule: 'daily', hour: 9 },
      fx.ctx,
    );

    const listArgs = {
      projectId: fx.projectId,
      actorUserId: fx.ownerId,
      actorCanManageAny: true,
      view: 'all' as const,
    };
    const rows = await savedFilterRepository.listPage({ ...listArgs, take: 10 });
    const total = await savedFilterRepository.countVisible(listArgs);
    const subs = await savedFilterSubscriptionRepository.countByFilter(filter.id);

    expect(rows).toEqual([]);
    expect(total).toBe(0);
    expect(subs).toBe(0);
  });
});

// ── The arms MOTIR-2830 stranded ─────────────────────────────────────────────
//
// Binding the TEST call sites removed the last unbound caller from nine more
// repositories, and CI's merged coverage report caught what a single local run
// had not: `codeGraphOffboardingRepository` 50%, `planChangeTurnRepository` 50%,
// `workItemRevisionRepository` 75.6%, and six others under the ≥90% branch floor.
//
// The same argument as everything above, one sweep later: the fallback is not
// dead code, it is what a repository does when nobody bound a transaction, and
// the answer in that state is the thing this story is about. So it is exercised
// on purpose rather than deleted or excused.

describe('the fallback arms MOTIR-2830 left without a caller', () => {
  it('workItemLinkRepository — every edge read, unbound', async () => {
    const { fx, itemId } = await seedItem('FB1');
    const other = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Blocker' },
      fx.ctx,
    );
    const link = await workItemsService.linkWorkItems(
      { fromId: itemId, toId: other.id, kind: 'is_blocked_by' },
      fx.ctx,
    );

    expectFallbackAnswer(await workItemLinkRepository.findByFromItem(itemId));
    expectFallbackAnswer(await workItemLinkRepository.findByToItem(other.id));
    expectFallbackAnswer(await workItemLinkRepository.findBlockedByEdges([itemId]));
    expectFallbackAnswer(await workItemLinkRepository.findBlockerStates(itemId));
    expectFallbackAnswer(await workItemLinkRepository.findBlockerStatesForItems([itemId]));
    expectFallbackAnswer(await workItemLinkRepository.findBlockerEdgesForItems([itemId]));
    expectFallbackAnswer(await workItemLinkRepository.findBlockedEdgesForItems([other.id]));
    expectFallbackAnswer(await workItemLinkRepository.findBlockerSessionBranchesForItems([itemId]));

    const one = await workItemLinkRepository.findById(link.id);
    expect(one).toBeNull();

    const between = await workItemLinkRepository.findAnyBetween(itemId, other.id);
    expect(between).toBeNull();

    const reciprocal = await workItemLinkRepository.findReciprocal(
      itemId,
      other.id,
      'is_blocked_by',
    );
    expect(reciprocal).toBeNull();
  });

  it('sprintRepository — the sprint lookups, unbound', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'FB2' });
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Arm' }, fx.ctx);

    expectFallbackAnswer(await sprintRepository.listByProject(fx.projectId, fx.workspaceId));
    expectFallbackAnswer(await sprintRepository.findByIds([sprint.id], fx.workspaceId));
    expectFallbackAnswer(
      await sprintRepository.listCompletedByProject(fx.projectId, fx.workspaceId, 10),
    );
    expectFallbackAnswer(
      await sprintRepository.listCompletedByProjectEndingAt(
        fx.projectId,
        fx.workspaceId,
        { completedAt: new Date(), sequence: 1 },
        10,
      ),
    );
    expectFallbackCount(
      await sprintRepository.countByProjectAndState(fx.projectId, fx.workspaceId, 'planned'),
    );
    // ⚠️ NON-DISCRIMINATING, and kept for the coverage floor rather than the
    // claim. `maxSequenceForProject` returns 0 for "nothing found", which is
    // also the unbound answer, so a passing 0 does not distinguish the policy
    // hiding the row from there being no row. Before MOTIR-2734 the assertion
    // ran only on the OWNER side, where a real sequence proved the read had run;
    // that side is gone with the flag, so what remains is the arm being
    // EXECUTED. Do not read this line as evidence the read is gated.
    expectFallbackCount(await sprintRepository.maxSequenceForProject(fx.projectId, fx.workspaceId));

    const byId = await sprintRepository.findById(sprint.id, fx.workspaceId);
    expect(byId).toBeNull();

    const active = await sprintRepository.findActiveByProject(fx.projectId, fx.workspaceId);
    expect(active).toBeNull(); // never started — null under BOTH roles
  });

  it('workItemRevisionRepository — the history and the aggregates, unbound', async () => {
    const { fx, itemId } = await seedItem('FB3');
    await workItemsService.updateWorkItem(itemId, { title: 'Renamed' }, fx.ctx);
    const window = {
      start: new Date(Date.now() - 24 * 60 * 60 * 1000),
      end: new Date(Date.now() + 24 * 60 * 60 * 1000),
    };

    expectFallbackAnswer(await workItemRevisionRepository.listByWorkItem(itemId));
    // TWO: the `created` revision and the rename. The NUMBER is what separates a
    // bound read from the unbound zero, so it is asserted rather than rounded to
    // "some".
    expectFallbackCount(await workItemRevisionRepository.countDisplayableByWorkItem(itemId, []));
    expectFallbackAnswer(
      await workItemRevisionRepository.aggregateNetResolvedByBucket(
        fx.projectId,
        fx.workspaceId,
        'day',
        window,
      ),
    );
    expectFallbackAnswer(
      await workItemRevisionRepository.aggregateAverageAgeByBucket(fx.projectId, fx.workspaceId, [
        { key: 'now', end: window.end },
      ]),
    );
    expectFallbackAnswer(
      await workItemRevisionRepository.aggregateResolutionTimeByBucket(
        fx.projectId,
        fx.workspaceId,
        'day',
        window,
      ),
    );

    const latest = await workItemRevisionRepository.findLatestIdsByWorkItemIds([itemId]);
    expect(latest.size).toBe(0);

    const actor = await workItemRevisionRepository.findLatestArchivedActor(itemId);
    expect(actor).toBeNull(); // never archived — null under BOTH roles

    // The status-derivation guard's read (MOTIR-2965). Bound, it finds the
    // transition below; unbound it must come back NULL — and null is the arm
    // that matters most here, because the recompute reads "no date to beat" as
    // "proceed", so an unbound read would silently restore the very overwrite
    // this guard exists to prevent.
    await workItemsService.updateStatus(itemId, 'in_progress', fx.ctx);
    const changedAt = await workItemRevisionRepository.findLatestStatusChangeAt(itemId);
    expect(changedAt).toBeNull();

    // The decision-correction mark's staleness read (MOTIR-12175). Bound, it finds
    // the item's `created` revision; unbound it must come back NULL, never a date
    // from a row this connection may not read.
    expect(await workItemRevisionRepository.findLatestDescriptionChangeAt(itemId)).toBeNull();
  });

  it('customFieldOptionRepository — the option lookups, unbound', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'FB4' });
    const field = await adminDb.customFieldDefinition.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        key: 'stage',
        label: 'Stage',
        fieldType: 'select',
        position: 'a0',
      },
    });
    const option = await adminDb.customFieldOption.create({
      data: { fieldId: field.id, label: 'Alpha', position: 'a0' },
    });

    expectFallbackAnswer(await customFieldOptionRepository.listByField(field.id, fx.workspaceId));
    expectFallbackAnswer(
      await customFieldOptionRepository.listByProject(fx.projectId, fx.workspaceId),
    );
    expectFallbackAnswer(
      await customFieldOptionRepository.findByIds([option.id], fx.projectId, fx.workspaceId),
    );
    expectFallbackCount(await customFieldOptionRepository.countByField(field.id, fx.workspaceId));

    const byId = await customFieldOptionRepository.findById(option.id, fx.workspaceId);
    expect(byId).toBeNull();
  });

  it('the plan-change conversation, the offboarding queue and the CI charge', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'FB5' });
    const session = await adminDb.planChangeSession.create({
      data: { workspaceId: fx.workspaceId, projectId: fx.projectId, scopeKey: 'project' },
    });
    await adminDb.planChangeTurn.create({
      data: {
        workspaceId: fx.workspaceId,
        sessionId: session.id,
        seq: 1,
        role: 'user',
        body: 'hello',
      },
    });

    const found = await planChangeSessionRepository.findByProjectAndScope(
      fx.projectId,
      'project',
      fx.workspaceId,
    );
    expect(found).toBeNull();

    expectFallbackAnswer(
      await planChangeTurnRepository.listBySessionId(session.id, fx.workspaceId),
    );

    // Two tables gated but NOT by `app.workspace_id`: the offboarding queue is a
    // system-context table, the CI charge is org-scoped. Their arms still need a
    // caller, and BOTH answer the same under either role here — nothing seeded,
    // so nothing to hide. The value is the branch, not the verdict.
    expectFallbackAnswer(
      await codeGraphOffboardingRepository.findByProject(fx.workspaceId, fx.projectId),
    );

    // ⚠️ Named in a comment on the first pass and never actually CALLED, which is
    // why CI kept reporting `ciPeriodChargeRepository` at 83.33%. A comment does
    // not execute a branch.
    const organizationId = await adminDb.workspace
      .findUniqueOrThrow({ where: { id: fx.workspaceId } })
      .then((w) => w.organizationId);
    const charge = await ciPeriodChargeRepository.findForPeriod(
      organizationId,
      new Date('2026-08-01T00:00:00.000Z'),
    );
    expect(charge).toBeNull(); // no row for that period, under either role
  });
});

// ── EVERY `tx ?? dbRead` arm in `workItemRepository`, in one table ────────────────
//
// The file has SIXTY-EIGHT of them, and MOTIR-2830 took the last caller off
// almost all at once by binding the test call sites. Branch coverage fell to
// 85.3% with barely an uncovered LINE, which is the trap: a two-arm branch whose
// `tx` side is taken and whose `db` side is not leaves the line fully covered and
// the branch half-covered, so "Uncovered Line #s" points at nothing useful. Only
// the percentage moves. Chasing the reported line is the wrong instrument.
//
// A TABLE rather than sixty-eight `it`s, and rather than a hand-picked subset
// that happens to clear the floor: the claim worth making is "every fallback arm
// in this file has a caller", which a list can state and a sample cannot. A new
// bindable read added here with no entry does not fail this test — but its arm
// goes uncovered and the ≥90% floor says so, which is the same signal one step
// removed.
//
// The contract is the file's usual one, applied generically: under the owner the
// call resolves; under `motir_app` it comes back EMPTY. `isEmptyish` spells out
// what "empty" means across the four shapes these reads return.

/** `[]`, `0`, `null`, or an empty `Map` — the four ways these reads say nothing. */
function isEmptyish(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'number') return value === 0;
  // A Map whose VALUES are all empty counts as empty: several of these reads
  // pre-seed an entry per requested id so callers can `.get()` without a null
  // gap (`findAncestorIdsForItems`, `getTerminalStatusKeysByProjects`), so their
  // unbound answer is a full map of empty arrays, not an empty map.
  if (value instanceof Map) return [...value.values()].every(isEmptyish);
  if (typeof value === 'boolean') return value === false;
  // A record of counts is empty when every count is zero — `countByStatusCategory`
  // returns `{ todo, in_progress, done }` and its unbound answer is all zeros,
  // not an absent object. Same idea as the Map case above: the SHAPE is always
  // there, and the emptiness lives in the values.
  if (typeof value === 'object') return Object.values(value).every(isEmptyish);
  return false;
}

describe('workItemRepository — all 67 fallback arms have a caller', () => {
  it('every `tx ?? dbRead` read resolves unbound, and answers EMPTY under motir_app', async () => {
    const { fx, itemId } = await seedItem('FBW');
    const ws = fx.workspaceId;
    const pid = fx.projectId;
    const sort = { column: 'key', direction: 'asc' } as const;
    const win = {
      start: new Date(Date.now() - 24 * 60 * 60 * 1000),
      end: new Date(Date.now() + 24 * 60 * 60 * 1000),
    };
    const r = workItemRepository;

    // Every arm, called with the cheapest arguments that reach the query. Ids
    // that resolve where the answer is interesting; empty arrays where the read
    // short-circuits anyway (the arm is still entered).
    const arms: Array<readonly [string, Promise<unknown>]> = [
      ['findById', r.findById(itemId)],
      ['findProvenanceBackfillCandidates', r.findProvenanceBackfillCandidates(pid, ws)],
      ['findByIdentifier', r.findByIdentifier(pid, 'FBW-1')],
      ['findByIdentifiers', r.findByIdentifiers(pid, ['FBW-1'])],
      ['findByIds', r.findByIds([itemId])],
      ['findByIdsInWorkspace', r.findByIdsInWorkspace([itemId], ws)],
      ['findRoadmapBlockerStubs', r.findRoadmapBlockerStubs([itemId])],
      ['findBySessionBranch', r.findBySessionBranch('nope', ws)],
      ['findReadyLayer', r.findReadyLayer(pid, ws, null)],
      ['findExpandableStubs', r.findExpandableStubs(pid, ws)],
      ['findTriageQueue', r.findTriageQueue(pid, ws, { limit: 5 })],
      ['quickSearch', r.quickSearch(ws, [pid], 'sub', 5)],
      ['findSiblings', r.findSiblings(pid, null)],
      ['findByProjectFiltered', r.findByProjectFiltered(pid)],
      ['findByProjectAndKinds', r.findByProjectAndKinds(pid, ['task'], ws)],
      ['findByProjectKindAndTitle', r.findByProjectKindAndTitle(pid, 'task', 'Subject')],
      ['findByProject', r.findByProject(pid)],
      ['findAllByProjectForValidity', r.findAllByProjectForValidity(pid, ws)],
      ['findPublicHiddenDescendantIds', r.findPublicHiddenDescendantIds(pid, ws)],
      ['countByProjectAndStatusKey', r.countByProjectAndStatusKey(pid, 'todo')],
      ['findByProjectAndStatusKey', r.findByProjectAndStatusKey(pid, 'todo')],
      ['findChildren', r.findChildren(itemId)],
      ['findSubtree', r.findSubtree(itemId)],
      ['findBoundedSubtree', r.findBoundedSubtree(itemId, ws, 3)],
      ['findSubtreeMembersForValidity', r.findSubtreeMembersForValidity(itemId, ws)],
      ['findDescriptionsByIds', r.findDescriptionsByIds([itemId], ws)],
      ['countLiveDescendantsByKind', r.countLiveDescendantsByKind(itemId)],
      ['countRoadmapProgress', r.countRoadmapProgress([itemId], ['done'], 'cancelled')],
      ['findAncestors', r.findAncestors(itemId, ws)],
      ['findAncestorIdsForItems', r.findAncestorIdsForItems([itemId], ws)],
      ['findChildrenForItems', r.findChildrenForItems([itemId], ws)],
      ['findProjectForest', r.findProjectForest(pid, ws)],
      [
        'findProjectIssuesFlat',
        r.findProjectIssuesFlat(pid, ws, sort, {}, { limit: 5, offset: 0 }),
      ],
      ['findProjectIssuesKeyset', r.findProjectIssuesKeyset(pid, ws, {}, { limit: 5 })],
      ['countProjectIssues', r.countProjectIssues(pid, ws)],
      ['findArchivedByProject', r.findArchivedByProject(pid, ws, { limit: 5, offset: 0 })],
      ['countArchivedByProject', r.countArchivedByProject(pid, ws)],
      ['countByStatusCategory', r.countByStatusCategory(pid, ws)],
      [
        'aggregateChildrenStatus',
        r.aggregateChildrenStatus(itemId, { reviewStatusKey: null, implementedStatusKey: null }),
      ],
      ['countTriageItems', r.countTriageItems(pid, ws)],
      ['findColumnCards', r.findColumnCards(pid, ws, ['todo'], 'position', { limit: 5 })],
      ['findProjectTreeLevel', r.findProjectTreeLevel(pid, ws, null, sort, { take: 5, offset: 0 })],
      ['countProjectTreeLevel', r.countProjectTreeLevel(pid, ws, null)],
      [
        'findPublicProjectTreeLevel',
        r.findPublicProjectTreeLevel(pid, ws, null, { take: 5, offset: 0 }, []),
      ],
      ['countPublicProjectTreeLevel', r.countPublicProjectTreeLevel(pid, ws, null, [])],
      ['aggregateBoardLanesByAssignee', r.aggregateBoardLanesByAssignee(pid, ws, ['todo'])],
      ['aggregateBoardLanesByPriority', r.aggregateBoardLanesByPriority(pid, ws, ['todo'])],
      ['aggregateBoardLanesByEpic', r.aggregateBoardLanesByEpic(pid, ws, ['todo'])],
      [
        'matchesAutomationCondition',
        r.matchesAutomationCondition(itemId, {
          combinator: 'and',
          conditions: [{ field: 'kind', operator: 'is_any_of', value: ['task'] }],
        }),
      ],
      ['aggregateCreatedByBucket', r.aggregateCreatedByBucket(pid, ws, 'day', win)],
      [
        'aggregateDistribution',
        r.aggregateDistribution(pid, ws, { kind: 'column', column: 'kind' }),
      ],
      ['aggregateWorkloadByAssignee', r.aggregateWorkloadByAssignee(pid, ws)],
      ['aggregateWorkloadByPersonInWindow', r.aggregateWorkloadByPersonInWindow(pid, ws, win)],
      ['findEpicAncestors', r.findEpicAncestors([itemId], ws)],
      ['findBacklogRankByIds', r.findBacklogRankByIds([itemId], ws)],
      ['findBoundaryBacklogRank', r.findBoundaryBacklogRank(pid, ws, null, 'max')],
    ];

    const answers = await Promise.all(arms.map(([, p]) => p));
    for (const [i, [name]] of arms.entries()) {
      expect(isEmptyish(answers[i]), `${name} must answer EMPTY unbound under motir_app`).toBe(
        true,
      );
    }
  });
});

// ── The arms MOTIR-2881 stranded ─────────────────────────────────────────────
//
// The third sweep, and the same consequence. MOTIR-2881 routed the ASSERTION-side
// reads of twelve test files onto a client that can see the row — the owner for the
// files whose subject is the repository contract with RLS deliberately inert, a bound
// context for the rest — and in doing so removed the last unbound caller from eight
// more repositories, all of them gated at the ≥90% branch floor. Their production
// callers all thread a `tx` (MOTIR-2796 saw to that), so nothing else reaches the arm.
//
// The argument is unchanged from the two blocks above and is not repeated: the
// fallback is what a repository does when nobody bound a transaction, the answer in
// that state is EMPTY under `motir_app`, and that is the claim worth pinning.

describe('the fallback arms MOTIR-2881 left without a caller', () => {
  it('labelRepository + workItemLabelRepository — the picker, the ride-along, the name probe', async () => {
    const { fx, itemId } = await seedItem('FC1');
    const label = await adminDb.label.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        name: 'Perf-Q3',
        nameLower: 'perf-q3',
      },
    });
    await adminDb.workItemLabel.create({ data: { workItemId: itemId, labelId: label.id } });

    expectFallbackAnswer(await labelRepository.searchByPrefix(fx.projectId, 'perf'));
    expectFallbackAnswer(await labelRepository.listByWorkItem(itemId));
    expectFallbackAnswer(await workItemLabelRepository.listByWorkItem(itemId));

    const byName = await labelRepository.findByNameLower(fx.projectId, 'perf-q3');
    expect(byName).toBeNull();
  });

  it('componentRepository + workItemComponentRepository — the list, the join, the default assignee', async () => {
    const { fx, itemId } = await seedItem('FC2');
    const component = await adminDb.component.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        name: 'API',
        nameLower: 'api',
        defaultAssigneeId: fx.ownerId,
      },
    });
    await adminDb.workItemComponent.create({
      data: { workItemId: itemId, componentId: component.id },
    });

    expectFallbackAnswer(await componentRepository.listByProject(fx.projectId));
    expectFallbackAnswer(await componentRepository.listByWorkItem(itemId));
    expectFallbackAnswer(await workItemComponentRepository.listByWorkItem(itemId));
    expectFallbackCount(await workItemComponentRepository.countByComponent(component.id));

    const byId = await componentRepository.findById(component.id);
    expect(byId).toBeNull();

    const byName = await componentRepository.findByNameLower(fx.projectId, 'api');
    expect(byName).toBeNull();

    const defaulted = await componentRepository.findFirstDefaultAssignee([component.id]);
    expect(defaulted).toBeNull();
  });

  it('watcherRepository — the popover page, the count, and the membership probe', async () => {
    // `createWorkItem` auto-watches the creator, so the row is already there —
    // creating a second one trips the (work_item_id, user_id) unique.
    const { fx, itemId } = await seedItem('FC3');

    expectFallbackAnswer(await watcherRepository.listByWorkItem(itemId, { take: 5 }));
    expectFallbackCount(await watcherRepository.countByWorkItem(itemId));

    // `existsFor` is the boolean form of the same arm: FALSE unbound under the role
    // is the "no rows admitted" answer, not "this person is not watching".
    const watching = await watcherRepository.existsFor(itemId, fx.ownerId);
    expect(watching).toBe(false);
  });

  it('commentRepository + commentMentionRepository — the thread, its counts, the mentions', async () => {
    const { fx, itemId } = await seedItem('FC4');
    const root = await adminDb.comment.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: itemId,
        authorId: fx.ownerId,
        bodyMd: 'root',
      },
    });
    await adminDb.comment.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: itemId,
        authorId: fx.ownerId,
        parentCommentId: root.id,
        bodyMd: 'reply',
      },
    });
    await adminDb.commentMention.create({
      data: { commentId: root.id, mentionedUserId: fx.ownerId },
    });

    expectFallbackAnswer(await commentRepository.listThreadsByWorkItem(itemId));
    expectFallbackAnswer(await commentMentionRepository.findByCommentIds([root.id]));
    expectFallbackCount(await commentRepository.countByWorkItem(itemId));
    expectFallbackCount(await commentRepository.countRootsByWorkItem(itemId));
    expectFallbackCount(await commentRepository.countByParent(root.id));

    const one = await commentRepository.findById(root.id);
    expect(one).toBeNull();
  });

  it('notificationRepository — the drawer page, the badge count, the id lookup', async () => {
    const { fx, itemId } = await seedItem('FC5');
    const row = await adminDb.notification.create({
      data: {
        workspaceId: fx.workspaceId,
        recipientUserId: fx.ownerId,
        type: 'mentioned',
        category: 'direct',
        workItemId: itemId,
        actorId: fx.ownerId,
        data: {},
        dedupeKey: 'fallback-arm:1',
      },
    });

    expectFallbackAnswer(await notificationRepository.listByRecipient(fx.ownerId, { take: 5 }));
    expectFallbackCount(await notificationRepository.countUnreadByRecipient(fx.ownerId));

    const one = await notificationRepository.findById(row.id);
    expect(one).toBeNull();
  });

  it('customFieldValueRepository — the issue’s values and the two guard counts', async () => {
    const { fx, itemId } = await seedItem('FC6');
    const field = await adminDb.customFieldDefinition.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        key: 'severity',
        label: 'Severity',
        fieldType: 'select',
        position: 'a0',
      },
    });
    const option = await adminDb.customFieldOption.create({
      data: { fieldId: field.id, label: 'High', position: 'a0' },
    });
    await adminDb.customFieldValue.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: itemId,
        fieldId: field.id,
        valueOptionId: option.id,
      },
    });

    expectFallbackAnswer(await customFieldValueRepository.listByWorkItem(itemId, fx.workspaceId));
    expectFallbackCount(await customFieldValueRepository.countByField(field.id, fx.workspaceId));
    expectFallbackCount(await customFieldValueRepository.countByOption(option.id, fx.workspaceId));
  });
});
