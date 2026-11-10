import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deliverySetVersion } from '@/lib/approvalGates/deliverySetVersion';
import {
  acceptanceRefusalHoldsMerge,
  designHoldsMerge,
  primaryApprovalStandsForMerge,
  resolveGateSet,
  type ExistingGate,
  type GateSetInput,
  type GateSetMember,
} from '@/lib/approvalGates/gateSet';

// THE GATE-SET PREDICATE (Story MOTIR-5652 · Subtask MOTIR-5660; `design-result.md`
// AMENDMENT 6).
//
// Every case below is a CARD STATE, not a call site — which is the claim the module
// makes. The six defects in this family were each fixed at the raiser or withdrawer
// that produced them, and the rate did not fall, because the next one arrived
// somewhere nobody had touched. Asking the states proves a defect is unreachable
// from ANY direction, including directions nobody has built yet.

const WORK_ITEM = 'wi_1';

const member = (version: string | null, isMergeCandidate = true): GateSetMember => ({
  memberVersion: version,
  isMergeCandidate,
});

const GREEN_ONE = [member('moooon/motir-core#10@aaa1')];
const GREEN_TWO = [member('moooon/motir-core#10@aaa1'), member('moooon/motir-ai#4@bbb2')];

const input = (over: Partial<GateSetInput> = {}): GateSetInput => ({
  currentDesignEvidence: null,
  latestDesignGate: null,
  currentReceipt: null,
  latestAcceptanceGate: null,
  latestMergeGate: null,
  members: [],
  prMergeMode: 'manual',
  cardIsTerminal: false,
  cardInReview: true,
  primaryApprovalStandsForMerge: false,
  workItemId: WORK_ITEM,
  ...over,
});

const decided = (
  subjectId: string,
  subjectVersion: string | null,
  state: ExistingGate['state'] = 'approved',
): ExistingGate => ({ state, subjectId, subjectVersion });

describe('resolveGateSet — the states with nothing to decide', () => {
  it('asks nothing when the card has neither a design result nor a delivery set', () => {
    expect(resolveGateSet(input())).toEqual({ awaited: [], primary: null });
  });

  it('asks nothing on a TERMINAL card, whatever it holds', () => {
    const set = resolveGateSet(
      input({
        cardIsTerminal: true,
        currentDesignEvidence: { id: 'ev_1', commitSha: 'c0ffee' },
        members: GREEN_ONE,
      }),
    );
    expect(set).toEqual({ awaited: [], primary: null });
  });

  it('asks no MERGE question in an `auto` project — Motir merges with no person', () => {
    const set = resolveGateSet(input({ prMergeMode: 'auto', members: GREEN_ONE }));
    expect(set.awaited).toEqual([]);
  });

  it('asks no MERGE question while a member is not a merge candidate (MOTIR-5604)', () => {
    const set = resolveGateSet(input({ members: [member('moooon/motir-core#10@aaa1', false)] }));
    expect(set.awaited).toEqual([]);
  });

  it('asks no MERGE question while any member has an unknown head', () => {
    const set = resolveGateSet(
      input({ members: [member('moooon/motir-core#10@aaa1'), member(null)] }),
    );
    expect(set.awaited).toEqual([]);
  });
});

describe('resolveGateSet — the DESIGN question stands on its own', () => {
  it('asks it for a published result with NO pull request', () => {
    const set = resolveGateSet(
      input({ currentDesignEvidence: { id: 'ev_1', commitSha: 'c0ffee' } }),
    );
    expect(set).toEqual({
      awaited: [{ kind: 'design_result', subjectId: 'ev_1', subjectVersion: 'c0ffee' }],
      primary: 'design_result',
    });
  });

  it('asks it for a result with no commit behind it — an unknown version is not no question', () => {
    const set = resolveGateSet(input({ currentDesignEvidence: { id: 'ev_1', commitSha: null } }));
    expect(set.awaited).toEqual([
      { kind: 'design_result', subjectId: 'ev_1', subjectVersion: null },
    ]);
  });

  it('stops asking it once a decision has answered THAT version', () => {
    const set = resolveGateSet(
      input({
        currentDesignEvidence: { id: 'ev_1', commitSha: 'c0ffee' },
        latestDesignGate: decided('ev_1', 'c0ffee'),
      }),
    );
    expect(set.awaited).toEqual([]);
  });

  it('asks AGAIN when a republish moved the version the decision answered', () => {
    const set = resolveGateSet(
      input({
        currentDesignEvidence: { id: 'ev_2', commitSha: 'deadbee' },
        latestDesignGate: decided('ev_1', 'c0ffee'),
      }),
    );
    expect(set.awaited).toEqual([
      { kind: 'design_result', subjectId: 'ev_2', subjectVersion: 'deadbee' },
    ]);
  });

  it('keeps asking while its own gate is merely AWAITING — a caller leaves that row alone', () => {
    const set = resolveGateSet(
      input({
        currentDesignEvidence: { id: 'ev_1', commitSha: 'c0ffee' },
        latestDesignGate: { state: 'awaiting', subjectId: 'ev_1', subjectVersion: 'c0ffee' },
      }),
    );
    expect(set.primary).toBe('design_result');
  });

  it('treats CHANGES REQUESTED as an answer, not an open question', () => {
    const set = resolveGateSet(
      input({
        currentDesignEvidence: { id: 'ev_1', commitSha: 'c0ffee' },
        latestDesignGate: decided('ev_1', 'c0ffee', 'changes_requested'),
      }),
    );
    expect(set.awaited).toEqual([]);
  });
});

