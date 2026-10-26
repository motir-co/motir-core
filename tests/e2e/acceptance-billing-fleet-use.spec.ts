import type { Locator, Page, Response } from '@playwright/test';
import { test, expect } from './_helpers/acceptance-video';
import {
  addOrgMember,
  paidOrgState,
  pinContextCookies,
  resetBillingFixture,
  seedBillingOwner,
  setOrgBillingState,
  type BillingSeed,
} from './_helpers/billing';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import {
  clearFleetUseRows,
  denyRaise,
  grantAndGoLive,
  holdFleetPasses,
  releaseFleetPasses,
  seedCiJobs,
  seedOwnAccount,
  seedRunningHostedRun,
  seedWaitingHostedRun,
  writeFleetSwitches,
  type FleetOrg,
  type OwnAccount,
} from './_helpers/fleet-use-seed';
import { saveAccountLanguageInSettings } from './_helpers/i18n-walk';
import { holdScheduledJob } from './_helpers/scheduled-job-hold';
import { signIn, SHELL_PASSWORD } from './_helpers/shell-session';
import { BILLING_CATALOG, type AiPlanCatalogEntry } from '@/lib/billing/catalog';
import { capsForPlanKey, type PlanCaps } from '@/lib/billing/planCaps';
import { MERGED_INDEX_SPOTS } from '@/lib/ciFleet/hostMergedAccountSplit';
import { CI_RUNNER_PROVISION_SWEEP_CRON } from '@/lib/jobs/definitions/ciRunnerFleet';
import type { BillingFixtureTier } from '@/lib/test-billing-mock';
import { assessWatchability } from '../../scripts/upload-acceptance-video.mjs';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// FLEET USE ON BILLING & PLANS (Story MOTIR-9368 · MOTIR-9665) — the story's
// acceptance receipt. A Pro admin reads agent runs 3 of 3 with one run waiting
// for the plan's limit, CI 10 of 10 with two plan-limit waits and one full-pool
// wait counted apart, and where each fleet kind runs. A member sees no section.
// An org whose plan has no figures reads "not read" while the page above it
// works. A Host admin reads its three own accounts right after purchase, then
// one live, one denied and one still asked, asks Motir for more CI capacity, and
// reads it all in 中文.
//
// ── WHAT THIS LANE CAN AND CANNOT PROVE ───────────────────────────────────────
// The lane boots no container and runs no admission, so the fleet state the
// gates would have written is SEEDED (`_helpers/fleet-use-seed.ts`): hosted runs
// holding their `hosted_agent` slot, one held with the waiting line admission
// writes, CI intents `running` and `pending` with the `waiting_reason` the CI
// gate records, and the Host org's `org_owned` account rows with their state
// times and AWS quota raises (pending, then approved at 32 vCPU or denied — the
// fake AWS's two outcomes, written as the raise service records them). The plan
// is motir-ai's, answered by the lane's billing boundary mock (`E2E_TEST_BILLING`)
// from `setOrgBillingState`. So this proves what a PERSON sees and can do: the
// section's place on the page, its words over those rows, the not-read state
// coming out of the real plan read, the dialog's round trip to the real route
// and back, the member gate and the zh rendering. It does NOT prove that the
// numbers equal what admission decides, or cross-org isolation and no-leak over
// every response — that is the story integration gate's
// (`tests/integration/fleetUse/fleetUseStoryGate.test.ts`, MOTIR-9664), which
// drives the real gates. Nor does it prove that AWS would grant what the fake
// grants; the staging walk with real queued work is the person accepting the
// story's.
//
// ── THE FLY↔AWS SWITCHES, PER KIND, AS THIS LANE'S SERVER WIRES THEM ─────────
// `lib/ciFleet/fleetKindSwitches.ts` wires every kind in the server process:
//  - agent runner (`hosted_agent`): `agentRunnerOnPool`, which reads the lane's
//    switch fixture first (`MOTIR_FAKE_FLEET_SWITCH_PATH`, installed by
//    `installFakeAwsSeam`), then `MOTIR_FLEET_AGENT_RUNNER_PROVIDER`. SET to
//    `aws` through the fixture.
//  - CI runner (`ci_runner`): `ciRunnerOnPoolInLane`, the same fixture file —
//    the only way it reads yes. SET to `aws` through the fixture.
//  - agent hoster (`agent_instance`): the stored `platform_fleet_kind_switch`
//    row /admin/fleet-settings writes. Written OFF for the walk (and put back as
//    it was afterwards), so it reads Fly.
//  - indexer (`code_graph_index`): `MOTIR_INDEX_FLEET_PROVIDER`, which the lane
//    does not set and a spec cannot change in the server. Reads Fly.
// So the person accepting the story sees two kinds on Motir's shared AWS pool
// and two on Fly, and on Host the agent runner on the org's own account.
//
// ── FIGURES AND WORDS ─────────────────────────────────────────────────────────
// Every plan figure is read from `lib/billing/planCaps.ts` (`capsForPlanKey`),
// every plan name from `lib/billing/catalog.ts` and every sentence from
// `messages/en.json` / `zh.json` (`billing.fleetUse`). The only literals are the
// seeded counts, the vCPU asked of and granted by the fake AWS (200 / 32 / 120,
// 300) and the derived 32 ÷ 2.
//
// ── WAITS ─────────────────────────────────────────────────────────────────────
// Each read the next assertion depends on waits on the fleet-use GET armed
// before the navigation; the request waits on the POST's 200 and the re-read.
// Every locator is scoped to the section (its region) or the dialog. The plan
// read caches a good answer for 30 s, so no org's tier changes mid-walk: the
// not-read org is its own, failing from its first read. `beat()` is pacing only.

