import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';
import { makeWorkItemFixture, type WorkItemFixture } from './fixtures/workItemFixtures';
import { createTestProject } from './fixtures/projectFixtures';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { resolveCodeContextState } from '@/lib/services/codeContextService';
import { sectionFromParam } from '@/app/(authed)/code/_section';

// THE `/code` PAGE (Story MOTIR-1754 · MOTIR-1768) — one room, two sections.
//
// It absorbs `/code-health`, which now permanently redirects into it, and it is
// the surface that makes the story's whole point visible: a plan built without
// the code looks exactly like one built with it, and this is where a person can
// see which they got.
//
// ⚠️ WHAT THIS FILE IS FOR. The page's own BRANCHES — the gate, the seeding, the
// rethrow — are asserted in `tests/navigation/render/code-render.test.tsx`
// against a rendered tree. What is asserted HERE is everything that needs a real
// database or the shipped file tree: that the list is the PROJECT's set and not
// the workspace's, that the four verdicts and the drift are what the service
// hands over, and the structural rules the design places on the route.
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
    provider?: string;
    indexedHeadSha?: string | null;
    defaultBranchHeadSha?: string | null;
    commitsBehind?: number | null;
    commitsBehindBaseSha?: string | null;
    commitsBehindHeadSha?: string | null;
    indexingRunId?: string | null;
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
      provider: opts.provider ?? 'github',
      archived: false,
      indexedHeadSha: opts.indexedHeadSha ?? null,
      defaultBranchHeadSha: opts.defaultBranchHeadSha ?? null,
      commitsBehind: opts.commitsBehind ?? null,
      commitsBehindBaseSha: opts.commitsBehindBaseSha ?? null,
      commitsBehindHeadSha: opts.commitsBehindHeadSha ?? null,
      indexingRunId: opts.indexingRunId ?? null,
    },
  });
}

async function linkIntoProject(
  projectId: string,
  githubRepoId: string,
  name: string,
  ctx: WorkItemFixture['ctx'],
) {
  const row = await projectRepoSetService.addRow(projectId, { role: 'web', name }, ctx);
  await adminDb.projectRepo.update({ where: { id: row.id }, data: { githubRepoId } });
}

/** A succeeded index — the ledger row and the row's `indexedAt` stamp, what makes any state but `never` reachable. */
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

const CTX = () => ({ userId: fx.ownerId, workspaceId: fx.workspaceId });

describe('⚠️ the list is the PROJECT’s set, never the workspace’s grant list', () => {
  it('two projects in ONE workspace with different sets render only their own', async () => {
    // The leak §1 names, made to happen. The workspace's installation grants
    // BOTH repositories; each project is configured with one. A page reading the
    // grant list would show two rows on both projects and be wrong on both.
    const web = await seedRepo('web');
    const worker = await seedRepo('worker');
    await linkIntoProject(fx.projectId, web.id, 'web', fx.ctx);

    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTHR',
      name: 'Other',
    });
    await linkIntoProject(other.id, worker.id, 'worker', fx.ctx);

    const mine = await resolveCodeContextState(fx.projectId, CTX());
    const theirs = await resolveCodeContextState(other.id, CTX());

    expect(mine.repos.map((r) => r.repoRef)).toEqual(['moooon/web']);
    expect(theirs.repos.map((r) => r.repoRef)).toEqual(['moooon/worker']);
  });

  it('⚠️ a repository absent from a project is UNCONFIGURED, not hidden', async () => {
    // There is no privacy boundary between projects of one org, and the copy
    // must never imply one. The structural half of that claim: the row the
    // project has not been given is not filtered out by a permission check — it
    // is simply not in the project's set, and the SAME actor sees it on the
    // project that does have it.
    const shared = await seedRepo('shared');
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTHR',
      name: 'Other',
    });
    await linkIntoProject(other.id, shared.id, 'shared', fx.ctx);

    expect((await resolveCodeContextState(fx.projectId, CTX())).repos).toEqual([]);
    expect((await resolveCodeContextState(other.id, CTX())).repos.map((r) => r.repoRef)).toEqual([
      'moooon/shared',
    ]);
  });

  it('a PROPOSED row contributes no repository at all', async () => {
    // A row with no `githubRepoId` is a plan for a repository that does not
    // exist yet. There is no graph to have a state about, so it contributes
    // nothing rather than a fabricated `never`.
    await projectRepoSetService.addRow(fx.projectId, { role: 'api', name: 'not-yet' }, fx.ctx);

    expect((await resolveCodeContextState(fx.projectId, CTX())).repos).toEqual([]);
  });
});

