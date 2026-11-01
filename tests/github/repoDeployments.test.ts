// MOTIR-10038 — the GitHub deployment primitives a release status is posted
// through (MOTIR-10033), at the `fetch` boundary. The status suite drives them
// end to end; this one owns the shapes it never meets: a deployment created
// without a description, a 201 that carries no id, and a string id.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RepoProvisioningApiError } from '@/lib/github/repoProvisioning';
import { repoDeployments } from '@/lib/github/repoDeployments';

const ACCESS = { owner: 'motir-projects', repo: 'shop', token: 'ghs_test' };
const SHA = 'a'.repeat(40);

let sent: Array<Record<string, unknown>>;

function answer(status: number, body: unknown): void {
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(body === undefined ? null : JSON.stringify(body), { status });
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('createDeployment', () => {
  it('sends an empty description when none is given, and accepts a string id', async () => {
    answer(201, { id: '77' });

    expect(
      await repoDeployments.createDeployment(ACCESS, { ref: SHA, environment: 'production' }),
    ).toBe('77');
    expect(sent[0]).toMatchObject({ ref: SHA, description: '', production_environment: true });
  });

  it('refuses a 201 that names no deployment', async () => {
    answer(201, { ref: SHA });

    const error = await repoDeployments
      .createDeployment(ACCESS, { ref: SHA, environment: 'production', description: 'x' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RepoProvisioningApiError);
    expect(error).toMatchObject({ status: 201 });
    expect((error as Error).message).toContain('deployment created without an id');
  });

  it('refuses a 202 merged-first answer as not created', async () => {
    answer(202, { message: 'Auto-merged main into the ref' });

    await expect(
      repoDeployments.createDeployment(ACCESS, { ref: SHA, environment: 'production' }),
    ).rejects.toMatchObject({ status: 202 });
  });
});
