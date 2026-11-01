import { beforeEach, describe, expect, it } from 'vitest';
import { GET } from '@/app/api/v1/work-items/[key]/dispatch-prompt/route';
import {
  dispatchPromptSchema,
  planJobHandleSchema,
  planStatusUrl,
  presentDispatchPrompt,
  type V1DispatchPrompt,
} from '@/lib/api/v1/workLoop/schema';
import { WORK_LOOP_OPERATIONS } from '@/lib/api/v1/workLoop/operations';
import { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { runDispatchPrompt } from '@/lib/mcp/tools/dispatchPrompt';
import { workItemsService } from '@/lib/services/workItemsService';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// GET /api/v1/work-items/{key}/dispatch-prompt (Story 11.7 · Subtask 11.7.3 —
// MOTIR-2237) against real Postgres.
//
// Three assertions here are the reason this endpoint is not just another read:
//
//   • It MUST NOT MUTATE. The row is compared byte-for-byte before and after,
//     including for an item already `in_progress` — an orchestrator that could
//     not preview work without taking it would have no safe way to choose.
//   • A `sessionBranch` seed MUST NOT REDIRECT a live lineage. That is the one
//     way this endpoint could corrupt state: an integrated chain stranded across
//     two branches.
//   • The payload must MATCH the MCP tool's, field by field. Two transports, one
//     service — asserted, not asserted-in-a-comment.

const BASE = 'http://localhost:3000/api/v1';

function req(caller: V1ProjectCaller, key: string, query = ''): Promise<Response> {
  return GET(
    new Request(`${BASE}/work-items/${key}/dispatch-prompt${query}`, { headers: caller.headers }),
    { params: Promise.resolve({ key }) },
  );
}

async function prompt(caller: V1ProjectCaller, key: string, query = ''): Promise<V1DispatchPrompt> {
  const res = await req(caller, key, query);
  expect(res.status).toBe(200);
  return (await res.json()) as V1DispatchPrompt;
}

async function makeItem(caller: V1ProjectCaller, title: string, kind: 'task' | 'subtask' = 'task') {
  return workItemsService.createWorkItem(
    // Typed so the fixture is not UNDER-AUTHORED (MOTIR-5427).
    { projectId: caller.fixture.projectId, kind, title, type: 'code' },
    caller.ctx,
  );
}

/** Everything about the row this endpoint could conceivably move. */
async function stateOf(caller: V1ProjectCaller, id: string) {
  const item = await workItemsService.getWorkItem(id, caller.ctx);
  return {
    status: item.status,
    sessionBranch: item.sessionBranch,
    assigneeId: item.assigneeId,
    updatedAt: item.updatedAt,
  };
}

describe('GET /api/v1/work-items/{key}/dispatch-prompt', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  it('returns the assembled prompt and the facts a client routes on', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'build the thing');

    const body = await prompt(caller, item.identifier);

    expect(() => dispatchPromptSchema.parse(body)).not.toThrow();
    expect(body.key).toBe(item.identifier);
    expect(body.prompt.length).toBeGreaterThan(0);
    expect(body.prompt).toContain(item.identifier);
    expect(body.workflowMode).toBe('per_item_pr');
    expect(body.sessionBranch).toBeNull();
    // Always PRESENT — `[]` when there are none, so a client never branches on
    // absence.
    expect(body.advisories).toEqual([]);
  });

  it('does NOT claim the item, move its status or touch its branch', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'do not take me');
    const before = await stateOf(caller, item.id);

    await prompt(caller, item.identifier);

    expect(await stateOf(caller, item.id)).toEqual(before);
  });

  it('does not mutate an item already IN PROGRESS either', async () => {
    // The case that matters: re-fetching the prompt mid-run is exactly what a
    // resumed session does, and it must be free.
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'already running');
    await workItemsService.updateStatus(item.id, 'in_progress', caller.ctx);
    const before = await stateOf(caller, item.id);

    const body = await prompt(caller, item.identifier);

    expect(body.key).toBe(item.identifier);
    expect(await stateOf(caller, item.id)).toEqual(before);
  });

  it('accepts a `sessionBranch` SEED for an item with no lineage of its own', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'seed me');

    const body = await prompt(caller, item.identifier, '?sessionBranch=session/MOTIR-1-run');

    expect(body.sessionBranch).toBe('session/MOTIR-1-run');
    expect(body.workflowMode).toBe('session_lineage');
    // Reading the prompt is still a read: the seed reached the PROMPT, not the row.
    expect((await stateOf(caller, item.id)).sessionBranch).toBeNull();
  });

  it('does NOT redirect an item that already carries a lineage', async () => {
    // The one way this endpoint could corrupt state. The item's own branch wins;
    // the caller's seed is ignored entirely.
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'already on a branch');
    // `markIntegrated` moves the item to `in_review`, which is only legal from
    // `in_progress` on the default workflow.
    await workItemsService.updateStatus(item.id, 'in_progress', caller.ctx);
    await workItemsService.markIntegrated(item.id, 'session/OWN-branch', caller.ctx);
    const before = await stateOf(caller, item.id);

    const body = await prompt(caller, item.identifier, '?sessionBranch=session/HIJACK');

    expect(body.sessionBranch).not.toBe('session/HIJACK');
    expect(await stateOf(caller, item.id)).toEqual(before);
  });

  // ── the per-run findings policy (MOTIR-3020) ──────────────────────────────
  //
  // The parameter that carries an operator's per-run policy to the ONE surface
  // the agent actually reads. `docs/decisions/run-findings-protocol.md` Q1.

  it('renders the COMPLETE protocol when `findingsPolicy` is absent', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'no policy');

    const body = await prompt(caller, item.identifier);

    expect(body.prompt).toContain('FOUND A DEFECT');
    expect(body.prompt).toContain('submit_plan_session');
  });

  it('removes the branch the policy names, from the prompt itself', async () => {
    // Asserted on the PROMPT TEXT, because that is the whole contract: a
    // parameter that changed a field and not the text would change nothing about
    // what the agent does.
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'no bugs please');

    const body = await prompt(caller, item.identifier, '?findingsPolicy=log-bug');

    expect(body.prompt).not.toContain('create_work_item');
    expect(body.prompt).toContain('Comment the finding on');
    expect(body.prompt).toContain('submit_plan_session');
  });

  it('removes both when both are named', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'quiet run');

    const body = await prompt(caller, item.identifier, '?findingsPolicy=log-bug,replan');

    expect(body.prompt).not.toContain('create_work_item');
    expect(body.prompt).not.toContain('submit_plan_session');
    expect(body.prompt).toContain('leave the card In Progress');
  });

  it('REFUSES an unknown capability with 422 rather than rendering the full protocol', async () => {
    // The refusal is the point. Ignoring `no-log-bug` would hand the caller a
    // 200 and a prompt they believe is narrowed — the exact lie this parameter
    // exists to remove.
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'typo');

    const res = await req(caller, item.identifier, '?findingsPolicy=no-log-bug');

    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('INVALID_FINDINGS_POLICY');
    // It TEACHES: the vocabulary is in the message, so a caller can fix it.
    expect(body.error).toContain('log-bug');
    expect(body.error).toContain('replan');
  });

  it('stays a READ under a policy — the row is untouched', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'still a read');
    const before = await stateOf(caller, item.id);

    await prompt(caller, item.identifier, '?findingsPolicy=log-bug,replan');

    expect(await stateOf(caller, item.id)).toEqual(before);
  });

  it('the MCP tool takes the SAME parameter and renders the same text', async () => {
    // Two transports, one vocabulary, one parser. A policy that narrowed the v1
    // prompt and not the MCP one would be a contract that depends on how it was
    // fetched.
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'both doors');

    const viaHttp = await prompt(caller, item.identifier, '?findingsPolicy=log-bug');
    const viaMcp = await runDispatchPrompt(
      { key: item.identifier, findingsPolicy: 'log-bug' },
      caller.ctx,
    );

    expect(viaMcp.isError).toBeFalsy();
    const payload = viaMcp.structuredContent as { prompt: string };
    expect(payload.prompt).toBe(viaHttp.prompt);
  });

  it('the MCP tool REFUSES an unknown capability too', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'mcp typo');

    const result = await runDispatchPrompt(
      { key: item.identifier, findingsPolicy: 'nonsense' },
      caller.ctx,
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('nonsense');
  });

  // ── ?agentReport (MOTIR-8810) ─────────────────────────────────────────────
  //
  // The client's declaration that it posts what its agent writes into
  // `$MOTIR_AGENT_REPORT`. `@motir/cli` 0.12.0 sends none and posts nothing but the
  // model, so a prompt that sent the unbuildable report into that file lost it.

  it('routes the unbuildable report through the tool when the client does not declare it posts', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'an old cli');

    const text = (await prompt(caller, item.identifier)).prompt;

    expect(text).toContain('  4. Report it with the report_unbuildable_target tool:');
    expect(text).not.toContain('no Motir tool needed');
    expect(text).not.toContain('NO MOTIR TOOLS?');
    for (const query of ['?agentReport=', '?agentReport=0', '?agentReport=yes']) {
      expect((await prompt(caller, item.identifier, query)).prompt).toBe(text);
    }
  });

  it('names the report file as the route for `?agentReport=1`', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'a cli that posts');

    const text = (await prompt(caller, item.identifier, '?agentReport=1')).prompt;

    expect(text).toContain('"unbuildable": "<the SAME text as your step-3 comment>"');
    expect(text).toContain('no Motir tool needed');
    expect(text).toContain('NO MOTIR TOOLS?');
    expect(text).toContain('"discrepancy": [{"planAsked"');
    // …but not the decisions route, which a CLI that predates MOTIR-10000 would drop.
    expect(text).not.toContain('"decisions": [{"planSaid"');
  });

  it('names the decisions file route only for `?agentReport=1&agentReportDecisions=1` (MOTIR-10000)', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'a cli that posts decisions');

    const both = (await prompt(caller, item.identifier, '?agentReport=1&agentReportDecisions=1'))
      .prompt;
    expect(both).toContain('"decisions": [{"planSaid"');
    expect(both).toContain('DECIDE WHAT THE CARD LEAVES OPEN — never ask');

    const alone = (await prompt(caller, item.identifier, '?agentReportDecisions=1')).prompt;
    expect(alone).not.toContain('"decisions": [{"planSaid"');
    // The never-ask block itself is in every agent prompt, whatever the client posts.
    expect(alone).toContain('DECIDE WHAT THE CARD LEAVES OPEN — never ask');
  });

  // ── ?autoApproveReplan (MOTIR-4085) ─────────────────────────────────────
  //
  // The OTHER prompt parameter, and it is a different KIND of thing from the one
  // above: it switches nothing off for the agent — the tools, the anchor and the
  // one shot are identical either way — it tells the agent what will happen to
  // what it submits. Its own parameter, so `findingsPolicy`'s documented meaning
  // (a list of what is OFF) keeps meaning one thing.

  it('renders NO lane section by default — the request is unchanged without it', async () => {
    // ⚠️ THE ABSENCE IS THE IMPORTANT ARM. A section rendered unconditionally
    // would tell every agent on every run that its plan might be approved
    // unattended, which is false for every run without an approving loop — and
    // false in the direction the agent cannot check.
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'no lane');

    expect((await prompt(caller, item.identifier)).prompt).not.toContain('TWO LANES');
  });

  it('renders the lane section for `?autoApproveReplan=1`', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'two lanes');

    const body = await prompt(caller, item.identifier, '?autoApproveReplan=1');

    expect(body.prompt).toContain('TWO LANES');
    expect(body.prompt).toContain('--auto-approve-replan');
    expect(body.prompt).toContain('ALWAYS available');
  });

  it('IGNORES it when `replan` is disabled — approving what was never submitted is nonsense', async () => {
    // Resolved to the SAFE side, in the shared parser rather than per transport.
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'contradiction');

    const body = await prompt(
      caller,
      item.identifier,
      '?findingsPolicy=replan&autoApproveReplan=1',
    );

    expect(body.prompt).not.toContain('TWO LANES');
    expect(body.prompt).toContain('leave the card In Progress');
  });

  it('treats every other value as NO — the safe direction for a claim an agent cannot check', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'falsey');

    for (const query of ['?autoApproveReplan=', '?autoApproveReplan=0', '?autoApproveReplan=yes']) {
      expect((await prompt(caller, item.identifier, query)).prompt).not.toContain('TWO LANES');
    }
  });

  it('stays a READ under the lane parameter — the row is untouched', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'still a read, with a lane');
    const before = await stateOf(caller, item.id);

    await prompt(caller, item.identifier, '?autoApproveReplan=1');

    expect(await stateOf(caller, item.id)).toEqual(before);
  });

  it('the MCP tool does NOT expose it — the agent may not compose its own lane', async () => {
    // ⚠️ A DELIBERATE NON-WIDENING, asserted rather than left as an omission
    // nobody reads. MCP is the AGENT's surface; a tool parameter here would let
    // the party whose plan is being bounded write the prompt that describes the
    // bound. The tool therefore renders the lane that is true for every caller
    // who reaches a prompt through it: nobody is going to approve it unattended.
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'mcp has no lane');

    const viaMcp = await runDispatchPrompt({ key: item.identifier }, caller.ctx);
    const payload = viaMcp.structuredContent as { prompt: string };

    expect(payload.prompt).not.toContain('TWO LANES');
    // …and it is the SAME prompt the HTTP door renders without the parameter,
    // so the two transports still cannot disagree about the default.
    expect(payload.prompt).toBe((await prompt(caller, item.identifier)).prompt);
  });

  it('treats an EMPTY `sessionBranch` as no seed rather than as a bad request', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'no seed');

    const body = await prompt(caller, item.identifier, '?sessionBranch=');

    expect(body.sessionBranch).toBeNull();
    expect(body.workflowMode).toBe('per_item_pr');
  });

  it.each([
    ['a shell metacharacter', 'main;rm -rf /'],
    ['whitespace', 'my branch'],
    ['a leading dash', '-oProxyCommand=x'],
    ['an over-long name', 'a'.repeat(201)],
  ])('422s an unsafe branch name — %s', async (_label, branch) => {
    // The seed is interpolated into prompt text instructing an agent to run
    // `git … origin/<branch>`, so refusing is cheaper than escaping — and it is
    // refused BEFORE the read.
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'safe');

    const res = await req(caller, item.identifier, `?sessionBranch=${encodeURIComponent(branch)}`);

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_SESSION_BRANCH');
  });

  it('matches the MCP tool’s payload field by field', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'one item, two transports');

    const body = await prompt(caller, item.identifier);
    const tool = await runDispatchPrompt({ key: item.identifier }, caller.ctx);
    const payload = tool.structuredContent as Record<string, unknown>;

    // Every field of the v1 body, compared to the SAME field of the MCP payload.
    // The prompt is a pure function of server state, so the text is byte-equal.
    for (const [field, value] of Object.entries(body)) {
      expect(payload[field], `field ${field}`).toEqual(value);
    }
  });

  it('is gated on the scope its MCP counterpart carries, not on a copy of it', async () => {
    // Read off the shipped map rather than hard-coded: ADR Amendment 6 Q2 —
    // one capability model, two transports.
    const operation = WORK_LOOP_OPERATIONS.find(
      (op) => op.operationId === 'getWorkItemDispatchPrompt',
    );
    expect(operation?.permission).toBe(TOOL_PERMISSIONS.dispatch_prompt);
  });

  it('refuses a token without `read` with 403', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['work_items:write'] });
    const item = await makeItem(caller, 'not for you');

    const res = await req(caller, item.identifier);

    expect(res.status).toBe(403);
  });

  it('answers 404 for a key in ANOTHER workspace — never 403', async () => {
    // The existence oracle §4 forbids: 403 would confirm the item exists.
    const mine = await createV1ProjectCaller({ scopes: ['read'] });
    const theirs = await createV1ProjectCaller({ scopes: ['read'] });
    const hidden = await makeItem(theirs, 'someone else’s work');

    const res = await req(mine, hidden.identifier);

    expect(res.status).toBe(404);
  });

  it('422s a malformed key before any read', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });

    const res = await req(caller, 'not-a-key');

    expect(res.status).toBe(422);
  });
});

