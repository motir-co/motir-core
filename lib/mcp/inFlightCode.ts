import type { AiInFlightCodeFields, InFlightCodeDto } from '@/lib/dto/ai';

// The IN-FLIGHT CODE lines `get_work_item` prints (MOTIR-10069) — where a card's
// UNMERGED code lives, per repository, so an agent planning over the MCP is handed
// the location the hosted planner's `get_item` hands it, rather than hunting for it
// through the card's parent.
//
// ⚠️ MIRRORED, NOT IMPORTED — the twin is motir-ai `src/llm/planTreeTools.ts`
// (`renderInFlightLine`, `renderInFlightCode`, `NO_IN_FLIGHT_CODE_MESSAGE`). motir-ai
// is another repository, so the wording is COPIED, and a change to one is a change
// to both. The one difference is the argument names the line points at: the MCP's
// `read_file` / `list_changed_files` take `repo`, the hosted tools `repoRef`.
//
// THREE STATES, and none of them reads as "the project has no code": entries (one
// `In-flight code:` line each), merged repositories (the default branch has it
// now), and BOTH EMPTY (nothing was ever delivered on the card or a parent). The
// hosted twin's fourth — the fields ABSENT on an older motir-core — cannot arise
// here: this read and the fields ship in the same deployment.

/** Both arrays empty — nothing in flight, nothing merged. */
export const NO_IN_FLIGHT_CODE_MESSAGE =
  'No in-flight code (no open pull request on this item or its parents).';

/** One `In-flight code:` line — the repo and branch are exactly what `read_file`
 *  and `list_changed_files` take as `repo` and `ref` / `head`. */
export function renderInFlightLine(e: InFlightCodeDto): string {
  const parts = [
    `In-flight code: ${e.repo} — branch ${e.branch}${e.headSha ? ` @ ${e.headSha.slice(0, 7)}` : ''}`,
  ];
  if (e.prNumber > 0) parts.push(`PR #${e.prNumber}${e.draft ? ' (draft)' : ''}`);
  if (e.baseRef) parts.push(`base ${e.baseRef}`);
  parts.push(
    e.source === 'inherited' ? `inherited from ${e.fromKey}` : "this item's own pull request",
  );
  return parts.join(' · ');
}

/** The in-flight lines for one item read: one per entry, then the merged line, or
 *  the one empty sentence. */
export function renderInFlightCode(fields: AiInFlightCodeFields): string[] {
  const lines = fields.inFlightCode.map(renderInFlightLine);
  if (fields.mergedRepos.length > 0) {
    lines.push(`Merged to default branch: ${fields.mergedRepos.join(', ')}`);
  }
  return lines.length > 0 ? lines : [NO_IN_FLIGHT_CODE_MESSAGE];
}
