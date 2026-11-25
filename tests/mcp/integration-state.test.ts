import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { IllegalTransitionError } from '@/lib/workItems/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { spyOnJobDispatch } from '../helpers/jobs';

// Integration-state substrate (Story 7.8 · Subtask 7.8.11): the `implemented`
// status + `work_item.session_branch` + the integrated-dep readiness rule +
// `mark_integrated` / `complete_session`. Real Postgres; the project comes from
// makeWorkItemFixture (default workflow: todo → in_progress → in_review → done,
// plus blocked). The Inngest publish is stubbed — the status-transition paths
// emit `work-item/transitioned` post-commit (the transition-suite pattern).

beforeEach(async () => {
  spyOnJobDispatch();
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Create a leaf task in `fx`'s project. */
async function task(fx: WorkItemFixture, title: string) {
  return workItemsService.createWorkItem({ projectId: fx.projectId, kind: 'task', title }, fx.ctx);
}

/** `from` is_blocked_by `to`. */
async function block(fx: WorkItemFixture, fromId: string, toId: string) {
  await workItemsService.linkWorkItems({ fromId, toId, kind: 'is_blocked_by' }, fx.ctx);
}

/** Move an item todo → in_progress (the legal precondition for in_review). */
async function start(fx: WorkItemFixture, id: string) {
  await workItemsService.updateStatus(id, 'in_progress', fx.ctx);
}

describe('integrated-dep readiness (7.8.11) — a recorded session branch unblocks dependents', () => {
  it('an implemented dep WITH a session branch unblocks B; WITHOUT it does NOT; done still does', async () => {
    const fx = await makeWorkItemFixture();
    const a = await task(fx, 'A (the dependency)');
    const b = await task(fx, 'B (depends on A)');
    await block(fx, b.id, a.id);

    // A still in `todo` → B blocked.
    expect(await workItemsService.isReady(b.id, fx.ctx)).toBe(false);

    // Move A to implemented WITHOUT recording a branch (a raw status change, not
    // `mark_integrated`): the FIELD is the signal, so B is STILL blocked.
    // (`mark_integrated` lands at `implemented` since MOTIR-3004 — built, pushed,
    // waiting on CI — so this raw move names the same status it would.)
    await start(fx, a.id);
    await workItemsService.updateStatus(a.id, 'implemented', fx.ctx);
    expect(await workItemsService.isReady(b.id, fx.ctx)).toBe(false);

    // Record the branch via mark_integrated → A is integrated-awaiting-review →
    // B unblocks (a done dep would too, tested below).
    await workItemsService.markIntegrated(a.id, 'session/PROD-run-1', fx.ctx);
    expect(await workItemsService.isReady(b.id, fx.ctx)).toBe(true);

    // And a fully done dep still unblocks (done clears the branch).
    await workItemsService.completeSession('session/PROD-run-1', fx.ctx);
    const refreshedA = await workItemsService.getWorkItem(a.id, fx.ctx);
    expect(refreshedA.status).toBe('done');
    expect(refreshedA.sessionBranch).toBeNull();
    expect(await workItemsService.isReady(b.id, fx.ctx)).toBe(true);
  });

  it('conflicting lineages — deps integrated on TWO branches keep the item out of the ready set', async () => {
    const fx = await makeWorkItemFixture();
    const a = await task(fx, 'A');
    const c = await task(fx, 'C');
    const b = await task(fx, 'B (depends on A and C)');
    await block(fx, b.id, a.id);
    await block(fx, b.id, c.id);

    await start(fx, a.id);
    await start(fx, c.id);
    await workItemsService.markIntegrated(a.id, 'session/branch-1', fx.ctx);
    await workItemsService.markIntegrated(c.id, 'session/branch-2', fx.ctx);

    // Two distinct lineages → NOT ready, and the verdict names them.
    const verdict = await workItemsService.getReadiness(b.id, fx.ctx);
    expect(verdict.ready).toBe(false);
    expect(verdict.openBlockerIds.size).toBe(0); // neither blocker is "open"…
    expect(verdict.conflictingSessionBranches).toEqual(['session/branch-1', 'session/branch-2']);
    expect(verdict.inheritedSessionBranch).toBeNull();

    // Re-integrate C onto A's branch → single lineage → ready, inherited branch set.
    await workItemsService.markIntegrated(c.id, 'session/branch-1', fx.ctx);
    const ok = await workItemsService.getReadiness(b.id, fx.ctx);
    expect(ok.ready).toBe(true);
    expect(ok.conflictingSessionBranches).toEqual([]);
    expect(ok.inheritedSessionBranch).toBe('session/branch-1');
  });

  it('listReady / next_ready honor the rule and the dispatch payload carries the inherited branch', async () => {
    const fx = await makeWorkItemFixture();
    const a = await task(fx, 'A');
    const b = await task(fx, 'B');
    await block(fx, b.id, a.id);
    await start(fx, a.id);
    await workItemsService.markIntegrated(a.id, 'session/PROD-42', fx.ctx);

    // B is the only ready candidate (A is in_review, not a todo candidate).
    const { items } = await workItemsService.listReady(fx.projectId, {}, fx.ctx);
    expect(items.map((i) => i.id)).toContain(b.id);

    // The dispatch payload for B inherits A's branch.
    const dispatch = await workItemsService.getNextReady(fx.projectId, {}, fx.ctx);
    expect(dispatch?.id).toBe(b.id);
    expect(dispatch?.sessionBranch).toBe('session/PROD-42');

    // An item with no integrated dep carries null.
    const standalone = await task(fx, 'standalone');
    const solo = await workItemsService.getNextReady(fx.projectId, { excludeIds: [b.id] }, fx.ctx);
    expect(solo?.id).toBe(standalone.id);
    expect(solo?.sessionBranch).toBeNull();
  });
});

describe('mark_integrated (7.8.11) — transactional status + branch', () => {
  it('sets implemented + branch together; re-marking updates the branch with no status change', async () => {
    const fx = await makeWorkItemFixture();
    const a = await task(fx, 'A');
    await start(fx, a.id);

    const integrated = await workItemsService.markIntegrated(a.id, 'session/v1', fx.ctx);
    expect(integrated.status).toBe('implemented');
    expect(integrated.sessionBranch).toBe('session/v1');

    // Re-mark with a new branch — already implemented, so a branch-only write.
    const remarked = await workItemsService.markIntegrated(a.id, 'session/v2', fx.ctx);
    expect(remarked.status).toBe('implemented');
    expect(remarked.sessionBranch).toBe('session/v2');
  });

  it('an ILLEGAL transition to implemented throws and leaves the branch untouched', async () => {
    const fx = await makeWorkItemFixture();
    // A is at `planning`; planning → implemented is NOT a legal default transition
    // (todo, in_progress, blocked and the ejection's in_review / approved are — the
    // first since MOTIR-12202), so mark_integrated must reject it.
    const a = await task(fx, 'A');
    await workItemsService.updateStatus(a.id, 'planning', fx.ctx);
    await expect(workItemsService.markIntegrated(a.id, 'session/x', fx.ctx)).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
    const after = await workItemsService.getWorkItem(a.id, fx.ctx);
    expect(after.status).toBe('planning');
    expect(after.sessionBranch).toBeNull();
  });
});

describe('complete_session (7.8.11) — bulk close-out', () => {
  it('flips every recorded item to done and clears the branch (a 3-item session)', async () => {
    const fx = await makeWorkItemFixture();
    const items = await Promise.all([task(fx, 'one'), task(fx, 'two'), task(fx, 'three')]);
    for (const it of items) {
      await start(fx, it.id);
      await workItemsService.markIntegrated(it.id, 'session/bulk', fx.ctx);
    }

    const result = await workItemsService.completeSession('session/bulk', fx.ctx);
    expect(result.sessionBranch).toBe('session/bulk');
    expect(result.results).toHaveLength(3);
    expect(result.results.every((r) => r.outcome === 'completed')).toBe(true);

    for (const it of items) {
      const after = await workItemsService.getWorkItem(it.id, fx.ctx);
      expect(after.status).toBe('done');
      expect(after.sessionBranch).toBeNull();
    }
  });

  it('an empty branch returns an empty result', async () => {
    const fx = await makeWorkItemFixture();
    const result = await workItemsService.completeSession('session/nobody', fx.ctx);
    expect(result).toEqual({ sessionBranch: 'session/nobody', results: [] });
  });

  it('surfaces a per-item FAILURE without blocking the items that can complete', async () => {
    const fx = await makeWorkItemFixture();
    const okItem = await task(fx, 'completable');
    await start(fx, okItem.id);
    await workItemsService.markIntegrated(okItem.id, 'session/mixed', fx.ctx);

    // A second item parked on the same branch while still in `todo` (set
    // directly): todo → done is NOT a legal default transition, so it must
    // surface as `failed` while the legal item still completes.
    const stuck = await task(fx, 'stuck-in-todo');
    await adminDb.workItem.update({
      where: { id: stuck.id },
      data: { sessionBranch: 'session/mixed' },
    });

    const result = await workItemsService.completeSession('session/mixed', fx.ctx);
    const byKey = new Map(result.results.map((r) => [r.key, r]));
    expect(byKey.get(okItem.identifier)?.outcome).toBe('completed');
    expect(byKey.get(stuck.identifier)?.outcome).toBe('failed');
    expect(byKey.get(stuck.identifier)?.reason).toBeTruthy();

    // The completable one really committed; the stuck one is untouched.
    expect((await workItemsService.getWorkItem(okItem.id, fx.ctx)).status).toBe('done');
    expect((await workItemsService.getWorkItem(stuck.id, fx.ctx)).status).toBe('todo');
  });

  it('an item already in done on the branch is an idempotent no-op and clears the branch', async () => {
    const fx = await makeWorkItemFixture();
    const a = await task(fx, 'already done');
    // Park a done item on the branch with a lingering field (invariant repair).
    await adminDb.workItem.update({
      where: { id: a.id },
      data: { status: 'done', sessionBranch: 'session/repair' },
    });

    const result = await workItemsService.completeSession('session/repair', fx.ctx);
    expect(result.results).toEqual([{ key: a.identifier, outcome: 'already_done' }]);
    expect((await workItemsService.getWorkItem(a.id, fx.ctx)).sessionBranch).toBeNull();
  });
});

describe('done clears the session branch (7.8.11 invariant) on any transition', () => {
  it('a plain status move to done clears a recorded branch', async () => {
    const fx = await makeWorkItemFixture();
    const a = await task(fx, 'A');
    await start(fx, a.id);
    await workItemsService.markIntegrated(a.id, 'session/plain', fx.ctx);
    expect((await workItemsService.getWorkItem(a.id, fx.ctx)).sessionBranch).toBe('session/plain');

    // in_review → done via the ordinary status path clears the field too.
    await workItemsService.updateStatus(a.id, 'done', fx.ctx);
    expect((await workItemsService.getWorkItem(a.id, fx.ctx)).sessionBranch).toBeNull();
  });
});

// Implementation provenance (Story MOTIR-1685 · MOTIR-1692) — the self-reported
// BYOK/manual recording seam over the session tools + the reusable service method
// + the manual completion lane.
describe('implementation provenance (MOTIR-1685) — the recording seam', () => {
  /** A leaf whose executor is human (the manual lane) or a coding agent. */
  async function typedTask(
    fx: WorkItemFixture,
    title: string,
    over: { type?: 'manual' | 'code'; executor?: 'human' | 'coding_agent' } = {},
  ) {
    return workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title, ...over },
      fx.ctx,
    );
  }

  it('mark_integrated self-reports byok provenance (source defaults to byok)', async () => {
    const fx = await makeWorkItemFixture();
    const a = await task(fx, 'BYOK built');
    await start(fx, a.id);

    const dto = await workItemsService.markIntegrated(a.id, 'session/byok', fx.ctx, {
      harness: 'opencode',
      model: 'deepseek',
    });
    expect(dto.implementationSource).toBe('byok');
    expect(dto.implementationHarness).toBe('opencode');
    expect(dto.implementationModel).toBe('deepseek');

    // Persisted through the detail read.
    const reread = await workItemsService.getWorkItem(a.id, fx.ctx);
    expect(reread.implementationSource).toBe('byok');
    expect(reread.implementationModel).toBe('deepseek');
  });

  it('mark_integrated without a report leaves the implementation triple null', async () => {
    const fx = await makeWorkItemFixture();
    const a = await task(fx, 'No report');
    await start(fx, a.id);
    const dto = await workItemsService.markIntegrated(a.id, 'session/none', fx.ctx);
    expect(dto.implementationSource).toBeNull();
    expect(dto.implementationHarness).toBeNull();
  });

  it('a human/manual item reaching done records source = manual (the manual lane)', async () => {
    const fx = await makeWorkItemFixture();
    const a = await typedTask(fx, 'Human task', { executor: 'human' });
    await start(fx, a.id);
    await workItemsService.updateStatus(a.id, 'in_review', fx.ctx);
    await workItemsService.updateStatus(a.id, 'done', fx.ctx);

    const reread = await workItemsService.getWorkItem(a.id, fx.ctx);
    expect(reread.implementationSource).toBe('manual');
    expect(reread.implementationHarness).toBeNull();
    expect(reread.implementationModel).toBeNull();
  });

  it('a coding-agent item reaching done WITHOUT a report stays null (never auto-manual)', async () => {
    const fx = await makeWorkItemFixture();
    const a = await typedTask(fx, 'Agent task', { type: 'code' }); // seeds executor coding_agent
    await start(fx, a.id);
    await workItemsService.updateStatus(a.id, 'in_review', fx.ctx);
    await workItemsService.updateStatus(a.id, 'done', fx.ctx);
    expect((await workItemsService.getWorkItem(a.id, fx.ctx)).implementationSource).toBeNull();
  });

  it('the manual lane NEVER overwrites a prior byok report at done', async () => {
    const fx = await makeWorkItemFixture();
    const a = await typedTask(fx, 'Human item, but agent-reported', { executor: 'human' });
    await start(fx, a.id);
    // A byok report arrives at integration...
    await workItemsService.markIntegrated(a.id, 'session/keep', fx.ctx, {
      harness: 'Claude Code',
      model: 'claude',
    });
    // ...and the human merge closes it out; the byok stamp must survive.
    await workItemsService.updateStatus(a.id, 'done', fx.ctx);
    const reread = await workItemsService.getWorkItem(a.id, fx.ctx);
    expect(reread.implementationSource).toBe('byok');
    expect(reread.implementationModel).toBe('claude');
  });

  it('complete_session stamps the reported provenance on every closed item', async () => {
    const fx = await makeWorkItemFixture();
    const items = await Promise.all([task(fx, 'a'), task(fx, 'b')]);
    for (const it of items) {
      await start(fx, it.id);
      await workItemsService.markIntegrated(it.id, 'session/close', fx.ctx);
    }
    const result = await workItemsService.completeSession('session/close', fx.ctx, {
      harness: 'Codex',
      model: 'openai',
    });
    expect(result.results.every((r) => r.outcome === 'completed')).toBe(true);
    for (const it of items) {
      const reread = await workItemsService.getWorkItem(it.id, fx.ctx);
      expect(reread.status).toBe('done');
      expect(reread.implementationSource).toBe('byok');
      expect(reread.implementationHarness).toBe('Codex');
      expect(reread.implementationModel).toBe('openai');
    }
  });

  it('recordImplementationProvenance persists the triple in a caller tx, independent of the session tools', async () => {
    const fx = await makeWorkItemFixture();
    const a = await task(fx, 'Direct stamp');
    // The reusable seam Epic 9's hosted runner will call with metered values.
    const row = await withWorkspaceContext(fx.ctx, (tx) =>
      workItemsService.recordImplementationProvenance(
        a.id,
        { source: 'hosted', harness: 'Motir', model: 'claude-opus-4-8' },
        tx,
      ),
    );
    expect(row.implementationSource).toBe('hosted');
    expect(row.implementationHarness).toBe('Motir');
    expect(row.implementationModel).toBe('claude-opus-4-8');
  });
});
