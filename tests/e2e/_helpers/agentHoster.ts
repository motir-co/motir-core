import { expect, type Page, type Response } from '@playwright/test';
import * as Sentry from '@sentry/nextjs';
import {
  fakePersistentOrchestrator,
  type FakeCapacityOperation,
  type FleetInventory,
  type InventoryMachine,
} from '@motir/orchestrator';
import { adminDb } from './db-reset';
import { clearFleetRows } from './fleet-monitor-seed';
import {
  holdShardShared,
  readShardFakeCalls,
  releaseShardShared,
  resetShardFakeJournal,
  type ShardFakeCall,
} from '@/lib/orchestrator/shardFakeJournal';
import {
  FLEET_ATTRIBUTION_GRACE_MS,
  fleetAttributionService,
  type AccountInventory,
} from '@/lib/services/fleetAttributionService';
import en from '@/messages/en.json';

// THE AGENT HOSTER, FROM OUTSIDE THE BROWSER (Story MOTIR-9361 · MOTIR-9478) —
// for `acceptance-my-agents--agent-hoster.spec.ts`.
//
// ── THE SEAMS ─────────────────────────────────────────────────────────────────
//   * The two hoster accounts are `agent_instance` AWS `FleetShard` rows. Under
//     the lane's fake fleet each one is `fakePersistentOrchestratorForShard`: a
//     per-account view over the ONE persistent fake store the webServer, the job
//     worker, the relay and the terminal host share.
//   * What each account was asked for, and which of its operations it refuses as
//     full, live beside that store's state file (`shardFakeJournal.ts`), so this
//     spec reads the calls the job worker's boot passes made and holds an
//     account's room for them.
//   * The switch is NOT here. It is flipped only through the platform-admin
//     control MOTIR-9503 ships, Operations → Fleet settings → Agent hosting.
//   * The reconciler runs once in THIS process (the worker runs it on a
//     five-minute cron and no route fires one pass), over the account
//     inventories the spec injects: an account's machines, read from the shared
//     store, plus the one machine the spec plants. Its alert goes to Sentry, so
//     the pass runs with Sentry's capture recorded (see `reconcileOnce`).

export const HOSTER_PREFIX = 'agent-hoster-e2e-';
const FLEET_SETTINGS = '/admin/fleet-settings';
const hosting = en.platformAdmin.fleetSettings.agentHosting;

export interface HosterAccount {
  id: string;
  name: string;
}

/** Two agent-hoster AWS accounts: A with more headroom (10) than B (2). */
export async function seedHosterAccounts(): Promise<{ a: HosterAccount; b: HosterAccount }> {
  const tag = Date.now().toString(36);
  const made: HosterAccount[] = [];
  for (const [i, machineLimit] of [10, 2].entries()) {
    made.push(
      await adminDb.fleetShard.create({
        data: {
          name: `${HOSTER_PREFIX}${tag}-${i === 0 ? 'a' : 'b'}`,
          fleetKind: 'agent_instance',
          provider: 'aws',
          state: 'active',
          githubOrg: 'motir-projects-e2e',
          githubInstallationId: '556677',
          awsAccountId: `88880000000${i + 1}`,
          awsRegion: 'us-east-1',
          credentialRef: `AWS_HOSTER_E2E_${i + 1}`,
          machineLimit,
        },
        select: { id: true, name: true },
      }),
    );
  }
  return { a: made[0]!, b: made[1]! };
}

/**
 * A fresh start: no hoster accounts (and no instance still naming one), no
 * recorded calls or holds, and the switch row gone — the reader's default, Fly.
 * Clean-up only: the run itself flips the switch through the page.
 */
export async function clearHoster(): Promise<void> {
  const shards = await adminDb.fleetShard.findMany({
    where: { name: { startsWith: HOSTER_PREFIX } },
    select: { id: true },
  });
  const ids = shards.map((s) => s.id);
  await adminDb.agentInstance.deleteMany({ where: { fleetShardId: { in: ids } } });
  await clearFleetRows();
  await adminDb.fleetShard.deleteMany({ where: { id: { in: ids } } });
  await adminDb.platformFleetKindSwitch.deleteMany({ where: { fleetKind: 'agent_instance' } });
  resetShardFakeJournal();
}

/** Arm the wait for the flip's Server Action BEFORE the press. */
function flipResponse(page: Page): Promise<Response> {
  return page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      r.request().headers()['next-action'] !== undefined &&
      new URL(r.url()).pathname === FLEET_SETTINGS,
  );
}

/**
 * Turn agent hosting onto AWS (`toAws`) or back to Fly the way a superadmin
 * does: Fleet settings, the Agent hosting switch, a reason, confirm. Resolves
 * once the page re-reads the new state.
 */
