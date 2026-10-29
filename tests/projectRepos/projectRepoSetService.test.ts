import { Prisma, type GithubRepo } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { listConnectedRepoNames } from '@/lib/workItems/targetRepo';
import { resolveDispatchTargetRepo } from '@/lib/workItems/targetRepo';
import {
  ProjectRepoInvalidFieldError,
  ProjectRepoNameTakenError,
  ProjectRepoNotFoundError,
  ProjectRepoStateTransitionError,
  RealizedRepoAlreadyClaimedError,
} from '@/lib/projectRepos/errors';
import {
  PROJECT_REPO_PROPOSAL_SIGNALS,
  SEED_SOURCE_INITIALISED,
  SEED_SOURCE_PLATFORM_STARTER,
  SEED_SOURCE_SPRING_API_FOUNDATION,
} from '@/lib/projectRepos/vocabulary';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';
import { organizationIdOf } from '../helpers/organizationOf';
import { setProjectAccess } from '@/tests/helpers/projectAccess';

// The project REPOSITORY SET over real Postgres (Story MOTIR-1775 · MOTIR-1780) —
// the substrate every other card in the Story stands on, so what is pinned here is
// each place it could quietly be wrong:
//
//   1. The set is a SET: rows append in order, primary first, a role may repeat.
//   2. `listByProject` joins the realized repos in ONE query — proved by counting
//      the round-trips, not asserted in a comment.
//   3. The two UNIQUENESS guarantees hold IN THE DATABASE, each proved by
//      attempting the violation: a duplicate `(project, name)`, and one
//      `GithubRepo` claimed by two projects.
//   4. Every state transition the ADR §4.1 machine permits is permitted, and the
//      ones it does not are rejected with a typed error — including under
//      concurrency, where the loser must not clobber the winner.
//   5. `resolveProjectRepoNames` agrees with `listConnectedRepoNames` on spelling,
//      so a pin validated against the project and one validated against the
//      workspace can never disagree.
//   6. The delete contracts: a deleted project takes its rows; a deleted
//      `GithubRepo` leaves the row with a null realized repo and an honest state.
//
// Real Postgres, no mocks (the repo convention). Tests connect as the superuser, so
// RLS is inert here by design — tenancy is proved in `project-repo-rls.test.ts`.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Connect one repo to the fixture's workspace — the 7.10.3 installation mirror
 *  rows a set row realizes against. */
async function connectRepo(
  workspaceId: string,
  name: string,
  opts: { owner?: string; provider?: string } = {},
): Promise<GithubRepo> {
  const owner = opts.owner ?? 'acme';
  const provider = opts.provider ?? 'github';
  const installationId = `inst-${workspaceId}-${provider}`;
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId },
    create: {
      installationId,
      workspaceId,
      accountLogin: owner,
      accountType: 'Organization',
      provider,
    },
    update: {},
  });
  return adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: workspaceId,
      organizationId: await organizationIdOf(workspaceId),
      repoId: `${name}-${randomToken(8)}`,
      owner,
      name,
      defaultBranch: 'main',
      archived: false,
      provider,
    },
  });
}

/**
 * Resolve once some backend in THIS test database is blocked on a lock — the
 * deterministic signal that a racing write has reached the unique index and is
 * waiting on an uncommitted winner. A signal, not a sleep: it polls the server's
 * own view of who is waiting.
 */
