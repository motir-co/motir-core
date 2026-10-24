import type { Locator, Page, Response } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  closeOverlay,
  developmentSection,
  openDevelopmentOverlay,
} from './_helpers/development-decide';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { pagesService } from '@/lib/services/pagesService';
import { workItemsService } from '@/lib/services/workItemsService';
import { decisionPageService } from '@/lib/services/decisionPageService';
import en from '@/messages/en.json';

// AN AGENT'S DECISION IS A PAGE — THE ACCEPTANCE RECEIPT (Story MOTIR-5761 · Subtask
// MOTIR-7443). The story's verification recipe, in a real browser against a production
// build and a real database.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// An agent wrote its decision as a page in Motir and published it. The decision waits on
// To approve, by the page's title — and there is no pull request anywhere. The person opens
// it and reads VERSION 1. Someone edits the page afterwards; the port says so and still asks
// about version 1. One press approves it: the card is Done and version 1 is FROZEN. History
// tags it, the edit is version 2, and a further edit leaves version 1 exactly as approved.
//
// ── THE AGENT'S PUBLISH ─────────────────────────────────────────────────────
//
// The seed publishes through `decisionPageService.publish` — the service the
// `publish_decision_page` MCP tool calls (MOTIR-7434), so the gate, the seal and the status
// walk are the product's own. The tool's door itself is the story gate's
// (`tests/integration/decisionPageStoryGate.test.ts`).
//
// ── THE CASE THIS RECEIPT DOES NOT RE-RECORD ────────────────────────────────
//
// A decision carried as a FILE in an open pull request still shows the file port: that is
// MOTIR-4907's receipt (`regression-decision-gate.spec.ts`), and the subject precedence is
// held by the story gate. Recording it again here would double the clip for no new claim.
//
// ── THE WAITS (the coding convention § E2E tests wait on the AUTHORITATIVE signal) ──────
//
// Every body save is waited on by its own `POST /api/pages/<id>/updates` response, armed
// before the typing; the History list by its `GET …/versions`, a version by its
// `GET …/versions/<n>`; the Approve by the server action's response; the Done status by a
// reload. No timed wait — the holds are `chapter()` / `beat()`'s, taken after an assertion.

const PASSWORD = 'acceptance-decision-page-pass-1';
const OWNER_EMAIL = 'acceptance-decision-page@example.com';
const TYPING = { delay: 45 };

const PAGE_TITLE = 'How a page stores its body';
const DECISION_LINE = 'Store the body as a Yjs document.';
const PUBLISHED = `# ${PAGE_TITLE}\n\n${DECISION_LINE}\n\nDerive Markdown and HTML on save.`;
const FIRST_EDIT = 'Also keep a plain-text copy for search.';
const SECOND_EDIT = 'Index headings separately.';

const dec = en.approvalGate.decision;
const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key]));
/** The copy with its rich tags dropped — what a reader sees. */
const plain = (text: string) => ['<b>', '</b>'].reduce((out, tag) => out.split(tag).join(''), text);

interface Seed {
  key: string;
  title: string;
  pageId: string;
}

async function seed(): Promise<Seed> {
  const owner = await usersService.createUser({
    email: OWNER_EMAIL,
    password: PASSWORD,
    name: 'Dana Decider',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Decision pages',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Pages',
    identifier: 'DPG',
  });
  const ctx = { userId: owner.id, workspaceId: workspace.id };
  await projectsService.setActiveProject({ ...ctx, projectId: project.id });

  const title = 'Decide how a page stores its body';
  const item = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title, type: 'decision', executor: 'coding_agent' },
    ctx,
  );
  await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId: owner.id } });
  await workItemsService.updateStatus(item.id, 'in_progress', ctx);

  const written = await pagesService.createPageFromMarkdown(ctx, {
    projectId: project.id,
    title: PAGE_TITLE,
    markdown: PUBLISHED,
  });
  // The agent's publish (see the header): seals version 1, raises the decision question,
  // walks the card to review.
  await decisionPageService.publish({ workItemId: item.id, pageId: written.id }, ctx);
  return { key: item.identifier, title, pageId: written.id };
}

// ── Locators and waits ──────────────────────────────────────────────────────

const liveBodyOf = (page: Page) =>
  page.getByRole('textbox', { name: 'Page body', exact: true }).first();
const versionsList = (page: Page) =>
  page.getByRole('list', { name: 'Versions of this page', exact: true });
const statusCard = (page: Page): Locator =>
  page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('button', { name: 'Edit Status' }) });
const portOf = (scope: Locator) => scope.getByRole('group', { name: dec.portTitle, exact: true });

function respondsTo(page: Page, path: string, method: string): Promise<Response> {
  return page.waitForResponse(
    (r) => new URL(r.url()).pathname === path && r.request().method() === method,
  );
}

const serverAction = (page: Page) =>
  page.waitForResponse(
    (res) => res.request().method() === 'POST' && Boolean(res.request().headers()['next-action']),
  );

