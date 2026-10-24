import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import {
  codeGraphIndexAdmissionService,
  indexSlotRef,
  type IndexAdmissionVerdict,
} from '@/lib/services/codeGraphIndexAdmissionService';
import { fleetCeilingService } from '@/lib/services/fleetCeilingService';
import { fleetShardAdmissionService } from '@/lib/services/fleetShardAdmissionService';
import { ciRunnerAdmissionService } from '@/lib/services/ciRunnerAdmissionService';
import { fleetInFlightSlotRepository } from '@/lib/repositories/fleetInFlightSlotRepository';
import { ciFleetAdmissionLockRepository } from '@/lib/repositories/ciFleetAdmissionLockRepository';
import {
  DEFAULT_INDEX_IN_FLIGHT_CAP,
  indexInFlightCap,
  orgIndexInFlightCap,
} from '@/lib/ciFleet/limits';
import { withSystemContext } from '@/lib/workspaces/context';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { wireFleetKindSwitch } from '@/lib/ciFleet/shardTargets';
import type { FleetShard } from '@/generated/prisma/client';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomInt, randomToken } from '../helpers/random';
import { grantPaidAiPlan } from '../helpers/paidAiPlan';

// THE INDEX ADMISSION CAP against real Postgres (Story MOTIR-1981 · MOTIR-1990) —
// `docs/decisions/code-graph-index-fleet.md` §7 · §7.2.
//
// ⚠️ WHAT THIS SUITE HAS TO PROVE THAT THE SIBLINGS CANNOT.
// `fleetCeiling.test.ts` proves ONE pool per org over every workload.
// `codeGraphIndexDispatch.test.ts` proves the dispatch service's spec, taxonomy
// and supervision, with the gate stubbed and no database at all. This file is the
// only place the CAP ITSELF is decided against real transactions, so every
// case here either races them or moves a configured number and watches the same
// world flip verdict.
//
// Everything load-bearing is REAL: Postgres, the shared `fleet` admission lock
// and its `FOR UPDATE`, the slot table's `ON CONFLICT`, and both counted tables.
// The ONE thing stubbed is the motir-ai HTTP boundary, and only in the cases that
// reach through MOTIR-1922's CI gate (its third guard reads a credit balance).
//
// ⚠️ THE CLOCK IS PINNED, because slot expiry is a real comparison against a Date
// the service binds; an unpinned clock would race the wall clock instead of
// asserting a branch.

const PASSWORD = 'hunter2hunter2';
const MOTIR_ORG = 'motir-projects';
const NOW = new Date('2026-08-03T12:00:00.000Z');
/** The shipped container hard kill — the slot TTL is derived from it. */
const CONTAINER_TIMEOUT_MS = 1_800_000;

interface Fixture {
  workspaceId: string;
  organizationId: string;
  projectId: string;
}

let seq = 0;

async function seedTenant(options: { isMeta?: boolean } = {}): Promise<Fixture> {
  seq += 1;
  const user = await usersService.createUser({
    email: `index-admission-${seq}-${randomInt(1_000_000)}@example.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${seq}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: `A${randomInt(100, 1000)}`,
  });
  if (options.isMeta) {
    await adminDb.organization.update({
      where: { id: workspace.organizationId },
      data: { isMeta: true },
    });
  }
  return {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
  };
}

/** The DISPATCH every case shares unless it is ABOUT two of them — so a case that
 *  asks twice for one (repo × project) is a REDELIVERY of one dispatch, which is
 *  what `already_held` is for. A second one is spelled out explicitly (MOTIR-2160). */
const RUN = 'evt-01HZZ';

/** Ask for admission for one (repo × project), through the real gate. */
function admit(
  fx: Fixture,
  repoRef = `moooon/repo-${(seq += 1)}`,
  dispatchId = RUN,
): Promise<IndexAdmissionVerdict> {
  return codeGraphIndexAdmissionService.admit(
    {
      projectId: fx.projectId,
      repoRef,
      dispatchId,
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      containerTimeoutMs: CONTAINER_TIMEOUT_MS,
    },
    NOW,
  );
}

/** How many index slots are live right now, fleet-wide. */
function indexInFlight(now = NOW): Promise<number> {
  return withSystemContext((tx) =>
    fleetInFlightSlotRepository.countLiveForWorkload('code_graph_index', now, tx),
  );
}

/** How many index slots one organisation is holding right now. */
function orgInFlight(organizationId: string, now = NOW): Promise<number> {
  return withSystemContext((tx) =>
    fleetInFlightSlotRepository.countLiveForWorkloadInOrganization(
      'code_graph_index',
      organizationId,
      now,
      tx,
    ),
  );
}

let jobSeq = 0;

/** A queued CI job — the OTHER workload on the same invoice. */
async function seedIntent(fx: Fixture, overrides: { status?: string } = {}) {
  jobSeq += 1;
  return adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      projectId: fx.projectId,
      installationId: '556677',
      runId: '9001',
      runAttempt: 1,
      jobId: String(70_000 + jobSeq),
      jobName: 'build',
      workflowName: 'CI',
      repoOwner: MOTIR_ORG,
      repoName: 'acme-web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: NOW,
      status: overrides.status ?? 'pending',
    },
  });
}

function stubMotirAi(balance = 1_000): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string): Promise<Response> => {
      const parsed = new URL(String(url));
      if (parsed.pathname.includes('/v1/usage')) {
        return new Response(JSON.stringify({ balance }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch to ${parsed.href}`);
    }),
  );
}

grantPaidAiPlan();

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.fleetInFlightSlot.deleteMany({});
  vi.setSystemTime(NOW);
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  // The kill switch disengaged. Indexing is held to no org pool (MOTIR-9375).
  vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '');
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // ⚠️ AND AFTER, NOT ONLY BEFORE. `fleet_in_flight_slot` is FLEET-WIDE — nullable
  // `workspace_id`, no foreign key, by design, so a slot outlives whatever it
  // pointed at — which means no `TRUNCATE "workspace" CASCADE` reaches it and the
  // NEXT FILE IN THIS WORKER does not clean up after this one. A slot this file
  // leaves behind is counted by `fleetCeilingService.census`, which unions EVERY
  // workload, so it defers an unrelated file's CI-runner admission with no visible
  // cause. Clearing it before our own tests protects us; clearing it after protects
  // everyone else.
  await adminDb.fleetInFlightSlot.deleteMany({});
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── The numbers are CONFIG, and the per-tenant one is DERIVED ────────────────

