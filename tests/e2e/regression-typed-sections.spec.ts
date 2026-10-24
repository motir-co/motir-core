import type { Locator, Page, Request } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { actionWrite } from './_helpers/authoritative-signal';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { openUndecidedPlan } from './_helpers/open-undecided-plan';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { plansService } from '@/lib/services/plansService';
import { runGetWorkItem } from '@/lib/mcp/tools/getWorkItem';
import { GATE_CRITERIA, gateSections } from '../helpers/sectionsGate';

// A CARD WRITTEN THROUGH THE SECTIONS INTERFACE READS AS FREE TEXT — THE ACCEPTANCE
// RECEIPT (Story MOTIR-9023 · Subtask MOTIR-9038).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// The story gives agents a typed way to WRITE a card's body and stores nothing
// but the free text it renders to. So what a person sees and types must not have
// moved. The recording shows three things, each against a CONTROL — a twin whose
// stored body is the identical string, written by code the story did not touch:
//
//   1. a card written with `sections`, and its twin, show the same Description on
//      the item page, with the Scope BOUNDARY, Acceptance criteria and Context
//      refs as their own headings;
//   2. a hand-written, heading-less card and its twin show the same text;
//   3. a plan's proposal sent with `sections`, the same body sent as plain
//      `descriptionMd`, and one whose framing is gutter-corrupted, show the same
//      text in the plan review overlay — and the gutter hides no heading;
//   4. the item page's Description editor still edits free text: one criterion
//      edited, then a body with no headings, then a body of `| ` lines — each
//      saved, none refused, each stored exactly as the editor sent it.
//
// "The same text as before" is made mechanical by the twins, not by a screenshot
// from before the story, which does not exist.
//
// ── THE WAITS (the coding convention § E2E tests wait on the AUTHORITATIVE signal) ──────
//
// Each Save is a Server Action, matched by its body (`actionWrite`, a marker only
// the edited text carries) and armed before the click; its 200 is asserted before
// anything is read. The item page is waited on by its heading landmark, the
// overlay by its plan pane (`openUndecidedPlan`, which also composes the overlay
// address — none is written here). Nothing waits on a timeout: every `beat()` is
// pacing taken after the state it shows is proven.

const PASSWORD = 'acceptance-typed-sections-pass-123';
const EMAIL = 'acceptance-sections-member@example.com';

const TYPING = { delay: 30 };

const STORY_TITLE = 'Checkout rework';
const S_TITLE = 'Wire the receipt email (written with sections)';
const S_TWIN_TITLE = 'Wire the receipt email (twin)';
const H_TITLE = 'Sort out the refund wording';
const H_TWIN_TITLE = 'Sort out the refund wording (twin)';
const H_BODY = [
  'Support keeps asking what "refunded" means to a customer.',
  '',
  'We said we would settle it before the next release, so it needs an owner.',
].join('\n');

const P1_TITLE = 'Proposal one — sections';
const P2_TITLE = 'Proposal two — plain body';
const P3_TITLE = 'Proposal three — gutter framing';
const GUTTER_FRAMING = ['Opening sentence one.', '## Acceptance criteria', 'Opening sentence two.']
  .map((l) => `| ${l}`)
  .join('\n');

const HEADINGS = ['Scope BOUNDARY', 'Acceptance criteria', 'Context refs'] as const;

interface Seed {
  s: { id: string; key: string };
  sTwin: { id: string; key: string };
  h: { id: string; key: string };
  hTwin: { id: string; key: string };
  planId: string;
  ctx: { userId: string; workspaceId: string };
}

