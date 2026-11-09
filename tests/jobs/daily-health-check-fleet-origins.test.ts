import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobTestEngine, seedHealthyJobSchedules } from '../helpers/jobs';
import { adminDb } from '../helpers/adminDb';
import { truncateJobRuns } from '../helpers/db';
import { db } from '@/lib/db';
import type { FleetOriginsVerdict } from '@/lib/ai/fleetOrigins';
import { dailyHealthCheck, FleetOriginsError } from '@/lib/jobs/definitions/dailyHealthCheck';
import { fleetPreflightService } from '@/lib/services/fleetPreflightService';
import { runnerVersionSupportProbeService } from '@/lib/services/runnerVersionSupportProbeService';

// THE THREE FLEET ORIGINS RIDE THE DAILY HEALTH CHECK (Story MOTIR-9714 ·
// MOTIR-10750). A definite failure of any origin fails the run, and the message
// sends the operator to motir-core's own variable and the motir-infra stack
// output it must equal — never to a Fly secret, which is where the old message
// pointed and where the value no longer lives. Everything else is recorded on
// the run, healthy tick included.

beforeEach(async () => {
  await truncateJobRuns();
  await seedHealthyJobSchedules();
  // Held fixed for the reason `scheduled.test.ts` holds it: the probe reads
  // GitHub's live release list, and no test here is about it.
  vi.spyOn(runnerVersionSupportProbeService, 'check').mockResolvedValue({
    verdict: 'supported',
    checkedAt: '2026-11-08T09:00:00.000Z',
    pinned: '2.338.2',
    latest: { version: '2.338.2', publishedAt: '2026-10-26T12:00:00Z' },
    supersededBy: null,
    deadline: null,
    daysLeft: null,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Outcome = { result?: Record<string, unknown>; error?: Error };

async function runCheck(): Promise<Outcome> {
  const engine = new JobTestEngine({ function: dailyHealthCheck });
  return (await engine.execute()) as Outcome;
}

const base = {
  core: { origin: 'core', variable: 'MOTIR_BASE_URL', output: 'CoreOrigin' },
  aiContainer: {
    origin: 'aiContainer',
    variable: 'MOTIR_AI_CONTAINER_URL',
    output: 'AiContainerOrigin',
  },
  gatewayRun: {
    origin: 'gatewayRun',
    variable: 'MOTIR_GATEWAY_RUN_URL',
    output: 'GatewayRunOrigin',
  },
} as const;

describe('the fleet origins preflight on the daily health check', () => {
  it('records the reading on a healthy tick where no fleet machine boots', async () => {
    const { result, error } = await runCheck();
    expect(error).toBeUndefined();
    expect(result).toMatchObject({ ok: true, fleetOrigins: { verdict: 'not_applicable' } });
  });

  it.each<FleetOriginsVerdict>([
    {
      verdict: 'ok',
      readings: [
        {
          ...base.core,
          verdict: 'reachable',
          address: 'https://app.example.test',
          path: '/api/health/ready',
          status: 200,
        },
      ],
    },
    {
      verdict: 'indeterminate',
      readings: [
        {
          ...base.gatewayRun,
          verdict: 'indeterminate',
          address: 'https://gateway-run.example.test',
          path: '/healthz',
          detail: 'fetch failed',
        },
      ],
      detail: 'MOTIR_GATEWAY_RUN_URL https://gateway-run.example.test/healthz: fetch failed',
    },
  ])('stays green, recording the reading, when the verdict is $verdict', async (verdict) => {
    vi.spyOn(fleetPreflightService, 'checkFleetOrigins').mockResolvedValue(verdict);
    const { result, error } = await runCheck();
    expect(error).toBeUndefined();
    expect(result).toMatchObject({ ok: true, fleetOrigins: verdict });
  });

  it('FAILS the run naming each failing variable and the stack output it must equal', async () => {
    const failures = [
      {
        ...base.core,
        verdict: 'unconfigured',
        detail: 'MOTIR_BASE_URL is not set, so no fleet machine can be handed this origin.',
      },
      {
        ...base.gatewayRun,
        verdict: 'private_address',
        address: 'https://motir-gateway.fly.dev',
        detail: 'motir-gateway.fly.dev is a private or Fly-owned host.',
      },
    ] as const;
    vi.spyOn(fleetPreflightService, 'checkFleetOrigins').mockResolvedValue({
      verdict: 'failed',
      readings: [...failures],
      failures: [...failures],
    });

    const { result, error } = await runCheck();

    expect(result).toBeUndefined();
    expect(error).toBeInstanceOf(FleetOriginsError);
    const message = error?.message ?? '';
    expect(message).toMatch(/^2 fleet origin\(s\) cannot work for a fleet machine/);
    for (const name of [
      'MOTIR_BASE_URL',
      'CoreOrigin',
      'MOTIR_GATEWAY_RUN_URL',
      'GatewayRunOrigin',
    ]) {
      expect(message).toContain(name);
    }
    expect(message).toContain('motir-gateway.fly.dev');
    expect(message).not.toMatch(/fly secrets?|Fly secret/i);
    // The origin that is fine is not named as a fault.
    expect(message).not.toContain('AiContainerOrigin');
  });

  it('FAILS a CI-only Fly fleet whose core origin is private, through the real chain', async () => {
    // Real services, no stubbed verdict: env selects a CI runner fleet on Fly and
    // core's origin is its private Fly name. Every probe that reaches the network
    // gets no answer, so the only DEFINITE fault is the address.
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', 'fly_fleet_token');
    vi.stubEnv('FLY_FLEET_APP', 'motir-ci-fleet');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', 'ghcr.io/motir-co/motir-ci-runner@sha256:446c692d');
    vi.stubEnv('MOTIR_INDEXER_IMAGE', '');
    vi.stubEnv('MOTIR_HOSTED_AGENT_IMAGE', '');
    vi.stubEnv('MOTIR_BASE_URL', 'http://motir-core.internal:3000');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    );

    const { result, error } = await runCheck();

    expect(result).toBeUndefined();
    expect(error).toBeInstanceOf(FleetOriginsError);
    expect(error?.message).toContain('MOTIR_BASE_URL: motir-core.internal');
    expect(error?.message).toContain('services stack output CoreOrigin');
    // A CI-only fleet is handed neither of the other two origins.
    expect(error?.message).not.toContain('MOTIR_AI_CONTAINER_URL');
    expect(error?.message).not.toContain('MOTIR_GATEWAY_RUN_URL');
  });
});
