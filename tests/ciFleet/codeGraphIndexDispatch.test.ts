import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyIndexExit,
  MAX_DISPATCH_ATTEMPTS,
  codeGraphIndexDispatchService,
  indexAdmissionWaitMs,
  indexPollWaitMs,
  INDEX_ADMISSION_BUDGETS,
  INDEX_FLEET_TIME_BUDGETS,
  INITIAL_INDEX_POLL_STATE,
  runCredentialTtlSeconds,
  type IndexDispatchInput,
  type IndexSession,
} from '@/lib/services/codeGraphIndexDispatchService';
import {
  codeGraphIndexAdmissionService,
  indexSlotRef,
  type IndexAdmission,
} from '@/lib/services/codeGraphIndexAdmissionService';
import {
  FLEET_CONTAINER_SIZE,
  OrchestratorApiError,
  OrchestratorImageUnpullableError,
  OrchestratorNotConfiguredError,
  exitCodeOf,
  fakeOrchestrator,
  toFlyMachine,
} from '@motir/orchestrator';
import { RepoTarballUrlNotRedirectedError, RepoTarballUrlUnsupportedError } from '@/lib/git';
import { inMemorySupervisionStore } from '@/lib/jobs/supervision/driver';
import { isJobRunDefer } from '@/lib/jobs/engine/defer';
import { CodeGraphRunCredentialTooShortError, MotirAiUnavailableError } from '@/lib/ai/errors';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken, randomInt } from '../helpers/random';
import { Prisma, type FleetShard } from '@/generated/prisma/client';
import { fakeOrchestratorForShard, resetShardFakes } from '@/lib/orchestrator';
import { SHARD_PAUSE_SECONDS } from '@/lib/ciFleet/shardTargets';
import { fleetShardOrchestratorService } from '@/lib/services/fleetShardOrchestratorService';
import { buildFleetCostReadout, type FleetCostReadout } from '../../scripts/fleetCostReadoutQuery';

/**
 * What a container that never started is measured at (MOTIR-4545): ZERO billable
 * seconds, and it still COUNTS as a container on the `index` line.
 *
 * ⚠️ THE ZERO IS A MEASUREMENT HERE, NOT A PLACEHOLDER. The provider never reported
 * a start, so there is no running interval to bill — `buildContainerAccrual`
 * measures from `startedAt`, and a teardown with none has nothing to measure. The
 * container still occupied a slot and a provision call, which is why it is counted.
 * Read off the rehearsal's own run and pinned, so a change in how that path is
 * metered is a decision in a diff rather than a drift.
 */
const NEVER_STARTED_BILLABLE_SECONDS = 0;

// THE INDEX DISPATCH SERVICE (Story MOTIR-1981 · MOTIR-2026) —
// `docs/decisions/code-graph-index-fleet.md` §2 · §4 · §5 · §10.
//
// ⚠️ MOST OF THIS FILE ASSERTS NEGATIVES, and that is the shape of the card. The
// spec is the fleet's isolation boundary (§4: "credential scope, not org count"),
// so what a container does NOT hold is the property worth testing: a fifth
// environment variable, a GitHub token, a database URL, an object-storage
// credential or a Fly token in a container that ingests untrusted source is the
// failure this suite exists to catch — and none of them would fail any test that
// only asserted the four expected values were present.
//
// The whole path runs on the `fake` orchestrator. No test needs Fly, and — per
// the OOM this architecture removes (§2, `motir-core`, 5/5 attempts) — no test
// buffers a repo tarball: the fake tarball response below makes reading its body
// a LOUD failure rather than a silent cost.

const TARBALL_URL =
  'https://codeload.github.com/moooon-B-V/motir-core/legacy.tar.gz/refs/heads/main' +
  '?token=PRESIGNED&X-Amz-Expires=300';
const RUN_CREDENTIAL = 'mrc1.payload.signature';
/** The third pre-signed URL (MOTIR-3252) — the PREVIOUS snapshot, when there is one. */
const SNAPSHOT_URL =
  'https://fly.storage.tigris.dev/bucket/codegraph/ai-proj/moooon-B-V_motir-core/abc.db.gz' +
  '?X-Amz-Signature=PRESIGNED&X-Amz-Expires=1800';
const AI_URL = 'https://ai.example.test';
/**
 * The address the CONTAINER is given (MOTIR-4518) — deliberately DIFFERENT from
 * `AI_URL`, which is the address motir-core itself uses. In production they are
 * different because the two callers sit in different organizations, and a suite
 * that stubbed one value for both could not tell a correct dispatcher from the
 * one that shipped.
 */
const CONTAINER_AI_URL = 'https://ai-public.example.test';
const SERVICE_TOKEN = 'svc-token-must-never-reach-a-container';
const INSTALLATION_TOKEN = 'ghs_installation_must_never_reach_a_container';
const DATABASE_URL = 'postgres://motir:secret@db.example.test/motir';

const INPUT: IndexDispatchInput = {
  installationId: '556677',
  providerId: 'github',
  organizationId: 'org-1',
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  repoOwner: 'moooon-B-V',
  repoName: 'motir-core',
  repoRef: 'moooon-B-V/motir-core',
  defaultBranch: 'main',
  runId: 'run-abc',
  dispatchId: 'evt-abc',
};

/** Millisecond deadlines, so a whole supervised run is a few ticks. */
const FAST = {
  bootDeadlineMs: 50,
  indexTimeoutMs: 500,
  pollIntervalMs: 1,
  maxPollIntervalMs: 1,
  admissionWaitMs: 1,
  maxAdmissionWaitMs: 1,
} as const;

/**
 * A GRANTED admission — the ticket MOTIR-1990 makes `bootIndexContainer` require.
 *
 * ⚠️ THE GATE ITSELF IS STUBBED IN THIS FILE, and that is the file boundary
 * rather than a shortcut. The admission cap is a locked decision whose whole
 * content is what happens when TRANSACTIONS RACE, so it has its own suite
 * (`codeGraphIndexAdmission.test.ts`) that races real ones at it. THIS suite is
 * about the spec, the exit taxonomy, the supervision loop and the COGS meter —
 * so it supplies the ticket and asserts the one thing the gate cannot see from
 * its own side: that every path leaving NO CONTAINER BEHIND gives the slot back.
 */
const ADMISSION: IndexAdmission = {
  slotRef: indexSlotRef('proj-1', 'moooon-B-V/motir-core'),
  admittedAt: '2026-08-03T12:00:00.000Z',
  detail: 'granted by the test',
};

/** The slot releases this dispatch performed — `<slotRef>` and the run that
 *  claimed to own it, because WHO releases is now half the contract (MOTIR-2160). */
let released: string[] = [];
let releasedBy: Array<{ slotRef: string; dispatchId: string }> = [];

/** The ticket for one dispatch input — the slot ref the gate would have granted
 *  for that (repo × project), so a stubbed grant still names the real key. */
function admissionFor(input: IndexDispatchInput): IndexAdmission {
  return {
    slotRef: indexSlotRef(input.projectId, input.repoRef),
    admittedAt: ADMISSION.admittedAt,
    detail: 'granted by the test',
  };
}

interface Call {
  url: string;
  method: string;
  body: unknown;
}

let calls: Call[] = [];
let credentialResponder: (body: unknown) => Response;
let tarballResponder: () => Response;
let tarballBodyTouched = false;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** GitHub's 302 to the pre-signed codeload URL, with a body that CANNOT be read
 *  without failing the test — the §2 OOM asserted as a negative. */
function redirectResponse(): Response {
  const res = new Response(null, { status: 302, headers: { location: TARBALL_URL } });
  const trap = (name: string) => () => {
    tarballBodyTouched = true;
    throw new Error(`the dispatch read the tarball body via ${name}()`);
  };
  for (const name of ['arrayBuffer', 'blob', 'text', 'json'] as const) {
    Object.defineProperty(res, name, { value: trap(name) });
  }
  return res;
}

/**
 * motir-ai's mint, INCLUDING ITS CLAMP (MOTIR-4923).
 *
 * ⚠️ IT HONOURS `ttlSeconds`, and it defaults to FIFTEEN MINUTES when the field
 * is absent — `motir-ai` `src/codegraph/runCredential.ts`'s
 * `DEFAULT_TTL_SECONDS` / `clampTtlSeconds`, transcribed. Until this card the
 * fixture returned a flat fifteen minutes whatever it was asked for, which is
 * exactly the shape that made the production defect untestable here: the
 * dispatch sent no TTL, the fixture answered with the default, and both halves
 * of a mismatch that only bites past fifteen minutes looked identical.
 */
const AI_DEFAULT_TTL_SECONDS = 15 * 60;
const AI_MIN_TTL_SECONDS = 60;
const AI_MAX_TTL_SECONDS = 60 * 60;

function credentialResponse(body: unknown): Response {
  const requested = (body as { ttlSeconds?: unknown } | null)?.ttlSeconds;
  const ttl =
    typeof requested === 'number' && Number.isFinite(requested)
      ? Math.min(AI_MAX_TTL_SECONDS, Math.max(AI_MIN_TTL_SECONDS, Math.floor(requested)))
      : AI_DEFAULT_TTL_SECONDS;
  return json(201, {
    credential: RUN_CREDENTIAL,
    expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
  });
}

function motirAiCalls(): Call[] {
  return calls.filter((c) => new URL(c.url).host === new URL(AI_URL).host);
}

/** Drive a whole run to completion: the container exits with `exitCode` on the
 *  first wait, exactly as a real one would while supervision sleeps. */
function completeWith(exitCode: number | null) {
  return async () => {
    const live = fakeOrchestrator.liveContainerIds();
    if (live[0]) fakeOrchestrator.completeJob(live[0], { exitCode });
  };
}