describe('resolveGateSet — MOTIR-5652: a design result AND open pull requests is TWO gates', () => {
  it('asks BOTH, with the design gate PRIMARY (AMENDMENT 6 Q1)', () => {
    const set = resolveGateSet(
      input({ currentDesignEvidence: { id: 'ev_1', commitSha: 'c0ffee' }, members: GREEN_ONE }),
    );
    expect(set.awaited).toEqual([
      { kind: 'design_result', subjectId: 'ev_1', subjectVersion: 'c0ffee' },
      {
        kind: 'pull_request_approval',
        subjectId: WORK_ITEM,
        subjectVersion: 'moooon/motir-core#10@aaa1',
      },
    ]);
    expect(set.primary).toBe('design_result');
  });

  it('does the same across two repositories', () => {
    const set = resolveGateSet(
      input({ currentDesignEvidence: { id: 'ev_1', commitSha: 'c0ffee' }, members: GREEN_TWO }),
    );
    expect(set.awaited.map((gate) => gate.kind)).toEqual([
      'design_result',
      'pull_request_approval',
    ]);
    expect(set.primary).toBe('design_result');
  });

  it('NEVER depends on who holds the run target — it is not an input at all', () => {
    // MOTIR-5652's second refusal was `resolveRunTargetFor(...).kind === 'ancestor'`,
    // which every child of a parent run resolves to. A card with something to decide
    // has a gate regardless of it, so the fact is absent from this module's inputs
    // and this test is the record of that being deliberate.
    expect(Object.keys(input())).not.toContain('runTarget');
  });
});

describe('resolveGateSet — MOTIR-5603: at most ONE merge gate, ever', () => {
  it('asks exactly one merge question however many pull requests the card delivers', () => {
    const set = resolveGateSet(input({ members: GREEN_TWO }));
    expect(set.awaited.filter((gate) => gate.kind === 'pull_request_approval')).toHaveLength(1);
  });

  it('names the whole SET as its subject version, sorted and joined', () => {
    const set = resolveGateSet(input({ members: GREEN_TWO }));
    expect(set.awaited[0]?.subjectVersion).toBe('moooon/motir-ai#4@bbb2,moooon/motir-core#10@aaa1');
  });

  it('gives the same version whatever order the rows were read in', () => {
    const forward = resolveGateSet(input({ members: GREEN_TWO }));
    const reversed = resolveGateSet(input({ members: [...GREEN_TWO].reverse() }));
    expect(reversed.awaited[0]?.subjectVersion).toBe(forward.awaited[0]?.subjectVersion);
  });

  it('agrees with `deliverySetVersion`, which three other places already use', () => {
    const set = resolveGateSet(input({ members: GREEN_TWO }));
    expect(set.awaited[0]?.subjectVersion).toBe(
      deliverySetVersion(GREEN_TWO.map((m) => m.memberVersion)),
    );
  });
});

describe('resolveGateSet — MOTIR-5632: the same commits are never asked about twice', () => {
  it('stops asking once a decision answered THIS set', () => {
    const version = deliverySetVersion(GREEN_ONE.map((m) => m.memberVersion));
    const set = resolveGateSet(
      input({ members: GREEN_ONE, latestMergeGate: decided(WORK_ITEM, version) }),
    );
    expect(set.awaited).toEqual([]);
  });

  it('asks again once a push moved a head (MOTIR-5604)', () => {
    const answered = deliverySetVersion(GREEN_ONE.map((m) => m.memberVersion));
    const pushed = [member('moooon/motir-core#10@bbb2')];
    const set = resolveGateSet(
      input({ members: pushed, latestMergeGate: decided(WORK_ITEM, answered) }),
    );
    expect(set.awaited).toEqual([
      {
        kind: 'pull_request_approval',
        subjectId: WORK_ITEM,
        subjectVersion: 'moooon/motir-core#10@bbb2',
      },
    ]);
  });
});

describe('resolveGateSet — AMENDMENT 6 Q2: the merge gate re-opens ALONE', () => {
  it('asks the merge question by itself once the design has been decided', () => {
    // The state after an approval whose merge was then ejected: the design answer
    // stands, the commits are a live question again, and nobody is re-asked about
    // the mock they already approved.
    const set = resolveGateSet(
      input({
        currentDesignEvidence: { id: 'ev_1', commitSha: 'c0ffee' },
        latestDesignGate: decided('ev_1', 'c0ffee'),
        members: GREEN_ONE,
      }),
    );
    expect(set.awaited).toEqual([
      {
        kind: 'pull_request_approval',
        subjectId: WORK_ITEM,
        subjectVersion: 'moooon/motir-core#10@aaa1',
      },
    ]);
    expect(set.primary).toBe('pull_request_approval');
  });
});

describe('resolveGateSet — AMENDMENT 6 Q4: the design question does not wait for CI', () => {
  it('asks the design question while the set is NOT yet a merge candidate', () => {
    // The press is not refused before green; only the MERGE is held. Refusing it is
    // the silent stall MOTIR-5652 was filed about, arriving through a door we built.
    const set = resolveGateSet(
      input({
        currentDesignEvidence: { id: 'ev_1', commitSha: 'c0ffee' },
        members: [member('moooon/motir-core#10@aaa1', false)],
      }),
    );
    expect(set.awaited).toEqual([
      { kind: 'design_result', subjectId: 'ev_1', subjectVersion: 'c0ffee' },
    ]);
    expect(set.primary).toBe('design_result');
  });
});

