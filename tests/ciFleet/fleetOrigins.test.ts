import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyFleetOrigin,
  FLEET_ORIGINS,
  verifyFleetOrigins,
  type FleetOriginReading,
  type FleetOriginSpec,
} from '@/lib/ai/fleetOrigins';
import { fleetPreflightService } from '@/lib/services/fleetPreflightService';

// THE THREE FLEET ORIGINS, PREFLIGHTED (Story MOTIR-9714 · MOTIR-10750).
//
// Every fleet machine is handed core's public origin, and the index and hosted
// containers motir-ai's and the gateway's too. Each address has been wrong in
// production before with every check green, so each gets the same four arms:
// unset, a definite failure decided from its shape, reachable, and could-not-tell.

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const spec = (origin: FleetOriginSpec['origin']): FleetOriginSpec => {
  const found = FLEET_ORIGINS.find((s) => s.origin === origin);
  if (!found) throw new Error(`no ${origin}`);
  return found;
};

const PUBLIC = {
  core: 'https://app.example.test',
  aiContainer: 'https://ai.example.test',
  gatewayRun: 'https://gateway-run.example.test',
} as const;

const publicEnv = {
  MOTIR_BASE_URL: PUBLIC.core,
  MOTIR_AI_CONTAINER_URL: PUBLIC.aiContainer,
  MOTIR_GATEWAY_RUN_URL: PUBLIC.gatewayRun,
};

const answering = (status = 200) =>
  vi.fn(
    async (_url: string | URL | Request): Promise<Response> =>
      new Response(status === 204 ? null : 'ok', { status }),
  );

const byOrigin = (readings: FleetOriginReading[], origin: FleetOriginSpec['origin']) =>
  readings.find((r) => r.origin === origin);

describe('FLEET_ORIGINS', () => {
  it('names each variable beside the motir-infra stack output it must equal', () => {
    expect(FLEET_ORIGINS.map((s) => [s.origin, s.variable, s.output])).toEqual([
      ['core', 'MOTIR_BASE_URL', 'CoreOrigin'],
      ['aiContainer', 'MOTIR_AI_CONTAINER_URL', 'AiContainerOrigin'],
      ['gatewayRun', 'MOTIR_GATEWAY_RUN_URL', 'GatewayRunOrigin'],
    ]);
  });
});

describe.each(FLEET_ORIGINS)('classifyFleetOrigin for $variable', (s) => {
  it.each([undefined, '', '   '])('reads %j as unconfigured, naming the variable', (raw) => {
    const reading = classifyFleetOrigin(s, raw);
    expect(reading).toMatchObject({
      verdict: 'unconfigured',
      variable: s.variable,
      output: s.output,
    });
    expect('detail' in reading && reading.detail).toContain(s.variable);
  });

  it.each([
    'http://motir-core.internal:3000',
    'http://motir-ai.flycast',
    'https://motir-core.fly.dev',
    'http://10.0.4.12:8080',
    'http://[fd00::1]',
    'http://internal-motir-alb-123.eu-west-1.elb.amazonaws.com',
    'http://localhost:3000',
  ])('reads %s as a definite failure from its shape alone', (raw) => {
    expect(classifyFleetOrigin(s, raw)).toMatchObject({
      verdict: 'private_address',
      variable: s.variable,
      output: s.output,
      address: raw,
    });
  });

  it.each(['not a url', 'ftp://files.example.test', 'mailto:ops@example.test'])(
    'reads %s as a definite failure: not an http(s) URL with a host',
    (raw) => {
      const reading = classifyFleetOrigin(s, raw);
      expect(reading).toMatchObject({ verdict: 'private_address' });
      expect('detail' in reading && reading.detail).toContain('absolute http(s) URL');
    },
  );

  it('hands back a public value with its trailing slashes stripped, to probe', () => {
    expect(classifyFleetOrigin(s, ` ${PUBLIC[s.origin]}// `)).toEqual({
      address: PUBLIC[s.origin],
    });
  });
});