test.describe.configure({ timeout: 300_000 });

const copy = en.billing.fleetUse;
const billingPath = '/settings/organization/billing';

const entry = (key: string): AiPlanCatalogEntry => {
  const found = BILLING_CATALOG.aiPlans.find((p) => p.key === key);
  if (!found) throw new Error(`the catalog has no ${key} entry`);
  return found;
};
const capsOf = (key: string): PlanCaps => {
  const caps = capsForPlanKey(key);
  if (!caps) throw new Error(`lib/billing/planCaps.ts has no row for ${key}`);
  return caps;
};
const PRO = entry('pro');
const HOST = entry('host');
const PRO_CAPS = capsOf(PRO.key);
const HOST_FLOOR = capsOf(HOST.key);
/** A plan key with no figures row — what the plan read answers `plan_unknown` for. */
const UNKNOWN_TIER: BillingFixtureTier = {
  key: 'legacy_team_2019',
  name: 'Team (2019)',
  monthlyCreditAllotment: 5_000,
};

const tierOf = (plan: AiPlanCatalogEntry): BillingFixtureTier => ({
  key: plan.key,
  name: plan.name,
  monthlyCreditAllotment: plan.allotment!.credits,
});

// The fake AWS's numbers: what each own account asked, what was granted, and
// what the admin asks Motir for.
const ASKED = { ci: 200, agentRunner: 32, merged: 120 } as const;
const GRANTED = 32;
const REQUESTED = 300;

// ── words, from the catalogue ─────────────────────────────────────────────────

type Values = Record<string, string | number>;

/** The ICU subset the catalogue uses: `{name}` and `{n, plural, …}` with `#`. */
function icu(message: string, values: Values, locale = 'en'): string {
  let out = '';
  let i = 0;
  while (i < message.length) {
    if (message[i] !== '{') {
      out += message[i];
      i += 1;
      continue;
    }
    const end = closing(message, i);
    const inner = message.slice(i + 1, end);
    const plural = /^(\w+),\s*plural,\s*([\s\S]*)$/.exec(inner);
    if (plural) {
      const n = Number(values[plural[1]!]);
      const branches = pluralBranches(plural[2]!);
      const branch =
        branches[`=${n}`] ?? branches[new Intl.PluralRules(locale).select(n)] ?? branches['other'];
      out += icu(branch!.replace(/#/g, String(values[plural[1]!])), values, locale);
    } else {
      out += String(values[inner.trim()]);
    }
    i = end + 1;
  }
  return out;
}

function closing(text: string, open: number): number {
  let depth = 0;
  for (let j = open; j < text.length; j += 1) {
    if (text[j] === '{') depth += 1;
    else if (text[j] === '}' && --depth === 0) return j;
  }
  throw new Error(`unbalanced message: ${text}`);
}

function pluralBranches(body: string): Record<string, string> {
  const branches: Record<string, string> = {};
  let i = 0;
  while (i < body.length) {
    const open = body.indexOf('{', i);
    if (open < 0) break;
    const end = closing(body, open);
    branches[body.slice(i, open).trim()] = body.slice(open + 1, end);
    i = end + 1;
  }
  return branches;
}

const n = (v: number, locale = 'en') => v.toLocaleString(locale);
/** "Oct 26, 09:12" — the section's state time, in UTC. */
const when = (at: Date, locale = 'en') =>
  at.toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'UTC',
  });
