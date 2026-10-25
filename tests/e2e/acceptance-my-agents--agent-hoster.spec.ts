import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Locator, Page, Response } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/acceptance-video';
import { adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  finishRun,
  runsOf,
  seedReadyCard,
  seedRunInMyAgent,
  signInCodingAgent,
  type RunInMyAgentSeed,
} from './_helpers/run-in-my-agent-seed';
import { runRepositoryFile } from './_helpers/agent-terminal/paths';
import {
  callsNaming,
  callsOn,
  clearHoster,
  fillAccount,
  flipAgentHosting,
  freeAccount,
  hosterInventory,
  instanceRow,
  liveMachines,
  liveVolumes,
  plantMachine,
  reconcileOnce,
  seedHosterAccounts,
  type HosterAccount,
} from './_helpers/agentHoster';
import { resetShardFakeJournal } from '@/lib/orchestrator/shardFakeJournal';
import en from '@/messages/en.json';

// THE AGENT HOSTER FLEET RUNS ON AWS (Story MOTIR-9361 · MOTIR-9478) — the
// story's acceptance receipt: its ten-step verification recipe, walked on My
// agents against two agent-hoster AWS accounts, A (room for ten) and B (two).
//
// ── THE SEAMS ─────────────────────────────────────────────────────────────────
//   * Each hoster account is the lane's persistent fake seen through
//     `fakePersistentOrchestratorForShard`, whose calls and room holds are shared
//     with the webServer and the job worker beside the fake's state file
//     (`_helpers/agentHoster.ts`). Placement is read from those calls and from the
//     instance row (`fleetShardId`, `availabilityZone`), never from page text.
//   * The switch is flipped ONLY through Operations → Fleet settings → Agent
//     hosting (MOTIR-9503's control), as a superadmin, with a reason. Nothing else
//     in this spec or its helper writes it during the run; `afterEach` clears the
//     row so a later spec's agents are created on Fly again.
//   * The Fly path is the same fake store reached without an account view, so
//     "nothing on Fly" is read as no new machine in that store.
//   * The reconciler (step 9) runs once in this process over injected account
//     inventories — the lane has no hoster AWS credentials to list an account
//     with — on a clock past the grace window, under a Sentry client that
//     records the alert it raises.
//
// ── WAITS ─────────────────────────────────────────────────────────────────────
// Every mutating press arms its response first and awaits it. Boot progress is
// awaited on the read-out's committed `data-state`, the waiting step's retry on
// the job worker's 30 s poll. No timers; `chapter()` / `beat()` are pacing only.

test.describe.configure({ timeout: 900_000 });

const copy = en.myAgents;
const boot = copy.boot;
const r = en.runs.agent;
const WIDE = { width: 1440, height: 810 };
/** Pull-request numbers: this spec owns the 94xxx block. */
const PR_NUMBER = 94781;
const TYPE_DELAY_MS = 30;
/** A boot through the job worker, with a clone and a terminal check. */
const BOOT_MS = 90_000;
/** The waiting boot re-asks on the job worker's 30 s poll; allow a few. */
const RETRY_MS = 150_000;
/** No waiting copy names the provider underneath. */
const PROVIDER_TERMS = /\b(aws|amazon|ec2|fly|account|zone|shard|quota|provider|region)\b/i;

const main = (page: Page): Locator => page.getByRole('main');
const panel = (page: Page): Locator => main(page).getByTestId('agent-panel');
const readout = (page: Page): Locator => panel(page).getByTestId('agent-boot');
const waitRow = (page: Page): Locator => readout(page).locator('li[data-state="waiting-for-room"]');
const roomFound = (page: Page): Locator => readout(page).locator('li[data-state="room-found"]');
const screen = (page: Page): Locator =>
  panel(page).getByTestId('agent-terminal').locator('.xterm-rows');
const connWord = (page: Page): Locator => panel(page).getByTestId('agent-conn');
const rowOf = (page: Page, name: string): Locator =>
  page.getByRole('table').getByTestId('agent-row').filter({ hasText: name });
const menuOf = (page: Page, name: string): Locator =>
  page.getByRole('menu', { name: `Actions for ${name}` });