describe('the four verdicts, and the drift beside them', () => {
  it('renders `never` for a connected repository with no succeeded index', async () => {
    const repo = await seedRepo('web');
    await linkIntoProject(fx.projectId, repo.id, 'web', fx.ctx);

    expect((await resolveCodeContextState(fx.projectId, CTX())).repos[0]).toMatchObject({
      indexState: 'never',
      commitsBehind: null,
    });
  });

  it('renders `stale` with its COUNT when the pair is known and differs', async () => {
    const repo = await seedRepo('web', {
      indexedHeadSha: 'base1',
      defaultBranchHeadSha: 'head9',
      commitsBehind: 312,
      commitsBehindBaseSha: 'base1',
      commitsBehindHeadSha: 'head9',
    });
    await linkIntoProject(fx.projectId, repo.id, 'web', fx.ctx);
    await seedSucceededIndex('moooon/web');

    expect((await resolveCodeContextState(fx.projectId, CTX())).repos[0]).toMatchObject({
      indexState: 'stale',
      commitsBehind: 312,
    });
  });

  it('⚠️ renders `stale` with a NULL count — the D3 arm, and it is not zero', async () => {
    // The count was never taken, or the pair has moved, or there is no common
    // ancestor. All of those mean *behind by an unknown number of commits*, and
    // none of them means *matching* — which is what a `0` would say.
    const repo = await seedRepo('web', {
      indexedHeadSha: 'base1',
      defaultBranchHeadSha: 'head9',
    });
    await linkIntoProject(fx.projectId, repo.id, 'web', fx.ctx);
    await seedSucceededIndex('moooon/web');

    const row = (await resolveCodeContextState(fx.projectId, CTX())).repos[0];
    expect(row).toMatchObject({ indexState: 'stale', commitsBehind: null });
    expect(row?.commitsBehind).not.toBe(0);
  });

  it('⚠️ renders `indexed`, not `stale`, when a comparand is MISSING', async () => {
    // `defaultBranchHeadSha` is written by the push webhook and by nothing else,
    // so a connected repository nobody has pushed to never acquires one.
    // Treating an absent comparand as a difference would flip the whole estate
    // to `stale` on deploy (§4.1).
    const repo = await seedRepo('web', { indexedHeadSha: 'base1' });
    await linkIntoProject(fx.projectId, repo.id, 'web', fx.ctx);
    await seedSucceededIndex('moooon/web');

    expect((await resolveCodeContextState(fx.projectId, CTX())).repos[0]).toMatchObject({
      indexState: 'indexed',
    });
  });

  it('carries the provider through, so a GitLab row draws its own mark', async () => {
    const repo = await seedRepo('web', { provider: 'gitlab' });
    await linkIntoProject(fx.projectId, repo.id, 'web', fx.ctx);

    expect((await resolveCodeContextState(fx.projectId, CTX())).repos[0]?.provider).toBe('gitlab');
  });
});

describe('the SECTION switch', () => {
  it('defaults to Repositories, and an unknown value falls back rather than throwing', () => {
    expect(sectionFromParam(null)).toBe('repositories');
    expect(sectionFromParam(undefined)).toBe('repositories');
    expect(sectionFromParam('')).toBe('repositories');
    expect(sectionFromParam('index')).toBe('repositories'); // the RETIRED tab
    expect(sectionFromParam('../../etc')).toBe('repositories');
  });

  it('reads the two sections a URL may legitimately name', () => {
    expect(sectionFromParam('repositories')).toBe('repositories');
    expect(sectionFromParam('health')).toBe('health');
  });
});