async function seed(): Promise<Seed> {
  const user = await usersService.createUser({
    email: EMAIL,
    password: PASSWORD,
    name: 'Mia Member',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Sections Workspace',
    ownerUserId: user.id,
  });
  const ctx = { userId: user.id, workspaceId: workspace.id };
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Storefront',
    identifier: 'SHP',
  });
  await projectsService.setActiveProject({ ...ctx, projectId: project.id });
  const projectId = project.id;

  const story = await workItemsService.createWorkItem(
    { projectId, kind: 'story', title: STORY_TITLE },
    ctx,
  );

  // S: written with `sections` and no `descriptionMd`. Its twin carries the same
  // stored body, copied straight onto a row the sections branch never touched.
  const s = await workItemsService.createWorkItem(
    {
      projectId,
      kind: 'subtask',
      type: 'code',
      title: S_TITLE,
      parentId: story.id,
      sections: gateSections('subtask', 'code'),
    } as never,
    ctx,
  );
  const sBody = (await adminDb.workItem.findUniqueOrThrow({ where: { id: s.id } })).descriptionMd;
  const sTwin = await workItemsService.createWorkItem(
    { projectId, kind: 'subtask', type: 'code', title: S_TWIN_TITLE, parentId: story.id },
    ctx,
  );
  await adminDb.workItem.update({ where: { id: sTwin.id }, data: { descriptionMd: sBody } });

  // H: hand-written, no sections key anywhere.
  const h = await workItemsService.createWorkItem(
    { projectId, kind: 'task', title: H_TITLE, descriptionMd: H_BODY },
    ctx,
  );
  const hTwin = await workItemsService.createWorkItem(
    { projectId, kind: 'task', title: H_TWIN_TITLE },
    ctx,
  );
  await adminDb.workItem.update({ where: { id: hTwin.id }, data: { descriptionMd: H_BODY } });

  // P: three adds under the story. P2's body is P1's stored body, sent plain.
  const plan = await plansService.createPlan(projectId, { title: 'Sections plan' }, ctx);
  const first = await plansService.addProposals(
    plan.id,
    [
      {
        op: 'add',
        proposedFields: {
          title: P1_TITLE,
          kind: 'task',
          type: 'code',
          sections: gateSections('task', 'code'),
        } as never,
        parentRef: story.id,
      },
    ],
    ctx,
  );
  const p1Body = (
    (await adminDb.planItem.findUniqueOrThrow({ where: { id: first.appendedItemIds[0]! } }))
      .proposedFields as Record<string, unknown>
  )['descriptionMd'] as string;
  await plansService.addProposals(
    plan.id,
    [
      {
        op: 'add',
        proposedFields: { title: P2_TITLE, kind: 'task', type: 'code', descriptionMd: p1Body },
        parentRef: story.id,
      },
      {
        op: 'add',
        proposedFields: {
          title: P3_TITLE,
          kind: 'task',
          type: 'code',
          sections: { ...gateSections('task', 'code'), framing: GUTTER_FRAMING },
        } as never,
        parentRef: story.id,
      },
    ],
    ctx,
  );
  await plansService.markPlanned(plan.id, ctx);

  return {
    s: { id: s.id, key: s.identifier },
    sTwin: { id: sTwin.id, key: sTwin.identifier },
    h: { id: h.id, key: h.identifier },
    hTwin: { id: hTwin.id, key: hTwin.identifier },
    planId: plan.id,
    ctx,
  };
}

// ── Locators and waits ──────────────────────────────────────────────────────

/** The item page's read-view Description region. */
const descriptionOf = (page: Page) => page.getByRole('main').getByLabel('Work item description');
const editorOf = (page: Page) => page.getByRole('textbox', { name: 'Description', exact: true });
const proposalButton = (page: Page, title: string) =>
  page
    .getByRole('dialog')
    .getByTestId('plan-proposal-list')
    .getByRole('button', { name: new RegExp(title) });
const peekOf = (page: Page) => page.getByRole('dialog').getByTestId('proposal-peek');

async function openItem(page: Page, item: { key: string }, title: string): Promise<Locator> {
  expect((await page.goto(`/items/${item.key}`))?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
  return descriptionOf(page);
}

async function storedBody(id: string): Promise<string | null> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).descriptionMd;
}

