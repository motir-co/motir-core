import type { APIRequestContext, Locator, Page, Response } from '@playwright/test';
import * as Sentry from '@sentry/nextjs';
import { FLEET_CONTAINER_SIZE, resolveContainerRate } from '@motir/orchestrator';
import { test, expect, FIRST_PAINT_MS } from './_helpers/acceptance-video';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedHostedRun, seedReadyHostedCard, type HostedRunSeed } from './_helpers/hosted-run-seed';
import { appendEvents, closeRun, ingestContext } from './_helpers/agent-run-seed';
import {
  fakeContainerCount,
  fakeContainerForRun,
  readHostedRunJournal,
  resetHostedRunJournal,
  runTokenFor,
  writeHostedRunFixture,
} from './_helpers/hosted-run-boundary';
import {
  clearAgentRunnerSwitch,
  fakeAwsContainerEnv,
  fakeAwsInstanceForRun,
  fakeAwsInstances,
  fakeAwsRunTokenFor,
  plantUntaggedInstance,
  readFakeAws,
  refuseNextLaunch,
  resetFakeAws,
  stopFakeAwsInstance,
  writeAgentRunnerSwitch,
} from './_helpers/fake-aws-boundary';
import { clearFleetRows } from './_helpers/fleet-monitor-seed';
import { fleetShardService } from '@/lib/services/fleetShardService';
import { HOSTED_AGENT_SHARD_CAPACITY_DETAIL } from '@/lib/services/fleetShardAdmissionService';
import {
  FLEET_ATTRIBUTION_GRACE_MS,
  fleetAttributionService,
} from '@/lib/services/fleetAttributionService';
import { installFakeAwsSeam } from '@/lib/test-fake-aws';
import type { FleetShardDTO } from '@/lib/dto/fleetShard';
import en from '@/messages/en.json';

// THE AGENT RUNNER FLEET RUNS ON AWS (Story MOTIR-9359 · MOTIR-9428). This is the
// story's acceptance receipt. It walks the verification recipe against two
// agent-runner AWS accounts, A and B, each with a ceiling of ONE run:
//
//   1. With the agent-runner switch on Fly, a run boots on the legacy fake.
//   2. With the switch on AWS, a run boots on account A.
//   4. With A full, the next run boots on B.
//   5. With both full, the next run waits. It shows its waiting line, its card
//      stays claimed, and it is never shown failed.
//   6. Run 2 ends on A. The supervisor settles it, writes its AWS usage and
//      charges it, and the waiting run boots on A by itself.
//   7. Run 3 is cancelled from its run panel and its instance on B is terminated.
//   +  A refuses its next launch for an account-wide quota, and the run moves to B.
//   8. A VM started by hand on B is reaped by one reconcile pass, with an alert.
//
// Steps 3 (a CI job stays on Fly), 9 (the kill switch at 0) and adding accounts
// with `fleet-admin add-shard` cannot be driven from this lane. They are proven
// at lower tiers: the admission card's switch-isolation and kill-switch cases,
// the wait card's org-refusal case, the story integration gate, and MOTIR-9278's
// own tests.
//
// ── THE SEAMS ─────────────────────────────────────────────────────────────────
//
//   * AWS is the lane's file-backed fake EC2 (`lib/test-fake-aws.ts`, MOTIR-9429).
//     It sits behind the REAL `aws` adapter and inventory, and the webServer, the
//     job worker and this spec all share one state file. The spec reads what each
//     account launched, and it writes the three controls: stop an instance as if
//     its container exited, refuse the next launch, and start an untagged VM.
//   * The agent-runner switch is the lane fixture `MOTIR_FAKE_FLEET_SWITCH_PATH`.
//     It is read on every admission, by the webServer (a start) and by the job
//     worker (an admit pass).
//   * The legacy fleet is the fake orchestrator's shared container state.
//   * The gateway, motir-ai and GitHub are `lib/test-hosted-run-mock.ts`.
//
// ── PLAYING THE CONTAINER ─────────────────────────────────────────────────────
//
// The spec plays the container with the run's OWN credential, read back from the
// machine the run booted on. For an AWS run that is the `MOTIR_ENV_MOTIR_RUN_TOKEN`
// line of the instance's user-data; for a Fly run it is the fake container's env.
// A live container keeps talking (one `log` line every few seconds), because the
// lane's stall window is 25 s (`E2E_HOSTED_RUN_STALL_WINDOW_MS`) and this walk
// keeps two runs alive across the 30 s admit retry. An AWS run ends the way a real
// one does: the CLI closes the run, then the instance stops (the fake EC2 stop
// entry), and the supervisor's real describe and settle path tears it down.
//
// ── THE RECONCILE PASS ────────────────────────────────────────────────────────
//
// The PR base has no job trigger a spec can fire for one reconcile pass: the
// worker runs `fleetAttributionService.reconcile` on its five-minute cron. So the
// spec calls it in its own process, over the same state file, after installing
// the fake EC2 the way the lane's processes do (`installFakeAwsSeam`). The alert
// goes to Sentry, so the pass runs under a Sentry client whose `beforeSend`
// records the event and drops it.
//
// ── WAITS ─────────────────────────────────────────────────────────────────────
//
// Every press awaits its own response. Boots, terminations, the slot ledger,
// usage rows and the self-boot are polled on the fake EC2 state or a database
// row. There are no timers. The holds are `chapter()` and `beat()`'s.

