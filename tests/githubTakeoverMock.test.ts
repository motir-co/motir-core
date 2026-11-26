import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { E2E_MOCK_SEAMS } from '@/lib/test-mock-seams';
import {
  installGithubTakeoverMock,
  takeoverMockAccountId,
  type GithubTakeoverCall,
} from '@/lib/test-github-takeover-mock';
import { githubTakeoverSeamEnv } from './e2e/_helpers/job-worker-process';

// THE E2E GITHUB TAKEOVER SEAM (Story MOTIR-9800 · MOTIR-12140): every call a
// takeover makes, answered on an undici `MockAgent` with net connect DISABLED, so
// a call the seam does not claim fails here instead of reaching api.github.com;
// scoped to the provisioning org; journaled to the file both lane processes share.

const original = getGlobalDispatcher();
const dir = mkdtempSync(join(tmpdir(), 'github-takeover-mock-'));
const JOURNAL = join(dir, 'journal.jsonl');
const ORG = 'motir-projects-e2e';
const API = 'https://api.github.com';

function journal(): GithubTakeoverCall[] {
  if (!existsSync(JOURNAL)) return [];
  return readFileSync(JOURNAL, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as GithubTakeoverCall);
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('MOTIR_GITHUB_TAKEOVER_JOURNAL_PATH', JOURNAL);
  vi.stubEnv('GITHUB_FALLBACK_ORG', ORG);
  rmSync(JOURNAL, { force: true });
  const agent = new MockAgent();
  agent.disableNetConnect();
  installGithubTakeoverMock(agent);
  setGlobalDispatcher(agent);
});

afterAll(() => {
  setGlobalDispatcher(original);
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const call = (method: string, path: string, body?: object) =>
  fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

describe('the GitHub takeover seam', () => {
  it('reads an account id that is the same for the same login, case-insensitively', async () => {
    const res = await call('GET', '/users/Acme-Co');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { login: string; id: number };
    expect(body).toEqual({ login: 'Acme-Co', id: takeoverMockAccountId('acme-co'), type: 'User' });
    expect(Number.isInteger(body.id) && body.id > 0).toBe(true);
    expect(takeoverMockAccountId('other')).not.toBe(body.id);
  });

  it('answers the transfer 202 with the new owner, so it reads completed', async () => {
    const res = await call('POST', `/repos/${ORG}/shop/transfer`, { new_owner: 'acme-co' });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ owner: { login: 'acme-co' }, name: 'shop' });
  });

  it('accepts Actions re-enabled and every secret, variable and environment delete', async () => {
    const calls: Array<[string, string]> = [
      ['PUT', `/repos/${ORG}/shop/actions/permissions`],
      ['DELETE', `/repos/${ORG}/shop/actions/secrets/MOTIR_PREVIEW_TOKEN`],
      ['DELETE', `/repos/${ORG}/shop/actions/variables/MOTIR_PRODUCTION_IMAGE`],
      ['DELETE', `/repos/${ORG}/shop/environments/production`],
      ['DELETE', `/repos/${ORG}/shop/environments/production/secrets/MOTIR_DEPLOY_TOKEN`],
    ];
    for (const [method, path] of calls) {
      const res = await call(method, path, method === 'PUT' ? { enabled: true } : undefined);
      expect(res.status, `${method} ${path}`).toBe(204);
    }
    expect(journal().map((c) => `${c.method} ${c.path}`)).toEqual(
      calls.map(([m, p]) => `${m} ${p}`),
    );
    expect(journal()[0]!.body).toEqual({ enabled: true });
  });

  it('journals the transfer with its body', async () => {
    await call('POST', `/repos/${ORG}/api/transfer`, { new_owner: 'acme-co' });
    expect(journal()).toEqual([
      { method: 'POST', path: `/repos/${ORG}/api/transfer`, body: { new_owner: 'acme-co' } },
    ]);
  });

  it('claims nothing outside the provisioning org, and no other path', async () => {
    for (const [method, path] of [
      ['POST', '/repos/someone-else/shop/transfer'],
      ['PUT', '/repos/someone-else/shop/actions/permissions'],
      ['GET', `/repos/${ORG}/shop`],
      ['DELETE', `/repos/${ORG}/shop`],
      ['POST', `/repos/${ORG}/shop/actions/permissions`],
    ] as const) {
      await expect(call(method, path), `${method} ${path}`).rejects.toThrow();
    }
    expect(journal()).toEqual([]);
  });

  it('claims no repository at all when the lane names no provisioning org', async () => {
    vi.stubEnv('GITHUB_FALLBACK_ORG', '');
    await expect(call('POST', `/repos/${ORG}/shop/transfer`, { new_owner: 'x' })).rejects.toThrow();
  });
});

describe('its wiring', () => {
  it('is the first GitHub seam in the table, so no wider seam shadows it', () => {
    const github = E2E_MOCK_SEAMS.map((s) => s.flag).filter(
      (flag) => flag.includes('GITHUB') || flag === 'E2E_TEST_PRODUCTION_RELEASE',
    );
    expect(github[0]).toBe('E2E_TEST_GITHUB_TAKEOVER');
  });

  it('is mirrored into the worker only when the lane opts in', () => {
    vi.stubEnv('E2E_JOB_WORKER_GITHUB_TAKEOVER_SEAM', '');
    expect(githubTakeoverSeamEnv()).toEqual({});
    vi.stubEnv('E2E_JOB_WORKER_GITHUB_TAKEOVER_SEAM', '1');
    const env = githubTakeoverSeamEnv();
    expect(env['E2E_TEST_GITHUB_TAKEOVER']).toBe('1');
    expect(env['MOTIR_GITHUB_TAKEOVER_JOURNAL_PATH']).toBe(JOURNAL);
    expect(env['GITHUB_FALLBACK_ORG']).toBeTruthy();
  });

  it('is turned on in the acceptance lane, server and worker', () => {
    const config = readFileSync('playwright.acceptance.config.ts', 'utf8');
    expect(config).toMatch(/process\.env\['E2E_JOB_WORKER_GITHUB_TAKEOVER_SEAM'\] \?\?= '1'/);
    expect(config).toMatch(/E2E_TEST_GITHUB_TAKEOVER: '1'/);
  });
});
