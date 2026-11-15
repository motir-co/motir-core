import { describe, expect, it } from 'vitest';
import { planReviewItem } from '../helpers/planReview';
import type { PlanItemDraftDto } from '@/lib/dto/plans';
import type { InFlightStep } from '@/lib/planning/livePane';
import {
  type CueStep,
  EMPTY_HOLD,
  NO_CARD_CUES,
  cuesByProposal,
  deriveCardCues,
  holdCardCues,
  type CardCueHold,
  type CardCues,
} from '@/lib/planning/cueState';
import { cueLineState } from '@/lib/planning/liveDraft';

// THINKING · DRAFTING · CHECKING (Task MOTIR-11254; design
// `design/ai-planning/design-notes.md` Part XXXI §31.1 and the two-read hold of
// §31.4), and EDITING · FIXING (MOTIR-11362). The derivation every surface reads,
// and the hold that keeps a card from blinking between reads.

const STORY = planReviewItem({ planItemId: 'pi_story', nodeId: 'pi_story', parentNodeId: null });
const A = planReviewItem({ planItemId: 'pi_a', nodeId: 'pi_a', parentNodeId: 'pi_story' });
const B = planReviewItem({ planItemId: 'pi_b', nodeId: 'pi_b', parentNodeId: 'pi_story' });
// A `modify` — its node is the committed work item, not the plan item.
const M = planReviewItem({ planItemId: 'pi_m', nodeId: 'wi_m', op: 'modify', parentNodeId: null });
const ITEMS = [STORY, A, B, M];

const step = (kind: InFlightStep['kind'], targetNodeId: string | null): InFlightStep => ({
  kind,
  targetNodeId,
});

function draft(planItemId: string, over: Partial<PlanItemDraftDto> = {}): PlanItemDraftDto {
  return {
    planItemId,
    sessionKey: `s-${planItemId}`,
    seq: 1,
    title: null,
    descriptionMd: null,
    explanationMd: null,
    updatedAt: '2026-11-14T10:00:00.000Z',
    ...over,
  };
}

const states = (cues: CardCues) => Object.fromEntries(cues.states);

describe('deriveCardCues — one read (§31.1)', () => {
  it('no steps → no cue at all', () => {
    expect(deriveCardCues(ITEMS, null, [draft('pi_a', { title: 'x' })])).toBe(NO_CARD_CUES);
    expect(deriveCardCues(ITEMS, [], [])).toBe(NO_CARD_CUES);
  });

  it('an author step with no draft is THINKING; with a draft carrying text it is DRAFTING', () => {
    const cues = deriveCardCues(
      ITEMS,
      [step('author', 'pi_a'), step('author', 'pi_b')],
      [draft('pi_b', { descriptionMd: '' })],
    );
    // An empty string counts as text begun; a level authored in parallel keeps each card's own state.
    expect(states(cues)).toEqual({ pi_a: 'thinking', pi_b: 'drafting' });
  });

  it('a draft whose three fields are all null is no draft', () => {
    const cues = deriveCardCues(ITEMS, [step('author', 'pi_a')], [draft('pi_a')]);
    expect(states(cues)).toEqual({ pi_a: 'thinking' });
  });

  it('a draft is matched to its card through the items — a modify draws on the work item node', () => {
    const cues = deriveCardCues(ITEMS, [step('author', 'wi_m')], [draft('pi_m', { title: 'T' })]);
    expect(states(cues)).toEqual({ wi_m: 'drafting' });
  });

  it('a draft with no author step on its card draws nothing', () => {
    const cues = deriveCardCues(ITEMS, [step('author', 'pi_a')], [draft('pi_b', { title: 'x' })]);
    expect(states(cues)).toEqual({ pi_a: 'thinking' });
  });

  it('the final check marks its card CHECKING; a lay, a repair with no start and an untargeted step mark nothing', () => {
    const cues = deriveCardCues(ITEMS, [
      step('check', 'pi_a'),
      step('lay', 'pi_story'),
      step('repair', null),
      step('author', null),
      step('settle', null),
    ]);
    expect(states(cues)).toEqual({ pi_a: 'checking' });
    expect(cues.containers.size).toBe(0);
  });

  it('a check on a card that holds proposals of its own is the CONTAINER review', () => {
    const cues = deriveCardCues(ITEMS, [step('check', 'pi_story')]);
    expect(states(cues)).toEqual({ pi_story: 'checking' });
    expect([...cues.containers]).toEqual(['pi_story']);
  });

  it('two steps on one card: Checking wins, then Drafting, then Thinking', () => {
    const drafted = [draft('pi_a', { title: 'x' })];
    expect(
      states(deriveCardCues(ITEMS, [step('author', 'pi_a'), step('check', 'pi_a')], drafted)),
    ).toEqual({ pi_a: 'checking' });
    expect(
      states(deriveCardCues(ITEMS, [step('check', 'pi_a'), step('author', 'pi_a')], drafted)),
    ).toEqual({ pi_a: 'checking' });
  });
});

