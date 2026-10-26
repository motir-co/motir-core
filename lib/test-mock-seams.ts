// THE E2E BOUNDARY SEAMS, as ONE table every process in the lane installs from
// (Bug MOTIR-5837). Node-only.
//
// ⚠️ WHY THIS IS NOT INSIDE `instrumentation.ts` ANY MORE. That file is a
// NEXT.JS HOOK: it runs once per Next server boot and nowhere else. The E2E lane
// runs a THIRD process — the Postgres job engine's worker (`scripts/worker.ts`,
// spawned by `tests/e2e/_helpers/job-worker-process.ts`) — which never executes
// it. So while this table lived there, a job handler that reached a faked
// boundary got NO intercept at all: `pull-request/auto-merge.requested` and
// `system.pull-request-reconcile` left the box for the real `api.github.com`,
// and the approve-before-green → merges-by-itself path was unreachable from any
// spec. The worker had grown ONE seam of its own (the index writer's, MOTIR-3564)
// by hand, which is exactly the shape that re-opens the hole for the next seam.
// Now both processes call `installE2EMockSeams()`, so a seam added here is
// installed wherever its flag is set.
//
// ⚠️ A FLAG IS STILL PER PROCESS. Installing from one table does not turn a seam
// on in the worker: the worker inherits the RUNNER's environment, not
// `webServer.env`, and `job-worker-process.ts` decides which flags it mirrors.
// That is deliberate — a seam whose fake keeps state IN MEMORY
// (`E2E_TEST_GITHUB_REPOS`' "created" map, `E2E_TEST_BLOB`'s object store) would
// be a SECOND, disagreeing fake in a second process. Mirror only a seam whose
// state lives in its control/journal files.
//
// The imports inside each `install` stay DYNAMIC: `instrumentation.ts` reaches
// this module only under `NEXT_RUNTIME === 'nodejs'`, and a production worker
// that sets no flag never loads `undici`'s mock machinery at all.

import type { MockAgent } from 'undici';

/**
 * One E2E boundary seam: the env flag that turns it on, the clause its boot
 * line completes, and the installer to run. `install` receives the shared
 * MockAgent; a seam that intercepts elsewhere (E2E_TEST_BLOB replaces the S3
 * client's transport) simply ignores it.
 */
export interface MockSeam {
  readonly flag: string;
  readonly message: string;
  readonly install: (agent: MockAgent) => Promise<void>;
  /** Whether the seam is on in this process. Absent ⇒ `flag` is set to `'1'`;
   *  a seam keyed on a PATH (the fake AWS) says so here. */
  readonly active?: () => boolean;
}

