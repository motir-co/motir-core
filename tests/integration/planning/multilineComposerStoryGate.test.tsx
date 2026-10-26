// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { cleanup, screen } from '@testing-library/react';
import { Textarea } from '@motir/design-system';
import type { ProjectContext } from '@/lib/projects';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';
import { db } from '@/lib/db';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import { renderWithIntl } from '../../helpers/renderWithIntl';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { workItemsService } from '@/lib/services/workItemsService';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// ═══════════════════════════════════════════════════════════════════════════
// THE STORY GATE — a multi-line message survives the whole trip
// (Story MOTIR-6156 · Subtask MOTIR-6239)
// ═══════════════════════════════════════════════════════════════════════════
//
// The two code cards each proved their own unit, and each MOCKED the other side
// of the seam: MOTIR-6237 measured the primitive against a stubbed layout,
// MOTIR-6238 drove the composer against a stubbed `onSubmit`. Both can be green
// while a list still arrives flattened, because nothing between them was run.
//
// This file stands at the JOIN, and it adds two things a coverage number cannot
// see:
//
//   1. THE LINE-BREAK SEAM, on all three of the composer's send doors — the
//      plan-change turn, the anchored first turn, and the revise instruction.
//      A body with newlines (a blank line among them) goes through the REAL
//      route → service → repository → Postgres → DTO chain, and the DTO that
//      comes back is fed to the SHIPPED rail, which must render it as the lines
//      that were typed. Only `trim()` may touch it, and a whitespace-only
//      multi-line body is refused on every door.
//   2. THE OPT-IN GUARD, from the other side. `autoGrow` is opt-in so eight
//      other product surfaces stay exactly as they were; nothing enforced that
//      from OUTSIDE the primitive. The guard walks the source tree and pins
//      every caller by name, so a tenth caller or a silent opt-in is red with
//      the file named.
//
// ⚠️ happy-dom + REAL POSTGRES in one file, deliberately — the seam ENDS at a
// screen, so splitting it would put the writer in one file and the reader in
// another and leave exactly the gap this card exists to close.
// `tests/integration/plans/planHistoryStoryGate.test.tsx` is the precedent.
//
// ⚠️ THE `Textarea.tsx` COVERAGE CRITERION IS NOT MEASURABLE HERE, and it is
// disposed of rather than faked. The primitive lives in `packages/design-system`,
// whose own vitest lane declares no coverage at all, and motir-core's tests
// import the BUILT package (`@motir/design-system` → `dist/`), so a
// `packages/design-system/src/**` entry in motir-core's coverage `include` would
// report a file no motir-core test imports — 0%, a permanently red gate. What
// the criterion was reaching for is that the primitive's behaviour is covered,
// and it is: MOTIR-6237 shipped 24 cases over the shipped artifact
// (`tests/components/textarea-autogrow.test.tsx`), and cases (5a)/(5b) below add
// the contract its callers depend on. Stated in the pull-request body too.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/auth/requireCompliantSession', () => ({
  requireCompliantSession: async () =>
    session.current
      ? { ok: true as const, session: session.current }
      : {
          ok: false as const,
          response: new Response(JSON.stringify({ code: 'UNAUTHENTICATED' }), { status: 401 }),
        },
}));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

// The ONE network boundary: the motir-ai client. Everything below it is real.
const submitJobMock = vi.fn(async () => ({ jobId: 'job-1' }));
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...(args as [])),
  streamJob: vi.fn(),
  getJob: vi.fn(),
  getConvention: vi.fn(),
  getCodeAudit: vi.fn(),
  refreshCodeAudit: vi.fn(),
  saveDesignChoice: vi.fn(),
  getPreplanState: vi.fn(),
  getOrgUsage: vi.fn(),
  getOrgSubscription: vi.fn(),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  setSeatQuantity: vi.fn(),
  parseSseFrame: vi.fn(),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// Imported AFTER the mocks are registered.
