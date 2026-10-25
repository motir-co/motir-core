import type { McpToolName } from '../registry';

// The EXEMPTION + MIGRATION registries (Story 11.6 · Subtask 11.6.2 — MOTIR-2228).
//
// A guard's SILENCE is only information if an absent tool and a deliberately
// excluded one look different. These two maps are what makes them different:
// every tool is derived from a shared schema, or it appears here with a written
// reason, and `toolOk` accepts nothing else.
//
// ADR Amendment 7 Q5 records the decision and the rule for joining the list.

/**
 * Tools whose payload has NO shared resource schema to derive from, because no
 * `/api/v1` operation returns that resource.
 *
 * ⚠️ That is the ONLY thing an exemption means. It is not "we did not get to
 * it", and it is not a per-tool opt-out — a tool that returns a shape v1
 * describes must derive, whether or not it has an endpoint of its own.
 *
 * Adding an entry is a deliberate edit with a reason string, in the same PR as
 * the tool. `MOTIR-2231` (11.6.5) SEALS this against `lib/mcp/registry.ts`:
 * every registered tool must resolve to derived-or-exempt, so a tool in neither
 * column fails the run rather than being skipped.
 */
export const EXEMPT_TOOLS = {
  record_run_discrepancy:
    'Returns an ACKNOWLEDGEMENT — `{ commentId, recorded }` — of a comment it wrote on the ' +
    'card and, when the card had an open dispatch leg, a server-written finding on the run. It ' +
    'represents no resource, and there is no `/api/v1` operation by decision — nothing but the ' +
    'runner that built the card through calls it (decision page MOTIR-8654, MOTIR-8657).',
  report_unbuildable_target:
    'Returns an ACKNOWLEDGEMENT of a server-side finding — `{ acknowledged: true, ' +
    'recordedOnRun }` — and deliberately nothing else: the verdict, the approving plan and any ' +
    'bug filed stay on the server. It represents no resource. Its `/api/v1` sibling, ' +
    '`POST /dispatch-runs/{id}/unbuildable` (MOTIR-8698), is the CLI’s door on the run’s own ' +
    'credential and answers the same acknowledgement ' +
    '(`docs/decisions/run-found-trigger-dispatched-path.md` AMENDMENT 1, MOTIR-6286).',
  get_approved_shape_verdict:
    'Returns a VERDICT — is this card still what the last approved plan approved ' +
    '(`unchanged` / `changed` / `no_plan`), with the diverging revision and the child-set ' +
    'comparison — beside the card’s plan-history page. A judgement computed over the revision ' +
    'log, not a representation of a resource, and no `/api/v1` operation returns either half: ' +
    'the plan history is read by the cookie-authed item page only (MOTIR-6227).',
  record_plan_revision_reason:
    'Returns the recorded EVENT — `{ kind, revisionId, planId, branch, planningBugKey, at }` ' +
    '— and the whole point of the card it ships with is that this event has NO tenant-facing ' +
    'representation AT ALL: a classification of why a plan had to change is Motir’s own ' +
    'judgement about its own planner, excluded from every tenant read at the QUERY. So there ' +
    'is nothing in `/api/v1` to derive from, and there must not be — deriving this from a ' +
    'published component would be the first step toward publishing it. ⚠️ This exemption is ' +
    'therefore LOAD-BEARING rather than a gap to close later: if a v1 component for it ever ' +
    'appears, THAT is the defect, not this line (MOTIR-6086).',
  report_plan_step:
    'Returns the step a planner SESSION just reported — `{ planId, sessionKey, step, ' +
    'targetRef, startedAt }` — an advisory progress signal about a plan being written. The ' +
    'stored step is read back only on the cookie-authed plan review (`inFlightSteps`); no ' +
    '`/api/v1` operation returns a plan step, so there is no component to derive from ' +
    '(MOTIR-7824). A `narration` call returns `{ planId, sessionKey, narration: [{ seq, body }] }` ' +
    '— the sentences it appended, read back only on the same cookie-authed plan review; no ' +
    '`/api/v1` operation returns plan narration either (MOTIR-8062).',
  hold_plan_revision:
    'Returns the state of a plan’s REVISION HOLD after the call — `{ planId, action, held, ' +
    'expiresAt }` — a lease on the plan’s own trail, not a resource. No `/api/v1` operation ' +
    'returns a revision lease (the hosted revision takes it inside the cookie-authed revise ' +
    'route), so there is no component to derive from (MOTIR-7988).',
  validate_work_item:
    'Returns a subtree FINISHABILITY verdict (valid / blockers / advisories) — a planning ' +
    'judgement computed over a tree, not a representation of a resource. No v1 operation ' +
    'exposes it (ADR Amendment 6’s boundary records why no client has asked).',
  validate_sprint:
    'The same verdict shape over a sprint’s membership. Same boundary, same reason — it ' +
    'describes whether a set of work can finish, which is not a thing v1 returns.',
  validate_plan:
    'The same verdict shape again, over the PROJECTED forest of a plan being authored ' +
    '(`{ planId, valid, blockers }`). v1 returns plans, and a plan resource is not this — ' +
    'this is a judgement ABOUT one, computed over a projection that is never persisted ' +
    '(MOTIR-3095).',
  get_project_state:
    'Reports a project’s PLANNING PRECONDITIONS (established?, code connected + indexed?, ' +
    'repo set, onboarding run) — an agent-facing readiness report assembled for dispatch, ' +
    'with no REST client asking for it.',
  get_code_health:
    'Reports each repository’s CODE HEALTH for PLANNING (index state, latest audit summary, ' +
    'derived convention, each section present / absent / unavailable) — a planning read ' +
    'assembled for an agent, the same reason `get_project_state` gives. No `/api/v1` ' +
    'operation returns it, and no REST client has asked for it (MOTIR-7793).',
  get_coding_convention:
    'Returns ONE repository\u2019s coding convention TEXT with its version and author (derived / ' +
    'edited by), or a named `state` (absent / unavailable / repo_not_in_project) \u2014 a read of ' +
    'motir-ai\u2019s convention store assembled for an agent about to write code. No `/api/v1` ' +
    'operation returns a convention document, and no REST client has asked for one (MOTIR-9083).',
  read_file:
    'Returns one repository FILE\u2019s TEXT at a git ref, plus a named `outcome` (found / not_found / ' +
    'ref_not_found / too_large / binary / \u2026 / repo_not_in_project) \u2014 a read made against the ' +
    'git host for an agent planning over the MCP. No `/api/v1` operation returns repository file ' +
    'text, and no REST client has asked for it (MOTIR-7861).',
  code_explore:
    'Returns the hosted planner\u2019s own `code_explore` TEXT verbatim, or a named `state` \u2014 a ' +
    'graph read assembled in motir-ai for an agent planning over the MCP. No `/api/v1` operation ' +
    'returns a code-graph answer, and no REST client has asked for one (MOTIR-7862).',
  code_search:
    'Returns the hosted planner\u2019s own `code_search` TEXT verbatim, or a named `state` \u2014 the ' +
    'same reason as `code_explore` (MOTIR-7862).',
  publish_design_result:
    'Returns the published RESULT\u2019s receipt \u2014 `{ id, workItemKey, assetCount, ' +
    'noteTruncated, createdAt }`. \u26a0\ufe0f `/api/v1` NOW PUBLISHES DESIGN COMPONENTS ' +
    '(`DesignVerdict` / `ApprovedDesign` / `DesignAsset`, MOTIR-5560), so the old reason \u2014 ' +
    'that there was nothing to derive from \u2014 is no longer true and is replaced by the part ' +
    'that is: A RECEIPT IS NOT THE RESOURCE. Those components describe an APPROVED DESIGN as a ' +
    'consumer reads it back; this is the acknowledgement of a WRITE, and the two share almost no ' +
    'fields \u2014 a receipt reports what was accepted (`assetCount`, `noteTruncated`), a design ' +
    'reports what a reader gets (the version, each asset\u2019s state, its links). Deriving one ' +
    'from the other would force one schema to describe both, which is how a publish comes to ' +
    'advertise fields only a read can fill. \u26a0\ufe0f `noteTruncated` is load-bearing rather ' +
    'than decorative: it is how a caller learns the inline note hit the 64 KiB cap and that the ' +
    'complete text lives in the `note_file` asset, which is the difference between a rendering ' +
    'bound and data loss (MOTIR-3782).',
  create_design_upload:
    'Returns UPLOAD GRANTS \u2014 `{ workItemKey, targets: [{ kind, sourcePath, pathname, ' +
    'uploadUrl, contentType, maxBytes }] }`. A presigned PUT URL and the key it is bound to is ' +
    'not a representation of any resource: it is a CAPABILITY that expires in minutes. ' +
    '\u26a0\ufe0f That is now the WHOLE reason. `/api/v1` publishes design components as of ' +
    'MOTIR-5560, so the old clause \u2014 no design-evidence component to derive from \u2014 is ' +
    'false and is gone; what survives is that a grant to WRITE bytes is not a description of the ' +
    'design those bytes become. `DesignAsset` describes a stored, published file \u2014 its ' +
    'state, its size, a short-lived READ link; a target describes a place to PUT one that does ' +
    'not exist yet. \u26a0\ufe0f `maxBytes` is load-bearing rather than decorative: it is the ' +
    'org\u2019s per-file cap, and telling the caller up front is the difference between a ' +
    'refused PUT and an opaque store error (MOTIR-4750).',
  create_acceptance_upload:
    'Returns an UPLOAD GRANT — `{ workItemKey, video: { pathname, uploadUrl, contentType, ' +
    'maxBytes }, trace }`. A presigned PUT URL and the key it is bound to is not a ' +
    'representation of any resource at all: it is a capability that expires in minutes, and ' +
    '`/api/v1` publishes no acceptance-evidence component to derive from either — the receipt ' +
    'is reached over the CI-authed `/api/work-items/[id]/acceptance-evidence` routes and read ' +
    'by the panel server-side. By architecture rather than by omission (MOTIR-4704).',
  publish_acceptance_result:
    'Returns the published RECEIPT\u2019s confirmation \u2014 `{ id, workItemKey, status, ' +
    'chapterCount, sizeBytes, createdAt }`. Same boundary as its design twin above: no v1 ' +
    'operation exposes acceptance evidence, so `V1_RESOURCE_COMPONENTS` has nothing to derive ' +
    'from. \u26a0\ufe0f `status` is load-bearing rather than decorative \u2014 a receipt lands ' +
    '`pending` and only a person moves it to `approved`, so a caller that reads this field ' +
    'learns the publish SUCCEEDED and the story is still not accepted, which is the whole ' +
    'shape of the gate (MOTIR-4704).',
  publish_test_instructions:
    'Returns the published RECORD\u2019s confirmation \u2014 `{ id, workItemKey, repoId, commitSha, ' +
    'created, isCurrent, dispatchRunId, createdAt }`. No `/api/v1` operation exposes a How-to-test ' +
    'record \u2014 the item page reads it server-side \u2014 so there is no shared shape to derive ' +
    'from. `created` is load-bearing: `false` tells a retrying agent its earlier call already ' +
    'landed and nothing changed (MOTIR-5331).',
  link_work_items:
    'Returns the created EDGE ROW (`WorkItemLinkDto` — `id`, `fromId`, `toId`, `kind`, ' +
    '`createdById`). v1 has a link-create endpoint, but its 201 body is an inline ' +
    '`{ toKey, relationship }` declared at the operation — key-addressed, not a registered ' +
    'component, and a different resource from the row. Nothing shared to derive from (MOTIR-2229).',
  unlink_work_items:
    'Returns `{ removed, relationship }` — a removal COUNT. v1’s delete is a 204 with no body ' +
    'at all (idempotent by post-condition), so there is no shared shape (MOTIR-2229).',
  delete_comment:
    'Returns WHAT WAS REMOVED — `{ commentId, workItemKey, parentCommentId, replyCount }`. No ' +
    '`/api/v1` operation deletes a comment (the v1 comments sub-resource is GET + POST only), ' +
    'so there is no shared shape to derive from. `replyCount` is load-bearing rather than ' +
    'decorative: deleting a root takes its whole thread, and a caller must be able to see how ' +
    'much went with it without re-reading the item (MOTIR-5295).',
  list_work_item_todos:
    'Returns a committed work item’s TO-DO LIST — `{ workItemKey, items, progress }`. No ' +
    '`/api/v1` operation returns a work item’s to-do list: the item page reads it through its ' +
    'own Server Actions, and the only to-do shape in v1 is a plan PROPOSAL’s `todos`, which ' +
    'describes a step that does not exist yet (no id, no `done`). So there is no shared shape to ' +
    'derive from. `progress` is load-bearing: it is counted in the same read as the rows, so a ' +
    'caller never pairs a list with a count taken at another moment (MOTIR-6725).',
  add_work_item_todo:
    'Returns the appended step and the list’s progress — `{ workItemKey, todo, progress }`. ' +
    'Same boundary as `list_work_item_todos`: no `/api/v1` operation writes or returns a ' +
    'committed card’s to-do, so there is nothing to derive from. `todo.id` is load-bearing: it ' +
    'is what `set_work_item_todo_done` takes (MOTIR-6725).',
  set_work_item_todo_done:
    'Returns the ticked (or unticked) step and the list’s progress — `{ workItemKey, todo, ' +
    'progress }`. Same boundary as its two siblings. `progress` is read inside the tick’s own ' +
    'transaction, so it describes the list the tick produced (MOTIR-6725).',
  update_work_item_todo:
    'Returns the edited step and the list’s progress — `{ workItemKey, todo, progress }`. Same ' +
    'boundary as its siblings: no `/api/v1` operation writes a committed card’s to-do (MOTIR-7306).',
  delete_work_item_todo:
    'Returns WHAT WAS REMOVED and the list’s new progress — `{ workItemKey, removed: { id, text ' +
    '}, progress }`. Same boundary as its siblings. `progress` is load-bearing: removing a step ' +
    'moves the denominator a caller renders (MOTIR-7306).',
  move_work_item_todo:
    'Returns the moved step and the list’s progress — `{ workItemKey, todo, progress }`, the shape ' +
    '`update_work_item_todo` returns. Same boundary as its siblings: the item page moves a step ' +
    'through its own Server Action and no `/api/v1` operation does (MOTIR-7556).',
  touch_work_item_repair:
    'Returns a REPAIR RUN’s liveness — `{ key, runId, open, status, stopReason, startedAt, ' +
    'endedAt, lastHeartbeatAt }` — the answer an agent holding a repair acts on (stop when ' +
    '`open` is false). v1’s heartbeat is a 204 with no body, and its run read is the whole ' +
    '`DispatchRun` resource, which no MCP tool returns by decision ' +
    '(`MCP_UNREACHABLE_RESOURCES.DispatchRun`). So there is nothing to derive from, and this ' +
    'narrow shape must not grow into that resource (MOTIR-6807).',
  close_work_item_repair:
    'The same repair-run liveness shape as `touch_work_item_repair`, after the close. v1’s close ' +
    'returns the whole `DispatchRun` with its legs, which the agent surface does not carry, for ' +
    'the reason `MCP_UNREACHABLE_RESOURCES.DispatchRun` records; the agent needs only that its ' +
    'repair is closed and how (MOTIR-6807).',
  touch_work_item_continue:
    'Returns a CONTINUE RUN’s liveness — `{ key, runId, open, status, stopReason, startedAt, ' +
    'endedAt, lastHeartbeatAt }` — the answer an agent holding a continue acts on (stop when ' +
    '`open` is false). The same shape and the same reason as `touch_work_item_repair`: v1’s ' +
    'heartbeat is a 204 with no body, and its run read is the whole `DispatchRun` resource, ' +
    'which no MCP tool returns by decision (`MCP_UNREACHABLE_RESOURCES.DispatchRun`) (MOTIR-7262).',
  close_work_item_continue:
    'The same continue-run liveness shape as `touch_work_item_continue`, after the close. v1’s ' +
    'close returns the whole `DispatchRun` with its legs, which the agent surface does not ' +
    'carry, for the reason `MCP_UNREACHABLE_RESOURCES.DispatchRun` records; the agent needs ' +
    'only that its continue is closed and how (MOTIR-7262).',
  start_work_item_run:
    'Returns a RUN RECEIPT — `{ outcome, key, runId, reportedBy, legs: [{ key, title }] }`, or ' +
    '`not_claimed` naming the card the caller does not hold. v1’s open answers the whole ' +
    '`DispatchRunOpened` envelope for the CLI that reports a run; an agent reporting its OWN ' +
    'run (`agent-reported-runs.md`, AMENDMENT 3 of `dispatch-run-record.md`) needs only the id ' +
    'to report into and the cards it covers. The run READ stays unreachable from MCP ' +
    '(`MCP_UNREACHABLE_RESOURCES.DispatchRun`), so this narrow shape must not grow into it ' +
    '(MOTIR-7451).',
  report_action:
    'Returns an APPEND RECEIPT — `{ outcome, runId, accepted, refused: [{ kind, reason }] }`, ' +
    'plus `seq` and the run’s reporter when it wrote, or `touched` for the no-argument ' +
    'heartbeat. v1’s append answers `DispatchRunAppended` with every leg for the CLI’s cursor; ' +
    'the agent needs to know what was stored and what was refused, by kind (MOTIR-7451).',
  close_work_item_run:
    'Returns a CLOSE RECEIPT — `{ closed, alreadyClosed, runId, status, stopReason, endedAt, ' +
    'stamped }`. v1’s close returns the whole `DispatchRun` with its legs, which the agent ' +
    'surface does not carry for the reason `MCP_UNREACHABLE_RESOURCES.DispatchRun` records; ' +
    'the agent needs how its run ended and which cards it is now recorded as the implementer ' +
    'of (MOTIR-7451).',
  delete_work_item:
    'Returns a cascade-delete summary (`totalCount`, `descendantCount`, `byKind`). ADR §3 ' +
    'leaves the irreversible cascade delete OUT of v1 entirely, and `tests/helpers/v1RouteAudit.ts` ' +
    'enforces it with a `reaches-cascade-delete` rule — so no v1 resource exists, by decision ' +
    'rather than by omission (MOTIR-2229).',
  search_work_items_semantic:
    'Returns a RANKING — `{ outcome, results: [{ key, title, score }], model, coverage, message }`. ' +
    'The row is not a work-item representation and is forbidden from becoming one: ' +
    '`plan-tree-embeddings.md` §2 pins it to keys, titles and scores, never prose, so it cannot ' +
    'derive from a resource whose whole job is to describe an item. `score`, `coverage` and ' +
    '`outcome` have no v1 counterpart at all — no v1 operation exposes semantic search ' +
    '(MOTIR-3101).',
  add_lesson:
    'Returns the recorded LESSON (`id`, `title`, its three routing axes, `sourceRef`). The ' +
    'lesson store lives in motir-ai and is reached over the 7.1 boundary; no `/api/v1` ' +
    'operation returns a lesson at all — the only other reader is the AI-planning settings ' +
    'surface, which consumes `ProjectLessonDTO` server-side and never over REST. So there is ' +
    'no shared component to derive from, by architecture rather than by omission ' +
    '(MOTIR-3361).',
  search_lessons:
    'Returns RANKED LESSONS AS PROSE — `{ outcome, lessons: [{ id, title, body, howToApply, ' +
    'scope, kinds, types, phases, distance }] }`. Two reasons it cannot derive: the lesson store ' +
    'lives in motir-ai and no `/api/v1` operation returns a lesson at all (the same reason ' +
    '`add_lesson` is exempt), and `outcome` / `distance` have no v1 counterpart — no v1 ' +
    'operation exposes lesson search. ⚠️ `outcome` is load-bearing rather than decorative: ' +
    '`nothing-matched` and `unavailable` are opposite answers that both carry an empty ' +
    '`lessons`, so a caller reading the payload structurally must be able to tell them apart ' +
    '(MOTIR-3480).',
  reinforce_lesson:
    'Returns WHAT WAS REINFORCED and whether this call counted — `{ id, title, scope, ' +
    'lastOccurredAt, recurrenceCount, counted }`. Exempt for the same reason its two lesson ' +
    'siblings are: the store lives in motir-ai and no `/api/v1` operation returns a lesson at ' +
    'all, so there is no shared component to derive from. ⚠️ `counted` is load-bearing rather ' +
    'than decorative: `false` means the occurrence was ALREADY on the ledger, so nothing was ' +
    'written and both counters stand — a caller reading the payload structurally must be able ' +
    'to tell that from a fresh record without parsing the prose (MOTIR-3553).',
  link_pull_request:
    'Returns the DECLARED LINK — `{ key, created, pullRequest: { repo, number, url, ' +
    'title, state, ci } }`. The row is a `LinkedPullRequestDto`, the shape the ' +
    'item detail page’s Development section renders, and no `/api/v1` operation returns a ' +
    'change request at all — the linking table is reached only through the webhook, the ' +
    'detail-page picker and now this tool. `created` has no v1 counterpart either, and it is ' +
    'load-bearing rather than decorative: it says the row existed only because this call wrote ' +
    'it (no delivery had arrived) (MOTIR-3526). ⚠️ `movedFrom` is GONE (MOTIR-3757): it named ' +
    'the item a singular foreign key had been taken off, and with that column dropped a link ' +
    'ADDS rather than moving, so there is no move to report — a caller that read it can stop.',
  unlink_pull_request:
    'Returns WHAT WAS REMOVED — `{ key, removed, pullRequest }`, where `pullRequest` is the ' +
    '`owner/name#number` coordinate the caller addressed. Exempt for the same reason its sibling ' +
    'is: no `/api/v1` operation returns a change request at all, so there is no shared component ' +
    'to derive from. ⚠️ `removed` is load-bearing rather than decorative — `false` means the ' +
    'pull request and the item both EXIST and were simply not linked (a retry, or a correction ' +
    'already made), which a caller must be able to tell from a real removal without parsing the ' +
    'prose. An unknown repository or number does not reach this payload at all; it raises ' +
    '(MOTIR-3756).',
  delete_sprint:
    'Returns `{ sprintId, deleted }` — a deletion acknowledgement. v1’s sprint delete answers ' +
    '204 with no body (the post-condition is the whole contract), so there is no shared shape ' +
    'to derive from (MOTIR-2230).',
  get_page:
    'Returns a PAGE as an agent reads it — `{ id, projectId, title, placement, revision, ' +
    'latestVersion, markdown, updatedAt }`. The `/api/v1` `Page` resource (MOTIR-9493) is a ' +
    'SUBSET of it: it leaves out `projectId` (a project is a KEY on the wire) and the ' +
    '`version` block of a one-version read, so this payload cannot be derived from it; both ' +
    'are presented from the same `PageMarkdownDto`. `revision` is load-bearing: it is what ' +
    '`update_page` must send back (MOTIR-7410).',
  create_page:
    'Returns the new PAGE exactly as `get_page` reads it (MOTIR-7411) — a superset of the ' +
    '`/api/v1` `Page` resource, for the reason `get_page` gives, so there is no shared shape ' +
    'to derive from.',
  update_page:
    'Returns the saved PAGE exactly as `get_page` reads it, at its new `revision` (MOTIR-7411) ' +
    '— a superset of the `/api/v1` `Page` resource, for the reason `get_page` gives, so there ' +
    'is no shared shape to derive from.',
  rename_page:
    'Returns the renamed page’s summary — `{ id, projectId, title, position, revision, updatedAt }` ' +
    '(MOTIR-8841). No `/api/v1` operation returns a page, so there is no shared shape to derive from.',
  archive_page:
    'Returns what an archive took — `{ archivedIds, rootId, subPageCount }` — or what a restore ' +
    'brought back and where it landed — `{ restoredIds, landing }` (MOTIR-9557). No `/api/v1` ' +
    'operation archives or restores a page, so there is no shared shape to derive from.',
  link_page:
    'Returns the hand-link PAIR — `{ pageId, workItemId, source, action, changed }` (MOTIR-9558). ' +
    'No `/api/v1` operation returns a link pair, so there is no shared shape to derive from.',
  publish_decision_page:
    'Returns the PUBLICATION — which version of which page is the card’s decision, and the gate ' +
    'it raised (MOTIR-7434). No `/api/v1` operation returns a publication, so there is no shared ' +
    'shape to derive from.',
} as const satisfies Partial<Record<McpToolName, string>>;