const inUseOf = (inUse: number, figure: number) =>
  icu(copy.inUseOf, { inUse: n(inUse), figure: n(figure) });

// ── page helpers ──────────────────────────────────────────────────────────────

const section = (page: Page, title = copy.title): Locator =>
  page.getByRole('region', { name: title });
const figureRow = (scope: Locator, key: string) => scope.getByTestId(`fleet-figure-${key}`);
const accountRow = (scope: Locator, kind: string) => scope.getByTestId(`fleet-account-${kind}`);
const fleetUsePath = (orgId: string) => `/api/organizations/${orgId}/billing/fleet-use`;

/** Arm the section's own read of the org; answers its response. */
const fleetUseRead = (page: Page, orgId: string): Promise<Response> =>
  page.waitForResponse(
    (res) =>
      res.request().method() === 'GET' &&
      new URL(res.url()).pathname === fleetUsePath(orgId) &&
      res.status() === 200,
    { timeout: 45_000 },
  );

/** Open (or reopen) Billing & plans and wait for the section's read. */
async function openFleetUse(page: Page, orgId: string): Promise<Record<string, unknown>> {
  const read = fleetUseRead(page, orgId);
  await page.goto(billingPath);
  const body = (await (await read).json()) as { fleetUse: Record<string, unknown> };
  expect(body.fleetUse).toBeTruthy();
  return body.fleetUse;
}

/** The provider words beside a fleet kind in "Where it runs". */
const whereItRuns = (scope: Locator, kindWords: string): Locator =>
  scope.locator('dt', { hasText: kindWords }).locator('xpath=following-sibling::dd[1]');

const fleetOrg = (seed: BillingSeed): FleetOrg => ({
  organizationId: seed.organizationId,
  workspaceId: seed.workspaceId,
  projectId: seed.projectId,
  ownerId: seed.ownerId,
});

// ── the walk ──────────────────────────────────────────────────────────────────

let hosterSwitchBefore: boolean | null = null;

test.beforeEach(async () => {
  await resetDatabase();
  resetBillingFixture();
  await clearFleetUseRows();
  await holdFleetPasses();
  await holdScheduledJob('system.ci-runner-provision-sweep', CI_RUNNER_PROVISION_SWEEP_CRON, [
    'system.ci-runner-boot',
  ]);
  writeFleetSwitches({ hostedAgent: 'aws', ciRunner: 'aws' });
  const hoster = await adminDb.platformFleetKindSwitch.findUnique({
    where: { fleetKind: 'agent_instance' },
  });
  hosterSwitchBefore = hoster ? hoster.onPool : null;
  await adminDb.platformFleetKindSwitch.upsert({
    where: { fleetKind: 'agent_instance' },
    create: { fleetKind: 'agent_instance', onPool: false },
    update: { onPool: false },
  });
});

test.afterEach(async () => {
  writeFleetSwitches({});
  await releaseFleetPasses();
  await clearFleetUseRows();
  if (hosterSwitchBefore === null) {
    await adminDb.platformFleetKindSwitch.deleteMany({ where: { fleetKind: 'agent_instance' } });
  } else {
    await adminDb.platformFleetKindSwitch.update({
      where: { fleetKind: 'agent_instance' },
      data: { onPool: hosterSwitchBefore },
    });
  }
});