// Two settles, two 30 s admit retries and a supervisor whose poll backs off to
// 60 s: well over the passing time, and under the acceptance leg's ceiling.
test.describe.configure({ timeout: 900_000 });

const MODEL = 'e2e-hosted-default';
/** The waiting line, exactly as `recordWaitingLine` writes it. */
const WAITING_LINE = `[motir] waiting for room: ${HOSTED_AGENT_SHARD_CAPACITY_DETAIL}`;
/** How often a live played container writes a line, well inside the 25 s stall window. */
const KEEP_TALKING_MS = 8_000;
/** A supervisor poll backs off to 60 s; a settle may need two. */
const SETTLE_MS = 180_000;
/** The admit job re-asks every 30 s; allow several retries after a settle. */
const SELF_BOOT_MS = 240_000;
const ACCOUNT_PREFIX = 'hosted-agent-e2e-';

const hosted = en.runs.hosted;

function origin(baseURL: string | undefined): string {
  if (!baseURL) throw new Error('no Playwright baseURL — the ingest calls have nowhere to go');
  return baseURL;
}

const main = (page: Page): Locator => page.getByRole('main');

const startResponse = (page: Page, itemKey: string) =>
  page.waitForResponse(
    (res) =>
      res.url().endsWith(`/api/work-items/${itemKey}/hosted-runs`) &&
      res.request().method() === 'POST',
    { timeout: 60_000 },
  );
const runsListResponse = (page: Page, itemKey: string) =>
  page.waitForResponse(
    (res) =>
      res.url().includes(`/api/work-items/${itemKey}/dispatch-runs`) &&
      res.request().method() === 'GET',
    { timeout: 60_000 },
  );

/**
 * The run a Run hosted press opened, off the list the section refetches. Never
 * the start's own body: Chrome never reports that 201's chunked body finished
 * once the page refreshes on it (`regression-hosted-agent-run.spec.ts`).
 */
async function startedRunId(runsRes: Response): Promise<string> {
  const { runs } = (await runsRes.json()) as { runs: { id: string; origin: string }[] };
  const run = runs.find((r) => r.origin === 'hosted');
  expect(run, 'the run list carries the hosted run just started').toBeTruthy();
  return run!.id;
}

/** Open a card and press Run hosted on the default model. */
async function runHosted(page: Page, itemKey: string): Promise<string> {
  await page.goto(`/items/${itemKey}`);
  await expect(main(page).getByTestId('run-hosted-door')).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(main(page).getByRole('combobox', { name: 'Model' })).toContainText(MODEL);
  const started = startResponse(page, itemKey);
  const runs = runsListResponse(page, itemKey);
  await main(page).getByTestId('run-hosted').click();
  expect((await started).status()).toBe(201);
  const id = await startedRunId(await runs);
  await expect(main(page).getByTestId('hosted-run')).toBeVisible();
  return id;
}

/**
 * The run panel's phase list says the agent is running. The panel shows phases,
 * not log lines; a run's log is read in its Runs dialog ({@link expectRunLog}).
 */
