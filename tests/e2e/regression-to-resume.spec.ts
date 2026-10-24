import type { Locator, Page } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { servePublishedMock } from './_helpers/design-approval-seed';
import {
  readFakeContainers,
  resetHostedRunJournal,
  writeHostedRunFixture,
} from './_helpers/hosted-run-boundary';
import {
  HOSTED_MODEL,
  SESSION_BRANCH,
  seedGatedStory,
  seedToResume,
  type GatedStory,
  type StoryTitles,
  type ToResumeSeed,
} from './_helpers/to-resume-seed';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// A RUN THAT STOPS AT A GATE WAITS TO RESUME — AND A HOSTED ONE RESUMES ITSELF
// (Story MOTIR-7701 · Subtask MOTIR-7715; `design/workbench/design-notes.md` § 35,
// `design/runs/design-notes.md` § _Stopped at a gate_).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A story ran on the hosted agent. One leg landed on the session branch, and the run
// stopped at the design it could not build past. The story's run section says so —
// *Stopped at a gate, waiting on the design result* — and never *Run died*. On the
// Workbench the run waits on its own tab, To resume, naming the design and the person
// who decides it, and it is on neither In progress nor To fix. The person approves the
// design in the overlay, and that is all they do: the entry leaves the tab, and the
// story reads *Resuming* — a new hosted run carrying on on the same branch, started by
// itself. Once nothing is waiting, the tab says so.
//
// ── THE SEAMS THIS LANE USES ────────────────────────────────────────────────
//
//   * The gateway, motir-ai and GitHub — `lib/test-hosted-run-mock.ts` (the fixture it
//     answers from), as `regression-continue-hosted.spec.ts` uses it.
//   * The container — the fake orchestrator. The resume is the `run/gate-resume.requested`
//     job, which the lane's job worker runs with the hosted-run seam
//     (`E2E_JOB_WORKER_HOSTED_RUN_SEAM`), so its boot is read back from the fake
//     orchestrator's shared state, exactly as a press's is.
//   * The gated runs — `to-resume-seed.ts` says how each is opened and why.
//
// ── ⚠️ WHAT *RESUMING* LOOKS LIKE ON THE TAB ───────────────────────────────
//
// The continue claim clears the story's To resume column as it opens the new run
// (MOTIR-7707), so the next live re-read no longer returns the entry: it is HELD in
// place, marked *Cleared*, with the badge already one lower (§ 35.5's *Held
// (Resuming)*), and the next load drops it. The run section is where *Resuming* is
// read from the run itself (G3), so the walk asserts it there.
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE: the decision drawn from the row the action returned,
// the live re-read's own DOM state (`data-resume-state`, `data-held`), the badge, the
// fake orchestrator's record, a read of the run. No timed wait anywhere; the holds are
// `chapter()` / `beat()`'s.

test.describe.configure({ timeout: 420_000 });

type Messages = typeof en;

const HOSTED_STORY: StoryTitles = {
  story: 'Export billing history',
  landed: 'Add the export endpoint',
  design: 'Sketch the export dialog',
  code: 'Wire the CSV writer',
};
const LOCAL_STORY: StoryTitles = {
  story: 'Archive old projects',
  landed: 'Add the archived flag',
  design: 'Mock the archive confirmation',
  code: 'Implement project archiving',
};
const SENT_BACK_STORY: StoryTitles = {
  story: 'Invite guests to a project',
  landed: 'Store guest roles',
  design: 'Draw the guest invite sheet',
  code: 'Send guest invitations',
};
const REVISE_REASON = 'The invite sheet needs the expiry date beside the role.';

const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key]));
/** A rich message as the page renders it: tags dropped (to a fixed point, so no removal
 *  can leave a new tag behind), placeholders filled. */
const plain = (text: string, vars: Record<string, string | number> = {}) => {
  let stripped = text;
  for (let previous = ''; previous !== stripped; ) {
    previous = stripped;
    stripped = stripped.replace(/<\/?[a-z]+>/g, '');
  }
  return fill(stripped, vars);
};
/** An ICU `{count, plural, …}` with one `#` item, as the page renders it for one. */
const onePlural = (text: string, rendered: string) =>
  text.replace(/\{count, plural,.*\}\}/, rendered);