async function waitUntilABackendWaitsOnALock(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const rows = await adminDb.$queryRaw<{ waiting: bigint }[]>`
      SELECT count(*) AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (Number(rows[0]?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('no backend ever waited on a lock — the race was not forced');
}

/**
 * Wrap a real transaction client so every property access and every `$queryRaw`
 * call is recorded — the instrument behind the "ONE query" assertion. Only
 * `$queryRaw` is intercepted; everything else passes through untouched, so the
 * read under test behaves exactly as in production.
 */
function instrumentTx(real: Prisma.TransactionClient): {
  proxy: Prisma.TransactionClient;
  accesses: string[];
  queryRawCalls: () => number;
} {
  const accesses: string[] = [];
  let queryRawCalls = 0;
  const proxy = new Proxy(real as object, {
    get(target, prop, receiver) {
      if (typeof prop === 'string') accesses.push(prop);
      const value = Reflect.get(target, prop, receiver);
      if (prop === '$queryRaw' && typeof value === 'function') {
        return (...args: unknown[]) => {
          queryRawCalls += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return value;
    },
  }) as Prisma.TransactionClient;
  return { proxy, accesses, queryRawCalls: () => queryRawCalls };
}

// ── The set as a SET ────────────────────────────────────────────────────────

describe('a project repository SET', () => {
  it('is EMPTY, not an error, for a project that never ran the establish step', async () => {
    // Every project predating this table is in this state, and the shipped
    // single-connected-repo dispatch fallback is what answers for it.
    const fx = await makeWorkItemFixture();
    const set = await projectRepoSetService.getSet(fx.projectId, fx.ctx);
    expect(set.rows).toEqual([]);
    expect(set.ownership).toBeNull();
    expect(set.targetAccount).toBeNull();
  });

  it('holds ONE row for a single-repo architecture — the degenerate case, same model', async () => {
    const fx = await makeWorkItemFixture();
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme' },
      fx.ctx,
    );
    expect(row.role).toBe('web');
    expect(row.name).toBe('acme');
    expect(row.state).toBe('proposed');
    expect(row.established).toBe(false);
    expect(row.realizedRepo).toBeNull();
    // ADR §2: a web row seeds from the ONE default platform starter.
    expect(row.seedSource).toBe(SEED_SOURCE_PLATFORM_STARTER);
    expect(
      (await projectRepoSetService.listByProject(fx.projectId, fx.ctx)).map((r) => r.name),
    ).toEqual(['acme']);
  });

  it('holds TWO rows for a separated frontend/backend, in append order, primary first', async () => {
    // The cardinality comes from the architecture, never a constant — this is the
    // case the one-repo premise could not express.
    const fx = await makeWorkItemFixture();
    await projectRepoSetService.addRow(fx.projectId, { role: 'web', name: 'acme-web' }, fx.ctx);
    await projectRepoSetService.addRow(fx.projectId, { role: 'api', name: 'acme-api' }, fx.ctx);
    const rows = await projectRepoSetService.listByProject(fx.projectId, fx.ctx);
    expect(rows.map((r) => [r.role, r.name])).toEqual([
      ['web', 'acme-web'],
      ['api', 'acme-api'],
    ]);
    // Order is meaningful: the FIRST row is the project's primary repo (§1.3).
    expect(rows[0]!.position < rows[1]!.position).toBe(true);
    // ADR §2: a non-web role is not seeded from the web starter — it takes its
    // role's registered foundation (706 3.8, MOTIR-9813).
    expect(rows[1]!.seedSource).toBe(SEED_SOURCE_SPRING_API_FOUNDATION);
  });

  it('lets a ROLE REPEAT, distinguished by label — a service-oriented backend', async () => {
    // ADR §1.2: forbidding repetition would push several services into `other`,
    // losing the seeding behaviour the role exists to select.
    const fx = await makeWorkItemFixture();
    await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'api', name: 'acme-api-billing', label: 'billing' },
      fx.ctx,
    );
    await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'api', name: 'acme-api-search', label: 'search' },
      fx.ctx,
    );
    const apis = await projectRepoSetService.getByProjectAndRole(fx.projectId, 'api', fx.ctx);
    expect(apis).toHaveLength(2);
    expect(apis.map((r) => r.label)).toEqual(['billing', 'search']);
  });

  it('accepts an explicit seedSource override — the MOTIR-709 registry seam', async () => {
    const fx = await makeWorkItemFixture();
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'api', name: 'acme-api', seedSource: 'some-future-starter-key' },
      fx.ctx,
    );
    expect(row.seedSource).toBe('some-future-starter-key');
  });

  it('normalizes a blank label to null so a caller never distinguishes "" from null', async () => {
    const fx = await makeWorkItemFixture();
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme', label: '   ' },
      fx.ctx,
    );
    expect(row.label).toBeNull();
  });
});

// ── WHY a row is there, PERSISTED (MOTIR-1892) ─────────────────────────────

describe('the derivation signal a row records', () => {
  it('persists the signal Motir derived, and SURVIVES a re-read of the set', async () => {
    // The whole point of the column: the proposer runs once, so the signal has to
    // come back from the DATABASE on a later page load, not from the run's own
    // return value. Read through `listByProject`, whose hand-written SELECT is
    // exactly where a new column silently goes missing.
    const fx = await makeWorkItemFixture();
    const created = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme', proposalSignal: 'preplan-platform' },
      fx.ctx,
    );
    expect(created.proposalSignal).toBe('preplan-platform');

    const [listed] = await projectRepoSetService.listByProject(fx.projectId, fx.ctx);
    expect(listed!.proposalSignal).toBe('preplan-platform');
    const set = await projectRepoSetService.getSet(fx.projectId, fx.ctx);
    expect(set.rows[0]!.proposalSignal).toBe('preplan-platform');
  });

  it('records NULL for a row the USER added — there is no inference to explain', async () => {
    const fx = await makeWorkItemFixture();
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'api', name: 'acme-api' },
      fx.ctx,
    );
    expect(row.proposalSignal).toBeNull();
    expect(
      (await projectRepoSetService.listByProject(fx.projectId, fx.ctx))[0]!.proposalSignal,
    ).toBeNull();
    // NULL in the DB, not the string "null" or an empty string — a consumer
    // branches on absence.
    const persisted = await adminDb.projectRepo.findUnique({ where: { id: row.id } });
    expect(persisted!.proposalSignal).toBeNull();
  });

  it('treats an EXPLICIT null the same as omitting it — absence has one meaning', async () => {
    // A caller that spreads a partially-filled object writes `null`, not
    // `undefined`; both mean "nothing inferred this row", and neither is an
    // unknown value to reject.
    const fx = await makeWorkItemFixture();
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme', proposalSignal: null as never },
      fx.ctx,
    );
    expect(row.proposalSignal).toBeNull();
  });

  it('REJECTS a signal outside ADR §0.1s ladder, and writes nothing', async () => {
    // The column is what the establish step maps to copy, so an unmappable value
    // is a bug to reject at the write rather than discover at render.
    const fx = await makeWorkItemFixture();
    await expect(
      projectRepoSetService.addRow(
        fx.projectId,
        { role: 'web', name: 'acme', proposalSignal: 'vibes' as never },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(ProjectRepoInvalidFieldError);
    expect(await projectRepoSetService.listByProject(fx.projectId, fx.ctx)).toEqual([]);
  });

  it('accepts EVERY rung the ADR names — the vocabulary and the column agree', async () => {
    const fx = await makeWorkItemFixture();
    for (const [i, signal] of PROJECT_REPO_PROPOSAL_SIGNALS.entries()) {
      const row = await projectRepoSetService.addRow(
        fx.projectId,
        { role: 'other', name: `acme-${i}`, proposalSignal: signal },
        fx.ctx,
      );
      expect(row.proposalSignal).toBe(signal);
    }
  });

  it('SURVIVES the user editing the row — the signal records what Motir inferred, not what the row now says', async () => {
    // A rename is a decision about the repo; it is not a claim that Motir never
    // inferred anything. Clearing the signal here would erase the history the
    // column exists to keep.
    const fx = await makeWorkItemFixture();
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme-web', proposalSignal: 'plan-item-role' },
      fx.ctx,
    );
    const patched = await projectRepoSetService.patchRow(
      row.id,
      { name: 'acme-frontend', role: 'other' },
      fx.ctx,
    );
    expect(patched.proposalSignal).toBe('plan-item-role');
  });

  it('SURVIVES the establish machine — a row that becomes real still says why it was proposed', async () => {
    const fx = await makeWorkItemFixture();
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme-web', proposalSignal: 'default-web' },
      fx.ctx,
    );
    const creating = await projectRepoSetService.markCreating(row.id, fx.ctx);
    expect(creating.proposalSignal).toBe('default-web');

    const repo = await connectRepo(fx.workspaceId, 'acme-web');
    const realized = await projectRepoSetService.attachRealizedRepo(row.id, repo.id, fx.ctx);
    expect(realized.state).toBe('created');
    expect(realized.proposalSignal).toBe('default-web');
  });
});

// ── ONE query, not N+1 ─────────────────────────────────────────────────────

describe('listByProject reads the set in ONE query', () => {
  it('issues exactly one statement and touches no model delegate, however many rows', async () => {
    const fx = await makeWorkItemFixture();
    // Three rows, two of them realized — enough that an N+1 or a per-row include
    // would show up as extra round-trips.
    const web = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme-web' },
      fx.ctx,
    );
    const api = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'api', name: 'acme-api' },
      fx.ctx,
    );
    await projectRepoSetService.addRow(fx.projectId, { role: 'infra', name: 'acme-infra' }, fx.ctx);
    const webRepo = await connectRepo(fx.workspaceId, 'acme-web');
    const apiRepo = await connectRepo(fx.workspaceId, 'acme-api');
    await projectRepoSetService.markCreating(web.id, fx.ctx);
    await projectRepoSetService.attachRealizedRepo(web.id, webRepo.id, fx.ctx);
    await projectRepoSetService.attachRealizedRepo(api.id, apiRepo.id, fx.ctx);

    const { rows, queryRawCalls, accesses } = await withWorkspaceContext(
      { userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId },
      async (tx) => {
        const inst = instrumentTx(tx);
        const rows = await projectRepoRepository.listByProject(
          fx.projectId,
          fx.workspaceId,
          inst.proxy,
        );
        return { rows, queryRawCalls: inst.queryRawCalls(), accesses: inst.accesses };
      },
    );

    expect(queryRawCalls).toBe(1);
    // No `projectRepo` / `githubRepo` delegate was reached at all — so there is no
    // second (batched or per-row) query hiding behind a Prisma `include`.
    expect(accesses).not.toContain('projectRepo');
    expect(accesses).not.toContain('githubRepo');

    // …and the single query really did join the realized repos.
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.githubRepo?.name ?? null)).toEqual(['acme-web', 'acme-api', null]);
    expect(rows.map((r) => r.name)).toEqual(['acme-web', 'acme-api', 'acme-infra']);
  });
});

// ── Uniqueness, enforced in the DATABASE ───────────────────────────────────

describe('uniqueness — one row per (project, name)', () => {
  it('rejects a duplicate name with a typed error, not a raw P2002', async () => {
    const fx = await makeWorkItemFixture();
    await projectRepoSetService.addRow(fx.projectId, { role: 'web', name: 'acme-web' }, fx.ctx);
    await expect(
      projectRepoSetService.addRow(fx.projectId, { role: 'api', name: 'acme-web' }, fx.ctx),
    ).rejects.toBeInstanceOf(ProjectRepoNameTakenError);
  });

  it('rejects a CASE-VARIANT duplicate — git-host repo names are case-insensitive', async () => {
    const fx = await makeWorkItemFixture();
    await projectRepoSetService.addRow(fx.projectId, { role: 'web', name: 'acme-web' }, fx.ctx);
    await expect(
      projectRepoSetService.addRow(fx.projectId, { role: 'api', name: 'ACME-Web' }, fx.ctx),
    ).rejects.toBeInstanceOf(ProjectRepoNameTakenError);
  });

  it('is enforced BY THE DATABASE, not merely by the service pre-check', async () => {
    // Attempt the violation UNDERNEATH the service, straight at the table: the
    // unique index is what arbitrates a lost race, so it has to be real.
    const fx = await makeWorkItemFixture();
    const first = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme-web' },
      fx.ctx,
    );
    await expect(
      adminDb.projectRepo.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          role: 'api',
          name: 'acme-web',
          seedSource: SEED_SOURCE_INITIALISED,
          position: 'a1',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    const projectRepoCount = await adminDb.projectRepo.count({
      where: { projectId: fx.projectId },
    });
    expect(projectRepoCount).toBe(1);
    expect(first.name).toBe('acme-web');
  });

  it('allows the SAME name in two DIFFERENT projects — the unique is per project', async () => {
    const fx = await makeWorkItemFixture();
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTHER',
      name: 'Other',
    });
    await projectRepoSetService.addRow(fx.projectId, { role: 'web', name: 'web' }, fx.ctx);
    const second = await projectRepoSetService.addRow(
      other.id,
      { role: 'web', name: 'web' },
      fx.ctx,
    );
    expect(second.projectId).toBe(other.id);
  });
});

// ⚠️ RE-WRITTEN, NOT RELAXED (Story MOTIR-4669 · MOTIR-4648). This block used to
// be titled *"uniqueness — a realized repo is claimed by AT MOST ONE project
// row"*, and its first case asserted that a second project claiming the same
// `GithubRepo` was REFUSED, with the reason: *"the corruption to prevent: a repo
// created for project A recorded as project B's, which would send B's agents into
// A's code."*
//
// That premise is reversed. A repository belongs to the ORGANISATION and which
// projects use it is visibility configuration (MOTIR-2029, applied to the thing
// the code graph is built FROM) — so a repository in two projects is the ORDINARY
// CASE, and the old assertion now pins a behaviour the product must not have.
// The old sentences are kept above rather than deleted: a guard that inverts is
// worth being able to read the previous contract of.
//
// The guarantee that SURVIVED is narrower and is still enforced by the DATABASE:
// one repository appears at most once in ONE project's set. Both halves are
// asserted below.
describe('uniqueness — one repository, at most once per PROJECT', () => {
  it('ALLOWS a second project to claim the same GithubRepo — the ordinary case now', async () => {
    const fx = await makeWorkItemFixture();
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTHER',
      name: 'Other',
    });
    const repo = await connectRepo(fx.workspaceId, 'shared-repo');
    const rowA = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'shared-repo' },
      fx.ctx,
    );
    const rowB = await projectRepoSetService.addRow(
      other.id,
      { role: 'web', name: 'shared-repo' },
      fx.ctx,
    );
    await projectRepoSetService.attachRealizedRepo(rowA.id, repo.id, fx.ctx);
    const attachedB = await projectRepoSetService.attachRealizedRepo(rowB.id, repo.id, fx.ctx);

    expect(attachedB.projectId).toBe(other.id);
    // …and A keeps it. Neither project takes it from the other, which is the
    // property the `@unique` used to deliver by making the situation impossible.
    const stillA = await adminDb.projectRepo.findUnique({ where: { id: rowA.id } });
    expect(stillA?.githubRepoId).toBe(repo.id);
  });

  it('REJECTS a second row in the SAME project claiming it — the surviving 409', async () => {
    const fx = await makeWorkItemFixture();
    const repo = await connectRepo(fx.workspaceId, 'shared-repo');
    const rowA = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'shared-repo' },
      fx.ctx,
    );
    const rowDup = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'api', name: 'shared-repo-again' },
      fx.ctx,
    );
    await projectRepoSetService.attachRealizedRepo(rowA.id, repo.id, fx.ctx);
    // The SAME typed error the old contract raised — this card narrowed what the
    // 409 is about, it did not remove it.
    await expect(
      projectRepoSetService.attachRealizedRepo(rowDup.id, repo.id, fx.ctx),
    ).rejects.toBeInstanceOf(RealizedRepoAlreadyClaimedError);
  });

  it('is enforced BY THE DATABASE, not merely by the service pre-check', async () => {
    const fx = await makeWorkItemFixture();
    const repo = await connectRepo(fx.workspaceId, 'shared-repo');
    const rowA = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'shared-repo' },
      fx.ctx,
    );
    await projectRepoSetService.attachRealizedRepo(rowA.id, repo.id, fx.ctx);
    // Written through the admin client, so this is `@@unique([projectId,
    // githubRepoId])` answering — not the service's pre-check, which a concurrent
    // write would race past.
    await expect(
      adminDb.projectRepo.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          role: 'api',
          name: 'shared-repo-raced',
          seedSource: SEED_SOURCE_PLATFORM_STARTER,
          state: 'connected',
          githubRepoId: repo.id,
          position: 'a2',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('a LOST RACE on the realize path is the claim error — the loser neither 500s nor is told to rename (MOTIR-5273)', async () => {
    // Two claims of one repository into one project at once, forced to collide at
    // the INDEX rather than at the pre-check: the winner's claim is held open and
    // uncommitted, so the loser's pre-check reads nothing, its UPDATE waits on
    // `@@unique([projectId, githubRepoId])`, and it receives the `23505` when the
    // winner commits. That is the path whose translator read the absent
    // `meta.target` and re-threw the raw Prisma error — a 500 out of a service
    // whose contract says a raw P2002 never escapes.
    const fx = await makeWorkItemFixture();
    const repo = await connectRepo(fx.workspaceId, 'shared-repo');
    const winner = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'shared-repo' },
      fx.ctx,
    );
    const loserRow = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'api', name: 'shared-repo-again' },
      fx.ctx,
    );

    let loser: Promise<unknown> | undefined;
    await adminDb.$transaction(
      async (tx) => {
        await tx.projectRepo.update({
          where: { id: winner.id },
          data: { githubRepoId: repo.id, state: 'connected' },
        });
        loser = projectRepoSetService.attachRealizedRepoRow(loserRow.id, repo.id, fx.ctx).then(
          () => 'fulfilled',
          (err: unknown) => err,
        );
        await waitUntilABackendWaitsOnALock();
      },
      { timeout: 20_000 },
    );

    const outcome = await loser;
    expect(outcome).toBeInstanceOf(RealizedRepoAlreadyClaimedError);
    expect(outcome).not.toBeInstanceOf(ProjectRepoNameTakenError);
    expect(outcome).not.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    // …and the loser's row is untouched: nothing half-claimed it.
    const persisted = await adminDb.projectRepo.findUnique({ where: { id: loserRow.id } });
    expect(persisted?.githubRepoId).toBeNull();
  });

  it('permits MANY unrealized rows — a NULL claim is not a claim', async () => {
    // Postgres allows many NULLs in a unique index, which is exactly the semantics
    // the set needs: every `proposed` row is unrealized.
    const fx = await makeWorkItemFixture();
    for (const name of ['a', 'b', 'c', 'd']) {
      await projectRepoSetService.addRow(fx.projectId, { role: 'other', name }, fx.ctx);
    }
    const rows = await projectRepoSetService.listByProject(fx.projectId, fx.ctx);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.realizedRepo === null)).toBe(true);
  });
});

