import { createFormatter, createTranslator } from 'next-intl';
import { expect, test } from './_helpers/acceptance-video';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { resetBillingFixture, seedBillingOwner } from './_helpers/billing';
import {
  fixtureFinding,
  fixtureJob,
  readJournal,
  readPlannerFindingsFixture,
  resetPlannerFindingsJournal,
  setPlannerFindingsMode,
  storedFinding,
  writePlannerFindingsFixture,
} from './_helpers/planner-findings-fixture';
import { formatCostMicroUsd } from '@/app/(admin)/admin/planner-findings/_components/costFormat';
import type { RawPlannerFinding } from '@/lib/ai/motirAiClient';
import type { PlannerFindingsFixture } from '@/lib/test-planner-findings-mock';
import deMessages from '@/messages/de.json';
import enMessages from '@/messages/en.json';

// PLATFORM ADMINS GROUP, TRIAGE AND PROMOTE PLANNER FINDINGS — THE ACCEPTANCE
// RECEIPT (Story MOTIR-10353 · Subtask MOTIR-10528).
//
// ── WHAT THE CLIP SHOWS ─────────────────────────────────────────────────────
//
// The story's verification recipe, steps 1 to 9, as one person walks it:
//   8. a tenant owner gets the ordinary 404 for /admin and the console, and no
//      findings route is read for them;
//   1. made platform staff, they open Planner findings from the console rail,
//      switch to All findings, narrow it with each filter, remove a chip, clear
//      them, and page forward and back;
//   2. the grouped view shows a defect two plans share, and opens it;
//   3. a finding's detail with the review and repair cost beside the findings
//      made and fixed, an unpriced line, an unmetered finding and a check plan
//      finding — never a zero;
//   4–6. attribution, promote to a lesson, a bug key, dismiss and restore, each
//      checked on the re-rendered page, in the store motir-ai answers from (the
//      seam's fixture), in the request journal and in the platform audit log;
//   7. findings of a plan that was declined and of one deleted from motir-core;
//   9. motir-ai down is the unavailable state on every page, and Retry recovers;
// then support staff see no triage controls, the page in German, and an empty
// store.
//
// ── WHAT IT LEAVES TO OTHER TESTS ───────────────────────────────────────────
//
// The gate's refusals of every non-staff kind and of support on the five Server
// Actions (a browser cannot call an action from outside the page), every result
// code, the cost rule's every arm and the audit rows' metadata are the
// integration gate's (`tests/platform/plannerFindingsServicesIntegration.test.ts`
// and `plannerFindingsActionsAndPagesGate.test.ts`, MOTIR-10527). motir-ai's own
// filter, retention and regrouping behaviour are motir-ai's tests: the seam
// copies each row's fingerprint, so an attribution change is shown persisting,
// not moving group.
//
// ── PACING ──────────────────────────────────────────────────────────────────
//
// The lane holds a spec to 90s by default; this walk is the nine recipe steps
// and runs longer, so it sets its own bound (300s, as `acceptance-admin-jobs`
// does). Beats are cut before chapters if it ever runs close. Every wait is on
// the re-rendered page, the stored fixture, the journal or the audit row — never
// on a dialog closing, never a timer.
//
// One person holds every role (each extra sign-in is clip that shows nothing),
// and the German chapter switches that person's saved account language — the
// first signal the request reads — on the recorded page, because a second
// browser context would leave the recording.

const ui = enMessages.platformAdmin.plannerFindings;
const shell = enMessages.platformAdmin.shell;
const t = createTranslator({
  locale: 'en',
  messages: enMessages,
  namespace: 'platformAdmin.plannerFindings',
});
const money = (micro: number | null) =>
  formatCostMicroUsd(micro, createFormatter({ locale: 'en', timeZone: 'UTC' }));

const OWNER = 'acceptance-planner-findings@example.com';
const DISMISS_REASON = 'Noise from a dry run on a scratch plan';
const FILLERS = 52;
const BASE = '/admin/planner-findings';

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

const PRICED = [
  {
    stage: 'review' as const,
    model: 'claude-opus',
    inputTokens: 120_000,
    outputTokens: 9_000,
    sessions: 3,
    costMicroUsd: 2_475_000,
  },
  {
    stage: 'repair' as const,
    model: 'claude-opus',
    inputTokens: 40_000,
    outputTokens: 6_000,
    sessions: 2,
    costMicroUsd: 1_050_000,
  },
];

