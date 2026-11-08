// IS THE FLEET'S ACTIONS RUNNER STILL ONE GITHUB WILL SERVE? (MOTIR-10706)
//
// The runner is baked into the image and the AMI at `ARG RUNNER_VERSION` in
// `infra/ci-runner/Dockerfile`, and it runs with self-update off — a fleet VM is
// one job and gone, so an update would be a download on every boot. GitHub's
// rule for a runner with updates disabled is that it must be updated within 30
// days of a newer release; past that it is refused. Refused looks like this on
// the machine: "√ Connected to GitHub … Listening for Jobs … An error occurred:
// Runner version v2.336.0 is deprecated and cannot receive messages", the
// runner exits, the VM powers off, and the job stays queued. On 2026-11-08 every
// runner of the AWS fleet did exactly that, and nothing had said the pin was
// ageing out.
//
// THE RULE THIS FILE APPLIES. The clock starts at the OLDEST release newer than
// the pin (`supersededBy`): that publication is the moment GitHub's 30 days
// began, whatever came out after it. The check fails `RUNNER_VERSION_WARN_DAYS`
// before the cut-off, so a bump, a `runner-v*` release and a
// `ci-runner-ami-v*` AMI all fit before GitHub stops serving the old one —
// rather than when the fleet has already stopped. A rule of "is the pin the
// newest minor" would fail on every release day, a day nothing is wrong, and a
// check that cries wolf is one somebody silences.
//
// Pure: no I/O. `lib/services/runnerVersionSupportProbeService.ts` reads the
// Dockerfile and the release list and hands them here.

import type {
  RunnerReleaseDTO,
  RunnerVersionSupportVerdictDTO,
} from '@/lib/dto/runnerVersionSupport';

/** The file the runner version is pinned in, on the runner image's source repository. */
export const RUNNER_VERSION_PIN_PATH = 'infra/ci-runner/Dockerfile';

/** Where GitHub publishes the runner. */
export const RUNNER_RELEASES_REPO = { owner: 'actions', name: 'runner' } as const;

/** GitHub's window: a runner with updates off must move within this many days
 *  of a newer release being published. */
export const RUNNER_SUPPORT_WINDOW_DAYS = 30;

/** How long before the cut-off the check fails: room to bump, release the image
 *  and the AMI, and pin both. */
export const RUNNER_VERSION_WARN_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;
const VERSION = /^\d+\.\d+\.\d+$/;

/** The `ARG RUNNER_VERSION=<x.y.z>` value, or null when the line is missing or not
 *  an exact three-part version. */
export function runnerVersionFromDockerfile(dockerfile: string): string | null {
  const match = /^ARG RUNNER_VERSION=(\S+)\s*$/m.exec(dockerfile);
  const value = match?.[1];
  return value && VERSION.test(value) ? value : null;
}

/** Numeric comparison of two `x.y.z` versions: negative, zero or positive. */
export function compareRunnerVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The published releases out of `GET /repos/actions/runner/releases`: drafts
 * and pre-releases dropped (GitHub never asks a runner to move to either), and
 * any tag that is not `v<x.y.z>` dropped with them. Oldest version first.
 * Returns null when the body is not a list at all.
 */
export function parseRunnerReleases(body: unknown): RunnerReleaseDTO[] | null {
  if (!Array.isArray(body)) return null;
  const releases: RunnerReleaseDTO[] = [];
  for (const raw of body) {
    const row = asRecord(raw);
    if (!row || row['draft'] === true || row['prerelease'] === true) continue;
    const tag = row['tag_name'];
    const publishedAt = row['published_at'];
    if (typeof tag !== 'string' || typeof publishedAt !== 'string') continue;
    const version = tag.replace(/^v/, '');
    if (!VERSION.test(version) || Number.isNaN(Date.parse(publishedAt))) continue;
    releases.push({ version, publishedAt });
  }
  return releases.sort((a, b) => compareRunnerVersions(a.version, b.version));
}

/**
 * Judge a pinned version against the published releases. `releases` must be
 * non-empty (the caller reports an empty list as `indeterminate`).
 */
export function judgeRunnerVersion(input: {
  pinned: string;
  releases: readonly RunnerReleaseDTO[];
  now: Date;
}): Extract<RunnerVersionSupportVerdictDTO, { verdict: 'supported' | 'expiring' | 'unsupported' }> {
  const { pinned, now } = input;
  const releases = [...input.releases].sort((a, b) => compareRunnerVersions(a.version, b.version));
  const latest = releases.at(-1);
  if (!latest) throw new Error('judgeRunnerVersion needs at least one release');
  const checkedAt = now.toISOString();
  const supersededBy = releases.find((r) => compareRunnerVersions(r.version, pinned) > 0) ?? null;
  if (!supersededBy) {
    return {
      verdict: 'supported',
      checkedAt,
      pinned,
      latest,
      supersededBy,
      deadline: null,
      daysLeft: null,
    };
  }
  const deadlineMs = Date.parse(supersededBy.publishedAt) + RUNNER_SUPPORT_WINDOW_DAYS * DAY_MS;
  const deadline = new Date(deadlineMs).toISOString();
  const daysLeft = Math.floor((deadlineMs - now.getTime()) / DAY_MS);
  const base = { checkedAt, pinned, latest, supersededBy, deadline, daysLeft };
  if (deadlineMs <= now.getTime()) return { verdict: 'unsupported', ...base };
  if (daysLeft < RUNNER_VERSION_WARN_DAYS) return { verdict: 'expiring', ...base };
  return { verdict: 'supported', ...base };
}

/** The DLQ sentence for a pin GitHub has stopped, or is about to stop, serving. */
export function runnerVersionSentence(
  verdict: Extract<RunnerVersionSupportVerdictDTO, { verdict: 'expiring' | 'unsupported' }>,
): string {
  const { pinned, supersededBy, deadline, daysLeft, latest } = verdict;
  const day = deadline.slice(0, 10);
  const status =
    verdict.verdict === 'unsupported'
      ? `is past GitHub's support window since ${day}`
      : `leaves GitHub's support window in ${daysLeft} day${daysLeft === 1 ? '' : 's'}, on ${day}`;
  return (
    `The Actions runner the CI fleet is built with, v${pinned} (RUNNER_VERSION in ` +
    `${RUNNER_VERSION_PIN_PATH} on the default branch), ${status}: v${supersededBy.version} ` +
    `came out ${supersededBy.publishedAt.slice(0, 10)}, and GitHub stops serving jobs to a runner ` +
    `with self-update off ${RUNNER_SUPPORT_WINDOW_DAYS} days after a newer release. A refused ` +
    `runner connects, logs "is deprecated and cannot receive messages", and exits without its ` +
    `job (MOTIR-10706). Set RUNNER_VERSION and RUNNER_SHA256 to v${latest.version} from its ` +
    `release body (https://github.com/actions/runner/releases/tag/v${latest.version}), then ` +
    `release runner-v<next> and ci-runner-ami-v<next> and pin MOTIR_RUNNER_IMAGE and ` +
    `MOTIR_AWS_RUNNER_AMI_ID to what they publish.`
  );
}
