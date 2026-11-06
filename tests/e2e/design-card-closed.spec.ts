import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { shaFor } from '../helpers/commitShaFixtures';
import en from '@/messages/en.json';
import { adminDb } from '@/tests/helpers/adminDb';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  openAgentSession,
  publishDesignResult,
  seedDesignApproval,
  servePublishedMock,
  MOCK_SOURCE_PATH,
  NOTE_SOURCE_PATH,
  type DesignApprovalSeed,
} from './_helpers/design-approval-seed';

// A DONE DESIGN IS FINAL — the story's browser walk (Story MOTIR-5552 · Subtask
// MOTIR-5559; `docs/decisions/approval-gates.md` §6c SECOND AMENDMENT).
//
// Approve a design → the card is Done → a republish is REFUSED with the way
// forward → a person reopens the card with the ordinary status control → the
// republish is accepted and waits for a decision like the first one did.
//
// Main E2E lane, NO acceptance video: the story adds no user-observable surface
// (the refusal is on agent-facing doors, the status control and the design-result
// panel already ship), so this proves the flow and records nothing.
//
// ── HOW THE PUBLISHES REACH THE STORE, and why step 5 re-registers v1's blobs ──
//
// The register route (`POST /api/work-items/[id]/design-evidence`) HEADs every
// pathname it is given, on the SERVER. Under E2E the server's S3 transport is the
// in-process fake (`lib/test-blob-mock.ts`), whose HEAD answers only for objects
// that were PUT to it — and only a server-side write can PUT there, because a
// presigned upload URL points the RUNNER at `e2e.s3.invalid`, which resolves
// nowhere and which `page.route` cannot intercept for `page.request`.
//
// So v1 is published through the real `publish_design_result` tool (inline
// bytes, which the server PUTs), and every register-route call below names the
// pathnames that publish actually wrote, read back from the database. Nothing is
// seeded as evidence and no row is written by the spec: both register calls go
// through the real route, its auth, its HEAD and the service's guards. The v2
// that step 5 records therefore shares v1's bytes — which is irrelevant to what
// is under test, the card's status deciding whether a new version is taken.
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E): the approval waits on the pill the
// decide action's RESPONSE renders, the reopen waits on its server action's 200
// and the committed status, and every register call is asserted on its own
// response. No `waitForTimeout`.

test.describe.configure({ timeout: 240_000 });

/** The Design result section's ONE door (Story MOTIR-5215 · MOTIR-5229). Scoped to the
 *  section: while this gate holds a move the status control carries a second
 *  `Review & approve` (MOTIR-5528). */
function designDoor(page: Page) {
  return page
    .getByRole('main')
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('heading', { level: 2, name: 'Design result' }) })
    .getByRole('link', { name: 'Review & approve' });
}

/** The approval overlay the door opens, named for the card it decides. */
function overlay(page: Page, seed: DesignApprovalSeed) {
  return page.getByRole('dialog', { name: `Design result for ${seed.designKey}` });
}

async function designItem(seed: DesignApprovalSeed) {
  return adminDb.workItem.findFirstOrThrow({
    where: { title: seed.designTitle, workspaceId: seed.workspaceId },
    select: { id: true, status: true },
  });
}

/** The pathnames v1's publish wrote to the store, in the order it recorded them. */
async function publishedPathnames(workItemId: string) {
  const current = await adminDb.designEvidence.findFirstOrThrow({
    where: { workItemId, isCurrent: true },
    include: { assets: { include: { attachment: true }, orderBy: { position: 'asc' } } },
  });
  const byKind = (kind: 'mock' | 'note_file') =>
    current.assets.find((asset) => asset.kind === kind)!.attachment!.blobPathname;
  return { evidenceId: current.id, mock: byKind('mock'), note: byKind('note_file') };
}

function register(
  request: APIRequestContext,
  seed: DesignApprovalSeed,
  paths: { mock: string; note: string },
  commitSha: string,
) {
  return request.post(`/api/work-items/${seed.designKey}/design-evidence`, {
    headers: { Authorization: `Bearer ${seed.token}` },
    data: {
      assets: [
        { kind: 'mock', sourcePath: MOCK_SOURCE_PATH, pathname: paths.mock },
        { kind: 'note_file', sourcePath: NOTE_SOURCE_PATH, pathname: paths.note },
      ],
      commitSha,
    },
  });
}

