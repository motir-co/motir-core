import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as INTEGRATE } from '@/app/api/v1/work-items/[key]/integration/route';
import { POST as REPORT_IMPL } from '@/app/api/v1/work-items/[key]/implementation/route';
import { POST as COMPLETE } from '@/app/api/v1/sessions/complete/route';
import {
  implementationReportSchema,
  integrationResultSchema,
  sessionCloseOutSchema,
  toProvenanceInput,
  type V1ImplementationReport,
  type V1IntegrationResult,
  type V1SessionCloseOut,
} from '@/lib/api/v1/workLoop/schema';
import { WORK_LOOP_OPERATIONS } from '@/lib/api/v1/workLoop/operations';
import { DOMAIN_ERROR_STATUS } from '@/lib/api/v1/errors';
import { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { runCompleteSession } from '@/lib/mcp/tools/completeSession';
import { runMarkIntegrated } from '@/lib/mcp/tools/markIntegrated';
import { workItemsService } from '@/lib/services/workItemsService';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// The two `integration`-scoped writes that close the work loop (Story 11.7 ·
// Subtask 11.7.4 — MOTIR-2238) against real Postgres.
//
// Three properties carry the card:
//
//   • The integration write is ATOMIC. `markIntegrated` moves the item to
//     `implemented` AND stamps its branch in one transaction; a route that
//     decomposed that would leave a delivered item with no lineage on a crash,
//     and every dependent inheriting the branch would inherit nothing. Asserted
//     by failing the write mid-flight and reading the row back.
//   • PARTIAL SUCCESS is a real outcome. A mixed branch returns both kinds in
//     one 200, never a failure and never uniform success.
//   • The `integration` SCOPE is not decorative. A token holding
//     `work_items:write` and not `integration` is refused on both — these two
//     operations are the entire reason that scope exists.

const BASE = 'http://localhost:3000/api/v1';

function post(caller: V1ProjectCaller, path: string, body: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { ...caller.headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function integrate(caller: V1ProjectCaller, key: string, body: unknown): Promise<Response> {
  return INTEGRATE(post(caller, `/work-items/${key}/integration`, body), {
    params: Promise.resolve({ key }),
  });
}

function reportImplementation(
  caller: V1ProjectCaller,
  key: string,
  body: unknown,
): Promise<Response> {
  return REPORT_IMPL(post(caller, `/work-items/${key}/implementation`, body), {
    params: Promise.resolve({ key }),
  });
}

function complete(caller: V1ProjectCaller, body: unknown): Promise<Response> {
  return COMPLETE(post(caller, '/sessions/complete', body));
}

async function makeItem(caller: V1ProjectCaller, title: string) {
  return workItemsService.createWorkItem(
    { projectId: caller.fixture.projectId, kind: 'task', title },
    caller.ctx,
  );
}

/** An item moved to `in_progress`, the status a run integrates from. */
async function readyToIntegrate(caller: V1ProjectCaller, title: string) {
  const item = await makeItem(caller, title);
  await workItemsService.updateStatus(item.id, 'in_progress', caller.ctx);
  return item;
}

async function stateOf(caller: V1ProjectCaller, id: string) {
  const item = await workItemsService.getWorkItem(id, caller.ctx);
  return { status: item.status, sessionBranch: item.sessionBranch };
}

describe('POST /api/v1/work-items/{key}/integration', () => {
  beforeEach(async () => {
    await truncateAuthTables();
    vi.restoreAllMocks();
  });

  it('moves the item to implemented and records the branch', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['integration'] });
    const item = await readyToIntegrate(caller, 'integrate me');

    const res = await integrate(caller, item.identifier, { sessionBranch: 'session/MOTIR-1' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as V1IntegrationResult;
    expect(() => integrationResultSchema.parse(body)).not.toThrow();
    expect(body.key).toBe(item.identifier);
    // `implemented` since MOTIR-2999: the integration write reports finished
    // work, and CI is what makes the card reviewable.
    expect(body.status).toBe('implemented');
    expect(body.sessionBranch).toBe('session/MOTIR-1');
    expect(await stateOf(caller, item.id)).toEqual({
      status: 'implemented',
      sessionBranch: 'session/MOTIR-1',
    });
  });

  it('applies the status move and the branch stamp ATOMICALLY — neither, or both', async () => {
    // The failure is injected BETWEEN the two effects: the transition has been
    // applied inside the transaction and the provenance write then throws. If
    // the route (or the service) had split them, the item would come back
    // `in_review` with no branch — the exact state a dependent would inherit
    // nothing from.
    const caller = await createV1ProjectCaller({ scopes: ['integration'] });
    const item = await readyToIntegrate(caller, 'atomic or nothing');
    vi.spyOn(workItemsService, 'recordImplementationProvenance').mockRejectedValueOnce(
      new Error('injected mid-transaction fault'),
    );

    const res = await integrate(caller, item.identifier, {
      sessionBranch: 'session/should-roll-back',
      implementationHarness: 'Claude Code',
    });

    expect(res.status).toBe(500);
    // NEITHER effect survived: the whole transaction rolled back.
    expect(await stateOf(caller, item.id)).toEqual({
      status: 'in_progress',
      sessionBranch: null,
    });
  });

  it('records the self-reported harness when supplied', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['integration'] });
    const item = await readyToIntegrate(caller, 'with provenance');

    const res = await integrate(caller, item.identifier, {
      sessionBranch: 'session/MOTIR-1',
      implementationHarness: 'Claude Code',
      implementationModel: 'claude-opus-5',
    });

    const body = (await res.json()) as V1IntegrationResult;
    expect(body.implementationHarness).toBe('Claude Code');
    expect(body.implementationModel).toBe('claude-opus-5');
    // `source` defaults to `byok` — a self-reported machine.
    expect(body.implementationSource).toBe('byok');
  });

  it('leaves provenance UNTOUCHED when none is supplied', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['integration'] });
    const item = await readyToIntegrate(caller, 'no provenance');

    const res = await integrate(caller, item.identifier, { sessionBranch: 'session/MOTIR-1' });

    const body = (await res.json()) as V1IntegrationResult;
    expect(body.implementationSource).toBeNull();
    expect(body.implementationHarness).toBeNull();
    expect(body.implementationModel).toBeNull();
  });

  it('refuses an item with no legal path to implemented, leaving the branch unset', async () => {
    // The workflow decides, not this route: `planning → implemented` is illegal on
    // the default workflow (`todo → implemented` is legal since MOTIR-12202, for a
    // pull request delivering a card nobody moved). The error has a deliberate row
    // in the v1 status map.
    const caller = await createV1ProjectCaller({ scopes: ['integration'] });
    const item = await makeItem(caller, 'being re-planned');
    await workItemsService.updateStatus(item.id, 'planning', caller.ctx);

    const res = await integrate(caller, item.identifier, { sessionBranch: 'session/MOTIR-1' });

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('ILLEGAL_TRANSITION');
    expect(DOMAIN_ERROR_STATUS['ILLEGAL_TRANSITION']).toBe(422);
    expect(await stateOf(caller, item.id)).toEqual({ status: 'planning', sessionBranch: null });
  });

  it('matches the MCP tool’s payload for the fields both publish', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['integration'] });
    const viaV1 = await readyToIntegrate(caller, 'via v1');
    const viaMcp = await readyToIntegrate(caller, 'via mcp');

    const res = await integrate(caller, viaV1.identifier, { sessionBranch: 'session/same' });
    const body = (await res.json()) as V1IntegrationResult;
    const tool = await runMarkIntegrated(
      { key: viaMcp.identifier, sessionBranch: 'session/same' },
      caller.ctx,
    );
    const payload = tool.structuredContent as Record<string, unknown>;

    expect(body.status).toBe(payload['status']);
    expect(body.sessionBranch).toBe(payload['sessionBranch']);
    expect(body.implementationSource).toBe(payload['implementationSource']);
    // Each names ITS OWN item, and v1 names it by the `MOTIR-<n>` key rather
    // than the internal cuid (§7) — the one field where the two shapes differ,
    // because `identifier` is the DTO's word and `key` is the API's.
    expect(body.key).toBe(viaV1.identifier);
    expect(payload['identifier']).toBe(viaMcp.identifier);
    expect(JSON.stringify(body)).not.toContain(viaV1.id);
  });

  it('refuses a BROWSE-ONLY token — 403', async () => {
    const caller = await createV1ProjectCaller({ permissions: ['project:browse'] });
    const item = await readyToIntegrate(caller, 'wrong permission');

    const res = await integrate(caller, item.identifier, { sessionBranch: 'session/MOTIR-1' });

    expect(res.status).toBe(403);
  });

  it('ADMITS a work-item-edit token — the merge MOTIR-2572 makes deliberately', async () => {
    // ⚠️ THIS ASSERTION IS THE REVERSE OF THE ONE IT REPLACES, on purpose. The
    // old test refused a `work_items:write` token here, because `integration`
    // was a separate scope. It is not a separate GATE: `markIntegrated` reaches
    // `applyStatusTransition → assertCanEdit`, the same gate `transition_status`
    // reaches, so the two scopes merge at `work_item:edit`. ADR §5 records the
    // merge, its direction and why it is accepted; this is where it is checked
    // rather than assumed.
    const caller = await createV1ProjectCaller({
      permissions: ['project:browse', 'work_item:edit'],
    });
    const item = await readyToIntegrate(caller, 'merged permission');

    const res = await integrate(caller, item.identifier, { sessionBranch: 'session/MOTIR-1' });

    expect(res.status).not.toBe(403);
  });

  it('answers 404 for a key in another workspace — never 403', async () => {
    const mine = await createV1ProjectCaller({ scopes: ['integration'] });
    const theirs = await createV1ProjectCaller({ scopes: ['integration'] });
    const hidden = await readyToIntegrate(theirs, 'not yours');

    const res = await integrate(mine, hidden.identifier, { sessionBranch: 'session/MOTIR-1' });

    expect(res.status).toBe(404);
    expect(await stateOf(theirs, hidden.id)).toEqual({
      status: 'in_progress',
      sessionBranch: null,
    });
  });

  it('422s a body with no branch, and one carrying an unknown field', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['integration'] });
    const item = await readyToIntegrate(caller, 'bad bodies');

    expect((await integrate(caller, item.identifier, {})).status).toBe(422);
    expect((await integrate(caller, item.identifier, { sessionBranch: 'b', nope: 1 })).status).toBe(
      422,
    );
  });
});

