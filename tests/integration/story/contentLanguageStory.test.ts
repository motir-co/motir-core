import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectContext } from '@/lib/projects';

// STORY MOTIR-7734 (Subtask MOTIR-8749) — the motir-core half of "the planner and
// agents write work content in the organisation's content language, while
// explanations and replies follow each person's own", proven TOGETHER in one
// organisation whose setting changes. Each card proved its own seam in its own
// file; this one asserts the cross-card facts:
//
//   · every writing job's tenant carries both languages, the person being the
//     one who started the work, and nobody for a scheduled or monitor job;
//   · a plan generated in `zh` and approved after the org became `ja` records
//     what the planner stated, and the setting only where it stated nothing;
//   · a saved draft records the draft's language on the explanation alone;
//   · the coding-agent prompt and `get_project_state` name the setting.
//
// Real Postgres throughout. Mocked: the motir-ai client (the boundary), the
// session and the active project (no cookies in a test), `next/cache`, and the
// monitor provider (the fake one, as every monitor suite does).

const { session, activeCtx, submitJobMock, getJobMock } = vi.hoisted(() => ({
  session: { current: null as unknown },
  activeCtx: { current: null as unknown },
  submitJobMock: vi.fn(),
  getJobMock: vi.fn(),
}));

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...args),
  getJob: (...args: unknown[]) => getJobMock(...args),
  streamJob: vi.fn(),
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
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/projects')>()),
  getActiveProject: async () => activeCtx.current,
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import type { WorkItemCreatedData } from '@/lib/jobs/types';
import { monitorBugEnrichOnCreated } from '@/lib/jobs/definitions/monitorBugEnrich';
import {
  fakeMonitorProvider,
  fakeMonitorState,
  resetFakeMonitorProvider,
} from '@/lib/monitors/providers/fake';
import { sentryMonitorProvider } from '@/lib/monitors/providers/sentry';
import { registerMonitorProvider } from '@/lib/monitors/registry';
import { runGetProjectState } from '@/lib/mcp/tools/getProjectState';
import { aiPlanEditsService } from '@/lib/services/aiPlanEditsService';
import { aiGenerationService } from '@/lib/services/aiGenerationService';
import { aiExplanationService } from '@/lib/services/aiExplanationService';
import { aiBugTelemetryService } from '@/lib/services/aiBugTelemetryService';
import { dispatchPromptService } from '@/lib/services/dispatchPromptService';
import { monitorConnectionService } from '@/lib/services/monitorConnectionService';
import { monitorIngestionService } from '@/lib/services/monitorIngestionService';
import { plansService } from '@/lib/services/plansService';
import { usersService } from '@/lib/services/usersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { POST as askPOST } from '@/app/api/ai/ask/route';
import { POST as proposalsPOST } from '@/app/api/internal/ai/plan-proposals/route';
import { PATCH as proposalPATCH } from '@/app/api/internal/ai/plan-proposals/[itemId]/route';
import { createIssueAction } from '@/app/(authed)/items/actions';
import { updateIssueAction } from '@/app/(authed)/items/[key]/edit/actions';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { captureJobEvents, JobTestEngine, type CapturedJobEvent } from '../../helpers/jobs';
import { addToProjectAs } from '../../helpers/workspaceRoleFixtures';

const SERVICE_SECRET = 'core-callback-secret-story';

let fx: WorkItemFixture;
/** A: started the plan, saved English. B: saved Korean. C: saved nothing. */
let userA: string;
let userB: string;
let userC: string;
let cap: { events: CapturedJobEvent[]; restore: () => void };
let seq = 0;

const pctxFor = (userId: string): ProjectContext => ({
  userId,
  workspaceId: fx.workspaceId,
  projectId: fx.projectId,
  project: fx.project,
});

function actAs(userId: string) {
  session.current = { user: { id: userId, email: `${userId}@example.com`, name: 'Someone' } };
  activeCtx.current = pctxFor(userId);
}

async function setOrgLanguage(contentLanguage: string) {
  await adminDb.organization.update({
    where: { id: fx.workspace.organizationId },
    data: { contentLanguage },
  });
}

async function setLocale(userId: string, locale: string | null) {
  await adminDb.user.update({ where: { id: userId }, data: { locale } });
}

