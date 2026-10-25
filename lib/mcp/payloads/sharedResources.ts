import type { z } from 'zod/v4';
import { V1_RESOURCE_COMPONENTS } from '@/lib/api/v1/openapi/registry';

// The SHARED-RESOURCE set (Story 11.6 · Subtask 11.6.2 — MOTIR-2228).
//
// "Which resources do BOTH surfaces expose?" is DERIVED here, never listed. The
// source is `V1_RESOURCE_COMPONENTS` — the merged component map
// `lib/api/v1/openapi/registry.ts` assembles from the per-resource
// `operations.ts` modules — so a resource added later joins this set at the
// moment it is registered for the OpenAPI document, with no second list for
// anyone to remember.
//
// That reuse is deliberate. ADR Amendment 4 Q2 created the registry so exactly
// ONE value knows the whole set; a hand-written mirror of it here would be this
// story's own defect one level up — a guard reporting success over a set nobody
// defined. ADR Amendment 7 Q4 records it.

/** Every resource name `/api/v1` publishes a component schema for. */
export type SharedResourceName = keyof typeof V1_RESOURCE_COMPONENTS;

/** The derived set, as a value. Order follows the registry's resource order. */
export const SHARED_RESOURCE_NAMES = Object.keys(
  V1_RESOURCE_COMPONENTS,
) as readonly SharedResourceName[];

/** The v1 schema a shared resource is described by — what a payload's matching
 *  part must validate against.
 *
 *  The non-null assertion is safe by construction and required only by
 *  `noUncheckedIndexedAccess`: `SharedResourceName` IS `keyof` the map, so the
 *  lookup cannot miss. */
export function sharedResourceSchema(name: SharedResourceName): z.ZodType {
  return V1_RESOURCE_COMPONENTS[name]!;
}

/** Membership test usable on an untrusted string. */
export function isSharedResourceName(value: string): value is SharedResourceName {
  return value in V1_RESOURCE_COMPONENTS;
}

/**
 * Shared resources NO MCP tool returns, each with the reason.
 *
 * The coverage rule (11.6.6's guard) is that every name in
 * {@link SHARED_RESOURCE_NAMES} is either PROBED by at least one tool's payload
 * definition or listed here — so "this resource has no MCP check" is a written
 * claim rather than an absence, which is the same discipline
 * `EXEMPT_TOOLS` applies one level down.
 *
 * Entries are added as the family cards discover them; 11.6.6 is where the rule
 * becomes a failing assertion.
 */
