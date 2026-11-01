import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { toWorkItemDto } from '@/lib/mappers/workItemMappers';
import { presentWorkItemDetail, workItemDetailSchema } from '@/lib/api/v1/workItems/schema';
import { presentMcpWorkItem, presentMcpReadyDispatch } from '@/lib/mcp/payloads/workItems';
import { resolveItemDispatchRepo } from '@/lib/workItems/dispatchRepo';
import { adminDb } from '../helpers/adminDb';
import { linkPrByIdentifier } from '../helpers/prLink';
import { truncateAuthTables } from '../helpers/db';
import { linkWorkspaceReposToProject } from '../helpers/projectRepoLink';

// STORY GATE for MOTIR-2725 — the repository SET (Subtask MOTIR-2417).
//
// This file asserts only what a GATE can: the seams BETWEEN the story's
// subtasks, measured on their real, assembled behaviour. It deliberately does
// not re-list the per-state rendering (MOTIR-2415 / MOTIR-2416 own that) or the
// gate's own rules (MOTIR-2729 owns those).
//
// The five things only this file is positioned to see:
//
//   1. The write→read SEAM — one card, real Postgres, THREE consumers. Two
//      mocked halves agreeing is exactly the state in which a key has drifted.
//   2. The completion gate against a REAL set, driven by real webhook
//      deliveries, against the database that stores the set.
//   3. The migration's assembled result — over a seeded fixture with pinned,
//      role-pinned and unpinned rows, not one example.
//   4. OPTIONALITY as a structural property, not a rendering.
//   5. DISPATCH unchanged — this story's boundary, asserted rather than intended.
//
// Surface agreement (item 4 of the card) is asserted where it can actually
// fail — over the shared component and the shared catalog — in
// `tests/components/quick-view-repository-set.test.ts`. Repeating it here
// against a second copy of the literal is the very thing that rule forbids.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-repo-set-gate';
const CORE = { name: 'motir-core', providerRepoId: '8001', defaultBranch: 'main' };
const AI = { name: 'motir-ai', providerRepoId: '8002', defaultBranch: 'trunk' };

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

beforeEach(async () => {
  await truncateAuthTables();
});

async function scenario(email: string, repos = [CORE, AI]) {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: 'ACME',
  });
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: INSTALLATION_ID,
      accountLogin: 'moooon',
      accountType: 'Organization',
    },
    repos: repos.map((r) => ({
      providerRepoId: r.providerRepoId,
      owner: 'moooon',
      name: r.name,
      defaultBranch: r.defaultBranch,
      archived: false,
    })),
  });
  await linkWorkspaceReposToProject({
    workspaceId: workspace.id,
    projectId: project.id,
    names: repos.map((repo) => repo.name),
  });
  return { user, workspace, project, ctx: { userId: user.id, workspaceId: workspace.id } };
}

function prPayload(o: {
  action: string;
  identifier: string;
  repo: typeof CORE;
  number: number;
  baseRef?: string;
  state?: 'open' | 'closed';
  merged?: boolean;
}) {
  return {
    action: o.action,
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(o.repo.providerRepoId) },
    pull_request: {
      number: o.number,
      state: o.state ?? 'open',
      merged: o.merged ?? false,
      title: `Some change (${o.identifier})`,
      head: { ref: `subtask/${o.identifier}-change` },
      base: { ref: o.baseRef ?? o.repo.defaultBranch },
      user: { id: 4242 },
    },
  };
}

// The EXPLICIT link, written before the delivery that asserts on it. Since
// MOTIR-3674 the `Some change (KEY)` title above names the card to a reader and
// to nothing else — an unlinked delivery resolves `no_work_item` and moves
// nothing. Every test here is about the completion GATE, so the link is setup
// and the gate assertions are unchanged.
const link = (identifier: string, repo: typeof CORE, number: number) =>
  linkPrByIdentifier({
    identifier,
    owner: 'moooon',
    name: repo.name,
    number,
    headRef: `subtask/${identifier}-change`,
    baseRef: repo.defaultBranch,
  });

