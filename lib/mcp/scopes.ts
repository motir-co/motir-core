import type { PermissionKey } from '@/lib/permissions/catalog';
import type { McpToolName } from './registry';

// ⚠️ THE LEGACY TABLE — read `docs/decisions/token-permissions.md`
// (Story MOTIR-2572 · Subtask MOTIR-2573/-2574, 2026-08-10).
//
// This module used to define the LIVE capability vocabulary for an API token:
// six `TokenScope` values, a `TOOL_SCOPES` map over every MCP tool, a default
// grant and the CLI's fixed grant. All four are gone. A token now GRANTS
// `PermissionKey`s from `lib/permissions/catalog.ts`; the model lives in
// `lib/tokens/grant.ts` and the tool map in `lib/mcp/toolPermissions.ts`.
//
// What remains here is the FORWARD MAP for the six strings already sitting in
// `api_token.scopes` rows, and the type that keys it. `TokenScope` is that key
// type and nothing else: it is not a live vocabulary, and NOTHING NEW may be
// typed against it.
//
// ── ⚠️ THE @deprecated BLOCK AT THE FOOT OF THIS FILE IS SCAFFOLDING ────────
// Retiring the four old exports and re-pointing their consumers cannot happen in
// one commit without collapsing MOTIR-2575 / -2576 / -2577 / -2579 / -2580 /
// -2581 / -2583 into this one — every card in the story reads one of them. So
// they survive as `@deprecated` re-exports, each naming the CARD that deletes it,
// and the tree typechecks at every commit on the way. The last card to leave
// removes the block; MOTIR-2585's guard then asserts no live import of the
// retired vocabulary survives outside this legacy table. If you are reading this
// on `main` after MOTIR-2572 merged, the block should not exist — that it does is
// a finding, not a convention.
//
// ── The superseded statement, quoted so the reversal reads as a reversal ────
// The header this file carried until MOTIR-2573 said:
//
//   Per-token SCOPES — the capability boundary for an API token (Story 7.7 ·
//   Subtask 7.7.16). A scope decides which MCP operations a given token may
//   perform; it NARROWS (never widens) the token owner's existing 6.4
//   workspace/project role. The two compose at dispatch (7.7.17): an operation
//   is allowed only if the token's role permits it AND the token carries the
//   scope it maps to.
//
//   "scopes", NOT "permissions" — the durable industry convention for API-token
//   capabilities (GitHub classic-PAT *scopes*, Linear/Slack/Atlassian-OAuth
//   *scopes*). Motir already uses "permissions" for the project access model — a
//   named catalog in `lib/permissions/catalog.ts` that each role holds a SET over
//   (MOTIR-2255) — so reusing that word here would collide. The two axes COMPOSE
//   and never merge: a permission says what the token's owner may do, a scope
//   narrows what this particular token may do on their behalf.
//
// It rested on a premise that expired — that the catalog was a project-access
// model too narrow to describe what a token reaches — and the ADR records why,
// with dates. The COMPOSITION rule in the first paragraph survives verbatim and
// is restated in `lib/tokens/grant.ts`; only the naming claim is retired. No
// card may cite the paragraph above as current.

/**
 * The six scope strings Story 7.7 minted tokens with, and that live in
 * `api_token.scopes` rows to this day.
 *
 * Kept ONLY to key {@link LEGACY_SCOPE_PERMISSIONS} and to recognise a stored
 * value. Not offered anywhere, not persisted by any new write.
 */
export const LEGACY_TOKEN_SCOPES = [
  'read',
  'work_items:write',
  'work_items:archive',
  'work_items:delete',
  'sprints:write',
  'integration',
] as const;

/** One legacy scope string — the key type of {@link LEGACY_SCOPE_PERMISSIONS}. */
export type TokenScope = (typeof LEGACY_TOKEN_SCOPES)[number];

/** Whether an untrusted stored string is one of the six legacy scopes. */
export function isLegacyTokenScope(value: unknown): value is TokenScope {
  return typeof value === 'string' && (LEGACY_TOKEN_SCOPES as readonly string[]).includes(value);
}

