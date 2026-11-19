import { describe, expect, it } from 'vitest';
import {
  MOTIR_ON_DEMAND_RUNNER_LABEL,
  MOTIR_RUNNER_LABEL,
  isMotirFleetJob,
  requestsOnDemandRunner,
} from '@/lib/ciFleet/config';
import { classifyRunner } from '@/lib/ciMetering/runnerRates';

// The fleet's §O label gate, in isolation (Story MOTIR-1916 · MOTIR-1920). Pure
// module, no DB — this is the one decision that separates "boot a machine" from
// "do nothing", and it is worth pinning at the unit level as well as through the
// service, because both of its failure directions are silent:
//
//   * too permissive → Motir's own 141-job-minute CI matrix migrates onto
//     infrastructure Motir is still building (`ci-minutes-allowance.md` §J);
//   * too strict → a job that genuinely asked for a Motir runner never gets one
//     and queues until GitHub expires it 24 hours later, which reads to the user
//     as "Motir handed me a repo whose CI is broken" (§N).

describe('MOTIR_RUNNER_LABEL — the §M naming constraints', () => {
  // §M is emphatic that the label VALUE is load-bearing, not cosmetic: the
  // shipped meter's classifier returns on the first substring match, so a label
  // containing `linux` would be metered as GitHub's own `linux_x64` family
  // (right number, wrong attribution) and one matching `N-core`/`large` would
  // trip §3.4's "unpriced" warning on every fleet job forever. Asserting the
  // constraint here makes a future rename fail a test rather than silently
  // corrupt a year of billing attribution.
  it('contains none of the OS/arch substrings the classifier matches on', () => {
    for (const forbidden of ['ubuntu', 'linux', 'arm', 'windows', 'macos', 'osx']) {
      expect(MOTIR_RUNNER_LABEL).not.toContain(forbidden);
    }
  });

  it('does not match the larger-runner pattern (`N-core` / `large` / `xlarge`)', () => {
    expect(MOTIR_RUNNER_LABEL).not.toMatch(/\d+-?core|xlarge|large/i);
  });

  it('classifies as its OWN `motir_fleet` family, never a GitHub one (MOTIR-1923)', () => {
    // This assertion used to pin `unknown` — the honest state while the rate
    // table had no fleet row — and named MOTIR-1923 as what would flip it. 1923
    // had in fact merged FIRST (`2d13e066`, before this file landed in
    // `dcbb7383`), so the pin shipped already-stale and `main` went red on a
    // collision neither PR could see. Asserting the shipped truth is what a
    // forward-looking pin should have been in the first place: the guarantee
    // §M actually wants is that the label lands in the fleet family, not that
    // it lands in today's fallback.
    expect(classifyRunner([MOTIR_RUNNER_LABEL])).toBe('motir_fleet');
  });
});

describe('the gate and the meter agree on WHICH label is the fleet (MOTIR-1964)', () => {
  // The invariant that outranks either module's own constant: a job the
  // provisioner boots a fleet runner for MUST meter as `motir_fleet`. Two
  // separate `'motir-runner'` literals — one per module, which is what the
  // MOTIR-1920 / MOTIR-1923 merge produced — satisfy every other test in this
  // file and in `runnerRates.test.ts` while being one edit away from silently
  // disagreeing. This asserts the join, so a re-split fails here rather than in
  // a billing report months later.
  it('every label the §O gate accepts classifies as `motir_fleet`', () => {
    for (const labels of [
      [MOTIR_RUNNER_LABEL],
      ['self-hosted', MOTIR_RUNNER_LABEL],
      ['MOTIR-RUNNER'],
      ['  Motir-Runner  '],
      // The §M failure this pair exists to prevent: a fleet job whose set also
      // carries an OS label must still attribute to the fleet, never to Linux.
      ['ubuntu-latest', MOTIR_RUNNER_LABEL],
    ]) {
      expect(isMotirFleetJob(labels)).toBe(true);
      expect(classifyRunner(labels)).toBe('motir_fleet');
    }
  });

  it('a label the gate REJECTS never classifies as `motir_fleet`', () => {
    for (const labels of [['ubuntu-latest'], ['self-hosted'], ['motir-runner-staging'], []]) {
      expect(isMotirFleetJob(labels)).toBe(false);
      expect(classifyRunner(labels)).not.toBe('motir_fleet');
    }
  });
});

describe('isMotirFleetJob — the §O gate', () => {
  it('accepts a job whose sole requested label is the fleet label', () => {
    expect(isMotirFleetJob([MOTIR_RUNNER_LABEL])).toBe(true);
  });

  it('accepts the fleet label alongside others — a job needs ALL its labels', () => {
    // GitHub dispatches a job to a runner carrying every label it lists, so
    // `runs-on: [self-hosted, motir-runner]` is unambiguously asking for the
    // fleet. Requiring the fleet label to be the SOLE entry would refuse it.
    expect(isMotirFleetJob(['self-hosted', MOTIR_RUNNER_LABEL])).toBe(true);
  });

  it('matches case-insensitively, as GitHub matches runner labels', () => {
    expect(isMotirFleetJob(['MOTIR-RUNNER'])).toBe(true);
    expect(isMotirFleetJob(['  Motir-Runner  '])).toBe(true);
  });

  it('REJECTS every GitHub-hosted label — the §J exclusion', () => {
    for (const hosted of [
      ['ubuntu-latest'],
      ['ubuntu-24.04'],
      ['windows-latest'],
      ['macos-14'],
      ['ubuntu-latest-4-core'],
      ['self-hosted'],
    ]) {
      expect(isMotirFleetJob(hosted)).toBe(false);
    }
  });

  it('rejects a job with no labels at all', () => {
    expect(isMotirFleetJob([])).toBe(false);
  });

  it('rejects a label that merely CONTAINS the fleet label', () => {
    // The match is exact-per-label, not substring: a runner registered as
    // `motir-runner-staging` is a different runner group, and `runs-on` selects
    // by whole label. A substring gate would provision Motir's production fleet
    // for someone else's queue.
    expect(isMotirFleetJob(['motir-runner-staging'])).toBe(false);
    expect(isMotirFleetJob(['not-motir-runner'])).toBe(false);
  });
});

describe('requestsOnDemandRunner — the "never Spot" label (MOTIR-11727)', () => {
  it('is the one exported label', () => {
    expect(MOTIR_ON_DEMAND_RUNNER_LABEL).toBe('motir-on-demand');
  });

  it('matches the label exactly, in any case and with surrounding spaces', () => {
    expect(requestsOnDemandRunner([MOTIR_RUNNER_LABEL, 'motir-on-demand'])).toBe(true);
    expect(requestsOnDemandRunner(['MOTIR-ON-DEMAND'])).toBe(true);
    expect(requestsOnDemandRunner([MOTIR_RUNNER_LABEL, '  Motir-On-Demand  '])).toBe(true);
  });

  it('is false for a near-miss and for a set without it', () => {
    expect(requestsOnDemandRunner(['motir-on-demand-x'])).toBe(false);
    expect(requestsOnDemandRunner(['x-motir-on-demand'])).toBe(false);
    expect(requestsOnDemandRunner([MOTIR_RUNNER_LABEL])).toBe(false);
    expect(requestsOnDemandRunner([])).toBe(false);
  });

  it('a job asking for both labels is still a fleet job', () => {
    expect(isMotirFleetJob([MOTIR_RUNNER_LABEL, MOTIR_ON_DEMAND_RUNNER_LABEL])).toBe(true);
  });
});
