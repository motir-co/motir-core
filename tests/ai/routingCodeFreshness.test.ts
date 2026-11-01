import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { linkProjectRepo } from '../helpers/projectRepoLink';
import { resolveProjectCodeContext, withCodeFreshness } from '@/lib/ai/codeContext';

// THE ROUTING DISPATCH CARRIES THE DRIFT (Story MOTIR-1754 · MOTIR-4857).
//
// `startRoutingRun` asks the largest question Motir asks on a project's behalf —
// can this be planned at all, or does the person need onboarding first — and it
// was told only whether a graph EXISTS. A graph three commits behind and one
// three hundred behind are the same fact to a boolean, and they support opposite
// answers.
//
// ⚠️ WHAT THIS FILE IS NOT ABOUT: whether any particular drift means anything.
// Nothing here asserts a threshold, because there is none — the number goes on
// the wire and the planner judges it (MOTIR-4590, and MOTIR-4753's rule that
// nothing about the verdict's content is decided in code). The last test in this
// file asserts that absence directly.
//
// Real Postgres. Nothing is stubbed.

let fx: WorkItemFixture;
let orgId: string;
let installationRowId: string;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  orgId = fx.workspace.organizationId;
  const installation = await adminDb.githubInstallation.create({
    data: {
      installationId: `inst-${fx.workspaceId}`,
      workspaceId: fx.workspaceId,
      organizationId: orgId,
      accountLogin: 'moooon',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  installationRowId = installation.id;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function seedRepo(
  name: string,
  opts: {
    indexedHeadSha?: string | null;
    defaultBranchHeadSha?: string | null;
    commitsBehind?: number | null;
    commitsBehindBaseSha?: string | null;
    commitsBehindHeadSha?: string | null;
  } = {},
) {
  return adminDb.githubRepo.create({
    data: {
      installationId: installationRowId,
      workspaceId: fx.workspaceId,
      organizationId: orgId,
      repoId: `host-${name}`,
      owner: 'moooon',
      name,
      defaultBranch: 'main',
      provider: 'github',
      archived: false,
      indexedHeadSha: opts.indexedHeadSha ?? null,
      defaultBranchHeadSha: opts.defaultBranchHeadSha ?? null,
      commitsBehind: opts.commitsBehind ?? null,
      commitsBehindBaseSha: opts.commitsBehindBaseSha ?? null,
      commitsBehindHeadSha: opts.commitsBehindHeadSha ?? null,
    },
  });
}

async function linkIntoProject(githubRepoId: string, name: string) {
  // ⚠️ `linkProjectRepo`, not `addRow` + a realize. `addRow` records a PROPOSED
  // row, and `resolveProjectCodeContext` filters proposals out
  // (`isEstablishedState`), so an `addRow`-built fixture leaves the project
  // code-blind and its cases read as an empty answer rather than a missing link.
  await linkProjectRepo({
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    githubRepoId,
    name,
    role: 'web',
  });
}

/** A succeeded index in the ledger — what makes `stale` reachable at all. */
async function seedSucceededIndex(repoRef: string) {
  await adminDb.jobRun.create({
    data: {
      workspaceId: fx.workspaceId,
      functionId: 'system.code-graph-index',
      eventName: 'code-graph/index.requested',
      eventId: `evt-${Math.random().toString(36).slice(2)}`,
      lane: 'inngest',
      attempt: 1,
      status: 'succeeded',
      output: { repoRef },
    },
  });
  // …and the settle's stamp on the repository row, which is what every index
  // state reads (`hasBuiltGraph`, Bug MOTIR-10171): a real success writes both.
  const [owner, name] = repoRef.split('/');
  await adminDb.githubRepo.updateMany({
    where: { owner, name, indexedAt: null },
    data: { indexedAt: new Date() },
  });
}

// MOTIR-4653 — `resolveProjectCodeContext` reads the PROJECT's configured set, so the
// project is part of the coordinate. Every case in this file already calls
// `linkIntoProject`, which is what makes them still meaningful: the repository
// under test is one the project actually works on.
const CTX = () => ({
  userId: fx.ownerId,
  workspaceId: fx.workspaceId,
  projectId: fx.projectId,
});

describe('the drift rides beside `indexed`', () => {
  it('carries `indexState` and `commitsBehind` for a repository the project works on', async () => {
    const repo = await seedRepo('web', {
      indexedHeadSha: 'base1',
      defaultBranchHeadSha: 'head9',
      commitsBehind: 312,
      commitsBehindBaseSha: 'base1',
      commitsBehindHeadSha: 'head9',
    });
    await linkIntoProject(repo.id, 'web');
    await seedSucceededIndex('moooon/web');

    const thin = await resolveProjectCodeContext(CTX());
    const rich = await withCodeFreshness(thin, fx.projectId, CTX());

    expect(rich?.repos[0]).toMatchObject({
      repoRef: 'moooon/web',
      indexState: 'stale',
      commitsBehind: 312,
    });
  });

  it('⚠️ leaves `indexed` EXACTLY as it was — MOTIR-4753 reads it and is not changed', async () => {
    // The compatibility this card promised. `parseCodeRepoIndexState` (motir-ai)
    // keys on `indexed` and nothing else; a consumer reading only that field must
    // see today's answer, byte for byte.
    const repo = await seedRepo('web', { indexedHeadSha: 'b', defaultBranchHeadSha: 'h' });
    await linkIntoProject(repo.id, 'web');
    await seedSucceededIndex('moooon/web');

    const thin = await resolveProjectCodeContext(CTX());
    const rich = await withCodeFreshness(thin, fx.projectId, CTX());

    expect(thin?.repos.map((r) => [r.repoRef, r.indexed])).toEqual(
      rich?.repos.map((r) => [r.repoRef, r.indexed]),
    );
    // …and every field the thin entry already carried is untouched.
    for (const [i, before] of (thin?.repos ?? []).entries()) {
      expect(rich?.repos[i]).toMatchObject({
        provider: before.provider,
        repoRef: before.repoRef,
        defaultBranch: before.defaultBranch,
        indexed: before.indexed,
      });
    }
  });

  it('⚠️ omits the ENTRY entirely for a repository the project has NOT been given', async () => {
    // ⚠️ INVERTED BY MOTIR-4653, and the inversion STRENGTHENS the guarantee.
    // This used to assert that such a repository rides the envelope with the two
    // drift keys ABSENT — because the entries came from the WORKSPACE's
    // installation grant while the freshness came from the PROJECT's configured
    // set, so the two sets differed by construction and an un-joined repository
    // carried no drift rather than a fabricated one.
    //
    // `resolveProjectCodeContext` reads the project's set now, so the sets coincide and
    // there is no un-joined member left to describe: a repository the project
    // has not been given is not in the envelope AT ALL. Absent beats
    // present-with-no-drift for the same reason the original rule preferred an
    // absent key to a null one — nothing about it can read to a consumer as an
    // answer.
    const repo = await seedRepo('unlinked', { indexedHeadSha: 'b', defaultBranchHeadSha: 'h' });
    expect(repo.id).toBeTruthy();

    const rich = await withCodeFreshness(
      await resolveProjectCodeContext(CTX()),
      fx.projectId,
      CTX(),
    );

    expect(rich?.repos.map((r) => r.repoRef) ?? []).not.toContain('moooon/unlinked');
  });

  it('carries a NULL drift for a linked repository nobody has counted', async () => {
    // `null` is a first-class answer and is not the same as the key being absent:
    // here the project DOES work on the repository and the count simply has not
    // been taken. MOTIR-4644's own rule.
    const repo = await seedRepo('web', { indexedHeadSha: 'base1', defaultBranchHeadSha: 'head9' });
    await linkIntoProject(repo.id, 'web');
    await seedSucceededIndex('moooon/web');

    const rich = await withCodeFreshness(
      await resolveProjectCodeContext(CTX()),
      fx.projectId,
      CTX(),
    );

    expect(rich?.repos[0]).toMatchObject({ indexState: 'stale', commitsBehind: null });
  });

  it('passes an ABSENT or EMPTY context straight through', async () => {
    await expect(withCodeFreshness(undefined, fx.projectId, CTX())).resolves.toBeUndefined();
    await expect(withCodeFreshness({ repos: [] }, fx.projectId, CTX())).resolves.toEqual({
      repos: [],
    });
  });
});

describe('⚠️ it supplies a FACT and forms no opinion', () => {
  it('nothing in the routing dispatch branches on the drift', () => {
    // MOTIR-4753's rule, and this card is bound by it: `motir-core` carries the
    // verdict and does not have an opinion about it. `startRoutingRun` already
    // says so about `indexed` — *"a branch here would put the routing decision
    // back where five of this story's cards took it out of"* — and the same binds
    // the two fields this card adds.
    //
    // Asserted LEXICALLY over the function's own body: the drift may be READ onto
    // the wire and must never be compared.
    const src = readFileSync('lib/services/aiGenerationService.ts', 'utf8');
    const start = src.indexOf('async startRoutingRun');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\n  async ', start + 1);
    const body = src.slice(start, end === -1 ? undefined : end);

    // The composer is called…
    expect(body).toContain('withCodeFreshness');
    // …and neither field is ever compared, thresholded or branched on.
    expect(body).not.toMatch(/commitsBehind\s*[<>=!]/);
    expect(body).not.toMatch(/indexState\s*[<>=!]/);
    expect(body).not.toMatch(/BADLY_STALE/);
  });

  it('the freshness comes from the ONE derivation, not a second comparison here', () => {
    // `withCodeFreshness` assembles; `indexState.ts` and `driftCount.ts` derive.
    // The repo-wide one-derivation guard (tests/codeGraph/indexState.test.ts)
    // enforces this over `lib/`; this asserts the local half — the composer reads
    // the service's answer and compares nothing itself.
    const src = readFileSync('lib/ai/codeContext.ts', 'utf8');
    const start = src.indexOf('export async function withCodeFreshness');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start);
    expect(body).toContain('resolveCodeContextState');
    expect(body).not.toContain("'stale'");
    expect(body).not.toMatch(/indexedHeadSha\s*!==/);
  });
});
