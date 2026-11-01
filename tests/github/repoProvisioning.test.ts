import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RepoNameTakenOnHostError,
  RepoNotReadyError,
  RepoProvisioningApiError,
  RepoProvisioningNotConfiguredError,
  SeedTemplateUnavailableError,
  _resetProvisioningInstallationCache,
  _setReadinessPollForTests,
  isRepoProvisioningConfigured,
  repoProvisioningClient,
} from '@/lib/github/repoProvisioning';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import {
  SEED_SOURCE_INITIALISED,
  SEED_SOURCE_PLATFORM_STARTER,
} from '@/lib/projectRepos/vocabulary';

// The repo-CREATION boundary (Story MOTIR-1775 · MOTIR-1781), faked at `fetch` —
// the shipped convention for these suites, and the level at which the card's
// requirement "the fake asserts the exact request bodies — account, name,
// template source, visibility" is actually checkable. A fake of the client module
// would assert only that we called ourselves.
//
// What is pinned here is every GitHub mechanic the spike
// (`docs/github-repo-creation-mechanics.md`) settled, so a later refactor cannot
// quietly re-derive one:
//
//   * WHICH endpoint each role uses, and with which credential — the ORG create
//     (never `POST /user/repos`, which is user-token-only) and the template
//     `generate`, both under the PROVISIONING App's installation token.
//   * `201` is not readiness (§4.2): a repo with no `default_branch` is polled,
//     and a window that closes is an honest typed failure.
//   * The 422 collision is detected on STATUS + a case-insensitive `already
//     exists` anywhere in the body's message strings — NOT on the `errors`
//     element shape, which differs between the two endpoints (§4.3 finding 2).
//     BOTH shapes are exercised, which is what caught the spike's own wording
//     being too narrow: only `/generate` puts the phrase in `message`.
//   * No raw GitHub body escapes: every failure is one of the typed errors.

const MOTIR_ORG = 'motir-projects';
const INSTALLATION_ID = '556677';

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  auth: string;
}

let calls: Call[];

/** Every handler a scenario needs, tried in order; the first match answers. */
type Handler = (call: Call) => Response | null;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The two calls EVERY scenario makes before it can create anything: resolve the
 *  provisioning installation (App JWT) and mint its token. */
function baseHandlers(): Handler[] {
  return [
    (c) =>
      c.url.endsWith(`/orgs/${MOTIR_ORG}/installation`)
        ? json(200, { id: Number(INSTALLATION_ID), account: { login: MOTIR_ORG } })
        : null,
    (c) =>
      c.url.includes('/access_tokens')
        ? json(200, {
            token: 'ghs_provisioning',
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          })
        : null,
  ];
}

function installFetch(handlers: Handler[]): void {
  // The scenario's own handlers win, so a test can override the base ones (e.g.
  // make the token mint fail) without restating the whole fake.
  const all = [...handlers, ...baseHandlers()];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const call: Call = {
        url: String(url),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
        auth: String((init?.headers as Record<string, string>)?.['authorization'] ?? ''),
      };
      calls.push(call);
      for (const handler of all) {
        const res = handler(call);
        if (res) return res;
      }
      throw new Error(`unexpected fetch: ${call.method} ${call.url}`);
    }),
  );
}

/** A repository read that reports the repo as READY (a non-empty default branch). */
function readyRepo(name: string, id = 4242): Handler {
  return (c) =>
    c.method === 'GET' && c.url.endsWith(`/repos/${MOTIR_ORG}/${name}`)
      ? json(200, { id, name, owner: { login: MOTIR_ORG }, default_branch: 'main' })
      : null;
}

function configureApp(): void {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
}

/** The generate endpoint's 422 collision body (STRING `errors` — §4.3). */
const generateCollision = {
  message: 'Could not clone: Name already exists on this account',
  errors: ['Could not clone: Name already exists on this account'],
  status: '422',
};

// Seeds as the registry resolves them (MOTIR-708): the client never reads a key.
const STARTER_SEED = {
  key: SEED_SOURCE_PLATFORM_STARTER,
  source: { owner: 'motir-co', repo: 'nextjs-prisma-serverless-starter' },
};
const INITIALISED_SEED = { key: SEED_SOURCE_INITIALISED, source: 'initialised' as const };

