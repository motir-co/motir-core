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

/** Where the off-state hint and the disabled failure send the user to fix it.
 *  Defined in `lib/settings/aiPlanningSettingsLinks.ts` beside the final-check
 *  row's anchor (MOTIR-11548). */
export { AI_PLANNING_SETTINGS_HREF } from '@/lib/settings/aiPlanningSettingsLinks';

/** Where the out-of-credits failure sends the user (the shipped billing pane —
 *  the same target `GenerationFlow`'s credits terminal uses). */
export const TOP_UP_HREF = '/settings/organization/billing';
