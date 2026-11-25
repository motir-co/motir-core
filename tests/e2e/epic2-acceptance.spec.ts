// E2E: the Epic-2 ACCEPTANCE JOURNEY (Subtask 2.6.5) — the closing story of
// Epic 2 (Issue tracking core). Where the per-feature specs are focused smoke
// tests (issue-create-edit-flow / issue-detail-flow / issue-list-flow /
// workflow-flow), this file owns the ONE consolidated, user-visible journey
// that proves the type-parent rule + the full status lifecycle + the List/Tree
// read surfaces COMPOSE for a real user, in a single signed-in session against
// the real shell (Next + Postgres). It is the E2E analogue of 2.6.3's
// integration lifecycle scenario — same beats, driven through the UI.
//
// The journey (one test, one session):
//   1. Create an issue via the create modal — pick a kind (Sub-task), confirm
//      the parent picker offers ONLY legal parents for that kind (a Task is
//      offered; an Epic is never offered to a Sub-task — the type-parent rule
//      surfaced in the UI), select the legal parent, submit.
//   2. Open its detail page and confirm it rendered (identifier · title · kind ·
//      status · parent breadcrumb), then assign it to the workspace member
//      through the inline Assignee picker (the assignee gate, in the UI).
//   3. Walk it through a multi-step status lifecycle via the status picker
//      (todo → in_progress → in_review → done), confirming at each step that an
//      illegal direct target is NOT offered under the restricted default policy
//      (no direct todo → done; `in_progress → done` IS an edge since MOTIR-1625,
//      so the skip-ahead check there is To Do, which stays unreachable forwards).
//   4. Verify reflection in BOTH read surfaces: the List shows the item with its
//      final status, and the Tree shows it nested under its parent — closing the
//      loop on Stories 2.4 (tree/detail) + 2.5 (list).
//
// @smoke — exercises the cross-feature UI↔service seams: the create modal's
// type+parent filtering (2.3.4) → the gated transition path (2.2.4 /
// changeStatusAction) → the List + Tree reads (2.4/2.5). Setup mirrors the
// per-feature specs: sign up through the real UI (shell-session.signUp →
// auto-workspace → the Workbench), then seed the project + the two parent
// candidates SERVER-SIDE through the shipped services (the one sanctioned
// cross-layer reach for tests), so the seeded tree is exactly what Motir
// itself renders. The journey item itself is created THROUGH the UI — that is
// the surface under test.
//
// Known selector gotchas heeded (memory: prodect-e2e-selector-gotchas): a
// Combobox option's accessible name is label + secondary text, so members are
// matched by their email substring; status options are matched by their label
// ("In Progress", "Done"); the modal's submit is `Create` with `exact: true` so
// it never matches the `Create work item` trigger.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkItemKindDto } from '@/lib/dto/workItems';

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

interface Seed {
  ctx: ServiceContext;
  projectId: string;
}

/** Sign-up auto-creates the workspace; create a project server-side + pin it
 *  active so the project-scoped /items route resolves it. Returns the service
 *  context (for seeding the parent candidates) + the project id. Mirrors the
 *  per-feature specs' seedActiveProject/seedProject. */
async function seedActiveProject(page: Page, email: string, identifier: string): Promise<Seed> {
  await signUp(page, email);
  const local = email.split('@')[0]!;
  const user = await db.user.findFirst({ where: { email } });
  const ws = await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(user, 'user exists after sign-up').not.toBeNull();
  expect(ws, 'auto workspace exists').not.toBeNull();
  const project = await projectsService.createProject({
    workspaceId: ws!.id,
    actorUserId: user!.id,
    name: 'Acceptance',
    identifier,
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user!.id, workspaceId: ws!.id } },
    data: { activeProjectId: project.id },
  });
  return { ctx: { userId: user!.id, workspaceId: ws!.id }, projectId: project.id };
}

