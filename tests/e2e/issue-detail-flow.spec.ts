// E2E: the Story-2.4 issue-DETAIL lifecycle (Subtask 2.4.6), driving the real
// shell. The Story CLOSER — it covers EVERY Story-2.4 surface end to end:
//   - the read surfaces (2.4.1–2.4.3): canonical page render, parent breadcrumb
//     + child-list tree navigation;
//   - the inline edit controls (2.4.4): workflow-aware status + assignee, both
//     verified to PERSIST across reload;
//   - readiness (2.4.5): a blocked item reads "Blocked"; resolving the blocker
//     flips it to "Ready to start";
//   - link management on the detail panel (2.4.9): add / remove (with the
//     reciprocal `relates_to` drop) + the cycle guardrail's inline error;
//   - link management in the create modal (2.4.10): collect-then-write-on-create.
//
// @smoke — exercises the UI↔service seams unit tests structurally can't: the
// inline Server Actions (changeStatusAction / updateIssueAction / create+remove
// link actions) → service → trigger → revalidate → the panel + readiness banner
// re-render. Mirrors the 1.6.6 / 2.3.8 real-stack lesson.
//
// Setup uses ONLY auth (shell-session signUp) + the 2.2.7 `_test` harness
// (work-items / work-item-links create + the gated `?status=` transition), so
// this has no ordering dependency on the create/edit specs. Selectors target the
// stable role/label hooks the detail components expose (the "Edit <field>"
// FieldCard toggles, the "Status"/"Assignee"/"Relationship"/"Work item to link"
// Comboboxes, the "Link issue" / per-row "Remove … link" affordances, the
// "Parent work items" nav, the "Child issues" / "Relationships" section cards), never
// brittle text.

import { expect, test, type Locator, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { actionWrite } from './_helpers/authoritative-signal';
import { projectsService } from '@/lib/services/projectsService';

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

/** Sign-up auto-creates the workspace; create a project server-side + pin it
 * active. Returns the project id (for `_test` calls). Mirrors the 2.3.8 spec. */
async function seedActiveProject(email: string, identifier: string): Promise<string> {
  const local = email.split('@')[0]!;
  const user = await db.user.findFirst({ where: { email } });
  const ws = await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(user, 'user exists after sign-up').not.toBeNull();
  expect(ws, 'auto workspace exists').not.toBeNull();
  const project = await projectsService.createProject({
    workspaceId: ws!.id,
    actorUserId: user!.id,
    name: 'Detail Flow',
    identifier,
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user!.id, workspaceId: ws!.id } },
    data: { activeProjectId: project.id },
  });
  return project.id;
}

interface Created {
  id: string;
  identifier: string;
}

/** Create a work item through the `_test` route. Returns id + identifier. */
async function mk(
  page: Page,
  projectId: string,
  opts: { kind?: string; title: string; parentId?: string; descriptionMd?: string },
): Promise<Created> {
  const res = await page.request.post('/api/_test/work-items', {
    data: { projectId, kind: opts.kind ?? 'task', ...opts },
  });
  expect(res.status(), `create "${opts.title}"`).toBe(201);
  const dto = (await res.json()) as Created;
  return { id: dto.id, identifier: dto.identifier };
}

/** Add an `is_blocked_by` link (`fromId` is blocked by `toId`) via `_test`. */
async function linkBlockedBy(page: Page, fromId: string, toId: string): Promise<void> {
  const res = await page.request.post('/api/_test/work-item-links', {
    data: { fromId, toId, kind: 'is_blocked_by' },
  });
  expect(res.status(), 'create is_blocked_by link').toBe(201);
}

/** Drive the gated workflow transition (a single legal edge) via `_test`. */
async function transition(page: Page, id: string, statusKey: string): Promise<void> {
  const res = await page.request.patch(`/api/_test/work-items?id=${id}&status=${statusKey}`);
  expect(res.status(), `transition ${id} → ${statusKey}`).toBe(200);
}

/** Walk an item from the default initial `todo` to terminal `done` via the
 * default-workflow legal path (todo → in_progress → in_review → done). */
async function driveToDone(page: Page, id: string): Promise<void> {
  await transition(page, id, 'in_progress');
  await transition(page, id, 'in_review');
  await transition(page, id, 'done');
}

