import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { db } from '@/lib/db';
import { MotirAiOutOfCreditsError } from '@/lib/ai/errors';
import type { AskConversationTurn, Tenant } from '@/lib/ai/types';
import type { AiJobsFixture, AskJobOutcome } from '@/lib/test-ai-jobs-mock';

// The in-repo motir-ai mock's two `ask_project` arms added for Story MOTIR-9216's
// acceptance receipt (MOTIR-9234), crossed on the WIRE by the REAL client
// (`submitJob` / `getJob`) through the undici intercept the acceptance lane
// installs: an ask submit refused out of credits, and a `codeUnreadable` signal
// that names WHICH outage it was. Without them the lane could not reach the
// not-indexed repository or the paywall on an ask, and a spec asserting either
// would have nothing to stand on.

const ORIGIN = 'http://motir-ai.ask-mock.test';
let fixturePath: string;
let agent: MockAgent;

beforeAll(async () => {
  fixturePath = join(mkdtempSync(join(tmpdir(), 'motir-ask-mock-')), 'jobs.json');
  vi.stubEnv('MOTIR_AI_URL', ORIGIN);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token-test');
  vi.stubEnv('MOTIR_AI_JOBS_FIXTURE_PATH', fixturePath);
  agent = new MockAgent();
  agent.disableNetConnect();
  agent.enableNetConnect(/localhost|127\.0\.0\.1/);
  setGlobalDispatcher(agent);
  const { installAiJobsBoundaryMock } = await import('@/lib/test-ai-jobs-mock');
  installAiJobsBoundaryMock(agent);
});

beforeEach(() => writeFileSync(fixturePath, '{}'));

afterAll(async () => {
  vi.unstubAllEnvs();
  await agent.close();
  await db.$disconnect();
});

const { getJob, submitJob } = await import('@/lib/ai/motirAiClient');

// An org with no row: its switches evaluate as "no organization", which the
// submit's kill-switch check lets through — nothing here is about the flags.
const tenant: Tenant = {
  organizationId: 'org-ask-mock-none',
  isMeta: false,
  internalBilling: false,
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  projectKey: 'ACME',
};

function declare(ask: AskJobOutcome[]): void {
  writeFileSync(fixturePath, JSON.stringify({ ask } satisfies AiJobsFixture));
}

const submitted = () =>
  (JSON.parse(readFileSync(fixturePath, 'utf8')) as AiJobsFixture).submitted ?? [];

const ask = () => submitJob('ask_project', tenant, { prompt: 'how?' }, { userId: 'user-1' });

describe('the ask arms of the jobs mock (MOTIR-9234)', () => {
  it('refuses an ask submit declared out of credits with the client’s typed error, and takes the next', async () => {
    declare([
      { intent: 'ask', submit: 'out_of_credits' },
      { intent: 'ask', answer: 'Here.' },
    ]);

    await expect(ask()).rejects.toBeInstanceOf(MotirAiOutOfCreditsError);
    const { jobId } = await ask();

    expect(submitted()).toEqual([
      expect.objectContaining({ kind: 'ask_project', refused: true }),
      expect.objectContaining({ kind: 'ask_project', jobId }),
    ]);
    expect(submitted()[0]!.jobId).toBeUndefined();
    const job = await getJob(jobId, 'proj-1');
    expect(job.result).toMatchObject({ ask: { intent: 'ask', answer: 'Here.' } });
  });

  it.each([
    [true, 'snapshot_integrity'],
    ['hydrate_failed', 'hydrate_failed'],
    ['not_indexed', 'not_indexed'],
  ] as const)('codeUnreadable %s settles with the signal naming %s', async (declared, reason) => {
    declare([{ intent: 'ask', answer: 'Without the code.', codeUnreadable: declared }]);
    const { jobId } = await ask();

    const job = await getJob(jobId, 'proj-1');

    expect(job.result).toMatchObject({
      ask: { intent: 'ask', answer: 'Without the code.' },
      codeUnreadable: { halt: 'code_unreadable', repoRef: 'acme/web', reason },
    });
  });

  it('an ask with neither arm declared is unchanged: accepted, no signal', async () => {
    declare([{ intent: 'ask', answer: 'Plain.' }]);
    const { jobId } = await ask();

    const job = await getJob(jobId, 'proj-1');

    expect(submitted()).toEqual([expect.objectContaining({ kind: 'ask_project', jobId })]);
    expect(job.result).toEqual({ ask: { intent: 'ask', answer: 'Plain.', citations: [] } });
  });
});

