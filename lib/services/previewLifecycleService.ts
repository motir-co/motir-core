import { createHmac } from 'node:crypto';
import type { PreviewDeployment, PreviewDeploymentState } from '@/generated/prisma/client';
import type {
  ReleaseEnvVar,
  ReleaseHandle,
  ReleaseRuntime,
  ReleaseUsage,
} from '@motir/orchestrator';
import { mintInstallationToken } from '@/lib/github/appAuth';
import {
  previewDeploymentsClient,
  type PreviewDeploymentStatusState,
} from '@/lib/github/previewDeployments';
import type { RepositoryCoordinates } from '@/lib/github/repositoryActionsConfig';
import { seedPromotionGithub } from '@/lib/github/seedPromotion';
import { parseHostingManifest, type HostingManifest } from '@/lib/hosting/manifest';
import { sendEvent } from '@/lib/jobs/sendEvent';
// From the composition root, not `./hosting`: loading it binds the preview
// meter to the ports' destroys (MOTIR-5777), which this service never calls.
import { getHostingDeployPort, hostingOriginSecretKey } from '@/lib/orchestrator';
import { previewDomain } from '@/lib/preview/config';
import { NEON_PREVIEW_TARGETS } from '@/lib/preview/enablement';
import { choosePreviewHostName } from '@/lib/preview/hostName';
import {
  parsePreviewImageRunEvent,
  parsePreviewPullRequestEvent,
  type PreviewDeliveryRepository,
} from '@/lib/preview/lifecycleEvents';
import {
  createPreviewBranch,
  deletePreviewBranch,
  deletePreviewDatabase,
  ensurePreviewDatabase,
  previewBranchName,
  previewDatabaseApplicationRef,
} from '@/lib/preview/previewDatabase';
import { LIVE_PREVIEW_STATES } from '@/lib/preview/states';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { previewDeploymentRepository } from '@/lib/repositories/previewDeploymentRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { withSystemContext } from '@/lib/workspaces/context';

// THE PREVIEW LIFECYCLE (Story MOTIR-5766 · MOTIR-5776, decision MOTIR-5769 §4,
// §6 and §9). The events Motir already receives, wired to a pull request's
// preview:
//
//   pull_request opened / synchronize / reopened → the row `building` for the new
//       head; a GitHub deployment on that head, `in_progress`
//   preview-image run succeeded  → `starting`; the preview's app, its Neon branch,
//       the release; `ready` + `success` with `environment_url` once healthy
//   preview-image run did not    → `failed` + `failure`, with a reason
//   pull_request closed          → `closed`; the app and branch destroyed,
//       `inactive`
//   takeover                     → every preview closed as above, then the
//       repository's preview image app and Neon preview project destroyed
//   the reaper                   → finishes what a crash interrupted, closes a
//       preview whose close was missed
//
// Only for a repository whose previews `previewEnablementService` switched on;
// every other delivery is `not_enabled` and touches nothing.
//
// ⚠️ COMMIT, THEN EFFECT. A webhook commits the transition and enqueues the
// effect; the effect re-reads the row and acts only while it is still in the
// state that ordered it. Every outbound call (GitHub, the deploy port, the
// database port) runs outside any transaction, after the state that orders it
// has committed. A crash between the two leaves a row the reaper can finish:
// teardown clears each resource name as it destroys it, so a `closed` row that
// still names one is exactly an unfinished teardown.
//
// ⚠️ OUT OF ORDER IS NORMAL. A preview-image run for any SHA but the row's head
// is stale and ignored; a `closed` row ignores everything but a reopen.
//
// SCOPE EDGE. Charging what `destroyApp` returns is the metering card's (it binds
// a sink at composition; this returns the usage and calls no billing code); the
// push credential is enablement's; serving the host is serving's.

/** How long a start waits for the release's health check: polls × interval, ten
 *  minutes — an image pull, the preview branch's migrations and a cold boot. */
export const PREVIEW_START_POLLS = 20;
export const PREVIEW_START_POLL_MS = 30_000;

/** A live row untouched this long is re-checked against GitHub by the reaper —
 *  and one still `starting` has outlived its start job (ten minutes) six times. */
export const PREVIEW_REAP_RECHECK_MS = 60 * 60_000;

/** What a preview Machine is told about idling (recorded on Fly, native on
 *  serverless; AWS previews run until closed, §4). */
