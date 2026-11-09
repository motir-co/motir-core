import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInstanceBootData } from '@/lib/jobs/types';

// THE AGENT-BILLING STORY GATE, motir-core (Story MOTIR-6914 · MOTIR-6922).
//
// Each card tested its own piece. This file tests the ASSEMBLED story against the
// real database and the fake persistent fleet, with motir-ai faked at `fetch` as a
// tiny LEDGER — it records what each org is debited and answers the usage read
// from those same records — so a number can be followed across the boundary:
//
//   1. THE SEAMS — the daily storage charge's debit reaches the usage read the
//      Agents line renders, the same number end to end; and a seat-off push
//      schedules deletion, the create and wake refusal follows, and a seat-on
//      push clears both.
//   2. THE GUARDS — no path deletes an agent before its `scheduledDeletionAt`,
//      sweep retries included; and an internal org is never refused and never
//      scheduled, while its charges still land. Each structural guard carries a
//      negative control, so a guard that could never fail cannot pass.

const sendEventImpl = vi.hoisted(() => ({
  current: vi.fn(async (_name: string, _data: Record<string, unknown>) => undefined),
}));
vi.mock('@/lib/jobs/sendEvent', () => ({
  sendEvent: (name: string, data: Record<string, unknown>) => sendEventImpl.current(name, data),
  // A charged storage day enqueues its platform meter report (MOTIR-7294); this
  // gate is about the charge, so the report's enqueue is inert here.
  sendSystemEvent: async () => {},
}));

const { db } = await import('@/lib/db');
const { deliverBootEvent } = await import('../helpers/agentBootDriver');
const { INSTANCE_STORAGE_CREDITS_PER_DAY } = await import('@/lib/agentInstances/config');
const { deletionDateFor } = await import('@/lib/agentInstances/planLapse');
const { _resetAiPlanCache } = await import('@/lib/services/aiPlanGateService');
const { billingPropagationService } = await import('@/lib/services/billingPropagationService');
const { billingService } = await import('@/lib/services/billingService');
const { agentInstanceLifecycleService: lifecycle } =
  await import('@/lib/services/agentInstanceLifecycleService');
const { agentInstanceSweepService: sweeper } =
  await import('@/lib/services/agentInstanceSweepService');
const { agentInstanceStorageChargeService } =
  await import('@/lib/services/agentInstanceStorageChargeService');
const { agentLineFigures } =
  await import('@/app/(authed)/settings/organization/billing/_components/agentFigures');
const { agentInstanceLapseService } = await import('@/lib/services/agentInstanceLapseService');
const { agentInstanceRepository } = await import('@/lib/repositories/agentInstanceRepository');
const { organizationRepository } = await import('@/lib/repositories/organizationRepository');
const { agentInstanceStorageChargeRepository } =
  await import('@/lib/repositories/agentInstanceStorageChargeRepository');
const { engineJob } = await import('@/lib/jobs/engine/registry');
// A job registers itself when its definition is imported.
await import('@/lib/jobs/definitions/agentInstanceStorageCharge');
const { jobServices } = await import('@/lib/jobs/services');
const { withWorkspaceServiceContext } = await import('@/lib/workspaces/context');
const { adminDb } = await import('../helpers/adminDb');
const harness = await import('./_harness');
const { AI, MIN, clock, fleet, setUpHarness, stub, tearDownHarness } = harness;
/** The harness re-binds its fixture per test, so read it through the module. */
const fx = () => harness.fx;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The fake motir-ai's ledger: every debit it accepted, by org and kind. */
let ledger: { org: string; kind: 'machine' | 'storage'; credits: number }[] = [];
const spent = (org: string, kind: 'machine' | 'storage') =>
  ledger.filter((l) => l.org === org && l.kind === kind).reduce((s, l) => s + l.credits, 0);

