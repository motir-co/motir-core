import 'server-only';

import { listImageTags, readImageCreated, readImageLabels } from '@motir/orchestrator';
import { catalogRegistry, compareVersions } from '@/lib/agentInstances/imageCatalog';
import { SANDBOX_IMAGE_REPOSITORY } from '@/lib/agentInstances/profiles';
import {
  imageRepositoryOf,
  imageRevisionFromLabels,
  RUNNER_IMAGE_SOURCE_REPO,
} from '@/lib/ciFleet/runnerImageSources';
import type {
  FleetImageBuildDTO,
  FleetImageKey,
  FleetImageNotReadDTO,
  FleetImagePublishDTO,
  FleetImagePublishOutcomeDTO,
  FleetImageReadSource,
  FleetPublishBlock,
  FleetPublishProgressDTO,
  FleetPublishRecordDTO,
  FleetPublishTargetDTO,
  HostedImageRowDTO,
  RunnerImageRowDTO,
  SandboxImageRowDTO,
  SandboxProfileTagDTO,
} from '@/lib/dto/fleetStatusImages';
import { FLEET_IMAGE_KEYS } from '@/lib/dto/fleetStatusImages';
import type { RunnerImageUnreleasedChangeDTO } from '@/lib/dto/runnerImageFreshness';
import {
  publishWorkflowsClient,
  PublishWorkflowError,
  type PublishWorkflowRun,
} from '@/lib/github/publishWorkflows';
import { repoCommitHistoryClient, RepoCommitHistoryError } from '@/lib/github/repoCommitHistory';
import {
  configuredFleetRunnerImage,
  HOSTED_AGENT_IMAGE_ENV_VAR,
  hostedAgentImage,
  isHostedAgentConfigured,
  selectedOrchestratorProvider,
} from '@/lib/orchestrator';
import { requirePlatformStaff, type PlatformPrincipal } from '@/lib/platform/auth';
import { withPlatformRead, withPlatformWrite } from '@/lib/platform/context';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import { platformAuditLogRepository } from '@/lib/repositories/platformAuditLogRepository';
import {
  runnerImageFreshnessProbeService,
  sourceRepoToken,
} from '@/lib/services/runnerImageFreshnessProbeService';
import { withSystemContext } from '@/lib/workspaces/context';

// THE FLEET STATUS PAGE'S IMAGES SECTION (MOTIR-10886; design MOTIR-10885). For
// each image Motir boots: is production on the newest one, and — when it is not —
// Publish latest, which only ever STARTS that image's own publish workflow. The
// page writes no secret and calls no deploy API.
//
// THE THREE ROWS, each read on its own and never thrown out of:
//
//   - HOSTED AGENT: the pinned `MOTIR_HOSTED_AGENT_IMAGE` digest against the
//     lane's `:main` tag (the newest main build, MOTIR-10882), each with its
//     `org.opencontainers.image.revision` and build time, and the
//     `packages/cli` commits between the two.
//   - RUNNER: the pinned `MOTIR_RUNNER_IMAGE` against the newest `x.y.z` tag
//     the release lane pushed (`runner-v*`, MOTIR-10883). The unreleased
//     `infra/ci-runner` changes and the AMI are `runnerImageFreshnessProbeService`'s,
//     not a second probe; the changes the newest release already contains are
//     left out, because those are a publish, not a release, away.
//   - SANDBOX: the newest `cli-v*` tag against `base` and every profile of the CI
//     matrix having its `<profile>-<version>` tag, read through the published-
//     image catalog's registry, and how many live agents run an older version.
//
// PUBLISH LATEST dispatches the image's workflow with the target the row reads
// (`workflow_dispatch` inputs added by this card): the two pins open their pin
// pull request and queue it to merge, and the deploy rolls web and worker onto
// it; the sandbox re-runs its release tag, which pushes only the missing tags
// (MOTIR-10884). The audit row is written in the transaction that dispatches, so
// a refused dispatch writes none.

const MOTIR_CORE = RUNNER_IMAGE_SOURCE_REPO;
const DAY_MS = 24 * 60 * 60 * 1000;
const RUNNER_REPOSITORY = 'ghcr.io/motir-co/motir-ci-runner';
const RELEASE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const CLI_TAG = /^cli-v(\d+\.\d+\.\d+)$/;
/** The script whose `plan` makes a re-run of a release push only its gap
 *  (MOTIR-10884). A release cut before it would push every tag again. */
