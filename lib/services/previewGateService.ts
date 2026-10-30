import type { PreviewDeploymentState } from '@/generated/prisma/client';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import type { HostingTarget } from '@/lib/hosting/vocabulary';
import {
  ORIGIN_SECRET_HEADER,
  deriveOriginSecret,
  type OriginCredentialKind,
} from '@motir/orchestrator';
import { getHostingDeployPort, hostingOriginSecretKey } from '@/lib/orchestrator/hosting';
import {
  PREVIEW_ACCESS_PATH,
  PREVIEW_AUTH_PATH,
  gateSigningKey,
  mintAdmission,
  mintGatePass,
  previewHostOf,
  safeReturnPath,
  verifyAdmission,
  type GateRefusal,
} from '@/lib/preview/gate';
import { ProjectNotFoundError, PermissionDeniedError } from '@/lib/projects/errors';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { previewDeploymentRepository } from '@/lib/repositories/previewDeploymentRepository';
import { previewGateAdmissionRepository } from '@/lib/repositories/previewGateAdmissionRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { bindWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';

// THE PREVIEW MEMBER GATE's database half (Story MOTIR-5766 · Subtask MOTIR-5779,
// MOTIR-5769 §5 and §9). `lib/preview/gate.ts` holds the pure half: the host
// rule, the signatures, the return path and the forwarding rules.
//
// Three callers:
//   * `app/(auth)/preview-access/page.tsx` on app.motir.co — `admit`: a signed-in
//     viewer holding `project:browse` on the preview's project gets an admission.
//   * `proxy.ts` on a preview host — `consumeAdmission`, then `route` on every
//     request: where a ready preview's requests go, cached for a few seconds.
//   * `app/(preview-host)/preview-gate/page.tsx` — `view`: what a non-ready
//     preview's page shows, read fresh.
//
// The preview host carries no Motir session, so every read here runs under
// withSystemContext, binding the preview's workspace before the one tenant read
// (the linked work item) that needs it.

/** What a page on the preview host shows about its preview. */
export interface PreviewGateView {
  readonly host: string;
  readonly state: PreviewDeploymentState;
  /** The lifecycle's reason, verbatim, when `failed`. */
  readonly failureReason: string | null;
  readonly pullRequestNumber: number;
  /** `owner/name`. */
  readonly repository: string;
  readonly pullRequestUrl: string;
  /** The card the pull request delivers, when one is linked. */
  readonly workItem: {
    readonly identifier: string;
    readonly title: string;
    readonly url: string;
  } | null;
  /** Why a `closed` preview closed (the design's `closed.*` copy), else null. */
  readonly closedReason: PreviewClosedReason | null;
}

export type PreviewClosedReason = 'merged' | 'closed' | 'takenOver' | 'unknown';

/** Where a ready preview's requests are sent, and with which origin credential. */
export interface PreviewUpstream {
  /** The release's address — `https://<app>.fly.dev`, a function URL, … */
  readonly origin: string;
  readonly credential: OriginCredentialKind;
  /** Headers every forwarded request carries (the Fly origin secret). */
  readonly headers: Readonly<Record<string, string>>;
}

/** What the proxy decides a preview-host request with. */
export interface PreviewRoute {
  readonly state: PreviewDeploymentState;
  readonly target: HostingTarget | null;
  /** Set only when `state` is `ready` and the release reports an address. */
  readonly upstream: PreviewUpstream | null;
}

export type AdmitResult =
  | { readonly admitted: true; readonly url: string }
  | { readonly admitted: false };

/** How long the proxy trusts a host's route before reading it again. Short:
 *  a preview closing, failing or changing release shows within this window. */
export const PREVIEW_ROUTE_CACHE_MS = 5_000;

const routeCache = new Map<string, { at: number; route: PreviewRoute | null }>();

/** Drop the route cache — for tests. */
export function resetPreviewRouteCache(): void {
  routeCache.clear();
}

/** The URL preview-access lives at for one host and path. */
export function previewAccessUrl(host: string, returnPath: string): string {
  const url = new URL(PREVIEW_ACCESS_PATH, resolveBaseUrlTrimmed());
  url.searchParams.set('host', host);
  url.searchParams.set('return', safeReturnPath(returnPath));
  return url.toString();
}

async function readUpstream(
  target: HostingTarget,
  appRef: string,
): Promise<PreviewUpstream | null> {
  const port = getHostingDeployPort(target);
  const [serving] = await port.listReleases({ appRef });
  if (!serving) return null;
  const description = await port.describe(serving.handle);
  if (!description.upstreamAddress) return null;
  const headers: Record<string, string> =
    description.originCredential === 'origin_secret'
      ? { [ORIGIN_SECRET_HEADER]: deriveOriginSecret(hostingOriginSecretKey(), appRef) }
      : {};
  return {
    origin: new URL(description.upstreamAddress).origin,
    credential: description.originCredential,
    headers,
  };
}

function closedReasonOf(
  pullRequest: { state: string; merged: boolean } | null,
  takeoverState: string | null,
): PreviewClosedReason {
  if (pullRequest?.merged) return 'merged';
  if (pullRequest?.state === 'closed') return 'closed';
  if (takeoverState !== null) return 'takenOver';
  return 'unknown';
}

