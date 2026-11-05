// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { db } from '@/lib/db';
import { adminDb } from '../../helpers/adminDb';
import { resolvableGateSubject } from '../../helpers/resolvableGateSubject';
import { truncateAuthTables } from '../../helpers/db';
import { renderWithIntl } from '../../helpers/renderWithIntl';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { UNREGISTERED_GATE_KINDS } from '@/lib/approvalGates/registry';
import { ApprovalGateKind } from '@/generated/prisma/client';
import type { HomeActorContext } from '@/lib/services/homeService';
import type {
  ApprovalGateDTO,
  ApprovalQueueRowDto,
  ApprovalRecordDecidedRowDto,
} from '@/lib/dto/approvalGate';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// THE STORY GATE for Story MOTIR-5996 (Subtask MOTIR-6002): TO APPROVE SAYS WHAT IS
// WAITING IN PLAIN WORDS. The four subtasks each test their own piece against inputs
// they built for themselves; this file tests what only the ASSEMBLED story can get
// wrong — the SEAMS between the read, the DTO and the one row, and TOTALITY over the
// gate-kind enum — against the real Postgres and the real components.
//
//   · the unpaged read, over a population the reader cannot fully see;
//   · the REAL read's output, rendered through the REAL row, for every kind;
//   · every kind the enum holds has a sentence, in both locales;
//   · no row, in any state, in either locale, speaks a git host's vocabulary;
//   · the overlay's own labels (`workbench.approvals.kind.*`) still resolve;
//   · the list's two doors and the overlay's third never write each other's address.
//
// ⚠️ NO ASSERTION HERE MAY PASS VACUOUSLY — every "must not appear" is paired with a
// positive control over the same fixture, as `story-seams.test.ts` holds its own.

const { shallowPush, nav } = vi.hoisted(() => ({
  shallowPush: vi.fn(),
  nav: { params: new URLSearchParams('tab=approvals') },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/workbench',
  useSearchParams: () => nav.params,
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));

const { approvalGatesService, APPROVAL_QUEUE_CEILING } =
  await import('@/lib/services/approvalGatesService');
const { ApprovalRow } = await import('@/components/approvals/ApprovalRow');
const { announceGateDecided } = await import('@/lib/approvals/decidedGates');

/** The kinds the enum holds — the source of truth a new member is added to. */
const ALL_KINDS = Object.values(ApprovalGateKind);
/** The kinds whose gate hangs off a CARD — every one but `plan_approval`, which the CHECK
 *  `approval_gate_work_item_iff_not_plan` keeps card-less (Story MOTIR-6012 · MOTIR-6034).
 *  Its row is covered by `tests/approvalGates/cardlessGateReads.test.ts`. */
const CARD_KINDS = ALL_KINDS.filter(
  // …and `planning_session`, the second card-less kind (MOTIR-7913), whose row is covered by
  // `tests/integration/approvals/planningSessionGate.test.ts`.
  (kind) => kind !== 'plan_approval' && kind !== 'planning_session',
);
/** The card kinds that NEVER reach a person's To approve read. `agent_review` (Story
 *  MOTIR-1626; ADR `approval-gates.md` §12.1) asks the review AGENT, not the person it is
 *  routed to: `awaitingRoutedToWhere` excludes the kind, and the person meets it on the
 *  card only. So it owes no To-approve sentence — and SEAM 1 proves it stays off the read. */
const OFF_THE_TO_APPROVE_READ: readonly ApprovalGateKind[] = ['agent_review'];
/** The card kinds the To-approve read returns — the population SEAMS 1–3 are total over. */
const QUEUED_KINDS = CARD_KINDS.filter((kind) => !OFF_THE_TO_APPROVE_READ.includes(kind));
/** The kinds this build RENDERS with ONE `workbench.approvals.sentence.*` key — every
 *  one owes its own sentence. `plan_approval` (registered by MOTIR-6035) is not among
 *  them: its leading line has FOUR forms (design `design/ai-planning/design-notes.md`
 *  §22.3), so its row takes its own branch reading `approvalGate.planApproval.row.*`
 *  (MOTIR-6037) — asserted by its own case in SEAM 3 below. */
const REGISTERED_KINDS = QUEUED_KINDS.filter(
  (kind) => !(UNREGISTERED_GATE_KINDS as readonly string[]).includes(kind),
);

/** A git host's vocabulary, in both locales — never on a row's visible text. */
const HOST_VOCABULARY = /pull request|\bPR\b|merge request|#\d+|拉取请求|合并请求/i;

let fx: WorkItemFixture;
let meCtx: HomeActorContext;
let storyId: string;

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "approval_gate", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  meCtx = { ...fx.ctx, projectId: fx.projectId };
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Plain words' },
    fx.ctx,
  );
  storyId = story.id;
  shallowPush.mockReset();
  nav.params = new URLSearchParams('tab=approvals');
});