describe('holdCardCues — the two-read hold (§31.4)', () => {
  const author = [step('author', 'pi_a')];
  const read = (prev: CardCueHold, drafts: PlanItemDraftDto[] | null, token: unknown = drafts) =>
    holdCardCues(prev, deriveCardCues(ITEMS, author, drafts), token);
  const shown = (h: CardCueHold) => h.cues.states.get('pi_a') ?? null;

  it('T1 → T2 → T3 → T4: Thinking, Drafting from the first draft, ONE empty read held, the second falls back', () => {
    let h = read(EMPTY_HOLD, []);
    expect(shown(h)).toBe('thinking');
    h = read(h, [draft('pi_a', { title: 'R' })]);
    expect(shown(h)).toBe('drafting');
    h = read(h, []); // one read with no draft — HELD
    expect(shown(h)).toBe('drafting');
    h = read(h, []); // the second in a row — back to Thinking
    expect(shown(h)).toBe('thinking');
    h = read(h, []); // and it stays there
    expect(shown(h)).toBe('thinking');
  });

  it('the hold resets as soon as a read carries the draft again', () => {
    let h = read(EMPTY_HOLD, [draft('pi_a', { title: 'R' })]);
    h = read(h, []);
    expect(shown(h)).toBe('drafting');
    h = read(h, [draft('pi_a', { title: 'Re' })]);
    expect(shown(h)).toBe('drafting');
    expect(h.misses.size).toBe(0);
    h = read(h, []); // a fresh single miss is held again
    expect(shown(h)).toBe('drafting');
  });

  it('a re-render that is NOT a new read (a dropped read, a stall, the clock) never advances the hold', () => {
    let h = read(EMPTY_HOLD, [draft('pi_a', { title: 'R' })]);
    const empty: PlanItemDraftDto[] = [];
    h = read(h, empty);
    expect(shown(h)).toBe('drafting');
    // Same token again and again: still the first miss.
    for (let i = 0; i < 5; i += 1) h = read(h, empty, empty);
    expect(shown(h)).toBe('drafting');
    expect(h.misses.get('pi_a')).toBe(1);
  });

  it('a first observation of a missing draft with no new token still counts as the held read', () => {
    let h = read(EMPTY_HOLD, [draft('pi_a', { title: 'R' })], 't1');
    h = read(h, [], 't1');
    expect(shown(h)).toBe('drafting');
    h = read(h, [], 't2');
    expect(shown(h)).toBe('thinking');
  });

  it('T5 wins: a step that ends takes the cue away at once, whatever is held', () => {
    let h = read(EMPTY_HOLD, [draft('pi_a', { title: 'R' })]);
    h = read(h, []);
    h = holdCardCues(h, deriveCardCues(ITEMS, [], []), {});
    expect(h.cues).toBe(NO_CARD_CUES);
    expect(h.misses.size).toBe(0);
  });

  it('nothing a reader sees changed → the SAME hold back, so a host can compare by reference', () => {
    const token = [draft('pi_a', { title: 'R' })];
    const h = read(EMPTY_HOLD, token);
    expect(read(h, token)).toBe(h);
    // A new read with the same picture keeps the cues and records the token.
    const token2 = [draft('pi_a', { title: 'Re' })];
    const h2 = read(h, token2);
    expect(h2).not.toBe(h);
    expect(h2.cues).toBe(h.cues);
    expect(h2.read).toBe(token2);
  });

  it('the container set follows the derivation', () => {
    const h = holdCardCues(EMPTY_HOLD, deriveCardCues(ITEMS, [step('check', 'pi_story')]), 1);
    expect([...h.cues.containers]).toEqual(['pi_story']);
    const h2 = holdCardCues(h, deriveCardCues(ITEMS, [step('check', 'pi_a')]), 2);
    expect(h2.cues.containers.size).toBe(0);
    expect(Object.fromEntries(h2.cues.states)).toEqual({ pi_a: 'checking' });
  });
});