/** The words inside a rich message's `<link>…</link>`. */
const linkText = (text: string) => /<link>(.*)<\/link>/.exec(text)![1]!;

// ── The page ────────────────────────────────────────────────────────────────

const main = (page: Page) => page.getByRole('main');
const strip = (page: Page, m: Messages) =>
  page.getByRole('navigation', { name: m.workbench.tabs.label });
const tabLink = (page: Page, m: Messages, label: string) =>
  strip(page, m).getByRole('link', { name: new RegExp(`^${label}`) });
const table = (page: Page, name: string): Locator => page.getByRole('table', { name });
const rowOf = (page: Page, tab: string, key: string): Locator =>
  table(page, tab).getByTestId(`workbench-row-${key}`);
const entryOf = (page: Page, tab: string, key: string): Locator =>
  table(page, tab).getByTestId(`workbench-resume-${key}`);
const gateOf = (page: Page, tab: string, key: string): Locator =>
  table(page, tab).getByTestId(`workbench-resume-gate-${key}`);
const marker = (page: Page) => main(page).getByTestId('run-gated');
const dialogFor = (page: Page, m: Messages, key: string) =>
  page.getByRole('dialog', {
    name:
      m === zh
        ? `${key} 的${zh.workbench.approvals.kind.design_result}`
        : `${en.workbench.approvals.kind.design_result} for ${key}`,
  });

/** The strip's badge for a tab, as a number — a suppressed zero is zero. */
async function badgeCount(page: Page, m: Messages, label: string): Promise<number> {
  const text = (await tabLink(page, m, label).textContent()) ?? '';
  const digits = text.replace(/[^0-9]/g, '');
  return digits === '' ? 0 : Number(digits);
}

/** Land on a Workbench tab, asserting the TAB ITSELF is mounted and current first — a
 *  tab that is not in the strip would let every absence below pass vacuously. */
async function openTab(page: Page, m: Messages, key: string, label: string): Promise<void> {
  await page.goto(`/workbench?tab=${key}`);
  await expect(tabLink(page, m, label)).toHaveAttribute('aria-current', 'page', {
    timeout: FIRST_PAINT_MS,
  });
}

/** Open a story's page and wait for its run section's marker. */
async function openStory(page: Page, key: string, state: string): Promise<Locator> {
  await page.goto(`/items/${key}`);
  const gated = marker(page);
  await expect(gated).toHaveAttribute('data-gated-state', state, { timeout: FIRST_PAINT_MS });
  return gated;
}

/** Press the entry's *Review* door and approve the design in the overlay. Drawn from the
 *  gate row the action RETURNED, the *Approved* state is the decision recorded. */