const { POST: startSession } = await import('@/app/api/ai/plan-change/session/route');
const { POST: appendTurn } = await import('@/app/api/ai/plan-change/session/turns/route');
const { POST: anchoredPlan } = await import('@/app/api/work-items/[id]/ai/plan/route');
const { POST: revise } = await import('@/app/api/ai/revise/route');
const { PlanChangeRail } = await import('@/components/planning/PlanChangeRail');

const BASE = 'http://localhost:3000';
const post = (path: string, body: unknown): Request =>
  new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/**
 * The message under test, and every part of it is load-bearing: two newlines in
 * a row (the BLANK line, which a naive normaliser eats first), leading and
 * trailing whitespace that `trim()` is allowed to take, and a line that is only
 * spaces in the middle, which it is NOT.
 */
const MULTILINE = '  first\nsecond\n\n   \nfifth  ';
const TRIMMED = 'first\nsecond\n\n   \nfifth';
/** Whitespace and newlines only — still an empty message, on every door. */
const BLANK_MULTILINE = '\n  \n\t\n';

let fx: WorkItemFixture;
/** The card the ANCHORED door plans from (case 3). */
let anchorId: string;

beforeEach(async () => {
  submitJobMock.mockClear();
  submitJobMock.mockResolvedValue({ jobId: 'job-1' });
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_change_turn", "plan_change_session", "plan_revision", "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  session.current = { user: { id: fx.ownerId, email: 'owner@example.com', name: 'Owner' } };
  activeCtx.current = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
  anchorId = (
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Billing' },
      fx.ctx,
    )
  ).id;
});

afterEach(cleanup);

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** The rail, handed a real session DTO and nothing else. */
function renderRailWith(dto: PlanChangeSessionDto) {
  const state: PlanChangeConversationState = {
    phase: 'idle',
    session: dto,
    progress: null,
    review: null,
    liveReview: null,
    liveVersion: 0,
    liveFailing: false,
    discardedReview: null,
    decided: null,
    jobId: null,
    planId: null,
    approved: null,
    errorCode: null,
    outOfCredits: false,
    stopping: false,
    stopped: false,
    queued: [],
    earlier: null,
    reopened: null,
    readOnly: false,
    acts: [],
  };
  return renderWithIntl(
    <PlanChangeRail
      launch={parsePlanningLaunch({ mode: 'replan', from: 'project' })}
      projectName="PayFlow"
      state={state}
      index={indexPlanReview(null)}
      targets={[]}
      onSend={vi.fn()}
      onRetry={vi.fn()}
      onCorrectTurn={vi.fn()}
      onApprove={vi.fn()}
      onDiscard={vi.fn()}
      onAddTarget={vi.fn()}
      onRemoveTarget={vi.fn()}
    />,
  );
}

/**
 * The LAST user bubble in the transcript, found by its own fill.
 *
 * By fill rather than by text because `getByText` normalises whitespace on both
 * sides of the match, which is exactly the collapse under test; and the LAST one
 * because the turn that opened the session is a user bubble too.
 */
function lastUserBubble(): HTMLElement {
  const all = document.querySelectorAll('[class*="el-chat-bubble-user"]');
  expect(all.length, 'the transcript rendered no user bubble').toBeGreaterThan(0);
  return all[all.length - 1] as HTMLElement;
}

