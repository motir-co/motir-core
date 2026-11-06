// ── Is a proposal's body more than its boundary? (MOTIR-10490) ────────────────
//
// A plan proposal can carry `authorFinished` — the stored fact that an author
// session finished writing the card (`PlanItemProposedFields.authorFinished`).
// A driver sets it through the deepen doors; when a person or an outside agent
// writes a card by hand on a plan no session is working on, core sets it itself
// (`stampHandWrittenBody` in `plansService`), and that stamp asks THIS question
// first: does the body hold anything beyond its `Scope BOUNDARY`?
//
// A card the lay names arrives as a title and, at most, its boundary — the edge
// its siblings were laid against. Writing it is everything after that. So a
// body is "beyond its boundary" when the section parser finds anything other
// than `scopeBoundary` in it: another registry section, the unheaded `framing`,
// or an `otherSections` heading nothing defines (prose a person wrote is
// written, whatever it is called).
//
// ⚠️ IT REUSES CORE'S OWN PARSER (`parseSections`) rather than copying the
// hosted planner's line scan (`isBoundaryOnlyBody`), which reads a boundary
// containing a third-level heading as more than a boundary. The parser keeps a
// `###` heading and a fenced line inside the section they stand in, so a
// boundary that uses either is still only a boundary.
//
// TOTAL: a kind or type the registry has no cell for never throws (a door that
// has not refused such a proposal must not answer a 500 because of this test).
// An unknown kind is read as the leaf default, an unknown type as untyped — the
// boundary heading and `framing` are in every cell, so the answer is the same.
//
// The carry-over card (MOTIR-10491) calls this too, for the plans already open
// when the field shipped. PURE: no DB, no `tx`.

import { isIssueType, type IssueType } from '@/lib/issues/parentRules';
import { WORK_ITEM_TYPES } from '@/lib/issues/executorDefaults';
import { parseSections } from '@/lib/workItems/sections/parse';
import type { SectionType } from '@/lib/workItems/sections/registry';
import { DEFAULT_PROPOSED_KIND } from '@/lib/plans/validateProposals';

function sectionKind(kind: string | null | undefined): IssueType {
  return isIssueType(kind) ? kind : (DEFAULT_PROPOSED_KIND as IssueType);
}

function sectionType(type: string | null | undefined): SectionType {
  return typeof type === 'string' && (WORK_ITEM_TYPES as readonly string[]).includes(type)
    ? (type as SectionType)
    : null;
}

/**
 * True when `body` holds anything except its `Scope BOUNDARY` section.
 *
 * - An empty or missing body answers `false`, and so does a body that is only
 *   an empty boundary heading.
 * - A body with no headings at all answers `true`: it is prose somebody wrote.
 * - A boundary containing a `###` heading or a fenced block is still only a
 *   boundary.
 */
export function hasBodyBeyondBoundary(
  body: string | null | undefined,
  kind: string | null | undefined,
  type: string | null | undefined,
): boolean {
  if (typeof body !== 'string' || body.trim() === '') return false;
  const { sections } = parseSections(body, sectionKind(kind), sectionType(type));
  return Object.entries(sections).some(
    ([name, value]) => name !== 'scopeBoundary' && value !== undefined,
  );
}
