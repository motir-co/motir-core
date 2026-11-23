import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { User } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { presentWorkItemRepairClaim } from '@/lib/api/v1/workLoop/schema';
import {
  CLAIM_WORK_ITEM_REPAIR_TOOL_NAME,
  CLOSE_WORK_ITEM_REPAIR_TOOL_NAME,
  TOUCH_WORK_ITEM_REPAIR_TOOL_NAME,
  runClaimWorkItemRepair,
  runCloseWorkItemRepair,
  runTouchWorkItemRepair,
} from '@/lib/mcp/tools/workItemRepair';
import { CLI_TOKEN_GRANT, TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { EXEMPT_TOOLS } from '@/lib/mcp/payloads/exemptions';
import { REPAIR_CLOSE_OUTCOMES } from '@/lib/dto/workItemRepair';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { usersService } from '@/lib/services/usersService';
import {
  REPAIR_CLOSE_STOP_REASON,
  workItemRepairService,
} from '@/lib/services/workItemRepairService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';
import { connectRepairRepo, deliveredPr, setStatus } from '../helpers/repairFixtures';

// MOTIR-6807 — the three REPAIR tools, entered at the TOOL ADAPTER, over real
// Postgres: the key resolution, the claim DTO passthrough, the outcome → stop
// reason map, and the ownership refusal on touch and close. The same calls
// through the real MCP transport — parity with REST across two doors, every
// refusal, the liveness sweep, concurrency — are the story's gate (MOTIR-6808).
//
// Each case is chosen so the obvious broken adapter fails it:
//
//   1. PARITY is asserted against v1's presenter over the SAME run (a `mine`
//      re-claim) — an adapter that hand-built its payload, and dropped or
//      renamed a field, fails the deep equality.
//   2. The claim BEATS once — an adapter that called `claimRepair` bare leaves
//      `lastHeartbeatAt` null, and the run on the 12-hour age reap.
//   3. Touch and close on ANOTHER user's run are refused AND the row is
//      unchanged — an adapter that passed only `runId` to `close` (which does
//      not check the operator) would close it successfully.
//   4. A second close returns the FIRST close's stop reason — an adapter that
//      re-closed would raise DISPATCH_RUN_TERMINAL, one that overwrote would
//      change it.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function member(
  fx: WorkItemFixture,
  name: string,
): Promise<{ user: User; ctx: ServiceContext }> {
  const user = await usersService.createUser({
    email: `${name.toLowerCase().replace(/\W/g, '')}+${randomToken()}@example.com`,
    password: 'hunter2hunter2',
    name,
  });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  return { user, ctx: { userId: user.id, workspaceId: fx.workspaceId } };
}

/** An `implemented` task with ONE open pull request whose `Vitest` is failing. */
async function redCard(fx: WorkItemFixture, title = 'red card') {
  const card = await createTestWorkItem(fx, { kind: 'task', title });
  await setStatus(card.id, 'implemented');
  const repo = await connectRepairRepo(fx, `web-${randomToken(4)}`);
  await deliveredPr(fx, card.id, repo, {
    headRef: 'subtask/red-card',
    baseRef: 'main',
    checks: { Vitest: 'failure', Lint: 'success' },
  });
  return card;
}

function ok<T>(result: CallToolResult): T {
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return result.structuredContent as T;
}

function text(result: CallToolResult): string {
  return (result.content[0] as { text: string }).text;
}

function errorCode(result: CallToolResult): string {
  expect(result.isError).toBe(true);
  return text(result).split(':')[0] as string;
}

interface ClaimOut {
  outcome: string;
  reason: string | null;
  runId: string | null;
  holder: { id: string; name: string } | null;
  pullRequests: {
    headRef: string;
    failingChecks: string[];
    conflicted: boolean;
    outOfDate: boolean;
  }[];
}
interface RunOut {
  key: string;
  runId: string;
  open: boolean;
  status: string;
  stopReason: string | null;
  lastHeartbeatAt: string | null;
}

const runRow = (id: string) => adminDb.dispatchRun.findUniqueOrThrow({ where: { id } });

