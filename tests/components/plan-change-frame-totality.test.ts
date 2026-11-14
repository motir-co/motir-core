import { afterEach, describe, expect, it, vi } from 'vitest';
import { narrateFrame } from '@/lib/hooks/usePlanChangeConversation';
import {
  FRAME_DISPOSITIONS,
  PLAN_CHANGE_FRAME_KINDS,
  isKnownFrameKind,
} from '@/lib/planning/planChangeFrames';

// THE RENDERER IS TOTAL (Story MOTIR-4054 · MOTIR-4069).
//
// ⚠️ WHAT THE CARD ASKED FOR, AND WHAT IT COULD NOT HAVE. It asks for totality
// "over the frame contract … enumerated from the contract, never from a
// hand-written list in the test". There WAS no contract: a frame's kind is a bare
// `string` on both sides of the wire, so there was nothing to enumerate from and
// no way to write this file as specified. `lib/planning/planChangeFrames.ts` is
// that enumeration, created by this card, and the tests below read it rather than
// restating it — which is the property the card's clause was protecting: the
// renderer and the test cannot drift, because there is only one list.
//
// The rest of that clause is answered by the TYPE rather than by a test:
// `FRAME_DISPOSITIONS` is a `Record<PlanChangeFrameKind, …>`, so a kind added to
// the union without a disposition does not compile. A test can only fail after
// somebody runs it; this fails while they are typing.

afterEach(() => {
  vi.restoreAllMocks();
});

/** Silence the loud default's console.warn for the cases that expect it. */
function withQuietConsole<T>(fn: () => T): T {
  const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    return fn();
  } finally {
    spy.mockRestore();
  }
}

describe('every frame kind is ACCOUNTED FOR', () => {
  it('the enumeration and the disposition map are the same set', () => {
    // Not a restatement of either — a check that the two agree, which is what
    // makes reading one of them sufficient everywhere else.
    expect(Object.keys(FRAME_DISPOSITIONS).sort()).toEqual([...PLAN_CHANGE_FRAME_KINDS].sort());
  });

  it('⚠️ NOTHING FALLS THROUGH — every kind is a decision, driven from the contract', () => {
    // The card's own words: "the renderer accounts for every frame kind". Not
    // "renders" — a line for all 51 would make the rail a log, which the design
    // rejects. What is forbidden is NEITHER: a kind nobody decided about.
    const unaccounted: string[] = [];
    for (const kind of PLAN_CHANGE_FRAME_KINDS) {
      const disposition = FRAME_DISPOSITIONS[kind];
      const decided = 'show' in disposition || 'quiet' in disposition;
      if (!decided) unaccounted.push(kind);
    }
    expect(unaccounted).toEqual([]);
  });

  it('a SHOW kind narrates something; a QUIET kind narrates nothing, on purpose', () => {
    for (const kind of PLAN_CHANGE_FRAME_KINDS) {
      const disposition = FRAME_DISPOSITIONS[kind];
      // Payloads every SHOW arm can read something out of, so a null here means
      // the arm is missing rather than the fixture being thin.
      const narrated = narrateFrame(kind, {
        proposed: 3,
        family: 'plan_tree',
        target: 'MOTIR-1',
        title: 'A card',
        text: 'because the billing epic already owns it',
      });
      if ('show' in disposition) {
        expect(narrated, `${kind} is SHOW and must narrate`).not.toBeNull();
      } else {
        expect(narrated, `${kind} is QUIET and must not`).toBeNull();
      }
    }
  });

  it('every QUIET decision carries its REASON', () => {
    // A bare `false` would be the same silent decision this card repairs, one
    // layer up: the reason is what makes "we do not show this" reviewable.
    for (const kind of PLAN_CHANGE_FRAME_KINDS) {
      const disposition = FRAME_DISPOSITIONS[kind];
      if ('quiet' in disposition) {
        expect(disposition.quiet.length, `${kind} needs a reason`).toBeGreaterThan(10);
      }
    }
  });
});

describe('AN UNKNOWN KIND DRAWS NOTHING, AND TELLS A DEVELOPER (MOTIR-8158)', () => {
  // The rail used to draw an unlisted frame raw as `frame: <name>`, which meant
  // nothing to the person. The user's screen no longer carries that; catching a
  // new kind is `tests/planning/frameKindParity.test.ts`'s job. The console
  // warning stays as the developer signal.
  it('returns null for a frame nobody has decided about', () => {
    withQuietConsole(() => {
      for (const invented of ['some_future_frame', 'token_stream', 'zzz', 'retrievalX']) {
        expect(isKnownFrameKind(invented)).toBe(false);
        expect(narrateFrame(invented, { x: 1 }), `${invented} was drawn`).toBeNull();
      }
    });
  });

  it('says so where a DEVELOPER sees it, naming the frame and the file to fix', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    narrateFrame('some_future_frame', {});
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('some_future_frame');
    // The message has to be actionable, not merely present: whoever sees it in a
    // console needs to know where the list lives.
    expect(message).toContain('planChangeFrames');
    warn.mockRestore();
  });
});

