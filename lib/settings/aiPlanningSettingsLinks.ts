// Where a surface sends a person to change the project's AI planning settings.
//
// Kept apart from the backlog's AI sprint-planning constants (which re-export
// AI_PLANNING_SETTINGS_HREF) so a component that only links to the settings does
// not pull a member route such as `/backlog?…` into its import closure: the
// planning overlay is rendered by the Visitor tree, whose closure
// `tests/visitor/visitorReaderRoutesGuard.test.ts` scans for raw member routes.

/** Settings › AI planning, for the active project. */
export const AI_PLANNING_SETTINGS_HREF = '/settings/project/ai-planning';

/** The `id` of the Run the final check row on that page (MOTIR-11548; design
 *  MOTIR-11547 § "The final check, §3 amended" §3b), so a link can land on it. */
export const FINAL_CHECK_SETTING_ID = 'final-check';

/** The Run the final check row itself — what the Skip the final check dialog opens
 *  in a new tab. */
export const FINAL_CHECK_SETTING_HREF = `${AI_PLANNING_SETTINGS_HREF}#${FINAL_CHECK_SETTING_ID}`;