beforeEach(async () => {
  await setUpHarness();
  sendEventImpl.current.mockReset();
  // The boot event goes to the in-process driver, as the harness routes it.
  sendEventImpl.current.mockImplementation(async (name: string, data: unknown) => {
    if (name === 'agent-instance/boot') await deliverBootEvent(data as AgentInstanceBootData);
  });
  vi.stubEnv('MOTIR_BASE_URL', 'https://app.test');
  ledger = [];
  // The ledger sits in front of the harness's own stub and answers the three
  // routes the seam crosses; everything else falls through to the harness.
  const inner = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      const json = (payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (url === `${AI}/v1/credits/agent-storage`) {
        ledger.push({
          org: String(body!['coreOrganizationId']),
          kind: 'storage',
          credits: Number(body!['credits']),
        });
        return json({ idempotent: false, balanceCredits: 100 });
      }
      if (url === `${AI}/v1/credits/agent-machine`) {
        ledger.push({
          org: String(body!['coreOrganizationId']),
          kind: 'machine',
          credits: Number(body!['credits']),
        });
        stub.calls.push({ url, method: 'POST', body });
        return json({ idempotent: false, balanceCredits: 90 });
      }
      if (url.startsWith(`${AI}/v1/usage?`)) {
        const org = new URL(url).searchParams.get('coreOrganizationId')!;
        const machine = spent(org, 'machine');
        const storage = spent(org, 'storage');
        return json({
          scope: 'org',
          coreOrganizationId: org,
          coreWorkspaceId: null,
          coreProjectId: null,
          balance: 1000,
          tier: { key: 'pro', name: 'Pro', monthlyCreditAllotment: 20000 },
          totalSpend: machine + storage,
          monthSpend: machine + storage,
          monthlyHistory: [],
          perModel: [],
          recentRuns: { runs: [], page: 1, pageSize: 10, total: 0 },
          agentMachine: { totalSpend: machine, monthSpend: machine },
          agentStorage: { totalSpend: storage, monthSpend: storage },
        });
      }
      return inner(input, init);
    }),
  );
});
afterEach(tearDownHarness);
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const KEY = () => fx().projectIdentifier;
const orgId = () => fx().workspace.organizationId;
const live = () => adminDb.agentInstance.findMany({ where: { deletedAt: null } });
const create = (name: string) => lifecycle.create(KEY(), { name, profileId: 'claude' }, fx().ctx);
const push = (included: boolean) =>
  billingPropagationService.setAiIncludedSeat({ organizationId: orgId(), included });
/** motir-ai's answer about the org's plan changes with the push, as Stripe's does. */
const planIs = (status: string | null) => {
  stub.plan = status;
  _resetAiPlanCache();
};
const destroys = () => fleet.operations.filter((o) => o.includes(':destroy:'));

/**
 * THE STORAGE CHARGE'S CLOCK (MOTIR-10784). The charge window is built from the
 * `now` it is handed, but the rows it reads were stamped with the DATABASE's own
 * clock — an agent's `createdAt` is the real now, while the harness's virtual
 * clock starts at a fixed date. Charging at `clock.now()` therefore compares a
 * virtual "today" against a real `createdAt`, and the result depends on how far
 * the calendar has moved past the harness's start: once it is more than the
 * walk's length, no agent ever stood in the window. So a walk charges on the
 * database's timeline: the instant the earliest agent was stamped, plus the
 * virtual time that has passed since it was created. Call it right after the
 * agents are created; it measures the offset once.
 */
async function storageChargeClock(): Promise<() => Date> {
  const first = await adminDb.agentInstance.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  const offset = first.createdAt.getTime() - clock.now().getTime();
  return () => new Date(clock.now().getTime() + offset);
}

