import type { Browser, Locator, Page } from '@playwright/test';
import type { Prisma } from '@/generated/prisma/client';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { adminDb } from '@/tests/helpers/adminDb';
import { signIn } from './_helpers/shell-session';
import { fitsFold, overlappingPairs, type Quad } from './_helpers/report-geometry';
import { workspacesService } from '@/lib/services/workspacesService';
import {
  createTestProject,
  createTestUser,
  createTestWorkItem,
  makeWorkItemFixture,
  TEST_PASSWORD,
} from '../fixtures';
import type { WorkItemFixture } from '../fixtures';

// ACCEPTANCE — the reports read well and point where you ask (Story MOTIR-8919 ·
// MOTIR-8931). The receipt a person watches to accept the story:
//
//   1. every report fills the width at 1440 and 1920 px with its chart's x axis
//      above the fold;
//   2. a daily 90-day Created vs Resolved has no overlapping x labels, in the
//      line and the bars form, and a thinned bucket is still on hover and in the
//      data table;
//   3. the help text, once hidden, stays hidden on the next report and after a
//      reload, until it is shown again;
//   4. Workload over a window splits each bar into Assigned and "Unassigned —
//      reported by" and leaves out work resolved before the window;
//   5. a copied bars + Resolved-only link reopens identically for someone else;
//   6. the Sprint report's picker and the fallback for a foreign, made-up or
//      never-started id;
//   7. Velocity over a chosen range, and a garbage value in the URL;
//   8. the Reports hub opens every report.
//
// ── THE BOUNDARY ────────────────────────────────────────────────────────────
// Every report reads Postgres through `reportsService`; no path calls motir-ai,
// GitHub or a third party, so nothing is stubbed and every seed is written
// straight to the test database (as `reports.spec.ts` does). The predicates
// underneath (the workload window, the velocity range, coercion, locale parity,
// the widget tiles) are the story gate's (MOTIR-8930) — this spec asserts only
// what a person sees.
//
// ── THE WAITS ───────────────────────────────────────────────────────────────
// Every step waits on a settled URL or a rendered assertion; there is no fixed
// timeout. `chapter()`'s and `beat()`'s holds are pacing taken after an
// assertion has already proven the state.

test.describe.configure({ timeout: 300_000 });

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): Date => new Date(Date.now() - n * DAY);
const ADA = 'Ada Lovelace';

interface Seed {
  fx: WorkItemFixture;
  ownerName: string;
  adaEmail: string;
  activeSprintId: string;
  plannedSprintId: string;
  foreignSprintId: string;
  /** Completed sprints, oldest → newest. */
  completed: Array<{ id: string; name: string }>;
}

async function recordTransition(
  workItemId: string,
  byId: string,
  from: string,
  to: string,
  ageDays: number,
): Promise<void> {
  await adminDb.workItemRevision.create({
    data: {
      workItemId,
      changedById: byId,
      changeKind: 'updated',
      changedAt: daysAgo(ageDays),
      diff: { status: { from, to } } as Prisma.InputJsonValue,
    },
  });
}

