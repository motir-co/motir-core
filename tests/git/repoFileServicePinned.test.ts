import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { getGitProvider, REPO_FILE_MAX_BYTES } from '@/lib/git';
import type { RepoFileReadResult } from '@/lib/git/types';
import {
  repoFileReadService,
  type RepoFileServiceResult,
} from '@/lib/services/repoFileReadService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE PINNED READ CARRIES THE BLOB ID (MOTIR-11529) — the service hop between the
// provider seam (MOTIR-11528, `readFileAtRef`'s `blobSha` ask) and the planner's
// two callers. On real Postgres: a connected repository row, the provider spied
// at its seam methods. What the host answers is the provider's test
// (`repoFileRead.test.ts`); what is here is that the service ASKS on the pinned
// branch only, CARRIES what it was given beside `commitSha`, and DROPS it on every
// answer that is not `found` — the whole-file limit's rewrite above all.

const github = getGitProvider('github');
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const BLOB = '3f786850e387550fdab836ed7e6dc881de23001b';
const PATH = 'lib/x.ts';
const TEXT = 'export const x = 1;\n';

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  const installation = await adminDb.githubInstallation.create({
    data: {
      workspaceId: fx.workspaceId,
      installationId: 'inst-pinned-blob',
      accountLogin: 'acme',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  await adminDb.githubRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      installationId: installation.id,
      repoId: '11529',
      owner: 'acme',
      name: 'web',
      defaultBranch: 'main',
      provider: 'github',
    },
  });
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const ctx = () => ({ userId: fx.ownerId, workspaceId: fx.workspaceId });

/** The seam answers `read` to every file read, and resolves every ref to SHA. */
function seam(read: RepoFileReadResult) {
  const resolveRef = vi
    .spyOn(github, 'resolveRef')
    .mockResolvedValue({ outcome: 'resolved', ref: 'main', sha: SHA });
  const readFileAtRef = vi.spyOn(github, 'readFileAtRef').mockResolvedValue(read);
  return { resolveRef, readFileAtRef };
}

const found = (blobSha?: string): RepoFileReadResult => ({
  outcome: 'found',
  path: PATH,
  ref: SHA,
  text: TEXT,
  bytes: TEXT.length,
  ...(blobSha ? { blobSha } : {}),
});