describe('the registry sites', () => {
  it('registers all three tools, gated work_item:edit, inside the CLI grant', () => {
    for (const name of [
      CLAIM_WORK_ITEM_REPAIR_TOOL_NAME,
      TOUCH_WORK_ITEM_REPAIR_TOOL_NAME,
      CLOSE_WORK_ITEM_REPAIR_TOOL_NAME,
    ] as const) {
      expect(MCP_TOOL_NAMES).toContain(name);
      expect(TOOL_PERMISSIONS[name]).toBe('work_item:edit');
    }
    expect(CLI_TOKEN_GRANT).toContain('work_item:edit');
    // The claim DERIVES (it is v1's `WorkItemRepairClaim`); touch and close answer
    // a narrow liveness shape and are exempt.
    expect(Object.keys(EXEMPT_TOOLS)).not.toContain(CLAIM_WORK_ITEM_REPAIR_TOOL_NAME);
    expect(Object.keys(EXEMPT_TOOLS)).toContain(TOUCH_WORK_ITEM_REPAIR_TOOL_NAME);
    expect(Object.keys(EXEMPT_TOOLS)).toContain(CLOSE_WORK_ITEM_REPAIR_TOOL_NAME);
  });

  it('maps every close outcome onto the CLI’s stop reasons', () => {
    expect(Object.keys(REPAIR_CLOSE_STOP_REASON).sort()).toEqual([...REPAIR_CLOSE_OUTCOMES].sort());
    expect(REPAIR_CLOSE_STOP_REASON).toEqual({
      green: 'completed',
      gave_up: 'halted',
      halted: 'halted',
      interrupted: 'interrupted',
    });
  });
});

describe('claim_work_item_repair', () => {
  it('claims by a lower-case key and answers exactly what v1’s presenter answers', async () => {
    const fx = await makeWorkItemFixture();
    const card = await redCard(fx);

    const claimed = ok<ClaimOut>(
      await runClaimWorkItemRepair({ key: card.identifier.toLowerCase() }, fx.ctx),
    );
    expect(claimed).toMatchObject({ outcome: 'claimed', reason: null, holder: { id: fx.ownerId } });
    expect(claimed.pullRequests).toEqual([
      expect.objectContaining({ headRef: 'subtask/red-card', failingChecks: ['Vitest'] }),
    ]);

    // Parity over the SAME run: the owner's re-claim is `mine`, through both
    // doors — the tool's payload and v1's presenter over the service's DTO.
    const viaTool = ok<ClaimOut>(await runClaimWorkItemRepair({ key: card.identifier }, fx.ctx));
    const viaRest = presentWorkItemRepairClaim(
      await workItemRepairService.claimRepair(fx.projectId, card.identifier, fx.ctx),
    );
    expect(viaTool).toEqual(viaRest);
    expect(viaTool.outcome).toBe('mine');
    expect(viaTool.runId).toBe(claimed.runId);
  });

  it('a GREEN member behind or conflicting with its base is named in the text with what to do, and on the payload (Bug MOTIR-12095)', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'stale base' });
    await setStatus(card.id, 'implemented');
    const repo = await connectRepairRepo(fx, `web-${randomToken(4)}`);
    const head = 'c'.repeat(40);
    const stale = [
      { headRef: 'subtask/behind', baseRef: 'main', mergeableState: 'behind' },
      { headRef: 'subtask/conflicted', baseRef: 'release', mergeableState: 'dirty' },
      // A row mirrored before base branches were recorded names no base.
      { headRef: 'subtask/no-base', baseRef: null, mergeableState: 'behind' },
    ];
    for (const s of stale) {
      const row = await deliveredPr(fx, card.id, repo, {
        headRef: s.headRef,
        checks: { Vitest: 'success' },
      });
      await adminDb.githubPullRequest.update({
        where: { id: row.id },
        data: {
          baseRef: s.baseRef,
          mergeableState: s.mergeableState,
          mergeableStateHeadSha: head,
        },
      });
    }

    const result = await runClaimWorkItemRepair({ key: card.identifier }, fx.ctx);

    const claimed = ok<ClaimOut>(result);
    expect(claimed.outcome).toBe('claimed');
    expect(
      claimed.pullRequests.map((pr) => [pr.headRef, pr.conflicted, pr.outOfDate]).sort(),
    ).toEqual([
      ['subtask/behind', false, true],
      ['subtask/conflicted', true, false],
      ['subtask/no-base', false, true],
    ]);
    expect(text(result)).toContain(
      'on branch subtask/behind — out of date with `main`: merge it and push',
    );
    expect(text(result)).toContain(
      'on branch subtask/conflicted — conflicts with `release`: merge it, resolve the conflicts, and push',
    );
    expect(text(result)).toContain(
      'on branch subtask/no-base — out of date with its base: merge it and push',
    );
  });

  it('a card a REVIEW sent back is claimed as `review`, and the text names the reviewer and carries EVERY finding (MOTIR-6822)', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'sent back' });
    await setStatus(card.id, 'in_review');
    const repo = await connectRepairRepo(fx, `web-${randomToken(4)}`);
    const pr = await deliveredPr(fx, card.id, repo, {
      headRef: 'subtask/sent-back',
      checks: { Vitest: 'success' },
    });
    const findings = '1. The route has no tenant check.\n2. The empty list drops its header.';
    await adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: card.id,
        kind: 'agent_review',
        subjectId: card.id,
        subjectVersion: `acme/${repo.name}#${pr.number}@${'c'.repeat(40)}`,
        state: 'changes_requested',
        decidedById: fx.ownerId,
        decidedAt: new Date('2026-09-29T10:00:00Z'),
        decidedByLabel: 'Owner',
        decisionSource: 'ui',
        decidedUnderAuthority: 'review_agent',
        noteMd: findings,
      },
    });

    const result = await runClaimWorkItemRepair({ key: card.identifier }, fx.ctx);

    expect(ok<{ repairClass: string }>(result).repairClass).toBe('review');
    const said = text(result);
    expect(said).toContain('class review');
    expect(said).toContain('Review agent sent it back (agent_review)');
    expect(said).toContain('Address EVERY finding');
    expect(said).toContain(findings);
  });

  it('beats once at the claim, so the run is on the five-minute lapse from its first second', async () => {
    const fx = await makeWorkItemFixture();
    const card = await redCard(fx);

    const { runId } = ok<ClaimOut>(await runClaimWorkItemRepair({ key: card.identifier }, fx.ctx));

    const row = await runRow(runId as string);
    expect(row).toMatchObject({ command: 'fix', origin: 'local', status: 'running' });
    expect(row.lastHeartbeatAt).not.toBeNull();
  });

  it('answers `taken` as a RESULT naming the holder, and opens nothing', async () => {
    const fx = await makeWorkItemFixture();
    const card = await redCard(fx);
    const bob = await member(fx, 'Bob Fixer');
    await runClaimWorkItemRepair({ key: card.identifier }, bob.ctx);

    const result = await runClaimWorkItemRepair({ key: card.identifier }, fx.ctx);

    const taken = ok<ClaimOut>(result);
    expect(taken).toMatchObject({
      outcome: 'taken',
      holder: { id: bob.user.id },
      pullRequests: [],
    });
    expect(text(result)).toContain('Bob Fixer');
    expect(await adminDb.dispatchRun.count({ where: { command: 'fix' } })).toBe(1);
  });

  it('answers `not_repairable` as a RESULT naming the reason, and opens nothing', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'still to do' });

    const result = await runClaimWorkItemRepair({ key: card.identifier }, fx.ctx);

    expect(ok<ClaimOut>(result)).toMatchObject({
      outcome: 'not_repairable',
      reason: 'not_implemented',
      runId: null,
    });
    expect(text(result)).toContain('not_implemented');
    expect(await adminDb.dispatchRun.count()).toBe(0);
  });

  it('maps an unknown key to WORK_ITEM_NOT_FOUND', async () => {
    const fx = await makeWorkItemFixture();
    const result = await runClaimWorkItemRepair({ key: `${fx.projectIdentifier}-999` }, fx.ctx);
    expect(errorCode(result)).toBe('WORK_ITEM_NOT_FOUND');
  });
});

