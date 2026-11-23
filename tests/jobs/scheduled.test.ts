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
import { CREDENTIAL_REGISTRY } from '@/lib/health/credentialRegistry';
import { workspacesService } from '@/lib/services/workspacesService';
import { classifyRunner, MOTIR_FLEET_RUNNER_FAMILY } from '@/lib/ciMetering/runnerRates';
import { generateKeyPairSync } from 'node:crypto';
import { fleetOrgCiSettingService } from '@/lib/services/fleetOrgCiSettingService';
import { fleetPreflightService } from '@/lib/services/fleetPreflightService';
import { fleetReadinessService } from '@/lib/services/fleetReadinessService';
import { hostedAgentImageLagProbeService } from '@/lib/services/hostedAgentImageLagProbeService';
import { runnerImageFreshnessProbeService } from '@/lib/services/runnerImageFreshnessProbeService';
import { runnerVersionSupportProbeService } from '@/lib/services/runnerVersionSupportProbeService';

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
  // The runner-version probe (MOTIR-10706) reads GitHub's live release list.
  // Every test here but its own block holds it at a fixed `supported`, so no
  // test of another probe depends on GitHub answering, or on the day it runs.
  vi.spyOn(runnerVersionSupportProbeService, 'check').mockResolvedValue({
    verdict: 'supported',
    checkedAt: '2026-11-08T09:00:00.000Z',
    pinned: '2.338.2',
    latest: { version: '2.338.2', publishedAt: '2026-10-26T12:00:00Z' },
    supersededBy: null,
    deadline: null,
    daysLeft: null,
  });
  // The three fleet origins (Story MOTIR-9714) have their own suite,
  // `daily-health-check-fleet-origins.test.ts`, which drives the real chain.
  // Here they are held `ok`, so a test of another probe that selects the Fly
  // fleet does not also have to publish core's own origin.
  vi.spyOn(fleetPreflightService, 'checkFleetOrigins').mockResolvedValue({
    verdict: 'ok',
    readings: [],
  });
  // The hosted-agent pin lag (MOTIR-10882) has its own suite,
  // `tests/ciFleet/hostedAgentImageLagProbeService.test.ts`. Held `not_applicable`
  // here, so a test that sets MOTIR_HOSTED_AGENT_IMAGE for the pullability probe
  // does not also have to serve a `:main` build; its own block below unholds it.
  vi.spyOn(hostedAgentImageLagProbeService, 'check').mockResolvedValue({
    verdict: 'not_applicable',
    checkedAt: '2026-11-10T09:00:00.000Z',
    detail: 'held by the test',
  });
});

// ── Registry fixtures for the pull paths (MOTIR-2030) ────────────────────────
//
// The runner and the hosted agent both pull from ghcr.io (public, §1), from
// DIFFERENT repositories, which is what lets a test prove which path a verdict
// is about — a fixture where both images were the same string would pass for a
// preflight that probed the runner twice, which is the bug MOTIR-2030 fixed.
// (The indexer's `registry.fly.io` path left with the index fleet, MOTIR-12037.)

const RUNNER_REPO = 'motir-co/motir-ci-runner';
const RUNNER_IMAGE = `ghcr.io/${RUNNER_REPO}@sha256:446c692d`;

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

// ── NO INDEXER CHECK IS LEFT (MOTIR-12037) ───────────────────────────────────
//
// The index fleet's three probes — its image's pull preflight, the container's
// motir-ai address and the rebuild streak — left with the fleet. A deployment
// that sets none of the old indexer settings is a clean one, and the check must
// say so rather than ask production for settings that no longer mean anything.

