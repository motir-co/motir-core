import type { PlanItemPatch, RescopeField } from '@/lib/dto/plans';

/**
 * THE RE-SCOPE RESET (bug MOTIR-5359) — the one definition of *"this `modify`
 * changes the WORK a card describes"*, read by BOTH the approve
 * (`plansService.applyModify`) and the review diff (`planReviewService.buildChanges`).
 *
 * ⚠️ WHY ONE DEFINITION. The reviewer is shown *"status → To Do (re-scoped while
 * Implemented)"* BEFORE pressing approve, and the approve then performs the reset.
 * Two predicates would let the surface promise a reset the approve does not make,
 * or make one the surface never showed — the review-shows-what-approve-does drift
 * MOTIR-3868 and MOTIR-3070 were both filed about.
 *
 * WHAT COUNTS (the requester's decision, 2026-09-13): a changed `title`, a changed
 * `descriptionMd`, or any re-pin of the repository axis. The comparisons are the
 * review diff's own — raw patch against the live row — so a row appears on the
 * surface exactly when this returns true.
 *
 * WHAT DOES NOT, deliberately: `type`, `storyPoints` and `estimateMinutes` are
 * re-classification and re-sizing, not a change to the work; `priority`,
 * `explanationMd`, `parentRef` and the edge carriers (`blockedByAdd` /
 * `blockedByRemove`) change where a card sits, why it matters or what gates it —
 * never what it asks a runner to build.
 */
export function patchRescopes(
  patch: PlanItemPatch | null | undefined,
  target: RescopeTarget,
): boolean {
  return rescopingFields(patch, target).length > 0;
}

/** The live fields {@link patchRescopes} compares a patch against. */
export interface RescopeTarget {
  title: string;
  descriptionMd: string | null;
  targetRepo: string | null;
  targetRepos: readonly string[];
}

/**
 * WHICH fields of `patch` re-scope its target, in a fixed order — the same
 * comparisons {@link patchRescopes} answers with, so the write door's warning
 * (MOTIR-10106) can name what tripped it without a second definition.
 */
export function rescopingFields(
  patch: PlanItemPatch | null | undefined,
  target: RescopeTarget,
): RescopeField[] {
  if (!patch) return [];
  const fields: RescopeField[] = [];
  if (patch.title !== undefined && patch.title !== target.title) fields.push('title');
  if (patch.descriptionMd !== undefined && patch.descriptionMd !== (target.descriptionMd ?? null)) {
    fields.push('descriptionMd');
  }
  if (repositoryRepinned(patch, target)) fields.push('repository');
  return fields;
}

function repositoryRepinned(patch: PlanItemPatch, target: RescopeTarget): boolean {
  if (
    patch.targetRepo !== undefined &&
    blankToNull(patch.targetRepo) !== blankToNull(target.targetRepo)
  ) {
    return true;
  }
  if (patch.targetRepos !== undefined && !sameOrderedNames(patch.targetRepos, target.targetRepos)) {
    return true;
  }
  // The three spellings that name a ROW or a ROLE cannot be compared against the
  // live row without a read neither caller makes, so — exactly like the review
  // diff's rows for them — their PRESENCE is the re-pin.
  return (
    patch.targetRepositories !== undefined ||
    patch.targetRepositoryRef !== undefined ||
    patch.targetRepoRole !== undefined
  );
}

function blankToNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function sameOrderedNames(a: readonly string[], b: readonly string[]): boolean {
  const norm = (xs: readonly string[]) => xs.map((x) => x.trim()).filter((x) => x.length > 0);
  const na = norm(a);
  const nb = norm(b);
  return na.length === nb.length && na.every((x, i) => x === nb[i]);
}