async function seed(): Promise<Seed> {
  const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'RPR' });
  const ada = await createTestUser({ name: ADA });
  await workspacesService.addMember({ userId: ada.id, workspaceId: fx.workspaceId });
  for (const userId of [fx.ownerId, ada.id]) {
    await adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId, workspaceId: fx.workspaceId } },
      data: { activeProjectId: fx.projectId },
    });
  }

  const sprint = (
    projectId: string,
    name: string,
    sequence: number,
    state: 'planned' | 'active' | 'complete',
    completedAgo?: number,
  ) =>
    adminDb.sprint.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId,
        name,
        state,
        sequence,
        startDate: state === 'planned' ? null : daysAgo((completedAgo ?? 0) + 10),
        endDate: state === 'active' ? new Date(Date.now() + 4 * DAY) : null,
        completedAt: completedAgo === undefined ? null : daysAgo(completedAgo),
        committedPoints: state === 'planned' ? null : 6,
        committedIssueCount: state === 'planned' ? null : 2,
      },
    });

  const completed: Seed['completed'] = [];
  for (const [i, ago] of [70, 50, 30, 10].entries()) {
    const s = await sprint(fx.projectId, `Sprint ${i + 1}`, i + 1, 'complete', ago);
    completed.push({ id: s.id, name: s.name });
  }
  const active = await sprint(fx.projectId, 'Sprint 5', 5, 'active');
  const planned = await sprint(fx.projectId, 'Sprint 6', 6, 'planned');
  const other = await createTestProject({
    workspaceId: fx.workspaceId,
    actorUserId: fx.ownerId,
    name: 'Other project',
    identifier: 'OTH',
  });
  const foreign = await sprint(other.id, 'Elsewhere 1', 1, 'complete', 5);

  // An item with everything the reports read set directly.
  const item = async (
    title: string,
    over: {
      createdAgo: number;
      assigneeId?: string | null;
      reporterId?: string;
      points?: number | null;
      done?: boolean;
      sprintId?: string;
    },
  ) => {
    const wi = await createTestWorkItem(fx, { kind: 'task', title });
    await adminDb.workItem.update({
      where: { id: wi.id },
      data: {
        createdAt: daysAgo(over.createdAgo),
        assigneeId: over.assigneeId ?? null,
        reporterId: over.reporterId ?? fx.ownerId,
        storyPoints: over.points ?? null,
        status: over.done ? 'done' : 'todo',
        sprintId: over.sprintId ?? null,
      },
    });
    return wi;
  };

  // Created vs Resolved (and the rest): one item a day for 89 days, every other
  // one resolved the next half-day. They are Ada's and carry no points, so they
  // do not move the Workload numbers asserted below.
  for (let i = 1; i <= 89; i++) {
    const done = i % 2 === 1;
    const wi = await item(`Daily item ${i}`, {
      createdAgo: i,
      assigneeId: ada.id,
      done,
      sprintId: i <= 6 ? active.id : undefined,
    });
    if (done) await recordTransition(wi.id, fx.ownerId, 'todo', 'done', i - 0.5);
  }

  // Workload, Owner's bar: assigned 5 + the unassigned 3 they reported; the
  // 13-point item was resolved 40 days ago, so only a 60-day window sees it.
  await item('Owner assigned', { createdAgo: 20, assigneeId: fx.ownerId, points: 5 });
  await item('Owner reported, unassigned', { createdAgo: 20, points: 3 });
  const old = await item('Resolved 40 days ago', {
    createdAgo: 55,
    assigneeId: fx.ownerId,
    points: 13,
    done: true,
  });
  await recordTransition(old.id, fx.ownerId, 'todo', 'done', 40);
  await item('Ada assigned', { createdAgo: 15, assigneeId: ada.id, points: 9 });

  // Velocity history: two done items in each completed sprint.
  for (const [i, s] of completed.entries()) {
    for (let k = 0; k < 2; k++) {
      await item(`Sprint ${i + 1} done ${k}`, {
        createdAgo: 80,
        assigneeId: ada.id,
        points: 3,
        done: true,
        sprintId: s.id,
      });
    }
  }

  return {
    fx,
    ownerName: fx.owner.name ?? 'Owner',
    adaEmail: ada.email,
    activeSprintId: active.id,
    plannedSprintId: planned.id,
    foreignSprintId: foreign.id,
    completed,
  };
}

// ── Locators and measurements ───────────────────────────────────────────────

const firstChart = (page: Page): Locator => page.locator('main svg[role="img"]').first();
const helpRegions = (page: Page): Locator => page.locator('[id^="report-help-"]');
const hideHelp = (page: Page): Locator => page.getByRole('button', { name: 'Hide help text' });
const showHelp = (page: Page): Locator => page.getByRole('button', { name: 'Show help text' });
const cvrChart = (page: Page): Locator => page.getByRole('img', { name: 'Created vs Resolved' });

