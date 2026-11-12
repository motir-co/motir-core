import { expect, type Page } from '@playwright/test';
import { test } from './_helpers/promoted-regression';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// Story MOTIR-2622 — the work-item TYPE vocabulary reaches fourteen (Subtask
// MOTIR-2635).
//
// THE ACCEPTANCE RECEIPT. Of the three stories in this cluster, only this one
// has something to WATCH: a person opens a menu and picks from it. Whether that
// menu is usable at half again its old size is not a question any test result
// answers — you have to see the list open, read it, and watch the choice land.
// That is the whole reason this story earns a recording.
//
// ⚠️ THE ASSERTIONS READ THE RENDERED SET, NOT `WORK_ITEM_TYPES` (the card's
// last paragraph, and the point of the exercise). A spec that imports the same
// constant the component imports agrees with itself perfectly while both are
// wrong — which is a miniature of the exact defect this story exists to close:
// the planner's list and the product's list drifted for months and nothing
// compared them. So the expected labels below are WRITTEN OUT, once, and the
// picker is checked against those literal strings.
//
// The behavioural coverage that does not need a human eye — the executor
// seeding, the leaf-only absence, the filter round-trip — is asserted here too
// rather than in a second spec, because each is one interaction on a surface the
// recording is already standing in front of.

test.describe.configure({ timeout: 180_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

/**
 * The fifteen labels a person actually reads, in the canonical order, written
 * out rather than derived (`Choice` joined after `Decision` with taxonomy ADR
 * Amendment 3, MOTIR-5890). If the ADR's set changes, this list is
 * SUPPOSED to need editing — that is the check, not an inconvenience.
 */
const EXPECTED_LABELS = [
  'Code',
  'Design',
  'Test',
  'Content',
  'Copy',
  'Translate',
  'Research',
  'Review',
  'Verification',
  'Decision',
  'Choice',
  'Deploy',
  'Manual',
  'Legal',
  'Chore',
];

/**
 * The four section headers the grouping renders. Written in the DOM's casing,
 * NOT the rendered casing: the header is `uppercase`, which is a CSS transform,
 * so the text node is "Build" and a locator for "BUILD" finds nothing. (Learned
 * by running it — the first draft asserted what the screen shows.)
 */
const EXPECTED_GROUPS = ['Build', 'Author', 'Investigate', 'Govern & operate'];

interface Seed {
  ctx: ServiceContext;
  projectId: string;
  projectKey: string;
}

async function seedProject(page: Page, email: string): Promise<Seed> {
  await signUp(page, email);
  const local = email.split('@')[0]!;
  const user = await db.user.findFirst({ where: { email } });
  const ws = await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(user, 'user exists after sign-up').not.toBeNull();
  expect(ws, 'auto workspace exists').not.toBeNull();
  const project = await projectsService.createProject({
    workspaceId: ws!.id,
    actorUserId: user!.id,
    name: 'Type Vocabulary',
    identifier: 'TVA',
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user!.id, workspaceId: ws!.id } },
    data: { activeProjectId: project.id },
  });
  return {
    ctx: { userId: user!.id, workspaceId: ws!.id },
    projectId: project.id,
    projectKey: project.identifier,
  };
}

