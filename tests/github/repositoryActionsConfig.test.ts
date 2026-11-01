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
  RepositoryActionsConfigError,
  repositoryActionsConfigClient,
  type RepositoryCoordinates,
} from '@/lib/github/repositoryActionsConfig';
import {
  createRepositoryActionsConfigFake,
  type RepositoryActionsConfigFake,
} from '../helpers/repositoryActionsConfigFake';

// The REPOSITORY Actions-configuration client (MOTIR-5775) on the wire: the secret
// is sealed to the repository's public key before it leaves, so the plaintext is
// in no request; variables are read-then-written; every "already gone" is an
// answer, not a failure; and no error carries a value or a body.

const REPO: RepositoryCoordinates = {
  installationId: '556677',
  owner: 'motir-projects',
  repo: 'acme-web',
};
const FULL = 'motir-projects/acme-web';
const TOKEN = 'FlyV1 fm2_plaintext-deploy-token';

let github: RepositoryActionsConfigFake;
let transportDown: boolean;

beforeEach(() => {
  github = createRepositoryActionsConfigFake();
  transportDown = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (transportDown) throw new Error('ECONNRESET');
      const raw = typeof init?.body === 'string' ? init.body : null;
      const res = await github.handle(String(url), init?.method ?? 'GET', raw);
      if (!res) throw new Error(`unexpected fetch ${url}`);
      return res;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(mintInstallationToken).mockClear();
});

describe('putSecret', () => {
  it('seals the value to the repository public key; the plaintext is in no request', async () => {
    expect(
      await repositoryActionsConfigClient.putSecret(REPO, 'MOTIR_FLY_PREVIEW_PUSH_TOKEN', TOKEN),
    ).toBe('created');
    expect(github.secrets(FULL).get('MOTIR_FLY_PREVIEW_PUSH_TOKEN')).toBe(TOKEN);
    expect(
      github.calls.map((c) => [c.method, c.url.replace('https://api.github.com', '')]),
    ).toEqual([
      ['GET', '/repos/motir-projects/acme-web/actions/secrets/public-key'],
      ['PUT', '/repos/motir-projects/acme-web/actions/secrets/MOTIR_FLY_PREVIEW_PUSH_TOKEN'],
    ]);
    for (const call of github.calls) expect(call.rawBody ?? '').not.toContain(TOKEN);
    expect(mintInstallationToken).toHaveBeenCalledWith('556677', 'provisioning');
    // A re-write is an update.
    expect(
      await repositoryActionsConfigClient.putSecret(REPO, 'MOTIR_FLY_PREVIEW_PUSH_TOKEN', 'next'),
    ).toBe('updated');
  });

  it('refuses a public key it cannot use, and a refused write, with no value in the error', async () => {
    github.failNext('GET', '/secrets/public-key', 403);
    const keyRefused = await repositoryActionsConfigClient
      .putSecret(REPO, 'S', TOKEN)
      .catch((e: unknown) => e);
    expect(keyRefused).toBeInstanceOf(RepositoryActionsConfigError);
    expect(keyRefused).toMatchObject({ status: 403 });

    github.failNext('PUT', '/secrets/S', 422);
    const writeRefused = await repositoryActionsConfigClient
      .putSecret(REPO, 'S', TOKEN)
      .catch((e: unknown) => e);
    expect(writeRefused).toMatchObject({ status: 422 });
    for (const error of [keyRefused, writeRefused]) {
      expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(TOKEN);
    }
  });

  it('refuses a public-key answer with no key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ key_id: 'k' }), { status: 200 })),
    );
    await expect(repositoryActionsConfigClient.putSecret(REPO, 'S', TOKEN)).rejects.toThrow(
      /public key response had no key/,
    );
  });
});

describe('deleteSecret', () => {
  it('deletes a secret, and answers absent for one already gone', async () => {
    await repositoryActionsConfigClient.putSecret(REPO, 'S', TOKEN);
    expect(await repositoryActionsConfigClient.deleteSecret(REPO, 'S')).toBe('deleted');
    expect(await repositoryActionsConfigClient.deleteSecret(REPO, 'S')).toBe('absent');
    github.failNext('DELETE', '/secrets/S', 403);
    await expect(repositoryActionsConfigClient.deleteSecret(REPO, 'S')).rejects.toMatchObject({
      code: 'REPOSITORY_ACTIONS_CONFIG_FAILED',
      status: 403,
    });
  });
});

describe('ensureVariable and deleteVariable', () => {
  it('creates, leaves unchanged, then corrects a drifted value', async () => {
    expect(await repositoryActionsConfigClient.ensureVariable(REPO, 'V', 'fly')).toBe('created');
    expect(await repositoryActionsConfigClient.ensureVariable(REPO, 'V', 'fly')).toBe('unchanged');
    expect(await repositoryActionsConfigClient.ensureVariable(REPO, 'V', 'aws')).toBe('updated');
    expect(github.variables(FULL).get('V')).toBe('aws');
  });

  it('falls through to the PATCH when a concurrent create won the race', async () => {
    github.failNext('GET', '/variables/V', 404);
    github.variables(FULL).set('V', 'old');
    expect(await repositoryActionsConfigClient.ensureVariable(REPO, 'V', 'new')).toBe('updated');
    expect(github.variables(FULL).get('V')).toBe('new');
  });

  it('throws on a refused read, create or patch', async () => {
    github.failNext('GET', '/variables/V', 500);
    await expect(
      repositoryActionsConfigClient.ensureVariable(REPO, 'V', 'x'),
    ).rejects.toMatchObject({
      status: 500,
    });
    github.failNext('POST', '/actions/variables', 403);
    await expect(
      repositoryActionsConfigClient.ensureVariable(REPO, 'V', 'x'),
    ).rejects.toMatchObject({
      status: 403,
    });
    github.variables(FULL).set('V', 'old');
    github.failNext('PATCH', '/variables/V', 403);
    await expect(
      repositoryActionsConfigClient.ensureVariable(REPO, 'V', 'x'),
    ).rejects.toMatchObject({
      status: 403,
    });
  });

  it('deletes a variable, answers absent for one gone, and throws on a refusal', async () => {
    github.variables(FULL).set('V', 'x');
    expect(await repositoryActionsConfigClient.deleteVariable(REPO, 'V')).toBe('deleted');
    expect(await repositoryActionsConfigClient.deleteVariable(REPO, 'V')).toBe('absent');
    github.failNext('DELETE', '/variables/V', 500);
    await expect(repositoryActionsConfigClient.deleteVariable(REPO, 'V')).rejects.toBeInstanceOf(
      RepositoryActionsConfigError,
    );
  });
});

describe('transport and credential failures', () => {
  it('names an unreachable GitHub and an unwired App as the typed error, with no status', async () => {
    transportDown = true;
    await expect(repositoryActionsConfigClient.deleteVariable(REPO, 'V')).rejects.toMatchObject({
      status: null,
      message: expect.stringContaining('ECONNRESET'),
    });
    transportDown = false;
    await expect(
      repositoryActionsConfigClient.deleteSecret({ ...REPO, installationId: 'unwired' }, 'S'),
    ).rejects.toMatchObject({ status: null, message: expect.stringContaining('not configured') });
  });

  it('reads a refusal with no JSON body as an empty detail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>', { status: 502 })),
    );
    await expect(repositoryActionsConfigClient.deleteSecret(REPO, 'S')).rejects.toThrow(
      'GitHub refused a repository Actions call (HTTP 502).',
    );
  });
});
