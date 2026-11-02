import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma, WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { labelRepository } from '@/lib/repositories/labelRepository';
import { workItemLabelRepository } from '@/lib/repositories/workItemLabelRepository';
import { componentRepository } from '@/lib/repositories/componentRepository';
import { workItemComponentRepository } from '@/lib/repositories/workItemComponentRepository';
import { watcherRepository } from '@/lib/repositories/watcherRepository';
import { createTestUser, createTestWorkItem, makeWorkItemFixture } from '../fixtures';
import type { WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { expectRestrictViolation } from '../helpers/restrictViolation';

// Repository-layer tests for the Story 5.4 data-access leaves (Subtask
// 5.4.1): labelRepository / workItemLabelRepository / componentRepository /
// workItemComponentRepository / watcherRepository, plus the schema-level
// guarantees the migration carries — the case-insensitive uniques (the
// JRACLOUD-24907 wart-fix), the work_item_component RESTRICT backstop (the
// move-or-remove flow's DB guard), the cascades, and the SetNull on a
// component's default assignee. Real Postgres (no mocks), per CLAUDE.md.
// They run as the dev/CI superuser via the `db` singleton (RLS is inert
// under BYPASSRLS — the policies are exercised separately under the
// motir_app role, the multi-tenant-rls suite's pattern); what's proven
// here is the repository contract and the migration-built constraints.
// Writes run inside a real `db.$transaction` to exercise the required-`tx`
// path. The folksonomy/permission/notification BUSINESS rules live in the
// 5.4.2–5.4.5 services and are tested there.
//
// ⚠️ THIS FILE'S WRITES RUN THROUGH `adminDb` ON PURPOSE (MOTIR-2751).
// The header above states the subject: the repository CONTRACT and the
// migration-built CONSTRAINTS, with RLS deliberately inert. Under the non-bypass
// role a cross-workspace read returns [] because the POLICY hid the row — the same
// observation for a different reason, which would make every gate assertion here
// vacuous, and a constraint test that fails with a policy error proves nothing about
// the constraint. So the admin client is what PRESERVES these claims rather than
// weakening them. The policies' own behaviour is proved separately, under the role,
// in the *-rls suites this header already points at.
//
// ⚠️ AND SO DO THIS FILE'S READS (MOTIR-2881). MOTIR-2751 migrated the WRITES and
// left the assertion-side READS on the `@/lib/db` singleton — which under the role
// is `motir_app`, binds no workspace GUC, and returns NOTHING. A refused write says
// so (`42501`); a refused read just returns `null` / `[]` / `0` / `false`, so ten
// assertions here went red and the ones expecting emptiness (`findByNameLower('web')`
// → null, `existsFor` → false) passed for the wrong reason. `readAsOwner` routes them
// through the SAME owner client the writes use, keeping RLS inert as the header says.
//
// One claim did NOT survive that move and is recorded rather than quietly dropped:
// two reads here were written to exercise the repositories' `tx ?? dbRead` FALLBACK arm
// ("both client paths (bare `db` + in-`tx`)"). Under the role that arm no longer
// returns rows to assert on — deliberately, since a read nobody bound cannot see the
// tenant — so those sites now pass a tx like every other read. The arm itself is a
// per-role subject and belongs to `tests/rls/tx-fallback-arm.test.ts` (MOTIR-2815),
// which asserts rows under the owner and EMPTY under `motir_app`; it is not something
// a contract test can carry once the suite's only connection is the restricted role.

beforeEach(async () => {
  // truncateAuthTables truncates `workspace` RESTART IDENTITY CASCADE, which
  // cascades workspace → project → label/component and workspace →
  // work_item → join rows / watchers (all FK chains with onDelete: Cascade),
  // so no dedicated truncate is needed.
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface OrganisationFixture {
  fx: WorkItemFixture;
  issue: WorkItem;
}

async function makeOrganisationFixture(): Promise<OrganisationFixture> {
  const fx = await makeWorkItemFixture();
  const issue = await createTestWorkItem(fx, { kind: 'task', title: 'Organised task' });
  return { fx, issue };
}

/**
 * Run a repository READ through the OWNER client, exactly as this file's writes run.
 * The repository method under test is still what is exercised — only the connection
 * changes, so RLS stays inert (see the header) and an empty answer is the query's own
 * scoping rather than a policy.
 */
function readAsOwner<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return adminDb.$transaction(fn);
}

/** Find-or-create a label + attach it to an issue through the required-`tx` write path. */
async function addLabel(c: OrganisationFixture, name: string): Promise<string> {
  return adminDb.$transaction(async (tx) => {
    const nameLower = name.toLowerCase();
    const existing = await labelRepository.findByNameLower(c.fx.projectId, nameLower, tx);
    const label =
      existing ??
      (await labelRepository.create(
        { workspaceId: c.fx.workspaceId, projectId: c.fx.projectId, name, nameLower },
        tx,
      ));
    await workItemLabelRepository.create({ workItemId: c.issue.id, labelId: label.id }, tx);
    return label.id;
  });
}

async function addComponent(
  c: OrganisationFixture,
  name: string,
  opts: { defaultAssigneeId?: string } = {},
): Promise<string> {
  const component = await adminDb.$transaction(async (tx) =>
    componentRepository.create(
      {
        workspaceId: c.fx.workspaceId,
        projectId: c.fx.projectId,
        name,
        nameLower: name.toLowerCase(),
        defaultAssigneeId: opts.defaultAssigneeId ?? null,
      },
      tx,
    ),
  );
  return component.id;
}

describe('labelRepository + workItemLabelRepository', () => {
  it('find-or-create round-trips: findByNameLower matches case-insensitively, display casing survives', async () => {
    const c = await makeOrganisationFixture();
    const id = await addLabel(c, 'Perf-Q3');

    const found = await adminDb.$transaction(async (tx) =>
      labelRepository.findByNameLower(c.fx.projectId, 'perf-q3', tx),
    );
    expect(found?.id).toBe(id);
    expect(found?.name).toBe('Perf-Q3'); // first-typed display casing
    expect(found?.nameLower).toBe('perf-q3');
  });

  it('enforces case-INSENSITIVE uniqueness per project (the JRACLOUD-24907 wart-fix) while allowing the same name in another project', async () => {
    const c = await makeOrganisationFixture();
    await addLabel(c, 'Performance');

    // Same project, different casing → the unique on (projectId, nameLower) rejects.
    await expect(
      adminDb.$transaction(async (tx) =>
        labelRepository.create(
          {
            workspaceId: c.fx.workspaceId,
            projectId: c.fx.projectId,
            name: 'performance',
            nameLower: 'performance',
          },
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'P2002' });

    // A different project (second tenant) is free to use the same name.
    const other = await makeWorkItemFixture({ name: 'Globex', identifier: 'GLX' });
    const row = await adminDb.$transaction(async (tx) =>
      labelRepository.create(
        {
          workspaceId: other.workspaceId,
          projectId: other.projectId,
          name: 'performance',
          nameLower: 'performance',
        },
        tx,
      ),
    );
    expect(row.id).toBeTruthy();
  });

  it('one join row per issue × label (unique), remove() is an idempotent count', async () => {
    const c = await makeOrganisationFixture();
    const labelId = await addLabel(c, 'backend');

    await expect(
      adminDb.$transaction(async (tx) =>
        workItemLabelRepository.create({ workItemId: c.issue.id, labelId }, tx),
      ),
    ).rejects.toMatchObject({ code: 'P2002' });

    const first = await adminDb.$transaction(async (tx) =>
      workItemLabelRepository.remove(c.issue.id, labelId, tx),
    );
    const second = await adminDb.$transaction(async (tx) =>
      workItemLabelRepository.remove(c.issue.id, labelId, tx),
    );
    expect(first).toBe(1);
    expect(second).toBe(0); // idempotent, no P2025
  });

  it('createMany skips duplicates; createMany/removeMany guard empty input as no-ops', async () => {
    const c = await makeOrganisationFixture();
    const aId = await addLabel(c, 'alpha'); // already attached
    const b = await adminDb.$transaction(async (tx) =>
      labelRepository.create(
        {
          workspaceId: c.fx.workspaceId,
          projectId: c.fx.projectId,
          name: 'beta',
          nameLower: 'beta',
        },
        tx,
      ),
    );

    const inserted = await adminDb.$transaction(async (tx) =>
      workItemLabelRepository.createMany(
        [
          { workItemId: c.issue.id, labelId: aId }, // duplicate → skipped
          { workItemId: c.issue.id, labelId: b.id },
        ],
        tx,
      ),
    );
    expect(inserted).toBe(1);

    // Empty-input guards (coverage gate): no statement, zero counts.
    const emptyCreate = await adminDb.$transaction(async (tx) =>
      workItemLabelRepository.createMany([], tx),
    );
    const emptyRemove = await adminDb.$transaction(async (tx) =>
      workItemLabelRepository.removeMany(c.issue.id, [], tx),
    );
    expect(emptyCreate).toBe(0);
    expect(emptyRemove).toBe(0);

    const removed = await adminDb.$transaction(async (tx) =>
      workItemLabelRepository.removeMany(c.issue.id, [aId, b.id], tx),
    );
    expect(removed).toBe(2);
  });

  it('searchByPrefix is case-insensitive, prefix-anchored, bounded, name-ordered; empty prefix lists bounded', async () => {
    const c = await makeOrganisationFixture();
    for (const name of ['Perf-Q3', 'perf-q4', 'performance', 'backend']) {
      await adminDb.$transaction(async (tx) =>
        labelRepository.create(
          {
            workspaceId: c.fx.workspaceId,
            projectId: c.fx.projectId,
            name,
            nameLower: name.toLowerCase(),
          },
          tx,
        ),
      );
    }

    const hits = await readAsOwner((tx) =>
      labelRepository.searchByPrefix(c.fx.projectId, 'PERF', undefined, tx),
    );
    expect(hits.map((l) => l.name)).toEqual(['Perf-Q3', 'perf-q4', 'performance']);

    const bounded = await readAsOwner((tx) =>
      labelRepository.searchByPrefix(c.fx.projectId, 'perf', 2, tx),
    );
    expect(bounded).toHaveLength(2);

    // Empty prefix = "open the picker before typing": the first `take`
    // existing labels, name-ordered — bounded, never a semantic error.
    const all = await readAsOwner((tx) =>
      labelRepository.searchByPrefix(c.fx.projectId, '', 3, tx),
    );
    expect(all.map((l) => l.nameLower)).toEqual(['backend', 'perf-q3', 'perf-q4']);
  });

  it('countByLabel / countByWorkItem / listByWorkItem serve the guard reads; lockById returns the row or null', async () => {
    const c = await makeOrganisationFixture();
    const labelId = await addLabel(c, 'infra');
    const issue2 = await createTestWorkItem(c.fx, { kind: 'task', title: 'Second' });
    await adminDb.$transaction(async (tx) =>
      workItemLabelRepository.create({ workItemId: issue2.id, labelId }, tx),
    );

    await adminDb.$transaction(async (tx) => {
      expect(await workItemLabelRepository.countByLabel(labelId, tx)).toBe(2);
      expect(await workItemLabelRepository.countByWorkItem(c.issue.id, tx)).toBe(1);
      expect(await labelRepository.lockById(labelId, tx)).toEqual({ id: labelId });
      expect(await labelRepository.lockById('missing-label-id', tx)).toBeNull();
    });

    const labels = await readAsOwner((tx) => labelRepository.listByWorkItem(c.issue.id, tx));
    expect(labels.map((l) => l.name)).toEqual(['infra']);
    const joins = await readAsOwner((tx) => workItemLabelRepository.listByWorkItem(c.issue.id, tx));
    expect(joins).toHaveLength(1);

    // `findByNameLower` on the owner client — this used to be the file's bare-`db`
    // half; see the header for why the fallback arm is no longer asserted here.
    const bare = await readAsOwner((tx) =>
      labelRepository.findByNameLower(c.fx.projectId, 'infra', tx),
    );
    expect(bare?.id).toBe(labelId);
    await adminDb.$transaction(async (tx) => {
      expect(await labelRepository.listByWorkItem(c.issue.id, tx)).toHaveLength(1);
      expect(await workItemLabelRepository.listByWorkItem(c.issue.id, tx)).toHaveLength(1);
    });

    // The delete-on-last-use end state: label rows die with their last use.
    await adminDb.$transaction(async (tx) => {
      await workItemLabelRepository.remove(c.issue.id, labelId, tx);
      await workItemLabelRepository.remove(issue2.id, labelId, tx);
      expect(await workItemLabelRepository.countByLabel(labelId, tx)).toBe(0);
      await labelRepository.delete(labelId, tx);
    });
    const labelRow = await adminDb.label.findUnique({ where: { id: labelId } });
    expect(labelRow).toBeNull();
  });

  it('cascades: deleting a work item sheds its label joins; deleting a label sheds its joins', async () => {
    const c = await makeOrganisationFixture();
    const labelId = await addLabel(c, 'doomed');

    await adminDb.workItem.delete({ where: { id: c.issue.id } });
    const workItemLabelCount = await adminDb.workItemLabel.count({ where: { labelId } });
    expect(workItemLabelCount).toBe(0);
    // The label row itself survives a work-item delete (delete-on-last-use
    // is a SERVICE rule, not a cascade) — 5.4.2 owns that lifecycle.
    const labelRow = await adminDb.label.findUnique({ where: { id: labelId } });
    expect(labelRow).not.toBeNull();

    const issue2 = await createTestWorkItem(c.fx, { kind: 'task', title: 'Again' });
    await adminDb.$transaction(async (tx) =>
      workItemLabelRepository.create({ workItemId: issue2.id, labelId }, tx),
    );
    await adminDb.$transaction(async (tx) => labelRepository.delete(labelId, tx));
    const workItemLabelCount2 = await adminDb.workItemLabel.count({
      where: { workItemId: issue2.id },
    });
    expect(workItemLabelCount2).toBe(0);
  });
});

describe('componentRepository + workItemComponentRepository', () => {
  it('CRUD round-trips; case-insensitive uniqueness per project', async () => {
    const c = await makeOrganisationFixture();
    const id = await addComponent(c, 'API');

    await expect(
      adminDb.$transaction(async (tx) =>
        componentRepository.create(
          {
            workspaceId: c.fx.workspaceId,
            projectId: c.fx.projectId,
            name: 'api',
            nameLower: 'api',
          },
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'P2002' });

    const probe = await readAsOwner((tx) =>
      componentRepository.findByNameLower(c.fx.projectId, 'api', tx),
    );
    expect(probe?.id).toBe(id);
    expect(
      await readAsOwner((tx) => componentRepository.findByNameLower(c.fx.projectId, 'web', tx)),
    ).toBeNull();

    const updated = await adminDb.$transaction(async (tx) =>
      componentRepository.update(id, { description: 'The API surface' }, tx),
    );
    expect(updated.description).toBe('The API surface');

    await adminDb.$transaction(async (tx) => componentRepository.delete(id, tx));
    expect(await readAsOwner((tx) => componentRepository.findById(id, tx))).toBeNull();
  });

  it('listByProject is name-ordered with in-use counts; listByWorkItem rides the issue', async () => {
    const c = await makeOrganisationFixture();
    const webId = await addComponent(c, 'Web');
    const apiId = await addComponent(c, 'API');
    await adminDb.$transaction(async (tx) =>
      workItemComponentRepository.createMany(
        [
          { workItemId: c.issue.id, componentId: apiId },
          { workItemId: c.issue.id, componentId: webId },
        ],
        tx,
      ),
    );

    const list = await readAsOwner((tx) => componentRepository.listByProject(c.fx.projectId, tx));
    expect(list.map((x) => [x.name, x._count.workItems])).toEqual([
      ['API', 1],
      ['Web', 1],
    ]);

    const mine = await readAsOwner((tx) => componentRepository.listByWorkItem(c.issue.id, tx));
    expect(mine.map((x) => x.name)).toEqual(['API', 'Web']);
    expect(await readAsOwner((tx) => workItemComponentRepository.countByComponent(apiId, tx))).toBe(
      1,
    );
  });

  it('findFirstDefaultAssignee picks the first-alphabetical component HAVING a default; empty input guards to null', async () => {
    const c = await makeOrganisationFixture();
    const bo = await createTestUser({ name: 'Bo' });
    const odie = await createTestUser({ name: 'Odie' });
    // Alphabetical: "API" (no default) < "Mobile" (Odie) < "Web" (Bo) —
    // the rule skips API and lands on Mobile.
    const apiId = await addComponent(c, 'API');
    const mobileId = await addComponent(c, 'Mobile', { defaultAssigneeId: odie.id });
    const webId = await addComponent(c, 'Web', { defaultAssigneeId: bo.id });

    const winner = await readAsOwner((tx) =>
      componentRepository.findFirstDefaultAssignee([apiId, webId, mobileId], tx),
    );
    expect(winner?.id).toBe(mobileId);
    expect(winner?.defaultAssigneeId).toBe(odie.id);

    expect(
      await readAsOwner((tx) => componentRepository.findFirstDefaultAssignee([apiId], tx)),
    ).toBeNull();
    // Empty-input guard (coverage gate): no statement, null.
    expect(
      await readAsOwner((tx) => componentRepository.findFirstDefaultAssignee([], tx)),
    ).toBeNull();
  });

  it('RESTRICT backstop: a component with join rows cannot be deleted until the joins go', async () => {
    const c = await makeOrganisationFixture();
    const id = await addComponent(c, 'API');
    await adminDb.$transaction(async (tx) =>
      workItemComponentRepository.create({ workItemId: c.issue.id, componentId: id }, tx),
    );

    // FK RESTRICT violation — the DB backstop.
    await expectRestrictViolation(
      adminDb.$transaction(async (tx) => componentRepository.delete(id, tx)),
    );

    await adminDb.$transaction(async (tx) => {
      expect(await componentRepository.lockById(id, tx)).toEqual({ id });
      expect(await workItemComponentRepository.deleteByComponent(id, tx)).toBe(1);
      await componentRepository.delete(id, tx); // now clean
    });
    expect(await readAsOwner((tx) => componentRepository.findById(id, tx))).toBeNull();
    await adminDb.$transaction(async (tx) => {
      expect(await componentRepository.lockById('missing-component-id', tx)).toBeNull();
    });
  });

  it('reassignItems repoints joins to the target, skipping issues that already carry it (the move branch)', async () => {
    const c = await makeOrganisationFixture();
    const fromId = await addComponent(c, 'Old');
    const toId = await addComponent(c, 'New');
    const issue2 = await createTestWorkItem(c.fx, { kind: 'task', title: 'Both' });
    await adminDb.$transaction(async (tx) =>
      workItemComponentRepository.createMany(
        [
          { workItemId: c.issue.id, componentId: fromId }, // moves
          { workItemId: issue2.id, componentId: fromId }, // duplicate → skipped
          { workItemId: issue2.id, componentId: toId },
        ],
        tx,
      ),
    );

    await adminDb.$transaction(async (tx) => {
      const moved = await workItemComponentRepository.reassignItems(fromId, toId, tx);
      expect(moved).toBe(1);
      // The duplicate leftover still points at `fromId` — the service drops
      // it in the same transaction (the move branch's sweep).
      expect(await workItemComponentRepository.deleteByComponent(fromId, tx)).toBe(1);
    });

    expect(await readAsOwner((tx) => workItemComponentRepository.countByComponent(toId, tx))).toBe(
      2,
    );
    expect(
      await readAsOwner((tx) => workItemComponentRepository.countByComponent(fromId, tx)),
    ).toBe(0);
    // Issues untouched either way (the verified rule).
    const workItemCount = await adminDb.workItem.count({ where: { projectId: c.fx.projectId } });
    expect(workItemCount).toBe(2);

    // The set-diff reads. Both call sites now pass a tx — see the header for why the
    // bare-`db` half stopped being assertable here.
    const joins = await readAsOwner((tx) =>
      workItemComponentRepository.listByWorkItem(issue2.id, tx),
    );
    expect(joins.map((j) => j.componentId)).toEqual([toId]);
    await adminDb.$transaction(async (tx) => {
      expect(await workItemComponentRepository.listByWorkItem(c.issue.id, tx)).toHaveLength(1);
      expect(await workItemComponentRepository.countByComponent(toId, tx)).toBe(2);
    });

    // removeMany with real ids (the bulk-remove path of setComponents).
    expect(
      await adminDb.$transaction(async (tx) =>
        workItemComponentRepository.removeMany(c.issue.id, [toId, fromId], tx),
      ),
    ).toBe(1);

    // Per-issue join uniqueness + idempotent removes, mirroring labels.
    await expect(
      adminDb.$transaction(async (tx) =>
        workItemComponentRepository.create({ workItemId: issue2.id, componentId: toId }, tx),
      ),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(
      await adminDb.$transaction(async (tx) =>
        workItemComponentRepository.remove(issue2.id, toId, tx),
      ),
    ).toBe(1);
    expect(
      await adminDb.$transaction(async (tx) =>
        workItemComponentRepository.remove(issue2.id, toId, tx),
      ),
    ).toBe(0);
  });

  it('createMany/removeMany guard empty input; cascades shed an issue’s joins; SetNull clears a departed default assignee', async () => {
    const c = await makeOrganisationFixture();
    expect(
      await adminDb.$transaction(async (tx) => workItemComponentRepository.createMany([], tx)),
    ).toBe(0);
    expect(
      await adminDb.$transaction(async (tx) =>
        workItemComponentRepository.removeMany(c.issue.id, [], tx),
      ),
    ).toBe(0);

    const user = await createTestUser({ name: 'Departing' });
    const id = await addComponent(c, 'Theirs', { defaultAssigneeId: user.id });
    await adminDb.$transaction(async (tx) =>
      workItemComponentRepository.create({ workItemId: c.issue.id, componentId: id }, tx),
    );

    // Issue delete cascades the join (RESTRICT is only on the component side).
    await adminDb.workItem.delete({ where: { id: c.issue.id } });
    expect(await readAsOwner((tx) => workItemComponentRepository.countByComponent(id, tx))).toBe(0);

    // Deleting the default assignee clears the pointer, never blocks.
    await adminDb.user.delete({ where: { id: user.id } });
    const after = await readAsOwner((tx) => componentRepository.findById(id, tx));
    expect(after).not.toBeNull();
    expect(after?.defaultAssigneeId).toBeNull();
  });
});

describe('watcherRepository', () => {
  it('add is idempotent (the unique absorbs a re-watch); existsFor and countByWorkItem read it back', async () => {
    const c = await makeOrganisationFixture();
    const first = await adminDb.$transaction(async (tx) =>
      watcherRepository.add(c.issue.id, c.fx.ownerId, tx),
    );
    const again = await adminDb.$transaction(async (tx) =>
      watcherRepository.add(c.issue.id, c.fx.ownerId, tx),
    );
    expect(again.id).toBe(first.id); // upsert no-op, same row

    expect(
      await readAsOwner((tx) => watcherRepository.existsFor(c.issue.id, c.fx.ownerId, tx)),
    ).toBe(true);
    expect(await readAsOwner((tx) => watcherRepository.countByWorkItem(c.issue.id, tx))).toBe(1);
  });

  it('remove is an idempotent count; existsFor turns false', async () => {
    const c = await makeOrganisationFixture();
    await adminDb.$transaction(async (tx) => watcherRepository.add(c.issue.id, c.fx.ownerId, tx));

    expect(
      await adminDb.$transaction(async (tx) =>
        watcherRepository.remove(c.issue.id, c.fx.ownerId, tx),
      ),
    ).toBe(1);
    expect(
      await adminDb.$transaction(async (tx) =>
        watcherRepository.remove(c.issue.id, c.fx.ownerId, tx),
      ),
    ).toBe(0);
    expect(
      await readAsOwner((tx) => watcherRepository.existsFor(c.issue.id, c.fx.ownerId, tx)),
    ).toBe(false);
  });

  it('listByWorkItem pages with a cursor (stable order, user riding along, no skip/repeat at the boundary)', async () => {
    const c = await makeOrganisationFixture();
    const users = [c.fx.owner];
    for (let i = 0; i < 4; i++) users.push(await createTestUser({ name: `Watcher ${i}` }));
    for (const u of users) {
      await adminDb.$transaction(async (tx) => watcherRepository.add(c.issue.id, u.id, tx));
    }

    const page1 = await readAsOwner((tx) =>
      watcherRepository.listByWorkItem(c.issue.id, { take: 2 }, tx),
    );
    expect(page1).toHaveLength(2);
    expect(page1[0]!.user.name).toBeTruthy(); // the popover's Avatar · name shape

    const page2 = await readAsOwner((tx) =>
      watcherRepository.listByWorkItem(c.issue.id, { take: 2, cursor: page1[1]!.id }, tx),
    );
    const page3 = await readAsOwner((tx) =>
      watcherRepository.listByWorkItem(c.issue.id, { take: 2, cursor: page2[1]!.id }, tx),
    );
    const seen = [...page1, ...page2, ...page3].map((w) => w.userId);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5); // every watcher exactly once
    expect(await readAsOwner((tx) => watcherRepository.countByWorkItem(c.issue.id, tx))).toBe(5);
  });

  it('cascades both sides: an issue delete sheds its watchers; a user delete stops their watching', async () => {
    const c = await makeOrganisationFixture();
    const user = await createTestUser({ name: 'Transient' });
    await adminDb.$transaction(async (tx) => {
      await watcherRepository.add(c.issue.id, c.fx.ownerId, tx);
      await watcherRepository.add(c.issue.id, user.id, tx);
    });

    await adminDb.user.delete({ where: { id: user.id } });
    expect(await readAsOwner((tx) => watcherRepository.countByWorkItem(c.issue.id, tx))).toBe(1);

    await adminDb.workItem.delete({ where: { id: c.issue.id } });
    const watcherCount = await adminDb.watcher.count();
    expect(watcherCount).toBe(0);
  });
});