test.describe('a done design is final until a person reopens it', () => {
  let seed: DesignApprovalSeed;

  test.beforeEach(async () => {
    await resetDatabase();
    seed = await seedDesignApproval('closed');
  });

  test('approve → republish refused → reopen by hand → republish accepted', async ({
    page,
    baseURL,
  }) => {
    await servePublishedMock(page);
    const design = await designItem(seed);

    await test.step('1 · an agent publishes the design, and work waits on it', async () => {
      const client = await openAgentSession(seed.token, baseURL!);
      const result = await publishDesignResult(client, seed.designKey);
      expect(result.isError ?? false, JSON.stringify(result.content)).toBe(false);
      await client.close();
    });
    const v1 = await publishedPathnames(design.id);

    await test.step('2 · the routed reviewer approves it, and the card reads Done', async () => {
      await signIn(page, seed.reviewerEmail, seed.password);
      await page.goto(`/items/${seed.designKey}`);
      await expect(page.getByRole('heading', { name: seed.designTitle })).toBeVisible();
      // ⚠️ THE ITEM PAGE HANDS THE DECISION OVER (MOTIR-5215): the card shows the
      // band's one door, and the design is decided in the overlay it opens.
      await expect(designDoor(page)).toHaveCount(1);
      await designDoor(page).click();
      const dialog = overlay(page, seed);
      await expect(dialog.getByRole('group', { name: 'The subject being decided' })).toBeVisible();

      await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
      await dialog.getByRole('button', { name: 'Yes, Approve' }).click();
      // Rendered from the gate row the decide action RETURNED — the authoritative
      // signal that the decision is recorded.
      await expect(dialog.getByText('Approved', { exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(page.getByRole('main').getByText('Approved', { exact: true })).toBeVisible();
      // The rail's value — the header eyebrow's Done stamp says it too (MOTIR-10534).
      await expect(
        page.getByRole('complementary').getByText('Done', { exact: true }),
      ).toBeVisible();
      await expect
        .poll(async () => (await designItem(seed)).status, { message: 'the approval commits' })
        .toBe('done');
    });

    await test.step('3 · a new version is REFUSED, and the refusal names the way forward', async () => {
      const refused = await register(page.request, seed, v1, shaFor('v2'));
      expect(refused.status(), await refused.text()).toBe(409);
      const body = (await refused.json()) as { code: string; error: string };
      expect(body.code).toBe('DESIGN_CARD_CLOSED');
      expect(body.error).toMatch(/reopen the card by hand/);
      expect(body.error).toMatch(/propose a new design card/);

      // Nothing moved: v1 is still the one current version.
      expect((await publishedPathnames(design.id)).evidenceId).toBe(v1.evidenceId);
    });

    await test.step('4 · the reviewer reopens the card from Done with the status control', async () => {
      await page
        .getByRole('main')
        .getByRole('button', { name: `Edit ${en.issueViews.status}`, exact: true })
        .click();
      await page
        .getByRole('main')
        .getByRole('combobox', { name: en.issueViews.status, exact: true })
        .click();
      const moved = page.waitForResponse(
        (r) => r.request().method() === 'POST' && Boolean(r.request().headers()['next-action']),
      );
      await page.getByRole('option', { name: 'In Progress', exact: true }).click();
      expect((await moved).status()).toBe(200);
      await expect
        .poll(async () => (await designItem(seed)).status, { message: 'the reopen commits' })
        .toBe('in_progress');
    });

    await test.step('5 · the same publish is accepted, and the new version awaits a decision', async () => {
      const accepted = await register(page.request, seed, v1, shaFor('v2'));
      expect(accepted.status(), await accepted.text()).toBe(201);
      const { evidence } = (await accepted.json()) as { evidence: { id: string } };
      expect(evidence.id).not.toBe(v1.evidenceId);
      expect((await publishedPathnames(design.id)).evidenceId).toBe(evidence.id);

      await page.goto(`/items/${seed.designKey}`);
      await expect(page.getByRole('heading', { name: seed.designTitle })).toBeVisible();
      // A new question, routed to the reviewer again — on the card as the band's
      // one door (MOTIR-5215), so the door is MOUNTED before anything is said
      // about the question behind it.
      await expect(designDoor(page)).toHaveCount(1);
      // Scoped to the SECTION that holds the gate: since MOTIR-4908 (MOTIR-5878) the page
      // header carries the decision-waiting marker, which also reads "Awaiting you".
      await expect(
        page
          .getByRole('main')
          .locator('[data-surface="card"]')
          .filter({ has: page.getByRole('heading', { level: 2, name: 'Design result' }) })
          .getByText('Awaiting you', { exact: true }),
      ).toBeVisible();
      // …and decidable again, as the first was: the new version's design and the
      // verb, in the overlay the door opens.
      await designDoor(page).click();
      const dialog = overlay(page, seed);
      const port = dialog.getByRole('group', { name: 'The subject being decided' });
      await expect(port).toBeVisible();
      await expect(port.locator('iframe').first()).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    });
  });
});
