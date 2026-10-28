import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DesignChoiceNotAppliedError,
  _resetProvisioningInstallationCache,
  _setReadinessPollForTests,
  repoProvisioningClient,
} from '@/lib/github/repoProvisioning';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import {
  DESIGN_MANIFEST_PATH,
  DESIGN_NOTES_PATH,
  designSeedFor,
} from '@/lib/projectRepos/designChoiceSeed';
import {
  SEED_SOURCE_INITIALISED,
  SEED_SOURCE_PLATFORM_STARTER,
} from '@/lib/projectRepos/vocabulary';
import { THEME_DEFAULTS, defaultTypeForStyle, resolveAxesToApplied } from '@motir/design-system';

// A SEEDED WEB REPO WEARS THE PROJECT'S STORED designChoice FROM ITS FIRST COMMIT
// (Story MOTIR-704 · MOTIR-1529), faked at `fetch` — the GitHub HTTP boundary, the
// convention `repoProvisioning.test.ts` set for this module.
//
// The fake is a small STATEFUL repository: generating it copies the template's
// files onto `main`, and the git data API (`git/trees`, `git/commits`,
// `git/refs`) really moves the branch. So "one commit", "no second commit" and
// "the branch carries the ids" are read off the repository's history, not off a
// list of calls that merely happened.

const MOTIR_ORG = 'motir-projects';
const INSTALLATION_ID = '556677';
const NAME = 'acme-web';

/** The manifest a design-system starter ships: the registry defaults. */
const STARTER_MANIFEST = `${JSON.stringify(
  { styleId: THEME_DEFAULTS.style, paletteId: THEME_DEFAULTS.palette, typeId: THEME_DEFAULTS.type },
  null,
  2,
)}\n`;

interface Commit {
  sha: string;
  parents: string[];
  files: Map<string, string>;
  message: string;
}

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

let calls: Call[];
/** The template's tree: what `/generate` copies onto the new repo's `main`. */
let templateFiles: Map<string, string>;
let commits: Map<string, Commit>;
let trees: Map<string, Map<string, string>>;
/** `main`'s head once the repository exists; null before it is generated. */
let head: string | null;
let seq: number;
/** Stage a GitHub that fails the ref update — and whether the move still lands. */
let refUpdate: { status: number; lands: boolean } | null;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function filesAt(sha: string): Map<string, string> {
  return commits.get(sha)!.files;
}

/** The commits on `main` that came after the template, oldest first. */
function commitsAfterSeed(): Commit[] {
  const out: Commit[] = [];
  let at = head;
  while (at) {
    const commit = commits.get(at)!;
    if (commit.parents.length === 0) break;
    out.unshift(commit);
    at = commit.parents[0]!;
  }
  return out;
}

function installGitHub(): void {
  const repo = `https://api.github.com/repos/${MOTIR_ORG}/${NAME}`;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      calls.push({ url: u, method, body });

      if (u.endsWith(`/orgs/${MOTIR_ORG}/installation`)) {
        return json(200, { id: Number(INSTALLATION_ID) });
      }
      if (u.includes('/access_tokens')) {
        return json(200, {
          token: 'ghs_provisioning',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      if (method === 'POST' && u.endsWith('/generate')) {
        if (head !== null) {
          return json(422, { message: 'Could not clone: Name already exists on this account' });
        }
        const sha = `c${seq++}`;
        commits.set(sha, { sha, parents: [], files: new Map(templateFiles), message: 'seed' });
        head = sha;
        return json(201, { id: 4242, name: NAME, owner: { login: MOTIR_ORG } });
      }
      if (method === 'POST' && u.endsWith(`/orgs/${MOTIR_ORG}/repos`)) {
        const sha = `c${seq++}`;
        commits.set(sha, { sha, parents: [], files: new Map([['README.md', '#']]), message: '' });
        head = sha;
        return json(201, { id: 77, name: String(body?.['name']), owner: { login: MOTIR_ORG } });
      }
      if (method === 'PUT' && u.includes('/contents/')) return json(201, { content: {} });
      if (head === null) return json(404, { message: 'Not Found' });

      const repoRead = new RegExp(`/repos/${MOTIR_ORG}/([^/]+)$`).exec(u);
      if (method === 'GET' && repoRead) {
        return json(200, {
          id: 4242,
          name: NAME,
          owner: { login: MOTIR_ORG },
          default_branch: 'main',
        });
      }
      if (method === 'GET' && u === `${repo}/branches/main`) {
        return json(200, { name: 'main', commit: { sha: head } });
      }
      const content = /\/contents\/([^?]+)\?ref=main$/.exec(u);
      if (method === 'GET' && content) {
        const text = filesAt(head).get(decodeURIComponent(content[1]!));
        return text === undefined
          ? json(404, { message: 'Not Found' })
          : json(200, {
              content: Buffer.from(text, 'utf8').toString('base64'),
              encoding: 'base64',
            });
      }
      if (method === 'GET' && u === `${repo}/git/ref/heads/main`) {
        return json(200, { ref: 'refs/heads/main', object: { sha: head, type: 'commit' } });
      }
      const commitRead = /\/git\/commits\/([^/]+)$/.exec(u);
      if (method === 'GET' && commitRead) {
        return json(200, { sha: commitRead[1], tree: { sha: `t-${commitRead[1]}` } });
      }
      if (method === 'POST' && u === `${repo}/git/trees`) {
        const base = String(body?.['base_tree']).replace(/^t-/, '');
        const files = new Map(filesAt(base));
        for (const entry of body?.['tree'] as { path: string; content: string }[]) {
          files.set(entry.path, entry.content);
        }
        const sha = `tree${seq++}`;
        trees.set(sha, files);
        return json(201, { sha });
      }
      if (method === 'POST' && u === `${repo}/git/commits`) {
        const sha = `c${seq++}`;
        commits.set(sha, {
          sha,
          parents: body?.['parents'] as string[],
          files: trees.get(String(body?.['tree']))!,
          message: String(body?.['message']),
        });
        return json(201, { sha });
      }
      if (method === 'PATCH' && u === `${repo}/git/refs/heads/main`) {
        const target = String(body?.['sha']);
        if (refUpdate) {
          if (refUpdate.lands) head = target;
          return json(refUpdate.status, { message: 'Server Error' });
        }
        // A fast-forward only: the new commit's parent must be the current head.
        if (commits.get(target)?.parents[0] !== head) {
          return json(422, { message: 'Update is not a fast forward' });
        }
        head = target;
        return json(200, { ref: 'refs/heads/main', object: { sha: target } });
      }
      throw new Error(`unexpected fetch: ${method} ${u}`);
    }),
  );
}

