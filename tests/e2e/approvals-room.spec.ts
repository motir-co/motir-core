import type { Locator, Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { servePrivateObjectStore } from './_helpers/object-store';
import {
  MOCK_HTML,
  MOCK_SOURCE_PATH,
  NOTE_MD,
  NOTE_SOURCE_PATH,
} from './_helpers/design-approval-seed';
import { seedApprovalsRoom, type ApprovalsRoomSeed } from './_helpers/approvals-room-seed';

// THE APPROVAL RECORDS ROOM, END TO END — Story MOTIR-5299's walk, as a
// REGRESSION spec. It was that story's acceptance receipt
// (`acceptance-approvals-room.spec.ts`, Subtask MOTIR-5304); Story MOTIR-7460
// PROMOTED it into the main lane (docs/acceptance-lane-triage.md § MOTIR-7460)
// when the Workbench's To approve tab was renamed Waiting on you. The import swap
// to `_helpers/promoted-regression` keeps every `chapter()` as a step and drops the
// pacing; the one chapter restated is the queue forgetting the decided approval —
// the tab's link and its empty state now read Waiting on you and "Nothing is
// waiting on you" (design `design/workbench/design-notes.md` § 33). The header
// below is the receipt's, kept as it was written.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// Two claims, and only a browser can make either.
//
//   1. THE QUEUE FORGETS AND THE ROOM DOES NOT. A person decides an approval; it
//      leaves the Workbench's To-approve tab, as a queue must, and it is still in
//      Approval records, now under Decided.
//   2. ONE ADDRESS, TWO ROOMS, ONE PERMISSION. A reader without `approval:view_any`
//      does not see a colleague's decision — seeded, present in the database, absent
//      from their page. A reader holding the key, at the same `/approvals`, does.
//
// ⚠️ AMENDED ON THE RECORD — Story MOTIR-6179 (MOTIR-6328 · MOTIR-6333 · MOTIR-6337).
// Claim 2's premise stopped describing the built-in MEMBER: the DECISION card
// MOTIR-6165 (Q2) gave `member` and `viewer` `approval:view_any`, so the reviewer
// below is no longer "a reader without the key". What this receipt still proves is
// true and is NOT rewritten: the reviewer has records of their own, so a clean
// arrival serves the room's MINE view (design MOTIR-6327's default), and Mine is
// exactly "routed to me or decided by me" — the colleague's decision stays absent;
// the admin, with no records of their own, lands on PROJECT and sees it; the
// custom role holding only the key has Project alone. The assertions are unchanged
// (the disposition is KEEP, per `CLAUDE.md` § acceptance receipts). A reader who
// truly lacks the key — a custom role without it — and the Viewer / Member / custom
// walk across all three rooms are `regression-rooms-view-tabs.spec.ts`'s.
//
// ── THE DOOR IS PART OF THE ACCEPTANCE ──────────────────────────────────────
//
// `canOfferNavDestination` answers FALSE for an href the nav map does not carry,
// with no error — so a room nobody registered is a working page nobody can find, and
// a spec that typed the URL would pass against exactly that. So the room is reached
// by CLICKING the rail row, and separately through the COMMAND PALETTE. No
// `page.goto('/approvals')` appears in this file.
//
// ── SEEDING AND SWITCHING USER ──────────────────────────────────────────────
//
// `approvals-room-seed.ts` composes `approvals-tab-seed.ts` (whose spec stays
// unedited) and adds a decided record of the READER's, a built-in project ADMIN and a
// CUSTOM-ROLE reader holding only browse + `approval:view_any`; its header says why
// each is written the way it is. Personas are switched with `signIn`, which drops the
// session cookie first, so one page walks reader after reader.
//
// The CUSTOM-ROLE reader IS walked here, cheaply, because the seed writes the role
// row directly. `tests/approval-records-story-gate.test.ts` proves the same case at
// the service, with the key removed as well as granted.
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE — a heading, a row, the URL, a pill. No
// `waitForTimeout` anywhere in this file.

test.describe.configure({ timeout: 300_000 });

const b64 = (b: Buffer) => b.toString('base64');

async function agentSession(token: string, baseURL: string): Promise<Client> {
  const client = new Client({ name: 'approvals-room-e2e', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/api/mcp', baseURL), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

function publish(client: Client, key: string): Promise<CallToolResult> {
  return client.callTool({
    name: 'publish_design_result',
    arguments: {
      key,
      assets: [
        {
          kind: 'mock',
          sourcePath: MOCK_SOURCE_PATH,
          contentType: 'text/html',
          contentBase64: b64(Buffer.from(MOCK_HTML)),
        },
        {
          kind: 'note_file',
          sourcePath: NOTE_SOURCE_PATH,
          contentType: 'text/markdown',
          contentBase64: b64(Buffer.from(NOTE_MD)),
        },
      ],
      producedByKey: key,
      // A commit, so the decided row has a version to name — the field that makes a
      // row a record rather than a list entry.
      commitSha: 'b33c4e45d0f9e8a7',
    },
  }) as Promise<CallToolResult>;
}

async function resolveMod(page: Page): Promise<'Meta' | 'Control'> {
  const isMac = await page.evaluate(() => /mac|iphone|ipad|ipod/i.test(navigator.platform));
  return isMac ? 'Meta' : 'Control';
}

/**
 * The page's MAIN landmark. ⚠️ Every text / test-id locator below is rooted here,
 * never at `page` (MOTIR-5037): a page-rooted strict locator can match a node the
 * author never put there — a hidden previous subtree React keeps mounted during a
 * navigation — and fail strict mode. `tests/e2e-page-rooted-locators.test.ts` holds it.
 */
const main = (page: Page) => page.getByRole('main');

/** The primary rail — scoped, because the mobile drawer carries the same row names. */
const rail = (page: Page) => page.getByRole('navigation', { name: 'Primary' });

/** The room's one table, role-rooted so a hidden streaming copy can never match. */
const recordsTable = (page: Page, name = 'Approval records') => page.getByRole('table', { name });

/** The row for a work item, inside the room's table. */
const recordRow = (table: Locator, title: string): Locator =>
  table.getByTestId(/^approval-row-/).filter({ hasText: title });

/** Click the rail row, and wait on the room's heading — the authoritative signal. */
async function openRoomFromRail(page: Page, label: string, heading: string): Promise<void> {
  await rail(page).getByRole('link', { name: label, exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/approvals');
  await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
}

test.describe('Approval records — a place you can go', () => {
  let seed: ApprovalsRoomSeed;

  test.beforeEach(async () => {
    await resetDatabase();
    seed = await seedApprovalsRoom(`r${Date.now().toString(36)}`);
  });

  test('a decided approval leaves the queue and stays in the room — and a key holder sees the whole project', async ({
    page,
    baseURL,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-5299');
    await servePrivateObjectStore(page);

    const client = await agentSession(seed.token, baseURL!);
    expect((await publish(client, seed.designKey)).isError ?? false).toBe(false);

    await chapter('A reviewer finds Approval records in the rail', async () => {
      await signIn(page, seed.reviewerEmail, seed.password);
      await openRoomFromRail(page, 'Approval records', 'Approval records');
      await expect(
        main(page).getByText('Approvals waiting on you, and the ones you decided.'),
      ).toBeVisible();

      const table = recordsTable(page);
      // Pending first: the design routed to them, under Awaiting a decision.
      await expect(
        main(page)
          .getByTestId('approval-records-awaiting')
          .getByTestId(/^approval-row-/),
      ).toHaveCount(1);
      await expect(recordRow(table, seed.designTitle)).toBeVisible();
      await expect(
        main(page)
          .getByTestId('approval-records-decided')
          .getByText('You have not decided an approval in this project yet.'),
      ).toBeVisible();

      // ⚠️ THE LEAKAGE CHECK, IN THE PRODUCT: the reader's decision is IN THE DATABASE…
      expect(
        await adminDb.approvalGate.count({
          where: { projectId: seed.projectId, state: 'approved' },
        }),
      ).toBe(1);
      // …and absent from this reviewer's room.
      await expect(recordRow(table, seed.readerDecisionTitle)).toHaveCount(0);
    });
    await beat();

    const dialog = page.getByRole('dialog', { name: `Design result for ${seed.designKey}` });

    await chapter('They approve it, through the one approval door', async () => {
      await recordRow(recordsTable(page), seed.designTitle)
        .getByRole('button', { name: 'Review', exact: true })
        .click();
      await expect(dialog).toBeVisible();
      await expect(page).toHaveURL(
        (url) =>
          url.pathname === '/approvals' && url.searchParams.get('approval') === seed.designKey,
      );
      await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
      await expect(dialog.getByText('Approving this will:')).toBeVisible();
      await dialog.getByRole('button', { name: 'Yes, Approve' }).click();
      // AUTHORITATIVE: rendered from the gate row the decide action returned.
      await expect(dialog.getByText('Approved', { exact: true })).toBeVisible();
      await dialog.getByRole('button', { name: /^Close/ }).click();
      await expect(dialog).toBeHidden();
    });
    await beat();

    await chapter('The Workbench queue forgets it, as a queue should', async () => {
      await rail(page).getByRole('link', { name: 'Workbench', exact: true }).click();
      // ⚠️ RESTATED AFTER PROMOTION (Story MOTIR-7460, design
      // `design/workbench/design-notes.md` § 33): the tab is Waiting on you now,
      // not To approve, and its empty state is "Nothing is waiting on you".
      await page.getByRole('link', { name: /Waiting on you/ }).click();
      await expect(page).toHaveURL(/tab=approvals/);
      await expect(page.getByRole('heading', { name: 'Nothing is waiting on you' })).toBeVisible({
        timeout: 30_000,
      });
    });
    await beat();

    await chapter(
      'The room remembers it — reached this time from the command palette',
      async () => {
        await page.keyboard.press(`${await resolveMod(page)}+k`);
        const palette = page.getByRole('dialog', { name: 'Command palette' });
        await expect(palette).toBeVisible();
        await page.keyboard.type('Approval records');
        await palette.getByRole('option', { name: 'Go to Approval records' }).click();
        await expect(page).toHaveURL((url) => url.pathname === '/approvals');
        await expect(palette).toBeHidden();

        const decided = main(page).getByTestId('approval-records-decided');
        const row = recordRow(decided, seed.designTitle);
        await expect(row).toBeVisible();
        await expect(row.getByText('Approved', { exact: true })).toBeVisible();
        // WHEN: relative in the cell, absolute in its title.
        await expect(row.getByRole('cell').nth(2).locator('span[title]')).toHaveAttribute(
          'title',
          /\d/,
        );
        // …and the pending section is empty now, in the reader's own words.
        await expect(main(page).getByText('Nothing is waiting on you.')).toBeVisible();
        // Still not the colleague's decision.
        await expect(recordRow(recordsTable(page), seed.readerDecisionTitle)).toHaveCount(0);
      },
    );
    await beat();

    await chapter('An admin opens the same room, and sees the whole project', async () => {
      await signIn(page, seed.adminEmail, seed.password);
      await openRoomFromRail(page, 'Approval records', 'Approval records');
      await expect(
        main(page).getByText('Every approval in this project — waiting first, then decided.'),
      ).toBeVisible();
      const decided = main(page).getByTestId('approval-records-decided');
      // Other people's decisions, each naming who made it.
      const readerRow = recordRow(decided, seed.readerDecisionTitle);
      await expect(readerRow).toBeVisible();
      await expect(readerRow.getByText(new RegExp(`${seed.readerName} <`))).toBeVisible();
      const reviewerRow = recordRow(decided, seed.designTitle);
      await expect(reviewerRow).toBeVisible();
      await expect(reviewerRow.getByText(new RegExp(`${seed.reviewerName} <`))).toBeVisible();
    });
    await beat();

    await chapter('So does a custom role that holds only that one permission', async () => {
      await signIn(page, seed.customEmail, seed.password);
      await openRoomFromRail(page, 'Approval records', 'Approval records');
      const decided = main(page).getByTestId('approval-records-decided');
      await expect(recordRow(decided, seed.readerDecisionTitle)).toBeVisible();
      await expect(recordRow(decided, seed.designTitle)).toBeVisible();
    });
  });

  test('the key-less room in zh — reached from the rail, the colleague’s decision absent', async ({
    page,
    baseURL,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-5299');
    await servePrivateObjectStore(page);
    const client = await agentSession(seed.token, baseURL!);
    expect((await publish(client, seed.designKey)).isError ?? false).toBe(false);

    await signIn(page, seed.reviewerEmail, seed.password);
    // The suite's own locale switch (`workbench.spec.ts`).
    await page.context().addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: page.url() }]);
    await page.reload();

    await openRoomFromRail(page, '审批记录', '审批记录');
    await expect(main(page).getByText('等待你处理的审批，以及你已决定的审批。')).toBeVisible();
    // Asserted through the catalogue's own strings: both section headings, the
    // reviewer's pending row, and the decided section's empty line.
    const table = recordsTable(page, '审批记录');
    await expect(table.getByRole('columnheader', { name: /^等待决定/ })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: /^已决定/ })).toBeVisible();
    await expect(recordRow(table, seed.designTitle)).toBeVisible();
    await expect(main(page).getByText('你在本项目中还没有决定过审批。')).toBeVisible();
    await expect(recordRow(table, seed.readerDecisionTitle)).toHaveCount(0);
    // Negatively too: the English literal must not be reachable on a `zh` page.
    await expect(main(page).getByText('Approval records', { exact: true })).toHaveCount(0);
  });
});
