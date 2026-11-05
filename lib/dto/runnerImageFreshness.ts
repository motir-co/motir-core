// The verdict of the runner-image freshness probe (MOTIR-10393), the tenth probe
// of `system.daily-health-check`: is the runner image this deployment pins built
// from a commit that contains every default-branch change to the image's inputs?
// The arms are written out flat so the memoized step's pinned shape reads as
// plain objects.

/** The commit the pinned image was built from, and where that was read. */
export interface RunnerImageBuildDTO {
  /** The `MOTIR_RUNNER_IMAGE` reference, as configured. */
  image: string;
  /** The full commit SHA. */
  commit: string;
  /** `label` — the image's `org.opencontainers.image.revision`; `sha_tag` — the
   *  release's `sha-<commit>` registry tag that resolves to the same bytes (an
   *  image released before the label existed). */
  source: 'label' | 'sha_tag';
}

/** A default-branch commit that changed an image input the pinned image lacks. */
export interface RunnerImageUnreleasedChangeDTO {
  commit: string;
  committedAt: string;
  subject: string;
  /** The inputs it is the newest change to. */
  paths: string[];
  /** `ahead` — made after the build; `diverged` — the build came from a branch
   *  that does not contain it. */
  relation: 'ahead' | 'diverged';
}

/**
 * The runner AMI the AWS fleet boots. It is NOT judged: the deployment's only
 * identity in a pool account is the `motir-fleet-runner` role, which holds no
 * `ec2:DescribeImages`, and the AMI's `GitSha` tag lives in the build account,
 * where a shared AMI's tags are not visible to the accounts it is shared with.
 * The reason is recorded on every run so the gap is read, not assumed; judging
 * it is MOTIR-10395.
 */
export type RunnerAmiFreshnessDTO =
  | { state: 'unset' }
  | { state: 'not_read'; amiId: string; reason: string };

export type RunnerImageFreshnessVerdictDTO =
  | {
      /** No runner image is pinned: this deployment runs no fleet. */
      verdict: 'not_applicable';
      checkedAt: string;
      reason: 'runner_image_unset';
      ami: RunnerAmiFreshnessDTO;
    }
  | {
      /** The pinned image contains the newest change to every input. */
      verdict: 'current';
      checkedAt: string;
      build: RunnerImageBuildDTO;
      ami: RunnerAmiFreshnessDTO;
    }
  | {
      /** A merged change to an input has not reached the pinned image. */
      verdict: 'stale';
      checkedAt: string;
      build: RunnerImageBuildDTO;
      unreleased: RunnerImageUnreleasedChangeDTO[];
      ami: RunnerAmiFreshnessDTO;
    }
  | {
      /** The probe could not tell — never a pass. `phase` names the read. */
      verdict: 'indeterminate';
      checkedAt: string;
      image: string;
      phase: 'registry' | 'build_commit' | 'github';
      detail: string;
      ami: RunnerAmiFreshnessDTO;
    };