describe('resolveGateSet — MOTIR-5574: a withdrawn result leaves nothing asking about it', () => {
  it('asks no design question when the card has no current result', () => {
    // `currentDesignEvidence` is the card's CURRENT non-withdrawn row, so a
    // withdrawal is expressed by its absence — and the question goes with it.
    const set = resolveGateSet(input({ latestDesignGate: decided('ev_1', 'c0ffee') }));
    expect(set.awaited.filter((gate) => gate.kind === 'design_result')).toEqual([]);
  });
});

describe('resolveGateSet — purity', () => {
  it('does not mutate what it is handed', () => {
    const members = [...GREEN_TWO];
    const args = input({ members });
    const frozen = JSON.stringify(args);
    resolveGateSet(args);
    expect(JSON.stringify(args)).toBe(frozen);
    expect(members.map((m) => m.memberVersion)).toEqual(GREEN_TWO.map((m) => m.memberVersion));
  });
});

describe("resolveGateSet — MOTIR-5666: Q4's carry is ONE-TIME", () => {
  const evidence = { id: 'ev-1', commitSha: 'sha-design' };

  it('a standing design approval carries the merge while the card has never held a merge gate', () => {
    const set = resolveGateSet(
      input({
        currentDesignEvidence: evidence,
        latestDesignGate: decided('ev-1', 'sha-design'),
        primaryApprovalStandsForMerge: true,
        members: GREEN_ONE,
      }),
    );

    expect(set.awaited.map((g) => g.kind)).toEqual([]);
  });

  it('…and stops carrying it the moment a merge gate has existed — a PUSH is a new question', () => {
    // Without this the design approval would go on authorising every future green,
    // merging code nobody approved. Found by building the ejection card, from a
    // push after an ejection raising nothing.
    const set = resolveGateSet(
      input({
        currentDesignEvidence: evidence,
        latestDesignGate: decided('ev-1', 'sha-design'),
        primaryApprovalStandsForMerge: true,
        latestMergeGate: decided(WORK_ITEM, 'moooon/motir-core#10@old'),
        members: GREEN_ONE,
      }),
    );

    expect(set.awaited.map((g) => g.kind)).toEqual(['pull_request_approval']);
    expect(set.awaited[0]!.subjectVersion).toBe('moooon/motir-core#10@aaa1');
  });
});

