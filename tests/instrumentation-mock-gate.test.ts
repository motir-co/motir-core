import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { register } from '@/instrumentation';

// Guard for MOTIR-3244: every E2E boundary flag installs its mock ON ITS OWN.
//
// `register()`'s early return used to be a hand-copied enumeration of five of
// the six `want*` locals sitting three lines above it. `E2E_TEST_AI_JOBS` was
// computed and then left out, so a server started with only that flag returned
// before the shared MockAgent was installed and the jobs seam never registered.
// Nothing caught it: the acceptance lane's `webServer.env` sets six flags at
// once, so the gate passed on a sibling and the mock did install. The failure
// only appears where the flag is reached for ALONE — the natural way to write a
// focused `ask` spec — and it surfaces as a 500 from `POST /api/ai/ask`, a
// route, a service and a client away from the `if` that caused it.
//
// The fix derives the gate from the same `MOCKS` table the installs iterate, so
// this file asserts the property that makes that derivation worth having: for
// EVERY flag the table declares — not a list restated here — one flag alone
// installs the shared agent and exactly that seam. A seventh seam added to the
// table is covered the moment it is added, and the `INSTALLERS` equality below
// fails if it is added without an installer this file can see.

const ROOT = process.cwd();

/**
 * The flags the shipped table declares, read out of the source rather than
 * restated. A list restated here would be a second hand-maintained enumeration
 * — the exact defect this file exists to prevent. The table lives in
 * `lib/test-mock-seams.ts` since MOTIR-5837, so the job worker installs from it
 * too; `register()` below still reaches it through `instrumentation.ts`.
 */
const FLAGS: string[] = [
  ...new Set(
    [
      ...readFileSync(join(ROOT, 'lib/test-mock-seams.ts'), 'utf8').matchAll(
        /flag: '(E2E_TEST_\w+)'/g,
      ),
    ]
      .map((m) => m[1]!)
      .filter(Boolean),
  ),
];

const agent = vi.hoisted(() => ({ __shared: true }));
const installSharedMockAgent = vi.hoisted(() => vi.fn(() => agent));
const oauth = vi.hoisted(() => ({
  installGoogleTokenMock: vi.fn(),
  installGithubOAuthMock: vi.fn(),
  installGitlabOAuthMock: vi.fn(),
}));
const blob = vi.hoisted(() => ({ installBlobStoreMock: vi.fn() }));
const billing = vi.hoisted(() => ({ installBillingBoundaryMock: vi.fn() }));
const githubRepos = vi.hoisted(() => ({ installGithubReposMock: vi.fn() }));
const githubMerge = vi.hoisted(() => ({ installGithubMergeMock: vi.fn() }));
const githubPreview = vi.hoisted(() => ({ installGithubPreviewMock: vi.fn() }));
const productionRelease = vi.hoisted(() => ({ installProductionReleaseMock: vi.fn() }));
const githubAccounts = vi.hoisted(() => ({ installGithubAccountsMock: vi.fn() }));
const githubFleetOrgCi = vi.hoisted(() => ({ installGithubFleetOrgCiMock: vi.fn() }));
const codeHealth = vi.hoisted(() => ({ installCodeHealthBoundaryMock: vi.fn() }));
const codeGraphRead = vi.hoisted(() => ({ installCodeGraphReadBoundaryMock: vi.fn() }));
const embeddings = vi.hoisted(() => ({ installEmbeddingsBoundaryMock: vi.fn() }));
const aiJobs = vi.hoisted(() => ({ installAiJobsBoundaryMock: vi.fn() }));
const sharpen = vi.hoisted(() => ({ installSharpenBoundaryMock: vi.fn() }));
const lessons = vi.hoisted(() => ({ installLessonsBoundaryMock: vi.fn() }));
const platformUsage = vi.hoisted(() => ({ installPlatformUsageBoundaryMock: vi.fn() }));
const codeGraph = vi.hoisted(() => ({ installCodeGraphBoundaryMock: vi.fn() }));
const hostedRun = vi.hoisted(() => ({ installHostedRunMock: vi.fn() }));
const cimd = vi.hoisted(() => ({ installClientMetadataDocumentMock: vi.fn() }));
const plannerModel = vi.hoisted(() => ({ installPlannerModelBoundaryMock: vi.fn() }));
const platformLessons = vi.hoisted(() => ({ installPlatformLessonsBoundaryMock: vi.fn() }));