const webRow = {
  name: 'acme-web',
  role: 'web' as const,
  seed: STARTER_SEED,
  projectName: 'Acme',
};
const apiRow = {
  name: 'acme-api',
  role: 'api' as const,
  seed: INITIALISED_SEED,
  projectName: 'Acme',
};

beforeEach(() => {
  calls = [];
  configureApp();
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
  // No real sleeps: the poll's TIMING is not what these tests are about, its
  // BEHAVIOUR is. Attempts stay > 1 so the retry path is genuinely exercised.
  _setReadinessPollForTests({ attempts: 3, delayMs: 0 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  _setReadinessPollForTests(null);
});

describe('configuration is a first-class state, not a crash', () => {
  it('reports unconfigured when the org or the Studio App is missing', () => {
    expect(isRepoProvisioningConfigured()).toBe(true);
    vi.stubEnv('GITHUB_STUDIO_APP_ID', '');
    expect(isRepoProvisioningConfigured()).toBe(false);
    vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
    vi.stubEnv('GITHUB_FALLBACK_ORG', '');
    expect(isRepoProvisioningConfigured()).toBe(false);
  });

  it('throws the typed not-configured error with NO provisioning org', async () => {
    vi.stubEnv('GITHUB_FALLBACK_ORG', '');
    installFetch([]);
    await expect(repoProvisioningClient.provisionRepository(webRow)).rejects.toBeInstanceOf(
      RepoProvisioningNotConfiguredError,
    );
    // It never even asked GitHub — the flow is unreachable, not failing.
    expect(calls).toHaveLength(0);
  });

  it('throws the typed not-configured error with NO Studio App key', async () => {
    vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', '');
    installFetch([]);
    await expect(repoProvisioningClient.provisionRepository(webRow)).rejects.toBeInstanceOf(
      RepoProvisioningNotConfiguredError,
    );
    expect(calls).toHaveLength(0);
  });
});

describe('a `web` row is seeded from the platform starter', () => {
  it('calls the TEMPLATE endpoint with the exact body, as the provisioning App', async () => {
    installFetch([
      (c) =>
        c.method === 'POST' && c.url.includes('/generate')
          ? json(201, { id: 4242, name: webRow.name, owner: { login: MOTIR_ORG } })
          : null,
      readyRepo(webRow.name),
      (c) =>
        c.method === 'GET' && c.url.endsWith(`/repos/${MOTIR_ORG}/${webRow.name}/branches/main`)
          ? json(200, { commit: { sha: 'template-head' } })
          : null,
    ]);

    const repo = await repoProvisioningClient.provisionRepository(webRow);

    expect(repo).toEqual({
      installationId: INSTALLATION_ID,
      providerRepoId: '4242',
      owner: MOTIR_ORG,
      name: webRow.name,
      defaultBranch: 'main',
      adopted: false,
      // The head the template left, recorded so its first index waits (MOTIR-4589).
      seedHeadSha: 'template-head',
    });

    const generate = calls.find((c) => c.url.includes('/generate'))!;
    // The TEMPLATE SOURCE is in the path, the new repo in the body (§4.4) — which
    // is what lets one starter seed every row.
    // Read from the ENTRY's source, never spliced from the key (MOTIR-706 3.1).
    expect(generate.url).toBe(
      'https://api.github.com/repos/motir-co/nextjs-prisma-serverless-starter/generate',
    );
    expect(generate.body).toMatchObject({
      owner: MOTIR_ORG, // the ACCOUNT — always Motir's org, never the user's
      name: webRow.name,
      private: true, // VISIBILITY
      include_all_branches: false,
    });
    // The installation token, not an App JWT and not a user token.
    expect(generate.auth).toBe('Bearer ghs_provisioning');
    // `POST /user/repos` is user-token-only and therefore never reachable here.
    expect(calls.some((c) => c.url.endsWith('/user/repos'))).toBe(false);
  });

  it('resolves the provisioning installation ONCE and reuses it', async () => {
    installFetch([
      (c) =>
        c.method === 'POST' && c.url.includes('/generate')
          ? json(201, { id: 1, name: webRow.name, owner: { login: MOTIR_ORG } })
          : null,
      readyRepo(webRow.name, 1),
      (c) =>
        c.method === 'POST' && c.url.endsWith(`/orgs/${MOTIR_ORG}/repos`)
          ? json(201, { id: 2, name: apiRow.name, owner: { login: MOTIR_ORG } })
          : null,
      readyRepo(apiRow.name, 2),
      (c) => (c.method === 'PUT' ? json(201, { content: {} }) : null),
    ]);

    await repoProvisioningClient.provisionRepository(webRow);
    await repoProvisioningClient.provisionRepository(apiRow);

    expect(calls.filter((c) => c.url.endsWith('/installation'))).toHaveLength(1);
  });
});

describe('a non-web row is HONESTLY initialised, not seeded from the web starter', () => {
  it('creates in the org with auto_init + licence + gitignore, then commits the CI stub', async () => {
    installFetch([
      (c) =>
        c.method === 'POST' && c.url.endsWith(`/orgs/${MOTIR_ORG}/repos`)
          ? json(201, { id: 77, name: apiRow.name, owner: { login: MOTIR_ORG } })
          : null,
      readyRepo(apiRow.name, 77),
      (c) => (c.method === 'PUT' ? json(201, { content: {} }) : null),
    ]);

    const repo = await repoProvisioningClient.provisionRepository(apiRow);
    expect(repo).toMatchObject({ providerRepoId: '77', name: apiRow.name, adopted: false });

    const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/repos'))!;
    expect(create.url).toBe(`https://api.github.com/orgs/${MOTIR_ORG}/repos`);
    expect(create.body).toMatchObject({
      name: apiRow.name,
      private: true,
      auto_init: true,
      license_template: 'mit',
      gitignore_template: 'Node',
    });
    // ADR §2 — the README GitHub writes from `auto_init` names the PROJECT and the
    // ROW'S ROLE, which is the whole point of the description being derived.
    expect(String(create.body!['description'])).toContain('api');
    expect(String(create.body!['description'])).toContain('Acme');
    // It is NOT the starter: no template call at all for a non-web row.
    expect(calls.some((c) => c.url.includes('/generate'))).toBe(false);

    // The CI stub is the one thing `auto_init` cannot give it.
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.url).toBe(
      `https://api.github.com/repos/${MOTIR_ORG}/${apiRow.name}/contents/.github/workflows/ci.yml`,
    );
    const stub = Buffer.from(String(put.body!['content']), 'base64').toString('utf8');
    expect(stub).toContain('name: CI');
    expect(stub).toContain('actions/checkout');
    expect(put.body).toMatchObject({ branch: 'main' });
  });

  it('still returns the repository when the CI stub fails — a stub is not the artifact', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    installFetch([
      (c) =>
        c.method === 'POST' && c.url.endsWith(`/orgs/${MOTIR_ORG}/repos`)
          ? json(201, { id: 77, name: apiRow.name, owner: { login: MOTIR_ORG } })
          : null,
      readyRepo(apiRow.name, 77),
      (c) => (c.method === 'PUT' ? json(500, { message: 'nope' }) : null),
    ]);

    await expect(repoProvisioningClient.provisionRepository(apiRow)).resolves.toMatchObject({
      providerRepoId: '77',
    });
    expect(logged).toHaveBeenCalled();
  });

  it('never reads the KEY: an initialised seed under any key takes the auto_init path', async () => {
    installFetch([
      (c) =>
        c.method === 'POST' && c.url.endsWith(`/orgs/${MOTIR_ORG}/repos`)
          ? json(201, { id: 9, name: 'acme-ml', owner: { login: MOTIR_ORG } })
          : null,
      readyRepo('acme-ml', 9),
      (c) => (c.method === 'PUT' ? json(201, {}) : null),
    ]);

    await expect(
      repoProvisioningClient.provisionRepository({
        name: 'acme-ml',
        role: 'other',
        seed: { key: 'some-future-key', source: 'initialised' },
        projectName: 'Acme',
      }),
    ).resolves.toMatchObject({ name: 'acme-ml' });
    expect(calls.some((c) => c.url.includes('/generate'))).toBe(false);
  });
});