describe('touch_work_item_repair', () => {
  it('beats an open run it owns: open, and `lastHeartbeatAt` moves forward', async () => {
    const fx = await makeWorkItemFixture();
    const card = await redCard(fx);
    const { runId } = ok<ClaimOut>(await runClaimWorkItemRepair({ key: card.identifier }, fx.ctx));
    const past = new Date(Date.now() - 120_000);
    await adminDb.dispatchRun.update({
      where: { id: runId as string },
      data: { lastHeartbeatAt: past },
    });

    const touched = ok<RunOut>(
      await runTouchWorkItemRepair({ key: card.identifier, runId: runId as string }, fx.ctx),
    );

    expect(touched).toMatchObject({ runId, open: true, status: 'running', stopReason: null });
    const row = await runRow(runId as string);
    expect(row.lastHeartbeatAt!.getTime()).toBeGreaterThan(past.getTime());
    expect(Date.parse(touched.lastHeartbeatAt as string)).toBe(row.lastHeartbeatAt!.getTime());
  });

  it('answers a CLOSED run as `open: false` with its stop reason — not an error — and writes nothing', async () => {
    const fx = await makeWorkItemFixture();
    const card = await redCard(fx);
    const { runId } = ok<ClaimOut>(await runClaimWorkItemRepair({ key: card.identifier }, fx.ctx));
    // The reap's own close.
    await dispatchRunService.close(runId as string, { stopReason: 'abandoned' }, fx.ctx);
    const before = await runRow(runId as string);

    const result = await runTouchWorkItemRepair(
      { key: card.identifier, runId: runId as string },
      fx.ctx,
    );

    expect(ok<RunOut>(result)).toMatchObject({
      open: false,
      status: 'timed_out',
      stopReason: 'abandoned',
    });
    expect(text(result)).toContain('STOP');
    expect(await runRow(runId as string)).toEqual(before);
  });

  it('refuses ANOTHER user’s run by name, and leaves its heartbeat where it was', async () => {
    const fx = await makeWorkItemFixture();
    const card = await redCard(fx);
    const bob = await member(fx, 'Bob Fixer');
    const { runId } = ok<ClaimOut>(await runClaimWorkItemRepair({ key: card.identifier }, bob.ctx));
    const before = await runRow(runId as string);

    const result = await runTouchWorkItemRepair(
      { key: card.identifier, runId: runId as string },
      fx.ctx,
    );

    expect(errorCode(result)).toBe('REPAIR_RUN_NOT_YOURS');
    expect(await runRow(runId as string)).toEqual(before);
  });

  it('refuses a run that is not a `fix` run on that key', async () => {
    const fx = await makeWorkItemFixture();
    const card = await redCard(fx);
    const other = await redCard(fx, 'another red card');
    const { runId: otherRun } = ok<ClaimOut>(
      await runClaimWorkItemRepair({ key: other.identifier }, fx.ctx),
    );
    // A `run` dispatch that DOES hold the card — the wrong command.
    const { run: plainRun } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run',
        reportedBy: 'cli',
        cards: [{ key: card.identifier, disposition: 'queued' }],
      },
      fx.ctx,
    );

    for (const runId of [otherRun as string, plainRun.id, 'no-such-run']) {
      const result = await runTouchWorkItemRepair({ key: card.identifier, runId }, fx.ctx);
      expect(errorCode(result), runId).toBe('REPAIR_RUN_NOT_FOUND');
    }
    expect((await runRow(plainRun.id)).lastHeartbeatAt).toBeNull();
  });
});

