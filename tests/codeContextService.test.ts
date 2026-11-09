import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { db } from '@/lib/db';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from './fixtures/workItemFixtures';
import { createTestProject } from './fixtures/projectFixtures';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { resolveCodeContextState } from '@/lib/services/codeContextService';

// THE PROJECT'S CODE CONTEXT (Story MOTIR-1754 · MOTIR-1767, second revision).
//
// The card was re-scoped after MOTIR-4724 shipped `lib/codeGraph/indexState.ts`,
// so the subject of this file changed with it. It used to prove a verdict this
// service COMPUTED; it now proves that the service computes NOTHING and reports
// the shipped derivation faithfully over the PROJECT's own configured set.
//
// ⚠️ THE TWO ASSERTIONS THAT MATTER MOST ARE BOTH ABOUT NOT DOING SOMETHING:
//
//   1. NO SECOND DERIVATION. `tests/codeGraph/indexState.test.ts` owns the four
//      states and asserts nothing else under `lib/` compares an indexed sha to a
//      head sha. This file must not re-assert the derivation's own arms — two
//      suites owning one rule are two suites free to disagree about it — so it
//      asserts the SEAM instead: that this service's answer IS that function's.
//   2. NO BOUNDARY READ. Freshness is motir-core's own columns now. A round-trip
//      to `motir-ai` reintroduces a dependency the schema made unnecessary.
//
// Real Postgres. Nothing is stubbed: every path here is a database read.

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
    defaultBranchHeadSha?: string | null;
    indexedHeadSha?: string | null;
    indexingRunId?: string | null;
    indexedAt?: Date | null;
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
      defaultBranchHeadSha: opts.defaultBranchHeadSha ?? null,
      indexedHeadSha: opts.indexedHeadSha ?? null,
      indexingRunId: opts.indexingRunId ?? null,
      indexedAt: opts.indexedAt ?? null,
    },
  });
}

/** Link a realized repository into a project's set — the row this service reads. */
async function linkIntoProject(projectId: string, githubRepoId: string, name: string) {
  const row = await projectRepoSetService.addRow(projectId, { role: 'web', name }, fx.ctx);
  await adminDb.projectRepo.update({ where: { id: row.id }, data: { githubRepoId } });
  return row.id;
}

/**
 * A succeeded index run carrying a repo's ref, the ledger row a real index writes.
 * `stampIndexed: false` writes the ledger row ALONE — the half a settle that never
 * stamped the repository left behind (Bug MOTIR-10171).
 */
async function seedSucceededIndex(repoRef: string, opts: { stampIndexed?: boolean } = {}) {
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
  if (opts.stampIndexed === false) return;
  // …and the settle's stamp on the repository row, which is what every index
  // state reads (`hasBuiltGraph`, Bug MOTIR-10171): a real success writes both.
  const [owner, name] = repoRef.split('/');
  await adminDb.githubRepo.updateMany({
    where: { owner, name, indexedAt: null },
    data: { indexedAt: new Date() },
  });
}

