import { createTranslator } from 'next-intl';
import type { Page } from '@playwright/test';
import { expect, test } from './_helpers/acceptance-video';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { resetBillingFixture, seedBillingOwner } from './_helpers/billing';
import {
  readJournal,
  readPlannerFindingsFixture,
  recordWalkFixture,
  resetPlannerFindingsJournal,
  storedFinding,
  writePlannerFindingsFixture,
} from './_helpers/planner-findings-fixture';
import { keyForAppend } from '@/lib/workItems/positioning';
import { projectsService } from '@/lib/services/projectsService';
import type {
  RawPlannerFinding,
  RawPlannerFindingRecord as Rec,
  RawPlannerFindingRecordWithFindings,
} from '@/lib/ai/motirAiClient';
import enMessages from '@/messages/en.json';

// A PLAN CHECK'S RECORD, ITS FINDINGS' OWN PLANNING-BUG KEYS AND ITS RUN-THROUGH
// ANSWER — THE ACCEPTANCE RECEIPT (Story MOTIR-11455 · Subtask MOTIR-11507).
//
// ── WHAT THE CLIP SHOWS ─────────────────────────────────────────────────────
//
// A platform operator switches the planner-findings console to Records, opens
// an attributed record from its row, and works its findings' keys from their
// own rows: links one, re-links the one a row already carries, is refused a key
// that names no work item here and one from another project, removes one,
// removes it again as a stale tab would, and links it back. Then a record whose
// two findings share a key and one whose key's work item has since been
// deleted; the same record read as support staff; an open record; and the
// check's run-through answer in each of its three readings, each compared with
// the platform record read. It closes on the platform audit rows.
//
// ── WHAT IT LEAVES TO OTHER TESTS ───────────────────────────────────────────
//
// The route refusal matrix (every non-staff kind, tokens), the list states (no
// record, no match, loading, unavailable) and the 404 for an unknown id are the
// page and route suites'. The store's own semantics (the verdict transaction,
// the key-only PATCH) are motir-ai's tests and, for this lane's stand-in,
// `tests/test-planner-findings-mock.test.ts`. Each record's answer is SEEDED as
// the store would have written it: nothing here derives one.
//
// ── PACING ──────────────────────────────────────────────────────────────────
//
// The walk is longer than the lane's 90s default, so it sets its own bound as
// the shipped planner-findings receipt does. Every wait is on the re-rendered
// page, the platform record read, the fixture, the journal or an audit row.
//
// One person holds every role; the support chapter lowers that person's
// platform role on the recorded page, because a second browser context would
// leave the recording.

const ui = enMessages.platformAdmin.plannerFindings;
const t = createTranslator({
  locale: 'en',
  messages: enMessages,
  namespace: 'platformAdmin.plannerFindings',
});

const OWNER = 'acceptance-planner-finding-record@example.com';
const BASE = '/admin/planner-findings';
const recordUrl = (id: string) => `${BASE}/records/${id}`;
const keyUrl = (findingId: string, op: 'set' | 'remove') =>
  `/api/platform/planner-findings/${findingId}/bug-key${op === 'remove' ? '/remove' : ''}`;

