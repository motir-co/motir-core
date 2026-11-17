// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanActRecord, actLine, runningBarLine } from '@/components/planning/PlanActRecord';
import {
  applyPlanFrame,
  narrateFrame,
  type PlanChangeProgress,
} from '@/lib/hooks/usePlanChangeConversation';
import { FRAME_DISPOSITIONS, isKnownFrameKind } from '@/lib/planning/planChangeFrames';
import {
  FACT_KEYS,
  UNKNOWN_FACT_KEY,
  factLine,
  readProgressFact,
} from '@/lib/planning/progressFacts';
import { locales } from '@/lib/i18n/locales';

// THE CODE-WRITTEN RAIL LINES, AS FACTS (MOTIR-11296). motir-ai sends WHAT happened
// — `{ fact, code, ref, params }` on a `progress_fact` frame — and the line is this
// catalogue's, in the reader's locale. This suite renders EVERY fact and code motir-ai
// sends, in English and in every other locale, and fails when a locale file is
// missing one of its keys.

const NS = 'planningWorkspace.conversation';
const A = 'motir-co/motir-ai';
const B = 'motir-co/motir-core';
const C = 'motir-co/motir-infra';
const HASH = '00d5433a35dbdd3e7c0ad0df6b07ac89f3518be0b39a279ce1dd840fb106076b';

type Messages = Record<string, unknown>;

function readJson(rel: string): Messages {
  return JSON.parse(readFileSync(path.resolve(__dirname, '../../', rel), 'utf8')) as Messages;
}

const catalogue = (locale: string) => readJson(`messages/${locale}.json`);

function at(messages: Messages, dotted: string): unknown {
  return dotted
    .split('.')
    .reduce<unknown>((node, part) => (node as Messages | undefined)?.[part], messages);
}

/** A translator over one locale's raw catalogue that THROWS on a missing key. */
function translatorFor(locale: string) {
  return createTranslator({
    locale,
    messages: catalogue(locale),
    namespace: NS,
    onError: (error) => {
      throw error;
    },
  }) as unknown as Parameters<typeof actLine>[1];
}

/** Names a work type in one locale, as the rail's `useTypeLabel` does. */
function typeLabelFor(locale: string) {
  const tt = createTranslator({
    locale,
    messages: catalogue(locale),
    namespace: 'labels.workItemType',
  });
  return (type: string) => (tt.has(type as never) ? tt(type as never) : type);
}

/** A fact frame's data, as motir-ai sends it. */
const wire = (fact: string, code: string, params: Record<string, unknown> = {}) => ({
  fact,
  code,
  ref: 'planItem:x',
  params,
});

/** The parameters a code's line needs, filled with fixture values. */
const PARAMS = {
  count: 3,
  title: 'Publish the export layer',
  summary: 'Names src/gone.ts, which does not exist.',
  refreshes: [A, B, C].map((ref) => ({ ref, previousSha: 'f'.repeat(64), currentSha: HASH })),
  type: 'design',
  blocker: 'planItem:a',
  reason: 'reads the token the first card stores',
};

/** Every (fact, code) pair the closed set lists. */
const ALL = Object.entries(FACT_KEYS).flatMap(([fact, codes]) =>
  Object.keys(codes).map((code) => [fact, code] as const),
);

const asAct = (data: unknown): PlanChangeProgress => {
  const act = narrateFrame('progress_fact', data);
  if (act === null) throw new Error('a progress_fact frame must narrate');
  return act;
};

afterEach(cleanup);

describe('the frame', () => {
  it('is a kind core has decided about, and it is SHOWN', () => {
    expect(isKnownFrameKind('progress_fact')).toBe(true);
    expect(FRAME_DISPOSITIONS.progress_fact).toEqual({ show: 'fact' });
  });

  it('narrates to the fact, keeping counts, titles, summaries and repos — never a hash', () => {
    expect(asAct(wire('code_graph_refreshed', 'refreshed', PARAMS))).toEqual({
      kind: 'fact',
      fact: {
        fact: 'code_graph_refreshed',
        code: 'refreshed',
        ref: 'planItem:x',
        count: 3,
        title: 'Publish the export layer',
        summary: 'Names src/gone.ts, which does not exist.',
        repos: [A, B, C],
        type: 'design',
        blocker: 'planItem:a',
        reason: 'reads the token the first card stores',
      },
    });
    expect(JSON.stringify(asAct(wire('code_graph_refreshed', 'refreshed', PARAMS)))).not.toContain(
      HASH,
    );
  });

  it('reads a malformed frame loosely and still narrates it', () => {
    expect(readProgressFact(undefined)).toEqual({
      fact: '',
      code: '',
      ref: null,
      count: null,
      title: null,
      summary: null,
      repos: [],
      type: null,
      blocker: null,
      reason: null,
    });
    expect(
      readProgressFact({
        fact: ' dry_run ',
        code: 'checking',
        params: {
          count: Number.NaN,
          title: '  ',
          refreshes: [{ ref: ` ${A} ` }, { ref: 7 }, null],
        },
      }),
    ).toEqual({
      fact: 'dry_run',
      code: 'checking',
      ref: null,
      count: null,
      title: null,
      summary: null,
      repos: [A],
      type: null,
      blocker: null,
      reason: null,
    });
    expect(readProgressFact({ fact: 'x', code: 'y', params: 'not an object' }).repos).toEqual([]);
    expect(readProgressFact({ params: { refreshes: 'motir-co/motir-ai' } }).repos).toEqual([]);
  });
});