// ── The ADR §4.1 establish machine ─────────────────────────────────────────

describe('the establish machine — the happy paths', () => {
  it('runs proposed → creating → created, attaching the realized repo', async () => {
    const fx = await makeWorkItemFixture();
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme-web' },
      fx.ctx,
    );
    const repo = await connectRepo(fx.workspaceId, 'acme-web');

    const creating = await projectRepoSetService.markCreating(row.id, fx.ctx);
    expect(creating.state).toBe('creating');
    expect(creating.established).toBe(false);

    const created = await projectRepoSetService.attachRealizedRepo(row.id, repo.id, fx.ctx);
    // The target state is DERIVED from where the row sat: a row Motir was creating
    // becomes `created`, never `connected`.
    expect(created.state).toBe('created');
    expect(created.established).toBe(true);
    expect(created.realizedRepo).toMatchObject({
      id: repo.id,
      owner: 'acme',
      name: 'acme-web',
      repoRef: 'acme/acme-web',
      defaultBranch: 'main',
      archived: false,
    });
  });

  it('runs proposed → connected for an EXISTING repo — how a monorepo collapses the set', async () => {
    const fx = await makeWorkItemFixture();
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme-monorepo' },
      fx.ctx,
    );
    const repo = await connectRepo(fx.workspaceId, 'acme-monorepo');
    const connected = await projectRepoSetService.attachRealizedRepo(row.id, repo.id, fx.ctx);
    expect(connected.state).toBe('connected');
    expect(connected.established).toBe(true);
  });

  it('records WHY a row failed, and lets it be RETRIED (failed is not terminal)', async () => {
    const fx = await makeWorkItemFixture();
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme-web' },
      fx.ctx,
    );
    await projectRepoSetService.markCreating(row.id, fx.ctx);
    const failed = await projectRepoSetService.markFailed(
      row.id,
      'Not an admin of the target organization.',
      fx.ctx,
    );
    expect(failed.state).toBe('failed');
    expect(failed.failureReason).toBe('Not an admin of the target organization.');

    // …and the reason is CLEARED on the retry, so a recovered row does not carry the
    // stale reason for a failure it got past.
    const retried = await projectRepoSetService.markCreating(row.id, fx.ctx);
    expect(retried.state).toBe('creating');
    expect(retried.failureReason).toBeNull();
  });

  it('lets a FAILED row fall back to connect-existing or skip', async () => {
    const fx = await makeWorkItemFixture();
    const a = await projectRepoSetService.addRow(fx.projectId, { role: 'api', name: 'a' }, fx.ctx);
    const b = await projectRepoSetService.addRow(fx.projectId, { role: 'api', name: 'b' }, fx.ctx);
    for (const row of [a, b]) {
      await projectRepoSetService.markCreating(row.id, fx.ctx);
      await projectRepoSetService.markFailed(row.id, 'rate limited', fx.ctx);
    }
    const repo = await connectRepo(fx.workspaceId, 'a');
    expect((await projectRepoSetService.attachRealizedRepo(a.id, repo.id, fx.ctx)).state).toBe(
      'connected',
    );
    expect((await projectRepoSetService.skipRow(b.id, fx.ctx)).state).toBe('skipped');
  });

  it('leaves the OTHER rows untouched when one fails — rows are independent', async () => {
    // ADR §4.2: one row's failure does nothing to the others, and nothing is rolled
    // back. Partial establishment is recorded, not an all-or-nothing gate.
    const fx = await makeWorkItemFixture();
    const web = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme-web' },
      fx.ctx,
    );
    const api = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'api', name: 'acme-api' },
      fx.ctx,
    );
    const infra = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'infra', name: 'acme-infra' },
      fx.ctx,
    );
    const repo = await connectRepo(fx.workspaceId, 'acme-web');
    await projectRepoSetService.markCreating(web.id, fx.ctx);
    await projectRepoSetService.attachRealizedRepo(web.id, repo.id, fx.ctx);
    await projectRepoSetService.markCreating(api.id, fx.ctx);
    await projectRepoSetService.markFailed(api.id, 'org policy forbids repo creation', fx.ctx);
    await projectRepoSetService.skipRow(infra.id, fx.ctx);

    const rows = await projectRepoSetService.listByProject(fx.projectId, fx.ctx);
    expect(rows.map((r) => r.state)).toEqual(['created', 'failed', 'skipped']);
    expect(rows.map((r) => r.established)).toEqual([true, false, false]);
    expect(rows[1]!.failureReason).toBe('org policy forbids repo creation');
  });
});