test('platform staff read a plan check record, link and remove each finding’s own planning bug key, and read the check’s run-through answer', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  test.setTimeout(300_000);
  acceptanceStory('MOTIR-11455');

  await resetDatabase();
  resetBillingFixture();
  resetPlannerFindingsJournal();
  const seed = await seedBillingOwner(page, OWNER);
  const base = { workspaceId: seed.workspaceId, projectId: seed.projectId };

  // The key rule resolves a key as a work item in the RECORD's own project
  // (MOTIR-11590), so the keys the walk accepts name real rows there, and the
  // another-project key names a real row in a second project of the workspace.
  const workItem = (projectId: string, identifier: string, key: number) =>
    adminDb.workItem.create({
      data: {
        workspaceId: seed.workspaceId,
        projectId,
        kind: 'bug',
        key,
        identifier,
        title: `Planning bug ${identifier}`,
        status: 'todo',
        reporterId: seed.ownerId,
        position: keyForAppend(null),
      },
    });
  const kept = await workItem(base.projectId, 'BILL-1', 1);
  const linked = await workItem(base.projectId, 'BILL-2', 2);
  const shared = await workItem(base.projectId, 'BILL-3', 3);
  const other = await projectsService.createProject({
    workspaceId: seed.workspaceId,
    actorUserId: seed.ownerId,
    name: 'Another project',
    identifier: 'OTHR',
  });
  const elsewhere = await workItem(other.id, 'OTHR-1', 1);
  const NOWHERE = 'BILL-999';

  const walk = recordWalkFixture(
    {
      coreOrganizationId: seed.organizationId,
      coreWorkspaceId: seed.workspaceId,
      coreProjectId: seed.projectId,
      verdictBy: seed.ownerId,
    },
    { keptKey: kept.identifier, sharedKey: shared.identifier },
  );
  writePlannerFindingsFixture({ mode: 'live', ...walk });
  const [built, stops, silent] = walk.records as [Rec, Rec, Rec];
  const byId = (id: string) => walk.findings.find((f) => f.id === id)!;
  const keptRow = byId('pf_rec_kept');
  const emptyRow = byId('pf_rec_empty');

  await adminDb.user.update({ where: { email: OWNER }, data: { platformRole: 'operator' } });

  const main = page.getByRole('main');
  const findingRow = (id: string) => main.getByTestId(`record-finding-row-${id}`);
  const keyValue = (id: string) => main.getByTestId(`finding-key-value-${id}`);
  const keyAlert = (id: string) => main.getByTestId(`finding-key-alert-${id}`);
  const keyStatus = (id: string) => main.getByTestId(`finding-key-status-${id}`);
  const linkButton = (id: string) =>
    findingRow(id).getByRole('button', { name: ui.recordPage.findingKey.link, exact: true });
  const removeButton = (f: RawPlannerFinding) =>
    findingRow(f.id).getByRole('button', {
      name: t('recordPage.findingKey.removeFinding', { site: f.site }),
    });
  const keyInput = (id: string) => findingRow(id).getByRole('textbox');
  const runThrough = main.getByTestId('record-run-through');
  const triageRows = () =>
    adminDb.platformAuditLog.findMany({
      where: { action: 'planner_finding.triage' },
      orderBy: { seq: 'asc' },
    });
  const patches = () => readJournal().filter((l) => l.method === 'PATCH');

  /** The platform record read, as the console's session asks for it. */
  async function platformRecord(id: string): Promise<RawPlannerFindingRecordWithFindings> {
    const res = await page.request.get(`/api/platform/planner-findings/records/${id}`);
    expect(res.status(), `GET record ${id}`).toBe(200);
    return (await res.json()) as RawPlannerFindingRecordWithFindings;
  }
  const keysOf = async (id: string) =>
    Object.fromEntries((await platformRecord(id)).findings.map((f) => [f.id, f.bugKey]));

  /** Each row draws exactly the key the store holds; an empty one draws no text. */
  async function rowsShow(expected: Record<string, string | null>) {
    for (const [id, key] of Object.entries(expected)) {
      if (key) await expect(keyValue(id)).toHaveText(key);
      else await expect(keyValue(id)).toHaveText(ui.recordPage.findingKey.a11y.empty);
    }
  }

  /** What a finding's verdict put on its row, which no key write may move. */
  async function verdictOutputs(f: RawPlannerFinding) {
    await expect(findingRow(f.id)).toContainText(f.why!);
    await expect(findingRow(f.id)).toContainText(f.hostedCell!);
    await expect(findingRow(f.id)).toContainText(
      ui.attribution[f.attribution as keyof typeof ui.attribution],
    );
  }

  async function crafted(page: Page, findingId: string, op: 'set' | 'remove', key: string) {
    return page.request.post(keyUrl(findingId, op), { data: { key } });
  }

  const answerBefore = await platformRecord(built.id);

  await chapter('Records, reached from the view switch', async () => {
    await page.goto(BASE);
    await main
      .getByTestId('planner-findings-view-switch')
      .getByRole('radio', { name: ui.view.records })
      .click();
    await expect(page).toHaveURL((url) => url.searchParams.get('view') === 'records');
    const card = main.getByTestId('planner-finding-records-card');
    await expect(card.getByRole('heading', { name: ui.records.title })).toBeVisible();
    const rows = card.locator('tbody [data-testid^="planner-finding-record-row-"]');
    await expect(rows).toHaveCount(3);
    expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))).toEqual(
      [built, stops, silent].map((r) => `planner-finding-record-row-${r.id}`),
    );
    const row = (id: string) => card.getByTestId(`planner-finding-record-row-${id}`);
    await expect(row(built.id)).toContainText(ui.records.verdict.attributed);
    await expect(row(stops.id)).toContainText(ui.records.verdict.open);
    await expect(row(built.id)).toContainText(built.planTitle!);
    // Two findings each; the open record's one pre-verdict attribution counts.
    await expect(row(built.id).locator('td').nth(5)).toHaveText('2');
    await expect(row(built.id).locator('td').nth(6)).toHaveText('2');
    await expect(row(stops.id).locator('td').nth(6)).toHaveText('1');
    await beat();
    await card.getByRole('link', { name: t('records.row.open', { id: built.id }) }).click();
    await expect(page).toHaveURL(new RegExp(`${recordUrl(built.id)}$`));
  });

  await chapter('An attributed record: its context, its findings and their own keys', async () => {
    const context = main.getByTestId('record-plan-context');
    await expect(context).toBeVisible();
    await expect(main.getByTestId('record-plan-context')).toHaveCount(1);
    await expect(context).toContainText(built.planTitle!);
    await expect(context).toContainText(built.planSessionId!);
    await expect(context).toContainText(built.jobId!);
    await expect(context).toContainText(ui.records.verdict.attributed);
    await verdictOutputs(keptRow);
    await verdictOutputs(emptyRow);
    await rowsShow({ [keptRow.id]: kept.identifier, [emptyRow.id]: null });
    // The empty cell carries no dash and no warning: only its hidden label.
    await expect(keyValue(emptyRow.id)).not.toContainText('—');
    for (const f of [keptRow, emptyRow]) await expect(linkButton(f.id)).toBeVisible();
    await expect(removeButton(keptRow)).toBeVisible();
    await expect(removeButton(emptyRow)).toHaveCount(0);
    await expect(main.getByTestId('record-command')).toHaveCount(0);
    await beat();
  });

  await chapter('A key in this record’s project is linked from its row', async () => {
    resetPlannerFindingsJournal();
    await keyInput(emptyRow.id).fill(linked.identifier.toLowerCase());
    await beat();
    await linkButton(emptyRow.id).click();
    await expect(keyStatus(emptyRow.id)).toContainText(
      t('recordPage.findingKey.linked', { key: linked.identifier }),
    );
    await expect(keyValue(emptyRow.id)).toHaveText(linked.identifier);
    await page.reload();
    await rowsShow({ [keptRow.id]: kept.identifier, [emptyRow.id]: linked.identifier });
    expect(await keysOf(built.id)).toMatchObject({
      [keptRow.id]: kept.identifier,
      [emptyRow.id]: linked.identifier,
    });
    expect(patches().map((l) => [l.path, l.body])).toEqual([
      [
        `/v1/admin/planner-findings/${emptyRow.id}`,
        { bugKey: linked.identifier, actorCoreUserId: seed.ownerId },
      ],
    ]);
    await beat();
  });

  await chapter('Both rows keep their own key and their own verdict', async () => {
    await rowsShow({ [keptRow.id]: kept.identifier, [emptyRow.id]: linked.identifier });
    await verdictOutputs(keptRow);
    await verdictOutputs(emptyRow);
    for (const id of [keptRow.id, emptyRow.id]) {
      const stored = storedFinding(id)!;
      expect(stored.why).toBe(byId(id).why);
      expect(stored.attribution).toBe(byId(id).attribution);
    }
  });

  await chapter('Linking the key a row already carries changes nothing', async () => {
    resetPlannerFindingsJournal();
    const audit = (await triageRows()).length;
    await expect(keyInput(keptRow.id)).toHaveValue(kept.identifier);
    await linkButton(keptRow.id).click();
    // The nothing-changed notice, in the row's status slot — never a refusal.
    await expect(keyStatus(keptRow.id)).toContainText(
      t('recordPage.findingKey.unchanged', { key: kept.identifier }),
    );
    await expect(keyAlert(keptRow.id)).toHaveText('');
    await rowsShow({ [keptRow.id]: kept.identifier, [emptyRow.id]: linked.identifier });
    expect(patches()).toEqual([]);
    expect((await triageRows()).length).toBe(audit);
    await beat();
  });

  for (const [label, key] of [
    ['A key that names no work item here is refused in its own row', NOWHERE],
    ['A real work item from another project is refused the same way', elsewhere.identifier],
  ] as const) {
    await chapter(label, async () => {
      await page.reload();
      resetPlannerFindingsJournal();
      const audit = (await triageRows()).length;
      await keyInput(emptyRow.id).fill(key);
      await linkButton(emptyRow.id).click();
      await expect(keyAlert(emptyRow.id)).toContainText(
        t('recordPage.findingKey.notAWorkItem', { key }),
      );
      // The typed key stays; the store and every other row are as they were.
      await expect(keyInput(emptyRow.id)).toHaveValue(key);
      await expect(keyAlert(keptRow.id)).toHaveText('');
      await rowsShow({ [keptRow.id]: kept.identifier, [emptyRow.id]: linked.identifier });
      expect(patches()).toEqual([]);
      expect((await triageRows()).length).toBe(audit);
      expect(await keysOf(built.id)).toMatchObject({ [emptyRow.id]: linked.identifier });
      await beat();
    });
  }

  await chapter('A key is removed from its own row', async () => {
    await page.reload();
    resetPlannerFindingsJournal();
    await removeButton(keptRow).click();
    await expect(keyStatus(keptRow.id)).toContainText(ui.recordPage.findingKey.removed);
    await expect(removeButton(keptRow)).toHaveCount(0);
    await page.reload();
    await rowsShow({ [keptRow.id]: null, [emptyRow.id]: linked.identifier });
    await verdictOutputs(keptRow);
    expect(await keysOf(built.id)).toMatchObject({
      [keptRow.id]: null,
      [emptyRow.id]: linked.identifier,
    });
    expect(patches().map((l) => l.body)).toEqual([{ bugKey: null, actorCoreUserId: seed.ownerId }]);
    await beat();
  });

  await chapter('Removing it again, as a stale tab would, changes nothing', async () => {
    resetPlannerFindingsJournal();
    const audit = (await triageRows()).length;
    const res = await crafted(page, keptRow.id, 'remove', kept.identifier);
    expect(res.status()).toBe(200);
    expect(((await res.json()) as { finding: RawPlannerFinding }).finding.bugKey).toBeNull();
    expect(patches()).toEqual([]);
    expect((await triageRows()).length).toBe(audit);
    await page.reload();
    await rowsShow({ [keptRow.id]: null, [emptyRow.id]: linked.identifier });
    await expect(keyAlert(keptRow.id)).toHaveText('');
    await expect(keyStatus(keptRow.id)).toHaveText('');
  });

  await chapter('The key is linked back, and the finding page opens from its row', async () => {
    await keyInput(keptRow.id).fill(kept.identifier);
    await linkButton(keptRow.id).click();
    await expect(keyValue(keptRow.id)).toHaveText(kept.identifier);
    await page.reload();
    await rowsShow({ [keptRow.id]: kept.identifier, [emptyRow.id]: linked.identifier });
    expect(await keysOf(built.id)).toMatchObject({ [keptRow.id]: kept.identifier });
    await beat();
    await findingRow(keptRow.id).getByRole('link', { name: keptRow.site }).click();
    await expect(page).toHaveURL(new RegExp(`${BASE}/${keptRow.id}$`));
    const back = main.getByTestId('planner-finding-record-link');
    await expect(back).toContainText(ui.detail.record);
    await expect(back.getByRole('link', { name: built.id })).toHaveAttribute(
      'href',
      recordUrl(built.id),
    );
    await beat();
    await back.getByRole('link', { name: built.id }).click();
    await expect(page).toHaveURL(new RegExp(`${recordUrl(built.id)}$`));
  });

  await chapter('Two findings of one record carry the same key', async () => {
    await page.goto(recordUrl(silent.id));
    const [a, b] = walk.findings.filter((f) => f.recordId === silent.id);
    await rowsShow({ [a!.id]: shared.identifier, [b!.id]: shared.identifier });
    await expect(removeButton(a!)).toBeVisible();
    await expect(removeButton(b!)).toBeVisible();
    for (const f of [a!, b!]) await expect(keyAlert(f.id)).toHaveText('');
    await beat();
  });

  await chapter('A key whose work item was deleted is still drawn as stored', async () => {
    await adminDb.workItem.delete({ where: { id: shared.id } });
    await page.reload();
    const [a, b] = walk.findings.filter((f) => f.recordId === silent.id);
    await rowsShow({ [a!.id]: shared.identifier, [b!.id]: shared.identifier });
    await expect(main.getByRole('alert').filter({ hasText: /\S/ })).toHaveCount(0);
    await beat();
  });

  await chapter('Support staff read the record and its keys, with no control', async () => {
    await adminDb.user.update({ where: { email: OWNER }, data: { platformRole: 'support' } });
    await page.goto(recordUrl(built.id));
    await expect(main.getByTestId('record-plan-context')).toContainText(built.planTitle!);
    await rowsShow({ [keptRow.id]: kept.identifier, [emptyRow.id]: linked.identifier });
    await verdictOutputs(keptRow);
    const findings = main.getByTestId('record-findings');
    await expect(findings.getByRole('textbox')).toHaveCount(0);
    await expect(findings.getByRole('button')).toHaveCount(0);
    // No dead tab stop: the only focusable things in the table are the site links.
    expect(
      await findings.evaluate(
        (el) =>
          [...el.querySelectorAll<HTMLElement>('a, button, input, [tabindex]')].filter(
            (n) => n.tagName !== 'A',
          ).length,
      ),
    ).toBe(0);
    await beat();

    const res = await crafted(page, emptyRow.id, 'remove', linked.identifier);
    expect(res.status()).toBe(404);
    expect(storedFinding(emptyRow.id)!.bugKey).toBe(linked.identifier);
    await adminDb.user.update({ where: { email: OWNER }, data: { platformRole: 'operator' } });
  });

  await chapter('An open record draws no key control, and refuses a crafted write', async () => {
    await page.goto(recordUrl(stops.id));
    const [a, b] = walk.findings.filter((f) => f.recordId === stops.id);
    const findings = main.getByTestId('record-findings');
    await expect(main.getByTestId('record-findings-open-line')).toHaveText(
      ui.recordPage.findingKey.openRecord,
    );
    await rowsShow({ [a!.id]: kept.identifier, [b!.id]: null });
    await expect(findings.getByRole('textbox')).toHaveCount(0);
    await expect(findings.getByRole('button')).toHaveCount(0);
    // A pre-verdict attribution is withheld until the verdict lands.
    await expect(findingRow(a!.id)).not.toContainText(a!.why!);
    await expect(main.getByTestId('record-command')).toContainText(
      t('record.command.line', { id: stops.id }),
    );
    await beat();

    resetPlannerFindingsJournal();
    const res = await crafted(page, b!.id, 'set', kept.identifier);
    expect(res.status()).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'FINDING_KEY_REFUSED', reason: 'record_open' });
    expect(patches()).toEqual([]);
    expect(await keysOf(stops.id)).toEqual({ [a!.id]: kept.identifier, [b!.id]: null });
  });

  /** The block's reading, and that it matches the stored answer the read gives. */
  async function readsAnswer(id: string, reading: 'thru' | 'stops' | 'none', words: string) {
    await page.goto(recordUrl(id));
    await expect(runThrough).toBeVisible();
    await expect(runThrough.locator(`[data-reading="${reading}"]`)).toHaveText(words);
    // Its own region, never inside the header that carries the verdict chip.
    await expect(
      main.getByTestId('record-plan-context').getByTestId('record-run-through'),
    ).toHaveCount(0);
    await expect(runThrough).not.toContainText(ui.records.verdict.attributed);
    await expect(runThrough).not.toContainText(ui.records.verdict.open);
    const stored = (await platformRecord(id)).record;
    const expected = { thru: 'THRU', stops: 'STOPS', none: null }[reading];
    expect(stored.runThroughAnswer).toBe(expected);
    return stored;
  }

  resetPlannerFindingsJournal();

  await chapter('The attributed record builds through', async () => {
    await readsAnswer(built.id, 'thru', ui.recordPage.runThrough.answer.thru);
    await expect(runThrough.getByRole('list')).toHaveCount(0);
    await beat();
  });

  await chapter('The open record does not, with the cards to fix', async () => {
    const stored = await readsAnswer(stops.id, 'stops', ui.recordPage.runThrough.answer.stops);
    const chips = runThrough.getByRole('listitem');
    await expect(chips).toHaveText(stored.runThroughStopCards);
    expect(stored.runThroughStopCards).toEqual(stops.runThroughStopCards);
    await expect(runThrough.getByRole('link')).toHaveCount(0);
    await beat();
  });

  await chapter('The third record has no answer recorded', async () => {
    await readsAnswer(silent.id, 'none', ui.recordPage.runThrough.answer.none);
    await expect(runThrough).not.toContainText(ui.recordPage.runThrough.answer.thru);
    await expect(runThrough).toContainText(ui.recordPage.runThrough.hint.none);
    await beat();
  });

  await chapter('Nothing on a record page changes the answer', async () => {
    // The three answer chapters issued reads only.
    for (const line of readJournal()) expect(line.method, line.path).toBe('GET');
    for (const id of [built.id, stops.id, silent.id]) {
      await page.goto(recordUrl(id));
      await expect(runThrough.getByRole('button')).toHaveCount(0);
      await expect(runThrough.getByRole('textbox')).toHaveCount(0);
      // The page's only buttons are each row's Link / Remove and the copy button.
      const names = await main
        .getByTestId('planner-finding-record')
        .getByRole('button')
        .allTextContents();
      for (const name of names) {
        expect([
          ui.recordPage.findingKey.link,
          ui.recordPage.findingKey.remove,
          ui.record.command.copy,
        ]).toContain(name.trim());
      }
    }
    const after = await platformRecord(built.id);
    expect(after.record.runThroughAnswer).toBe(answerBefore.record.runThroughAnswer);
    expect(after.record.runThroughStopCards).toEqual(answerBefore.record.runThroughStopCards);
    // The fixture still holds the answers exactly as seeded.
    expect(readPlannerFindingsFixture().records!.map((r) => [r.id, r.runThroughAnswer])).toEqual(
      walk.records!.map((r) => [r.id, r.runThroughAnswer]),
    );
  });

  await chapter('One audit row per change, none for a refusal or a no-op', async () => {
    const rows = (await triageRows()).filter(
      (r) => (r.metadata as { recordId?: string } | null)?.recordId === built.id,
    );
    expect(
      rows.map((r) => {
        const m = r.metadata as { findingId: string; key: string };
        return [r.targetId, m.findingId, m.key];
      }),
    ).toEqual([
      [emptyRow.id, emptyRow.id, linked.identifier],
      [keptRow.id, keptRow.id, kept.identifier],
      [keptRow.id, keptRow.id, kept.identifier],
    ]);
    for (const r of rows) expect(r).toMatchObject({ actorUserId: seed.ownerId });
    // No row names the other project's work item or the key that named nothing.
    const all = JSON.stringify((await triageRows()).map((r) => r.metadata));
    expect(all).not.toContain(NOWHERE);
    expect(all).not.toContain(elsewhere.identifier);
  });
});