describe('the dispatch-prompt schema', () => {
  it('accepts an UNKNOWN advisory severity rather than failing a shipped client', () => {
    // ADR §8 permits a new value on a field documented as open-ended, and the
    // advisory channel has grown twice already (MOTIR-2175, MOTIR-2177). A closed
    // enum here would 500 this endpoint on its OWN response the day the server
    // emitted the next severity — the drift guard validates real responses
    // against this schema.
    const withFutureSeverity = {
      key: 'PROD-1',
      prompt: 'text',
      parentKey: 'PROD-9',
      targetRepo: null,
      targetRepoCloneUrl: null,
      targetRepoDefaultBranch: null,
      // MOTIR-3131 — the presenter maps the repository SET too; these fixtures
      // exercise the ADVISORY branch and carry an empty one.
      targetRepos: [],
      workflowMode: 'per_item_pr',
      sessionBranch: null,
      advisories: [
        {
          item: 'PROD-1',
          referenced: 'PROD-2',
          referencedStatus: 'todo',
          severity: 'not-yet-invented',
        },
        { kind: 'shape', item: 'PROD-1', severity: 'a-future-shape-defect', criterionIndex: 3 },
      ],
    };

    expect(() => dispatchPromptSchema.parse(withFutureSeverity)).not.toThrow();
  });

  it('shapes each advisory FIELD BY FIELD — an internal addition does not reach the wire', () => {
    const mapped = presentDispatchPrompt({
      key: 'PROD-1',
      prompt: 'text',
      parentKey: 'PROD-9',
      targetRepo: null,
      targetRepoCloneUrl: null,
      targetRepoDefaultBranch: null,
      // MOTIR-3131 — the presenter maps the repository SET too; these fixtures
      // exercise the ADVISORY branch and carry an empty one.
      targetRepos: [],
      workflowMode: 'per_item_pr',
      sessionBranch: null,
      advisories: [
        {
          item: 'PROD-1',
          referenced: 'PROD-2',
          referencedStatus: 'todo',
          severity: 'likely-missing-edge',
          internalOnly: 'do-not-ship',
        },
      ],
    } as unknown as Parameters<typeof presentDispatchPrompt>[0]);

    expect(JSON.stringify(mapped)).not.toContain('do-not-ship');
    expect(mapped.advisories[0]).toEqual({
      item: 'PROD-1',
      referenced: 'PROD-2',
      referencedStatus: 'todo',
      severity: 'likely-missing-edge',
    });
  });

  it('carries a SHAPE advisory’s per-severity fields, and only its own', () => {
    const mapped = presentDispatchPrompt({
      key: 'PROD-1',
      prompt: 'text',
      parentKey: 'PROD-9',
      targetRepo: null,
      targetRepoCloneUrl: null,
      targetRepoDefaultBranch: null,
      // MOTIR-3131 — the presenter maps the repository SET too; these fixtures
      // exercise the ADVISORY branch and carry an empty one.
      targetRepos: [],
      workflowMode: 'per_item_pr',
      sessionBranch: null,
      advisories: [
        {
          kind: 'shape',
          item: 'PROD-1',
          severity: 'likely-ordering-violation',
          criterionIndex: 2,
          phrase: 'after this merges',
        },
        {
          kind: 'shape',
          item: 'PROD-1',
          severity: 'likely-repo-straddle',
          criterionIndex: 4,
          path: 'lib/x.ts',
          repo: 'motir-ai',
          reason: 'contradiction',
        },
      ],
    } as unknown as Parameters<typeof presentDispatchPrompt>[0]);

    expect(mapped.advisories[0]).toEqual({
      kind: 'shape',
      item: 'PROD-1',
      severity: 'likely-ordering-violation',
      criterionIndex: 2,
      phrase: 'after this merges',
    });
    expect(mapped.advisories[1]).toEqual({
      kind: 'shape',
      item: 'PROD-1',
      severity: 'likely-repo-straddle',
      criterionIndex: 4,
      path: 'lib/x.ts',
      repo: 'motir-ai',
      reason: 'contradiction',
    });
    expect(() => dispatchPromptSchema.parse(mapped)).not.toThrow();
  });

  it('carries a SUBSUMPTION advisory field-for-field, and only its own (MOTIR-2903)', () => {
    // The seam's whole job: a field added to `WorkItemProseAdvisoryDto` for an
    // internal consumer must not become public API by accident, and a NEW family
    // must not be mapped through another family's branch. Before MOTIR-2903 the
    // presenter's `else` swept everything not tagged `shape` into the reference
    // shape, so this entry would have crossed the wire as
    // `{ referenced: undefined, referencedStatus: undefined }`.
    const mapped = presentDispatchPrompt({
      key: 'PROD-1',
      prompt: 'text',
      parentKey: null,
      targetRepo: 'motir-core',
      targetRepoCloneUrl: null,
      targetRepoDefaultBranch: null,
      // MOTIR-3131 — the presenter maps the repository SET too; these fixtures
      // exercise the ADVISORY branch and carry an empty one.
      targetRepos: [],
      workflowMode: 'per_item_pr',
      sessionBranch: null,
      advisories: [
        {
          kind: 'subsumption',
          item: 'PROD-1',
          severity: 'likely-already-shipped',
          path: 'lib/services/workflowsService.ts',
          pullRequest: 'moooon-B-V/motir-core#2059',
          pullRequestTitle: 'Bind the READ surface for motir_app',
          state: 'merged',
          mergedAt: '2026-08-15T14:00:00.000Z',
        },
      ],
    } as unknown as Parameters<typeof presentDispatchPrompt>[0]);

    expect(mapped.advisories[0]).toEqual({
      kind: 'subsumption',
      item: 'PROD-1',
      severity: 'likely-already-shipped',
      path: 'lib/services/workflowsService.ts',
      pullRequest: 'moooon-B-V/motir-core#2059',
      pullRequestTitle: 'Bind the READ surface for motir_app',
      state: 'merged',
      mergedAt: '2026-08-15T14:00:00.000Z',
    });
    expect(() => dispatchPromptSchema.parse(mapped)).not.toThrow();
  });

  it('carries the OPEN subsumption arm as its own wire variant (MOTIR-3230)', () => {
    // The merged variant above is byte-identical to the shipped shape plus
    // `state`; THIS payload is one no consumer has ever received, which is what
    // makes the pair additive under §8 rather than a retype of `mergedAt`.
    const mapped = presentDispatchPrompt({
      key: 'PROD-1',
      prompt: 'text',
      parentKey: null,
      targetRepo: 'motir-core',
      targetRepoCloneUrl: null,
      targetRepoDefaultBranch: null,
      targetRepos: [],
      workflowMode: 'per_item_pr',
      sessionBranch: null,
      advisories: [
        {
          kind: 'subsumption',
          item: 'PROD-1',
          severity: 'likely-in-flight',
          path: 'lib/services/workflowsService.ts',
          pullRequest: 'moooon-B-V/motir-core#2200',
          pullRequestTitle: 'Inject the resolver into every main() call',
          state: 'open',
          mergedAt: null,
        },
      ],
    } as unknown as Parameters<typeof presentDispatchPrompt>[0]);

    expect(mapped.advisories[0]).toEqual({
      kind: 'subsumption',
      item: 'PROD-1',
      severity: 'likely-in-flight',
      path: 'lib/services/workflowsService.ts',
      pullRequest: 'moooon-B-V/motir-core#2200',
      pullRequestTitle: 'Inject the resolver into every main() call',
      state: 'open',
      mergedAt: null,
    });
    expect(() => dispatchPromptSchema.parse(mapped)).not.toThrow();
  });

  it('carries a SIZING advisory field-for-field, with NO criterionIndex (MOTIR-3110)', () => {
    // The second `kind: 'shape'` variant, and the reason it is a variant rather
    // than a third severity inside the existing one: it has no criterion to
    // point at, and loosening `criterionIndex` to optional on the shipped shape
    // schema would be a nullability change ADR §8 forbids. So the union grew
    // instead — additive, on a field clients must already tolerate unknown
    // members of.
    const mapped = presentDispatchPrompt({
      key: 'PROD-1',
      prompt: 'text',
      parentKey: null,
      targetRepo: 'motir-core',
      targetRepoCloneUrl: null,
      targetRepoDefaultBranch: null,
      // MOTIR-3131 — the presenter maps the repository SET too; this fixture
      // exercises the ADVISORY branch and carries an empty one.
      targetRepos: [],
      workflowMode: 'per_item_pr',
      sessionBranch: null,
      advisories: [
        {
          kind: 'shape',
          item: 'PROD-1',
          severity: 'likely-over-gate-sizing',
          threshold: 'both',
          storyPoints: 13,
          estimateMinutes: 600,
        },
      ],
    } as unknown as Parameters<typeof presentDispatchPrompt>[0]);

    expect(mapped.advisories[0]).toEqual({
      kind: 'shape',
      item: 'PROD-1',
      severity: 'likely-over-gate-sizing',
      threshold: 'both',
      storyPoints: 13,
      estimateMinutes: 600,
    });
    // The point of the field-by-field mapper: no `criterionIndex` is invented on
    // the way out, and no other member's fields ride along.
    expect(mapped.advisories[0]).not.toHaveProperty('criterionIndex');
    expect(mapped.advisories[0]).not.toHaveProperty('phrase');
    expect(() => dispatchPromptSchema.parse(mapped)).not.toThrow();
  });

  it('an UNESTIMATED column crosses the wire as null, not as absent or zero', () => {
    // A card over one ceiling with the other column empty is the ordinary shape
    // — the gate's "every leaf carries an estimate" limb is a different finding
    // — so `null` has to survive the mapper AND the schema.
    const mapped = presentDispatchPrompt({
      key: 'PROD-1',
      prompt: 'text',
      parentKey: null,
      targetRepo: 'motir-core',
      targetRepoCloneUrl: null,
      targetRepoDefaultBranch: null,
      targetRepos: [],
      workflowMode: 'per_item_pr',
      sessionBranch: null,
      advisories: [
        {
          kind: 'shape',
          item: 'PROD-1',
          severity: 'likely-over-gate-sizing',
          threshold: 'story_points',
          storyPoints: 21,
          estimateMinutes: null,
        },
      ],
    } as unknown as Parameters<typeof presentDispatchPrompt>[0]);

    expect(mapped.advisories[0]).toMatchObject({ storyPoints: 21, estimateMinutes: null });
    expect(() => dispatchPromptSchema.parse(mapped)).not.toThrow();
  });

  it('the two `kind: "shape"` variants stay DISJOINT — neither parses as the other', () => {
    // The union is plain, not discriminated, so the guarantee that a sizing
    // advisory does not silently validate as a criterion one (and lose its
    // fields) rests on their REQUIRED fields being disjoint. Asserted directly,
    // because the day it stops holding the failure is a stripped payload rather
    // than an error.
    const sizing = {
      kind: 'shape' as const,
      item: 'PROD-1',
      severity: 'likely-over-gate-sizing',
      threshold: 'both',
      storyPoints: 13,
      estimateMinutes: 600,
    };
    const ordering = {
      kind: 'shape' as const,
      item: 'PROD-1',
      severity: 'likely-ordering-violation',
      criterionIndex: 2,
      phrase: 'once it lands',
    };
    const envelope = (advisories: unknown[]) => ({
      key: 'PROD-1',
      prompt: 'text',
      parentKey: null,
      targetRepo: null,
      targetRepoCloneUrl: null,
      targetRepoDefaultBranch: null,
      targetRepos: [],
      workflowMode: 'per_item_pr' as const,
      sessionBranch: null,
      advisories,
    });

    expect(dispatchPromptSchema.parse(envelope([sizing])).advisories[0]).toEqual(sizing);
    expect(dispatchPromptSchema.parse(envelope([ordering])).advisories[0]).toEqual(ordering);
  });

  it('carries a SELF-BLOCKING-DESIGN advisory field-for-field, with BOTH indices (MOTIR-3178)', () => {
    // The third `kind: 'shape'` variant, and a variant for the same §8 reason the
    // sizing one is: it carries no `criterionIndex` at all — a PAIR of named
    // indices instead, because its remedy LIFTS the design criterion onto its own
    // card rather than cutting the list at a line.
    const mapped = presentDispatchPrompt({
      key: 'PROD-1',
      prompt: 'text',
      parentKey: null,
      targetRepo: 'motir-core',
      targetRepoCloneUrl: null,
      targetRepoDefaultBranch: null,
      targetRepos: [],
      workflowMode: 'per_item_pr',
      sessionBranch: null,
      advisories: [
        {
          kind: 'shape',
          item: 'PROD-1',
          severity: 'likely-self-blocking-design',
          designCriterionIndex: 1,
          surfaceCriterionIndex: 4,
        },
      ],
    } as unknown as Parameters<typeof presentDispatchPrompt>[0]);

    expect(mapped.advisories[0]).toEqual({
      kind: 'shape',
      item: 'PROD-1',
      severity: 'likely-self-blocking-design',
      designCriterionIndex: 1,
      surfaceCriterionIndex: 4,
    });
    // No `criterionIndex` is invented on the way out, and no other member's
    // fields ride along — the point of the field-by-field mapper.
    expect(mapped.advisories[0]).not.toHaveProperty('criterionIndex');
    expect(mapped.advisories[0]).not.toHaveProperty('threshold');
    expect(() => dispatchPromptSchema.parse(mapped)).not.toThrow();
  });

  it('all FOUR `kind: "shape"` variants stay disjoint — none parses as another', () => {
    // The union is plain, not discriminated, so this guarantee rests entirely on
    // the four variants' REQUIRED fields being disjoint: `criterionIndex` /
    // `threshold` / the index PAIR / the counted claim. Asserted directly, because the day it stops
    // holding the failure is a silently stripped payload rather than an error.
    const selfBlocking = {
      kind: 'shape' as const,
      item: 'PROD-1',
      severity: 'likely-self-blocking-design',
      designCriterionIndex: 1,
      surfaceCriterionIndex: 4,
    };
    const sizing = {
      kind: 'shape' as const,
      item: 'PROD-1',
      severity: 'likely-over-gate-sizing',
      threshold: 'both',
      storyPoints: 13,
      estimateMinutes: 600,
    };
    const straddle = {
      kind: 'shape' as const,
      item: 'PROD-1',
      severity: 'likely-repo-straddle',
      criterionIndex: 2,
      path: 'motir-ai/src/x.ts',
      repo: 'motir-ai',
      reason: 'contradiction',
    };
    const blockerCount = {
      kind: 'shape' as const,
      item: 'PROD-1',
      severity: 'likely-blocker-count-mismatch',
      claim: 'four siblings this card is blocked_by',
      claimedCount: 4,
      blockerCount: 2,
    };
    const envelope = (advisories: unknown[]) => ({
      key: 'PROD-1',
      prompt: 'text',
      parentKey: null,
      targetRepo: null,
      targetRepoCloneUrl: null,
      targetRepoDefaultBranch: null,
      targetRepos: [],
      workflowMode: 'per_item_pr' as const,
      sessionBranch: null,
      advisories,
    });

    expect(dispatchPromptSchema.parse(envelope([selfBlocking])).advisories[0]).toEqual(
      selfBlocking,
    );
    expect(dispatchPromptSchema.parse(envelope([sizing])).advisories[0]).toEqual(sizing);
    expect(dispatchPromptSchema.parse(envelope([straddle])).advisories[0]).toEqual(straddle);
    expect(dispatchPromptSchema.parse(envelope([blockerCount])).advisories[0]).toEqual(
      blockerCount,
    );
    // …and all four together, in one array, since that is how a card carrying
    // several defects actually arrives.
    expect(
      dispatchPromptSchema.parse(envelope([selfBlocking, sizing, straddle, blockerCount]))
        .advisories,
    ).toEqual([selfBlocking, sizing, straddle, blockerCount]);
  });
});

describe('the work-loop job handle (ADR Amendment 6 Q3)', () => {
  it('has no field a RESULT could arrive in — that is how it signals "accepted"', () => {
    // The schema's shape IS the signal: no `items`, no `proposals`, no `count`,
    // no `status`. A client cannot read an outcome out of it, only an address to
    // come back to. Pinned here, ahead of the two endpoints that return it, so
    // neither can widen it into something that reads like a finished result.
    expect(Object.keys(planJobHandleSchema.shape).sort()).toEqual(['jobId', 'planId', 'statusUrl']);
  });

  it('builds the poll address in ONE place, so the two 202 endpoints agree', () => {
    expect(planStatusUrl('plan_123')).toBe('/api/v1/plans/plan_123/status');
  });
});