describe('the establish machine — the transitions it REJECTS', () => {
  it('refuses to skip the creating step (proposed → created)', async () => {
    const fx = await makeWorkItemFixture();
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'w' },
      fx.ctx,
    );
    await expect(
      projectRepoSetService.transitionRow(row.id, 'created', fx.ctx),
    ).rejects.toBeInstanceOf(ProjectRepoStateTransitionError);
  });

  it('names the legal targets on a rejection so the caller can self-correct', async () => {
    const fx = await makeWorkItemFixture();
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'w' },
      fx.ctx,
    );
    await expect(
      projectRepoSetService.transitionRow(row.id, 'created', fx.ctx),
    ).rejects.toMatchObject({
      code: 'PROJECT_REPO_ILLEGAL_TRANSITION',
      from: 'proposed',
      to: 'created',
    });
  });

  it('refuses EVERY hop out of a SETTLED row (created / connected / skipped)', async () => {
    const fx = await makeWorkItemFixture();
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'w' },
      fx.ctx,
    );
    await projectRepoSetService.skipRow(row.id, fx.ctx);
    for (const target of ['proposed', 'creating', 'created', 'connected', 'failed'] as const) {
      await expect(
        projectRepoSetService.transitionRow(row.id, target, fx.ctx, {
          failureReason: 'x',
        }),
      ).rejects.toBeInstanceOf(ProjectRepoStateTransitionError);
    }
    expect((await adminDb.projectRepo.findUnique({ where: { id: row.id } }))?.state).toBe(
      'skipped',
    );
  });

  it('refuses to RE-ATTACH a different repo to a settled row — no silent overwrite', async () => {
    // Silently re-pointing which repository a project's code lives in is exactly the
    // corruption the uniqueness rules exist to prevent; it must be an error.
    const fx = await makeWorkItemFixture();
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'w' },
      fx.ctx,
    );
    const first = await connectRepo(fx.workspaceId, 'first');
    const second = await connectRepo(fx.workspaceId, 'second');
    await projectRepoSetService.attachRealizedRepo(row.id, first.id, fx.ctx);
    await expect(
      projectRepoSetService.attachRealizedRepo(row.id, second.id, fx.ctx),
    ).rejects.toBeInstanceOf(ProjectRepoStateTransitionError);
    expect((await adminDb.projectRepo.findUnique({ where: { id: row.id } }))?.githubRepoId).toBe(
      first.id,
    );
  });

  it('refuses a move to failed with NO reason — partial failure is recorded, not inferred', async () => {
    const fx = await makeWorkItemFixture();
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'w' },
      fx.ctx,
    );
    await projectRepoSetService.markCreating(row.id, fx.ctx);
    await expect(
      projectRepoSetService.transitionRow(row.id, 'failed', fx.ctx),
    ).rejects.toBeInstanceOf(ProjectRepoInvalidFieldError);
    await expect(projectRepoSetService.markFailed(row.id, '   ', fx.ctx)).rejects.toBeInstanceOf(
      ProjectRepoInvalidFieldError,
    );
  });

  it('lets only ONE of two concurrent transitions win, and the loser does not clobber it', async () => {
    // The row lock + re-read under it is the lost-update guard: the legality of a
    // hop is derived from the current state, so the state must not move between the
    // read and the write. Both outcomes are legitimate races — what must NOT happen
    // is both succeeding, or the row ending up in the loser's state.
    const fx = await makeWorkItemFixture();
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'w' },
      fx.ctx,
    );
    const results = await Promise.allSettled([
      projectRepoSetService.markCreating(row.id, fx.ctx),
      projectRepoSetService.skipRow(row.id, fx.ctx),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(
      ProjectRepoStateTransitionError,
    );
    const persisted = await adminDb.projectRepo.findUnique({ where: { id: row.id } });
    expect(persisted?.state).toBe(
      (fulfilled[0] as PromiseFulfilledResult<{ state: string }>).value.state,
    );
  });

  it('404s a transition on a row that does not exist (or belongs to another tenant)', async () => {
    const fx = await makeWorkItemFixture();
    await expect(projectRepoSetService.markCreating('nope', fx.ctx)).rejects.toBeInstanceOf(
      ProjectRepoNotFoundError,
    );
  });
});