describe('(2) the plan-change door — composer → store → DTO → rendered bubble', () => {
  it('keeps every newline, including the blank line, all the way to the transcript', async () => {
    const started = await startSession(post('/api/ai/plan-change/session', { body: 'Opening' }));
    expect(started.status).toBe(200);
    const sessionId = ((await started.json()) as { id: string }).id;

    const res = await appendTurn(
      post('/api/ai/plan-change/session/turns', { sessionId, body: MULTILINE }),
    );
    expect(res.status).toBe(200);
    const dto = (await res.json()) as PlanChangeSessionDto;

    // (a) THE ROW. Only the outer whitespace was taken.
    const stored = await adminDb.planChangeTurn.findFirstOrThrow({
      where: { sessionId, seq: 1 },
    });
    expect(stored.body).toBe(TRIMMED);

    // (b) THE DTO the route answers with carries the same bytes.
    expect(dto.turns[1]!.body).toBe(TRIMMED);

    // (c) THE SCREEN. This is the half both unit suites mock.
    renderRailWith(dto);
    const bubble = lastUserBubble();
    expect(bubble.textContent).toContain(TRIMMED);
    // Five lines typed ⇒ five lines rendered, and `pre-wrap` is what renders
    // them. Counted on the STORED text, so the count cannot drift from the row.
    expect(TRIMMED.split('\n')).toHaveLength(5);
    expect(bubble.className).toContain('whitespace-pre-wrap');
  });

  it('refuses a whitespace-and-newlines body with 400, exactly as a blank line is refused', async () => {
    const started = await startSession(post('/api/ai/plan-change/session', { body: 'Opening' }));
    const sessionId = ((await started.json()) as { id: string }).id;

    const res = await appendTurn(
      post('/api/ai/plan-change/session/turns', { sessionId, body: BLANK_MULTILINE }),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('PLAN_CHANGE_EMPTY_TURN');
    // …and it wrote nothing: a refused turn is not a stored turn.
    expect(await adminDb.planChangeTurn.count({ where: { sessionId, seq: 1 } })).toBe(0);
  });
});

describe('(3) the anchored door — a first turn started from a work item', () => {
  it('lands the line breaks in the session’s first turn AND in the motir-ai payload', async () => {
    const res = await anchoredPlan(
      post(`/api/work-items/${anchorId}/ai/plan`, { prompt: MULTILINE }),
      { params: Promise.resolve({ id: anchorId }) },
    );
    expect(res.status).toBe(200);

    const turn = await adminDb.planChangeTurn.findFirstOrThrow({
      where: { seq: 0 },
      orderBy: { createdAt: 'desc' },
    });
    expect(turn.body).toBe(TRIMMED);

    // Asserted AT the mock rather than past it: the planner is handed the same
    // bytes the transcript shows, which is the whole point of the door.
    expect(submitJobMock).toHaveBeenCalled();
    // The client is mocked through a rest-args forwarder, so its recorded call
    // is `unknown[]` rather than the real signature's tuple.
    const args = submitJobMock.mock.calls[0] as unknown as unknown[];
    const context = args[2] as { prompt?: string };
    expect(context.prompt).toContain(TRIMMED);
  });

  it('refuses a whitespace-and-newlines prompt with 400', async () => {
    const res = await anchoredPlan(
      post(`/api/work-items/${anchorId}/ai/plan`, { prompt: BLANK_MULTILINE }),
      { params: Promise.resolve({ id: anchorId }) },
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('BAD_REQUEST');
    expect(submitJobMock).not.toHaveBeenCalled();
  });
});

describe('(4) the revise door — the instruction reaches the revision job', () => {
  it('refuses a whitespace-and-newlines instruction with 400, before the plan is even read', async () => {
    const res = await revise(post('/api/ai/revise', { planId: 'p_1', prompt: BLANK_MULTILINE }));

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/prompt/);
    expect(submitJobMock).not.toHaveBeenCalled();
  });
});

// ── (5) the OPT-IN guard ────────────────────────────────────────────────────

describe('(5a) the primitive’s DEFAULT is a contract', () => {
  it('a bare <Textarea> is a fixed field with the manual resize handle and no measurement', () => {
    renderWithIntl(<Textarea label="Description" />);
    const el = screen.getByLabelText('Description') as HTMLTextAreaElement;

    expect(Number(el.rows)).toBe(3);
    expect(el.className).toContain('resize-y');
    expect(el.className).not.toContain('resize-none');
    // The whole promise of an OPT-IN: nothing measured, nothing written.
    expect(el.style.height).toBe('');
    expect(el.style.overflowY).toBe('');
  });
});

describe('(5b) every `Textarea` caller in the tree is pinned by name', () => {
  // Walked with `fs` at test time rather than with `git`, which a CI container
  // may not carry — and read from the SOURCE, so a caller is caught before it
  // ships rather than after a screenshot.
  const ROOT = join(import.meta.dirname, '..', '..', '..');

  /** Every `.tsx` under the given roots, relative to the repository root. */
  function sources(...roots: string[]): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
          walk(full);
        } else if (entry.name.endsWith('.tsx')) {
          out.push(relative(ROOT, full));
        }
      }
    };
    for (const root of roots) walk(join(ROOT, root));
    return out.sort();
  }

  /**
   * The callers that must stay FIXED. Each renders `<Textarea>` and passes no
   * `autoGrow`, so each is a field whose height a user still drags.
   */
  const FIXED = [
    // The capacity edit dialog's tier note (MOTIR-9614): a fixed editor, per
    // design platform-admin § Provider capacity.
    'app/(admin)/admin/capacity/_components/EditCapacityLimitsDialog.tsx',
    // The console Ideas edit form and its retire / delete reason fields
    // (MOTIR-7681): fixed editors, per design platform-admin § Ideas.
    'app/(admin)/admin/ideas/[slug]/_components/DeleteIdeaDialog.tsx',
    'app/(admin)/admin/ideas/[slug]/_components/IdeaEditForm.tsx',
    'app/(admin)/admin/ideas/[slug]/_components/RetireIdeaDialog.tsx',
    // The platform lessons console's why / how-to-apply editors (MOTIR-1411).
    'app/(admin)/admin/planning-lessons/_components/LessonCurate.tsx',
    // The ops reason field (MOTIR-752): a fixed three-row editor.
    'app/(admin)/admin/tenants/[orgId]/_components/ops/ReasonConfirmDialog.tsx',
    'app/(authed)/_components/ReportWidgetModal.tsx',
    'app/(authed)/backlog/_components/StartSprintDialog.tsx',
    // The convention editor (MOTIR-9082): a fixed 14-row Markdown editor, per its design.
    'app/(authed)/code/_components/ConventionPanel.tsx',
    'app/(authed)/filters/_components/EditFilterDialog.tsx',
    'app/(authed)/items/_components/SaveFilterDialog.tsx',
    'app/(authed)/triage/_components/TriageDetail.tsx',
    'components/approvals/ApprovalGateControl.tsx',
    // The obsolescence note (MOTIR-6674): a fixed three-row editor, per its design.
    'components/issues/ObsolescenceField.tsx',
    'components/planning/PlanDeclineConfirm.tsx',
  ];

  /**
   * The callers that DO opt in, and the only ones allowed to. `app/tokens` is
   * the specimen MOTIR-6237 added so the variant is visible at all; the planning
   * composer is MOTIR-6238, the surface the opt-in was built for.
   */
  const OPTED_IN = ['app/tokens/page.tsx', 'components/planning/PlanChangeComposer.tsx'];

  const callers = () =>
    sources('app', 'components').filter((p) =>
      readFileSync(join(ROOT, p), 'utf8').includes('<Textarea'),
    );

  it('names every caller — a tenth one is red, with its path', () => {
    expect(callers()).toEqual([...FIXED, ...OPTED_IN].sort());
  });

  it('no FIXED caller passes `autoGrow` — a silent opt-in is red, with its path', () => {
    const slipped = FIXED.filter((p) => readFileSync(join(ROOT, p), 'utf8').includes('autoGrow'));
    expect(slipped, `these fixed callers now opt into auto-grow: ${slipped.join(', ')}`).toEqual(
      [],
    );
  });

  it('every OPTED_IN caller really does opt in — the list cannot rot into a comment', () => {
    // The mirror assertion, so a caller that stops using `autoGrow` (or is
    // deleted) has to be taken off the list rather than left standing as a claim
    // nothing checks.
    for (const p of OPTED_IN) {
      expect(readFileSync(join(ROOT, p), 'utf8'), p).toContain('autoGrow');
    }
  });
});