afterEach(cleanup);

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** One card carrying one gate of one kind, routed EXACTLY by `assigneeId`. */
async function gate(opts: {
  title: string;
  kind: ApprovalGateKind;
  assigneeId: string;
  projectId?: string;
  parentId?: string;
  createdAt?: Date;
}) {
  const projectId = opts.projectId ?? fx.projectId;
  const item = await workItemsService.createWorkItem(
    { projectId, kind: 'subtask', parentId: opts.parentId ?? storyId, title: opts.title },
    fx.ctx,
  );
  await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId: opts.assigneeId } });
  // A subject that RESOLVES — the queue withdraws a gate whose subject is gone (MOTIR-7146).
  const subjectId = await resolvableGateSubject(
    { workspaceId: fx.workspaceId, projectId },
    item.id,
    opts.kind,
  );
  const row = await withWorkspaceContext(fx.ctx, (tx) =>
    approvalGateRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId,
        workItemId: item.id,
        kind: opts.kind,
        subjectId,
      },
      tx,
    ),
  );
  if (opts.createdAt) {
    await adminDb.approvalGate.update({
      where: { id: row.id },
      data: { createdAt: opts.createdAt },
    });
  }
  return { item, gate: row };
}

/** A row's sentence as the catalogue writes it, tags removed. */
function sentence(messages: typeof en, kind: string, title: string): string {
  const sentences = messages.workbench.approvals.sentence as Record<string, string>;
  return sentences[kind in sentences ? kind : 'other']!.replace(/<\/?title>/g, '').replace(
    '{name}',
    title,
  );
}

/** The row door's accessible name — it reads the whole sentence. */
function doorName(): string {
  return screen.getAllByRole('link')[0]!.getAttribute('aria-label') ?? '';
}

// ─── 1 · THE UNPAGED READ, real Postgres ─────────────────────────────────────

describe('SEAM 1 · the To-approve read is the WHOLE set, under a ceiling it SAYS', () => {
  it('thirty gates across every kind → thirty items, one call, and the count agrees', async () => {
    for (let i = 0; i < 30; i += 1) {
      await gate({
        title: `Waiting ${i}`,
        kind: QUEUED_KINDS[i % QUEUED_KINDS.length]!,
        assigneeId: fx.ownerId,
        createdAt: new Date(Date.UTC(2026, 8, 1, 0, i)),
      });
    }

    const queue = await approvalGatesService.listAwaitingMe(meCtx);

    expect(queue.items).toHaveLength(30);
    expect(queue).toMatchObject({ total: 30, truncated: false });
    expect(await approvalGatesService.countAwaitingMe(meCtx)).toBe(30);
    // Every kind is in the set — the population the seam below renders.
    expect(new Set(queue.items.map((row) => row.kind))).toEqual(new Set(QUEUED_KINDS));
  });

  it.each(OFF_THE_TO_APPROVE_READ)(
    'an awaiting `%s` gate routed to the reader is NOT on the read (§12.1)',
    async (kind) => {
      // POSITIVE CONTROL — a queued kind routed the same way IS on the read.
      const control = await gate({
        title: 'Queued',
        kind: 'design_result',
        assigneeId: fx.ownerId,
      });
      await gate({ title: `Off the read — ${kind}`, kind, assigneeId: fx.ownerId });

      const queue = await approvalGatesService.listAwaitingMe(meCtx);

      expect(queue.items.map((row) => row.gateId)).toEqual([control.gate.id]);
      expect(queue).toMatchObject({ total: 1, truncated: false });
      expect(await approvalGatesService.countAwaitingMe(meCtx)).toBe(1);
    },
  );

  it('one more than the ceiling → exactly the ceiling, `truncated`, and the whole total', async () => {
    expect(APPROVAL_QUEUE_CEILING).toBe(500);
    for (let i = 0; i < 6; i += 1) {
      await gate({ title: `Waiting ${i}`, kind: 'design_result', assigneeId: fx.ownerId });
    }

    const cut = await approvalGatesService.listAwaitingMe(meCtx, { ceiling: 5 });

    expect(cut.items).toHaveLength(5);
    expect(cut).toMatchObject({ total: 6, truncated: true });
  });

  it('a gate routed to someone else and a gate in a project the reader may not browse never appear', async () => {
    const other = await createTestUser({ email: 'other-plain@ex.com', name: 'Other' });
    await workspacesService.addMember({ userId: other.id, workspaceId: fx.workspaceId });
    const hidden = await projectsService.createProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Hidden',
    });
    const hiddenStory = await workItemsService.createWorkItem(
      { projectId: hidden.id, kind: 'story', title: 'Hidden story' },
      fx.ctx,
    );
    const reader = await createTestUser({ email: 'reader-plain@ex.com', name: 'Reader' });
    await workspacesService.addMember({ userId: reader.id, workspaceId: fx.workspaceId });

    // POSITIVE CONTROL — the reader's own gate in the project they browse.
    const mine = await gate({ title: 'Mine', kind: 'design_result', assigneeId: reader.id });
    // MIS-ROUTED — the same project, somebody else's question.
    await gate({ title: 'Theirs', kind: 'design_result', assigneeId: other.id });
    // NOT BROWSABLE — routed to the reader, in a project they may not open.
    await gate({
      title: 'Hidden',
      kind: 'design_result',
      assigneeId: reader.id,
      projectId: hidden.id,
      parentId: hiddenStory.id,
    });
    await projectMembersService.setAccessMode({
      key: hidden.identifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      mode: 'members',
    });
    await adminDb.projectMembership.deleteMany({
      where: { userId: reader.id, projectId: hidden.id },
    });

    const readerCtx: HomeActorContext = {
      userId: reader.id,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    };
    const queue = await approvalGatesService.listAwaitingMe(readerCtx);

    expect(queue.items.map((row) => row.gateId)).toEqual([mine.gate.id]);
    expect(queue).toMatchObject({ total: 1, truncated: false });
    expect(
      await approvalGatesService.listAwaitingMe({ ...readerCtx, projectId: hidden.id }),
    ).toEqual({ items: [], total: 0, truncated: false, reviewsToRun: [] });
  });
});