// ── Editing the set before it is executed ──────────────────────────────────

describe('editing the set', () => {
  it('renames, re-roles and re-seeds a PROPOSED row', async () => {
    const fx = await makeWorkItemFixture();
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme-web' },
      fx.ctx,
    );
    const patched = await projectRepoSetService.patchRow(
      row.id,
      { name: 'acme-frontend', role: 'other', label: 'the SPA', seedSource: 'initialised' },
      fx.ctx,
    );
    expect(patched).toMatchObject({
      name: 'acme-frontend',
      role: 'other',
      label: 'the SPA',
      seedSource: 'initialised',
    });
  });

  it('does NOT re-derive seedSource when only the role changes — an edit is a decision', async () => {
    const fx = await makeWorkItemFixture();
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme' },
      fx.ctx,
    );
    expect(row.seedSource).toBe(SEED_SOURCE_PLATFORM_STARTER);
    const patched = await projectRepoSetService.patchRow(row.id, { role: 'api' }, fx.ctx);
    // Rewriting it silently would freeze a GUESS in a column recording a DECISION —
    // the defect docs/decisions/target-repo-attribution.md §3 names.
    expect(patched.seedSource).toBe(SEED_SOURCE_PLATFORM_STARTER);
  });

  it('renames a FAILED row (ADR §1.5 — a collision never dead-ends a row)', async () => {
    const fx = await makeWorkItemFixture();
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme' },
      fx.ctx,
    );
    await projectRepoSetService.markCreating(row.id, fx.ctx);
    await projectRepoSetService.markFailed(row.id, 'name already exists on the account', fx.ctx);
    const patched = await projectRepoSetService.patchRow(row.id, { name: 'acme-2' }, fx.ctx);
    expect(patched.name).toBe('acme-2');
  });

  it('refuses to rename a CREATING or SETTLED row, but still accepts a label', async () => {
    const fx = await makeWorkItemFixture();
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme' },
      fx.ctx,
    );
    await projectRepoSetService.markCreating(row.id, fx.ctx);
    await expect(
      projectRepoSetService.patchRow(row.id, { name: 'acme-renamed' }, fx.ctx),
    ).rejects.toBeInstanceOf(ProjectRepoInvalidFieldError);
    // A label is a human annotation that drives nothing, so it stays editable.
    expect(
      (await projectRepoSetService.patchRow(row.id, { label: 'in flight' }, fx.ctx)).label,
    ).toBe('in flight');

    const repo = await connectRepo(fx.workspaceId, 'acme');
    await projectRepoSetService.attachRealizedRepo(row.id, repo.id, fx.ctx);
    await expect(
      projectRepoSetService.patchRow(row.id, { name: 'acme-renamed' }, fx.ctx),
    ).rejects.toBeInstanceOf(ProjectRepoInvalidFieldError);
  });

  it('lets a row keep its own name on a no-op rename (it must not collide with itself)', async () => {
    const fx = await makeWorkItemFixture();
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme' },
      fx.ctx,
    );
    expect((await projectRepoSetService.patchRow(row.id, { name: 'acme' }, fx.ctx)).name).toBe(
      'acme',
    );
  });

  it('rejects a rename onto ANOTHER row of the set, case-insensitively', async () => {
    const fx = await makeWorkItemFixture();
    await projectRepoSetService.addRow(fx.projectId, { role: 'web', name: 'acme-web' }, fx.ctx);
    const api = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'api', name: 'acme-api' },
      fx.ctx,
    );
    await expect(
      projectRepoSetService.patchRow(api.id, { name: 'ACME-WEB' }, fx.ctx),
    ).rejects.toBeInstanceOf(ProjectRepoNameTakenError);
  });

  it('rejects a name whose SHAPE no host would accept', async () => {
    // Shape only — whether a name is AVAILABLE is a host mechanic the creation
    // primitive learns, never asserted here.
    const fx = await makeWorkItemFixture();
    for (const name of ['', '   ', 'has spaces', 'sla/sh', 'ünïcode', '.', '..', 'x'.repeat(101)]) {
      await expect(
        projectRepoSetService.addRow(fx.projectId, { role: 'web', name }, fx.ctx),
      ).rejects.toBeInstanceOf(ProjectRepoInvalidFieldError);
    }
  });

  it('removes a row idempotently, WITHOUT touching the repository it realized', async () => {
    // A created repo is a real artifact in the user's own account; deleting it to
    // tidy a record would be strictly worse than reporting the truth (ADR §4.2).
    const fx = await makeWorkItemFixture();
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme' },
      fx.ctx,
    );
    const repo = await connectRepo(fx.workspaceId, 'acme');
    await projectRepoSetService.attachRealizedRepo(row.id, repo.id, fx.ctx);

    await projectRepoSetService.removeRow(row.id, fx.ctx);
    const projectRepoRow = await adminDb.projectRepo.findUnique({ where: { id: row.id } });
    expect(projectRepoRow).toBeNull();
    const githubRepoRow = await adminDb.githubRepo.findUnique({ where: { id: repo.id } });
    expect(githubRepoRow).not.toBeNull();
    // …and a double-submit is a no-op, not a 404.
    await expect(projectRepoSetService.removeRow(row.id, fx.ctx)).resolves.toBeUndefined();

    // The un-claimed repo is now attachable to another row.
    const replacement = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme' },
      fx.ctx,
    );
    expect(
      (await projectRepoSetService.attachRealizedRepo(replacement.id, repo.id, fx.ctx)).established,
    ).toBe(true);
  });
});

