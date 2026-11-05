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

/** The commit the pinned runner AMI was built from, as an account it is shared
 *  with reads it (MOTIR-10395). */
export interface RunnerAmiBuildDTO {
  /** The `MOTIR_AWS_RUNNER_AMI_ID` value, as configured. */
  amiId: string;
  /** The AMI's name, `motir-ci-runner-<runner>-<YYYYMMDDhhmm>-<sha7>`. */
  name: string | null;
  /** The commit: the full SHA when the description records it, else the name's
   *  seven characters, which GitHub resolves as long as they are unambiguous. */
  commit: string;
  /** `description` — an AMI built since MOTIR-10395 writes `commit <sha>` into
   *  its description; `name` — an older AMI, read from the name's suffix. */
  source: 'description' | 'name';
  /** The fleet account (an active aws `ci_runner` account) whose runner role read it. */
  account: string;
}

/**
 * The runner AMI the AWS fleet boots (`MOTIR_AWS_RUNNER_AMI_ID`), judged the
 * way the image is: is the commit it was built from at or after the newest
 * default-branch change to `RUNNER_AMI_INPUTS`? It is read through the
 * `motir-fleet-runner` role of one active aws `ci_runner` account, which holds
 * `ec2:DescribeImages` since MOTIR-10395. The AMI's `GitSha` tag is not used: a
 * shared AMI's tags are visible only in the build account. `indeterminate` is a
 * read that did not answer, never a pass.
 */
export type RunnerAmiFreshnessDTO =
  | { state: 'unset' }
  | { state: 'current'; build: RunnerAmiBuildDTO }
  | { state: 'stale'; build: RunnerAmiBuildDTO; unreleased: RunnerImageUnreleasedChangeDTO[] }
  | {
      state: 'indeterminate';
      amiId: string;
      /** `account` — no active aws `ci_runner` account to read it in; `ec2` —
       *  the account's EC2 refused or did not show it; `build_commit` — its name
       *  and description record no commit; `github` — the history read failed. */
      phase: 'account' | 'ec2' | 'build_commit' | 'github';
      detail: string;
    };

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
