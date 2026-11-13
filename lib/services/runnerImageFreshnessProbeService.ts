import { Ec2ApiError, listImageTags, readImageLabels } from '@motir/orchestrator';
import {
  evictInstallationToken,
  GithubAppNotConfiguredError,
  GithubAppTokenError,
  isGithubAppConfigured,
  mintInstallationToken,
} from '@/lib/github/appAuth';
import { getOrgInstallation, OrgInstallationReadError } from '@/lib/github/orgInstallation';
import {
  repoCommitHistoryClient,
  RepoCommitHistoryError,
  type RepoRef,
} from '@/lib/github/repoCommitHistory';
import {
  amiBuildCommitFrom,
  commitFromShaTag,
  imageRepositoryOf,
  imageRevisionFromLabels,
  RUNNER_AMI_INPUTS,
  RUNNER_IMAGE_INPUTS,
  RUNNER_IMAGE_SOURCE_REPO,
} from '@/lib/ciFleet/runnerImageSources';
import type { FleetShardDTO } from '@/lib/dto/fleetShard';
import { toFleetShardDTO } from '@/lib/mappers/fleetShardMappers';
import {
  AWS_RUNNER_AMI_ENV_VAR,
  configuredFleetRunnerImage,
  describeAwsImages,
  OrchestratorNotConfiguredError,
} from '@/lib/orchestrator';
import { fleetShardRepository } from '@/lib/repositories/fleetShardRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import type {
  RunnerAmiBuildDTO,
  RunnerAmiFreshnessDTO,
  RunnerImageBuildDTO,
  RunnerImageFreshnessVerdictDTO,
  RunnerImageUnreleasedChangeDTO,
} from '@/lib/dto/runnerImageFreshness';

// THE RUNNER-IMAGE FRESHNESS PROBE (MOTIR-10393) — a probe of
// `system.daily-health-check` that fails when a change to the runner image has
// merged but the image `MOTIR_RUNNER_IMAGE` pins was built before it.
//
// The release lane has no push-to-main trigger on purpose, and the pin moves
// only when a person moves it; neither changes here. What was missing is the
// NOTICE: MOTIR-10293's and MOTIR-10290's image changes merged, nobody tagged a
// release, and the fleet kept booting the image from two weeks before.
//
// THE QUESTION, AND WHY IT IS ASKED THIS WAY. For each file the image is built
// from (`RUNNER_IMAGE_INPUTS`), take the newest default-branch commit that
// touched it, and ask GitHub how it relates to the commit the pinned image was
// built from. Contained (`behind` / `identical`) is current; anything else is a
// change the image lacks. A commit that touches no input never becomes that
// newest commit, so it cannot fail the step — a date comparison could not say
// that, and would also misread a release cut from a branch.
//
// THE BUILD COMMIT. A release from this card on stamps the standard
// `org.opencontainers.image.revision` label. An image released before that
// carries none, but every release has always pushed a `sha-<commit>` tag beside
// its version (`runner-image.yml`), so the probe finds the `sha-` tag whose
// bytes are the pinned image's. Neither found is "could not tell", not a pass.
//
// THE AMI (MOTIR-10395). The AWS fleet boots `MOTIR_AWS_RUNNER_AMI_ID`, built
// from `RUNNER_AMI_INPUTS` by its own lane (`ci-runner-ami-v*`), and it is
// judged by the same rule. The build commit is read through the
// `motir-fleet-runner` role of an active aws `ci_runner` account, the
// deployment's only identity there, with `ec2:DescribeImages`. The AMI's
// `GitSha` tag cannot be used: EC2 shows a shared AMI's tags only in the
// account that owns it. Its description carries the full commit (an AMI built
// since this card) and its name the first seven characters (any AMI).
//
// ⚠️ `indeterminate` IS RECORDED, NOT THROWN — the file's rule for every probe:
// a registry or GitHub that did not answer is a statement about the read, and a
// health check that pages on someone else's uptime is one somebody silences.
// It is never `current`, and it is on the job_run row with the read it failed.

/** The registry tags read before the probe gives up looking for the pinned bytes. */
const MAX_SHA_TAGS = 60;

/** An installation token for the source repository's owner when this deployment
 *  has the provisioning App there, else null — the repository is public, and an
 *  anonymous read answers the same question. Also used by the runner-version
 *  support probe (MOTIR-10706), which reads the same repository.
 *
 *  `fresh: true` drops the cached token for that installation first, so the
 *  answer is newly minted and carries the installation's permissions as they
 *  are NOW: a cached token keeps the ones it was minted with for up to an hour,
 *  so a caller refused 403 retries with one of these (MOTIR-11229). */