/** A project member holding `ai:plan`, with this saved language. */
async function member(locale: string | null): Promise<string> {
  seq += 1;
  const u = await usersService.createUser({
    email: `story-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: `Member ${seq}`,
  });
  await adminDb.workspaceMembership.create({
    data: { userId: u.id, workspaceId: fx.workspaceId, workspaceRole: 'member' },
  });
  await addToProjectAs({
    key: fx.project.identifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: u.id,
    role: 'member',
  });
  await setLocale(u.id, locale);
  return u.id;
}

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await truncateAuthTables();
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.example');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  submitJobMock.mockReset();
  let n = 0;
  submitJobMock.mockImplementation(async (kind: unknown) => ({
    jobId: `job-${String(kind)}-${++n}`,
  }));
  getJobMock.mockReset();
  resetFakeMonitorProvider();
  fakeMonitorState().issues = [];
  registerMonitorProvider(fakeMonitorProvider, 'sentry');
  cap = captureJobEvents();

  fx = await makeWorkItemFixture();
  await setOrgLanguage('zh');
  userA = fx.ownerId;
  await setLocale(userA, 'en');
  userB = await member('ko');
  userC = await member(null);
  actAs(userA);
});

afterEach(() => {
  cap.restore();
  registerMonitorProvider(sentryMonitorProvider, 'sentry');
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ─── the submitted tenants ───────────────────────────────────────────────────

/** Both languages of every submit of `kind` since the last reset. */
function languagesSent(kind: string) {
  return submitJobMock.mock.calls
    .filter((c) => c[0] === kind)
    .map((c) => {
      const tenant = c[1] as Record<string, unknown>;
      return {
        contentLanguage: tenant['contentLanguage'],
        personLanguage: tenant['personLanguage'],
      };
    });
}

/** A `planned` plan started by `createdById`, for a revision or a resume. */
async function plannedPlanBy(createdById: string | null): Promise<string> {
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: 'Revisable', authorSource: 'native', authorHarness: 'Motir' },
    fx.ctx,
  );
  await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'The proposal', kind: 'story' } }],
    fx.ctx,
  );
  await plansService.markPlanned(plan.id, fx.ctx);
  await adminDb.plan.update({ where: { id: plan.id }, data: { createdById } });
  return plan.id;
}

const json = (path: string, body: unknown) =>
  new Request(`http://localhost:3000${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** Ask once: the one job a conversation turn opens is `ask_project` (MOTIR-9231). */
async function askOnce(text: string) {
  expect((await askPOST(json('/api/ai/ask', { body: text }))).status).toBe(200);
}

/** File one monitor issue through the real reconciler, then run the enrichment job. */
async function fileMonitorBug() {
  await monitorConnectionService.completeGrant(
    {
      provider: 'sentry',
      providerInstallationId: `pi-story-${seq}`,
      code: 'valid-code',
      projectId: fx.projectId,
    },
    fx.ctx,
  );
  const dto = await monitorConnectionService.bindProject(
    fx.projectId,
    { externalProjectId: 'fake-web', externalProjectSlug: 'web' },
    fx.ctx,
  );
  const issue = {
    externalId: 'story-issue',
    title: 'TypeError in export',
    culprit: 'lib/services/exportService.ts in toCsv',
    level: 'error',
    eventCount: 3,
    firstSeenAt: new Date('2026-10-01T08:00:00.000Z'),
    lastSeenAt: new Date('2026-10-02T08:00:00.000Z'),
    permalink: 'https://sentry.example/issues/story-issue/',
    assignee: null,
    environment: 'production',
    release: '1.0.0',
    frames: [],
  };
  fakeMonitorState().issues = [issue];
  const from = cap.events.length;
  await monitorIngestionService.reconcileIssue(
    {
      id: dto.id,
      projectId: fx.projectId,
      workspaceId: fx.workspaceId,
      boundByUserId: fx.ctx.userId,
      externalProjectSlug: 'web',
    },
    issue,
    {
      outcome: 'read',
      at: new Date(),
      context: {
        environment: 'production',
        release: '1.0.0',
        frames: [],
        exception: null,
        tags: [],
        request: null,
        eventId: null,
        eventAt: null,
      },
    },
  );
  const created = cap.events
    .slice(from)
    .filter((e) => e.name === 'work-item/created')
    .map((e) => e.data as WorkItemCreatedData);
  expect(created).toHaveLength(1);
  await new JobTestEngine({
    function: monitorBugEnrichOnCreated,
    events: [{ name: 'work-item/created', data: created[0]! }],
  }).execute();
}

describe('every writing job sends both languages', () => {
  const A_IN_ZH = { contentLanguage: 'zh', personLanguage: 'en' };
  const NOBODY_IN_ZH = { contentLanguage: 'zh', personLanguage: '' };

  it('one row per writing job kind, in a `zh` organisation, started by A (saved `en`)', async () => {
    // plan — augment, generation, revision, resume by A, and the cadence watcher's.
    await aiPlanEditsService.submitAugment('add exports', pctxFor(userA));
    await aiGenerationService.startGeneration(pctxFor(userA), { prompt: 'build it' });
    const aPlan = await plannedPlanBy(userA);
    await aiPlanEditsService.submitRevise(aPlan, 'split it', pctxFor(userA));
    await aiPlanEditsService.submitResume(
      aPlan,
      'job-before',
      pctxFor(userA),
      userA,
      'session-resumed',
    );
    expect(languagesSent('plan')).toEqual([A_IN_ZH, A_IN_ZH, A_IN_ZH, A_IN_ZH]);
    submitJobMock.mockClear();
    await aiPlanEditsService.submitAugment('weekly', pctxFor(userA), undefined, {
      origin: 'cadence',
    });
    expect(languagesSent('plan')).toEqual([NOBODY_IN_ZH]);

    // ask_project — the asker's.
    await askOnce('Export hangs');
    expect(languagesSent('ask_project')).toEqual([A_IN_ZH]);

    // generate_explanation — the requester's.
    await aiExplanationService.submitExplanationDraft({ title: 'Exports' }, pctxFor(userA));
    expect(languagesSent('generate_explanation')).toEqual([A_IN_ZH]);

    // analyze_bug — automatic, so nobody, even though A filed the bug.
    const bug = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'bug', title: 'Tax double-counted' },
      fx.ctx,
    );
    await aiBugTelemetryService.dispatchOutwardAnalysis({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: bug.id,
      actorId: userA,
    });
    expect(languagesSent('analyze_bug')).toEqual([NOBODY_IN_ZH]);

    // author_bug — a monitor filed it, so nobody, though A bound the monitor.
    await fileMonitorBug();
    expect(languagesSent('author_bug')).toEqual([NOBODY_IN_ZH]);
  });

  it('B revising A’s plan sends A’s language, not B’s', async () => {
    const aPlan = await plannedPlanBy(userA);
    await aiPlanEditsService.submitRevise(aPlan, 'split it', pctxFor(userB));
    expect(languagesSent('plan')).toEqual([{ contentLanguage: 'zh', personLanguage: 'en' }]);
  });

  it('a person with no saved language sends the content language, never empty', async () => {
    await aiPlanEditsService.submitAugment('add exports', pctxFor(userC));
    actAs(userC);
    await askOnce('Export hangs');
    const zh = { contentLanguage: 'zh', personLanguage: 'zh' };
    expect(languagesSent('plan')).toEqual([zh]);
    expect(languagesSent('ask_project')).toEqual([zh]);
  });
});

// ─── proposal to approval, across a setting change ───────────────────────────

function asJob(req: Request): Request {
  req.headers.set(
    'x-motir-job-token',
    mintJobToken({ userId: fx.ctx.userId, workspaceId: fx.workspaceId, projectId: fx.projectId }),
  );
  return req;
}

function internal(method: 'POST' | 'PATCH', path: string, body: unknown): Request {
  return asJob(
    new Request(`http://core${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_SECRET}` },
      body: JSON.stringify(body),
    }),
  );
}