// ── The composed requirement (Story MOTIR-9430 · MOTIR-9441) ──────────────────────────
// The lane could not reach a no-target offer WITH a requirement, nor see what a plan
// submit or an ask submit carried for it. Each arm is crossed on the wire by the real
// client, and the undeclared reply stays as it was.

const REQUIREMENT = {
  outcome: 'People export the board as CSV.',
  behaviour: 'An Export button downloads every visible card.',
  scopeEdge: '',
  constraints: 'Reuses the download route.',
  acceptance: 'The file has the same row count.',
  assumptions: [{ id: 'r1', text: 'Archived cards are left out.' }],
};

describe('the composed requirement arms of the jobs mock (MOTIR-9441)', () => {
  it('passes a declared offer.requirement onto the ask result’s offer', async () => {
    declare([
      {
        intent: 'ask',
        answer: 'I can plan that.',
        offer: { kind: 'plan', requestText: 'Export the board', requirement: REQUIREMENT },
      },
    ]);
    const { jobId } = await ask();

    const job = await getJob(jobId, 'proj-1');

    expect(job.result).toMatchObject({
      ask: { offer: { kind: 'plan', requestText: 'Export the board', requirement: REQUIREMENT } },
    });
  });

  it('leaves an offer that declares no requirement byte-identical', async () => {
    declare([
      {
        intent: 'ask',
        answer: 'I can plan that.',
        offer: { kind: 'plan', requestText: 'Export the board', immediate: false },
      },
    ]);
    const { jobId } = await ask();

    const job = await getJob(jobId, 'proj-1');

    const offer = (job.result as unknown as { ask: { offer: Record<string, unknown> } }).ask.offer;
    expect(offer).toEqual({ kind: 'plan', requestText: 'Export the board', immediate: false });
    expect(offer).not.toHaveProperty('requirement');
  });

  it('journals a plan submit’s requirement, page and whether it carried answers', async () => {
    declare([]);
    const page = { pageId: 'page-1', title: 'Export the board' };

    await submitJob(
      'plan',
      tenant,
      { requirement: REQUIREMENT, requirementPage: page },
      { userId: 'user-1' },
    );
    await submitJob(
      'plan',
      tenant,
      { carriedAnswers: { requests: [], settled: [], assumptions: [] } },
      { userId: 'user-1' },
    );
    await submitJob('plan', tenant, {}, { userId: 'user-1' });

    const [supplied, carried, bare] = submitted();
    expect(supplied).toMatchObject({
      kind: 'plan',
      requirement: REQUIREMENT,
      requirementPage: page,
      hasCarriedAnswers: false,
    });
    expect(carried).toMatchObject({ kind: 'plan', hasCarriedAnswers: true });
    expect(carried).not.toHaveProperty('requirement');
    expect(bare).toMatchObject({ kind: 'plan', hasCarriedAnswers: false });
    expect(bare).not.toHaveProperty('requirement');
    expect(bare).not.toHaveProperty('requirementPage');
  });

  it('journals an ask submit’s conversation turns, and none on a first turn', async () => {
    declare([{ intent: 'ask', answer: 'One.' }]);
    const turns: AskConversationTurn[] = [
      { role: 'person', text: 'Plan an export' },
      { role: 'motir', text: 'I can plan that.' },
    ];

    await submitJob(
      'ask_project',
      tenant,
      { prompt: 'second', conversationTurns: turns },
      {
        userId: 'user-1',
      },
    );
    await ask();

    const [withTurns, first] = submitted();
    expect(withTurns).toMatchObject({ kind: 'ask_project', conversationTurns: turns });
    expect(first).toMatchObject({ kind: 'ask_project' });
    expect(first).not.toHaveProperty('conversationTurns');
  });
});
