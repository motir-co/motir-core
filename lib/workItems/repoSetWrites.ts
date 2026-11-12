import type { Prisma } from '@/generated/prisma/client';
import { toWorkItemRepositoryDtos } from '@/lib/mappers/workItemMappers';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemRepoRepository } from '@/lib/repositories/workItemRepoRepository';
import { primaryTargetRepo } from '@/lib/workItems/targetRepo';

// The WRITERS of a work item's repository set — shared by every door that writes
// one (bug MOTIR-6751). They lived privately in `workItemsService`, and
// `plansService`'s approve re-derivation wrote the references by hand beside
// them: the same fact with two writers, only one of which remembered the stored
// name projection. So a container an approved plan re-derived kept the names it
// was created with — or none — while its references moved. One home means the
// next door to derive a container cannot write half of it.
//
// Both require `tx`: they run inside the caller's transaction, whose owner is
// always a service.

/**
 * REPLACE one item's repository REFERENCES with `refs`, in order (Story
 * MOTIR-2732 · MOTIR-3039, ADR `work-item-repository-set.md` "Amendment
 * 2026-08-18" §A2).
 *
 * Delete-then-insert rather than a per-element diff, because a repository set is
 * authored as a whole: element 0 is the primary, so `[a, b]` → `[b, a]` is a
 * different decision and not two no-ops, and `@@unique([workItemId, position])`
 * makes any interleaved patch fight itself. That is also why `position` is a plain
 * ordinal — there is no incremental re-order to keep cheap.
 *
 * Positions are written CONTIGUOUS from 0, which the unique index then enforces:
 * a gap is a database error rather than something a reader has to interpret.
 *
 * Runs inside the caller's transaction (both repository calls require `tx`), so a
 * failed write leaves neither the row nor its references behind.
 */
export async function writeRepoRefs(
  workItemId: string,
  workspaceId: string,
  refs: readonly string[],
  tx: Prisma.TransactionClient,
): Promise<void> {
  await workItemRepoRepository.deleteByWorkItem(workItemId, tx);
  await workItemRepoRepository.createMany(
    refs.map((projectRepoId, position) => ({ workspaceId, workItemId, projectRepoId, position })),
    tx,
  );
}

/**
 * A container's derived set, written as BOTH halves of the one fact (Story
 * MOTIR-2732 · MOTIR-2978).
 *
 * ⚠️ The name projection is not optional here, and leaving it out is invisible.
 * `work_item.targetRepos` is a STORED projection of the references (ADR §A4), and
 * a leaf gets it written by its own create/update — but a container never
 * authors its set, so the rollup is the only writer it has. Writing only the join
 * rows leaves every container with an empty `targetRepos`, and the completion
 * gate reads exactly that column: the story that spans two repositories would
 * complete on its first merge, which is the outcome this whole capability exists
 * to prevent. Caught by MOTIR-3031's gate, which is the seam no unit test on
 * either card could see.
 *
 * Names are RESOLVED through the same rule every reader uses (`toWorkItemRepositoryDtos`
 * — the realized repository's own name, else the row's authored intent), so the
 * projection cannot say something different from what the panel shows.
 *
 * A LEAF's set is derived too when the init-card routing pass supplies it
 * (`projectRepoInitRoutingService`, MOTIR-11042): nobody authored it — the init
 * card's declaration and the settled row produced it — so that pass writes through
 * THIS writer, not `writeRepoRefs`, and the stored projection is never left behind.
 */
export async function writeDerivedRepoSet(
  containerId: string,
  workspaceId: string,
  refs: readonly string[],
  tx: Prisma.TransactionClient,
): Promise<void> {
  await writeRepoRefs(containerId, workspaceId, refs, tx);
  const rows = await workItemRepoRepository.listByWorkItem(containerId, tx);
  const names = toWorkItemRepositoryDtos(rows).map((r) => r.name);
  await workItemRepository.update(
    containerId,
    { targetRepos: names, targetRepo: primaryTargetRepo(names) },
    tx,
  );
}