const RELEASE_SET_SCRIPT = 'packages/cli/sandbox/smoke/release-set.mjs';
/** How many release tags are read looking for the bytes the pin names. */
const MAX_VERSION_READS = 15;
/** A done band stays this long after the run ended. */
const DONE_BAND_MS = DAY_MS;
/** After a successful pin run, the merge and the deploy are this long "publishing". */
const ROLL_WINDOW_MS = 6 * 60 * 60 * 1000;

/** The workflow each image's Publish latest dispatches. */
export const PUBLISH_WORKFLOWS: Record<FleetImageKey, string> = {
  hosted: 'hosted-agent-image.yml',
  runner: 'release-runner-image.yml',
  sandbox: 'release-sandbox.yml',
};

/** The reason written on a `fleet.image.publish` row: the confirm dialog has no
 *  reason field (approved design MOTIR-10885). */
export const PUBLISH_REASON = 'Publish latest pressed on /admin/fleet-status';

/** `fleet.image.publish`'s target id for an image. */
const targetIdFor = (image: FleetImageKey) => `fleet_image.${image}`;

/** The sandbox images every release publishes: `base`, then the CI matrix's
 *  profiles in `packages/cli/sandbox/smoke/profiles.json`'s order. Written out
 *  because that file sits outside the lib project; `fleetStatusImagesService.test.ts`
 *  holds the two equal. */
export const SANDBOX_IMAGE_IDS: readonly string[] = [
  'base',
  'claude',
  'codex',
  'opencode',
  'kimi',
  'antigravity',
  'cursor',
  'aider',
  'goose',
];

const notRead = (source: FleetImageReadSource, detail: string): FleetImageNotReadDTO => ({
  status: 'not_read',
  source,
  detail,
});

/** A read the row cannot do without — its failure is the row's `not_read`. */
class RowReadError extends Error {
  constructor(
    readonly source: FleetImageReadSource,
    detail: string,
  ) {
    super(detail);
  }
}

function digestOf(reference: string): string | null {
  const at = reference.lastIndexOf('@');
  return at >= 0 ? reference.slice(at + 1) : null;
}

function wholeDays(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / DAY_MS)) : null;
}

const compareUrl = (base: string, head: string) =>
  `https://github.com/${MOTIR_CORE.owner}/${MOTIR_CORE.name}/compare/${base}...${head}`;

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : '');

/** The GitHub calls of one read; a refusal is the row's `not_read` GitHub. */
async function github<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof PublishWorkflowError || err instanceof RepoCommitHistoryError) {
      throw new RowReadError('github', err.message);
    }
    throw err;
  }
}

/** Every read of a row, with its own failures turned into `not_read`. */
async function settleRow<T>(read: () => Promise<T>): Promise<T | FleetImageNotReadDTO> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof RowReadError) return notRead(err.source, err.message);
    throw err;
  }
}

async function imageBuild(reference: string): Promise<FleetImageBuildDTO> {
  const [created, labels] = await Promise.all([
    readImageCreated(reference),
    readImageLabels(reference),
  ]);
  if (!created.ok)
    throw new RowReadError('ghcr', `${reference}: ${created.reason}: ${created.detail}`);
  if (!labels.ok)
    throw new RowReadError('ghcr', `${reference}: ${labels.reason}: ${labels.detail}`);
  return {
    digest: created.digest,
    commit: imageRevisionFromLabels(labels.labels),
    createdAt: created.createdAt,
  };
}

/**
 * Where an image's newest press stands. Anything the run read cannot say is
 * `idle`: the Audit line still names the press.
 */
async function progressOf(
  image: FleetImageKey,
  record: FleetPublishRecordDTO | null,
  landed: (target: string) => boolean,
  token: string | null,
  now: number,
): Promise<FleetPublishProgressDTO> {
  if (!record?.runId) return { state: 'idle' };
  let run: PublishWorkflowRun;
  try {
    run = await publishWorkflowsClient.run(MOTIR_CORE, record.runId, token);
  } catch (err) {
    if (err instanceof PublishWorkflowError) return { state: 'idle' };
    throw err;
  }
  if (run.status !== 'completed') return { state: 'running', startedAt: record.at };
  const endedAt = run.updatedAt || record.at;
  const age = now - Date.parse(endedAt);
  const reached = landed(record.target);
  if (run.conclusion === 'success') {
    if (reached) return age <= DONE_BAND_MS ? { state: 'done', endedAt } : { state: 'idle' };
    // A pin run has opened and queued its pull request; the pin moves when it
    // merges and the deploy rolls. The sandbox run IS the publish.
    return image !== 'sandbox' && age <= ROLL_WINDOW_MS
      ? { state: 'running', startedAt: record.at }
      : { state: 'idle' };
  }
  if (reached) return { state: 'idle' };
  const error = await publishWorkflowsClient
    .failureDetail(MOTIR_CORE, run.id, token)
    .catch(() => null);
  return { state: 'failed', endedAt, error };
}