// PROVENANCE WITHOUT A BRANCH (MOTIR-2421). The per-item-PR path — `motir
// batch` opens one pull request per item off `main` — had no way to say what
// built an item, because the only write that recorded the triple also asserted
// a session branch.
//
// ⚠️ Every assertion here is a NEGATIVE one, deliberately. "Provenance was
// recorded" is satisfied by the dangerous fix too: inventing a branch so the
// existing call could be reused. What that fix breaks is `sessionBranch` and
// readiness, so those are what these tests read.
describe('POST /api/v1/work-items/{key}/implementation', () => {
  beforeEach(async () => {
    await truncateAuthTables();
    vi.restoreAllMocks();
  });

  it('records the triple and leaves the STATUS and the BRANCH alone', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['integration'] });
    const item = await readyToIntegrate(caller, 'built by an agent');
    await workItemsService.updateStatus(item.id, 'in_review', caller.ctx);

    const res = await reportImplementation(caller, item.identifier, {
      implementationSource: 'byok',
      implementationHarness: 'claude',
      implementationModel: 'claude-opus-5',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as V1ImplementationReport;
    expect(() => implementationReportSchema.parse(body)).not.toThrow();
    expect(body.implementationHarness).toBe('claude');
    expect(body.implementationModel).toBe('claude-opus-5');
    expect(body.implementationSource).toBe('byok');
    // The two facts the wrong implementation would change.
    expect(body.status).toBe('in_review');
    expect(body.sessionBranch).toBeNull();
    expect(await stateOf(caller, item.id)).toEqual({ status: 'in_review', sessionBranch: null });
  });

  it('leaves the item BLOCKING its dependents exactly as before', async () => {
    // The consequence that makes the short road dangerous rather than untidy: a
    // recorded branch reads as evidence a blocker is satisfied, so a dependent
    // would go ready with nothing merged.
    const caller = await createV1ProjectCaller({ scopes: ['integration'] });
    const blocker = await readyToIntegrate(caller, 'the blocker');
    const dependent = await makeItem(caller, 'the dependent');
    await workItemsService.linkWorkItems(
      { fromId: dependent.id, toId: blocker.id, kind: 'is_blocked_by' },
      caller.ctx,
    );

    const before = await workItemsService.getReadiness(dependent.id, caller.ctx);
    expect(before.ready).toBe(false);

    await reportImplementation(caller, blocker.identifier, {
      implementationSource: 'byok',
      implementationHarness: 'claude',
    });

    const after = await workItemsService.getReadiness(dependent.id, caller.ctx);
    expect(after.ready).toBe(false);
    expect([...after.openBlockerIds]).toEqual([blocker.id]);
    // …and it inherits no lineage from an item that never had one.
    expect(after.inheritedSessionBranch).toBeNull();
  });

  it('a batch-run item is NOT found by the session close-out', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['integration'] });
    const item = await readyToIntegrate(caller, 'own pull request');
    await workItemsService.updateStatus(item.id, 'in_review', caller.ctx);
    await reportImplementation(caller, item.identifier, { implementationSource: 'byok' });

    // Any branch a close-out might sweep: the item belongs to none of them.
    const res = await complete(caller, { sessionBranch: 'motir/auto-1' });
    const body = (await res.json()) as V1SessionCloseOut;
    expect(body.results).toEqual([]);
    expect(await stateOf(caller, item.id)).toEqual({ status: 'in_review', sessionBranch: null });
  });

  it('422s a body carrying a sessionBranch — the field is refused, not ignored', async () => {
    // A caller reaching for the branch here is reaching for the fix that would
    // unblock dependents without a merge. `.strict()` makes that a loud failure
    // instead of a silently dropped field that looks like it worked.
    const caller = await createV1ProjectCaller({ scopes: ['integration'] });
    const item = await readyToIntegrate(caller, 'no branches here');

    const res = await reportImplementation(caller, item.identifier, {
      sessionBranch: 'session/nope',
      implementationHarness: 'claude',
    });

    expect(res.status).toBe(422);
    expect(await stateOf(caller, item.id)).toEqual({ status: 'in_progress', sessionBranch: null });
  });

  it('an OMITTED field leaves what an earlier report recorded', async () => {
    // Shares `toProvenanceInput` with its siblings, so it inherits MOTIR-2447's
    // partial-report rule rather than restating it.
    const caller = await createV1ProjectCaller({ scopes: ['integration'] });
    const item = await readyToIntegrate(caller, 'partial report');
    await reportImplementation(caller, item.identifier, {
      implementationHarness: 'codex',
      implementationModel: 'gpt-5-codex',
    });

    const res = await reportImplementation(caller, item.identifier, {
      implementationSource: 'byok',
    });

    const body = (await res.json()) as V1ImplementationReport;
    expect(body.implementationHarness).toBe('codex');
    expect(body.implementationModel).toBe('gpt-5-codex');
  });

  it('refuses a BROWSE-ONLY token — 403', async () => {
    // The DECLARATION (`work_item:edit`) is what refuses here — the wrapper runs
    // before the service does. Since MOTIR-2603 the service refuses a
    // browse-only ACTOR too (`assertCanEdit` before the provenance write), so
    // this is no longer the only thing standing between a read token and a
    // write; the two gates are independent and both are asserted — the actor
    // half in `tests/work-items/report-implementation-gate.test.ts`.
    const caller = await createV1ProjectCaller({ permissions: ['project:browse'] });
    const item = await readyToIntegrate(caller, 'wrong permission');

    const res = await reportImplementation(caller, item.identifier, {
      implementationSource: 'byok',
    });

    expect(res.status).toBe(403);
  });

  it('answers 404 for a key in another workspace — never 403', async () => {
    const mine = await createV1ProjectCaller({ scopes: ['integration'] });
    const theirs = await createV1ProjectCaller({ scopes: ['integration'] });
    const hidden = await readyToIntegrate(theirs, 'not yours');

    const res = await reportImplementation(mine, hidden.identifier, {
      implementationSource: 'byok',
    });

    expect(res.status).toBe(404);
    const still = await workItemsService.getWorkItem(hidden.id, theirs.ctx);
    expect(still.implementationSource).toBeNull();
  });
});

