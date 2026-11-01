import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobTestEngine } from '../helpers/jobs';
import { db } from '@/lib/db';
import { defineJob } from '@/lib/jobs/defineJob';
import {
  dailyHealthCheck,
  DAILY_HEALTH_CHECK_PAYLOAD,
  DAILY_HEALTH_CHECK_CRON,
} from '@/lib/jobs/definitions/dailyHealthCheck';
import { registerMonitorProvider } from '@/lib/monitors/registry';
import { sentryMonitorProvider } from '@/lib/monitors/providers/sentry';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { seedHealthyJobSchedules } from '../helpers/jobs';
import { Prisma } from '@/generated/prisma/client';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { classifyRunner, MOTIR_FLEET_RUNNER_FAMILY } from '@/lib/ciMetering/runnerRates';

// Scheduled-job primitive (Story 1.6 · Subtask 1.6.4) — the replacement for the
// 1.6.2 system.ping smoke test. Drives the `system.daily-health-check` cron job
// IN-PROCESS via the in-process JobTestEngine (no live scheduler / dev server / cloud) and
// asserts the contract the scheduled path provides:
//   1. the function resolves to its static payload, and
//   2. the defineJob wrapper persisted a succeeded job_run row whose event_name
//      is the SYNTHETIC `scheduled.system.daily-health-check` (not Inngest's
//      internal cron-timer event name) — so the dashboard treats scheduled +
//      event-triggered runs uniformly, and
//   3. the cron expression is wired into the Inngest function config.

beforeEach(async () => {
  await truncateJobRuns();
});

// ── Registry fixtures for the two pull paths (MOTIR-2030) ────────────────────
//
// The runner pulls from ghcr.io (public, §1) and the indexer from
// registry.fly.io (a mirror of a closed image, §5). Keeping them on DIFFERENT
// hosts is what lets a test prove which path a verdict is about — a fixture
// where both images were the same string would pass for a preflight that probed
// the runner twice, which is the bug MOTIR-2030 fixes.

const RUNNER_REPO = 'motir-co/motir-ci-runner';
const RUNNER_IMAGE = `ghcr.io/${RUNNER_REPO}@sha256:446c692d`;
const INDEXER_REPO = 'motir-ci-fleet/motir-indexer';
const INDEXER_IMAGE = `registry.fly.io/${INDEXER_REPO}@sha256:9f2c1ab4`;
/** The address a deployment hands an index container for motir-ai (MOTIR-4518) —
 *  motir-ai's PUBLIC ingress, and deliberately not `MOTIR_AI_URL`. */
const CONTAINER_AI_URL = 'https://ai-public.example.test';

