import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { PROJECT_SCOPE } from '@/lib/planChange/scope';
import { usersService } from '@/lib/services/usersService';
import { makeWorkItemFixture, createTestWorkItem } from '../fixtures/workItemFixtures';
import type { WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';

// Story MOTIR-7734 · MOTIR-8741 — EVERY `plan` SUBMIT SENDS BOTH LANGUAGES, and the
// person is the one who STARTED the plan: the clicker on a first plan, an expand, an
// augment, a contextual turn, a generation or a routing run; the plan's
// `createdById` on a revision or a resume (never the reviewer's own); nobody (`''`)
// on the cadence watcher's submit. Real Postgres for the reads; only the motir-ai
// boundary client is mocked, as in every AI service test.

const submitJobMock = vi.fn(async (..._args: unknown[]) => ({ jobId: 'job-lang-1' }));

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...args),
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

const { aiPlanEditsService } = await import('@/lib/services/aiPlanEditsService');
const { aiGenerationService } = await import('@/lib/services/aiGenerationService');
const { plansService } = await import('@/lib/services/plansService');
const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');

let fx: WorkItemFixture;
let seq = 0;

const pctxFor = (userId: string): ProjectContext => ({
  userId,
  workspaceId: fx.workspaceId,
  projectId: fx.projectId,
  project: fx.project,
});

async function setOrgLanguage(contentLanguage: string) {
  await adminDb.organization.update({
    where: { id: fx.workspace.organizationId },
    data: { contentLanguage },
  });
}

async function setLocale(userId: string, locale: string | null) {
  await adminDb.user.update({ where: { id: userId }, data: { locale } });
}

/** A second project member holding `ai:plan`, with this saved language. */
async function teammate(locale: string | null): Promise<string> {
  seq += 1;
  const u = await usersService.createUser({
    email: `planner-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: `Planner ${seq}`,
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

/** The tenant the ONLY `plan` submit since the last clear carried. */
function sentTenant(): Record<string, unknown> {
  const plans = submitJobMock.mock.calls.filter((c) => c[0] === 'plan');
  expect(plans).toHaveLength(1);
  return plans[0]![1] as Record<string, unknown>;
}

const languagesOf = (tenant: Record<string, unknown>) => ({
  contentLanguage: tenant['contentLanguage'],
  personLanguage: tenant['personLanguage'],
});

/** A `planned` plan, started by `createdById`, for a revision or resume. */
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

beforeEach(async () => {
  await truncateAuthTables();
  submitJobMock.mockClear();
  fx = await makeWorkItemFixture();
  await setOrgLanguage('zh');
  await setLocale(fx.ownerId, 'ko');
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a submit somebody clicked sends the clicker’s language', () => {
  const ZH_KO = { contentLanguage: 'zh', personLanguage: 'ko' };

  it('submitAugment', async () => {
    await aiPlanEditsService.submitAugment('add exports', pctxFor(fx.ownerId));
    expect(languagesOf(sentTenant())).toEqual(ZH_KO);
  });

  it('submitContextual', async () => {
    const item = await createTestWorkItem(fx, { kind: 'story', title: 'Exports' });
    await aiPlanEditsService.submitContextual('split it', [item.identifier], pctxFor(fx.ownerId));
    expect(languagesOf(sentTenant())).toEqual(ZH_KO);
  });

  it('submitExpand', async () => {
    const item = await createTestWorkItem(fx, { kind: 'story', title: 'Exports' });
    await aiPlanEditsService.submitExpand(item.identifier, pctxFor(fx.ownerId));
    expect(languagesOf(sentTenant())).toEqual(ZH_KO);
  });

  it('startGeneration', async () => {
    await aiGenerationService.startGeneration(pctxFor(fx.ownerId), { prompt: 'build it' });
    expect(languagesOf(sentTenant())).toEqual(ZH_KO);
  });

  it('startRoutingRun', async () => {
    await aiGenerationService.startRoutingRun(pctxFor(fx.ownerId));
    expect(languagesOf(sentTenant())).toEqual(ZH_KO);
  });

  it('a planning-conversation turn, submitted by its Korean owner', async () => {
    const me = pctxFor(fx.ownerId);
    const started = await planChangeSessionsService.startWithFirstTurn(
      me,
      PROJECT_SCOPE,
      'add exports',
    );
    await planChangeSessionsService.submit(me, { sessionId: started.id });
    expect(languagesOf(sentTenant())).toEqual(ZH_KO);
  });

  it('a person with no saved language sends the content language, never empty', async () => {
    await setLocale(fx.ownerId, null);
    await aiPlanEditsService.submitAugment('add exports', pctxFor(fx.ownerId));
    expect(languagesOf(sentTenant())).toEqual({ contentLanguage: 'zh', personLanguage: 'zh' });
  });

  it('reads the setting at each submit: an org moved from en to ja sends ja next', async () => {
    await setOrgLanguage('en');
    await aiPlanEditsService.submitAugment('one', pctxFor(fx.ownerId));
    expect(sentTenant()['contentLanguage']).toBe('en');
    submitJobMock.mockClear();
    await setOrgLanguage('ja');
    await aiPlanEditsService.submitAugment('two', pctxFor(fx.ownerId));
    expect(sentTenant()['contentLanguage']).toBe('ja');
  });
});

describe('a submit nobody clicked sends no person', () => {
  it('the cadence watcher’s augment sends personLanguage "" and opens a plan nobody started', async () => {
    const { planId } = await aiPlanEditsService.submitAugment(
      'tick',
      pctxFor(fx.ownerId),
      undefined,
      { origin: 'cadence' },
    );
    expect(languagesOf(sentTenant())).toEqual({ contentLanguage: 'zh', personLanguage: '' });
    const row = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(row.createdById).toBeNull();
  });
});

describe('a revision or resume sends the plan STARTER’s language, not the reviewer’s', () => {
  it('submitRevise by B on A’s plan sends A’s language', async () => {
    const starter = await teammate('de');
    const planId = await plannedPlanBy(starter);
    await aiPlanEditsService.submitRevise(planId, 'split it', pctxFor(fx.ownerId));
    expect(languagesOf(sentTenant())).toEqual({ contentLanguage: 'zh', personLanguage: 'de' });
  });

  it('submitSessionRevision by B on A’s plan sends A’s language', async () => {
    const starter = await teammate('de');
    const planId = await plannedPlanBy(starter);
    await aiPlanEditsService.submitSessionRevision(planId, 'split it', pctxFor(fx.ownerId));
    expect(sentTenant()['personLanguage']).toBe('de');
  });

  it('a revision of a plan nobody started sends ""', async () => {
    const planId = await plannedPlanBy(null);
    await aiPlanEditsService.submitRevise(planId, 'split it', pctxFor(fx.ownerId));
    expect(sentTenant()['personLanguage']).toBe('');
  });

  it('submitResume sends the starter’s language', async () => {
    const starter = await teammate('fr');
    const planId = await plannedPlanBy(starter);
    await aiPlanEditsService.submitResume(
      planId,
      'job-before',
      pctxFor(fx.ownerId),
      starter,
      'session-resumed',
    );
    expect(languagesOf(sentTenant())).toEqual({ contentLanguage: 'zh', personLanguage: 'fr' });
  });
});