describe('the project code-context read', () => {
  it('returns the PROJECT’s configured set — two projects of one workspace see only their own', async () => {
    const a = await seedRepo('repo-a');
    const b = await seedRepo('repo-b');
    const second = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: `SEC${Math.floor(Math.random() * 10_000)}`,
    });
    await linkIntoProject(fx.projectId, a.id, 'repo-a');
    await linkIntoProject(second.id, b.id, 'repo-b');

    const first = await resolveCodeContextState(fx.projectId, fx.ctx);
    const other = await resolveCodeContextState(second.id, fx.ctx);

    expect(first.repos.map((r) => r.repoRef)).toEqual(['moooon/repo-a']);
    expect(other.repos.map((r) => r.repoRef)).toEqual(['moooon/repo-b']);
  });

  it('a project with an EMPTY set has no code context at all', async () => {
    // The workspace HAS an installation and a connected repository; this project
    // simply is not configured with it. That distinction is the whole point of
    // reading the project's set rather than the installation's grant list.
    await seedRepo('repo-a');
    const state = await resolveCodeContextState(fx.projectId, fx.ctx);
    expect(state.hasCodeContext).toBe(false);
    expect(state.repos).toEqual([]);
  });

  it('a PROPOSED row — one with no realized repository — contributes nothing', async () => {
    await projectRepoSetService.addRow(fx.projectId, { role: 'web', name: 'not-yet' }, fx.ctx);
    const state = await resolveCodeContextState(fx.projectId, fx.ctx);
    expect(state.repos).toEqual([]);
    expect(state.hasCodeContext).toBe(false);
  });

  it('reports `never` for a realized repository with no succeeded index run', async () => {
    const a = await seedRepo('repo-a');
    await linkIntoProject(fx.projectId, a.id, 'repo-a');
    const state = await resolveCodeContextState(fx.projectId, fx.ctx);
    expect(state.repos[0]!.indexState).toBe('never');
    expect(state.hasCodeContext).toBe(true);
  });

  it('reports `stale` only when BOTH shas are known and differ, and `indexed` when one is null', async () => {
    const moved = await seedRepo('moved', {
      defaultBranchHeadSha: 'bbb',
      indexedHeadSha: 'aaa',
    });
    // A repository that predates the head columns: null is "not known yet", never
    // "behind". Flipping such a repository to `stale` would tell every customer
    // their graph was out of date on no evidence at all.
    const unknown = await seedRepo('unknown', {
      defaultBranchHeadSha: null,
      indexedHeadSha: 'aaa',
    });
    await linkIntoProject(fx.projectId, moved.id, 'moved');
    await linkIntoProject(fx.projectId, unknown.id, 'unknown');
    await seedSucceededIndex('moooon/moved');
    await seedSucceededIndex('moooon/unknown');

    const byRef = new Map(
      (await resolveCodeContextState(fx.projectId, fx.ctx)).repos.map((r) => [r.repoRef, r]),
    );
    expect(byRef.get('moooon/moved')!.indexState).toBe('stale');
    expect(byRef.get('moooon/unknown')!.indexState).toBe('indexed');
  });

  it('⚠️ a succeeded run naming the repository while its row was never stamped reads `never` (MOTIR-10171)', async () => {
    // The disagreement `get_code_health` served: the state read the LEDGER (a
    // succeeded run's `output.repoRef`) while `indexedAt` read the ROW, so a
    // settle that never stamped the row answered `indexed` with `indexedAt: null`.
    // Both now come off the row, so the two cannot contradict each other.
    const repo = await seedRepo('repo-a', { defaultBranchHeadSha: null, indexedHeadSha: null });
    await linkIntoProject(fx.projectId, repo.id, 'repo-a');
    await seedSucceededIndex('moooon/repo-a', { stampIndexed: false });

    const [row] = (await resolveCodeContextState(fx.projectId, fx.ctx)).repos;
    expect(row).toMatchObject({ indexState: 'never', indexedAt: null });

    // …and the stamp a successful settle writes is what moves it — with its time.
    await adminDb.githubRepo.update({
      where: { id: repo.id },
      data: { indexedAt: new Date('2026-10-31T09:11:00Z') },
    });
    const [after] = (await resolveCodeContextState(fx.projectId, fx.ctx)).repos;
    expect(after).toMatchObject({
      indexState: 'indexed',
      indexedAt: new Date('2026-10-31T09:11:00Z'),
    });
  });

  it('never answers `indexed` or `stale` with `indexedAt: null`, across every row shape (MOTIR-10171)', async () => {
    const shas = [null, 'aaa', 'bbb'] as const;
    let n = 0;
    for (const indexedAt of [null, new Date('2026-10-01T00:00:00Z')])
      for (const indexedHeadSha of shas)
        for (const defaultBranchHeadSha of shas)
          for (const ledger of [false, true]) {
            const name = `shape-${n++}`;
            const repo = await seedRepo(name, { indexedAt, indexedHeadSha, defaultBranchHeadSha });
            await linkIntoProject(fx.projectId, repo.id, name);
            if (ledger) await seedSucceededIndex(`moooon/${name}`, { stampIndexed: false });
          }

    const { repos } = await resolveCodeContextState(fx.projectId, fx.ctx);
    expect(repos).toHaveLength(n);
    for (const repo of repos) {
      if (repo.indexState === 'indexed' || repo.indexState === 'stale') {
        expect(repo.indexedAt, repo.repoRef).not.toBeNull();
      } else {
        expect(repo.indexState, repo.repoRef).toBe('never');
        expect(repo.indexedAt, repo.repoRef).toBeNull();
      }
    }
  });

  it('⚠️ a CRASHED run’s stale `indexingRunId` does NOT report `indexing`', async () => {
    // The column is a POINTER, not a state. Resolving it against the column alone
    // would leave a repository reading `indexing` for ever after a crash — worse
    // than never reporting it at all — so the derivation's fact is resolved
    // against the LEDGER, and an abandoned row is simply not in the running set.
    const crashed = await adminDb.jobRun.create({
      data: {
        workspaceId: fx.workspaceId,
        functionId: 'system.code-graph-index',
        eventName: 'code-graph/index.requested',
        eventId: `evt-${Math.random().toString(36).slice(2)}`,
        lane: 'inngest',
        attempt: 1,
        status: 'abandoned',
      },
    });
    const repo = await seedRepo('repo-a', {
      indexingRunId: crashed.id,
      defaultBranchHeadSha: 'aaa',
      indexedHeadSha: 'aaa',
    });
    await linkIntoProject(fx.projectId, repo.id, 'repo-a');
    await seedSucceededIndex('moooon/repo-a');

    const state = await resolveCodeContextState(fx.projectId, fx.ctx);
    expect(state.repos[0]!.indexState).not.toBe('indexing');
    expect(state.repos[0]!.indexState).toBe('indexed');
  });

  it('reports `indexing` while the run its pointer names is genuinely running', async () => {
    const running = await adminDb.jobRun.create({
      data: {
        workspaceId: fx.workspaceId,
        functionId: 'system.code-graph-index',
        eventName: 'code-graph/index.requested',
        eventId: `evt-${Math.random().toString(36).slice(2)}`,
        lane: 'inngest',
        attempt: 1,
        status: 'running',
      },
    });
    const repo = await seedRepo('repo-a', {
      indexingRunId: running.id,
      defaultBranchHeadSha: 'bbb',
      indexedHeadSha: 'aaa',
    });
    await linkIntoProject(fx.projectId, repo.id, 'repo-a');
    await seedSucceededIndex('moooon/repo-a');

    const state = await resolveCodeContextState(fx.projectId, fx.ctx);
    // `indexing` outranks `stale`: a re-index of a behind graph is in flight, not
    // behind.
    expect(state.repos[0]!.indexState).toBe('indexing');
  });

  it('⚠️ reports `indexing` while a REFRESH its pointer names is running (bug MOTIR-10821)', async () => {
    // A refresh claims the repository with its own job_run id exactly as a first
    // index does (MOTIR-9454). The running read used to count only
    // `system.code-graph-index`, so a behind graph being re-indexed read `stale`.
    const refresh = await adminDb.jobRun.create({
      data: {
        workspaceId: fx.workspaceId,
        functionId: 'system.code-graph-refresh',
        eventName: 'code-graph/refresh.requested',
        eventId: `evt-${Math.random().toString(36).slice(2)}`,
        lane: 'engine',
        attempt: 1,
        status: 'running',
      },
    });
    const repo = await seedRepo('repo-a', {
      indexingRunId: refresh.id,
      defaultBranchHeadSha: 'bbb',
      indexedHeadSha: 'aaa',
    });
    await linkIntoProject(fx.projectId, repo.id, 'repo-a');
    await seedSucceededIndex('moooon/repo-a');

    const state = await resolveCodeContextState(fx.projectId, fx.ctx);
    expect(state.repos[0]!.indexState).toBe('indexing');
  });

  it.each(['succeeded', 'failed', 'abandoned'] as const)(
    'a claimed REFRESH that ended `%s` reads `stale`, exactly as before (bug MOTIR-10821)',
    async (status) => {
      const refresh = await adminDb.jobRun.create({
        data: {
          workspaceId: fx.workspaceId,
          functionId: 'system.code-graph-refresh',
          eventName: 'code-graph/refresh.requested',
          eventId: `evt-${Math.random().toString(36).slice(2)}`,
          lane: 'engine',
          attempt: 1,
          status,
          finishedAt: new Date(),
        },
      });
      const repo = await seedRepo('repo-a', {
        indexingRunId: refresh.id,
        defaultBranchHeadSha: 'bbb',
        indexedHeadSha: 'aaa',
      });
      await linkIntoProject(fx.projectId, repo.id, 'repo-a');
      await seedSucceededIndex('moooon/repo-a');

      const state = await resolveCodeContextState(fx.projectId, fx.ctx);
      expect(state.repos[0]!.indexState).toBe('stale');
    },
  );

  it('`hasImplementedWork` reads implementation provenance, not a done status', async () => {
    // A project with work items but NONE implemented is the case the prompt is
    // for, so seed one and leave its provenance null first.
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Something' });
    const before = await resolveCodeContextState(fx.projectId, fx.ctx);
    expect(before.hasImplementedWork).toBe(false);
    await adminDb.workItem.update({
      where: { id: item.id },
      data: { implementationSource: 'byok' },
    });
    const after = await resolveCodeContextState(fx.projectId, fx.ctx);
    expect(after.hasImplementedWork).toBe(true);
  });
});