describe('a template seed is generated from THAT entry’s own repository (MOTIR-708)', () => {
  const flySeed = {
    key: 'nextjs-prisma-fly-starter',
    source: { owner: 'motir-co', repo: 'nextjs-prisma-fly-starter' },
  };

  it('posts /generate to the entry’s owner/repo with the same body', async () => {
    installFetch([
      (c) =>
        c.method === 'POST' && c.url.includes('/generate')
          ? json(201, { id: 77, name: 'acme', owner: { login: MOTIR_ORG } })
          : null,
      readyRepo('acme', 77),
    ]);
    await repoProvisioningClient.provisionRepository({ ...webRow, name: 'acme', seed: flySeed });
    const generate = calls.find((c) => c.url.includes('/generate'))!;
    expect(generate.url).toBe(
      'https://api.github.com/repos/motir-co/nextjs-prisma-fly-starter/generate',
    );
    expect(generate.body).toMatchObject({ owner: MOTIR_ORG, name: 'acme', private: true });
    // A template ships its own CI: no stub is committed.
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it.each([
    ['gone (404)', 404, { message: 'Not Found' }],
    [
      'not a template (422)',
      422,
      { message: 'motir-co/nextjs-prisma-fly-starter is not a template repository' },
    ],
  ])('fails naming the entry when the template is %s', async (_label, status, body) => {
    installFetch([
      (c) => (c.method === 'POST' && c.url.includes('/generate') ? json(status, body) : null),
    ]);
    const err = await repoProvisioningClient
      .provisionRepository({ ...webRow, name: 'acme', seed: flySeed })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SeedTemplateUnavailableError);
    expect(err).toMatchObject({
      code: 'SEED_TEMPLATE_UNAVAILABLE',
      seedKey: 'nextjs-prisma-fly-starter',
      template: 'motir-co/nextjs-prisma-fly-starter',
      status,
    });
    expect((err as SeedTemplateUnavailableError).reason).toContain('nextjs-prisma-fly-starter');
    // Nothing is created from a guessed default instead.
    expect(calls.some((c) => c.url.endsWith(`/orgs/${MOTIR_ORG}/repos`))).toBe(false);
  });

  it('keeps any OTHER 422 on the template endpoint the generic API error', async () => {
    installFetch([
      (c) =>
        c.method === 'POST' && c.url.includes('/generate')
          ? json(422, { message: 'Repository name is reserved' })
          : null,
    ]);
    await expect(
      repoProvisioningClient.provisionRepository({ ...webRow, name: 'acme', seed: flySeed }),
    ).rejects.toBeInstanceOf(RepoProvisioningApiError);
  });

  it('keeps a 404 on the INITIALISED path the generic API error — there is no template', async () => {
    installFetch([
      (c) =>
        c.method === 'POST' && c.url.endsWith(`/orgs/${MOTIR_ORG}/repos`)
          ? json(404, { message: 'Not Found' })
          : null,
    ]);
    await expect(repoProvisioningClient.provisionRepository(apiRow)).rejects.toBeInstanceOf(
      RepoProvisioningApiError,
    );
  });
});

describe('`201` is not readiness (spike §4.2)', () => {
  it('polls until GitHub reports a default branch', async () => {
    let reads = 0;
    installFetch([
      (c) =>
        c.method === 'POST' && c.url.includes('/generate')
          ? json(201, { id: 5, name: webRow.name, owner: { login: MOTIR_ORG } })
          : null,
      (c) => {
        if (c.method !== 'GET' || !c.url.endsWith(`/repos/${MOTIR_ORG}/${webRow.name}`))
          return null;
        reads += 1;
        // The documented shape: the repo record exists, its tree does not yet.
        return json(200, {
          id: 5,
          name: webRow.name,
          owner: { login: MOTIR_ORG },
          default_branch: reads < 2 ? '' : 'main',
        });
      },
    ]);

    await expect(repoProvisioningClient.provisionRepository(webRow)).resolves.toMatchObject({
      defaultBranch: 'main',
    });
    expect(reads).toBe(2);
  });

  it('fails the row honestly when the window closes', async () => {
    installFetch([
      (c) =>
        c.method === 'POST' && c.url.includes('/generate')
          ? json(201, { id: 5, name: webRow.name, owner: { login: MOTIR_ORG } })
          : null,
      (c) =>
        c.method === 'GET' && c.url.endsWith(`/repos/${MOTIR_ORG}/${webRow.name}`)
          ? json(200, { id: 5, name: webRow.name, owner: { login: MOTIR_ORG }, default_branch: '' })
          : null,
    ]);

    await expect(repoProvisioningClient.provisionRepository(webRow)).rejects.toBeInstanceOf(
      RepoNotReadyError,
    );
  });
});

describe('the 422 collision — matched on STATUS + message, never on the `errors` shape', () => {
  // §4.3 finding 2: `/orgs/{org}/repos` returns `errors` as OBJECTS while
  // `/generate` returns plain STRINGS. Both must read identically here.
  const orgShape = {
    message: 'Repository creation failed.',
    errors: [
      { resource: 'Repository', field: 'name', message: 'name already exists on this account' },
    ],
    status: '422',
  };
  const generateShape = {
    message: 'Could not clone: Name already exists on this account',
    errors: ['Could not clone: Name already exists on this account'],
    status: '422',
  };

  it('ADOPTS the existing repo on the template endpoint’s STRING-array shape', async () => {
    installFetch([
      (c) => (c.method === 'POST' && c.url.includes('/generate') ? json(422, generateShape) : null),
      readyRepo(webRow.name, 31337),
    ]);

    const repo = await repoProvisioningClient.provisionRepository(webRow);
    // Adopted, NOT renamed and NOT created twice — the resume path after a crash
    // between create and attach.
    expect(repo).toMatchObject({ providerRepoId: '31337', name: webRow.name, adopted: true });
    expect(calls.filter((c) => c.url.includes('/generate'))).toHaveLength(1);
  });

  it('ADOPTS on the org endpoint’s OBJECT-array shape too', async () => {
    installFetch([
      (c) =>
        c.method === 'POST' && c.url.endsWith(`/orgs/${MOTIR_ORG}/repos`)
          ? json(422, orgShape)
          : null,
      readyRepo(apiRow.name, 8080),
    ]);

    await expect(repoProvisioningClient.provisionRepository(apiRow)).resolves.toMatchObject({
      providerRepoId: '8080',
      adopted: true,
    });
    // An ADOPTED repo is not re-seeded: it already has whatever it has.
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('reports NAME TAKEN when the colliding repo cannot even be read', async () => {
    installFetch([
      (c) => (c.method === 'POST' && c.url.includes('/generate') ? json(422, generateShape) : null),
      (c) =>
        c.method === 'GET' && c.url.endsWith(`/repos/${MOTIR_ORG}/${webRow.name}`)
          ? json(404, { message: 'Not Found' })
          : null,
    ]);

    await expect(repoProvisioningClient.provisionRepository(webRow)).rejects.toBeInstanceOf(
      RepoNameTakenOnHostError,
    );
  });

  it('does NOT treat a 422 with no message and no errors as a collision', async () => {
    installFetch([
      (c) => (c.method === 'POST' && c.url.includes('/generate') ? json(422, {}) : null),
    ]);

    // Nothing to match the phrase in, so it is not a collision — the row fails
    // rather than adopting a repository nobody said exists.
    await expect(repoProvisioningClient.provisionRepository(webRow)).rejects.toBeInstanceOf(
      RepoProvisioningApiError,
    );
  });

  it('does NOT treat a non-collision 422 as a collision', async () => {
    installFetch([
      (c) =>
        c.method === 'POST' && c.url.includes('/generate')
          ? json(422, { message: 'Repository creation failed.', errors: [{ field: 'name' }] })
          : null,
    ]);

    const err = await repoProvisioningClient
      .provisionRepository(webRow)
      .catch((e: unknown) => e as RepoProvisioningApiError);
    expect(err).toBeInstanceOf(RepoProvisioningApiError);
    expect((err as RepoProvisioningApiError).status).toBe(422);
  });
});

describe('no raw GitHub payload escapes', () => {
  it('turns an org-policy refusal into the typed API error carrying only the status', async () => {
    installFetch([
      (c) =>
        c.method === 'POST' && c.url.endsWith(`/orgs/${MOTIR_ORG}/repos`)
          ? json(403, { message: 'Organization has disabled repository creation', foo: 'secret' })
          : null,
    ]);

    const err = await repoProvisioningClient
      .provisionRepository(apiRow)
      .catch((e: unknown) => e as RepoProvisioningApiError);
    expect(err).toBeInstanceOf(RepoProvisioningApiError);
    expect((err as RepoProvisioningApiError).status).toBe(403);
    expect((err as RepoProvisioningApiError).reason).not.toContain('secret');
  });

  it('turns a transport failure into the typed API error with a null status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    );

    const err = await repoProvisioningClient
      .provisionRepository(apiRow)
      .catch((e: unknown) => e as RepoProvisioningApiError);
    expect(err).toBeInstanceOf(RepoProvisioningApiError);
    expect((err as RepoProvisioningApiError).status).toBeNull();
  });

  it('surfaces a failed installation lookup as the typed API error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(404, { message: 'Not Found' })),
    );

    await expect(repoProvisioningClient.provisionRepository(apiRow)).rejects.toBeInstanceOf(
      RepoProvisioningApiError,
    );
  });

  it('rejects an installation lookup that returns no id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(200, { account: { login: MOTIR_ORG } })),
    );

    await expect(repoProvisioningClient.provisionRepository(apiRow)).rejects.toBeInstanceOf(
      RepoProvisioningApiError,
    );
  });

  it('survives a non-JSON error body — the STATUS is what it branches on', async () => {
    installFetch([
      (c) =>
        c.method === 'POST' && c.url.endsWith(`/orgs/${MOTIR_ORG}/repos`)
          ? new Response('<html>502 Bad Gateway</html>', { status: 502 })
          : null,
    ]);

    const err = await repoProvisioningClient
      .provisionRepository(apiRow)
      .catch((e: unknown) => e as RepoProvisioningApiError);
    expect(err).toBeInstanceOf(RepoProvisioningApiError);
    expect((err as RepoProvisioningApiError).status).toBe(502);
    // No detail to quote, so none is invented — and no HTML reaches the row.
    expect((err as RepoProvisioningApiError).reason).not.toContain('html');
  });

  it('surfaces a failed readiness READ (not a 404) as the typed API error', async () => {
    installFetch([
      (c) =>
        c.method === 'POST' && c.url.includes('/generate')
          ? json(201, { id: 5, name: webRow.name, owner: { login: MOTIR_ORG } })
          : null,
      (c) =>
        c.method === 'GET' && c.url.endsWith(`/repos/${MOTIR_ORG}/${webRow.name}`)
          ? json(500, { message: 'upstream' })
          : null,
    ]);

    await expect(repoProvisioningClient.provisionRepository(webRow)).rejects.toBeInstanceOf(
      RepoProvisioningApiError,
    );
  });

  it('normalizes a NON-Error throw from the transport', async () => {
    // JS lets anything be thrown; a `reason` reading "unknown" is still a typed,
    // renderable failure rather than a crash inside the error path itself.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw 'a string, not an Error';
      }),
    );

    const err = await repoProvisioningClient
      .provisionRepository(apiRow)
      .catch((e: unknown) => e as RepoProvisioningApiError);
    expect(err).toBeInstanceOf(RepoProvisioningApiError);
    expect((err as RepoProvisioningApiError).reason).toContain('unknown');
  });

  it('reports a token-mint failure as the typed API error, with the id already resolved', async () => {
    let mints = 0;
    installFetch([
      (c) => {
        if (!c.url.includes('/access_tokens')) return null;
        mints += 1;
        return json(401, { message: 'Bad credentials' });
      },
    ]);

    await expect(repoProvisioningClient.provisionRepository(apiRow)).rejects.toBeInstanceOf(
      RepoProvisioningApiError,
    );
    expect(mints).toBe(1);
  });

  it('reports the Studio App going UNCONFIGURED after the installation id is cached', async () => {
    // The operational case: the process resolved the installation, then the key
    // was rotated out from under it. The mint's own not-configured error must not
    // escape as `appAuth`'s — it is this module's typed one.
    installFetch([
      (c) =>
        c.method === 'POST' && c.url.endsWith(`/orgs/${MOTIR_ORG}/repos`)
          ? json(201, { id: 1, name: apiRow.name, owner: { login: MOTIR_ORG } })
          : null,
      readyRepo(apiRow.name, 1),
      (c) => (c.method === 'PUT' ? json(201, {}) : null),
    ]);
    await repoProvisioningClient.provisionRepository(apiRow);

    vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', '');
    _resetInstallationTokenCache(); // force a re-mint; the installation id stays cached
    await expect(
      repoProvisioningClient.provisionRepository({ ...apiRow, name: 'acme-two' }),
    ).rejects.toBeInstanceOf(RepoProvisioningNotConfiguredError);
  });

  it('waits between readiness attempts when a delay is configured', async () => {
    // The default poll has a real delay; this proves the wait is wired without
    // making the suite sit through the production one.
    _setReadinessPollForTests({ attempts: 3 });
    _setReadinessPollForTests({ delayMs: 5 });
    let reads = 0;
    installFetch([
      (c) =>
        c.method === 'POST' && c.url.includes('/generate')
          ? json(201, { id: 6, name: webRow.name, owner: { login: MOTIR_ORG } })
          : null,
      (c) => {
        if (c.method !== 'GET' || !c.url.endsWith(`/repos/${MOTIR_ORG}/${webRow.name}`))
          return null;
        reads += 1;
        return json(200, {
          id: 6,
          name: webRow.name,
          owner: { login: MOTIR_ORG },
          default_branch: reads < 2 ? '' : 'main',
        });
      },
    ]);

    const started = Date.now();
    await expect(repoProvisioningClient.provisionRepository(webRow)).resolves.toMatchObject({
      defaultBranch: 'main',
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(4);
  });

  it('tolerates a repository read that omits owner and default_branch', async () => {
    installFetch([
      (c) =>
        c.method === 'POST' && c.url.includes('/generate') ? json(422, generateCollision) : null,
      (c) =>
        c.method === 'GET' && c.url.endsWith(`/repos/${MOTIR_ORG}/${webRow.name}`)
          ? json(200, { id: 9, name: webRow.name })
          : null,
    ]);

    // An adopted repo is returned as-is: the owner falls back to the org we asked,
    // and an absent `default_branch` is empty rather than undefined. (Readiness is
    // not re-polled for an adopted repo — it already exists.)
    await expect(repoProvisioningClient.provisionRepository(webRow)).resolves.toEqual({
      installationId: INSTALLATION_ID,
      providerRepoId: '9',
      owner: MOTIR_ORG,
      name: webRow.name,
      defaultBranch: '',
      adopted: true,
      // An adopted repo's seed is not Motir's to vouch for (MOTIR-4589).
      seedHeadSha: null,
    });
  });

  it('logs, but does not fail, when the CI-stub commit throws', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    installFetch([
      (c) =>
        c.method === 'POST' && c.url.endsWith(`/orgs/${MOTIR_ORG}/repos`)
          ? json(201, { id: 12, name: apiRow.name, owner: { login: MOTIR_ORG } })
          : null,
      readyRepo(apiRow.name, 12),
      (c) => {
        if (c.method !== 'PUT') return null;
        throw new Error('socket hang up');
      },
    ]);

    await expect(repoProvisioningClient.provisionRepository(apiRow)).resolves.toMatchObject({
      providerRepoId: '12',
    });
    expect(logged).toHaveBeenCalled();
  });

  it('rejects a repository read carrying an id but no name', async () => {
    installFetch([
      (c) =>
        c.method === 'POST' && c.url.includes('/generate')
          ? json(201, { id: 5, name: webRow.name })
          : null,
      (c) => (c.method === 'GET' ? json(200, { id: 5, default_branch: 'main' }) : null),
    ]);

    // Half a repository is not a repository: without a NAME there is no checkout
    // coordinate to record, so this fails rather than mirroring a nameless row.
    await expect(repoProvisioningClient.provisionRepository(webRow)).rejects.toBeInstanceOf(
      RepoProvisioningApiError,
    );
  });

  it('rejects a repository read whose shape it cannot use', async () => {
    installFetch([
      (c) =>
        c.method === 'POST' && c.url.includes('/generate')
          ? json(201, { id: 5, name: webRow.name })
          : null,
      (c) => (c.method === 'GET' ? json(200, { default_branch: 'main' }) : null),
    ]);

    await expect(repoProvisioningClient.provisionRepository(webRow)).rejects.toBeInstanceOf(
      RepoProvisioningApiError,
    );
  });
});
