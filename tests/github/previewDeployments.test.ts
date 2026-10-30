import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/github/appAuth', () => ({
  mintInstallationToken: vi.fn(async (installationId: string) => {
    if (installationId === 'unwired')
      throw new Error('GitHub App (provisioning) is not configured.');
    return { token: 'ghs_provisioning' };
  }),
}));

import { mintInstallationToken } from '@/lib/github/appAuth';
import {
  PreviewDeploymentsError,
  previewDeploymentsClient,
  previewEnvironmentName,
} from '@/lib/github/previewDeployments';

// The GitHub deployments boundary of a preview (MOTIR-5776) on the wire.

const REPO = { installationId: '556677', owner: 'motir-projects', repo: 'acme-web' };
const BASE = 'https://api.github.com/repos/motir-projects/acme-web';

let calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }>;
let respond: (url: string) => Response;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  calls = [];
  respond = () => json(201, { id: 41 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });
      return respond(String(url));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(mintInstallationToken).mockClear();
});

describe('createDeployment', () => {
  it('creates a transient preview deployment on the head, through the provisioning App', async () => {
    expect(
      await previewDeploymentsClient.createDeployment(REPO, { sha: 'abc', pullRequestNumber: 7 }),
    ).toBe('41');
    expect(calls).toEqual([
      {
        url: `${BASE}/deployments`,
        method: 'POST',
        body: {
          ref: 'abc',
          environment: 'preview/pr-7',
          transient_environment: true,
          production_environment: false,
          auto_merge: false,
          required_contexts: [],
          description: 'Preview of pull request #7',
        },
      },
    ]);
    expect(mintInstallationToken).toHaveBeenCalledWith('556677', 'provisioning');
    expect(previewEnvironmentName(12)).toBe('preview/pr-12');
  });

  it('refuses an answer with no id', async () => {
    respond = () => json(201, {});
    await expect(
      previewDeploymentsClient.createDeployment(REPO, { sha: 'abc', pullRequestNumber: 7 }),
    ).rejects.toThrow(/had no id/);
  });

  it('names a refusal by status and message, and a body that is not JSON as empty', async () => {
    respond = () => json(409, { message: 'Conflict: merge' });
    await expect(
      previewDeploymentsClient.createDeployment(REPO, { sha: 'abc', pullRequestNumber: 7 }),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining('Conflict: merge') });
    respond = () => new Response('<html>', { status: 502 });
    await expect(
      previewDeploymentsClient.createDeployment(REPO, { sha: 'abc', pullRequestNumber: 7 }),
    ).rejects.toThrow('GitHub refused a preview deployment call (HTTP 502).');
    respond = () => json(500, ['not', 'an', 'object']);
    await expect(
      previewDeploymentsClient.createDeployment(REPO, { sha: 'abc', pullRequestNumber: 7 }),
    ).rejects.toMatchObject({ status: 500 });
  });

  it('names an unreachable GitHub and an unwired App with no status', async () => {
    await expect(
      previewDeploymentsClient.createDeployment(
        { ...REPO, installationId: 'unwired' },
        { sha: 'abc', pullRequestNumber: 7 },
      ),
    ).rejects.toMatchObject({ status: null, message: expect.stringContaining('not configured') });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    );
    const error = await previewDeploymentsClient
      .createDeployment(REPO, { sha: 'abc', pullRequestNumber: 7 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PreviewDeploymentsError);
    expect(error).toMatchObject({ status: null, message: expect.stringContaining('ECONNRESET') });
  });
});

describe('postStatus', () => {
  it('posts success with its URL and auto_inactive, and any other state without', async () => {
    await previewDeploymentsClient.postStatus(REPO, '41', {
      state: 'success',
      environmentUrl: 'https://pr-7--acme-web.preview.motir.site',
      description: 'ready',
    });
    await previewDeploymentsClient.postStatus(REPO, '41', {
      state: 'failure',
      description: 'x'.repeat(200),
    });
    expect(calls.map((c) => [c.url, c.body])).toEqual([
      [
        `${BASE}/deployments/41/statuses`,
        {
          state: 'success',
          description: 'ready',
          environment_url: 'https://pr-7--acme-web.preview.motir.site',
          auto_inactive: true,
        },
      ],
      [
        `${BASE}/deployments/41/statuses`,
        { state: 'failure', description: 'x'.repeat(140), auto_inactive: false },
      ],
    ]);
  });
});

describe('isPullRequestOpen', () => {
  it('reads open, closed and gone', async () => {
    respond = () => json(200, { state: 'open' });
    expect(await previewDeploymentsClient.isPullRequestOpen(REPO, 7)).toBe(true);
    expect(calls[0]).toMatchObject({ url: `${BASE}/pulls/7`, method: 'GET' });
    respond = () => json(200, { state: 'closed' });
    expect(await previewDeploymentsClient.isPullRequestOpen(REPO, 7)).toBe(false);
    respond = () => json(404, { message: 'Not Found' });
    expect(await previewDeploymentsClient.isPullRequestOpen(REPO, 7)).toBe(false);
    respond = () => new Response('<html>', { status: 200 });
    expect(await previewDeploymentsClient.isPullRequestOpen(REPO, 7)).toBe(false);
  });

  it('throws on a refusal and on an unreachable GitHub', async () => {
    respond = () => json(500, {});
    await expect(previewDeploymentsClient.isPullRequestOpen(REPO, 7)).rejects.toMatchObject({
      status: 500,
    });
    await expect(
      previewDeploymentsClient.isPullRequestOpen({ ...REPO, installationId: 'unwired' }, 7),
    ).rejects.toMatchObject({ status: null });
  });
});