describe('the caps are configuration, and the per-org one is a RELATION', () => {
  it('reads the global cap from the environment, not from a constant', async () => {
    const fx = await seedTenant();
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '2');
    // Two DIFFERENT orgs, so the per-org cap cannot be what refuses.
    const other = await seedTenant();
    expect((await admit(fx)).outcome).toBe('admitted');
    expect((await admit(other)).outcome).toBe('admitted');

    expect(await admit(await seedTenant())).toMatchObject({
      outcome: 'deferred',
      reason: 'index_cap',
      detail: expect.stringContaining('2/2'),
    });

    // Move the number; the SAME world flips verdict, with no code change. That is
    // the criterion — the cap is sized against the fleet spend cap and must
    // follow when that moves (§7.2).
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '4');
    expect((await admit(await seedTenant())).outcome).toBe('admitted');
  });

  // ⚠️ DERIVED, NEVER SEPARATELY CONFIGURED. Two independent numbers drift, and
  // the invariant that matters ("no tenant holds more than half") is only
  // expressible as a relation between them.
  it('derives the per-org cap as ceil(global / 2) at every value', () => {
    for (const global of [0, 1, 2, 3, 6, 7, 24]) {
      expect(orgIndexInFlightCap(global)).toBe(Math.ceil(global / 2));
    }
    // ceil, not floor: at a global of 1 the floor would be 0, which is not "fair"
    // but "nothing indexes, ever".
    expect(orgIndexInFlightCap(1)).toBe(1);
    // And there is deliberately no env var for it — moving the global moves both.
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT_PER_ORG', '99');
    expect(orgIndexInFlightCap(indexInFlightCap())).toBe(
      Math.ceil(DEFAULT_INDEX_IN_FLIGHT_CAP / 2),
    );
  });

  it('falls back to the shipped default, and to it again on a malformed value', () => {
    expect(indexInFlightCap()).toBe(DEFAULT_INDEX_IN_FLIGHT_CAP);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', 'lots');
    expect(indexInFlightCap()).toBe(DEFAULT_INDEX_IN_FLIGHT_CAP);
    expect(warn).toHaveBeenCalled();
  });

  // Zero is the index-only kill switch: it stops indexing without touching CI,
  // which is what distinguishes it from the fleet kill switch's zero.
  it('ZERO stops indexing and nothing else', async () => {
    const fx = await seedTenant();
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '0');
    stubMotirAi();

    expect(await admit(fx)).toMatchObject({ outcome: 'deferred', reason: 'org_index_cap' });
    // CI is untouched — the two caps are different numbers about different things.
    expect((await ciRunnerAdmissionService.admit(await seedIntent(fx))).outcome).toBe('admitted');
  });
});

// ── The two caps, and which one refuses ─────────────────────────────────────

describe('the GLOBAL cap and the PER-ORG cap', () => {
  it('lets an org take up to half the lane and no more', async () => {
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '6');
    const fx = await seedTenant();

    for (let i = 0; i < 3; i += 1) expect((await admit(fx)).outcome).toBe('admitted');

    expect(await admit(fx)).toMatchObject({
      outcome: 'deferred',
      reason: 'org_index_cap',
      detail: expect.stringContaining('3/3'),
    });
    expect(await orgInFlight(fx.organizationId)).toBe(3);
  });

  // ⚠️ THE FAIRNESS PROPERTY, STATED AS THE CARD STATES IT. One tenant's burst
  // must not delay another tenant's FIRST index — the measured failure of the
  // old global unkeyed `concurrency: 2`.
  it('leaves room for another tenant when one workspace bursts', async () => {
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '4');
    const busy = await seedTenant();
    const quiet = await seedTenant();

    // The busy tenant asks for six containers and gets its half.
    const bursts = [];
    for (let i = 0; i < 6; i += 1) bursts.push(await admit(busy));
    expect(bursts.filter((v) => v.outcome === 'admitted')).toHaveLength(2);

    // The other tenant's FIRST index is admitted immediately — not queued behind
    // the whole burst.
    expect((await admit(quiet)).outcome).toBe('admitted');
  });

  it('reports the SPECIFIC reason — an org pacing itself is not a full fleet', async () => {
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '6');
    const fx = await seedTenant();
    for (let i = 0; i < 3; i += 1) await admit(fx);

    const verdict = await admit(fx);

    expect(verdict).toMatchObject({ reason: 'org_index_cap' });
    // Indexing as a whole is nowhere near its cap, which is exactly why the two
    // reasons must not be collapsed: an operator reads different actions off them.
    expect(await indexInFlight()).toBe(3);
    expect((verdict as { detail: string }).detail).toContain('global 6');
  });

  it('refuses on the GLOBAL cap when many tenants filled the lane', async () => {
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '3');
    for (let i = 0; i < 3; i += 1)
      expect((await admit(await seedTenant())).outcome).toBe('admitted');

    expect(await admit(await seedTenant())).toMatchObject({
      outcome: 'deferred',
      reason: 'index_cap',
      detail: expect.stringContaining('3/3'),
    });
  });

  // The slot really is per (repo × project): the same workspace indexing a
  // second repo takes a second slot, and the same repo into a second project
  // takes another. That is §6's unit of work, and it is what the cap counts.
  it('counts one slot per (repo × project), not per repo and not per workspace', async () => {
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '20');
    const fx = await seedTenant();
    const second = await projectsService.createProject({
      workspaceId: fx.workspaceId,
      actorUserId: (
        await adminDb.workspaceMembership.findFirstOrThrow({
          where: { workspaceId: fx.workspaceId },
        })
      ).userId,
      name: 'Second',
      identifier: `B${randomInt(100, 1000)}`,
    });

    await admit(fx, 'moooon/a');
    await admit(fx, 'moooon/b');
    await codeGraphIndexAdmissionService.admit(
      {
        projectId: second.id,
        repoRef: 'moooon/a',
        dispatchId: RUN,
        workspaceId: fx.workspaceId,
        organizationId: fx.organizationId,
        containerTimeoutMs: CONTAINER_TIMEOUT_MS,
      },
      NOW,
    );

    expect(await orgInFlight(fx.organizationId)).toBe(3);
  });
});

// ── Indexing is held to no org pool (MOTIR-9375) ───────────────────────────

describe('indexing is held to its index caps alone — no org pool, no plan figure', () => {
  // The retired pool used to refuse an index container when the org's own CI
  // runners filled it. Indexing now counts against no plan figure.
  it('admits an index container however many CI runners the org runs', async () => {
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '10');
    const fx = await seedTenant();
    await seedIntent(fx, { status: 'running' });
    await seedIntent(fx, { status: 'provisioning' });

    expect((await admit(fx)).outcome).toBe('admitted');
    expect(await indexInFlight()).toBe(1);
  });

  // …and the mirror: an admitted index container takes none of CI's room.
  it("an admitted index container takes none of the org's CI room", async () => {
    stubMotirAi();
    const fx = await seedTenant();
    await adminDb.organization.update({
      where: { id: fx.organizationId },
      data: { fleetPoolCap: 1 },
    });

    expect((await admit(fx)).outcome).toBe('admitted');

    expect((await ciRunnerAdmissionService.admit(await seedIntent(fx))).outcome).toBe('admitted');
  });

  it('the kill switch stops indexing too', async () => {
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '0');

    expect(await admit(await seedTenant())).toMatchObject({
      outcome: 'deferred',
      reason: 'fleet_ceiling',
    });
    expect(await indexInFlight()).toBe(0);
  });
});