describe('SET-level ownership (ADR §3)', () => {
  it('records the ownership + target account for the whole set, not per row', async () => {
    const fx = await makeWorkItemFixture();
    await projectRepoSetService.addRow(fx.projectId, { role: 'web', name: 'acme-web' }, fx.ctx);
    const set = await projectRepoSetService.setOwnership(
      fx.projectId,
      { ownership: 'motir', targetAccount: 'motir-projects' },
      fx.ctx,
    );
    expect(set.ownership).toBe('motir');
    expect(set.targetAccount).toBe('motir-projects');
    // …and it survives a re-read (it is on the project row, so 9.3.7 finds every
    // claimable repo of a project with ONE project-scoped read).
    const reread = await projectRepoSetService.getSet(fx.projectId, fx.ctx);
    expect(reread.ownership).toBe('motir');
    expect(reread.rows).toHaveLength(1);
  });

  it('rejects a blank or over-long target account', async () => {
    const fx = await makeWorkItemFixture();
    for (const targetAccount of ['', '   ', 'x'.repeat(101)]) {
      await expect(
        projectRepoSetService.setOwnership(
          fx.projectId,
          { ownership: 'user', targetAccount },
          fx.ctx,
        ),
      ).rejects.toBeInstanceOf(ProjectRepoInvalidFieldError);
    }
  });
});