/** A `generating` plan bound to `jobId`, and motir-ai's appends to it. */
async function generatedPlan(jobId: string, proposals: unknown[]) {
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: 'Generated', authorSource: 'native', authorHarness: 'Motir' },
    fx.ctx,
  );
  await adminDb.plan.update({ where: { id: plan.id }, data: { sourceJobId: jobId } });
  const res = await proposalsPOST(
    internal('POST', '/api/internal/ai/plan-proposals', { jobId, proposals }),
  );
  expect(res.status).toBe(200);
  const { planItemIds } = (await res.json()) as { planItemIds: string[] };
  return { planId: plan.id, planItemIds };
}

async function deepen(jobId: string, itemId: string, patch: unknown) {
  const res = await proposalPATCH(
    internal('PATCH', `/api/internal/ai/plan-proposals/${itemId}`, { jobId, patch }),
    { params: Promise.resolve({ itemId }) },
  );
  expect(res.status).toBe(200);
}

const recorded = async (title: string) => {
  const row = await adminDb.workItem.findFirstOrThrow({ where: { title } });
  const steps = await adminDb.workItemTodo.findMany({
    where: { workItemId: row.id },
    orderBy: { position: 'asc' },
  });
  return {
    title: row.titleLanguage,
    description: row.descriptionLanguage,
    explanation: row.explanationLanguage,
    steps: steps.map((s) => s.textLanguage),
  };
};

const STATED = { title: 'zh', description: 'zh', todos: 'zh', explanation: 'ko' };

