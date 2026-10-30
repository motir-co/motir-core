// MOTIR-10038 — the repository Actions primitives production enablement writes
// through (MOTIR-10027), each step's refusal and each convergence branch, with
// GitHub stubbed at the `fetch` boundary `provisioningTransport` calls. The
// enablement suite drives the happy paths; this one owns the refusals: every
// non-2xx answer is a typed `RepoProvisioningApiError` carrying its status, and
// none carries the secret value.
import sodium from 'libsodium-wrappers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RepoProvisioningApiError } from '@/lib/github/repoProvisioning';
import { repoActionsConfig, sealForGithub } from '@/lib/github/repoActionsConfig';

const ACCESS = { owner: 'motir-projects', repo: 'shop', token: 'ghs_test' };
const REPO = 'https://api.github.com/repos/motir-projects/shop';
const ENV = `${REPO}/environments/production`;
const POLICIES = `${ENV}/deployment-branch-policies`;
const VARIABLES = `${REPO}/actions/variables`;
const SECRET = 'fly-token-value';

let publicKey = '';
let privateKey: Uint8Array;
let calls: Array<{ method: string; url: string; body: string | null }>;

type Reply = [number, unknown?];

/** Answer each `METHOD url` from the table; anything unlisted is a test error. */
function stub(table: Record<string, Reply>): void {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? init.body : null;
      calls.push({ method, url, body });
      const reply = table[`${method} ${url}`];
      if (!reply) throw new Error(`unexpected fetch: ${method} ${url}`);
      const [status, json] = reply;
      return new Response(json === undefined ? null : JSON.stringify(json), { status });
    }),
  );
}

beforeAll(async () => {
  await sodium.ready;
  const pair = sodium.crypto_box_keypair();
  publicKey = sodium.to_base64(pair.publicKey, sodium.base64_variants.ORIGINAL);
  privateKey = pair.privateKey;
});

afterEach(() => vi.unstubAllGlobals());

async function refusal(promise: Promise<unknown>): Promise<RepoProvisioningApiError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(RepoProvisioningApiError);
  expect(String((error as Error).message)).not.toContain(SECRET);
  return error as RepoProvisioningApiError;
}

describe('sealForGithub', () => {
  it('seals a value only the key pair can open', async () => {
    const sealed = await sealForGithub(SECRET, publicKey);
    const opened = sodium.crypto_box_seal_open(
      sodium.from_base64(sealed, sodium.base64_variants.ORIGINAL),
      sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL),
      privateKey,
    );
    expect(sodium.to_string(opened)).toBe(SECRET);
  });
});

describe('ensureBranchOnlyEnvironment', () => {
  it('keeps the branch policy, deletes every other one, and creates nothing more', async () => {
    stub({
      [`PUT ${ENV}`]: [200, {}],
      [`GET ${POLICIES}?per_page=100`]: [
        200,
        {
          branch_policies: [
            { id: 1, name: 'main' },
            { id: 2, name: 'release/*', type: 'branch' },
            { id: 3, name: 'main', type: 'tag' },
          ],
        },
      ],
      [`DELETE ${POLICIES}/2`]: [204],
      [`DELETE ${POLICIES}/3`]: [404],
    });

    await repoActionsConfig.ensureBranchOnlyEnvironment(ACCESS, 'production', 'main');

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `PUT ${ENV}`,
      `GET ${POLICIES}?per_page=100`,
      `DELETE ${POLICIES}/2`,
      `DELETE ${POLICIES}/3`,
    ]);
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    });
  });

  it('creates the branch policy when the list has none, or is not a list', async () => {
    for (const listed of [{ branch_policies: [] }, { branch_policies: 'nope' }, null]) {
      stub({
        [`PUT ${ENV}`]: [200, {}],
        [`GET ${POLICIES}?per_page=100`]: [200, listed ?? undefined],
        [`POST ${POLICIES}`]: [201, { id: 9 }],
      });
      await repoActionsConfig.ensureBranchOnlyEnvironment(ACCESS, 'production', 'main');
      expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ name: 'main', type: 'branch' });
    }
  });

  it.each([
    ['the environment write', { [`PUT ${ENV}`]: [403, { message: 'Forbidden' }] as Reply }, 403],
    [
      'the policy list',
      {
        [`PUT ${ENV}`]: [200, {}] as Reply,
        [`GET ${POLICIES}?per_page=100`]: [500, { message: 'boom' }] as Reply,
      },
      500,
    ],
    [
      'a policy delete',
      {
        [`PUT ${ENV}`]: [200, {}] as Reply,
        [`GET ${POLICIES}?per_page=100`]: [
          200,
          { branch_policies: [{ id: 2, name: 'dev' }] },
        ] as Reply,
        [`DELETE ${POLICIES}/2`]: [422, { message: 'nope' }] as Reply,
      },
      422,
    ],
    [
      'the policy create',
      {
        [`PUT ${ENV}`]: [200, {}] as Reply,
        [`GET ${POLICIES}?per_page=100`]: [200, { branch_policies: [] }] as Reply,
        [`POST ${POLICIES}`]: [422, { message: 'exists' }] as Reply,
      },
      422,
    ],
  ])('refuses typed when %s fails', async (_label, table, status) => {
    stub(table);
    const error = await refusal(
      repoActionsConfig.ensureBranchOnlyEnvironment(ACCESS, 'production', 'main'),
    );
    expect(error.status).toBe(status);
  });
});