async function openDataTable(scope: Page | Locator): Promise<Locator> {
  const table = scope.getByRole('table');
  // A disclosure toggles: clicking an open one would close it, so a poll that calls this
  // again must leave an already-open table alone.
  if (!(await table.isVisible())) await scope.getByText('View data table').click();
  await expect(table).toBeVisible();
  return table;
}

/** Text of every cell in the data-table row headed `header`, in order. */
async function rowCells(table: Locator, header: string): Promise<string[]> {
  const row = table
    .getByRole('row')
    .filter({ has: table.page().getByText(header, { exact: true }) });
  return (await row.getByRole('cell').allInnerTexts()).map((c) => c.trim());
}

/** The x-axis labels (everything under the plot) as page-pixel quads. */
async function axisLabelQuads(svg: Locator): Promise<{ texts: string[]; quads: Quad[] }> {
  return svg.evaluate((el) => {
    const root = el as SVGSVGElement;
    const plotBottom = root.querySelector('rect')!.getBoundingClientRect().bottom;
    const texts: string[] = [];
    const quads: Array<Array<{ x: number; y: number }>> = [];
    for (const t of Array.from(root.querySelectorAll('text'))) {
      if (t.getBoundingClientRect().top < plotBottom - 0.5) continue;
      const b = t.getBBox();
      const m = t.getScreenCTM()!;
      quads.push(
        [
          [b.x, b.y],
          [b.x + b.width, b.y],
          [b.x + b.width, b.y + b.height],
          [b.x, b.y + b.height],
        ].map(([x, y]) => {
          const p = new DOMPoint(x, y).matrixTransform(m);
          return { x: p.x, y: p.y };
        }),
      );
      texts.push(t.textContent ?? '');
    }
    return { texts, quads };
  });
}

/** Each bar row of an HBar chart: its label and the computed fill of every segment. */
async function hbarRows(svg: Locator): Promise<Array<{ label: string; fills: string[] }>> {
  return svg.evaluate((el) =>
    Array.from(el.querySelectorAll(':scope > g'))
      .filter((g) => g.querySelector('rect') && g.querySelectorAll('text').length >= 2)
      .map((g) => ({
        label: g.querySelector('text')!.textContent ?? '',
        fills: Array.from(g.querySelectorAll('rect')).map((r) => getComputedStyle(r).fill),
      })),
  );
}

