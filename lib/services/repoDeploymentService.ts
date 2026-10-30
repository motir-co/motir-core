import type { GithubRepo, Prisma } from '@/generated/prisma/client';
import { withSystemContext } from '@/lib/workspaces/context';
import type { GitProviderId, NormalizedDeploymentStatus } from '@/lib/git/types';
import { repoDeploymentRepository } from '@/lib/repositories/repoDeploymentRepository';

// Preview deployments — the ONE writer both webhook services share (Story
// MOTIR-4906 · Subtask MOTIR-5329; GitLab joins in MOTIR-5332).
//
// A provider's webhook service normalizes its payload through the GitProvider
// seam and resolves the repository row its own way; everything after that —
// the safe-URL rule, the out-of-order guard, the "unconnected repository is not
// an error" rule — is here, once, so the two providers cannot drift apart.
//
// ⚠️ MOTIR CREATES NOTHING HERE. This path makes NO outbound call: no host API
// request, no deployment creation, no status post. It stores what a host
// announced. Keep it that way — a self-hosted customer owns their deploys.
// The ONE deployment Motir itself creates is a PRODUCTION release of a Motir
// repository (MOTIR-10033, `releaseDeploymentStatusService`), and its statuses
// still reach the store only through the webhook this service records.

export type RecordDeploymentOutcome = 'recorded' | 'stale' | 'unknown_repo';

/**
 * Keep a URL only when it parses as `http:` or `https:`. The port renders it as
 * a link, so `javascript:`, a relative path or anything unparseable is dropped
 * to `null` rather than stored and trusted later.
 */
export function safeEnvironmentUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
}

export const repoDeploymentService = {
  /**
   * Record one normalized deployment status for the repository the caller's
   * resolver finds. `resolveRepo` runs inside the system-context transaction;
   * a repository no workspace has connected resolves to `null` and the delivery
   * is a quiet `unknown_repo` — never an error, because GitHub delivers for every
   * repository an installation can see.
   */
  async record(
    provider: GitProviderId,
    event: NormalizedDeploymentStatus,
    resolveRepo: (tx: Prisma.TransactionClient) => Promise<GithubRepo | null>,
  ): Promise<RecordDeploymentOutcome> {
    return withSystemContext(async (tx) => {
      const repo = await resolveRepo(tx);
      if (!repo) return 'unknown_repo';
      const id = await repoDeploymentRepository.upsertIfNotOlder(
        {
          workspaceId: repo.workspaceId,
          repoId: repo.id,
          provider,
          providerDeploymentId: event.providerDeploymentId,
          commitSha: event.commitSha,
          ref: event.ref,
          environment: event.environment,
          state: event.state,
          environmentUrl: safeEnvironmentUrl(event.environmentUrl),
          occurredAt: event.occurredAt,
        },
        tx,
      );
      return id ? 'recorded' : 'stale';
    });
  },
};