// ── The names a dispatch may resolve to ────────────────────────────────────

describe('resolveProjectRepoNames', () => {
  it('agrees with listConnectedRepoNames on SPELLING for the same repository', async () => {
    // The whole point: a pin validated against the PROJECT's set and one validated
    // against the WORKSPACE's connected set must never disagree on the name, or the
    // column and `.motir.json` would name different directories.
    const fx = await makeWorkItemFixture();
    const repo = await connectRepo(fx.workspaceId, 'Acme-Core', { owner: 'Acme' });
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme-core' },
      fx.ctx,
    );
    await projectRepoSetService.attachRealizedRepo(row.id, repo.id, fx.ctx);

    const projectNames = await projectRepoSetService.resolveProjectRepoNames(fx.projectId, fx.ctx);
    const workspaceNames = await listConnectedRepoNames(fx.ctx);
    expect(projectNames.map((n) => n.name)).toEqual(['Acme-Core']);
    expect(projectNames.map((n) => n.name)).toEqual(workspaceNames.map((n) => n.name));
    expect(projectNames.map((n) => n.repoRef)).toEqual(workspaceNames.map((n) => n.repoRef));
  });

  it('drops straight into resolveDispatchTargetRepo with no adapter', async () => {
    // The result EXTENDS ConnectedRepoName, so MOTIR-1783 consumes it unchanged —
    // one established row is the unambiguous default; two is `null`, never a guess.
    const fx = await makeWorkItemFixture();
    const webRow = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme-web' },
      fx.ctx,
    );
    const webRepo = await connectRepo(fx.workspaceId, 'acme-web');
    await projectRepoSetService.attachRealizedRepo(webRow.id, webRepo.id, fx.ctx);
    let names = await projectRepoSetService.resolveProjectRepoNames(fx.projectId, fx.ctx);
    expect(resolveDispatchTargetRepo(null, names)).toBe('acme-web');

    const apiRow = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'api', name: 'acme-api' },
      fx.ctx,
    );
    const apiRepo = await connectRepo(fx.workspaceId, 'acme-api');
    await projectRepoSetService.attachRealizedRepo(apiRow.id, apiRepo.id, fx.ctx);
    names = await projectRepoSetService.resolveProjectRepoNames(fx.projectId, fx.ctx);
    expect(resolveDispatchTargetRepo(null, names)).toBeNull();
    expect(resolveDispatchTargetRepo('acme-api', names)).toBe('acme-api');
  });

  it('omits a SKIPPED role entirely — the honest "Motir does not know" signal', async () => {
    // ADR §5.3: a role that matches no established row leaves `targetRepo` null, the
    // same signal the shipped resolver emits and the code-index loop renders.
    const fx = await makeWorkItemFixture();
    const web = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme-web' },
      fx.ctx,
    );
    const api = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'api', name: 'acme-api' },
      fx.ctx,
    );
    const repo = await connectRepo(fx.workspaceId, 'acme-web');
    await projectRepoSetService.attachRealizedRepo(web.id, repo.id, fx.ctx);
    await projectRepoSetService.skipRow(api.id, fx.ctx);

    const names = await projectRepoSetService.resolveProjectRepoNames(fx.projectId, fx.ctx);
    expect(names.map((n) => n.role)).toEqual(['web']);
  });

  it('is empty for a project with no set at all', async () => {
    const fx = await makeWorkItemFixture();
    expect(await projectRepoSetService.resolveProjectRepoNames(fx.projectId, fx.ctx)).toEqual([]);
  });
});

// ── Delete contracts ───────────────────────────────────────────────────────

