import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';
import { installSharedMockAgent } from '@/lib/test-mock-agent';
import {
  CODELOAD_ORIGIN,
  E2E_INDEX_RUN_CREDENTIAL,
  armMintWithoutCredential,
  clearMintFault,
  codeGraphMockEnabled,
  codeGraphMockJournal,
  E2E_INDEX_PUBLISH_DELAY_MS,
  e2eHeadSha,
  e2eTarballUrl,
  installCodeGraphBoundaryMock,
  resetCodeGraphMockJournal,
} from '@/lib/test-code-graph-mock';
import { codeGraphIndexDispatchService } from '@/lib/services/codeGraphIndexDispatchService';
import { handOffCodeGraphIndex, readCodeGraphIndexStatus } from '@/lib/ai/motirAiClient';
import { githubProvider } from '@/lib/git/providers/github';
import { fakeOrchestrator } from '@motir/orchestrator';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { stubAppCredentials } from '../helpers/indexFleet';
import type { IndexAdmission } from '@/lib/services/codeGraphIndexAdmissionService';

// THE INDEX-WRITER E2E SEAM (Story MOTIR-3417 · Subtask MOTIR-3564).
//
// The seam itself is for Playwright — a lane that runs the product in separate
// processes and therefore cannot use `tests/helpers/indexFleet.ts`'s in-process
// stub. But the two properties it must have are unit-testable, and both are the
// kind that fail SILENTLY in an E2E lane:
//
//   * a run-credential response the client's validator ACCEPTS, and the malformed
//     arm actually failing — a mock that only ever produces the happy path hides
//     the one branch that exists to stop an empty credential reaching a container;
//   * a 302 whose `Location` is what lands in the container spec, with the
//     archive never fetched in-process.
//
// So this drives the REAL `bootIndexContainer` against the mock, exactly as the
// worker will. If this file passes and the spec still cannot boot, the fault is
// in the lane's wiring rather than in the seam.

const ORIGINAL_DISPATCHER: Dispatcher = getGlobalDispatcher();

const AI_ORIGIN = 'http://motir-ai.index-e2e.local';
/** What the lane hands the CONTAINER (MOTIR-4518) — `indexWriterSeamEnv()`'s
 *  `MOTIR_AI_CONTAINER_URL`, kept in step with it. */
const CONTAINER_AI_ORIGIN = 'http://motir-ai-public.index-e2e.local';
const OWNER = 'moooon';
const NAME = 'motir-core';
const REF = 'main';

const ADMISSION: IndexAdmission = {
  slotRef: `p_1:${OWNER}/${NAME}`,
  admittedAt: new Date().toISOString(),
  detail: 'admitted for the seam test',
};

const INPUT = {
  installationId: '990001',
  providerId: 'github' as const,
  organizationId: 'org_1',
  workspaceId: 'ws_1',
  projectId: 'p_1',
  repoOwner: OWNER,
  repoName: NAME,
  repoRef: `${OWNER}/${NAME}`,
  defaultBranch: REF,
  runId: 'run_seam',
  dispatchId: 'evt_seam',
};

/** Put the process in the state the WORKER is in when the lane runs it. */
function armHarness(): void {
  vi.stubEnv('E2E_TEST_CODE_GRAPH', '1');
  vi.stubEnv('E2E_PROD_HARNESS', '1');
  vi.stubEnv('MOTIR_AI_URL', AI_ORIGIN);
  // The CONTAINER's address (MOTIR-4518) — a different value, mirroring
  // `indexWriterSeamEnv()`. In the lane the two differ because the worker and
  // the container are in different places; here they differ so the assertion
  // below can tell them apart.
  vi.stubEnv('MOTIR_AI_CONTAINER_URL', CONTAINER_AI_ORIGIN);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'e2e-index-placeholder-token');
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  // A REAL RSA key pair, because `createAppJwt` has to actually sign — nothing
  // verifies the signature behind the intercept, but the mint would refuse to
  // build one at all without a key. `indexWriterSeamEnv()` generates the lane's
  // equivalent per run.
  stubAppCredentials();
}

function install(): void {
  installCodeGraphBoundaryMock(installSharedMockAgent());
}

