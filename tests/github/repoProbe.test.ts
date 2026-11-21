import { afterEach, describe, expect, it, vi } from 'vitest';

// `repoDeletionClient.probeRepo` — the read the hosted delete's confirm makes
// before it says what it would delete (MOTIR-11981; design repository-set §19.4).
// It never guesses: only a 200 is present and only a 404 is absent.

const { mintInstallationToken, githubFetch } = vi.hoisted(() => ({
  mintInstallationToken: vi.fn(),
  githubFetch: vi.fn(),
}));
vi.mock('@/lib/github/appAuth', () => ({ mintInstallationToken }));
vi.mock('@/lib/github/githubFetch', () => ({ githubFetch }));

const { repoDeletionClient, RepoDeletionError } = await import('@/lib/github/repoDeletion');

const input = { installationId: '556677', owner: 'motir-projects', repo: 'acme shop' };

afterEach(() => vi.resetAllMocks());

describe('repoDeletionClient.probeRepo', () => {
  it('GETs the repository with the provisioning installation token', async () => {
    mintInstallationToken.mockResolvedValue({ token: 'tok' });
    githubFetch.mockResolvedValue(new Response('{}', { status: 200 }));
    expect(await repoDeletionClient.probeRepo(input)).toBe('present');
    expect(mintInstallationToken).toHaveBeenCalledWith('556677', 'provisioning');
    const [, url, init] = githubFetch.mock.calls[0]!;
    expect(url).toBe('https://api.github.com/repos/motir-projects/acme%20shop');
    expect(init).toMatchObject({ method: 'GET', headers: { authorization: 'Bearer tok' } });
  });

  it('reads a 404 as absent', async () => {
    mintInstallationToken.mockResolvedValue({ token: 'tok' });
    githubFetch.mockResolvedValue(new Response('{}', { status: 404 }));
    expect(await repoDeletionClient.probeRepo(input)).toBe('absent');
  });

  it('throws on any other answer, carrying GitHub’s message', async () => {
    mintInstallationToken.mockResolvedValue({ token: 'tok' });
    githubFetch.mockResolvedValue(
      new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 }),
    );
    const err = await repoDeletionClient.probeRepo(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepoDeletionError);
    expect(err).toMatchObject({ status: 401 });
    expect((err as Error).message).toContain('Bad credentials');
  });

  it('throws when the token cannot be minted or the request cannot be made', async () => {
    mintInstallationToken.mockRejectedValueOnce(new Error('no key'));
    await expect(repoDeletionClient.probeRepo(input)).rejects.toBeInstanceOf(RepoDeletionError);

    mintInstallationToken.mockResolvedValue({ token: 'tok' });
    githubFetch.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(repoDeletionClient.probeRepo(input)).rejects.toMatchObject({ status: null });
  });
});