/**
 * The FORWARD MAP (ADR §5) — what each stored legacy scope confers, expressed
 * in the permission vocabulary. Applied when a token is READ; nothing rewrites
 * a row and no migration runs.
 *
 * Each entry is the set of permissions that scope's OPERATIONS assert, taken
 * from `lib/mcp/toolPermissions.ts`:
 *
 *   * `read` — every read bottoms out in `assertCanBrowse`.
 *   * `work_items:write` — its tools split FOUR ways once the real gates are
 *     named: the work-item writes (`work_item:edit`), `add_comment`
 *     (`comment:add`), the four planning submits (`ai:plan`), and — since
 *     MOTIR-2988 — `add_plan_items` (`ai:view_plan`). Expanding to all of them
 *     is what keeps an existing token working; the SPLIT is what lets a NEW
 *     token withhold planning, commenting or plan authoring.
 *
 *     ⚠️ `ai:view_plan` joined 2026-08-18 because `add_plan_items` is the first
 *     MCP tool to assert it, and this map must confer whatever `TOOL_SCOPES`
 *     files under a scope or a legacy row silently loses a tool
 *     (`tests/tokens/story-gate.test.ts` asserts exactly that). It confers no
 *     other reach over MCP: neither `approvePlan` nor `declinePlan` is an MCP
 *     tool, so the widening is one tool wide HERE.
 *
 *     ⚠️ AMENDED 2026-08-19 (MOTIR-3021): "not token-reachable at all" is no
 *     longer true of `approvePlan`. It has a bounded `/api/v1` entrance —
 *     `POST /api/v1/work-items/{key}/plan-approval` — which an operator's
 *     `motir auto --auto-approve-replan` drives. It is NOT an MCP tool,
 *     deliberately (`docs/decisions/run-findings-protocol.md` Q2), so the
 *     sentence above stays correct about this map and wrong only about the API
 *     as a whole. `declinePlan` remains unreachable by any token.
 *
 *     ⚠️ AMENDED AGAIN 2026-08-20 (MOTIR-3188), and the two amendments met at a
 *     merge. The 3021 note said that entrance is "gated by this same key". It is
 *     not any more: the plan DECISIONS moved to `ai:decide_plan`, so the route
 *     declares that one and this legacy map cannot confer it at all — no legacy
 *     scope expands to a key no MCP tool asserts. So a legacy token's reach over
 *     approval is now zero by CONSTRUCTION rather than by the absence of a
 *     route, which is the stronger of the two reasons and survives the next
 *     entrance somebody adds. What a legacy `work_items:write` still confers is
 *     `ai:view_plan`, i.e. plan AUTHORING and nothing else.
 *   * `work_items:archive` / `work_items:delete` — the two-scope split is BACK,
 *     and each maps to the key its own operations now assert.
 *
 *     ⚠️ AMENDED 2026-08-26 (MOTIR-3629). This entry used to read: "both archive
 *     and delete assert `work_item:delete`, so the old two-scope split has no
 *     counterpart in the gates." It was true and it was the evidence: a legacy
 *     vocabulary carrying a distinction the new one could not express is a
 *     missing term announcing itself, and `work_item:archive` is that term. So
 *     `work_items:archive` expands to `work_item:archive` alone, which RESTORES
 *     what that string meant when it was minted — a token that could hide a row
 *     and not destroy a tree. That is a NARROWING of a stored row, which is
 *     always legal here; the direction stale data may never take is WIDER.
 *
 *     `work_items:delete` keeps `work_item:delete`, and its holder keeps
 *     archiving: `PERMISSION_IMPLICATIONS` confers archive from delete at
 *     resolution, so nothing minted under either string lost an operation. This
 *     also closes the second half of ADR §5's accepted merge — the
 *     archive → delete direction, where a token granted only the recoverable
 *     operation had silently gained the irreversible one.
 *   * `sprints:write` — `assertCanManageSprints` / `assertCanGroom`.
 *   * `integration` — `markIntegrated` / `completeSession` reach
 *     `applyStatusTransition → assertCanEdit`, the same gate `transition_status`
 *     reaches.
 *
 * ⚠️ `integration` and `work_items:write` therefore MERGE at `work_item:edit`,
 * and that is the one place the forward map does not preserve exactly. ADR §5
 * states the direction (each gains the other's operations), why it is accepted
 * (no catalog key is added in this story, `∩ role` still caps both, and no
 * irreversible operation is reached), and that neither shipped default grant has
 * the shape that would expose it.
 */
export const LEGACY_SCOPE_PERMISSIONS: Record<TokenScope, readonly PermissionKey[]> = {
  read: ['project:browse'],
  'work_items:write': ['work_item:edit', 'comment:add', 'ai:plan', 'ai:view_plan'],
  'work_items:archive': ['work_item:archive'],
  'work_items:delete': ['work_item:delete'],
  'sprints:write': ['sprint:manage'],
  integration: ['work_item:edit'],
};

// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ DEPRECATED SCAFFOLDING — see the header. Each export below is read by a
// consumer a LATER card in MOTIR-2572 re-points, and is deleted by that card.
// Nothing new may import from this block.
// ─────────────────────────────────────────────────────────────────────────────

/** @deprecated Use `GRANTABLE_PERMISSIONS` (`lib/tokens/grant.ts`). Removed by MOTIR-2581. */
export const TOKEN_SCOPES = LEGACY_TOKEN_SCOPES;

/** @deprecated Use `isGrantable` / `isLegacyTokenScope`. Removed by MOTIR-2575. */
export const isTokenScope = isLegacyTokenScope;

/** @deprecated Use `DEFAULT_TOKEN_GRANT` (`lib/tokens/grant.ts`). Removed by MOTIR-2580. */
export const DEFAULT_TOKEN_SCOPES: TokenScope[] = LEGACY_TOKEN_SCOPES.filter(
  (scope) => scope !== 'work_items:delete',
);

/** @deprecated Use `CLI_TOKEN_GRANT` (`lib/mcp/toolPermissions.ts`). Removed by MOTIR-2579. */
export const CLI_TOKEN_SCOPES: TokenScope[] = ['read', 'work_items:write', 'integration'];

/**
 * @deprecated Use `TOOL_PERMISSIONS` (`lib/mcp/toolPermissions.ts`). Removed by
 * MOTIR-2581, which re-points the last reader (the published `/docs` MCP page).
 *
 * The 7.7.16 table, verbatim. It is NOT re-derived from `TOOL_PERMISSIONS`: the
 * two disagree by design (`add_comment` and the four planning submits move out
 * of `work_items:write`, archive joins delete), and a shim that pretended
 * otherwise would make the docs page render the new split under the old names —
 * the exact drift this story removes.
 */
