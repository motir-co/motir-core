import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { autoCommand } from '../src/commands/auto.js';
import { batchCommand } from '../src/commands/batch.js';
import { nextCommand, runCommand } from '../src/commands/dispatch.js';
import { setCredential } from '../src/config/userConfig.js';
import type { CommandResult, CommandRunner } from '../src/git.js';
import { answerPrView } from './fakePullRequest.js';
import {
  startTestServer,
  v1Claim,
  v1Detail,
  v1DispatchPrompt,
  v1Integration,
  v1Page,
  v1Plan,
  v1Proposal,
  v1ReadyRow,
  v1Child,
  type TestServer,
  type V1Reply,
  type V1Request,
  type V1Script,
} from './helpers/testServer.js';

// THE RE-PLAN SIGNAL, end to end (MOTIR-3018).
//
// The dispatch prompt's THE-CARD-IS-WRONG branch tells an agent whose card is
// unbuildable to revert, comment, move the card to `planning`, submit a detached
// plan, and STOP — then exit 0. This file drives exactly that agent through all
// four entry points, over the REAL `/api/v1` protocol, against a server that
// enforces the SAME workflow edges `lib/workflows/defaultWorkflow.ts` seeds.
//
// ⚠️ THE SERVER HERE REFUSES WHAT THE REAL ONE REFUSES. `planning`'s outgoing
// edges are `in_progress`, `todo` and `cancelled` — there is no edge to
// `implemented` and none to `in_review`. A test server that accepted the
// close-out transition would let every assertion below pass against a CLI that
// still drags a parked card back into the pickable set, which is the whole
// defect. So the transitions route answers an illegal move with the real 422
// envelope (`{ code, error, allowedTransitions }`), and the integration route —
// whose service calls the same `updateStatus(implemented)` — refuses it too.

let server: TestServer;
let root: string;
let cwd: string;
let exitCode: typeof process.exitCode;

const TOKEN = 'pat_replan_token';

/** The container every card in this file sits under (MOTIR-4085's lane frame). */
const PARENT = 'PROD-1';

/**
 * The default workflow's outgoing edges, keyed by source status — transcribed
 * from `lib/workflows/defaultWorkflow.ts` so the fake server refuses exactly
 * what the real one refuses. Only the statuses this file moves through are
 * needed; an unlisted source is treated as permissive, so a test that starts
 * somewhere unmodelled fails on its own assertion rather than on this table.
 */
const LEGAL_TARGETS: Record<string, string[]> = {
  todo: ['in_progress', 'blocked', 'cancelled', 'planning'],
  in_progress: ['in_review', 'blocked', 'todo', 'cancelled', 'done', 'planning', 'implemented'],
  planning: ['in_progress', 'todo', 'cancelled'],
  implemented: ['in_progress', 'in_review', 'done', 'blocked', 'cancelled'],
};

const STATUS_LABEL: Record<string, string> = {
  todo: 'To Do',
  blocked: 'Blocked',
  in_progress: 'In Progress',
  implemented: 'Implemented',
  planning: 'Planning',
  in_review: 'In Review',
  done: 'Done',
  cancelled: 'Cancelled',
};

beforeAll(async () => {
  server = await startTestServer({ token: TOKEN });
  cwd = process.cwd();
});

afterAll(async () => {
  process.chdir(cwd);
  await server.close();
});

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'motir-replan-'));
  root = join(base, 'workspace');
  mkdirSync(join(root, 'motir-core'), { recursive: true });
  vi.stubEnv('MOTIR_CONFIG_HOME', join(base, 'config'));
  process.chdir(root);
  setCredential(server.url, { token: TOKEN });
  writeFileSync(
    join(root, '.motir.json'),
    JSON.stringify({ serverUrl: server.url, workspace: 'acme', project: 'PROD' }),
  );
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  server.v1Calls.length = 0;
  server.resetV1();
  exitCode = process.exitCode;
});

