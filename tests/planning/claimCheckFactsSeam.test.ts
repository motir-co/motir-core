// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import { narrateFrame } from '@/lib/hooks/usePlanChangeConversation';
import { UNKNOWN_FACT_KEY, factLine, readProgressFact } from '@/lib/planning/progressFacts';
import { locales } from '@/lib/i18n/locales';

// THE CLAIM-CHECK SEAM, motir-ai → motir-core (MOTIR-11543, story MOTIR-11494).
//
// motir-core's facts suite builds its payloads from `FACT_KEYS`, and motir-ai's from its
// own builders, so a code one side sends and the other cannot word is invisible to both.
// This suite holds what motir-ai ACTUALLY emits for the claim check and feeds it through
// the two readers the rail uses — `readProgressFact`, then `factLine` — in every locale.
//
// THE SAMPLE IS A SNAPSHOT, REFRESHED BY HAND. It was read from motir-co/motir-ai at
// ac5ec079 (branch parent/MOTIR-11494-send-back-rule), `src/llm/progressFacts.ts`:
// `claimCheckStarted`, `claimCardChecked`, `claimCheckEnded`, `claimSettleStarted` and
// `claimSettleEnded`. motir-core publishes a generated contract for frame KINDS only, and
// none for fact codes; `lib/planning/planChangeFrames.ts` records what a checked-in copy
// nobody refreshed cost once (MOTIR-10427). When motir-ai adds or renames a claim-check
// code, copy its payload in here.

const NS = 'planningWorkspace.conversation';
const TITLE = 'Publish the export layer';

type Messages = Record<string, unknown>;

const catalogue = (locale: string): Messages =>
  JSON.parse(
    readFileSync(path.resolve(__dirname, '../../messages', `${locale}.json`), 'utf8'),
  ) as Messages;

/** A translator over one locale's raw catalogue that THROWS on a missing key or parameter. */
function translatorFor(locale: string) {
  return createTranslator({
    locale,
    messages: catalogue(locale),
    namespace: NS,
    onError: (error) => {
      throw error;
    },
  }) as unknown as Parameters<typeof factLine>[1];
}

/** One sent-back card's findings, as `claimCheckEnded` carries them on `sent_back`. */
const SENT_BACK_CARDS = [
  {
    ref: 'planItem:gone',
    findings: [
      {
        kind: 'path_missing',
        path: 'lib/gone/file.ts',
        detail: '`lib/gone/file.ts` is not on origin/main in `motir-core`.',
      },
      {
        kind: 'unlisted',
        path: 'ghostClaimHelper',
        detail: '`ghostClaimHelper` is in the body, and the check could not show it exists.',
        unproven: true,
      },
    ],
  },
];

/** Every claim-check payload motir-ai emits — the snapshot. */
const SAMPLE = {
  started: { fact: 'claim_check', code: 'started', ref: null, params: { count: 3 } },
  card_checked: {
    fact: 'claim_check',
    code: 'card_checked',
    ref: 'planItem:a',
    params: { title: TITLE, count: 3 },
  },
  held: { fact: 'claim_check', code: 'held', ref: null, params: { count: 0 } },
  sent_back: {
    fact: 'claim_check',
    code: 'sent_back',
    ref: null,
    params: { count: 1, cards: SENT_BACK_CARDS },
  },
  settle_started: { fact: 'claim_check', code: 'settle_started', ref: null, params: { count: 2 } },
  settle_held: { fact: 'claim_check', code: 'settle_held', ref: null, params: { count: 0 } },
  settle_unresolved: {
    fact: 'claim_check',
    code: 'settle_unresolved',
    ref: null,
    params: { count: 1 },
  },
} as const;

/** The catalogue key each sampled code must word as. */
const KEY_OF: Record<keyof typeof SAMPLE, string> = {
  started: 'claimCheck.started',
  card_checked: 'claimCheck.cardChecked',
  held: 'claimCheck.held',
  sent_back: 'claimCheck.sentBack',
  settle_started: 'claimCheck.settleStarted',
  settle_held: 'claimCheck.settleHeld',
  settle_unresolved: 'claimCheck.settleUnresolved',
};

const CODES = Object.keys(SAMPLE) as (keyof typeof SAMPLE)[];

const say = (payload: unknown, locale: string) =>
  factLine(readProgressFact(payload), translatorFor(locale), locale);