/** The committed server state, polled — the authoritative signal, never a sleep. */
async function expectCommitted(
  page: Page,
  id: string,
  predicate: (item: Record<string, unknown>) => boolean,
  what: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/api/_test/work-items?id=${id}`);
        if (res.status() !== 200) return false;
        return predicate((await res.json()) as Record<string, unknown>);
      },
      { message: `server committed: ${what}`, timeout: 20_000 },
    )
    .toBe(true);
}

/** Every option label the open picker is currently rendering, in DOM order. */
async function renderedOptions(page: Page): Promise<string[]> {
  const raw = await page.getByRole('option').allTextContents();
  return raw.map((t) => t.trim()).filter(Boolean);
}

test('acceptance: the type picker offers fifteen, and a new one can be chosen end to end', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-2622');

  const seed = await seedProject(page, 'acceptance-type-owner@example.com');
  const task = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind: 'task', title: 'Translate the password-reset strings' },
    seed.ctx,
  );
  // A STORY as well as a leaf — the leaf-only rule is a visible absence, and you
  // cannot see something is missing without the case where it is present.
  const story = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind: 'story', title: 'Internationalisation' },
    seed.ctx,
  );

  await chapter('A work item with no type yet', async () => {
    await page.goto(`/items/${task.identifier}`);
    await expect(page.getByRole('heading', { name: task.title })).toBeVisible();
    // The empty state is its own affordance, not a blank: "Set a type".
    await expect(page.getByRole('button', { name: /set a type/i })).toBeVisible();
    await beat();
  });

  await chapter('The picker opens on the detail rail — fifteen, in four groups', async () => {
    await page.getByRole('button', { name: /set a type/i }).click();
    // ⚠️ 'Work type' EXACT, never /type/i: the work-item TYPE picker is labelled
    // "Work type" and the KIND picker is labelled "Type", so a loose matcher
    // resolves to both and trips strict mode.
    await expect(page.getByRole('listbox', { name: 'Work type' })).toBeVisible();
    await beat();

    // THE CENTRAL ASSERTION. Against literal strings, in order — not against the
    // constant the component reads.
    expect(await renderedOptions(page)).toEqual(EXPECTED_LABELS);

    // And the grouping the design's measurement justified: four headers, which
    // are NOT options (a header is role="presentation", so it cannot be picked
    // and keyboard navigation cannot land on it).
    for (const group of EXPECTED_GROUPS) {
      await expect(page.getByText(group, { exact: true })).toBeVisible();
    }
    expect(await renderedOptions(page)).toHaveLength(EXPECTED_LABELS.length);
    await beat();
  });

  await chapter(
    'The list scrolls — the new members are below the fold, and reachable',
    async () => {
      // The design measured this: the menu is capped (now 320px) in both hosts, so at
      // fourteen roughly half the list starts hidden. Scrolling to a NEWLY ADMITTED
      // member is the part a viewer needs to see actually work.
      const legal = page.getByRole('option', { name: 'Legal', exact: true });
      await legal.scrollIntoViewIfNeeded();
      await expect(legal).toBeVisible();
      await expect(page.getByRole('option', { name: 'Verification', exact: true })).toBeVisible();
      await beat();
    },
  );

  await chapter('Translate is chosen, and the choice sticks', async () => {
    await page.getByRole('option', { name: 'Translate', exact: true }).click();
    // The authoritative signal: the SERVER has the value, not the optimistic UI.
    await expectCommitted(page, task.id, (i) => i.type === 'translate', 'type = translate');
    await expect(page.getByText('Translate', { exact: true }).first()).toBeVisible();
    await beat();
  });

  await chapter('Choosing a type seeded WHO executes it', async () => {
    // The type→executor default map, reaching the control a person looks at.
    // `translate` defaults to the coding agent (ADR Amendment 1 §3a).
    await expectCommitted(page, task.id, (i) => i.executor === 'coding_agent', 'executor seeded');
    // The rail renders the executor as "Agent" / "Human" (labels.executor), not
    // the enum's `coding_agent` — the value is asserted above, the WORD here.
    await expect(page.getByText('Agent', { exact: true }).first()).toBeVisible();
    await beat();
  });

  await chapter('The chip follows the item into the list', async () => {
    await page.goto('/items');
    await expect(page.getByText(task.title)).toBeVisible();
    // The chip, in the list's Type column.
    await expect(page.getByText('Translate', { exact: true }).first()).toBeVisible();
    await beat();
  });

  await chapter('The filter finds it by its new type', async () => {
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Filter work items' });
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole('listbox', { name: 'Work type' })
      .getByRole('option', { name: 'Translate', exact: true })
      .click();
    // The URL is the committed filter state — the authoritative signal here.
    await expect(page).toHaveURL(/type=translate/);
    await expect(page.getByText(task.title)).toBeVisible();
    await beat();
  });

  await chapter('A STORY has no type control at all — the leaf-only rule, visible', async () => {
    // Not "the picker is disabled": the whole row is absent, because a container
    // is not a unit of execution. You can only see that by looking at one.
    await page.goto(`/items/${story.identifier}`);
    await expect(page.getByRole('heading', { name: story.title })).toBeVisible();
    await expect(page.getByRole('button', { name: /set a type/i })).toHaveCount(0);
    await expect(page.getByText('Work type', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Work type' })).toHaveCount(0);
    await beat();
  });
});

// ── The SECOND host, in its own test ────────────────────────────────────────
// The same control, a different call site — and two call sites drift apart. It
// is a separate test rather than a chapter because it starts from a clean list
// and creating an item mid-recording would make the earlier chapters' list
// contents change under the viewer.
test('the create-issue modal offers the same fifteen, and creates with a new type', async ({
  page,
  chapter,
  beat,
}) => {
  const seed = await seedProject(page, 'acceptance-type-create@example.com');
  expect(seed.projectKey).toBe('TVA');

  await chapter('The create modal, and its type picker', async () => {
    await page.goto('/items');
    await page
      .getByRole('button', { name: /create/i })
      .first()
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox', { name: /title/i }).fill('Terms of service review');
    await beat();

    await dialog.getByRole('combobox', { name: 'Work type' }).click();
    await expect(dialog.getByRole('listbox', { name: 'Work type' })).toBeVisible();
    // Same literal expectation as the first host — the two call sites are
    // asserted against the same written-out list, which is what catches drift
    // between them.
    expect(await renderedOptions(page)).toEqual(EXPECTED_LABELS);
    await beat();
  });

  await chapter('Legal is chosen — and it seeds a HUMAN, not an agent', async () => {
    const dialog = page.getByRole('dialog');
    const legal = dialog.getByRole('option', { name: 'Legal', exact: true });
    await legal.scrollIntoViewIfNeeded();
    await legal.click();
    // `legal` is the one admitted member whose default is `human`: a binding
    // artifact ends in a signature, and an agent cannot sign. Visible here.
    await expect(dialog.getByText('Human', { exact: true }).first()).toBeVisible();
    await beat();

    // ⚠️ The modal dispatches the `createIssueAction` SERVER ACTION, not a REST
    // POST — a `waitForResponse('/api/work-items')` here would wait forever and
    // fail as a bare timeout with no reason. The authoritative signal is the
    // committed row.
    await dialog.getByRole('button', { name: /^create/i }).click();
    await expect
      .poll(
        async () =>
          (await db.workItem.findFirst({ where: { title: 'Terms of service review' } }))?.type ??
          null,
        { message: 'the created item committed with type = legal', timeout: 20_000 },
      )
      .toBe('legal');
    await beat();
  });

  await chapter('It lands in the list carrying its type', async () => {
    // `{ exact: true }` (MOTIR-2769): the create flow's `aria-live` announcement
    // ("Notification TVA-1 created…") EMBEDS the title, so a loose match resolves
    // to two elements and trips strict mode. This passed in the acceptance lane
    // only because the pacing holds gave the announcement time to clear — i.e. the
    // spec was leaning on pacing for SYNCHRONISATION, which the pacing helpers
    // explicitly are not. Promoting it into a lane that does not pace surfaced
    // that, which is the promotion doing its job.
    await expect(page.getByText('Terms of service review', { exact: true })).toBeVisible();
    await expect(page.getByText('Legal', { exact: true }).first()).toBeVisible();
    // And the server agrees on BOTH columns — including the human executor the
    // type seeded, which is the half a chip cannot show.
    const item = await db.workItem.findFirst({ where: { title: 'Terms of service review' } });
    expect(item?.type).toBe('legal');
    expect(item?.executor).toBe('human');
    await beat();
  });
});