describe('close_work_item_repair', () => {
  it('closes the caller’s run with the mapped stop reason, idempotently, and admits a new claim', async () => {
    const fx = await makeWorkItemFixture();
    const card = await redCard(fx);
    const { runId } = ok<ClaimOut>(await runClaimWorkItemRepair({ key: card.identifier }, fx.ctx));

    const closed = ok<RunOut>(
      await runCloseWorkItemRepair(
        { key: card.identifier, runId: runId as string, outcome: 'gave_up' },
        fx.ctx,
      ),
    );
    expect(closed).toMatchObject({ runId, open: false, status: 'failed', stopReason: 'halted' });
    const first = await runRow(runId as string);

    // A retry — even with a different outcome — answers the run as it stands.
    const again = ok<RunOut>(
      await runCloseWorkItemRepair(
        { key: card.identifier, runId: runId as string, outcome: 'green' },
        fx.ctx,
      ),
    );
    expect(again).toEqual(closed);
    expect(await runRow(runId as string)).toEqual(first);

    const next = ok<ClaimOut>(await runClaimWorkItemRepair({ key: card.identifier }, fx.ctx));
    expect(next.outcome).toBe('claimed');
    expect(next.runId).not.toBe(runId);
  });

  it.each([
    ['green', 'succeeded', 'completed'],
    ['halted', 'failed', 'halted'],
    ['interrupted', 'cancelled', 'interrupted'],
  ] as const)('outcome %s closes the run %s / %s', async (outcome, status, stopReason) => {
    const fx = await makeWorkItemFixture();
    const card = await redCard(fx);
    const { runId } = ok<ClaimOut>(await runClaimWorkItemRepair({ key: card.identifier }, fx.ctx));

    await runCloseWorkItemRepair({ key: card.identifier, runId: runId as string, outcome }, fx.ctx);

    expect(await runRow(runId as string)).toMatchObject({ status, stopReason });
  });

  it('refuses to close ANOTHER user’s run, and leaves it open', async () => {
    const fx = await makeWorkItemFixture();
    const card = await redCard(fx);
    const bob = await member(fx, 'Bob Fixer');
    const { runId } = ok<ClaimOut>(await runClaimWorkItemRepair({ key: card.identifier }, bob.ctx));

    const result = await runCloseWorkItemRepair(
      { key: card.identifier, runId: runId as string, outcome: 'green' },
      fx.ctx,
    );

    expect(errorCode(result)).toBe('REPAIR_RUN_NOT_YOURS');
    expect(await runRow(runId as string)).toMatchObject({ status: 'running', stopReason: null });
  });
});