// ── Over the cap means WAIT, never drop ─────────────────────────────────────

describe('a refused index WAITS and later runs — nothing is dropped', () => {
  // ⚠️ THE ACCEPTANCE CRITERION, at the gate's own altitude: a burst over the cap
  // is REFUSED, not dropped, and every one of its repos gets through as capacity
  // frees. Dropping would leave a repo permanently unindexed behind a
  // `succeeded`-looking ledger — the failure the whole story exists to remove.
  it('admits every repo of an over-cap burst as the earlier ones settle', async () => {
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '2');
    const fx = await seedTenant();
    const repos = ['moooon/a', 'moooon/b', 'moooon/c', 'moooon/d', 'moooon/e'];
    const admitted = new Set<string>();
    const pending = [...repos];

    // The dispatcher's loop, in miniature: ask, and if refused, come back after
    // the containers ahead have ended.
    for (let round = 0; round < repos.length && pending.length > 0; round += 1) {
      const stillPending: string[] = [];
      for (const repo of pending) {
        const verdict = await admit(fx, repo);
        if (verdict.outcome === 'admitted') admitted.add(repo);
        else stillPending.push(repo);
      }
      pending.length = 0;
      pending.push(...stillPending);
      // The admitted containers finish and give their capacity back.
      for (const repo of admitted) {
        await codeGraphIndexAdmissionService.release(indexSlotRef(fx.projectId, repo), RUN);
      }
    }

    expect([...admitted].sort()).toEqual([...repos].sort());
    expect(pending).toEqual([]);
  });

  it('a released slot immediately lets the next queued index in', async () => {
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '2');
    const fx = await seedTenant();
    await admit(fx, 'moooon/first');
    const other = await seedTenant();
    await admit(other, 'moooon/second');

    expect(await admit(await seedTenant(), 'moooon/third')).toMatchObject({
      reason: 'index_cap',
    });

    expect(
      await codeGraphIndexAdmissionService.release(indexSlotRef(fx.projectId, 'moooon/first'), RUN),
    ).toBe(true);

    expect((await admit(await seedTenant(), 'moooon/third')).outcome).toBe('admitted');
  });

  // TWO WORKSPACES BURSTING SIMULTANEOUSLY BOTH MAKE PROGRESS — neither is
  // starved behind the other's whole queue. This is the property the old global
  // unkeyed `concurrency: 2` did not have.
  it('lets two simultaneously-bursting workspaces BOTH make progress', async () => {
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '4');
    const left = await seedTenant();
    const right = await seedTenant();

    // Interleaved, as two real dispatchers would arrive.
    const verdicts = await Promise.all([
      ...['a', 'b', 'c', 'd'].map((r) => admit(left, `left/${r}`)),
      ...['a', 'b', 'c', 'd'].map((r) => admit(right, `right/${r}`)),
    ]);

    expect(verdicts.filter((v) => v.outcome === 'admitted')).toHaveLength(4);
    // Exactly half each: the derived cap is what makes "both progress" a
    // guarantee rather than a hope about scheduling order.
    expect(await orgInFlight(left.organizationId)).toBe(2);
    expect(await orgInFlight(right.organizationId)).toBe(2);
  });
});

// ── The real-concurrency contract (notes.html #35) ──────────────────────────

describe('the caps hold under REAL concurrency', () => {
  // ⚠️ MUTATION-CHECK THIS TEST: comment out the `lockScope` call in
  // `codeGraphIndexAdmissionService.admit` and it MUST go red. Every racer then
  // reads the same "0 in flight" snapshot and all of them take a slot — the
  // TOCTOU that a count-then-write with no shared row allows, and the exact bug a
  // serial loop cannot see.
  it('never exceeds the GLOBAL cap when many dispatches race', async () => {
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '4');
    // Eight different orgs, so ONLY the global cap can be what binds.
    const tenants = await Promise.all(Array.from({ length: 8 }, () => seedTenant()));

    const verdicts = await Promise.all(tenants.map((fx, i) => admit(fx, `moooon/r${i}`)));

    expect(verdicts.filter((v) => v.outcome === 'admitted')).toHaveLength(4);
    expect(await indexInFlight()).toBe(4);
  });

  // The per-tenant half of the same guarantee: one org racing its own
  // repo-connect burst cannot walk past `ceil(global / 2)`.
  it('never exceeds the PER-ORG cap when one tenant races itself', async () => {
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '6');
    const fx = await seedTenant();

    const verdicts = await Promise.all(
      Array.from({ length: 8 }, (_, i) => admit(fx, `moooon/burst-${i}`)),
    );

    expect(verdicts.filter((v) => v.outcome === 'admitted')).toHaveLength(3);
    expect(await orgInFlight(fx.organizationId)).toBe(3);
    // …and the global lane still has room, which is the point of a per-tenant cap.
    expect(await indexInFlight()).toBe(3);
  });

  // ⚠️ RACED AGAINST THE OTHER WORKLOADS, not just against itself. A same-workload
  // race would pass against an implementation that took a per-workload lock —
  // which is exactly the shape MOTIR-1997 exists to replace.
  // Since MOTIR-9375 each gate holds its OWN workload: the CI figure and the
  // per-org index share each hold exactly, in the same racing instant.
  it('holds CI at its figure and indexing at its share when the two race', async () => {
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '6');
    stubMotirAi();
    const fx = await seedTenant();
    await adminDb.organization.update({
      where: { id: fx.organizationId },
      data: { fleetPoolCap: 2 },
    });
    const intents = await Promise.all([1, 2, 3, 4].map(() => seedIntent(fx)));

    await Promise.all([
      ...intents.map((intent) => ciRunnerAdmissionService.admit(intent)),
      ...[1, 2, 3, 4, 5].map((i) => admit(fx, `moooon/race-${i}`)),
    ]);

    const census = await withSystemContext((tx) =>
      fleetCeilingService.orgCensus(fx.organizationId, NOW, tx),
    );
    expect(census.byWorkload.ci_runner).toBe(2);
    expect(census.byWorkload.code_graph_index).toBe(3);
  });

  // A redelivered job / replayed step must occupy ONE slot, not two — the
  // `(workload, ref)` uniqueness is what makes the take idempotent.
  it('takes exactly one slot when the same (repo × project) is admitted twice', async () => {
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '10');
    const fx = await seedTenant();

    const verdicts = await Promise.all([
      admit(fx, 'moooon/redelivered'),
      admit(fx, 'moooon/redelivered'),
    ]);

    expect(verdicts.filter((v) => v.outcome === 'admitted')).toHaveLength(1);
    expect(verdicts.filter((v) => v.outcome === 'already_held')).toHaveLength(1);
    expect(await indexInFlight()).toBe(1);
    // And both got a usable ticket naming the SAME slot — the redelivery boots
    // on the capacity it already holds.
    for (const verdict of verdicts) {
      if (verdict.outcome === 'deferred') throw new Error('expected a ticket');
      expect(verdict.admission.slotRef).toBe(indexSlotRef(fx.projectId, 'moooon/redelivered'));
    }
  });

  // ⚠️ AN ALREADY-HELD REF IS NOT JUDGED AGAINST THE CAPS. Refusing a redelivery
  // capacity it is already occupying would make the caller tear down a live
  // container to honour a refusal.
  it('admits an already-held ref even when indexing is at its cap', async () => {
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '1');
    const fx = await seedTenant();
    await admit(fx, 'moooon/held');
    expect(await admit(await seedTenant(), 'moooon/other')).toMatchObject({ reason: 'index_cap' });

    expect(await admit(fx, 'moooon/held')).toMatchObject({ outcome: 'already_held' });
    expect(await indexInFlight()).toBe(1);
  });
});