describe('SEAM · the daily storage charge reaches the Agents line with the same number', () => {
  it('two agents, one asleep: the day’s debits, the usage read and the line all say 2 × the rate — beside the machine time', async () => {
    const running = await create('one');
    const asleep = await create('two');
    clock.advance(10 * MIN);
    await lifecycle.hibernate(KEY(), asleep.id, fx().ctx);
    const machine = spent(orgId(), 'machine');
    expect(machine).toBeGreaterThan(0);

    // `createdAt` is the database's own clock, so the day charged is today's.
    const summary = await agentInstanceStorageChargeService.chargeDays({ now: new Date() });
    expect(summary.charged).toBe(2);
    expect(spent(orgId(), 'storage')).toBe(2 * INSTANCE_STORAGE_CREDITS_PER_DAY);

    // A second pass the same day charges nothing: once per agent per day.
    await agentInstanceStorageChargeService.chargeDays({ now: new Date() });
    expect(spent(orgId(), 'storage')).toBe(2 * INSTANCE_STORAGE_CREDITS_PER_DAY);

    const status = await billingService.getBillingStatus({
      organizationId: orgId(),
      actorUserId: fx().ownerId,
    });
    expect(status.agents.spend).toEqual({
      machineMonthSpend: machine,
      storageMonthSpend: 2 * INSTANCE_STORAGE_CREDITS_PER_DAY,
    });
    const line = agentLineFigures(status.agents);
    expect(line).toMatchObject({
      variant: 'figures',
      machine,
      storage: 2 * INSTANCE_STORAGE_CREDITS_PER_DAY,
      total: machine + 2 * INSTANCE_STORAGE_CREDITS_PER_DAY,
    });
    expect(running.state).toBe('running');
  });
});

describe('SEAM · seat off schedules, refuses create and wake; seat on clears both', () => {
  it('the push, the refusal and the restore, in order', async () => {
    const mine = await create('one');
    await lifecycle.hibernate(KEY(), mine.id, fx().ctx);

    planIs('canceled');
    await push(false);
    const deletesOn = deletionDateFor(
      (await adminDb.organization.findUniqueOrThrow({ where: { id: orgId() } })).aiPlanLapsedAt!,
    );
    expect((await live()).map((r) => r.scheduledDeletionAt?.toISOString())).toEqual([
      deletesOn.toISOString(),
    ]);
    await expect(create('two')).rejects.toMatchObject({ reason: 'ai_plan_required' });
    await expect(lifecycle.wake(KEY(), mine.id, fx().ctx)).rejects.toMatchObject({
      reason: 'ai_plan_required',
    });
    expect(
      (await lifecycle.list(KEY(), { take: 10, skip: 0 }, fx().ctx)).planLapse?.deletesOn,
    ).toBe(deletesOn.toISOString());

    planIs('active');
    await push(true);
    expect((await live()).every((r) => r.scheduledDeletionAt === null)).toBe(true);
    expect((await lifecycle.list(KEY(), { take: 10, skip: 0 }, fx().ctx)).planLapse).toBeNull();
    expect((await lifecycle.wake(KEY(), mine.id, fx().ctx)).state).toBe('running');
    expect((await create('two')).state).toBe('running');
  });
});

describe('GUARD · nothing deletes an agent before its scheduledDeletionAt', () => {
  it('every pass of every sweep, retries included, up to one minute before the date, deletes nothing', async () => {
    const running = await create('one');
    const asleep = await create('two');
    await lifecycle.hibernate(KEY(), asleep.id, fx().ctx);
    planIs('canceled');
    await push(false);
    const deletesOn = deletionDateFor(
      (await adminDb.organization.findUniqueOrThrow({ where: { id: orgId() } })).aiPlanLapsedAt!,
    );
    const destroysBefore = destroys().length;
    const chargeNow = await storageChargeClock();

    // Walk the clock to the minute before the date, one day at a time, running
    // every pass the product runs — the instance sweep, the lapse pass, the
    // storage charge — and failing the fleet's destroy on the way, so a retry
    // path that fired would be caught too.
    while (clock.now().getTime() + DAY_MS < deletesOn.getTime() - MIN) {
      clock.advance(DAY_MS);
      await lifecycle.touchActivity(running.id);
      fleet.failNextDestroy('a destroy that fails, so a retry would have to fire');
      await sweeper.sweep();
      await sweeper.sweepPlanLapse();
      await sweeper.sweepPlanLapse();
      await agentInstanceStorageChargeService.chargeDays({ now: chargeNow() });
    }
    clock.advance(deletesOn.getTime() - clock.now().getTime() - MIN);
    await sweeper.sweep();
    expect((await sweeper.sweepPlanLapse()).deleted).toBe(0);

    expect(await live()).toHaveLength(2);
    expect((await live()).every((r) => r.state !== 'deleting')).toBe(true);
    expect(destroys()).toHaveLength(destroysBefore);

    // At the date — and not a minute before — both go.
    clock.advance(2 * MIN);
    expect((await sweeper.sweepPlanLapse()).deleted).toBe(2);
    // A destroy that failed at the date is the ordinary delete's to retry: the
    // instance sweep finishes it — after the date, never before.
    await sweeper.sweep();
    expect(await live()).toEqual([]);
  });

  it('structurally: the one deletion-for-lapse door is called only by the lapse pass, which takes only due rows', () => {
    const offenders = callersOf('beginDelete(', 'lib', 'app');
    expect(offenders).toEqual(['lib/services/agentInstanceSweepService.ts']);
    const sweep = readFileSync('lib/services/agentInstanceSweepService.ts', 'utf8');
    const pass = sweep.slice(sweep.indexOf('async sweepPlanLapse'), sweep.indexOf('async sweep()'));
    expect(pass).toContain('agentInstanceLapseService.listDue(');
    expect(pass).toContain('lifecycle.beginDelete(row.id)');
    // Negative control: the same scan finds a caller where one exists.
    expect(callersOf('sweepPlanLapse(', 'lib')).toContain(
      'lib/jobs/definitions/agentInstanceSweep.ts',
    );
  });
});