// ─── 2 · THE READ → ROW SEAM ─────────────────────────────────────────────────

describe('SEAM 2 · the REAL read, rendered through the REAL row, reads the sentence', () => {
  it.each(['en', 'zh'] as const)(
    'every kind the read returns reads its sentence with that work item’s title — %s',
    async (locale) => {
      const messages = locale === 'en' ? en : zh;
      for (const kind of QUEUED_KINDS) {
        await gate({ title: `Card for ${kind}`, kind, assigneeId: fx.ownerId });
      }
      const queue = await approvalGatesService.listAwaitingMe(meCtx);
      expect(queue.items).toHaveLength(QUEUED_KINDS.length);

      for (const row of queue.items) {
        const view = renderWithIntl(<ApprovalRow record={{ section: 'awaiting', row }} />, {
          locale,
          messages,
        });
        expect(doorName()).toContain(
          sentence(messages as typeof en, row.kind, row.workItem!.title),
        );
        expect(screen.getByText(row.workItem!.title)).toBeTruthy();
        expect(view.container.textContent).not.toMatch(HOST_VOCABULARY);
        view.unmount();
      }
    },
  );
});

// ─── 3 · TOTALITY over the kind enum ─────────────────────────────────────────

describe('SEAM 3 · every gate kind has a sentence, in both locales', () => {
  it('the enum is the source of truth, and it is non-empty', () => {
    expect(ALL_KINDS.length).toBeGreaterThan(5);
    expect(REGISTERED_KINDS.length).toBeGreaterThan(0);
  });

  it.each(REGISTERED_KINDS)(
    'the registered kind `%s` has its OWN sentence in en and zh',
    (kind) => {
      const enSentence = (en.workbench.approvals.sentence as Record<string, string>)[kind];
      const zhSentence = (zh.workbench.approvals.sentence as Record<string, string>)[kind];
      expect(enSentence, `en has no sentence for ${kind}`).toMatch(/<title>\{name\}<\/title>/);
      expect(zhSentence, `zh has no sentence for ${kind}`).toMatch(/<title>\{name\}<\/title>/);
    },
  );

  it('`plan_approval` has its OWN leading-line forms in en and zh (MOTIR-6037, §22.3)', () => {
    for (const messages of [en, zh]) {
      const row = messages.approvalGate.planApproval.row;
      expect(row.targeted).toMatch(/<title>\{name\}<\/title>/);
      expect(row.untargeted).toMatch(/<title>\{name\}<\/title>/);
      expect(row.untitled).toMatch(/<title>\{project\}<\/title>/);
      expect(row.reviewRow).toContain('{sentence}');
    }
  });

  it('an unregistered kind falls to the NEUTRAL sentence, which exists in both locales', () => {
    expect(en.workbench.approvals.sentence.other).toMatch(/<title>\{name\}<\/title>/);
    expect(zh.workbench.approvals.sentence.other).toMatch(/<title>\{name\}<\/title>/);
  });
});