/** Append a paragraph to the page in the editor, waiting on its save. */
async function appendLine(page: Page, pageId: string, line: string): Promise<void> {
  await page.goto(`/pages/${pageId}`);
  await expect(liveBodyOf(page)).toContainText(DECISION_LINE);
  const saved = respondsTo(page, `/api/pages/${pageId}/updates`, 'POST');
  await liveBodyOf(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(line, TYPING);
  expect((await saved).status()).toBe(200);
}

test.describe.configure({ timeout: 300_000 });

test('an agent’s decision published as a page waits for a person; Approve freezes the version and a later edit leaves it intact', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-5761');

  await resetDatabase();
  const s = await seed();
  await signIn(page, OWNER_EMAIL, PASSWORD);

  await chapter('The agent’s decision waits on To approve — a page, no pull request', async () => {
    await page.goto('/workbench?tab=approvals');
    const row = page
      .getByRole('table', { name: en.workbench.tabs.toApprove })
      .getByTestId(/^approval-row-/)
      .filter({ hasText: s.key });
    await expect(row).toHaveCount(1, { timeout: 60_000 });
    await expect(
      row.getByText(
        fill(en.workbench.approvals.row.decisionPage, { title: PAGE_TITLE, number: 1 }),
        {
          exact: true,
        },
      ),
    ).toBeVisible();
    await beat();

    await page.goto(`/items/${s.key}`);
    await expect(statusCard(page).getByText('In Review', { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    const dev = developmentSection(page);
    // ⚠️ THE PORT IS MOUNTED BEFORE ITS CONTENT IS READ: the page's own heading, out of the
    // published version. Nothing below passes on an empty slot.
    const port = portOf(dev);
    await expect(port.getByRole('heading', { name: PAGE_TITLE })).toBeVisible({ timeout: 60_000 });
    await expect(port.getByTestId('decision-page-meta')).toContainText('Version 1');
    await expect(port.getByRole('link', { name: dec.page.open })).toHaveAttribute(
      'href',
      `/pages/${s.pageId}?version=1`,
    );
    await expect(dev.getByText(fill(dec.headMeta.pageNoRun, { number: 1 }))).toBeVisible();
    // No pull request anywhere, and none is expected: no pull-request group and no "No
    // linked pull request" prompt under the page. The band asks about the page.
    await expect(
      dev.getByRole('group', { name: en.github.development.pullRequestsGroup }),
    ).toHaveCount(0);
    await expect(dev.getByRole('heading', { name: en.github.development.emptyTitle })).toHaveCount(
      0,
    );
    await expect(
      dev.getByText(en.approvalGate.pullRequestApproval.cta.bodyDecisionPage),
    ).toBeVisible();
  });
  await beat();

  await chapter(
    'The page is edited after it was published — the port still asks about version 1',
    async () => {
      await appendLine(page, s.pageId, FIRST_EDIT);
      await beat();
      await page.goto(`/items/${s.key}`);
      const port = portOf(developmentSection(page));
      await expect(port.getByRole('heading', { name: PAGE_TITLE })).toBeVisible({
        timeout: 60_000,
      });
      const notice = port.getByTestId('decision-page-changed');
      await expect(notice).toContainText(plain(fill(dec.page.changedSince, { number: 1 })));
      await expect(port.getByTestId('decision-page-meta')).toContainText('Version 1');
      // The text on screen is version 1's, not the page's.
      await expect(port.getByText(FIRST_EDIT)).toHaveCount(0);
    },
  );
  await beat();

  await chapter('Approve: version 1 is frozen and the card is Done', async () => {
    const overlay = await openDevelopmentOverlay(page);
    await expect(portOf(overlay).getByRole('heading', { name: PAGE_TITLE })).toBeVisible();
    await expect(
      overlay.getByText(plain(fill(dec.consequencePage, { number: 1, key: s.key }))),
    ).toBeVisible();
    await overlay.getByRole('button', { name: en.approvalGate.verb.approve, exact: true }).click();
    await expect(overlay.getByText(fill(dec.confirm.freezesPage, { number: 1 }))).toBeVisible();
    await beat();
    const action = serverAction(page);
    await overlay
      .getByRole('button', {
        name: fill(en.approvalGate.confirm.proceed, { verb: en.approvalGate.verb.approve }),
        exact: true,
      })
      .click();
    expect((await action).status()).toBe(200);
    await expect(overlay.getByText(en.approvalGate.state.approved, { exact: true })).toBeVisible();
    await closeOverlay(page);

    await page.reload();
    await expect(statusCard(page).getByText('Done', { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    const dev = developmentSection(page);
    await expect(
      dev.getByText(fill(dec.page.approvedVersion, { number: 1 })).first(),
    ).toBeVisible();
    await expect(portOf(dev).getByText(dec.page.frozen, { exact: true })).toBeVisible();
  });
  await beat();

  await chapter('History tags version 1 Frozen; another edit never reaches it', async () => {
    await appendLine(page, s.pageId, SECOND_EDIT);
    const listed = respondsTo(page, `/api/pages/${s.pageId}/versions`, 'GET');
    await page.getByRole('button', { name: 'History', exact: true }).click();
    expect((await listed).status()).toBe(200);
    const rows = versionsList(page).getByRole('button');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('v2');
    await expect(rows.nth(0)).toContainText('Current');
    await expect(rows.nth(1)).toContainText('v1');
    const tag = versionsList(page).getByRole('link', {
      name: fill(en.pages.history.tag.frozenLabel, { key: s.key }),
    });
    await expect(tag).toBeVisible();
    await expect(tag).toHaveAttribute('href', `/items/${s.key}`);
    await beat();

    const read = respondsTo(page, `/api/pages/${s.pageId}/versions/1`, 'GET');
    await rows.nth(1).click();
    expect((await read).status()).toBe(200);
    const v1 = page.getByRole('region', { name: 'Version 1', exact: true });
    const v1Body = v1.getByRole('textbox', { name: 'Page body', exact: true });
    await expect(v1Body).toContainText(DECISION_LINE);
    await expect(v1Body).not.toContainText(FIRST_EDIT);
    await expect(v1Body).not.toContainText(SECOND_EDIT);
    // The live page beside it carries both edits.
    await expect(liveBodyOf(page)).toContainText(SECOND_EDIT);
  });
  await beat();
});