beforeEach(() => {
  resetCodeGraphMockJournal();
  clearMintFault();
  fakeOrchestrator.reset();
  _resetInstallationTokenCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  // ⚠️ RESTORE THE DISPATCHER. `setGlobalDispatcher` is process-wide, and a
  // vitest worker runs many files in one process — leaving a MockAgent installed
  // would make the NEXT file's outbound calls fail on an intercept it never
  // registered, several files from anything that mentions this one.
  setGlobalDispatcher(ORIGINAL_DISPATCHER);
  _resetInstallationTokenCache();
});

afterAll(() => {
  setGlobalDispatcher(ORIGINAL_DISPATCHER);
});

describe('the seam is REFUSED outside the harness', () => {
  it('installs nothing when the flag is set but the harness flag is not', () => {
    // ⚠️ THE GATE THAT MATTERS, because `scripts/worker.ts` — SHIPPED code that
    // runs in production — calls this installer. The flag alone would be one
    // environment variable away from installing an HTTP mock in a real worker.
    vi.stubEnv('E2E_TEST_CODE_GRAPH', '1');
    vi.stubEnv('E2E_PROD_HARNESS', '');
    expect(codeGraphMockEnabled()).toBe(false);

    const agent = installSharedMockAgent();
    const spy = vi.spyOn(agent, 'get');
    installCodeGraphBoundaryMock(agent);
    expect(spy, 'no pool may be opened when the harness flag is absent').not.toHaveBeenCalled();
  });

  it('installs nothing when the harness is on but the flag is not', () => {
    vi.stubEnv('E2E_TEST_CODE_GRAPH', '');
    vi.stubEnv('E2E_PROD_HARNESS', '1');
    expect(codeGraphMockEnabled()).toBe(false);
  });

  it('is enabled only when BOTH are set', () => {
    armHarness();
    expect(codeGraphMockEnabled()).toBe(true);
  });
});

describe('the boot path crosses both boundaries and lands their values in the SPEC', () => {
  it("carries the mint's credential and the 302's Location into the container spec", async () => {
    armHarness();
    install();

    const booted = await codeGraphIndexDispatchService.bootIndexContainer(INPUT, ADMISSION);
    expect(booted.phase).toBe('supervising');

    // ⚠️ THE ASSERTION THE SEAM EXISTS FOR. Both values crossed a process
    // boundary in the real lane; here they cross the real client and the real
    // resolver, and land where the container reads them.
    expect(fakeOrchestrator.specs).toHaveLength(1);
    const env = fakeOrchestrator.specs[0]!.env;
    expect(env['MOTIR_INDEX_RUN_CREDENTIAL']).toBe(E2E_INDEX_RUN_CREDENTIAL);
    expect(env['MOTIR_INDEX_TARBALL_URL']).toBe(e2eTarballUrl(OWNER, NAME, REF));
    expect(env['MOTIR_INDEX_REPO_REF']).toBe(`${OWNER}/${NAME}`);
    // ⚠️ THE CONTAINER's address, NOT the worker's (MOTIR-4518). The mint above
    // really went to `AI_ORIGIN` — that is the worker's own transport — and the
    // value that lands in the spec is the other one. The two are different here
    // for the same reason they are different in production.
    expect(env['MOTIR_AI_BASE_URL']).toBe(CONTAINER_AI_ORIGIN);
    expect(env['MOTIR_AI_BASE_URL']).not.toBe(AI_ORIGIN);

    // Both boundaries really were crossed — not short-circuited by a cached
    // token or a fallback.
    const paths = codeGraphMockJournal().map((e) => e.path);
    expect(paths).toContain('/v1/code-graph/run-credential');
    expect(paths).toContain('/app/installations/:id/access_tokens');
    expect(paths.some((p) => p.startsWith(`/repos/${OWNER}/${NAME}/tarball/`))).toBe(true);
  });

  it('NEVER fetches the archive in-process — the byte trap is untouched', async () => {
    armHarness();
    install();

    await codeGraphIndexDispatchService.bootIndexContainer(INPUT, ADMISSION);

    // The §2 OOM, inverted, ported across the process boundary: the pre-signed
    // URL is for the CONTAINER. A hit on the download host would have been
    // journalled and would have failed the request loudly.
    expect(codeGraphMockJournal().map((e) => e.path)).not.toContain('codeload:BYTE-TRAP');
    // And the URL that reached the spec IS a download URL — so "nothing fetched
    // it" is a statement about this process, not about the URL being inert.
    expect(fakeOrchestrator.specs[0]!.env['MOTIR_INDEX_TARBALL_URL']).toContain(CODELOAD_ORIGIN);
  });
});