describe('LOOKUPS ARE NEVER DRAWN (MOTIR-8158)', () => {
  it('`retrieval`, `search`, `drill` and `tool_call` narrate nothing, whatever the payload', () => {
    for (const kind of ['retrieval', 'search', 'drill', 'tool_call', 'tool_call_failed']) {
      for (const payload of [
        { tool: 'get_item', family: 'plan_tree' },
        { family: 'plan_tree', blocked: true },
        {},
        undefined,
      ]) {
        expect(narrateFrame(kind, payload), kind).toBeNull();
      }
    }
  });

  it('the telemetry and bookkeeping frames motir-ai emits are quiet too', () => {
    for (const kind of [
      'model_stop',
      'session_summary',
      'gap',
      'planning_record_not_filed',
      'planning_failure_filed',
    ]) {
      expect(narrateFrame(kind, { reason: 'x' }), kind).toBeNull();
    }
  });
});

describe('`lay` and `author` name what they act on — and survive a thin payload', () => {
  it('names the target being laid and the title being written', () => {
    expect(narrateFrame('lay', { target: 'MOTIR-42', depth: 1 })).toEqual({
      kind: 'laying',
      target: 'MOTIR-42',
    });
    expect(narrateFrame('author', { ref: 'MOTIR-43', kind: 'subtask', title: 'The stop' })).toEqual(
      {
        kind: 'authoring',
        title: 'The stop',
      },
    );
  });

  it('a missing or non-string target / title is null, never the string "undefined"', () => {
    expect(narrateFrame('lay', {})).toEqual({ kind: 'laying', target: null });
    expect(narrateFrame('lay', { target: 7 })).toEqual({ kind: 'laying', target: null });
    expect(narrateFrame('author', { title: null })).toEqual({ kind: 'authoring', title: null });
    expect(narrateFrame('author', undefined)).toEqual({ kind: 'authoring', title: null });
  });
});

// MOTIR-11256 — the reconcile, the final check and its fix each draw their own act.
describe('`amend`, `check` and `repair` are their own acts, never a lay', () => {
  it('an amend names the level it reconciles, or the top level with none', () => {
    expect(narrateFrame('amend', { target: 'MOTIR-42', depth: 1 })).toEqual({
      kind: 'amending',
      target: 'MOTIR-42',
    });
    expect(narrateFrame('amend', { target: null, depth: 0 })).toEqual({
      kind: 'amending',
      target: null,
    });
    expect(narrateFrame('amend', undefined)).toEqual({ kind: 'amending', target: null });
  });

  it('the final check and its fix name the plan step, whatever the payload', () => {
    expect(narrateFrame('check', {})).toEqual({ kind: 'checking' });
    expect(narrateFrame('check', undefined)).toEqual({ kind: 'checking' });
    expect(narrateFrame('repair', { target: 'x' })).toEqual({ kind: 'repairing' });
  });
});

describe('the planner’s PROSE line', () => {
  it('renders the text the planner wrote', () => {
    expect(
      narrateFrame('note', {
        act: 'author',
        ref: 'MOTIR-1',
        text: '  the billing epic already owns this  ',
      }),
    ).toEqual({
      kind: 'note',
      text: 'the billing epic already owns this',
    });
  });

  it('⚠️ ITS ABSENCE IS NOT AN EMPTY ROW', () => {
    // The producer already refuses to emit a blank note — "a blank line is not a
    // shorter line, it is a line the rail would render as a hole" — and this is
    // the same refusal on our side, because a hole is what a bad payload draws.
    for (const text of ['', '   ', '\n\t ', undefined, null, 42]) {
      expect(narrateFrame('note', { text }), String(text)).toBeNull();
    }
  });
});

describe('the frames still drawn keep their output', () => {
  it('the outcome arms are byte-identical', () => {
    expect(narrateFrame('pass', { proposed: 4 })).toEqual({ kind: 'proposed', count: 4 });
    expect(narrateFrame('planned', { proposed: 'lots' })).toEqual({ kind: 'proposed', count: 0 });
    expect(narrateFrame('level_complete', {})).toEqual({ kind: 'proposed', count: 0 });
    expect(narrateFrame('validated', {})).toEqual({ kind: 'validating' });
    expect(narrateFrame('validation_skipped', {})).toEqual({ kind: 'validating' });
  });

  it('still tolerates an absent payload', () => {
    expect(narrateFrame('pass', undefined)).toEqual({ kind: 'proposed', count: 0 });
  });
});

describe('the enumeration is a SNAPSHOT, and says so', () => {
  it('holds the kinds motir-ai emitted at the sweep', () => {
    // A CROSS-REPO FIXTURE: `tests/planning/frameKindParity.test.ts` holds the
    // checked-in sweep and fails when it names a kind this map does not list.
    // Here only a few load-bearing members are pinned.
    for (const kind of ['retrieval', 'search', 'drill', 'lay', 'author', 'note', 'planned']) {
      expect(isKnownFrameKind(kind), kind).toBe(true);
    }
    for (const kind of ['model_stop', 'session_summary', 'gap', 'tool_call']) {
      expect(isKnownFrameKind(kind), kind).toBe(true);
    }
  });

  it('the SHOW set is the outcome and prose frames — no lookup is in it', () => {
    const shown = PLAN_CHANGE_FRAME_KINDS.filter((k) => 'show' in FRAME_DISPOSITIONS[k]);
    expect([...shown].sort()).toEqual(
      [
        'amend',
        'author',
        'check',
        'lay',
        'level_complete',
        'note',
        'pass',
        'planned',
        'repair',
        'validated',
        'validation_skipped',
      ].sort(),
    );
    // …and it is a SMALL set. A line for every kind would make the rail a log,
    // which sheet 3 rejects in as many words.
    expect(shown.length).toBeLessThan(PLAN_CHANGE_FRAME_KINDS.length / 2);
  });
});
