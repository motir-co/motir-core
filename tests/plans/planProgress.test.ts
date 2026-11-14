import { describe, expect, it } from 'vitest';
import {
  PLAN_AT_WORK_MOVES,
  PLAN_PROVIDER_WAIT_GRACE_MS,
  PLAN_STALLED_AFTER_MS,
  PLAN_STEP_PHRASE_MESSAGE_KEY,
  buildPlanProgressSnapshot,
  countAuthored,
  progressRowOfAdd,
  readPlanAtWork,
  readPlanProgress,
  requireExplanationFor,
  serverNow,
  type PlanProgressAddRow,
  type PlanProgressReading,
  type PlanProgressSnapshot,
} from '@/lib/plans/planProgress';
import type { PlanStepDto } from '@/lib/dto/plans';

// Story MOTIR-7820 · Subtask MOTIR-7825 — the ONE progress derivation, pure.
// Every number and phrase key here is the design's (Part XXVI §26.9, §26.13).

const T0 = Date.parse('2026-10-08T12:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();

function row(over: Partial<PlanProgressAddRow> & { id: string }): PlanProgressAddRow {
  return {
    workItemId: null,
    parentRef: null,
    kind: 'task',
    title: `Title ${over.id}`,
    authorFinished: true,
    ...over,
  };
}

function step(over: Partial<PlanStepDto> & { sessionKey: string }): PlanStepDto {
  return { kind: 'author', targetRef: null, startedAt: at(0), providerWait: null, ...over };
}

function snap(over: Partial<PlanProgressSnapshot> = {}): PlanProgressSnapshot {
  return {
    startedAt: at(0),
    lastActivityAt: at(0),
    observedAt: at(0),
    authored: 0,
    proposed: 0,
    autoResume: null,
    steps: [],
    ...over,
  };
}

function build(args: {
  steps: PlanStepDto[];
  addRows?: PlanProgressAddRow[];
  committedTitles?: Map<string, string>;
}) {
  return buildPlanProgressSnapshot({
    plan: { createdAt: at(0), lastActivityAt: at(0) },
    steps: args.steps,
    addRows: args.addRows ?? [],
    committedTitles: args.committedTitles ?? new Map(),
    observedAt: at(0),
  });
}

describe('the threshold and the copy keys are the design’s', () => {
  it('PLAN_STALLED_AFTER_MS is 15 minutes (§26.9)', () => {
    expect(PLAN_STALLED_AFTER_MS).toBe(900_000);
  });

  it('maps every phrase to its §26.13 copy key', () => {
    expect(PLAN_STEP_PHRASE_MESSAGE_KEY).toEqual({
      settling: 'planReview.progress.settling',
      layingTopLevel: 'planReview.progress.layingTopLevel',
      layingChildrenOf: 'planReview.progress.layingChildrenOf',
      authoring: 'planReview.progress.authoring',
      draftingNew: 'planReview.progress.draftingNew',
      amendingTopLevel: 'planReview.progress.amendingTopLevel',
      amendingChildrenOf: 'planReview.progress.amendingChildrenOf',
      checkingPlan: 'planReview.progress.checkingPlan',
      checkingCard: 'planReview.progress.checkingCard',
      repairing: 'planReview.progress.repairing',
    });
  });
});

describe('readPlanProgress — states and their precedence', () => {
  const live = build({ steps: [step({ sessionKey: 'a', kind: 'settle' })] }).steps;

  it('stalled exactly past the threshold — `=` is not, `+1 ms` is', () => {
    const s = snap({ steps: live, proposed: 2 });
    expect(readPlanProgress(s, T0 + PLAN_STALLED_AFTER_MS).state).toBe('working');
    const past = readPlanProgress(s, T0 + PLAN_STALLED_AFTER_MS + 1);
    expect(past.state).toBe('stalled');
    expect(past.liveSteps).toEqual([]);
  });

  it('stalled wins over a live step (a step younger than the silence)', () => {
    const young = build({
      steps: [step({ sessionKey: 'a', kind: 'settle', startedAt: at(10 * 60_000) })],
    }).steps;
    const s = snap({ steps: young, lastActivityAt: at(0) });
    const r = readPlanProgress(s, T0 + PLAN_STALLED_AFTER_MS + 1);
    expect(r.state).toBe('stalled');
    expect(r.liveSteps).toEqual([]);
  });

  it('working with a live step, starting with none and nothing proposed, writing otherwise', () => {
    expect(readPlanProgress(snap({ steps: live }), T0).state).toBe('working');
    expect(readPlanProgress(snap({ proposed: 0 }), T0).state).toBe('starting');
    expect(readPlanProgress(snap({ proposed: 3, authored: 1 }), T0).state).toBe('writing');
  });

  it('drops a QUIET step while a younger sibling stays live (untargeted included)', () => {
    const steps = build({
      steps: [
        step({ sessionKey: 'old', kind: 'lay', targetRef: null, startedAt: at(0) }),
        step({ sessionKey: 'new', kind: 'author', targetRef: null, startedAt: at(10 * 60_000) }),
      ],
    }).steps;
    const now = T0 + PLAN_STALLED_AFTER_MS + 1;
    const s = snap({ steps, lastActivityAt: at(14 * 60_000), proposed: 1 });
    const r = readPlanProgress(s, now);
    expect(r.state).toBe('working');
    expect(r.liveSteps.map((x) => x.sessionKey)).toEqual(['new']);
  });

  it('a plan whose every step aged out reads writing, not working', () => {
    const steps = build({ steps: [step({ sessionKey: 'a', kind: 'settle' })] }).steps;
    const r = readPlanProgress(
      snap({ steps, lastActivityAt: at(14 * 60_000), proposed: 1 }),
      T0 + PLAN_STALLED_AFTER_MS + 1,
    );
    expect(r.state).toBe('writing');
    expect(r.liveSteps).toEqual([]);
  });

  it('elapsed and since-activity, with negative durations clamped to 0', () => {
    const s = snap({ startedAt: at(0), lastActivityAt: at(60_000) });
    const r = readPlanProgress(s, T0 + 120_000);
    expect(r.elapsedMs).toBe(120_000);
    expect(r.sinceActivityMs).toBe(60_000);
    const early = readPlanProgress(s, T0 - 5_000);
    expect(early.elapsedMs).toBe(0);
    expect(early.sinceActivityMs).toBe(0);
  });
});

// Story MOTIR-8301 · MOTIR-8309 — a plan Motir resumed BY ITSELF after its machine was lost
// reads `resuming` until its new job writes (design Part XXVII §27.2, §27.5, §27.6).
describe('readPlanProgress — resuming after an automatic resume', () => {
  const MIN = 60_000;
  const T = 30 * MIN; // the resume instant, relative to T0
  const resumed = (
    over: { steps?: PlanStepDto[]; lastActivityAt?: string; proposed?: number } = {},
  ) =>
    buildPlanProgressSnapshot({
      plan: { createdAt: at(0), lastActivityAt: over.lastActivityAt ?? at(T) },
      steps: over.steps ?? [],
      addRows:
        over.proposed === 0 ? [] : [row({ id: 'p1' }), row({ id: 'p2', authorFinished: false })],
      committedTitles: new Map(),
      observedAt: at(T),
      autoResume: { at: at(T), count: 1 },
    });

  it('reads resuming from the resume to exactly 15 min after it, then stalled', () => {
    const s = resumed();
    expect(readPlanProgress(s, T0 + T + MIN).state).toBe('resuming');
    expect(readPlanProgress(s, T0 + T + PLAN_STALLED_AFTER_MS).state).toBe('resuming');
    const past = readPlanProgress(s, T0 + T + PLAN_STALLED_AFTER_MS + 1);
    expect(past.state).toBe('stalled');
  });

  it('the lost machine’s step is dropped from the snapshot and is never live', () => {
    const s = resumed({
      steps: [step({ sessionKey: 'dead', kind: 'settle', startedAt: at(T - 2 * MIN) })],
    });
    expect(s.steps).toEqual([]);
    const r = readPlanProgress(s, T0 + T + MIN);
    expect(r.state).toBe('resuming');
    expect(r.liveSteps).toEqual([]);
    // …and afterwards too: once the new job writes, it is still not on the list.
    const later = { ...s, lastActivityAt: at(T + 1_000) };
    expect(readPlanProgress(later, T0 + T + 2 * MIN).liveSteps).toEqual([]);
  });

  it('a step started at or after the resume is the new job’s: working, that step live', () => {
    for (const startedAt of [at(T), at(T + 20_000)]) {
      const s = resumed({ steps: [step({ sessionKey: 'new', kind: 'settle', startedAt })] });
      const r = readPlanProgress(s, T0 + T + MIN);
      expect(r.state).toBe('working');
      expect(r.liveSteps.map((x) => x.sessionKey)).toEqual(['new']);
    }
  });

  it('a write after the resume with no step reads writing — or starting with nothing proposed', () => {
    expect(readPlanProgress(resumed({ lastActivityAt: at(T + 1_000) }), T0 + T + MIN).state).toBe(
      'writing',
    );
    expect(
      readPlanProgress(resumed({ lastActivityAt: at(T + 1_000), proposed: 0 }), T0 + T + MIN).state,
    ).toBe('starting');
  });

  it('carries the resume on the reading, and none when there was no automatic resume', () => {
    const s = resumed();
    expect(readPlanProgress(s, T0 + T + MIN).autoResume).toEqual({ at: at(T), count: 1 });
    const second = { ...s, autoResume: { at: at(T), count: 2 } };
    expect(readPlanProgress(second, T0 + T + MIN).autoResume?.count).toBe(2);
    const plain = build({ steps: [] });
    expect(plain.autoResume).toBeNull();
    expect(readPlanProgress(plain, T0).autoResume).toBeNull();
  });
});

describe('buildPlanProgressSnapshot — the phrase table', () => {
  const adds = [
    row({ id: 'add1', title: 'Proposed story' }),
    row({ id: 'mat', workItemId: 'wi9', title: 'Materialized' }),
  ];
  const committedTitles = new Map([['wi1', 'Committed parent']]);

  it('yields all five phrases; the untargeted ones are KEPT with null title and node', () => {
    const s = build({
      addRows: adds,
      committedTitles,
      steps: [
        step({ sessionKey: '1', kind: 'settle', startedAt: at(1) }),
        step({ sessionKey: '2', kind: 'lay', targetRef: null, startedAt: at(2) }),
        step({ sessionKey: '3', kind: 'lay', targetRef: 'wi1', startedAt: at(3) }),
        step({ sessionKey: '4', kind: 'author', targetRef: null, startedAt: at(4) }),
        step({ sessionKey: '5', kind: 'author', targetRef: 'planItem:add1', startedAt: at(5) }),
      ],
    });
    expect(s.steps.map((x) => [x.phrase, x.targetTitle, x.targetNodeId])).toEqual([
      ['settling', null, null],
      ['layingTopLevel', null, null],
      ['layingChildrenOf', 'Committed parent', 'wi1'],
      ['draftingNew', null, null],
      ['authoring', 'Proposed story', 'add1'],
    ]);
  });

  // MOTIR-11256 — the reconcile, the final check and its fix read as themselves.
  it('yields the amend, check and repair phrases, untargeted and on a card', () => {
    const s = build({
      addRows: adds,
      committedTitles,
      steps: [
        step({ sessionKey: '1', kind: 'amend', targetRef: null, startedAt: at(1) }),
        step({ sessionKey: '2', kind: 'amend', targetRef: 'wi1', startedAt: at(2) }),
        step({ sessionKey: '3', kind: 'check', targetRef: null, startedAt: at(3) }),
        step({ sessionKey: '4', kind: 'check', targetRef: 'planItem:add1', startedAt: at(4) }),
        step({ sessionKey: '5', kind: 'repair', targetRef: null, startedAt: at(5) }),
        step({ sessionKey: '6', kind: 'repair', targetRef: 'wi1', startedAt: at(6) }),
        step({ sessionKey: '7', kind: 'check', targetRef: 'planItem:gone', startedAt: at(7) }),
      ],
    });
    expect(s.steps.map((x) => [x.kind, x.phrase, x.targetTitle, x.targetNodeId])).toEqual([
      ['amend', 'amendingTopLevel', null, null],
      ['amend', 'amendingChildrenOf', 'Committed parent', 'wi1'],
      ['check', 'checkingPlan', null, null],
      ['check', 'checkingCard', 'Proposed story', 'add1'],
      ['repair', 'repairing', null, null],
      ['repair', 'repairing', 'Committed parent', 'wi1'],
    ]);
  });

  it('a materialized add’s node id is its work item (PlanReviewItemDto.nodeId’s rule)', () => {
    const s = build({
      addRows: adds,
      steps: [step({ sessionKey: 'm', kind: 'author', targetRef: 'planItem:mat' })],
    });
    expect(s.steps[0]).toMatchObject({ targetNodeId: 'wi9', targetTitle: 'Materialized' });
  });

  it('drops a withdrawn planItem target and a committed id with no title', () => {
    const s = build({
      addRows: adds,
      committedTitles,
      steps: [
        step({ sessionKey: 'gone', kind: 'author', targetRef: 'planItem:withdrawn' }),
        step({ sessionKey: 'nope', kind: 'lay', targetRef: 'wi-unknown' }),
        step({ sessionKey: 'ok', kind: 'lay', targetRef: 'wi1' }),
      ],
    });
    expect(s.steps.map((x) => x.sessionKey)).toEqual(['ok']);
  });

  it('orders by startedAt, ties by sessionKey', () => {
    const s = build({
      steps: [
        step({ sessionKey: 'b', kind: 'settle', startedAt: at(5) }),
        step({ sessionKey: 'z', kind: 'settle', startedAt: at(1) }),
        step({ sessionKey: 'a', kind: 'settle', startedAt: at(5) }),
      ],
    });
    expect(s.steps.map((x) => x.sessionKey)).toEqual(['z', 'a', 'b']);
  });

  it('carries the plan’s times and the counts', () => {
    const s = buildPlanProgressSnapshot({
      plan: { createdAt: new Date(T0), lastActivityAt: at(30_000) },
      steps: [],
      addRows: [row({ id: 'x' }), row({ id: 'y', authorFinished: false })],
      committedTitles: new Map(),
      observedAt: new Date(T0 + 45_000),
    });
    expect(s).toMatchObject({
      startedAt: at(0),
      lastActivityAt: at(30_000),
      observedAt: at(45_000),
      authored: 1,
      proposed: 2,
    });
  });
});

// MOTIR-10496 — "N authored" reads the stored `authorFinished` and nothing else:
// no body, no sizing field and no project explanations setting moves it.
describe('countAuthored — the stored written state', () => {
  it('a stamped row counts, whatever its kind', () => {
    expect(
      countAuthored([
        row({ id: 't' }),
        row({ id: 's', kind: 'story' }),
        row({ id: 'e', kind: 'epic' }),
      ]),
    ).toEqual({ authored: 3, proposed: 3 });
  });

  it('an unstamped row does not count', () => {
    expect(countAuthored([row({ id: 't', authorFinished: false })])).toEqual({
      authored: 0,
      proposed: 1,
    });
  });

  it('a modify is in neither number (the caller passes adds only; progressRowOfAdd filters nothing)', () => {
    // M counts what is passed: the service passes ONLY `add` rows (SQL `op = 'add'`,
    // the review path filters `op === 'add'`), so a modify never reaches here.
    expect(countAuthored([])).toEqual({ authored: 0, proposed: 0 });
  });

  it('progressRowOfAdd reads only the stored flag — EXACTLY `true`, as the SQL compares JSON', () => {
    const base = { id: 'p', workItemId: null, parentRef: null };
    const complete = {
      title: 'P',
      kind: 'task',
      descriptionMd: 'A whole body.',
      explanationMd: 'why',
      type: 'code',
      executor: 'coding_agent',
      storyPoints: 2,
      estimateMinutes: 30,
      difficulty: 'low',
    };
    expect(progressRowOfAdd({ ...base, proposedFields: complete })).toEqual({
      id: 'p',
      workItemId: null,
      parentRef: null,
      kind: 'task',
      title: 'P',
      authorFinished: false,
    });
    expect(
      progressRowOfAdd({ ...base, proposedFields: { title: 'S', authorFinished: true } }),
    ).toMatchObject({ kind: null, title: 'S', authorFinished: true });
    for (const value of [null, false, 'true', 1]) {
      expect(
        progressRowOfAdd({ ...base, proposedFields: { ...complete, authorFinished: value } })
          .authorFinished,
        String(value),
      ).toBe(false);
    }
    expect(progressRowOfAdd({ ...base, proposedFields: null })).toMatchObject({
      kind: null,
      title: '',
      authorFinished: false,
    });
  });
});

describe('requireExplanationFor — kept for the carry-over, no longer read by the count', () => {
  it('mcp always owes it; native and null follow the project setting', () => {
    for (const setting of [true, false]) {
      expect(
        requireExplanationFor({ authorSource: 'mcp', projectAiGenerateExplanations: setting }),
      ).toBe(true);
      expect(
        requireExplanationFor({ authorSource: 'native', projectAiGenerateExplanations: setting }),
      ).toBe(setting);
      expect(
        requireExplanationFor({ authorSource: null, projectAiGenerateExplanations: setting }),
      ).toBe(setting);
    }
  });
});

describe('serverNow — the client ticks in server time', () => {
  // The server built the snapshot at T0 + 4 min; activity was at T0. The client
  // received it at ITS OWN clock reading, 5 minutes off either way, and reads
  // again 30 s later. Read in raw client time, the fast clock would be 9.5 min
  // past activity and the slow one would be negative; in server time both are 4.5.
  const s = snap({ lastActivityAt: at(0), observedAt: at(4 * 60_000), proposed: 1 });
  for (const [label, skew] of [
    ['5 minutes fast', 5 * 60_000],
    ['5 minutes slow', -5 * 60_000],
  ] as const) {
    it(`holds to server time with a client clock ${label}`, () => {
      const receivedAt = T0 + 4 * 60_000 + skew;
      const now = serverNow(s.observedAt, receivedAt, receivedAt + 30_000);
      expect(now).toBe(T0 + 4 * 60_000 + 30_000);
      const r = readPlanProgress(s, now);
      expect(r.state).not.toBe('stalled');
      expect(r.sinceActivityMs).toBe(4 * 60_000 + 30_000);
    });
  }

  it('never runs backwards when the client clock steps back after receipt', () => {
    expect(serverNow(at(0), T0 + 10_000, T0 + 5_000)).toBe(T0);
  });
});

// Story MOTIR-8413 · MOTIR-8415 — the AT-WORK state the drafted card and the Motir mark read
// (design `design/ai-chat/design-notes.md` § "Motir at work"). One case per precedence row.
describe('readPlanAtWork — whether Motir is at work, and which cards may move', () => {
  const authoring = build({
    steps: [step({ sessionKey: 'a', kind: 'author', targetRef: 'planItem:pi_1' })],
    addRows: [row({ id: 'pi_1' })],
  }).steps;
  const reading = (over: Partial<PlanProgressReading>): PlanProgressReading => ({
    ...readPlanProgress(snap({ proposed: 1 }), T0),
    ...over,
  });
  const ROWS: [PlanProgressReading['state'], boolean][] = [
    ['starting', true],
    ['working', true],
    ['writing', true],
    ['stalled', false],
    ['resuming', false],
  ];

  for (const [state, moves] of ROWS) {
    it(`${state} — at work: ${moves}, and failing always reads reconnecting`, () => {
      const liveSteps = state === 'working' ? authoring : [];
      const r = reading({ state, liveSteps });
      expect(readPlanAtWork(r)).toEqual({ state, atWork: moves, steps: moves ? liveSteps : [] });
      expect(readPlanAtWork(r, { failing: true })).toEqual({
        state: 'reconnecting',
        atWork: false,
        steps: [],
      });
    });
  }

  it('a null reading is settled, failing or not', () => {
    expect(readPlanAtWork(null)).toEqual({ state: 'settled', atWork: false, steps: [] });
    expect(readPlanAtWork(null, { failing: true })).toEqual({
      state: 'reconnecting',
      atWork: false,
      steps: [],
    });
  });

  it('a dropped read stops the motion and leaves the held steps on the reading', () => {
    const r = reading({ state: 'working', liveSteps: authoring });
    const before = structuredClone(r);
    const out = readPlanAtWork(r, { failing: true });
    expect(out).toEqual({ state: 'reconnecting', atWork: false, steps: [] });
    expect(r).toEqual(before);
    expect(r.liveSteps).toHaveLength(1);
  });

  it('the stall boundary is the shipped one — `=` still moves, `+1 ms` does not', () => {
    const s = snap({ steps: authoring, proposed: 1 });
    const at = readPlanAtWork(readPlanProgress(s, T0 + PLAN_STALLED_AFTER_MS));
    expect(at.state).toBe('working');
    expect(at.atWork).toBe(true);
    const past = readPlanAtWork(readPlanProgress(s, T0 + PLAN_STALLED_AFTER_MS + 1));
    expect(past).toEqual({ state: 'stalled', atWork: false, steps: [] });
  });

  it('steps are exactly the live steps, same members and order, while at work', () => {
    const two = build({
      steps: [
        step({ sessionKey: 'b', kind: 'author', targetRef: 'planItem:pi_2', startedAt: at(1) }),
        step({ sessionKey: 'a', kind: 'author', targetRef: 'planItem:pi_1', startedAt: at(0) }),
      ],
      addRows: [row({ id: 'pi_1' }), row({ id: 'pi_2' })],
    }).steps;
    const r = readPlanProgress(snap({ steps: two, proposed: 2 }), T0 + 10);
    const out = readPlanAtWork(r);
    expect(out.steps).toEqual(r.liveSteps);
    expect(out.steps).not.toBe(r.liveSteps);
  });

  it('starting is at work with no step to move', () => {
    const out = readPlanAtWork(readPlanProgress(snap({ proposed: 0 }), T0));
    expect(out).toEqual({ state: 'starting', atWork: true, steps: [] });
  });

  it('is pure — equal arguments, equal answers', () => {
    const r = reading({ state: 'working', liveSteps: authoring });
    expect(readPlanAtWork(r)).toEqual(readPlanAtWork(r));
    expect(readPlanAtWork(r, { failing: false })).toEqual(readPlanAtWork(r));
  });

  it('the moves record is total and true exactly for starting, working and writing', () => {
    expect(
      Object.entries(PLAN_AT_WORK_MOVES)
        .filter(([, m]) => m)
        .map(([s]) => s)
        .sort(),
    ).toEqual(['starting', 'working', 'writing']);
    expect(Object.keys(PLAN_AT_WORK_MOVES).sort()).toEqual([
      'reconnecting',
      'resuming',
      'settled',
      'stalled',
      'starting',
      'working',
      'writing',
    ]);
  });
});

describe('the provider-retry wait (Story MOTIR-9540 · MOTIR-9619)', () => {
  const wait = (retryAtMs: number, attempt = 1) => ({
    attempt,
    maxAttempts: 3,
    since: at(retryAtMs - 2_000),
    retryAt: at(retryAtMs),
  });

  it('the grace is 5 minutes', () => {
    expect(PLAN_PROVIDER_WAIT_GRACE_MS).toBe(300_000);
  });

  it('the snapshot passes each step’s wait through, null when it has none', () => {
    const w = wait(10_000);
    const s = build({
      steps: [
        step({ sessionKey: 'a', kind: 'settle', providerWait: w }),
        step({ sessionKey: 'b' }),
      ],
    });
    expect(s.steps.map((x) => [x.sessionKey, x.providerWait])).toEqual([
      ['a', w],
      ['b', null],
    ]);
  });

  it('reads the wait with the latest retryAt, and none when no step waits', () => {
    const early = wait(5_000, 1);
    const late = wait(9_000, 2);
    const s = snap({
      lastActivityAt: at(1_000),
      steps: build({
        steps: [
          step({ sessionKey: 'a', providerWait: late }),
          step({ sessionKey: 'b', providerWait: early }),
          step({ sessionKey: 'c' }),
        ],
      }).steps,
    });
    expect(readPlanProgress(s, T0 + 2_000).providerWait).toEqual(late);
    expect(
      readPlanProgress(snap({ steps: build({ steps: [step({ sessionKey: 'c' })] }).steps }), T0)
        .providerWait,
    ).toBeNull();
  });

  it('reads a wait whose step started more than PLAN_STALLED_AFTER_MS ago', () => {
    const now = T0 + PLAN_STALLED_AFTER_MS + 60_000;
    const w = wait(now - T0 + 4_000);
    const s = snap({
      lastActivityAt: at(now - T0 - 1_000),
      steps: build({ steps: [step({ sessionKey: 'old', startedAt: at(0), providerWait: w })] })
        .steps,
    });
    const reading = readPlanProgress(s, now);
    // The wait report is the session's latest sign of life (MOTIR-11184), so the
    // step stays live however long ago it started.
    expect(reading.liveSteps.map((x) => x.sessionKey)).toEqual(['old']);
    expect(reading.providerWait).toEqual(w);
  });

  it('drops a wait more than the grace past its retryAt — the grace edge itself still reads', () => {
    const w = wait(10_000);
    const s = snap({
      lastActivityAt: at(10_000),
      steps: build({ steps: [step({ sessionKey: 'a', providerWait: w })] }).steps,
    });
    expect(readPlanProgress(s, T0 + 10_000 + PLAN_PROVIDER_WAIT_GRACE_MS).providerWait).toEqual(w);
    expect(
      readPlanProgress(s, T0 + 10_000 + PLAN_PROVIDER_WAIT_GRACE_MS + 1).providerWait,
    ).toBeNull();
  });

  it('is null when the reading is stalled', () => {
    const w = wait(PLAN_STALLED_AFTER_MS + 10_000);
    const s = snap({ steps: build({ steps: [step({ sessionKey: 'a', providerWait: w })] }).steps });
    const reading = readPlanProgress(s, T0 + PLAN_STALLED_AFTER_MS + 1);
    expect(reading.state).toBe('stalled');
    expect(reading.providerWait).toBeNull();
  });
});
