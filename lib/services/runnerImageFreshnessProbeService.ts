import { listImageTags, readImageLabels } from '@motir/orchestrator';
import {
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
  commitFromShaTag,
  imageRepositoryOf,
  imageRevisionFromLabels,
  RUNNER_IMAGE_INPUTS,
  RUNNER_IMAGE_SOURCE_REPO,
} from '@/lib/ciFleet/runnerImageSources';
import { AWS_RUNNER_AMI_ENV_VAR, configuredFleetRunnerImage } from '@/lib/orchestrator';
import type {
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
// ⚠️ `indeterminate` IS RECORDED, NOT THROWN — the file's rule for every probe:
// a registry or GitHub that did not answer is a statement about the read, and a
// health check that pages on someone else's uptime is one somebody silences.
// It is never `current`, and it is on the job_run row with the read it failed.

/** Why the AMI is not judged. Stated on the row so the gap is read, not assumed. */
export const RUNNER_AMI_NOT_READ_REASON =
  'The AMI cannot be read from this deployment: its only identity in a pool account is the ' +
  'motir-fleet-runner role, which is not granted ec2:DescribeImages, and the AMI records its ' +
  'build commit as a GitSha tag in the build account, which accounts the AMI is shared with ' +
  'cannot see. Compare its name (motir-ci-runner-<runner>-<time>-<commit>) with the newest ' +
  'change to infra/ci-runner-aws by hand after each ci-runner-ami-v* release (MOTIR-10395).';

/** The registry tags read before the probe gives up looking for the pinned bytes. */
const MAX_SHA_TAGS = 60;

function amiState(): RunnerAmiFreshnessDTO {
  const amiId = process.env[AWS_RUNNER_AMI_ENV_VAR]?.trim();
  return amiId
    ? { state: 'not_read', amiId, reason: RUNNER_AMI_NOT_READ_REASON }
    : { state: 'unset' };
}

/** An installation token for the source repository's owner when this deployment
 *  has the provisioning App there, else null — the repository is public, and an
 *  anonymous read answers the same question. */
async function sourceRepoToken(owner: string): Promise<string | null> {
  if (!isGithubAppConfigured('provisioning')) return null;
  try {
    const installation = await getOrgInstallation(owner, 'provisioning');
    if (!installation || installation.suspendedAt) return null;
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

export const runnerImageFreshnessProbeService = {
  /** Judge the pinned runner image. Never throws on a stale image or a refused
   *  read — the caller decides which arms are loud. */
  async check(options: { now?: Date } = {}): Promise<RunnerImageFreshnessVerdictDTO> {
    const checkedAt = (options.now ?? new Date()).toISOString();
    const ami = amiState();
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
      const token = await sourceRepoToken(repo.owner);
      unreleased = await unreleasedChanges(repo, read.build.commit, RUNNER_IMAGE_INPUTS, token);
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