describe('every key, in every locale file', () => {
  const keys = [
    `fact.${UNKNOWN_FACT_KEY}`,
    ...ALL.map(([fact, code]) => `fact.${FACT_KEYS[fact]![code]!.key}`),
  ];

  for (const locale of locales) {
    it(`${locale}: messages/${locale}.json holds every fact key`, () => {
      const messages = catalogue(locale);
      const missing = keys.filter((k) => typeof at(messages, `${NS}.${k}`) !== 'string');
      expect(missing).toEqual([]);
    });
    if (locale === 'en') continue;
    it(`${locale}: messages/sources/${locale}.json records the English of every fact key`, () => {
      const record = readJson(`messages/sources/${locale}.json`);
      const en = catalogue('en');
      const unrecorded = keys.filter((k) => record[`${NS}.${k}`] !== at(en, `${NS}.${k}`));
      expect(unrecorded).toEqual([]);
    });
  }
});

describe('the line, in English: what the rail said before the words moved', () => {
  const tc = translatorFor('en');
  const line = (fact: string, code: string, params: Record<string, unknown> = {}) =>
    actLine(asAct(wire(fact, code, params)), tc, 'en');

  it('the claim check and its settle say they run, and how they ended', () => {
    expect(line('claim_check', 'started', { count: 11 })).toBe(
      'Checking the code names of 11 items',
    );
    expect(line('claim_check', 'started', { count: 1 })).toBe('Checking the code names of 1 item');
    expect(line('claim_check', 'sent_back', { count: 3 })).toBe(
      "3 items' code names did not hold; sending them back",
    );
    expect(line('claim_check', 'held', { count: 0 })).toBe("Every item's code names hold");
    expect(line('claim_check', 'settle_started', { count: 2 })).toBe(
      'Checking the code names of 2 items again against the whole plan',
    );
    expect(line('claim_check', 'settle_held', { count: 0 })).toBe(
      "Every item's code names hold against the whole plan",
    );
    expect(line('claim_check', 'settle_unresolved', { count: 1 })).toBe(
      "1 item's code names still do not hold; it is reported in the plan",
    );
  });

  it('each card checked has its own line, a clean card with 0 included (MOTIR-11494)', () => {
    const three = line('claim_check', 'card_checked', {
      title: 'Publish the export layer',
      count: 3,
    });
    expect(three).toBe('Checked Publish the export layer — 3 issues');
    expect(three).not.toBe(tc(`fact.${UNKNOWN_FACT_KEY}`));
    expect(
      line('claim_check', 'card_checked', { title: 'Publish the export layer', count: 1 }),
    ).toBe('Checked Publish the export layer — 1 issue');
    // A clean card sends a zero, and zero is PRESENT: the card keeps its line.
    expect(
      line('claim_check', 'card_checked', { title: 'Publish the export layer', count: 0 }),
    ).toBe('Checked Publish the export layer — 0 issues');
    // A frame missing either parameter is the generic line, as for every code.
    expect(line('claim_check', 'card_checked', { count: 2 })).toBe('Working on the plan…');
    expect(line('claim_check', 'card_checked', { title: 'Publish the export layer' })).toBe(
      'Working on the plan…',
    );
  });

  it('the final check, its repair and the re-open say what they said, around the data', () => {
    expect(line('dry_run', 'started')).toBe('Starting the final check of the plan');
    expect(line('dry_run', 'skipped_turned_off')).toBe(
      'Skipped the final check of the plan: it is turned off for this project',
    );
    expect(line('dry_run', 'checking', { title: 'Card s1' })).toBe('Checking and fixing “Card s1”');
    expect(line('dry_run', 'container_found', { title: 'Card s1', count: 2 })).toBe(
      'Found 2 issues in “Card s1”',
    );
    expect(line('dry_run', 'container_found', { title: 'Card s1', count: 1 })).toBe(
      'Found 1 issue in “Card s1”',
    );
    expect(line('dry_run', 'finding', { summary: 'Finding 1.' })).toBe('Issue: Finding 1.');
    expect(line('dry_run_repair', 'retrying')).toBe(
      'The fixes stopped part-way, trying them once more…',
    );
    expect(line('dry_run_repair', 'not_fixed_committed_in_progress', { summary: 'F.' })).toBe(
      'Not fixed: F. (the item is already being worked on)',
    );
    expect(line('validity_reopen', 'started_again')).toBe(
      "Re-checking the plan's links and order once more",
    );
    expect(line('validity_reopen', 'card_removed', { title: 'Compaction' })).toBe(
      'Removed “Compaction”',
    );
  });

  it('a refresh of one repository keeps the singular sentence; several are one line', () => {
    const refreshes = (...refs: string[]) => ({
      refreshes: refs.map((ref) => ({ ref, previousSha: 'a', currentSha: HASH })),
    });
    expect(line('code_graph_refreshed', 'refreshed', refreshes(A))).toBe(
      `Your code graph for ${A} was refreshed since the last turn. Earlier answers used the previous graph.`,
    );
    expect(line('code_graph_refreshed', 'refreshed', refreshes(A, B, C))).toBe(
      `Code graphs for ${A}, ${B}, and ${C} were refreshed since the last turn. Earlier answers used the previous graphs.`,
    );
    expect(line('code_graph_refreshed', 'refreshed', refreshes(A, B))).not.toMatch(/[0-9a-f]{7,}/);
  });

  it('a fact or code it does not know, or a line missing its data, is the generic line — never dropped', () => {
    expect(line('a_new_stage', 'started')).toBe('Working on the plan…');
    expect(line('dry_run', 'a_new_code')).toBe('Working on the plan…');
    expect(line('dry_run', 'checking')).toBe('Working on the plan…');
    expect(line('claim_check', 'started')).toBe('Working on the plan…');
    expect(line('code_graph_refreshed', 'refreshed')).toBe('Working on the plan…');
    expect(actLine(asAct(undefined), tc, 'en')).toBe('Working on the plan…');
  });

  it('the running bar repeats the same line', () => {
    const acts = [asAct(wire('dry_run', 'started'))];
    expect(runningBarLine(acts, tc, 'en')).toBe('Starting the final check of the plan');
  });
});

