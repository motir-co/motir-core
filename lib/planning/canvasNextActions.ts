// THE CANVAS CARD'S NEXT-ACTION GATE — one rule for every canvas that opts in
// (MOTIR-10509 built the button; MOTIR-12233 turns it on beyond the roadmap).
//
// A canvas card's hover button copies an agent command (`motir run` / `review` /
// `fix` / `guide`) or, on a To plan card, opens the planning overlay. Which of
// those a reader may be offered does not depend on the canvas: it depends on who
// is reading and whether the project's AI is wired. So the decision lives HERE,
// once, and each server page that mounts a member-facing canvas asks it — the
// roadmap page and the item page's child graph read the same answer, and a third
// canvas that opts in cannot drift from them.
//
//   · A VISITOR gets no button at all (design MOTIR-6641 panel 3): the button
//     copies a member's command or opens planning, and a reader with no commands
//     to run and no right to plan must be offered neither.
//   · A member on a project whose AI is NOT configured keeps the copy rows, and a
//     To plan card draws no Plan button (`plan: false`): the overlay it would open
//     has no planner behind it.
//
// Client-safe and framework-free: no `server-only`, no env read. The caller
// passes `aiConfigured` (from `isMotirAiConfigured()` on the server), so this is
// a pure function a test can drive without stubbing the environment.

/**
 * The card's NEXT-ACTION button, opted into by a consumer (MOTIR-10509; design
 * MOTIR-10508 § "The next-action button"). Absent / `null` draws no button.
 */
export interface CardNextActionsOption {
  /** May the reader open the planning overlay (the project's AI is configured and
   *  the reader is a member)? `false` draws no Plan button on a To plan card. */
  plan: boolean;
}

/**
 * The next-action option a member-facing canvas passes to its cards: `null` for a
 * Visitor (no button), otherwise the copy rows on and the Plan row on only when
 * the project's AI is configured.
 */
export function canvasNextActionsFor(reader: {
  visitor: boolean;
  aiConfigured: boolean;
}): CardNextActionsOption | null {
  if (reader.visitor) return null;
  return { plan: reader.aiConfigured };
}
