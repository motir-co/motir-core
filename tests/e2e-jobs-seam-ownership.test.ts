import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent, setGlobalDispatcher } from 'undici';

// Guard for MOTIR-4137: the LESSONS seam does not answer the JOBS protocol.
//
// ## What went wrong
//
// `lib/test-lessons-mock.ts` registered its own `/v1/jobs` interceptors — the
// POST and BOTH reads — on the same `MOTIR_AI_URL` pool the jobs seam uses.
// undici matches interceptors in REGISTRATION ORDER and `instrumentation.ts`
// installs lessons (entry 5) before jobs (entry 6), so with both flags on the
// jobs seam's replies were unreachable: every caller got the constant
// `job_lessons_e2e` id and an empty `{ operations: [] }` result.
//
// Nothing caught it while the two flags lived in different lanes. MOTIR-4094
// then promoted `acceptance-ask-about-this-project` into the CLOUD lane, which
// is the one lane that sets both — and the ask journey, whose three crossings
// all read the jobs protocol (the id carries the job KIND, and the settle reads
// `result.ask`), went silent on every turn. `main` stopped deploying for 13
// hours because `CI complete` gates `Deploy to Fly`.
//
// ## What this file pins, and why it is not a restatement of the fix
//
// The property is OWNERSHIP, asserted through the wire rather than through the
// source: with both seams installed IN THE SHIPPED ORDER, a `POST /v1/jobs`
// gets back the jobs seam's kind-carrying id and the settle reads the outcome
// the fixture declared. That holds however `instrumentation.ts` is ordered, so
// re-ordering the table cannot resurrect the bug and cannot silently pass this.
//
// ⚠️ The lessons CAPTURE is asserted in the same test, and that is the point of
// the card rather than an extra. The tempting fix — delete the lessons seam's
// `/v1/jobs` interceptors — would make the two assertions below disagree: the
// jobs protocol would be right and the lesson would never be written. Both
// arms in one test is what stops the next person trading one for the other.
//
// The third test is the COUNTERFACTUAL. Without it the first two would still
// pass if the lessons seam had simply stopped serving `/v1/jobs` in every lane,
// so it pins that the seam still answers on its own — which is what keeps a
// planning submit from escaping to an unresolvable host in a lessons-only lane.

const ORIGIN = 'http://motir-ai.seam-ownership.test';