// ── EDITING and FIXING (MOTIR-11362) ─────────────────────────────────────────
// The amend names the PARENT of the level it rewrites and the fix names no card,
// so each card past the amend's target is known by its last write against the
// step's start.

const STARTED = '2026-11-15T10:00:00.000Z';
const BEFORE = '2026-11-15T09:59:59.000Z';
const AFTER = '2026-11-15T10:00:05.000Z';
const timed = (
  kind: CueStep['kind'],
  targetNodeId: string | null,
  startedAt = STARTED,
): CueStep => ({
  kind,
  targetNodeId,
  startedAt,
});
// The story's level written before the step; one card of it rewritten after.
const OLD_A = planReviewItem({
  planItemId: 'pi_a',
  nodeId: 'pi_a',
  parentNodeId: 'pi_story',
  lastWrittenAt: BEFORE,
});
const NEW_B = planReviewItem({
  planItemId: 'pi_b',
  nodeId: 'pi_b',
  parentNodeId: 'pi_story',
  lastWrittenAt: AFTER,
});
const ROOT_NEW = planReviewItem({
  planItemId: 'pi_r',
  nodeId: 'pi_r',
  parentNodeId: null,
  lastWrittenAt: AFTER,
});
const STORY_OLD = planReviewItem({
  planItemId: 'pi_story',
  nodeId: 'pi_story',
  parentNodeId: null,
  lastWrittenAt: BEFORE,
});
const TIMED = [STORY_OLD, OLD_A, NEW_B, ROOT_NEW];

describe('deriveCardCues — Editing (the amend) and Fixing (the fix after the check)', () => {
  it('an amend with no write yet: its TARGET reads Editing from the first instant, nothing else does', () => {
    const items = [STORY_OLD, { ...OLD_A }, { ...NEW_B, lastWrittenAt: BEFORE }];
    expect(states(deriveCardCues(items, [timed('amend', 'pi_story')]))).toEqual({
      pi_story: 'editing',
    });
  });

  it('…and a card on the amended level reads Editing once the amend has written it', () => {
    const cues = deriveCardCues(TIMED, [timed('amend', 'pi_story')]);
    // pi_a was written before the step began; pi_r sits on another level.
    expect(states(cues)).toEqual({ pi_story: 'editing', pi_b: 'editing' });
    expect(cues.containers.size).toBe(0);
  });

  it('a write AT the step start counts; a step without a start marks only its target', () => {
    const atStart = [{ ...NEW_B, lastWrittenAt: STARTED }];
    expect(states(deriveCardCues(atStart, [timed('amend', 'pi_story')]))).toEqual({
      pi_story: 'editing',
      pi_b: 'editing',
    });
    expect(states(deriveCardCues(TIMED, [step('amend', 'pi_story')]))).toEqual({
      pi_story: 'editing',
    });
  });

  it('a top-level amend names no card: the top-level cards it has written read Editing', () => {
    expect(states(deriveCardCues(TIMED, [timed('amend', null)]))).toEqual({ pi_r: 'editing' });
  });

  it('a card with no write instant, or one that does not parse, is never written-since', () => {
    const items = [
      planReviewItem({ planItemId: 'pi_x', nodeId: 'pi_x', parentNodeId: null }),
      planReviewItem({
        planItemId: 'pi_y',
        nodeId: 'pi_y',
        parentNodeId: null,
        lastWrittenAt: 'not a date',
      }),
    ];
    expect(deriveCardCues(items, [timed('amend', null)])).toBe(NO_CARD_CUES);
    expect(deriveCardCues(items, [timed('repair', null, 'nope')])).toBe(NO_CARD_CUES);
  });

  it('during an amend no card it works on reads Thinking or Drafting — Editing wins', () => {
    const drafted = [draft('pi_b', { title: 'x' })];
    const cues = deriveCardCues(
      TIMED,
      [timed('author', 'pi_story'), timed('author', 'pi_b'), timed('amend', 'pi_story')],
      drafted,
    );
    expect(states(cues)).toEqual({ pi_story: 'editing', pi_b: 'editing' });
    // An author step on a card the amend has NOT written keeps its own state.
    expect(
      states(deriveCardCues(TIMED, [timed('amend', 'pi_story'), timed('author', 'pi_a')])),
    ).toEqual({ pi_story: 'editing', pi_b: 'editing', pi_a: 'thinking' });
  });

  it('the fix marks every card it has written, anywhere, Fixing — and only those', () => {
    expect(states(deriveCardCues(TIMED, [timed('repair', null)]))).toEqual({
      pi_b: 'fixing',
      pi_r: 'fixing',
    });
  });

  it('the latest stage shows: Fixing over Checking over Editing', () => {
    const cues = deriveCardCues(TIMED, [
      timed('amend', 'pi_story'),
      timed('check', 'pi_story'),
      timed('check', 'pi_b'),
      timed('repair', null),
    ]);
    expect(states(cues)).toEqual({ pi_story: 'checking', pi_b: 'fixing', pi_r: 'fixing' });
    // pi_story stays the container review; pi_b, taken over by the fix, is not one.
    expect([...cues.containers]).toEqual(['pi_story']);
  });

  it('a container check a later stage takes over leaves the container set', () => {
    const story = { ...STORY_OLD, lastWrittenAt: AFTER };
    const cues = deriveCardCues(
      [story, OLD_A],
      [timed('check', 'pi_story'), timed('repair', null)],
    );
    expect(states(cues)).toEqual({ pi_story: 'fixing' });
    expect(cues.containers.size).toBe(0);
  });

  it('the hold passes Editing and Fixing straight through, and drops them when the step closes', () => {
    let h = holdCardCues(EMPTY_HOLD, deriveCardCues(TIMED, [timed('amend', 'pi_story')]), 1);
    expect(Object.fromEntries(h.cues.states)).toEqual({ pi_story: 'editing', pi_b: 'editing' });
    h = holdCardCues(h, deriveCardCues(TIMED, [timed('repair', null)]), 2);
    expect(Object.fromEntries(h.cues.states)).toEqual({ pi_b: 'fixing', pi_r: 'fixing' });
    h = holdCardCues(h, deriveCardCues(TIMED, []), 3);
    expect(h.cues).toBe(NO_CARD_CUES);
  });

  it('the list rows and the peek both carry them — neither is a container review', () => {
    const { rows, peek } = cuesByProposal(
      TIMED,
      deriveCardCues(TIMED, [timed('amend', 'pi_story')]),
    );
    expect(Object.fromEntries(rows)).toEqual({ pi_story: 'editing', pi_b: 'editing' });
    expect(Object.fromEntries(peek)).toEqual({ pi_story: 'editing', pi_b: 'editing' });
  });
});

