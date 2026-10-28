import { describe, expect, it } from 'vitest';
import {
  localizeClaim,
  localizeIdea,
  localizeLabel,
  publicIdeaLocaleCode,
  resolvePublicIdeaLocale,
  type LocalizableIdea,
} from '@/lib/ideas/publicLocale';

/**
 * The public read's locale (Story MOTIR-7772 · MOTIR-7775) — the resolver that
 * never throws, and the per-field merge with its three meanings of "missing":
 * a null translation, a length-mismatched list, and a null ENGLISH (which is not
 * missing at all).
 */

describe('resolvePublicIdeaLocale', () => {
  it.each([
    ['ja', 'ja'],
    ['pt', 'pt'],
    ['en', 'en'],
    [null, 'en'],
    [undefined, 'en'],
    ['', 'en'],
    ['xx', 'en'],
    ['JA', 'en'],
    ['zh-CN', 'en'],
    ['zh-tw', 'zh_tw'],
    // The enum's own spelling is not a public code.
    ['zh_tw', 'en'],
    ['zh-TW', 'en'],
  ] as const)('%s → %s', (raw, served) => {
    expect(resolvePublicIdeaLocale(raw)).toBe(served);
  });
});

describe('publicIdeaLocaleCode', () => {
  it('spells Traditional Chinese as motir.co does, every other locale as itself', () => {
    expect(publicIdeaLocaleCode('zh_tw')).toBe('zh-tw');
    expect(publicIdeaLocaleCode('zh')).toBe('zh');
    expect(publicIdeaLocaleCode('en')).toBe('en');
  });
});

function idea(
  translation: Partial<LocalizableIdea['translations'][number]> | null,
): LocalizableIdea {
  return {
    title: 'Title',
    pitch: 'Pitch',
    capabilities: ['One', 'Two'],
    gap: 'Gap',
    whyNow: 'Now',
    whyMotir: null,
    whoElse: null,
    translations: translation
      ? [
          {
            locale: 'ja',
            title: null,
            pitch: null,
            capabilities: [],
            gap: null,
            whyNow: null,
            whyMotir: null,
            whoElse: null,
            ...translation,
          },
        ]
      : [],
  };
}

describe('localizeIdea', () => {
  it('serves a full translation with nothing listed', () => {
    const out = localizeIdea(
      idea({ title: '題', pitch: '売り', capabilities: ['一', '二'], gap: '隙', whyNow: '今' }),
      'ja',
    );
    expect(out).toEqual({
      fields: {
        title: '題',
        pitch: '売り',
        capabilities: ['一', '二'],
        gap: '隙',
        whyNow: '今',
        whyMotir: null,
        whoElse: null,
      },
      fallbackFields: [],
    });
  });

  it('falls back field by field, never listing a field whose English is null', () => {
    const out = localizeIdea(
      idea({ title: '題', capabilities: ['一'], gap: '隙', whyNow: '今', whyMotir: 'なぜ' }),
      'ja',
    );
    expect(out.fields.title).toBe('題');
    expect(out.fields.pitch).toBe('Pitch');
    expect(out.fields.capabilities).toEqual(['One', 'Two']);
    expect(out.fields.whyMotir).toBeNull();
    expect(out.fallbackFields).toEqual(['pitch', 'capabilities']);
  });

  it('treats an empty list against a non-empty English as missing', () => {
    const out = localizeIdea(
      idea({ title: '題', pitch: '売り', capabilities: [], gap: '隙', whyNow: '今' }),
      'ja',
    );
    expect(out.fallbackFields).toEqual(['capabilities']);
  });

  it('serves everything in English when the locale has no row, naming every English field', () => {
    expect(localizeIdea(idea(null), 'ko').fallbackFields).toEqual([
      'title',
      'pitch',
      'capabilities',
      'gap',
      'whyNow',
    ]);
  });

  it('serves English with nothing listed for en, even beside translations', () => {
    const out = localizeIdea(idea({ title: '題' }), 'en');
    expect(out.fields.title).toBe('Title');
    expect(out.fallbackFields).toEqual([]);
  });
});

describe('localizeClaim and localizeLabel', () => {
  it('serves the locale text when present and flags the English otherwise', () => {
    const evidence = { claim: 'A claim', translations: [{ locale: 'ja' as const, claim: '主張' }] };
    expect(localizeClaim(evidence, 'ja')).toEqual({ text: '主張', fallback: false });
    expect(localizeClaim(evidence, 'ko')).toEqual({ text: 'A claim', fallback: true });
    expect(localizeClaim(evidence, 'en')).toEqual({ text: 'A claim', fallback: false });

    const tag = { label: 'Pets', translations: [{ locale: 'de' as const, label: '' }] };
    expect(localizeLabel(tag, 'de')).toEqual({ text: 'Pets', fallback: true });
    expect(
      localizeLabel({ ...tag, translations: [{ locale: 'de', label: 'Haustiere' }] }, 'de'),
    ).toEqual({
      text: 'Haustiere',
      fallback: false,
    });
  });
});
