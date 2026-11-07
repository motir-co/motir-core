// ── Is an `add` WRITTEN? (Story MOTIR-10413 · MOTIR-10496) ─────────────────────
//
// THE ONE ANSWER core gives to "has this proposal's author session finished
// writing it?". It reads the stored fact and nothing else: `authorFinished` on
// the proposal's `proposedFields` (MOTIR-10490), which a planner's driver sends
// once an author session ended successfully and its card passed the driver's own
// check, and which core stamps itself on a card written by hand over the MCP
// while no walk is writing the plan (`stampHandWrittenBody` in `plansService`).
//
// Why a stored fact and not a reading of the body. Since the lay saves each card
// with a `## Scope BOUNDARY` as its only section, a body no longer says whether a
// card is finished — and no reading of the text can tell a whole body a FAILED
// session left behind from a whole body a session finished. So a boundary-only
// body, a long body nobody finished, a choice body its lay wrote and a failed
// session's body all read NOT written here, and a stamped card reads written
// whatever its body says, a one-line body included.
//
// EXACTLY `true` reads written. Absent, `null` and any other value — a string
// `"true"` included — read not written. The SQL twin is
// `(pi."proposed_fields"->'authorFinished' = 'true'::jsonb) IS TRUE` in
// `planItemRepository.findProgressRowsByPlanIds`: an exact JSON comparison, so a
// stored string cannot read written on one path and not on the other.
//
// A `modify` targets a committed card, which has no state: it keeps today's
// meaning (`deriveCommittedStates`). This predicate is for an `add`'s fields.
//
// ⚠️ NO IMPORTS, deliberately. `lib/plans/planProgress.ts` is imported by client
// code (the progress line, the Workbench row), and `lib/plans/authorFinished.ts`
// pulls in the section parser; the predicate must not drag it into a bundle.

/** True only when the proposal's fields carry `authorFinished: true`. */
export function isProposalWritten(
  fields: { authorFinished?: unknown } | null | undefined,
): boolean {
  return fields?.authorFinished === true;
}