// ── Fail CLOSED ─────────────────────────────────────────────────────────────

describe('the index gate fails CLOSED', () => {
  it('DECLINES AND LOGS when a count cannot be established', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(fleetInFlightSlotRepository, 'countLiveForWorkload').mockRejectedValue(
      new Error('connection reset'),
    );
    const fx = await seedTenant();

    expect(await admit(fx)).toMatchObject({ outcome: 'deferred', reason: 'gate_unavailable' });
    expect(error).toHaveBeenCalled();
    // The transaction rolled back, so no slot was taken either.
    const fleetInFlightSlotCount = await adminDb.fleetInFlightSlot.count();
    expect(fleetInFlightSlotCount).toBe(0);
  });

  it('DECLINES when the per-ORG count throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(fleetInFlightSlotRepository, 'countLiveForWorkloadInOrganization').mockRejectedValue(
      new Error('connection reset'),
    );

    expect(await admit(await seedTenant())).toMatchObject({ reason: 'gate_unavailable' });
  });

  it('DECLINES AND LOGS when the shared admission lock cannot be taken', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(ciFleetAdmissionLockRepository, 'lockScope').mockResolvedValue(false);

    expect(await admit(await seedTenant())).toMatchObject({ reason: 'gate_unavailable' });
    expect(error).toHaveBeenCalled();
  });

  it('reports a NON-ERROR rejection as `unknown` rather than losing it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(ciFleetAdmissionLockRepository, 'ensureScope').mockRejectedValue('a bare string');

    expect(await admit(await seedTenant())).toMatchObject({
      reason: 'gate_unavailable',
      detail: expect.stringContaining('unknown'),
    });
  });

  // The lost-insert race the `ON CONFLICT DO NOTHING` closes: another transaction
  // committed the same ref between this one's read and its write. `mockResolvedValueOnce`
  // makes only the FIRST read miss, so the winner is read back for real afterwards —
  // which is what decides the verdict (MOTIR-2160).
  it('a LOST INSERT RACE by the SAME run reports already_held, never a second slot', async () => {
    const fx = await seedTenant();
    await admit(fx, 'moooon/raced');
    vi.spyOn(fleetInFlightSlotRepository, 'findByRef').mockResolvedValueOnce(null);

    expect(await admit(fx, 'moooon/raced')).toMatchObject({ outcome: 'already_held' });
    expect(await indexInFlight()).toBe(1);
  });

  // ⚠️ AND THE SAME RACE LOST TO A DIFFERENT RUN IS A DEFERRAL, NOT A TICKET. The
  // conflict alone cannot tell the two apart, and reading it as one's own
  // redelivery is what let a second container boot past every cap.
  it('a LOST INSERT RACE to ANOTHER run defers — the conflict is not proof of ownership', async () => {
    const fx = await seedTenant();
    await admit(fx, 'moooon/raced', 'evt-first');
    vi.spyOn(fleetInFlightSlotRepository, 'findByRef').mockResolvedValueOnce(null);

    expect(await admit(fx, 'moooon/raced', 'evt-second')).toMatchObject({
      outcome: 'deferred',
      reason: 'repo_index_in_flight',
    });
    expect(await indexInFlight()).toBe(1);
  });

  // Fail CLOSED on an unreadable winner too: the insert conflicted, so SOMETHING
  // holds the slot, and a holder that cannot be identified is not this run.
  it('DEFERS when the winning row cannot be read back at all', async () => {
    const fx = await seedTenant();
    await admit(fx, 'moooon/unreadable');
    vi.spyOn(fleetInFlightSlotRepository, 'findByRef').mockResolvedValue(null);

    expect(await admit(fx, 'moooon/unreadable')).toMatchObject({
      outcome: 'deferred',
      reason: 'repo_index_in_flight',
    });
    expect(await indexInFlight()).toBe(1);
  });
});

// ── The slot's own bookkeeping ──────────────────────────────────────────────