async function publishHalf(
  image: FleetImageKey,
  record: FleetPublishRecordDTO | null,
  target: FleetPublishTargetDTO | null,
  idleBlock: FleetPublishBlock | null,
  landed: (target: string) => boolean,
  token: string | null,
  now: number,
): Promise<FleetImagePublishDTO> {
  const active = await github(() =>
    publishWorkflowsClient.activeRuns(MOTIR_CORE, PUBLISH_WORKFLOWS[image], token),
  );
  const progress = await progressOf(image, record, landed, token, now);
  const running = active.length > 0 || progress.state === 'running';
  return {
    record,
    progress,
    activeRun: active.length > 0,
    target,
    blocked: target === null ? idleBlock : running ? 'running' : null,
  };
}

function toRecord(row: {
  createdAt: Date;
  metadata: unknown;
  actor: { email: string } | null;
}): FleetPublishRecordDTO {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof meta[k] === 'string' ? (meta[k] as string) : '');
  const num = (k: string) => (typeof meta[k] === 'number' ? (meta[k] as number) : null);
  return {
    actorEmail: row.actor?.email ?? null,
    at: row.createdAt.toISOString(),
    from: str('from'),
    to: str('to'),
    target: str('target'),
    runId: num('runId'),
    runUrl: str('runUrl') || null,
    runNumber: num('runNumber'),
  };
}

export type FleetPublishRecords = Record<FleetImageKey, FleetPublishRecordDTO | null>;

