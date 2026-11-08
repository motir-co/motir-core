// The verdict of the runner-version support probe (MOTIR-10706), a probe of
// `system.daily-health-check`: is the GitHub Actions runner the fleet is built
// with (`ARG RUNNER_VERSION` in `infra/ci-runner/Dockerfile` on the default
// branch) still inside the window GitHub serves jobs to? The arms are written
// out flat so the memoized step's pinned shape reads as plain objects.

/** One published, non-prerelease `actions/runner` release. */
export interface RunnerReleaseDTO {
  /** `2.338.2` — the tag without its `v`. */
  version: string;
  /** ISO-8601, as GitHub reports `published_at`. */
  publishedAt: string;
}

/**
 * `supported` — nothing newer is out, or the cut-off is more than the warning
 * margin away. `expiring` — the cut-off is inside the margin: bump now.
 * `unsupported` — the cut-off has passed: GitHub refuses runners on the pin.
 * `indeterminate` — the pin or the release list could not be read, never a pass.
 * `not_applicable` — the deployment runs no CI fleet (no runner image, no AMI).
 *
 * On the definite arms: `pinned` is the default branch's `RUNNER_VERSION`;
 * `latest` the newest release; `supersededBy` the OLDEST release newer than the
 * pin, whose publication starts GitHub's clock (null when nothing newer is out);
 * `deadline` its `publishedAt` plus the support window; `daysLeft` the whole days
 * from `checkedAt` to `deadline`, negative once it has passed.
 */
export type RunnerVersionSupportVerdictDTO =
  | {
      verdict: 'supported';
      checkedAt: string;
      pinned: string;
      latest: RunnerReleaseDTO;
      supersededBy: RunnerReleaseDTO | null;
      deadline: string | null;
      daysLeft: number | null;
    }
  | {
      verdict: 'expiring';
      checkedAt: string;
      pinned: string;
      latest: RunnerReleaseDTO;
      supersededBy: RunnerReleaseDTO;
      deadline: string;
      daysLeft: number;
    }
  | {
      verdict: 'unsupported';
      checkedAt: string;
      pinned: string;
      latest: RunnerReleaseDTO;
      supersededBy: RunnerReleaseDTO;
      deadline: string;
      daysLeft: number;
    }
  | { verdict: 'indeterminate'; checkedAt: string; phase: 'pin' | 'releases'; detail: string }
  | { verdict: 'not_applicable'; checkedAt: string; reason: 'fleet_unset' };