// ─── 4 · THE HOST-VOCABULARY GUARD — every kind × state × locale ─────────────

function queueRow(
  kind: ApprovalGateKind,
  over: Partial<ApprovalQueueRowDto> = {},
): ApprovalQueueRowDto {
  // A PLAN row is CARD-LESS (MOTIR-6037): what it names is its target, from its subject.
  if (kind === 'plan_approval') {
    return {
      gateId: `gate-${kind}`,
      kind,
      state: 'awaiting',
      canDecide: true,
      routedToName: 'Yue',
      waitingSince: new Date(Date.now() - 3_600_000).toISOString(),
      workItem: null,
      subject: {
        kind: 'plan_approval',
        planId: 'plan-1',
        sessionId: 'session-1',
        sessionHasTurns: true,
        title: 'Split invoicing',
        projectName: 'Acme',
        targets: [{ key: 'ACME-1', title: 'Billing export runs nightly' }],
        proposalCount: 3,
        author: { source: 'native', harness: null, origin: 'user' },
        held: null,
      },
      ...over,
    } as ApprovalQueueRowDto;
  }
  return {
    gateId: `gate-${kind}`,
    kind,
    state: 'awaiting',
    canDecide: true,
    routedToName: 'Yue',
    waitingSince: new Date(Date.now() - 3_600_000).toISOString(),
    workItem: {
      id: `wi-${kind}`,
      key: 1,
      identifier: 'ACME-1',
      title: 'Billing export runs nightly',
      kind: 'story',
      type: null,
    },
    // A subject that reads as NUMBERS is the one that could leak them: the
    // approve-to-merge set is the carrier, so every kind is tried with it.
    subject:
      kind === 'pull_request_approval'
        ? {
            kind: 'pull_request_approval',
            members: [{ repo: 'moooon/motir-core', number: 412, headSha: 'a', state: 'open' }],
          }
        : null,
    ...over,
  } as ApprovalQueueRowDto;
}

function decidedGate(id: string, kind: ApprovalGateKind): ApprovalGateDTO {
  return {
    id,
    workItemId: 'wi',
    kind,
    subjectId: 's',
    state: 'approved',
    decidedById: null,
    decidedAt: null,
    noteMd: null,
    supersededCause: null,
    subjectVersion: null,
    decidedByLabel: null,
    routedToId: null,
    decidedUnderAuthority: null,
    decisionSource: null,
    outcomeRef: null,
    confirmedRecord: null,
    replanOwed: null,
    chosenOption: null,
    createdAt: '2026-09-08T04:00:00.000Z',
    updatedAt: '2026-09-08T04:00:00.000Z',
  } as ApprovalGateDTO;
}

type State =
  | 'awaiting'
  | 'see-but-not-decide'
  | 'settled'
  | 'held'
  | 'arrived'
  | 'decided'
  | 'not-renderable'
  | 'gone';
const STATES: State[] = [
  'awaiting',
  'see-but-not-decide',
  'settled',
  'held',
  'arrived',
  'decided',
  'not-renderable',
  'gone',
];