vi.mock('@/lib/test-mock-agent', () => ({ installSharedMockAgent }));
vi.mock('@/lib/test-oauth-mock', () => oauth);
vi.mock('@/lib/test-blob-mock', () => blob);
vi.mock('@/lib/test-billing-mock', () => billing);
vi.mock('@/lib/test-github-repos-mock', () => githubRepos);
vi.mock('@/lib/test-github-merge-mock', () => githubMerge);
vi.mock('@/lib/test-github-preview-mock', () => githubPreview);
vi.mock('@/lib/test-production-release-mock', () => productionRelease);
vi.mock('@/lib/test-github-accounts-mock', () => githubAccounts);
vi.mock('@/lib/test-github-fleet-org-ci-mock', () => githubFleetOrgCi);
vi.mock('@/lib/test-code-health-mock', () => codeHealth);
vi.mock('@/lib/test-code-graph-read-mock', () => codeGraphRead);
vi.mock('@/lib/test-embeddings-mock', () => embeddings);
vi.mock('@/lib/test-ai-jobs-mock', () => aiJobs);
vi.mock('@/lib/test-sharpen-mock', () => sharpen);
vi.mock('@/lib/test-lessons-mock', () => lessons);
vi.mock('@/lib/test-platform-usage-mock', () => platformUsage);
vi.mock('@/lib/test-code-graph-mock', () => codeGraph);
vi.mock('@/lib/test-hosted-run-mock', () => hostedRun);
vi.mock('@/lib/test-cimd-mock', () => cimd);
vi.mock('@/lib/test-planner-model-mock', () => plannerModel);
vi.mock('@/lib/test-platform-lessons-mock', () => platformLessons);

/** Which installers each flag owns — the assertion that the RIGHT seam ran. */
const INSTALLERS: Record<string, ReturnType<typeof vi.fn>[]> = {
  E2E_TEST_OAUTH: [
    oauth.installGoogleTokenMock,
    oauth.installGithubOAuthMock,
    oauth.installGitlabOAuthMock,
  ],
  E2E_TEST_BLOB: [blob.installBlobStoreMock],
  E2E_TEST_BILLING: [billing.installBillingBoundaryMock],
  E2E_TEST_GITHUB_REPOS: [githubRepos.installGithubReposMock],
  // MOTIR-5572 — the GitHub MERGE seam, registered here in the same change that adds
  // it to the shipped table.
  E2E_TEST_GITHUB_MERGE: [githubMerge.installGithubMergeMock],
  // MOTIR-5781 — a preview's GitHub deployment, statuses and hosting manifest (Story MOTIR-5766).
  E2E_TEST_GITHUB_PREVIEW: [githubPreview.installGithubPreviewMock],
  // MOTIR-10040 — a production release's GitHub calls, made by the job worker
  // (Story MOTIR-9797).
  E2E_TEST_PRODUCTION_RELEASE: [productionRelease.installProductionReleaseMock],
  // MOTIR-8225 — the Git room's account + repository pickers (Story MOTIR-8216).
  E2E_TEST_GITHUB_ACCOUNTS: [githubAccounts.installGithubAccountsMock],
  // MOTIR-8717 — the GitHub calls behind /admin/fleet-settings (Story MOTIR-8699).
  E2E_TEST_GITHUB_FLEET_ORG_CI: [githubFleetOrgCi.installGithubFleetOrgCiMock],
  E2E_TEST_CODE_HEALTH: [codeHealth.installCodeHealthBoundaryMock],
  // MOTIR-7866 — the motir-ai code-graph READ seam (Story MOTIR-7858).
  E2E_TEST_CODE_GRAPH_READ: [codeGraphRead.installCodeGraphReadBoundaryMock],
  // MOTIR-9577 — motir-ai's embeddings, for page search by meaning (Story MOTIR-9490).
  E2E_TEST_EMBEDDINGS: [embeddings.installEmbeddingsBoundaryMock],
  E2E_TEST_AI_JOBS: [aiJobs.installAiJobsBoundaryMock],
  // MOTIR-8180 — a Sharpen session's `sharpen_turn` jobs.
  E2E_TEST_SHARPEN: [sharpen.installSharpenBoundaryMock],
  // MOTIR-3340 — the lesson-library seam. Registered HERE in the same change
  // that adds it to the shipped table, which is the whole point of the equality
  // assertion below: this file went red the moment the seam landed without it.
  E2E_TEST_LESSONS: [lessons.installLessonsBoundaryMock],
  // MOTIR-735 — the operator console's platform usage seam (Story MOTIR-727).
  E2E_TEST_PLATFORM_USAGE: [platformUsage.installPlatformUsageBoundaryMock],
  // MOTIR-3564 — the index-WRITER seam (the run-credential mint + the tarball
  // redirect). Registered HERE in the same change that adds it to the shipped
  // table, exactly as the note above describes: this file went red the moment the
  // seam landed without it, which is the guard doing its job rather than a
  // formality.
  //
  // ⚠️ IT IS THE ONE SEAM THE LANE DOES NOT TURN ON HERE, and that changes
  // nothing about this assertion. The boundary it stubs is crossed only by the
  // index supervisor, which is a JOB, so `playwright.config.ts` sets its flag on
  // the WORKER only (which installs from the same table — MOTIR-5837). The table
  // declares it once for both processes, so the table's own guard owes it an entry.
  E2E_TEST_CODE_GRAPH: [codeGraph.installCodeGraphBoundaryMock],
  // MOTIR-6452 — a hosted run's gateway, motir-ai and GitHub-installation seams,
  // registered here in the same change that adds them to the shipped table.
  E2E_TEST_HOSTED_RUN: [hostedRun.installHostedRunMock],
  // MOTIR-7176 — the Client ID Metadata Document transport. Takes no agent.
  E2E_TEST_CIMD: [cimd.installClientMetadataDocumentMock],
  // MOTIR-7231 — the console's planner-model settings seam.
  E2E_TEST_PLANNER_MODEL: [plannerModel.installPlannerModelBoundaryMock],
  // MOTIR-1413 — the console's planning-lessons seam.
  E2E_TEST_PLATFORM_LESSONS: [platformLessons.installPlatformLessonsBoundaryMock],
};