describe('the slot a granted admission takes', () => {
  it('is attributed, and expires LATER than the container it stands for', async () => {
    const fx = await seedTenant();
    const verdict = await admit(fx, 'moooon/ttl');
    expect(verdict.outcome).toBe('admitted');

    const slot = await withSystemContext((tx) =>
      fleetInFlightSlotRepository.findByRef(
        'code_graph_index',
        indexSlotRef(fx.projectId, 'moooon/ttl'),
        tx,
      ),
    );
    expect(slot).toMatchObject({
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
    });
    // ⚠️ THE ONE DIRECTION THAT WOULD BREAK THE CEILING. A TTL shorter than the
    // container's real life stops counting a container that is still spending.
    expect(slot!.expiresAt.getTime()).toBeGreaterThan(NOW.getTime() + CONTAINER_TIMEOUT_MS);
  });

  it('stops counting once its safety net has passed', async () => {
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '1');
    const fx = await seedTenant();
    await admit(fx, 'moooon/stale');
    expect(await admit(await seedTenant(), 'moooon/next')).toMatchObject({ reason: 'index_cap' });

    const later = new Date(NOW.getTime() + CONTAINER_TIMEOUT_MS + 3_600_000);
    const verdict = await codeGraphIndexAdmissionService.admit(
      {
        projectId: fx.projectId,
        repoRef: 'moooon/next',
        dispatchId: RUN,
        workspaceId: fx.workspaceId,
        organizationId: fx.organizationId,
        containerTimeoutMs: CONTAINER_TIMEOUT_MS,
      },
      later,
    );

    expect(verdict.outcome).toBe('admitted');
  });

  it('releasing a slot that was never held is visible, not silent', async () => {
    expect(await codeGraphIndexAdmissionService.release('never:taken', RUN)).toBe(false);
  });

  it('keys the slot by (projectId, repoRef) — deterministic, never run-scoped', () => {
    expect(indexSlotRef('proj-1', 'moooon/core')).toBe('proj-1:moooon/core');
    expect(indexSlotRef('proj-1', 'moooon/core')).toBe(indexSlotRef('proj-1', 'moooon/core'));
    expect(indexSlotRef('proj-2', 'moooon/core')).not.toBe(indexSlotRef('proj-1', 'moooon/core'));
  });

  // …and the RUN that took it rides on the ROW, which is the half the key
  // deliberately cannot carry (MOTIR-2160).
  it('stamps the taking run on the slot, without putting it in the key', async () => {
    const fx = await seedTenant();
    await admit(fx, 'moooon/owned', 'evt-owner');

    const slot = await withSystemContext((tx) =>
      fleetInFlightSlotRepository.findByRef(
        'code_graph_index',
        indexSlotRef(fx.projectId, 'moooon/owned'),
        tx,
      ),
    );
    expect(slot).toMatchObject({ ownerRef: 'evt-owner' });
    // The key is unchanged — a run-scoped KEY is what would let retries walk the cap.
    expect(slot!.ref).toBe(`${fx.projectId}:moooon/owned`);
  });
});

// ── TWO RUNS, ONE (repo × project) — MOTIR-2160 ─────────────────────────────
//
// The debounce coalesces pushes inside a 2-minute window and stops at the run
// boundary; an index takes minutes. So a SECOND run for a repo the first is still
// indexing is ordinary merge cadence, and the slot key alone cannot tell it from
// the first run's own replay. Everything below is that distinction, against real
// transactions.

describe('a second RUN for a (repo × project) the first is still indexing', () => {
  it('is DEFERRED, not admitted — the ticket count is what the cap really bounds', async () => {
    // Room for a dozen: nothing here may be a CAP refusal in disguise.
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '12');
    const fx = await seedTenant();

    expect(await admit(fx, 'moooon/core', 'evt-A')).toMatchObject({ outcome: 'admitted' });
    const second = await admit(fx, 'moooon/core', 'evt-B');

    expect(second).toMatchObject({ outcome: 'deferred', reason: 'repo_index_in_flight' });
    // ⚠️ THE ASSERTION THE CARD TURNS ON, stated as capacity: one unit of index
    // work, one slot, one container's worth of spend — never two.
    expect(await indexInFlight()).toBe(1);
    // And the deferral names the holder, so an operator reading the run's log can
    // tell "another run has this repo" from "the fleet is full".
    if (second.outcome !== 'deferred') throw new Error('expected a deferral');
    expect(second.detail).toContain('evt-A');
  });

  it('never lets both of TWO CONCURRENT runs through — the race, not the sequence', async () => {
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '12');
    const fx = await seedTenant();

    // Two dispatchers arriving together on the same repo, as two pushes four
    // minutes apart really do. Under the shared `fleet` lock exactly one may win.
    const verdicts = await Promise.all([
      admit(fx, 'moooon/core', 'evt-A'),
      admit(fx, 'moooon/core', 'evt-B'),
    ]);

    expect(verdicts.filter((v) => v.outcome === 'admitted')).toHaveLength(1);
    expect(verdicts.filter((v) => v.outcome === 'deferred')).toHaveLength(1);
    expect(verdicts.filter((v) => v.outcome === 'already_held')).toHaveLength(0);
    expect(await indexInFlight()).toBe(1);
  });

  // ⚠️ AND IT IS THE RUN, NOT THE REPO, THAT IS SERIALIZED. Two runs indexing the
  // same repo into DIFFERENT projects are two units of work, and the fan-out
  // depends on both proceeding.
  it('does not serialize two PROJECTS of the same repo', async () => {
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '12');
    const first = await seedTenant();
    const second = await seedTenant();

    expect(await admit(first, 'moooon/core', 'evt-A')).toMatchObject({ outcome: 'admitted' });
    expect(await admit(second, 'moooon/core', 'evt-B')).toMatchObject({ outcome: 'admitted' });
    expect(await indexInFlight()).toBe(2);
  });

  // The deferral is a WAIT, and the holder settling is what ends it — the same
  // "nothing is dropped" contract every other deferral has.
  it('lets the waiting run in as soon as the holder releases', async () => {
    const fx = await seedTenant();
    const first = await admit(fx, 'moooon/core', 'evt-A');
    if (first.outcome !== 'admitted') throw new Error('expected a ticket');
    expect(await admit(fx, 'moooon/core', 'evt-B')).toMatchObject({
      reason: 'repo_index_in_flight',
    });

    await codeGraphIndexAdmissionService.release(first.admission.slotRef, 'evt-A');

    expect(await admit(fx, 'moooon/core', 'evt-B')).toMatchObject({ outcome: 'admitted' });
    expect(await indexInFlight()).toBe(1);
  });

  // ⚠️ THE NON-REFUSAL THAT MUST SURVIVE. `already_held` exists for a redelivered
  // job and a replayed step, and scoping it to the run must not cost that: a run
  // asking again for capacity it is already holding still gets its ticket, still
  // ahead of every cap.
  it('still admits the SAME run’s retry — even with indexing at its cap', async () => {
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '1');
    const fx = await seedTenant();
    const first = await admit(fx, 'moooon/core', 'evt-A');
    if (first.outcome !== 'admitted') throw new Error('expected a ticket');

    const replay = await admit(fx, 'moooon/core', 'evt-A');

    expect(replay).toMatchObject({ outcome: 'already_held' });
    if (replay.outcome === 'deferred') throw new Error('expected a ticket');
    // The SAME slot — the replay boots on the capacity it already holds.
    expect(replay.admission.slotRef).toBe(first.admission.slotRef);
    expect(await indexInFlight()).toBe(1);
  });

  // A row taken before `owner_ref` existed belongs to a run this one cannot name.
  // It DEFERS: the question is whether to boot a second container beside a live
  // one, and an unidentifiable holder is not evidence that it is safe.
  it('defers behind an UNOWNED slot — a holder it cannot identify is not itself', async () => {
    const fx = await seedTenant();
    await withSystemContext((tx) =>
      fleetInFlightSlotRepository.take(
        {
          workload: 'code_graph_index',
          ref: indexSlotRef(fx.projectId, 'moooon/legacy'),
          organizationId: fx.organizationId,
          workspaceId: fx.workspaceId,
          expiresAt: new Date(NOW.getTime() + CONTAINER_TIMEOUT_MS),
        },
        tx,
      ),
    );

    expect(await admit(fx, 'moooon/legacy', 'evt-A')).toMatchObject({
      outcome: 'deferred',
      reason: 'repo_index_in_flight',
    });
  });
});