function jsonRes(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** The `WWW-Authenticate` a v2 registry returns for THIS manifest URL — realm,
 *  service and scope all derived from the request, so one fixture serves both
 *  registries and neither can accidentally answer for the other. */
function challengeFor(url: URL): string {
  const repo = url.pathname.replace(/^\/v2\//, '').replace(/\/manifests\/.*$/, '');
  return `Bearer realm="https://${url.host}/token",service="${url.host}",scope="repository:${repo}:pull"`;
}

/** A v2 registry that hands out an anonymous token only for `publicRepos`, then
 *  serves the manifest to a bearer — the measured GHCR flow (ADR §2.1). */
function serveManifest(rawUrl: string, init: RequestInit | undefined, publicRepos: string[]) {
  const url = new URL(String(rawUrl));
  if (url.pathname === '/token') {
    const scope = url.searchParams.get('scope') ?? '';
    return publicRepos.some((repo) => scope.includes(repo))
      ? jsonRes(200, { token: 'anon-pull-token' })
      : jsonRes(401, { errors: [{ code: 'UNAUTHORIZED', message: 'authentication required' }] });
  }
  const auth = (init?.headers as Record<string, string> | undefined)?.['authorization'];
  return auth
    ? jsonRes(200, {}, { 'docker-content-digest': 'sha256:deadbeef' })
    : jsonRes(401, {}, { 'www-authenticate': challengeFor(url) });
}

function registryServing(publicRepos: string[]) {
  return vi.fn(async (rawUrl: string, init?: RequestInit) =>
    serveManifest(rawUrl, init, publicRepos),
  );
}

// The fleet-preflight tests below stub env + `fetch`; unwinding them per test
// keeps a stubbed registry from following the next one.
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// A cron job has NO event trigger, so we invoke it WITHOUT an `events` array:
// the in-process JobTestEngine then drives it via the internal `inngest/function.invoked`
// event (the direct-invoke path), which bypasses trigger-event validation. The
// wrapper records the ledger event_name as the synthetic `scheduled.{id}`
// regardless, so the assertions below prove the override.

// As of MOTIR-1970 the health check carries a real probe (the schedule-health
// check), so it only SUCCEEDS when every registered cron job is firing. These
// tests are about the scheduled-path primitive, not the probe, so they make the
// schedules healthy first — the probe's own behaviour is covered in
// `schedule-health.test.ts`.

describe('system.daily-health-check scheduled job', () => {
  it('runs to completion and returns the static payload', async () => {
    await seedHealthyJobSchedules();
    const engine = new JobTestEngine({ function: dailyHealthCheck });
    const { result } = await engine.execute();

    expect(result).toMatchObject(DAILY_HEALTH_CHECK_PAYLOAD);
  });

  it('writes a succeeded job_run row with the synthetic scheduled event name', async () => {
    await seedHealthyJobSchedules();
    const engine = new JobTestEngine({ function: dailyHealthCheck });
    await engine.execute();

    // Only the wrapper writes a row for THIS function (the seed skips it), so
    // there is exactly one and it is the one under test.
    const runs = await adminDb.jobRun.findMany({
      where: { functionId: 'system.daily-health-check' },
    });
    expect(runs).toHaveLength(1);

    const run = runs[0]!;
    expect(run.functionId).toBe('system.daily-health-check');
    // The ledger event name is the synthetic scheduled.{id}, NOT event.name.
    expect(run.eventName).toBe('scheduled.system.daily-health-check');
    expect(run.status).toBe('succeeded');
    // System job → untenanted.
    expect(run.workspaceId).toBeNull();
    expect(run.finishedAt).not.toBeNull();
    expect(run.durationMs).not.toBeNull();
    expect(run.failure).toBeNull();
  });

  it('wires the cron expression into the Inngest function config', () => {
    const def = defineJob(
      { id: 'system.daily-health-check', cron: DAILY_HEALTH_CHECK_CRON, catchUp: 'latest' },
      () => undefined,
    );
    expect(def.cron).toBe('0 9 * * *');
  });
});

// ── THE FLEET BOOT PREFLIGHT'S HUMAN-VISIBLE SURFACE (MOTIR-2006) ────────────
//
// §6.1 of `docs/decisions/fleet-image-pull.md` asks for a preflight that "fails
// loudly, once, naming the image reference and the registry's own error". LOUDLY
// means somewhere a person looks: this job's `retryPolicy: 'none'` sends a
// failure straight to the DLQ, whose tab on the staff ledger (`/admin/jobs`)
// counts it and renders `job_run.failure`. So the tests
// below assert the two things that make that surface worth having — that the row
// EXISTS, and that its message is a diagnosis rather than "the fleet is
// unhealthy".
//
// MOTIR-1980 is why: the fleet shipped unbootable and nothing anywhere said so.

describe('the fleet boot preflight rides the daily health check', () => {
  it('records the verdict on a HEALTHY tick — including when there is no fleet to check', async () => {
    // An unwired deployment is not a fault (a self-hosted `motir-core` has no
    // fleet at all), but the ledger still says which state it was in. A result
    // that only appeared on failure could not tell `not_applicable` from
    // `bootable`, and those are very different deployments.
    await seedHealthyJobSchedules();
    const engine = new JobTestEngine({ function: dailyHealthCheck });
    const { result } = await engine.execute();

    expect(result).toMatchObject({ ok: true, fleet: { verdict: 'not_applicable' } });
  });

  it('FAILS the run with a legible message when the configured image cannot be pulled', async () => {
    // The real chain, not a stubbed verdict: env selects Fly with a digest-pinned
    // image, and the registry refuses an anonymous pull token exactly as ghcr.io
    // does for a private package (measured 2026-08-02).
    await seedHealthyJobSchedules();
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', 'fly_fleet_token');
    vi.stubEnv('FLY_FLEET_APP', 'motir-ci-fleet');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', 'ghcr.io/motir-co/motir-ci-runner@sha256:446c692d');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (rawUrl: string): Promise<Response> => {
        const url = new URL(String(rawUrl));
        const body =
          url.pathname === '/token'
            ? { errors: [{ code: 'UNAUTHORIZED', message: 'authentication required' }] }
            : {};
        return new Response(JSON.stringify(body), {
          status: 401,
          headers: {
            'content-type': 'application/json',
            'www-authenticate':
              'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:motir-co/motir-ci-runner:pull"',
          },
        });
      }),
    );

    const engine = new JobTestEngine({ function: dailyHealthCheck });
    // `the in-process JobTestEngine` CAPTURES a handler throw onto `error` rather than
    // rejecting — the same shape `schedule-health.test.ts` reads.
    const { result, error } = (await engine.execute()) as {
      result?: unknown;
      error?: { message?: string };
    };

    expect(result).toBeUndefined();
    // ⚠️ THE MESSAGE IS THE WHOLE SURFACE. It becomes `job_run.failure`, which
    // the DLQ detail panel renders and nothing beside it — so the diagnosis has
    // to be IN there: which image, what happened, and where to go next.
    expect(error?.message).toContain('ghcr.io/motir-co/motir-ci-runner@sha256:446c692d');
    expect(error?.message).toContain('No CI container can boot');
    expect(error?.message).toContain('MOTIR_RUNNER_IMAGE');
    expect(error?.message).toContain('registry visibility');
  });

  it('does NOT fail the run when the registry merely could not be REACHED', async () => {
    // ⚠️ The arm that keeps the row trustworthy. A DNS blip is not a statement
    // about the image, and an alarm that fires on ghcr.io's uptime is one an
    // operator learns to ignore — which is how the next real MOTIR-1980 gets
    // missed.
    await seedHealthyJobSchedules();
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', 'fly_fleet_token');
    vi.stubEnv('FLY_FLEET_APP', 'motir-ci-fleet');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', 'ghcr.io/motir-co/motir-ci-runner@sha256:446c692d');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND ghcr.io');
      }),
    );

    const engine = new JobTestEngine({ function: dailyHealthCheck });
    const { result } = await engine.execute();

    // Green, but the indeterminate verdict is ON the row — a run of consecutive
    // ones is readable; it is just not an alarm.
    expect(result).toMatchObject({ ok: true, fleet: { verdict: 'indeterminate' } });
  });
});