const PREVIEW_IDLE_SECONDS = 300;

export type PreviewLifecycleOutcome =
  /** A delivery the lifecycle does not act on. */
  | 'ignored'
  /** The repository is unknown, not Motir's, or its previews are not on. */
  | 'not_enabled'
  /** A run for a head that is not the row's, or an event after `closed`. */
  | 'stale'
  | 'building'
  | 'starting'
  | 'failed'
  | 'closed';

export interface PreviewLifecycleResult {
  readonly outcome: PreviewLifecycleOutcome;
  readonly previewId?: string;
}

/** The effects a committed transition enqueues. */
export type PreviewEffect = 'announce' | 'report_failure' | 'teardown';

export interface PreviewEffectRequestedData {
  workspaceId: string;
  previewId: string;
  effect: PreviewEffect;
  idempotencyKey: string;
}

export interface PreviewStartRequestedData {
  workspaceId: string;
  previewId: string;
  headSha: string;
  idempotencyKey: string;
}

export type PreviewStartResult =
  | { readonly status: 'deployed'; readonly handle: ReleaseHandle }
  | { readonly status: 'skipped' }
  | { readonly status: 'failed'; readonly reason: string };

export type PreviewHealth = 'healthy' | 'unhealthy' | 'pending';

export interface PreviewTeardownResult {
  readonly status: 'torn_down' | 'skipped' | 'unresolvable';
  /** What the app's releases ran — for metering. */
  readonly usage: readonly ReleaseUsage[];
}

export interface PreviewReapResult {
  readonly teardownsFinished: number;
  readonly closed: number;
  readonly announced: number;
  readonly startsAbandoned: number;
  readonly failed: number;
}

export interface PreviewRepositoryTeardownResult {
  readonly closed: number;
  readonly usage: readonly ReleaseUsage[];
}

// ── Reading what a row is about ─────────────────────────────────────────────

type FoundSubject = NonNullable<
  Awaited<ReturnType<typeof projectRepoRepository.findPreviewLifecycleSubjectInTx>>
>;

/** A row read THROUGH its mirror, so its repository is always realized. */
type Subject = FoundSubject & { githubRepo: NonNullable<FoundSubject['githubRepo']> };

/** A subject whose previews are on: realized, hosted, not leaving. */
type EnabledSubject = Subject & { hostingTarget: NonNullable<Subject['hostingTarget']> };

function isEnabled(subject: Subject | null): subject is EnabledSubject {
  return (
    subject !== null &&
    subject.previewEnabledAt !== null &&
    subject.takeoverState === null &&
    subject.state === 'created' &&
    subject.hostingTarget !== null
  );
}

/** The row behind a mirror, read in `tx` — realized by construction. */
async function subjectOfMirror(
  githubRepoId: string,
  tx: Parameters<Parameters<typeof withSystemContext>[0]>[0],
): Promise<Subject | null> {
  return (await projectRepoRepository.findPreviewLifecycleSubjectByGithubRepoInTx(
    githubRepoId,
    tx,
  )) as Subject | null;
}

/** Installation + repository id → the row, inside the delivery's system context. */
async function subjectForDelivery(
  delivery: PreviewDeliveryRepository,
  tx: Parameters<Parameters<typeof withSystemContext>[0]>[0],
): Promise<Subject | null> {
  const installation = await githubInstallationRepository.findByInstallationId(
    delivery.installationId,
    tx,
  );
  if (!installation) return null;
  const repo = await githubRepoRepository.findByInstallationAndRepoId(
    installation.id,
    delivery.providerRepoId,
    tx,
  );
  return repo ? subjectOfMirror(repo.id, tx) : null;
}

/** A row and the repository it belongs to, read together. */
async function readPreview(
  previewId: string,
): Promise<{ row: PreviewDeployment; subject: Subject | null } | null> {
  return withSystemContext(async (tx) => {
    const row = await previewDeploymentRepository.findById(previewId, tx);
    if (!row) return null;
    return { row, subject: await subjectOfMirror(row.repoId, tx) };
  });
}