test('platform admins list, group, open, triage and promote planner findings; a tenant owner is denied and motir-ai down is never empty', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  test.setTimeout(300_000);
  acceptanceStory('MOTIR-10353');

  await resetDatabase();
  resetBillingFixture();
  resetPlannerFindingsJournal();
  const seed = await seedBillingOwner(page, OWNER);
  const tenant = {
    coreOrganizationId: seed.organizationId,
    coreWorkspaceId: seed.workspaceId,
    coreProjectId: seed.projectId,
  };

  // Two plans that existed in motir-core: one is declined, one deleted below.
  const base = { workspaceId: seed.workspaceId, projectId: seed.projectId };
  const corePlan = async (title: string, status: 'declined' | 'planned') => {
    const session = await adminDb.planChangeSession.create({ data: { ...base, targetKeys: [] } });
    return adminDb.plan.create({
      data: { ...base, sessionId: session.id, status, title, createdById: seed.ownerId },
    });
  };
  const declinedPlan = await corePlan('Billing export, declined', 'declined');
  const deletedPlan = await corePlan('Search rework, later deleted', 'planned');

  const f = (over: Partial<RawPlannerFinding> & Pick<RawPlannerFinding, 'id'>) =>
    fixtureFinding({ ...tenant, ...over });

  const named = {
    sharedA: f({
      id: 'pf_shared_a',
      site: 'leaf:ACME-12',
      fingerprint: 'fp_shared',
      planId: 'plan_checkout',
      planTitle: 'Checkout redesign',
      attribution: 'corpus',
      outcome: 'fixed',
      jobId: 'job_priced',
      why: 'The pack never says to read a path before naming it.',
      fixDirection: 'Read the file before a leaf names it.',
      hostedCell: 'author:leaf',
      planpyCell: 'leaf.author',
      createdAt: daysAgo(1),
    }),
    sharedB: f({
      id: 'pf_shared_b',
      site: 'leaf:ACME-31',
      fingerprint: 'fp_shared',
      planId: 'plan_onboarding',
      planTitle: 'Onboarding checklist',
      attribution: 'code',
      outcome: 'reported',
      jobId: 'job_bare',
      createdAt: daysAgo(1.2),
    }),
    unpriced: f({
      id: 'pf_unpriced',
      site: 'story:ACME-7',
      fingerprint: 'fp_other',
      attribution: 'model',
      outcome: 'fix_failed',
      jobId: 'job_unpriced',
      createdAt: daysAgo(1.4),
    }),
    check: f({
      id: 'pf_check',
      site: 'leaf:ACME-44',
      source: 'check_plan',
      planner: 'plan_py',
      outcome: 'reported',
      createdAt: daysAgo(1.6),
    }),
    bug: f({
      id: 'pf_bug',
      site: 'leaf:ACME-50',
      source: 'check_plan',
      planner: 'hosted',
      outcome: 'fixed',
      attribution: 'code',
      createdAt: daysAgo(1.8),
    }),
    promote: f({
      id: 'pf_promote',
      site: 'epic:ACME-2',
      why: 'Every story under the epic restated the same rule.',
      fixDirection: 'State the rule once on the epic.',
      createdAt: daysAgo(2),
    }),
    dismiss: f({ id: 'pf_dismiss', site: 'leaf:ACME-60', createdAt: daysAgo(2.2) }),
    hidden: f({
      id: 'pf_hidden',
      site: 'leaf:ACME-99',
      status: 'dismissed',
      createdAt: daysAgo(2.4),
    }),
    declined: f({
      id: 'pf_declined',
      site: 'leaf:ACME-70',
      planId: declinedPlan.id,
      planTitle: declinedPlan.title!,
      createdAt: daysAgo(2.6),
    }),
    deleted: f({
      id: 'pf_deleted',
      site: 'leaf:ACME-80',
      planId: deletedPlan.id,
      planTitle: deletedPlan.title!,
      createdAt: daysAgo(2.8),
    }),
  };
  const fillers = Array.from({ length: FILLERS }, (_, i) =>
    f({
      id: `pf_fill_${String(i).padStart(2, '0')}`,
      site: `leaf:FILL-${i}`,
      fingerprint: 'fp_filler',
      planId: 'plan_filler',
      planTitle: 'An older plan',
      createdAt: daysAgo(10 + i),
    }),
  );
  const fixture: PlannerFindingsFixture = {
    mode: 'live',
    findings: [...Object.values(named), ...fillers],
    jobs: {
      job_priced: fixtureJob(PRICED, { findingsAccepted: 5, fixed: 4 }),
      job_bare: fixtureJob(undefined, { findingsAccepted: 1 }),
      job_unpriced: fixtureJob([PRICED[0]!, { ...PRICED[1]!, costMicroUsd: null }]),
    },
  };
  writePlannerFindingsFixture(fixture);

  const main = page.getByRole('main');
  const row = (id: string) => main.getByTestId(`planner-finding-row-${id}`);
  const rows = main.locator('[data-testid^="planner-finding-row-"]');
  const groupRow = (fp: string) => main.getByTestId(`planner-findings-group-row-${fp}`);
  const findingsRoutes = () => readJournal().filter((l) => l.path.startsWith('/v1/admin/'));
  const patches = () => readJournal().filter((l) => l.method === 'PATCH');

  /** Each site in `present` shows, each in `absent` does not. */
  async function shows(present: RawPlannerFinding[], absent: RawPlannerFinding[]) {
    for (const p of present) await expect(row(p.id)).toBeVisible();
    for (const a of absent) await expect(row(a.id)).toHaveCount(0);
  }

  await chapter('The console does not exist for a non-admin', async () => {
    for (const path of [BASE, '/admin']) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(404);
    }
    await expect(page.getByRole('heading', { name: ui.title })).toHaveCount(0);
    await expect(page.getByText(named.sharedA.site)).toHaveCount(0);
    await expect(page.getByRole('link', { name: shell.navPlannerFindings })).toHaveCount(0);
    expect(findingsRoutes()).toEqual([]);
    await beat();
  });

  // The owner is made platform staff; the gate reads a fresh row per request.
  await adminDb.user.update({ where: { email: OWNER }, data: { platformRole: 'superadmin' } });

  await chapter('The list, reached from the console rail', async () => {
    await page.goto('/admin');
    const rail = page.getByRole('link', { name: shell.navPlannerFindings });
    await rail.click();
    await expect(page).toHaveURL(new RegExp(`${BASE}$`));
    await expect(page.getByRole('heading', { name: ui.title, level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: shell.navPlannerFindings })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const views = main.getByTestId('planner-findings-view-switch');
    await expect(views.getByRole('radio', { name: ui.view.grouped })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await views.getByRole('radio', { name: ui.view.all }).click();
    await expect(page).toHaveURL((url) => url.searchParams.get('view') === 'all');

    const a = row(named.sharedA.id);
    for (const text of [
      ui.source.in_loop,
      ui.planner.hosted,
      ui.attribution.corpus,
      ui.outcome.fixed,
      'Checkout redesign',
    ]) {
      await expect(a).toContainText(text);
    }
    await expect(row(named.check.id)).toContainText(ui.source.check_plan);
    await expect(row(named.check.id)).toContainText(ui.planner.plan_py);
    await expect(row(named.check.id)).toContainText(ui.attribution.unattributed);
    await expect(row(named.unpriced.id)).toContainText(ui.outcome.fix_failed);
    await expect(row(named.sharedB.id)).toContainText(ui.outcome.reported);
    await expect(row(named.hidden.id)).toHaveCount(0);
    const pager = main.getByTestId('planner-findings-pager');
    await expect(pager).toContainText(t('pager.page', { n: 1 }));
    await expect(pager.getByRole('link', { name: ui.pager.next })).toBeVisible();
    await beat();
  });

  await chapter('The filters narrow the list, and a chip comes off', async () => {
    const choose = async (filter: string, option: string, key: string, value: string) => {
      await main.getByRole('combobox', { name: filter }).click();
      await page.getByRole('option', { name: option, exact: true }).click();
      await expect(page).toHaveURL((url) => url.searchParams.get(key) === value);
    };
    const chips = main.getByTestId('planner-findings-filter-chips');

    await choose(ui.filter.source, ui.source.check_plan, 'source', 'check_plan');
    await shows([named.check, named.bug], [named.sharedA, named.promote]);
    await choose(ui.filter.planner, ui.planner.hosted, 'planner', 'hosted');
    await shows([named.bug], [named.check]);
    await expect(chips).toContainText(t('filter.count', { n: 2 }));
    await beat();

    await choose(ui.filter.attribution, ui.attribution.corpus, 'attribution', 'corpus');
    await expect(main.getByTestId('planner-findings-no-match')).toBeVisible();
    await expect(main.getByTestId('planner-findings-empty')).toHaveCount(0);
    await choose(ui.filter.outcome, ui.outcome.fixed, 'outcome', 'fixed');
    await expect(main.getByTestId('planner-findings-no-match')).toBeVisible();
    await beat();

    await chips
      .getByRole('button', { name: t('filter.remove', { filter: ui.filter.attribution }) })
      .click();
    await expect(page).toHaveURL((url) => !url.searchParams.has('attribution'));
    await shows([named.bug], [named.check]);
    await expect(chips).toContainText(t('filter.count', { n: 3 }));
    await beat();

    await chips.getByRole('button', { name: ui.filter.clearAll }).click();
    await expect(page).toHaveURL((url) => !url.searchParams.has('source'));
    await expect(chips).toHaveCount(0);
    await shows([named.sharedA, named.check, named.bug], []);
  });

  await chapter('Every page is reachable', async () => {
    await page.goto(`${BASE}?view=all`);
    await expect(rows).toHaveCount(50);
    const firstPage = await rows.evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-testid')),
    );
    const oldest = fillers[FILLERS - 1]!;
    await expect(row(oldest.id)).toHaveCount(0);

    const pager = main.getByTestId('planner-findings-pager');
    await pager.getByRole('link', { name: ui.pager.next }).click();
    await expect(pager).toContainText(t('pager.page', { n: 2 }));
    await expect(row(oldest.id)).toBeVisible();
    await expect(pager.getByRole('link', { name: ui.pager.next })).toHaveCount(0);
    await beat();

    await pager.getByRole('link', { name: ui.pager.previous }).click();
    await expect(pager).toContainText(t('pager.page', { n: 1 }));
    await expect(rows).toHaveCount(50);
    expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))).toEqual(
      firstPage,
    );
  });

  await chapter('Grouped by defect', async () => {
    await main
      .getByTestId('planner-findings-view-switch')
      .getByRole('radio', { name: ui.view.grouped })
      .click();
    await expect(page).toHaveURL((url) => !url.searchParams.has('view'));
    await expect(main.getByTestId('planner-findings-groups-table')).toBeVisible();
    await expect(groupRow('fp_shared')).toContainText(t('row.findings', { n: 2 }));
    await expect(groupRow('fp_shared')).toContainText(t('row.plans', { n: 2 }));
    await expect(groupRow('fp_filler')).toContainText(t('row.findings', { n: FILLERS }));
    await expect(groupRow('fp_filler')).toContainText(t('row.plans', { n: 1 }));
    await expect(groupRow('fp_other')).toContainText(t('row.findings', { n: 1 }));
    await beat();
  });

  await chapter('A group opens to its findings, under the same filters', async () => {
    await page.goto(`${BASE}?source=in_loop`);
    await groupRow('fp_shared').getByRole('link').first().click();
    await expect(main.getByTestId('planner-findings-group-page')).toBeVisible();
    await expect(page).toHaveURL((url) => url.searchParams.get('source') === 'in_loop');
    await expect(main.getByTestId('planner-findings-group-summary')).toContainText(
      t('group.summary', { findings: 2, plans: 2 }),
    );
    await expect(rows).toHaveCount(2);
    await shows([named.sharedA, named.sharedB], []);
    await expect(row(named.sharedA.id)).toContainText('Checkout redesign');
    await expect(row(named.sharedB.id)).toContainText('Onboarding checklist');
    await beat();

    await main.getByRole('link', { name: ui.group.back }).click();
    // The back link names the grouped view and keeps the filter it was opened under.
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === BASE &&
        (url.searchParams.get('view') ?? 'grouped') === 'grouped' &&
        url.searchParams.get('source') === 'in_loop',
    );
    await expect(main.getByTestId('planner-findings-groups-table')).toBeVisible();
  });

  const detail = main.getByTestId('planner-finding-detail');
  const openDetail = async (id: string) => {
    await page.goto(`${BASE}/${id}`);
    await expect(detail).toBeVisible();
  };

  await chapter('A finding in full, with its review and repair cost', async () => {
    await openDetail(named.sharedA.id);
    await expect(detail.getByRole('heading', { level: 1 })).toHaveText(named.sharedA.site);
    for (const text of [
      ui.prediction.STOPS,
      named.sharedA.whatHappened,
      named.sharedA.evidence,
      named.sharedA.fixDirection!,
      named.sharedA.hostedCell!,
      named.sharedA.planpyCell!,
    ]) {
      await expect(detail).toContainText(text);
    }
    const provenance = main.getByTestId('planner-finding-provenance');
    await expect(provenance).toContainText('Checkout redesign');
    await expect(provenance).toContainText('plan_checkout');

    const cost = main.getByTestId('planner-finding-cost');
    await expect(cost).toContainText(ui.cost.made);
    await expect(cost).toContainText('5');
    await expect(cost).toContainText(ui.cost.fixed);
    await expect(cost).toContainText('4');
    const lines = cost.getByTestId('planner-finding-cost-line');
    await expect(lines).toHaveCount(2);
    await expect(lines.nth(0)).toContainText(ui.cost.review);
    await expect(lines.nth(0)).toContainText(money(2_475_000)!);
    await expect(lines.nth(0)).toContainText(t('cost.sessions', { n: 3 }));
    await expect(lines.nth(1)).toContainText(ui.cost.repair);
    await expect(lines.nth(1)).toContainText(money(1_050_000)!);
    // No total: the sum of the two amounts appears nowhere.
    await expect(cost).not.toContainText(money(3_525_000)!);
    await beat();

    await openDetail(named.unpriced.id);
    const unpriced = main.getByTestId('planner-finding-cost-line').nth(1);
    await expect(unpriced).toContainText(ui.cost.unpriced);
    await expect(unpriced).not.toContainText('$');
    await beat();

    for (const id of [named.sharedB.id, named.check.id]) {
      await openDetail(id);
      const note = main.getByTestId('planner-finding-not-metered');
      await expect(note).toContainText(ui.cost.notMetered);
      await expect(note).not.toContainText('$');
      await expect(main.getByTestId('planner-finding-cost')).toHaveCount(0);
      if (id === named.check.id) await expect(note).toContainText(ui.cost.notMeteredBody);
    }
    await beat();
  });

  const triage = main.getByTestId('planner-finding-triage');
  const notice = main.getByTestId('planner-finding-triage-notice');

  await chapter('Set attribution', async () => {
    resetPlannerFindingsJournal();
    await openDetail(named.check.id);
    await triage.getByRole('button', { name: ui.attr.open }).click();
    await triage.getByRole('combobox', { name: ui.attr.label }).click();
    await page.getByRole('option', { name: ui.attribution.corpus, exact: true }).click();
    await triage.getByRole('button', { name: ui.attr.save }).click();
    await expect(notice).toHaveText(t('attr.saved', { attribution: ui.attribution.corpus }));
    expect(storedFinding(named.check.id)?.attribution).toBe('corpus');
    await beat();

    await page.reload();
    await expect(main.getByTestId('planner-finding-provenance')).toContainText(
      ui.attribution.corpus,
    );
    await page.goto(`${BASE}?view=all`);
    await expect(row(named.check.id)).toContainText(ui.attribution.corpus);

    const sent = patches();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.path).toBe(`/v1/admin/planner-findings/${named.check.id}`);
    expect(Object.keys(sent[0]!.body as object).sort()).toEqual(['actorCoreUserId', 'attribution']);
    const audit = await adminDb.platformAuditLog.findMany({
      where: { action: 'planner_finding.triage' },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ targetId: named.check.id });
    await beat();
  });

  await chapter('Promote to a lesson', async () => {
    resetPlannerFindingsJournal();
    await openDetail(named.promote.id);
    await triage.getByRole('button', { name: ui.promote.open }).click();
    const form = main.getByTestId('planner-finding-promote-form');
    const title = form.getByLabel(ui.promote.fieldTitle);
    await expect(title).toHaveValue(named.promote.site);
    await expect(form.getByLabel(ui.promote.fieldWhy)).toHaveValue(named.promote.why!);
    await expect(form.getByLabel(ui.promote.fieldHow)).toHaveValue(named.promote.fixDirection!);
    await expect(form.getByRole('combobox', { name: ui.promote.fieldType })).toBeVisible();
    const edited = 'State a shared rule once, on the epic';
    await title.fill(edited);
    await beat();
    await form.getByRole('button', { name: ui.promote.review }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText(ui.promote.confirmTitle);
    await dialog.getByRole('button', { name: ui.promote.confirm }).click();

    const link = main.getByTestId('planner-finding-lesson-link');
    await expect(link).toHaveAttribute('href', '/admin/planning-lessons/les_pf_1');
    await expect(triage.getByRole('button', { name: ui.promote.open })).toHaveCount(0);
    expect(storedFinding(named.promote.id)).toMatchObject({
      status: 'promoted_to_lesson',
      lessonId: 'les_pf_1',
    });
    const lessons = readPlannerFindingsFixture().createdLessons ?? [];
    expect(lessons).toHaveLength(1);

    // The page's own read comes first; the act is GET, POST, PATCH in that order.
    const calls = readJournal()
      .filter((l) => !l.path.startsWith('/v1/jobs/'))
      .map((l) => `${l.method} ${l.path}`);
    const created = calls.indexOf('POST /v1/lessons');
    expect(calls.slice(created - 1, created + 2)).toEqual([
      `GET /v1/admin/planner-findings/${named.promote.id}`,
      'POST /v1/lessons',
      `PATCH /v1/admin/planner-findings/${named.promote.id}`,
    ]);
    const post = readJournal().find((l) => l.method === 'POST')!.body as Record<string, string>;
    expect(post).toMatchObject({ ...tenant, title: edited, body: named.promote.whatHappened });
    await beat();
  });

  await chapter('Record a bug key, then dismiss and restore', async () => {
    resetPlannerFindingsJournal();
    await openDetail(named.bug.id);
    await triage.getByRole('button', { name: ui.bug.open }).click();
    await main.getByTestId('planner-finding-bug-key').getByLabel(ui.bug.label).fill('motir-123');
    await triage.getByRole('button', { name: ui.bug.save }).click();
    await expect(notice).toHaveText(t('bug.saved', { key: 'MOTIR-123' }));
    await expect(detail).toContainText(t('status.bugWithKey', { key: 'MOTIR-123' }));
    const bugPatch = patches()[0]!;
    expect(bugPatch.body).toMatchObject({ status: 'filed_as_bug', bugKey: 'MOTIR-123' });
    expect(Object.keys(bugPatch.body as object).sort()).toEqual([
      'actorCoreUserId',
      'bugKey',
      'status',
    ]);
    await beat();

    await openDetail(named.dismiss.id);
    await main.getByTestId('planner-finding-dismiss').click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByLabel(ui.dismiss.reasonLabel).fill(DISMISS_REASON);
    await dialog.getByRole('button', { name: ui.dismiss.confirm }).click();
    await expect(main.getByTestId('planner-finding-restore')).toBeVisible();
    expect(storedFinding(named.dismiss.id)?.status).toBe('dismissed');
    await beat();

    await page.goto(`${BASE}?view=all`);
    await expect(row(named.bug.id)).toContainText(t('status.bugWithKey', { key: 'MOTIR-123' }));
    await expect(row(named.dismiss.id)).toHaveCount(0);
    await page.goto(`${BASE}?view=all&state=dismissed`);
    await expect(row(named.dismiss.id)).toBeVisible();
    await beat();

    await openDetail(named.dismiss.id);
    await main.getByTestId('planner-finding-restore').click();
    await expect(notice).toHaveText(ui.dismiss.restored);
    await page.goto(`${BASE}?view=all`);
    await expect(row(named.dismiss.id)).toBeVisible();

    // Nothing in the walk creates a work item or files a bug.
    for (const line of readJournal()) {
      expect(['GET', 'PATCH'], `${line.method} ${line.path}`).toContain(line.method);
    }
    await beat();
  });

  await chapter('One audit row per change, none for a read', async () => {
    const audit = await adminDb.platformAuditLog.findMany({
      where: { action: 'planner_finding.triage' },
      orderBy: { seq: 'asc' },
    });
    expect(audit.map((r) => r.targetId)).toEqual([
      named.check.id,
      named.promote.id,
      named.bug.id,
      named.dismiss.id,
      named.dismiss.id,
    ]);
    const owner = await adminDb.user.findUniqueOrThrow({ where: { email: OWNER } });
    for (const r of audit) {
      expect(r).toMatchObject({ targetKind: 'platform', actorUserId: owner.id });
    }
    expect(audit[3]!.reason).toBe(DISMISS_REASON);
    // Reads add nothing: the list, the groups and a detail, then the same count.
    await page.goto(BASE);
    await openDetail(named.sharedA.id);
    expect(
      await adminDb.platformAuditLog.count({ where: { action: 'planner_finding.triage' } }),
    ).toBe(5);
  });

  await chapter('Findings of a declined plan and of a deleted one', async () => {
    await adminDb.plan.delete({ where: { id: deletedPlan.id } });
    expect(await adminDb.plan.findUnique({ where: { id: deletedPlan.id } })).toBeNull();
    expect((await adminDb.plan.findUniqueOrThrow({ where: { id: declinedPlan.id } })).status).toBe(
      'declined',
    );

    await page.goto(`${BASE}?view=all`);
    await expect(row(named.deleted.id)).toContainText(deletedPlan.title!);
    await expect(row(named.declined.id)).toContainText(declinedPlan.title!);
    for (const [finding, plan] of [
      [named.deleted, deletedPlan],
      [named.declined, declinedPlan],
    ] as const) {
      await openDetail(finding.id);
      const provenance = main.getByTestId('planner-finding-provenance');
      await expect(provenance).toContainText(plan.title!);
      await expect(provenance).toContainText(plan.id);
    }
    await beat();
  });

  await chapter('The page says so when motir-ai cannot be read', async () => {
    setPlannerFindingsMode('down');
    const unavailable = main.getByTestId('planner-findings-unavailable');
    for (const path of [
      `${BASE}?view=all`,
      BASE,
      `${BASE}/groups/fp_shared`,
      `${BASE}/pf_shared_a`,
    ]) {
      await page.goto(path);
      await expect(unavailable, path).toBeVisible();
      await expect(main.getByTestId('planner-findings-empty')).toHaveCount(0);
      await expect(main.getByTestId('planner-findings-no-match')).toHaveCount(0);
      await expect(main.locator('table')).toHaveCount(0);
      await expect(detail).toHaveCount(0);
    }
    await beat();

    await page.goto(`${BASE}?view=all`);
    await expect(unavailable).toBeVisible();
    setPlannerFindingsMode('live');
    await unavailable.getByRole('button', { name: ui.unavailable.retry }).click();
    await expect(row(named.sharedA.id)).toBeVisible();
    await beat();
  });

  await chapter('Support staff see no triage controls', async () => {
    await adminDb.user.update({ where: { email: OWNER }, data: { platformRole: 'support' } });
    await openDetail(named.sharedA.id);
    await expect(main.getByTestId('planner-finding-cost')).toBeVisible();
    await expect(triage).toHaveCount(0);
    await beat();
    await adminDb.user.update({ where: { email: OWNER }, data: { platformRole: 'superadmin' } });
    await page.reload();
    await expect(triage).toBeVisible();
  });

  await chapter('In another language', async () => {
    const de = deMessages.platformAdmin;
    expect(de.plannerFindings.title).not.toBe(ui.title);
    expect(de.plannerFindings.attribution.unattributed).not.toBe(ui.attribution.unattributed);
    await adminDb.user.update({ where: { email: OWNER }, data: { locale: 'de' } });
    await page.goto(`${BASE}?view=all`);
    await expect(
      page.getByRole('heading', { name: de.plannerFindings.title, level: 1 }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: de.shell.navPlannerFindings })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(row(fillers[0]!.id)).toContainText(de.plannerFindings.attribution.unattributed);
    await beat();
    await adminDb.user.update({ where: { email: OWNER }, data: { locale: 'en' } });
  });

  await chapter('Nothing yet', async () => {
    writePlannerFindingsFixture({ findings: [] });
    await page.goto(`${BASE}?view=all`);
    await expect(main.getByTestId('planner-findings-empty')).toBeVisible();
    await expect(main.getByTestId('planner-findings-no-match')).toHaveCount(0);
    await beat();
  });
});