// ── THE SECOND PULL PATH RIDES THE SAME SURFACE (MOTIR-2030) ─────────────────
//
// §5's third constraint on the indexer's mirror: "It is a second pull path. The
// fleet then has two, and each needs §6's preflight independently." The tests
// above cover the RUNNER's path and are unchanged; these cover the INDEXER's,
// and the thing they most need to pin is that the two verdicts stay TOLD APART
// — on the ledger row and, when it fails, in the message an operator reads.

describe("the INDEXER image's preflight rides the same health check", () => {
  /** A cloud deployment wired for CI, with the indexer optionally wired too. */
  function stubFleet(indexerImage?: string) {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', 'fly_fleet_token');
    vi.stubEnv('FLY_FLEET_APP', 'motir-ci-fleet');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', RUNNER_IMAGE);
    vi.stubEnv('MOTIR_INDEXER_IMAGE', indexerImage ?? '');
  }

  it('records BOTH verdicts on a healthy tick, and they can differ', async () => {
    // The ordinary cloud state today: CI is wired and indexing is not. A single
    // merged verdict could not express it — and "the fleet is fine" would be
    // true of a deployment that cannot index at all.
    await seedHealthyJobSchedules();
    stubFleet();
    vi.stubGlobal('fetch', registryServing([RUNNER_REPO]));

    const engine = new JobTestEngine({ function: dailyHealthCheck });
    const { result } = await engine.execute();

    expect(result).toMatchObject({
      ok: true,
      fleet: { verdict: 'bootable', reference: RUNNER_IMAGE },
      indexFleet: { verdict: 'not_applicable' },
    });
  });

  it('FAILS the run naming the INDEXER image when its registry refuses — with CI perfectly healthy', async () => {
    // ⚠️ THE CARD'S CENTRAL ASSERTION. The runner image is pullable throughout,
    // so a preflight that still probed only one image would report a GREEN run
    // while no index container could boot — the MOTIR-1980 shape, one workload
    // over. The message must name the INDEXER's reference, because it is the
    // whole of what the DLQ detail panel renders.
    await seedHealthyJobSchedules();
    stubFleet(INDEXER_IMAGE);
    // Fly's registry has collected the mirrored digest (§5.2); ghcr.io still
    // serves the runner.
    vi.stubGlobal('fetch', registryServing([RUNNER_REPO]));

    const engine = new JobTestEngine({ function: dailyHealthCheck });
    const { result, error } = (await engine.execute()) as {
      result?: unknown;
      error?: { message?: string };
    };

    expect(result).toBeUndefined();
    expect(error?.message).toContain(INDEXER_IMAGE);
    expect(error?.message).toContain('MOTIR_INDEXER_IMAGE');
    // It names the INDEXER's failure and its likeliest cause — not the runner's
    // image, and not GHCR visibility, which would send the fix to the wrong
    // registry entirely.
    expect(error?.message).not.toContain(RUNNER_IMAGE);
    expect(error?.message).toContain('garbage-collects');
    expect(error?.message).toContain('CI is unaffected');
  });

  it('does NOT fail the run when the indexer registry merely could not be REACHED', async () => {
    // Same boundary the runner's path holds: a transport failure is not a claim
    // about the image, and an alarm on registry uptime is one an operator learns
    // to ignore.
    await seedHealthyJobSchedules();
    stubFleet(INDEXER_IMAGE);
    // A deployment that indexes owes the container an address it can resolve
    // (MOTIR-4518); without it the run fails on THAT probe instead, which is a
    // different assertion from the one this test makes.
    vi.stubEnv('MOTIR_AI_CONTAINER_URL', CONTAINER_AI_URL);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (rawUrl: string, init?: RequestInit): Promise<Response> => {
        // The runner resolves; only Fly's registry is unreachable. Matched on
        // the parsed HOST rather than a substring of the URL — the host is the
        // thing that is actually unreachable, and a substring test would also
        // fire for any other host carrying it in a path (CodeQL
        // `js/incomplete-url-substring-sanitization`).
        const host = new URL(String(rawUrl)).host;
        if (host === 'registry.fly.io') {
          throw new Error('getaddrinfo ENOTFOUND registry.fly.io');
        }
        // The container-address probe (MOTIR-4518) rides the same stubbed fetch.
        if (host === new URL(CONTAINER_AI_URL).host) return new Response('ok', { status: 200 });
        return serveManifest(rawUrl, init, [RUNNER_REPO]);
      }),
    );

    const engine = new JobTestEngine({ function: dailyHealthCheck });
    const { result } = await engine.execute();

    expect(result).toMatchObject({
      ok: true,
      fleet: { verdict: 'bootable' },
      indexFleet: { verdict: 'indeterminate', reference: INDEXER_IMAGE },
      indexContainerAi: { verdict: 'reachable', address: CONTAINER_AI_URL },
    });
  });
});