describe('cuesByProposal — what the list row and the quick view look up', () => {
  it('maps node → plan item; the list leaves the container review out, the peek keeps it', () => {
    const cues = deriveCardCues(
      ITEMS,
      [step('check', 'pi_story'), step('author', 'wi_m')],
      [draft('pi_m', { title: 'T' })],
    );
    const { rows, peek } = cuesByProposal(ITEMS, cues);
    expect(Object.fromEntries(rows)).toEqual({ pi_m: 'drafting' });
    expect(Object.fromEntries(peek)).toEqual({ pi_story: 'checking', pi_m: 'drafting' });
  });

  it('no cues → two empty maps', () => {
    const { rows, peek } = cuesByProposal(ITEMS, NO_CARD_CUES);
    expect(rows.size + peek.size).toBe(0);
  });
});

describe('cueLineState — the quick view header cue (§31.7)', () => {
  it('Checking first, Thinking only over the writing state, else the shipped state', () => {
    expect(cueLineState('idle', 'checking')).toBe('checking');
    expect(cueLineState('written', 'checking')).toBe('checking');
    expect(cueLineState('writing', 'thinking')).toBe('thinking');
    expect(cueLineState('writing', 'drafting')).toBe('writing');
    expect(cueLineState('writing', null)).toBe('writing');
    expect(cueLineState('written', 'thinking')).toBe('written');
    expect(cueLineState('idle', undefined)).toBe('idle');
  });

  it('Editing and Fixing win over every shipped state, like Checking (MOTIR-11362)', () => {
    for (const shipped of ['idle', 'writing', 'written'] as const) {
      expect(cueLineState(shipped, 'editing')).toBe('editing');
      expect(cueLineState(shipped, 'fixing')).toBe('fixing');
    }
  });
});