describe('classifyFleetOrigin for the run lane', () => {
  it('refuses a value ending in /v1, which the run lane appends itself', () => {
    const reading = classifyFleetOrigin(spec('gatewayRun'), `${PUBLIC.gatewayRun}/v1/`);
    expect(reading).toMatchObject({ verdict: 'private_address' });
    expect('detail' in reading && reading.detail).toContain('/v1/v1');
  });

  it('takes /v1 as an ordinary path on the other two origins', () => {
    expect(classifyFleetOrigin(spec('core'), `${PUBLIC.core}/v1`)).toEqual({
      address: `${PUBLIC.core}/v1`,
    });
  });
});

describe('verifyFleetOrigins', () => {
  it('is not_applicable, and reads nothing, where no real fleet machine boots', async () => {
    const fetchImpl = answering();
    expect(await verifyFleetOrigins({ isConfigured: false, env: {}, fetchImpl })).toEqual({
      verdict: 'not_applicable',
      detail: 'this deployment boots no real fleet machine',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is ok when every origin is public and its health route answers 2xx', async () => {
    const fetchImpl = answering(204);
    const result = await verifyFleetOrigins({ isConfigured: true, env: publicEnv, fetchImpl });
    expect(result.verdict).toBe('ok');
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      `${PUBLIC.core}/api/health/ready`,
      `${PUBLIC.aiContainer}/health`,
      `${PUBLIC.gatewayRun}/healthz`,
    ]);
    expect('readings' in result && result.readings).toEqual(
      FLEET_ORIGINS.map((s) =>
        expect.objectContaining({
          origin: s.origin,
          verdict: 'reachable',
          address: PUBLIC[s.origin],
          path: s.healthPath,
          status: 204,
        }),
      ),
    );
  });

  it('reads MOTIR_BASE_URL itself, so an unset value fails though the app falls back to localhost', async () => {
    const result = await verifyFleetOrigins({
      isConfigured: true,
      env: { ...publicEnv, MOTIR_BASE_URL: undefined },
      fetchImpl: answering(),
    });
    expect(result).toMatchObject({
      verdict: 'failed',
      failures: [{ origin: 'core', verdict: 'unconfigured', output: 'CoreOrigin' }],
    });
  });

  it('fails on a definite failure even while another origin cannot be told', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const result = await verifyFleetOrigins({
      isConfigured: true,
      env: { ...publicEnv, MOTIR_GATEWAY_RUN_URL: 'http://motir-gateway.internal:8080' },
      fetchImpl,
    });
    expect(result.verdict).toBe('failed');
    if (result.verdict !== 'failed') return;
    expect(result.failures.map((f) => f.origin)).toEqual(['gatewayRun']);
    expect(byOrigin(result.readings, 'core')).toMatchObject({ verdict: 'indeterminate' });
    // The private address is never probed: the verdict comes from its shape.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('is indeterminate, never failed, when a public origin answers non-2xx or not at all', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request): Promise<Response> => {
      if (String(url).startsWith(PUBLIC.aiContainer)) throw new Error('fetch failed');
      if (String(url).startsWith(PUBLIC.gatewayRun)) return new Response('', { status: 503 });
      return new Response('ok', { status: 200 });
    });
    const result = await verifyFleetOrigins({ isConfigured: true, env: publicEnv, fetchImpl });
    expect(result.verdict).toBe('indeterminate');
    if (result.verdict !== 'indeterminate') return;
    expect(byOrigin(result.readings, 'core')).toMatchObject({ verdict: 'reachable' });
    expect(result.detail).toBe(
      `MOTIR_AI_CONTAINER_URL ${PUBLIC.aiContainer}/health: fetch failed; ` +
        `MOTIR_GATEWAY_RUN_URL ${PUBLIC.gatewayRun}/healthz: ${PUBLIC.gatewayRun}/healthz answered 503.`,
    );
  });

  it('carries a non-Error throw as its string', async () => {
    const result = await verifyFleetOrigins({
      isConfigured: true,
      env: publicEnv,
      fetchImpl: vi.fn(async () => {
        throw 'socket hang up';
      }),
    });
    expect(result).toMatchObject({ verdict: 'indeterminate' });
    expect('detail' in result && result.detail).toContain('socket hang up');
  });

  it('reads an origin no fleet kind here is handed as not_applicable, and never fails on it', async () => {
    const fetchImpl = answering();
    const result = await verifyFleetOrigins({
      isConfigured: true,
      applies: { aiContainer: false, gatewayRun: false },
      env: { MOTIR_BASE_URL: PUBLIC.core },
      fetchImpl,
    });
    expect(result.verdict).toBe('ok');
    if (result.verdict !== 'ok') return;
    expect(result.readings.map((r) => [r.origin, r.verdict])).toEqual([
      ['core', 'reachable'],
      ['aiContainer', 'not_applicable'],
      ['gatewayRun', 'not_applicable'],
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reads the process environment and the global fetch when none is injected', async () => {
    vi.stubEnv('MOTIR_BASE_URL', PUBLIC.core);
    vi.stubEnv('MOTIR_AI_CONTAINER_URL', PUBLIC.aiContainer);
    vi.stubEnv('MOTIR_GATEWAY_RUN_URL', PUBLIC.gatewayRun);
    vi.stubGlobal('fetch', answering());
    expect((await verifyFleetOrigins({ isConfigured: true })).verdict).toBe('ok');
  });
});