async function expectAgentRunning(page: Page): Promise<void> {
  await expect(main(page).locator('li[data-phase="running"]')).toHaveAttribute(
    'data-state',
    'now',
    {
      timeout: 30_000,
    },
  );
}

/** Open a run's dialog on the Runs page and wait until its log shows every line. */
async function expectRunLog(page: Page, dispatchRunId: string, lines: string[]): Promise<void> {
  await page.goto(`/runs?run=${dispatchRunId}`);
  const dialog = page.getByRole('dialog', { name: en.runs.modalTitle });
  await expect(dialog).toBeVisible({ timeout: FIRST_PAINT_MS });
  for (const line of lines) {
    await expect(dialog.getByTestId('run-log-body')).toContainText(line);
  }
}

/** The instance a run booted on AWS, once it has, with its account's id. */
async function awsBootOf(dispatchRunId: string) {
  await expect
    .poll(() => fakeAwsInstanceForRun(dispatchRunId) !== undefined, { timeout: 60_000 })
    .toBe(true);
  return fakeAwsInstanceForRun(dispatchRunId)!;
}

/** Instances on an account that have not been terminated. */
const liveOn = (account: { id: string }) =>
  fakeAwsInstances(account.id).filter((i) => i.state !== 'terminated');

const instanceState = (account: { id: string }, instanceId: string) =>
  fakeAwsInstances(account.id).find((i) => i.instanceId === instanceId)?.state;

const runRow = (id: string) => adminDb.dispatchRun.findUniqueOrThrow({ where: { id } });

const runLogs = async (dispatchRunId: string) =>
  (
    await adminDb.dispatchRunEvent.findMany({
      where: { dispatchRunId, kind: 'log' },
      orderBy: { createdAt: 'asc' },
    })
  ).map((e) => e.body ?? '');

/**
 * The container's side of one run, played with the run's own credential. Once
 * booted it keeps writing a line, as a working agent does, until it exits or is
 * cancelled. The keep-alive post ignores its answer: a post that lands after the
 * run closed is refused, and that refusal is not this run's result.
 */
class PlayedContainer {
  private timer: ReturnType<typeof setInterval> | null = null;

  private constructor(
    private readonly api: APIRequestContext,
    readonly runId: string,
    private readonly itemKey: string,
  ) {}

  static async boot(
    token: string,
    runId: string,
    itemKey: string,
    baseURL: string | undefined,
  ): Promise<PlayedContainer> {
    const played = new PlayedContainer(await ingestContext(token, origin(baseURL)), runId, itemKey);
    await appendEvents(played.api, runId, [{ kind: 'agent_started', workItemKey: itemKey }]);
    played.timer = setInterval(() => {
      void played.api
        .post(`/api/v1/dispatch-runs/${runId}/events`, {
          data: {
            events: [{ kind: 'log', workItemKey: itemKey, body: 'opencode: still working…' }],
          },
        })
        .catch(() => undefined);
    }, KEEP_TALKING_MS);
    return played;
  }

  /** One output line, through the ingest — the helper asserts the 2xx. */
  async say(body: string): Promise<void> {
    await appendEvents(this.api, this.runId, [{ kind: 'log', workItemKey: this.itemKey, body }]);
  }

  /** The agent exits 0 and the CLI closes the run it adopted. */
  async exit(): Promise<void> {
    this.quiet();
    await appendEvents(this.api, this.runId, [
      { kind: 'agent_exited', workItemKey: this.itemKey, exitCode: 0 },
    ]);
    await closeRun(this.api, this.runId, 'drained');
  }