describe('GUARD · an internal org is never refused and never scheduled — and still charged', () => {
  it('past every cap, at zero credits, through a seat-off push and 40 days of sweeps', async () => {
    await adminDb.organization.update({ where: { id: orgId() }, data: { internalBilling: true } });
    planIs('unanswerable');
    stub.mayRun = false;

    const agents = [await create('one'), await create('two')];
    expect(agents.map((a) => a.state)).toEqual(['running', 'running']);
    const chargeNow = await storageChargeClock();
    await lifecycle.hibernate(KEY(), agents[1]!.id, fx().ctx);
    expect((await lifecycle.wake(KEY(), agents[1]!.id, fx().ctx)).state).toBe('running');

    await push(false);
    expect(
      (await adminDb.organization.findUniqueOrThrow({ where: { id: orgId() } })).aiPlanLapsedAt,
    ).toBeNull();
    expect(sendEventImpl.current.mock.calls.filter(([n]) => n === 'email.send')).toEqual([]);

    for (let day = 0; day < 40; day++) {
      clock.advance(DAY_MS);
      for (const a of agents) await lifecycle.touchActivity(a.id);
      await sweeper.sweep();
      await sweeper.sweepPlanLapse();
      await agentInstanceStorageChargeService.chargeDays({ now: chargeNow() });
    }
    expect(await live()).toHaveLength(2);
    expect((await live()).every((r) => r.scheduledDeletionAt === null)).toBe(true);
    // Never stopped for credits — only the 12-hour backstop, which every org has.
    const credits = await adminDb.agentInstanceInterval.count({ where: { endReason: 'credits' } });
    expect(credits).toBe(0);
    // Its machine time and storage are still on its ledger.
    expect(spent(orgId(), 'machine')).toBeGreaterThan(0);
    const days = await adminDb.agentInstanceStorageCharge.count({
      where: { chargeOutcome: 'charged' },
    });
    // Every UTC day each agent stood on is charged once — the creation day through
    // the last pass's day — not just whichever day the window happened to catch.
    const utcDay = (d: Date) => Math.floor(d.getTime() / DAY_MS);
    const rows = await adminDb.agentInstance.findMany({ where: { deletedAt: null } });
    const daysStood = rows.map((r) => utcDay(chargeNow()) - utcDay(r.createdAt) + 1);
    expect(daysStood.every((n) => n >= 41)).toBe(true);
    expect(days).toBe(daysStood.reduce((a, b) => a + b, 0));
    expect(spent(orgId(), 'storage')).toBe(days * INSTANCE_STORAGE_CREDITS_PER_DAY);
  });
});

