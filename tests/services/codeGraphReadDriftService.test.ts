import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodeContextRepoDTO } from '@/lib/dto/codeContext';
import {
  CODE_GRAPH_DRIFT_PATHS_MAX,
  codeGraphReadDriftService,
  pathsInArea,
  queryAreaWords,
} from '@/lib/services/codeGraphReadDriftService';
import { repoChangesService } from '@/lib/services/repoChangesService';
import { RepoNotInProjectError } from '@/lib/git/errors';

// The drift a code-graph read carries (MOTIR-10094), at the service: which
// repositories are behind, the searched area, and a compare that cannot be asked.
// The read through the MCP, against real Postgres and the provider seam, is
// `tests/mcp/code-graph-read.test.ts`; this file is the arms that door cannot reach.

const CTX = { userId: 'u1', workspaceId: 'w1' };
const INDEXED = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

function repo(overrides: Partial<CodeContextRepoDTO> = {}): CodeContextRepoDTO {
  return {
    repoRef: 'acme/web',
    provider: 'github',
    indexState: 'stale',
    indexedAt: null,
    commitsBehind: 2,
    indexedSha: INDEXED,
    defaultHead: HEAD,
    refreshFailing: false,
    graphTooLarge: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('queryAreaWords — the words of a query that can name a path', () => {
  it('splits at non-alphanumerics and camelCase humps, keeps four letters or more, drops stop words', () => {
    expect(queryAreaWords('chooseInTx')).toEqual(['choose']);
    expect(queryAreaWords('fleet pool chooser')).toEqual(['fleet', 'pool', 'chooser']);
    expect(queryAreaWords('fleetShardAdmissionService.chooseInTx')).toEqual([
      'fleet',
      'shard',
      'admission',
      'service',
      'choose',
    ]);
    expect(queryAreaWords('code that runs with the pool')).toEqual(['code', 'runs', 'pool']);
    expect(queryAreaWords('a b c')).toEqual([]);
    expect(queryAreaWords('Pool pool POOL')).toEqual(['pool']);
  });
});

describe('pathsInArea — the changed paths inside the searched area', () => {
  const PATHS = ['lib/billing/plans.ts', 'lib/fleet/pool.ts', 'app/pricing/page.tsx'];

  it('a path prefix is the area, matched exactly (a leading ./ or / is ignored)', () => {
    expect(pathsInArea(PATHS, { pathPrefix: 'lib/billing/' })).toEqual(['lib/billing/plans.ts']);
    expect(pathsInArea(PATHS, { pathPrefix: './lib/' })).toEqual([
      'lib/billing/plans.ts',
      'lib/fleet/pool.ts',
    ]);
    expect(pathsInArea(PATHS, { pathPrefix: '/app/', text: 'billing' })).toEqual([
      'app/pricing/page.tsx',
    ]);
  });

  it('without a prefix, a path naming a query word is in the area — case-insensitively', () => {
    expect(pathsInArea(PATHS, { text: 'FleetPool' })).toEqual(['lib/fleet/pool.ts']);
    expect(pathsInArea(PATHS, { text: 'nothing here' })).toEqual([]);
  });

  it('a query with no usable word, or no query at all, names no path', () => {
    expect(pathsInArea(PATHS, { text: 'a b' })).toEqual([]);
    expect(pathsInArea(PATHS, {})).toEqual([]);
    expect(pathsInArea(PATHS, { pathPrefix: '  ' })).toEqual([]);
  });
});

describe('codeGraphReadDriftService.forRead', () => {
  it('asks only for the repositories whose graph trails the head, in order, graph commit against head', async () => {
    const list = vi.spyOn(repoChangesService, 'listChangedFiles').mockResolvedValue({
      outcome: 'ok',
      base: INDEXED,
      head: HEAD,
      files: [{ path: 'lib/fleet/pool.ts', status: 'added' }],
      truncated: false,
      baseSha: INDEXED,
      headSha: HEAD,
    });
    const drift = await codeGraphReadDriftService.forRead(
      'p1',
      [
        repo({ repoRef: 'acme/current', indexedSha: HEAD }),
        repo({ repoRef: 'acme/unknown', defaultHead: null }),
        repo({ repoRef: 'acme/never', indexedSha: null }),
        repo(),
      ],
      { text: 'pool' },
      CTX,
    );
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({ ...CTX, projectId: 'p1' }, 'acme/web', HEAD, INDEXED);
    expect(drift).toEqual([
      {
        repoRef: 'acme/web',
        indexedSha: INDEXED,
        defaultHead: HEAD,
        commitsBehind: 2,
        changedPaths: ['lib/fleet/pool.ts'],
        changedPathsTruncated: false,
        changedPathsUnavailable: null,
        changedPathsInQueryArea: ['lib/fleet/pool.ts'],
      },
    ]);
  });

  it('no repository behind ⇒ no compare and no entries', async () => {
    const list = vi.spyOn(repoChangesService, 'listChangedFiles');
    expect(
      await codeGraphReadDriftService.forRead('p1', [repo({ indexedSha: HEAD })], {}, CTX),
    ).toEqual([]);
    expect(list).not.toHaveBeenCalled();
  });

  it('a listing that THROWS (a repository the set no longer holds) is host_error, never a thrown read', async () => {
    vi.spyOn(repoChangesService, 'listChangedFiles')
      .mockRejectedValueOnce(new RepoNotInProjectError('acme/web'))
      .mockRejectedValueOnce('not an error');
    const [first] = await codeGraphReadDriftService.forRead('p1', [repo()], {}, CTX);
    const [second] = await codeGraphReadDriftService.forRead('p1', [repo()], {}, CTX);
    for (const d of [first, second]) {
      expect(d).toMatchObject({
        changedPaths: null,
        changedPathsTruncated: false,
        changedPathsUnavailable: 'host_error',
        changedPathsInQueryArea: null,
      });
    }
  });

  it(`bounds the list at ${CODE_GRAPH_DRIFT_PATHS_MAX}, and the area at the same bound`, async () => {
    const paths = Array.from({ length: 120 }, (_, i) => `lib/pool/file${i}.ts`);
    vi.spyOn(repoChangesService, 'listChangedFiles').mockResolvedValue({
      outcome: 'ok',
      base: INDEXED,
      head: HEAD,
      files: paths.map((path) => ({ path, status: 'modified' as const })),
      truncated: false,
      baseSha: INDEXED,
      headSha: HEAD,
    });
    const [d] = await codeGraphReadDriftService.forRead('p1', [repo()], { text: 'pool' }, CTX);
    expect(d!.changedPaths).toHaveLength(CODE_GRAPH_DRIFT_PATHS_MAX);
    expect(d!.changedPathsTruncated).toBe(true);
    expect(d!.changedPathsInQueryArea).toHaveLength(CODE_GRAPH_DRIFT_PATHS_MAX);
  });
});
