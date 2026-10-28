import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getGitProvider } from '@/lib/git';
import { parseGithubDirectoryListing, REPO_DIRECTORY_MAX_ENTRIES } from '@/lib/git/fileRead';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { renderReadFile } from '@/lib/mcp/tools/readFile';
import { gitlabConnectionService } from '@/lib/services/gitlabConnectionService';

// A DIRECTORY read on the `readFileAtRef` seam (MOTIR-9868).
//
// GitHub answers a directory path with its own JSON listing whatever media type
// was asked for, and that listing used to reach the planner as `found` TEXT — an
// undocumented shape owned by the host. GitLab's files endpoint answers a
// directory with 404, so the same path was `not_found` there. Both now answer a
// named `directory` with the immediate entries, and a session learns the same
// fact about a repository wherever it is hosted.

const github = getGitProvider('github');
const gitlab = getGitProvider('gitlab');

function tokenResponse(): Response {
  return new Response(
    JSON.stringify({
      token: 'ghs_read',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function stubFetch(reply: (url: string) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (url: string): Promise<Response> => {
    const u = String(url);
    if (u.includes('/access_tokens')) return tokenResponse();
    return reply(u);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** One element of GitHub's contents listing, as the endpoint shapes it. */
function githubItem(dir: string, name: string, type: string) {
  return {
    name,
    path: `${dir}/${name}`,
    sha: 'a'.repeat(40),
    size: 10,
    type,
    url: `https://api.github.com/repos/moooon/acme/contents/${dir}/${name}?ref=main`,
    _links: { self: 'x', git: 'y', html: 'z' },
  };
}

describe('github.readFileAtRef on a directory', () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  beforeEach(() => {
    _resetInstallationTokenCache();
    vi.stubEnv('GITHUB_APP_ID', '999');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('lists the immediate entries, sorted, never the raw listing JSON', async () => {
    const listing = [
      githubItem('.github/workflows', 'release-runner-image.yml', 'file'),
      githubItem('.github/workflows', 'ci.yml', 'file'),
      githubItem('.github/workflows', 'shared', 'dir'),
    ];
    stubFetch(
      () =>
        new Response(JSON.stringify(listing), {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        }),
    );
    expect(
      await github.readFileAtRef('inst-1', 'moooon', 'acme', '.github/workflows/', 'main'),
    ).toEqual({
      outcome: 'directory',
      path: '.github/workflows',
      ref: 'main',
      entries: [
        { name: 'ci.yml', type: 'file' },
        { name: 'release-runner-image.yml', type: 'file' },
        { name: 'shared', type: 'dir' },
      ],
      truncated: false,
    });
  });

  it('a committed JSON file that is an array stays `found` text', async () => {
    const text = JSON.stringify([{ name: 'a', path: 'elsewhere/a', type: 'file', sha: 'x' }]);
    stubFetch(() => new Response(text, { status: 200 }));
    expect(
      await github.readFileAtRef('inst-1', 'moooon', 'acme', 'fixtures/list.json', 'main'),
    ).toMatchObject({ outcome: 'found', text });
  });

  it('a listing at the host cap says it was cut', async () => {
    const items = Array.from({ length: REPO_DIRECTORY_MAX_ENTRIES }, (_, i) =>
      githubItem('big', `f${String(i).padStart(4, '0')}.txt`, 'file'),
    );
    stubFetch(() => new Response(JSON.stringify(items), { status: 200 }));
    const result = await github.readFileAtRef('inst-1', 'moooon', 'acme', 'big', 'main');
    expect(result).toMatchObject({ outcome: 'directory', truncated: true });
    expect(
      parseGithubDirectoryListing(new TextEncoder().encode(JSON.stringify(items)), 'big'),
    ).toHaveLength(REPO_DIRECTORY_MAX_ENTRIES);
  });
});

describe('gitlab.readFileAtRef on a directory', () => {
  beforeEach(() => {
    vi.spyOn(gitlabConnectionService, 'getAccessToken').mockResolvedValue({
      token: 'glpat_read',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('asks the tree when the files endpoint says 404, and lists what it holds', async () => {
    const fetchMock = stubFetch((url) =>
      url.includes('/repository/tree')
        ? new Response(
            JSON.stringify([
              {
                id: '1',
                name: 'Dockerfile',
                type: 'blob',
                path: 'infra/Dockerfile',
                mode: '100644',
              },
              { id: '2', name: 'packer', type: 'tree', path: 'infra/packer', mode: '040000' },
              { id: '3', name: 'current', type: 'blob', path: 'infra/current', mode: '120000' },
              { id: '4', name: 'vendor', type: 'commit', path: 'infra/vendor', mode: '160000' },
            ]),
            { status: 200 },
          )
        : new Response(JSON.stringify({ message: '404 File Not Found' }), { status: 404 }),
    );
    expect(await gitlab.readFileAtRef('conn-1', 'acme', 'web', 'infra', 'main')).toEqual({
      outcome: 'directory',
      path: 'infra',
      ref: 'main',
      entries: [
        { name: 'Dockerfile', type: 'file' },
        { name: 'current', type: 'symlink' },
        { name: 'packer', type: 'dir' },
        { name: 'vendor', type: 'submodule' },
      ],
      truncated: false,
    });
    const tree = fetchMock.mock.calls.map(([u]) => String(u)).find((u) => u.includes('/tree'));
    expect(tree).toContain('path=infra&ref=main');
  });

  it('a path that is neither a file nor a directory stays `not_found`', async () => {
    stubFetch((url) =>
      url.includes('/repository/tree')
        ? new Response('[]', { status: 200 })
        : new Response(JSON.stringify({ message: '404 File Not Found' }), { status: 404 }),
    );
    expect(await gitlab.readFileAtRef('conn-1', 'acme', 'web', 'nope', 'main')).toEqual({
      outcome: 'not_found',
      path: 'nope',
      ref: 'main',
    });
  });

  it('a missing ref is still `ref_not_found`, and asks no tree', async () => {
    const fetchMock = stubFetch(
      () => new Response(JSON.stringify({ message: '404 Reference Not Found' }), { status: 404 }),
    );
    expect(await gitlab.readFileAtRef('conn-1', 'acme', 'web', 'infra', 'nope')).toMatchObject({
      outcome: 'ref_not_found',
    });
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/tree'))).toBe(false);
  });

  it('pages the tree and says when the listing was cut at the shared cap', async () => {
    let page = 0;
    stubFetch((url) => {
      if (!url.includes('/repository/tree')) {
        return new Response(JSON.stringify({ message: '404 File Not Found' }), { status: 404 });
      }
      page += 1;
      const items = Array.from({ length: 100 }, (_, i) => ({
        name: `f${page}-${i}`,
        type: 'blob',
        mode: '100644',
      }));
      return new Response(JSON.stringify(items), {
        status: 200,
        headers: { 'x-next-page': String(page + 1) },
      });
    });
    const result = await gitlab.readFileAtRef('conn-1', 'acme', 'web', 'big', 'main');
    expect(result).toMatchObject({ outcome: 'directory', truncated: true });
    expect(result.outcome === 'directory' && result.entries.length).toBe(
      REPO_DIRECTORY_MAX_ENTRIES,
    );
  });
});

describe('the MCP read_file renders a directory as a listing', () => {
  it('names the outcome, marks subdirectories, and says when the list was cut', () => {
    const result = {
      outcome: 'directory' as const,
      repoRef: 'acme/web',
      path: 'infra',
      ref: 'main',
      entries: [
        { name: 'Dockerfile', type: 'file' as const },
        { name: 'packer', type: 'dir' as const },
      ],
      truncated: false,
    };
    const { summary, structured } = renderReadFile(result);
    expect(summary).toContain('"infra" in acme/web at main is a DIRECTORY');
    expect(summary).toContain('Dockerfile (file)\npacker/');
    expect(summary).not.toContain('TRUNCATED');
    expect(structured).toMatchObject({ outcome: 'directory', entries: result.entries });
    expect(renderReadFile({ ...result, truncated: true }).summary).toContain('TRUNCATED');
  });
});
