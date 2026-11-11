import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// THE HOSTED-AGENT IMAGE LAG PROBE (MOTIR-10882): the daily health check fails
// when the newest `main` build of the hosted-agent image has gone unpinned for
// more than a day, or the pin is more than a week behind it. The registry is
// faked at its seam, `readImageCreated`, whose HTTP is pinned in the
// orchestrator package's `imagePull.test.ts`. This file pins every arm, both
// allowances, and the error's sentence.

const registry = vi.hoisted(() => ({ readImageCreated: vi.fn() }));
vi.mock('@motir/orchestrator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@motir/orchestrator')>()),
  readImageCreated: registry.readImageCreated,
}));

const { HostedAgentImageLaggingError } = await import('@/lib/jobs/definitions/dailyHealthCheck');
const {
  HOSTED_AGENT_IMAGE_MAX_BEHIND_MS,
  HOSTED_AGENT_IMAGE_MAX_UNPINNED_MS,
  hostedAgentImageLagProbeService,
} = await import('@/lib/services/hostedAgentImageLagProbeService');
const { HOSTED_AGENT_IMAGE_ENV_VAR } = await import('@/lib/orchestrator');

const NOW = new Date('2026-11-10T09:00:00Z');
const REPO = 'ghcr.io/motir-co/motir-hosted-agent';
const PINNED_DIGEST = `sha256:${'87'.repeat(32)}`;
const MAIN_DIGEST = `sha256:${'03'.repeat(32)}`;
const PINNED = `${REPO}@${PINNED_DIGEST}`;
const MAIN = `${REPO}:main`;

const hoursBefore = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

/** The registry: `:main` and the pinned digest, each with a build time. */
function serve(
  main: { digest: string | null; createdAt: string | null },
  pinned: { createdAt: string | null } | 'unreadable' = { createdAt: hoursBefore(48) },
) {
  registry.readImageCreated.mockImplementation(async (reference: string) => {
    if (reference === MAIN) return { ok: true, reference, ...main };
    if (pinned === 'unreadable') {
      return { ok: false, reference, reason: 'unreachable', detail: 'ECONNRESET' };
    }
    return { ok: true, reference, digest: PINNED_DIGEST, ...pinned };
  });
}

beforeEach(() => {
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
  vi.stubEnv(HOSTED_AGENT_IMAGE_ENV_VAR, PINNED);
});

afterEach(() => {
  vi.unstubAllEnvs();
  registry.readImageCreated.mockReset();
});