describe('1 — the write→read SEAM: one card, real Postgres, three consumers', () => {
  it('a two-element set written through the service reads back, in order, on every shape', async () => {
    const fx = await scenario('seam@example.com');
    const created = await workItemsService.createWorkItem(
      {
        projectId: fx.project.id,
        kind: 'task',
        title: 'Ships in two repositories',
        targetRepos: ['motir-ai', 'motir-core'],
      },
      fx.ctx,
    );

    // The row, then each consumer built FROM the row — never from the create's
    // return value, which is the half a drifted key would still agree with.
    const row = await adminDb.workItem.findUnique({ where: { id: created.id } });
    const dto = toWorkItemDto(row!);
    const detail = await workItemsService.getIssueDetail(fx.project.id, created.identifier, fx.ctx);
    const publicBody = workItemDetailSchema.parse(presentWorkItemDetail(detail, 0, {}, []));
    const mcp = presentMcpWorkItem(dto);

    for (const shape of [dto, publicBody, mcp]) {
      expect(shape.targetRepos).toEqual(['motir-ai', 'motir-core']);
      // The relationship, not a repeated literal: the scalar IS element 0.
      expect(shape.targetRepo).toBe(shape.targetRepos[0]);
    }
  });
});

describe('2 — the completion gate against a REAL set, driven by real deliveries', () => {
  it('HOLDS while a linked pull request is open, and completes on its merge', async () => {
    const fx = await scenario('gate@example.com');
    const item = await workItemsService.createWorkItem(
      {
        projectId: fx.project.id,
        kind: 'task',
        title: 'Two repositories',
        targetRepos: ['motir-core', 'motir-ai'],
      },
      fx.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);

    const open = async (repo: typeof CORE, n: number) => {
      await link(item.identifier, repo, n);
      return githubWebhookService.handleEvent(
        'pull_request',
        prPayload({ action: 'opened', identifier: item.identifier, repo, number: n }),
      );
    };
    const merge = (repo: typeof CORE, n: number) =>
      githubWebhookService.handleEvent(
        'pull_request',
        prPayload({
          action: 'closed',
          identifier: item.identifier,
          repo,
          number: n,
          state: 'closed',
          merged: true,
        }),
      );

    // Both pull requests are linked and open. Since MOTIR-10135 a repository with
    // NO pull request no longer holds a card — completion counts the LINKED pull
    // requests — so the hold here is the delivery set's: motir-ai's is still open.
    await open(CORE, 1);
    await open(AI, 2);
    expect(await merge(CORE, 1)).toMatchObject({ outcome: 'deferred_incomplete_delivery_set' });
    // Held, NOT done — which is this test's claim. The status the hold leaves it
    // at is `implemented` since MOTIR-2999: an opened pull request says the code
    // is pushed, and only a green build makes it reviewable. No check ever
    // reported here, so it is still where the delivery left it.
    expect((await adminDb.workItem.findUnique({ where: { id: item.id } }))!.status).toBe(
      'implemented',
    );

    expect(await merge(AI, 2)).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
    expect((await adminDb.workItem.findUnique({ where: { id: item.id } }))!.status).toBe('done');
  });

  it('the SURFACE lists a repository with no pull request, and the GATE completes the card anyway', async () => {
    // Since MOTIR-10135 the two answer different questions on purpose: the panel
    // still draws every repository on the list (its placeholder rows are out of
    // that card's scope), and the gate counts the LINKED pull requests — so a
    // repository the run found needed no change no longer holds the card. Both
    // sides are read from the live row, after a real delivery.
    const fx = await scenario('agree@example.com');
    const item = await workItemsService.createWorkItem(
      {
        projectId: fx.project.id,
        kind: 'task',
        title: 'Two repositories',
        targetRepos: ['motir-core', 'motir-ai'],
      },
      fx.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    await link(item.identifier, CORE, 1);
    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened', identifier: item.identifier, repo: CORE, number: 1 }),
    );
    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({
        action: 'closed',
        identifier: item.identifier,
        repo: CORE,
        number: 1,
        state: 'closed',
        merged: true,
      }),
    );

    const row = await adminDb.workItem.findUnique({ where: { id: item.id } });
    const delivery = await workItemsService.listRepoDelivery(item.id, row!.targetRepos, fx.ctx);
    // The panel's view…
    expect(delivery).toEqual([
      { repo: 'motir-core', state: 'delivered', primary: true, role: 'other' },
      { repo: 'motir-ai', state: 'awaiting', primary: false, role: 'other' },
    ]);
    // …and the gate's: its one linked pull request merged onto the trunk, so the
    // card is done whatever else the list names.
    expect(row!.status).toBe('done');
  });
});

