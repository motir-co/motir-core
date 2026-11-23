import type {
  FakeHostingControls,
  HostingDeployPort,
  HostingDeployTarget,
} from '@motir/orchestrator';
import { adminDb } from './db-reset';
import { E2E_ENVIRONMENT_CONFIG_ENCRYPTION_KEY } from './github-const';
import type { ProductionRepo, ProductionSeed } from './production-seed';
import { getHostingDeployPort } from '@/lib/orchestrator/hosting';
import { environmentConfigService } from '@/lib/services/environmentConfigService';
import { productionUsageMeterService } from '@/lib/services/productionUsageMeterService';

// Drivers and authoritative reads for Story MOTIR-9799's acceptance recording
// (Subtask MOTIR-12112): a live Motir-hosted app's logs, health, crashes, idle
// policy and usage on the Production panel.
//
// THE FAKE IS ARRANGED THROUGH ITS OWN CONTROLS, IN THIS PROCESS. The runner's
// `getHostingDeployPort` is the same file-backed fake the webServer and the job
// worker read (`MOTIR_FAKE_HOSTING_STATE_PATH`, `shareAcrossProcesses`): every
// control loads the shared slice, changes it and saves it, so a log line
// appended here is the line the webServer's logs route reads, and an exit set
// here is the exit the worker's prober reads. No route is mocked.
//
// THE PROBER RUNS IN THE LANE'S JOB WORKER, on its own one-minute schedule
// (`system.production-health-probe`) — the worker is the process that holds the
// GitHub seam the probe reads the manifest's health-check path through. A spec
// waits for its rows with `expect.poll`. THE ACCRUAL is hourly, so the spec
// runs one pass here, on demand (`accrueUsage`) — the same service the job
// calls, against the same shared fake and database.

// The runner seals the production secret it sets, as the webServer and the
// worker open it; the lane hands the key to those two processes only.
process.env['ENVIRONMENT_CONFIG_ENCRYPTION_KEY'] ??= E2E_ENVIRONMENT_CONFIG_ENCRYPTION_KEY;

type FakeHosting = HostingDeployPort & FakeHostingControls;

/** The shared hosting fake for a target, as this process sees it. */
export function hostingFake(target: HostingDeployTarget = 'fly'): FakeHosting {
  return getHostingDeployPort(target) as FakeHosting;
}

/**
 * Bring the fake's clock up to the wall clock. The fake keeps its own clock
 * (2026-01-01 when the store is new), and every time it stamps — a release's
 * start, an exit — is read by the panel against the browser's now. Never moves
 * it back: another spec may have run it ahead.
 */
export function alignHostingClock(target: HostingDeployTarget = 'fly'): void {
  const fake = hostingFake(target);
  const lag = Math.floor((Date.now() - fake.now().getTime()) / 1000);
  if (lag > 0) fake.advanceSeconds(lag);
}

/** The repository's production app at the fake. */
export async function appRefOf(repo: ProductionRepo): Promise<string> {
  const { appRef } = await hostingFake().ensureApp({
    repositoryId: repo.id,
    environment: { kind: 'production' },
  });
  return appRef;
}

/** Lines the app wrote, oldest first, `secondsAgo` before the wall clock. */
export async function appendLogLines(
  repo: ProductionRepo,
  lines: ReadonlyArray<{ secondsAgo: number; message: string }>,
): Promise<void> {
  const appRef = await appRefOf(repo);
  hostingFake().appendLogLines(
    appRef,
    lines.map((l) => ({
      at: new Date(Date.now() - l.secondsAgo * 1000),
      stream: 'app' as const,
      message: l.message,
    })),
  );
}

/** Make the target's log service refuse the app's logs, or answer again (null). */
export async function setLogsUnavailable(
  repo: ProductionRepo,
  reason: string | null,
): Promise<void> {
  hostingFake().setLogsUnavailable(await appRefOf(repo), reason);
}

/** The app's process exits with `exitCode`, from the fake's (aligned) now. */
export async function crashApp(repo: ProductionRepo, exitCode: number): Promise<void> {
  alignHostingClock();
  hostingFake().setRuntimeState(await appRefOf(repo), { state: 'exited', exitCode });
}

/** The image and release id the fake serves for the repository's app. */
export async function servingAtFake(
  repo: ProductionRepo,
): Promise<{ image: string; releaseId: string } | null> {
  const app = hostingFake().app(await appRefOf(repo));
  return app?.live ? { image: app.live.image, releaseId: app.live.releaseId } : null;
}

/** Set a production Environment secret, as the administrator. */
export async function setProductionSecret(
  seed: ProductionSeed,
  repo: ProductionRepo,
  name: string,
  value: string,
): Promise<void> {
  await environmentConfigService.set(
    repo.id,
    'production',
    { name, value, isSecret: true },
    { userId: seed.adminUserId, workspaceId: seed.workspaceId },
  );
}

/** One accrual pass, as the hourly job runs it. */
export async function accrueUsage(): Promise<void> {
  await productionUsageMeterService.accrue();
}

// ── Authoritative reads ──────────────────────────────────────────────────────

/** The live release's id and commit, or null. */
export async function liveReleaseOf(repo: ProductionRepo) {
  return adminDb.hostedRelease.findFirst({
    where: { application: { projectRepositoryId: repo.id }, state: 'live' },
    select: { id: true, commitSha: true },
  });
}

/** The repository's releases, newest first, with why each was made and the
 *  artifact it ran. */
export async function releaseCausesOf(repo: ProductionRepo) {
  const rows = await adminDb.hostedRelease.findMany({
    where: { application: { projectRepositoryId: repo.id } },
    orderBy: { createdAt: 'desc' },
    select: { commitSha: true, cause: true, artifactRef: true, state: true },
  });
  return rows.map((r) => ({
    commit: r.commitSha,
    cause: r.cause,
    artifactRef: r.artifactRef,
    state: r.state,
  }));
}

/** The stored health state, and which release it was probed on. */
export async function healthOf(repo: ProductionRepo) {
  return adminDb.hostedApplicationHealth.findFirst({
    where: { application: { projectRepositoryId: repo.id } },
    select: { state: true, probedReleaseId: true },
  });
}

/** The app's crash events, newest first. */
export async function crashEventsOf(repo: ProductionRepo) {
  return adminDb.hostedApplicationEvent.findMany({
    where: { application: { projectRepositoryId: repo.id } },
    orderBy: { occurredAt: 'desc' },
    select: { id: true, kind: true, exitCode: true, releaseId: true },
  });
}

/** The crash notifications a user holds. */
export async function crashNotificationsFor(userId: string) {
  return adminDb.notification.findMany({
    where: { recipientUserId: userId, type: 'production_app_crashed' },
    select: { id: true },
  });
}

/** The stored idle mode of the repository's application. */
export async function idleModeOf(repo: ProductionRepo) {
  const app = await adminDb.hostedApplication.findFirst({
    where: { projectRepositoryId: repo.id },
    select: { idleMode: true },
  });
  return app?.idleMode ?? null;
}

/** The repository's own usage slices this period: credits summed per unit. */
export async function usageCreditsOf(repo: ProductionRepo): Promise<Record<string, number>> {
  const rows = await adminDb.productionUsageSlice.groupBy({
    by: ['unit'],
    where: { application: { projectRepositoryId: repo.id } },
    _sum: { credits: true },
  });
  return Object.fromEntries(rows.map((r) => [r.unit, Number(r._sum.credits ?? 0)]));
}