describe('the MALFORMED mint arm actually fails', () => {
  it('throws rather than booting a container with an empty credential', async () => {
    // ⚠️ A MOCK THAT CAN ONLY PRODUCE THE HAPPY PATH HIDES THIS BRANCH. The
    // client VALIDATES the body precisely because the value lands in a container
    // spec, where an empty credential surfaces as the container blaming the
    // dispatch for a defect in a response one process away.
    armHarness();
    install();
    armMintWithoutCredential();

    await expect(
      codeGraphIndexDispatchService.bootIndexContainer(INPUT, ADMISSION),
    ).rejects.toThrow(/no credential/i);

    // Nothing was provisioned, so nothing is billed for a run that could not have
    // authenticated.
    expect(fakeOrchestrator.specs).toHaveLength(0);
    expect(fakeOrchestrator.provisioned).toHaveLength(0);
    // And the resolver was never reached: the mint is FIRST, deliberately, so the
    // shorter-lived secret's clock starts as late as possible.
    expect(codeGraphMockJournal().map((e) => e.path)).not.toContain(
      '/app/installations/:id/access_tokens',
    );
  });
});

describe('the HANDOFF path crosses its three boundaries (MOTIR-11883)', () => {
  it('answers the live head, accepts the handoff, reads running and then published', async () => {
    armHarness();
    install();

    const head = await githubProvider.resolveRef('990001', OWNER, NAME, REF);
    expect(head).toMatchObject({ outcome: 'resolved', sha: e2eHeadSha(OWNER, NAME) });
    expect(e2eHeadSha(OWNER, NAME)).toMatch(/^[0-9a-f]{40}$/);

    const answer = await handOffCodeGraphIndex({
      coreOrganizationId: 'org_1',
      coreWorkspaceId: 'ws_1',
      coreProjectId: 'p_1',
      repoRef: `${OWNER}/${NAME}`,
      kind: 'refresh',
      commitSha: e2eHeadSha(OWNER, NAME),
      ref: REF,
      sourceUrl: e2eTarballUrl(OWNER, NAME, e2eHeadSha(OWNER, NAME)),
    });
    expect(answer).toMatchObject({ outcome: 'accepted', jobId: expect.any(String) });

    const query = { coreOrganizationId: 'org_1', repoRef: `${OWNER}/${NAME}` };
    const running = await readCodeGraphIndexStatus(query);
    expect(running.inProgressJob).toMatchObject({
      commit: e2eHeadSha(OWNER, NAME),
      kind: 'refresh',
    });
    expect(running.indexedCommit).toBeNull();

    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + E2E_INDEX_PUBLISH_DELAY_MS });
    try {
      const published = await readCodeGraphIndexStatus(query);
      expect(published.indexedCommit?.commit).toBe(e2eHeadSha(OWNER, NAME));
      expect(published.inProgressJob).toBeNull();
    } finally {
      vi.useRealTimers();
    }

    // The journal names the routes, and never the source URL the body carried.
    expect(codeGraphMockJournal().map((e) => e.path)).toEqual(
      expect.arrayContaining([
        '/repos/:owner/:name/commits/:ref',
        '/v1/code-graph/index-handoff',
        '/v1/code-graph/index-status',
      ]),
    );
    expect(JSON.stringify(codeGraphMockJournal())).not.toContain('E2E_PRESIGNED');
  });

  it('a repository nothing was handed for reads published at its head', async () => {
    armHarness();
    install();
    const status = await readCodeGraphIndexStatus({ coreOrganizationId: 'org_1', repoRef: 'a/b' });
    expect(status.indexedCommit?.commit).toBe(e2eHeadSha('a', 'b'));
  });
});