export const MCP_UNREACHABLE_RESOURCES: Partial<Record<SharedResourceName, string>> = {
  DispatchRun:
    'No MCP tool READS a dispatch run. The original ruling (Story MOTIR-1789 · MOTIR-1792) kept ' +
    'the whole ingest off MCP because the agent was the SUBJECT of a run, never its reporter. ' +
    'AMENDMENT 3 of `docs/decisions/dispatch-run-record.md` (`agent-reported-runs.md`, Story ' +
    'MOTIR-7446) narrows that: an agent with no CLI around it — the Motir skill in Claude Code, ' +
    'Codex, Kimi — may report its OWN run of a card it holds, through `start_work_item_run`, ' +
    '`report_action` and `close_work_item_run`. Every event it writes is marked ' +
    '`reportedBy: agent`, so its account is never mistaken for a runner’s, and it may send only ' +
    'four milestone kinds. Those tools answer a receipt and a liveness shape (their ' +
    '`EXEMPT_TOOLS` entries), never this resource, and the run READ stays where it was: on ' +
    '`/api/v1` and the UI, for the people and processes that watch runs. The repair and ' +
    'continue tools (MOTIR-6807, MOTIR-7262) keep the same boundary — a lock the agent holds and ' +
    'a narrow liveness answer.',
  DispatchRunCloseOutPrompt:
    'The CLOSE-OUT prompt (Story MOTIR-4906 · MOTIR-5357) is assembled for the process AROUND ' +
    'the agent: the CLI fetches it over `/api/v1` and hands it to one agent before the run marks ' +
    'its pull requests ready. It is a run read, so it shares `DispatchRun`’s reason — no MCP ' +
    'tool returns a run, and the agent receives this text as its prompt rather than calling for it.',
  CurrentTestInstructions:
    'The HOW TO TEST read (Story MOTIR-4906 · MOTIR-5358) serves the CLI’s close-out summary over ' +
    '`/api/v1`. The agent WRITES the record through `publish_test_instructions`, whose result is ' +
    'its own receipt (`{ id, bodyBytes, … }`), not this read; an agent that just wrote the ' +
    'instructions has no use for reading them back, so no MCP payload returns this shape.',
  DispatchRunCard:
    'The run’s LEG rides on `DispatchRun` and shares its reason: no MCP tool returns a run at ' +
    'all, so no payload carries a leg. Listed separately because the guard reads RESOURCES ' +
    'rather than the operations that return them.',
  DispatchRunOpened:
    'The OPEN result (`{ run, created }`) is the ingest’s own envelope and exists only on the ' +
    'operation that has no MCP counterpart. `created` in particular answers a question only a ' +
    'RETRYING reporter asks, and nothing on the agent surface retries an open.',
  DispatchRunAppended:
    'The APPEND result (`{ runId, appended, seq, cards }`) is the ingest’s own envelope, for the ' +
    'same reason. Its `seq` is the reporter’s next cursor — a value that means nothing to a ' +
    'caller which is not the one writing the stream.',
  WorkItemSummary:
    'The `search_work_items` row is a declared NARROWING (`.omit({ createdAt })`). The flat List ' +
    'projection that tool reads does not carry `createdAt`; v1’s collection route sources it from ' +
    'the KEYSET read’s cursor position, which is part of that endpoint’s page addressing and has ' +
    'no equivalent here. Everything else on the row IS the shared schema, `dependencies` included ' +
    '— the block whose absence on `get_work_item` started this story. ⚠️ This is the one entry ' +
    'that is a candidate for CLOSING rather than a permanent difference: if a client ever needs a ' +
    'created timestamp from the MCP search, the fix is a card against the owning story to widen ' +
    'the projection, NOT relaxing the guard.',
  WorkItemDetail:
    '`get_work_item` returns the ISSUE-DETAIL AGGREGATE — `{ item, ancestors, parent, children, ' +
    'blockedBy, …, readiness, workflow, watcherCount }` — because that is the shape an agent reads ' +
    'a card from. v1’s `WorkItemDetail` is the FLAT single-resource form, shaped for a different ' +
    'caller. The envelope stays MCP’s own (ADR Amendment 7 Q6 rule 3); what derives is its ' +
    'resource-valued part, the CHILD rows, which probe `WorkItemRef`.',
  WorkItemLinkGroups:
    'The aggregate publishes the five edge groups as TOP-LEVEL arrays of link DTOs carrying the ' +
    '`work_item_link` row id, which the CLI’s relationship rendering reads. v1 groups bare refs ' +
    'under `links`. No MCP payload returns that grouping, so there is nothing to compare.',
  CommentThread:
    '`add_comment` returns the ONE comment it created, which by definition has no replies — it ' +
    'derives from `commentSchema`, the thread resource’s base. No MCP tool returns a root comment ' +
    'WITH its reply thread: `get_work_item_activity` pages an activity stream whose envelope is ' +
    'MCP’s own.',
  WorkItemCount:
    'ADR Amendment 14 made COUNTING a filtered set its own v1 operation, and the MCP surface has ' +
    'no counterpart: `search_work_items` still reports a `total` on the page itself, which is the ' +
    'shape that amendment moved AWAY from for v1 and deliberately left alone for MCP (an agent ' +
    'reading a page usually wants the number with it). So there is no MCP payload to compare — ' +
    'not a narrowing, an absence. ⚠️ If the MCP search ever drops its `total`, this entry closes ' +
    'and the count becomes a tool that probes this resource.',
  Me:
    '`whoami` answers a different question. v1’s `/me` describes the TOKEN — its `workspaceId` ' +
    'and granted `scopes`; `whoami` returns the RESOLVED user and workspace objects an agent ' +
    'prints. Each PART derives (see `mcpWhoamiSchema`), but neither payload is the other resource.',
  WorkspaceSummary:
    'The workspace `whoami` resolves is a `WorkspaceSummaryDTO` — `{ id, name, slug }` — while ' +
    'v1’s strict schema also requires `createdAt`, which that read does not fetch. It is therefore ' +
    'a declared NARROWING and cannot satisfy the base; adding the column would mean a read this ' +
    'tool has never made.',
  Plan:
    '`get_plan` is a declared NARROWING (see `mcpPlanSchema`): v1’s `proposals` carry a ' +
    '`workItemKey` resolved through a `keyOfId` lookup the v1 route performs and this tool does ' +
    'not. Publishing it here would mean adding that read, or emitting `null` for every proposal ' +
    'that HAS a work item — a field that lies. The divergence is declared rather than hidden.',
  ActivityEntry:
    'The activity page’s ENVELOPE stays MCP’s own, including the `all` view’s OPAQUE composite ' +
    'cursor over two sources. Its entries are the activity DTOs the web surface renders; v1’s ' +
    '`ActivityEntry` is the narrowed wire form. Aligning them is a widening of a paged read that ' +
    'no client has asked for — a card against 11.7 if one ever does, not a divergence to keep quiet.',
  Page:
    'Story MOTIR-9486 publishes the v1 `Page` resource for `/api/v1` integrations. The MCP ' +
    'page tools (`get_page`, `create_page`, `update_page`) return a SUPERSET of it — they add ' +
    '`projectId` and the full version block an agent needs to cite a version — and each is ' +
    'listed in `EXEMPT_TOOLS` with that reason, so no tool payload carries this exact shape to ' +
    'probe. Both surfaces read the same `pagesService.getPageMarkdown` DTO, which is where the ' +
    'body and revision are kept in agreement.',
  PagePlacement:
    'Story MOTIR-9486 (MOTIR-9495) publishes the result of `PATCH /api/v1/pages/{pageId}/placement` ' +
    'as `PagePlacement`. No MCP tool moves a page yet: `move_page` belongs to the sibling story ' +
    '"An agent moves, archives and links pages over the MCP", which reuses the same ' +
    '`pagesService.movePage` door. When that tool lands it probes this resource and this entry ' +
    'closes; it is not a permanent divergence.',
  PageSearchHit:
    'Story MOTIR-9489 (MOTIR-9552) publishes one hit of `GET /api/v1/projects/{projectKey}/pages/search` ' +
    'as `PageSearchHit`. The MCP `search_pages` tool is the sibling card MOTIR-9553, which reads the ' +
    'same `pagesService.searchPages` door; when it lands it probes this resource and this entry ' +
    'closes. It is not a permanent divergence.',
  ScopeClaim:
    'MOTIR-3049’s SCOPE claim ships on `/api/v1` ONLY, and the absence is argued rather than ' +
    'incidental: its caller is `motir run <story-id>` / `motir run sprint` in `packages/cli`, ' +
    'which retired its MCP transport in 11.5.6, so a mirrored tool would be a second ' +
    'implementation with no caller (`tests/api/v1/work-loop-story-gate.test.ts` carries the same ' +
    'argument as that operation’s unmirrored entry). Its SIBLING, the keyed claim, probes ' +
    '`WorkItemClaim` whole — so the shape family IS checked here, on the tool that has an ' +
    'agent-facing reason to exist. ⚠️ If an agent surface is ever added for a scoped run, ' +
    'this entry closes and `claim_scope` probes this resource; it is not a permanent divergence.',
  ProjectRepository:
    'MOTIR-3586 publishes the project\u2019s repository SET on `/api/v1` ONLY, and the absence is ' +
    'argued rather than incidental: its caller is `motir link` in `packages/cli`, which retired ' +
    'its MCP transport in 11.5.6, so a mirrored tool would be a second implementation with no ' +
    'caller \u2014 the same argument `ScopeClaim` above makes. The nearest MCP shape is the ' +
    '`targetRepos` block on `dispatch_prompt`, and it is deliberately NOT this resource: that is ' +
    'a per-ITEM projection carrying `name` / `cloneUrl` / `defaultBranch` / `delivery` for the ' +
    'repositories ONE card ships in, while this is the per-PROJECT row with its `role`, its ' +
    'establish `state` and the derived `established` discriminator. \u26a0\ufe0f If an agent surface ' +
    'ever needs to ask which repositories a project has, this entry closes and that tool probes ' +
    'this resource; it is not a permanent divergence.',
  TransitionList:
    'The list of legal transition targets is published by `GET …/transitions`. On MCP it is ' +
    'not a payload at all: `transition_status` names the allowed targets inside an ERROR ' +
    'message (`IllegalTransitionError`, enriched at the tool), so there is no success ' +
    'structuredContent for the guard to compare.',
  ReviewPrompt:
    'The REVIEW brief (Story MOTIR-1626 · MOTIR-6821) is read over `/api/v1` by `motir review` ' +
    'inside a hosted review container, on the review run’s own token — the one credential the ' +
    'route admits, and one `verifyMcpToken` refuses outright. No MCP tool returns it, and none ' +
    'should: a tool would have no caller (`tests/api/v1/work-loop-story-gate.test.ts` records ' +
    'the same argument for `getWorkItemReviewPrompt`).',
  AgentReviewResult:
    'The VERDICT result (Story MOTIR-1626 · MOTIR-6821) answers the review run’s one ' +
    '`/api/v1` verdict, which decides the card’s `agent_review` gate as the review agent. Its ' +
    'only caller is that run’s own token, which never reaches MCP, and a tool would put a gate ' +
    'decision in reach of an agent credential that is not the review run’s — so there is no ' +
    'MCP payload to compare (`submitWorkItemAgentReview`’s entry in the work-loop story gate).',
  UnbuildableReportAcknowledgement:
    'The run’s UNBUILDABLE report (MOTIR-8698) is posted over `/api/v1` by the `motir` CLI ' +
    'around the agent, on the run’s own credential, which `verifyMcpToken` refuses. Its MCP ' +
    'sibling `report_unbuildable_target` answers the same `{ acknowledged, recordedOnRun }` ' +
    'acknowledgement, and is exempt from the payload guard because an acknowledgement represents ' +
    'no resource (`EXEMPT_TOOLS`), so there is no probed payload to compare this against.',
  RunDiscrepancyAcknowledgement:
    'The run’s DISCREPANCY record (MOTIR-8722) is posted over `/api/v1` by the `motir` CLI ' +
    'around the agent, on the run’s own credential, which `verifyMcpToken` refuses. Its MCP ' +
    'sibling `record_run_discrepancy` answers the same `{ commentId, recorded }` ' +
    'acknowledgement, and is exempt from the payload guard because an acknowledgement represents ' +
    'no resource (`EXEMPT_TOOLS`), so there is no probed payload to compare this against.',
  RunStopReportAcknowledgement:
    'The run’s STOP report (MOTIR-8722) is posted over `/api/v1` by the `motir` CLI around the ' +
    'agent, on the run’s own credential, which `verifyMcpToken` refuses. It has no MCP sibling: ' +
    'an agent with the Motir tools makes the STOP’s calls itself (`add_comment`, ' +
    '`transition_status`, `append_plan_turn`, `submit_plan_session`), so there is no MCP payload ' +
    'to compare this acknowledgement against.',
};