describe('hostedAgentImageLagProbeService.check', () => {
  it('is not_applicable under the fake orchestrator, and reads no registry', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
    expect(await hostedAgentImageLagProbeService.check(NOW)).toEqual({
      verdict: 'not_applicable',
      checkedAt: NOW.toISOString(),
      detail: 'the fake orchestrator is selected; no image is pulled',
    });
    expect(registry.readImageCreated).not.toHaveBeenCalled();
  });

  it('is not_applicable when no hosted-agent image is set', async () => {
    vi.stubEnv(HOSTED_AGENT_IMAGE_ENV_VAR, '');
    expect(await hostedAgentImageLagProbeService.check(NOW)).toMatchObject({
      verdict: 'not_applicable',
      detail: expect.stringContaining('MOTIR_HOSTED_AGENT_IMAGE is unset'),
    });
  });

  it('is indeterminate at the pin when the image is pinned by tag', async () => {
    vi.stubEnv(HOSTED_AGENT_IMAGE_ENV_VAR, `${REPO}:main`);
    expect(await hostedAgentImageLagProbeService.check(NOW)).toMatchObject({
      verdict: 'indeterminate',
      phase: 'pin',
      reference: `${REPO}:main`,
      detail: expect.stringContaining('must be pinned by digest'),
    });
    expect(registry.readImageCreated).not.toHaveBeenCalled();
  });

  it("is current when the pin IS :main's digest, reading only :main", async () => {
    serve({ digest: PINNED_DIGEST, createdAt: hoursBefore(200) });
    expect(await hostedAgentImageLagProbeService.check(NOW)).toEqual({
      verdict: 'current',
      checkedAt: NOW.toISOString(),
      pinned: PINNED,
      main: { reference: MAIN, digest: PINNED_DIGEST, createdAt: hoursBefore(200) },
    });
    expect(registry.readImageCreated.mock.calls).toEqual([[MAIN]]);
  });

  it('is current even when the config records no build time', async () => {
    serve({ digest: PINNED_DIGEST, createdAt: null });
    expect(await hostedAgentImageLagProbeService.check(NOW)).toMatchObject({
      verdict: 'current',
      main: { createdAt: null },
    });
  });

  it('is pending while the newer build is under a day old and under a week ahead', async () => {
    serve({ digest: MAIN_DIGEST, createdAt: hoursBefore(5) });
    expect(await hostedAgentImageLagProbeService.check(NOW)).toEqual({
      verdict: 'pending',
      checkedAt: NOW.toISOString(),
      pinned: PINNED,
      main: { reference: MAIN, digest: MAIN_DIGEST, createdAt: hoursBefore(5) },
      lag: { unpinnedHours: 5, behindHours: 43, pinnedCreatedAt: hoursBefore(48) },
    });
    expect(registry.readImageCreated.mock.calls).toEqual([[MAIN], [PINNED]]);
  });

  it('is lagging once the newer build has gone unpinned for more than a day', async () => {
    serve({ digest: MAIN_DIGEST, createdAt: hoursBefore(25) });
    expect(await hostedAgentImageLagProbeService.check(NOW)).toMatchObject({
      verdict: 'lagging',
      lag: { unpinnedHours: 25, behindHours: 23 },
    });
    expect(HOSTED_AGENT_IMAGE_MAX_UNPINNED_MS).toBe(24 * 3_600_000);
  });

  it('is pending at exactly a day, the allowance being inclusive', async () => {
    serve({ digest: MAIN_DIGEST, createdAt: hoursBefore(24) });
    expect((await hostedAgentImageLagProbeService.check(NOW)).verdict).toBe('pending');
  });

  // The rule that catches a CLI merged more than once a day: every merge makes
  // `:main` younger, so the first allowance alone would never be spent.
  it('is lagging when :main is fresh but the pinned build is more than a week older', async () => {
    serve({ digest: MAIN_DIGEST, createdAt: hoursBefore(2) }, { createdAt: hoursBefore(2 + 169) });
    expect(await hostedAgentImageLagProbeService.check(NOW)).toMatchObject({
      verdict: 'lagging',
      lag: { unpinnedHours: 2, behindHours: 169 },
    });
    expect(HOSTED_AGENT_IMAGE_MAX_BEHIND_MS).toBe(7 * 24 * 3_600_000);
  });

  it('judges by the first allowance alone when the pinned build time cannot be read', async () => {
    serve({ digest: MAIN_DIGEST, createdAt: hoursBefore(3) }, 'unreadable');
    expect(await hostedAgentImageLagProbeService.check(NOW)).toMatchObject({
      verdict: 'pending',
      lag: { unpinnedHours: 3, behindHours: null, pinnedCreatedAt: null },
    });
    serve({ digest: MAIN_DIGEST, createdAt: hoursBefore(3) }, { createdAt: null });
    expect(await hostedAgentImageLagProbeService.check(NOW)).toMatchObject({
      verdict: 'pending',
      lag: { behindHours: null },
    });
  });

  it('counts a build time in the future as zero hours unpinned', async () => {
    serve({ digest: MAIN_DIGEST, createdAt: new Date(NOW.getTime() + 60_000).toISOString() });
    expect(await hostedAgentImageLagProbeService.check(NOW)).toMatchObject({
      verdict: 'pending',
      lag: { unpinnedHours: 0 },
    });
  });

  it('is indeterminate at the registry when :main cannot be read', async () => {
    registry.readImageCreated.mockResolvedValue({
      ok: false,
      reference: MAIN,
      reason: 'unreachable',
      detail: 'the registry could not be reached: ECONNRESET',
    });
    expect(await hostedAgentImageLagProbeService.check(NOW)).toEqual({
      verdict: 'indeterminate',
      checkedAt: NOW.toISOString(),
      phase: 'registry',
      reference: MAIN,
      detail: 'unreachable: the registry could not be reached: ECONNRESET',
    });
  });

  it('is indeterminate when :main names no digest, or a newer one with no build time', async () => {
    serve({ digest: null, createdAt: hoursBefore(1) });
    expect(await hostedAgentImageLagProbeService.check(NOW)).toMatchObject({
      verdict: 'indeterminate',
      detail: 'the registry named no digest for :main',
    });
    serve({ digest: MAIN_DIGEST, createdAt: null });
    expect(await hostedAgentImageLagProbeService.check(NOW)).toMatchObject({
      verdict: 'indeterminate',
      detail: "the :main image's config records no build time",
    });
  });

  it('defaults the clock to now', async () => {
    serve({ digest: PINNED_DIGEST, createdAt: hoursBefore(1) });
    const verdict = await hostedAgentImageLagProbeService.check();
    expect(Date.parse(verdict.checkedAt)).toBeGreaterThan(NOW.getTime());
  });
});

describe('HostedAgentImageLaggingError', () => {
  const lagging = {
    verdict: 'lagging' as const,
    checkedAt: NOW.toISOString(),
    pinned: PINNED,
    main: { reference: MAIN, digest: MAIN_DIGEST, createdAt: hoursBefore(30) },
    lag: { unpinnedHours: 30, behindHours: 840, pinnedCreatedAt: hoursBefore(870) },
  };

  it('names the pin, the newer build, both lags and the pull request to merge', () => {
    const err = new HostedAgentImageLaggingError(lagging);
    expect(err.name).toBe('HostedAgentImageLaggingError');
    expect(err.verdict).toBe(lagging);
    expect(err.message).toContain(`${PINNED} is pinned`);
    expect(err.message).toContain(`${MAIN} has been ${MAIN_DIGEST} for 30 h`);
    expect(err.message).toContain(`840 h newer than the pinned build (${hoursBefore(870)})`);
    expect(err.message).toContain('chore/hosted-agent-image-pin');
    expect(err.message).toContain('MOTIR_HOSTED_AGENT_IMAGE');
  });

  it('leaves out the second lag when the pinned build time is unknown', () => {
    const err = new HostedAgentImageLaggingError({
      ...lagging,
      lag: { unpinnedHours: 30, behindHours: null, pinnedCreatedAt: null },
    });
    expect(err.message).not.toContain('newer than the pinned build');
  });

  it('marks an unknown pinned time when only the gap is known', () => {
    const err = new HostedAgentImageLaggingError({
      ...lagging,
      lag: { unpinnedHours: 30, behindHours: 200, pinnedCreatedAt: null },
    });
    expect(err.message).toContain('200 h newer than the pinned build (?)');
  });
});