describe('POST /api/v1/sessions/complete', () => {
  beforeEach(async () => {
    await truncateAuthTables();
    vi.restoreAllMocks();
  });

  it('closes every item on the branch and clears the lineage', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['integration'] });
    const first = await readyToIntegrate(caller, 'first');
    const second = await readyToIntegrate(caller, 'second');
    await workItemsService.markIntegrated(first.id, 'session/merged', caller.ctx);
    await workItemsService.markIntegrated(second.id, 'session/merged', caller.ctx);

    const res = await complete(caller, { sessionBranch: 'session/merged' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as V1SessionCloseOut;
    expect(() => sessionCloseOutSchema.parse(body)).not.toThrow();
    expect(body.sessionBranch).toBe('session/merged');
    expect(body.results.map((r) => r.outcome)).toEqual(['completed', 'completed']);
    expect(await stateOf(caller, first.id)).toEqual({ status: 'done', sessionBranch: null });
    expect(await stateOf(caller, second.id)).toEqual({ status: 'done', sessionBranch: null });
  });

  it('carries a SLASH in the branch name — the reason it rides in the body', async () => {
    // A git ref routinely contains `/`. A path segment could not carry this.
    const caller = await createV1ProjectCaller({ scopes: ['integration'] });
    const item = await readyToIntegrate(caller, 'on a real ref');
    await workItemsService.markIntegrated(item.id, 'subtask/MOTIR-2238-close-out', caller.ctx);

    const res = await complete(caller, { sessionBranch: 'subtask/MOTIR-2238-close-out' });

    const body = (await res.json()) as V1SessionCloseOut;
    expect(body.sessionBranch).toBe('subtask/MOTIR-2238-close-out');
    expect(body.results).toHaveLength(1);
    expect(body.results[0]?.outcome).toBe('completed');
  });

  it('returns BOTH kinds on a mixed branch — a partial close is not a failure', async () => {
    // The service checks the legal transition before writing and does NOT roll
    // back the items that closed. So the request SUCCEEDED and the per-item list
    // is the payload; collapsing it into one verdict would lose the half that
    // matters.
    const caller = await createV1ProjectCaller({ scopes: ['integration'] });
    const closable = await readyToIntegrate(caller, 'can close');
    const stuck = await readyToIntegrate(caller, 'cannot close');
    await workItemsService.markIntegrated(closable.id, 'session/mixed', caller.ctx);
    await workItemsService.markIntegrated(stuck.id, 'session/mixed', caller.ctx);
    // Move the second one somewhere `done` is not reachable from, while leaving
    // its recorded branch in place.
    await workItemsService.updateStatus(stuck.id, 'blocked', caller.ctx);

    const res = await complete(caller, { sessionBranch: 'session/mixed' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as V1SessionCloseOut;
    const byKey = new Map(body.results.map((r) => [r.key, r]));
    expect(byKey.get(closable.identifier)?.outcome).toBe('completed');
    expect(byKey.get(stuck.identifier)?.outcome).toBe('failed');
    // A failure names its reason; a success does not carry the key at all.
    expect(typeof byKey.get(stuck.identifier)?.reason).toBe('string');
    expect(byKey.get(closable.identifier)).not.toHaveProperty('reason');
    // …and the one that COULD close did, rather than being rolled back with it.
    expect(await stateOf(caller, closable.id)).toEqual({ status: 'done', sessionBranch: null });
  });

  it('answers 200 with an empty list for a branch nothing is recorded on', async () => {
    // The branch is not a resource — "nothing was recorded on it" is a true
    // answer to the question asked, so a 404 would be a category error.
    const caller = await createV1ProjectCaller({ scopes: ['integration'] });

    const res = await complete(caller, { sessionBranch: 'session/never-existed' });

    expect(res.status).toBe(200);
    expect((await res.json()) as V1SessionCloseOut).toEqual({
      sessionBranch: 'session/never-existed',
      results: [],
    });
  });

  it('closes nothing in ANOTHER workspace that happens to share the branch name', async () => {
    // Branch names are not unique across tenants; the service scopes by
    // workspace and this asserts the endpoint inherits that.
    const mine = await createV1ProjectCaller({ scopes: ['integration'] });
    const theirs = await createV1ProjectCaller({ scopes: ['integration'] });
    const hidden = await readyToIntegrate(theirs, 'theirs');
    await workItemsService.markIntegrated(hidden.id, 'session/shared-name', theirs.ctx);

    const res = await complete(mine, { sessionBranch: 'session/shared-name' });

    expect(res.status).toBe(200);
    expect(((await res.json()) as V1SessionCloseOut).results).toEqual([]);
    expect(await stateOf(theirs, hidden.id)).toEqual({
      status: 'implemented',
      sessionBranch: 'session/shared-name',
    });
  });

  it('matches the MCP tool’s payload field by field', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['integration'] });
    const viaV1 = await readyToIntegrate(caller, 'v1 branch');
    const viaMcp = await readyToIntegrate(caller, 'mcp branch');
    await workItemsService.markIntegrated(viaV1.id, 'session/v1', caller.ctx);
    await workItemsService.markIntegrated(viaMcp.id, 'session/mcp', caller.ctx);

    const body = (await (
      await complete(caller, { sessionBranch: 'session/v1' })
    ).json()) as V1SessionCloseOut;
    const tool = await runCompleteSession({ sessionBranch: 'session/mcp' }, caller.ctx);
    const payload = tool.structuredContent as {
      sessionBranch: string;
      results: { key: string; outcome: string }[];
    };

    expect(Object.keys(body).sort()).toEqual(Object.keys(payload).sort());
    expect(body.results.map((r) => r.outcome)).toEqual(payload.results.map((r) => r.outcome));
    expect(Object.keys(body.results[0] ?? {}).sort()).toEqual(
      Object.keys(payload.results[0] ?? {}).sort(),
    );
  });

  it('refuses a BROWSE-ONLY token — 403', async () => {
    const caller = await createV1ProjectCaller({ permissions: ['project:browse'] });

    const res = await complete(caller, { sessionBranch: 'session/anything' });

    expect(res.status).toBe(403);
  });

  it('422s a body with no branch', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['integration'] });

    expect((await complete(caller, {})).status).toBe(422);
    expect((await complete(caller, { sessionBranch: '' })).status).toBe(422);
  });
});