export async function flipAgentHosting(page: Page, toAws: boolean, reason: string): Promise<void> {
  await page.goto(FLEET_SETTINGS);
  const section = page.getByRole('main').getByTestId('agent-hosting');
  const state = section.getByTestId('agent-hosting-state');
  await expect(state).toHaveAttribute('data-state', toAws ? 'fly' : 'aws', { timeout: 60_000 });
  await section.getByRole('switch', { name: hosting.title }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(hosting.confirm.reasonLabel).fill(reason);
  const answered = flipResponse(page);
  await dialog
    .getByRole('button', {
      name: toAws ? hosting.confirm.confirmToAws : hosting.confirm.confirmToFly,
      exact: true,
    })
    .click();
  expect((await answered).status()).toBe(200);
  await expect(dialog).toHaveCount(0);
  await expect(state).toHaveAttribute('data-state', toAws ? 'aws' : 'fly');
}

/** Every call an account's view recorded, oldest first. */
export const callsOn = (account: HosterAccount): ShardFakeCall[] =>
  readShardFakeCalls().filter((c) => c.shardId === account.id);

/** The calls on any hoster account that named `ref` (a machine or a disk). */
export const callsNaming = (ref: string): ShardFakeCall[] =>
  readShardFakeCalls().filter((c) => c.ref === ref);

/** The account refuses `op` as full, for every process sharing the store. */
export function fillAccount(account: HosterAccount, op: FakeCapacityOperation): void {
  holdShardShared(account.id, op);
}

/**
 * Room frees on the account: its holds lift and the admission pause its refusal
 * set is cleared, so the next retry may choose it at once rather than after the
 * pause runs out.
 */
export async function freeAccount(account: HosterAccount): Promise<void> {
  releaseShardShared(account.id);
  await adminDb.fleetShard.update({
    where: { id: account.id },
    data: { admissionPausedUntil: null, admissionPausedReason: null },
  });
}

/** The instance row, as the webServer and the job worker wrote it. */
export const instanceRow = (id: string) =>
  adminDb.agentInstance.findUniqueOrThrow({
    where: { id },
    select: {
      state: true,
      fleetShardId: true,
      availabilityZone: true,
      flyApp: true,
      machineId: true,
      volumeId: true,
      deletedAt: true,
    },
  });

/** The machines and disks the shared fake store holds right now. */
export const liveMachines = (): string[] => fakePersistentOrchestrator.liveMachineIds();
export const liveVolumes = (): string[] => fakePersistentOrchestrator.liveVolumeIds();

/** Start a machine by hand in `app`, outside Motir: no instance names it. */
export function plantMachine(app: string): string {
  return fakePersistentOrchestrator.createOutside(app);
}

/**
 * One account's inventory, read from the shared store: the machines of the
 * instances recorded on it, plus any machine planted into its app. Its kills
 * land in the store, where every other process sees them.
 */
export async function hosterInventory(
  account: HosterAccount,
  planted: readonly string[],
): Promise<AccountInventory> {
  const rows = await adminDb.agentInstance.findMany({
    where: { fleetShardId: account.id, deletedAt: null },
    select: { flyApp: true, machineId: true },
  });
  const owned = new Set(rows.map((r) => r.machineId).filter((m): m is string => m !== null));
  const apps = [...new Set(rows.map((r) => r.flyApp).filter((a): a is string => a !== null))];
  const inventory: FleetInventory = {
    provider: 'aws',
    listApps: async () => apps,
    listMachines: async (app): Promise<InventoryMachine[]> => {
      const { machines } = await fakePersistentOrchestrator.listPersistent(app);
      return machines
        .filter((m) => owned.has(m.machineId) || planted.includes(m.machineId))
        .map((m) => ({
          app,
          machineId: m.machineId,
          name: '',
          region: 'us-east-1',
          state: m.state,
          createdAt: m.createdAt,
          metadata: {},
        }));
    },
    destroyMachine: (app, machineId) => fakePersistentOrchestrator.destroyMachine(app, machineId),
    stopMachine: async () => {
      throw new Error('this walk expects no machine to be stopped');
    },
  };
  return { shardId: account.id, name: account.name, inventory, fleetKind: 'agent_instance' };
}

export type ReconcileResult = Awaited<ReturnType<typeof fleetAttributionService.reconcile>>;

/**
 * Run the reconciler ONCE over the given account inventories, on a clock past
 * the grace window, and return its result with the alerts it raised.
 *
 * ⚠️ THE ALERTS ARE READ AT THE SCOPE, NOT THROUGH A CLIENT. `@sentry/nextjs`
 * initialises once per process: once any spec in the same worker has closed
 * its client (`acceptance-hosted-run-aws-pool.spec.ts` does), a second
 * `Sentry.init` is a no-op and nothing reaches a `beforeSend`. Every
 * `Sentry.captureException` lands on a `Scope`, whichever copy of the module
 * namespace called it, so the pass runs with the scopes' capture recorded and
 * it is put back after.
 */
export async function reconcileOnce(
  accountInventories: readonly AccountInventory[],
): Promise<{ result: ReconcileResult; alerts: Error[] }> {
  const alerts: Error[] = [];
  const scope = Object.getPrototypeOf(Sentry.getCurrentScope()) as {
    captureException: (exception: unknown) => string;
  };
  const original = scope.captureException;
  scope.captureException = (exception: unknown) => {
    if (exception instanceof Error) alerts.push(exception);
    return 'e2e-recorded';
  };
  const later = Date.now() + FLEET_ATTRIBUTION_GRACE_MS + 60_000;
  try {
    const result = await fleetAttributionService.reconcile({
      now: () => new Date(later),
      inventory: null,
      accountInventories,
    });
    return { result, alerts };
  } finally {
    scope.captureException = original;
  }
}