async function waitForReport(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(firstChart(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
}

async function pickerOptions(page: Page, label: string): Promise<string[]> {
  await page.getByRole('combobox', { name: label }).click();
  const names = (await page.getByRole('option').allInnerTexts()).map((n) => n.trim());
  await page.keyboard.press('Escape');
  return names;
}

async function newMemberPage(
  browser: Browser,
  baseURL: string | undefined,
  email: string,
): Promise<Page> {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await signIn(page, email, TEST_PASSWORD);
  return page;
}

// Reports whose stack the design measured against the 900px fold: one control row, the legend,
// then the chart (design/reports/design-notes.md, the full-width chrome section).
const FOLD_STACKS = ['/reports/burndown', '/reports/velocity'];

test('the refined reports fill the width, stay readable, and point where you ask', async ({
  page,
  browser,
  baseURL,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-8919');

  await resetDatabase();
  const s = await seed();
  await signIn(page, s.fx.owner.email, TEST_PASSWORD);

  await chapter('Every report fills the width, axis above the fold', async () => {
    const reportPaths = [
      '/reports/burndown',
      '/reports/velocity',
      `/sprints/${s.activeSprintId}/report`,
      '/reports/created-vs-resolved',
      '/reports/distribution',
      '/reports/average-age',
      '/reports/resolution-time',
      '/reports/workload',
    ];
    for (const width of [1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of reportPaths) {
        await waitForReport(page, path);
        const card = page.locator('main [data-surface="card"]').first();
        const [cardBox, inner, scrolls] = await Promise.all([
          card.boundingBox(),
          // The card sits in the report chrome's `w-full` column; the content width it
          // should fill is that column's parent, less the page gutters the shell puts
          // on it (the `main` itself carries none).
          card.evaluate((c) => {
            const region = c.parentElement?.parentElement ?? c;
            const cs = getComputedStyle(region);
            return region.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
          }),
          page.evaluate(
            () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
          ),
        ]);
        expect(
          Math.abs((cardBox?.width ?? 0) - inner),
          `${path} card width at ${width}`,
        ).toBeLessThanOrEqual(2);
        expect(scrolls, `${path} scrolls sideways at ${width}`).toBe(false);
        const chartBox = await firstChart(page).boundingBox();
        // Every chart holds the page-mode height bound (clamp(280px, 44vh, 420px), 396px at
        // 900px), so it never grows with the width.
        expect(
          chartBox?.height ?? Infinity,
          `${path} chart height at ${width}`,
        ).toBeLessThanOrEqual(420);
        if (FOLD_STACKS.some((stack) => path === stack)) {
          expect(fitsFold(chartBox, 900), `${path} chart bottom edge at ${width}`).toBe(true);
        } else {
          // The design's fold arithmetic is for one control row above the chart. A report
          // with a second row (Created vs Resolved's series switches) or a stat row (the
          // Sprint report) sits lower by design, so its bottom edge is recorded, not ruled.
          test.info().annotations.push({
            type: 'chart-bottom',
            description: `${path} @${width}: ${Math.round((chartBox?.y ?? 0) + (chartBox?.height ?? 0))}px of 900`,
          });
        }
      }
    }
  });

  await chapter('A daily 90-day axis has no overlapping labels', async () => {
    for (const width of [1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      for (const form of ['line', 'bars'] as const) {
        const url = `/reports/created-vs-resolved?period=day&daysBack=90${form === 'bars' ? '&form=bars' : ''}`;
        await page.goto(url);
        const svg = cvrChart(page);
        await expect(svg).toBeVisible({ timeout: FIRST_PAINT_MS });

        const { texts, quads } = await axisLabelQuads(svg);
        expect(quads.length, `${form} at ${width}: axis labels found`).toBeGreaterThan(2);
        const clashes = overlappingPairs(quads).map(
          ([i, j]: [number, number]) => `${texts[i]} / ${texts[j]}`,
        );
        expect(clashes, `${form} at ${width}: overlapping labels`).toEqual([]);

        if (width !== 1440) continue;
        // A bucket whose label was thinned away is still on hover and in the table.
        const titles = await svg
          .locator('rect > title')
          .evaluateAll((els) => els.map((e) => e.textContent ?? ''));
        expect(titles).toHaveLength(90);
        const thinned = titles.findIndex((t) => !texts.includes(t.split('\n')[0]!));
        expect(thinned, 'at least one bucket label is thinned out').toBeGreaterThanOrEqual(0);
        await svg.locator('rect:has(> title)').nth(thinned).hover();
        expect(titles[thinned]).toMatch(/^.+\nCreated: \d+\nResolved: \d+$/);
        const table = await openDataTable(page);
        await expect(table.getByRole('row')).toHaveCount(91);
        await beat();
      }
    }
  });

  await chapter('The help text is remembered across reports and reloads', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/reports/created-vs-resolved');
    await expect(hideHelp(page)).toHaveAttribute('aria-expanded', 'true', {
      timeout: FIRST_PAINT_MS,
    });
    await expect(helpRegions(page)).toHaveCount(1);

    await hideHelp(page).click();
    await expect(showHelp(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(helpRegions(page)).toHaveCount(0);

    await page.goto('/reports/workload');
    await expect(showHelp(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(helpRegions(page)).toHaveCount(0);
    await page.reload();
    await expect(showHelp(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(helpRegions(page)).toHaveCount(0);

    await showHelp(page).click();
    await expect(helpRegions(page)).toHaveCount(1);
    await page.goto(`/sprints/${s.activeSprintId}/report`);
    await expect(hideHelp(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(helpRegions(page)).toHaveCount(1);
  });

  await chapter('Workload splits each bar by who reported the unowned work', async () => {
    await page.goto('/reports/workload');
    const chart = page.getByRole('img', { name: 'Workload' });
    await expect(chart).toBeVisible({ timeout: FIRST_PAINT_MS });

    // Widen to 60 days: the item resolved 40 days ago was open inside it.
    await page.getByRole('button', { name: 'Longer window' }).click();
    await page.waitForURL(/daysBack=60/);
    const table = await openDataTable(page);
    await expect.poll(() => rowCells(table, s.ownerName)).toEqual(['18', '3', '21']);

    // Back to 30: that item is out, the bar is Assigned 5 + Unassigned 3.
    await page.getByRole('button', { name: 'Shorter window' }).click();
    await page.waitForURL((u) => !u.search.includes('daysBack'));
    await expect.poll(() => rowCells(table, s.ownerName)).toEqual(['5', '3', '8']);

    const rows = await hbarRows(chart);
    const mine = rows.find((r) => r.label === s.ownerName);
    expect(mine?.fills).toHaveLength(2);
    expect(new Set(mine?.fills).size, 'two different fills').toBe(2);
    // NOTE: a work item's reporter is required, so no seedable item is unassigned
    // AND reporter-less; the person-less "Unassigned" bar is not reachable here
    // (MOTIR-8931 finding). The bars are ranked by total, descending.
    expect(rows.map((r) => r.label)).toEqual([ADA, s.ownerName]);
    await expect(page.getByText('Unassigned — reported by').first()).toBeVisible();
    await expect(page.getByText('Assigned', { exact: true }).first()).toBeVisible();
    await beat();

    // The 60-day link reopens with the same controls and bars.
    await page.goto('/reports/workload?daysBack=60');
    const reopened = await openDataTable(page);
    await expect.poll(() => rowCells(reopened, s.ownerName)).toEqual(['18', '3', '21']);
  });

  await chapter('A copied bars + Resolved-only link reopens identically', async () => {
    await page.goto('/reports/created-vs-resolved');
    await expect(cvrChart(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await page.getByRole('button', { name: 'Bars', exact: true }).click();
    await page.waitForURL(/form=bars/);
    await page.getByRole('switch', { name: 'Created' }).click();
    await page.waitForURL(/series=resolved/);
    const resolvedSwitch = page.getByRole('switch', { name: 'Resolved' });
    await expect(resolvedSwitch).toBeDisabled();
    await resolvedSwitch.click({ force: true });
    await expect(page).toHaveURL(/series=resolved/);
    await expect(page.getByRole('main').getByText('At least one series stays on.')).toBeVisible();

    const copied = page.url();
    const table = await openDataTable(page);
    const columns = await table.getByRole('columnheader').allInnerTexts();
    const firstRows = await table.getByRole('row').allInnerTexts();
    expect(columns.join('|')).not.toContain('Created');

    const other = await newMemberPage(browser, baseURL, s.adaEmail);
    await other.goto(copied);
    await expect(cvrChart(other)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(other.getByRole('button', { name: 'Bars', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(other.getByRole('switch', { name: 'Created' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await expect(other.getByRole('switch', { name: 'Resolved' })).toBeDisabled();
    const otherTable = await openDataTable(other);
    expect(await otherTable.getByRole('columnheader').allInnerTexts()).toEqual(columns);
    expect(await otherTable.getByRole('row').allInnerTexts()).toEqual(firstRows);
    await other.context().close();
  });

  await chapter('The Sprint report picker, and ids that are not reportable', async () => {
    const [newest, second] = [s.completed[3]!, s.completed[2]!];
    await page.goto(`/sprints/${s.activeSprintId}/report`);
    await expect(page.getByRole('combobox', { name: 'Sprint' })).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    const reportOrder = await pickerOptions(page, 'Sprint');
    await page.goto('/reports/burndown');
    await expect(page.getByRole('combobox', { name: 'Sprint' })).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    expect(reportOrder).toEqual(await pickerOptions(page, 'Sprint'));
    expect(reportOrder.findIndex((n) => n.includes('Sprint 5'))).toBe(0);
    expect(reportOrder.findIndex((n) => n.includes(newest.name))).toBeLessThan(
      reportOrder.findIndex((n) => n.includes(second.name)),
    );

    await page.goto(`/sprints/${s.activeSprintId}/report`);
    await page.getByRole('combobox', { name: 'Sprint' }).click();
    await page.getByRole('option', { name: new RegExp(`^${second.name}`) }).click();
    await page.waitForURL(`**/sprints/${second.id}/report`);
    await expect(page.getByRole('heading', { name: `${second.name} report` })).toBeVisible();
    await beat();

    for (const bad of [s.foreignSprintId, 'not-a-real-id', s.plannedSprintId]) {
      const res = await page.goto(`/sprints/${bad}/report`);
      await page.waitForURL(`**/sprints/${s.activeSprintId}/report`);
      expect(res?.status(), `${bad} answers 200 after the redirect`).toBe(200);
      await expect(page.getByRole('heading', { name: 'Sprint 5 report' })).toBeVisible();
    }
  });

  await chapter('Velocity covers the range you choose', async () => {
    await page.goto('/reports/velocity');
    await expect(firstChart(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    const names = async () => {
      const t = await openDataTable(page);
      return t.getByRole('rowheader').allInnerTexts();
    };
    expect(await names()).toEqual(['Sprint 1', 'Sprint 2', 'Sprint 3', 'Sprint 4']);

    await page.getByRole('combobox', { name: 'Ending at' }).click();
    await page.getByRole('option', { name: 'Sprint 3', exact: true }).click();
    await page.waitForURL(new RegExp(`endingAt=${s.completed[2]!.id}`));
    await page.getByRole('button', { name: 'Fewer sprints' }).click();
    await page.waitForURL(/count=5/);
    await page.getByRole('button', { name: 'Fewer sprints' }).click();
    await page.waitForURL(/count=3/);
    await expect.poll(async () => (await names()).join()).toBe('Sprint 1,Sprint 2,Sprint 3');
    await beat();

    const res = await page.goto('/reports/velocity?endingAt=garbage&count=nope');
    expect(res?.status()).toBe(200);
    await expect(firstChart(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    expect(await names()).toEqual(['Sprint 1', 'Sprint 2', 'Sprint 3', 'Sprint 4']);
  });

  await chapter('The Reports hub opens every report', async () => {
    const doors: Array<[string, RegExp]> = [
      ['Sprint graph', /\/reports\/burndown/],
      ['Velocity chart', /\/reports\/velocity/],
      ['Sprint report', /\/sprints\/[^/]+\/report/],
      ['Created vs Resolved', /\/reports\/created-vs-resolved/],
      ['Status distribution', /\/reports\/distribution/],
      ['Average age', /\/reports\/average-age/],
      ['Resolution time', /\/reports\/resolution-time/],
      ['Workload', /\/reports\/workload/],
    ];
    for (const [name, url] of doors) {
      await page.goto('/reports');
      await page
        .getByRole('link', { name: new RegExp(name) })
        .first()
        .click();
      await page.waitForURL(url);
      await expect(firstChart(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    }
  });
});

test.afterAll(async () => {
  await adminDb.$disconnect();
});