const agentRun = (page: Page): Locator => main(page).getByTestId('agent-run');
const picker = (page: Page): Locator => page.getByRole('dialog', { name: r.door.send });
const pickerRow = (page: Page, name: string): Locator =>
  picker(page).locator(`[data-testid="send-to-agent-row"][data-agent="${name}"]`);

const instancesResponse = (page: Page, method: string, suffix = ''): Promise<Response> =>
  page.waitForResponse(
    (res) =>
      res.request().method() === method &&
      new URL(res.url()).pathname.match(/\/api\/projects\/[^/]+\/instances/) !== null &&
      new URL(res.url()).pathname.endsWith(suffix),
    { timeout: 60_000 },
  );

async function typeLine(page: Page, line: string): Promise<void> {
  await page.keyboard.type(line, { delay: TYPE_DELAY_MS });
  await page.keyboard.press('Enter');
}

async function openMyAgents(page: Page): Promise<void> {
  await page.goto('/my-agents');
  await expect(page.getByRole('heading', { name: copy.title })).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
}

/** Create an agent through the dialog; the panel opens on it. */
async function createAgent(page: Page, seed: RunInMyAgentSeed, name: string): Promise<string> {
  await page.getByRole('button', { name: copy.newAgent }).first().click();
  const dialog = page.getByRole('dialog', { name: copy.create.title });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(copy.create.name).fill(name);
  await dialog.getByRole('radio', { name: /^Claude Code/ }).check();
  const created = instancesResponse(page, 'POST', '/instances');
  await dialog.getByRole('button', { name: copy.create.submit }).click();
  const res = await created;
  expect(res.status()).toBe(201);
  const { instance } = (await res.json()) as { instance: { id: string } };
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`[?&]agent=${instance.id}`));
  // The stub run's repository (`_helpers/agent-terminal/motir-run.py`).
  const repositoryFile = runRepositoryFile(instance.id);
  mkdirSync(dirname(repositoryFile), { recursive: true });
  writeFileSync(repositoryFile, `${seed.repository}\n`);
  return instance.id;
}

async function expectBooted(page: Page): Promise<void> {
  await expect(readout(page)).toHaveAttribute('data-outcome', 'running', { timeout: BOOT_MS });
}

async function closePanel(page: Page, name: string): Promise<void> {
  await panel(page)
    .getByRole('button', { name: `Close ${name}` })
    .click();
  await expect(panel(page)).toHaveCount(0);
}

async function openMenu(page: Page, name: string): Promise<Locator> {
  await page.getByRole('button', { name: `Actions for ${name}` }).click();
  const menu = menuOf(page, name);
  await expect(menu).toBeVisible();
  return menu;
}

/** Hibernate from the row menu and wait for the row to read Hibernated. */
async function hibernate(page: Page, name: string): Promise<void> {
  await expect(rowOf(page, name)).toHaveAttribute('data-state', 'running', { timeout: BOOT_MS });
  const menu = await openMenu(page, name);
  const answered = instancesResponse(page, 'POST', '/hibernate');
  await menu.getByRole('menuitem', { name: copy.menu.hibernate }).click();
  expect((await answered).status()).toBe(200);
  await expect(rowOf(page, name)).toHaveAttribute('data-state', 'hibernated', {
    timeout: BOOT_MS,
  });
}

/** Wake from the row menu; resolves on the wake's own answer. */
async function wake(page: Page, name: string): Promise<void> {
  const menu = await openMenu(page, name);
  const answered = instancesResponse(page, 'POST', '/wake');
  await menu.getByRole('menuitem', { name: copy.menu.wake }).click();
  expect((await answered).status()).toBe(200);
}

/** Wake and wait for the row to read Running again. */
async function wakeToRunning(page: Page, name: string): Promise<void> {
  await wake(page, name);
  await expect(rowOf(page, name)).toHaveAttribute('data-state', 'running', { timeout: BOOT_MS });
}