// MOTIR-11489 · MOTIR-11491 — the final check is ONE step that checks and fixes each
// card. Its findings' outcomes ride the `dry_run` fact, a card whose upstream changed
// is checked again as a line under the same step, and `dry_run_repair` is kept only so
// an older stored plan reads as before.
describe('the final check as one check & fix step', () => {
  const tc = translatorFor('en');
  const line = (fact: string, code: string, params: Record<string, unknown> = {}) =>
    actLine(asAct(wire(fact, code, params)), tc, 'en');
  const OUTCOMES = Object.keys(FACT_KEYS.dry_run_repair!).filter(
    (c) => c === 'finding_fixed' || c.startsWith('not_fixed_'),
  );

  it('words every outcome the repair worded on the dry_run fact, and the other-card report', () => {
    expect(OUTCOMES.length).toBeGreaterThanOrEqual(8);
    for (const code of [...OUTCOMES, 'not_fixed_other_card']) {
      expect(FACT_KEYS.dry_run![code], code).toBeDefined();
      expect(FACT_KEYS.dry_run![code]!.needs).toEqual(['summary']);
    }
    expect(line('dry_run', 'finding_fixed', { summary: 'F.' })).toBe('Fixed: F.');
    expect(line('dry_run', 'not_fixed_other_card', { summary: 'F.' })).toBe(
      'Not fixed: F. (the fix belongs on another item)',
    );
    expect(line('dry_run', 'not_fixed_skipped', { summary: 'F.' })).toBe(
      'Not fixed: F. (the final check was skipped before the fix)',
    );
  });

  for (const locale of locales) {
    it(`${locale}: each outcome on dry_run reads as the repair's own line, never the generic one`, () => {
      const t = translatorFor(locale);
      const said = (fact: string, code: string) =>
        actLine(asAct(wire(fact, code, { summary: PARAMS.summary })), t, locale);
      for (const code of OUTCOMES) {
        expect(said('dry_run', code), `${locale} ${code}`).toBe(said('dry_run_repair', code));
      }
      for (const code of [...OUTCOMES, 'not_fixed_other_card']) {
        const text = said('dry_run', code);
        expect(text, `${locale} ${code}`).not.toBe(t(`fact.${UNKNOWN_FACT_KEY}`));
        expect(text).toContain(PARAMS.summary);
      }
    });
  }

  it('a recheck names the card and the card whose change sent it back; without the upstream it is the generic line', () => {
    expect(line('dry_run', 'rechecking', { blocker: 'Card a', title: 'Card x' })).toBe(
      'Checking “Card x” again: “Card a” changed what it delivers',
    );
    expect(line('dry_run', 'rechecking', { title: 'Card x' })).toBe('Working on the plan…');
    expect(line('dry_run', 'rechecking', { blocker: 'Card a' })).toBe('Working on the plan…');
  });

  /** The rail a run's frames draw, as the hook folds them. */
  function railOf(frames: readonly [string, unknown][]) {
    const acts = frames.reduce((state, [event, data]) => applyPlanFrame(state, event, data), {
      progress: null,
      acts: [],
    } as Parameters<typeof applyPlanFrame>[0]).acts;
    renderWithIntl(<PlanActRecord acts={acts} streaming={false} />);
    const rows = Array.from(
      screen.getByTestId('plan-change-acts').querySelectorAll('[data-testid^="plan-change-act-"]'),
    );
    return {
      acts,
      labels: rows.map((r) => r.querySelector('.font-mono')?.textContent),
      lines: rows.map((r) => r.textContent ?? ''),
    };
  }
  const fact = (fact: string, code: string, params: Record<string, unknown> = {}) =>
    ['progress_fact', { fact, code, ref: 'planItem:b1', params }] as [string, unknown];

  it('a check followed by its card, its recheck and its outcome draws ONE check & fix act, the rest as lines', () => {
    const rail = railOf([
      ['check', {}],
      fact('dry_run', 'checking', { title: 'Card b1' }),
      fact('dry_run', 'rechecking', { title: 'Card b1', blocker: 'Card a1' }),
      fact('dry_run', 'finding_fixed', { summary: 'F.' }),
    ]);
    expect(rail.acts.map((a) => a.kind)).toEqual(['checking', 'fact', 'fact', 'fact']);
    expect(rail.labels.filter((l) => l === 'check & fix')).toHaveLength(1);
    expect(rail.labels).not.toContain('fix');
    expect(rail.lines[0]).toContain('Running the final check');
    expect(rail.lines[1]).toContain('Checking and fixing “Card b1”');
    expect(rail.lines[2]).toContain('Checking “Card b1” again: “Card a1” changed what it delivers');
    expect(rail.lines[3]).toContain('Fixed: F.');
  });

  it('the validity re-open still draws its fix act, worded as the plan’s links and order', () => {
    const rail = railOf([fact('validity_reopen', 'started'), ['repair', {}], ['check', {}]]);
    expect(rail.labels).toEqual(['note', 'fix', 'check & fix']);
    expect(rail.lines[1]).toContain("Fixing the plan's links and order");
    expect(rail.lines[1]).not.toMatch(/final check/i);
  });

  it('an older stored plan, with its repair frame and dry_run_repair facts, reads as it always did', () => {
    const rail = railOf([
      ['check', {}],
      fact('dry_run', 'finding', { summary: 'F.' }),
      ['repair', {}],
      fact('dry_run_repair', 'started'),
      fact('dry_run_repair', 'finding_fixed', { summary: 'F.' }),
      fact('dry_run_repair', 'not_fixed_sizing', { summary: 'G.' }),
    ]);
    expect(rail.labels).toEqual(['check & fix', 'note', 'fix', 'note', 'note', 'note']);
    expect(rail.lines.slice(3)).toEqual([
      expect.stringContaining('Fixing the findings…'),
      expect.stringContaining('Fixed: F.'),
      expect.stringContaining('Not fixed: G. (it is about how the work is sized)'),
    ]);
    expect(rail.lines.join('\n')).not.toContain('Working on the plan…');
  });
});