describe('fleetPreflightService.checkFleetOrigins', () => {
  function stubOrigins() {
    vi.stubEnv('MOTIR_BASE_URL', PUBLIC.core);
    vi.stubEnv('MOTIR_AI_CONTAINER_URL', PUBLIC.aiContainer);
    vi.stubEnv('MOTIR_GATEWAY_RUN_URL', PUBLIC.gatewayRun);
    vi.stubGlobal('fetch', answering());
  }

  it('is not_applicable on the fake orchestrator, which boots no machine', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
    vi.stubEnv('MOTIR_BASE_URL', '');
    expect(await fleetPreflightService.checkFleetOrigins()).toMatchObject({
      verdict: 'not_applicable',
    });
  });

  it('is not_applicable on a deployment wired for no fleet kind at all', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    for (const name of [
      'FLY_FLEET_API_TOKEN',
      'FLY_FLEET_APP',
      'MOTIR_RUNNER_IMAGE',
      'MOTIR_INDEXER_IMAGE',
      'MOTIR_HOSTED_AGENT_IMAGE',
      'FLY_INSTANCES_API_TOKEN',
      'MOTIR_INSTALL_FLEET_KINDS',
      'MOTIR_BASE_URL',
    ]) {
      vi.stubEnv(name, '');
    }
    expect(await fleetPreflightService.checkFleetOrigins()).toMatchObject({
      verdict: 'not_applicable',
    });
  });

  function wireOnly(kinds: {
    ci?: boolean;
    index?: boolean;
    hosted?: boolean;
    instances?: boolean;
  }) {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', kinds.ci || kinds.index ? 'fly_fleet_token' : '');
    vi.stubEnv('FLY_FLEET_APP', kinds.ci || kinds.index ? 'motir-ci-fleet' : '');
    vi.stubEnv(
      'MOTIR_RUNNER_IMAGE',
      kinds.ci || kinds.index ? 'ghcr.io/motir-co/motir-ci-runner@sha256:446c692d' : '',
    );
    vi.stubEnv(
      'MOTIR_INDEXER_IMAGE',
      kinds.index ? 'registry.fly.io/motir-indexer@sha256:0a1b2c3d' : '',
    );
    vi.stubEnv(
      'MOTIR_HOSTED_AGENT_IMAGE',
      kinds.hosted ? 'ghcr.io/motir-co/motir-agent@sha256:9f8e7d6c' : '',
    );
    vi.stubEnv('FLY_INSTANCES_API_TOKEN', kinds.instances ? 'fly_instances_token' : '');
    vi.stubEnv('MOTIR_INSTALL_FLEET_KINDS', '');
  }

  const verdicts = (result: Awaited<ReturnType<typeof fleetPreflightService.checkFleetOrigins>>) =>
    'readings' in result ? result.readings.map((r) => [r.origin, r.verdict]) : result.verdict;

  it('is not_applicable on a CI-only fleet, whose runner is handed no Motir address', async () => {
    wireOnly({ ci: true });
    vi.stubEnv('MOTIR_BASE_URL', '');
    expect(await fleetPreflightService.checkFleetOrigins()).toMatchObject({
      verdict: 'not_applicable',
    });
  });

  it("asks only core's origin of a deployment that runs agent instances alone", async () => {
    wireOnly({ instances: true });
    stubOrigins();
    expect(verdicts(await fleetPreflightService.checkFleetOrigins())).toEqual([
      ['core', 'reachable'],
      ['aiContainer', 'not_applicable'],
      ['gatewayRun', 'not_applicable'],
    ]);
    vi.stubEnv('MOTIR_BASE_URL', '');
    expect(await fleetPreflightService.checkFleetOrigins()).toMatchObject({
      verdict: 'failed',
      failures: [{ origin: 'core', verdict: 'unconfigured' }],
    });
  });

  it("asks core's origin of agent instances on the install fleet, with no Fly lane", async () => {
    wireOnly({});
    vi.stubEnv('MOTIR_INSTALL_FLEET_KINDS', 'agent_instance');
    stubOrigins();
    expect(verdicts(await fleetPreflightService.checkFleetOrigins())).toEqual([
      ['core', 'reachable'],
      ['aiContainer', 'not_applicable'],
      ['gatewayRun', 'not_applicable'],
    ]);
  });

  it("asks only motir-ai's origin of a deployment that only indexes", async () => {
    wireOnly({ index: true });
    stubOrigins();
    vi.stubEnv('MOTIR_BASE_URL', '');
    expect(verdicts(await fleetPreflightService.checkFleetOrigins())).toEqual([
      ['core', 'not_applicable'],
      ['aiContainer', 'reachable'],
      ['gatewayRun', 'not_applicable'],
    ]);
  });

  it("asks core's and the gateway's origins of a deployment that runs hosted agents", async () => {
    wireOnly({ hosted: true });
    stubOrigins();
    vi.stubEnv('MOTIR_AI_CONTAINER_URL', '');
    expect(verdicts(await fleetPreflightService.checkFleetOrigins())).toEqual([
      ['core', 'reachable'],
      ['aiContainer', 'not_applicable'],
      ['gatewayRun', 'reachable'],
    ]);
  });

  it('asks all three of a deployment that indexes and runs hosted agents', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', 'fly_fleet_token');
    vi.stubEnv('FLY_FLEET_APP', 'motir-ci-fleet');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', 'ghcr.io/motir-co/motir-ci-runner@sha256:446c692d');
    vi.stubEnv('MOTIR_INDEXER_IMAGE', 'registry.fly.io/motir-indexer@sha256:0a1b2c3d');
    vi.stubEnv('MOTIR_HOSTED_AGENT_IMAGE', 'ghcr.io/motir-co/motir-agent@sha256:9f8e7d6c');
    stubOrigins();
    vi.stubEnv('MOTIR_GATEWAY_RUN_URL', 'https://motir-gateway.fly.dev');
    expect(await fleetPreflightService.checkFleetOrigins()).toMatchObject({
      verdict: 'failed',
      failures: [{ origin: 'gatewayRun', output: 'GatewayRunOrigin' }],
    });
  });
});
