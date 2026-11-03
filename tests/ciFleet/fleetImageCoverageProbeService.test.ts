import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetOrgCiTargetDTO } from '@/lib/dto/fleetOrgCiSetting';
import { FleetImageCoverageGapError } from '@/lib/jobs/definitions/dailyHealthCheck';
import { FleetOrgCiGithubWriteError } from '@/lib/platform/errors';
import {
  fleetImageCoverageProbeService,
  judgeCoverage,
} from '@/lib/services/fleetImageCoverageProbeService';
import { fleetOrgCiSettingService } from '@/lib/services/fleetOrgCiSettingService';
import {
  fleetReadinessService,
  type FleetReadinessCondition,
} from '@/lib/services/fleetReadinessService';

// THE FLEET IMAGE-COVERAGE PROBE (MOTIR-10290): the daily health check asks
// readiness condition 9 of every pair the fleet console offers. The condition
// itself — the workflows read at head, the image's tool list — is pinned in
// `fleetReadinessService.test.ts`; here it is the seam, and this file pins how
// the probe folds the answers, which arms are loud, and the error's sentence.

const NOW = new Date('2026-11-03T09:00:00Z');
const RUNNER_IMAGE = `registry.probe.test/motir-ci-runner@sha256:${'ef'.repeat(32)}`;

function target(projectKey: string, org: string): FleetOrgCiTargetDTO {
  return {
    projectId: `p-${projectKey}`,
    projectKey,
    workspaceId: `w-${projectKey}`,
    organizationId: 'o',
    org,
    installationId: '1',
  };
}

function condition(
  state: FleetReadinessCondition['state'],
  reasonCode: string,
  message = `${reasonCode} message`,
): FleetReadinessCondition {
  return { key: 'image_coverage', state, reasonCode, params: {}, message };
}

beforeEach(() => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  vi.stubEnv('MOTIR_RUNNER_IMAGE', RUNNER_IMAGE);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('fleetImageCoverageProbeService.check', () => {
  it('is not_applicable with no provisioning App, or no runner image pinned', async () => {
    const targets = vi.spyOn(fleetOrgCiSettingService, 'systemTargets');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', '');
    expect(await fleetImageCoverageProbeService.check({ now: NOW })).toEqual({
      verdict: 'not_applicable',
      checkedAt: NOW.toISOString(),
      reason: 'runner_image_unset',
    });
    vi.stubEnv('GITHUB_STUDIO_APP_ID', '');
    expect(await fleetImageCoverageProbeService.check({ now: NOW })).toMatchObject({
      verdict: 'not_applicable',
      reason: 'app_not_configured',
    });
    expect(targets).not.toHaveBeenCalled();
  });

  it('is not_applicable when the console offers no pair (the real door, no meta project)', async () => {
    expect(await fleetImageCoverageProbeService.check({ now: NOW })).toMatchObject({
      verdict: 'not_applicable',
      reason: 'no_targets',
    });
  });

  it('asks condition 9 of every offered pair and is runnable when each is met', async () => {
    vi.spyOn(fleetOrgCiSettingService, 'systemTargets').mockResolvedValue([
      target('MOTIR', 'motir-co'),
      target('ACME', 'acme'),
    ]);
    const ask = vi
      .spyOn(fleetReadinessService, 'imageCoverageFor')
      .mockResolvedValue(condition('met', 'all_runnable'));
    const verdict = await fleetImageCoverageProbeService.check({ now: NOW });
    expect(ask.mock.calls.map(([t]) => t)).toEqual([
      { projectId: 'p-MOTIR', workspaceId: 'w-MOTIR', org: 'motir-co' },
      { projectId: 'p-ACME', workspaceId: 'w-ACME', org: 'acme' },
    ]);
    expect(verdict).toEqual({
      verdict: 'runnable',
      checkedAt: NOW.toISOString(),
      pairs: [
        {
          projectKey: 'MOTIR',
          org: 'motir-co',
          state: 'met',
          reasonCode: 'all_runnable',
          message: 'all_runnable message',
        },
        {
          projectKey: 'ACME',
          org: 'acme',
          state: 'met',
          reasonCode: 'all_runnable',
          message: 'all_runnable message',
        },
      ],
    });
  });

  it('is indeterminate when the pairs cannot be listed, and rethrows anything else', async () => {
    const targets = vi
      .spyOn(fleetOrgCiSettingService, 'systemTargets')
      .mockRejectedValueOnce(new FleetOrgCiGithubWriteError('acme', 502, 'read'));
    expect(await fleetImageCoverageProbeService.check({ now: NOW })).toEqual({
      verdict: 'indeterminate',
      checkedAt: NOW.toISOString(),
      pairs: [],
      targetsUnreadable: { status: 502 },
    });
    targets.mockRejectedValueOnce(new RangeError('a bug'));
    await expect(fleetImageCoverageProbeService.check({ now: NOW })).rejects.toBeInstanceOf(
      RangeError,
    );
  });
});

describe('judgeCoverage — which answers are loud', () => {
  const pair = (state: FleetReadinessCondition['state'], reasonCode: string) => ({
    projectKey: 'MOTIR',
    org: 'motir-co',
    state,
    reasonCode,
    message: 'm',
  });
  const at = NOW.toISOString();

  it('a job the image cannot run, or an image with no tool list, is a gap', () => {
    expect(judgeCoverage(at, [pair('unmet', 'jobs_not_runnable')]).verdict).toBe('gap');
    expect(
      judgeCoverage(at, [pair('unknown', 'read_failed'), pair('unmet', 'image_tools_unrecorded')])
        .verdict,
    ).toBe('gap');
  });

  it('a refused read is indeterminate; a project with no private repository is runnable', () => {
    expect(judgeCoverage(at, [pair('unknown', 'image_unreadable')])).toMatchObject({
      verdict: 'indeterminate',
      targetsUnreadable: null,
    });
    expect(judgeCoverage(at, [pair('unmet', 'no_private_repositories')]).verdict).toBe('runnable');
  });
});

describe("the health check's FleetImageCoverageGapError", () => {
  it('names each unmet pair by its own message, and the way out', () => {
    const error = new FleetImageCoverageGapError({
      verdict: 'gap',
      checkedAt: NOW.toISOString(),
      pairs: [
        {
          projectKey: 'MOTIR',
          org: 'motir-co',
          state: 'unmet',
          reasonCode: 'jobs_not_runnable',
          message:
            '1 job cannot run: motir-co/motir-ai ci.yml deploy (needs aws, which the image lacks).',
        },
        {
          projectKey: 'ACME',
          org: 'acme',
          state: 'met',
          reasonCode: 'all_runnable',
          message: 'fine',
        },
      ],
    });
    expect(error.name).toBe('FleetImageCoverageGapError');
    expect(error.message).toContain(
      'MOTIR on motir-co: 1 job cannot run: motir-co/motir-ai ci.yml deploy (needs aws',
    );
    expect(error.message).not.toContain('fine');
    expect(error.message).toContain('infra/ci-runner/Dockerfile');
  });
});