export async function sourceRepoToken(
  owner: string,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<string | null> {
  if (!isGithubAppConfigured('provisioning')) return null;
  try {
    const installation = await getOrgInstallation(owner, 'provisioning');
    if (!installation || installation.suspendedAt) return null;
    if (fresh) evictInstallationToken(installation.id, 'provisioning');
    return (await mintInstallationToken(installation.id, 'provisioning')).token;
  } catch (err) {
    if (
      err instanceof OrgInstallationReadError ||
      err instanceof GithubAppTokenError ||
      err instanceof GithubAppNotConfiguredError
    ) {
      return null;
    }
    throw err;
  }
}

type BuildRead =
  | { ok: true; build: RunnerImageBuildDTO }
  | { ok: false; phase: 'registry' | 'build_commit'; detail: string };

/** The commit the pinned image was built from. Never throws. */
async function readBuild(image: string): Promise<BuildRead> {
  const pinned = await readImageLabels(image);
  if (!pinned.ok) {
    return {
      ok: false,
      phase: 'registry',
      detail: `the pinned image's registry entry could not be read (${pinned.reason}: ${pinned.detail})`,
    };
  }
  const labelled = imageRevisionFromLabels(pinned.labels);
  if (labelled) return { ok: true, build: { image, commit: labelled, source: 'label' } };

  const unrecorded = (why: string): BuildRead => ({
    ok: false,
    phase: 'build_commit',
    detail: `the pinned image records no build commit (no org.opencontainers.image.revision label) and ${why}`,
  });
  if (!pinned.digest) return unrecorded('the registry named no digest to match a sha- tag against');
  const repository = imageRepositoryOf(image);
  const listing = await listImageTags(repository);
  if (!listing.ok) {
    return unrecorded(
      `the registry's tag list could not be read (${listing.reason}: ${listing.detail})`,
    );
  }
  const shaTags = listing.tags.filter((t) => commitFromShaTag(t) !== null).slice(0, MAX_SHA_TAGS);
  for (const tag of shaTags) {
    const candidate = await readImageLabels(`${repository}:${tag}`);
    if (candidate.ok && candidate.digest === pinned.digest) {
      return { ok: true, build: { image, commit: commitFromShaTag(tag)!, source: 'sha_tag' } };
    }
  }
  return unrecorded(`none of the ${shaTags.length} sha- tags in ${repository} resolves to it`);
}

/**
 * The default-branch changes to `inputs` the build commit does not contain,
 * newest-per-path, one entry per commit. Throws `RepoCommitHistoryError`.
 */
export async function unreleasedChanges(
  repo: RepoRef,
  buildCommit: string,
  inputs: readonly string[],
  token: string | null,
): Promise<RunnerImageUnreleasedChangeDTO[]> {
  const byCommit = new Map<string, RunnerImageUnreleasedChangeDTO>();
  const judged = new Set<string>();
  for (const path of inputs) {
    const newest = await repoCommitHistoryClient.newestTouching(repo, path, token);
    if (!newest) continue;
    const existing = byCommit.get(newest.sha);
    if (existing) {
      existing.paths.push(path);
      continue;
    }
    if (judged.has(newest.sha)) continue;
    judged.add(newest.sha);
    const relation = await repoCommitHistoryClient.relation(repo, buildCommit, newest.sha, token);
    if (relation === 'ahead' || relation === 'diverged') {
      byCommit.set(newest.sha, {
        commit: newest.sha,
        committedAt: newest.committedAt,
        subject: newest.subject,
        paths: [path],
        relation,
      });
    }
  }
  return [...byCommit.values()].sort((a, b) => b.committedAt.localeCompare(a.committedAt));
}

/** The account the AMI is read in: the oldest active aws `ci_runner` account.
 *  Every one of them is shared the same AMI and boots it, so any one answers. */
async function amiReadAccount(): Promise<FleetShardDTO | null> {
  const rows = await withSystemContext((tx) =>
    fleetShardRepository.listByRole(
      null,
      { fleetKind: 'ci_runner', state: 'active', provider: 'aws' },
      tx,
    ),
  );
  return rows[0] ? toFleetShardDTO(rows[0]) : null;
}

type AmiBuildRead =
  | { ok: true; build: RunnerAmiBuildDTO }
  | { ok: false; phase: 'account' | 'ec2' | 'build_commit'; detail: string };

/** The commit the pinned AMI was built from (MOTIR-10395). Never throws on a
 *  refused read. */
async function readAmiBuild(amiId: string): Promise<AmiBuildRead> {
  const account = await amiReadAccount();
  if (!account) {
    return {
      ok: false,
      phase: 'account',
      detail: 'there is no active aws ci_runner fleet account whose runner role could read it',
    };
  }
  let images;
  try {
    images = await describeAwsImages(account, [amiId]);
  } catch (err) {
    if (!(err instanceof Ec2ApiError) && !(err instanceof OrchestratorNotConfiguredError)) {
      throw err;
    }
    const why =
      err instanceof Ec2ApiError
        ? `EC2 refused DescribeImages (${err.code})` +
          (err.code === 'UnauthorizedOperation'
            ? '; the motir-fleet-runner role there does not hold ec2:DescribeImages yet'
            : '')
        : err.message;
    return {
      ok: false,
      phase: 'ec2',
      detail: `${amiId} could not be read in fleet account ${account.name}: ${why}`,
    };
  }
  const image = images.find((i) => i.imageId === amiId);
  if (!image) {
    return {
      ok: false,
      phase: 'ec2',
      detail: `EC2 in fleet account ${account.name} answered no image for ${amiId}`,
    };
  }
  const recorded = amiBuildCommitFrom(image);
  if (!recorded) {
    return {
      ok: false,
      phase: 'build_commit',
      detail:
        `${amiId} records no build commit: its description carries no "commit <sha>" and its ` +
        `name ${JSON.stringify(image.name)} does not end in -<YYYYMMDDhhmm>-<sha7>`,
    };
  }
  return {
    ok: true,
    build: { amiId, name: image.name, ...recorded, account: account.name },
  };
}

/** Judge the pinned AMI against `RUNNER_AMI_INPUTS` with the image's rule. */
async function judgeAmi(token: () => Promise<string | null>): Promise<RunnerAmiFreshnessDTO> {
  const amiId = process.env[AWS_RUNNER_AMI_ENV_VAR]?.trim();
  if (!amiId) return { state: 'unset' };
  const read = await readAmiBuild(amiId);
  if (!read.ok) return { state: 'indeterminate', amiId, phase: read.phase, detail: read.detail };
  const repo = RUNNER_IMAGE_SOURCE_REPO;
  let unreleased: RunnerImageUnreleasedChangeDTO[];
  try {
    unreleased = await unreleasedChanges(repo, read.build.commit, RUNNER_AMI_INPUTS, await token());
  } catch (err) {
    if (!(err instanceof RepoCommitHistoryError)) throw err;
    return {
      state: 'indeterminate',
      amiId,
      phase: 'github',
      detail: `${repo.owner}/${repo.name}'s history could not be read against ${read.build.commit}: ${err.message}`,
    };
  }
  return unreleased.length > 0
    ? { state: 'stale', build: read.build, unreleased }
    : { state: 'current', build: read.build };
}

export const runnerImageFreshnessProbeService = {
  /** Judge the pinned runner image and the pinned runner AMI. Never throws on a
   *  stale pin or a refused read — the caller decides which arms are loud. */
  async check(options: { now?: Date } = {}): Promise<RunnerImageFreshnessVerdictDTO> {
    const checkedAt = (options.now ?? new Date()).toISOString();
    // One token for both arms, minted only when an arm reaches GitHub.
    let tokenRead: Promise<string | null> | null = null;
    const token = () => (tokenRead ??= sourceRepoToken(RUNNER_IMAGE_SOURCE_REPO.owner));
    const ami = await judgeAmi(token);
    const image = configuredFleetRunnerImage();
    if (!image) return { verdict: 'not_applicable', checkedAt, reason: 'runner_image_unset', ami };

    const read = await readBuild(image);
    if (!read.ok) {
      return {
        verdict: 'indeterminate',
        checkedAt,
        image,
        phase: read.phase,
        detail: read.detail,
        ami,
      };
    }
    const repo = RUNNER_IMAGE_SOURCE_REPO;
    let unreleased: RunnerImageUnreleasedChangeDTO[];
    try {
      unreleased = await unreleasedChanges(
        repo,
        read.build.commit,
        RUNNER_IMAGE_INPUTS,
        await token(),
      );
    } catch (err) {
      if (!(err instanceof RepoCommitHistoryError)) throw err;
      return {
        verdict: 'indeterminate',
        checkedAt,
        image,
        phase: 'github',
        detail: `${repo.owner}/${repo.name}'s history could not be read against ${read.build.commit}: ${err.message}`,
        ami,
      };
    }
    if (unreleased.length > 0) {
      return { verdict: 'stale', checkedAt, build: read.build, unreleased, ami };
    }
    return { verdict: 'current', checkedAt, build: read.build, ami };
  },
};