test.describe('Fleet use on Billing & plans', () => {
  test('an admin sees its use against its plan caps and where each kind runs, and on Host its own accounts', async ({
    page,
    browser,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-9368');
    const pageErrors: Error[] = [];
    page.on('pageerror', (e) => pageErrors.push(e));
    const stamp = Date.now().toString(36);
    const t0 = Date.now();
    const starts: number[] = [];
    const timed = async (title: string, body: () => Promise<void>) => {
      starts.push((Date.now() - t0) / 1000);
      await chapter(title, body);
      await beat();
    };

    // ── Pro ──────────────────────────────────────────────────────────────────
    const pro = await seedBillingOwner(page, `acc-fleet-pro-${stamp}@example.com`);
    setOrgBillingState(pro.organizationId, paidOrgState({ tier: tierOf(PRO) }));
    const proOrg = fleetOrg(pro);
    for (let i = 0; i < PRO_CAPS.agentRunsInParallel; i += 1) await seedRunningHostedRun(proOrg);
    await seedWaitingHostedRun(proOrg, 'plan_cap');

    await timed(
      `${PRO.name}: agent runs ${PRO_CAPS.agentRunsInParallel} of ${PRO_CAPS.agentRunsInParallel}, one waiting for the plan's limit`,
      async () => {
        await openFleetUse(page, pro.organizationId);
        const fleet = section(page);
        await expect(fleet).toContainText(copy.yourPlan);
        await expect(fleet).toContainText(PRO.name);

        const runs = figureRow(fleet, 'agentRunsInParallel');
        await expect(runs).toContainText(copy.label.agentRunsInParallel);
        await expect(runs).toContainText(
          inUseOf(PRO_CAPS.agentRunsInParallel, PRO_CAPS.agentRunsInParallel),
        );
        await expect(runs.getByRole('listitem')).toHaveCount(1);
        await expect(runs.getByRole('listitem')).toContainText(
          icu(copy.waiting.count, { count: n(1) }),
        );
        await expect(runs.getByRole('listitem')).toContainText(copy.waiting.planLimit);

        await expect(figureRow(fleet, 'agentsRunningInOrg')).toContainText(
          inUseOf(0, PRO_CAPS.agentsRunningPerOrg),
        );
        await expect(figureRow(fleet, 'agentsPerPerson')).toContainText(
          icu(copy.membersAt, { count: 0, figure: n(PRO_CAPS.agentsPerUser) }),
        );
        await expect(figureRow(fleet, 'ciJobsInFlight')).toContainText(
          inUseOf(0, PRO_CAPS.ciBurstCap),
        );
        await expect(figureRow(fleet, 'ciJobsInFlight')).toContainText(copy.waiting.none);
      },
    );

    await seedCiJobs(proOrg, PRO_CAPS.ciBurstCap, { status: 'running' });
    await seedCiJobs(proOrg, 2, { status: 'pending', waitingReason: 'plan_cap' });
    await seedCiJobs(proOrg, 1, { status: 'pending', waitingReason: 'shard_capacity' });

    await timed(
      `CI ${PRO_CAPS.ciBurstCap} of ${PRO_CAPS.ciBurstCap}: two waiting for the plan's limit, one for a full pool, counted apart`,
      async () => {
        await openFleetUse(page, pro.organizationId);
        const ci = figureRow(section(page), 'ciJobsInFlight');
        await expect(ci).toContainText(inUseOf(PRO_CAPS.ciBurstCap, PRO_CAPS.ciBurstCap));
        const waits = ci.getByRole('listitem');
        await expect(waits).toHaveCount(2);
        const planLimit = waits.filter({ hasText: copy.waiting.planLimit });
        await expect(planLimit).toContainText(icu(copy.waiting.count, { count: n(2) }));
        const poolFull = waits.filter({ hasText: copy.waiting.poolFull.ciJobsInFlight });
        await expect(poolFull).toContainText(icu(copy.waiting.count, { count: n(1) }));
        // A plan change lifts the first and not the second — said in each line.
        await expect(planLimit).not.toContainText(copy.waiting.poolFull.ciJobsInFlight);
      },
    );

    await timed('Where each kind runs: two on Motir’s shared AWS pool, two on Fly', async () => {
      const fleet = section(page);
      await expect(fleet.getByRole('heading', { name: copy.whereItRuns })).toBeVisible();
      await expect(whereItRuns(fleet, copy.kind.hosted_agent)).toHaveText(
        copy.provider.shared_aws_pool,
      );
      await expect(whereItRuns(fleet, copy.kind.ci_runner)).toHaveText(
        copy.provider.shared_aws_pool,
      );
      await expect(whereItRuns(fleet, copy.kind.agent_instance)).toHaveText(copy.provider.fly);
      await expect(whereItRuns(fleet, copy.kind.code_graph_index)).toHaveText(copy.provider.fly);
      await expect(fleet).not.toContainText(copy.provider.own_aws_account);
    });

    await timed('A member of the organisation sees no Fleet use section', async () => {
      const member = await addOrgMember(pro, `acc-fleet-member-${stamp}@example.com`);
      const context = await browser.newContext();
      try {
        const memberPage = await context.newPage();
        await signIn(memberPage, member.email, SHELL_PASSWORD);
        await pinContextCookies(memberPage, {
          workspaceId: pro.workspaceId,
          organizationId: pro.organizationId,
        });
        const billingRead = memberPage.waitForResponse(
          (res) =>
            res.request().method() === 'GET' &&
            new URL(res.url()).pathname === `/api/organizations/${pro.organizationId}/billing`,
        );
        await memberPage.goto(billingPath);
        expect((await billingRead).status()).toBe(403);
        await expect(memberPage.getByRole('main')).toBeVisible();
        await expect(section(memberPage)).toHaveCount(0);
        await expect(memberPage.getByTestId('fleet-use')).toHaveCount(0);
        const direct = await context.request.get(fleetUsePath(pro.organizationId));
        expect(direct.status()).toBe(403);
      } finally {
        await context.close();
      }
    });

    // ── A plan with no figures ───────────────────────────────────────────────
    await timed(
      'A plan whose figures cannot be read shows “not read”, and the page above it still works',
      async () => {
        const odd = await seedBillingOwner(page, `acc-fleet-unread-${stamp}@example.com`);
        setOrgBillingState(odd.organizationId, paidOrgState({ tier: UNKNOWN_TIER }));
        const fleetUse = await openFleetUse(page, odd.organizationId);
        expect(fleetUse['plan']).toEqual({ kind: 'not_read' });

        await expect(page.getByRole('heading', { name: en.billing.title, level: 1 })).toBeVisible();
        await expect(page.getByRole('main')).toContainText(UNKNOWN_TIER.name);
        const fleet = section(page);
        await expect(fleet).toContainText(copy.planNotRead);
        await expect(fleet).toContainText(copy.notReadNotice);
        await expect(fleet.getByRole('button', { name: copy.tryAgain })).toBeVisible();
        for (const key of [
          'agentRunsInParallel',
          'agentsRunningInOrg',
          'agentsPerPerson',
          'ciJobsInFlight',
        ]) {
          await expect(figureRow(fleet, key)).toContainText(copy.notRead);
        }
        await expect(fleet).toContainText(copy.indexingNotRead);
        await expect(fleet).not.toContainText(/\b0\b/);
        await expect(fleet).not.toContainText(copy.noLimit);
      },
    );

    // ── Host ─────────────────────────────────────────────────────────────────
    const host = await seedBillingOwner(page, `acc-fleet-host-${stamp}@example.com`);
    setOrgBillingState(host.organizationId, paidOrgState({ tier: tierOf(HOST) }));
    const purchasedAt = new Date(Date.now() - 20 * 60_000);
    const ciAccount = await seedOwnAccount({
      organizationId: host.organizationId,
      kinds: ['ci_runner'],
      desiredVcpu: ASKED.ci,
      requestedAt: purchasedAt,
    });
    const agentRunner = await seedOwnAccount({
      organizationId: host.organizationId,
      kinds: ['hosted_agent'],
      desiredVcpu: ASKED.agentRunner,
      requestedAt: purchasedAt,
    });
    const merged = await seedOwnAccount({
      organizationId: host.organizationId,
      kinds: ['code_graph_index', 'agent_instance'],
      desiredVcpu: ASKED.merged,
      requestedAt: purchasedAt,
    });
    const accounts: OwnAccount[] = [ciAccount, agentRunner, merged];
    const noAccountIds = async (fleet: Locator) => {
      for (const account of accounts) await expect(fleet).not.toContainText(account.awsAccountId);
    };

    await timed(
      `${HOST.name}, right after purchase: three own accounts, quota requested, every kind on the shared floor`,
      async () => {
        await openFleetUse(page, host.organizationId);
        const fleet = section(page);
        await expect(fleet).toContainText(HOST.name);
        await expect(fleet.getByRole('heading', { name: copy.accounts.title })).toBeVisible();
        const since = icu(copy.accounts.since, { when: when(purchasedAt) });
        const rows: Array<[string, number]> = [
          ['ci_runner', ASKED.ci],
          ['hosted_agent', ASKED.agentRunner],
          ['indexer_and_hoster', ASKED.merged],
        ];
        for (const [kind, asked] of rows) {
          const row = accountRow(fleet, kind);
          await expect(row).toContainText(copy.accounts.kind[kind as 'ci_runner']);
          await expect(row).toContainText(copy.accounts.state.quota_requested);
          await expect(row).toContainText(since);
          await expect(row).toContainText(copy.accounts.vcpuAsked);
          await expect(row).toContainText(n(asked));
          await expect(row).toContainText(copy.accounts.noneYet);
        }
        await expect(accountRow(fleet, 'ci_runner')).toContainText(
          icu(copy.accounts.sharedFloor.ci_runner, { figure: n(HOST_FLOOR.ciBurstCap) }),
        );
        await expect(accountRow(fleet, 'hosted_agent')).toContainText(
          icu(copy.accounts.sharedFloor.hosted_agent, {
            figure: n(HOST_FLOOR.agentRunsInParallel),
          }),
        );
        const mergedRow = accountRow(fleet, 'indexer_and_hoster');
        await expect(mergedRow).toContainText(copy.accounts.role.indexer_and_hoster);
        await expect(mergedRow).toContainText(
          icu(copy.accounts.sharedFloor.indexer_and_hoster, {
            perPerson: n(HOST_FLOOR.agentsPerUser),
            perOrg: n(HOST_FLOOR.agentsRunningPerOrg),
          }),
        );
        await expect(mergedRow).toContainText(
          icu(copy.accounts.keptSpots, { count: MERGED_INDEX_SPOTS }),
        );

        const runs = figureRow(fleet, 'agentRunsInParallel');
        await expect(runs).toContainText(inUseOf(0, HOST_FLOOR.agentRunsInParallel));
        await expect(runs).toContainText(copy.source.sharedFloor.agentRunsInParallel);
        const ci = figureRow(fleet, 'ciJobsInFlight');
        await expect(ci).toContainText(inUseOf(0, HOST_FLOOR.ciBurstCap));
        await expect(ci).toContainText(
          icu(copy.source.sharedFloor.ciJobsInFlight, { figure: n(HOST_FLOOR.ciBurstCap) }),
        );
        await noAccountIds(fleet);
      },
    );

    const answeredAt = new Date(Date.now() - 5 * 60_000);
    await grantAndGoLive(agentRunner, GRANTED, answeredAt);
    await denyRaise(merged, answeredAt);
    const ownFigure = Math.floor(GRANTED / 2);

    await timed(
      `The agent runner is live at ${GRANTED} vCPU, so agent runs read ${ownFigure}; the merged account was denied`,
      async () => {
        await openFleetUse(page, host.organizationId);
        const fleet = section(page);
        const runner = accountRow(fleet, 'hosted_agent');
        await expect(runner).toContainText(copy.accounts.state.live);
        await expect(runner).toContainText(icu(copy.accounts.since, { when: when(answeredAt) }));
        await expect(runner).toContainText(n(GRANTED));
        await expect(runner).not.toContainText(copy.accounts.noneYet);
        await expect(runner).not.toContainText(
          icu(copy.accounts.sharedFloor.hosted_agent, {
            figure: n(HOST_FLOOR.agentRunsInParallel),
          }),
        );

        const runs = figureRow(fleet, 'agentRunsInParallel');
        await expect(runs).toContainText(inUseOf(0, ownFigure));
        await expect(runs).toContainText(
          icu(copy.source.granted.agentRunsInParallel, {
            figure: n(ownFigure),
            vcpu: n(GRANTED),
          }),
        );
        await expect(whereItRuns(fleet, copy.kind.hosted_agent)).toHaveText(
          copy.provider.own_aws_account,
        );

        const mergedRow = accountRow(fleet, 'indexer_and_hoster');
        await expect(mergedRow).toContainText(copy.accounts.quotaDenied);
        await expect(mergedRow).toContainText(
          icu(copy.accounts.deniedNote, { state: copy.accounts.state.quota_requested }),
        );
        await expect(mergedRow).toContainText(
          icu(copy.accounts.sharedFloor.indexer_and_hoster, {
            perPerson: n(HOST_FLOOR.agentsPerUser),
            perOrg: n(HOST_FLOOR.agentsRunningPerOrg),
          }),
        );

        await expect(accountRow(fleet, 'ci_runner')).toContainText(
          copy.accounts.state.quota_requested,
        );
        await noAccountIds(fleet);
      },
    );

    await timed(
      `Request more capacity on the CI runner account: ${REQUESTED} vCPU, sent to Motir`,
      async () => {
        const ciRow = accountRow(section(page), 'ci_runner');
        await ciRow.getByRole('button', { name: copy.request.button }).click();
        const dialog = page.getByRole('dialog', { name: copy.dialog.title });
        await expect(dialog).toContainText(
          icu(copy.dialog.accountNoneGranted, { account: copy.accounts.kind.ci_runner }),
        );
        await dialog.getByLabel(copy.dialog.figureLabel).fill(String(REQUESTED));
        await dialog
          .getByLabel(copy.dialog.reasonLabel)
          .fill('Our nightly matrix needs about 150 runners from next week.');

        const posted = page.waitForResponse(
          (res) =>
            res.request().method() === 'POST' &&
            new URL(res.url()).pathname ===
              `${fleetUsePath(host.organizationId)}/capacity-requests`,
        );
        const reread = fleetUseRead(page, host.organizationId);
        await dialog.getByRole('button', { name: copy.dialog.send }).click();
        expect((await posted).status()).toBe(200);
        await reread;
        await expect(dialog).toHaveCount(0);

        const status = ciRow.getByTestId('fleet-request-status');
        await expect(status).toContainText(copy.request.status.open);
        await expect(status).toContainText(
          copy.request.asked.split('{date}')[0]!.replace('{vcpu}', n(REQUESTED)),
        );
        await expect(status).toContainText(copy.request.line.open);
        await expect(ciRow.getByRole('button', { name: copy.request.button })).toHaveCount(0);
        expect(
          await adminDb.fleetCapacityRequest.count({
            where: { organizationId: host.organizationId },
          }),
        ).toBe(1);
      },
    );

    await timed('中文: the Fleet use section, its accounts and the request dialog', async () => {
      const words = zh.billing.fleetUse;
      await saveAccountLanguageInSettings(page, 'zh');
      await openFleetUse(page, host.organizationId);
      const fleet = section(page, words.title);
      await expect(fleet).toBeVisible();
      for (const key of Object.keys(words.label) as Array<keyof typeof words.label>) {
        await expect(figureRow(fleet, key)).toContainText(words.label[key]);
      }
      await expect(fleet.getByRole('heading', { name: words.whereItRuns })).toBeVisible();
      await expect(fleet.getByRole('heading', { name: words.accounts.title })).toBeVisible();
      await expect(accountRow(fleet, 'hosted_agent')).toContainText(words.accounts.state.live);
      await expect(accountRow(fleet, 'indexer_and_hoster')).toContainText(
        words.accounts.quotaDenied,
      );
      await expect(figureRow(fleet, 'agentRunsInParallel')).toContainText(
        icu(words.inUseOf, { inUse: n(0, 'zh'), figure: n(ownFigure, 'zh') }, 'zh'),
      );
      const english = [
        copy.title,
        copy.lead,
        ...Object.values(copy.label),
        copy.whereItRuns,
        copy.accounts.title,
        copy.accounts.state.live,
        copy.accounts.quotaDenied,
        copy.request.button,
        copy.request.line.open,
      ];
      for (const line of english) await expect(fleet).not.toContainText(line);

      await accountRow(fleet, 'hosted_agent')
        .getByRole('button', { name: words.request.button })
        .click();
      const dialog = page.getByRole('dialog', { name: words.dialog.title });
      await expect(dialog).toContainText(
        icu(
          words.dialog.account,
          { account: words.accounts.kind.hosted_agent, vcpu: n(GRANTED, 'zh') },
          'zh',
        ),
      );
      await expect(dialog.getByLabel(words.dialog.figureLabel)).toBeVisible();
      await expect(dialog.getByRole('button', { name: words.dialog.send })).toBeVisible();
      await expect(dialog).not.toContainText(copy.dialog.title);
      await dialog.getByRole('button', { name: words.dialog.cancel }).click();
      await expect(dialog).toHaveCount(0);
      await noAccountIds(fleet);
    });

    const verdict = assessWatchability({
      chapters: starts.map((tSeconds, i) => ({ label: String(i), tSeconds })),
      meta: { totalSeconds: (Date.now() - t0) / 1000 },
    });
    expect(verdict.watchable, verdict.reason ?? '').toBe(true);
    expect(pageErrors).toEqual([]);
  });
});
