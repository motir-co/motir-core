import { randomUUID } from 'node:crypto';
import type { Prisma } from '@/generated/prisma/client';

// Single-op data access for `repo_deployment` — the preview deployments a
// repository's own host reports (Story MOTIR-4906 · Subtask MOTIR-5329), and
// the production releases Motir posts for a Motir repository, which arrive by
// the same webhook (MOTIR-10033).
//
// Writes run under withSystemContext from the webhook services (a delivery has
// no tenant session), taking `tx`, which is what binds the GUC the table's
// policies read.
//
// ⚠️ NOTHING IN THE PRODUCT READS THIS TABLE ANY MORE (MOTIR-5691). Its two reads
// fed HOW TO TEST's per-repository preview, which `design/github/design-notes.md`
// § 25 retired: a preview is per SYSTEM — one configured environment for every
// work item — not a per-head derivation. The webhook keeps recording, so the
// history is there for whichever card makes preview a per-system setting.

/** What one delivery writes. `environmentUrl` must already be sanitised. */
export interface RepoDeploymentUpsert {
  workspaceId: string;
  repoId: string;
  provider: string;
  providerDeploymentId: string;
  commitSha: string;
  ref: string;
  environment: string;
  state: string;
  environmentUrl: string | null;
  occurredAt: Date;
}

export const repoDeploymentRepository = {
  /**
   * Record one deployment status, ONE atomic statement.
   *
   * ⚠️ THE OUT-OF-ORDER GUARD LIVES IN THE STATEMENT, NOT IN A READ BEFORE IT.
   * GitHub does not guarantee delivery order, so a late `in_progress` can arrive
   * after the `success` it preceded. The conflict arm updates ONLY when the
   * stored status is not newer (`occurred_at <= EXCLUDED.occurred_at`); an older
   * delivery matches no row, RETURNING yields nothing, and the caller reports
   * `stale`. A read-then-write would race two deliveries for the same deployment
   * — this cannot, because the unique index serialises the conflict inside the
   * statement.
   *
   * A re-delivery of the same status (equal `occurred_at`) rewrites identical
   * values and still leaves one row.
   *
   * Returns the row id, or `null` when the delivery was older than what is stored.
   * `@default(cuid())` and `@updatedAt` are Prisma-side, so the INSERT supplies
   * both (the `ciContainerPeriodCostRepository` precedent: a UUID for the PK).
   */
  async upsertIfNotOlder(
    input: RepoDeploymentUpsert,
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "repo_deployment" (
        "id", "workspace_id", "repo_id", "provider", "provider_deployment_id",
        "commit_sha", "ref", "environment", "state", "environment_url",
        "occurred_at", "created_at", "updated_at"
      )
      VALUES (
        ${randomUUID()}, ${input.workspaceId}, ${input.repoId}, ${input.provider},
        ${input.providerDeploymentId}, ${input.commitSha}, ${input.ref},
        ${input.environment}, ${input.state}, ${input.environmentUrl},
        ${input.occurredAt}, NOW(), NOW()
      )
      ON CONFLICT ("repo_id", "provider", "provider_deployment_id") DO UPDATE SET
        "commit_sha" = EXCLUDED."commit_sha",
        "ref" = EXCLUDED."ref",
        "environment" = EXCLUDED."environment",
        "state" = EXCLUDED."state",
        "environment_url" = EXCLUDED."environment_url",
        "occurred_at" = EXCLUDED."occurred_at",
        "updated_at" = NOW()
      WHERE "repo_deployment"."occurred_at" <= EXCLUDED."occurred_at"
      RETURNING "id"
    `;
    return rows[0]?.id ?? null;
  },
};