describe('the walk-written lines (MOTIR-11338): a typeless card settled, an edge explained', () => {
  const tc = translatorFor('en');
  const line = (fact: string, code: string, params: Record<string, unknown> = {}) =>
    actLine(asAct({ fact, code, ref: 'ACME-7', params }), tc, 'en', typeLabelFor('en'));

  it('says in English what the rail said as a note before, with the type named', () => {
    expect(line('author', 'typed', { type: 'code' })).toBe(
      'ACME-7 had no type, so I gave it the type “Code” before writing it.',
    );
    expect(line('author', 'made_story')).toBe(
      'ACME-7 had no type and no single type fits its work, so I am making it a story and writing it as one.',
    );
    expect(line('edge', 'explained', { blocker: 'ACME-6', reason: 'reads the stored token' })).toBe(
      'ACME-7 waits on ACME-6 — reads the stored token',
    );
  });

  it('names the type in the reader’s language, and an id no catalogue lists as sent', () => {
    const de = actLine(
      asAct({ fact: 'author', code: 'typed', ref: 'ACME-7', params: { type: 'decision' } }),
      translatorFor('de'),
      'de',
      typeLabelFor('de'),
    );
    expect(de).toContain('„Entscheidung“');
    expect(line('author', 'typed', { type: 'a_new_type' })).toContain('“a_new_type”');
    // With no namer the id is drawn rather than nothing.
    expect(
      actLine(
        asAct({ fact: 'author', code: 'typed', ref: 'ACME-7', params: { type: 'code' } }),
        tc,
        'en',
      ),
    ).toContain('“code”');
  });

  it('a line missing its card, type, blocker or reason is the generic line', () => {
    const generic = 'Working on the plan…';
    expect(actLine(asAct({ fact: 'author', code: 'made_story', params: {} }), tc, 'en')).toBe(
      generic,
    );
    expect(line('author', 'typed')).toBe(generic);
    expect(line('edge', 'explained', { blocker: 'ACME-6' })).toBe(generic);
    expect(line('edge', 'explained', { reason: 'x' })).toBe(generic);
  });

  it('the rail row names the type through the catalogue', () => {
    renderWithIntl(
      <PlanActRecord
        acts={[asAct({ fact: 'author', code: 'typed', ref: 'ACME-7', params: { type: 'design' } })]}
        streaming={false}
      />,
    );
    expect(screen.getByTestId('plan-change-act-fact').textContent).toContain(
      'ACME-7 had no type, so I gave it the type “Design” before writing it.',
    );
  });
});