const STARTER_SEED = {
  key: SEED_SOURCE_PLATFORM_STARTER,
  source: { owner: 'motir-co', repo: 'nextjs-prisma-serverless-starter' },
};

const CHOICE = { styleId: 'neo-brutalism', paletteId: 'cobalt', typeId: 'grotesk' };

function webRow(design?: { choice: typeof CHOICE | null }) {
  return { name: NAME, role: 'web' as const, seed: STARTER_SEED, projectName: 'Acme', design };
}

beforeEach(() => {
  calls = [];
  templateFiles = new Map([
    ['package.json', '{}'],
    [DESIGN_MANIFEST_PATH, STARTER_MANIFEST],
  ]);
  commits = new Map();
  trees = new Map();
  head = null;
  seq = 1;
  refUpdate = null;
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
  _setReadinessPollForTests({ attempts: 2, delayMs: 0 });
  installGitHub();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  _setReadinessPollForTests(null);
});

describe('the stored choice, resolved through the package registries', () => {
  it('keeps every registered id', () => {
    const seed = designSeedFor(CHOICE);
    expect(seed.applied).toEqual(CHOICE);
    expect(seed.fallbacks).toEqual([]);
  });

  it('gives the registry defaults for no choice, and names every axis as a fallback', () => {
    const seed = designSeedFor(null);
    expect(seed.applied).toEqual({
      styleId: THEME_DEFAULTS.style,
      paletteId: THEME_DEFAULTS.palette,
      typeId: THEME_DEFAULTS.type,
    });
    expect(seed.fallbacks).toEqual(['styleId', 'paletteId', 'typeId']);
  });

  it('falls back per axis on an unknown id, and an unknown type follows the style', () => {
    const seed = designSeedFor({
      styleId: 'swiss-minimal-flat',
      paletteId: 'gone',
      typeId: 'gone',
    });
    expect(seed.applied).toEqual({
      styleId: 'swiss-minimal-flat',
      paletteId: THEME_DEFAULTS.palette,
      typeId: defaultTypeForStyle('swiss-minimal-flat'),
    });
    expect(seed.fallbacks).toEqual(['paletteId', 'typeId']);
  });

  it('agrees with the package’s own resolution — no table of its own', () => {
    const input = { styleId: 'aurora', paletteId: 'evergreen', typeId: 'nope' };
    const { pattern: _pattern, typePinned: _pinned, ...ids } = resolveAxesToApplied(input);
    expect(designSeedFor(input).applied).toEqual(ids);
  });
});