export const fleetStatusImagesService = {
  /**
   * The newest `fleet.image.publish` row of each image — one audited read
   * (`fleet.status.read`) for the whole page.
   *
   * @throws NotPlatformStaffError below `superadmin`.
   */
  async publishRecords(principal: PlatformPrincipal): Promise<FleetPublishRecords> {
    await requirePlatformStaff('superadmin');
    return withPlatformRead(
      principal,
      { action: 'fleet.status.read', targetKind: 'platform', targetId: 'fleet_image' },
      async (tx) => {
        const out = {} as FleetPublishRecords;
        for (const image of FLEET_IMAGE_KEYS) {
          const row = await platformAuditLogRepository.findLatestByTargetAndAction(
            'platform',
            targetIdFor(image),
            'fleet.image.publish',
            tx,
          );
          out[image] = row ? toRecord(row) : null;
        }
        return out;
      },
    );
  },

  /** The hosted-agent row. Never throws on a source that did not answer. */
  async readHosted(
    record: FleetPublishRecordDTO | null,
    now: Date = new Date(),
  ): Promise<HostedImageRowDTO> {
    await requirePlatformStaff('superadmin');
    if (selectedOrchestratorProvider() === 'fake' || !isHostedAgentConfigured()) {
      return { status: 'unset', variable: HOSTED_AGENT_IMAGE_ENV_VAR };
    }
    let pinnedRef: string;
    try {
      pinnedRef = hostedAgentImage('aws');
    } catch {
      return { status: 'unset', variable: HOSTED_AGENT_IMAGE_ENV_VAR };
    }
    return settleRow(async () => {
      const token = await sourceRepoToken(MOTIR_CORE.owner);
      const repository = imageRepositoryOf(pinnedRef);
      const pinnedDigest = digestOf(pinnedRef);
      const [pinned, newest] = await Promise.all([
        imageBuild(pinnedRef),
        imageBuild(`${repository}:main`),
      ]);
      pinned.digest = pinnedDigest;
      if (!newest.digest) throw new RowReadError('ghcr', 'the registry named no digest for :main');
      const behind = newest.digest !== pinnedDigest;
      let cliCommits: number | null = null;
      if (behind && pinned.commit && newest.commit) {
        const [base, head] = [pinned.commit, newest.commit];
        cliCommits = await github(() =>
          publishWorkflowsClient.countPathCommits(MOTIR_CORE, base, head, 'packages/cli', token),
        );
      }
      const target: FleetPublishTargetDTO | null = behind
        ? {
            workflow: PUBLISH_WORKFLOWS.hosted,
            ref: 'main',
            inputs: { digest: newest.digest, source_commit: newest.commit ?? '' },
            from: `${pinnedDigest ?? ''}${pinned.commit ? ` (${short(pinned.commit)})` : ''}`,
            to: `${newest.digest}${newest.commit ? ` (${short(newest.commit)})` : ''}`,
            target: newest.digest,
          }
        : null;
      const landed = (digest: string) => digest === pinnedDigest;
      return {
        status: 'read' as const,
        pinned,
        newest,
        behind,
        daysBehind: behind ? wholeDays(pinned.createdAt, newest.createdAt) : null,
        cliCommits,
        compareUrl:
          behind && pinned.commit && newest.commit
            ? compareUrl(pinned.commit, newest.commit)
            : null,
        publish: await publishHalf(
          'hosted',
          record,
          target,
          'up_to_date',
          landed,
          token,
          now.getTime(),
        ),
      };
    });
  },

  /** The CI runner row. Never throws on a source that did not answer. */
  async readRunner(
    record: FleetPublishRecordDTO | null,
    now: Date = new Date(),
  ): Promise<RunnerImageRowDTO> {
    await requirePlatformStaff('superadmin');
    const probe = await runnerImageFreshnessProbeService.check({ now });
    const pinnedRef = configuredFleetRunnerImage();
    if (probe.verdict === 'not_applicable' || !pinnedRef) {
      return { status: 'unset', variable: 'MOTIR_RUNNER_IMAGE' };
    }
    if (probe.verdict === 'indeterminate') {
      return notRead(probe.phase === 'github' ? 'github' : 'ghcr', probe.detail);
    }
    return settleRow(async () => {
      const token = await sourceRepoToken(MOTIR_CORE.owner);
      const listing = await listImageTags(RUNNER_REPOSITORY);
      if (!listing.ok) {
        throw new RowReadError(
          'ghcr',
          `${RUNNER_REPOSITORY}: ${listing.reason}: ${listing.detail}`,
        );
      }
      const versions = listing.tags
        .filter((t) => RELEASE_VERSION.test(t))
        .sort((a, b) => compareVersions(b, a));
      const newestVersion = versions[0];
      if (!newestVersion) throw new RowReadError('ghcr', `${RUNNER_REPOSITORY} has no release tag`);
      const [newestBuild, pinnedCreated] = await Promise.all([
        imageBuild(`${RUNNER_REPOSITORY}:${newestVersion}`),
        readImageCreated(pinnedRef),
      ]);
      if (!pinnedCreated.ok) {
        throw new RowReadError(
          'ghcr',
          `${pinnedRef}: ${pinnedCreated.reason}: ${pinnedCreated.detail}`,
        );
      }
      const pinnedDigest = digestOf(pinnedRef) ?? pinnedCreated.digest;
      const behind = newestBuild.digest !== pinnedDigest;

      // The release the pinned bytes were published as: the newest first.
      let pinnedVersion: string | null = behind ? null : newestVersion;
      if (behind) {
        for (const version of versions.slice(1, 1 + MAX_VERSION_READS)) {
          const read = await readImageCreated(`${RUNNER_REPOSITORY}:${version}`);
          if (read.ok && read.digest === pinnedDigest) {
            pinnedVersion = version;
            break;
          }
        }
      }
      const pinned = {
        digest: pinnedDigest,
        commit: probe.build.commit,
        createdAt: pinnedCreated.createdAt,
        version: pinnedVersion,
      };
      const newest = { ...newestBuild, version: newestVersion };

      let runnerCommits: number | null = null;
      if (behind && newest.commit) {
        const head = newest.commit;
        runnerCommits = await github(() =>
          publishWorkflowsClient.countPathCommits(
            MOTIR_CORE,
            pinned.commit,
            head,
            'infra/ci-runner',
            token,
          ),
        );
      }
      // Merged changes the NEWEST release lacks: a release away, not a publish.
      let unreleased: RunnerImageUnreleasedChangeDTO[] =
        probe.verdict === 'stale' ? probe.unreleased : [];
      if (behind && newest.commit && unreleased.length > 0) {
        const releaseCommit = newest.commit;
        const kept: RunnerImageUnreleasedChangeDTO[] = [];
        for (const change of unreleased) {
          const relation = await github(() =>
            repoCommitHistoryClient.relation(MOTIR_CORE, releaseCommit, change.commit, token),
          );
          if (relation === 'ahead' || relation === 'diverged') kept.push(change);
        }
        unreleased = kept;
      }
      const [major, minor, patch] = RELEASE_VERSION.exec(newestVersion)!.slice(1).map(Number);
      const target: FleetPublishTargetDTO | null = behind
        ? {
            workflow: PUBLISH_WORKFLOWS.runner,
            ref: 'main',
            inputs: { pin_digest: newest.digest ?? '', pin_version: newestVersion },
            from: pinnedVersion ? `runner-v${pinnedVersion} (${pinnedDigest})` : `${pinnedDigest}`,
            to: `runner-v${newestVersion} (${newest.digest ?? ''})`,
            target: newest.digest ?? '',
          }
        : null;
      const landed = (digest: string) => digest === pinnedDigest;
      return {
        status: 'read' as const,
        pinned,
        newest,
        behind,
        releasesBetween:
          behind && pinnedVersion
            ? versions
                .filter((v) => compareVersions(v, pinnedVersion) > 0)
                .reverse()
                .map((v) => `runner-v${v}`)
            : behind
              ? null
              : [],
        daysBehind: behind ? wholeDays(pinned.createdAt, newest.createdAt) : null,
        runnerCommits,
        compareUrl: !behind
          ? null
          : pinnedVersion
            ? compareUrl(`runner-v${pinnedVersion}`, `runner-v${newestVersion}`)
            : newest.commit
              ? compareUrl(pinned.commit, newest.commit)
              : null,
        unreleased,
        nextTag: `runner-v${major}.${minor}.${patch! + 1}`,
        ami: probe.ami,
        publish: await publishHalf(
          'runner',
          record,
          target,
          unreleased.length > 0 ? 'release_needed' : 'up_to_date',
          landed,
          token,
          now.getTime(),
        ),
      };
    });
  },

  /** The agent-instance (sandbox) row. Never throws on a source that did not answer. */
  async readSandbox(
    record: FleetPublishRecordDTO | null,
    now: Date = new Date(),
  ): Promise<SandboxImageRowDTO> {
    await requirePlatformStaff('superadmin');
    return settleRow(async () => {
      const token = await sourceRepoToken(MOTIR_CORE.owner);
      const tags = await github(() =>
        publishWorkflowsClient.tagsWithPrefix(MOTIR_CORE, 'cli-v', token),
      );
      const releases = tags
        .map((t) => ({ ...t, version: CLI_TAG.exec(t.name)?.[1] ?? null }))
        .filter((t): t is typeof t & { version: string } => t.version !== null)
        .sort((a, b) => compareVersions(b.version, a.version));
      const newest = releases[0];
      if (!newest) throw new RowReadError('github', 'no cli-v* release tag');
      const commit = await github(() =>
        publishWorkflowsClient.peel(MOTIR_CORE, newest.commit, token),
      );
      const committedAt = await github(() =>
        publishWorkflowsClient.commitDate(MOTIR_CORE, commit, token),
      );

      const registryTags = await catalogRegistry().listTags(SANDBOX_IMAGE_REPOSITORY);
      if (!registryTags) {
        throw new RowReadError('ghcr', `${SANDBOX_IMAGE_REPOSITORY}'s tags could not be read`);
      }
      const present = new Set(registryTags);
      const profiles: SandboxProfileTagDTO[] = SANDBOX_IMAGE_IDS.map((id) => {
        const tag = `${id}-${newest.version}`;
        return { id, tag, published: present.has(tag) };
      });
      const missing = profiles.filter((p) => !p.published);
      let previous: string | null = null;
      for (const p of missing) {
        const prefix = `${p.id}-`;
        for (const tag of registryTags) {
          if (!tag.startsWith(prefix)) continue;
          const version = tag.slice(prefix.length);
          if (!RELEASE_VERSION.test(version) || compareVersions(version, newest.version) >= 0)
            continue;
          if (previous === null || compareVersions(version, previous) > 0) previous = version;
        }
      }

      const byVersion = await withSystemContext((tx) =>
        agentInstanceRepository.countLiveByImageVersion(tx),
      );
      const liveOlder = byVersion
        .filter((row) => row.imageVersion !== null && RELEASE_VERSION.test(row.imageVersion))
        .filter((row) => compareVersions(row.imageVersion!, newest.version) < 0)
        .reduce((sum, row) => sum + row.count, 0);

      const republishable =
        missing.length > 0 &&
        (await github(() =>
          publishWorkflowsClient.pathExists(MOTIR_CORE, RELEASE_SET_SCRIPT, newest.name, token),
        ));
      const total = profiles.length;
      const target: FleetPublishTargetDTO | null =
        missing.length > 0 && republishable
          ? {
              workflow: PUBLISH_WORKFLOWS.sandbox,
              ref: newest.name,
              inputs: { dry_run: 'false' },
              from: `${newest.name}: ${total - missing.length} of ${total} tags`,
              to: `${newest.name}: ${total} of ${total} tags`,
              target: newest.version,
            }
          : null;
      const landed = (version: string) => version === newest.version && missing.length === 0;
      return {
        status: 'read' as const,
        release: { tag: newest.name, version: newest.version, commit, committedAt },
        profiles,
        previous,
        liveOlder,
        republishable,
        publish: await publishHalf(
          'sandbox',
          record,
          target,
          missing.length > 0 ? 'not_republishable' : 'up_to_date',
          landed,
          token,
          now.getTime(),
        ),
      };
    });
  },

  /**
   * PUBLISH LATEST for one image. The row is read again here, never trusted
   * from the page: refused when it is not behind, when a run of its workflow is
   * already going, or when it cannot be read. The dispatch and its
   * `fleet.image.publish` row are one transaction, so a refused dispatch is
   * recorded nowhere and a recorded press always names its run.
   *
   * @throws NotPlatformStaffError below `superadmin`.
   */
  async publish(
    principal: PlatformPrincipal,
    image: FleetImageKey,
  ): Promise<FleetImagePublishOutcomeDTO> {
    await requirePlatformStaff('superadmin');
    // The newest press too: a pin run that succeeded is still publishing until
    // its pull request merges and the deploy rolls, and a second press then is
    // refused like one during the run.
    const records = await this.publishRecords(principal);
    const record = records[image];
    const row =
      image === 'hosted'
        ? await this.readHosted(record)
        : image === 'runner'
          ? await this.readRunner(record)
          : await this.readSandbox(record);
    if (row.status !== 'read') return { outcome: 'refused', reason: row.status };
    const { target, blocked } = row.publish;
    if (!target || blocked) return { outcome: 'refused', reason: blocked ?? 'up_to_date' };

    const token = await sourceRepoToken(MOTIR_CORE.owner);
    if (!token) {
      return {
        outcome: 'failed',
        detail: `this deployment has no GitHub App installation on ${MOTIR_CORE.owner} to start the workflow with`,
      };
    }
    try {
      const run = await withPlatformWrite(principal, async (_tx, record) => {
        const started = await publishWorkflowsClient.dispatch(
          MOTIR_CORE,
          target.workflow,
          target.ref,
          target.inputs,
          token,
        );
        await record({
          action: 'fleet.image.publish',
          targetKind: 'platform',
          targetId: targetIdFor(image),
          targetLabel: image,
          reason: PUBLISH_REASON,
          metadata: {
            image,
            workflow: target.workflow,
            ref: target.ref,
            from: target.from,
            to: target.to,
            target: target.target,
            runId: started.id,
            runUrl: started.htmlUrl,
            runNumber: started.runNumber,
          },
        });
        return started;
      });
      return { outcome: 'dispatched', runUrl: run.htmlUrl, runNumber: run.runNumber };
    } catch (err) {
      if (err instanceof PublishWorkflowError) return { outcome: 'failed', detail: err.message };
      throw err;
    }
  },

  /**
   * Whether the run a press started has ENDED for the page: the run finished
   * and — for a successful pin run — this deployment now pins the target. The
   * page polls it while a row is publishing and reads the rows again once true.
   * The pin is this process's own environment, so the answer turns true on the
   * first poll served by the rolled deploy.
   */
  async publishEnded(image: FleetImageKey, runId: number, target: string): Promise<boolean> {
    await requirePlatformStaff('superadmin');
    const token = await sourceRepoToken(MOTIR_CORE.owner);
    let run: PublishWorkflowRun;
    try {
      run = await publishWorkflowsClient.run(MOTIR_CORE, runId, token);
    } catch (err) {
      if (err instanceof PublishWorkflowError) return false;
      throw err;
    }
    if (run.status !== 'completed') return false;
    if (run.conclusion !== 'success' || image === 'sandbox') return true;
    const pinned = image === 'runner' ? configuredFleetRunnerImage() : safeHostedPin();
    return pinned !== null && digestOf(pinned) === target;
  },
};

function safeHostedPin(): string | null {
  try {
    return hostedAgentImage('aws');
  } catch {
    return null;
  }
}