describe('putEnvironmentSecret', () => {
  const KEY_URL = `${ENV}/secrets/public-key`;

  it('seals the value with the environment key and never sends it in the clear', async () => {
    stub({
      [`GET ${KEY_URL}`]: [200, { key_id: 'k1', key: publicKey }],
      [`PUT ${ENV}/secrets/FLY_API_TOKEN`]: [201],
    });

    await repoActionsConfig.putEnvironmentSecret(ACCESS, 'production', 'FLY_API_TOKEN', SECRET);

    const put = JSON.parse(calls[1]!.body!) as { encrypted_value: string; key_id: string };
    expect(put.key_id).toBe('k1');
    expect(calls[1]!.body).not.toContain(SECRET);
  });

  it('refuses typed when the key read fails, returns no key, or the write fails', async () => {
    stub({ [`GET ${KEY_URL}`]: [404, { message: 'Not Found' }] });
    expect(
      (await refusal(repoActionsConfig.putEnvironmentSecret(ACCESS, 'production', 'X', SECRET)))
        .status,
    ).toBe(404);

    stub({ [`GET ${KEY_URL}`]: [200, { key_id: 7 }] });
    const noKey = await refusal(
      repoActionsConfig.putEnvironmentSecret(ACCESS, 'production', 'X', SECRET),
    );
    expect(noKey.message).toContain('public key read returned no key');

    stub({
      [`GET ${KEY_URL}`]: [200, { key_id: 'k1', key: publicKey }],
      [`PUT ${ENV}/secrets/X`]: [422, { message: 'bad' }],
    });
    expect(
      (await refusal(repoActionsConfig.putEnvironmentSecret(ACCESS, 'production', 'X', SECRET)))
        .status,
    ).toBe(422);
  });
});

describe('setRepositoryVariable', () => {
  const VAR = `${VARIABLES}/FLY_APP`;

  it('creates a missing variable, patches a different one, and leaves a right one alone', async () => {
    stub({ [`GET ${VAR}`]: [404], [`POST ${VARIABLES}`]: [201] });
    await repoActionsConfig.setRepositoryVariable(ACCESS, 'FLY_APP', 'mh-1');
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);

    stub({ [`GET ${VAR}`]: [200, { value: 'mh-0' }], [`PATCH ${VAR}`]: [204] });
    await repoActionsConfig.setRepositoryVariable(ACCESS, 'FLY_APP', 'mh-1');
    expect(JSON.parse(calls[1]!.body!)).toEqual({ name: 'FLY_APP', value: 'mh-1' });

    stub({ [`GET ${VAR}`]: [200, { value: 'mh-1' }] });
    await repoActionsConfig.setRepositoryVariable(ACCESS, 'FLY_APP', 'mh-1');
    expect(calls).toHaveLength(1);
  });

  it('refuses typed when the create, the read or the patch fails', async () => {
    stub({ [`GET ${VAR}`]: [404], [`POST ${VARIABLES}`]: [422, { message: 'bad' }] });
    expect(
      (await refusal(repoActionsConfig.setRepositoryVariable(ACCESS, 'FLY_APP', 'v'))).status,
    ).toBe(422);

    stub({ [`GET ${VAR}`]: [403, { message: 'Forbidden' }] });
    expect(
      (await refusal(repoActionsConfig.setRepositoryVariable(ACCESS, 'FLY_APP', 'v'))).status,
    ).toBe(403);

    stub({ [`GET ${VAR}`]: [200, { value: 'old' }], [`PATCH ${VAR}`]: [500, { message: 'x' }] });
    expect(
      (await refusal(repoActionsConfig.setRepositoryVariable(ACCESS, 'FLY_APP', 'v'))).status,
    ).toBe(500);
  });
});