// ── THE HOSTED-AGENT IMAGE RIDES THE SAME SURFACE (MOTIR-9420) ──────────────
//
// The third pull path, probed anonymously the way an agent-runner VM pulls it.
// Its verdict is recorded beside the other two, and only a definite refusal is
// loud, with a message naming the hosted-agent image and its variable.

describe("the HOSTED-AGENT image's preflight rides the same health check", () => {
  const HOSTED_REPO = 'motir-co/motir-hosted-agent';
  const HOSTED_IMAGE = `ghcr.io/${HOSTED_REPO}@sha256:${'b'.repeat(64)}`;

  function stubFleet(hostedImage: string) {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', 'fly_fleet_token');
    vi.stubEnv('FLY_FLEET_APP', 'motir-ci-fleet');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', RUNNER_IMAGE);
    vi.stubEnv('MOTIR_INDEXER_IMAGE', '');
    vi.stubEnv('MOTIR_HOSTED_AGENT_IMAGE', hostedImage);
  }

  it('records the verdict on a healthy tick, beside the fleet and indexer ones', async () => {
    await seedHealthyJobSchedules();
    stubFleet(HOSTED_IMAGE);
    vi.stubGlobal('fetch', registryServing([RUNNER_REPO, HOSTED_REPO]));

    const engine = new JobTestEngine({ function: dailyHealthCheck });
    const { result } = await engine.execute();

    expect(result).toMatchObject({
      ok: true,
      fleet: { verdict: 'bootable', reference: RUNNER_IMAGE },
      indexFleet: { verdict: 'not_applicable' },
      hostedAgentImage: { verdict: 'bootable', reference: HOSTED_IMAGE },
    });
  });

  it('records `not_applicable` on a deployment that runs no hosted agent', async () => {
    await seedHealthyJobSchedules();
    stubFleet('');
    vi.stubGlobal('fetch', registryServing([RUNNER_REPO]));

    const engine = new JobTestEngine({ function: dailyHealthCheck });
    const { result } = await engine.execute();

    expect(result).toMatchObject({ ok: true, hostedAgentImage: { verdict: 'not_applicable' } });
  });

  it('FAILS the run naming the hosted-agent image when it cannot be pulled anonymously', async () => {
    await seedHealthyJobSchedules();
    stubFleet(HOSTED_IMAGE);
    // The runner is public; the hosted-agent package has gone private.
    vi.stubGlobal('fetch', registryServing([RUNNER_REPO]));

    const engine = new JobTestEngine({ function: dailyHealthCheck });
    const { result, error } = (await engine.execute()) as {
      result?: unknown;
      error?: { name?: string; message?: string };
    };

    expect(result).toBeUndefined();
    expect(error?.name).toBe('HostedAgentImageUnpullableError');
    expect(error?.message).toContain(HOSTED_IMAGE);
    expect(error?.message).toContain('MOTIR_HOSTED_AGENT_IMAGE');
    expect(error?.message).toContain('anonymously');
    expect(error?.message).not.toContain(RUNNER_IMAGE);
  });
});

// ── THE THIRD FAULT ON THE SAME SURFACE (MOTIR-4518) ─────────────────────────
//
// Both probes above ask whether a container can BOOT. Neither has ever asked
// whether the booted container can REACH anything, and that is where the fleet
// spent two weeks: pullable image, successful boot, repository downloaded, 45 MB
// graph built, and then `getaddrinfo ENOTFOUND motir-ai.internal` one call before
// it could be uploaded — because motir-core handed the container motir-core's own
// private motir-ai address and the container runs in another organization. Both
// image verdicts were green the whole time, correctly. These pin the probe that
// asks the other question, and that the three verdicts stay TOLD APART.