describe('⚠️ the service COMPOSES the shipped derivation — it computes nothing', () => {
  it('declares no verdict type or comparison of its own', () => {
    // The card this file belongs to first shipped a `resolveVerdict` and a
    // `CodeRepoVerdict` union here. Both are gone, and a re-introduction is the
    // exact defect `tests/codeGraph/indexState.test.ts` exists to prevent — one
    // word, two answers, on two different screens. Asserted lexically because a
    // second union would compile perfectly.
    const service = readFileSync('lib/services/codeContextService.ts', 'utf8');
    const dto = readFileSync('lib/dto/codeContext.ts', 'utf8');
    // Matched as DECLARATIONS, not as words: this file's own comment names both
    // symbols deliberately, so a bare word match would forbid the explanation
    // along with the thing it explains.
    expect(service).not.toMatch(/(export )?function resolveVerdict/);
    expect(service + dto).not.toMatch(/type CodeRepoVerdict|CodeRepoVerdict =/);
    expect(service).toMatch(/deriveCodeGraphIndexState/);
  });

  it('reaches motir-ai on no path', () => {
    // Freshness is motir-core's own columns since MOTIR-4724. The first revision
    // of this service called `getCodeGraphStatus` across the 7.1 boundary for
    // exactly the facts the schema now holds.
    const service = readFileSync('lib/services/codeContextService.ts', 'utf8');
    expect(service).not.toMatch(/motirAiClient|getCodeGraphStatus/);
  });

  it('is not a second implementation of "stale" — the shipped guard still passes', () => {
    // The guard greps `lib/` for `indexedHeadSha` and requires the hit list to be
    // exactly its own allow-list. Running it here means this card cannot be
    // merged on a green suite that never exercised the rule it was written to
    // obey.
    // ⚠️ THE RULE IS THE COMPARISON, NOT THE MENTION. This service is on the
    // guard's allow-list precisely because it ASSEMBLES the facts — naming the
    // column is its job. What it may never do is decide what they mean, and the
    // `'stale'` literal is where that decision would have to be written.
    const hits = execSync("grep -rln 'indexedHeadSha' lib/ --include='*.ts' || true", {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
    expect(hits).toContain('lib/codeGraph/indexState.ts');
    expect(hits).toContain('lib/services/codeContextService.ts');
    expect(readFileSync('lib/services/codeContextService.ts', 'utf8')).not.toContain("'stale'");
    expect(readFileSync('lib/codeGraph/indexState.ts', 'utf8')).toContain("return 'stale'");
  });
});