afterEach(() => {
  process.chdir(cwd);
  process.exitCode = exitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** The tenant the four entry points are driven against. */
interface Tenant {
  /** Every status write the server accepted, in order — the state of record. */
  statuses: Map<string, string>;
  /** Every transition the server REFUSED, so a test can say the CLI asked. */
  refused: { key: string; from: string; to: string }[];
  /** Children an approved plan ADDED under the parent — push a key here and the
   *  parent's next read reports it, which is what the scoped refresh sees. */
  extraChildren: string[];
  v1: V1Script;
}

/**
 * A server that keeps real status state and enforces the real edges.
 *
 * `mode` decides the workflow variant: `per_item_pr` closes out through
 * `POST …/transitions`, `session_lineage` through `POST …/integration`. Both
 * land on `implemented` (`workItemsService.markIntegrated` writes that key), so
 * both are refused from `planning` — which is why the reproduction has to drive
 * each of them rather than assuming one stands for the other.
 */
function tenant(mode: 'per_item_pr' | 'session_lineage', keys: string[] = ['PROD-7']): Tenant {
  const statuses = new Map<string, string>(keys.map((k) => [k, 'todo']));
  const refused: Tenant['refused'] = [];
  /** The container every card in this tenant sits under — the lane's own frame. */
  const extraChildren: string[] = [];
  const children = (): string[] => [...keys, ...extraChildren];

  const move = (key: string, to: string): { ok: true } | { ok: false; from: string } => {
    const from = statuses.get(key) ?? 'todo';
    if (from === to) return { ok: true };
    const legal = LEGAL_TARGETS[from];
    if (legal && !legal.includes(to)) {
      refused.push({ key, from, to });
      return { ok: false, from };
    }
    statuses.set(key, to);
    return { ok: true };
  };

  const illegal = (key: string, from: string, to: string) => ({
    status: 422,
    body: {
      code: 'ILLEGAL_TRANSITION',
      error: `Illegal status transition: "${from}" → "${to}".`,
      allowedTransitions: (LEGAL_TARGETS[from] ?? []).map((k) => ({
        key: k,
        label: STATUS_LABEL[k] ?? k,
      })),
    },
  });

  const v1: V1Script = {
    'GET /api/v1/projects/{projectKey}/ready/leaves': () => ({
      body: v1Page(
        keys
          .filter((k) => (statuses.get(k) ?? 'todo') === 'todo')
          .map((k) =>
            v1ReadyRow(k, { title: `Item ${k}`, status: { key: 'todo', category: 'todo' } }),
          ),
      ),
    }),
    // ⚠️ THE CARDS HAVE A PARENT (MOTIR-4085), and that is the honest fixture
    // rather than a convenience: `motir run <parent>` runs a container as a
    // SEQUENCE of leaf children, so every iteration of every loop is working a
    // leaf that sits under one. The auto-approve LANE is defined against that
    // parent — the leaf and its siblings — so a parentless fixture would
    // exercise the degenerate arm and call it the normal one.
    'GET /api/v1/work-items/{key}': (req) => {
      const key = String(req.params['key']);
      if (key === PARENT) {
        return {
          body: v1Detail(PARENT, {
            kind: 'story',
            status: 'in_progress',
            children: children().map((k) =>
              v1Child(k, { parentKey: PARENT, status: statuses.get(k) ?? 'todo' }),
            ),
          }),
        };
      }
      return {
        body: v1Detail(key, { status: statuses.get(key) ?? 'todo', parentKey: PARENT }),
      };
    },
    'GET /api/v1/work-items/{key}/dispatch-prompt': (req) => {
      const key = String(req.params['key']);
      const seed = req.query.get('sessionBranch');
      return {
        body: v1DispatchPrompt(key, {
          prompt: `PROMPT ${key}`,
          parentKey: PARENT,
          targetRepo: 'motir-core',
          workflowMode: mode,
          sessionBranch: mode === 'session_lineage' ? (seed ?? 'motir/auto-run') : null,
        }),
      };
    },
    // The plan READ the lane check makes BEFORE approving anything (MOTIR-4085).
    // The default is the ordinary correction — a `modify` of the very card that
    // refused itself — which is in lane by construction, so a tenant that does
    // not care about lanes behaves exactly as it did before the check existed.
    'GET /api/v1/work-items/{key}/plan-approval': (req) => {
      const key = String(req.params['key']);
      return {
        body: {
          plan: v1Plan([v1Proposal('pi_1', { op: 'modify', workItemKey: key })], {
            id: `plan_for_${key}`,
          }),
        },
      };
    },
    // MOTIR-3048 — the ATOMIC claim. Every dispatch path now takes a card
    // through this endpoint rather than through an assign-then-transition pair,
    // so a tenant that does not model it leaves the card at `todo` and every
    // later transition is illegal. It moves the row, exactly as the real one does.
    'POST /api/v1/work-items/{key}/claim': (req) => {
      const key = String(req.params['key']);
      statuses.set(key, 'in_progress');
      return { body: v1Claim(key) };
    },
    'POST /api/v1/work-items/{key}/transitions': (req) => {
      const key = String(req.params['key']);
      const to = String((req.body as { status: string }).status);
      const result = move(key, to);
      if (!result.ok) return illegal(key, result.from, to);
      return { body: v1Detail(key, { status: statuses.get(key) ?? to }) };
    },
    'POST /api/v1/work-items/{key}/integration': (req) => {
      // `markIntegrated` transitions to `implemented` and stamps the branch —
      // the transition is part of the SAME service call, so a card at
      // `planning` is refused here exactly as it is on the transitions route.
      const key = String(req.params['key']);
      const result = move(key, 'implemented');
      if (!result.ok) return illegal(key, result.from, 'implemented');
      const sent = req.body as { sessionBranch: string };
      return {
        body: v1Integration(key, { sessionBranch: sent.sessionBranch, status: 'implemented' }),
      };
    },
  };

  return { statuses, refused, v1, extraChildren };
}

/**
 * A scripted agent that performs the prompt's DEFECT PROTOCOL: it moves the card
 * to `planning` over the real API — the way a real agent would, with its own
 * credential — and exits 0. Nothing else; the revert, the comment and the plan
 * submission are the agent's business and change nothing about what the CLI
 * does next.
 */
function refusingAgent(key: string): { agent: string } {
  // ⚠️ A SCRIPT FILE, NOT `-e`. `parseAgentCommand` splits the agent command on
  // WHITESPACE, so an inline program is torn into argv words no quoting
  // survives. The file lives beside the workspace the test just made, so its
  // path never contains a space either.
  const path = join(root, `refusing-agent-${key}.mjs`);
  writeFileSync(
    path,
    [
      `const res = await fetch(${JSON.stringify(`${server.url}/api/v1/work-items/${key}/transitions`)}, {`,
      `  method: 'POST',`,
      `  headers: { authorization: ${JSON.stringify(`Bearer ${TOKEN}`)}, 'content-type': 'application/json' },`,
      `  body: JSON.stringify({ status: 'planning' }),`,
      `});`,
      // A refusal HERE would mean the agent could not park the card at all,
      // which is a different defect from the one under test — fail loudly
      // rather than exiting 0 and letting the CLI assertions explain it.
      `if (!res.ok) { console.error('agent could not park the card: ' + res.status); process.exit(9); }`,
      `process.exit(0);`,
    ].join('\n'),
  );
  return { agent: `${process.execPath} ${path}` };
}

/** A git runner that answers like a healthy repo whose work reached the remote. */
function gitRunner(): { run: CommandRunner; log: string[] } {
  const log: string[] = [];
  const run: CommandRunner = (bin, args) => {
    log.push(`${bin} ${args.join(' ')}`);
    const ok = (stdout: string): CommandResult => ({ exitCode: 0, stdout, stderr: '' });
    const pr = answerPrView(bin, args);
    if (pr) return pr;
    if (bin === 'git' && args[0] === 'ls-remote') return ok('abc123\trefs/heads/subtask/PROD-7');
    if (bin === 'git' && args[0] === 'log') return ok('abc123');
    if (bin === 'git' && args[0] === 'rev-parse') return { exitCode: 1, stdout: '', stderr: '' };
    if (bin === 'git' && args[0] === 'rev-list') return ok('1');
    if (bin === 'gh' && args[1] === 'create') return ok('https://github.test/pull/1');
    return ok('');
  };
  return { run, log };
}

/**
 * An agent that FINISHES its card: it does nothing at all and exits 0, which is
 * exactly what a successful BYOK agent looks like from the CLI's side — the git
 * runner is what says the work reached the remote.
 */
function finishingAgent(): string {
  const path = join(root, 'finishing-agent.mjs');
  writeFileSync(path, 'process.exit(0);\n');
  return path;
}

/** Every `/api/v1` call the run made to one operation, in order. */
function callsTo(method: string, suffix: string): V1Request[] {
  return server.v1Calls.filter((c) => c.method === method && c.path.endsWith(suffix));
}

/**
 * Every status the run asked for AFTER the agent parked the card — the direct
 * evidence that no close-out was attempted.
 *
 * ⚠️ ASSERTING THE FINAL STATUS IS NOT ENOUGH. A run that asks for `implemented`
 * and is refused leaves the card at `planning` too, so the end state alone
 * cannot tell a fixed CLI from the broken one plus a strict server. This reads
 * the REQUESTS: the agent's own `planning` write is the last transition on the
 * wire, and anything after it is the defect.
 */
function transitionsAfterPlanning(): string[] {
  const asked = callsTo('POST', '/transitions').map((c) =>
    String((c.body as { status: string }).status),
  );
  const parked = asked.lastIndexOf('planning');
  return parked === -1 ? asked : asked.slice(parked + 1);
}

const VARIANTS = ['per_item_pr', 'session_lineage'] as const;

describe.each(VARIANTS)('a submitted re-plan on %s', (mode) => {
  it('motir run leaves the card in Planning and reports it as a refusal, not a failure', async () => {
    const t = tenant(mode);
    server.scriptV1(t.v1);
    const { run } = gitRunner();

    await runCommand('PROD-7', refusingAgent('PROD-7'), { run });

    expect(t.statuses.get('PROD-7')).toBe('planning');
    // The card is where the agent put it, and NOTHING was attempted against it:
    // an assertion on the final status alone would also pass if the run had
    // asked and been refused.
    expect(t.refused).toHaveLength(0);
    expect(callsTo('POST', '/integration')).toHaveLength(0);
    expect(transitionsAfterPlanning()).toEqual([]);
    // A correctly-refused card is a correct outcome, not a failed run.
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('motir next leaves the card in Planning and reports it as a refusal', async () => {
    const t = tenant(mode);
    server.scriptV1(t.v1);
    const { run } = gitRunner();

    await nextCommand(refusingAgent('PROD-7'), { run });

    expect(t.statuses.get('PROD-7')).toBe('planning');
    expect(t.refused).toHaveLength(0);
    expect(callsTo('POST', '/integration')).toHaveLength(0);
    expect(transitionsAfterPlanning()).toEqual([]);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('motir auto stops on the submitted re-plan and never drags the card onward', async () => {
    const t = tenant(mode);
    server.scriptV1(t.v1);
    const { run } = gitRunner();

    await autoCommand({ ...refusingAgent('PROD-7'), max: '2' }, { run });

    expect(t.statuses.get('PROD-7')).toBe('planning');
    expect(t.refused).toHaveLength(0);
    expect(callsTo('POST', '/integration')).toHaveLength(0);
    expect(transitionsAfterPlanning()).toEqual([]);
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe('motir batch', () => {
  it('records a submitted re-plan as a skip, not an agent failure (per_item_pr)', async () => {
    const t = tenant('per_item_pr');
    server.scriptV1(t.v1);
    const { run } = gitRunner();

    await batchCommand({ ...refusingAgent('PROD-7'), max: '1' }, { run });

    expect(t.statuses.get('PROD-7')).toBe('planning');
    expect(t.refused).toHaveLength(0);
    expect(transitionsAfterPlanning()).toEqual([]);
    expect(process.exitCode ?? 0).toBe(0);
  });

  // ⚠️ NOT the defect, and asserted so it is never mistaken for it. `batch`
  // refuses a session-lineage item BEFORE dispatching it (`dispatchOne`,
  // `commands/batch.ts`) — integrating onto a session branch is precisely what
  // this command guarantees it never does. So the card is never claimed, never
  // dispatched, and stays exactly where the snapshot found it; the re-plan path
  // is structurally out of reach here rather than working by accident.
  it('never dispatches a session-lineage item at all, so the card is untouched', async () => {
    const t = tenant('session_lineage');
    server.scriptV1(t.v1);
    const { run } = gitRunner();

    await batchCommand({ ...refusingAgent('PROD-7'), max: '1' }, { run });

    expect(t.statuses.get('PROD-7')).toBe('todo');
    expect(t.refused).toHaveLength(0);
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe('the run that FINISHES is unchanged', () => {
  // The read-back is a branch, and a branch nothing takes the other arm of is a
  // switch that could be stuck. A card the agent did NOT park must still close
  // out exactly as it did before this card existed.
  it('still records an ordinary card as implemented on per_item_pr', async () => {
    const t = tenant('per_item_pr');
    server.scriptV1(t.v1);
    const { run } = gitRunner();

    await runCommand('PROD-7', { agent: `${process.execPath} ${finishingAgent()}` }, { run });

    expect(t.statuses.get('PROD-7')).toBe('implemented');
    expect(t.refused).toHaveLength(0);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('still integrates an ordinary card on session_lineage', async () => {
    const t = tenant('session_lineage');
    server.scriptV1(t.v1);
    const { run } = gitRunner();

    await runCommand('PROD-7', { agent: `${process.execPath} ${finishingAgent()}` }, { run });

    expect(t.statuses.get('PROD-7')).toBe('implemented');
    expect(callsTo('POST', '/integration')).toHaveLength(1);
    expect(process.exitCode ?? 0).toBe(0);
  });
});

// ── `motir auto --auto-approve-replan` (MOTIR-3023) ─────────────────────────
//
// The loop half. What it approves is bounded server-side; what it does AFTER is
// the whole risk surface, and the two guards below are the ones that cost real
// money or a wrong tree if they are missed.

/** Every plan-approval call the run made, in order. */
function approvalsRequested(): string[] {
  return server.v1Calls
    .filter((c) => c.method === 'POST' && c.path.endsWith('/plan-approval'))
    .map((c) => c.path);
}

/**
 * A tenant with TWO cards, where the second becomes ready only once the first
 * has left the ready set — the cascade a continuing loop has to reach.
 *
 * `approvable` scripts the approval endpoint: `true` answers a materialized
 * plan, `false` answers the server's own bound refusal, which is the case the
 * loop must STOP on rather than continue past.
 */
function twoCardTenant(opts: { approvable: boolean }): Tenant {
  const t = tenant('per_item_pr', ['PROD-7', 'PROD-8']);
  const approvals: string[] = [];
  t.v1['POST /api/v1/work-items/{key}/plan-approval'] = (req) => {
    const key = String(req.params['key']);
    approvals.push(key);
    if (!opts.approvable) {
      return {
        status: 422,
        body: {
          code: 'NO_PLAN_FOR_WORK_ITEM',
          error: `No submitted plan is anchored to ${key}.`,
        },
      };
    }
    return {
      body: v1Plan([v1Proposal('pi_1', { workItemKey: 'PROD-9' })], {
        id: `plan_for_${key}`,
        status: 'approved',
        decidedAt: '2026-01-01T00:02:00.000Z',
      }),
    };
  };
  return t;
}

describe('motir auto --auto-approve-replan', () => {
  it('WITHOUT the flag, stops and approves nothing — the default is unchanged', async () => {
    const t = twoCardTenant({ approvable: true });
    server.scriptV1(t.v1);
    const { run } = gitRunner();

    await autoCommand({ ...refusingAgent('PROD-7'), max: '5' }, { run });

    expect(approvalsRequested()).toEqual([]);
    expect(t.statuses.get('PROD-7')).toBe('planning');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('WITH the flag, approves the card’s own plan and keeps looping', async () => {
    const t = twoCardTenant({ approvable: true });
    server.scriptV1(t.v1);
    const { run } = gitRunner();

    await autoCommand({ ...refusingAgent('PROD-7'), max: '5', autoApproveReplan: true }, { run });

    // Approved — addressed by the CARD, with no plan id anywhere in the request.
    expect(approvalsRequested()).toEqual(['/api/v1/work-items/PROD-7/plan-approval']);
    // …and it CONTINUED: the second card was dispatched AND finished. The
    // scripted agent only parks PROD-7, so PROD-8 runs to its ordinary outcome —
    // which is the stronger evidence, since it says the loop carried on rather
    // than merely taking one more turn.
    expect(t.statuses.get('PROD-8')).toBe('implemented');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('never dispatches the same card twice, however many times it refuses itself', async () => {
    // ⚠️ THE GUARD THAT COSTS MONEY. Approve → the card returns to the ready set
    // → dispatched again → refused again → another submit, and every submit
    // spends the token owner's AI credits. The agent here ALWAYS refuses, so a
    // missing hold-out is an unbounded loop rather than one extra turn.
    const t = tenant('per_item_pr', ['PROD-7']);
    let dispatched = 0;
    // The server keeps offering the card — the loop's own hold-out is the only
    // thing that can stop this, which is exactly what is under test.
    t.v1['GET /api/v1/projects/{projectKey}/ready/leaves'] = () => ({
      body: v1Page([v1ReadyRow('PROD-7', { title: 'refuses itself forever' })]),
    });
    t.v1['GET /api/v1/work-items/{key}/dispatch-prompt'] = (req) => {
      dispatched += 1;
      return {
        body: v1DispatchPrompt(String(req.params['key']), {
          prompt: 'PROMPT',
          targetRepo: 'motir-core',
          workflowMode: 'per_item_pr',
          sessionBranch: null,
        }),
      };
    };
    t.v1['POST /api/v1/work-items/{key}/plan-approval'] = () => ({
      body: v1Plan([], { id: 'plan_1', status: 'approved', decidedAt: '2026-01-01T00:02:00.000Z' }),
    });
    server.scriptV1(t.v1);
    const { run } = gitRunner();

    await autoCommand({ ...refusingAgent('PROD-7'), max: '10', autoApproveReplan: true }, { run });

    // Dispatched ONCE, and its plan submitted for approval ONCE — the assertion
    // is the COUNT, because a run that took it twice would look identical in the
    // final state and cost twice as much.
    expect(dispatched).toBe(1);
    expect(approvalsRequested()).toHaveLength(1);
  });

  it('STOPS when the server refuses the approval, with the server’s own message', async () => {
    // Continuing would dispatch against a tree nobody approved. The refusals are
    // the ADR's bounds — no plan of this card's own, a plan already decided, a
    // scope the token lacks — and none of them is a reason to carry on.
    const t = twoCardTenant({ approvable: false });
    server.scriptV1(t.v1);
    const { run } = gitRunner();

    await autoCommand({ ...refusingAgent('PROD-7'), max: '5', autoApproveReplan: true }, { run });

    expect(approvalsRequested()).toHaveLength(1);
    // The SECOND card was never dispatched.
    expect(t.statuses.get('PROD-8')).toBe('todo');
    // …and a correctly-refused approval is still not a failed run.
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('does not crash when the approved plan removed the card in flight', async () => {
    // An approved plan may archive the very card that produced it — which is the
    // CORRECT output when the card's premise was false. The run records the
    // outcome and proceeds; a card that stopped existing is an ordinary result,
    // not an error.
    const t = twoCardTenant({ approvable: true });
    const detail = t.v1['GET /api/v1/work-items/{key}'] as (req: V1Request) => V1Reply;
    let approved = false;
    t.v1['POST /api/v1/work-items/{key}/plan-approval'] = (req) => {
      approved = true;
      return {
        body: v1Plan(
          [
            v1Proposal('pi_1', {
              op: 'remove',
              workItemKey: String(req.params['key']),
              proposedFields: null,
            }),
          ],
          { id: 'plan_1', status: 'approved', decidedAt: '2026-01-01T00:02:00.000Z' },
        ),
      };
    };
    // After the approval the card is gone: every read of it 404s.
    t.v1['GET /api/v1/work-items/{key}'] = (req) =>
      approved && String(req.params['key']) === 'PROD-7'
        ? { status: 404, body: { code: 'WORK_ITEM_NOT_FOUND', error: 'gone' } }
        : detail(req);
    server.scriptV1(t.v1);
    const { run } = gitRunner();

    await autoCommand({ ...refusingAgent('PROD-7'), max: '5', autoApproveReplan: true }, { run });

    expect(approvalsRequested()).toHaveLength(1);
    expect(t.statuses.get('PROD-8')).toBe('implemented');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('WAITS while the planner is still writing, then approves and CONTINUES', async () => {
    // ⚠️ THE CASE THAT IS NORMAL IN PRODUCTION. The agent submits with
    // `--detach` and exits within milliseconds, so the loop reaches the approval
    // while motir-ai is still writing the plan. The server answers 409 carrying
    // `planStatus: 'generating'` — "not yet", as data rather than as a sentence
    // — and the loop waits rather than treating it as a refusal. Getting this
    // wrong would make `--auto-approve-replan` fail in exactly its ordinary
    // case, which is how the story-level suite found it.
    const t = twoCardTenant({ approvable: true });
    const succeed = t.v1['POST /api/v1/work-items/{key}/plan-approval'] as (
      req: V1Request,
    ) => V1Reply;
    let attempts = 0;
    t.v1['POST /api/v1/work-items/{key}/plan-approval'] = (req) => {
      attempts += 1;
      // Still generating on the first ask; written by the second.
      if (attempts === 1) {
        return {
          status: 409,
          body: {
            code: 'PLAN_NOT_IN_EXPECTED_STATUS',
            error: 'Plan plan_1 is generating; this action requires it to be planned.',
            planStatus: 'generating',
          },
        };
      }
      return succeed(req);
    };
    server.scriptV1(t.v1);
    const { run } = gitRunner();
    const waits: number[] = [];

    await autoCommand(
      { ...refusingAgent('PROD-7'), max: '5', autoApproveReplan: true },
      {
        run,
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    );

    // It asked twice, waited between, and then carried on into the second card.
    expect(attempts).toBe(2);
    expect(waits).toHaveLength(1);
    expect(t.statuses.get('PROD-8')).toBe('implemented');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('STOPS on a plan somebody ALREADY DECIDED, rather than waiting for it', async () => {
    // The other side of the same field, and why it has to be data: `approved`
    // and `generating` are one word apart in the sentence, and a loop that
    // retried a decided plan would spin against an answer that will never
    // change.
    const t = twoCardTenant({ approvable: true });
    let attempts = 0;
    t.v1['POST /api/v1/work-items/{key}/plan-approval'] = () => {
      attempts += 1;
      return {
        status: 409,
        body: {
          code: 'PLAN_NOT_IN_EXPECTED_STATUS',
          error: 'Plan plan_1 is approved; this action requires it to be planned.',
          planStatus: 'approved',
        },
      };
    };
    server.scriptV1(t.v1);
    const { run } = gitRunner();
    const waits: number[] = [];

    await autoCommand(
      { ...refusingAgent('PROD-7'), max: '5', autoApproveReplan: true },
      {
        run,
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    );

    expect(attempts).toBe(1);
    expect(waits).toEqual([]);
    // The run stopped: the second card was never dispatched.
    expect(t.statuses.get('PROD-8')).toBe('todo');
  });

  it('--max still bounds the run when an approved plan enlarges the ready set', async () => {
    const t = twoCardTenant({ approvable: true });
    server.scriptV1(t.v1);
    const { run } = gitRunner();

    await autoCommand({ ...refusingAgent('PROD-7'), max: '1', autoApproveReplan: true }, { run });

    // One dispatch, one approval, and the second card untouched — the cap binds
    // before the newly-approved work can be reached.
    expect(approvalsRequested()).toHaveLength(1);
    expect(t.statuses.get('PROD-8')).toBe('todo');
  });
});

// ── THE TWO LANES (MOTIR-4085) ──────────────────────────────────────────────
//
// `--auto-approve-replan` already approved and continued (MOTIR-3023); what it
// did not have was a BOUND on what it would approve, or a re-read of the queue
// the approval just changed. The block above is that flag's original behaviour;
// this one is the lane it now runs inside.
//
// ⚠️ EVERY ASSERTION HERE IS ABOUT WHAT THE LOOP DID, not about what it printed
// alone. A decline changes nothing observable in the tree — that is the point of
// it — so the evidence is the approval that was NOT made and the second card
// that was NOT dispatched, which is what distinguishes a real bound from a
// warning printed beside an approval that happened anyway.

/** Every plan READ the run made before deciding — the lane check's own request. */
function planReads(): string[] {
  return server.v1Calls
    .filter((c) => c.method === 'GET' && c.path.endsWith('/plan-approval'))
    .map((c) => c.path);
}

/**
 * The scripted answer for one route, as a FUNCTION — a script entry may be a
 * bare reply or a handler, and a test that wraps one has to be able to call it.
 */
function asHandler(entry: V1Reply | ((req: V1Request) => V1Reply) | undefined) {
  return (req: V1Request): V1Reply => (typeof entry === 'function' ? entry(req) : entry!);
}

/** A two-card tenant whose submitted plan is whatever the test says it is. */
function laneTenant(proposals: unknown[]): Tenant {
  const t = tenant('per_item_pr', ['PROD-7', 'PROD-8']);
  t.v1['GET /api/v1/work-items/{key}/plan-approval'] = () => ({
    body: { plan: v1Plan(proposals, { id: 'plan_for_PROD-7' }) },
  });
  t.v1['POST /api/v1/work-items/{key}/plan-approval'] = () => ({
    body: v1Plan(proposals, {
      id: 'plan_for_PROD-7',
      status: 'approved',
      decidedAt: '2026-01-01T00:02:00.000Z',
    }),
  });
  return t;
}

describe('motir auto --auto-approve-replan — THE LANE (MOTIR-4085)', () => {
  it('READS the plan before approving it, and approves an IN-LANE one', async () => {
    // The order is the substance: a check that ran after the approval would be a
    // description of a tree that had already changed.
    const t = laneTenant([v1Proposal('pi_1', { op: 'modify', workItemKey: 'PROD-7' })]);
    server.scriptV1(t.v1);
    const { run } = gitRunner();

    await autoCommand({ ...refusingAgent('PROD-7'), max: '5', autoApproveReplan: true }, { run });

    expect(planReads()).toEqual(['/api/v1/work-items/PROD-7/plan-approval']);
    expect(approvalsRequested()).toEqual(['/api/v1/work-items/PROD-7/plan-approval']);
    const read = server.v1Calls.findIndex(
      (c) => c.method === 'GET' && c.path.endsWith('/plan-approval'),
    );
    const approve = server.v1Calls.findIndex(
      (c) => c.method === 'POST' && c.path.endsWith('/plan-approval'),
    );
    expect(read).toBeLessThan(approve);
    // …and it CONTINUED: the second card ran to its ordinary outcome.
    expect(t.statuses.get('PROD-8')).toBe('implemented');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('a SPLIT is in lane — one leaf becomes two siblings, and the run carries on', async () => {
    // The case the flag exists for, end to end: the correction the agent most
    // often needs is "this card is really two", and a subtask parents nothing,
    // so the second card can only be a SIBLING.
    const t = laneTenant([
      v1Proposal('pi_1', { op: 'modify', workItemKey: 'PROD-7' }),
      v1Proposal('pi_2', { op: 'add', parentRef: 'cm_parent', parentKey: PARENT }),
    ]);
    server.scriptV1(t.v1);
    const { run } = gitRunner();

    await autoCommand({ ...refusingAgent('PROD-7'), max: '5', autoApproveReplan: true }, { run });

    expect(approvalsRequested()).toHaveLength(1);
    expect(t.statuses.get('PROD-8')).toBe('implemented');
  });

  it('DECLINES an out-of-lane plan, approves NOTHING, and stops', async () => {
    // ⚠️ THE ASSERTION IS THE ABSENT POST. A run that printed a warning and
    // approved anyway would pass every other assertion in this file.
    const t = laneTenant([
      v1Proposal('pi_1', { op: 'modify', workItemKey: 'PROD-7' }),
      v1Proposal('pi_2', { op: 'modify', workItemKey: PARENT }),
    ]);
    server.scriptV1(t.v1);
    const { run } = gitRunner();

    await autoCommand({ ...refusingAgent('PROD-7'), max: '5', autoApproveReplan: true }, { run });

    expect(planReads()).toHaveLength(1);
    expect(approvalsRequested()).toEqual([]);
    // The run stopped: the second card was never dispatched, and the card the
    // agent parked is left exactly where the agent put it.
    expect(t.statuses.get('PROD-8')).toBe('todo');
    expect(t.statuses.get('PROD-7')).toBe('planning');
    // …and a correct decline is not a failed run.
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('reports an out-of-lane decline in the summary, NAMING what fell out', async () => {
    const t = laneTenant([v1Proposal('pi_1', { op: 'modify', workItemKey: 'PROD-42' })]);
    server.scriptV1(t.v1);
    const { run } = gitRunner();
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });

    await autoCommand({ ...refusingAgent('PROD-7'), max: '5', autoApproveReplan: true }, { run });

    const text = lines.join('');
    expect(text).toContain('NOT auto-approved');
    expect(text).toContain('PROD-42');
    // A count with no names is the thing this rule exists to refuse.
    expect(text).toContain("wider than the card's own lane");
  });

  it('treats a plan ANCHORED ELSEWHERE as the election it is, not as an error', async () => {
    // The agent deliberately anchored at the container, so the loop's own
    // address resolves nothing — which is the normal lane, chosen on purpose.
    const t = tenant('per_item_pr', ['PROD-7', 'PROD-8']);
    // ⚠️ `plan: null` AT 200, not a 4xx — nothing is anchored at this card
    // because the agent anchored its re-plan at a container, which is a lane the
    // prompt offers. The loop reads the FIELD, never a status code.
    t.v1['GET /api/v1/work-items/{key}/plan-approval'] = () => ({ body: { plan: null } });
    server.scriptV1(t.v1);
    const { run } = gitRunner();
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });

    await autoCommand({ ...refusingAgent('PROD-7'), max: '5', autoApproveReplan: true }, { run });

    expect(approvalsRequested()).toEqual([]);
    expect(t.statuses.get('PROD-8')).toBe('todo');
    const text = lines.join('');
    expect(text).toContain('elected the lane that goes to a person');
    // ⚠️ NOT A FAILURE: exit 0, because the agent did exactly what it was told
    // it could do.
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('WAITS while the plan is still being written, and lane-checks the FINISHED one', async () => {
    // ⚠️ A LANE CHECK OVER A HALF-WRITTEN PLAN IS WORSE THAN NO CHECK. The
    // proposals that have not arrived yet are exactly the ones that might be out
    // of lane, so the read waits for the plan to stop generating before looking.
    const t = laneTenant([v1Proposal('pi_1', { op: 'modify', workItemKey: 'PROD-42' })]);
    let reads = 0;
    t.v1['GET /api/v1/work-items/{key}/plan-approval'] = () => {
      reads += 1;
      return reads < 3
        ? { body: { plan: v1Plan([], { id: 'plan_for_PROD-7', status: 'generating' }) } }
        : {
            body: {
              plan: v1Plan([v1Proposal('pi_1', { op: 'modify', workItemKey: 'PROD-42' })], {
                id: 'plan_for_PROD-7',
              }),
            },
          };
    };
    server.scriptV1(t.v1);
    const { run } = gitRunner();
    const waits: number[] = [];

    await autoCommand(
      { ...refusingAgent('PROD-7'), max: '5', autoApproveReplan: true },
      {
        run,
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    );

    expect(reads).toBe(3);
    expect(waits).toHaveLength(2);
    // The finished plan was OUT of lane, and the run acted on the finished one.
    expect(approvalsRequested()).toEqual([]);
  });

  it('stops rather than approving a plan it could NOT read', async () => {
    const t = tenant('per_item_pr', ['PROD-7', 'PROD-8']);
    t.v1['GET /api/v1/work-items/{key}/plan-approval'] = () => ({
      status: 500,
      body: { code: 'INTERNAL', error: 'boom' },
    });
    server.scriptV1(t.v1);
    const { run } = gitRunner();

    await autoCommand({ ...refusingAgent('PROD-7'), max: '5', autoApproveReplan: true }, { run });

    expect(approvalsRequested()).toEqual([]);
    expect(t.statuses.get('PROD-8')).toBe('todo');
  });

  it('WITHOUT the flag it neither reads nor approves — today’s behaviour, unchanged', async () => {
    const t = laneTenant([v1Proposal('pi_1', { op: 'modify', workItemKey: 'PROD-7' })]);
    server.scriptV1(t.v1);
    const { run } = gitRunner();

    await autoCommand({ ...refusingAgent('PROD-7'), max: '5' }, { run });

    expect(planReads()).toEqual([]);
    expect(approvalsRequested()).toEqual([]);
    expect(t.statuses.get('PROD-7')).toBe('planning');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('sends the auto-approve lane to the PROMPT only when the flag is set', async () => {
    // ⚠️ THE PROMPT IS THE ONLY PLACE THE AGENT LEARNS ITS LANE. A flag the agent
    // never reads cannot change what it does, so a run that bounded approvals
    // without telling the agent would get the wider plan every time and decline it.
    const t = laneTenant([v1Proposal('pi_1', { op: 'modify', workItemKey: 'PROD-7' })]);
    server.scriptV1(t.v1);
    const { run } = gitRunner();

    await autoCommand({ ...refusingAgent('PROD-7'), max: '1', autoApproveReplan: true }, { run });
    const withFlag = server.v1Calls.filter((c) => c.path.endsWith('/dispatch-prompt'));
    expect(withFlag).not.toHaveLength(0);
    expect(withFlag.every((c) => c.query?.get('autoApproveReplan') === '1')).toBe(true);

    server.v1Calls.length = 0;
    server.scriptV1(laneTenant([]).v1);
    await autoCommand({ ...refusingAgent('PROD-7'), max: '1' }, { run });
    const without = server.v1Calls.filter((c) => c.path.endsWith('/dispatch-prompt'));
    expect(without).not.toHaveLength(0);
    // ABSENT, not `0`: an omitted parameter is how the request stays
    // byte-identical to the one this command sent before the lane existed.
    expect(without.every((c) => c.query?.get('autoApproveReplan') === null)).toBe(true);
  });
});

describe('the SCOPED refresh after an approved in-lane plan (MOTIR-4085)', () => {
  it('holds out a sibling the plan REMOVED — the arm that does damage silently', async () => {
    // ⚠️ THE REMOVAL IS THE DANGEROUS HALF. An added sibling arrives on its own,
    // because `next_ready` asks again every iteration; a removed one is work the
    // plan DELETED, and a loop that executed it would look entirely healthy.
    const t = laneTenant([
      v1Proposal('pi_1', { op: 'modify', workItemKey: 'PROD-7' }),
      v1Proposal('pi_2', { op: 'remove', workItemKey: 'PROD-8' }),
    ]);
    // The approval takes PROD-8 out of the parent's children, and the ready set
    // keeps offering it — which is exactly the state the hold-out is for.
    let approved = false;
    const post = asHandler(t.v1['POST /api/v1/work-items/{key}/plan-approval']);
    t.v1['POST /api/v1/work-items/{key}/plan-approval'] = (req) => {
      approved = true;
      return post(req);
    };
    const detail = asHandler(t.v1['GET /api/v1/work-items/{key}']);
    t.v1['GET /api/v1/work-items/{key}'] = (req) => {
      if (approved && String(req.params['key']) === PARENT) {
        return { body: v1Detail(PARENT, { kind: 'story', status: 'in_progress', children: [] }) };
      }
      return detail(req);
    };
    server.scriptV1(t.v1);
    const { run } = gitRunner();

    await autoCommand({ ...refusingAgent('PROD-7'), max: '5', autoApproveReplan: true }, { run });

    expect(approvalsRequested()).toHaveLength(1);
    // PROD-8 was removed by the plan, so the run did NOT execute it.
    expect(t.statuses.get('PROD-8')).toBe('todo');
  });

  it('names what the plan ADDED, and picks it up when it is ready', async () => {
    const t = laneTenant([
      v1Proposal('pi_1', { op: 'modify', workItemKey: 'PROD-7' }),
      v1Proposal('pi_2', { op: 'add', parentRef: 'cm_parent', parentKey: PARENT }),
    ]);
    let approved = false;
    const post = asHandler(t.v1['POST /api/v1/work-items/{key}/plan-approval']);
    t.v1['POST /api/v1/work-items/{key}/plan-approval'] = (req) => {
      approved = true;
      // The approval materialized a NEW sibling under the parent.
      t.extraChildren.push('PROD-9');
      return post(req);
    };
    server.scriptV1(t.v1);
    const { run } = gitRunner();
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });

    await autoCommand({ ...refusingAgent('PROD-7'), max: '5', autoApproveReplan: true }, { run });

    expect(approved).toBe(true);
    expect(lines.join('')).toContain('the plan added PROD-9');
  });

  it('re-reads THAT parent and nothing else — the refresh is SCOPED', async () => {
    // ⚠️ THE SCOPE IS THE DECISION, not an economy. A loop that re-derived more
    // than the iteration's own container would let one leaf silently re-order
    // work an operator queued elsewhere.
    const t = laneTenant([v1Proposal('pi_1', { op: 'modify', workItemKey: 'PROD-7' })]);
    server.scriptV1(t.v1);
    const { run } = gitRunner();

    await autoCommand({ ...refusingAgent('PROD-7'), max: '5', autoApproveReplan: true }, { run });

    const parentsRead = server.v1Calls
      .filter((c) => c.method === 'GET' && /\/work-items\/[^/]+$/.test(c.path))
      .map((c) => c.path.split('/').pop());
    // Every container read in the whole run is THIS parent; no other is touched.
    expect(new Set(parentsRead.filter((k) => k === PARENT)).size).toBe(1);
    expect(parentsRead.filter((k) => k !== PARENT && k !== 'PROD-7' && k !== 'PROD-8')).toEqual([]);
  });
});