describe('⚠️ the structural rules the design places on this route', () => {
  const page = readFileSync('app/(authed)/code/page.tsx', 'utf8');
  const sections = readFileSync('app/(authed)/code/_components/CodeSections.tsx', 'utf8');
  const repos = readFileSync('app/(authed)/code/_components/CodeRepositories.tsx', 'utf8');
  const redirect = readFileSync('app/(authed)/code-health/page.tsx', 'utf8');

  it('`/code-health` redirects PERMANENTLY, and renders nothing of its own', () => {
    // A 307 tells a client to keep asking. `Code health` was a top-level row and
    // is now a tab; it is never coming back.
    expect(redirect).toContain('permanentRedirect');
    expect(redirect).toContain("'/code'");
    expect(redirect).not.toContain('CodeHealthClient');
  });

  it('⚠️ THE HEALTH GATE IS INSIDE THE SECTION — the page never returns early on it', () => {
    // §2.1's resolution, asserted lexically because it is a claim about
    // STRUCTURE that a passing render can satisfy by accident. The project-gate
    // catch must set a flag, not `return` — a return takes Repositories away
    // from every member and is the capability loss §3.1 forbids.
    const start = page.indexOf('catch (err)');
    expect(start).toBeGreaterThan(-1);
    const catchBody = page.slice(start, page.indexOf('\n  }', start));
    expect(catchBody).toContain('healthDenied = true');
    expect(catchBody).not.toContain('return (');
  });

  it('the two sections are exactly Repositories and Health — the `Index` tab is gone', () => {
    // §4, 2026-09-07: freshness is a property of the REPOSITORY and belongs on
    // its row. "A tab is a room somebody goes to, and nobody goes to look at an
    // index."
    expect(sections).toContain("'repositories'");
    expect(sections).toContain("'health'");
    expect(sections).not.toMatch(/'index'|Index tab|tabs\.index/);
  });

  it('⚠️ the section switch is SHALLOW — it never re-runs the server page', () => {
    // the coding convention § URL state the CLIENT reads. Both bodies are already in the
    // browser, so `router.push` would re-run every await behind this page —
    // the audit fan-out included — to show something already on screen.
    //
    // Asserted on a CALL rather than on the word: the module's own comment
    // explains what `router.push` would have cost, and a guard that forbade the
    // vocabulary would forbid the explanation along with the defect.
    expect(sections).toContain('shallowPush(');
    expect(sections).not.toContain('router.push(');
    expect(sections).not.toContain('useRouter(');
  });

  it('⚠️ and draws NO pending affordance for it', () => {
    // The same rule's second half: there is nothing to wait for, and drawing a
    // wait manufactures one.
    expect(sections).not.toMatch(/isPending|useTransition|Spinner|Skeleton|disabled=/);
  });

  it('the Repositories section has NO action of its own', () => {
    // §3, as amended by MOTIR-4866. The two actions live at
    // `/settings/project/repositories` and `/settings/account/git`; this section
    // links to the first and draws neither.
    expect(repos).toContain('/settings/project/repositories');
    expect(repos).not.toContain('Add or remove');
    expect(repos).not.toContain('/settings/account/git');
    expect(repos).not.toContain('<Button');
  });

  it('⚠️ the drift is never expressed as an AGE', () => {
    // §9, the sharpest point in the asset. `indexedAt` is on the DTO and this
    // section deliberately does not read it: age and drift disagree about the
    // answer, and an age-led reading gets both directions backwards.
    expect(repos).not.toContain('indexedAt');
    expect(repos).not.toMatch(/formatDistance|timeAgo|daysAgo/);
    expect(repos).toContain('drift.commits');
  });

  it('the verdict is READ, never re-derived here', () => {
    // `lib/codeGraph/indexState.ts` is the ONE derivation. A comparison in a
    // component would be a second definition of "still current".
    expect(repos).not.toContain('indexedHeadSha');
    expect(repos).not.toContain('defaultBranchHeadSha');
    expect(repos).not.toContain('deriveCodeGraphIndexState');
  });

  it('no `loading.tsx` was added under the authed group', () => {
    // Eleven of that group's pages call `notFound()`, and a boundary at the
    // group root fixes the status at 200 before any page function runs.
    expect(() => readFileSync('app/(authed)/loading.tsx', 'utf8')).toThrow();
    expect(() => readFileSync('app/(authed)/code/loading.tsx', 'utf8')).toThrow();
  });
});