/** Create ONE work item through the service (the seeded parent candidates). */
async function mk(
  seed: Seed,
  kind: WorkItemKindDto,
  title: string,
): Promise<{ id: string; identifier: string; title: string }> {
  const dto = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind, title, parentId: null },
    seed.ctx,
  );
  return { id: dto.id, identifier: dto.identifier, title: dto.title };
}

/** Read a single work item back via the `_test` service-layer route — the
 *  robust persistence check the per-feature specs use for status/assignee. */
async function getItem(page: Page, id: string): Promise<Record<string, unknown>> {
  const res = await page.request.get(`/api/_test/work-items?id=${id}`);
  expect(res.status(), 'get work item').toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

test('@smoke Epic-2 acceptance journey: create (type-parent rule) → detail → status lifecycle → List + Tree reflection', async ({
  page,
}) => {
  const email = 'e2e-epic2-acceptance@example.com';
  const seed = await seedActiveProject(page, email, 'ACC');

  // Two ROOT parent candidates of distinct kinds: a Task (a LEGAL parent for a
  // Sub-task) and an Epic (NEVER a legal parent for a Sub-task). The journey
  // item nests under the Task — a single-level parent so the Tree needs one
  // expand to show the nesting.
  const parentTask = await mk(seed, 'task', 'Parent task');
  // Seed an Epic too — it must EXIST in the candidate pool so the parent picker
  // is proven to FILTER it out for a Sub-task (not merely "not seeded"). Its id
  // is unused; the assertion is on its absence from the picker.
  await mk(seed, 'epic', 'Unparentable epic');

  // ── 1. CREATE via the modal — the type-parent rule, surfaced in the UI ──────
  await page.goto('/items');
  await page.getByRole('button', { name: 'Create work item' }).click();
  await page.getByRole('textbox', { name: 'Title' }).fill('Acceptance subtask');

  // Pick kind = Sub-task → the parent picker must offer the Task but NOT the
  // Epic (a Sub-task requires a story/task/bug parent; an epic is never legal).
  // `exact` so this matches the KIND picker ("Type") and not the new leaf-only
  // "Work type" combobox (2.7.4) — Playwright's name match is substring.
  await page.getByRole('combobox', { name: 'Type', exact: true }).click();
  await page.getByRole('option', { name: 'Sub-task' }).click();
  await page.getByRole('combobox', { name: 'Parent' }).click();
  await expect(page.getByRole('option', { name: /Parent task/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /Unparentable epic/ })).toHaveCount(0);
  // Select the legal parent (the listbox closes on select).
  await page.getByRole('option', { name: /Parent task/ }).click();

  await page.getByRole('button', { name: 'Create', exact: true }).click();

  // The toast names the created identifier (`<IDENT> created`); capture it.
  const toast = page.getByText(/^\S+ created$/);
  await expect(toast).toBeVisible();
  const identifier = ((await toast.textContent()) ?? '').replace(/ created$/, '').trim();
  expect(identifier, 'created identifier reads ACC-<n>').toMatch(/^ACC-\d+$/);

  // Resolve the new item's id (for robust persistence polling across the walk).
  const items = (await (
    await page.request.get(`/api/_test/work-items?projectId=${seed.projectId}`)
  ).json()) as { id: string; identifier: string }[];
  const subId = items.find((i) => i.identifier === identifier)!.id;
  expect(subId, 'the created subtask is listed').toBeTruthy();

  // ── 2. DETAIL — render + assign to the member ───────────────────────────────
  await page.goto(`/items/${identifier}`);
  // Header + body: title (h1), identifier, kind, initial status, parent breadcrumb.
  await expect(page.getByRole('heading', { name: 'Acceptance subtask', level: 1 })).toBeVisible();
  // The header identifier (testid: the bare key text is no longer unique on
  // the detail page — the Development empty-state copy names it too, MOTIR-1579).
  await expect(page.getByTestId('item-identifier')).toHaveText(identifier);
  await expect(page.getByText('Sub-task', { exact: true })).toBeVisible(); // the Type field card
  // exact: the status Pill reads "To Do" — without exact it also matches the
  // description empty-state placeholder ("— what to do").
  await expect(page.getByText('To Do', { exact: true })).toBeVisible();
  const breadcrumb = page.getByRole('navigation', { name: 'Parent work items' });
  await expect(breadcrumb.getByRole('link', { name: /Parent task/ })).toBeVisible();

  // Assign to the workspace member through the inline picker (the assignee gate,
  // in the UI). The member option's name is `${name} ${email}` — match the email.
  await page.getByRole('button', { name: 'Edit Assignee' }).click();
  await page.getByRole('combobox', { name: 'Assignee' }).click();
  await page.getByRole('option', { name: email }).click();
  await expect(async () => {
    expect((await getItem(page, subId)).assigneeId).toBe(seed.ctx.userId);
  }).toPass();

  // ── 3. STATUS LIFECYCLE via the picker — illegal direct targets not offered ──
  // Each hop: reveal the inline Status control, open its picker, assert the
  // illegal direct target is absent, pick the legal next status, confirm it
  // persisted through the gated path, then reload for a clean next hop.
  async function walk(
    legalNext: string,
    absent: string[],
    expectedStatusKey: string,
  ): Promise<void> {
    await page.getByRole('button', { name: 'Edit Status' }).click();
    await page.getByRole('combobox', { name: 'Status' }).click();
    await expect(page.getByRole('option', { name: legalNext })).toBeVisible();
    for (const opt of absent) {
      await expect(page.getByRole('option', { name: opt })).toHaveCount(0);
    }
    await page.getByRole('option', { name: legalNext }).click();
    await expect(async () => {
      expect((await getItem(page, subId)).status).toBe(expectedStatusKey);
    }).toPass();
    await page.reload();
  }

  // From todo: in_progress is legal; Done is NOT (no skipping ahead). In Review is
  // reachable from To Do since MOTIR-12202 (a pull request delivering a To Do card),
  // so it is no longer an illegal-target probe here.
  await walk('In Progress', ['Done'], 'in_progress');
  // From in_progress: in_review is legal. Done is DIRECTLY reachable too since
  // MOTIR-1625 (review is optional), so it is no longer an illegal-target probe
  // here — this journey walks the full review path deliberately.
  await walk('In Review', [], 'in_review');
  // From in_review: Done is now legal — close out the lifecycle.
  await page.getByRole('button', { name: 'Edit Status' }).click();
  await page.getByRole('combobox', { name: 'Status' }).click();
  await page.getByRole('option', { name: 'Done' }).click();
  await expect(async () => {
    expect((await getItem(page, subId)).status).toBe('done');
  }).toPass();

  // ── 4. REFLECTION in both read surfaces ─────────────────────────────────────
  // List (flat): the subtask row shows with its final status.
  await page.goto('/items?view=list');
  await expect(page.getByRole('table', { name: 'Work Items' })).toBeVisible();
  const listRow = page.getByTestId(`issue-row-${identifier}`);
  await expect(listRow).toBeVisible();
  await expect(listRow).toContainText('Done');

  // Tree: the subtask is nested under its parent Task. It is LAZY — not in the
  // DOM until the parent row is expanded (ArrowRight via the WAI-ARIA treegrid
  // keyboard model, robust vs a coordinate click on the chevron).
  await page.goto('/items');
  await expect(page.getByRole('treegrid', { name: 'Work Items' })).toBeVisible();
  await expect(page.getByTestId(`issue-row-${identifier}`)).toHaveCount(0);
  const taskRow = page.getByTestId(`issue-row-${parentTask.identifier}`);
  await expect(taskRow).toHaveAttribute('aria-level', '1');
  await taskRow.press('ArrowRight');
  const subRow = page.getByTestId(`issue-row-${identifier}`);
  await expect(subRow).toBeVisible();
  await expect(subRow).toHaveAttribute('aria-level', '2'); // nested under the parent
  await expect(subRow).toContainText('Done');
});
