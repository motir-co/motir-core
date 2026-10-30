import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { JobPlanningCodeContext } from '@/lib/ai/codeContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The CODE half of a conversation job (MOTIR-7922), route-level, against a REAL
// Postgres. `aiAskService`'s one conversation submit used to send `{ prompt,
// anchorKey? }` and nothing else, so motir-ai — which offers its code-graph tools
// only when `context.code.repos[]` names a repository — answered every question
// and diagnosed every debug turn code-blind, on a project whose repos were all
// indexed. The submit now resolves `context.code` through the SAME planning
// producer the plan-edit submits use.
//
// Mocked: `getSession` / `getActiveProject` and the motir-ai client, exactly as
// `askDebugIntent.test.ts` does, plus `resolvePlanningCodeContext` alone — the
// producer has its own suite (`codeContext.test.ts`); what this file pins is that
// the conversation submit CALLS it and forwards what it answers, for both kinds.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

const resolvePlanningCodeContextMock = vi.fn(
  async (..._args: unknown[]): Promise<JobPlanningCodeContext | undefined> => undefined,
);
vi.mock('@/lib/ai/codeContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/codeContext')>()),
  resolvePlanningCodeContext: (...args: unknown[]) => resolvePlanningCodeContextMock(...args),
}));

const submitJobMock = vi.fn(async (..._args: unknown[]) => ({ jobId: 'job-ask-1' }));
const getJobMock = vi.fn();
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...args),
  getJob: (...args: unknown[]) => getJobMock(...(args as [])),
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

const { POST: ask } = await import('@/app/api/ai/ask/route');

const BASE = 'http://localhost:3000';
const post = (path: string, body: unknown) =>
  new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** A connected, indexed repository set, as the planning producer answers it. */
const CODE: JobPlanningCodeContext = {
  repos: [
    {
      provider: 'github',
      repoRef: 'acme/web',
      defaultBranch: 'main',
      indexed: true,
      indexState: 'indexed',
      refreshInFlight: false,
      indexedAt: null,
      commitsBehind: null,
      indexedSha: null,
      defaultHead: null,
    },
  ],
};

const submittedKinds = () => submitJobMock.mock.calls.map((c) => c[0]);
const contextOf = (n: number) => submitJobMock.mock.calls[n]![2] as Record<string, unknown>;

/** Ask, then RETRY the same turn, so the door submits twice — the only job kind a
 *  conversation turn opens since AMENDMENT 5 (MOTIR-9231) is `ask_project`. */
async function askThenRetry(text: string) {
  const submitted = (await (await ask(post('/api/ai/ask', { body: text }))).json()) as {
    turnId: string;
  };
  const res = await ask(post('/api/ai/ask', { turnId: submitted.turnId }));
  expect(res.status).toBe(200);
  expect(submittedKinds()).toEqual(['ask_project', 'ask_project']);
}

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  submitJobMock.mockReset();
  let n = 0;
  submitJobMock.mockImplementation(async (...args: unknown[]) => ({
    jobId: `job-${String(args[0])}-${++n}`,
  }));
  getJobMock.mockReset();
  resolvePlanningCodeContextMock.mockReset();
  resolvePlanningCodeContextMock.mockResolvedValue(undefined);
  vi.stubEnv('MOTIR_AI_URL', 'http://motir-ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'test-service-token');
  fx = await makeWorkItemFixture();
  session.current = { user: { id: fx.ownerId, email: 'owner@example.com', name: 'Owner' } };
  activeCtx.current = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a conversation job carries the project code context', () => {
  it('the ask and its retry both carry `context.code` from the planning producer', async () => {
    resolvePlanningCodeContextMock.mockResolvedValue(CODE);
    await askThenRetry('Which service owns the code-graph index fan-out?');

    expect(contextOf(0)).toEqual({
      prompt: 'Which service owns the code-graph index fan-out?',
      code: CODE,
    });
    expect(contextOf(1)).toEqual({
      prompt: 'Which service owns the code-graph index fan-out?',
      code: CODE,
    });
    // Resolved for the ACTIVE project and the sender, once per submit.
    expect(resolvePlanningCodeContextMock).toHaveBeenCalledTimes(2);
    for (const call of resolvePlanningCodeContextMock.mock.calls) {
      expect(call[0]).toEqual({
        userId: fx.ownerId,
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
      });
    }
  });

  it('a project with no connected repository OMITS `code` on both submits — never an empty key', async () => {
    await askThenRetry('Export hangs');

    for (const n of [0, 1]) {
      expect(contextOf(n)).toEqual({ prompt: 'Export hangs' });
      expect(contextOf(n)).not.toHaveProperty('code');
    }
  });
});

// Story MOTIR-7734 · MOTIR-8742 — the same two submits carry BOTH languages: the
// org's content language and the ASKER's own, read fresh at each submit.
describe('a conversation job carries the tenant languages', () => {
  const tenantOf = (n: number) => submitJobMock.mock.calls[n]![1] as Record<string, unknown>;
  const languagesOf = (n: number) => ({
    contentLanguage: tenantOf(n)['contentLanguage'],
    personLanguage: tenantOf(n)['personLanguage'],
  });
  const setOrgLanguage = (contentLanguage: string) =>
    adminDb.organization.update({
      where: { id: fx.workspace.organizationId },
      data: { contentLanguage },
    });
  const setLocale = (locale: string | null) =>
    adminDb.user.update({ where: { id: fx.ownerId }, data: { locale } });

  it('the ask and its retry both send the org’s and the asker’s language', async () => {
    await setOrgLanguage('ja');
    await setLocale('ko');
    await askThenRetry('Export hangs');
    for (const n of [0, 1]) {
      expect(languagesOf(n)).toEqual({ contentLanguage: 'ja', personLanguage: 'ko' });
    }
  });

  it('an asker with no saved language gets the content language, never empty', async () => {
    await setOrgLanguage('de');
    await setLocale(null);
    await askThenRetry('Export hangs');
    for (const n of [0, 1]) {
      expect(languagesOf(n)).toEqual({ contentLanguage: 'de', personLanguage: 'de' });
    }
  });

  it('reads the org setting at each submit: moved from en to ja, the next ask sends ja', async () => {
    await setOrgLanguage('en');
    await setLocale('en');
    await ask(post('/api/ai/ask', { body: 'one' }));
    expect(tenantOf(0)['contentLanguage']).toBe('en');
    await setOrgLanguage('ja');
    await ask(post('/api/ai/ask', { body: 'two' }));
    expect(tenantOf(1)['contentLanguage']).toBe('ja');
  });
});