export const TOOL_SCOPES: Record<McpToolName, TokenScope> = {
  get_work_item: 'read',
  get_design: 'read',
  list_designs: 'read',
  // Bug MOTIR-6191's gate read — a read, under the legacy scope vocabulary too.
  get_approval_gate: 'read',
  get_work_item_activity: 'read',
  list_ready: 'read',
  next_ready: 'read',
  dispatch_prompt: 'read',
  search_work_items: 'read',
  whoami: 'read',
  list_projects: 'read',
  get_project_state: 'read',
  get_code_health: 'read',
  get_coding_convention: 'read',
  read_file: 'read',
  code_explore: 'read',
  code_search: 'read',
  skeleton: 'read',
  list_folders: 'read',
  get_section_sets: 'read',
  // MOTIR-7410 — a page read. Mapped into the RETIRED vocabulary only because
  // this table is total over the registry; its real gate is `page:view`.
  get_page: 'read',
  // MOTIR-7411 — the page writes. Filed under `work_items:write` for totality
  // only; their real gate is `page:edit`.
  create_page: 'work_items:write',
  update_page: 'work_items:write',
  rename_page: 'work_items:write',
  // MOTIR-9553 — the page search. `read` for totality only; its real gate is `page:view`.
  search_pages: 'read',
  // MOTIR-9556 — the page move, a write; its real gate is `page:edit`.
  move_page: 'work_items:write',
  // MOTIR-9557 — the page archive / restore, a write; its real gate is `page:edit`.
  archive_page: 'work_items:write',
  // A WRITE: it seals a page version, records the publication and may raise a gate.
  publish_decision_page: 'work_items:write',
  // The SEMANTIC search (MOTIR-3101). A read at the gate — `assertCanBrowse` and
  // nothing more — which is what this legacy table records. That it also spends
  // an AI call is bounded by the `ai:chat` rate limit inside the tool, not by a
  // scope: this vocabulary has no billing axis at all, which is one of the things
  // `docs/decisions/token-permissions.md` §3 replaced it to fix.
  search_work_items_semantic: 'read',
  list_sprints: 'read',
  validate_sprint: 'read',
  validate_work_item: 'read',
  // The plan-level validity verdict (MOTIR-3095), mapped into the RETIRED
  // six-scope vocabulary only because this table is total over the registry and
  // a new tool would not compile without a row. `read` is honest here in a way
  // `create_plan`'s `work_items:write` is not: it is a pure read, and its REAL
  // gate (`TOOL_PERMISSIONS` → `project:browse`) is the same class. This row
  // governs nothing but the deprecated docs rendering.
  validate_plan: 'read',
  get_plan_status: 'read',
  get_plan: 'read',
  // The approved-shape verdict (MOTIR-6227). A pure READ, and still filed under
  // `work_items:write` rather than `read`, because this row decides which legacy
  // scope's forward map must carry its REAL gate (`TOOL_PERMISSIONS` →
  // `ai:view_plan`). `read` does not carry it, and must not start to: a stale
  // `read` token would gain every plan tool at once. `work_items:write` already
  // carries it for the six plan-authoring neighbours, so this adds no loss and no
  // widening (`tests/mcp/scopes.test.ts`'s forward-map check).
  get_approved_shape_verdict: 'work_items:write',
  // The run-found report (MOTIR-6286). A write onto the caller's run leg, gated
  // on `work_item:edit` (`TOOL_PERMISSIONS`); `work_items:write`'s forward map
  // already carries that key, so this row adds no loss and no widening
  // (`tests/mcp/scopes.test.ts`'s forward-map check).
  report_unbuildable_target: 'work_items:write',
  // The run discrepancy record (MOTIR-8657). A comment on the card and a finding on the
  // caller's run leg, gated on `work_item:edit` (`TOOL_PERMISSIONS`); `work_items:write`'s
  // forward map already carries that key, so this row adds no loss and no widening.
  record_run_discrepancy: 'work_items:write',
  open_plan_session: 'read',
  // The plan-AUTHORING door (MOTIR-2988), mapped into the RETIRED six-scope
  // vocabulary only because this table is total over the registry and a new tool
  // would not compile without a row. Both are writes, and `work_items:write` is
  // the nearest thing the legacy set has — it is the scope the four planning
  // submits above already sit under here, and the reason it is wrong in the same
  // way for all of them is exactly what `docs/decisions/token-permissions.md` §3
  // replaced this table to fix. The REAL gates are in `TOOL_PERMISSIONS`
  // (`create_plan` → `work_item:edit`, `add_plan_items` → `ai:view_plan`); this
  // row governs nothing but the deprecated docs rendering.
  create_plan: 'work_items:write',
  add_plan_items: 'work_items:write',
  update_plan_item: 'work_items:write',
  // The correction door (MOTIR-3541) — the same scope as the deepen it sits
  // beside: both write to a plan's proposals and neither reaches a work item.
  update_plan_proposal: 'work_items:write',
  withdraw_plan_proposal: 'work_items:write',
  // The plan's OWN title / summary (MOTIR-4637) — same scope again, and for the
  // same reason: it writes to a plan row and reaches no work item.
  update_plan: 'work_items:write',
  record_plan_revision_reason: 'work_items:write',
  // A planner session's step (MOTIR-7824) — a plan-side write reaching no work item.
  report_plan_step: 'work_items:write',
  // A plan's revision hold (MOTIR-7988) — a plan-side write reaching no work item.
  hold_plan_revision: 'work_items:write',
  create_work_item: 'work_items:write',
  update_work_item: 'work_items:write',
  transition_status: 'work_items:write',
  claim_next_ready: 'work_items:write',
  // The KEYED claim (MOTIR-2961) — the same write as `claim_next_ready`, on a
  // card named rather than picked.
  claim_work_item: 'work_items:write',
  add_comment: 'work_items:write',
  // `edit_comment` / `delete_comment` (MOTIR-5295) — beside their add, in the
  // same legacy bucket; the real gate is `comment:add` in `toolPermissions.ts`.
  edit_comment: 'work_items:write',
  delete_comment: 'work_items:write',
  // The to-do tools (MOTIR-6725 · MOTIR-7306) — the read under `read`, the
  // writes in the legacy write bucket; the real gates are in `toolPermissions.ts`.
  list_work_item_todos: 'read',
  add_work_item_todo: 'work_items:write',
  set_work_item_todo_done: 'work_items:write',
  update_work_item_todo: 'work_items:write',
  delete_work_item_todo: 'work_items:write',
  move_work_item_todo: 'work_items:write',
  // The repair tools (MOTIR-6807) — three writes, in the legacy write bucket; the
  // real gate is `work_item:edit` in `toolPermissions.ts`.
  claim_work_item_repair: 'work_items:write',
  touch_work_item_repair: 'work_items:write',
  close_work_item_repair: 'work_items:write',
  // The continue tools (MOTIR-7262) — the same three-write shape as repair.
  claim_work_item_continue: 'work_items:write',
  touch_work_item_continue: 'work_items:write',
  close_work_item_continue: 'work_items:write',
  // The run tools (MOTIR-7451) — three writes, the same legacy write bucket.
  start_work_item_run: 'work_items:write',
  report_action: 'work_items:write',
  close_work_item_run: 'work_items:write',
  // `add_lesson` (MOTIR-3361). This legacy table records the 7.7.16 vocabulary,
  // which has no lesson axis at all — the real gate is the PERMISSION
  // (`lesson:manage`, in `toolPermissions.ts`). Filed under `work_items:write`
  // as the nearest write bucket, exactly as `add_comment` is, rather than
  // inventing a scope in a table this story deprecates.
  add_lesson: 'work_items:write',
  // `search_lessons` (MOTIR-3480). Same note as its write sibling above: this
  // legacy table has no lesson axis, and the real gate is the PERMISSION
  // (`lesson:view`, in `toolPermissions.ts`). A READ, so it files under `read`.
  search_lessons: 'read',
  // `reinforce_lesson` (MOTIR-3553). Same note as both siblings: this legacy
  // table has no lesson axis, and the real gate is the PERMISSION
  // (`lesson:reinforce`, in `toolPermissions.ts`). A WRITE — it records an
  // occurrence and moves a lesson's clock — so it files beside `add_lesson`
  // under the nearest write bucket rather than inventing a scope in a table this
  // story deprecates.
  reinforce_lesson: 'work_items:write',
  // A WRITE: it puts a row on the item and spends the org's storage quota.
  attach_file: 'work_items:write',
  publish_design_result: 'work_items:write',
  // Step 1 of the same publish (MOTIR-4750): a WRITE, because it mints an
  // object-store grant. The real gate is the PERMISSION (`work_item:edit`, in
  // `toolPermissions.ts`); this deprecated table only needs the nearest bucket.
  create_design_upload: 'work_items:write',
  // The acceptance publish pair (MOTIR-4704). Both are writes on the same
  // bucket as the design publisher beside them: one mints an object-store grant
  // and spends the org's storage quota, the other puts the receipt row on the
  // story. The real gate is the PERMISSION (`work_item:edit`, in
  // `toolPermissions.ts`); this deprecated table only needs the nearest bucket.
  create_acceptance_upload: 'work_items:write',
  publish_acceptance_result: 'work_items:write',
  // `publish_test_instructions` (MOTIR-5331) — a WRITE: it puts a record on the
  // item. The real gate is `work_item:edit` in `toolPermissions.ts`.
  publish_test_instructions: 'work_items:write',
  // `link_pull_request` (MOTIR-3526). A WRITE — it sets the change-request row's
  // `work_item_id`, and may create the row itself. This legacy table has no
  // integration-link axis finer than `integration`, which is the MERGE report's
  // scope, not an item edit; `work_items:write` is the nearest bucket and the
  // real gate is the PERMISSION (`work_item:edit`, in `toolPermissions.ts`).
  link_pull_request: 'work_items:write',
  // `unlink_pull_request` (MOTIR-3756). A WRITE for the same reason and under the
  // same bucket as its sibling — it removes a delivery row. This legacy table has
  // no integration-link axis finer than `integration`, which is the MERGE report's
  // scope rather than an item edit, and the real gate is the PERMISSION
  // (`work_item:edit`, in `toolPermissions.ts`) — the same key the link asserts.
  unlink_pull_request: 'work_items:write',
  expand_item: 'work_items:write',
  append_plan_turn: 'work_items:write',
  submit_plan_session: 'work_items:write',
  link_work_items: 'work_items:write',
  unlink_work_items: 'work_items:write',
  move_to_parent: 'work_items:write',
  create_folder: 'work_items:write',
  update_folder: 'work_items:write',
  delete_folder: 'work_items:write',
  change_kind: 'work_items:write',
  archive_work_item: 'work_items:archive',
  unarchive_work_item: 'work_items:archive',
  delete_work_item: 'work_items:delete',
  create_sprint: 'sprints:write',
  update_sprint: 'sprints:write',
  delete_sprint: 'sprints:write',
  start_sprint: 'sprints:write',
  complete_sprint: 'sprints:write',
  move_to_sprint: 'sprints:write',
  move_to_backlog: 'sprints:write',
  mark_integrated: 'integration',
  complete_session: 'integration',
};

/** @deprecated Use `toolPermission` (`lib/mcp/toolPermissions.ts`). Removed with `TOOL_SCOPES`. */
export function toolScope(toolName: McpToolName): TokenScope {
  return TOOL_SCOPES[toolName];
}