// ── §4 FOURTH AMENDMENT, points 1–2 (Story MOTIR-5799 · MOTIR-5805) ──────────────
// A merge-queue FAILURE standing at a member's head RE-ASKS the merge question, even
// over an approval of the same commits and over the design's carry — but only in a
// `manual` project, never the design question, and never over a decision made AFTER
// the exit (the re-asked gate's own answer).
describe('resolveGateSet — the FOURTH AMENDMENT: a failure ejection re-asks the merge', () => {
  const SET = 'moooon/motir-core#10@aaa1';
  const DECIDED_AT = new Date('2026-09-19T10:00:00.000Z');
  const EXIT_AFTER = new Date('2026-09-19T10:05:00.000Z');
  const EXIT_BEFORE = new Date('2026-09-19T09:55:00.000Z');
  const approvedMerge: ExistingGate = { ...decided(WORK_ITEM, SET), decidedAt: DECIDED_AT };
  const designEvidence = { id: 'ev_1', commitSha: 'c0ffee' };
  const approvedDesign: ExistingGate = { ...decided('ev_1', 'c0ffee'), decidedAt: DECIDED_AT };

  const cases = [
    {
      name: 'the merge gate APPROVED at the same version',
      over: { latestMergeGate: approvedMerge },
    },
    {
      name: "the design's one-press CARRY (no merge gate ever)",
      over: {
        currentDesignEvidence: designEvidence,
        latestDesignGate: approvedDesign,
        designApprovalStandsForMerge: true,
      },
    },
    { name: 'NO gate at all', over: {} },
  ] as const;

  for (const c of cases) {
    it(`manual · ${c.name}: ONE merge gate over the SAME set is owed, standing alone`, () => {
      const set = resolveGateSet(
        input({
          ...c.over,
          members: GREEN_ONE,
          standingUnlandedOutcome: { at: EXIT_AFTER, landingClass: 'retryable' },
        }),
      );
      expect(set.awaited).toEqual([
        { kind: 'pull_request_approval', subjectId: WORK_ITEM, subjectVersion: SET },
      ]);
      expect(set.primary).toBe('pull_request_approval');
    });

    it(`auto · ${c.name}: nothing is owed — no person decides in auto mode`, () => {
      const set = resolveGateSet(
        input({
          ...c.over,
          prMergeMode: 'auto',
          members: GREEN_ONE,
          standingUnlandedOutcome: { at: EXIT_AFTER, landingClass: 'retryable' },
        }),
      );
      expect(set.awaited.filter((g) => g.kind === 'pull_request_approval')).toEqual([]);
    });
  }

  it('never re-asks the DESIGN — a decided design stays decided', () => {
    const set = resolveGateSet(
      input({
        currentDesignEvidence: designEvidence,
        latestDesignGate: approvedDesign,
        latestMergeGate: approvedMerge,
        members: GREEN_ONE,
        standingUnlandedOutcome: { at: EXIT_AFTER, landingClass: 'retryable' },
      }),
    );
    expect(set.awaited.map((g) => g.kind)).toEqual(['pull_request_approval']);
  });

  it('an approval given AFTER the exit answers it — the re-asked gate’s own yes is not asked again', () => {
    const set = resolveGateSet(
      input({
        latestMergeGate: { ...approvedMerge, decidedAt: EXIT_AFTER },
        members: GREEN_ONE,
        standingUnlandedOutcome: { at: EXIT_BEFORE, landingClass: 'retryable' },
      }),
    );
    expect(set.awaited).toEqual([]);
  });

  it('CHANGES REQUESTED after the exit is an answer too', () => {
    const set = resolveGateSet(
      input({
        latestMergeGate: {
          ...decided(WORK_ITEM, SET, 'changes_requested'),
          decidedAt: EXIT_AFTER,
        },
        members: GREEN_ONE,
        standingUnlandedOutcome: { at: EXIT_BEFORE, landingClass: 'retryable' },
      }),
    );
    expect(set.awaited).toEqual([]);
  });

  it('with NO standing exit the approval still answers the same commits (MOTIR-5632, unchanged)', () => {
    const set = resolveGateSet(
      input({ latestMergeGate: approvedMerge, members: GREEN_ONE, standingUnlandedOutcome: null }),
    );
    expect(set.awaited).toEqual([]);
  });

  // ⚠️ A CAN'T-LAND OUTCOME ASKS NOTHING (§4 FOURTH AMENDMENT, point 2; MOTIR-5805).
  // The commits cannot combine as they stand, so a gate there would offer a button
  // guaranteed to fail — the card waits at Implemented with `motir fix`, and a PUSH is
  // what brings the question back.
  it('a CONFLICT outcome raises NOTHING, however long it stands', () => {
    const set = resolveGateSet(
      input({
        latestMergeGate: approvedMerge,
        members: GREEN_ONE,
        standingUnlandedOutcome: { at: EXIT_AFTER, landingClass: 'cant_land' },
      }),
    );
    expect(set.awaited).toEqual([]);
  });

  // ⚠️ AND WHATEVER THE LATEST GATE SAYS (MOTIR-6595). The convergence withdraws a gate the
  // OLD rule re-asked from a queue failure, so the latest merge gate is `superseded` — or
  // there is none — and without the clause the reconcile would ask over the refused commits.
  it.each([
    ['a SUPERSEDED latest gate', { ...decided(WORK_ITEM, SET, 'superseded'), decidedAt: null }],
    ['NO merge gate at all', null],
  ] as const)('a CAN’T-LAND outcome raises NOTHING over %s either', (_label, latestMergeGate) => {
    const set = resolveGateSet(
      input({
        latestMergeGate,
        members: GREEN_ONE,
        standingUnlandedOutcome: { at: EXIT_AFTER, landingClass: 'cant_land' },
      }),
    );
    expect(set.awaited).toEqual([]);
  });

  it('a SETTING outcome re-asks, exactly as a retryable one does', () => {
    const set = resolveGateSet(
      input({
        latestMergeGate: approvedMerge,
        members: GREEN_ONE,
        standingUnlandedOutcome: { at: EXIT_AFTER, landingClass: 'setting' },
      }),
    );
    expect(set.awaited).toEqual([
      { kind: 'pull_request_approval', subjectId: WORK_ITEM, subjectVersion: SET },
    ]);
  });

  it('a member that already MERGED is settled, not blocking — the re-ask is still owed (MOTIR-5805)', () => {
    const TWO = 'moooon/motir-ai#4@bbb2,' + SET;
    const set = resolveGateSet(
      input({
        latestMergeGate: { ...decided(WORK_ITEM, TWO), decidedAt: DECIDED_AT },
        members: [member(SET), { ...member('moooon/motir-ai#4@bbb2', false), merged: true }],
        standingUnlandedOutcome: { at: EXIT_AFTER, landingClass: 'retryable' },
      }),
    );
    expect(set.awaited).toEqual([
      { kind: 'pull_request_approval', subjectId: WORK_ITEM, subjectVersion: TWO },
    ]);
  });

  // ⚠️ …AND WITHOUT ONE TOO (MOTIR-5901; §4 SECOND AMENDMENT, decision 4's amendment).
  // This case used to pin the opposite — *"a merged member still blocks, exactly as
  // before"* — and that WAS the defect: a member merged with GitHub's own button made
  // the rest of the set unaskable for ever, so the withdrawn frame's *"Motir asks again"*
  // could never be kept. What made the member merge does not change what it is: settled.
  it('…and WITHOUT an ejection a merged member is settled too — the rest is still asked about (MOTIR-5901)', () => {
    const TWO = 'moooon/motir-ai#4@bbb2,' + SET;
    const set = resolveGateSet(
      input({
        members: [member(SET), { ...member('moooon/motir-ai#4@bbb2', false), merged: true }],
      }),
    );
    expect(set).toEqual({
      awaited: [{ kind: 'pull_request_approval', subjectId: WORK_ITEM, subjectVersion: TWO }],
      primary: 'pull_request_approval',
    });
  });

  it('a set whose EVERY member merged asks nothing — there is nothing left to land (MOTIR-5901)', () => {
    const merged = (version: string) => ({ ...member(version, false), merged: true });
    expect(
      resolveGateSet(input({ members: [merged(SET), merged('moooon/motir-ai#4@bbb2')] })).awaited,
    ).toEqual([]);
    // …and an ejection does not change that: it re-asks about commits that did not land,
    // and here there are none.
    expect(
      resolveGateSet(
        input({
          latestMergeGate: approvedMerge,
          members: [merged(SET)],
          standingUnlandedOutcome: { at: EXIT_AFTER, landingClass: 'retryable' },
        }),
      ).awaited,
    ).toEqual([]);
  });

  it('a merged member beside an open one that is NOT green asks nothing yet (MOTIR-5901)', () => {
    const set = resolveGateSet(
      input({
        members: [member(SET, false), { ...member('moooon/motir-ai#4@bbb2', false), merged: true }],
      }),
    );
    expect(set.awaited).toEqual([]);
  });

  // ⚠️ CLOSED WITHOUT MERGING STILL BLOCKS — decided, not inherited (MOTIR-5901; the §4
  // amendment says why). A closed member can be REOPENED or UNLINKED, and both put the
  // question back; a merged one can do neither. Its commits will never land, so a gate
  // naming them would ask a person to approve a merge the set cannot finish.
  it('a member CLOSED WITHOUT MERGING still blocks — it is not settled (MOTIR-5901)', () => {
    const set = resolveGateSet(
      input({
        members: [member(SET), { ...member('moooon/motir-ai#4@bbb2', false), merged: false }],
      }),
    );
    expect(set.awaited).toEqual([]);
  });

  it('still needs every member to be a merge candidate — an ejection does not bypass MOTIR-5604', () => {
    const set = resolveGateSet(
      input({
        latestMergeGate: approvedMerge,
        members: [member(SET, false)],
        standingUnlandedOutcome: { at: EXIT_AFTER, landingClass: 'retryable' },
      }),
    );
    expect(set.awaited).toEqual([]);
  });
});