function renderState(kind: ApprovalGateKind, state: State, locale: 'en' | 'zh') {
  const messages = locale === 'en' ? en : zh;
  const id = `gate-${kind}-${state}-${locale}`;
  const base = queueRow(kind, { gateId: id });
  switch (state) {
    case 'see-but-not-decide':
      return renderWithIntl(
        <ApprovalRow record={{ section: 'awaiting', row: { ...base, canDecide: false } }} />,
        { locale, messages },
      );
    case 'settled':
      act(() => announceGateDecided({ gate: decidedGate(id, kind), filesKept: null }));
      return renderWithIntl(<ApprovalRow record={{ section: 'awaiting', row: base }} />, {
        locale,
        messages,
      });
    case 'held':
      return renderWithIntl(<ApprovalRow record={{ section: 'held', row: base }} />, {
        locale,
        messages,
      });
    case 'arrived':
      return renderWithIntl(<ApprovalRow record={{ section: 'awaiting', row: base }} arrived />, {
        locale,
        messages,
      });
    case 'decided':
      return renderWithIntl(
        <ApprovalRow
          record={{
            section: 'decided',
            row: {
              ...base,
              state: 'approved',
              decidedAt: new Date().toISOString(),
              decidedByLabel: 'Yue',
              decisionSource: 'ui',
              subjectVersion: 'moooon/motir-core#412@abc',
              chosenOption: null,
              confirmedRecord: null,
            } as unknown as ApprovalRecordDecidedRowDto,
          }}
          person={{ label: 'Decided by', value: 'Yue' }}
        />,
        { locale, messages },
      );
    case 'not-renderable':
      return renderWithIntl(
        <ApprovalRow
          record={{
            section: 'awaiting',
            row: { ...base, kind: 'pull_request_merge', subject: { kind: 'pull_request_merge' } },
          }}
        />,
        { locale, messages },
      );
    case 'gone':
      return renderWithIntl(
        <ApprovalRow record={{ section: 'awaiting', row: { ...base, subject: null } }} />,
        { locale, messages },
      );
    default:
      return renderWithIntl(<ApprovalRow record={{ section: 'awaiting', row: base }} />, {
        locale,
        messages,
      });
  }
}

describe('SEAM 4 · no row, in any state, in either locale, speaks a git host’s vocabulary', () => {
  // A PLAN row has no `not-renderable` or `gone` face: it is card-less, so a row whose
  // subject is gone (or of another kind) has nothing to name and renders nothing.
  const cases = (['en', 'zh'] as const).flatMap((locale) =>
    ALL_KINDS.flatMap((kind) =>
      STATES.filter(
        (state) => kind !== 'plan_approval' || (state !== 'not-renderable' && state !== 'gone'),
      ).map((state) => [locale, kind, state] as const),
    ),
  );

  it.each(cases)('%s · %s · %s', (locale, kind, state) => {
    const view = renderState(kind, state, locale);
    // POSITIVE CONTROL — the row rendered, and it names its work item.
    expect(view.container.textContent).toContain('Billing export runs nightly');
    expect(view.container.textContent).not.toMatch(HOST_VOCABULARY);
  });

  it('the guard can FAIL — the approve-to-merge numbers are in the title, and the title only', () => {
    const view = renderState('pull_request_approval', 'awaiting', 'en');
    const set = screen.getByText('In motir-core');
    expect(set.getAttribute('title')).toBe('moooon/motir-core · #412');
    expect(set.getAttribute('title')).toMatch(HOST_VOCABULARY);
    expect(view.container.textContent).not.toMatch(HOST_VOCABULARY);
  });
});

// ─── 5 · THE OVERLAY'S OWN LABELS ────────────────────────────────────────────

describe('SEAM 5 · the overlay’s labels are untouched — every kind still names itself', () => {
  it.each(ALL_KINDS)('`workbench.approvals.kind.%s` resolves in en and zh', (kind) => {
    const enKind = (en.workbench.approvals.kind as Record<string, string>)[kind];
    const zhKind = (zh.workbench.approvals.kind as Record<string, string>)[kind];
    expect(enKind).toBeTruthy();
    expect(zhKind).toBeTruthy();
  });
});

// ─── 6 · THE TWO DOORS DO NOT COLLIDE ────────────────────────────────────────

describe('SEAM 6 · the row’s two doors write only their own address', () => {
  it('on one render: the title writes only `peek`, the row only `approval`', () => {
    renderWithIntl(
      <ApprovalRow record={{ section: 'awaiting', row: queueRow('design_result') }} />,
    );

    fireEvent.click(screen.getByRole('link', { name: 'Billing export runs nightly' }), {
      button: 0,
    });
    expect(shallowPush).toHaveBeenLastCalledWith('/workbench?tab=approvals&peek=ACME-1');
    expect(shallowPush.mock.calls[0]![0]).not.toContain('approval=');

    // The row door — the stretched link behind the cells, named for the sentence.
    expect(doorName()).toMatch(/^Review ACME-1 — /);
    fireEvent.click(screen.getAllByRole('link')[0]!, { button: 0 });
    const opened = shallowPush.mock.calls[1]![0] as string;
    expect(opened).toContain('approval=ACME-1');
    expect(opened).not.toContain('peek=');
  });
});
