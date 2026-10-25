import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistentExecResult } from '@motir/orchestrator';
import { wireFleetKindSwitch } from '@/lib/ciFleet/shardTargets';
import { db } from '@/lib/db';
import { machineCreditsFor } from '@/lib/hostedRuns/machineRate';
import {
  agentInstanceClock,
  agentInstanceLifecycleService as lifecycle,
} from '@/lib/services/agentInstanceLifecycleService';
import { adminDb } from '../helpers/adminDb';
import {
  configureHoster,
  fillAccount,
  seedHosterAccount,
  type HosterAccount,
} from '../helpers/agentHosterFixture';
import { clock, debits, fleet, fx, MIN, setUpHarness, tearDownHarness } from './_harness';

vi.mock('@motir/orchestrator', async () =>
  (await import('../helpers/agentHosterFixture')).hosterOrchestratorPackage(),
);
vi.mock('@/lib/orchestrator', async (importOriginal) =>
  (await import('../helpers/agentHosterFixture')).hosterCompositionRoot(
    await importOriginal<Record<string, unknown>>(),
  ),
);

// MACHINE MINUTES ARE THE SAME ON FLY AND ON AWS (Story MOTIR-9361 · MOTIR-9477),
// against a real Postgres, the Fly fake and one AWS hoster account on the real AWS
// adapter over its in-memory EC2. The same running interval — the same start and
// stop instants, the same machine size — is charged once on each provider, and
// read back from the rows the product writes: the interval's own charge record
// and the debit it sent motir-ai. An interval spent waiting for room is not.
//
// The charge reads the INTERVAL's start and end, which the lifecycle writes from
// its clock at wake and hibernate (`agentInstanceChargeService.chargeInterval`);
// it reads no provider's describe. So the identity is held by that one code path
// for both providers, and this suite proves it end to end.

const ok = (stdout = ''): PersistentExecResult => ({ exitCode: 0, stdout, stderr: '' });
const answer = (): PersistentExecResult => ok();

/** While frozen, no wait advances the clock: only the test moves it. */
let frozen = false;
let a: HosterAccount;
let switchOn = false;

beforeEach(async () => {
  await setUpHarness();
  fleet.setExecResponder(answer);
  frozen = false;
  await configureHoster({
    now: () => clock.now(),
    sleep: async (ms) => {
      if (!frozen) clock.advance(ms);
    },
    answer,
  });
  vi.spyOn(agentInstanceClock, 'sleep').mockImplementation(async (ms: number) => {
    if (!frozen) clock.advance(ms);
  });
  a = await seedHosterAccount('agent-hoster-a', 10);
  switchOn = false;
  wireFleetKindSwitch('agent_instance', () => switchOn);
});

afterEach(async () => {
  wireFleetKindSwitch('agent_instance', null);
  await tearDownHarness();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const create = (name: string) =>
  lifecycle.create(fx.projectIdentifier, { name, profileId: 'claude' }, fx.ctx);
const rowOf = (id: string) => adminDb.agentInstance.findUniqueOrThrow({ where: { id } });
const intervalsOf = (agentInstanceId: string) =>
  adminDb.agentInstanceInterval.findMany({
    where: { agentInstanceId },
    orderBy: { startedAt: 'asc' },
  });
const debitFor = (intervalId: string) =>
  debits().find((d) => d.body?.['instanceIntervalId'] === intervalId);

describe('machine minutes on Fly and on AWS', () => {
  it('the same running interval is charged the same minutes at the same price on both providers', async () => {
    const onFly = (await create('on-fly')).id;
    switchOn = true;
    const onAws = (await create('on-aws')).id;
    switchOn = false;
    expect((await rowOf(onFly)).fleetShardId).toBeNull();
    expect((await rowOf(onAws)).fleetShardId).toBe(a.shard.id);
    await lifecycle.hibernate(fx.projectIdentifier, onFly, fx.ctx);
    await lifecycle.hibernate(fx.projectIdentifier, onAws, fx.ctx);

    // The interval under test: both woken at T1 and hibernated at T2.
    frozen = true;
    clock.advance(5 * MIN);
    const t1 = clock.now();
    await lifecycle.wake(fx.projectIdentifier, onFly, fx.ctx);
    await lifecycle.wake(fx.projectIdentifier, onAws, fx.ctx);
    expect((await rowOf(onFly)).state).toBe('running');
    expect((await rowOf(onAws)).state).toBe('running');
    clock.advance(37 * MIN);
    const t2 = clock.now();
    await lifecycle.hibernate(fx.projectIdentifier, onFly, fx.ctx);
    await lifecycle.hibernate(fx.projectIdentifier, onAws, fx.ctx);

    const fly = (await intervalsOf(onFly)).at(-1)!;
    const aws = (await intervalsOf(onAws)).at(-1)!;
    for (const interval of [fly, aws]) {
      expect(interval).toMatchObject({
        startedAt: t1,
        endedAt: t2,
        billableSeconds: 37 * 60,
        chargeOutcome: 'charged',
      });
    }
    expect(aws.credits).toBe(fly.credits);
    expect(fly.credits).toBe(machineCreditsFor(37 * 60, t2));
    expect(fly.credits).toBeGreaterThan(0);

    // The debit each sent motir-ai: the same seconds and credits.
    const flyDebit = debitFor(fly.id)!.body!;
    const awsDebit = debitFor(aws.id)!.body!;
    expect(awsDebit['billableSeconds']).toBe(flyDebit['billableSeconds']);
    expect(awsDebit['credits']).toBe(flyDebit['credits']);
    expect(flyDebit['billableSeconds']).toBe(37 * 60);
  });

  it('an interval spent waiting for room charges no machine minutes', async () => {
    fillAccount(a);
    switchOn = true;
    const dto = await create('waits');
    expect(dto.state).toBe('starting');
    expect((await rowOf(dto.id)).machineId).toBeNull();
    clock.advance(25 * MIN);
    await lifecycle.delete(fx.projectIdentifier, dto.id, fx.ctx);

    const [interval] = await intervalsOf(dto.id);
    expect(interval).toMatchObject({
      endReason: 'deleted',
      chargeOutcome: 'not_charged',
      credits: 0,
    });
    expect(debitFor(interval!.id)).toBeUndefined();
  });
});
