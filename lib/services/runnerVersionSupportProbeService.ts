import {
  judgeRunnerVersion,
  parseRunnerReleases,
  RUNNER_RELEASES_REPO,
  RUNNER_VERSION_PIN_PATH,
  runnerVersionFromDockerfile,
} from '@/lib/ciFleet/runnerVersionSupport';
import { RUNNER_IMAGE_SOURCE_REPO } from '@/lib/ciFleet/runnerImageSources';
import type { RunnerVersionSupportVerdictDTO } from '@/lib/dto/runnerVersionSupport';
import {
  RunnerVersionSourceError,
  runnerVersionSourcesClient,
} from '@/lib/github/runnerVersionSources';
import { AWS_RUNNER_AMI_ENV_VAR, configuredFleetRunnerImage } from '@/lib/orchestrator';
import { sourceRepoToken } from '@/lib/services/runnerImageFreshnessProbeService';

// THE RUNNER-VERSION SUPPORT PROBE (MOTIR-10706) — a probe of
// `system.daily-health-check` that fails before GitHub stops serving the
// Actions runner the CI fleet is built with. The rule and its reasons are in
// `lib/ciFleet/runnerVersionSupport.ts`; this file is its two reads.
//
// WHAT IT READS, AND WHY THE DEFAULT BRANCH. The pin lives in one place,
// `ARG RUNNER_VERSION` in `infra/ci-runner/Dockerfile`, and the image and the
// AMI are both built from it. This probe judges the pin on the default branch;
// the runner-image freshness probe beside it (MOTIR-10393 / MOTIR-10395) fails
// whenever the pinned image or AMI was built before the newest change to that
// file. Between them, a stale pin on the branch and a fresh pin that never
// reached the fleet are both reported — the second by the freshness probe, with
// the release step in its message.
//
// ⚠️ `indeterminate` IS RECORDED, NOT THROWN — the rule every probe of the job
// follows: GitHub not answering is a statement about the read, and the
// indeterminate streak (MOTIR-10429) is what turns a read that keeps failing
// into an alarm.

/** A read that fell back to anonymous after the token was refused, once. The
 *  installation token is scoped to the deployment's own organisation; GitHub
 *  serves a public repository to it as well, but an anonymous read is the
 *  answer that does not depend on that. */
async function withAnonymousFallback<T>(
  token: string | null,
  read: (token: string | null) => Promise<T>,
): Promise<T> {
  try {
    return await read(token);
  } catch (err) {
    const refusedToken =
      token !== null &&
      err instanceof RunnerVersionSourceError &&
      (err.status === 401 || err.status === 403 || err.status === 404);
    if (!refusedToken) throw err;
    return read(null);
  }
}

type Read<T> = { ok: true; value: T } | { ok: false; detail: string };

async function readPin(token: string | null): Promise<Read<string>> {
  const repo = RUNNER_IMAGE_SOURCE_REPO;
  const where = `${RUNNER_VERSION_PIN_PATH} on ${repo.owner}/${repo.name}'s default branch`;
  let text: string;
  try {
    text = await withAnonymousFallback(token, (t) =>
      runnerVersionSourcesClient.fileOnDefaultBranch(repo, RUNNER_VERSION_PIN_PATH, t),
    );
  } catch (err) {
    if (!(err instanceof RunnerVersionSourceError)) throw err;
    return { ok: false, detail: `${where} could not be read: ${err.message}` };
  }
  const pinned = runnerVersionFromDockerfile(text);
  return pinned
    ? { ok: true, value: pinned }
    : { ok: false, detail: `${where} carries no exact "ARG RUNNER_VERSION=<x.y.z>" line` };
}

async function readReleases(
  token: string | null,
): Promise<Read<NonNullable<ReturnType<typeof parseRunnerReleases>>>> {
  const repo = RUNNER_RELEASES_REPO;
  let body: unknown;
  try {
    body = await withAnonymousFallback(token, (t) => runnerVersionSourcesClient.releases(repo, t));
  } catch (err) {
    if (!(err instanceof RunnerVersionSourceError)) throw err;
    return {
      ok: false,
      detail: `${repo.owner}/${repo.name}'s releases could not be read: ${err.message}`,
    };
  }
  const releases = parseRunnerReleases(body);
  if (!releases || releases.length === 0) {
    return {
      ok: false,
      detail: `${repo.owner}/${repo.name}'s release list named no published v<x.y.z> release`,
    };
  }
  return { ok: true, value: releases };
}

export const runnerVersionSupportProbeService = {
  /** Judge the default branch's runner pin against GitHub's releases. Never
   *  throws on a pin GitHub refuses or a read that failed — the job decides
   *  which arms are loud. */
  async check(options: { now?: Date } = {}): Promise<RunnerVersionSupportVerdictDTO> {
    const now = options.now ?? new Date();
    const checkedAt = now.toISOString();
    const runsFleet =
      configuredFleetRunnerImage() !== null || Boolean(process.env[AWS_RUNNER_AMI_ENV_VAR]?.trim());
    if (!runsFleet) return { verdict: 'not_applicable', checkedAt, reason: 'fleet_unset' };

    const token = await sourceRepoToken(RUNNER_IMAGE_SOURCE_REPO.owner);
    const pin = await readPin(token);
    if (!pin.ok) return { verdict: 'indeterminate', checkedAt, phase: 'pin', detail: pin.detail };
    const releases = await readReleases(token);
    if (!releases.ok) {
      return { verdict: 'indeterminate', checkedAt, phase: 'releases', detail: releases.detail };
    }
    return judgeRunnerVersion({ pinned: pin.value, releases: releases.value, now });
  },
};
