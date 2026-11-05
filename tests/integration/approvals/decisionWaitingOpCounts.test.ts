import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';

// THE "NO PER-ROW LOOKUP" PROMISE, AS A FAILING TEST (Story MOTIR-4908 · MOTIR-5879
// case 4). The decision-waiting marker reads its state for a whole SET of rows in
// one batch; the way that promise breaks is a lookup that quietly becomes per row,
// on the densest screens in the product. So each surface is measured at N rows
// and at 3N rows — some carrying gates — and the number of model operations must
// be EQUAL. Counted, never timed.

const { session, activeCtx } = vi.hoisted(() => ({
  session: { current: null as unknown },
  activeCtx: { current: null as unknown },
}));
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));
vi.mock('next-intl/server', () => ({
  getLocale: async () => 'en',
  getTranslations: async () => (key: string) => key,
}));

import { db } from '@/lib/db';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { boardsService } from '@/lib/services/boardsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { EMPTY_FILTER } from '@/lib/issues/issueListFilter';
import { DEFAULT_SORT } from '@/lib/issues/issueListView';
import { listChildIssuesAction } from '@/app/(authed)/items/actions';
import { IssueTreeSection } from '@/app/(authed)/items/_components/IssueTreeSection';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  session.current = { user: { id: fx.ownerId } };
  activeCtx.current = { projectId: fx.projectId, userId: fx.ownerId, workspaceId: fx.workspaceId };
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Every MODEL operation made inside `db.$transaction` while `run` executes (the
 *  `pendingPlanIndicator.test.ts` recorder). */
async function recordModelOps<T>(run: () => Promise<T>): Promise<{ result: T; ops: string[] }> {
  const ops: string[] = [];
  const passthrough = db.$transaction.bind(db) as (
    arg: unknown,
    options?: unknown,
  ) => Promise<unknown>;
  const record = (tx: Prisma.TransactionClient): Prisma.TransactionClient =>
    new Proxy(tx as object, {
      get(client, key) {
        const value = Reflect.get(client, key) as unknown;
        if (typeof key !== 'string' || key.startsWith('$') || typeof value !== 'object' || !value) {
          return value;
        }
        return new Proxy(value, {
          get(delegate, method) {
            const fn = Reflect.get(delegate, method) as unknown;
            if (typeof method !== 'string' || typeof fn !== 'function') return fn;
            return (...args: unknown[]) => {
              ops.push(`${key}.${method}`);
              return (fn as (...a: unknown[]) => unknown).apply(delegate, args);
            };
          },
        });
      },
    }) as Prisma.TransactionClient;
  const spy = vi
    .spyOn(db, '$transaction')
    .mockImplementation(((arg: unknown, options?: unknown) =>
      typeof arg === 'function'
        ? passthrough(
            (tx: Prisma.TransactionClient) =>
              (arg as (t: Prisma.TransactionClient) => Promise<unknown>)(record(tx)),
            options,
          )
        : passthrough(arg, options)) as unknown as typeof db.$transaction);
  try {
    return { result: await run(), ops };
  } finally {
    spy.mockRestore();
  }
}

/** `count` more tasks (under `parentId` when given); every third carries a design gate. */
async function seed(count: number, parentId?: string) {
  for (let i = 0; i < count; i += 1) {
    const item = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: parentId ? 'subtask' : 'task',
        title: `Row ${i}`,
        ...(parentId ? { parentId } : {}),
      },
      fx.ctx,
    );
    if (i % 3 === 0) {
      await withWorkspaceContext(fx.ctx, (tx) =>
        approvalGateRepository.create(
          {
            workspaceId: fx.workspaceId,
            projectId: fx.projectId,
            workItemId: item.id,
            kind: 'design_result',
            subjectId: `subject-${item.id}`,
          },
          tx,
        ),
      );
    }
  }
}

const N = 6;

/**
 * The gate reads a page makes, each ONE batch: the decision marker's, then the review state
 * read model's two (its `agent_review` gates and the latest decided gates — Story
 * MOTIR-10327 · MOTIR-10341, which put the review markers and the Reviewed badge on the
 * board and the List / Tree).
 */
const GATE_BATCHES = ['approvalGate.findMany', 'approvalGate.findMany', 'approvalGate.findMany'];