describe('resolveGateSet — ONE home, and every trigger goes through it', () => {
  // The whole reason the decision is a pure predicate: adding a trigger must
  // duplicate no logic, because duplicating it is how this family reached six
  // defects. A second caller of `resolveGateSet` would be a second place the
  // inputs are assembled, which is the same mistake one layer out.
  const sourceFiles = () =>
    execSync("grep -rl 'resolveGateSet' lib || true", { cwd: process.cwd(), encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);

  it('is CALLED from exactly one module — `gateSetFor`, the one loader', () => {
    const callers = sourceFiles().filter(
      (file) =>
        file !== 'lib/approvalGates/gateSet.ts' &&
        readFileSync(join(process.cwd(), file), 'utf8').includes('resolveGateSet('),
    );

    expect(callers).toEqual(['lib/services/gateSetFor.ts']);
  });

  it('and every TRIGGER reaches it through `reconcileGatesFor`, never by re-deriving', () => {
    // The triggers as they stand: the CI promotion (through
    // `raisePullRequestApprovalGate`, a thin wrapper), the three merge-gate
    // withdrawers' re-ask, the design publish, the status funnel, and the
    // 30-minute reconcile. Each names the helper; none names the predicate.
    const triggers = execSync("grep -rl 'reconcileGatesFor\\|gateSetFor(' lib/services || true", {
      cwd: process.cwd(),
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
      .filter((file) => file !== 'lib/services/gateSetFor.ts');

    expect(triggers.length).toBeGreaterThan(0);
    for (const file of triggers) {
      expect(
        `${file}: ${readFileSync(join(process.cwd(), file), 'utf8').includes('resolveGateSet(')}`,
      ).toBe(`${file}: false`);
    }
  });
});

describe('designHoldsMerge — MOTIR-5762: only an approval of the CURRENT result releases the merge', () => {
  const current = { id: 'ev-2' };
  const gate = (state: string, subjectId = 'ev-2') => ({ state, subjectId });

  it('a card with no design result is never held', () => {
    expect(designHoldsMerge(null, null)).toBe(false);
    expect(designHoldsMerge(null, gate('awaiting'))).toBe(false);
  });

  it('a result nobody has answered, or one sent back, holds', () => {
    expect(designHoldsMerge(current, null)).toBe(true);
    expect(designHoldsMerge(current, gate('awaiting'))).toBe(true);
    // Sent back is not an OPEN question — `resolveGateSet` asks nothing — and it still holds.
    expect(designHoldsMerge(current, gate('changes_requested'))).toBe(true);
  });

  it('an approval of a SUPERSEDED result holds; an approval of the current one releases', () => {
    expect(designHoldsMerge(current, gate('approved', 'ev-1'))).toBe(true);
    expect(designHoldsMerge(current, gate('approved'))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE ACCEPTANCE QUESTION (Story MOTIR-4949 · Subtask MOTIR-5789; `approval-gates.md`
// §1, the MOTIR-5787 amendment) — a STORY's receipt is a PRIMARY, exactly where the
// design result is, and every case below is a story state.
// ═══════════════════════════════════════════════════════════════════════════
describe('resolveGateSet — the ACCEPTANCE question (MOTIR-5789; timing: MOTIR-5903)', () => {
  const RECEIPT = { id: 'ae_1', commitSha: 'c0ffee1' };

  it('(a) a SUBTASK-RUN story (no pull requests of its own) with its subtree SETTLED asks acceptance alone, and it leads', () => {
    const set = resolveGateSet(input({ currentReceipt: RECEIPT, subtreeSettled: true }));
    expect(set.awaited).toEqual([
      { kind: 'acceptance_result', subjectId: 'ae_1', subjectVersion: 'c0ffee1' },
    ]);
    expect(set.primary).toBe('acceptance_result');
  });

  it('(a′) a SUBTASK-RUN story asks NOTHING while anything under it is open — the recording subtask is not merged yet (MOTIR-5903)', () => {
    expect(resolveGateSet(input({ currentReceipt: RECEIPT, subtreeSettled: false }))).toEqual({
      awaited: [],
      primary: null,
    });
    // Absent reads as NOT settled: a caller that did not load it never asks early.
    expect(resolveGateSet(input({ currentReceipt: RECEIPT })).awaited).toEqual([]);
  });

  it('(a″) a STORY RUN whose set is NOT green asks nothing — no acceptance row while the story cannot merge (MOTIR-5903)', () => {
    for (const members of [
      [member('moooon/motir-core#10@aaa1', false)],
      [member('moooon/motir-core#10@aaa1'), member('moooon/motir-ai#4@bbb2', false)],
    ]) {
      // A settled subtree does not make a story run's question owed: its timing is the SET.
      const set = resolveGateSet(input({ currentReceipt: RECEIPT, members, subtreeSettled: true }));
      expect(set).toEqual({ awaited: [], primary: null });
    }
  });

  it('(a‴) a STORY RUN in an `auto` project asks acceptance once green, and never while red (MOTIR-5903)', () => {
    expect(
      resolveGateSet(
        input({
          prMergeMode: 'auto',
          currentReceipt: RECEIPT,
          members: [member('moooon/motir-core#10@aaa1', false)],
        }),
      ).awaited,
    ).toEqual([]);
    expect(
      resolveGateSet(
        input({ prMergeMode: 'auto', currentReceipt: RECEIPT, members: GREEN_ONE }),
      ).awaited.map((gate) => gate.kind),
    ).toEqual(['acceptance_result']);
  });

  describe('a STORY RUN whose own pull requests have ALL merged (MOTIR-10837)', () => {
    const merged = (version: string): GateSetMember => ({
      ...member(version, false),
      merged: true,
    });
    const ALL_MERGED = [merged('moooon/motir-core#10@aaa1'), merged('moooon/motir-ai#4@bbb2')];

    it('asks acceptance ALONE once the subtree is settled — there is no merge question left for it to ride', () => {
      for (const members of [[merged('moooon/motir-core#10@aaa1')], ALL_MERGED]) {
        const set = resolveGateSet(
          input({ currentReceipt: RECEIPT, members, subtreeSettled: true }),
        );
        expect(set.awaited).toEqual([
          { kind: 'acceptance_result', subjectId: 'ae_1', subjectVersion: 'c0ffee1' },
        ]);
        expect(set.primary).toBe('acceptance_result');
      }
    });

    it('asks nothing while anything under the story is still open, or when the subtree was not loaded', () => {
      expect(
        resolveGateSet(
          input({ currentReceipt: RECEIPT, members: ALL_MERGED, subtreeSettled: false }),
        ),
      ).toEqual({ awaited: [], primary: null });
      expect(
        resolveGateSet(input({ currentReceipt: RECEIPT, members: ALL_MERGED })).awaited,
      ).toEqual([]);
    });

    it('follows the settled rule, not the merge question’s: asked outside `in_review`, and over a stale merge refusal at the merged version', () => {
      const version = deliverySetVersion(ALL_MERGED.map((m) => m.memberVersion));
      const set = resolveGateSet(
        input({
          currentReceipt: RECEIPT,
          members: ALL_MERGED,
          subtreeSettled: true,
          cardInReview: false,
          latestMergeGate: decided(WORK_ITEM, version, 'changes_requested'),
          agentSendBackVersion: version,
        }),
      );
      expect(set.awaited.map((gate) => gate.kind)).toEqual(['acceptance_result']);
    });

    it('an ANSWERED receipt is not asked again', () => {
      const set = resolveGateSet(
        input({
          currentReceipt: RECEIPT,
          latestAcceptanceGate: decided('ae_1', 'c0ffee1'),
          members: ALL_MERGED,
          subtreeSettled: true,
        }),
      );
      expect(set).toEqual({ awaited: [], primary: null });
    });

    it('a member CLOSED WITHOUT MERGING still holds the question back, however settled the subtree', () => {
      const closed: GateSetMember = { ...member('moooon/motir-ai#4@bbb2', false), merged: false };
      for (const members of [
        [merged('moooon/motir-core#10@aaa1'), closed],
        [{ ...closed, merged: undefined }],
      ]) {
        const set = resolveGateSet(
          input({ currentReceipt: RECEIPT, members, subtreeSettled: true }),
        );
        expect(set).toEqual({ awaited: [], primary: null });
      }
    });

    it('a story run with one member merged and one still OPEN keeps the story-run rule: asked beside the merge question at `in_review`, never outside it', () => {
      const members = [merged('moooon/motir-core#10@aaa1'), member('moooon/motir-ai#4@bbb2')];
      expect(
        resolveGateSet(input({ currentReceipt: RECEIPT, members })).awaited.map(
          (gate) => gate.kind,
        ),
      ).toEqual(['acceptance_result', 'pull_request_approval']);
      expect(
        resolveGateSet(
          input({ currentReceipt: RECEIPT, members, subtreeSettled: true, cardInReview: false }),
        ).awaited,
      ).toEqual([]);
    });
  });

  it('(b) a STORY RUN — receipt + a green set — asks BOTH, and acceptance is the primary', () => {
    const set = resolveGateSet(input({ currentReceipt: RECEIPT, members: GREEN_ONE }));
    expect(set.awaited.map((gate) => gate.kind)).toEqual([
      'acceptance_result',
      'pull_request_approval',
    ]);
    expect(set.primary).toBe('acceptance_result');
  });

  it('(c) an APPROVED acceptance over the current receipt carries the merge — no merge gate is asked (Q4)', () => {
    const latestAcceptanceGate = decided('ae_1', 'c0ffee1');
    const set = resolveGateSet(
      input({
        currentReceipt: RECEIPT,
        latestAcceptanceGate,
        members: GREEN_ONE,
        primaryApprovalStandsForMerge: primaryApprovalStandsForMerge({
          currentDesign: null,
          latestDesignGate: null,
          currentReceipt: RECEIPT,
          latestAcceptanceGate,
        }),
      }),
    );
    expect(set.awaited).toEqual([]);
    expect(set.primary).toBeNull();
  });

  it('(d) after a merge gate has existed and the merge failed, a new green asks the MERGE alone — acceptance is not re-asked (Q2)', () => {
    const set = resolveGateSet(
      input({
        currentReceipt: RECEIPT,
        latestAcceptanceGate: decided('ae_1', 'c0ffee1'),
        // An approved merge gate over OLD commits; a push has moved the set since.
        latestMergeGate: decided(WORK_ITEM, 'moooon/motir-core#10@old0'),
        members: GREEN_ONE,
        primaryApprovalStandsForMerge: true,
      }),
    );
    expect(set.awaited.map((gate) => gate.kind)).toEqual(['pull_request_approval']);
    expect(set.primary).toBe('pull_request_approval');
  });

  it('(e) a TERMINAL story asks nothing, receipt or not', () => {
    const set = resolveGateSet(
      input({ currentReceipt: RECEIPT, members: GREEN_ONE, cardIsTerminal: true }),
    );
    expect(set).toEqual({ awaited: [], primary: null });
  });

  it('a NEWER receipt than the one approved is a new question — the approval of v1 answers nothing about v2', () => {
    const set = resolveGateSet(
      input({
        currentReceipt: { id: 'ae_2', commitSha: 'd00d002' },
        latestAcceptanceGate: decided('ae_1', 'c0ffee1'),
        subtreeSettled: true,
      }),
    );
    expect(set.awaited.map((gate) => gate.subjectId)).toEqual(['ae_2']);
  });

  it('REFUSES a card owing both a design and an acceptance question — asserted, never ranked', () => {
    expect(() =>
      resolveGateSet(
        input({
          currentReceipt: RECEIPT,
          currentDesignEvidence: { id: 'de_1', commitSha: 'abc' },
          subtreeSettled: true,
        }),
      ),
    ).toThrow(/BOTH a design and an acceptance question/);
  });

  it('`primaryApprovalStandsForMerge` is ONE reader for both primaries, and needs the approval to be over the CURRENT subject', () => {
    const none = { currentDesign: null, latestDesignGate: null };
    expect(
      primaryApprovalStandsForMerge({
        ...none,
        currentReceipt: RECEIPT,
        latestAcceptanceGate: decided('ae_1', 'c0ffee1'),
      }),
    ).toBe(true);
    expect(
      primaryApprovalStandsForMerge({
        ...none,
        currentReceipt: { id: 'ae_2' },
        latestAcceptanceGate: decided('ae_1', 'c0ffee1'),
      }),
    ).toBe(false);
    expect(
      primaryApprovalStandsForMerge({
        ...none,
        currentReceipt: RECEIPT,
        latestAcceptanceGate: decided('ae_1', 'c0ffee1', 'changes_requested'),
      }),
    ).toBe(false);
  });
});

describe('acceptanceRefusalHoldsMerge + resolveGateSet — MOTIR-6503: a story-run refusal HOLDS the merge', () => {
  const RECEIPT = { id: 'ae_1', commitSha: 'c0ffee1' };
  const refused = (verdict: string | null, subjectId = 'ae_1'): ExistingGate => ({
    state: 'changes_requested',
    subjectId,
    subjectVersion: 'c0ffee1',
    refusalVerdict: verdict,
  });

  for (const verdict of ['revise', 're_plan']) {
    it(`${verdict} over the CURRENT receipt holds: a green set asks nothing — not the merge alone`, () => {
      expect(acceptanceRefusalHoldsMerge(RECEIPT, refused(verdict))).toBe(true);
      const set = resolveGateSet(
        input({
          currentReceipt: RECEIPT,
          latestAcceptanceGate: refused(verdict),
          members: GREEN_TWO,
        }),
      );
      expect(set).toEqual({ awaited: [], primary: null });
    });
  }

  it('the hold survives a push: a NEW set version with no new receipt still asks nothing', () => {
    const set = resolveGateSet(
      input({
        currentReceipt: RECEIPT,
        latestAcceptanceGate: refused('revise'),
        members: [member('moooon/motir-core#10@fff9')],
        // The withdrawn merge gate the refusal left behind.
        latestMergeGate: {
          ...decided(WORK_ITEM, 'moooon/motir-core#10@aaa1'),
          state: 'superseded',
        },
      }),
    );
    expect(set.awaited).toEqual([]);
  });

  it('a NEWER receipt releases it: the acceptance and the merge are asked together, acceptance leading', () => {
    const newer = { id: 'ae_2', commitSha: 'c0ffee2' };
    expect(acceptanceRefusalHoldsMerge(newer, refused('revise'))).toBe(false);
    const set = resolveGateSet(
      input({ currentReceipt: newer, latestAcceptanceGate: refused('revise'), members: GREEN_ONE }),
    );
    expect(set.awaited.map((g) => g.kind)).toEqual(['acceptance_result', 'pull_request_approval']);
    expect(set.primary).toBe('acceptance_result');
  });

  it('a VERDICT-LESS refusal (GitHub, or a finished story) holds nothing', () => {
    expect(acceptanceRefusalHoldsMerge(RECEIPT, refused(null))).toBe(false);
    expect(
      acceptanceRefusalHoldsMerge(RECEIPT, { state: 'changes_requested', subjectId: 'ae_1' }),
    ).toBe(false);
    const set = resolveGateSet(
      input({ currentReceipt: RECEIPT, latestAcceptanceGate: refused(null), members: GREEN_ONE }),
    );
    expect(set.awaited.map((g) => g.kind)).toEqual(['pull_request_approval']);
  });

  it('an approval, an awaiting question, or no receipt at all holds nothing', () => {
    expect(acceptanceRefusalHoldsMerge(RECEIPT, { ...refused('revise'), state: 'approved' })).toBe(
      false,
    );
    expect(acceptanceRefusalHoldsMerge(RECEIPT, { ...refused('revise'), state: 'awaiting' })).toBe(
      false,
    );
    expect(acceptanceRefusalHoldsMerge(null, refused('revise'))).toBe(false);
    expect(acceptanceRefusalHoldsMerge(RECEIPT, null)).toBe(false);
  });
});

describe('resolveGateSet — a refused MERGE withholds a story run’s acceptance question', () => {
  const RECEIPT = { id: 'ae_1', commitSha: 'c0ffee1' };
  const VERSION = 'moooon/motir-core#10@aaa1';

  it('Request changes on the merge gate at the current version asks NOTHING — neither the video nor the merge', () => {
    const set = resolveGateSet(
      input({
        currentReceipt: RECEIPT,
        members: GREEN_ONE,
        latestMergeGate: decided(WORK_ITEM, VERSION, 'changes_requested'),
      }),
    );
    expect(set).toEqual({ awaited: [], primary: null });
  });

  it('a push past the refused version asks both again, acceptance leading', () => {
    const set = resolveGateSet(
      input({
        currentReceipt: RECEIPT,
        members: GREEN_ONE,
        latestMergeGate: decided(WORK_ITEM, 'moooon/motir-core#10@old0', 'changes_requested'),
      }),
    );
    expect(set.awaited.map((gate) => gate.kind)).toEqual([
      'acceptance_result',
      'pull_request_approval',
    ]);
    expect(set.primary).toBe('acceptance_result');
  });

  it('a standing agent send-back at the version withholds the video too; a Dismiss asks both again', () => {
    const sentBack = resolveGateSet(
      input({ currentReceipt: RECEIPT, members: GREEN_ONE, agentSendBackVersion: VERSION }),
    );
    expect(sentBack).toEqual({ awaited: [], primary: null });

    const dismissed = resolveGateSet(
      input({
        currentReceipt: RECEIPT,
        members: GREEN_ONE,
        agentSendBackVersion: VERSION,
        dismissedSendBackVersion: VERSION,
      }),
    );
    expect(dismissed.awaited.map((gate) => gate.kind)).toEqual([
      'acceptance_result',
      'pull_request_approval',
    ]);
  });

  it('a SUBTASK-RUN story is untouched — its video is not the merge gate', () => {
    const set = resolveGateSet(
      input({
        currentReceipt: RECEIPT,
        subtreeSettled: true,
        agentSendBackVersion: VERSION,
      }),
    );
    expect(set.awaited.map((gate) => gate.kind)).toEqual(['acceptance_result']);
  });
});

describe('resolveGateSet — MOTIR-6971: the merge question is asked ONLY at `in_review`', () => {
  // Green CI is not a finished run: any pull request can be linked to a card, and a
  // card left at `in_progress` is a DEAD run. MOTIR-6914 was asked to approve at
  // `in_progress` and the press threw `IllegalTransitionError` (no `in_progress →
  // approved` edge). Gate ⇔ CI all green AND the card in review.
  const RECEIPT = { id: 'ae_1', commitSha: 'c0ffee1' };

  it('asks NO merge question of a green set on a card that is not in review', () => {
    expect(resolveGateSet(input({ members: GREEN_TWO, cardInReview: false }))).toEqual({
      awaited: [],
      primary: null,
    });
  });

  it('asks exactly ONE merge question of the same set once the card is in review', () => {
    const set = resolveGateSet(input({ members: GREEN_TWO, cardInReview: true }));
    expect(set.awaited).toEqual([
      {
        kind: 'pull_request_approval',
        subjectId: WORK_ITEM,
        subjectVersion: deliverySetVersion(['moooon/motir-core#10@aaa1', 'moooon/motir-ai#4@bbb2']),
      },
    ]);
  });

  it("a STORY RUN's acceptance question takes the same condition — none while the story is out of review", () => {
    expect(
      resolveGateSet(input({ currentReceipt: RECEIPT, members: GREEN_ONE, cardInReview: false })),
    ).toEqual({ awaited: [], primary: null });
    expect(
      resolveGateSet(
        input({ currentReceipt: RECEIPT, members: GREEN_ONE, cardInReview: true }),
      ).awaited.map((gate) => gate.kind),
    ).toEqual(['acceptance_result', 'pull_request_approval']);
  });

  it("a SUBTASK-RUN story's acceptance question is untouched — its timing is the subtree, not a pull request", () => {
    expect(
      resolveGateSet(input({ currentReceipt: RECEIPT, subtreeSettled: true, cardInReview: false }))
        .awaited,
    ).toEqual([{ kind: 'acceptance_result', subjectId: 'ae_1', subjectVersion: 'c0ffee1' }]);
  });

  it('the DESIGN question does not depend on the status — it is asked on publish', () => {
    const set = resolveGateSet(
      input({
        currentDesignEvidence: { id: 'de_1', commitSha: 'd351gn1' },
        members: GREEN_ONE,
        cardInReview: false,
      }),
    );
    expect(set.awaited.map((gate) => gate.kind)).toEqual(['design_result']);
  });
});