describe('delete contracts', () => {
  it('deleting a PROJECT removes its set rows', async () => {
    const fx = await makeWorkItemFixture();
    await projectRepoSetService.addRow(fx.projectId, { role: 'web', name: 'acme-web' }, fx.ctx);
    await projectRepoSetService.addRow(fx.projectId, { role: 'api', name: 'acme-api' }, fx.ctx);
    const projectRepoCount = await adminDb.projectRepo.count({
      where: { projectId: fx.projectId },
    });
    expect(projectRepoCount).toBe(2);
    await adminDb.project.delete({ where: { id: fx.projectId } });
    const projectRepoCount2 = await adminDb.projectRepo.count({
      where: { projectId: fx.projectId },
    });
    expect(projectRepoCount2).toBe(0);
  });

  it('deleting a WORKSPACE removes its projects’ set rows', async () => {
    const fx = await makeWorkItemFixture();
    await projectRepoSetService.addRow(fx.projectId, { role: 'web', name: 'acme-web' }, fx.ctx);
    await adminDb.workspace.delete({ where: { id: fx.workspaceId } });
    const projectRepoCount = await adminDb.projectRepo.count({
      where: { workspaceId: fx.workspaceId },
    });
    expect(projectRepoCount).toBe(0);
  });

  it('deleting a GithubRepo leaves the row with a NULL realized repo — not a lost plan', async () => {
    // The plan (role + name + seed source) survives so the row can be
    // re-established, and `established` — not `state` — is what tells a consumer the
    // repository is gone. `state` records what HAPPENED; `established` what is TRUE.
    const fx = await makeWorkItemFixture();
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme-web' },
      fx.ctx,
    );
    const repo = await connectRepo(fx.workspaceId, 'acme-web');
    await projectRepoSetService.markCreating(row.id, fx.ctx);
    await projectRepoSetService.attachRealizedRepo(row.id, repo.id, fx.ctx);

    await adminDb.githubRepo.delete({ where: { id: repo.id } });

    const rows = await projectRepoSetService.listByProject(fx.projectId, fx.ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: 'acme-web',
      role: 'web',
      seedSource: SEED_SOURCE_PLATFORM_STARTER,
      // The state still reads honestly: this row WAS created.
      state: 'created',
      realizedRepo: null,
      // …but it no longer names a repository that exists, so nothing may be pinned
      // to it.
      established: false,
    });
    expect(await projectRepoSetService.resolveProjectRepoNames(fx.projectId, fx.ctx)).toEqual([]);
  });
});

// ── Access gating ──────────────────────────────────────────────────────────

describe('access gating', () => {
  it('hides another tenant’s project behind the SAME error as a nonexistent one', async () => {
    // The no-existence-leak posture, asserted rather than described: a cross-tenant
    // project id and an id that simply does not exist must produce the IDENTICAL
    // error code (→ 404), so a caller can never use the response to confirm that a
    // foreign project is real.
    const a = await makeWorkItemFixture({ name: 'Tenant A', identifier: 'AAA' });
    const b: WorkItemFixture = await makeWorkItemFixture({ name: 'Tenant B', identifier: 'BBB' });

    const crossTenantRead = await projectRepoSetService.getSet(b.projectId, a.ctx).catch((e) => e);
    const nonexistentRead = await projectRepoSetService
      .getSet('no-such-project', a.ctx)
      .catch((e) => e);
    expect(crossTenantRead.code).toBe('PROJECT_NOT_FOUND');
    expect(nonexistentRead.code).toBe(crossTenantRead.code);

    await expect(
      projectRepoSetService.addRow(b.projectId, { role: 'web', name: 'sneaky' }, a.ctx),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    const projectRepoCount = await adminDb.projectRepo.count({ where: { projectId: b.projectId } });
    expect(projectRepoCount).toBe(0);
  });

  it('refuses a WRITE from a workspace member who may only browse', async () => {
    // Reads stay browse-gated; the SET writes moved to `repository:manage`
    // (MOTIR-2299). This actor was refused before the change too — a workspace
    // Viewer holds no `work_item:edit` — so what moved is the error CLASS:
    // `PROJECT_ACCESS_DENIED`/`edit` → `PERMISSION_DENIED` naming the key. (The
    // actor used to be a member not added to a `limited` project; that project is
    // Members only since Story MOTIR-6169, so they would not browse it at all.)
    const fx = await makeWorkItemFixture();
    const viewer = await adminDb.user.create({
      data: { email: 'repo-set-viewer@example.com', name: 'Viewer', emailVerified: true },
    });
    await adminDb.workspaceMembership.create({
      data: {
        userId: viewer.id,
        workspaceId: fx.workspaceId,
        workspaceRole: 'viewer',
      },
    });
    const viewerCtx = { userId: viewer.id, workspaceId: fx.workspaceId };

    // They CAN read the set…
    await expect(projectRepoSetService.getSet(fx.projectId, viewerCtx)).resolves.toMatchObject({
      rows: [],
    });
    // …but not change it.
    await expect(
      projectRepoSetService.addRow(fx.projectId, { role: 'web', name: 'nope' }, viewerCtx),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED', permission: 'repository:manage' });
  });

  it('refuses a PROJECT MEMBER who CAN edit — the hole this card closes', async () => {
    // THE TIGHTENING, asserted directly (MOTIR-2299). Before this card the set
    // writes were `assertCanEdit`, so any project MEMBER could detach a
    // project's repository. They can edit work items and they are refused here.
    const fx = await makeWorkItemFixture();
    const member = await adminDb.user.create({
      data: { email: 'repo-set-member@example.com', name: 'Member', emailVerified: true },
    });
    await adminDb.workspaceMembership.create({
      data: {
        userId: member.id,
        workspaceId: fx.workspaceId,
        workspaceRole: 'member',
      },
    });
    await adminDb.projectMembership.create({
      data: {
        userId: member.id,
        projectId: fx.projectId,
        workspaceId: fx.workspaceId,
      },
    });
    const memberCtx = { userId: member.id, workspaceId: fx.workspaceId };

    // The capability they DO hold — editing work items — is untouched.
    const held = await projectAccessService.getPermissions(fx.projectId, memberCtx);
    expect(held.has('work_item:edit')).toBe(true);
    expect(held.has('repository:manage')).toBe(false);

    // They still SEE where the code lives…
    await expect(projectRepoSetService.getSet(fx.projectId, memberCtx)).resolves.toMatchObject({
      rows: [],
    });
    // …and can no longer change the set.
    await expect(
      projectRepoSetService.addRow(fx.projectId, { role: 'web', name: 'nope' }, memberCtx),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED', permission: 'repository:manage' });
  });

  it('a NON-BROWSER gets 404, not 403', async () => {
    const fx = await makeWorkItemFixture();
    const outsider = await adminDb.user.create({
      data: { email: 'repo-set-outsider@example.com', name: 'Out', emailVerified: true },
    });
    await adminDb.workspaceMembership.create({
      data: {
        userId: outsider.id,
        workspaceId: fx.workspaceId,
        workspaceRole: 'member',
      },
    });
    await setProjectAccess(adminDb, fx.projectId, 'members');
    await expect(
      projectRepoSetService.addRow(
        fx.projectId,
        { role: 'web', name: 'nope' },
        { userId: outsider.id, workspaceId: fx.workspaceId },
      ),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });
});