function coordinatesOf(subject: Subject): RepositoryCoordinates {
  return {
    installationId: subject.githubRepo.installation.installationId,
    owner: subject.githubRepo.owner,
    repo: subject.githubRepo.name,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function enqueue(data: PreviewEffectRequestedData): Promise<void> {
  await sendEvent('preview/effect.requested', data);
}

/** Commit a transition in its own short system-context transaction. */
async function commitTransition(
  id: string,
  from: readonly PreviewDeploymentState[],
  to: PreviewDeploymentState,
  patch: Parameters<typeof previewDeploymentRepository.transition>[3] = {},
): Promise<PreviewDeployment | null> {
  return withSystemContext((tx) => previewDeploymentRepository.transition(id, from, to, patch, tx));
}

async function record(
  id: string,
  states: readonly PreviewDeploymentState[],
  patch: Parameters<typeof previewDeploymentRepository.recordWhileIn>[2],
): Promise<PreviewDeployment | null> {
  return withSystemContext((tx) =>
    previewDeploymentRepository.recordWhileIn(id, states, patch, tx),
  );
}

/**
 * Post a status on the row's deployment, creating the deployment first when the
 * announce never ran (a crash, a GitHub outage) — so a `failure` or `success` is
 * never lost for want of the deployment it belongs to. Recorded only while the
 * row is still in `states`, so a deployment made for a head the row has since
 * left is not attached to the new one.
 */
async function postStatus(
  row: PreviewDeployment,
  subject: Subject,
  states: readonly PreviewDeploymentState[],
  status: { state: PreviewDeploymentStatusState; environmentUrl?: string; description: string },
): Promise<void> {
  const coordinates = coordinatesOf(subject);
  let deploymentId = row.githubDeploymentId;
  if (!deploymentId) {
    deploymentId = await previewDeploymentsClient.createDeployment(coordinates, {
      sha: row.headSha,
      pullRequestNumber: row.pullRequestNumber,
    });
    await record(row.id, states, { githubDeploymentId: deploymentId });
  }
  await previewDeploymentsClient.postStatus(coordinates, deploymentId, status);
}

// ── What a release runs ─────────────────────────────────────────────────────

/** The repository's manifest at the preview's head, read through the
 *  provisioning App. A missing or invalid manifest throws its named error. */
async function manifestAt(
  coordinates: RepositoryCoordinates,
  sha: string,
): Promise<HostingManifest> {
  const { token } = await mintInstallationToken(coordinates.installationId, 'provisioning');
  const text = await seedPromotionGithub.readHostingManifest(
    { owner: coordinates.owner, repo: coordinates.repo, token },
    sha,
  );
  return parseHostingManifest(text);
}

/** Single-quote `value` for a POSIX shell. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The manifest as the port reads it. A postgres preview runs its migrations on
 * its OWN branch before it serves (§6: "each preview branch then runs
 * `migrateCommand` itself, so the PR's own migrations apply"), so the start
 * command is the migration, then the server; `migrate deploy` is idempotent, so
 * a restarted Machine re-runs it harmlessly.
 */
export function previewRuntime(manifest: HostingManifest): ReleaseRuntime {
  const migrate =
    manifest.database.kind === 'postgres' ? manifest.database.migrateCommand : undefined;
  return {
    port: manifest.port,
    healthCheck: { path: manifest.healthCheck.path },
    startCommand: migrate
      ? `sh -c ${shellQuote(`${migrate} && exec ${manifest.startCommand}`)}`
      : manifest.startCommand,
    database: { kind: manifest.database.kind },
    requires: {
      websockets: manifest.requires.websockets,
      backgroundWork: manifest.requires.backgroundWork,
    },
  };
}

/**
 * The preview's environment (§9): its branch's connection pairs, under both the
 * port's names and the ADR's `DATABASE_URL_UNPOOLED`; a per-preview auth secret;
 * its own URL; console email; and no Google credentials. The auth secret is
 * DERIVED from the hosting key and the row id — unique per preview, stable across
 * its redeploys so a push does not sign every reviewer out, and never stored.
 */
export function previewEnvironment(input: {
  previewId: string;
  host: string;
  databaseEnv: readonly ReleaseEnvVar[];
  secretKey: string;
}): ReleaseEnvVar[] {
  const direct = input.databaseEnv.find((v) => v.name === 'DIRECT_URL');
  const authSecret = createHmac('sha256', input.secretKey)
    .update(`preview-auth:${input.previewId}`)
    .digest('hex');
  return [
    ...input.databaseEnv,
    ...(direct ? [{ name: 'DATABASE_URL_UNPOOLED', value: direct.value, secret: true }] : []),
    { name: 'BETTER_AUTH_SECRET', value: authSecret, secret: true },
    { name: 'BETTER_AUTH_URL', value: `https://${input.host}`, secret: false },
    { name: 'EMAIL_PROVIDER', value: 'console', secret: false },
    { name: 'NODE_ENV', value: 'production', secret: false },
  ];
}

// ── The service ─────────────────────────────────────────────────────────────

export const previewLifecycleService = {
  /** A `pull_request` delivery: a new head rebuilds, a close tears down. */
  async onPullRequest(body: Record<string, unknown>): Promise<PreviewLifecycleResult> {
    const event = parsePreviewPullRequestEvent(body);
    if (!event) return { outcome: 'ignored' };

    const committed = await withSystemContext(async (tx) => {
      const subject = await subjectForDelivery(event, tx);
      if (!isEnabled(subject)) return { outcome: 'not_enabled' as const };
      const existing = await previewDeploymentRepository.findForPullRequest(
        subject.githubRepo.id,
        event.pullRequestNumber,
        tx,
      );

      if (event.kind === 'closed') {
        if (!existing) return { outcome: 'ignored' as const };
        const closed = await previewDeploymentRepository.transition(
          existing.id,
          LIVE_PREVIEW_STATES,
          'closed',
          {},
          tx,
        );
        return closed
          ? { outcome: 'closed' as const, row: closed }
          : { outcome: 'stale' as const, row: existing };
      }

      if (existing) {
        // A redelivery of the head the row already builds changes nothing.
        if (existing.headSha === event.headSha && existing.state !== 'closed') {
          return { outcome: 'stale' as const, row: existing };
        }
        const moved = await previewDeploymentRepository.transition(
          existing.id,
          ['building', 'starting', 'ready', 'failed', 'closed'],
          'building',
          { headSha: event.headSha, failureReason: null, githubDeploymentId: null },
          tx,
        );
        return { outcome: 'building' as const, row: moved ?? existing };
      }

      const host = await choosePreviewHostName(
        {
          pullRequestNumber: event.pullRequestNumber,
          repositoryName: subject.githubRepo.name,
          repositoryId: subject.id,
          domain: previewDomain(),
        },
        async (candidate) => (await previewDeploymentRepository.findByHost(candidate, tx)) !== null,
      );
      const created = await previewDeploymentRepository.upsertForPullRequest(
        {
          workspaceId: subject.workspaceId,
          repoId: subject.githubRepo.id,
          pullRequestNumber: event.pullRequestNumber,
          headSha: event.headSha,
          host,
        },
        tx,
      );
      return { outcome: 'building' as const, row: created };
    });

    const row = 'row' in committed ? committed.row : undefined;
    if (!row) return { outcome: committed.outcome };
    if (committed.outcome === 'building') {
      await enqueue({
        workspaceId: row.workspaceId,
        previewId: row.id,
        effect: 'announce',
        idempotencyKey: `preview:${row.id}:announce:${row.headSha}`,
      });
    } else if (committed.outcome === 'closed') {
      await enqueue({
        workspaceId: row.workspaceId,
        previewId: row.id,
        effect: 'teardown',
        idempotencyKey: `preview:${row.id}:teardown:${row.updatedAt.toISOString()}`,
      });
    }
    return { outcome: committed.outcome, previewId: row.id };
  },

  /** A completed preview-image run: start the head's release, or record why not. */
  async onImageRun(body: Record<string, unknown>): Promise<PreviewLifecycleResult> {
    const event = parsePreviewImageRunEvent(body);
    if (!event) return { outcome: 'ignored' };

    const committed = await withSystemContext(async (tx) => {
      const subject = await subjectForDelivery(event, tx);
      if (!isEnabled(subject)) return { outcome: 'not_enabled' as const };
      const row = await previewDeploymentRepository.findForPullRequest(
        subject.githubRepo.id,
        event.pullRequestNumber,
        tx,
      );
      if (!row || row.headSha !== event.headSha || row.state !== 'building') {
        return { outcome: 'stale' as const };
      }
      if (event.conclusion === 'success') {
        const moved = await previewDeploymentRepository.transition(
          row.id,
          ['building'],
          'starting',
          {},
          tx,
        );
        return moved ? { outcome: 'starting' as const, row: moved } : { outcome: 'stale' as const };
      }
      const failed = await previewDeploymentRepository.transition(
        row.id,
        ['building'],
        'failed',
        {
          failureReason:
            `The preview image did not build: the "Preview image" workflow ended ` +
            `with "${event.rawConclusion}". Its run log on GitHub says why.`,
        },
        tx,
      );
      return failed ? { outcome: 'failed' as const, row: failed } : { outcome: 'stale' as const };
    });

    const row = 'row' in committed ? committed.row : undefined;
    if (!row) return { outcome: committed.outcome };
    if (committed.outcome === 'starting') {
      await sendEvent('preview/start.requested', {
        workspaceId: row.workspaceId,
        previewId: row.id,
        headSha: row.headSha,
        idempotencyKey: `preview:${row.id}:start:${row.headSha}`,
      });
    } else {
      await enqueue({
        workspaceId: row.workspaceId,
        previewId: row.id,
        effect: 'report_failure',
        idempotencyKey: `preview:${row.id}:failure:${row.headSha}`,
      });
    }
    return { outcome: committed.outcome, previewId: row.id };
  },

  /** Run one enqueued effect against the row as it is NOW. */
  async runEffect(previewId: string, effect: PreviewEffect): Promise<{ status: string }> {
    if (effect === 'teardown') return this.teardown(previewId);
    const read = await readPreview(previewId);
    if (!read?.subject) return { status: 'skipped' };
    const { row, subject } = read;
    if (effect === 'announce') {
      if (row.state !== 'building' || row.githubDeploymentId) return { status: 'skipped' };
      await postStatus(row, subject, ['building'], {
        state: 'in_progress',
        description: 'Building the preview image',
      });
      return { status: 'announced' };
    }
    if (row.state !== 'failed') return { status: 'skipped' };
    await postStatus(row, subject, ['failed'], {
      state: 'failure',
      description: row.failureReason ?? 'The preview could not start.',
    });
    return { status: 'reported' };
  },

  /**
   * Start the head's release: its app, its database branch, the release itself.
   * Acts only on a row still `starting` at `headSha`; records each resource on
   * the row as it is made. A refusal a person can act on (no manifest, a bad
   * field, a target that cannot run the app) settles the row `failed` with it.
   */
  async start(previewId: string, headSha: string): Promise<PreviewStartResult> {
    const read = await readPreview(previewId);
    if (!read || read.row.state !== 'starting' || read.row.headSha !== headSha) {
      return { status: 'skipped' };
    }
    const { row, subject } = read;
    if (!isEnabled(subject)) return { status: 'skipped' };
    const port = getHostingDeployPort(subject.hostingTarget);
    const coordinates = coordinatesOf(subject);
    try {
      const environment = { kind: 'preview' as const, pullRequest: row.pullRequestNumber };
      const app = await port.ensureApp({ repositoryId: subject.id, environment });
      await record(row.id, ['starting'], { flyAppName: app.appRef });

      let databaseEnv: readonly ReleaseEnvVar[] = [];
      if (NEON_PREVIEW_TARGETS.includes(subject.hostingTarget)) {
        const database = await ensurePreviewDatabase(subject.id);
        const created = await createPreviewBranch(database, row.pullRequestNumber);
        await record(row.id, ['starting'], {
          neonProjectId: database.databaseRef,
          neonBranchId: created.branch.branchRef,
        });
        databaseEnv = created.env;
      }

      const manifest = await manifestAt(coordinates, row.headSha);
      const { imageRepository } = await port.ensurePushNamespace({
        repositoryId: subject.id,
        kind: 'preview',
      });
      const handle = await port.deploy({
        appRef: app.appRef,
        environment,
        artifact: { kind: 'image', ref: `${imageRepository}:${row.headSha}` },
        runtime: previewRuntime(manifest),
        env: previewEnvironment({
          previewId: row.id,
          host: row.host,
          databaseEnv,
          secretKey: hostingOriginSecretKey(),
        }),
        idle:
          subject.hostingTarget === 'aws'
            ? { mode: 'always_on' }
            : { mode: 'suspend', idleSeconds: PREVIEW_IDLE_SECONDS },
        ...(subject.hostingTarget === 'aws' ? { shape: 'container' as const } : {}),
      });
      await record(row.id, ['starting'], { flyMachineId: handle.providerRef });
      return { status: 'deployed', handle };
    } catch (error) {
      const reason = `Motir could not start the preview: ${messageOf(error)}`;
      await this.settleStart(previewId, headSha, 'unhealthy', reason);
      return { status: 'failed', reason };
    }
  },

  /** One health read of a started release. */
  async checkStart(handle: ReleaseHandle): Promise<PreviewHealth> {
    const description = await getHostingDeployPort(handle.target).describe(handle);
    if (description.state === 'healthy') return 'healthy';
    if (description.state === 'deploying' || description.state === 'waiting_for_account') {
      return 'pending';
    }
    return 'unhealthy';
  },

  /**
   * Settle a start: `ready` + `success` at the preview's URL, or `failed` +
   * `failure` with a reason. A release that failed its health check is LEFT in
   * place — the port has no stop, and a suspended preview costs nothing — so its
   * logs can be read; closing the pull request, or the next head, replaces it.
   */
  async settleStart(
    previewId: string,
    headSha: string,
    health: 'healthy' | 'unhealthy' | 'timed_out',
    reason?: string,
  ): Promise<{ status: 'ready' | 'failed' | 'skipped' }> {
    const read = await readPreview(previewId);
    if (!read || read.row.headSha !== headSha) return { status: 'skipped' };
    if (health === 'healthy') {
      const ready = await commitTransition(previewId, ['starting'], 'ready');
      if (!ready || !read.subject) return { status: ready ? 'ready' : 'skipped' };
      await postStatus(ready, read.subject, ['ready'], {
        state: 'success',
        environmentUrl: `https://${ready.host}`,
        description: 'The preview is ready',
      });
      return { status: 'ready' };
    }
    const failureReason =
      reason ??
      (health === 'timed_out'
        ? `The preview did not pass its health check within ${
            (PREVIEW_START_POLLS * PREVIEW_START_POLL_MS) / 60_000
          } minutes.`
        : 'The preview started but failed its health check.');
    const failed = await commitTransition(previewId, ['starting'], 'failed', { failureReason });
    if (!failed || !read.subject) return { status: failed ? 'failed' : 'skipped' };
    await postStatus(failed, read.subject, ['failed'], {
      state: 'failure',
      description: failureReason,
    });
    return { status: 'failed' };
  },

  /**
   * Tear a `closed` row's resources down: the app (with its usage), the database
   * branch, then `inactive` on GitHub. Each name is cleared as its resource goes,
   * so a crash part-way leaves exactly what is left for the reaper.
   */
  async teardown(previewId: string): Promise<PreviewTeardownResult> {
    const read = await readPreview(previewId);
    if (!read || read.row.state !== 'closed') return { status: 'skipped', usage: [] };
    const { row, subject } = read;
    // A repository no longer listed in any project, or with no target: nothing
    // here can name the port its app lives on.
    if (!subject?.hostingTarget) return { status: 'unresolvable', usage: [] };
    let usage: ReleaseUsage[] = [];
    if (row.flyAppName) {
      usage = await getHostingDeployPort(subject.hostingTarget).destroyApp({
        appRef: row.flyAppName,
      });
      await record(row.id, ['closed'], { flyAppName: null, flyMachineId: null });
    }
    if (row.neonBranchId && row.neonProjectId) {
      await deletePreviewBranch({
        database: {
          provider: 'neon',
          applicationRef: previewDatabaseApplicationRef(subject.id),
          databaseRef: row.neonProjectId,
        },
        branchRef: row.neonBranchId,
        name: previewBranchName(row.pullRequestNumber),
      });
      await record(row.id, ['closed'], { neonBranchId: null });
    }
    if (row.githubDeploymentId) {
      // Cosmetic once the resources are gone, and impossible once the repository
      // has left Motir's org: logged, never a reason to keep the row unfinished.
      await postStatus(row, subject, ['closed'], {
        state: 'inactive',
        description: 'The pull request is closed; its preview is gone',
      }).catch((error: unknown) => {
        console.warn('[previewLifecycle] inactive status not posted', {
          previewId,
          error: messageOf(error),
        });
      });
    }
    return { status: 'torn_down', usage };
  },

  /**
   * The takeover's step, AFTER enablement's `disable` and before the transfer:
   * close and tear down every preview of the repository, then destroy its preview
   * image app (Fly) and its Neon preview project. `pushNamespace` is read by the
   * saga before `disable` clears it.
   */
  async teardownRepository(
    projectRepoId: string,
    input: { pushNamespace: string | null },
  ): Promise<PreviewRepositoryTeardownResult> {
    const found = await withSystemContext(async (tx) => {
      const found = await projectRepoRepository.findPreviewLifecycleSubjectInTx(projectRepoId, tx);
      if (!found?.githubRepo) return null;
      const subject = found as Subject;
      const live = await previewDeploymentRepository.listOpenForRepo(subject.githubRepo.id, tx);
      const closed: PreviewDeployment[] = [];
      for (const row of live) {
        const moved = await previewDeploymentRepository.transition(
          row.id,
          LIVE_PREVIEW_STATES,
          'closed',
          {},
          tx,
        );
        if (moved) closed.push(moved);
      }
      const unfinished = await previewDeploymentRepository.listUnfinishedTeardowns(tx, {
        repoId: subject.githubRepo.id,
      });
      return { subject, closed: closed.length, ids: unfinished.map((r) => r.id) };
    });
    if (!found) return { closed: 0, usage: [] };

    const usage: ReleaseUsage[] = [];
    for (const id of found.ids) usage.push(...(await this.teardown(id)).usage);

    const { subject } = found;
    if (subject.hostingTarget === 'fly' && input.pushNamespace) {
      usage.push(
        ...(await getHostingDeployPort('fly').destroyApp({ appRef: input.pushNamespace })),
      );
    }
    if (subject.hostingTarget && NEON_PREVIEW_TARGETS.includes(subject.hostingTarget)) {
      // Created at enablement; the create is idempotent, so this finds it.
      await deletePreviewDatabase(await ensurePreviewDatabase(subject.id));
    }
    return { closed: found.closed, usage };
  },

  /**
   * The reaper: finish every teardown a crash interrupted; for every live row
   * untouched for an hour, close it when its repository's previews are off or
   * its pull request is no longer open on GitHub, re-announce it when its
   * deployment was never created, and fail it when its start was abandoned.
   */
  async reap(input: { now?: () => Date } = {}): Promise<PreviewReapResult> {
    const now = (input.now ?? (() => new Date()))();
    const counts = { teardownsFinished: 0, closed: 0, announced: 0, startsAbandoned: 0, failed: 0 };

    const scan = await withSystemContext(async (tx) => ({
      unfinished: await previewDeploymentRepository.listUnfinishedTeardowns(tx),
      stale: await previewDeploymentRepository.listStale(
        new Date(now.getTime() - PREVIEW_REAP_RECHECK_MS),
        tx,
      ),
    }));

    for (const row of scan.unfinished) {
      try {
        const result = await this.teardown(row.id);
        if (result.status === 'torn_down') counts.teardownsFinished += 1;
      } catch (error) {
        counts.failed += 1;
        console.warn('[previewLifecycle] reaper teardown failed', {
          previewId: row.id,
          error: messageOf(error),
        });
      }
    }

    for (const row of scan.stale) {
      try {
        const read = await readPreview(row.id);
        if (!read) continue;
        const { subject } = read;
        const open = isEnabled(subject)
          ? await previewDeploymentsClient.isPullRequestOpen(
              coordinatesOf(subject),
              row.pullRequestNumber,
            )
          : false;
        if (!open) {
          const closed = await commitTransition(row.id, LIVE_PREVIEW_STATES, 'closed');
          if (closed) {
            counts.closed += 1;
            await this.teardown(row.id);
          }
          continue;
        }
        if (row.state === 'building' && !row.githubDeploymentId) {
          const result = await this.runEffect(row.id, 'announce');
          if (result.status === 'announced') counts.announced += 1;
        } else if (row.state === 'starting') {
          // An hour untouched is far past the start job's own bound: abandoned.
          const settled = await this.settleStart(row.id, row.headSha, 'timed_out');
          if (settled.status === 'failed') counts.startsAbandoned += 1;
        } else {
          // Checked and still open: move it to the back of the scan, so a
          // long-lived preview does not hold the scan's first rows forever.
          await withSystemContext((tx) => previewDeploymentRepository.touch(row.id, row.state, tx));
        }
      } catch (error) {
        counts.failed += 1;
        console.warn('[previewLifecycle] reaper pass failed for a preview', {
          previewId: row.id,
          error: messageOf(error),
        });
      }
    }
    return counts;
  },
};