describe('repoFileReadService.readFile — the pinned read carries blobSha', () => {
  it('answers the seam’s blob id beside commitSha and the text, having asked for it', async () => {
    const { readFileAtRef } = seam(found(BLOB));
    const result = await repoFileReadService.readFile(ctx(), 'acme/web', PATH, 'main', {
      pinCommit: true,
    });
    expect(result).toEqual({
      outcome: 'found',
      path: PATH,
      ref: 'main',
      text: TEXT,
      bytes: TEXT.length,
      commitSha: SHA,
      blobSha: BLOB,
    });
    // Asked AT the resolved commit, with the opt-in ask.
    expect(readFileAtRef).toHaveBeenCalledWith('inst-pinned-blob', 'acme', 'web', PATH, SHA, {
      blobSha: true,
    });
  });

  it('a ranged read carries the same id as the whole-file read at the same commit', async () => {
    seam(found(BLOB));
    const whole = await repoFileReadService.readFile(ctx(), 'acme/web', PATH, 'main', {
      pinCommit: true,
    });
    const ranged = await repoFileReadService.readFile(ctx(), 'acme/web', PATH, 'main', {
      pinCommit: true,
      ranged: true,
    });
    expect(ranged).toMatchObject({ outcome: 'found', commitSha: SHA, blobSha: BLOB });
    expect(ranged.outcome === 'found' && ranged.blobSha).toBe(
      whole.outcome === 'found' && whole.blobSha,
    );
  });

  it('a read without pinCommit asks for nothing, resolves no ref, and carries no blobSha', async () => {
    const { readFileAtRef, resolveRef } = seam(found());
    const result = await repoFileReadService.readFile(ctx(), 'acme/web', PATH, 'main');
    expect(result).toEqual({
      outcome: 'found',
      path: PATH,
      ref: SHA,
      text: TEXT,
      bytes: TEXT.length,
    });
    expect(resolveRef).not.toHaveBeenCalled();
    // Five arguments: the plain call carries no ask at all.
    expect(readFileAtRef).toHaveBeenCalledWith('inst-pinned-blob', 'acme', 'web', PATH, 'main');
    expect(readFileAtRef.mock.calls[0]).toHaveLength(5);
  });

  it('a whole-file read over the limit answers too_large with no blobSha, even when the seam gave one', async () => {
    const big = 'a'.repeat(REPO_FILE_MAX_BYTES + 1);
    seam({ outcome: 'found', path: PATH, ref: SHA, text: big, bytes: big.length, blobSha: BLOB });
    const result = await repoFileReadService.readFile(ctx(), 'acme/web', PATH, 'main', {
      pinCommit: true,
    });
    expect(result).toEqual({
      outcome: 'too_large',
      path: PATH,
      ref: 'main',
      limitBytes: REPO_FILE_MAX_BYTES,
      totalLines: 1,
      commitSha: SHA,
    });
  });

  it.each<RepoFileReadResult>([
    { outcome: 'directory', path: 'lib', ref: SHA, entries: [], truncated: false },
    { outcome: 'not_found', path: PATH, ref: SHA },
    { outcome: 'binary', path: PATH, ref: SHA, bytes: 10 },
    { outcome: 'unauthorized', path: PATH, ref: SHA },
    {
      outcome: 'unreachable',
      path: PATH,
      ref: SHA,
      failure: 'timeout',
      detail: 'no response within 5000ms',
    },
  ])('a $outcome answer carries no blobSha', async (read) => {
    seam(read);
    const result = await repoFileReadService.readFile(ctx(), 'acme/web', PATH, 'main', {
      pinCommit: true,
    });
    expect(result.outcome).toBe(read.outcome);
    expect(result).not.toHaveProperty('blobSha');
  });

  it.each(['ref_not_found', 'unauthorized'] as const)(
    'a ref that resolves to %s carries no blobSha and reads no file',
    async (outcome) => {
      const { readFileAtRef } = seam(found(BLOB));
      vi.spyOn(github, 'resolveRef').mockResolvedValue({ outcome, ref: 'main' });
      const result = await repoFileReadService.readFile(ctx(), 'acme/web', PATH, 'main', {
        pinCommit: true,
      });
      expect(result).toEqual({ outcome, path: PATH, ref: 'main' });
      expect(readFileAtRef).not.toHaveBeenCalled();
    },
  );

  it('an unreachable resolve and a refused path carry no blobSha', async () => {
    seam(found(BLOB));
    vi.spyOn(github, 'resolveRef').mockResolvedValue({
      outcome: 'unreachable',
      ref: 'main',
      failure: 'unreachable',
      detail: 'ECONNRESET',
    });
    const unreachable = await repoFileReadService.readFile(ctx(), 'acme/web', PATH, 'main', {
      pinCommit: true,
    });
    expect(unreachable).toMatchObject({ outcome: 'unreachable' });
    expect(unreachable).not.toHaveProperty('blobSha');

    const refused = await repoFileReadService.readFile(ctx(), 'acme/web', '../x', 'main', {
      pinCommit: true,
    });
    expect(refused).toMatchObject({ outcome: 'invalid_path' });
    expect(refused).not.toHaveProperty('blobSha');
  });

  it('a found answer the seam gave no id stays found with its text and commitSha', async () => {
    seam(found());
    const result = await repoFileReadService.readFile(ctx(), 'acme/web', PATH, 'main', {
      pinCommit: true,
    });
    expect(result).toEqual({
      outcome: 'found',
      path: PATH,
      ref: 'main',
      text: TEXT,
      bytes: TEXT.length,
      commitSha: SHA,
    });
  });
});

describe('RepoFileServiceResult — blobSha is readable on a found answer only', () => {
  it('compiles against found and refuses not_found / too_large', () => {
    const read = (r: RepoFileServiceResult): string | undefined => {
      if (r.outcome === 'found') return r.blobSha;
      if (r.outcome === 'not_found') {
        // @ts-expect-error — a not_found answer has no blobSha (MOTIR-11529).
        return r.blobSha;
      }
      if (r.outcome === 'too_large') {
        // @ts-expect-error — a too_large answer has no blobSha (MOTIR-11529).
        return r.blobSha;
      }
      return undefined;
    };
    expect(
      read({ outcome: 'found', path: PATH, ref: 'main', text: '', bytes: 0, blobSha: BLOB }),
    ).toBe(BLOB);
    expect(read({ outcome: 'not_found', path: PATH, ref: 'main' })).toBeUndefined();
  });
});