async function approveFromTab(page: Page, m: Messages, s: GatedStory): Promise<void> {
  const tab = m.workbench.tabs.toResume;
  await gateOf(page, tab, s.designKey)
    .getByRole('button', { name: m.workbench.toResume.review, exact: true })
    .click();
  const dialog = dialogFor(page, m, s.designKey);
  await expect(dialog).toBeVisible();
  // The verbs wait on the port having rendered (`portRenderStatus.tsx`).
  await expect(dialog.getByRole('group', { name: m.approvalGate.port.label })).toBeVisible({
    timeout: 60_000,
  });
  await dialog.getByRole('button', { name: m.approvalGate.verb.approve, exact: true }).click();
  await expect(dialog.getByText(m.approvalGate.confirm.title)).toBeVisible();
  await dialog
    .getByRole('button', {
      name: m.approvalGate.confirm.proceed.replace('{verb}', m.approvalGate.verb.approve),
    })
    .click();
  await expect(dialog.getByText(m.approvalGate.state.approved, { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
}

// ── The resume, read back ───────────────────────────────────────────────────

/** The continue runs the fake orchestrator has booted, by dispatch run id. */
function continueBoots(): string[] {
  return Object.values(readFakeContainers())
    .filter((m) => m.spec.env?.['MOTIR_RUN_MODE'] === 'continue')
    .map((m) => m.spec.env?.['MOTIR_DISPATCH_RUN_ID'] ?? '')
    .filter(Boolean);
}

function defaultFixture(): void {
  writeHostedRunFixture({ models: { ids: [HOSTED_MODEL], default: HOSTED_MODEL }, mayRun: true });
  resetHostedRunJournal();
}

function origin(baseURL: string | undefined): string {
  if (!baseURL) throw new Error('no Playwright baseURL — the seed has nowhere to publish');
  return baseURL;
}

test.describe('a run that stops at a gate waits To resume', () => {
  let seed: ToResumeSeed;

  test.beforeEach(async () => {
    await resetDatabase();
    defaultFixture();
    seed = await seedToResume(`resume-${Date.now().toString(36)}@example.com`, 'RSUM');
  });

  test('a hosted story stops at its design, waits To resume, and resumes itself once the design is approved', async ({
    page,
    baseURL,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-7701');
    const story = await seedGatedStory(seed, origin(baseURL), HOSTED_STORY, 'hosted');
    const toResume = en.workbench.tabs.toResume;
    const bootsBefore = continueBoots();
    await servePublishedMock(page);
    await signIn(page, seed.hosted.email, seed.hosted.password);

    await chapter('The story stopped at its design — waiting, not dead', async () => {
      const gated = await openStory(page, story.storyKey, 'waiting');
      await gated.scrollIntoViewIfNeeded();
      await expect(main(page).getByTestId('run-gated-pill')).toHaveText(en.runs.gated.pill);
      await expect(gated.getByTestId('run-gated-line')).toHaveText(
        plain(en.runs.gated.waitingHosted, {
          gate: fill(en.runs.gated.gate, {
            kind: en.workbench.approvals.kind.design_result.toLowerCase(),
            key: story.designKey,
          }),
          branch: SESSION_BRANCH,
        }),
      );
      // Nowhere *Run died*: neither its pill nor its line.
      await expect(main(page).getByTestId('run-died-line')).toHaveCount(0);
      await expect(main(page).getByText(en.runs.runStatus.died, { exact: true })).toHaveCount(0);
    });
    await beat();

    await chapter(
      'It waits on its own tab, To resume, naming the design and who decides',
      async () => {
        await openTab(page, en, 'to-resume', toResume);
        const entry = entryOf(page, toResume, story.storyKey);
        await expect(entry).toHaveAttribute('data-resume-state', 'waiting');
        await expect(entry).toContainText(onePlural(en.workbench.toResume.waiting, '1 approval'));
        const gate = gateOf(page, toResume, story.designKey);
        await expect(gate).toHaveAttribute('data-gate-state', 'awaiting');
        await expect(gate).toContainText(story.designTitle);
        await expect(gate).toContainText(plain(en.workbench.toResume.deciderYou));
        await expect(table(page, toResume).getByTestId(/^workbench-row-/)).toHaveCount(1);
        expect(await badgeCount(page, en, toResume)).toBe(1);
      },
    );
    await beat();

    await chapter('…and it is on neither In progress nor To fix', async () => {
      for (const [key, label] of [
        ['in-progress', en.workbench.tabs.inProgress],
        ['to-fix', en.workbench.tabs.toFix],
      ] as const) {
        await openTab(page, en, key, label);
        await expect(main(page).getByTestId(`workbench-row-${story.storyKey}`)).toHaveCount(0);
      }
      await openTab(page, en, 'to-resume', toResume);
      await expect(entryOf(page, toResume, story.storyKey)).toBeVisible();
    });

    await chapter(
      'The design is approved in the overlay — and the run leaves by itself',
      async () => {
        await approveFromTab(page, en, story);
        // AUTHORITATIVE: the live re-read stopped returning the entry, because the
        // continue claim cleared its column. It is HELD where it was, marked *Cleared*,
        // and the badge has already gone down (§ 35.5).
        const row = rowOf(page, toResume, story.storyKey);
        await expect(row).toHaveAttribute('data-held', 'true', { timeout: 60_000 });
        await expect(row).toContainText(en.workbench.live.cleared);
        await expect.poll(() => badgeCount(page, en, toResume), { timeout: 60_000 }).toBe(0);
        // Nobody pressed Continue: the boot is the gate-resume job's.
        await expect
          .poll(() => continueBoots().length, { timeout: 60_000 })
          .toBe(bootsBefore.length + 1);
      },
    );
    await beat();

    await chapter('The story reads Resuming — a new hosted run on the same branch', async () => {
      const resumed = continueBoots().find((id) => !bootsBefore.includes(id))!;
      const gated = await openStory(page, story.storyKey, 'resuming');
      await gated.scrollIntoViewIfNeeded();
      await expect(gated.getByTestId('run-gated-line')).toContainText(
        plain(en.runs.gated.resuming, {
          name: en.workbench.toResume.you,
          gate: fill(en.runs.gated.gate, {
            kind: en.workbench.approvals.kind.design_result.toLowerCase(),
            key: story.designKey,
          }),
        }),
      );
      await expect(
        gated.getByRole('link', { name: linkText(en.runs.gated.resuming) }),
      ).toBeVisible();
      await expect(main(page).getByText(en.runs.runStatus.running, { exact: true })).toBeVisible();

      // The run it opened: a hosted CONTINUE of the gated run, on its session branch,
      // as the person who started that run, with that run's model.
      const run = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: resumed } });
      expect(run).toMatchObject({
        origin: 'hosted',
        command: 'continue',
        model: HOSTED_MODEL,
        createdById: seed.hosted.userId,
      });
      const opened = await adminDb.dispatchRunEvent.findFirstOrThrow({
        where: { dispatchRunId: resumed, kind: 'run_opened' },
      });
      expect(opened.data).toMatchObject({
        continuesRunId: story.runId,
        resumesGated: true,
        branch: SESSION_BRANCH,
      });
    });
    await beat();

    await chapter('Nothing is waiting any more, and the tab says so', async () => {
      await openTab(page, en, 'to-resume', toResume);
      await expect(
        main(page).getByRole('heading', { name: en.workbench.empty.toResume.title }),
      ).toBeVisible();
      await expect(table(page, toResume)).toHaveCount(0);
    });
  });

  test('a terminal run reads Ready to resume with its command, and a design with changes requested is released to redo', async ({
    page,
    baseURL,
  }) => {
    const local = await seedGatedStory(seed, origin(baseURL), LOCAL_STORY, 'local');
    const back = await seedGatedStory(seed, origin(baseURL), SENT_BACK_STORY, 'local');
    const toResume = en.workbench.tabs.toResume;
    const bootsBefore = continueBoots();
    await servePublishedMock(page);
    await signIn(page, seed.hosted.email, seed.hosted.password);

    await openTab(page, en, 'to-resume', toResume);
    for (const s of [local, back]) {
      await expect(entryOf(page, toResume, s.storyKey)).toHaveAttribute(
        'data-resume-state',
        'waiting',
      );
      await expect(
        table(page, toResume).getByTestId(`workbench-resume-next-${s.storyKey}`),
      ).toHaveText(en.workbench.toResume.next.waitingLocal);
    }
    expect(await badgeCount(page, en, toResume)).toBe(2);

    // A TERMINAL run is approved: it waits for its person, Ready to resume, and the
    // copy affordance carries the exact command.
    await approveFromTab(page, en, local);
    const ready = entryOf(page, toResume, local.storyKey);
    await expect(ready).toHaveAttribute('data-resume-state', 'ready', { timeout: 60_000 });
    await expect(ready).toContainText(en.workbench.toResume.readyBare);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await table(page, toResume)
      .getByRole('button', { name: fill(en.workbench.toResume.copyAria, { key: local.storyKey }) })
      .click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      `motir continue ${local.storyKey}`,
    );
    // Its run is not hosted, so nothing resumed it.
    expect(continueBoots()).toEqual(bootsBefore);

    // A design with CHANGES REQUESTED is released to redo the work (MOTIR-9185).
    const r = en.approvalGate.reason;
    await gateOf(page, toResume, back.designKey)
      .getByRole('button', { name: en.workbench.toResume.review, exact: true })
      .click();
    const dialog = dialogFor(page, en, back.designKey);
    await expect(dialog.getByRole('group', { name: en.approvalGate.port.label })).toBeVisible({
      timeout: 60_000,
    });
    await dialog
      .getByRole('button', { name: en.approvalGate.verb.requestChanges, exact: true })
      .click();
    await dialog.getByLabel(r.label).fill(REVISE_REASON);
    const verdicts = dialog.getByRole('radiogroup', { name: r.verdict.legend });
    await verdicts.locator('label[data-verdict="revise"]').click();
    await dialog.getByRole('button', { name: r.proceed, exact: true }).click();
    await expect(
      dialog.getByText(en.approvalGate.state.changesRequested, { exact: true }),
    ).toBeVisible({ timeout: 60_000 });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // A changes-requested answer is a DECIDED gate that carries its reason: the run is
    // released to read it and redo the work, so the entry reads Ready (MOTIR-9185).
    // Declined / overturned still stay waiting — that is asserted in
    // tests/workbench/resumeState.test.ts.
    const redo = entryOf(page, toResume, back.storyKey);
    await expect(redo).toHaveAttribute('data-resume-state', 'ready', { timeout: 60_000 });
    await expect(gateOf(page, toResume, back.designKey)).toHaveAttribute(
      'data-gate-state',
      'changes_requested',
    );

    // …and it is still there on the next load, beside the other Ready entry.
    await page.reload();
    await expect(entryOf(page, toResume, back.storyKey)).toHaveAttribute(
      'data-resume-state',
      'ready',
      { timeout: FIRST_PAINT_MS },
    );
    await expect(entryOf(page, toResume, local.storyKey)).toHaveAttribute(
      'data-resume-state',
      'ready',
    );
    expect(await badgeCount(page, en, toResume)).toBe(2);
  });

  test('the same walk in zh — the tab, Stopped at a gate, Ready to resume and Resuming', async ({
    page,
    baseURL,
  }) => {
    const hosted = await seedGatedStory(seed, origin(baseURL), HOSTED_STORY, 'hosted');
    const local = await seedGatedStory(seed, origin(baseURL), LOCAL_STORY, 'local');
    const toResume = zh.workbench.tabs.toResume;
    const bootsBefore = continueBoots();
    await servePublishedMock(page);
    await signIn(page, seed.hosted.email, seed.hosted.password);
    // The suite's own locale switch (`workbench.spec.ts`).
    await page.context().addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: page.url() }]);

    // Stopped at a gate — on the run section and on the tab.
    await openStory(page, hosted.storyKey, 'waiting');
    await expect(main(page).getByTestId('run-gated-pill')).toHaveText(zh.runs.gated.pill);

    await openTab(page, zh, 'to-resume', toResume);
    await expect(tabLink(page, zh, toResume)).toContainText(toResume);
    const waiting = entryOf(page, toResume, hosted.storyKey);
    await expect(waiting).toHaveAttribute('data-resume-state', 'waiting');
    await expect(waiting).toContainText(zh.runs.gated.pill);
    // Negatively too: no English on a `zh` page.
    await expect(main(page).getByText(en.workbench.toResume.readyBare)).toHaveCount(0);

    // Ready to resume — the terminal run, approved.
    await approveFromTab(page, zh, local);
    const ready = entryOf(page, toResume, local.storyKey);
    await expect(ready).toHaveAttribute('data-resume-state', 'ready', { timeout: 60_000 });
    await expect(ready).toContainText(zh.workbench.toResume.readyBare);

    // Resuming — the hosted run, approved, carries on by itself.
    await approveFromTab(page, zh, hosted);
    await expect(rowOf(page, toResume, hosted.storyKey)).toHaveAttribute('data-held', 'true', {
      timeout: 60_000,
    });
    await expect(rowOf(page, toResume, hosted.storyKey)).toContainText(zh.workbench.live.cleared);
    await expect
      .poll(() => continueBoots().length, { timeout: 60_000 })
      .toBe(bootsBefore.length + 1);
    const resuming = await openStory(page, hosted.storyKey, 'resuming');
    await expect(resuming.getByTestId('run-gated-line')).toContainText(
      zh.runs.gated.resuming.split('——')[0]!,
    );
  });
});
