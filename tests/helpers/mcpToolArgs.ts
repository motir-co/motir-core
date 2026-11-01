import type { McpToolName } from '@/lib/mcp/registry';

// The ARGUMENT MAP for every MCP tool, aimed at one seeded project — lifted out of
// `tests/mcp/story-roundtrip.test.ts` (Story MOTIR-6974 · Subtask MOTIR-7003) so
// the two suites that loop the registry share ONE map rather than two that drift:
//
//  - `story-roundtrip.test.ts` aims it at tenant A from a NON-MEMBER's token, and
//    every resource-targeting tool must read as not-found;
//  - `tool-hints-integration.test.ts` aims it at the caller's OWN project, and
//    every `readOnlyHint: true` tool must run and write nothing.
//
// Typed `Record<McpToolName, …>`, so a tool added to `MCP_TOOL_NAMES` without an
// entry is a compile error here, and each suite's totality check restates that
// as a value comparison.

/** The seeded resources the map aims at. */
export interface McpToolTargets {
  /** The project KEY (e.g. `'PROD'`). */
  projectKey: string;
  /** Two work items' `<KEY>-<n>` identifiers. */
  item1: string;
  item2: string;
  /** A planned sprint's id. */
  sprintId: string;
  /** A plan's id (a settled `planned` plan, so reading it never reaches motir-ai). */
  planId: string;
  /** A page's id in that project (MOTIR-7410). */
  pageId: string;
}