describe('EDGES · the defensive paths the story’s services own, driven on purpose', () => {
  it('the hourly storage job runs one step, `charge-agent-instance-storage`, over the charge pass', async () => {
    await create('one');
    const steps: string[] = [];
    const step = {
      run: async <T>(name: string, fn: () => Promise<T>) => {
        steps.push(name);
        return fn();
      },
    };
    const result = await engineJob('system.agent-instance-storage-charge')!.handler(
      { step } as never,
      jobServices as never,
    );
    expect(steps).toEqual(['charge-agent-instance-storage']);
    expect(result).toMatchObject({ written: expect.any(Number), charged: expect.any(Number) });
  });

  it('the storage repository: an empty batch writes nothing, and an outcome with no detail keeps none', async () => {
    const dto = await create('one');
    await agentInstanceStorageChargeService.chargeDays({ now: new Date() });
    const [row] = await adminDb.agentInstanceStorageCharge.findMany({
      where: { agentInstanceId: dto.id },
    });
    await adminDb.agentInstanceStorageCharge.update({
      where: { id: row!.id },
      data: { chargeOutcome: 'pending' },
    });
    await withWorkspaceServiceContext(fx().workspaceId, async (tx) => {
      expect(await agentInstanceStorageChargeRepository.createDays([], tx)).toBe(0);
      expect(
        await agentInstanceStorageChargeRepository.recordCharge(
          row!.id,
          { outcome: 'charged' },
          tx,
        ),
      ).toBe(1);
    });
    const after = await adminDb.agentInstanceStorageCharge.findUniqueOrThrow({
      where: { id: row!.id },
    });
    expect(after).toMatchObject({ chargeOutcome: 'charged', chargeDetail: row!.chargeDetail });
  });

  it('the lapse service on an org that is not there: nothing recorded, nothing cleared, nothing sent', async () => {
    expect(await agentInstanceLapseService.recordLapse('no-such-org', new Date())).toBeNull();
    await expect(agentInstanceLapseService.clearLapse('no-such-org')).resolves.toBeUndefined();
    expect(await agentInstanceLapseService.notify('no-such-org', 'Nobody')).toBe(0);
  });

  it('a notice whose owed list cannot be read sends nothing and fails nothing — it stays owed', async () => {
    await create('one');
    // The first read schedules; the second — the notice's own — fails.
    const read = agentInstanceRepository.listLiveForOrganization.bind(agentInstanceRepository);
    vi.spyOn(agentInstanceRepository, 'listLiveForOrganization')
      .mockImplementationOnce(read)
      .mockRejectedValueOnce(new Error('the read failed'));
    planIs('canceled');
    await push(false);
    expect(sendEventImpl.current.mock.calls.filter(([n]) => n === 'email.send')).toEqual([]);
    // Not lost: it is sent once the read works again.
    expect(await agentInstanceLapseService.sendPendingNotices()).toBe(1);
  });

  it('a notice owed to an owner with no email address is recorded without a send', async () => {
    await create('one');
    await adminDb.user.update({ where: { id: fx().ownerId }, data: { email: '' } });
    planIs('canceled');
    await push(false);
    expect(sendEventImpl.current.mock.calls.filter(([n]) => n === 'email.send')).toEqual([]);
    expect((await live()).every((r) => r.deletionNoticedAt !== null)).toBe(true);
  });

  it('a due agent whose org cannot be read is not deleted; an owed notice whose org is gone is skipped', async () => {
    await create('one');
    planIs('canceled');
    await push(false);
    clock.advance(40 * DAY_MS);
    vi.spyOn(organizationRepository, 'findByIdInTx').mockRejectedValue(new Error('unreadable'));
    expect(await agentInstanceLapseService.listDue(clock.now())).toEqual([]);
    expect(await live()).toHaveLength(1);
    vi.restoreAllMocks();

    await adminDb.agentInstance.updateMany({ data: { deletionNoticedAt: null } });
    vi.spyOn(organizationRepository, 'findByIdInTx').mockResolvedValue(null);
    expect(await agentInstanceLapseService.sendPendingNotices()).toBe(0);
  });
});

/** Every file under `roots` whose source calls `needle`, minus its definition. */
function callersOf(needle: string, ...roots: string[]): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(name)) {
        const src = readFileSync(path, 'utf8');
        const calls = src.split(needle).length - 1;
        const defines = src.split(`async ${needle}`).length - 1;
        if (calls - defines > 0) hits.push(path);
      }
    }
  };
  for (const root of roots) walk(root);
  return hits.sort();
}