describe('the daily health check carries no indexer check', () => {
  it('is GREEN on a CI deployment that sets none of the old indexer settings, and runs no index step', async () => {
    await seedHealthyJobSchedules();
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', 'fly_fleet_token');
    vi.stubEnv('FLY_FLEET_APP', 'motir-ci-fleet');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', RUNNER_IMAGE);
    for (const name of [
      'MOTIR_INDEXER_IMAGE',
      'MOTIR_INDEX_FLEET_PROVIDER',
      'MOTIR_AWS_INDEXER_AMI_ID',
    ]) {
      vi.stubEnv(name, '');
    }
    vi.stubGlobal('fetch', registryServing([RUNNER_REPO]));

    const engine = new JobTestEngine({ function: dailyHealthCheck });
    const { result, error, ctx } = await engine.execute();

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ ok: true, fleet: { verdict: 'bootable' } });
    for (const field of ['indexFleet', 'indexContainerAi', 'indexRebuildStreak']) {
      expect(result).not.toHaveProperty(field);
    }
    const stepIds = ctx.step.run.mock.calls.map((call) => call[0] as string);
    for (const retired of [
      'index-fleet-boot-preflight',
      'index-container-ai-address',
      'index-rebuild-streak',
    ]) {
      expect(stepIds).not.toContain(retired);
    }
    expect(stepIds).toContain('fleet-origins-v2');
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

// ── THE HOSTED-AGENT IMAGE RIDES THE SAME SURFACE (MOTIR-9420) ──────────────
//
// The second pull path, probed anonymously the way an agent-runner VM pulls it.
// Its verdict is recorded beside the runner's, and only a definite refusal is
// loud, with a message naming the hosted-agent image and its variable.

describe("the HOSTED-AGENT image's preflight rides the same health check", () => {
  const HOSTED_REPO = 'motir-co/motir-hosted-agent';
  const HOSTED_IMAGE = `ghcr.io/${HOSTED_REPO}@sha256:${'b'.repeat(64)}`;

  function stubFleet(hostedImage: string) {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', 'fly_fleet_token');
    vi.stubEnv('FLY_FLEET_APP', 'motir-ci-fleet');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', RUNNER_IMAGE);
    vi.stubEnv('MOTIR_HOSTED_AGENT_IMAGE', hostedImage);
  }

  it('records the verdict on a healthy tick, beside the runner one', async () => {
    await seedHealthyJobSchedules();
    stubFleet(HOSTED_IMAGE);
    vi.stubGlobal('fetch', registryServing([RUNNER_REPO, HOSTED_REPO]));

    const engine = new JobTestEngine({ function: dailyHealthCheck });
    const { result } = await engine.execute();

    expect(result).toMatchObject({
      ok: true,
      fleet: { verdict: 'bootable', reference: RUNNER_IMAGE },
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

// ── THE LATER PROBES RIDE THE SAME SURFACE ───────────────────────────────────
//
// The rebuild-streak probe (MOTIR-5027) that opened this block left with the
// code-graph index fleet (MOTIR-12037); the probes after it keep its fixture.

describe('the later probes ride the same health check', () => {
  /** A cloud deployment wired for CI only — the ordinary state. */
  function stubCiFleet() {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', 'fly_fleet_token');
    vi.stubEnv('FLY_FLEET_APP', 'motir-ci-fleet');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', RUNNER_IMAGE);
  }

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
      // Every other registered credential is held unset, and the cloud flag off so
      // the ones held outside core (MOTIR-9408's `heldIn`) are skipped too: each
      // case judges the billing token alone.
      for (const { envVar } of CREDENTIAL_REGISTRY) vi.stubEnv(envVar, '');
      vi.stubEnv('MOTIR_CLOUD', '');
      vi.stubEnv('GITHUB_BILLING_TOKEN', billingToken);
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
      expect(error?.message).toContain('`GITHUB_BILLING_TOKEN` key of `motir/core/grouped-later`');
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
          skipped: CREDENTIAL_REGISTRY.map((c) => c.envVar),
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
          'monitor-config-preflight',
          'credential-expiry',
          'hosted-run-probe',
        ]),
      );
    });
  });

  // ── The NINTH probe: fleet image coverage (MOTIR-10290) ───────────────────
  //
  // The condition it asks is pinned over a faked GitHub and registry in
  // `tests/ciFleet/fleetReadinessService.test.ts`, and the probe's own folding in
  // `tests/ciFleet/fleetImageCoverageProbeService.test.ts`; these assert the job
  // surface: the verdict on the row, a job the image cannot run failing the run
  // with a message an operator can act on, and a runnable change staying green.

  describe('fleet image coverage', () => {
    function offerOnePair(condition: {
      state: 'met' | 'unmet' | 'unknown';
      reasonCode: string;
      message: string;
    }) {
      const { privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
      vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
      vi.stubEnv('MOTIR_RUNNER_IMAGE', RUNNER_IMAGE);
      vi.spyOn(fleetOrgCiSettingService, 'systemTargets').mockResolvedValue([
        {
          projectId: 'p',
          projectKey: 'MOTIR',
          workspaceId: 'w',
          organizationId: 'o',
          org: 'motir-co',
          installationId: '1',
        },
      ]);
      vi.spyOn(fleetReadinessService, 'imageCoverageFor').mockResolvedValue({
        key: 'image_coverage',
        params: {},
        ...condition,
      });
    }

    it('PASSES and records not_applicable on a deployment with no provisioning App', async () => {
      await seedHealthyJobSchedules();
      greenExceptMonitorConfig();
      vi.stubEnv('GITHUB_STUDIO_APP_ID', '');

      const engine = new JobTestEngine({ function: dailyHealthCheck });
      const { result } = await engine.execute();

      expect(result).toMatchObject({
        ok: true,
        fleetImageCoverage: { verdict: 'not_applicable', reason: 'app_not_configured' },
      });
    });

    it('PASSES on a runnable change, recording each pair', async () => {
      await seedHealthyJobSchedules();
      greenExceptMonitorConfig();
      offerOnePair({ state: 'met', reasonCode: 'all_runnable', message: 'every job runs' });

      const engine = new JobTestEngine({ function: dailyHealthCheck });
      const { result } = await engine.execute();

      expect(result).toMatchObject({
        ok: true,
        fleetImageCoverage: {
          verdict: 'runnable',
          pairs: [{ projectKey: 'MOTIR', org: 'motir-co', state: 'met' }],
        },
      });
    });

    it('FAILS on a job the image cannot run, naming the repository, workflow, job and tool', async () => {
      await seedHealthyJobSchedules();
      greenExceptMonitorConfig();
      offerOnePair({
        state: 'unmet',
        reasonCode: 'jobs_not_runnable',
        message:
          '1 job cannot run on the fleet runner image yet: motir-co/motir-ai ci.yml deploy-aws (needs aws, which the image lacks).',
      });

      const engine = new JobTestEngine({ function: dailyHealthCheck });
      const { result, error, ctx } = await engine.execute();

      expect(result).toBeUndefined();
      expect(error?.name).toBe('FleetImageCoverageGapError');
      expect(error?.message).toContain(
        'MOTIR on motir-co: 1 job cannot run on the fleet runner image yet: motir-co/motir-ai ci.yml deploy-aws (needs aws, which the image lacks).',
      );
      expect(error?.message).toContain('docs/research/fleet-job-inventory.md');
      // Every other probe still ran and recorded its verdict first.
      const stepIds = ctx.step.run.mock.calls.map((call) => call[0] as string);
      expect(stepIds).toEqual(expect.arrayContaining(['hosted-run-probe', 'fleet-image-coverage']));
    });

    it('PASSES and records indeterminate when a read is refused', async () => {
      await seedHealthyJobSchedules();
      greenExceptMonitorConfig();
      offerOnePair({ state: 'unknown', reasonCode: 'read_failed', message: 'GitHub said 502' });

      const engine = new JobTestEngine({ function: dailyHealthCheck });
      const { result } = await engine.execute();

      expect(result).toMatchObject({ ok: true, fleetImageCoverage: { verdict: 'indeterminate' } });
    });
  });

  // ── The TENTH probe: runner-image freshness (MOTIR-10393) ─────────────────
  //
  // The registry and GitHub reads are pinned in
  // `tests/ciFleet/runnerImageFreshnessProbeService.test.ts`; these assert the
  // job surface: the verdict on the row, a merged image change that was never
  // released failing the run with the release step in its message, and a read
  // that did not answer staying green but never `current`.

  describe('runner image freshness', () => {
    const BUILT = '4a9cb14b54e2366d2a30ad19ac4b924dddca6d31';
    const CHANGE = 'a4e83f13c8a344fd306993b997c9c361c29aa3e4';
    const build = { image: RUNNER_IMAGE, commit: BUILT, source: 'sha_tag' as const };

    it('PASSES and records current when the pinned image contains every image change', async () => {
      await seedHealthyJobSchedules();
      greenExceptMonitorConfig();
      vi.spyOn(runnerImageFreshnessProbeService, 'check').mockResolvedValue({
        verdict: 'current',
        checkedAt: '2026-11-05T09:00:00.000Z',
        build,
        ami: { state: 'unset' },
      });

      const engine = new JobTestEngine({ function: dailyHealthCheck });
      const { result } = await engine.execute();

      expect(result).toMatchObject({
        ok: true,
        runnerImageFreshness: { verdict: 'current', build: { commit: BUILT } },
      });
    });

    it('FAILS on a merged image change the pinned image lacks, naming both commits and the release step', async () => {
      await seedHealthyJobSchedules();
      greenExceptMonitorConfig();
      vi.spyOn(runnerImageFreshnessProbeService, 'check').mockResolvedValue({
        verdict: 'stale',
        checkedAt: '2026-11-05T09:00:00.000Z',
        build,
        unreleased: [
          {
            commit: CHANGE,
            committedAt: '2026-11-03T12:00:00Z',
            subject: 'MOTIR-10293 Add the AWS CLI to the runner images',
            paths: ['infra/ci-runner/Dockerfile'],
            relation: 'ahead',
          },
        ],
        ami: { state: 'unset' },
      });

      const engine = new JobTestEngine({ function: dailyHealthCheck });
      const { result, error, ctx } = await engine.execute();

      expect(result).toBeUndefined();
      expect(error?.name).toBe('RunnerImageStaleError');
      expect(error?.message).toContain(
        `The pinned runner image ${RUNNER_IMAGE} was built from 4a9cb14b54e2`,
      );
      expect(error?.message).toContain('a4e83f13c8a3 (2026-11-03T12:00:00Z');
      expect(error?.message).toContain(`git tag runner-v<next> ${CHANGE}`);
      const stepIds = ctx.step.run.mock.calls.map((call) => call[0] as string);
      expect(stepIds).toEqual(
        expect.arrayContaining(['fleet-image-coverage', 'runner-image-freshness-v2']),
      );
    });

    it('FAILS on a stale runner AMI while the image is current, naming the AMI release step (MOTIR-10395)', async () => {
      await seedHealthyJobSchedules();
      greenExceptMonitorConfig();
      vi.spyOn(runnerImageFreshnessProbeService, 'check').mockResolvedValue({
        verdict: 'current',
        checkedAt: '2026-11-05T09:00:00.000Z',
        build,
        ami: {
          state: 'stale',
          build: {
            amiId: 'ami-0123456789abcdef0',
            name: 'motir-ci-runner-2.329.0-202611050900-4a9cb14',
            commit: BUILT,
            source: 'description',
            account: 'motir-ci-1',
          },
          unreleased: [
            {
              commit: CHANGE,
              committedAt: '2026-11-03T12:00:00Z',
              subject: 'MOTIR-10293 Add the AWS CLI to the runner images',
              paths: ['infra/ci-runner/Dockerfile'],
              relation: 'ahead',
            },
          ],
        },
      });

      const engine = new JobTestEngine({ function: dailyHealthCheck });
      const { result, error } = await engine.execute();

      expect(result).toBeUndefined();
      expect(error?.name).toBe('RunnerAmiStaleError');
      expect(error?.message).toContain('The pinned runner AMI ami-0123456789abcdef0');
      expect(error?.message).toContain(`git tag ci-runner-ami-v<next> ${CHANGE}`);
    });

    it('PASSES and records an AMI it could not read as indeterminate (MOTIR-10395)', async () => {
      await seedHealthyJobSchedules();
      greenExceptMonitorConfig();
      vi.spyOn(runnerImageFreshnessProbeService, 'check').mockResolvedValue({
        verdict: 'current',
        checkedAt: '2026-11-05T09:00:00.000Z',
        build,
        ami: {
          state: 'indeterminate',
          amiId: 'ami-0123456789abcdef0',
          phase: 'ec2',
          detail: 'EC2 refused DescribeImages (UnauthorizedOperation)',
        },
      });

      const engine = new JobTestEngine({ function: dailyHealthCheck });
      const { result } = await engine.execute();

      expect(result).toMatchObject({
        ok: true,
        runnerImageFreshness: { ami: { state: 'indeterminate', phase: 'ec2' } },
      });
    });

    it('PASSES and records indeterminate when the registry entry cannot be read', async () => {
      await seedHealthyJobSchedules();
      greenExceptMonitorConfig();
      vi.spyOn(runnerImageFreshnessProbeService, 'check').mockResolvedValue({
        verdict: 'indeterminate',
        checkedAt: '2026-11-05T09:00:00.000Z',
        image: RUNNER_IMAGE,
        phase: 'registry',
        detail: "the pinned image's registry entry could not be read",
        ami: { state: 'unset' },
      });

      const engine = new JobTestEngine({ function: dailyHealthCheck });
      const { result } = await engine.execute();

      expect(result).toMatchObject({
        ok: true,
        runnerImageFreshness: { verdict: 'indeterminate', phase: 'registry' },
      });
    });
  });

  // ── The runner-version support probe (MOTIR-10706) ──────────────────────────
  //
  // The rule, the reads and the sentence are pinned in
  // `tests/ciFleet/runnerVersionSupport.test.ts`; these assert the job surface:
  // the verdict on the row, a pin GitHub refuses — or is about to — failing the
  // run with the bump in its message, and a read that did not answer staying
  // green but never `supported`.

  describe('runner version support', () => {
    const latest = { version: '2.338.2', publishedAt: '2026-10-26T12:00:00Z' };
    const superseded = { version: '2.337.0', publishedAt: '2026-08-25T12:00:00Z' };

    it('PASSES and records supported, with what it read', async () => {
      await seedHealthyJobSchedules();
      greenExceptMonitorConfig();

      const engine = new JobTestEngine({ function: dailyHealthCheck });
      const { result, ctx } = await engine.execute();

      expect(result).toMatchObject({
        ok: true,
        runnerVersionSupport: { verdict: 'supported', pinned: '2.338.2', latest },
      });
      const stepIds = ctx.step.run.mock.calls.map((call) => call[0] as string);
      expect(stepIds).toContain('runner-version-support');
    });

    it('FAILS on a pin past GitHub’s window — the 2026-11-08 outage — naming the bump', async () => {
      await seedHealthyJobSchedules();
      greenExceptMonitorConfig();
      vi.spyOn(runnerVersionSupportProbeService, 'check').mockResolvedValue({
        verdict: 'unsupported',
        checkedAt: '2026-11-08T09:00:00.000Z',
        pinned: '2.336.0',
        latest,
        supersededBy: superseded,
        deadline: '2026-09-24T12:00:00.000Z',
        daysLeft: -45,
      });

      const engine = new JobTestEngine({ function: dailyHealthCheck });
      const { result, error, ctx } = await engine.execute();

      expect(result).toBeUndefined();
      expect(error?.name).toBe('RunnerVersionUnsupportedError');
      expect(error?.message).toContain(
        "v2.336.0 (RUNNER_VERSION in infra/ci-runner/Dockerfile on the default branch), is past GitHub's support window since 2026-09-24",
      );
      expect(error?.message).toContain(
        'Set RUNNER_VERSION, RUNNER_SHA256 and RUNNER_ARM64_SHA256 to v2.338.2',
      );
      // Every other probe still ran first, the freshness probe included.
      const stepIds = ctx.step.run.mock.calls.map((call) => call[0] as string);
      expect(stepIds).toEqual(
        expect.arrayContaining(['runner-image-freshness-v2', 'runner-version-support']),
      );
    });

    it('FAILS while the cut-off is inside the margin, before any fleet runner is refused', async () => {
      await seedHealthyJobSchedules();
      greenExceptMonitorConfig();
      vi.spyOn(runnerVersionSupportProbeService, 'check').mockResolvedValue({
        verdict: 'expiring',
        checkedAt: '2026-11-12T09:00:00.000Z',
        pinned: '2.337.0',
        latest,
        supersededBy: latest,
        deadline: '2026-11-25T12:00:00.000Z',
        daysLeft: 13,
      });

      const engine = new JobTestEngine({ function: dailyHealthCheck });
      const { error } = await engine.execute();

      expect(error?.name).toBe('RunnerVersionUnsupportedError');
      expect(error?.message).toContain("leaves GitHub's support window in 13 days, on 2026-11-25");
    });

    it('PASSES and records indeterminate when GitHub could not be read', async () => {
      await seedHealthyJobSchedules();
      greenExceptMonitorConfig();
      vi.spyOn(runnerVersionSupportProbeService, 'check').mockResolvedValue({
        verdict: 'indeterminate',
        checkedAt: '2026-11-08T09:00:00.000Z',
        phase: 'releases',
        detail: "actions/runner's releases could not be read: GitHub refused the read (HTTP 403).",
      });

      const engine = new JobTestEngine({ function: dailyHealthCheck });
      const { result } = await engine.execute();

      expect(result).toMatchObject({
        ok: true,
        runnerVersionSupport: { verdict: 'indeterminate', phase: 'releases' },
        indeterminateStreak: {
          streaks: expect.arrayContaining([
            expect.objectContaining({
              probe: 'runnerVersionSupport',
              step: 'runner-version-support',
            }),
          ]),
        },
      });
    });
  });
});

// ── THE HOSTED-AGENT PIN'S LAG RIDES THE SAME SURFACE (MOTIR-10882) ──────────
//
// The probe's arms are pinned in its own suite; these assert the job surface:
// the verdict on the row (a `pending` pin pull request included), a pin left
// behind failing the run with the pull request to merge in its message, and an
// unreadable registry staying green.

describe("the hosted-agent pin's lag rides the same health check", () => {
  const PINNED = `ghcr.io/motir-co/motir-hosted-agent@sha256:${'87'.repeat(32)}`;
  const main = {
    reference: 'ghcr.io/motir-co/motir-hosted-agent:main',
    digest: `sha256:${'03'.repeat(32)}`,
    createdAt: '2026-11-09T08:00:00.000Z',
  };

  it('PASSES and records a pending pin, with how far behind it is', async () => {
    await seedHealthyJobSchedules();
    const lag = { unpinnedHours: 5, behindHours: 30, pinnedCreatedAt: '2026-11-08T02:00:00.000Z' };
    vi.spyOn(hostedAgentImageLagProbeService, 'check').mockResolvedValue({
      verdict: 'pending',
      checkedAt: '2026-11-09T13:00:00.000Z',
      pinned: PINNED,
      main,
      lag,
    });

    const engine = new JobTestEngine({ function: dailyHealthCheck });
    const { result, ctx } = await engine.execute();

    expect(result).toMatchObject({ ok: true, hostedAgentImageLag: { verdict: 'pending', lag } });
    const stepIds = ctx.step.run.mock.calls.map((call) => call[0] as string);
    expect(stepIds).toContain('hosted-agent-image-lag');
  });

  it('FAILS on a pin left behind main, naming the pull request to merge', async () => {
    await seedHealthyJobSchedules();
    vi.spyOn(hostedAgentImageLagProbeService, 'check').mockResolvedValue({
      verdict: 'lagging',
      checkedAt: '2026-11-10T09:00:00.000Z',
      pinned: PINNED,
      main,
      lag: { unpinnedHours: 25, behindHours: 912, pinnedCreatedAt: '2026-10-02T08:00:00.000Z' },
    });

    const engine = new JobTestEngine({ function: dailyHealthCheck });
    const { result, error, ctx } = await engine.execute();

    expect(result).toBeUndefined();
    expect(error?.name).toBe('HostedAgentImageLaggingError');
    expect(error?.message).toContain(`${PINNED} is pinned`);
    expect(error?.message).toContain('chore/hosted-agent-image-pin');
    // Every probe still ran first.
    const stepIds = ctx.step.run.mock.calls.map((call) => call[0] as string);
    expect(stepIds).toEqual(
      expect.arrayContaining(['hosted-agent-image-lag', 'runner-version-support']),
    );
  });

  it('PASSES and records indeterminate when the registry could not be read', async () => {
    await seedHealthyJobSchedules();
    vi.spyOn(hostedAgentImageLagProbeService, 'check').mockResolvedValue({
      verdict: 'indeterminate',
      checkedAt: '2026-11-10T09:00:00.000Z',
      phase: 'registry',
      reference: main.reference,
      detail: 'unreachable: the registry could not be reached: ECONNRESET',
    });

    const engine = new JobTestEngine({ function: dailyHealthCheck });
    const { result } = await engine.execute();

    expect(result).toMatchObject({
      ok: true,
      hostedAgentImageLag: { verdict: 'indeterminate', phase: 'registry' },
      indeterminateStreak: {
        streaks: expect.arrayContaining([
          expect.objectContaining({ probe: 'hostedAgentImageLag', step: 'hosted-agent-image-lag' }),
        ]),
      },
    });
  });
});