/** Open an agent's panel from its row and wait for a live shell. */
async function openLiveTerminal(page: Page, name: string): Promise<void> {
  await rowOf(page, name).click();
  await expect(panel(page).getByRole('heading', { level: 2 })).toContainText(name);
  await expect(connWord(page)).toHaveText(copy.panel.conn.live, { timeout: 30_000 });
  await expect(screen(page)).toContainText(/~\/workspace[$#]/, { timeout: 30_000 });
  await panel(page).getByTestId('agent-terminal').click();
}

/** Every call naming `ref` was made on `account`. */
function onlyOn(ref: string, account: HosterAccount): void {
  const calls = callsNaming(ref);
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.filter((c) => c.shardId !== account.id)).toEqual([]);
}

test.afterEach(async () => {
  // Clean-up only, after the walk: lift every hold and put agent hosting back on
  // its default, so a later spec's agents are created on Fly.
  resetShardFakeJournal();
  await adminDb.platformFleetKindSwitch.deleteMany({ where: { fleetKind: 'agent_instance' } });
});

test('new agents are created on the agent-hoster AWS pool behind its own switch, keep their home in their account, wait for room when it is full, and leave nothing behind', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-9361');
  await clearHoster();
  const seed = await seedRunInMyAgent(Date.now().toString(36));
  await adminDb.user.update({ where: { email: seed.email }, data: { platformRole: 'superadmin' } });
  const { a, b } = await seedHosterAccounts();
  const card = await seedReadyCard(seed, 'Export invoices as CSV');
  const second = await seedReadyCard(seed, 'Email the monthly invoice summary');
  const otherSwitches = await adminDb.platformFleetKindSwitch.findMany({
    where: { fleetKind: { not: 'agent_instance' } },
    orderBy: { fleetKind: 'asc' },
  });

  await page.setViewportSize(WIDE);
  await signIn(page, seed.email, seed.password);

  let flyId = '';
  let awsId = '';
  let waitsId = '';
  let fly: Awaited<ReturnType<typeof instanceRow>>;
  let aws: Awaited<ReturnType<typeof instanceRow>>;

  await chapter('1 · Switch on Fly: a new agent boots on Fly', async () => {
    await openMyAgents(page);
    flyId = await createAgent(page, seed, 'yue-fly');
    await expectBooted(page);
    await expect(readout(page)).toContainText(boot.title.create);
    await closePanel(page, 'yue-fly');
    await expect(rowOf(page, 'yue-fly')).toHaveAttribute('data-state', 'running');

    fly = await instanceRow(flyId);
    expect(fly.fleetShardId).toBeNull();
    expect(fly.availabilityZone).toBeNull();
    expect(liveMachines()).toContain(fly.machineId);
    expect(callsOn(a)).toEqual([]);
    expect(callsOn(b)).toEqual([]);
  });
  await beat();

  await chapter('2 · Turn agent hosting onto AWS: the next agent goes to account A', async () => {
    await flipAgentHosting(page, true, 'Agent hoster pool is ready — new agents go to AWS');
    // Only the agent-hoster switch moved.
    expect(
      await adminDb.platformFleetKindSwitch.findMany({
        where: { fleetKind: { not: 'agent_instance' } },
        orderBy: { fleetKind: 'asc' },
      }),
    ).toEqual(otherSwitches);
    await beat();

    await openMyAgents(page);
    awsId = await createAgent(page, seed, 'yue-aws');
    await expectBooted(page);

    aws = await instanceRow(awsId);
    expect(aws.fleetShardId).toBe(a.id);
    expect(aws.availabilityZone).toBe('us-east-1a');
    const onA = callsOn(a);
    expect(onA).toContainEqual({ shardId: a.id, op: 'provisionPersistent', ref: aws.machineId });
    // …and the boot that followed it, on the same account.
    expect(
      onA.filter((c) => c.ref === aws.machineId && c.op !== 'provisionPersistent').length,
    ).toBeGreaterThan(0);
    expect(callsOn(b)).toEqual([]);
  });
  await beat();

  await chapter('3 · Its home survives hibernate and wake, on the same account', async () => {
    // Signed in the way `/login` leaves it, so the hibernate records it for step 4.
    signInCodingAgent(awsId);
    await expect(connWord(page)).toHaveText(copy.panel.conn.live, { timeout: 30_000 });
    await expect(screen(page)).toContainText(/~\/workspace[$#]/, { timeout: 30_000 });
    await panel(page).getByTestId('agent-terminal').click();
    await typeLine(page, 'echo $((6*7))hoster > ~/proof.txt; echo wrote-$((1+1))');
    await expect(screen(page)).toContainText('wrote-2');
    onlyOn(aws.machineId!, a);
    await beat();

    await closePanel(page, 'yue-aws');
    await hibernate(page, 'yue-aws');
    await beat();
    await wakeToRunning(page, 'yue-aws');
    const woken = await instanceRow(awsId);
    expect(woken).toMatchObject({
      fleetShardId: a.id,
      machineId: aws.machineId,
      volumeId: aws.volumeId,
    });

    await openLiveTerminal(page, 'yue-aws');
    await typeLine(page, 'cat ~/proof.txt');
    await expect(screen(page)).toContainText('42hoster');
    onlyOn(aws.machineId!, a);
    expect(callsOn(b)).toEqual([]);
  });
  await beat();

  await chapter('4 · A run on the AWS agent works as it does on Fly', async () => {
    await page.goto(`/items/${card.key}`);
    await expect(main(page).getByTestId('start-send')).toBeVisible({ timeout: FIRST_PAINT_MS });
    const agentsRead = page.waitForResponse(
      (res) =>
        res.url().endsWith(`/api/work-items/${card.key}/agent-runs/agents`) &&
        res.request().method() === 'GET',
    );
    await main(page).getByTestId('send-to-agent').click();
    expect((await agentsRead).status()).toBe(200);
    await expect(picker(page)).toBeVisible();
    const started = page.waitForResponse(
      (res) =>
        res.url().endsWith(`/api/work-items/${card.key}/agent-runs`) &&
        res.request().method() === 'POST',
      { timeout: 60_000 },
    );
    await pickerRow(page, 'yue-aws').click();
    const res = await started;
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status(), JSON.stringify(body)).toBe(201);
    const runId = body['dispatchRunId'] as string;
    await expect(agentRun(page)).toHaveAttribute('data-status', 'running', { timeout: 30_000 });
    await expect(agentRun(page).locator('li[data-phase="running"]')).toHaveAttribute(
      'data-state',
      'now',
      { timeout: BOOT_MS },
    );
    await beat();

    finishRun(awsId, runId, PR_NUMBER);
    await expect(agentRun(page)).toHaveAttribute('data-status', 'succeeded', { timeout: BOOT_MS });
    await expect(agentRun(page).getByTestId('agent-end')).toHaveAttribute('data-end', 'succeeded');
    await expect.poll(async () => (await runsOf(page, card.key))[0]?.status).toBe('succeeded');

    // Every exec the run made reached account A.
    const execs = callsNaming(aws.machineId!).filter((c) => c.op === 'exec');
    expect(execs.length).toBeGreaterThan(0);
    expect(execs.filter((c) => c.shardId !== a.id)).toEqual([]);
    expect(callsOn(b)).toEqual([]);
  });
  await beat();

  await chapter('5 · Back on Fly: the AWS agent still wakes on account A', async () => {
    await flipAgentHosting(page, false, 'Holding new agents on Fly while the pool is checked');
    await beat();
    await openMyAgents(page);
    const machinesBefore = new Set(liveMachines());
    await hibernate(page, 'yue-aws');
    await wakeToRunning(page, 'yue-aws');

    expect(await instanceRow(awsId)).toMatchObject({
      fleetShardId: a.id,
      machineId: aws.machineId,
      volumeId: aws.volumeId,
    });
    onlyOn(aws.machineId!, a);
    expect(callsOn(b)).toEqual([]);
    // No machine was made for it anywhere, Fly included.
    expect(new Set(liveMachines())).toEqual(machinesBefore);
  });
  await beat();

  await chapter('6 · The Fly agent stays on Fly, untouched by the flips', async () => {
    const machinesBefore = new Set(liveMachines());
    await hibernate(page, 'yue-fly');
    await wakeToRunning(page, 'yue-fly');
    expect(await instanceRow(flyId)).toMatchObject({
      fleetShardId: null,
      machineId: fly.machineId,
      volumeId: fly.volumeId,
    });
    expect(callsNaming(fly.machineId!)).toEqual([]);
    expect(callsNaming(fly.volumeId!)).toEqual([]);
    expect(new Set(liveMachines())).toEqual(machinesBefore);
  });
  await beat();

  await chapter('7 · Both accounts full: a new agent waits for room, then boots on B', async () => {
    await flipAgentHosting(page, true, 'Pool checked — new agents go to AWS again');
    fillAccount(a, 'provision');
    fillAccount(b, 'provision');
    const machinesBefore = new Set(liveMachines());

    await openMyAgents(page);
    waitsId = await createAgent(page, seed, 'yue-waits');
    await expect(waitRow(page)).toBeVisible({ timeout: RETRY_MS });
    await expect(waitRow(page)).toContainText(boot.step.waiting);
    await expect(waitRow(page)).toContainText(boot.waiting.pool);
    await expect(waitRow(page)).toContainText(boot.waiting.detailPool);
    // The since-time: the row's ticking clock.
    await expect(waitRow(page).locator('[aria-hidden="true"]').last()).toHaveText(/^\d+:\d\d$/);
    await expect(readout(page)).not.toHaveAttribute('data-outcome', 'failed');
    await expect(panel(page)).toContainText(copy.waiting.status);
    // Terminal is refused, with the waiting reason.
    const terminalTab = panel(page).getByTestId('agent-terminal-tab-disabled');
    await expect(terminalTab).toBeVisible();
    await terminalTab.hover();
    await expect(terminalTab).toHaveAttribute('aria-disabled', 'true');
    await expect(terminalTab.getByRole('tooltip')).toBeVisible();
    await expect(terminalTab.getByRole('tooltip')).toHaveText(copy.waiting.terminalTip);
    for (const words of [await waitRow(page).innerText(), copy.waiting.terminalTip]) {
      expect(words).not.toMatch(PROVIDER_TERMS);
    }
    // Nothing exists for it, on either account or on Fly.
    const waiting = await instanceRow(waitsId);
    expect(waiting.fleetShardId).toBeNull();
    expect(waiting.machineId).toBeNull();
    expect(new Set(liveMachines())).toEqual(machinesBefore);
    expect(
      callsOn(a)
        .filter((c) => c.op === 'provisionPersistent')
        .at(-1)?.ref,
    ).toBeNull();
    expect(
      callsOn(b)
        .filter((c) => c.op === 'provisionPersistent')
        .at(-1)?.ref,
    ).toBeNull();
    await beat();

    // Run is refused too, saying why.
    await page.goto(`/items/${second.key}`);
    await expect(main(page).getByTestId('start-send')).toBeVisible({ timeout: FIRST_PAINT_MS });
    const agentsRead = page.waitForResponse(
      (res) =>
        res.url().endsWith(`/api/work-items/${second.key}/agent-runs/agents`) &&
        res.request().method() === 'GET',
    );
    await main(page).getByTestId('send-to-agent').click();
    expect((await agentsRead).status()).toBe(200);
    const refused = pickerRow(page, 'yue-waits');
    await expect(refused).toHaveAttribute('aria-disabled', 'true');
    await expect(refused).toContainText(copy.waiting.status);
    await expect(refused.getByTestId('send-to-agent-why')).toHaveText(r.picker.off.waitingForRoom);
    expect(r.picker.off.waitingForRoom).not.toMatch(PROVIDER_TERMS);
    await beat();
    await page.keyboard.press('Escape');

    // On My agents: the row reads Waiting, and only Delete is offered.
    await openMyAgents(page);
    await expect(rowOf(page, 'yue-waits')).toContainText(copy.waiting.status);
    const menu = await openMenu(page, 'yue-waits');
    await expect(menu.getByRole('menuitem', { name: copy.menu.delete })).toBeEnabled();
    await expect(menu.getByRole('menuitem', { name: copy.menu.wake })).toBeDisabled();
    await expect(menu.getByRole('menuitem', { name: copy.menu.hibernate })).toBeDisabled();
    await expect(menu).toContainText(copy.waiting.menuNotePool);
    expect(copy.waiting.menuNotePool).not.toMatch(PROVIDER_TERMS);
    await beat();
    await page.keyboard.press('Escape');

    // Room frees on B only.
    await freeAccount(b);
    await rowOf(page, 'yue-waits').click();
    await expect(roomFound(page)).toBeVisible({ timeout: RETRY_MS });
    await expectBooted(page);
    const placed = await instanceRow(waitsId);
    expect(placed.fleetShardId).toBe(b.id);
    expect(callsOn(b)).toContainEqual({
      shardId: b.id,
      op: 'provisionPersistent',
      ref: placed.machineId,
    });
    await closePanel(page, 'yue-waits');
  });
  await beat();

  await chapter('8 · Its own account full: a woken agent waits where its files are', async () => {
    fillAccount(a, 'start');
    await hibernate(page, 'yue-aws');
    await wake(page, 'yue-aws');
    await expect(rowOf(page, 'yue-aws')).toContainText(copy.waiting.status, { timeout: RETRY_MS });
    await rowOf(page, 'yue-aws').click();
    await expect(waitRow(page)).toBeVisible({ timeout: RETRY_MS });
    await expect(waitRow(page)).toContainText(boot.waiting.account);
    await expect(waitRow(page)).toContainText(boot.waiting.detailAccount);
    expect(await waitRow(page).innerText()).not.toMatch(PROVIDER_TERMS);
    onlyOn(aws.machineId!, a);
    await beat();

    await freeAccount(a);
    await expect(roomFound(page)).toBeVisible({ timeout: RETRY_MS });
    await expectBooted(page);
    expect(await instanceRow(awsId)).toMatchObject({
      state: 'running',
      fleetShardId: a.id,
      volumeId: aws.volumeId,
    });
    onlyOn(aws.machineId!, a);
    await closePanel(page, 'yue-aws');
  });
  await beat();

  await chapter('9 · A machine nobody made is found and destroyed, with an alert', async () => {
    const planted = plantMachine(aws.flyApp!);
    const live = [fly.machineId!, aws.machineId!, (await instanceRow(waitsId)).machineId!];
    const { result, alerts } = await reconcileOnce([
      await hosterInventory(a, [planted]),
      await hosterInventory(b, []),
    ]);

    expect(result).toMatchObject({ outcome: 'reconciled' });
    const killed = result.outcome === 'reconciled' ? result.killed : [];
    expect(killed).toEqual([
      expect.objectContaining({ app: aws.flyApp, machineId: planted, reason: 'no_record' }),
    ]);
    expect(liveMachines()).not.toContain(planted);
    expect(
      await adminDb.fleetMachineKill.findMany({ where: { machineId: planted } }),
    ).toMatchObject([{ app: aws.flyApp, machineId: planted, reason: 'no_record' }]);
    const alert = alerts.find((e) => e.name === 'UnattributedMachineDestroyedError');
    expect(alert, 'the pass raised the unattributed-machine alert').toBeDefined();
    expect(alert).toMatchObject({ app: aws.flyApp, machineId: planted, reason: 'no_record' });
    // Every live agent's machine, in both accounts and on Fly, is untouched.
    for (const machineId of live) expect(liveMachines()).toContain(machineId);
  });
  await beat();

  await chapter('10 · Delete the AWS agent: its machine and disk are gone', async () => {
    await openMyAgents(page);
    const menu = await openMenu(page, 'yue-aws');
    await menu.getByRole('menuitem', { name: copy.menu.delete }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Delete yue-aws?' });
    await expect(dialog).toBeVisible();
    const deleted = instancesResponse(page, 'DELETE', `/instances/${awsId}`);
    await dialog.getByRole('button', { name: copy.delete.confirm }).click();
    expect((await deleted).status()).toBe(204);
    await expect(rowOf(page, 'yue-aws')).toHaveCount(0, { timeout: BOOT_MS });

    await expect
      .poll(() => liveMachines().includes(aws.machineId!), { timeout: BOOT_MS })
      .toBe(false);
    await expect
      .poll(() => liveVolumes().includes(aws.volumeId!), { timeout: BOOT_MS })
      .toBe(false);
    expect(callsNaming(aws.machineId!).some((c) => c.op === 'destroyPersistent')).toBe(true);
    onlyOn(aws.machineId!, a);

    // A later pass finds nothing of it to destroy.
    const { result } = await reconcileOnce([
      await hosterInventory(a, []),
      await hosterInventory(b, []),
    ]);
    expect(result).toMatchObject({ outcome: 'reconciled', killed: [] });
  });
  await beat();
});