export const E2E_MOCK_SEAMS: readonly MockSeam[] = [
  {
    flag: 'E2E_TEST_OAUTH',
    message: 'Google + GitHub + GitLab OAuth endpoints mocked.',
    install: async (agent) => {
      const { installGoogleTokenMock, installGithubOAuthMock, installGitlabOAuthMock } =
        await import('@/lib/test-oauth-mock');
      installGoogleTokenMock(agent);
      // GitHub identity grant (Story 7.10 · MOTIR-897): the server-side
      // code→token exchange + /user read the OAuth callback performs — same
      // env gate, same shared agent.
      installGithubOAuthMock(agent);
      // GitLab connect grant (Story 7.23 · MOTIR-1480): the server-side
      // code→token exchange + /api/v4/user read — same env gate, same shared agent.
      installGitlabOAuthMock(agent);
    },
  },
  {
    flag: 'E2E_TEST_BLOB',
    message: 'in-process object store installed.',
    install: async () => {
      const { installBlobStoreMock } = await import('@/lib/test-blob-mock');
      // No `agent` — this seam replaces the S3 client's transport, not undici's.
      installBlobStoreMock();
    },
  },
  {
    // Story MOTIR-7170 · MOTIR-7176 — Client ID Metadata Documents. Like
    // E2E_TEST_BLOB it ignores the agent: it replaces the cimd plugin's
    // transport, whose pinned connection undici's MockAgent cannot intercept.
    flag: 'E2E_TEST_CIMD',
    message: 'Client ID Metadata Document transport mocked.',
    install: async () => {
      const { installClientMetadataDocumentMock } = await import('@/lib/test-cimd-mock');
      installClientMetadataDocumentMock();
    },
  },
  {
    flag: 'E2E_TEST_BILLING',
    message: 'motir-ai billing seam mocked.',
    install: async (agent) => {
      const { installBillingBoundaryMock } = await import('@/lib/test-billing-mock');
      installBillingBoundaryMock(agent);
    },
  },
  {
    // ⚠️ BEFORE `E2E_TEST_GITHUB_MERGE` and `E2E_TEST_GITHUB_REPOS`, and the order
    // is load-bearing: the REPOS seam answers every `POST /app/installations/*`
    // with one shared token, and this one claims only its own installation, so
    // its repository read can tell that installation apart (MOTIR-8225).
    flag: 'E2E_TEST_GITHUB_ACCOUNTS',
    message: 'GitHub account + repository pickers mocked.',
    install: async (agent) => {
      const { installGithubAccountsMock } = await import('@/lib/test-github-accounts-mock');
      installGithubAccountsMock(agent);
    },
  },
  {
    // Story MOTIR-8699 · MOTIR-8717 — the GitHub calls behind /admin/fleet-settings
    // (the org installation, its repositories, visibility, the workflow commit and
    // the org's MOTIR_RUNNER variable).
    // ⚠️ BEFORE `E2E_TEST_GITHUB_MERGE` and `E2E_TEST_GITHUB_REPOS`, and the order is
    // load-bearing: the REPOS seam answers every `POST /app/installations/*` with one
    // shared token and the MERGE seam answers `GET /repos/{owner}/{name}` for its own
    // repositories. This one claims only the orgs and installation ids its control
    // file names, so its token mint and its repository reads can tell its org apart,
    // and every other call falls through to them untouched.
    flag: 'E2E_TEST_GITHUB_FLEET_ORG_CI',
    message: 'GitHub fleet org CI (installation, repositories, MOTIR_RUNNER) mocked.',
    install: async (agent) => {
      const { installGithubFleetOrgCiMock } = await import('@/lib/test-github-fleet-org-ci-mock');
      installGithubFleetOrgCiMock(agent);
    },
  },
  {
    // ⚠️ BEFORE `E2E_TEST_GITHUB_REPOS`, and the order is load-bearing: both seams
    // answer `GET /repos/{owner}/{name}`, undici tries intercepts in registration
    // order, and this one claims only the repositories its control file names.
    flag: 'E2E_TEST_GITHUB_MERGE',
    message: 'GitHub merge + merge-queue API mocked.',
    install: async (agent) => {
      const { installGithubMergeMock } = await import('@/lib/test-github-merge-mock');
      installGithubMergeMock(agent);
    },
  },
  {
    flag: 'E2E_TEST_GITHUB_REPOS',
    message: 'GitHub repo creation + collaborator API mocked.',
    install: async (agent) => {
      const { installGithubReposMock } = await import('@/lib/test-github-repos-mock');
      installGithubReposMock(agent);
    },
  },
  {
    flag: 'E2E_TEST_CODE_HEALTH',
    message: 'motir-ai code-health seam mocked.',
    install: async (agent) => {
      const { installCodeHealthBoundaryMock } = await import('@/lib/test-code-health-mock');
      installCodeHealthBoundaryMock(agent);
    },
  },
  {
    // Story MOTIR-727 (MOTIR-735) — the operator console's platform usage reads.
    flag: 'E2E_TEST_PLATFORM_USAGE',
    message: 'motir-ai platform usage seam mocked.',
    install: async (agent) => {
      const { installPlatformUsageBoundaryMock } = await import('@/lib/test-platform-usage-mock');
      installPlatformUsageBoundaryMock(agent);
    },
  },
  {
    // Story MOTIR-7858 · MOTIR-7866 — motir-ai's POST /v1/code-graph/read, which
    // the MCP `code_explore` / `code_search` tools call from inside the server.
    flag: 'E2E_TEST_CODE_GRAPH_READ',
    message: 'motir-ai code-graph read seam mocked.',
    install: async (agent) => {
      const { installCodeGraphReadBoundaryMock } = await import('@/lib/test-code-graph-read-mock');
      installCodeGraphReadBoundaryMock(agent);
    },
  },
  {
    // Story MOTIR-9490 · MOTIR-9577 — motir-ai's POST /v1/embeddings, which the
    // server crosses to embed a page search query and the job WORKER crosses to
    // embed a page after a save. File-backed control and journal, so it is safe
    // to mirror into the worker (`tests/e2e/_helpers/job-worker-process.ts`).
    flag: 'E2E_TEST_EMBEDDINGS',
    message: 'motir-ai embeddings seam mocked (deterministic topic vectors).',
    install: async (agent) => {
      const { installEmbeddingsBoundaryMock } = await import('@/lib/test-embeddings-mock');
      installEmbeddingsBoundaryMock(agent);
    },
  },
  {
    flag: 'E2E_TEST_LESSONS',
    message: 'motir-ai lesson-library seam mocked.',
    install: async (agent) => {
      const { installLessonsBoundaryMock } = await import('@/lib/test-lessons-mock');
      installLessonsBoundaryMock(agent);
    },
  },
  {
    // Task MOTIR-1101 · MOTIR-8180 — a Sharpen session's `sharpen_turn` jobs.
    // ⚠️ BEFORE `E2E_TEST_AI_JOBS`, and the order is load-bearing: both seams
    // answer `/v1/jobs`, undici tries intercepts in registration order, the jobs
    // seam accepts any kind, and this one claims only `sharpen_turn` submits and
    // the ids it minted.
    flag: 'E2E_TEST_SHARPEN',
    message: 'motir-ai Sharpen (sharpen_turn) seam mocked.',
    install: async (agent) => {
      const { installSharpenBoundaryMock } = await import('@/lib/test-sharpen-mock');
      installSharpenBoundaryMock(agent);
    },
  },
  {
    flag: 'E2E_TEST_AI_JOBS',
    message: 'motir-ai jobs seam mocked.',
    install: async (agent) => {
      const { installAiJobsBoundaryMock } = await import('@/lib/test-ai-jobs-mock');
      installAiJobsBoundaryMock(agent);
    },
  },
  {
    // ⚠️ THE ONE SEAM THE LANE TURNS ON IN THE WORKER ONLY (MOTIR-3564). The
    // boundary it stubs is crossed only by the index SUPERVISOR, which is a job,
    // so `tests/e2e/_helpers/job-worker-process.ts` gives the WORKER the flag and
    // no `webServer.env` sets it. (Before MOTIR-5837 the worker installed this
    // one seam by hand; it installs from this table now, like the server.)
    //
    // Setting `MOTIR_AI_URL` + `MOTIR_AI_SERVICE_TOKEN` on the APP server
    // would not be redundant, it would be wrong: `lib/ai/availability.ts`
    // reads exactly that pair process-wide, so it flips the whole lane
    // cloud-on and four specs assert the OFF state against this server.
    flag: 'E2E_TEST_CODE_GRAPH',
    message: 'index-writer seam mocked (run-credential mint + tarball redirect).',
    install: async (agent) => {
      const { installCodeGraphBoundaryMock } = await import('@/lib/test-code-graph-mock');
      installCodeGraphBoundaryMock(agent);
    },
  },
  {
    // A HOSTED RUN's three outbound seams (Story MOTIR-683 · MOTIR-6452): the
    // gateway (mint/revoke the run's model key), motir-ai (the offered-model
    // list, the credit pre-flight, the run's usage and its machine-time
    // charge) and GitHub's repo-level installation read. `hostedRunService`
    // makes the gateway/motir-ai calls from BOTH the webServer (`start`,
    // `cancel`) and the job worker (the stall/backstop end path's revoke +
    // charge, run inside `supervise`'s durable job) — installed here from the
    // one shared table, exactly the fix `lib/test-mock-seams.ts`'s own header
    // describes for the GitHub merge seam.
    flag: 'E2E_TEST_HOSTED_RUN',
    message: 'hosted-run gateway + motir-ai + GitHub installation seams mocked.',
    install: async (agent) => {
      const { installHostedRunMock } = await import('@/lib/test-hosted-run-mock');
      installHostedRunMock(agent);
    },
  },
  {
    // MOTIR-7231 — the console AI planning page's GET / PUT
    // /v1/planner-model-settings. The page is server rendered and writes through
    // a Server Action, so `page.route` reaches neither.
    flag: 'E2E_TEST_PLANNER_MODEL',
    message: 'motir-ai planner-model settings seam mocked.',
    install: async (agent) => {
      const { installPlannerModelBoundaryMock } = await import('@/lib/test-planner-model-mock');
      installPlannerModelBoundaryMock(agent);
    },
  },
  {
    // MOTIR-1413 — the console's planning-lessons pages: the cross-tenant list,
    // a lesson's detail, the three curate acts and the retirement window. All
    // server rendered or Server Actions, so `page.route` reaches none of them.
    flag: 'E2E_TEST_PLATFORM_LESSONS',
    message: 'motir-ai platform planning-lessons seam mocked.',
    install: async (agent) => {
      const { installPlatformLessonsBoundaryMock } =
        await import('@/lib/test-platform-lessons-mock');
      installPlatformLessonsBoundaryMock(agent);
    },
  },
  {
    // Story MOTIR-9359 · MOTIR-9429 — the fake AWS: every `aws` fleet account's
    // EC2 becomes one state file all three lane processes share, behind the REAL
    // AWS adapter and inventory, and the agent-runner switch reads the spec's
    // fixture. Keyed on the state file's PATH, not a `'1'` flag, so it is on
    // exactly where the lane hands a process that path. Ignores the agent.
    flag: 'MOTIR_FAKE_AWS_STATE_PATH',
    message: 'fake AWS (file-backed EC2 behind the real adapter) installed.',
    active: () => Boolean(process.env['MOTIR_FAKE_AWS_STATE_PATH']?.trim()),
    install: async () => {
      const { installFakeAwsSeam } = await import('@/lib/test-fake-aws');
      await installFakeAwsSeam();
    },
  },
];

/** Is `seam` on in THIS process? */
function seamActive(seam: MockSeam): boolean {
  return seam.active ? seam.active() : process.env[seam.flag] === '1';
}

/**
 * Install every seam whose flag is set in THIS process, on ONE shared agent.
 * Returns the flags it installed, in table order; `log` receives each boot line
 * (`<FLAG> active — <message>`) so each process can prefix it with its own tag.
 *
 * The gate reads the SAME table the installs iterate, so every flag that can
 * install something can also open the gate (MOTIR-3244). No flag set ⇒ no
 * agent, and nothing is imported.
 */
export async function installE2EMockSeams(log: (line: string) => void): Promise<string[]> {
  const active = E2E_MOCK_SEAMS.filter(seamActive);
  if (active.length === 0) return [];

  const { installSharedMockAgent } = await import('@/lib/test-mock-agent');
  const agent = installSharedMockAgent();

  for (const seam of active) {
    await seam.install(agent);
    log(`${seam.flag} active — ${seam.message}`);
  }
  return active.map((seam) => seam.flag);
}