beforeEach(() => {
  fakeOrchestrator.reset();
  calls = [];
  tarballBodyTouched = false;
  credentialResponder = credentialResponse;
  tarballResponder = redirectResponse;
  released = [];
  releasedBy = [];
  vi.spyOn(codeGraphIndexAdmissionService, 'admit').mockResolvedValue({
    outcome: 'admitted',
    admission: ADMISSION,
    census: {
      total: 1,
      byWorkload: { ci_runner: 0, code_graph_index: 1, hosted_agent: 0, agent_instance: 0 },
    },
  });
  vi.spyOn(codeGraphIndexAdmissionService, 'release').mockImplementation(
    async (slotRef, dispatchId) => {
      released.push(slotRef);
      releasedBy.push({ slotRef, dispatchId });
      return true;
    },
  );

  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  // The tarball-URL resolve mints an INSTALLATION token with the user-facing
  // App — the same credential today's in-function fetch uses. It never leaves
  // this process; that is the §10 property the spec assertions below pin.
  vi.stubEnv('GITHUB_APP_ID', '4242');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
  vi.stubEnv('MOTIR_AI_URL', AI_URL);
  vi.stubEnv('MOTIR_AI_CONTAINER_URL', CONTAINER_AI_URL);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', SERVICE_TOKEN);
  vi.stubEnv('DATABASE_URL', DATABASE_URL);
  // Select the FAKE adapter the way a deployment selects Fly.
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  _resetInstallationTokenCache();

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const call: Call = {
        url: String(url),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      };
      calls.push(call);
      // Matched on the parsed URL, never `includes()` — a substring host check is
      // a HIGH CodeQL alert in this repo, test fixtures included.
      const parsed = new URL(call.url);
      if (parsed.host === new URL(AI_URL).host) return credentialResponder(call.body);
      if (parsed.pathname.endsWith('/access_tokens')) {
        return json(201, {
          token: INSTALLATION_TOKEN,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      if (parsed.pathname.includes('/tarball/')) return tarballResponder();
      throw new Error(`unexpected fetch: ${call.method} ${call.url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ── The spec, which is the security boundary ───────────────────────────────

describe('buildIndexSpec — the container gets the image its boot contract names, and nothing else', () => {
  const SPEC_ARGS = {
    target: INPUT,
    fleet: { image: 'motir/indexer@sha256:abc', region: 'ams' },
    aiBaseUrl: CONTAINER_AI_URL,
    tarballUrl: TARBALL_URL,
    runCredential: RUN_CREDENTIAL,
    timeoutSeconds: 1800,
  };

  it('emits EXACTLY the four variables the image boots on', () => {
    const spec = codeGraphIndexDispatchService.buildIndexSpec(SPEC_ARGS);

    // ⚠️ THE KEY SET, not the four values. A test that only asserted each
    // expected variable is present would pass just as happily with a fifth one
    // beside them — and the fifth is how a token reaches a container that
    // ingests untrusted source. Adding a variable must come past this line.
    expect(Object.keys(spec.env).sort()).toEqual([
      'MOTIR_AI_BASE_URL',
      'MOTIR_INDEX_REPO_REF',
      'MOTIR_INDEX_RUN_CREDENTIAL',
      'MOTIR_INDEX_TARBALL_URL',
    ]);
    expect(spec.env).toEqual({
      MOTIR_INDEX_TARBALL_URL: TARBALL_URL,
      MOTIR_INDEX_REPO_REF: 'moooon-B-V/motir-core',
      MOTIR_AI_BASE_URL: CONTAINER_AI_URL,
      MOTIR_INDEX_RUN_CREDENTIAL: RUN_CREDENTIAL,
    });
  });

  // ── The FIFTH variable, which came past the line above (MOTIR-3252) ────────

  it('adds MOTIR_INDEX_SNAPSHOT_URL — and ONLY that — when motir-ai offered one', () => {
    // The key-set assertion above is the guard this had to pass, so it is
    // re-asserted here in its widened form rather than relaxed: exactly five keys,
    // and the fifth is another PRE-SIGNED URL. A container that ingests untrusted
    // source gains no credential class from this — one object, one method, minutes
    // — and every absence the doc comment lists is still an absence.
    const spec = codeGraphIndexDispatchService.buildIndexSpec({
      ...SPEC_ARGS,
      previousSnapshotUrl: SNAPSHOT_URL,
    });

    expect(Object.keys(spec.env).sort()).toEqual([
      'MOTIR_AI_BASE_URL',
      'MOTIR_INDEX_REPO_REF',
      'MOTIR_INDEX_RUN_CREDENTIAL',
      'MOTIR_INDEX_SNAPSHOT_URL',
      'MOTIR_INDEX_TARBALL_URL',
    ]);
    expect(spec.env['MOTIR_INDEX_SNAPSHOT_URL']).toBe(SNAPSHOT_URL);
  });

  it('OMITS the variable entirely when there is none — never an empty string', () => {
    // An empty value would boot a container that believes it was handed a
    // snapshot and then fails to fetch it — trading a fast path for a slow path
    // WITH a spurious failure in the log. Absent is the first-index case, the
    // pruned case and the engine-version-bump case, and all three mean "build the
    // whole tree", which is what this container did before any of this existed.
    for (const previous of [undefined, '']) {
      const spec = codeGraphIndexDispatchService.buildIndexSpec({
        ...SPEC_ARGS,
        ...(previous === undefined ? {} : { previousSnapshotUrl: previous }),
      });
      expect(spec.env['MOTIR_INDEX_SNAPSHOT_URL']).toBeUndefined();
      expect(Object.keys(spec.env)).toHaveLength(4);
    }
  });

  it('tags the workload and carries NO workflow job — an index container has none', () => {
    const spec = codeGraphIndexDispatchService.buildIndexSpec(SPEC_ARGS);
    expect(spec.workload).toBe('code_graph_index');
    expect(spec.workflowJobId).toBeNull();
  });

  it('books the priced fleet machine class and the deployment image/region', () => {
    const spec = codeGraphIndexDispatchService.buildIndexSpec(SPEC_ARGS);
    expect(spec.size).toEqual(FLEET_CONTAINER_SIZE);
    expect(spec.image).toBe('motir/indexer@sha256:abc');
    expect(spec.region).toBe('ams');
    expect(spec.timeoutSeconds).toBe(1800);
    // Attribution rides on the spec so a usage row is readable without a join.
    expect(spec).toMatchObject({
      orgId: 'org-1',
      workspaceId: 'ws-1',
      projectId: 'proj-1',
      repoFullName: 'moooon-B-V/motir-core',
    });
  });

  it('reads NO environment of its own — the same arguments produce the same spec', () => {
    const first = codeGraphIndexDispatchService.buildIndexSpec(SPEC_ARGS);
    vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'a-different-token');
    vi.stubEnv('MOTIR_INDEXER_IMAGE', 'motir/indexer@sha256:something-else');
    expect(codeGraphIndexDispatchService.buildIndexSpec(SPEC_ARGS)).toEqual(first);
  });
});

describe('the booted spec carries no credential the container has no use for', () => {
  it('holds no GitHub token, no database URL, no object-storage or Fly credential', async () => {
    vi.stubEnv('FLY_FLEET_API_TOKEN', 'fly-token-must-never-reach-a-container');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'object-store-secret');

    const booted = await codeGraphIndexDispatchService.bootIndexContainer(INPUT, ADMISSION, FAST);
    expect(booted.phase).toBe('supervising');

    const spec = fakeOrchestrator.specs[0]!;
    // The env SET is already pinned above; this is the same guarantee stated in
    // the units an operator worries about — the actual secret VALUES this
    // process holds, none of which may appear anywhere in the spec.
    const serialized = JSON.stringify(spec);
    for (const secret of [
      INSTALLATION_TOKEN,
      SERVICE_TOKEN,
      DATABASE_URL,
      'fly-token-must-never-reach-a-container',
      'object-store-secret',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    // The one motir-ai credential it DOES hold is the run-scoped one.
    expect(spec.env['MOTIR_INDEX_RUN_CREDENTIAL']).toBe(RUN_CREDENTIAL);
    expect(tarballBodyTouched).toBe(false);
  });
});

// ── The address the container is GIVEN (MOTIR-4518) ────────────────────────
//
// ⚠️ THIS IS THE CARD'S CENTRAL ASSERTION, and it is a NEGATIVE about a value
// rather than about a key. The env KEY set above has been pinned since
// MOTIR-2026 and was correct throughout: `MOTIR_AI_BASE_URL` was present, spelled
// right, and carried a well-formed URL. What was wrong was WHICH url — the one
// motir-core reaches motir-ai at, over a private 6PN address scoped to
// motir-core's own Fly organization, handed to a machine that runs in the
// FLEET's organization, where the name does not exist. Every index run from
// 2026-08-21 booted, downloaded the repository, spent nineteen minutes building
// a 45 MB graph and then died on
// `getaddrinfo ENOTFOUND motir-ai.internal` at the upload grant.
//
// So the two variables are stubbed to DIFFERENT values in this suite, and these
// tests read the difference. A dispatcher that calls `motirAiBaseUrl()`, that
// falls back to it, or that reads `MOTIR_AI_URL` directly fails here.

describe("the container is handed its OWN motir-ai address, never motir-core's", () => {
  it('puts MOTIR_AI_CONTAINER_URL in the spec while the MINT goes to MOTIR_AI_URL', async () => {
    const booted = await codeGraphIndexDispatchService.bootIndexContainer(INPUT, ADMISSION, FAST);
    expect(booted.phase).toBe('supervising');

    const spec = fakeOrchestrator.specs[0]!;
    // The container's address: the public one.
    expect(spec.env['MOTIR_AI_BASE_URL']).toBe(CONTAINER_AI_URL);
    // motir-core's OWN transport is untouched and still on the private seam —
    // the half of the fix that is a refusal to change something (MOTIR-3277).
    expect(motirAiCalls()).toHaveLength(1);
    expect(motirAiCalls()[0]!.url).toBe(`${AI_URL}/v1/code-graph/run-credential`);
    // And the two are genuinely different values, so the assertion above cannot
    // be satisfied by accident.
    expect(spec.env['MOTIR_AI_BASE_URL']).not.toBe(AI_URL);
  });

  it('REFUSES to boot when MOTIR_AI_CONTAINER_URL is unset — no silent fallback, no machine', async () => {
    // ⚠️ THE ARM THAT MAKES THE DEFECT UNREPEATABLE. With a fallback this
    // deployment boots a container that cannot reach motir-ai and burns a
    // nineteen-minute machine to find out; without one it costs a throw before
    // anything is provisioned. `MOTIR_AI_URL` is left perfectly well set, which
    // is exactly the state a fallback would have been happy with.
    vi.stubEnv('MOTIR_AI_CONTAINER_URL', '');

    await expect(
      codeGraphIndexDispatchService.bootIndexContainer(INPUT, ADMISSION, FAST),
    ).rejects.toThrow('MOTIR_AI_CONTAINER_URL');

    // Nothing was provisioned, nothing was minted, and — the invariant every
    // failure path in this function owes — the admission slot went back.
    expect(fakeOrchestrator.provisioned).toHaveLength(0);
    expect(motirAiCalls()).toHaveLength(0);
    expect(released).toEqual([ADMISSION.slotRef]);
  });
});

// ── Boot ───────────────────────────────────────────────────────────────────

describe('bootIndexContainer — mint, resolve, boot; a fixed handful of calls', () => {
  it('mints the credential for THIS (project, repoRef, run) and boots one container', async () => {
    const booted = await codeGraphIndexDispatchService.bootIndexContainer(INPUT, ADMISSION, FAST);
    if (booted.phase !== 'supervising') throw new Error('expected a supervising boot');

    expect(motirAiCalls()).toHaveLength(1);
    expect(motirAiCalls()[0]!.url).toBe(`${AI_URL}/v1/code-graph/run-credential`);
    expect(motirAiCalls()[0]!.body).toEqual({
      coreOrganizationId: 'org-1',
      coreWorkspaceId: 'ws-1',
      coreProjectId: 'proj-1',
      repoRef: 'moooon-B-V/motir-core',
      runId: 'run-abc',
      // Derived from THIS dispatch's own container deadline (MOTIR-4923), never
      // left to motir-ai's default.
      ttlSeconds: runCredentialTtlSeconds(FAST.indexTimeoutMs),
    });
    expect(fakeOrchestrator.provisioned).toHaveLength(1);

    // JSON-SERIALIZABLE BY CONTRACT: it crosses a step boundary, so every instant
    // is an ISO string. A `Date` here survives the first pass and arrives as a
    // string on every replayed one.
    expect(JSON.parse(JSON.stringify(booted.session))).toEqual(booted.session);
    expect(typeof booted.session.handle.createdAt).toBe('string');
    expect(typeof booted.session.bootedAt).toBe('string');
    expect(booted.session.attribution).toEqual({
      orgId: 'org-1',
      workspaceId: 'ws-1',
      projectId: 'proj-1',
      repoFullName: 'moooon-B-V/motir-core',
    });
  });

  it('FAILS LOUDLY with the typed not-configured error, and never looks like a success', async () => {
    // A real deployment that selected Fly and wired nothing. The silent
    // alternative — "nothing to do" — is what lets a `succeeded` job_run claim a
    // repo nothing indexed, forever, to every reader of the ledger (§5).
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', '');
    vi.stubEnv('FLY_FLEET_APP', '');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', '');
    vi.stubEnv('MOTIR_INDEXER_IMAGE', '');

    await expect(
      codeGraphIndexDispatchService.bootIndexContainer(INPUT, ADMISSION, FAST),
    ).rejects.toThrow(OrchestratorNotConfiguredError);
    // It refused BEFORE spending anything: no credential minted, no container.
    expect(motirAiCalls()).toHaveLength(0);
    expect(fakeOrchestrator.provisioned).toHaveLength(0);
  });

  it('fails the dispatch when the credential cannot be minted — there is NO fallback token', async () => {
    credentialResponder = () =>
      json(503, { type: 'about:blank', title: 'unavailable', status: 503 });

    await expect(
      codeGraphIndexDispatchService.bootIndexContainer(INPUT, ADMISSION, FAST),
    ).rejects.toThrow(MotirAiUnavailableError);
    // ⚠️ THE POINT OF THE TEST. Not merely "it threw": NO container was booted,
    // so no spec exists that could have carried `MOTIR_AI_SERVICE_TOKEN` or any
    // broader identity in the credential's place.
    expect(fakeOrchestrator.provisioned).toHaveLength(0);
    expect(fakeOrchestrator.specs).toHaveLength(0);
  });

  it('fails the dispatch when the tarball URL cannot be resolved — never falls back to the bytes', async () => {
    // A 200 would mean the host served the BYTES instead of a redirect, which is
    // the one outcome the seam exists to avoid.
    tarballResponder = () => new Response(null, { status: 200 });

    await expect(
      codeGraphIndexDispatchService.bootIndexContainer(INPUT, ADMISSION, FAST),
    ).rejects.toThrow(RepoTarballUrlNotRedirectedError);
    expect(fakeOrchestrator.provisioned).toHaveLength(0);
  });

  it('refuses a host with no self-authorizing archive URL rather than downloading the repo', async () => {
    await expect(
      codeGraphIndexDispatchService.bootIndexContainer(
        { ...INPUT, providerId: 'gitlab' },
        ADMISSION,
        FAST,
      ),
    ).rejects.toThrow(RepoTarballUrlUnsupportedError);
    expect(fakeOrchestrator.provisioned).toHaveLength(0);
  });

  // ── The two deadlines are ONE decision (Bug MOTIR-4923) ──────────────────
  //
  // The container's hard kill and the credential's expiry are set in two
  // different repositories, and until this card nothing joined them: the mint
  // carried no `ttlSeconds`, so motir-ai's fifteen-minute default applied to a
  // container this side permits thirty minutes. The failure is DETERMINISTIC BY
  // REPOSITORY SIZE, which is why it survived 830 runs and every test here — a
  // repo that indexes in two minutes cannot exhibit it.

  it('asks for a credential that OUTLIVES the container deadline it is about to grant', async () => {
    const booted = await codeGraphIndexDispatchService.bootIndexContainer(INPUT, ADMISSION, FAST);
    if (booted.phase !== 'supervising') throw new Error('expected a supervising boot');

    // The derivation, not a number typed twice: the request is the container's
    // own timeout plus the grace, and it is the SAME function the service uses.
    expect((motirAiCalls()[0]!.body as { ttlSeconds: number }).ttlSeconds).toBe(
      runCredentialTtlSeconds(FAST.indexTimeoutMs),
    );

    // And the property that actually matters, asserted against the session the
    // supervision loop will run on: the credential is still valid at the last
    // second the container is allowed to work.
    const deadline = Date.parse(booted.session.bootedAt) + FAST.indexTimeoutMs;
    expect(Date.parse(booted.session.credentialExpiresAt)).toBeGreaterThan(deadline);
  });

  it('derives the TTL from the REAL budget too — 30 minutes of container needs more than motir-ai default', () => {
    // The production fixture as arithmetic. `moooon-B-V/motir-core` ran 19 m 52 s
    // against a credential minted for 15 m 00 s (2026-09-08T22:31:33Z), and the
    // ONLY reason it was 15 minutes is that nobody asked for anything else.
    const ttl = runCredentialTtlSeconds(INDEX_FLEET_TIME_BUDGETS.indexTimeoutMs);
    expect(ttl * 1000).toBeGreaterThan(INDEX_FLEET_TIME_BUDGETS.indexTimeoutMs);
    expect(ttl).toBeGreaterThan(AI_DEFAULT_TTL_SECONDS);
    // Still inside motir-ai's own ceiling, so the clamp cannot silently shorten
    // it — the case the assertion below exists to catch if that ever changes.
    expect(ttl).toBeLessThanOrEqual(AI_MAX_TTL_SECONDS);
  });

  it('REFUSES to boot when the minted credential expires before the container deadline', async () => {
    // A motir-ai that ignores `ttlSeconds` — an older deploy, or one whose
    // ceiling has fallen below our timeout. This is the production defect
    // exactly, and the point of the test is WHEN it is caught: before a machine
    // exists, rather than 20 minutes and 1 193 billable seconds later as an
    // exit-`50` `credential_refused` nobody can tell from a scope refusal.
    credentialResponder = () =>
      json(201, {
        credential: RUN_CREDENTIAL,
        expiresAt: new Date(Date.now() + AI_DEFAULT_TTL_SECONDS * 1000).toISOString(),
      });

    await expect(
      codeGraphIndexDispatchService.bootIndexContainer(INPUT, ADMISSION, {
        ...FAST,
        indexTimeoutMs: INDEX_FLEET_TIME_BUDGETS.indexTimeoutMs,
      }),
    ).rejects.toThrow(CodeGraphRunCredentialTooShortError);

    // Nothing was booted, and the slot went back — the invariant every failure
    // path in this function owes.
    expect(fakeOrchestrator.provisioned).toHaveLength(0);
    expect(fakeOrchestrator.specs).toHaveLength(0);
    expect(released).toEqual([ADMISSION.slotRef]);
  });

  it('REFUSES an unparseable expiry rather than treating it as unlimited', async () => {
    credentialResponder = () => json(201, { credential: RUN_CREDENTIAL, expiresAt: 'soon' });

    await expect(
      codeGraphIndexDispatchService.bootIndexContainer(INPUT, ADMISSION, FAST),
    ).rejects.toThrow(CodeGraphRunCredentialTooShortError);
    expect(fakeOrchestrator.provisioned).toHaveLength(0);
    expect(released).toEqual([ADMISSION.slotRef]);
  });

  it('reports a terminal outcome when the provider refuses, leaving no container', async () => {
    fakeOrchestrator.failNextProvision('the fake refused');
    const booted = await codeGraphIndexDispatchService.bootIndexContainer(INPUT, ADMISSION, FAST);

    expect(booted).toMatchObject({ phase: 'terminal', outcome: { outcome: 'provision_failed' } });
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
  });

  it('names an unpullable image as its own condition, not one more provider 400', async () => {
    // The remedy is categorically different from every other boot failure: a
    // human fixes visibility, a digest or the mirror, and every queued index hits
    // it identically.
    vi.spyOn(fakeOrchestrator, 'provision').mockRejectedValueOnce(
      new OrchestratorImageUnpullableError(
        'fake',
        400,
        'motir/indexer@sha256:gone',
        'unauthorized',
      ),
    );
    const booted = await codeGraphIndexDispatchService.bootIndexContainer(INPUT, ADMISSION, FAST);

    expect(booted).toMatchObject({ phase: 'terminal', outcome: { outcome: 'image_unpullable' } });
    if (booted.phase !== 'terminal' || booted.outcome.outcome !== 'image_unpullable') {
      throw new Error('expected an image_unpullable outcome');
    }
    expect(booted.outcome.detail).toContain('could not be pulled');
  });
});

// ── The admission slot's LIFETIME (MOTIR-1990) ─────────────────────────────

describe('the admission slot is held for exactly as long as a container exists', () => {
  // The whole reason `bootIndexContainer` takes the ticket rather than looking
  // it up: it is the function that knows whether a container was left behind, so
  // it is the only one that can decide whether capacity may go back.
  it('carries the slot onto the SESSION, so a later step can release it', async () => {
    const booted = await codeGraphIndexDispatchService.bootIndexContainer(INPUT, ADMISSION, FAST);
    if (booted.phase !== 'supervising') throw new Error('expected to be supervising');

    expect(booted.session.slotRef).toBe(ADMISSION.slotRef);
    // Still serializable — the slot ref crosses a step boundary with the session.
    expect(JSON.parse(JSON.stringify(booted.session))).toEqual(booted.session);
    // Nothing released while the container is alive.
    expect(released).toEqual([]);
  });

  // ⚠️ THE LEAK CLASS THIS CLOSES. Every one of these leaves NO container, so
  // holding capacity for it would shrink the fleet by one for the slot's whole
  // TTL — and a deployment failing every boot would shrink it to nothing while
  // booting nothing at all.
  it.each([
    [
      'a credential that cannot be minted',
      () => {
        credentialResponder = () => json(503, { title: 'unavailable', status: 503 });
      },
    ],
    [
      'a tarball URL that cannot be resolved',
      () => {
        tarballResponder = () => new Response(null, { status: 200 });
      },
    ],
  ])('gives the slot back when the boot throws on %s', async (_label, arrange) => {
    arrange();

    await expect(
      codeGraphIndexDispatchService.bootIndexContainer(INPUT, ADMISSION, FAST),
    ).rejects.toThrow();

    expect(released).toEqual([ADMISSION.slotRef]);
    expect(fakeOrchestrator.provisioned).toHaveLength(0);
  });

  it('gives the slot back when the provider refuses to provision', async () => {
    fakeOrchestrator.failNextProvision('the fake refused');

    await codeGraphIndexDispatchService.bootIndexContainer(INPUT, ADMISSION, FAST);

    expect(released).toEqual([ADMISSION.slotRef]);
  });

  it('gives the slot back once the container is torn down', async () => {
    const outcome = await codeGraphIndexDispatchService.runIndexContainer(INPUT, {
      ...FAST,
      sleep: completeWith(0),
    });

    expect(outcome.outcome).toBe('settled');
    expect(released).toEqual([ADMISSION.slotRef]);
  });

  // ⚠️ THE ONE DIRECTION THE CEILING MUST NEVER ERR IN. A failed teardown means
  // the container MAY STILL BE RUNNING and still spending, so its slot stays and
  // ages out through `expires_at` while the reaper works. Releasing here would
  // under-count a live container.
  it('does NOT release when the teardown failed — the container may still be running', async () => {
    fakeOrchestrator.failNextTeardown('the fake refused to tear down');

    const outcome = await codeGraphIndexDispatchService.runIndexContainer(INPUT, {
      ...FAST,
      sleep: completeWith(0),
    });

    expect(outcome.outcome).toBe('teardown_failed');
    expect(released).toEqual([]);
  });

  // ⚠️ AND IT RELEASES AS ITSELF (MOTIR-2160). The slot ref names a
  // (repo × project), not a run, so the release only frees THIS container's
  // capacity if it also says who is asking — the run the session was booted for.
  // `codeGraphIndexAdmission.test.ts` proves the gate enforces it; this is the
  // wiring half, that the dispatch actually passes it.
  it('names its OWN dispatch on every release, so it can only free its own slot', async () => {
    const outcome = await codeGraphIndexDispatchService.runIndexContainer(INPUT, {
      ...FAST,
      sleep: completeWith(0),
    });

    expect(outcome.outcome).toBe('settled');
    expect(releasedBy).toEqual([{ slotRef: ADMISSION.slotRef, dispatchId: INPUT.dispatchId }]);
  });

  it('names its own dispatch on the FAILED-BOOT releases too', async () => {
    fakeOrchestrator.failNextProvision('the fake refused');

    await codeGraphIndexDispatchService.bootIndexContainer(INPUT, ADMISSION, FAST);

    expect(releasedBy).toEqual([{ slotRef: ADMISSION.slotRef, dispatchId: INPUT.dispatchId }]);
  });

  // The gate is asked as this run too — the request the ticket is granted against
  // is what the ownership test on the other side reads.
  it('asks for admission AS its own dispatch', async () => {
    await codeGraphIndexDispatchService.admitIndexContainer(INPUT, FAST);

    expect(codeGraphIndexAdmissionService.admit).toHaveBeenCalledWith(
      expect.objectContaining({ dispatchId: INPUT.dispatchId, projectId: 'proj-1' }),
    );
  });
});

// ── Over the cap means WAIT, never drop (MOTIR-1990) ───────────────────────

describe('the in-process composition QUEUES for admission rather than dropping', () => {
  it('retries a deferred admission and boots as soon as capacity frees', async () => {
    const admit = vi.mocked(codeGraphIndexAdmissionService.admit);
    admit
      .mockResolvedValueOnce({
        outcome: 'deferred',
        reason: 'org_index_cap',
        detail: 'the organization is at its index cap (3/3, half of the global 6)',
      })
      .mockResolvedValueOnce({
        outcome: 'deferred',
        reason: 'index_cap',
        detail: 'indexing is at its global cap (6/6)',
      });

    const outcome = await codeGraphIndexDispatchService.runIndexContainer(INPUT, {
      ...FAST,
      sleep: completeWith(0),
    });

    // It waited twice and then ran. Nothing was dropped and nothing failed.
    expect(admit).toHaveBeenCalledTimes(3);
    expect(outcome).toMatchObject({ outcome: 'settled', verdict: { indexed: true } });
  });

  // A gate that failed CLOSED is a transient the caller must be allowed to
  // recover from — refusing to wait on it would turn one bad read into a dropped
  // index, which is the outcome the rule exists to forbid.
  it('waits through a fail-CLOSED gate too, then proceeds', async () => {
    vi.mocked(codeGraphIndexAdmissionService.admit).mockResolvedValueOnce({
      outcome: 'deferred',
      reason: 'gate_unavailable',
      detail: 'the index in-flight counts could not be established: connection reset',
    });

    const outcome = await codeGraphIndexDispatchService.runIndexContainer(INPUT, {
      ...FAST,
      sleep: completeWith(0),
    });

    expect(outcome.outcome).toBe('settled');
  });

  // ⚠️ AND WHEN THE BUDGET RUNS OUT IT FAILS LOUDLY — it does not quietly return
  // a success. §6: a `succeeded` row carrying an `output.repoRef` is a permanent
  // claim to every reader that the repo has a code graph.
  it('reports admission_deferred — never a settled run — when the wait is exhausted', async () => {
    vi.mocked(codeGraphIndexAdmissionService.admit).mockResolvedValue({
      outcome: 'deferred',
      reason: 'fleet_ceiling',
      detail: 'the fleet is at its in-flight ceiling (24/24: CI runners 24)',
    });

    const outcome = await codeGraphIndexDispatchService.runIndexContainer(INPUT, {
      ...FAST,
      maxAdmissionAttempts: 3,
    });

    expect(outcome).toMatchObject({ outcome: 'admission_deferred', reason: 'fleet_ceiling' });
    expect((outcome as { detail: string }).detail).toContain('refused for 3 attempts');
    // NOTHING was booted, and no capacity is held for a container that does not
    // exist.
    expect(fakeOrchestrator.provisioned).toHaveLength(0);
    expect(released).toEqual([]);
  });

  // ⚠️ MOTIR-8235: AN ORGANISATION WITH NO PAID AI PLAN IS AN ANSWER, NOT A FULL
  // LANE. Waiting sixty attempts on it changed nothing and ended in an
  // `IndexDispatchFailedError` the monitor filed as a production error. One ask,
  // no wait, nothing booted.
  it('returns an ai_plan_required refusal on the FIRST ask, without waiting', async () => {
    vi.mocked(codeGraphIndexAdmissionService.admit).mockResolvedValue({
      outcome: 'deferred',
      reason: 'ai_plan_required',
      detail: "This organization has no paid AI plan, so its CI does not run on Motir's runners.",
    });
    const sleep = vi.fn(async () => {});

    const outcome = await codeGraphIndexDispatchService.runIndexContainer(INPUT, {
      ...FAST,
      sleep,
    });

    expect(outcome).toMatchObject({ outcome: 'admission_deferred', reason: 'ai_plan_required' });
    expect((outcome as { detail: string }).detail).not.toContain('refused for');
    expect(vi.mocked(codeGraphIndexAdmissionService.admit)).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(fakeOrchestrator.provisioned).toHaveLength(0);
  });

  // The other half of the same line: an UNREADABLE plan is a transient (motir-ai
  // unreachable), so it stays on the wait like every other deferral.
  it('still waits through plan_unknown, then proceeds', async () => {
    vi.mocked(codeGraphIndexAdmissionService.admit).mockResolvedValueOnce({
      outcome: 'deferred',
      reason: 'plan_unknown',
      detail: "Motir could not read this organization's AI plan",
    });

    const outcome = await codeGraphIndexDispatchService.runIndexContainer(INPUT, {
      ...FAST,
      sleep: completeWith(0),
    });

    expect(vi.mocked(codeGraphIndexAdmissionService.admit)).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({ outcome: 'settled', verdict: { indexed: true } });
  });

  // A redelivery of a job whose container is already up must not be refused
  // capacity it is already holding — it proceeds on the slot it has.
  it('proceeds on an ALREADY-HELD slot instead of waiting for a new one', async () => {
    vi.mocked(codeGraphIndexAdmissionService.admit).mockResolvedValue({
      outcome: 'already_held',
      admission: ADMISSION,
    });

    const outcome = await codeGraphIndexDispatchService.runIndexContainer(INPUT, {
      ...FAST,
      sleep: completeWith(0),
    });

    expect(outcome.outcome).toBe('settled');
    expect(vi.mocked(codeGraphIndexAdmissionService.admit)).toHaveBeenCalledTimes(1);
  });

  it('backs the retry off, and never past its ceiling', () => {
    const opts = { admissionWaitMs: 5_000, maxAdmissionWaitMs: 60_000 };
    expect(indexAdmissionWaitMs(1, opts)).toBe(5_000);
    expect(indexAdmissionWaitMs(2, opts)).toBe(10_000);
    expect(indexAdmissionWaitMs(4, opts)).toBe(40_000);
    expect(indexAdmissionWaitMs(50, opts)).toBe(60_000);
    // PURE — a function of the attempt, never of the clock, because a durable
    // replay re-derives every wait.
    expect(indexAdmissionWaitMs(3, opts)).toBe(indexAdmissionWaitMs(3, opts));
  });

  // ⚠️ THE WAITING BUDGET MUST OUTLAST THE LONGEST CONTAINER, or "wait" becomes
  // "drop" whenever the lane is genuinely full: every slot-holder is hard-killed
  // at `indexTimeoutMs`, so a budget shorter than that could expire while the
  // containers ahead were all still legitimately running.
  it('waits longer than the hard kill on the containers it is queued behind', () => {
    const { maxAttempts, baseWaitMs, maxWaitMs } = INDEX_ADMISSION_BUDGETS;
    let total = 0;
    for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
      total += indexAdmissionWaitMs(attempt);
    }
    expect(baseWaitMs).toBeLessThanOrEqual(maxWaitMs);
    expect(total).toBeGreaterThan(INDEX_FLEET_TIME_BUDGETS.indexTimeoutMs);
  });
});

// ── Poll ───────────────────────────────────────────────────────────────────

describe('pollIndexContainer — one read, no loop, and it never throws', () => {
  async function boot(): Promise<IndexSession> {
    const booted = await codeGraphIndexDispatchService.bootIndexContainer(INPUT, ADMISSION, FAST);
    if (booted.phase !== 'supervising') throw new Error('expected a supervising boot');
    return booted.session;
  }

  it('makes EXACTLY ONE provider read per poll — the step cannot become long', async () => {
    const session = await boot();
    const describeSpy = vi.spyOn(fakeOrchestrator, 'describe');

    const polled = await codeGraphIndexDispatchService.pollIndexContainer(
      session,
      INITIAL_INDEX_POLL_STATE,
      FAST,
    );

    expect(describeSpy).toHaveBeenCalledTimes(1);
    expect(polled.done).toBe(false);
  });

  it('turns a provider read failure into a typed result, then a done verdict — never a throw', async () => {
    const session = await boot();
    vi.spyOn(fakeOrchestrator, 'describe').mockRejectedValue(new Error('the provider is down'));

    let state = INITIAL_INDEX_POLL_STATE;
    for (let i = 1; i <= INDEX_FLEET_TIME_BUDGETS.maxConsecutiveReadFailures; i += 1) {
      const polled = await codeGraphIndexDispatchService.pollIndexContainer(session, state, FAST);
      if (polled.done) throw new Error(`gave up after ${i} read failures, sooner than tolerated`);
      expect(polled.consecutiveReadFailures).toBe(i);
      state = polled;
    }

    const final = await codeGraphIndexDispatchService.pollIndexContainer(session, state, FAST);
    expect(final).toMatchObject({ done: true, reason: 'job_timed_out' });
    if (!final.done) throw new Error('expected a done verdict');
    expect(final.failureDetail).toContain('could not be read');

    // ⚠️ AND THE VERDICT STILL ROUTES TO TEARDOWN. That is the whole reason it is
    // a result and not an exception: a step that fails terminally is never
    // followed by one scheduled from a catch.
    vi.restoreAllMocks();
    await codeGraphIndexDispatchService.settleIndexContainer(session, final);
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
  });

  it('ends the run when the container never starts, before its own timeout could', async () => {
    fakeOrchestrator.setBootBehaviour('never_start');
    const session = await boot();

    const polled = await codeGraphIndexDispatchService.pollIndexContainer(
      session,
      INITIAL_INDEX_POLL_STATE,
      { ...FAST, bootDeadlineMs: 0 },
    );
    expect(polled).toMatchObject({ done: true, reason: 'provision_failed', startedAt: null });
  });

  it('ends a container that runs past the index timeout', async () => {
    fakeOrchestrator.setBootBehaviour('hang');
    const session = await boot();

    const polled = await codeGraphIndexDispatchService.pollIndexContainer(
      session,
      INITIAL_INDEX_POLL_STATE,
      { ...FAST, indexTimeoutMs: 0 },
    );
    expect(polled).toMatchObject({ done: true, reason: 'job_timed_out' });
  });

  it('backs off, and stops backing off at a cap tighter than the CI fleet uses', () => {
    expect(indexPollWaitMs(1)).toBe(INDEX_FLEET_TIME_BUDGETS.pollIntervalMs);
    expect(indexPollWaitMs(2)).toBe(INDEX_FLEET_TIME_BUDGETS.pollIntervalMs * 2);
    // The cap is what bounds the step count on a long run; it is deliberately
    // low because the exit code is only readable while the machine exists.
    expect(indexPollWaitMs(50)).toBe(INDEX_FLEET_TIME_BUDGETS.maxPollIntervalMs);
  });
});

// ── Settle, and the exit taxonomy ──────────────────────────────────────────

// ── The admitted ACCOUNT's orchestrator (MOTIR-9448) ──────────────────────

describe("boot, poll and settle address the admitted account's orchestrator", () => {
  let created: string[] = [];

  /** One account of the indexer's pool, as a real row (the accessor reads it). */
  async function account(): Promise<FleetShard> {
    const slug = randomToken(6).toLowerCase();
    const row = await adminDb.fleetShard.create({
      data: {
        name: `idx-${slug}`,
        fleetKind: 'code_graph_index',
        provider: 'fly',
        state: 'active',
        githubOrg: 'motir-projects',
        githubInstallationId: '556677',
        flyOrg: 'motir',
        flyApp: `motir-idx-${slug}`,
        flyRegion: 'iad',
        credentialRef: 'FLEET_SHARD_TEST_TOKEN',
        machineLimit: 4,
      },
    });
    created.push(row.id);
    return row;
  }

  function onAccount(shardId: string, input = INPUT): IndexAdmission {
    return { ...admissionFor(input), shardId };
  }

  async function bootOn(shardId: string, input = INPUT): Promise<IndexSession> {
    const booted = await codeGraphIndexDispatchService.bootIndexContainer(
      input,
      onAccount(shardId, input),
      FAST,
    );
    if (booted.phase !== 'supervising') throw new Error('expected a supervising boot');
    return booted.session;
  }

  beforeEach(() => {
    created = [];
    resetShardFakes();
    fleetShardOrchestratorService.resetCache();
  });

  afterEach(async () => {
    await adminDb.fleetShard.deleteMany({ where: { id: { in: created } } });
    resetShardFakes();
    fleetShardOrchestratorService.resetCache();
  });

  it('boots on the account only, and the session carries the account', async () => {
    const a = await account();

    const session = await bootOn(a.id);

    expect(fakeOrchestratorForShard(a.id).provisioned).toHaveLength(1);
    expect(fakeOrchestrator.provisioned).toHaveLength(0);
    expect(session.shardId).toBe(a.id);
    expect(JSON.parse(JSON.stringify(session))).toEqual(session);
  });

  it('polls and settles each session on its own account, never crossing', async () => {
    const [a, b] = [await account(), await account()];
    const other = { ...INPUT, repoRef: 'moooon-B-V/motir-ai', repoName: 'motir-ai' };
    const [onA, onB] = await Promise.all([bootOn(a.id), bootOn(b.id, other)]);
    const describes = {
      a: vi.spyOn(fakeOrchestratorForShard(a.id), 'describe'),
      b: vi.spyOn(fakeOrchestratorForShard(b.id), 'describe'),
      fly: vi.spyOn(fakeOrchestrator, 'describe'),
    };

    for (const [session, fake] of [
      [onA, fakeOrchestratorForShard(a.id)],
      [onB, fakeOrchestratorForShard(b.id)],
    ] as const) {
      fake.completeJob(fake.liveContainerIds()[0]!, { exitCode: 0 });
      const polled = await codeGraphIndexDispatchService.pollIndexContainer(
        session,
        INITIAL_INDEX_POLL_STATE,
        FAST,
      );
      if (!polled.done) throw new Error('expected a done verdict');
      expect(
        await codeGraphIndexDispatchService.settleIndexContainer(session, polled),
      ).toMatchObject({ outcome: 'settled' });
    }

    expect(describes.a).toHaveBeenCalledTimes(1);
    expect(describes.b).toHaveBeenCalledTimes(1);
    expect(describes.fly).not.toHaveBeenCalled();
    expect(fakeOrchestratorForShard(a.id).teardowns).toHaveLength(1);
    expect(fakeOrchestratorForShard(b.id).teardowns).toHaveLength(1);
    expect(fakeOrchestrator.teardowns).toHaveLength(0);
    expect(released.sort()).toEqual([onA.slotRef, onB.slotRef].sort());
  });

  it('a session from a memo without the field is the process-wide fleet', async () => {
    const booted = await codeGraphIndexDispatchService.bootIndexContainer(INPUT, ADMISSION, FAST);
    if (booted.phase !== 'supervising') throw new Error('expected a supervising boot');
    const memo = JSON.parse(JSON.stringify(booted.session)) as IndexSession;
    expect(memo).not.toHaveProperty('shardId');
    const describe = vi.spyOn(fakeOrchestrator, 'describe');

    await codeGraphIndexDispatchService.pollIndexContainer(memo, INITIAL_INDEX_POLL_STATE, FAST);

    expect(describe).toHaveBeenCalledTimes(1);
  });

  it('an account that cannot be reached at boot fails the boot, gives the slot back, and never falls back', async () => {
    const booted = await codeGraphIndexDispatchService.bootIndexContainer(
      INPUT,
      onAccount('shard-that-is-gone'),
      FAST,
    );

    expect(booted).toMatchObject({ phase: 'terminal', outcome: { outcome: 'provision_failed' } });
    if (booted.phase !== 'terminal') throw new Error('expected a terminal boot');
    expect(booted.outcome).toMatchObject({ detail: expect.stringContaining('shard-that-is-gone') });
    expect(released).toEqual([ADMISSION.slotRef]);
    expect(fakeOrchestrator.provisioned).toHaveLength(0);
    // Nothing was spent: no credential was minted for a boot that cannot happen.
    expect(motirAiCalls()).toEqual([]);
  });

  it('an account lost mid-run is never reported indexed, names the account, and frees the slot', async () => {
    const a = await account();
    const session = await bootOn(a.id);
    await adminDb.fleetShard.delete({ where: { id: a.id } });
    created = [];

    let state = INITIAL_INDEX_POLL_STATE;
    let polled;
    for (let i = 0; i <= INDEX_FLEET_TIME_BUDGETS.maxConsecutiveReadFailures; i += 1) {
      polled = await codeGraphIndexDispatchService.pollIndexContainer(session, state, FAST);
      if (polled.done) break;
      state = polled;
    }
    if (!polled?.done) throw new Error('expected a done verdict');
    expect(polled.reason).not.toBe('job_completed');
    expect(polled.failureDetail).toContain(a.id);

    const settled = await codeGraphIndexDispatchService.settleIndexContainer(session, polled);
    expect(settled).toMatchObject({ outcome: 'teardown_failed' });
    if (settled.outcome !== 'teardown_failed') throw new Error('expected teardown_failed');
    expect(settled.detail).toContain(a.id);
    expect(released).toEqual([session.slotRef]);
  });

  // ── A capacity refusal at boot is a full account, not a failed run (MOTIR-9451)

  /** The next admission names `shardId`, as the real gate would after the pause. */
  function nextAdmitOn(shardId: string): void {
    vi.mocked(codeGraphIndexAdmissionService.admit).mockResolvedValueOnce({
      outcome: 'admitted',
      admission: onAccount(shardId),
      census: {
        total: 1,
        byWorkload: { ci_runner: 0, code_graph_index: 1, hosted_agent: 0, agent_instance: 0 },
      },
    });
  }

  it('a capacity refusal pauses the account, gives the slot back and boots on another account', async () => {
    const [a, b] = [await account(), await account()];
    fakeOrchestratorForShard(a.id).failNextProvisionForCapacity('out_of_stock');
    nextAdmitOn(b.id);

    const booted = await codeGraphIndexDispatchService.bootIndexContainer(
      INPUT,
      onAccount(a.id),
      FAST,
    );

    expect(booted.phase).toBe('supervising');
    if (booted.phase !== 'supervising') throw new Error('expected a supervising boot');
    expect(booted.session.shardId).toBe(b.id);
    expect(fakeOrchestratorForShard(b.id).provisioned).toHaveLength(1);
    expect(fakeOrchestrator.provisioned).toHaveLength(0);
    // The refused account's slot went back before the re-admission took another.
    expect(released).toEqual([ADMISSION.slotRef]);
    const paused = await adminDb.fleetShard.findUniqueOrThrow({ where: { id: a.id } });
    expect(paused.admissionPausedReason).toBe('capacity_refused');
    const pausedForMs = paused.admissionPausedUntil!.getTime() - Date.now();
    expect(pausedForMs).toBeGreaterThan((SHARD_PAUSE_SECONDS - 10) * 1000);
    expect(pausedForMs).toBeLessThanOrEqual(SHARD_PAUSE_SECONDS * 1000);
  });

  it('when no other account has room it defers pool_full — never provision_failed, never Fly', async () => {
    const a = await account();
    fakeOrchestratorForShard(a.id).failNextProvisionForCapacity('quota_exceeded');
    vi.mocked(codeGraphIndexAdmissionService.admit).mockResolvedValue({
      outcome: 'deferred',
      reason: 'pool_full',
      detail: 'every indexer account is full',
    });

    const booted = await codeGraphIndexDispatchService.bootIndexContainer(
      INPUT,
      onAccount(a.id),
      FAST,
    );

    expect(booted).toMatchObject({
      phase: 'terminal',
      outcome: { outcome: 'admission_deferred', reason: 'pool_full' },
    });
    expect(fakeOrchestrator.provisioned).toHaveLength(0);
    expect(released).toEqual([ADMISSION.slotRef]);
    expect(
      (await adminDb.fleetShard.findUniqueOrThrow({ where: { id: a.id } })).admissionPausedReason,
    ).toBe('capacity_refused');
  });

  it('a provider that is down on the account is the same move; a job fault is still provision_failed', async () => {
    const [a, b] = [await account(), await account()];
    fakeOrchestratorForShard(a.id).failNextProvision('fly 503');
    nextAdmitOn(b.id);
    const moved = await codeGraphIndexDispatchService.bootIndexContainer(
      INPUT,
      onAccount(a.id),
      FAST,
    );
    expect(moved).toMatchObject({ phase: 'supervising', session: { shardId: b.id } });
    expect(
      (await adminDb.fleetShard.findUniqueOrThrow({ where: { id: a.id } })).admissionPausedReason,
    ).toBe('provider_unavailable');

    // A refusal that is the job's own (a 4xx) moves nowhere.
    const c = await account();
    vi.spyOn(fakeOrchestratorForShard(c.id), 'provision').mockRejectedValueOnce(
      new OrchestratorApiError('fake', 422, 'bad spec'),
    );
    const failed = await codeGraphIndexDispatchService.bootIndexContainer(
      INPUT,
      onAccount(c.id),
      FAST,
    );
    expect(failed).toMatchObject({ phase: 'terminal', outcome: { outcome: 'provision_failed' } });
    expect(
      (await adminDb.fleetShard.findUniqueOrThrow({ where: { id: c.id } })).admissionPausedUntil,
    ).toBeNull();
  });

  it('with the switch off a capacity refusal is still provision_failed', async () => {
    fakeOrchestrator.failNextProvisionForCapacity('out_of_stock');
    const booted = await codeGraphIndexDispatchService.bootIndexContainer(INPUT, ADMISSION, FAST);
    expect(booted).toMatchObject({ phase: 'terminal', outcome: { outcome: 'provision_failed' } });
    expect(vi.mocked(codeGraphIndexAdmissionService.admit)).not.toHaveBeenCalled();
  });
});

// ── A pull failure learned AFTER the boot (MOTIR-9446) ────────────────────

describe('an image the VM could not pull ends the run as image_unpullable', () => {
  /** The provider's answer once the VM has stopped on a failed pull — what the
   *  AWS adapter reports after reading the VM's console. */
  function pullFailsOnTheVm(): void {
    const describe = fakeOrchestrator.describe.bind(fakeOrchestrator);
    vi.spyOn(fakeOrchestrator, 'describe').mockImplementation(async (handle) => ({
      ...(await describe(handle)),
      terminal: true,
      state: 'destroyed',
      exitCode: null,
      imagePullFailed: true,
    }));
  }

  it('reports image_unpullable, not provision_failed, and gives the slot back', async () => {
    pullFailsOnTheVm();

    const outcome = await codeGraphIndexDispatchService.runIndexContainer(INPUT, FAST);

    expect(outcome).toMatchObject({ outcome: 'image_unpullable' });
    if (outcome.outcome !== 'image_unpullable') throw new Error('expected image_unpullable');
    expect(outcome.detail).toContain('could not be pulled');
    // The slot is released, so the next admission for this repo is not held by it.
    expect(releasedBy).toEqual([{ slotRef: ADMISSION.slotRef, dispatchId: INPUT.dispatchId }]);
    // Torn down, and not re-dispatched: every retry would hit the same image.
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    expect(fakeOrchestrator.teardowns).toHaveLength(1);
  });

  it('the poll verdict carries the condition across the step boundary', async () => {
    const booted = await codeGraphIndexDispatchService.bootIndexContainer(INPUT, ADMISSION, FAST);
    if (booted.phase !== 'supervising') throw new Error('expected a supervising boot');
    pullFailsOnTheVm();

    const polled = await codeGraphIndexDispatchService.pollIndexContainer(
      booted.session,
      INITIAL_INDEX_POLL_STATE,
      FAST,
    );

    expect(polled).toMatchObject({
      done: true,
      reason: 'provision_failed',
      imageUnpullable: true,
    });
    expect(JSON.parse(JSON.stringify(polled))).toEqual(polled);
  });
});

describe('every path out of supervision tears the container down', () => {
  it('leaves nothing running after boot → failure → settle', async () => {
    fakeOrchestrator.setBootBehaviour('never_start');

    const outcome = await codeGraphIndexDispatchService.runIndexContainer(INPUT, {
      ...FAST,
      bootDeadlineMs: 0,
    });

    expect(outcome).toMatchObject({
      outcome: 'settled',
      reason: 'provision_failed',
      verdict: { exitClass: 'never_started', indexed: false },
    });
    // THE GUARANTEE, stated as the only assertion that can catch its absence.
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    // `never_started` is re-dispatchable (MOTIR-6586), so the dispatch booted a
    // second container — and tore down every one it booted.
    expect(fakeOrchestrator.provisioned).toHaveLength(MAX_DISPATCH_ATTEMPTS);
    expect(fakeOrchestrator.teardowns).toHaveLength(MAX_DISPATCH_ATTEMPTS);
  });

  it('carries the container-seconds record OUT as well as writing it', async () => {
    const outcome = await codeGraphIndexDispatchService.runIndexContainer(INPUT, {
      ...FAST,
      sleep: completeWith(0),
    });

    if (outcome.outcome !== 'settled') throw new Error('expected a settled outcome');
    // Teardown PRODUCES the usage row — the port makes that unskippable — and the
    // dispatcher both PERSISTS it (MOTIR-1995) and hands it on. The two are not
    // redundant: this outcome becomes the durable step's `job_run` ledger entry, the
    // per-run operational trail, while the persisted row is the aggregated,
    // tenant-attributed record the margin readout reads. The persistence itself is
    // asserted against real Postgres further down.
    expect(outcome.usage).toMatchObject({
      handleId: outcome.containerId,
      workload: 'code_graph_index',
      workflowJobId: null,
      projectId: 'proj-1',
      repoFullName: 'moooon-B-V/motir-core',
      teardownReason: 'job_completed',
    });
    expect(outcome.usage.cpus).toBe(FLEET_CONTAINER_SIZE.cpus);
    expect(outcome.costUsd).toBe(outcome.usage.costUsd);
  });

  it('reports a teardown that failed instead of dressing it up as a settled run', async () => {
    fakeOrchestrator.failNextTeardown('the fake refused to tear down');

    const outcome = await codeGraphIndexDispatchService.runIndexContainer(INPUT, {
      ...FAST,
      sleep: completeWith(0),
    });

    expect(outcome.outcome).toBe('teardown_failed');
    if (outcome.outcome !== 'teardown_failed') throw new Error('expected teardown_failed');
    expect(outcome.detail).toContain('left for the reaper');
  });

  it('reports rather than throws when there is no orchestrator left to tear down THROUGH', async () => {
    const booted = await codeGraphIndexDispatchService.bootIndexContainer(INPUT, ADMISSION, FAST);
    if (booted.phase !== 'supervising') throw new Error('expected a supervising boot');
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', '');

    const outcome = await codeGraphIndexDispatchService.settleIndexContainer(booted.session, {
      done: true,
      reason: 'job_completed',
      startedAt: new Date().toISOString(),
      exitCode: 0,
      failureDetail: null,
    });

    expect(outcome).toMatchObject({ outcome: 'teardown_failed' });
  });

  it('settles the static poll-iteration ceiling rather than abandoning the container', async () => {
    // A clock that never advances: no deadline can ever fire, so only the
    // iteration ceiling ends the loop — and it must still end in a teardown.
    fakeOrchestrator.setBootBehaviour('hang');
    const frozen = new Date();

    const outcome = await codeGraphIndexDispatchService.runIndexContainer(INPUT, {
      ...FAST,
      now: () => frozen,
      sleep: async () => {},
    });

    expect(outcome).toMatchObject({
      outcome: 'settled',
      reason: 'job_timed_out',
      verdict: { exitClass: 'supervision_timed_out', indexed: false },
    });
    expect(outcome.outcome === 'settled' && outcome.failureDetail).toContain('poll ceiling');
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    // ⚠️ AND NOT RE-DISPATCHED (MOTIR-6586). A container that spent the whole
    // supervision budget is the costliest outcome there is; a second one on the
    // same tree mostly repeats it, so the verdict says so and one boot is final.
    expect(outcome).toMatchObject({ verdict: { redispatchable: false } });
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
  });
});

describe('the exit code is CLASSIFIED — the number is the whole diagnostic channel', () => {
  const CASES: Array<{ code: number | null; exitClass: string; indexed: boolean }> = [
    { code: 0, exitClass: 'indexed', indexed: true },
    { code: 10, exitClass: 'dispatch_malformed', indexed: false },
    { code: 20, exitClass: 'repo_unfetchable', indexed: false },
    { code: 30, exitClass: 'graph_unbuildable', indexed: false },
    { code: 40, exitClass: 'upload_failed', indexed: false },
    { code: 41, exitClass: 'pointer_unrecorded', indexed: false },
    { code: 50, exitClass: 'credential_refused', indexed: false },
    { code: 70, exitClass: 'unclassified', indexed: false },
    { code: 137, exitClass: 'out_of_memory', indexed: false },
    { code: null, exitClass: 'exit_unobserved', indexed: false },
  ];

  it('names every code the image can exit with, distinguishably', () => {
    const classes = CASES.map((c) => classifyIndexExit(c.code).exitClass);
    expect(classes).toEqual(CASES.map((c) => c.exitClass));
    // Distinguishable, not merely named: no two codes collapse into one class.
    expect(new Set(classes).size).toBe(CASES.length);
    for (const { code, indexed } of CASES) {
      expect(classifyIndexExit(code).indexed).toBe(indexed);
      expect(classifyIndexExit(code).exitCode).toBe(code);
    }
  });

  it('reads 137 as the kernel OOM-kill, NOT as a build failure', () => {
    // Different facts and different responses: `30` is "the engine rejected this
    // tree", `137` is "the machine was too small for it".
    expect(classifyIndexExit(137).exitClass).not.toBe(classifyIndexExit(30).exitClass);
    expect(classifyIndexExit(137).detail).toContain('OOM');
  });

  it('marks only an expired-or-refused FETCH and the upload paths as re-dispatchable', () => {
    expect(classifyIndexExit(20).redispatchable).toBe(true);
    expect(classifyIndexExit(40).redispatchable).toBe(true);
    expect(classifyIndexExit(41).redispatchable).toBe(true);
    // A dispatcher bug retried is the same bug; a refused credential retried with
    // another identity is the boundary dissolving; an unobserved exit retried on
    // every self-destroying container is a spend loop.
    expect(classifyIndexExit(10).redispatchable).toBe(false);
    expect(classifyIndexExit(50).redispatchable).toBe(false);
    expect(classifyIndexExit(137).redispatchable).toBe(false);
    expect(classifyIndexExit(null).redispatchable).toBe(false);
  });

  it('classifies a code the taxonomy does not name without pretending it succeeded', () => {
    const verdict = classifyIndexExit(3);
    expect(verdict.exitClass).toBe('unclassified');
    expect(verdict.indexed).toBe(false);
    expect(verdict.detail).toContain('3');
  });

  it('carries the class through a whole supervised run, for a success and for a failure', async () => {
    const indexed = await codeGraphIndexDispatchService.runIndexContainer(INPUT, {
      ...FAST,
      sleep: completeWith(0),
    });
    expect(indexed).toMatchObject({
      outcome: 'settled',
      reason: 'job_completed',
      verdict: { exitClass: 'indexed', indexed: true, exitCode: 0 },
    });

    fakeOrchestrator.reset();
    const oomKilled = await codeGraphIndexDispatchService.runIndexContainer(INPUT, {
      ...FAST,
      sleep: completeWith(137),
    });
    expect(oomKilled).toMatchObject({
      outcome: 'settled',
      reason: 'job_completed',
      verdict: { exitClass: 'out_of_memory', indexed: false },
    });
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
  });

  // ⚠️ THE GUARD MOTIR-4519 LEAVES BEHIND, and the one thing this whole block was
  // missing: every assertion above starts from a number ALREADY IN HAND, so it
  // cannot see the classifier being handed the WRONG number. That is precisely
  // what happened — `exitCodeOfEvent` preferred `guest_exit_code`, which Fly sets
  // to `0` on every clean guest shutdown, so a container that exited 40 reached
  // `classifyIndexExit` as a 0 and the ledger recorded `indexed: true`. 601
  // settle memos and 313 `succeeded` rows carried that claim between 2026-08-28
  // and 2026-09-04, against a pointer table whose newest row is 2026-08-21.
  //
  // So this walks the SAME table through the real adapter parse, from the event
  // shape Fly actually sends, and pins the ledger's `indexed` claim to
  // `classifyIndexExit`'s verdict about the CONTAINER's own code — never to the
  // step having completed. The two can no longer drift without failing here.
  it("classifies the code FLY REPORTED — the adapter's parse and the verdict cannot drift", () => {
    for (const { code, exitClass, indexed } of CASES) {
      // The verbatim production pair (MOTIR-4519, machine `8e3143b7164118`): the
      // container's code in `exit_code`, a flat 0 in `guest_exit_code`. A null
      // code is Fly answering with no exit event at all — the `auto_destroy`
      // machine that took its code with it.
      const machine = toFlyMachine({
        id: 'm1',
        events: [
          { type: 'start', timestamp: Date.parse('2026-09-04T15:16:28.609Z') },
          {
            type: 'exit',
            timestamp: Date.parse('2026-09-04T15:35:18.299Z'),
            request:
              code === null
                ? {}
                : {
                    exit_event: {
                      requested_stop: false,
                      restarting: false,
                      guest_exit_code: 0,
                      guest_signal: -1,
                      exit_code: code,
                      signal: -1,
                      oom_killed: false,
                    },
                  },
          },
        ],
      });

      const verdict = classifyIndexExit(exitCodeOf(machine!));
      expect(verdict.exitCode, `exit_code ${code}`).toBe(code);
      expect(verdict.exitClass, `exit_code ${code}`).toBe(exitClass);
      expect(verdict.indexed, `exit_code ${code}`).toBe(indexed);
    }

    // And the claim is granted to exactly ONE code out of the whole taxonomy —
    // the property §6's "permanent claim that the repo is indexed" rests on.
    expect(CASES.filter((c) => c.indexed).map((c) => c.code)).toEqual([0]);
  });

  it('never reports a container whose exit was unobservable as indexed', async () => {
    // The `auto_destroy` happy path: the machine deletes itself and takes the
    // exit code with it. Anything that claimed this indexed the repo would write
    // an `output.repoRef` no run ever earned.
    const outcome = await codeGraphIndexDispatchService.runIndexContainer(INPUT, {
      ...FAST,
      sleep: completeWith(null),
    });
    expect(outcome).toMatchObject({
      outcome: 'settled',
      verdict: { exitClass: 'exit_unobserved', indexed: false },
    });
  });
});

// ── The budgets, and the branch that must not exist ────────────────────────

describe('the index fleet time budgets fit under the platform ceiling', () => {
  it('orders the deadlines so each can fire before the next', () => {
    const b = INDEX_FLEET_TIME_BUDGETS;
    expect(b.pollIntervalMs).toBeLessThanOrEqual(b.maxPollIntervalMs);
    expect(b.maxPollIntervalMs).toBeLessThan(b.bootDeadlineMs);
    expect(b.bootDeadlineMs).toBeLessThan(b.indexTimeoutMs);
    // The iteration ceiling is a backstop, never the bound that matters: at the
    // capped interval it covers the whole timeout many times over.
    expect(b.maxPollIterations * b.maxPollIntervalMs).toBeGreaterThan(b.indexTimeoutMs);
  });

  it('lets a RUN outlive one invocation, which is only safe because it is stepped', () => {
    // `maxDuration = 300` bounds one INVOCATION. Shortening the run timeout to
    // fit inside it would cap every index at five minutes — the product
    // regressing to fit the platform, which is the non-fix MOTIR-2007 rejected.
    expect(INDEX_FLEET_TIME_BUDGETS.indexTimeoutMs).toBeGreaterThan(300_000);
  });
});

describe('the defaults are the shipped ones — the test seams only shorten them', () => {
  it('boots and polls on the module constants when no options are passed', async () => {
    const booted = await codeGraphIndexDispatchService.bootIndexContainer(INPUT, ADMISSION);
    if (booted.phase !== 'supervising') throw new Error('expected a supervising boot');
    // The default run timeout is what the container is booted with, so a spec
    // built without options carries the shipped deadline rather than a test one.
    expect(fakeOrchestrator.specs[0]!.timeoutSeconds).toBe(
      INDEX_FLEET_TIME_BUDGETS.indexTimeoutMs / 1000,
    );

    const polled = await codeGraphIndexDispatchService.pollIndexContainer(booted.session);
    expect(polled.done).toBe(false);
  });

  it('waits with a real timer when no sleep seam is supplied', async () => {
    // Both arms of the default sleep: a zero wait resolves immediately, a
    // positive one goes through a timer. The run still ends at its deadline.
    for (const pollIntervalMs of [0, 1]) {
      fakeOrchestrator.reset();
      const outcome = await codeGraphIndexDispatchService.runIndexContainer(INPUT, {
        pollIntervalMs,
        maxPollIntervalMs: pollIntervalMs,
        bootDeadlineMs: 0,
        indexTimeoutMs: 0,
      });
      expect(outcome.outcome).toBe('settled');
      expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    }
  });

  it('returns the boot outcome without supervising when nothing was provisioned', async () => {
    fakeOrchestrator.failNextProvision('the fake refused');
    const outcome = await codeGraphIndexDispatchService.runIndexContainer(INPUT, FAST);
    expect(outcome).toMatchObject({ outcome: 'provision_failed' });
    expect(fakeOrchestrator.teardowns).toHaveLength(0);
  });

  it('describes a non-Error rejection rather than losing it', async () => {
    vi.spyOn(fakeOrchestrator, 'provision').mockRejectedValueOnce('the provider threw a string');
    const booted = await codeGraphIndexDispatchService.bootIndexContainer(INPUT, ADMISSION, FAST);
    expect(booted).toMatchObject({
      phase: 'terminal',
      outcome: { outcome: 'provision_failed', detail: expect.stringContaining('unknown') },
    });
  });

  it('reads a terminal container that never started as a boot that never happened', async () => {
    // The provider reported a successful create and the container stopped
    // without ever running — a provisioning failure, not a completed index.
    fakeOrchestrator.setBootBehaviour('never_start');
    const booted = await codeGraphIndexDispatchService.bootIndexContainer(INPUT, ADMISSION, FAST);
    if (booted.phase !== 'supervising') throw new Error('expected a supervising boot');
    fakeOrchestrator.completeJob(booted.session.handle.id, { exitCode: null });

    const polled = await codeGraphIndexDispatchService.pollIndexContainer(
      booted.session,
      INITIAL_INDEX_POLL_STATE,
      FAST,
    );
    expect(polled).toMatchObject({ done: true, reason: 'provision_failed', startedAt: null });
    if (!polled.done) throw new Error('expected a done verdict');

    const outcome = await codeGraphIndexDispatchService.settleIndexContainer(
      booted.session,
      polled,
    );
    expect(outcome).toMatchObject({ verdict: { exitClass: 'never_started', indexed: false } });
  });

  it('adopts the provider-reported start instant when a poll first sees it terminal', async () => {
    const booted = await codeGraphIndexDispatchService.bootIndexContainer(INPUT, ADMISSION, FAST);
    if (booted.phase !== 'supervising') throw new Error('expected a supervising boot');
    // It ran and finished between two polls: this process never observed it
    // running, but the provider still reports when it started.
    fakeOrchestrator.completeJob(booted.session.handle.id, { exitCode: 0 });

    const polled = await codeGraphIndexDispatchService.pollIndexContainer(
      booted.session,
      INITIAL_INDEX_POLL_STATE,
      FAST,
    );
    expect(polled).toMatchObject({ done: true, reason: 'job_completed', exitCode: 0 });
    if (!polled.done) throw new Error('expected a done verdict');
    expect(polled.startedAt).not.toBeNull();
  });
});

describe('no isMeta branch exists anywhere in this path', () => {
  it('has none in the dispatch service', () => {
    // §8/§9: Motir's own repos take this identical code into the same org with
    // the same credential shape. `isMeta` decides whether a metered cost is
    // CHARGED — never where a container runs — and a meta-only path would mean
    // the tested path is the one nobody runs. Asserted because the dogfooding
    // argument depends on it.
    const source = readFileSync(
      join(process.cwd(), 'lib', 'services', 'codeGraphIndexDispatchService.ts'),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).not.toMatch(/isMeta/);
  });
});

describe('the COGS meter is WIRED to both moments (MOTIR-1995)', () => {
  // ⚠️ AGAINST REAL POSTGRES, and it has to be. MOTIR-2026 left this seam open —
  // teardown produced the usage record and the service wrote nothing — so the thing
  // worth asserting is not that a function was called but that a ROW EXISTS, in a
  // real tenant, attributed and costed. The rest of this file runs on fabricated
  // ids (`org-1`), which is why these tests seed their own tenant instead.
  const PASSWORD = 'hunter2hunter2';
  /**
   * How long the container has been RUNNING when the poll observes it — measured
   * from `handle.createdAt`, which is the stamp the accrual measures from, and
   * NOT from `session.bootedAt` (MOTIR-2091).
   *
   * ⚠️ THE ANCHOR IS THE WHOLE POINT, and naming it here is the fix. Injecting
   * `observedAt` removes the race with the wall clock only if it is offset from
   * the SAME stamp the arithmetic under test reads. `buildContainerAccrual`
   * computes `ceil((observedAt − startedAt) / 1000)` from the container's
   * provider-reported `startedAt`; `session.bootedAt` is stamped LATER, after
   * provisioning returns and credentials are minted. Offsetting from `bootedAt`
   * therefore asserts `ceil((90_000 + δ) / 1000)` where δ is whatever that boot
   * tail cost — and because `Math.ceil` has no tolerance at all, ONE millisecond
   * of δ flips 90 to 91. That is a knife-edge, not a margin: it passed only on a
   * machine fast enough to land the whole tail inside one millisecond, and it
   * red-lit an unrelated PR (#1826) the first time it lost that race.
   */
  const OBSERVED_AT_MS = 90_000;
  /**
   * A deliberate, generous δ between the fake's provision and the service's
   * `bootedAt` stamp — injected into every boot below so the wrong anchor cannot
   * come back green.
   *
   * At 1.5s it is three orders of magnitude past the real skew and, being over a
   * whole second, it would move the asserted count by TWO were the anchor wrong
   * again (`ceil(91_500 / 1000) = 92`). The tests assert the skew is really
   * present, so this guard can never go vacuous.
   */
  const BOOT_SKEW_MS = 1_500;

  /** Boot with that δ in place. `options.now` is read only for `bootedAt`, so
   *  advancing it is exactly "the boot tail took 1.5s". */
  const bootWithSkew = () =>
    codeGraphIndexDispatchService.bootIndexContainer(dbInput, admissionFor(dbInput), {
      ...FAST,
      now: () => new Date(Date.now() + BOOT_SKEW_MS),
    });

  /** The observation moment, anchored to the stamp the accrual measures FROM.
   *  The fake stamps `createdAt` and `startedAt` at one instant, at provision
   *  (`lib/orchestrator/adapters/fake/index.ts`), so the handle's `createdAt` IS
   *  the `startedAt` the checkpoint reads back off `describe`. */
  const observedAtFor = (session: IndexSession) =>
    new Date(new Date(session.handle.createdAt).getTime() + OBSERVED_AT_MS);

  /** The δ the boot actually carries — asserted, never assumed, so a future
   *  change that removes the skew fails loudly instead of quietly disarming the
   *  regression guard. */
  const bootSkewOf = (session: IndexSession) =>
    new Date(session.bootedAt).getTime() - new Date(session.handle.createdAt).getTime();

  let tenant: { organizationId: string; workspaceId: string; projectId: string };
  let dbInput: IndexDispatchInput;

  beforeEach(async () => {
    await adminDb.$executeRawUnsafe(
      'TRUNCATE TABLE "ci_container_usage", "ci_container_period_cost" RESTART IDENTITY CASCADE',
    );
    await truncateAuthTables();
    // The meter is a CLOUD meter (§8.5) — off-cloud there is no fleet to bill.
    vi.stubEnv('MOTIR_CLOUD', 'true');

    const email = `index-cogs-${randomToken(6)}@example.com`;
    const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
    const { workspace } = await workspacesService.createWorkspace({
      name: `WS ${email}`,
      ownerUserId: user.id,
    });
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: user.id,
      name: 'Acme',
      identifier: `A${randomInt(100, 1000)}`,
    });
    tenant = {
      organizationId: workspace.organizationId,
      workspaceId: workspace.id,
      projectId: project.id,
    };
    dbInput = { ...INPUT, ...tenant };
  });

  it('SETTLE persists the container-seconds row under the `index` line', async () => {
    const outcome = await codeGraphIndexDispatchService.runIndexContainer(dbInput, {
      ...FAST,
      sleep: completeWith(0),
    });

    if (outcome.outcome !== 'settled') throw new Error('expected a settled outcome');
    const row = await adminDb.ciContainerUsage.findFirstOrThrow();
    expect(row).toMatchObject({
      handleId: outcome.containerId,
      containerProvider: 'fake',
      // The cost AXIS value, mapped from the registry's `code_graph_index` kind —
      // the mapping whose absence made MOTIR-1981's "already attributable" claim
      // false.
      workload: 'index',
      // An index container has no GitHub job at all (§11), and the column must say
      // so with a real NULL rather than the string 'null'.
      workflowJobId: null,
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      projectId: tenant.projectId,
      repoFullName: 'moooon-B-V/motir-core',
      teardownReason: 'job_completed',
    });
    expect(row.containerStoppedAt).not.toBeNull();
    // And the rollup carries the same line, so index spend is separable from CI's.
    const rollup = await adminDb.ciContainerPeriodCost.findFirstOrThrow();
    expect(rollup).toMatchObject({ workload: 'index', containerCount: 1 });
    expect(rollup.containerSeconds).toBe(row.billableSeconds);
  });

  it('the POLL checkpoints a still-running container BEFORE it stops', async () => {
    // The incremental half. An index container is job-shaped and would survive on
    // teardown-time costing alone; this is here because Epic 9's agent container is
    // story-shaped (HOURS) and reaches teardown far too late to be the first write.
    const booted = await bootWithSkew();
    if (booted.phase !== 'supervising') throw new Error('expected a supervising boot');
    // The δ is REAL on this boot — without it the assertions below would pass
    // whether or not the anchor is right, which is how the defect survived.
    expect(bootSkewOf(booted.session)).toBeGreaterThanOrEqual(BOOT_SKEW_MS);
    const observedAt = observedAtFor(booted.session);

    const polled = await codeGraphIndexDispatchService.pollIndexContainer(
      booted.session,
      INITIAL_INDEX_POLL_STATE,
      { ...FAST, indexTimeoutMs: 600_000, now: () => observedAt },
    );

    expect(polled.done).toBe(false);
    const row = await adminDb.ciContainerUsage.findFirstOrThrow();
    // A PARTIAL figure, read mid-run — the acceptance criterion in one assertion.
    expect(row.billableSeconds).toBe(OBSERVED_AT_MS / 1000);
    expect(row.workload).toBe('index');
    // The three fields that say "still accruing"; the columns were relaxed to
    // nullable ahead of this card for exactly this row.
    expect(row.containerStoppedAt).toBeNull();
    expect(row.terminalState).toBeNull();
    expect(row.teardownReason).toBeNull();
    expect((await adminDb.ciContainerPeriodCost.findFirstOrThrow()).containerSeconds).toBe(
      OBSERVED_AT_MS / 1000,
    );
  });

  it('a REPLAYED poll adds nothing — the durable step re-executes, the meter does not', async () => {
    // ⚠️ NOT AN EDGE CASE. `pollIndexContainer` runs inside a durable Inngest step,
    // which re-executes on replay, so this is the ordinary path. It is free only
    // because the checkpoint reports the container's TOTAL to date rather than a
    // delta — a delta here would overstate Motir's own cost on every replay,
    // silently.
    const booted = await bootWithSkew();
    if (booted.phase !== 'supervising') throw new Error('expected a supervising boot');
    expect(bootSkewOf(booted.session)).toBeGreaterThanOrEqual(BOOT_SKEW_MS);
    const observedAt = observedAtFor(booted.session);
    const options = { ...FAST, indexTimeoutMs: 600_000, now: () => observedAt };

    await codeGraphIndexDispatchService.pollIndexContainer(
      booted.session,
      INITIAL_INDEX_POLL_STATE,
      options,
    );
    await codeGraphIndexDispatchService.pollIndexContainer(
      booted.session,
      INITIAL_INDEX_POLL_STATE,
      options,
    );

    const ciContainerUsageCount = await adminDb.ciContainerUsage.count();
    expect(ciContainerUsageCount).toBe(1);
    const rollup = await adminDb.ciContainerPeriodCost.findFirstOrThrow();
    expect(rollup.containerSeconds).toBe(OBSERVED_AT_MS / 1000);
    expect(rollup.containerCount).toBe(1);
  });

  it('a checkpointed container RECONCILES at teardown — one row, one container', async () => {
    // The two seams meeting: the poll's partial figure and the teardown's true total
    // land on ONE row and ONE rollup, which is what "extended, not duplicated" means
    // once both moments write.
    const booted = await bootWithSkew();
    if (booted.phase !== 'supervising') throw new Error('expected a supervising boot');
    expect(bootSkewOf(booted.session)).toBeGreaterThanOrEqual(BOOT_SKEW_MS);
    const observedAt = observedAtFor(booted.session);
    await codeGraphIndexDispatchService.pollIndexContainer(
      booted.session,
      INITIAL_INDEX_POLL_STATE,
      {
        ...FAST,
        indexTimeoutMs: 600_000,
        now: () => observedAt,
      },
    );
    expect((await adminDb.ciContainerUsage.findFirstOrThrow()).containerStoppedAt).toBeNull();

    const live = fakeOrchestrator.liveContainerIds();
    if (live[0]) fakeOrchestrator.completeJob(live[0], { exitCode: 0 });
    const settled = await codeGraphIndexDispatchService.settleIndexContainer(booted.session, {
      done: true,
      reason: 'job_completed',
      // The provider-reported container start, which is what a real verdict
      // carries (`status.startedAt`) — NOT `bootedAt`. Anchoring the settle to
      // the later stamp makes `stoppedAt − startedAt` negative under a real δ,
      // clamping the settled total to zero and letting the rollup invariant
      // below hold for the wrong reason.
      startedAt: booted.session.handle.createdAt,
      exitCode: 0,
      failureDetail: null,
    });

    expect(settled.outcome).toBe('settled');
    const ciContainerUsageCount = await adminDb.ciContainerUsage.count();
    expect(ciContainerUsageCount).toBe(1);
    const row = await adminDb.ciContainerUsage.findFirstOrThrow();
    expect(row.containerStoppedAt).not.toBeNull();
    expect(row.teardownReason).toBe('job_completed');
    const rollup = await adminDb.ciContainerPeriodCost.findFirstOrThrow();
    expect(rollup.containerCount).toBe(1);
    // The rollup equals the row — the invariant a signed-delta rollup has to keep.
    expect(rollup.containerSeconds).toBe(row.billableSeconds);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // THE END-TO-END REHEARSAL (Story MOTIR-4335 · MOTIR-4545) — a container ran →
  // rows were written → "what did indexing cost?" is answered, by THE SHIPPED
  // READOUT (`scripts/fleetCostReadoutQuery.ts`, the function `pnpm ops:fleet-cost`
  // prints), over the rows this real dispatch wrote to real Postgres.
  //
  // ⚠️ EVERY FIGURE ASSERTED IS THE READOUT'S. The expected values come from the
  // container itself — the controlled observation clock, and the settled
  // outcome's own `billableSeconds` / `costUsd` — never from a query this test
  // wrote. The orchestrator is faked at the port; the claim that a REAL production
  // container wrote a real row is the production verification task's, not this.
  //
  // ⚠️ Internal COGS. Nothing here is a charge.
  describe('the END-TO-END REHEARSAL — dispatch → rows → the shipped readout answers (MOTIR-4545)', () => {
    type Lines = NonNullable<NonNullable<FleetCostReadout['input']>['org']>['lines'];
    const indexLineOf = (lines: Lines) => lines.find((line) => line.workload === 'index');

    async function readoutAt(at: Date) {
      const readout = await buildFleetCostReadout({ organizationId: tenant.organizationId, at });
      if (!readout.input?.org) throw new Error('the meter must be enabled for the rehearsal');
      return { readout, lines: readout.input.org.lines, metaSplit: readout.input.metaSplit };
    }

    it('the HEALTHY run: a checkpoint, a replayed poll that adds nothing, then teardown reconciles — reported under `index`, never `ci`', async () => {
      const booted = await bootWithSkew();
      if (booted.phase !== 'supervising') throw new Error('expected a supervising boot');
      const session = booted.session;
      const observedAt = observedAtFor(session);
      const pollOptions = { ...FAST, indexTimeoutMs: 600_000, now: () => observedAt };

      // (1) Poll while it runs — the CHECKPOINT writes a partial figure.
      await codeGraphIndexDispatchService.pollIndexContainer(
        session,
        INITIAL_INDEX_POLL_STATE,
        pollOptions,
      );
      const partial = await readoutAt(observedAt);
      expect(indexLineOf(partial.lines)).toMatchObject({
        containerCount: 1,
        containerSeconds: OBSERVED_AT_MS / 1000,
      });

      // (2) A REPLAYED poll — the ordinary durable-step path — adds nothing.
      await codeGraphIndexDispatchService.pollIndexContainer(
        session,
        INITIAL_INDEX_POLL_STATE,
        pollOptions,
      );
      const replayed = await readoutAt(observedAt);
      expect(indexLineOf(replayed.lines)).toEqual(indexLineOf(partial.lines));

      // (3) Teardown reconciles the partial accrual to the true total — one container.
      const live = fakeOrchestrator.liveContainerIds();
      if (live[0]) fakeOrchestrator.completeJob(live[0], { exitCode: 0 });
      const settled = await codeGraphIndexDispatchService.settleIndexContainer(session, {
        done: true,
        reason: 'job_completed',
        startedAt: session.handle.createdAt,
        exitCode: 0,
        failureDetail: null,
      });
      if (settled.outcome !== 'settled') throw new Error('expected a settled outcome');
      expect(settled.verdict.indexed).toBe(true);

      // (4) The shipped readout answers the question from the rows that wrote.
      const { readout, lines, metaSplit } = await readoutAt(new Date(session.handle.createdAt));
      const index = indexLineOf(lines);
      expect(index).toMatchObject({ containerCount: 1, containerSeconds: settled.billableSeconds });
      expect(new Prisma.Decimal(index!.costUsd).equals(new Prisma.Decimal(settled.costUsd))).toBe(
        true,
      );
      expect(lines.map((line) => line.workload)).toEqual(['index']);
      // The platform-wide split carries the same container as a TENANT index line.
      expect(metaSplit.find((row) => !row.isMeta && row.workload === 'index')).toMatchObject({
        containerCount: 1,
        containerSeconds: settled.billableSeconds,
      });
      // And what the operator reads says so: the line is printed, `ci` is an absence.
      expect(readout.text).toMatch(new RegExp(`\\bindex\\s+1\\s+${settled.billableSeconds}\\s`));
      expect(readout.text).toContain('This is an ABSENCE, not a measured zero: ci');
    });

    it('the FAILED run: a non-zero exit still writes a row and still appears in the `index` total', async () => {
      const outcome = await codeGraphIndexDispatchService.runIndexContainer(dbInput, {
        ...FAST,
        sleep: completeWith(30),
      });
      if (outcome.outcome !== 'settled') throw new Error('expected a settled outcome');
      expect(outcome.verdict).toMatchObject({ exitClass: 'graph_unbuildable', indexed: false });

      const { lines } = await readoutAt(new Date());
      // A cost line that excluded failures would be the flattering number, not the true one.
      expect(indexLineOf(lines)).toMatchObject({
        containerCount: 1,
        containerSeconds: outcome.billableSeconds,
      });
    });

    it('the NEVER-STARTED run: counted as a container, with the seconds its row actually carries', async () => {
      fakeOrchestrator.setBootBehaviour('never_start');
      const outcome = await codeGraphIndexDispatchService.runIndexContainer(dbInput, {
        ...FAST,
        bootDeadlineMs: 0,
        // ONE container: this case is about how the readout counts it, and a
        // re-dispatch (MOTIR-6586) would count two.
        maxDispatchAttempts: 1,
      });
      if (outcome.outcome !== 'settled') throw new Error('expected a settled outcome');
      expect(outcome.verdict).toMatchObject({ exitClass: 'never_started', indexed: false });

      const { lines } = await readoutAt(new Date());
      // STATED, not inferred: the readout COUNTS the container that never started —
      // teardown wrote its row like every other path — and its seconds are exactly
      // what that row measured, never a figure made up to look like one.
      expect(indexLineOf(lines)).toMatchObject({
        containerCount: 1,
        containerSeconds: outcome.billableSeconds,
      });
      expect(outcome.billableSeconds).toBe(NEVER_STARTED_BILLABLE_SECONDS);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE CORE-SIDE PHASE SPANS (MOTIR-4413) — `docs/decisions/code-graph-index-fleet.md` §6
//
// ⚠️ THE PROPERTY UNDER TEST IS SURVIVAL, NOT ARITHMETIC. Computing three
// subtractions correctly is not what is hard here and not what would break in
// production: `advanceIndexContainer` is re-entered from the top on every pass
// and normally leaves by throwing `JobRunDefer`, so the interesting question is
// whether a number measured on the pass that did the work is still there on the
// pass that writes the ledger row — dozens of runs later. A test that drives one
// pass proves nothing about that, and would pass just as happily against a
// `let elapsed = 0` in the wrong scope.
//
// So both tests below drive MORE THAN ONE PASS, and the clock JUMPS between
// them: a span re-derived from the settling pass's clock would come back wrong
// by the size of the jump, and one accumulated in a local would come back zero.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Budgets for a run that DEFERS. `FAST` is tuned for the in-process composition,
 * where a whole supervision happens inside one call and 500 ms is generous; these
 * tests jump the clock by ninety seconds per pass on purpose, so the same ceiling
 * would fire the deadline transition and settle a container that never ran. The
 * POLL cadence stays at `FAST`'s milliseconds — it is what `pollToDetect` reads.
 */
const SPAN_BUDGETS = {
  bootDeadlineMs: 600_000,
  indexTimeoutMs: 3_600_000,
  pollIntervalMs: 1,
  maxPollIntervalMs: 1,
  admissionWaitMs: 1,
  maxAdmissionWaitMs: 1,
} as const;

/** A memoizing step seam — what `job_step` is to a real run, in a Map. */
function memoizingSeam(memo: Map<string, unknown>) {
  return {
    run: async <T>(id: string, fn: () => T | Promise<T>): Promise<T> => {
      if (memo.has(id)) return memo.get(id) as T;
      // Round-tripped through JSON exactly as the engine's shim does, so a value
      // that only survives because it stayed in memory fails here rather than in
      // production on the second pass.
      const value = JSON.parse(JSON.stringify(await fn())) as T;
      memo.set(id, value);
      return value;
    },
  };
}

/**
 * Drive `advanceIndexContainer` pass by pass until it settles, jumping the clock
 * forward between passes exactly as a real deferral does.
 *
 * Returns the outcome AND the number of passes it took, because "it really did
 * defer" is half of what the tests below are asserting.
 */
async function driveToSettlement(options: {
  memo: Map<string, unknown>;
  store: ReturnType<typeof inMemorySupervisionStore>;
  clock: { ms: number };
  exitCode?: number | null;
}) {
  const { memo, store, clock } = options;
  const now = (): Date => new Date(clock.ms);
  let passes = 0;
  for (let i = 0; i < 50; i += 1) {
    passes += 1;
    try {
      const outcome = await codeGraphIndexDispatchService.advanceIndexContainer(
        'run-spans',
        INPUT,
        {
          ...SPAN_BUDGETS,
          steps: memoizingSeam(memo),
          supervisionStore: store,
          now,
          // The wait a real pass spends suspended, applied to the clock rather
          // than to the wall — one pass of a self-rescheduling supervision.
          sleep: async (ms: number) => {
            clock.ms += ms;
          },
        },
      );
      return { outcome, passes };
    } catch (err) {
      if (!isJobRunDefer(err)) throw err;
      // THE DEFER — and the clock moves a long way, which is the whole point.
      // A pass is scheduled minutes later in production; here it is 90 seconds,
      // chosen to be far larger than any span this run legitimately produced so
      // a recomputation cannot hide inside the noise.
      clock.ms += 90_000;
      if (options.exitCode !== undefined) {
        const live = fakeOrchestrator.liveContainerIds();
        if (live[0]) fakeOrchestrator.completeJob(live[0], { exitCode: options.exitCode });
      }
    }
  }
  throw new Error('the supervision never settled');
}

describe('the CORE-side phase spans survive a JobRunDefer (MOTIR-4413)', () => {
  it('records admission wait, boot and poll-to-detect as THREE spans, per container', async () => {
    const memo = new Map<string, unknown>();
    const store = inMemorySupervisionStore();
    const clock = { ms: Date.parse('2026-09-04T12:00:00.000Z') };

    const { outcome, passes } = await driveToSettlement({ memo, store, clock, exitCode: 0 });

    // The supervision really was a state machine over runs, not one call.
    expect(passes).toBeGreaterThan(1);
    expect(outcome).toMatchObject({ outcome: 'settled', verdict: { indexed: true } });

    const timings = (outcome as Extract<typeof outcome, { outcome: 'settled' }>).coreTimings;
    // THREE spans, never one aggregate: a long admission queue, a slow boot and
    // a lagging poll are three different faults and sum to the same number.
    expect(Object.keys(timings?.phasesMs ?? {}).sort()).toEqual([
      'admissionWait',
      'boot',
      'pollToDetect',
    ]);
    for (const ms of Object.values(timings!.phasesMs)) {
      expect(Number.isFinite(ms)).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(0);
    }
    // The total is the SUM OF WHAT IS PRESENT — never a wall clock the phases
    // are expected to add up to, which is the reading a missing span would break.
    expect(timings!.totalMs).toBe(
      Object.values(timings!.phasesMs).reduce((sum, ms) => sum + ms, 0),
    );
  });

  it('a LATER pass re-derives the SAME spans — they are not reset by the pass that reads them', async () => {
    const memo = new Map<string, unknown>();
    const store = inMemorySupervisionStore();
    const clock = { ms: Date.parse('2026-09-04T12:00:00.000Z') };

    const settled = await driveToSettlement({ memo, store, clock, exitCode: 0 });
    const measured = (settled.outcome as Extract<typeof settled.outcome, { outcome: 'settled' }>)
      .coreTimings;
    expect(measured?.phasesMs.admissionWait).toBeDefined();

    // ── THE REPLAY PASS ──────────────────────────────────────────────────────
    // An hour later, on a fan-out that re-enters every settled subject on every
    // later pass. Every step answers from the memo, the supervision row reads
    // `settled`, and NOTHING is measured on this pass — so if a span were taken
    // from this pass's clock it would be off by an hour, and if it were carried
    // in a local it would be gone.
    clock.ms += 3_600_000;
    const replayed = await driveToSettlement({ memo, store, clock, exitCode: 0 });

    expect(replayed.passes).toBe(1);
    const again = (replayed.outcome as Extract<typeof replayed.outcome, { outcome: 'settled' }>)
      .coreTimings;
    expect(again).toEqual(measured);
  });

  it('OMITS a span whose source is missing, and still settles — telemetry never fails a run', async () => {
    const memo = new Map<string, unknown>();
    const store = inMemorySupervisionStore();
    const clock = { ms: Date.parse('2026-09-04T12:00:00.000Z') };

    // ⚠️ THE REAL CASE THIS COVERS IS A DEPLOYMENT MID-ROLLOUT, not a defensive
    // hypothetical. A run already in flight when this card ships has an
    // `index-admit:<pid>` memo written in the OLD shape — no `requestedAt`, no
    // `admittedAt` — and will replay it for the rest of its life. Seeding that
    // exact row is what proves those runs keep working.
    memo.set(`index-admit:${INPUT.projectId}`, {
      outcome: 'admitted',
      admission: admissionFor(INPUT),
    });

    const { outcome } = await driveToSettlement({ memo, store, clock, exitCode: 0 });

    // The run SETTLED. Nothing threw, and the verdict is untouched.
    expect(outcome).toMatchObject({ outcome: 'settled', verdict: { indexed: true } });

    const timings = (outcome as Extract<typeof outcome, { outcome: 'settled' }>).coreTimings;
    // The two spans that read those instants are ABSENT — not zero, which would
    // be the opposite claim ("this took no time" rather than "unmeasurable").
    expect(timings?.phasesMs).not.toHaveProperty('admissionWait');
    expect(timings?.phasesMs).not.toHaveProperty('boot');
    // And the one with a durable source of its own — the supervision row's poll
    // count — is still reported. A partial reading is worth more than none.
    expect(timings?.phasesMs.pollToDetect).toBeGreaterThanOrEqual(0);
    expect(timings?.totalMs).toBe(timings?.phasesMs.pollToDetect);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE SYNC / REBUILD MODE (MOTIR-4945) — `docs/decisions/code-graph-index-fleet.md` §6
//
// ⚠️ THE PROPERTY UNDER TEST IS SURVIVAL, exactly as it is for the spans above,
// and for a sharper reason. The mode is known at BOOT — `previousSnapshotUrl` is
// in hand when the spec is built — and it is written at SETTLE, minutes and
// several invocations later. Nothing in between re-derives it from the world, so
// the only thing carrying it is the `index-boot:<projectId>` memo. A boolean held
// in a closure would pass a single-pass test and be `undefined` in production on
// the second pass, which is the pass that writes the ledger row.
//
// So these tests drive MORE THAN ONE PASS through `driveToSettlement`, whose step
// seam JSON-round-trips every memo — a value that survives only because it stayed
// in memory fails here rather than in production.
//
// ⚠️ THE FAKE CLOCK IS DATED IN THE PAST, and it is not arbitrary. The supervision
// runs on `clock.ms`, but `credentialResponse` mints `expiresAt` from the REAL
// `Date.now()` — so a fake clock set to "today" puts the container deadline
// (`clock.ms + indexTimeoutMs`) BEYOND a credential minted now, and every boot
// dies on MOTIR-4923's run-credential floor before reaching what is under test.
// The date matches the span tests above for exactly this reason; keep it behind
// the wall clock.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A credential response that GRANTS the sync — motir-ai offering a snapshot.
 *
 * The TTL is the same default {@link credentialResponse} serves, so a run driven
 * through here still clears the run-credential floor MOTIR-4923 installed rather
 * than passing because this suite quietly handed it a different clock.
 */
function credentialResponseWithSnapshot(): Response {
  return json(201, {
    credential: RUN_CREDENTIAL,
    expiresAt: new Date(Date.now() + AI_DEFAULT_TTL_SECONDS * 1000).toISOString(),
    previousSnapshotUrl: SNAPSHOT_URL,
  });
}

describe('the sync/rebuild MODE survives a JobRunDefer (MOTIR-4945)', () => {
  it('records `rebuild` when motir-ai offered NO snapshot', async () => {
    const memo = new Map<string, unknown>();
    const store = inMemorySupervisionStore();
    const clock = { ms: Date.parse('2026-09-04T12:00:00.000Z') };

    const { outcome, passes } = await driveToSettlement({ memo, store, clock, exitCode: 0 });

    // The supervision really was a state machine over runs, not one call — the
    // same guard the span tests carry, and for the same reason.
    expect(passes).toBeGreaterThan(1);
    expect(outcome).toMatchObject({ outcome: 'settled', verdict: { indexed: true } });
    expect((outcome as Extract<typeof outcome, { outcome: 'settled' }>).indexMode).toBe('rebuild');
  });

  it('records `sync` when motir-ai DID offer one — the same value the spec branched on', async () => {
    credentialResponder = credentialResponseWithSnapshot;

    const memo = new Map<string, unknown>();
    const store = inMemorySupervisionStore();
    const clock = { ms: Date.parse('2026-09-04T12:00:00.000Z') };

    const { outcome, passes } = await driveToSettlement({ memo, store, clock, exitCode: 0 });

    expect(passes).toBeGreaterThan(1);
    expect((outcome as Extract<typeof outcome, { outcome: 'settled' }>).indexMode).toBe('sync');

    // ⚠️ AND THE MODE AGREES WITH WHAT THE CONTAINER WAS ACTUALLY HANDED. This is
    // the assertion that makes the field trustworthy rather than merely present:
    // the ledger may not claim `sync` for a run that was given no snapshot to
    // sync against, so the recorded mode is checked against the environment the
    // boot really produced, not against the response we stubbed.
    const booted = fakeOrchestrator.specs.at(-1);
    expect(booted?.env['MOTIR_INDEX_SNAPSHOT_URL']).toBe(SNAPSHOT_URL);
  });

  it('a LATER pass re-derives the SAME mode — it is not lost by the pass that reads it', async () => {
    credentialResponder = credentialResponseWithSnapshot;

    const memo = new Map<string, unknown>();
    const store = inMemorySupervisionStore();
    const clock = { ms: Date.parse('2026-09-04T12:00:00.000Z') };

    const settled = await driveToSettlement({ memo, store, clock, exitCode: 0 });
    expect(
      (settled.outcome as Extract<typeof settled.outcome, { outcome: 'settled' }>).indexMode,
    ).toBe('sync');

    // ── THE REPLAY PASS ──────────────────────────────────────────────────────
    // An hour later, answering entirely from the memo — and, critically, with the
    // credential endpoint now REFUSING to offer a snapshot. A mode re-minted from
    // the world on this pass would come back `rebuild`; one read off the boot memo
    // comes back `sync`, which is what actually happened.
    credentialResponder = credentialResponse;
    clock.ms += 3_600_000;
    const replayed = await driveToSettlement({ memo, store, clock, exitCode: 0 });

    expect(replayed.passes).toBe(1);
    expect(
      (replayed.outcome as Extract<typeof replayed.outcome, { outcome: 'settled' }>).indexMode,
    ).toBe('sync');
  });

  it('OMITS the mode — never guesses `rebuild` — when the boot memo predates this card', async () => {
    // ⚠️ THE REAL CASE THIS COVERS IS A DEPLOYMENT MID-ROLLOUT, not a defensive
    // hypothetical, and it is the one arm where a wrong answer would be invisible.
    // A run already in flight holds an `index-boot:<pid>` memo written in the OLD
    // shape — no `syncGranted` — and replays it for the rest of its life. If the
    // absence collapsed to `rebuild`, those runs would report the COMMONER mode,
    // so every wrong row would look exactly right, and the first measurement
    // anybody takes of what a sync saves would be quietly polluted.
    const memo = new Map<string, unknown>();
    const store = inMemorySupervisionStore();
    const clock = { ms: Date.parse('2026-09-04T12:00:00.000Z') };

    // Drive once to obtain a REAL boot memo, then strip the new field from it —
    // so the seeded row is the genuine old shape rather than one hand-written to
    // match today's expectations.
    const first = await driveToSettlement({ memo, store, clock, exitCode: 0 });
    expect((first.outcome as Extract<typeof first.outcome, { outcome: 'settled' }>).indexMode).toBe(
      'rebuild',
    );

    const bootKey = `index-boot:${INPUT.projectId}`;
    const booted = memo.get(bootKey) as { session?: Record<string, unknown> } | undefined;
    expect(booted?.session).toHaveProperty('syncGranted');
    delete booted!.session!.syncGranted;

    const replayed = await driveToSettlement({ memo, store, clock, exitCode: 0 });

    // The run SETTLED. Nothing threw, and the verdict is untouched — a ledger
    // field may never fail a run.
    expect(replayed.outcome).toMatchObject({ outcome: 'settled', verdict: { indexed: true } });
    // And the mode is ABSENT, not `rebuild`. Absent means UNKNOWN.
    const out = replayed.outcome as Extract<typeof replayed.outcome, { outcome: 'settled' }>;
    expect(out).not.toHaveProperty('indexMode');
    // The spans beside it are unaffected — the two channels are independent.
    expect(out.coreTimings).toBeDefined();
  });
});
