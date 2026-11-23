import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ciDockerVolumeGb,
  DEFAULT_CI_DOCKER_VOLUME_GB,
  DEFAULT_FLEET_SLOT_TTL_SECONDS,
  fleetKillSwitchEngaged,
  fleetSlotTtlSeconds,
} from '@/lib/ciFleet/limits';

// The gate's CONFIGURATION half (Story MOTIR-1916 · MOTIR-1922, re-cut by
// MOTIR-6907 per `docs/decisions/fleet-per-org-pool.md`) — pure, no DB.
//
// The assertions are about the SOURCES, not about the specific numbers: that
// unset falls back, that a set value wins, that a nonsense value cannot silently
// become a limit, and that zero — the kill switch — is a real value rather than a
// falsy one.

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('MOTIR_FLEET_MAX_IN_FLIGHT is the KILL SWITCH and nothing else', () => {
  it('is engaged by ZERO', () => {
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '0');
    expect(fleetKillSwitchEngaged()).toBe(true);
  });

  // Unset — and ANY positive number, including the retired default 24 an
  // environment may still carry — imposes no platform ceiling.
  it.each(['', '24', '1', '100000'])('is NOT engaged by %j', (raw) => {
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', raw);
    expect(fleetKillSwitchEngaged()).toBe(false);
  });

  it.each(['nonsense', '-1', '0.0.0'])('reads %s as NOT engaged, with a warning', (raw) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', raw);
    // A typo must NOT read as 0 — the safety mechanism must not cause the outage.
    expect(fleetKillSwitchEngaged()).toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});

// The slot safety net (MOTIR-1997) — the third tunable, and the one whose wrong
// direction is silent. A ceiling set too low queues work visibly; a TTL set too
// SHORT stops counting a container that is still running and spending, so the
// pool is exceeded and nothing says so.
describe('the fleet-slot TTL is per ENVIRONMENT', () => {
  it('defaults to a value LONGER than any container Motir boots', () => {
    vi.stubEnv('MOTIR_FLEET_SLOT_TTL_SECONDS', '');
    expect(fleetSlotTtlSeconds()).toBe(DEFAULT_FLEET_SLOT_TTL_SECONDS);
    // §6's boot budget and every workload's hard-kill sit far inside an hour;
    // the default has to clear them with room, or the safety net becomes the
    // thing that breaks the pool.
    expect(DEFAULT_FLEET_SLOT_TTL_SECONDS).toBeGreaterThan(60 * 60);
  });

  it('takes the environment value when set', () => {
    vi.stubEnv('MOTIR_FLEET_SLOT_TTL_SECONDS', '900');
    expect(fleetSlotTtlSeconds()).toBe(900);
  });

  it('falls back for a malformed value rather than reading it as zero', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('MOTIR_FLEET_SLOT_TTL_SECONDS', 'six hours');
    // A typo must not silently disable the safety net.
    expect(fleetSlotTtlSeconds()).toBe(DEFAULT_FLEET_SLOT_TTL_SECONDS);
    expect(warn).toHaveBeenCalled();
  });
});

describe('the CI Docker volume size is per ENVIRONMENT (MOTIR-8839)', () => {
  it('defaults to 20 GB when unset', () => {
    vi.stubEnv('MOTIR_CI_DOCKER_VOLUME_GB', '');
    expect(DEFAULT_CI_DOCKER_VOLUME_GB).toBe(20);
    expect(ciDockerVolumeGb()).toBe(20);
  });

  it('a set value wins, and 0 turns the volume off', () => {
    vi.stubEnv('MOTIR_CI_DOCKER_VOLUME_GB', '40');
    expect(ciDockerVolumeGb()).toBe(40);
    vi.stubEnv('MOTIR_CI_DOCKER_VOLUME_GB', '0');
    expect(ciDockerVolumeGb()).toBe(0);
  });

  it('a malformed value falls back to the default, with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('MOTIR_CI_DOCKER_VOLUME_GB', 'twenty');
    expect(ciDockerVolumeGb()).toBe(20);
    expect(warn).toHaveBeenCalled();
  });
});