describe('3 — the migration’s assembled result, over a seeded fixture', () => {
  it('every pre-existing row shape resolves the SAME dispatch repo after the backfill', async () => {
    const fx = await scenario('migrate@example.com', [CORE]);
    const make = (title: string) =>
      workItemsService.createWorkItem({ projectId: fx.project.id, kind: 'task', title }, fx.ctx);
    const pinned = await make('pinned');
    const rolePinned = await make('role-pinned');
    const unpinned = await make('unpinned');

    // Put all three back into the PRE-migration shape, then run the migration's
    // OWN backfill statement, read off disk so the assertion cannot drift from
    // the shipped SQL.
    await adminDb.workItem.update({
      where: { id: pinned.id },
      data: { targetRepo: 'motir-core', targetRepos: [] },
    });
    await adminDb.workItem.update({
      where: { id: rolePinned.id },
      // ⚠️ `targetRepoRole` retired by MOTIR-3040 (§A3). This row is now simply
      // the UNPINNED shape, which is what the backfill assertion below reads.
      data: { targetRepo: null, targetRepos: [] },
    });
    await adminDb.workItem.update({
      where: { id: unpinned.id },
      data: { targetRepo: null, targetRepos: [] },
    });

    const before = await Promise.all(
      [pinned, rolePinned, unpinned].map(async (i) => {
        const r = await adminDb.workItem.findUnique({ where: { id: i.id } });
        return resolveItemDispatchRepo(r!.targetRepo, fx.project.id, fx.ctx);
      }),
    );

    const sql = readFileSync(
      path.join(
        process.cwd(),
        'prisma/migrations/20260818110000_work_item_repository_set/migration.sql',
      ),
      'utf8',
    );
    await adminDb.$executeRawUnsafe(sql.match(/UPDATE "work_item"[\s\S]*?;/)![0]);

    const after = await Promise.all(
      [pinned, rolePinned, unpinned].map(async (i) => {
        const r = await adminDb.workItem.findUnique({ where: { id: i.id } });
        return resolveItemDispatchRepo(r!.targetRepo, fx.project.id, fx.ctx);
      }),
    );

    // The story's back-compat contract, asserted directly rather than inferred.
    expect(after).toEqual(before);
    // And the sets the backfill produced, per row shape.
    const rows = await Promise.all(
      [pinned, rolePinned, unpinned].map((i) =>
        adminDb.workItem.findUnique({ where: { id: i.id } }),
      ),
    );
    expect(rows.map((r) => r!.targetRepos)).toEqual([['motir-core'], [], []]);
  });
});

