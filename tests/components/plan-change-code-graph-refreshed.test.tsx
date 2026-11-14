// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanActRecord, actLine, runningBarLine } from '@/components/planning/PlanActRecord';
import { narrateFrame } from '@/lib/hooks/usePlanChangeConversation';
import type { PlanChangeProgress } from '@/lib/hooks/usePlanChangeConversation';
import { FRAME_DISPOSITIONS, isKnownFrameKind } from '@/lib/planning/planChangeFrames';
import { locales } from '@/lib/i18n/locales';

// THE CODE-GRAPH REFRESH LINE (MOTIR-11293). motir-ai sends ONE
// `code_graph_refreshed` frame per turn carrying facts only —
// `{ refreshes: [{ ref, previousSha, currentSha }] }` — and the line the person
// reads is this catalogue's, in their locale: ICU's plural on the count, the
// names joined by the locale's own list rules, the hashes never shown.

const A = 'motir-co/motir-ai';
const B = 'motir-co/motir-core';
const C = 'motir-co/motir-infra';
const HASH = '00d5433a35dbdd3e7c0ad0df6b07ac89f3518be0b39a279ce1dd840fb106076b';

const frame = (...refs: string[]) => ({
  refreshes: refs.map((ref) => ({ ref, previousSha: 'f'.repeat(64), currentSha: HASH })),
});

function catalogue(locale: string): Record<string, unknown> {
  const file = path.resolve(__dirname, `../../messages/${locale}.json`);
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function translatorFor(locale: string) {
  return createTranslator({
    locale,
    messages: catalogue(locale),
    namespace: 'planningWorkspace.conversation',
  }) as unknown as Parameters<typeof actLine>[1];
}

afterEach(cleanup);

describe('the frame', () => {
  it('is a kind core has decided about, and it is SHOWN', () => {
    expect(isKnownFrameKind('code_graph_refreshed')).toBe(true);
    expect(FRAME_DISPOSITIONS.code_graph_refreshed).toEqual({ show: 'codeGraphRefreshed' });
  });

  it('narrates to the list of repositories, in the order sent, and keeps no hash', () => {
    expect(narrateFrame('code_graph_refreshed', frame(A, B, C))).toEqual({
      kind: 'codeGraphRefreshed',
      repos: [A, B, C],
    });
  });

  it('skips an entry with no usable ref, and draws nothing when none is left', () => {
    expect(
      narrateFrame('code_graph_refreshed', {
        refreshes: [{ ref: ` ${A} ` }, { ref: '' }, { ref: 7 }, null, { previousSha: 'x' }],
      }),
    ).toEqual({ kind: 'codeGraphRefreshed', repos: [A] });
    expect(narrateFrame('code_graph_refreshed', { refreshes: [] })).toBeNull();
    expect(narrateFrame('code_graph_refreshed', { refreshes: 'motir-co/motir-ai' })).toBeNull();
    expect(narrateFrame('code_graph_refreshed', undefined)).toBeNull();
  });
});

describe('the line, in English', () => {
  const tc = translatorFor('en');

  it('one repository keeps the singular wording', () => {
    expect(actLine({ kind: 'codeGraphRefreshed', repos: [A] }, tc, 'en')).toBe(
      `Your code graph for ${A} was refreshed since the last turn. Earlier answers used the previous graph.`,
    );
  });

  it('several are ONE line naming them all, joined by the locale', () => {
    const expected = new Intl.ListFormat('en', { type: 'conjunction' }).format([A, B, C]);
    expect(actLine({ kind: 'codeGraphRefreshed', repos: [A, B, C] }, tc, 'en')).toBe(
      `Code graphs for ${expected} were refreshed since the last turn. Earlier answers used the previous graphs.`,
    );
    expect(actLine({ kind: 'codeGraphRefreshed', repos: [A, B] }, tc, 'en')).toBe(
      `Code graphs for ${A} and ${B} were refreshed since the last turn. Earlier answers used the previous graphs.`,
    );
  });

  it('the running bar repeats the same line', () => {
    const acts: PlanChangeProgress[] = [{ kind: 'codeGraphRefreshed', repos: [A, B] }];
    expect(runningBarLine(acts, tc, 'en')).toBe(actLine(acts[0]!, tc, 'en'));
  });
});

describe('the line, in every locale', () => {
  for (const locale of locales) {
    it(`${locale}: a real translation, the names as-is, the list joined by the locale, no hash`, () => {
      const tc = translatorFor(locale);
      const one = actLine({ kind: 'codeGraphRefreshed', repos: [A] }, tc, locale);
      const many = actLine({ kind: 'codeGraphRefreshed', repos: [A, B, C] }, tc, locale);
      for (const line of [one, many]) {
        expect(line).not.toMatch(/[{}]|codeGraphRefreshedLine|undefined/);
        expect(line).not.toMatch(/\b[0-9a-f]{7,64}\b/);
      }
      expect(one).toContain(A);
      expect(many).toContain(
        new Intl.ListFormat(locale, { type: 'conjunction' }).format([A, B, C]),
      );
      if (locale !== 'en') {
        expect(one).not.toContain('was refreshed');
        expect(many).not.toContain('were refreshed');
      }
    });
  }
});

describe('the act record row', () => {
  it('draws one row with the note label and the catalogue line', () => {
    renderWithIntl(
      <PlanActRecord acts={[{ kind: 'codeGraphRefreshed', repos: [A, B] }]} streaming={false} />,
    );
    const row = screen.getByTestId('plan-change-act-codeGraphRefreshed');
    expect(row.querySelector('.font-mono')?.textContent).toBe('note');
    expect(row.textContent).toContain(
      `Code graphs for ${A} and ${B} were refreshed since the last turn.`,
    );
    expect(screen.getByTestId('plan-change-announcer').textContent).toContain('Code graphs for');
  });
});
