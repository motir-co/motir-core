import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import {
  CodeScanningDefaultSetupApiError,
  codeScanningDefaultSetupClient as client,
  isNoRunnerWithLabelRefusal,
  runnerRequests,
} from '@/lib/github/codeScanningDefaultSetup';
import type { GithubOrgTarget } from '@/lib/github/orgTarget';

// The CodeQL default-setup leaf (MOTIR-10289). GitHub is a fake at `fetch`; the
// App JWT and the installation-token mint are the real ones.

const TARGET: GithubOrgTarget = { org: 'acme-ci', installationId: '4401', role: 'provisioning' };
const PATH = '/repos/acme-ci/motir-ai/code-scanning/default-setup';

interface Seen {
  method: string;
  path: string;
  body: unknown;
  auth: string | null;
}

let answer: (method: string) => Response | Promise<Response>;
let seen: Seen[];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  _resetInstallationTokenCache();
  seen = [];
  answer = () => json(500, { message: 'unset' });
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (
        url: string,
        init?: { method?: string; body?: string; headers?: Record<string, string> },
      ) => {
        const u = new URL(String(url));
        if (u.pathname.endsWith('/access_tokens')) {
          return json(201, {
            token: 'ghs_default_setup',
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          });
        }
        const method = init?.method ?? 'GET';
        seen.push({
          method,
          path: u.pathname,
          body: init?.body ? JSON.parse(init.body) : null,
          auth: init?.headers?.['authorization'] ?? null,
        });
        return answer(method);
      },
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('get', () => {
  it.each([
    [
      'labeled with a label',
      { state: 'configured', runner_type: 'labeled', runner_label: 'motir-runner' },
      { state: 'configured', runner: { type: 'labeled', label: 'motir-runner' } },
    ],
    [
      'standard',
      { state: 'configured', runner_type: 'standard', runner_label: '' },
      { state: 'configured', runner: { type: 'standard' } },
    ],
    [
      'labeled with an empty label',
      { state: 'configured', runner_type: 'labeled', runner_label: '' },
      { state: 'configured', runner: { type: 'standard' } },
    ],
    [
      'a null runner type',
      { state: 'configured', runner_type: null, runner_label: null },
      { state: 'configured', runner: { type: 'standard' } },
    ],
    [
      'not configured',
      { state: 'not-configured', runner_type: 'standard' },
      { state: 'not-configured' },
    ],
  ])('reads %s', async (_l, body, expected) => {
    answer = () => json(200, body);
    expect(await client.get('acme-ci', 'motir-ai', TARGET)).toEqual(expected);
    expect(seen).toEqual([
      { method: 'GET', path: PATH, body: null, auth: 'Bearer ghs_default_setup' },
    ]);
  });

  it('a repository without code scanning (GitHub’s Advanced Security 403) is unavailable', async () => {
    answer = () => json(403, { message: 'Advanced Security must be enabled for this repository.' });
    expect(await client.get('acme-ci', 'motir-ai', TARGET)).toEqual({ state: 'unavailable' });
  });

  it('a 403 for a missing App permission throws, carrying the status', async () => {
    answer = () => json(403, { message: 'Resource not accessible by integration' });
    const err = await client.get('acme-ci', 'motir-ai', TARGET).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodeScanningDefaultSetupApiError);
    expect(err).toMatchObject({ status: 403 });
    expect((err as Error).message).toContain('Resource not accessible by integration');
  });

  it('a refusal with no JSON body throws with no detail', async () => {
    answer = () => new Response('<html>', { status: 503 });
    const err = await client.get('acme-ci', 'motir-ai', TARGET).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 503 });
    expect((err as Error).message).toBe('GitHub refused a CodeQL default-setup call (HTTP 503).');
  });

  it.each([
    ['an unknown state', { state: 'pending' }],
    ['an array', []],
  ])('a 200 with %s throws rather than guessing', async (_l, body) => {
    answer = () => json(200, body);
    await expect(client.get('acme-ci', 'motir-ai', TARGET)).rejects.toMatchObject({
      status: 200,
    });
  });

  it('a transport failure throws with a null status', async () => {
    answer = () => {
      throw new TypeError('fetch failed');
    };
    const err = await client.get('acme-ci', 'motir-ai', TARGET).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: null });
    expect((err as Error).message).toContain('could not be reached');
  });

  it('a transport failure that is not an Error is still a typed failure', async () => {
    answer = () => Promise.reject('down');
    await expect(client.get('acme-ci', 'motir-ai', TARGET)).rejects.toMatchObject({
      status: null,
      message: expect.stringContaining('(unknown)'),
    });
  });
});

describe('setRunner', () => {
  it.each([
    [
      { type: 'labeled', label: 'motir-runner' } as const,
      { runner_type: 'labeled', runner_label: 'motir-runner' },
      200,
    ],
    [{ type: 'standard' } as const, { runner_type: 'standard' }, 202],
  ])('writes ONLY the runner — %o', async (runner, body, status) => {
    answer = () => json(status, status === 202 ? { run_id: 7, run_url: 'x' } : {});
    await client.setRunner('acme-ci', 'motir-ai', runner, TARGET);
    expect(seen).toEqual([{ method: 'PATCH', path: PATH, body, auth: 'Bearer ghs_default_setup' }]);
  });

  it('a refusal throws with its status and detail', async () => {
    answer = () => json(422, { message: 'not in the required state' });
    const err = await client
      .setRunner('acme-ci', 'motir-ai', { type: 'standard' }, TARGET)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodeScanningDefaultSetupApiError);
    expect(err).toMatchObject({ status: 422, code: 'CODE_SCANNING_DEFAULT_SETUP_API_FAILED' });
    expect((err as Error).message).toContain('not in the required state');
  });
});

describe('runnerRequests', () => {
  it('is true only for the label asked about', () => {
    expect(runnerRequests({ type: 'labeled', label: 'motir-runner' }, 'motir-runner')).toBe(true);
    expect(runnerRequests({ type: 'labeled', label: 'big-box' }, 'motir-runner')).toBe(false);
    expect(runnerRequests({ type: 'standard' }, 'motir-runner')).toBe(false);
  });
});

describe('isNoRunnerWithLabelRefusal', () => {
  it("is GitHub's 422 for a label no runner carries, and nothing else", async () => {
    answer = () =>
      json(422, {
        message:
          'Code scanning default setup can only be enabled if a runner with the specified label is assigned to this repository.',
      });
    const err = await client
      .setRunner('acme-ci', 'motir-ai', { type: 'labeled', label: 'motir-runner' }, TARGET)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodeScanningDefaultSetupApiError);
    expect((err as CodeScanningDefaultSetupApiError).detail).toContain('specified label');
    expect(isNoRunnerWithLabelRefusal(err)).toBe(true);

    expect(
      isNoRunnerWithLabelRefusal(new CodeScanningDefaultSetupApiError(422, 'Validation Failed')),
    ).toBe(false);
    expect(
      isNoRunnerWithLabelRefusal(
        new CodeScanningDefaultSetupApiError(403, 'a runner with the specified label'),
      ),
    ).toBe(false);
    expect(isNoRunnerWithLabelRefusal(new Error('a runner with the specified label'))).toBe(false);
  });
});
