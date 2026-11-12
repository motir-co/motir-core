import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import type { GithubOrgTarget } from '@/lib/github/orgTarget';
import {
  _resetSeenOnFleet,
  fleetCodeScanningCatchUpService as service,
  ON_FLEET_RECHECK_MS,
} from '@/lib/services/fleetCodeScanningCatchUpService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The deferred CodeQL move a fleet boot makes once its runner is registered.
// GitHub is a fake at `fetch`; the stored pair row is real.

const ORG = 'acme-connected';
const TARGET: GithubOrgTarget = { org: ORG, installationId: '4401', role: 'provisioning' };
const NO_RUNNER_WITH_LABEL =
  'Code scanning default setup can only be enabled if a runner with the specified label is assigned to this repository.';

interface Setup {
  state: 'configured' | 'not-configured';
  runner_type: 'standard' | 'labeled';
  runner_label: string;
}

let fx: WorkItemFixture;
let setup: Setup;
let isPrivate: boolean;
let patchAnswer: { status: number; message: string } | null;
let calls: string[];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installGitHub(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const u = new URL(String(url));
      const method = init?.method ?? 'GET';
      if (u.pathname.endsWith('/access_tokens')) {
        return json(201, {
          token: 'ghs_catch_up',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      calls.push(`${method} ${u.pathname}`);
      if (u.pathname.endsWith('/code-scanning/default-setup')) {
        if (method === 'GET') return json(200, { languages: ['actions'], ...setup });
        if (patchAnswer) return json(patchAnswer.status, { message: patchAnswer.message });
        const body = JSON.parse(init!.body!) as Record<string, string>;
        setup = {
          state: 'configured',
          runner_type: body['runner_type'] as Setup['runner_type'],
          runner_label: body['runner_label'] ?? '',
        };
        return json(202, { run_id: 1 });
      }
      if (u.pathname === `/repos/${ORG}/motir-ai`) return json(200, { private: isPrivate });
      return json(500, { message: `unexpected ${method} ${u.pathname}` });
    }),
  );
}

async function storePair(enabled: boolean): Promise<void> {
  await adminDb.platformFleetOrgCi.create({
    data: { projectId: fx.projectId, org: ORG, enabled, lastReason: 'seeded' },
  });
}

function catchUp(now?: number) {
  return service.afterRunnerRegistered({
    projectId: fx.projectId,
    owner: 'Acme-Connected',
    repo: 'motir-ai',
    target: TARGET,
    ...(now === undefined ? {} : { now }),
  });
}

beforeEach(async () => {
  await truncateAuthTables();
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  _resetInstallationTokenCache();
  _resetSeenOnFleet();
  setup = { state: 'configured', runner_type: 'standard', runner_label: '' };
  isPrivate = true;
  patchAnswer = null;
  calls = [];
  installGitHub();
  fx = await makeWorkItemFixture({ name: 'Motir', identifier: 'MOTIR' });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('fleetCodeScanningCatchUpService.afterRunnerRegistered', () => {
  it('moves a configured default setup onto the fleet label when the pair is ON', async () => {
    await storePair(true);
    expect(await catchUp()).toBe('moved');
    expect(setup).toEqual({
      state: 'configured',
      runner_type: 'labeled',
      runner_label: MOTIR_RUNNER_LABEL,
    });
  });

  it('leaves GitHub untouched when the pair is OFF or was never stored', async () => {
    expect(await catchUp()).toBe('pair_off');
    await storePair(false);
    expect(await catchUp()).toBe('pair_off');
    expect(calls).toEqual([]);
  });

  it('does nothing for the provisioning org, which has no pair', async () => {
    await storePair(true);
    const outcome = await service.afterRunnerRegistered({
      projectId: fx.projectId,
      owner: ORG,
      repo: 'motir-ai',
      target: undefined,
    });
    expect(outcome).toBe('no_target');
    expect(calls).toEqual([]);
  });

  it('never writes a public repository or one whose default setup is not configured', async () => {
    await storePair(true);
    isPrivate = false;
    expect(await catchUp()).toBe('not_private');
    isPrivate = true;
    setup = { state: 'not-configured', runner_type: 'standard', runner_label: '' };
    expect(await catchUp()).toBe('not_configured');
    expect(calls.some((c) => c.startsWith('PATCH'))).toBe(false);
  });

  it('reads a repository already on the fleet once per recheck window', async () => {
    await storePair(true);
    setup = { state: 'configured', runner_type: 'labeled', runner_label: MOTIR_RUNNER_LABEL };
    const t0 = 1_000_000;
    expect(await catchUp(t0)).toBe('already_on_fleet');
    calls = [];
    expect(await catchUp(t0 + ON_FLEET_RECHECK_MS - 1)).toBe('recently_on_fleet');
    expect(calls).toEqual([]);
    expect(await catchUp(t0 + ON_FLEET_RECHECK_MS)).toBe('already_on_fleet');
  });

  it('answers still_no_runner when GitHub does not count the runner yet, and tries again next boot', async () => {
    await storePair(true);
    patchAnswer = { status: 422, message: NO_RUNNER_WITH_LABEL };
    expect(await catchUp()).toBe('still_no_runner');
    patchAnswer = null;
    expect(await catchUp()).toBe('moved');
  });

  it('logs and swallows any other failure, never throwing into the boot', async () => {
    await storePair(true);
    patchAnswer = { status: 403, message: 'Resource not accessible by integration' };
    expect(await catchUp()).toBe('failed');
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(
      expect.stringContaining('could not move a deferred CodeQL default setup'),
      expect.objectContaining({ org: ORG, repo: 'motir-ai' }),
    );
  });
});