/** The targeting arguments for every tool, aimed at `t`. */
export function mcpToolArgs(t: McpToolTargets): Record<McpToolName, Record<string, unknown>> {
  return {
    whoami: {},
    // Self-scoped like whoami: no resource key, and the workspace comes from
    // the token — so it can only ever list the CALLER's own projects.
    list_projects: {},
    // Resource-targeting: the key names tenant A's project, so a non-member
    // must read its state as not-found rather than learn A's setup.
    get_project_state: { projectKey: t.projectKey },
    // MOTIR-7793 — project-keyed the same way: a non-member reads tenant A's code
    // health as not-found. Aimed at a project with no repository set, it answers
    // `repos: []` without ever reaching the motir-ai boundary.
    get_code_health: { projectKey: t.projectKey },
    // MOTIR-9083 — project-keyed: a non-member reads tenant A's key as not-found
    // before the repo is resolved or the boundary is asked.
    get_coding_convention: { projectKey: t.projectKey, repo: 'motir-core' },
    // MOTIR-7861 — project-keyed, so a non-member reads tenant A's key as
    // not-found before the repo is resolved or any host is asked.
    read_file: { projectKey: t.projectKey, repo: 'motir-core', path: 'README.md' },
    // MOTIR-10069 — project-keyed the same way: not-found before any host is asked.
    list_changed_files: { projectKey: t.projectKey, repo: 'motir-core', head: 'feat/x' },
    // MOTIR-7862 — project-keyed graph reads: a non-member reads A's key as
    // not-found before any repository set is read or motir-ai is called.
    code_explore: { projectKey: t.projectKey, query: 'readFile' },
    code_search: { projectKey: t.projectKey, query: 'readFile' },
    code_grep: { projectKey: t.projectKey, pattern: 'readFile' },
    // The ORIENTING read (MOTIR-3100) — project-keyed, so a non-member must
    // read tenant A's tree as not-found rather than receive its SHAPE. A
    // partial skeleton would be the worst possible leak here: it names every
    // card A has.
    skeleton: { projectKey: t.projectKey },
    // MOTIR-5409 — the folder tools, aimed at tenant A's PROJECT: the key resolves
    // inside the caller's workspace first, so a non-member reads it as not-found
    // before any folder id is looked at.
    list_folders: { projectKey: t.projectKey },
    get_section_sets: {},
    create_folder: { projectKey: t.projectKey, name: 'rogue' },
    update_folder: { projectKey: t.projectKey, folderId: 'fld_whatever', name: 'rogue' },
    delete_folder: { projectKey: t.projectKey, folderId: 'fld_whatever' },
    // MOTIR-7410 — the page read, project-keyed like the folder tools: a
    // non-member reads tenant A's project as not-found before the page id is
    // looked at; on the caller's own project it reads the seeded page.
    get_page: { projectKey: t.projectKey, pageId: t.pageId },
    // MOTIR-7411 — the page writes, aimed the same way.
    create_page: { projectKey: t.projectKey, markdown: 'rogue' },
    update_page: { projectKey: t.projectKey, pageId: t.pageId, markdown: 'rogue', revision: 1 },
    rename_page: { projectKey: t.projectKey, pageId: t.pageId, title: 'rogue' },
    // MOTIR-9553 — the page search, project-keyed the same way.
    search_pages: { projectKey: t.projectKey, q: 'rogue' },
    // MOTIR-9556 — the page move.
    move_page: { projectKey: t.projectKey, pageId: t.pageId, parent: { kind: 'root' } },
    // MOTIR-9557 — the page archive.
    archive_page: { projectKey: t.projectKey, pageId: t.pageId },
    // MOTIR-9558 — the page hand link.
    link_page: { projectKey: t.projectKey, pageId: t.pageId, workItemKey: t.item1 },
    publish_decision_page: { key: t.item1, pageId: t.pageId },
    get_work_item: { key: t.item1 },
    get_design: { key: t.item1 },
    list_designs: { projectKey: t.projectKey },
    // MOTIR-6191 — the gate read is item-keyed, so a non-member must read tenant
    // A's card as not-found rather than learn what was decided on it; on the
    // caller's own card it EXECUTES and answers `gate: null` (no such gate).
    get_approval_gate: { key: t.item1, kind: 'decision_approval' },
    get_work_item_activity: { key: t.item1 },
    list_ready: { projectKey: t.projectKey },
    next_ready: { projectKey: t.projectKey },
    claim_next_ready: { projectKey: t.projectKey },
    // The KEYED claim (MOTIR-2961) — item-keyed, so a non-member must read
    // tenant A's card as not-found rather than take it.
    claim_work_item: { key: t.item1 },
    dispatch_prompt: { key: t.item1 },
    get_plan_status: { planId: t.planId },
    get_plan: { planId: t.planId },
    // The plan-AUTHORING door (MOTIR-2988). `create_plan` is project-keyed,
    // so a non-member must read tenant A's project as not-found rather than
    // open a plan inside it; `add_plan_items` is plan-id-keyed, the same
    // shape as the two reads above.
    create_plan: { projectKey: t.projectKey, title: 'leak?' },
    add_plan_items: {
      planId: t.planId,
      proposals: [{ op: 'add', proposedFields: { title: 'leak?' } }],
    },
    // The DEEPEN turn (MOTIR-3090) — plan-id-keyed like the append. The item
    // id is deliberately a made-up one: a non-member must be refused on the
    // PLAN before anything looks at whether that proposal exists, so the
    // refusal cannot depend on tenant A having a real proposal to name.
    update_plan_item: { planId: t.planId, planItemId: 'pi_leak', title: 'leak?' },
    update_plan_proposal: { planId: t.planId, planItemId: 'pi_leak', title: 'leak?' },
    withdraw_plan_proposal: { planId: t.planId, planItemId: 'pi_leak' },
    // The plan's OWN heading (MOTIR-4637) — plan-id-keyed and needing no
    // proposal at all, so a non-member must be refused on the PLAN.
    update_plan: { planId: t.planId, summary: 'leak?' },
    // WHY a plan had to change (MOTIR-6086) — plan-id-keyed and needing no
    // proposal, so a non-member must be refused on the PLAN. Recording a
    // judgement about a plan is as much a leak as reading one.
    record_plan_revision_reason: { planId: t.planId, branch: 'new_ask', evidenceMd: 'leak?' },
    // A planner session's step (MOTIR-7824) — plan-id-keyed, so a non-member
    // must be refused on the PLAN before anything is written.
    report_plan_step: { planId: t.planId, sessionKey: 'leak?', step: 'settle' },
    // A plan's revision hold (MOTIR-7988) — plan-id-keyed, so a non-member must be
    // refused on the PLAN before any lease row is written.
    hold_plan_revision: { planId: t.planId, action: 'start' },
    // Is A's card still what its plan approved? (MOTIR-6227) — item-keyed, so a
    // non-member must read the key as not-found rather than learn A's plan
    // history or a verdict about it.
    get_approved_shape_verdict: { key: t.item1 },
    // The run-found report (MOTIR-6286) — item-keyed within a project, so a
    // non-member must read A's key as not-found rather than record on A's run.
    report_unbuildable_target: { projectKey: t.projectKey, targetKey: t.item1, reason: 'leak?' },
    // The run discrepancy record (MOTIR-8657) — item-keyed, so a non-member must read A's key
    // as not-found rather than comment on A's card or record on A's run.
    record_run_discrepancy: {
      key: t.item1,
      points: [{ planAsked: 'leak?', built: 'leak?', why: 'leak?' }],
    },
    open_plan_session: { projectKey: t.projectKey },
    append_plan_turn: { projectKey: t.projectKey, body: 'leak?' },
    submit_plan_session: { projectKey: t.projectKey },
    search_work_items: { projectKey: t.projectKey },
    // The SEMANTIC search (MOTIR-3101) — project-keyed like its substring
    // sibling, so a non-member must read tenant A's project as not-found
    // rather than receive a ranking over it. The refusal must also land
    // BEFORE the embed, which is why the gate is the service's first line.
    search_work_items_semantic: { projectKey: t.projectKey, query: 'anything at all' },
    list_sprints: { projectKey: t.projectKey },
    validate_sprint: { projectKey: t.projectKey, sprintId: t.sprintId },
    validate_work_item: { key: t.item1 },
    // Tenant A's plan id. A non-member must read it as not-found — the plan
    // read is where the projected validators get their access check, so a
    // leak here would be a leak on all three (MOTIR-3095).
    validate_plan: { planId: t.planId },
    get_plan_authoring_state: { planId: t.planId },
    get_plan_code_reads: { planId: t.planId },
    create_work_item: { projectKey: t.projectKey, kind: 'task', title: 'x' },
    expand_item: { key: t.item1 },
    update_work_item: { key: t.item1, title: 'hijacked' },
    change_kind: { key: t.item1, kind: 'task' },
    transition_status: { key: t.item1, status: 'in_progress' },
    add_comment: { key: t.item1, body: 'leak?' },
    // MOTIR-5295 — addressed by comment id, not by key. Any id reads as
    // not-found to a non-member, since the comment's work item is hidden.
    edit_comment: { commentId: 'cmt_whatever', body: 'leak?' },
    delete_comment: { commentId: 'cmt_whatever' },
    // MOTIR-6725 — the to-do tools are item-keyed, so a non-member must read
    // A's card as not-found: no list, no appended step, no tick.
    list_work_item_todos: { key: t.item1 },
    add_work_item_todo: { key: t.item1, text: 'leak?' },
    set_work_item_todo_done: { key: t.item1, todoId: 'tdo_whatever', done: true },
    // MOTIR-7306 — edit and delete are item-keyed too: no edited or removed step.
    update_work_item_todo: { key: t.item1, todoId: 'tdo_whatever', text: 'leak?' },
    delete_work_item_todo: { key: t.item1, todoId: 'tdo_whatever' },
    // MOTIR-7556 — move is item-keyed the same way: no moved step.
    move_work_item_todo: { key: t.item1, todoId: 'tdo_whatever', toIndex: 0 },
    // MOTIR-6807 — the repair tools are item-keyed too: a non-member reads
    // A's card as not-found, so no run opens, beats or closes.
    claim_work_item_repair: { key: t.item1 },
    touch_work_item_repair: { key: t.item1, runId: 'run_whatever' },
    close_work_item_repair: { key: t.item1, runId: 'run_whatever', outcome: 'gave_up' },
    // MOTIR-7262 — the continue tools, item-keyed the same way.
    claim_work_item_continue: { key: t.item1 },
    touch_work_item_continue: { key: t.item1, runId: 'run_whatever' },
    close_work_item_continue: { key: t.item1, runId: 'run_whatever', outcome: 'completed' },
    // MOTIR-7451 — the run tools, item-keyed the same way: a non-member reads A's
    // card as not-found, so no run opens, reports or closes.
    start_work_item_run: { key: t.item1, harness: 'Rogue Agent' },
    report_action: { key: t.item1, action: 'rogue step' },
    close_work_item_run: { key: t.item1, runId: 'run_whatever', outcome: 'completed' },
    // MOTIR-3361 — aimed at tenant A's PROJECT: a non-member must read the
    // key as not-found rather than write a standing planner instruction
    // into somebody else's project.
    add_lesson: {
      projectKey: t.projectKey,
      title: 'leak?',
      body: 'leak?',
      why: 'leak?',
      howToApply: 'leak?',
    },
    // MOTIR-3480 — aimed at tenant A's PROJECT, like its write sibling: a
    // non-member must read the key as not-found rather than learn what
    // somebody else's project has recorded about its own mistakes.
    search_lessons: { projectKey: t.projectKey, query: 'leak?' },
    // MOTIR-3553. Aimed at tenant A's project like its neighbours: a
    // cross-tenant caller must be refused before anything is recorded.
    reinforce_lesson: {
      projectKey: t.projectKey,
      lessonId: 'les_whatever',
      occurrenceRef: 'MOTIR-1',
    },
    // MOTIR-3058. Aimed at tenant A's item like its neighbours: a
    // cross-tenant caller must read the key as not-found — never a 403 that
    // confirms it exists, and never a file landing in another workspace.
    attach_file: {
      key: t.item1,
      filename: 'findings.md',
      contentType: 'text/markdown',
      contentBase64: 'eA==',
    },
    // MOTIR-3782. Same shape and the same stake as `attach_file`, one
    // artifact class over — and the leak this guards is worse, because a
    // design result RENDERS: a publish that crossed a tenant boundary would
    // put a stranger's screen on A's card under a real evidence id. The key
    // must read as not-found before any byte is written.
    publish_design_result: {
      key: t.item1,
      assets: [
        {
          kind: 'image',
          sourcePath: 'design/rogue/rogue.png',
          contentType: 'image/png',
          contentBase64: 'eA==',
        },
      ],
    },
    // MOTIR-4750 — the design publisher's own mint half, and the mint is
    // the worse half of any such pair: it hands back a presigned PUT into
    // A's object store, under A's own design prefix. The key must read as
    // not-found before a grant is minted.
    create_design_upload: {
      key: t.item1,
      files: [
        {
          kind: 'image',
          sourcePath: 'design/rogue/rogue.png',
          contentType: 'image/png',
        },
      ],
    },
    // MOTIR-4704 — the same argument one artifact over. A cross-tenant
    // acceptance publish would put a stranger's RECORDING on A's story, and
    // the mint half is worse than the register half: it hands back a
    // presigned PUT into A's object store. Both must read not-found before
    // a grant is minted or a pathname is registered.
    create_acceptance_upload: { key: t.item1 },
    publish_acceptance_result: {
      key: t.item1,
      videoPathname: 'acceptance/rogue/rogue.webm',
    },
    // MOTIR-5331 — the HOW TO TEST door, aimed at tenant A's item. The key must
    // read as not-found before the repository is resolved, so a non-member
    // neither learns A's repositories nor writes a record onto A's card.
    publish_test_instructions: {
      key: t.item1,
      bodyMd: 'rogue',
      repos: [{ repo: 'acme/web', commitSha: 'a'.repeat(40) }],
    },
    // MOTIR-3526. Aimed at tenant A's item like its neighbours: the ITEM key
    // must read as not-found BEFORE the repository is looked at, so a
    // non-member learns neither that the card exists nor which repositories
    // A has connected — and no row is written into A's tenant.
    link_pull_request: {
      key: t.item1,
      repository: 'acme/web',
      number: 7,
      headRef: 'subtask/rogue',
      baseRef: 'main',
    },
    // MOTIR-3756 — the UNLINK door, aimed the same way and for the same
    // reason: the ITEM key must read as not-found before the repository is
    // looked at, so a non-member learns neither that A's card exists nor
    // which repositories A has connected, and no row is removed from A.
    unlink_pull_request: { key: t.item1, repository: 'acme/web', number: 7 },
    link_work_items: { fromKey: t.item1, toKey: t.item2, relationship: 'relates_to' },
    unlink_work_items: { fromKey: t.item1, toKey: t.item2, relationship: 'relates_to' },
    move_to_parent: { key: t.item1, parentKey: t.item2 },
    archive_work_item: { key: t.item1 },
    unarchive_work_item: { key: t.item1 },
    delete_work_item: { key: t.item1 },
    create_sprint: { projectKey: t.projectKey, name: 'rogue' },
    update_sprint: { sprintId: t.sprintId, name: 'rogue' },
    delete_sprint: { sprintId: t.sprintId },
    move_to_sprint: { keys: [t.item1], sprintId: t.sprintId },
    move_to_backlog: { keys: [t.item1] },
    start_sprint: { sprintId: t.sprintId },
    complete_sprint: { sprintId: t.sprintId, carryOverTo: 'backlog' },
    mark_integrated: { key: t.item1, sessionBranch: 'feat/x' },
    complete_session: { sessionBranch: 'feat/x' },
  };
}