// ── The release owns what it frees ──────────────────────────────────────────

describe('a settle may only release the slot ITS OWN run took', () => {
  // ⚠️ MUTATION-CHECK THIS TEST: make `release` delegate to
  // `fleetInFlightSlotRepository.release` (the unchecked delete) and it MUST go
  // red. That was the shipped behaviour, and it is how the first run to settle
  // freed capacity a second run's live container was still spending.
  it('leaves the holder’s slot — and the census still counts the live container', async () => {
    const fx = await seedTenant();
    const held = await admit(fx, 'moooon/core', 'evt-A');
    if (held.outcome !== 'admitted') throw new Error('expected a ticket');

    // run-B settles — a container of its own, on a slot it never took.
    const released = await codeGraphIndexAdmissionService.release(held.admission.slotRef, 'evt-B');

    expect(released).toBe(false);
    // THE INVARIANT: a live container is still counted. Under-counting one is the
    // one direction the ceiling must never err in.
    expect(await indexInFlight()).toBe(1);
    const census = await withSystemContext((tx) => fleetCeilingService.census(NOW, tx));
    expect(census.byWorkload.code_graph_index).toBe(1);
    // …and the row is untouched, still naming its real owner.
    const slot = await withSystemContext((tx) =>
      fleetInFlightSlotRepository.findByRef('code_graph_index', held.admission.slotRef, tx),
    );
    expect(slot).toMatchObject({ ownerRef: 'evt-A' });
  });

  it('frees it for the run that DID take it', async () => {
    const fx = await seedTenant();
    const held = await admit(fx, 'moooon/core', 'evt-A');
    if (held.outcome !== 'admitted') throw new Error('expected a ticket');

    expect(await codeGraphIndexAdmissionService.release(held.admission.slotRef, 'evt-A')).toBe(
      true,
    );
    expect(await indexInFlight()).toBe(0);
  });

  // The cascade the ownership check removes: with an unchecked delete, run-B's
  // settle frees the slot run-C is holding, and no row names the container it
  // stands for any more.
  it('cannot cascade — a stale settle does not free a LATER run’s slot', async () => {
    const fx = await seedTenant();
    const first = await admit(fx, 'moooon/core', 'evt-A');
    if (first.outcome !== 'admitted') throw new Error('expected a ticket');
    await codeGraphIndexAdmissionService.release(first.admission.slotRef, 'evt-A');
    const later = await admit(fx, 'moooon/core', 'evt-C');
    expect(later.outcome).toBe('admitted');

    // run-B settles late, holding the same ref it once asked about.
    await codeGraphIndexAdmissionService.release(first.admission.slotRef, 'evt-B');

    expect(await indexInFlight()).toBe(1);
  });

  // The migration window, stated as a test so the asymmetry is deliberate rather
  // than discovered: an UNOWNED row blocks a second admission (above) but does not
  // strand its own holder's release for a full TTL.
  it('frees an UNOWNED slot, so a run in flight at deploy time is not stranded', async () => {
    const fx = await seedTenant();
    const slotRef = indexSlotRef(fx.projectId, 'moooon/legacy');
    await withSystemContext((tx) =>
      fleetInFlightSlotRepository.take(
        {
          workload: 'code_graph_index',
          ref: slotRef,
          organizationId: fx.organizationId,
          workspaceId: fx.workspaceId,
          expiresAt: new Date(NOW.getTime() + CONTAINER_TIMEOUT_MS),
        },
        tx,
      ),
    );

    expect(await codeGraphIndexAdmissionService.release(slotRef, 'evt-A')).toBe(true);
    expect(await indexInFlight()).toBe(0);
  });
});

// ── An EXPIRED slot is debris, not a holder ─────────────────────────────────

