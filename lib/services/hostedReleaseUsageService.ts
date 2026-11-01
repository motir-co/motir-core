import { OrchestratorApiError } from '@motir/orchestrator';
import { releaseHandleFor, settledWindow, usageWindowStart } from '@/lib/hosting/releaseUsage';
import { getHostingDeployPort } from '@/lib/orchestrator/hosting';
import { hostedReleaseRepository } from '@/lib/repositories/hostedReleaseRepository';
import { withSystemContext } from '@/lib/workspaces/context';

// A production release's RUNNING TIME, recorded on the release (Story MOTIR-9797
// · MOTIR-10034). `settleReleaseUsage` asks the deploy port how long the LIVE
// release ran since it was last settled and adds that window to
// `hosted_release.usage_seconds`. The release service calls it just before it
// deploys a replacing release, and a rollback just before the port's rollback —
// while the release is still the one serving, because once it is replaced the
// port need not answer for its handle any more.
//
// Settling is WINDOWED: each call reads from `usage_settled_until` (`live_at`
// the first time), and the write is one conditional UPDATE on that value, so two
// settles of one window add it once and a release that keeps serving after a
// failed replacement simply settles again from where it stopped.
//
// ⚠️ UNPRICED, and NEVER IN THE WAY. Nothing here prices, meters or bills: the
// seconds are stored and nothing more. A port error leaves the row as it was and
// is logged as step, status and code only — never its message, which can hold a
// connection string — and nothing here throws, so usage recording never fails,
// delays beyond one port call, or reverses a release or a rollback.

export type SettleReleaseUsageOutcome =
  /** The window was added. */
  | { outcome: 'settled'; seconds: number }
  /** Another settle added this window first; nothing was written. */
  | { outcome: 'skipped' }
  /** The port could not answer; nothing was written. */
  | { outcome: 'unavailable' }
  /** No live release with a port handle to ask about; nothing was written. */
  | { outcome: 'not_live' };

const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const ERROR_NAME = /^[A-Za-z]{1,64}$/;

/** The status and code of a port failure — nothing else of it. */
function failureFacts(error: unknown): { status: number | null; code: string } {
  const status = error instanceof OrchestratorApiError ? error.status : null;
  const code = (error as { code?: unknown } | null)?.code;
  const name = error instanceof Error ? error.name : '';
  return {
    status,
    code:
      typeof code === 'string' && ERROR_CODE.test(code)
        ? code
        : ERROR_NAME.test(name)
          ? name
          : 'UNKNOWN',
  };
}

/** Add the live release's running time since its last settle to its usage. */
async function settleReleaseUsage(releaseId: string): Promise<SettleReleaseUsageOutcome> {
  const release = await withSystemContext((tx) =>
    hostedReleaseRepository.findUsageTarget(releaseId, tx),
  );
  const since = release ? usageWindowStart(release) : null;
  if (!release || release.state !== 'live' || since === null) return { outcome: 'not_live' };

  // The port calls hold no transaction and no row lock: they are network calls.
  let usage;
  try {
    const port = getHostingDeployPort(release.target);
    const { appRef } = await port.ensureApp({
      repositoryId: release.projectRepositoryId,
      environment: { kind: 'production' },
    });
    const handle = releaseHandleFor({ target: release.target, appRef }, release);
    if (handle === null) return { outcome: 'not_live' };
    usage = await port.usageSince(handle, since);
  } catch (error) {
    console.warn('[hostedReleaseUsageService] could not read a release’s usage', {
      releaseId,
      step: 'usage',
      ...failureFacts(error),
    });
    return { outcome: 'unavailable' };
  }

  const window = settledWindow(since, usage);
  try {
    const added = await withSystemContext((tx) =>
      hostedReleaseRepository.addSettledUsage(
        releaseId,
        { expectedSettledUntil: release.usageSettledUntil, ...window },
        tx,
      ),
    );
    return added ? { outcome: 'settled', seconds: window.seconds } : { outcome: 'skipped' };
  } catch (error) {
    console.warn('[hostedReleaseUsageService] could not record a release’s usage', {
      releaseId,
      step: 'record',
      ...failureFacts(error),
    });
    return { outcome: 'unavailable' };
  }
}

export const hostedReleaseUsageService = { settleReleaseUsage };