/** The install order `instrumentation.ts` ships — lessons BEFORE jobs. */
async function installSeamsInShippedOrder(agent: MockAgent, opts: { jobsSeam: boolean }) {
  const { installLessonsBoundaryMock } = await import('@/lib/test-lessons-mock');
  installLessonsBoundaryMock(agent);
  if (opts.jobsSeam) {
    const { installAiJobsBoundaryMock } = await import('@/lib/test-ai-jobs-mock');
    installAiJobsBoundaryMock(agent);
  }
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

describe('the motir-ai jobs protocol belongs to ONE seam', () => {
  let agent: MockAgent;
  let jobsFixture: string;
  let lessonsFixture: string;

  beforeEach(() => {
    // A fresh module registry per test: `observeAiJobSubmit` keeps its
    // subscribers in module scope, so a second install in the same registry
    // would stack a second observer and double the capture.
    vi.resetModules();

    const dir = mkdtempSync(join(tmpdir(), 'motir-seam-ownership-'));
    jobsFixture = join(dir, 'jobs.json');
    lessonsFixture = join(dir, 'lessons.json');
    writeFileSync(
      jobsFixture,
      JSON.stringify({
        ask: [{ intent: 'ask', answer: 'Two are waiting.', citations: ['ACME-1'] }],
      }),
    );
    writeFileSync(lessonsFixture, JSON.stringify({ lessons: [] }));

    vi.stubEnv('MOTIR_AI_URL', ORIGIN);
    vi.stubEnv('MOTIR_AI_JOBS_FIXTURE_PATH', jobsFixture);
    vi.stubEnv('MOTIR_AI_LESSONS_FIXTURE_PATH', lessonsFixture);

    agent = new MockAgent();
    agent.enableNetConnect();
    setGlobalDispatcher(agent);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await agent.close();
  });

  it('answers a submit with the JOBS seam id when both flags are on — not the lessons constant', async () => {
    vi.stubEnv('E2E_TEST_LESSONS', '1');
    vi.stubEnv('E2E_TEST_AI_JOBS', '1');
    await installSeamsInShippedOrder(agent, { jobsSeam: true });

    const submitted = await fetch(`${ORIGIN}/v1/jobs`, {
      method: 'POST',
      body: JSON.stringify({ jobKind: 'ask_project' }),
    });
    const { jobId } = (await submitted.json()) as { jobId: string };

    // The id CARRIES THE KIND — that is the whole mechanism the settle reads
    // back, and the constant the lessons seam used to return destroyed it.
    expect(jobId).toBe('e2e-ask_project-0');
    expect(jobId).not.toBe('job_lessons_e2e');

    const settled = await fetch(`${ORIGIN}/v1/jobs/${jobId}`);
    const body = (await settled.json()) as { result?: { ask?: { answer?: string } } };
    expect(body.result?.ask?.answer).toBe('Two are waiting.');
  });

  it('still records the lessons CAPTURE while the jobs seam owns the protocol', async () => {
    vi.stubEnv('E2E_TEST_LESSONS', '1');
    vi.stubEnv('E2E_TEST_AI_JOBS', '1');
    await installSeamsInShippedOrder(agent, { jobsSeam: true });

    await fetch(`${ORIGIN}/v1/jobs`, {
      method: 'POST',
      body: JSON.stringify({ jobKind: 'generate_tree' }),
    });

    const { lessons } = readJson(lessonsFixture) as unknown as { lessons: { id: string }[] };
    expect(lessons).toHaveLength(1);
    expect(lessons[0]?.id).toBe('les_captured_1');
  });

  it('COUNTERFACTUAL — with no jobs seam, the lessons seam still answers a submit itself', async () => {
    vi.stubEnv('E2E_TEST_LESSONS', '1');
    vi.stubEnv('E2E_TEST_AI_JOBS', '');
    await installSeamsInShippedOrder(agent, { jobsSeam: false });

    const submitted = await fetch(`${ORIGIN}/v1/jobs`, {
      method: 'POST',
      body: JSON.stringify({ jobKind: 'generate_tree' }),
    });

    expect(((await submitted.json()) as { jobId: string }).jobId).toBe('job_lessons_e2e');
    const { lessons } = readJson(lessonsFixture) as unknown as { lessons: { id: string }[] };
    expect(lessons).toHaveLength(1);
  });

  it('the PLANNER-FINDINGS seam claims only the plan jobs its fixture names (MOTIR-10529)', async () => {
    const findingsFixture = join(jobsFixture, '..', 'planner-findings.json');
    writeFileSync(
      findingsFixture,
      JSON.stringify({
        findings: [],
        jobs: {
          job_plan_7: {
            result: {
              stageUsage: [
                {
                  stage: 'review',
                  model: 'm',
                  inputTokens: 10,
                  outputTokens: 2,
                  sessions: 1,
                  costMicroUsd: 1500,
                },
              ],
              dryRun: {
                outcome: 'ran',
                counts: { findingsAccepted: 2, fixed: 1, reported: 1, fixFailed: 0 },
              },
            },
          },
        },
      }),
    );
    vi.stubEnv('MOTIR_AI_PLANNER_FINDINGS_FIXTURE_PATH', findingsFixture);
    vi.stubEnv('E2E_TEST_PLANNER_FINDINGS', '1');
    vi.stubEnv('E2E_TEST_AI_JOBS', '1');
    // The shipped order: the planner-findings row sits BEFORE the jobs row.
    const { installPlannerFindingsBoundaryMock } = await import('@/lib/test-planner-findings-mock');
    installPlannerFindingsBoundaryMock(agent);
    const { installAiJobsBoundaryMock } = await import('@/lib/test-ai-jobs-mock');
    installAiJobsBoundaryMock(agent);

    // A job the findings fixture names is answered from it, usage lines and all.
    const named = await fetch(`${ORIGIN}/v1/jobs/job_plan_7?coreProjectId=proj_1`);
    const plan = (await named.json()) as {
      jobId: string;
      status: string;
      result: { stageUsage?: unknown[]; dryRun?: { counts: { fixed: number } } };
    };
    expect(plan).toMatchObject({ jobId: 'job_plan_7', status: 'succeeded' });
    expect(plan.result.stageUsage).toHaveLength(1);
    expect(plan.result.dryRun?.counts.fixed).toBe(1);

    // Every other job still belongs to the jobs seam: a submit's kind-carrying id
    // settles with the jobs fixture's outcome.
    const submitted = await fetch(`${ORIGIN}/v1/jobs`, {
      method: 'POST',
      body: JSON.stringify({ jobKind: 'ask_project' }),
    });
    const { jobId } = (await submitted.json()) as { jobId: string };
    expect(jobId).toBe('e2e-ask_project-0');
    const settled = await fetch(`${ORIGIN}/v1/jobs/${jobId}`);
    const body = (await settled.json()) as { result?: { ask?: { answer?: string } } };
    expect(body.result?.ask?.answer).toBe('Two are waiting.');
  });
});