async function getItem(page: Page, id: string): Promise<Record<string, unknown>> {
  const res = await page.request.get(`/api/_test/work-items?id=${id}`);
  expect(res.status(), 'get work item').toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

/** The item's `is_blocked_by` blockers, via `_test` — for "nothing persisted". */
async function blockersOf(page: Page, id: string): Promise<{ id: string }[]> {
  const res = await page.request.get(
    `/api/_test/work-item-links?workItemId=${id}&direction=blockers`,
  );
  expect(res.status(), 'list blockers').toBe(200);
  return (await res.json()) as { id: string }[];
}

// The link picker is query-driven (Subtask 6.9.2 — closes finding #98): open the
// issue-search Combobox and TYPE before a candidate loads (it no longer prefetches
// a newest-50 window). The trigger must already be expanded by the caller.
async function searchLinkPicker(page: Page, query: string): Promise<void> {
  await page.getByRole('combobox', { name: /Search by identifier or title/ }).fill(query);
}

// MOTIR-5431 — the link panel is OPTIMISTIC (MOTIR-4496): its row is added or
// removed BEFORE `createLinkAction` / `removeLinkAction` is even sent, so an
// in-page row assertion proves the client state, not the saved link. Any
// `goto` / `reload` after one must first await the write itself.
//
// `actionWrite` matches the action by its request BODY. An add is marked by the
// target's id, which only `createLinkAction` carries (the picker's
// `listLinkCandidatesAction` sends the CURRENT item's id and the query). A
// remove carries no target id at all — only the link id the panel holds — so it
// is marked by its `linkId` key, which no other Server Action on the item page
// takes.
const REMOVE_LINK_WRITE = '"linkId"';

test('@smoke renders the canonical detail page (header · rendered Markdown · core fields · Edit)', async ({
  page,
}) => {
  const email = 'e2e-detail-render@example.com';
  await signUp(page, email);
  const projectId = await seedActiveProject(email, 'REN');
  const item = await mk(page, projectId, {
    title: 'Wire the dashboard',
    descriptionMd: 'Bold **important** and a [docs](https://example.com/guide) and `run()` code.',
  });

  await page.goto(`/items/${item.identifier}`);

  // Header: identifier + title h1.
  await expect(page.getByRole('heading', { name: 'Wire the dashboard', level: 1 })).toBeVisible();
  // ONE main landmark — the shell's. The content column rendered a second
  // `<main>` inside `AppLayout`'s until MOTIR-5432, so assistive tech had two
  // main regions and `page.getByRole('main')` resolved to two elements.
  await expect(page.getByRole('main')).toHaveCount(1);
  // Header identifier via testid — the bare key text is no longer unique on
  // the detail page (the Development empty-state copy names it, MOTIR-1579).
  await expect(page.getByTestId('item-identifier')).toHaveText(item.identifier);

  // Rendered Markdown (not raw source): a real anchor, bold, and inline code.
  const desc = page.getByRole('main').getByLabel('Work item description');
  await expect(desc.getByRole('link', { name: 'docs' })).toHaveAttribute(
    'href',
    'https://example.com/guide',
  );
  await expect(desc.locator('strong', { hasText: 'important' })).toBeVisible();
  await expect(desc.locator('code', { hasText: 'run()' })).toBeVisible();

  // Core-fields rail rendered (Reporter is always present) + the Edit link.
  await expect(page.getByText('Reporter')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Edit' }).first()).toBeVisible();
});

test('@smoke tree navigation: breadcrumb walks up, child list walks down', async ({ page }) => {
  const email = 'e2e-detail-tree@example.com';
  await signUp(page, email);
  const projectId = await seedActiveProject(email, 'TRE');
  const story = await mk(page, projectId, { kind: 'story', title: 'The Story' });
  const task = await mk(page, projectId, { kind: 'task', title: 'The Task', parentId: story.id });
  const sub = await mk(page, projectId, {
    kind: 'subtask',
    title: 'The Subtask',
    parentId: task.id,
  });

  // On the subtask, the breadcrumb shows the Story → Task lineage.
  await page.goto(`/items/${sub.identifier}`);
  const breadcrumb = page.getByRole('navigation', { name: 'Parent work items' });
  await expect(breadcrumb.getByRole('link', { name: /The Story/ })).toBeVisible();
  const taskCrumb = breadcrumb.getByRole('link', { name: /The Task/ });
  await expect(taskCrumb).toBeVisible();

  // A breadcrumb link navigates UP to the ancestor's detail page.
  await taskCrumb.click();
  await page.waitForURL(`**/items/${task.identifier}`);
  await expect(page.getByRole('heading', { name: 'The Task', level: 1 })).toBeVisible();

  // The Task's child row walks DOWN to the subtask's full detail page. Since
  // MOTIR-1305 a PLAIN click peeks (covered by the dedicated peek test below),
  // so the full-page navigation is the modified-click path (⌘/ctrl) — a real
  // browser opens it in a new tab; Playwright performs the navigation in-page.
  // The anchor still carries the real href.
  const childRow = page.getByRole('link', { name: /The Subtask/ });
  await expect(childRow).toBeVisible();
  await expect(childRow).toHaveAttribute('href', `/items/${sub.identifier}`);
  await childRow.click({ modifiers: ['Meta'] });
  await page.waitForURL(`**/items/${sub.identifier}`);
  await expect(page.getByRole('heading', { name: 'The Subtask', level: 1 })).toBeVisible();
});

// Story MOTIR-5309 · MOTIR-5381: re-parenting from the rail moves the item, and the
// breadcrumb — a separate island — repaints from the page's placement channel
// WITHOUT a reload. Two Server Actions answer in sequence: the write (its body
// carries the new parent's id) and then the placement re-read (its body carries
// only the item's id). Both are awaited before the breadcrumb is asserted.
test('@smoke re-parenting from the rail repaints the breadcrumb in place', async ({ page }) => {
  const email = 'e2e-detail-reparent@example.com';
  await signUp(page, email);
  const projectId = await seedActiveProject(email, 'RPT');
  const oldStory = await mk(page, projectId, { kind: 'story', title: 'Old Story' });
  const newStory = await mk(page, projectId, { kind: 'story', title: 'New Story' });
  const task = await mk(page, projectId, {
    kind: 'task',
    title: 'The Moving Task',
    parentId: oldStory.id,
  });

  const pathname = `/items/${task.identifier}`;
  await page.goto(pathname);
  const breadcrumb = page.getByRole('navigation', { name: 'Parent work items' });
  await expect(breadcrumb.getByRole('link', { name: /Old Story/ })).toBeVisible();

  await page.getByRole('button', { name: 'Edit Parent' }).click();
  await page.getByRole('combobox', { name: 'Parent' }).click();
  const option = page.getByRole('option', { name: /New Story/ });
  await expect(option).toBeVisible();

  const write = actionWrite(page, pathname, newStory.id);
  const reread = page.waitForResponse((res) => {
    const req = res.request();
    const body = req.postData() ?? '';
    return (
      req.method() === 'POST' &&
      req.headers()['next-action'] !== undefined &&
      new URL(res.url()).pathname === pathname &&
      body.includes(task.id) &&
      !body.includes(newStory.id)
    );
  });
  await option.click();
  expect((await write).status(), 'parent write').toBe(200);
  expect((await reread).status(), 'placement re-read').toBe(200);

  await expect(breadcrumb.getByRole('link', { name: /New Story/ })).toBeVisible();
  await expect(breadcrumb.getByRole('link', { name: /Old Story/ })).toHaveCount(0);
  // No reload happened: the URL is untouched and the page was never re-navigated.
  expect(new URL(page.url()).pathname).toBe(pathname);
});

// Regression: `bug-issue-detail-eyebrow-overflows-viewport` (epics.ts, Epic 6).
// An item with a LONG ancestor chain (the data shape Epic 6 introduced —
// parenthetical-clause Story titles) used to push the whole detail page wider
// than the viewport: the eyebrow breadcrumb sat as a bare flex child and
// resolved to its min-content width (a flex item's default `min-width:auto`),
// so its inner `truncate` never fired and the page gained horizontal scroll —
// clipping the header right cluster (watch + Edit) and the core-fields rail.
// A wide markdown child (long unbroken URL / code block) was a SECOND latent
// source via the unbounded `1fr` grid track. We MEASURE rendered geometry in a
// real browser (scrollWidth vs clientWidth + on-screen boxes) rather than
// asserting CSS rules — same posture as the Epic-3 swimlane / tree-header bugs.
test('@smoke long ancestor chain + wide content never overflow the viewport (bug-issue-detail-eyebrow-overflows-viewport)', async ({
  page,
}) => {
  const email = 'e2e-detail-overflow@example.com';
  await signUp(page, email);
  const projectId = await seedActiveProject(email, 'OVF');

  // Ancestor titles well past 80 chars (the threshold the original detail.png
  // mockup — short "Epic: Foo" ancestors — never crossed).
  const story = await mk(page, projectId, {
    kind: 'story',
    title:
      'Edit project details and change the project key with old-key redirects across every saved filter and board',
  });
  const task = await mk(page, projectId, {
    kind: 'task',
    title:
      'Audit-log UI — per-rule execution log with status, error detail, pagination, and retry affordances',
    parentId: story.id,
  });
  // The leaf also carries a wide markdown child (a long unbroken URL + a long
  // code line) to exercise the `<main>` `1fr` grid track guard.
  const sub = await mk(page, projectId, {
    kind: 'subtask',
    title: 'A child whose eyebrow carries a long ancestor chain',
    parentId: task.id,
    descriptionMd:
      'A long unbroken URL https://example.com/' +
      'verylongpathsegment'.repeat(20) +
      '\n\n```\nconst x = "' +
      'token '.repeat(60) +
      '";\n```\n',
  });

  // The bug reproduces at typical laptop widths; pin 1280 per the AC.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/items/${sub.identifier}`);

  // The long ancestor chain is present (and so the bug's trigger is live)...
  const breadcrumb = page.getByRole('navigation', { name: 'Parent work items' });
  await expect(breadcrumb.getByRole('link', { name: /Edit project details/ })).toBeVisible();

  // ...yet the page root does NOT overflow horizontally.
  const root = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    root.scrollWidth,
    `page root must not overflow (scrollWidth ${root.scrollWidth} ≤ clientWidth ${root.clientWidth} + 1)`,
  ).toBeLessThanOrEqual(root.clientWidth + 1);

  // The user-visible consequence was the right cluster + rail being clipped —
  // assert both stay within the viewport's right edge.
  const editBox = await page.getByRole('link', { name: 'Edit' }).first().boundingBox();
  expect(editBox, 'Edit link rendered').not.toBeNull();
  expect(editBox!.x + editBox!.width).toBeLessThanOrEqual(root.clientWidth + 1);

  const railBox = await page.getByText('Reporter').first().boundingBox();
  expect(railBox, 'core-fields rail rendered').not.toBeNull();
  expect(railBox!.x + railBox!.width).toBeLessThanOrEqual(root.clientWidth + 1);
});

// MOTIR-2039 — the table half of the same bug class, and the one the test above
// could NOT catch: a `<table>` is sized by its content and neither wraps, clips
// nor scrolls, so a wide one escaped the description column and painted across
// the right rail WITHOUT ever widening the document (the root scrollWidth check
// above stays green through it). The containment is per-element now: every
// table renders inside its own bounded scroll block. Measured as rendered
// geometry in a real browser — happy-dom reports all-zero boxes, so the
// component test (tests/work-items/markdown-render.test.tsx) can only assert
// the structure.
test('@smoke a wide markdown table scrolls inside the description column instead of painting across the rail (MOTIR-2039)', async ({
  page,
}) => {
  const email = 'e2e-detail-table@example.com';
  await signUp(page, email);
  const projectId = await seedActiveProject(email, 'TBL');

  // Three columns whose cells hold long UNBREAKABLE tokens (inline code does not
  // wrap mid-token), so the table's min-content width exceeds the 1fr column —
  // the shape of the live description that surfaced the bug.
  const wide = (n: number) => '`' + `motir.code-graph.index.step.${'segment.'.repeat(n)}end` + '`';
  const item = await mk(page, projectId, {
    title: 'A description carrying a wide GFM table',
    descriptionMd: [
      'Intro paragraph above the table.',
      '',
      '| symptom | measured | why |',
      '| --- | --- | --- |',
      `| ${wide(6)} | ${wide(6)} | ${wide(8)} |`,
      `| ${wide(5)} | ${wide(7)} | ${wide(6)} |`,
      '',
    ].join('\n'),
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/items/${item.identifier}`);

  const prose = page.getByRole('main').getByLabel('Work item description');
  await expect(prose.locator('table')).toBeVisible();

  const wrap = prose.locator('.motir-table-wrap');
  const geometry = await wrap.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const prose = el.closest('.motir-prose')!.getBoundingClientRect();
    return {
      right: rect.right,
      proseRight: prose.right,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    };
  });

  // The repro is live: the table really is wider than the column it sits in...
  expect(
    geometry.scrollWidth,
    `the fixture table must overflow its column (scrollWidth ${geometry.scrollWidth} > clientWidth ${geometry.clientWidth})`,
  ).toBeGreaterThan(geometry.clientWidth);

  // ...yet the block holding it never extends past the description column.
  expect(
    geometry.right,
    `table block must stay inside the description column (right ${geometry.right} ≤ ${geometry.proseRight})`,
  ).toBeLessThanOrEqual(geometry.proseRight + 1);

  // The user-visible symptom: the table painted OVER the right rail's cards.
  const railBox = await page.getByText('Reporter').first().boundingBox();
  expect(railBox, 'core-fields rail rendered').not.toBeNull();
  expect(geometry.right, 'table block must not reach the right rail').toBeLessThanOrEqual(
    railBox!.x,
  );

  // And the overflow is REACHABLE — clipped-but-unscrollable would still lose
  // the outer columns.
  const scrolled = await wrap.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
    return el.scrollLeft;
  });
  expect(scrolled, 'the overflowing columns must be scrollable into view').toBeGreaterThan(0);
});

test('@smoke inline status: a legal transition persists; illegal targets are not offered', async ({
  page,
}) => {
  const email = 'e2e-detail-status@example.com';
  await signUp(page, email);
  const projectId = await seedActiveProject(email, 'STA');
  const item = await mk(page, projectId, { title: 'Status me' });

  await page.goto(`/items/${item.identifier}`);
  // Reveal the inline Status control, then open its picker.
  await page.getByRole('button', { name: 'Edit Status' }).click();

  // ── MOTIR-3080: the status dot is MEASURED, not asserted to exist ────────
  // It rendered as a 2 × 18 sliver for as long as the picker has existed: the
  // dot is a plain `<span>` in `Combobox`'s icon slot, and a non-replaced inline
  // box ignores width and height. Nothing caught it — the markup asks for 10 × 10
  // and `getComputedStyle` agrees; only the USED value disagreed, and a used
  // value exists only in a browser. So this reads the box, which is the one
  // assertion that would have failed. (`toBeTruthy` on the element passes today
  // and passed then.)
  //
  // The TRIGGER is measured first, while the control is still closed: committing
  // a status collapses the inline editor back to its read view, so the trigger is
  // gone by the end of the test.
  const dotBox = async (within: Locator) => {
    const dot = within.locator('span.rounded-full').first();
    await expect(dot).toBeVisible();
    const box = await dot.boundingBox();
    expect(box, 'the dot has a box').not.toBeNull();
    return box!;
  };
  const triggerBox = await dotBox(page.getByRole('combobox', { name: 'Status' }));
  expect(triggerBox.width, 'trigger dot width').toBeCloseTo(10, 0);
  expect(triggerBox.height, 'trigger dot height').toBeCloseTo(10, 0);

  await page.getByRole('combobox', { name: 'Status' }).click();

  // Restricted default workflow: from `todo` only in_progress / blocked /
  // cancelled are legal — Done + In Review are NOT offered.
  await expect(page.getByRole('option', { name: 'In Progress' })).toBeVisible();
  await expect(page.getByRole('option', { name: 'Done' })).toHaveCount(0);
  await expect(page.getByRole('option', { name: 'In Review' })).toHaveCount(0);

  // …and EVERY option row's dot: the same slot, its second call site.
  for (const name of ['In Progress', 'Blocked', 'Cancelled']) {
    const box = await dotBox(page.getByRole('option', { name }));
    expect(box.width, `${name} option dot width`).toBeCloseTo(10, 0);
    expect(box.height, `${name} option dot height`).toBeCloseTo(10, 0);
  }

  await page.getByRole('option', { name: 'In Progress' }).click();

  // Persists: the service stored it, and a reload still shows it.
  await expect(async () => {
    expect((await getItem(page, item.id)).status).toBe('in_progress');
  }).toPass();
  await page.reload();
  // The rail reads it back, and so does the header eyebrow's status slot, which
  // names the same status since MOTIR-10534.
  await expect(page.getByRole('complementary').getByText('In Progress')).toBeVisible();
  await expect(page.locator('[data-status="in_progress"]')).toHaveCount(2);
});

test('@smoke inline assignee: assign then unassign, both persist across reload', async ({
  page,
}) => {
  const email = 'e2e-detail-assignee@example.com';
  await signUp(page, email);
  const projectId = await seedActiveProject(email, 'ASG');
  const item = await mk(page, projectId, { title: 'Assign me' });

  await page.goto(`/items/${item.identifier}`);
  await page.getByRole('button', { name: 'Edit Assignee' }).click();
  await page.getByRole('combobox', { name: 'Assignee' }).click();
  // The member option's accessible name is `${name} ${email}` (label +
  // secondary), so match on the email — unique + unambiguous vs "Unassigned".
  await page.getByRole('option', { name: email }).click();

  await expect(async () => {
    expect((await getItem(page, item.id)).assigneeId).not.toBeNull();
  }).toPass();
  // Reloaded + not editing: the assignee field now names the member, so the
  // only place "Unassigned" could appear (the empty assignee field) is gone.
  await page.reload();
  await expect(page.getByText('Unassigned')).toHaveCount(0);

  // Unassign.
  await page.getByRole('button', { name: 'Edit Assignee' }).click();
  await page.getByRole('combobox', { name: 'Assignee' }).click();
  await page.getByRole('option', { name: 'Unassigned' }).click();
  await expect(async () => {
    expect((await getItem(page, item.id)).assigneeId).toBeNull();
  }).toPass();
  await page.reload();
  await expect(page.getByText('Unassigned')).toBeVisible();
});

test('@smoke readiness: blocked item reads "Blocked", flips to "Ready" when the blocker is done', async ({
  page,
}) => {
  const email = 'e2e-detail-ready@example.com';
  await signUp(page, email);
  const projectId = await seedActiveProject(email, 'RDY');
  const item = await mk(page, projectId, { title: 'Depends on infra' });
  const blocker = await mk(page, projectId, { title: 'Infra task' });
  await linkBlockedBy(page, item.id, blocker.id);

  await page.goto(`/items/${item.identifier}`);
  await expect(page.getByText('Blocked', { exact: true })).toBeVisible();
  await expect(page.getByText(/Waiting on 1 work item/)).toBeVisible();

  // Resolve the blocker (walk it to terminal `done`) → reload re-judges readiness.
  await driveToDone(page, blocker.id);
  await page.reload();
  await expect(page.getByText('Ready to start')).toBeVisible();
});

test('@smoke link management — add a blocked-by link via the panel; persists + flips readiness', async ({
  page,
}) => {
  const email = 'e2e-detail-link-add@example.com';
  await signUp(page, email);
  const projectId = await seedActiveProject(email, 'LADD');
  const a = await mk(page, projectId, { title: 'Needs a blocker' });
  const b = await mk(page, projectId, { title: 'The blocker issue' });

  await page.goto(`/items/${a.identifier}`);
  // A fresh todo item with no blockers is the most ready it can be — it reads
  // "Ready to start" before any dependency exists (bug-ready-banner-no-deps).
  await expect(page.getByText('Ready to start')).toBeVisible();
  await page.getByRole('button', { name: 'Link work item' }).click();
  // Default relationship is "Blocked by" — search the target, pick it + Add.
  await page.getByRole('combobox', { name: 'Work item to link' }).click();
  await searchLinkPicker(page, 'blocker');
  await page.getByRole('option', { name: /The blocker issue/ }).click();
  const addWrite = actionWrite(page, `/items/${a.identifier}`, b.id);
  await page.getByRole('button', { name: 'Add', exact: true }).click();

  // The blocker row appears and readiness flips to Blocked.
  await expect(page.getByRole('link', { name: /The blocker issue/ })).toBeVisible();
  await expect(page.getByText('Blocked', { exact: true })).toBeVisible();
  expect((await addWrite).status()).toBe(200);

  // Persisted across reload.
  await page.reload();
  await expect(page.getByRole('link', { name: /The blocker issue/ })).toBeVisible();
  expect((await blockersOf(page, a.id)).map((x) => x.id)).toContain(b.id);
});

test('@smoke relationships: a plain click on a linked row opens the quick-view peek, not a navigation (8.8.31)', async ({
  page,
}) => {
  const email = 'e2e-detail-relationship-peek@example.com';
  await signUp(page, email);
  const projectId = await seedActiveProject(email, 'RPEEK');
  const a = await mk(page, projectId, { title: 'The item being read' });
  const b = await mk(page, projectId, { title: 'The peeked blocker' });
  await linkBlockedBy(page, a.id, b.id);

  await page.goto(`/items/${a.identifier}`);
  const row = page.getByRole('link', { name: /The peeked blocker/ });
  await expect(row).toBeVisible();
  // The anchor still carries the real detail-page href (shareable + ⌘/middle-
  // click → new tab); a plain click is intercepted to open the peek instead.
  await expect(row).toHaveAttribute('href', `/items/${b.identifier}`);

  // Arm the authoritative signal BEFORE the click: the peek controller fetches
  // the linked item's fields from /api/work-items/peek. Wait on its 200.
  const peekResponse = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/work-items/peek?key=${b.identifier}`) &&
      r.request().method() === 'GET',
  );
  await row.click();
  expect((await peekResponse).status()).toBe(200);

  // The shared quick-view modal opens for B WITHOUT leaving A's page: the URL
  // gains ?peek=<B> (we never navigated to /items/<B>) and the dialog shows B.
  await expect(page).toHaveURL(new RegExp(`/items/${a.identifier}\\?peek=${b.identifier}`));
  const dialog = page.getByRole('dialog', { name: new RegExp(`Quick view: ${b.identifier}`) });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('The peeked blocker')).toBeVisible();
  // The peek's own "Open full page" link targets B's detail page.
  await expect(dialog.getByTestId('quick-view-open-full')).toHaveAttribute(
    'href',
    `/items/${b.identifier}`,
  );

  // Closing the peek (Esc) clears ?peek and returns to A's detail page intact.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/items/${a.identifier}$`));
  await expect(page.getByRole('heading', { level: 1, name: 'The item being read' })).toBeVisible();
});

