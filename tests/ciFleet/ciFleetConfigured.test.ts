import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AWS_RUNNER_AMI_ENV_VAR,
  ciFleetMissingConfig,
  isCiFleetConfigured,
  isOrchestratorConfigured,
  setAwsEc2OverrideForTests,
} from '@/lib/orchestrator';
import { CI_RUNNER_PROVIDER_ENV_VAR, ciRunnerOnPool } from '@/lib/ciFleet/fleetKindSwitches';
import { wireFleetKindSwitch } from '@/lib/ciFleet/shardTargets';
import { adminDb } from '../helpers/adminDb';

// THE CI RUNNER'S CONFIG GATE (Bug MOTIR-10625) — the CI twin of
// `isIndexFleetConfigured()` (MOTIR-10568).
//
// The gate used to be `isOrchestratorConfigured()`: the Fly fleet's three
// variables. On AWS, with `MOTIR_FLEET_CI_RUNNER_PROVIDER=aws`, a CI job boots on
// a `ci_runner` pool account and reads none of them — so the hot path, the
// provision sweep and the CI sweeps all stayed off, and every `motir-runner`
// job queued for good. The gate now follows the kind's switch.

const AMI = 'ami-0123456789abcdef0';
const ROLE_ARN = 'arn:aws:iam::944842271421:role/motir-add-shard';

const VARS = [
  'MOTIR_FLEET_ORCHESTRATOR',
  'FLY_FLEET_API_TOKEN',
  'FLY_FLEET_APP',
  'MOTIR_RUNNER_IMAGE',
  CI_RUNNER_PROVIDER_ENV_VAR,
  AWS_RUNNER_AMI_ENV_VAR,
  'AWS_ORG_ADMIN_ROLE_ARN',
];

/** The AWS deployment's shape: CI on its pool, the AWS values set, no Fly fleet. */
function configureAwsPool(): void {
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
  vi.stubEnv(CI_RUNNER_PROVIDER_ENV_VAR, 'aws');
  vi.stubEnv(AWS_RUNNER_AMI_ENV_VAR, AMI);
  vi.stubEnv('AWS_ORG_ADMIN_ROLE_ARN', ROLE_ARN);
}

/** A Fly deployment with its whole fleet set. */
function configureFly(): void {
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
  vi.stubEnv('FLY_FLEET_API_TOKEN', 'fly-token');
  vi.stubEnv('FLY_FLEET_APP', 'motir-fleet-app');
  vi.stubEnv('MOTIR_RUNNER_IMAGE', 'ghcr.io/motir-co/motir-ci-runner@sha256:' + 'a'.repeat(64));
}

beforeEach(() => {
  for (const key of VARS) vi.stubEnv(key, '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  setAwsEc2OverrideForTests(null);
  // The import wired the env reader; put it back after a test rewires it.
  wireFleetKindSwitch('ci_runner', ciRunnerOnPool);
});

afterAll(async () => {
  await adminDb.$disconnect();
});

describe('on the CI runner pool (MOTIR_FLEET_CI_RUNNER_PROVIDER=aws)', () => {
  it('is configured with NO Fly fleet variable set', async () => {
    configureAwsPool();
    expect(await ciFleetMissingConfig()).toEqual([]);
    expect(await isCiFleetConfigured()).toBe(true);
    // The process-wide fleet is still unconfigured, and says so: the two gates
    // answer different questions.
    expect(isOrchestratorConfigured()).toBe(false);
  });

  it('names the runner AMI when it is not pinned', async () => {
    configureAwsPool();
    vi.stubEnv(AWS_RUNNER_AMI_ENV_VAR, '  ');
    expect(await ciFleetMissingConfig()).toEqual([AWS_RUNNER_AMI_ENV_VAR]);
    expect(await isCiFleetConfigured()).toBe(false);
  });

  it('names the management credential the runner role is assumed through', async () => {
    configureAwsPool();
    vi.stubEnv('AWS_ORG_ADMIN_ROLE_ARN', '');
    expect(await ciFleetMissingConfig()).toEqual(['AWS_ORG_ADMIN_ROLE_ARN']);
  });

  it('names the role ARN and the AMI, all at once', async () => {
    configureAwsPool();
    vi.stubEnv(AWS_RUNNER_AMI_ENV_VAR, '');
    vi.stubEnv('AWS_ORG_ADMIN_ROLE_ARN', '');
    expect(await ciFleetMissingConfig()).toEqual([
      'AWS_ORG_ADMIN_ROLE_ARN',
      AWS_RUNNER_AMI_ENV_VAR,
    ]);
  });

  it('needs nothing under the acceptance lane’s fake EC2, as the launch does not', async () => {
    vi.stubEnv(CI_RUNNER_PROVIDER_ENV_VAR, 'aws');
    setAwsEc2OverrideForTests((() => ({})) as never);
    expect(await ciFleetMissingConfig()).toEqual([]);
  });

  it('reads the switch admission places by — a rewired reader moves the gate with it', async () => {
    configureAwsPool();
    wireFleetKindSwitch('ci_runner', () => false);
    // Off the pool now: the Fly fleet's three are what is missing.
    expect(await ciFleetMissingConfig()).toEqual([
      'FLY_FLEET_API_TOKEN',
      'FLY_FLEET_APP',
      'MOTIR_RUNNER_IMAGE',
    ]);
  });
});

describe('with the switch on Fly', () => {
  it.each([undefined, '', 'fly'])('still needs the three Fly values (switch %j)', async (value) => {
    vi.stubEnv(CI_RUNNER_PROVIDER_ENV_VAR, value);
    // The AWS values do not stand in for them.
    vi.stubEnv(AWS_RUNNER_AMI_ENV_VAR, AMI);
    vi.stubEnv('AWS_ORG_ADMIN_ROLE_ARN', ROLE_ARN);
    expect(await ciFleetMissingConfig()).toEqual([
      'FLY_FLEET_API_TOKEN',
      'FLY_FLEET_APP',
      'MOTIR_RUNNER_IMAGE',
    ]);
    expect(await isCiFleetConfigured()).toBe(false);
  });

  it('names only what is missing', async () => {
    configureFly();
    vi.stubEnv('FLY_FLEET_APP', '');
    expect(await ciFleetMissingConfig()).toEqual(['FLY_FLEET_APP']);
  });

  it('is configured on a fully-wired Fly fleet, and agrees with the process-wide gate', async () => {
    configureFly();
    expect(await isCiFleetConfigured()).toBe(true);
    expect(isOrchestratorConfigured()).toBe(true);
  });
});

describe('the fake adapter', () => {
  it.each(['fly', 'aws'])('needs nothing, whichever way the switch reads (%s)', async (value) => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
    vi.stubEnv(CI_RUNNER_PROVIDER_ENV_VAR, value);
    expect(await ciFleetMissingConfig()).toEqual([]);
    expect(await isCiFleetConfigured()).toBe(true);
  });
});