describe("the index container's motir-ai ADDRESS rides the same health check", () => {
  function stubIndexingFleet() {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', 'fly_fleet_token');
    vi.stubEnv('FLY_FLEET_APP', 'motir-ci-fleet');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', RUNNER_IMAGE);
    vi.stubEnv('MOTIR_INDEXER_IMAGE', INDEXER_IMAGE);
  }

  /** Both registries serve, and the container address answers. */
  function everythingServes() {
    return vi.fn(async (rawUrl: string, init?: RequestInit): Promise<Response> => {
      if (new URL(String(rawUrl)).host === new URL(CONTAINER_AI_URL).host) {
        return new Response('ok', { status: 200 });
      }
      return serveManifest(rawUrl, init, [RUNNER_REPO, INDEXER_REPO]);
    });
  }

  it('records the verdict on a healthy tick, beside the two image ones', async () => {
    await seedHealthyJobSchedules();
    stubIndexingFleet();
    vi.stubEnv('MOTIR_AI_CONTAINER_URL', CONTAINER_AI_URL);
    vi.stubGlobal('fetch', everythingServes());

    const engine = new JobTestEngine({ function: dailyHealthCheck });
    const { result } = await engine.execute();

    expect(result).toMatchObject({
      ok: true,
      fleet: { verdict: 'bootable' },
      indexFleet: { verdict: 'bootable' },
      indexContainerAi: { verdict: 'reachable', address: CONTAINER_AI_URL, status: 200 },
    });
  });

  it('FAILS the run when the container is given a PRIVATE address — with both images perfectly pullable', async () => {
    // ⚠️ THE CARD'S GUARD, in the exact state that shipped. `MOTIR_AI_URL` is the
    // private seam and stays that way; what is wrong is that the CONTAINER's
    // variable carries it too. Note that no probe is involved: from this process
    // the address resolves, which is precisely why the verdict has to be
    // structural.
    await seedHealthyJobSchedules();
    stubIndexingFleet();
    vi.stubEnv('MOTIR_AI_URL', 'http://motir-ai.internal:8080');
    vi.stubEnv('MOTIR_AI_CONTAINER_URL', 'http://motir-ai.internal:8080');
    vi.stubGlobal('fetch', everythingServes());

    const engine = new JobTestEngine({ function: dailyHealthCheck });
    const { result, error } = (await engine.execute()) as {
      result?: unknown;
      error?: { message?: string };
    };

    expect(result).toBeUndefined();
    // The message sends an operator to the right system: a Fly SECRET on
    // motir-core, not a registry. Sending them to re-run an image mirror for a
    // name-resolution fault is what two weeks of green image probes already did.
    expect(error?.message).toContain('motir-ai.internal');
    expect(error?.message).toContain('MOTIR_AI_CONTAINER_URL');
    expect(error?.message).not.toContain(INDEXER_IMAGE);
    expect(error?.message).not.toContain('garbage-collects');
  });

  it('FAILS the run when a deployment that indexes has no container address at all', async () => {
    await seedHealthyJobSchedules();
    stubIndexingFleet();
    vi.stubEnv('MOTIR_AI_CONTAINER_URL', '');
    vi.stubGlobal('fetch', everythingServes());

    const engine = new JobTestEngine({ function: dailyHealthCheck });
    const { result, error } = (await engine.execute()) as {
      result?: unknown;
      error?: { message?: string };
    };

    expect(result).toBeUndefined();
    expect(error?.message).toContain('MOTIR_AI_CONTAINER_URL');
    // And it says why there is no fallback, because "just point it at
    // MOTIR_AI_URL" is the fix an operator would otherwise reach for — and is
    // the defect.
    expect(error?.message).toContain('MOTIR_AI_URL');
  });

  it('does NOT fail the run when this process merely could not REACH the address', async () => {
    // Same boundary both image probes hold: a transport failure is a statement
    // about motir-core's network, not about the address. It is on the row either
    // way.
    await seedHealthyJobSchedules();
    stubIndexingFleet();
    vi.stubEnv('MOTIR_AI_CONTAINER_URL', CONTAINER_AI_URL);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (rawUrl: string, init?: RequestInit): Promise<Response> => {
        if (new URL(String(rawUrl)).host === new URL(CONTAINER_AI_URL).host) {
          throw new Error('fetch failed');
        }
        return serveManifest(rawUrl, init, [RUNNER_REPO, INDEXER_REPO]);
      }),
    );

    const engine = new JobTestEngine({ function: dailyHealthCheck });
    const { result } = await engine.execute();

    expect(result).toMatchObject({
      ok: true,
      indexFleet: { verdict: 'bootable' },
      indexContainerAi: { verdict: 'indeterminate', address: CONTAINER_AI_URL },
    });
  });

  it('is NOT_APPLICABLE on a deployment that does not index — the container variable is not owed', async () => {
    await seedHealthyJobSchedules();
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', 'fly_fleet_token');
    vi.stubEnv('FLY_FLEET_APP', 'motir-ci-fleet');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', RUNNER_IMAGE);
    vi.stubEnv('MOTIR_INDEXER_IMAGE', '');
    vi.stubEnv('MOTIR_AI_CONTAINER_URL', '');
    vi.stubGlobal('fetch', registryServing([RUNNER_REPO]));

    const engine = new JobTestEngine({ function: dailyHealthCheck });
    const { result } = await engine.execute();

    expect(result).toMatchObject({
      ok: true,
      fleet: { verdict: 'bootable' },
      indexFleet: { verdict: 'not_applicable' },
      indexContainerAi: { verdict: 'not_applicable' },
    });
  });
});