describe('a proposal records the language it was written in, whatever the setting became', () => {
  it('generated in `zh`, approved after the org became `ja`: stated fields keep theirs, unstated take `ja`', async () => {
    const { planId } = await generatedPlan('job-story', [
      {
        op: 'add',
        proposedFields: {
          title: '导出报表',
          kind: 'task',
          descriptionMd: '使用导出服务。',
          explanationMd: '매주 필요합니다.',
          todos: [{ text: '添加按钮' }],
        },
        languages: STATED,
      },
      {
        op: 'add',
        proposedFields: { title: 'No statement', kind: 'task', descriptionMd: 'Body.' },
      },
    ]);
    await setOrgLanguage('ja');
    await plansService.markPlanned(planId, fx.ctx);
    await plansService.approvePlan(planId, fx.ctx);

    expect(await recorded('导出报表')).toEqual({
      title: 'zh',
      description: 'zh',
      explanation: 'ko',
      steps: ['zh'],
    });
    expect(await recorded('No statement')).toMatchObject({ title: 'ja', description: 'ja' });

    // The next plan follows the new setting; what was recorded does not move.
    submitJobMock.mockClear();
    await aiPlanEditsService.submitAugment('more', pctxFor(userA));
    expect(languagesSent('plan')).toEqual([{ contentLanguage: 'ja', personLanguage: 'en' }]);
    expect((await recorded('导出报表')).title).toBe('zh');
  });

  it('an unstated deepen of the explanation and a person’s title edit record `ja`; untouched keys keep theirs', async () => {
    const { planId, planItemIds } = await generatedPlan('job-edit', [
      {
        op: 'add',
        proposedFields: {
          title: '原标题',
          kind: 'task',
          descriptionMd: '正文',
          explanationMd: '이유',
        },
        languages: STATED,
      },
    ]);
    await deepen('job-edit', planItemIds[0]!, { explanationMd: 'Rewritten, no statement.' });
    await setOrgLanguage('ja');
    await plansService.markPlanned(planId, fx.ctx);
    await plansService.updateProposal(planId, planItemIds[0]!, { title: 'Edited' }, fx.ctx);
    await plansService.approvePlan(planId, fx.ctx);

    expect(await recorded('Edited')).toMatchObject({
      title: 'ja',
      description: 'zh',
      explanation: 'ja',
    });
  });
});

// ─── saving a drafted explanation ────────────────────────────────────────────

describe('a saved draft records the draft’s language on the explanation only', () => {
  const columns = async (title: string) => {
    const r = await recorded(title);
    return [r.title, r.description, r.explanation];
  };

  it('create: `ko` on the explanation, the org’s on the rest, and a forged title language dropped', async () => {
    const res = await createIssueAction({
      kind: 'task',
      title: 'Drafted',
      descriptionMd: 'Body.',
      explanationMd: '초안 설명',
      explanationSource: 'ai_draft',
      languages: { explanation: 'ko', title: 'de' } as never,
    });
    expect(res.ok).toBe(true);
    expect(await columns('Drafted')).toEqual(['zh', 'zh', 'ko']);
  });

  it('create with no language records the organisation’s', async () => {
    const res = await createIssueAction({ kind: 'task', title: 'Typed', explanationMd: 'Why.' });
    expect(res.ok).toBe(true);
    expect(await columns('Typed')).toEqual(['zh', null, 'zh']);
  });

  it('update: the explanation records `ko`, the title and description stay as they were', async () => {
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Existing' });
    const before = await recorded('Existing');
    const res = await updateIssueAction({
      id: item.id,
      title: 'Existing',
      explanationMd: '초안 설명',
      explanationSource: 'ai_draft',
      languages: { explanation: 'ko' },
    });
    expect(res.ok).toBe(true);
    const after = await recorded('Existing');
    expect([after.title, after.description, after.explanation]).toEqual([
      before.title,
      before.description,
      'ko',
    ]);
  });
});

// ─── the agent prompt and the project-state read ─────────────────────────────

describe('the agent surfaces name the organisation’s language', () => {
  it('a code item’s prompt names `ja` before WHAT TO DO; a manual item’s has no section', async () => {
    await setOrgLanguage('ja');
    const code = await createTestWorkItem(fx, { kind: 'task', type: 'code', title: 'Build' });
    const manual = await createTestWorkItem(fx, { kind: 'task', type: 'manual', title: 'Do' });
    const codePrompt = (
      await dispatchPromptService.getDispatchPrompt(fx.projectId, code.identifier, fx.ctx)
    ).prompt;
    expect(codePrompt).toContain('This organisation writes its work content in Japanese (`ja`).');
    expect(codePrompt.indexOf('WORK CONTENT LANGUAGE')).toBeLessThan(
      codePrompt.indexOf('\nWHAT TO DO\n'),
    );
    const manualPrompt = (
      await dispatchPromptService.getDispatchPrompt(fx.projectId, manual.identifier, fx.ctx)
    ).prompt;
    expect(manualPrompt).not.toContain('WORK CONTENT LANGUAGE');
  });

  it('`get_project_state` reports `zh`, then `ja` on the next read after the change', async () => {
    const read = async () =>
      (
        (await runGetProjectState({ projectKey: fx.projectIdentifier }, fx.ctx))
          .structuredContent as { contentLanguage: string }
      ).contentLanguage;
    expect(await read()).toBe('zh');
    await setOrgLanguage('ja');
    expect(await read()).toBe('ja');
  });
});