export const previewGateService = {
  /**
   * preview-access's decision for a signed-in viewer. A host that is not a
   * preview host, names no preview, or whose project the viewer may not browse
   * is refused the SAME way, so the refusal says nothing about what exists
   * (design: "Not found cannot be told apart from closed, or from refused").
   * Access is the `project:browse` permission, resolved by the shipped
   * resolver — never a role name.
   */
  async admit(input: { userId: string; host: string; returnPath: string }): Promise<AdmitResult> {
    const host = previewHostOf(input.host);
    if (!host) return { admitted: false };
    const subject = await withSystemContext(async (tx) => {
      const row = await previewDeploymentRepository.findByHost(host, tx);
      if (!row) return null;
      return projectRepoRepository.findPreviewGateSubjectByGithubRepoInTx(row.repoId, tx);
    });
    if (!subject) return { admitted: false };
    try {
      await projectAccessService.assertPermission(
        subject.projectId,
        { userId: input.userId, workspaceId: subject.workspaceId },
        'project:browse',
      );
    } catch (error) {
      if (error instanceof ProjectNotFoundError || error instanceof PermissionDeniedError) {
        return { admitted: false };
      }
      throw error;
    }
    const { token } = mintAdmission({ host, sub: input.userId }, gateSigningKey());
    const url = new URL(PREVIEW_AUTH_PATH, `https://${host}`);
    url.searchParams.set('token', token);
    url.searchParams.set('return', safeReturnPath(input.returnPath));
    return { admitted: true, url: url.toString() };
  },

  /**
   * The preview host's half of the handshake: verify the admission FOR THIS
   * HOST and record it consumed. Answers the gate cookie's value, or why it
   * was refused — `consumed` for a replay. Expired records are deleted in the
   * same transaction.
   */
  async consumeAdmission(
    token: string | null,
    host: string,
    now: Date = new Date(),
  ): Promise<{ ok: true; cookie: string } | { ok: false; refusal: GateRefusal | 'consumed' }> {
    const key = gateSigningKey();
    const verified = verifyAdmission(token, host, key, now);
    if (!verified.ok) return verified;
    const { admission } = verified;
    const fresh = await withSystemContext(async (tx) => {
      await previewGateAdmissionRepository.deleteExpired(now, tx);
      return previewGateAdmissionRepository.consume(
        { jti: admission.jti, host, expiresAt: new Date(admission.exp) },
        tx,
      );
    });
    if (!fresh) return { ok: false, refusal: 'consumed' };
    return { ok: true, cookie: mintGatePass(admission, key, now) };
  },

  /**
   * Where a request to `host` goes, cached for {@link PREVIEW_ROUTE_CACHE_MS}.
   * Null when no preview holds the host. A ready row whose release reports no
   * address routes like a missing one would not: `upstream` is null and the
   * proxy answers with the page.
   */
  async route(host: string, now: number = Date.now()): Promise<PreviewRoute | null> {
    const hit = routeCache.get(host);
    if (hit && now - hit.at < PREVIEW_ROUTE_CACHE_MS) return hit.route;
    const read = await withSystemContext(async (tx) => {
      const row = await previewDeploymentRepository.findByHost(host, tx);
      if (!row) return null;
      const subject = await projectRepoRepository.findPreviewGateSubjectByGithubRepoInTx(
        row.repoId,
        tx,
      );
      return { row, target: subject?.hostingTarget ?? null };
    });
    let route: PreviewRoute | null = null;
    if (read) {
      const { row, target } = read;
      const upstream =
        row.state === 'ready' && target && row.flyAppName
          ? await readUpstream(target, row.flyAppName)
          : null;
      route = { state: row.state, target, upstream };
    }
    routeCache.set(host, { at: now, route });
    return route;
  },

  /** What the preview host's page shows for `host`, read fresh; null when no
   *  preview holds it (the Not found page). */
  async view(host: string): Promise<PreviewGateView | null> {
    return withSystemContext(async (tx) => {
      const row = await previewDeploymentRepository.findByHost(host, tx);
      if (!row) return null;
      const subject = await projectRepoRepository.findPreviewGateSubjectByGithubRepoInTx(
        row.repoId,
        tx,
      );
      const pullRequest = await githubPullRequestRepository.findByRepoAndNumber(
        row.repoId,
        row.pullRequestNumber,
        tx,
      );
      let workItem: PreviewGateView['workItem'] = null;
      if (pullRequest) {
        await bindWorkspaceContext(tx, row.workspaceId);
        const linked = await workItemDeliveryRepository.findFirstWorkItemForPullRequest(
          pullRequest.id,
          tx,
        );
        if (linked) {
          workItem = {
            ...linked,
            // Absolute, as the notification links are: the gate page is served
            // on the preview host, so the link leaves it for the app.
            url: `${resolveBaseUrlTrimmed()}/items/${encodeURIComponent(linked.identifier)}`,
          };
        }
      }
      const owner = subject?.githubRepo?.owner ?? '';
      const name = subject?.githubRepo?.name ?? '';
      return {
        host: row.host,
        state: row.state,
        failureReason: row.state === 'failed' ? row.failureReason : null,
        pullRequestNumber: row.pullRequestNumber,
        repository: `${owner}/${name}`,
        pullRequestUrl: `https://github.com/${owner}/${name}/pull/${row.pullRequestNumber}`,
        workItem,
        closedReason:
          row.state === 'closed'
            ? closedReasonOf(pullRequest, subject?.takeoverState ?? null)
            : null,
      };
    });
  },
};