describe('the close-out contract', () => {
  it('gates both on the permission their MCP counterparts carry, not on a copy', () => {
    const byId = new Map(WORK_LOOP_OPERATIONS.map((op) => [op.operationId, op]));
    expect(byId.get('recordWorkItemIntegration')?.permission).toBe(
      TOOL_PERMISSIONS.mark_integrated,
    );
    expect(byId.get('completeSession')?.permission).toBe(TOOL_PERMISSIONS.complete_session);
    // …and that permission is `work_item:edit`, because both reach
    // `applyStatusTransition → assertCanEdit` — the same gate `transition_status`
    // reaches. The old `integration` scope drew a line the gates do not (ADR §5).
    expect(TOOL_PERMISSIONS.mark_integrated).toBe('work_item:edit');
  });

  it('omits provenance ENTIRELY when the caller reported none', () => {
    // The `undefined` is what leaves a hosted run's own record alone; a
    // half-built object would stamp `byok` over it.
    expect(toProvenanceInput({})).toBeUndefined();
  });

  it('carries a PARTIAL report as partial — an absent field never becomes null', () => {
    // MOTIR-2447: `?? null` here turned "I do not know" into "there is none",
    // which is how `motir done --session` — a caller that knows only the source
    // — erased the agent and model the run had already recorded. Asserted with
    // `toEqual`, which fails on an extra key, so a reintroduced default cannot
    // pass.
    expect(toProvenanceInput({ implementationHarness: 'Claude Code' })).toEqual({
      harness: 'Claude Code',
    });
    expect(toProvenanceInput({ implementationSource: 'manual' })).toEqual({ source: 'manual' });
    expect(toProvenanceInput({ implementationModel: 'claude-opus-5' })).toEqual({
      model: 'claude-opus-5',
    });
    // A full report still carries all three.
    expect(
      toProvenanceInput({
        implementationSource: 'byok',
        implementationHarness: 'claude',
        implementationModel: 'claude-opus-5',
      }),
    ).toEqual({ source: 'byok', harness: 'claude', model: 'claude-opus-5' });
  });
});