const generic = (locale: string) => translatorFor(locale)(`fact.${UNKNOWN_FACT_KEY}`);

/** What the rendered text must never carry: a finding, a sent-back ref, or a template leak. */
function expectClean(said: string, what: string) {
  for (const card of SENT_BACK_CARDS) {
    expect(said, `${what} names a sent-back ref`).not.toContain(card.ref);
    for (const f of card.findings) {
      expect(said, `${what} names a finding kind`).not.toContain(f.kind);
      expect(said, `${what} names a finding name`).not.toContain(f.path);
      expect(said, `${what} carries a finding sentence`).not.toContain(f.detail);
    }
  }
  expect(said, `${what} leaks a template`).not.toMatch(/[{}]|undefined|claimCheck\.|fact\./);
}

describe('every claim-check code motir-ai sends, in every locale', () => {
  for (const locale of locales) {
    it(`${locale}: each sampled payload words as its catalogued line, never the generic one`, () => {
      const tc = translatorFor(locale);
      for (const code of CODES) {
        const payload = SAMPLE[code];
        const said = say(payload, locale);
        const params = { ...payload.params } as Record<string, unknown>;
        delete params.cards;
        expect(said, `${locale} ${code}`).toBe(tc(`fact.${KEY_OF[code]}`, params as never));
        expect(said, `${locale} ${code} is the generic line`).not.toBe(generic(locale));
        if (locale !== 'en')
          expect(said, `${locale} ${code} reads as English`).not.toBe(say(payload, 'en'));
        expectClean(said, `${locale} ${code}`);
      }
    });
  }
});

describe('the per-card line', () => {
  it('names the card and its count, in English', () => {
    expect(say(SAMPLE.card_checked, 'en')).toBe(`Checked ${TITLE} — 3 issues`);
  });

  it('a clean card sends 0 and still gets its line, in every locale', () => {
    const clean = { ...SAMPLE.card_checked, params: { title: TITLE, count: 0 } };
    expect(say(clean, 'en')).toBe(`Checked ${TITLE} — 0 issues`);
    for (const locale of locales) {
      const said = say(clean, locale);
      expect(said, locale).not.toBe(generic(locale));
      expect(said, locale).toContain(TITLE);
      expect(said, locale).toContain('0');
      expectClean(said, `${locale} clean`);
    }
  });

  it('a blank or missing title is the generic line — why motir-ai sends the ref instead', () => {
    for (const title of ['', '   ', undefined]) {
      const payload = { ...SAMPLE.card_checked, params: { title, count: 2 } };
      expect(say(payload, 'en')).toBe(generic('en'));
    }
  });

  it('extra parameters beside title and count change nothing and reach no text', () => {
    const extra = {
      ...SAMPLE.card_checked,
      params: {
        title: TITLE,
        count: 3,
        cards: SENT_BACK_CARDS,
        nested: { kind: 'symbol_missing', path: 'lib/gone/file.ts' },
        note: 'ghostClaimHelper',
      },
    };
    for (const locale of locales) {
      const said = say(extra, locale);
      expect(said, locale).toBe(say(SAMPLE.card_checked, locale));
      expectClean(said, `${locale} extra`);
    }
  });
});

describe('the send-back line, with the findings beside its count', () => {
  it('keeps its count line in every locale', () => {
    expect(say(SAMPLE.sent_back, 'en')).toBe("1 item's code names did not hold; sending it back");
    for (const locale of locales) {
      const tc = translatorFor(locale);
      const said = say(SAMPLE.sent_back, locale);
      expect(said, locale).toBe(tc('fact.claimCheck.sentBack', { count: 1 } as never));
      expectClean(said, `${locale} sent_back`);
    }
  });

  it('a sent_back that lost its count is the generic line — the regression this guards', () => {
    const lost = { ...SAMPLE.sent_back, params: { cards: SENT_BACK_CARDS } };
    for (const locale of locales) expect(say(lost, locale), locale).toBe(generic(locale));
  });
});

describe('the frame', () => {
  it('every sampled payload narrates as a fact act carrying the read fact', () => {
    for (const code of CODES) {
      const act = narrateFrame('progress_fact', SAMPLE[code]);
      expect(act, code).toEqual({ kind: 'fact', fact: readProgressFact(SAMPLE[code]) });
    }
  });
});