/** A tool the exemption registry covers. */
export type ExemptToolName = keyof typeof EXEMPT_TOOLS;

/**
 * ⚠️ SEALED by MOTIR-2231 (11.6.5). This map is EMPTY and stays empty.
 *
 * It existed only because Story 11.6 landed the seam (11.6.2) before the three
 * family cards that moved ~30 tools through it, and a commit that leaves the
 * tree red is not a commit. Every entry named the card that would remove it; all
 * three landed, so every registered tool is now DERIVED or EXEMPT and there is
 * no third column.
 *
 * The `unmigrated` constructor was deleted with the last entry. If a tool ever
 * needs staging again, restore both TOGETHER and card each entry — what must
 * never happen is a tool moving into {@link EXEMPT_TOOLS} to make a card finish,
 * because "no shared resource exists" and "nobody has done it yet" are different
 * facts and only one of them is permanent.
 */
export const MIGRATING_TOOLS = {} as const satisfies Partial<Record<McpToolName, string>>;

/** A tool still awaiting its family card. Empty since MOTIR-2231. */
export type MigratingToolName = keyof typeof MIGRATING_TOOLS;

/** Whether a tool is exempt (runtime form, for the registry walk 11.6.5 seals). */
export function isExemptTool(name: McpToolName): name is ExemptToolName {
  return name in EXEMPT_TOOLS;
}

/** Whether a tool is still staged for a family card. */
export function isMigratingTool(name: McpToolName): name is MigratingToolName {
  return name in MIGRATING_TOOLS;
}