describe('a slot whose safety net has passed does not hold the work it named', () => {
  /** Plant a slot that expired `agoMs` ago — a run that took capacity and never
   *  gave it back. `take` is the real repository write, so the row is exactly
   *  the shape a leaked one has in production. */
  async function plantExpiredSlot(
    fx: Fixture,
    repoRef: string,
    options: { ownerRef?: string | null; agoMs?: number; workload?: string } = {},
  ): Promise<string> {
    const ref =
      options.workload && options.workload !== 'code_graph_index'
        ? repoRef
        : indexSlotRef(fx.projectId, repoRef);
    await withSystemContext((tx) =>
      fleetInFlightSlotRepository.take(
        {
          workload: options.workload ?? 'code_graph_index',
          ref,
          ownerRef: options.ownerRef ?? null,
          organizationId: fx.organizationId,
          workspaceId: fx.workspaceId,
          expiresAt: new Date(NOW.getTime() - (options.agoMs ?? 3_600_000)),
        },
        tx,
      ),
    );
    return ref;
  }

  // ⚠️ THE PRODUCTION FIXTURE, AND THE ONE TO MUTATION-CHECK (MOTIR-3684).
  // Delete the `slots.deleteExpired(now, tx)` line from
  // `codeGraphIndexAdmissionService.admit` and this case MUST go red with
  // `repo_index_in_flight`. That is precisely what shipped: a slot for
  // `<project>:moooon-B-V/motir-core` expired at 2026-08-26T15:40:28Z and refused
  // every refresh of that repository for the next nineteen hours — 60 attempts
  // over ~1.7 hours per run, nine runs, a 100% failure rate — while the fleet held
  // ZERO live containers.
  it('does NOT defer a later dispatch — the leak recovers itself', async () => {
    const fx = await seedTenant();
    await plantExpiredSlot(fx, 'moooon/core', { ownerRef: 'evt-dead' });

    const verdict = await admit(fx, 'moooon/core', 'evt-later');

    expect(verdict.outcome).toBe('admitted');
    // And the row the new dispatch holds is ITS OWN, not the corpse rewritten.
    const slot = await withSystemContext((tx) =>
      fleetInFlightSlotRepository.findByRef(
        'code_graph_index',
        indexSlotRef(fx.projectId, 'moooon/core'),
        tx,
      ),
    );
    expect(slot).toMatchObject({ ownerRef: 'evt-later' });
    expect(slot!.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
    expect(await indexInFlight()).toBe(1);
  });

  // The OTHER production row: taken 2026-08-07 by a run that ended
  // `teardown_failed` — which deliberately does not release, "left for the
  // reaper". There was no reaper, so `moooon-B-V/motir-meta` went twenty days
  // without a code-graph refresh. An unowned row defers while it is LIVE (the
  // migration-window case above); once expired it is debris like any other.
  it('recovers even when nothing can name the run that leaked it', async () => {
    const fx = await seedTenant();
    await plantExpiredSlot(fx, 'moooon/legacy', {
      ownerRef: null,
      agoMs: 20 * 24 * 3_600_000,
    });

    expect(await admit(fx, 'moooon/legacy', 'evt-later')).toMatchObject({ outcome: 'admitted' });
  });

  // ⚠️ THE PROPERTY MOTIR-2160 BOUGHT MUST SURVIVE THE REAP. The reap keys on
  // EXPIRY and nothing else, so a second run arriving while the first's container
  // is genuinely alive still waits — which is the whole of what stops two
  // containers doing one unit of work.
  it('still defers behind a LIVE holder — expiry is the only thing the reap reads', async () => {
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '12');
    const fx = await seedTenant();
    expect(await admit(fx, 'moooon/core', 'evt-A')).toMatchObject({ outcome: 'admitted' });

    expect(await admit(fx, 'moooon/core', 'evt-B')).toMatchObject({
      outcome: 'deferred',
      reason: 'repo_index_in_flight',
    });
    expect(await indexInFlight()).toBe(1);
  });

  // The reap runs under the fleet admission lock, which serializes every
  // workload's admission — so it clears every workload's debris, and a starved
  // repo's own refresh is what pays for the sweep. It must NOT touch a live row
  // of another workload: that would under-count a container still spending, the
  // one direction the ceiling may never err in.
  it('clears another workload’s expired debris and leaves its LIVE slots alone', async () => {
    const fx = await seedTenant();
    await plantExpiredSlot(fx, 'agent-run-dead', { workload: 'hosted_agent' });
    await withSystemContext((tx) =>
      fleetInFlightSlotRepository.take(
        {
          workload: 'hosted_agent',
          ref: 'agent-run-live',
          ownerRef: 'agent-run-live',
          organizationId: fx.organizationId,
          workspaceId: fx.workspaceId,
          expiresAt: new Date(NOW.getTime() + CONTAINER_TIMEOUT_MS),
        },
        tx,
      ),
    );

    expect((await admit(fx, 'moooon/core')).outcome).toBe('admitted');

    const rows = await adminDb.fleetInFlightSlot.findMany({
      where: { workload: 'hosted_agent' },
      select: { ref: true },
    });
    expect(rows.map((r) => r.ref)).toEqual(['agent-run-live']);
  });

  // ⚠️ A RELEASE THAT REMOVES NOTHING IS THE MOMENT A LEAK IS BORN, and it used
  // to leave no trace at all — the boolean is returned and the index path
  // discards it, so the only evidence was the refusals hours later, by which time
  // nothing linked them to the run that caused them.
  it('says so when a release removes no row', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await codeGraphIndexAdmissionService.release('never:taken', RUN)).toBe(false);

    expect(warn).toHaveBeenCalledWith(
      '[fleetCeilingService] a fleet-slot release removed no row',
      expect.objectContaining({ workload: 'code_graph_index', ref: 'never:taken' }),
    );
  });
});

// ── No bypass ───────────────────────────────────────────────────────────────

describe('nothing bypasses the index caps', () => {
  // §8/§9.1: meta's OWN index containers run through this identical code, into
  // the same org. `isMeta` decides whether a cost is CHARGED, never whether work
  // runs somewhere else — and a meta-org runaway costs exactly as much.
  it('the META org is not exempt from either cap', async () => {
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '2');
    const meta = await seedTenant({ isMeta: true });

    expect((await admit(meta, 'moooon/a')).outcome).toBe('admitted');
    expect(await admit(meta, 'moooon/b')).toMatchObject({ reason: 'org_index_cap' });
  });

  it('MOTIR_CLOUD=false does not lift them either', async () => {
    vi.stubEnv('MOTIR_CLOUD', 'false');
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '1');
    const fx = await seedTenant();

    expect((await admit(fx, 'moooon/a')).outcome).toBe('admitted');
    expect(await admit(await seedTenant(), 'moooon/b')).toMatchObject({ reason: 'index_cap' });
  });
});

// ── The indexer's own account pool (MOTIR-9445) ──────────────────────────────

