import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  CI_RUNNER_PROVIDER_ENV_VAR,
  ciRunnerOnPool,
  setAgentRunnerSwitchForTests,
  setCiRunnerSwitchForTests,
} from '@/lib/ciFleet/fleetKindSwitches';
import { fleetKindOnPool } from '@/lib/ciFleet/shardTargets';
import { adminDb } from '../helpers/adminDb';

// THE CI RUNNER'S PRODUCTION Fly↔AWS SWITCH (MOTIR-10064):
// `MOTIR_FLEET_CI_RUNNER_PROVIDER`, wired as `ci_runner`'s reader by importing
// `fleetKindSwitches`. The lane's fixture answers first; then `aws` ⇒ the CI
// pool, unset / empty / `fly` ⇒ Fly, anything else ⇒ Fly with one warning.
// Read on every call, and no other kind moves with it.

afterEach(() => {
  setCiRunnerSwitchForTests(null);
  setAgentRunnerSwitchForTests(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await adminDb.$disconnect();
});

function quietWarn() {
  return vi.spyOn(console, 'warn').mockImplementation(() => {});
}

describe('MOTIR_FLEET_CI_RUNNER_PROVIDER', () => {
  it('is the env var the switch reads', () => {
    expect(CI_RUNNER_PROVIDER_ENV_VAR).toBe('MOTIR_FLEET_CI_RUNNER_PROVIDER');
  });

  it.each(['aws', 'AWS', ' Aws ', '\taws\n'])('puts CI on its pool for %j', async (value) => {
    const warn = quietWarn();
    vi.stubEnv(CI_RUNNER_PROVIDER_ENV_VAR, value);
    expect(ciRunnerOnPool()).toBe(true);
    expect(await fleetKindOnPool('ci_runner')).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads Fly, silently, when the variable is unset', async () => {
    const warn = quietWarn();
    vi.stubEnv(CI_RUNNER_PROVIDER_ENV_VAR, undefined);
    expect(ciRunnerOnPool()).toBe(false);
    expect(await fleetKindOnPool('ci_runner')).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['', '   ', 'fly', 'FLY', ' Fly '])('reads Fly, silently, for %j', async (value) => {
    const warn = quietWarn();
    vi.stubEnv(CI_RUNNER_PROVIDER_ENV_VAR, value);
    expect(ciRunnerOnPool()).toBe(false);
    expect(await fleetKindOnPool('ci_runner')).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['awss', 'ec2', 'true', 'aws,fly'])(
    'reads Fly for the malformed %j and warns once, naming the variable and the raw value',
    async (value) => {
      const warn = quietWarn();
      vi.stubEnv(CI_RUNNER_PROVIDER_ENV_VAR, value);
      expect(await fleetKindOnPool('ci_runner')).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[1]).toEqual({ env: CI_RUNNER_PROVIDER_ENV_VAR, raw: value });
    },
  );

  it('is read on every call, never cached', async () => {
    vi.stubEnv(CI_RUNNER_PROVIDER_ENV_VAR, 'aws');
    expect(await fleetKindOnPool('ci_runner')).toBe(true);
    vi.stubEnv(CI_RUNNER_PROVIDER_ENV_VAR, 'fly');
    expect(await fleetKindOnPool('ci_runner')).toBe(false);
    vi.stubEnv(CI_RUNNER_PROVIDER_ENV_VAR, undefined);
    expect(await fleetKindOnPool('ci_runner')).toBe(false);
    vi.stubEnv(CI_RUNNER_PROVIDER_ENV_VAR, 'aws');
    expect(await fleetKindOnPool('ci_runner')).toBe(true);
  });
});

describe('the lane fixture answers first', () => {
  it('wins with true over an env var on Fly', async () => {
    vi.stubEnv(CI_RUNNER_PROVIDER_ENV_VAR, 'fly');
    setCiRunnerSwitchForTests(() => true);
    expect(await fleetKindOnPool('ci_runner')).toBe(true);
  });

  it('wins with false over an env var on AWS', async () => {
    vi.stubEnv(CI_RUNNER_PROVIDER_ENV_VAR, 'aws');
    setCiRunnerSwitchForTests(() => false);
    expect(await fleetKindOnPool('ci_runner')).toBe(false);
  });

  it('falls through to the env var when it says nothing', async () => {
    setCiRunnerSwitchForTests(() => null);
    vi.stubEnv(CI_RUNNER_PROVIDER_ENV_VAR, 'aws');
    expect(await fleetKindOnPool('ci_runner')).toBe(true);
    vi.stubEnv(CI_RUNNER_PROVIDER_ENV_VAR, 'fly');
    expect(await fleetKindOnPool('ci_runner')).toBe(false);
  });

  it('reads Fly again once it is removed', async () => {
    vi.stubEnv(CI_RUNNER_PROVIDER_ENV_VAR, undefined);
    setCiRunnerSwitchForTests(() => true);
    expect(await fleetKindOnPool('ci_runner')).toBe(true);
    setCiRunnerSwitchForTests(null);
    expect(await fleetKindOnPool('ci_runner')).toBe(false);
  });
});

describe('only ci_runner follows it', () => {
  it('leaves the indexer, the agent runner and the agent hoster where they are', async () => {
    // Pin the env-switched kinds to Fly; the agent hoster reads its stored
    // switch, which no test row sets, so it reads Fly too. The only thing that
    // can move between the two reads below is the CI runner's env var.
    vi.stubEnv('MOTIR_INDEX_FLEET_PROVIDER', 'fly');
    vi.stubEnv('MOTIR_FLEET_AGENT_RUNNER_PROVIDER', 'fly');
    await adminDb.platformFleetKindSwitch.deleteMany({});
    const others = ['code_graph_index', 'hosted_agent', 'agent_instance'] as const;
    vi.stubEnv(CI_RUNNER_PROVIDER_ENV_VAR, 'fly');
    const before = await Promise.all(others.map((kind) => fleetKindOnPool(kind)));
    vi.stubEnv(CI_RUNNER_PROVIDER_ENV_VAR, 'aws');
    expect(await fleetKindOnPool('ci_runner')).toBe(true);
    const after = await Promise.all(others.map((kind) => fleetKindOnPool(kind)));
    expect(before).toEqual([false, false, false]);
    expect(after).toEqual(before);
  });
});