  /** Stop talking — the run was cancelled under it. */
  quiet(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async dispose(): Promise<void> {
    this.quiet();
    await this.api.dispose();
  }
}

let containers: PlayedContainer[] = [];
let openRuns: string[] = [];

/** Two agent-runner AWS accounts with a ceiling of one run each, A the lower id. */
async function seedAccounts(): Promise<{ a: FleetShardDTO; b: FleetShardDTO }> {
  const tag = Date.now().toString(36);
  const made: FleetShardDTO[] = [];
  for (const [i, accountId] of ['111111111111', '222222222222'].entries()) {
    made.push(
      await fleetShardService.createShard({
        name: `${ACCOUNT_PREFIX}${tag}-${i + 1}`,
        fleetKind: 'hosted_agent',
        provider: 'aws',
        state: 'active',
        githubOrg: 'motir-projects-e2e',
        githubInstallationId: '556677',
        awsAccountId: accountId,
        awsRegion: 'us-east-1',
        credentialRef: `AWS_E2E_${i + 1}`,
        limits: { machineLimit: 1 },
      }),
    );
  }
  // Ties go to the lowest id (`chooseInTx`), so A is whichever row sorts first.
  const [a, b] = [...made].sort((x, y) => (x.id < y.id ? -1 : 1));
  return { a: a!, b: b! };
}

/** Clear the fleet rows `resetDatabase()` never reaches, and this spec's accounts. */
async function clearAccounts(): Promise<void> {
  await clearFleetRows();
  await adminDb.fleetShard.deleteMany({ where: { name: { startsWith: ACCOUNT_PREFIX } } });
}

test.beforeEach(async () => {
  await resetDatabase();
  await clearAccounts();
  resetFakeAws();
  clearAgentRunnerSwitch();
  writeHostedRunFixture({ models: { ids: [MODEL], default: MODEL }, mayRun: true });
  resetHostedRunJournal();
  containers = [];
  openRuns = [];
});

test.afterEach(async ({ page }) => {
  for (const c of containers) await c.dispose();
  containers = [];
  // Cancel what is still open, so the job worker tears its machines down and no
  // run of this walk is left for the next spec's supervisor to find.
  for (const id of openRuns) {
    const run = await adminDb.dispatchRun.findUnique({ where: { id } });
    if (run?.status !== 'running') continue;
    const res = await page.request.post(`/api/dispatch-runs/${id}/cancel`);
    expect(res.status(), await res.text()).toBe(200);
  }
  openRuns = [];
  // Back to the server's own env var, so a later spec's hosted run boots as it
  // always has.
  clearAgentRunnerSwitch();
});

test('a hosted run boots on the agent-runner AWS pool, moves when an account is full, waits when both are, boots by itself, and is cancelled and reaped on its account', async ({
  page,
  baseURL,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-9359');

  const tag = Date.now().toString(36);
  const seed: HostedRunSeed = await seedHostedRun(`aws-pool-${tag}@example.com`, `AWP${tag}`);
  const card1 = await seedReadyHostedCard(seed, 'Add the release notes page');
  const card2 = await seedReadyHostedCard(seed, 'Export invoices as CSV');
  const card3 = await seedReadyHostedCard(seed, 'Name the reviewer on the card');
  const card4 = await seedReadyHostedCard(seed, 'Show the changelog link');
  const card5 = await seedReadyHostedCard(seed, 'Rename the billing tab');
  const { a, b } = await seedAccounts();

  await signIn(page, seed.email, seed.password);

  let run2 = '';
  let run3 = '';
  let run4 = '';
  let c2: PlayedContainer;
  let c3: PlayedContainer;
  let c4: PlayedContainer;
  let vm2 = '';
  let vm3 = '';
  let vm4 = '';
  let vm5 = '';

  await chapter('Switch on Fly: card 1 boots on the legacy fleet', async () => {
    writeAgentRunnerSwitch('fly');
    const run1 = await runHosted(page, card1.identifier);
    openRuns.push(run1);

    // The legacy fake's own record: one container carrying this run's id.
    await expect.poll(() => fakeContainerForRun(run1) !== undefined).toBe(true);
    expect(fakeAwsInstances(a.id)).toEqual([]);
    expect(fakeAwsInstances(b.id)).toEqual([]);
    expect((await runRow(run1)).fleetShardId).toBeNull();

    const c1 = await PlayedContainer.boot(runTokenFor(run1), run1, card1.identifier, baseURL);
    containers.push(c1);
    await c1.say('opencode: implementing on Fly…');
    await expectAgentRunning(page);
    await beat();
    await c1.exit();
    await expect(main(page).getByTestId('hosted-end')).toHaveAttribute('data-end', 'succeeded', {
      timeout: 30_000,
    });
  });
  await beat();

  await chapter('Switch on AWS: card 2 boots on account A', async () => {
    writeAgentRunnerSwitch('aws');
    const legacyBefore = fakeContainerCount();
    run2 = await runHosted(page, card2.identifier);
    openRuns.push(run2);

    const boot = await awsBootOf(run2);
    expect(boot.shardId).toBe(a.id);
    vm2 = boot.instance.instanceId;
    expect(boot.instance.tags).toContainEqual({ key: 'motir_dispatch_run_id', value: run2 });
    // Container-mode user-data naming the lane's digest-pinned image.
    const userData = Buffer.from(boot.instance.request!.userData, 'base64').toString('utf8');
    expect(userData).toContain(process.env['MOTIR_HOSTED_AGENT_IMAGE']!);
    expect(fakeAwsContainerEnv(boot.instance)['MOTIR_DISPATCH_RUN_ID']).toBe(run2);
    expect(fakeAwsInstances(b.id)).toEqual([]);
    expect(fakeContainerCount()).toBe(legacyBefore);
    await expect.poll(async () => (await runRow(run2)).fleetShardId).toBe(a.id);

    c2 = await PlayedContainer.boot(fakeAwsRunTokenFor(run2), run2, card2.identifier, baseURL);
    containers.push(c2);
    await c2.say('opencode: implementing on AWS account A…');
    await expectAgentRunning(page);
  });
  await beat();

  await chapter('A is full: card 3 boots on account B', async () => {
    const legacyBefore = fakeContainerCount();
    run3 = await runHosted(page, card3.identifier);
    openRuns.push(run3);

    const boot = await awsBootOf(run3);
    expect(boot.shardId).toBe(b.id);
    vm3 = boot.instance.instanceId;
    expect(fakeAwsInstances(a.id).map((i) => i.instanceId)).toEqual([vm2]);
    expect(fakeContainerCount()).toBe(legacyBefore);
    await expect.poll(async () => (await runRow(run3)).fleetShardId).toBe(b.id);

    c3 = await PlayedContainer.boot(fakeAwsRunTokenFor(run3), run3, card3.identifier, baseURL);
    containers.push(c3);
    await c3.say('opencode: implementing on AWS account B…');
    await expectAgentRunning(page);
  });
  await beat();

  await chapter('Both accounts are full: card 4 waits for room', async () => {
    const before = {
      a: fakeAwsInstances(a.id).length,
      b: fakeAwsInstances(b.id).length,
      legacy: fakeContainerCount(),
    };
    run4 = await runHosted(page, card4.identifier);
    openRuns.push(run4);

    // Authoritative: the waiting line is written, the run is open, the card is
    // claimed by this person, and nothing booted anywhere.
    await expect
      .poll(async () => (await runLogs(run4)).filter((l) => l === WAITING_LINE))
      .toEqual([WAITING_LINE]);
    expect((await runRow(run4)).status).toBe('running');
    expect(await adminDb.workItem.findUniqueOrThrow({ where: { id: card4.id } })).toMatchObject({
      status: 'in_progress',
      assigneeId: seed.userId,
    });
    expect(fakeAwsInstanceForRun(run4)).toBeUndefined();
    expect(fakeAwsInstances(a.id).length).toBe(before.a);
    expect(fakeAwsInstances(b.id).length).toBe(before.b);
    expect(fakeContainerCount()).toBe(before.legacy);

    // What the person sees on the card: the run is live, not failed.
    const panel = main(page).getByTestId('hosted-run');
    await expect(panel).toContainText(hosted.where.live);
    await expect(main(page).getByTestId('hosted-end')).toHaveCount(0);
    await beat();

    // …and the run's own log says why it waits.
    await expectRunLog(page, run4, [WAITING_LINE]);
    await expect(page.getByRole('dialog', { name: en.runs.modalTitle })).not.toContainText(
      hosted.end.failed,
    );
  });
  await beat();

  await chapter(
    'Run 2 ends on A: its instance is torn down, its usage written and charged',
    async () => {
      await page.goto(`/items/${card2.identifier}`);
      await expect(main(page).getByTestId('hosted-run')).toBeVisible({ timeout: FIRST_PAINT_MS });
      await c2.exit();
      // The container exits: the instance stops, and the supervisor's real describe
      // and settle path takes it from there.
      stopFakeAwsInstance(a, vm2);
      await expect.poll(() => instanceState(a, vm2), { timeout: SETTLE_MS }).toBe('terminated');

      await expect
        .poll(
          async () =>
            (
              await adminDb.ciContainerUsage.findFirst({
                where: { containerProvider: 'aws', handleId: vm2 },
              })
            )?.containerStoppedAt ?? null,
          { timeout: SETTLE_MS },
        )
        .not.toBeNull();
      const usage = await adminDb.ciContainerUsage.findFirstOrThrow({
        where: { containerProvider: 'aws', handleId: vm2 },
      });
      const rate = resolveContainerRate('aws', FLEET_CONTAINER_SIZE, 'us-east-1', new Date());
      expect(rate).not.toBeNull();
      expect(usage.containerRegion).toBe('us-east-1');
      expect(usage.usdPerSecond.equals(rate!.usdPerSecond)).toBe(true);
      // The machine-time charge, as motir-ai's mock journalled it.
      await expect
        .poll(
          () =>
            readHostedRunJournal().some((e) => e.type === 'machine_debit' && e.coreRunId === run2),
          { timeout: SETTLE_MS },
        )
        .toBe(true);
      // The slot on A is free.
      await expect
        .poll(() => adminDb.fleetInFlightSlot.count({ where: { fleetShardId: a.id } }), {
          timeout: SETTLE_MS,
        })
        .toBe(0);

      await expect(main(page).getByTestId('hosted-end')).toHaveAttribute('data-end', 'succeeded', {
        timeout: 30_000,
      });
    },
  );
  await beat();

  await chapter('Run 4 boots on A by itself — nobody pressed anything', async () => {
    await page.goto(`/items/${card4.identifier}`);
    await expect(main(page).getByTestId('hosted-run')).toBeVisible({ timeout: FIRST_PAINT_MS });

    await expect
      .poll(() => fakeAwsInstanceForRun(run4)?.shardId ?? null, { timeout: SELF_BOOT_MS })
      .toBe(a.id);
    vm4 = fakeAwsInstanceForRun(run4)!.instance.instanceId;
    expect(liveOn(b).map((i) => i.instanceId)).toEqual([vm3]);
    await expect.poll(async () => (await runRow(run4)).fleetShardId).toBe(a.id);

    // The credential from run 4's own new instance is accepted by the ingest:
    // `appendEvents` asserts each post's 2xx.
    c4 = await PlayedContainer.boot(fakeAwsRunTokenFor(run4), run4, card4.identifier, baseURL);
    containers.push(c4);
    await c4.say('opencode: started after waiting for room…');
    await expectAgentRunning(page);

    // The waiting line comes first, then the run's output.
    const logs = await runLogs(run4);
    expect(logs.indexOf(WAITING_LINE)).toBeGreaterThanOrEqual(0);
    expect(logs.indexOf(WAITING_LINE)).toBeLessThan(
      logs.indexOf('opencode: started after waiting for room…'),
    );
    // …and the person reads the same in the run's log.
    await expectRunLog(page, run4, [WAITING_LINE, 'opencode: started after waiting for room…']);
  });
  await beat();

  await chapter('Cancel run 3: its instance on B is terminated, A is untouched', async () => {
    await page.goto(`/items/${card3.identifier}`);
    await expect(main(page).getByTestId('hosted-run')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await main(page).getByTestId('hosted-run-cancel').click();
    const confirm = page.getByRole('alertdialog').getByTestId('hosted-run-cancel-confirm');
    await expect(confirm).toBeVisible();
    const cancelled = page.waitForResponse(
      (res) =>
        res.url().endsWith(`/api/dispatch-runs/${run3}/cancel`) &&
        res.request().method() === 'POST',
    );
    await confirm.click();
    expect((await cancelled).status()).toBe(200);
    c3.quiet();
    await expect(main(page).getByTestId('hosted-end')).toHaveAttribute('data-end', 'cancelled', {
      timeout: 30_000,
    });

    await expect.poll(() => instanceState(b, vm3), { timeout: SETTLE_MS }).toBe('terminated');
    expect(instanceState(a, vm4)).toBe('running');
    expect(liveOn(a).map((i) => i.instanceId)).toEqual([vm4]);
  });
  await beat();

  await chapter('A refuses its next launch for its vCPU quota: card 5 moves to B', async () => {
    // Free both accounts first: run 4 ends on A, and B's cancelled run settles.
    await c4.exit();
    stopFakeAwsInstance(a, vm4);
    await expect.poll(() => instanceState(a, vm4), { timeout: SETTLE_MS }).toBe('terminated');
    for (const account of [a, b]) {
      await expect
        .poll(() => adminDb.fleetInFlightSlot.count({ where: { fleetShardId: account.id } }), {
          timeout: SETTLE_MS,
        })
        .toBe(0);
    }

    // An ACCOUNT-WIDE quota refusal. A zone-local `InsufficientInstanceCapacity`
    // would only move the launch to A's next zone.
    refuseNextLaunch(a, { code: 'VcpuLimitExceeded' });
    const aBefore = fakeAwsInstances(a.id).length;
    const run5 = await runHosted(page, card5.identifier);
    openRuns.push(run5);

    const boot = await awsBootOf(run5);
    expect(boot.shardId).toBe(b.id);
    vm5 = boot.instance.instanceId;
    // A was asked (its refusal is spent) and holds no new instance.
    expect(readFakeAws().accounts[a.id]!.refusals).toEqual([]);
    expect(fakeAwsInstances(a.id).length).toBe(aBefore);
    expect(liveOn(a)).toEqual([]);
    await expect.poll(async () => (await runRow(run5)).fleetShardId).toBe(b.id);
    expect(
      (await adminDb.fleetShard.findUniqueOrThrow({ where: { id: a.id } })).admissionPausedUntil,
    ).not.toBeNull();

    const c5 = await PlayedContainer.boot(
      fakeAwsRunTokenFor(run5),
      run5,
      card5.identifier,
      baseURL,
    );
    containers.push(c5);
    await c5.say('opencode: implementing on AWS account B after A refused…');
    await expectAgentRunning(page);
  });
  await beat();

  await chapter(
    'A VM started by hand on B is destroyed by the reconciler, with an alert',
    async () => {
      const planted = plantUntaggedInstance(
        b,
        new Date(Date.now() - FLEET_ATTRIBUTION_GRACE_MS - 60_000),
      );
      expect(await installFakeAwsSeam()).toBe(true);

      const alerts: Error[] = [];
      Sentry.init({
        dsn: 'https://e2e@o0.ingest.sentry.io/0',
        defaultIntegrations: false,
        integrations: [],
        tracesSampleRate: 0,
        beforeSend(event, hint) {
          if (hint.originalException instanceof Error) alerts.push(hint.originalException);
          return null;
        },
      });
      let result: Awaited<ReturnType<typeof fleetAttributionService.reconcile>>;
      try {
        result = await fleetAttributionService.reconcile({ inventory: null });
        await Sentry.flush(5_000);
      } finally {
        await Sentry.close(5_000);
      }

      expect(result).toMatchObject({ outcome: 'reconciled' });
      expect(result.outcome === 'reconciled' ? result.killed : []).toContainEqual(
        expect.objectContaining({ app: b.name, machineId: planted, reason: 'no_record' }),
      );
      expect(instanceState(b, planted)).toBe('terminated');
      expect(
        await adminDb.fleetMachineKill.findMany({ where: { machineId: planted } }),
      ).toMatchObject([{ app: b.name, machineId: planted, reason: 'no_record' }]);
      const alert = alerts.find((e) => e.name === 'UnattributedMachineDestroyedError');
      expect(alert, 'the pass raised the unattributed-machine alert').toBeDefined();
      expect(alert).toMatchObject({ app: b.name, machineId: planted, reason: 'no_record' });
      expect(alert!.message).toContain(`AWS instance ${planted}`);
      // Every live run's instance survives the pass.
      expect(instanceState(b, vm5)).toBe('running');

      await page.goto(`/items/${card5.identifier}`);
      await expect(main(page).getByTestId('hosted-run')).toContainText(hosted.where.live, {
        timeout: FIRST_PAINT_MS,
      });
    },
  );
  await beat();
});