describe('a repository generated from a design-system starter', () => {
  it('carries the stored ids and a DESIGN.md naming them, in ONE commit before the seed head', async () => {
    const repo = await repoProvisioningClient.provisionRepository(webRow({ choice: CHOICE }));

    const added = commitsAfterSeed();
    expect(added).toHaveLength(1);
    const files = filesAt(head!);
    expect(JSON.parse(files.get(DESIGN_MANIFEST_PATH)!)).toEqual(CHOICE);
    const notes = files.get(DESIGN_NOTES_PATH)!;
    for (const id of Object.values(CHOICE)) expect(notes).toContain(`\`${id}\``);
    expect(notes).toMatch(/data-style[^]*data-palette[^]*data-type/);
    // The template's own files are kept: the commit is on top of its tree.
    expect(files.get('package.json')).toBe('{}');
    // The seed head the row records INCLUDES the design commit, so the first
    // index still waits for a push past the seed (MOTIR-4589).
    expect(repo).toMatchObject({ adopted: false, seedHeadSha: added[0]!.sha });
    // A fast-forward, never a forced ref move.
    const move = calls.find((c) => c.method === 'PATCH')!;
    expect(move.body).toMatchObject({ force: false });
  });

  it('carries the registry defaults when no choice is stored, and establish succeeds', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const repo = await repoProvisioningClient.provisionRepository(webRow({ choice: null }));

    expect(repo.adopted).toBe(false);
    expect(JSON.parse(filesAt(head!).get(DESIGN_MANIFEST_PATH)!)).toEqual({
      styleId: THEME_DEFAULTS.style,
      paletteId: THEME_DEFAULTS.palette,
      typeId: THEME_DEFAULTS.type,
    });
    expect(filesAt(head!).get(DESIGN_NOTES_PATH)).toContain(`\`${THEME_DEFAULTS.style}\``);
    // The fallback is LOGGED, never thrown.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('styleId, paletteId, typeId'),
      expect.anything(),
    );
  });

  it('carries the defaults for an unknown stored id, and still succeeds', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await repoProvisioningClient.provisionRepository(
      webRow({ choice: { ...CHOICE, paletteId: 'retired-palette' } }),
    );
    expect(JSON.parse(filesAt(head!).get(DESIGN_MANIFEST_PATH)!)).toEqual({
      ...CHOICE,
      paletteId: THEME_DEFAULTS.palette,
    });
  });
});

describe('a repository that does not wear the design system gets no extra commit', () => {
  it('a template without the manifest is left exactly as generated', async () => {
    templateFiles.delete(DESIGN_MANIFEST_PATH);
    await repoProvisioningClient.provisionRepository(webRow({ choice: CHOICE }));

    expect(commitsAfterSeed()).toHaveLength(0);
    expect(calls.some((c) => c.url.includes('/git/'))).toBe(false);
  });

  it('an initialised row is not even asked', async () => {
    await repoProvisioningClient.provisionRepository({
      name: 'acme-api',
      role: 'api',
      seed: { key: SEED_SOURCE_INITIALISED, source: 'initialised' },
      projectName: 'Acme',
      design: { choice: CHOICE },
    });

    expect(calls.some((c) => c.url.includes('/contents/motir.design.json'))).toBe(false);
    expect(calls.some((c) => c.url.includes('/git/'))).toBe(false);
  });

  it('a caller that passes no choice gets no design call at all', async () => {
    await repoProvisioningClient.provisionRepository(webRow());
    expect(commitsAfterSeed()).toHaveLength(0);
    expect(calls.some((c) => c.url.includes('/contents/'))).toBe(false);
  });
});

describe('a failed apply fails the row, and the retry commits at most once', () => {
  it('fails with a typed, renderable reason — the repository is kept', async () => {
    refUpdate = { status: 500, lands: false };
    const err = await repoProvisioningClient
      .provisionRepository(webRow({ choice: CHOICE }))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DesignChoiceNotAppliedError);
    expect(err).toMatchObject({ code: 'DESIGN_CHOICE_NOT_APPLIED', status: 500 });
    expect((err as DesignChoiceNotAppliedError).reason).toContain(NAME);
    expect(head).not.toBeNull();
    expect(commitsAfterSeed()).toHaveLength(0);
  });

  it('the retry adopts the repository and applies the choice once', async () => {
    refUpdate = { status: 500, lands: false };
    await expect(
      repoProvisioningClient.provisionRepository(webRow({ choice: CHOICE })),
    ).rejects.toBeInstanceOf(DesignChoiceNotAppliedError);

    refUpdate = null;
    const repo = await repoProvisioningClient.provisionRepository(webRow({ choice: CHOICE }));

    expect(repo.adopted).toBe(true);
    expect(commitsAfterSeed()).toHaveLength(1);
    expect(JSON.parse(filesAt(head!).get(DESIGN_MANIFEST_PATH)!)).toEqual(CHOICE);
  });

  it('a commit that landed before the failure is not made a second time', async () => {
    // GitHub moved the branch, then answered 502: the commit is there, the row
    // failed. The retry reads the files back and writes nothing.
    refUpdate = { status: 502, lands: true };
    await expect(
      repoProvisioningClient.provisionRepository(webRow({ choice: CHOICE })),
    ).rejects.toBeInstanceOf(DesignChoiceNotAppliedError);
    expect(commitsAfterSeed()).toHaveLength(1);

    refUpdate = null;
    const before = calls.length;
    const repo = await repoProvisioningClient.provisionRepository(webRow({ choice: CHOICE }));

    expect(repo.adopted).toBe(true);
    expect(commitsAfterSeed()).toHaveLength(1);
    expect(calls.slice(before).some((c) => c.method === 'POST' && c.url.includes('/git/'))).toBe(
      false,
    );
  });

  it('an unreachable GitHub is the same typed failure, not a raw error', async () => {
    installGitHub();
    const real = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).includes('/git/trees')) throw new TypeError('socket hang up');
      return real(url as string, init);
    });

    await expect(
      repoProvisioningClient.provisionRepository(webRow({ choice: CHOICE })),
    ).rejects.toMatchObject({ code: 'DESIGN_CHOICE_NOT_APPLIED', status: null });
  });
});