describe('every fact and code, in every locale', () => {
  for (const locale of locales) {
    it(`${locale}: each line is a real, interpolated translation — data kept as sent`, () => {
      const tc = translatorFor(locale);
      const en = translatorFor('en');
      for (const [fact, code] of ALL) {
        const act = asAct(wire(fact, code, PARAMS));
        const said = actLine(act, tc, locale, typeLabelFor(locale));
        expect(said, `${locale} ${fact}.${code}`).not.toMatch(/[{}]|undefined|fact\./);
        expect(said, `${locale} ${fact}.${code} is the generic line`).not.toBe(
          tc(`fact.${UNKNOWN_FACT_KEY}`),
        );
        const needs = FACT_KEYS[fact]![code]!.needs;
        if (needs.includes('title')) expect(said).toContain(PARAMS.title);
        if (needs.includes('summary')) expect(said).toContain(PARAMS.summary);
        if (needs.includes('ref')) expect(said).toContain('planItem:x');
        if (needs.includes('blocker')) expect(said).toContain(PARAMS.blocker);
        if (needs.includes('reason')) expect(said).toContain(PARAMS.reason);
        if (needs.includes('type'))
          expect(said, `${locale} names the type in its own language`).toContain(
            typeLabelFor(locale)('design'),
          );
        if (needs.includes('repos'))
          expect(said).toContain(
            new Intl.ListFormat(locale, { type: 'conjunction' }).format([A, B, C]),
          );
        expect(said).not.toContain(HASH);
        if (locale !== 'en')
          expect(said, `${locale} ${fact}.${code} reads as English`).not.toBe(
            actLine(act, en, 'en'),
          );
      }
      expect(factLine(readProgressFact({}), tc, locale)).toBe(tc(`fact.${UNKNOWN_FACT_KEY}`));
    });
  }
});

describe('the act record row', () => {
  it('draws one row with the note label and the catalogue line, and announces it', () => {
    renderWithIntl(
      <PlanActRecord
        acts={[asAct(wire('claim_check', 'started', { count: 11 }))]}
        streaming={false}
      />,
    );
    const row = screen.getByTestId('plan-change-act-fact');
    expect(row.querySelector('.font-mono')?.textContent).toBe('note');
    expect(row.textContent).toContain('Checking the code names of 11 items');
    expect(screen.getByTestId('plan-change-announcer').textContent).toContain(
      'Checking the code names of 11 items',
    );
  });

  it('draws the reader’s language', () => {
    renderWithIntl(<PlanActRecord acts={[asAct(wire('dry_run', 'started'))]} streaming={false} />, {
      locale: 'de',
      messages: catalogue('de'),
    });
    expect(screen.getByTestId('plan-change-act-fact').textContent).toContain(
      'Die Abschlussprüfung des Plans beginnt',
    );
  });
});