describe('the REBUILD-STREAK probe rides the same health check', () => {
  /** A cloud deployment wired for CI only — the ordinary state, and the one in
   *  which every other probe is green while the index rebuilds every run. */
  function stubCiFleet() {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', 'fly_fleet_token');
    vi.stubEnv('FLY_FLEET_APP', 'motir-ci-fleet');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', RUNNER_IMAGE);
    vi.stubEnv('MOTIR_INDEXER_IMAGE', '');
  }

  // ── The FIFTH probe: the rebuild streak (MOTIR-5027) ───────────────────────
  //
  // The only probe here that reads the LEDGER, so its fixture is `job_run` rows
  // rather than an env var and a stubbed registry. Rows are untenanted
  // (`workspace_id IS NULL`) because that is what a `system.*` job writes and
  // what the read's `withSystemContext` admits.

  async function seedCodeGraphRuns(count: number, mode: 'sync' | 'rebuild') {
    for (let i = 0; i < count; i += 1) {
      await adminDb.jobRun.create({
        data: {
          workspaceId: null,
          functionId: 'system.code-graph-refresh',
          eventName: 'scheduled.system.code-graph-refresh',
          eventId: `evt-cg-${mode}-${i}-${Date.now()}`,
          lane: 'engine',
          attempt: 1,
          status: 'succeeded',
          startedAt: new Date(Date.UTC(2026, 8, 1, 0, 0, i)),
          output: {
            indexed: true,
            repoRef: 'moooon-B-V/motir-core',
            projectsIndexed: 1,
            indexModes: [{ projectId: 'p0', mode }],
          },
        },
      });
    }
  }

  it('records the streak verdict on a HEALTHY tick too — so the ledger answers "was it still incremental yesterday?"', async () => {
    // The same reason every other verdict here is recorded on success: a green
    // run that says `not_applicable` and one that says the index is syncing are
    // very different states, and a field that only appeared on failure could not
    // tell them apart.
    await seedHealthyJobSchedules();
    stubCiFleet();
    vi.stubGlobal('fetch', registryServing([RUNNER_REPO]));
    await seedCodeGraphRuns(3, 'sync');

    const engine = new JobTestEngine({ function: dailyHealthCheck });
    const { result } = await engine.execute();

    expect(result).toMatchObject({
      ok: true,
      indexRebuildStreak: { verdict: 'ok' },
    });
    // The boundary is on the recorded row, not only in the failure path.
    expect(
      (result as { indexRebuildStreak: { blindSpot: string } }).indexRebuildStreak.blindSpot,
    ).toContain('OFFERED');
  });

  it('FAILS the run when a repository has rebuilt N consecutive times — with every OTHER probe green', async () => {
    // ⚠️ THE CARD'S CENTRAL ASSERTION. The schedules are healthy, both images
    // pull, the container address is fine — the exact state production was in
    // for twenty days while the graph was rebuilt from scratch on every run and
    // nothing said so. The message is the whole of what the DLQ panel renders,
    // so it must name the repository, the fork, AND what it did not measure.
    await seedHealthyJobSchedules();
    stubCiFleet();
    vi.stubGlobal('fetch', registryServing([RUNNER_REPO]));
    await seedCodeGraphRuns(6, 'rebuild');

    const engine = new JobTestEngine({ function: dailyHealthCheck });
    const { result, error } = (await engine.execute()) as {
      result?: unknown;
      error?: { message?: string };
    };

    expect(result).toBeUndefined();
    expect(error?.message).toContain('moooon-B-V/motir-core');
    expect(error?.message).toContain('MOTIR_INDEXER_IMAGE');
    expect(error?.message).toContain('codegraphVersion');
    // The blind spot travels into the DLQ row with the diagnosis.
    expect(error?.message).toContain('OFFERED');
  });
  // ── The SIXTH probe: monitor configuration (MOTIR-5831) ───────────────────
  //
  // The only probe here that asserts something about THIS PROCESS'S OWN
  // ENVIRONMENT, so its fixture is `vi.stubEnv` and nothing else — no registry,
  // no address, no ledger rows. It reads through the provider registry, so the
  // REAL adapter has to be registered for its declaration to be non-empty; the
  // suite may have left the fake under `sentry`.

  const SENTRY_NAMES = ['SENTRY_APP_CLIENT_ID', 'SENTRY_APP_CLIENT_SECRET', 'SENTRY_APP_SLUG'];

  /** Every probe ABOVE this one green, so a red run can only be this one. */
  function greenExceptMonitorConfig() {
    stubCiFleet();
    vi.stubGlobal('fetch', registryServing([RUNNER_REPO]));
    registerMonitorProvider(sentryMonitorProvider, 'sentry');
    for (const name of SENTRY_NAMES) vi.stubEnv(name, '');
  }

  it('PASSES when no monitor provider is configured — a deployment that never connected one', async () => {
    // ⚠️ THE ARM THAT KEEPS THIS PROBE FROM CRYING WOLF, and it is the common
    // case: `sentry` is registered at import in EVERY build, including a
    // self-hosted one that will never connect an error monitor. Failing here
    // would dead-letter this job every morning over a state its operator chose.
    await seedHealthyJobSchedules();
    greenExceptMonitorConfig();

    const engine = new JobTestEngine({ function: dailyHealthCheck });
    const { result } = await engine.execute();

    expect(result).toMatchObject({ ok: true, monitorConfig: { verdict: 'not_applicable' } });
  });

  it('records the verdict on a HEALTHY tick too, with the blind spot on it', async () => {
    // The same reason every other verdict here is recorded on success: the
    // ledger has to be able to answer "was the integration fully configured
    // yesterday?", and `complete` and `not_applicable` are very different
    // states that a field appearing only on failure could not tell apart.
    await seedHealthyJobSchedules();
    greenExceptMonitorConfig();
    for (const name of SENTRY_NAMES) vi.stubEnv(name, 'set');

    const engine = new JobTestEngine({ function: dailyHealthCheck });
    const { result } = await engine.execute();

    expect(result).toMatchObject({ ok: true, monitorConfig: { verdict: 'complete' } });
    expect((result as { monitorConfig: { blindSpot: string } }).monitorConfig.blindSpot).toContain(
      'EVERY declared name',
    );
  });

  it('FAILS the run when a provider is PARTLY configured — naming the variable and the provider', async () => {
    // ⚠️ THE CARD'S CENTRAL ASSERTION, and the production fixture exactly:
    // `SENTRY_APP_CLIENT_ID` and `SENTRY_APP_SLUG` present,
    // `SENTRY_APP_CLIENT_SECRET` absent, for seven days, with every other probe
    // green and every surface anyone looks at reporting normally. The message is
    // the whole of what the DLQ panel renders, so it must name the variable, the
    // provider, the fix AND what it did not measure.
    await seedHealthyJobSchedules();
    greenExceptMonitorConfig();
    vi.stubEnv('SENTRY_APP_CLIENT_ID', 'id');
    vi.stubEnv('SENTRY_APP_SLUG', 'motir');

    const engine = new JobTestEngine({ function: dailyHealthCheck });
    const { result, error } = (await engine.execute()) as {
      result?: unknown;
      error?: { message?: string };
    };

    expect(result).toBeUndefined();
    expect(error?.message).toContain('SENTRY_APP_CLIENT_SECRET');
    expect(error?.message).toContain('sentry');
    expect(error?.message).toContain('fly secrets set');
    // The blind spot travels into the DLQ row with the diagnosis.
    expect(error?.message).toContain('EVERY declared name');
  });

  it('reports NAMES only — no value, no length, no digest reaches the row or the message', async () => {
    // The card's explicit boundary. The DLQ row is rendered to a human, so a
    // probe that printed a length would put a secret-adjacent artifact on an
    // operator surface to answer a question that only ever needed yes or no.
    const SECRET = 'zzq-do-not-leak-me-5831';
    await seedHealthyJobSchedules();
    greenExceptMonitorConfig();
    vi.stubEnv('SENTRY_APP_CLIENT_ID', SECRET);
    vi.stubEnv('SENTRY_APP_SLUG', 'motir');

    const engine = new JobTestEngine({ function: dailyHealthCheck });
    const { error } = (await engine.execute()) as { error?: { message?: string } };

    expect(error?.message).toBeDefined();
    expect(error?.message).not.toContain(SECRET);
    expect(error?.message).not.toContain(String(SECRET.length));
  });

  // ── The SEVENTH probe: credential expiry (MOTIR-1933) ──────────────────────
  //
  // The only probe here whose subject is a DECLARED date
  // (`lib/health/credentialRegistry.ts`), so its fixture is the clock and one
  // env var. The clock is set BEFORE the schedules are seeded, so the
  // schedule-health probe judges them against the same `now`.

  describe('credential expiry', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    async function greenAt(now: string, billingToken: string) {
      vi.setSystemTime(new Date(now));
      await seedHealthyJobSchedules();
      greenExceptMonitorConfig();
      vi.stubEnv('GITHUB_BILLING_TOKEN', billingToken);
      // The Fly read token (MOTIR-7331) is registered too; held unset so each case
      // judges the billing token alone.
      vi.stubEnv('FLY_DEPLOYMENT_READ_TOKEN', '');
    }

    it('PASSES months ahead of the declared expiry, and records the entry', async () => {
      await greenAt('2026-10-02T09:00:00.000Z', 'ghp_billing');

      const engine = new JobTestEngine({ function: dailyHealthCheck });
      const { result } = await engine.execute();

      expect(result).toMatchObject({
        ok: true,
        credentialExpiry: {
          verdict: 'ok',
          entries: [{ envVar: 'GITHUB_BILLING_TOKEN', state: 'healthy' }],
        },
      });
    });

    it('FAILS inside the lead time, naming the variable, the date and the renewal', async () => {
      await greenAt('2027-07-05T09:00:00.000Z', 'ghp_billing');

      const engine = new JobTestEngine({ function: dailyHealthCheck });
      const { result, error } = await engine.execute();

      expect(result).toBeUndefined();
      expect(error?.name).toBe('CredentialExpiringError');
      expect(error?.message).toContain('GITHUB_BILLING_TOKEN');
      expect(error?.message).toContain('2027-07-31');
      expect(error?.message).toContain('in 25 day(s)');
      expect(error?.message).toContain('fly secrets set GITHUB_BILLING_TOKEN');
      expect(error?.message).toContain('credentialRegistry.ts');
      expect(error?.message).not.toContain('ghp_billing');
    });

    it('FAILS as EXPIRED once the date has passed and the variable is still set', async () => {
      await greenAt('2027-08-03T09:00:00.000Z', 'ghp_billing');

      const engine = new JobTestEngine({ function: dailyHealthCheck });
      const { error } = await engine.execute();

      expect(error?.name).toBe('CredentialExpiredError');
      expect(error?.message).toContain('PAST their declared expiry');
      expect(error?.message).toContain('3 day(s) ago');
    });

    it('SKIPS an unset token — a deployment without the audit is not a fault', async () => {
      await greenAt('2027-08-03T09:00:00.000Z', '');

      const engine = new JobTestEngine({ function: dailyHealthCheck });
      const { result } = await engine.execute();

      expect(result).toMatchObject({
        ok: true,
        credentialExpiry: {
          verdict: 'ok',
          entries: [],
          skipped: ['GITHUB_BILLING_TOKEN', 'FLY_DEPLOYMENT_READ_TOKEN'],
        },
      });
    });

    it('a credential failure still records every other probe first', async () => {
      await greenAt('2027-07-05T09:00:00.000Z', 'ghp_billing');

      const engine = new JobTestEngine({ function: dailyHealthCheck });
      const { error, ctx } = await engine.execute();

      expect(error?.name).toBe('CredentialExpiringError');
      const stepIds = ctx.step.run.mock.calls.map((call) => call[0] as string);
      for (const id of [
        'schedule-health',
        'fleet-boot-preflight',
        'index-fleet-boot-preflight',
        'index-container-ai-address',
        'index-rebuild-streak',
        'monitor-config-preflight',
        'credential-expiry',
      ]) {
        expect(stepIds).toContain(id);
      }
    });
  });

  // ── The EIGHTH probe: a hosted run in a Motir-owned org (MOTIR-1934) ───────
  //
  // Its fixture is a metered `ci_workflow_run_usage` row, which needs a real
  // workspace and organization behind it. The probe's own arms are pinned in
  // `tests/ciMetering/hostedRunProbe.test.ts`; these assert the job surface.

  describe('hosted runs in an owned org', () => {
    const OWNED = 'motir-projects';

    beforeEach(async () => {
      await adminDb.$executeRawUnsafe(
        'TRUNCATE TABLE "ci_workflow_run_usage" RESTART IDENTITY CASCADE',
      );
      await truncateAuthTables();
    });

    async function seedRun(runId: string, family: string) {
      const user = await usersService.createUser({
        email: `hosted-${runId}@example.com`,
        password: 'hunter2hunter2',
        name: 'Owner',
      });
      const { workspace } = await workspacesService.createWorkspace({
        name: `WS ${runId}`,
        ownerUserId: user.id,
      });
      const completedAt = new Date(Date.now() - 60 * 60 * 1000);
      await adminDb.ciWorkflowRunUsage.create({
        data: {
          workspaceId: workspace.id,
          organizationId: workspace.organizationId,
          runId,
          runAttempt: 1,
          repoOwner: OWNED,
          repoName: 'acme-web',
          periodStart: new Date(
            Date.UTC(completedAt.getUTCFullYear(), completedAt.getUTCMonth(), 1),
          ),
          runCompletedAt: completedAt,
          billableMinutes: 4,
          rawWallClockSeconds: new Prisma.Decimal(200),
          linearEquivalentMinutes: new Prisma.Decimal(4),
          jobCount: 1,
          runnerBreakdown: [
            {
              family,
              multiplier: 1,
              billableMinutes: 4,
              rawWallClockSeconds: 200,
              linearEquivalentMinutes: 4,
              jobCount: 1,
              unpriced: false,
            },
          ],
        },
      });
    }

    it('PASSES and records the verdict when every run ran on the fleet', async () => {
      await seedHealthyJobSchedules();
      greenExceptMonitorConfig();
      vi.stubEnv('GITHUB_FALLBACK_ORG', OWNED);
      await seedRun('run-fleet', MOTIR_FLEET_RUNNER_FAMILY);

      const engine = new JobTestEngine({ function: dailyHealthCheck });
      const { result } = await engine.execute();

      expect(result).toMatchObject({ ok: true, hostedRuns: { verdict: 'ok', runsChecked: 1 } });
    });

    it('FAILS on an ubuntu-latest run, naming the org, repo, run id and the variable to check', async () => {
      await seedHealthyJobSchedules();
      greenExceptMonitorConfig();
      vi.stubEnv('GITHUB_FALLBACK_ORG', OWNED);
      await seedRun('run-4242', classifyRunner(['ubuntu-latest']));

      const engine = new JobTestEngine({ function: dailyHealthCheck });
      const { result, error, ctx } = await engine.execute();

      expect(result).toBeUndefined();
      expect(error?.name).toBe('HostedRunInOwnedOrgError');
      expect(error?.message).toContain('motir-projects/acme-web run run-4242');
      expect(error?.message).toContain(classifyRunner(['ubuntu-latest']));
      expect(error?.message).toContain('vars.MOTIR_RUNNER');
      expect(error?.message).toContain('already spent');
      // Every other probe still ran and recorded its verdict first.
      const stepIds = ctx.step.run.mock.calls.map((call) => call[0] as string);
      expect(stepIds).toEqual(
        expect.arrayContaining([
          'schedule-health',
          'fleet-boot-preflight',
          'index-fleet-boot-preflight',
          'index-container-ai-address',
          'index-rebuild-streak',
          'monitor-config-preflight',
          'credential-expiry',
          'hosted-run-probe',
        ]),
      );
    });
  });
});