/** The `descriptionMd` a Server Action request carried — read off its body, never off what was typed. */
function carriedDescription(request: Request): string {
  const body = request.postData() ?? '';
  const find = (value: unknown): string | undefined => {
    if (value === null || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record['descriptionMd'] === 'string') return record['descriptionMd'];
    for (const inner of Object.values(record)) {
      const hit = find(inner);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  const found = find(JSON.parse(body));
  if (found === undefined) {
    throw new Error(`the save carried no descriptionMd: ${body.slice(0, 400)}`);
  }
  return found;
}

async function openEdit(page: Page, item: { key: string }): Promise<void> {
  expect((await page.goto(`/items/${item.key}/edit`))?.status()).toBe(200);
  await expect(editorOf(page)).toHaveAttribute('contenteditable', 'true');
}

/** Save the edit form; return the description its request carried, after the 200. */
async function save(page: Page, item: { key: string }, marker: string): Promise<string> {
  const written = actionWrite(page, `/items/${item.key}/edit`, marker);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const response = await written;
  expect(response.status()).toBe(200);
  return carriedDescription(response.request());
}

// ── The recorded journey ────────────────────────────────────────────────────

test('a card written with sections and a hand-written one read as the same free text, and the editor still edits it', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // The receipt belongs to the STORY, not to this subtask.
  acceptanceStory('MOTIR-9023');
  test.setTimeout(300_000);

  await resetDatabase();
  const seeded = await seed();
  await signIn(page, EMAIL, PASSWORD);

  let sRead = '';

  await chapter('A card written with sections shows its sections as headings', async () => {
    // Case 1: the stored bodies are byte-identical and so are the rendered regions.
    expect(await storedBody(seeded.s.id)).toBe(await storedBody(seeded.sTwin.id));
    const region = await openItem(page, seeded.s, S_TITLE);
    for (const heading of HEADINGS) {
      await expect(region.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    }
    for (const criterion of GATE_CRITERIA) await expect(region).toContainText(criterion);
    sRead = await region.innerText();
    await beat();

    const twin = await openItem(page, seeded.sTwin, S_TWIN_TITLE);
    expect(await twin.innerText()).toBe(sRead);
    await beat();
  });

  await chapter('A hand-written card reads exactly as typed', async () => {
    // Case 2.
    expect(await storedBody(seeded.h.id)).toBe(H_BODY);
    expect(await storedBody(seeded.hTwin.id)).toBe(H_BODY);
    const region = await openItem(page, seeded.h, H_TITLE);
    const read = await region.innerText();
    for (const line of H_BODY.split('\n').filter((l) => l.trim().length > 0)) {
      expect(read).toContain(line);
    }
    const twin = await openItem(page, seeded.hTwin, H_TWIN_TITLE);
    expect(await twin.innerText()).toBe(read);
    await beat();
  });

  await chapter('In the plan overlay, sections and a plain body read alike', async () => {
    // Case 3: opened through the product's own door, never a hand-written address.
    await openUndecidedPlan(page, seeded.planId, { view: 'list' });
    await proposalButton(page, P1_TITLE).click();
    await expect(peekOf(page)).toBeVisible();
    const one = peekOf(page).getByLabel('Work item description');
    await expect(one).toContainText(GATE_CRITERIA[0]!);
    const oneRead = await one.innerText();
    await page.keyboard.press('Escape');
    await expect(peekOf(page)).toBeHidden();

    await proposalButton(page, P2_TITLE).click();
    await expect(peekOf(page)).toBeVisible();
    const two = peekOf(page).getByLabel('Work item description');
    await expect(two).toContainText(GATE_CRITERIA[0]!);
    expect(await two.innerText()).toBe(oneRead);
    await beat();
  });

  await chapter('A gutter-corrupted framing hides no heading', async () => {
    // Case 4.
    await page.keyboard.press('Escape');
    await expect(peekOf(page)).toBeHidden();
    await proposalButton(page, P3_TITLE).click();
    await expect(peekOf(page)).toBeVisible();
    const region = peekOf(page).getByLabel('Work item description');
    for (const heading of HEADINGS.slice(0, 2)) {
      await expect(region.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    }
    for (const criterion of GATE_CRITERIA) await expect(region).toContainText(criterion);
    await expect(region).toContainText('Opening sentence one.');
    await beat();
    await page.keyboard.press('Escape');
  });

  await chapter('The editor edits one criterion of a sections-written card', async () => {
    // Case 5.
    await openEdit(page, seeded.s);
    const editor = editorOf(page);
    await editor.getByText(GATE_CRITERIA[1]!, { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Edited by the editor.', TYPING);
    const carried = await save(page, seeded.s, 'Edited by the editor.');

    expect(await storedBody(seeded.s.id)).toBe(carried);
    const read = await runGetWorkItem({ key: seeded.s.key }, seeded.ctx);
    expect(read.structuredContent).not.toHaveProperty('parsedSections');
    const region = await openItem(page, seeded.s, S_TITLE);
    await expect(region).toContainText(`${GATE_CRITERIA[1]!} Edited by the editor.`);
    await beat();
  });

  await chapter('A body with no headings is saved, not refused', async () => {
    // Case 6.
    await openEdit(page, seeded.s);
    await editorOf(page).click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('Just a plain note, no headings at all. E2E-PLAIN', TYPING);
    const carried = await save(page, seeded.s, 'E2E-PLAIN');

    expect(await storedBody(seeded.s.id)).toBe(carried);
    const region = await openItem(page, seeded.s, S_TITLE);
    await expect(region).toContainText('Just a plain note, no headings at all. E2E-PLAIN');
    await beat();
  });

  await chapter('A body of `| ` lines is saved as the editor sent it', async () => {
    // Case 7.
    await openEdit(page, seeded.h);
    await editorOf(page).click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('| quoted line one E2E-GUTTER', TYPING);
    await page.keyboard.press('Enter');
    await page.keyboard.type('| quoted line two', TYPING);
    const carried = await save(page, seeded.h, 'E2E-GUTTER');

    expect(await storedBody(seeded.h.id)).toBe(carried);
    const region = await openItem(page, seeded.h, H_TITLE);
    await expect(region).toContainText('quoted line one E2E-GUTTER');
    await expect(region).toContainText('quoted line two');
    await beat();
  });
});
