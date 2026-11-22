// The late stack's pending frame carries this attribute, so the item header's
// decision-waiting marker (MOTIR-5878) has somewhere to scroll when it is pressed
// before the section that holds the gate has streamed in. A plain module, so the
// server `LateSections` and the client header marker share one spelling.
export const LATE_FALLBACK_ATTR = 'data-late-stack-fallback';

// The Development block's fragment id on the item page (MOTIR-6611): the To fix
// banner's *See its pull requests* link lands on it, and with scripting off it is
// a plain `#development` anchor. One spelling for the server section and the
// client link.
export const DEVELOPMENT_SECTION_ID = 'development';

// The Pages section's fragment id (Story MOTIR-7565 · MOTIR-7575):
// `/items/<KEY>#pages` lands on it once the late stack has streamed it in.
export const PAGES_SECTION_ID = 'pages';

// The Run discrepancy section's fragment id (Task MOTIR-11996; `design/runs` § _Run
// discrepancy — the record gets its own section_, decision 3): the run modal's findings
// strip lands on `/items/<KEY>#run-discrepancy`, and arriving there opens the section.
export const RUN_DISCREPANCY_SECTION_ID = 'run-discrepancy';