/**
 * What the review state read model adds to a board read, all per CALL (MOTIR-10341): its
 * own access reads, the subtree and card reads, then one batch each of deliveries, gates,
 * records, dismissals and people. None grows with the rows (the tests below).
 */
const REVIEW_READS = [
  'project.findUnique',
  'workspaceMembership.findUnique',
  'workItem.findMany',
  'workflowStatus.findMany',
  'workItemDelivery.findMany',
  'approvalGate.findMany',
  'approvalGate.findMany',
  'reviewVerdictRecord.findMany',
  'reviewDismissal.findMany',
  'user.findMany',
];

async function listOps() {
  const workflow = await workflowsService.getWorkflow(fx.projectId, fx.workspaceId);
  return recordModelOps(() =>
    IssueTreeSection({
      projectId: fx.projectId,
      reader: { userId: fx.ownerId, workspaceId: fx.workspaceId },
      service: { userId: fx.ownerId, workspaceId: fx.workspaceId },
      view: 'list',
      sort: DEFAULT_SORT,
      filter: EMPTY_FILTER,
      ast: null,
      page: 1,
      workflow,
      members: [],
    }),
  );
}

describe('the operation count does not grow with rows', () => {
  it('the BOARD read — equal at N and 3N', async () => {
    await seed(N);
    const small = await recordModelOps(() => boardsService.getBoard(fx.projectId, fx.ctx));
    await seed(2 * N);
    const large = await recordModelOps(() => boardsService.getBoard(fx.projectId, fx.ctx));

    expect(large.result.columns.flatMap((c) => c.cards)).toHaveLength(3 * N);
    expect(large.ops.length).toBe(small.ops.length);
    expect(large.ops.filter((op) => op.startsWith('approvalGate.'))).toEqual(GATE_BATCHES);
  });

  it('the BOARD read against its PRE-STORY count — the marker adds a FIXED six reads and the review read ten, whatever the rows', async () => {
    // ⚠️ MEASURED, and it falsifies the story's "the board's query count is
    // literally unchanged". This fixture (N tasks, every third gated, no story in
    // review) was run against `origin/main` at `de31060f1`, before this story:
    // 17 model operations. The retired `findAwaitingIds` batch cancelled NOTHING
    // there, because it short-circuited without a query when no in-review story
    // was on the board. The marker's read adds six, and all six are per CALL:
    // the one gate batch, plus the access and permission reads
    // `pendingDecisionsFor` makes for itself (`browsableProjectIds` +
    // `getPermissions`). None of them grows with the rows (the test above).
    const PRE_STORY_BOARD_MODEL_OPS = 17; // de31060f1, this fixture
    const MARKER_READS = [
      'approvalGate.findMany',
      'project.findUnique',
      'project.findUnique',
      'projectMembership.findUnique',
      'workspaceMembership.findUnique',
      'workspaceMembership.findUnique',
    ];
    await seed(N);
    const { ops } = await recordModelOps(() => boardsService.getBoard(fx.projectId, fx.ctx));
    const modelOps = ops.filter((op) => !op.startsWith('_'));

    expect(modelOps.length).toBe(
      PRE_STORY_BOARD_MODEL_OPS + MARKER_READS.length + REVIEW_READS.length,
    );
    const added = [...MARKER_READS, ...REVIEW_READS];
    for (const op of new Set(added)) {
      const extra = added.filter((o) => o === op).length;
      expect(modelOps.filter((o) => o === op).length).toBeGreaterThanOrEqual(extra);
    }
  });

  it('the /items LIST read — equal at N and 3N', async () => {
    await seed(N);
    const small = await listOps();
    await seed(2 * N);
    const large = await listOps();

    expect(large.ops.length).toBe(small.ops.length);
    expect(large.ops.filter((op) => op.startsWith('approvalGate.'))).toEqual(GATE_BATCHES);
  });

  it('one LAZY level (a work item’s children) — equal at N and 3N', async () => {
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Parent' },
      fx.ctx,
    );
    await seed(N, story.id);
    const small = await recordModelOps(() =>
      listChildIssuesAction({ parentId: story.id, sortParam: 'key:asc' }),
    );
    await seed(2 * N, story.id);
    const large = await recordModelOps(() =>
      listChildIssuesAction({ parentId: story.id, sortParam: 'key:asc' }),
    );

    expect(large.result.ok && large.result.level.rows).toHaveLength(3 * N);
    expect(large.ops.length).toBe(small.ops.length);
  });
});
