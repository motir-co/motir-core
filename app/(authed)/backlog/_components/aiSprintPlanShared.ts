// Shared constants for the AI sprint-planning surface (Subtask MOTIR-1750).
//
// The action has ONE implementation and TWO doors (design-notes Part II §2): the
// two-action create-sprint strip on `/backlog`, and the ⌘K palette entry, which
// navigates to `/backlog` carrying `?planSprints=1` and starts the run on
// arrival. Both read the constants below, so the door can never drift from what
// the surface listens for.

/** The query param the ⌘K door sets to auto-start a run on arrival. */
export const PLAN_SPRINTS_PARAM = 'planSprints';

/** The ⌘K door's destination — `/backlog`, with the run already asked for. */
export const PLAN_SPRINTS_HREF = `/backlog?${PLAN_SPRINTS_PARAM}=1`;

/** Where the off-state hint and the disabled failure send the user to fix it. */
export const AI_PLANNING_SETTINGS_HREF = '/settings/project/ai-planning';

/** The `id` of the Run the final check row on that page (MOTIR-11548; design
 *  MOTIR-11547 § "The final check, §3 amended" §3b), so a link can land on it. */
export const FINAL_CHECK_SETTING_ID = 'final-check';

/** The Run the final check row itself — what the Skip the final check dialog opens
 *  in a new tab. */
export const FINAL_CHECK_SETTING_HREF = `${AI_PLANNING_SETTINGS_HREF}#${FINAL_CHECK_SETTING_ID}`;

/** Where the out-of-credits failure sends the user (the shipped billing pane —
 *  the same target `GenerationFlow`'s credits terminal uses). */
export const TOP_UP_HREF = '/settings/organization/billing';