describe("an admitted index lands on an account of the INDEXER'S pool", () => {
  /** One account of a kind's pool, with room for `machineLimit` containers. */
  function account(machineLimit: number, fleetKind = 'code_graph_index'): Promise<FleetShard> {
    const slug = randomToken(6).toLowerCase();
    return adminDb.fleetShard.create({
      data: {
        name: `acct-${slug}`,
        fleetKind,
        provider: 'fly',
        state: 'active',
        githubOrg: MOTIR_ORG,
        githubInstallationId: '556677',
        flyOrg: 'motir',
        flyApp: `motir-idx-${slug}`,
        flyRegion: 'iad',
        credentialRef: 'FLEET_SHARD_TEST_TOKEN',
        machineLimit,
      },
    });
  }

  /** Fill `count` units of an account with live index slots of other projects. */
  async function occupy(shard: FleetShard, count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await withSystemContext((tx) =>
        fleetInFlightSlotRepository.take(
          {
            workload: 'code_graph_index',
            ref: `busy:${shard.id}:${i}`,
            // A filler org, so no tenant under test is near its own cap.
            organizationId: 'org-filler',
            expiresAt: new Date(NOW.getTime() + CONTAINER_TIMEOUT_MS * 2),
            fleetShardId: shard.id,
          },
          tx,
        ),
      );
    }
  }

  function slotShard(fx: Fixture, repoRef: string): Promise<string | null | undefined> {
    return adminDb.fleetInFlightSlot
      .findUnique({
        where: {
          workload_ref: { workload: 'code_graph_index', ref: indexSlotRef(fx.projectId, repoRef) },
        },
      })
      .then((row) => row?.fleetShardId);
  }

  beforeEach(async () => {
    await adminDb.fleetShard.deleteMany({});
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '12');
    vi.stubEnv('MOTIR_INDEX_FLEET_PROVIDER', 'aws');
  });

  afterEach(async () => {
    // The slot's FK onto the account is RESTRICT: slots first.
    await adminDb.fleetInFlightSlot.deleteMany({});
    await adminDb.fleetShard.deleteMany({});
    wireFleetKindSwitch('ci_runner', null);
  });

  it('switch OFF: admitted with no account, whatever the other kinds say', async () => {
    vi.stubEnv('MOTIR_INDEX_FLEET_PROVIDER', '');
    wireFleetKindSwitch('ci_runner', () => true);
    await account(4);
    const fx = await seedTenant();

    const verdict = await admit(fx, 'moooon/off');

    expect(verdict.outcome).toBe('admitted');
    if (verdict.outcome !== 'admitted') throw new Error('expected an admission');
    expect(verdict.admission.shardId).toBeNull();
    expect(await slotShard(fx, 'moooon/off')).toBeNull();
  });

  it('switch ON: takes the roomier account, on the slot and on the admission', async () => {
    const tight = await account(3);
    const roomy = await account(5);
    await occupy(tight, 1);
    const fx = await seedTenant();

    const verdict = await admit(fx, 'moooon/on');

    if (verdict.outcome !== 'admitted') throw new Error('expected an admission');
    expect(verdict.admission.shardId).toBe(roomy.id);
    expect(verdict.admission.detail).toContain(roomy.id);
    expect(await slotShard(fx, 'moooon/on')).toBe(roomy.id);
  });

  it("never takes another kind's account", async () => {
    await account(8, 'ci_runner');
    const own = await account(1);
    const fx = await seedTenant();

    const verdict = await admit(fx, 'moooon/own');
    if (verdict.outcome !== 'admitted') throw new Error('expected an admission');
    expect(verdict.admission.shardId).toBe(own.id);

    // The indexer's pool is now full; the roomy CI account is NOT a fallback.
    expect(await admit(await seedTenant(), 'moooon/next')).toMatchObject({
      outcome: 'deferred',
      reason: 'pool_full',
    });
  });

  it('every account full: deferred pool_full, no slot taken, nothing on Fly', async () => {
    const only = await account(2);
    await occupy(only, 2);
    const before = await indexInFlight();
    const fx = await seedTenant();

    const verdict = await admit(fx, 'moooon/full');

    expect(verdict).toMatchObject({
      outcome: 'deferred',
      reason: 'pool_full',
      detail: expect.stringContaining('pool'),
    });
    expect(await indexInFlight()).toBe(before);
    expect(await slotShard(fx, 'moooon/full')).toBeUndefined();
  });

  it('no account at all with the switch on is also pool_full — never a Fly fallback', async () => {
    const verdict = await admit(await seedTenant(), 'moooon/empty');
    expect(verdict).toMatchObject({ outcome: 'deferred', reason: 'pool_full' });
    expect(await indexInFlight()).toBe(0);
  });

  it("already_held answers the held slot's account; another dispatch waits", async () => {
    const shard = await account(4);
    const fx = await seedTenant();
    expect(await admit(fx, 'moooon/held', 'evt-A')).toMatchObject({ outcome: 'admitted' });

    const redelivery = await admit(fx, 'moooon/held', 'evt-A');
    if (redelivery.outcome !== 'already_held') throw new Error('expected already_held');
    expect(redelivery.admission.shardId).toBe(shard.id);

    expect(await admit(fx, 'moooon/held', 'evt-B')).toMatchObject({
      outcome: 'deferred',
      reason: 'repo_index_in_flight',
    });
  });

  // Every earlier refusal is decided BEFORE the pool is read: a full pool must not
  // mask the reason an operator actually needs to see.
  it('kill switch, single-flight, org cap and global cap all come before the account', async () => {
    const only = await account(1);
    await occupy(only, 1);

    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '0');
    expect(await admit(await seedTenant())).toMatchObject({ reason: 'fleet_ceiling' });
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '');

    // Single-flight: the holder took its slot while the pool still had room.
    await adminDb.fleetInFlightSlot.deleteMany({});
    const fx = await seedTenant();
    expect((await admit(fx, 'moooon/sf', 'evt-A')).outcome).toBe('admitted');
    expect(await admit(fx, 'moooon/sf', 'evt-B')).toMatchObject({
      reason: 'repo_index_in_flight',
    });

    // Org cap (ceil(2/2) = 1) and global cap (2/2), both with the pool full.
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '2');
    expect(await admit(fx, 'moooon/sf-2')).toMatchObject({ reason: 'org_index_cap' });
    await withSystemContext((tx) =>
      fleetInFlightSlotRepository.take(
        {
          workload: 'code_graph_index',
          ref: 'other:org',
          organizationId: 'org-other',
          expiresAt: new Date(NOW.getTime() + CONTAINER_TIMEOUT_MS * 2),
        },
        tx,
      ),
    );
    expect(await admit(await seedTenant())).toMatchObject({ reason: 'index_cap' });
  });

  // ⚠️ MUTATION-CHECK THIS TEST: comment out the `lockScope` call in
  // `codeGraphIndexAdmissionService.admit` and it MUST go red — every racer reads
  // the same free unit and all of them land on it. The choice is held open for a
  // beat before the take, so the racers genuinely overlap between "this account
  // has one unit free" and the INSERT that spends it; under the lock they simply
  // queue behind each other.
  it('admits exactly one of many racing for the last unit of the pool', async () => {
    const shard = await account(3);
    await occupy(shard, 2);
    const tenants = await Promise.all(Array.from({ length: 6 }, () => seedTenant()));
    // The lock's anchor row exists before the race, as it does in production. A
    // FIRST admission inserts it, and a racer blocking on that uncommitted insert
    // would serialize the race with or without the lock — hiding the mutation.
    await withSystemContext((tx) => ciFleetAdmissionLockRepository.ensureScope('fleet', tx));
    const choose = fleetShardAdmissionService.chooseInTx.bind(fleetShardAdmissionService);
    vi.spyOn(fleetShardAdmissionService, 'chooseInTx').mockImplementation(async (...args) => {
      const placement = await choose(...args);
      await new Promise((resolve) => setTimeout(resolve, 150));
      return placement;
    });

    const verdicts = await Promise.all(tenants.map((fx, i) => admit(fx, `moooon/last-${i}`)));

    expect(verdicts.filter((v) => v.outcome === 'admitted')).toHaveLength(1);
    expect(verdicts.filter((v) => v.outcome === 'deferred')).toHaveLength(5);
    expect(
      await withSystemContext((tx) =>
        fleetInFlightSlotRepository.countLiveForWorkloadOnShard(
          'code_graph_index',
          shard.id,
          NOW,
          tx,
        ),
      ),
    ).toBe(3);
  });

  it('an admission naming its account survives a JSON round-trip (a replayed step)', async () => {
    const shard = await account(2);
    const verdict = await admit(await seedTenant(), 'moooon/json');
    if (verdict.outcome !== 'admitted') throw new Error('expected an admission');

    const replayed = JSON.parse(JSON.stringify(verdict.admission)) as typeof verdict.admission;
    expect(replayed).toEqual(verdict.admission);
    expect(replayed.shardId).toBe(shard.id);
  });
});