describe('4 — optionality is STRUCTURAL, not incidental', () => {
  it('a card can be created, read and completed carrying NO repository', async () => {
    // The story's oldest rule and the one that erodes. Not a rendering
    // assertion: there is no write path that requires the field, and the
    // completion gate abstains, so nothing anywhere can start asking for it.
    const fx = await scenario('optional@example.com', [CORE]);
    const item = await workItemsService.createWorkItem(
      { projectId: fx.project.id, kind: 'task', title: 'No repository' },
      fx.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);

    const row = await adminDb.workItem.findUnique({ where: { id: item.id } });
    expect(row!.targetRepos).toEqual([]);
    expect(await workItemsService.listRepoDelivery(item.id, row!.targetRepos, fx.ctx)).toEqual([]);

    await link(item.identifier, CORE, 9);
    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened', identifier: item.identifier, repo: CORE, number: 9 }),
    );
    // It completes on the shipped rules, with no new outcome.
    expect(
      await githubWebhookService.handleEvent(
        'pull_request',
        prPayload({
          action: 'closed',
          identifier: item.identifier,
          repo: CORE,
          number: 9,
          state: 'closed',
          merged: true,
        }),
      ),
    ).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
  });

  it('clearing the set is a legal write, on both the create and the patch surface', async () => {
    const fx = await scenario('clear@example.com', [CORE]);
    const item = await workItemsService.createWorkItem(
      {
        projectId: fx.project.id,
        kind: 'task',
        title: 'Pinned then cleared',
        targetRepos: ['motir-core'],
      },
      fx.ctx,
    );
    await workItemsService.updateWorkItem(item.id, { targetRepos: [] }, fx.ctx);
    const row = await adminDb.workItem.findUnique({ where: { id: item.id } });
    expect(row!.targetRepos).toEqual([]);
    expect(row!.targetRepo).toBeNull();
  });
});

describe('5 — a `decision` card, and 6 — DISPATCH unchanged', () => {
  it('a `decision` card carries a repository like any other kind — no special path', async () => {
    // The case existing data puts in front of it: MOTIR-2400 is a decision card
    // pinned to motir-core that shipped an ADR there. The rule settled in
    // MOTIR-2413 is a PLANNING convention, so there is no product branch at all.
    const fx = await scenario('decision@example.com', [CORE]);
    const item = await workItemsService.createWorkItem(
      {
        projectId: fx.project.id,
        kind: 'task',
        title: 'A decision that ships an ADR',
        type: 'decision',
        targetRepos: ['motir-core'],
      },
      fx.ctx,
    );
    const row = await adminDb.workItem.findUnique({ where: { id: item.id } });
    expect(row!.type).toBe('decision');
    expect(row!.targetRepos).toEqual(['motir-core']);
    expect(await workItemsService.listRepoDelivery(item.id, row!.targetRepos, fx.ctx)).toEqual([
      { repo: 'motir-core', state: 'awaiting', primary: true, role: 'other' },
    ]);
  });

  it('the MCP DISPATCH payload is single-valued for every set size — the story’s boundary', async () => {
    const fx = await scenario('dispatch@example.com');
    await workItemsService.createWorkItem(
      {
        projectId: fx.project.id,
        kind: 'task',
        title: 'Two repositories',
        targetRepos: ['motir-ai', 'motir-core'],
      },
      fx.ctx,
    );

    const dispatch = await workItemsService.getNextReady(fx.project.id, {}, fx.ctx);
    const payload = presentMcpReadyDispatch(dispatch!, 0);

    // The primary, with its OWN mirrored default branch — and NO set.
    expect(payload).toMatchObject({ targetRepo: 'motir-ai', targetRepoDefaultBranch: 'trunk' });
    expect(payload).not.toHaveProperty('targetRepos');
  });
});

describe('7 — the design assets are present and complete', () => {
  it('both surfaces ship the three-file set and a surface-table row', () => {
    // `CLAUDE.md`'s three-file rule, asserted rather than assumed — a design PR
    // that merged with two of three files is the failure this catches.
    const dir = path.join(process.cwd(), 'design/work-items');
    const notes = readFileSync(path.join(dir, 'design-notes.md'), 'utf8');
    for (const base of ['repository-set', 'repository-set-quick-view']) {
      expect(readFileSync(path.join(dir, `${base}.mock.html`), 'utf8').length).toBeGreaterThan(0);
      expect(readFileSync(path.join(dir, `${base}.png`)).length).toBeGreaterThan(0);
      // The area's surface table indexes it.
      expect(notes).toContain(`${base}.mock.html`);
    }
  });
});