test('@smoke child list: a plain click on a child row opens the quick-view peek; a modified click does not (MOTIR-1305)', async ({
  page,
}) => {
  const email = 'e2e-detail-child-peek@example.com';
  await signUp(page, email);
  const projectId = await seedActiveProject(email, 'CPEEK');
  const parent = await mk(page, projectId, { kind: 'story', title: 'The parent story' });
  const child = await mk(page, projectId, {
    kind: 'task',
    title: 'The peeked child',
    parentId: parent.id,
  });

  await page.goto(`/items/${parent.identifier}`);
  const row = page.getByRole('link', { name: /The peeked child/ });
  await expect(row).toBeVisible();
  // The anchor still carries the real detail-page href (shareable + ⌘/middle-
  // click → new tab); a plain click is intercepted to open the peek instead.
  await expect(row).toHaveAttribute('href', `/items/${child.identifier}`);

  // A MODIFIED (⌘/ctrl) click is NOT intercepted — the handler returns early and
  // the browser navigates to the child's FULL page (a real browser opens a new
  // tab; Playwright navigates in-page). The key assertion: it is a full-page
  // navigation, NOT a `?peek` quick-view.
  await row.click({ modifiers: ['Meta'] });
  await page.waitForURL(`**/items/${child.identifier}`);
  expect(page.url()).not.toContain('peek');
  await expect(page.getByRole('heading', { level: 1, name: 'The peeked child' })).toBeVisible();

  // A PLAIN primary click opens the shared quick-view peek for the child WITHOUT
  // leaving the parent's page. Arm the authoritative signal (the peek controller
  // fetches the child's fields from /api/work-items/peek) BEFORE the click.
  await page.goto(`/items/${parent.identifier}`);
  const plainRow = page.getByRole('link', { name: /The peeked child/ });
  const peekResponse = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/work-items/peek?key=${child.identifier}`) &&
      r.request().method() === 'GET',
  );
  await plainRow.click();
  expect((await peekResponse).status()).toBe(200);

  await expect(page).toHaveURL(
    new RegExp(`/items/${parent.identifier}\\?peek=${child.identifier}`),
  );
  const dialog = page.getByRole('dialog', {
    name: new RegExp(`Quick view: ${child.identifier}`),
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('The peeked child')).toBeVisible();
  // The peek's own "Open full page" link targets the child's detail page (it
  // opens in a new tab — target="_blank").
  await expect(dialog.getByTestId('quick-view-open-full')).toHaveAttribute(
    'href',
    `/items/${child.identifier}`,
  );
});

test('@smoke link management — remove a blocked-by link (confirm) flips back to Ready', async ({
  page,
}) => {
  const email = 'e2e-detail-link-remove@example.com';
  await signUp(page, email);
  const projectId = await seedActiveProject(email, 'LRM');
  const a = await mk(page, projectId, { title: 'Has two blockers' });
  const open = await mk(page, projectId, { title: 'Open blocker' });
  const resolved = await mk(page, projectId, { title: 'Resolved blocker' });
  await linkBlockedBy(page, a.id, open.id);
  await linkBlockedBy(page, a.id, resolved.id);
  await driveToDone(page, resolved.id); // terminal → not an OPEN blocker

  await page.goto(`/items/${a.identifier}`);
  await expect(page.getByText('Blocked', { exact: true })).toBeVisible();

  // Remove the OPEN blocker via the per-row × → confirm popover → Remove link.
  await page.getByRole('button', { name: `Remove Blocked by link to ${open.identifier}` }).click();
  const removeWrite = actionWrite(page, `/items/${a.identifier}`, REMOVE_LINK_WRITE);
  await page.getByRole('button', { name: 'Remove link' }).click();

  // Its row is gone; the remaining blocker is terminal → "Ready to start".
  await expect(page.getByRole('link', { name: /Open blocker/ })).toHaveCount(0);
  await expect(page.getByText('Ready to start')).toBeVisible();
  expect((await removeWrite).status()).toBe(200);
  await page.reload();
  expect((await blockersOf(page, a.id)).map((x) => x.id)).toEqual([resolved.id]);
});

test('@smoke link management — removing a relates_to link drops both reciprocal rows', async ({
  page,
}) => {
  const email = 'e2e-detail-relates@example.com';
  await signUp(page, email);
  const projectId = await seedActiveProject(email, 'REL');
  const a = await mk(page, projectId, { title: 'Issue Alpha' });
  const d = await mk(page, projectId, { title: 'Issue Delta' });

  // Add a relates_to link A → D through the panel.
  await page.goto(`/items/${a.identifier}`);
  await page.getByRole('button', { name: 'Link work item' }).click();
  await page.getByRole('combobox', { name: 'Relationship' }).click();
  await page.getByRole('option', { name: 'Relates to' }).click();
  await page.getByRole('combobox', { name: 'Work item to link' }).click();
  await searchLinkPicker(page, 'Delta');
  await page.getByRole('option', { name: /Issue Delta/ }).click();
  const addWrite = actionWrite(page, `/items/${a.identifier}`, d.id);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('link', { name: /Issue Delta/ })).toBeVisible();
  // A relates_to link moves no readiness, so nothing else on A's page waits for
  // the write — D's reciprocal row exists only once it has committed.
  expect((await addWrite).status()).toBe(200);

  // The reciprocal row shows on D's page.
  await page.goto(`/items/${d.identifier}`);
  await expect(page.getByRole('link', { name: /Issue Alpha/ })).toBeVisible();

  // Remove it from A → both halves drop.
  await page.goto(`/items/${a.identifier}`);
  await page.getByRole('button', { name: `Remove Relates to link to ${d.identifier}` }).click();
  const removeWrite = actionWrite(page, `/items/${a.identifier}`, REMOVE_LINK_WRITE);
  await page.getByRole('button', { name: 'Remove link' }).click();
  await expect(page.getByRole('link', { name: /Issue Delta/ })).toHaveCount(0);
  expect((await removeWrite).status()).toBe(200);

  await page.goto(`/items/${d.identifier}`);
  await expect(page.getByRole('link', { name: /Issue Alpha/ })).toHaveCount(0);
});

test('@smoke link management — a cycle attempt surfaces an inline error and persists nothing', async ({
  page,
}) => {
  const email = 'e2e-detail-cycle@example.com';
  await signUp(page, email);
  const projectId = await seedActiveProject(email, 'CYC');
  const a = await mk(page, projectId, { title: 'Alpha cyc' });
  const b = await mk(page, projectId, { title: 'Beta cyc' });
  await linkBlockedBy(page, a.id, b.id); // A is_blocked_by B

  // On B, try to add "Blocked by" → A: B is_blocked_by A would close A→B→A.
  await page.goto(`/items/${b.identifier}`);
  await page.getByRole('button', { name: 'Link work item' }).click();
  await page.getByRole('combobox', { name: 'Work item to link' }).click();
  await searchLinkPicker(page, 'Alpha cyc');
  await page.getByRole('option', { name: /Alpha cyc/ }).click();
  await page.getByRole('button', { name: 'Add', exact: true }).click();

  // The typed trigger error round-trips inline; nothing persists.
  await expect(page.getByText('That would create a dependency cycle.')).toBeVisible();
  expect(await blockersOf(page, b.id), 'no blocker written on B').toEqual([]);
});

test('@smoke create with a link (2.4.10): the link is written atomically with the new issue', async ({
  page,
}) => {
  const email = 'e2e-detail-create-link@example.com';
  await signUp(page, email);
  const projectId = await seedActiveProject(email, 'CRL');
  const target = await mk(page, projectId, { title: 'Pre-existing target' });

  await page.goto('/items');
  await page.getByRole('button', { name: 'Create work item' }).click();
  await page.getByRole('textbox', { name: 'Title' }).fill('Created with a link');

  // The Linked-issues section: search the target (default "Blocked by") + Add.
  await page.getByRole('combobox', { name: 'Work item to link' }).click();
  await searchLinkPicker(page, 'Pre-existing');
  await page.getByRole('option', { name: /Pre-existing target/ }).click();
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  // The pending row renders before submit.
  await expect(
    page.getByRole('button', { name: `Remove pending blocked by link to ${target.identifier}` }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const toast = page.getByText(/^\S+ created$/);
  await expect(toast).toBeVisible();
  const identifier = ((await toast.textContent()) ?? '').replace(/ created$/, '').trim();
  expect(identifier).toMatch(/^CRL-\d+$/);

  // The new issue's detail panel shows the link, written with the issue.
  await page.goto(`/items/${identifier}`);
  await expect(page.getByRole('link', { name: /Pre-existing target/ })).toBeVisible();
  await expect(page.getByText('Blocked', { exact: true })).toBeVisible();
});

test('@smoke create with a link (2.4.10): removing the pending row before create writes nothing', async ({
  page,
}) => {
  const email = 'e2e-detail-create-link-drop@example.com';
  await signUp(page, email);
  const projectId = await seedActiveProject(email, 'CRD');
  const target = await mk(page, projectId, { title: 'Not actually linked' });

  await page.goto('/items');
  await page.getByRole('button', { name: 'Create work item' }).click();
  await page.getByRole('textbox', { name: 'Title' }).fill('No links after all');
  await page.getByRole('combobox', { name: 'Work item to link' }).click();
  await searchLinkPicker(page, 'Not actually');
  await page.getByRole('option', { name: /Not actually linked/ }).click();
  await page.getByRole('button', { name: 'Add', exact: true }).click();

  // Drop the pending row before creating.
  const removePending = page.getByRole('button', {
    name: `Remove pending blocked by link to ${target.identifier}`,
  });
  await expect(removePending).toBeVisible();
  await removePending.click();
  await expect(removePending).toHaveCount(0);

  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const toast = page.getByText(/^\S+ created$/);
  await expect(toast).toBeVisible();
  const identifier = ((await toast.textContent()) ?? '').replace(/ created$/, '').trim();

  await page.goto(`/items/${identifier}`);
  // No relationships were written — the panel shows its empty state.
  await expect(page.getByText('No linked work items yet.')).toBeVisible();
});

test('@smoke cross-workspace isolation: a foreign identifier 404s; the link picker is own-workspace only', async ({
  page,
}) => {
  // Workspace A owns an issue.
  const emailA = 'e2e-detail-tenant-a@example.com';
  await signUp(page, emailA);
  const projectIdA = await seedActiveProject(emailA, 'AAA');
  const aItem = await mk(page, projectIdA, { title: 'A-only issue' });

  // Workspace B (fresh sign-up) cannot reach A's issue by URL.
  const emailB = 'e2e-detail-tenant-b@example.com';
  await signUp(page, emailB);
  const projectIdB = await seedActiveProject(emailB, 'BBB');
  const res = await page.goto(`/items/${aItem.identifier}`);
  expect(res?.status(), "A's detail route 404s for B").toBe(404);

  // B's link picker surfaces only B's own items, never A's.
  const bItem = await mk(page, projectIdB, { title: 'B home issue' });
  await mk(page, projectIdB, { title: 'B candidate issue' });
  await page.goto(`/items/${bItem.identifier}`);
  await page.getByRole('button', { name: 'Link work item' }).click();
  await page.getByRole('combobox', { name: 'Work item to link' }).click();
  // "issue" matches every title across BOTH workspaces — only the workspace scope
  // keeps A's item out of B's server search (6.9.2).
  await searchLinkPicker(page, 'issue');
  await expect(page.getByRole('option', { name: /B candidate issue/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /A-only issue/ })).toHaveCount(0);
});