const ALL_INSTALLERS = Object.values(INSTALLERS).flat();

let log: ReturnType<typeof vi.spyOn>;

/** Every instrumentation flag off, plus the Node-runtime precondition. */
function baseEnv(): void {
  vi.stubEnv('NEXT_RUNTIME', 'nodejs');
  for (const flag of FLAGS) vi.stubEnv(flag, '');
}

/** The `[INSTRUMENT] …` lines `register()` printed, in order. */
function instrumentLines(): string[] {
  return log.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((line: string) => line.startsWith('[INSTRUMENT]'));
}

beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  baseEnv();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('the instrumentation gate is derived from the mock table (MOTIR-3244)', () => {
  it('reads the flags off the shipped table, and the table is the full set', () => {
    // A vacuous FLAGS would make every `it.each` below pass by not running.
    expect(FLAGS.length).toBeGreaterThanOrEqual(6);
    expect(FLAGS).toContain('E2E_TEST_AI_JOBS');
    // A seam added to the table with no installer this file knows about fails
    // HERE rather than passing silently — the half-wiring guard, one level up.
    expect(Object.keys(INSTALLERS).sort()).toEqual([...FLAGS].sort());
  });

  it.each(FLAGS)('%s alone installs the shared agent and its own seam', async (flag) => {
    vi.stubEnv(flag, '1');

    await register();

    // The bug: the gate returned before this line for E2E_TEST_AI_JOBS.
    expect(installSharedMockAgent).toHaveBeenCalledTimes(1);
    for (const install of INSTALLERS[flag]!) {
      expect(install).toHaveBeenCalledTimes(1);
      // Whatever a seam takes, it takes THE shared agent — a second agent would
      // silently disconnect the first seam's intercepts. `E2E_TEST_BLOB` takes
      // none (it replaces the S3 transport), so this loop is empty for it.
      for (const arg of install.mock.calls[0]!) expect(arg).toBe(agent);
    }
    // and NOTHING else installed — the gate must not over-fire either.
    const foreign = ALL_INSTALLERS.filter((fn) => !INSTALLERS[flag]!.includes(fn));
    for (const install of foreign) expect(install).not.toHaveBeenCalled();
    expect(instrumentLines()).toEqual([expect.stringContaining(`[INSTRUMENT] ${flag} active — `)]);
  });

  // The literal regression, named rather than derived. Everything above reads
  // the table, so on the PRE-fix source it degenerates to zero cases and fails
  // for being vacuous; this one fails for the DEFECT — `installAiJobsBoundaryMock`
  // never called — which is what a reader needs to see it is guarding.
  it('E2E_TEST_AI_JOBS=1 alone installs the jobs seam (the MOTIR-3244 defect)', async () => {
    vi.stubEnv('E2E_TEST_AI_JOBS', '1');

    await register();

    expect(aiJobs.installAiJobsBoundaryMock).toHaveBeenCalledTimes(1);
    expect(aiJobs.installAiJobsBoundaryMock).toHaveBeenCalledWith(agent);
  });

  it('installs nothing when no flag is set — production stays dormant', async () => {
    await register();

    expect(installSharedMockAgent).not.toHaveBeenCalled();
    for (const install of ALL_INSTALLERS) expect(install).not.toHaveBeenCalled();
    expect(instrumentLines()).toEqual([]);
  });

  it('installs nothing outside the Node runtime, whatever the flags say', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    for (const flag of FLAGS) vi.stubEnv(flag, '1');

    await register();

    expect(installSharedMockAgent).not.toHaveBeenCalled();
    expect(instrumentLines()).toEqual([]);
  });

  it('shares ONE agent across every seam when several flags are set', async () => {
    for (const flag of FLAGS) vi.stubEnv(flag, '1');

    await register();

    // Two agents would silently disconnect the first mock's intercepts.
    expect(installSharedMockAgent).toHaveBeenCalledTimes(1);
    expect(instrumentLines()).toHaveLength(FLAGS.length);
    for (const install of ALL_INSTALLERS) expect(install).toHaveBeenCalledTimes(1);
  });
});
