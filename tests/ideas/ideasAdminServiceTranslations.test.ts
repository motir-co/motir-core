import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IdeaChangedError,
  IdeaTagNotFoundError,
  IdeaTranslationShapeError,
  IdeaTranslationWithoutEnglishError,
  IdeaUnsupportedLocaleError,
  InvalidIdeaInputError,
} from '@/lib/ideas/errors';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import type { IdeaActor, IdeaTranslationsInput } from '@/lib/ideas/types';
import { platformAuditLogRepository } from '@/lib/repositories/platformAuditLogRepository';
import { ideasAdminService } from '@/lib/services/ideasAdminService';
import { toStaffTranslationView } from '@/lib/ideas/staffTranslations';
import { isPlatformAuditWrite } from '@/lib/platform/auditActions';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { directionInput, ideaAuditRows, motirBuysInput, seedTags, staffActor } from './_helpers';

/**
 * Staff idea writes carrying per-locale text (Story MOTIR-7772 · MOTIR-7774),
 * against real Postgres: writing and reading every locale, the locale and shape
 * refusals, the stale-drop rule in every combination of changed English and
 * supplied locales, the `expectedUpdatedAt` check, the audit metadata and
 * rollback, `missingLocales`, the tag label routes — and the two races.
 */

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await truncateAuthTables();
});

const EVERY = ['zh', 'zh_tw', 'ja', 'ko', 'de', 'fr', 'es', 'it', 'nl', 'pl', 'pt'] as const;

/** A full translation of `directionInput`'s fields, tagged with the locale. */
function fullDirection(locale: string) {
  return {
    title: `${locale} title`,
    pitch: `${locale} pitch`,
    capabilities: [`${locale} one`, `${locale} two`],
    gap: `${locale} gap`,
  };
}

function everyLocale(): IdeaTranslationsInput {
  return Object.fromEntries(EVERY.map((l) => [l, fullDirection(l)]));
}

function everyClaim(): Record<string, string> {
  return Object.fromEntries(EVERY.map((l) => [l, `${l} claim`]));
}

async function seedTranslated(actor: IdeaActor, slug = 'kit') {
  await seedTags('smb');
  await ideasAdminService.addTag(actor, {
    slug: 'pets',
    label: 'Pets',
    description: 'Pet businesses.',
    labelTranslations: Object.fromEntries(EVERY.map((l) => [l, `${l} pets`])),
  });
  await ideasAdminService.addIdeas(actor, [
    directionInput(slug, {
      tags: ['pets'],
      evidence: [
        {
          claim: 'A sourced claim.',
          sourceName: 'A source',
          url: 'https://example.com/a',
          claimTranslations: everyClaim(),
        },
      ],
      translations: everyLocale(),
    }),
  ]);
  return ideasAdminService.getForStaff(actor, slug);
}

describe('writing and reading translations', () => {
  it('adds an idea with every locale and reads them all back, with nothing missing', async () => {
    const actor = await staffActor('operator');
    const idea = await seedTranslated(actor);

    expect(idea.translations?.ja).toEqual(fullDirection('ja'));
    expect(Object.keys(idea.translations ?? {}).sort()).toEqual([...EVERY].sort());
    expect(idea.evidence[0]!.claimTranslations?.de).toBe('de claim');
    expect(idea.tags[0]!.labelTranslations?.pl).toBe('pl pets');
    expect(idea.missingLocales).toEqual([]);

    const add = (await ideaAuditRows()).find((r) => r.action === 'idea.add')!;
    expect((add.metadata as { translatedLocales: string[] }).translatedLocales).toEqual(
      [...EVERY].sort(),
    );
    const listed = await ideasAdminService.listForStaff(actor);
    expect(listed.items[0]!.translations?.ko?.title).toBe('ko title');
  });

  it('names exactly the locales missing an idea field, a claim or a tag label', async () => {
    const actor = await staffActor('operator');
    await seedTranslated(actor);
    // A claim missing in de: replace its translations without de.
    const claimsWithoutDe = everyClaim();
    delete claimsWithoutDe.de;
    const current = await ideasAdminService.getForStaff(actor, 'kit');
    await ideasAdminService.updateIdea(actor, 'kit', {
      evidence: [{ ...current.evidence[0]!, claimTranslations: claimsWithoutDe }],
    });
    expect((await ideasAdminService.getForStaff(actor, 'kit')).missingLocales).toEqual(['de']);

    // A tag label missing in pl.
    await adminDb.ideaTagTranslation.deleteMany({ where: { locale: 'pl' } });
    expect((await ideasAdminService.getForStaff(actor, 'kit')).missingLocales).toEqual([
      'de',
      'pl',
    ]);

    // A length-mismatched list counts as missing.
    const idea = await adminDb.idea.findUniqueOrThrow({ where: { slug: 'kit' } });
    await adminDb.ideaTranslation.update({
      where: { ideaId_locale: { ideaId: idea.id, locale: 'it' } },
      data: { capabilities: ['only one'] },
    });
    const after = await ideasAdminService.getForStaff(actor, 'kit');
    expect(after.missingLocales).toEqual(['de', 'it', 'pl']);
    expect(after.translations?.it?.capabilities).toBeUndefined();
  });

  it('lists every locale as missing on an idea with no translations', async () => {
    const actor = await staffActor('operator');
    await ideasAdminService.addIdeas(actor, [motirBuysInput('bare')]);
    const bare = await ideasAdminService.getForStaff(actor, 'bare');
    expect(bare.translations).toEqual({});
    expect(bare.missingLocales).toEqual([...EVERY]);
  });

  it('merges a translation-only PATCH without moving updatedAt or touching other locales', async () => {
    const actor = await staffActor('operator');
    await ideasAdminService.addIdeas(actor, [directionInput('kit')]);
    const before = await ideasAdminService.getForStaff(actor, 'kit');

    const after = await ideasAdminService.updateIdea(actor, 'kit', {
      expectedUpdatedAt: before.updatedAt,
      translations: { ja: { title: '題' } },
    });
    const again = await ideasAdminService.updateIdea(actor, 'kit', {
      expectedUpdatedAt: before.updatedAt,
      translations: { ja: { pitch: '売り' }, ko: { title: '제목' } },
    });
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(again.updatedAt).toBe(before.updatedAt);
    expect(again.translations).toEqual({
      ja: { title: '題', pitch: '売り' },
      ko: { title: '제목' },
    });

    const update = (await ideaAuditRows()).filter((r) => r.action === 'idea.update').at(-1)!;
    expect(update.metadata).toMatchObject({
      fields: [],
      translatedLocales: ['ja', 'ko'],
      droppedTranslationFields: [],
    });
  });
});

describe('the stale-drop rule', () => {
  it('clears a changed field in every locale and leaves the others', async () => {
    const actor = await staffActor('operator');
    await seedTranslated(actor);
    const after = await ideasAdminService.updateIdea(actor, 'kit', { pitch: 'A new pitch.' });
    for (const locale of EVERY) {
      expect(after.translations?.[locale]?.pitch).toBeUndefined();
      expect(after.translations?.[locale]?.title).toBe(`${locale} title`);
    }
    expect(after.missingLocales).toEqual([...EVERY]);
    const update = (await ideaAuditRows()).filter((r) => r.action === 'idea.update').at(-1)!;
    expect(update.metadata).toMatchObject({
      fields: ['pitch'],
      droppedTranslationFields: ['pitch'],
      translatedLocales: [],
    });
  });

  it('keeps exactly the locales re-supplied in the same write', async () => {
    const actor = await staffActor('operator');
    const idea = await seedTranslated(actor);
    const after = await ideasAdminService.updateIdea(actor, 'kit', {
      pitch: 'A new pitch.',
      expectedUpdatedAt: idea.updatedAt,
      translations: { ja: { pitch: '新しい' }, ko: { pitch: '새로운' } },
    });
    const withPitch = EVERY.filter((l) => after.translations?.[l]?.pitch !== undefined);
    expect(withPitch).toEqual(['ja', 'ko']);
    expect(after.translations?.ja?.pitch).toBe('新しい');
  });

  it('clears nothing when the English is re-sent unchanged', async () => {
    const actor = await staffActor('operator');
    const idea = await seedTranslated(actor);
    const after = await ideasAdminService.updateIdea(actor, 'kit', {
      pitch: idea.pitch,
      capabilities: ['Does one thing', 'Does another'],
      reviewed: true,
    });
    expect(after.translations?.fr?.pitch).toBe('fr pitch');
    expect(after.translations?.fr?.capabilities).toEqual(['fr one', 'fr two']);
    expect(after.missingLocales).toEqual([]);
  });

  it('applies the rule to an English-only, console-shaped edit', async () => {
    const actor = await staffActor('operator', { kind: 'session' });
    await seedTranslated(actor);
    const after = await ideasAdminService.updateIdea(actor, 'kit', {
      title: 'A new title',
      capabilities: ['Does one thing'],
    });
    expect(after.translations?.de?.title).toBeUndefined();
    expect(after.translations?.de?.capabilities).toBeUndefined();
    expect(after.translations?.de?.gap).toBe('de gap');
  });

  it('drops a replaced claim with its row unless the write re-supplies it', async () => {
    const actor = await staffActor('operator');
    const idea = await seedTranslated(actor);
    const after = await ideasAdminService.updateIdea(actor, 'kit', {
      evidence: [{ ...idea.evidence[0]!, claim: 'A new claim.', claimTranslations: undefined }],
    });
    expect(after.evidence[0]!.claimTranslations).toEqual({});
  });
});

describe('refusals', () => {
  it('refuses a locale outside the ten — en included — everywhere, writing nothing', async () => {
    const actor = await staffActor('operator');
    await ideasAdminService.addIdeas(actor, [directionInput('kit')]);
    const { updatedAt } = await ideasAdminService.getForStaff(actor, 'kit');

    const batch = await ideasAdminService
      .addIdeas(actor, [
        directionInput('ok-one'),
        directionInput('bad-one', {
          translations: { en: { title: 'x' } } as IdeaTranslationsInput,
          evidence: [
            {
              claim: 'c',
              sourceName: 's',
              url: 'https://e.com',
              claimTranslations: { xx: 'c' } as Record<string, string>,
            },
          ],
        }),
      ])
      .catch((e: unknown) => e);
    expect(batch).toBeInstanceOf(IdeaUnsupportedLocaleError);
    expect((batch as IdeaUnsupportedLocaleError).locales).toEqual(['en', 'xx']);
    expect(await adminDb.idea.count()).toBe(1);

    await expect(
      ideasAdminService.updateIdea(actor, 'kit', {
        expectedUpdatedAt: updatedAt,
        translations: { 'en-GB': { title: 'x' } } as IdeaTranslationsInput,
      }),
    ).rejects.toBeInstanceOf(IdeaUnsupportedLocaleError);
    await expect(
      ideasAdminService.addTag(actor, {
        slug: 'nope',
        label: 'Nope',
        description: 'd',
        labelTranslations: { en: 'Nope' } as Record<string, string>,
      }),
    ).rejects.toBeInstanceOf(IdeaUnsupportedLocaleError);
    expect(await adminDb.ideaTranslation.count()).toBe(0);
  });

  it('refuses translations without expectedUpdatedAt, and a stale one with IDEA_CHANGED', async () => {
    const actor = await staffActor('operator');
    await ideasAdminService.addIdeas(actor, [directionInput('kit')]);
    const { updatedAt } = await ideasAdminService.getForStaff(actor, 'kit');

    await expect(
      ideasAdminService.updateIdea(actor, 'kit', { translations: { ja: { title: '題' } } }),
    ).rejects.toBeInstanceOf(InvalidIdeaInputError);

    await ideasAdminService.updateIdea(actor, 'kit', { pitch: 'Moved on.' });
    const changed = await ideasAdminService
      .updateIdea(actor, 'kit', {
        expectedUpdatedAt: updatedAt,
        translations: { ja: { pitch: '古い' } },
      })
      .catch((e: unknown) => e);
    expect(changed).toBeInstanceOf(IdeaChangedError);
    const now = await ideasAdminService.getForStaff(actor, 'kit');
    expect((changed as IdeaChangedError).updatedAt).toBe(now.updatedAt);
    expect(await adminDb.ideaTranslation.count()).toBe(0);
  });

  it('refuses a list of the wrong length and a translation of a field with no English', async () => {
    const actor = await staffActor('operator');
    await ideasAdminService.addIdeas(actor, [directionInput('kit')]);
    const { updatedAt } = await ideasAdminService.getForStaff(actor, 'kit');

    const shape = await ideasAdminService
      .updateIdea(actor, 'kit', {
        expectedUpdatedAt: updatedAt,
        translations: { ja: { capabilities: ['一'] } },
      })
      .catch((e: unknown) => e);
    expect(shape).toBeInstanceOf(IdeaTranslationShapeError);
    expect((shape as IdeaTranslationShapeError).fields).toEqual(['ja.capabilities']);

    const noEnglish = await ideasAdminService
      .updateIdea(actor, 'kit', {
        expectedUpdatedAt: updatedAt,
        translations: { ja: { whyMotir: 'なぜ' }, ko: { whyNow: '지금' } },
      })
      .catch((e: unknown) => e);
    expect(noEnglish).toBeInstanceOf(IdeaTranslationWithoutEnglishError);
    expect((noEnglish as IdeaTranslationWithoutEnglishError).fields).toEqual([
      'ja.whyMotir',
      'ko.whyNow',
    ]);

    const batch = await ideasAdminService
      .addIdeas(actor, [
        motirBuysInput('no-caps', {
          capabilities: [],
          translations: { de: { capabilities: ['x'] } },
        }),
      ])
      .catch((e: unknown) => e);
    expect((batch as IdeaTranslationWithoutEnglishError).fields).toEqual([
      'no-caps.de.capabilities',
    ]);
    expect(await adminDb.ideaTranslation.count()).toBe(0);
  });

  it('refuses blank and over-long translated text with INVALID_IDEA_INPUT', async () => {
    const actor = await staffActor('operator');
    const err = await ideasAdminService
      .addIdeas(actor, [
        directionInput('kit', {
          translations: {
            ja: { title: ' ', capabilities: ['x'.repeat(301), 'ok'] },
            ko: { capabilities: 'nope' as unknown as string[] },
          },
          evidence: [
            { claim: 'c', sourceName: 's', url: 'https://e.com', claimTranslations: { ja: '' } },
          ],
        }),
      ])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidIdeaInputError);
    expect((err as InvalidIdeaInputError).issues.map((i) => i.field).sort()).toEqual([
      'evidence[0].claimTranslations.ja',
      'translations.ja.capabilities[0]',
      'translations.ja.title',
      'translations.ko.capabilities',
    ]);
  });

  it('rolls a translation-carrying PATCH back whole when the audit append fails', async () => {
    const actor = await staffActor('operator');
    const idea = await seedTranslated(actor);
    vi.spyOn(platformAuditLogRepository, 'create').mockRejectedValueOnce(
      new Error('append failed'),
    );
    await expect(
      ideasAdminService.updateIdea(actor, 'kit', {
        pitch: 'Rolled back.',
        expectedUpdatedAt: idea.updatedAt,
        translations: { ja: { pitch: '戻す', title: '戻す' } },
      }),
    ).rejects.toThrow('append failed');
    const after = await ideasAdminService.getForStaff(actor, 'kit');
    expect(after.pitch).toBe(idea.pitch);
    expect(after.translations).toEqual(idea.translations);
  });
});

describe('tag label translations', () => {
  it('merges labels into an existing tag with one audit row, and 404s an unknown tag', async () => {
    const actor = await staffActor('operator');
    await seedTags('smb');
    await ideasAdminService.setTagLabelTranslations(actor, 'smb', { ja: 'ちゅう' });
    const tag = await ideasAdminService.setTagLabelTranslations(actor, 'smb', {
      ja: ' 中小企業 ',
      de: 'KMU',
    });
    expect(tag).toMatchObject({ slug: 'smb', labelTranslations: { ja: '中小企業', de: 'KMU' } });
    expect((await ideasAdminService.listTags(actor))[0]!.labelTranslations).toEqual({
      ja: '中小企業',
      de: 'KMU',
    });

    const rows = (await ideaAuditRows()).filter((r) => r.action === 'idea.tag_translate');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ targetLabel: 'tag:smb' });
    expect(rows[1]!.metadata).toMatchObject({ translatedLocales: ['de', 'ja'] });

    await expect(
      ideasAdminService.setTagLabelTranslations(actor, 'nope', { ja: 'x' }),
    ).rejects.toBeInstanceOf(IdeaTagNotFoundError);
    await expect(
      ideasAdminService.setTagLabelTranslations(actor, 'smb', {}),
    ).rejects.toBeInstanceOf(InvalidIdeaInputError);
    await expect(
      ideasAdminService.setTagLabelTranslations(actor, 'smb', { ja: 'x'.repeat(61) }),
    ).rejects.toBeInstanceOf(InvalidIdeaInputError);
    await expect(
      ideasAdminService.setTagLabelTranslations(
        await staffActor('support', undefined, 'sup'),
        'smb',
        {
          ja: 'x',
        },
      ),
    ).rejects.toBeInstanceOf(NotPlatformStaffError);
  });
});

describe('races, against genuinely concurrent transactions', () => {
  it('an English edit and a translation write on the same idea: the translation never survives', async () => {
    const actor = await staffActor('operator');
    await ideasAdminService.addIdeas(actor, [directionInput('kit')]);
    const { updatedAt } = await ideasAdminService.getForStaff(actor, 'kit');

    const results = await Promise.allSettled([
      ideasAdminService.updateIdea(actor, 'kit', {
        pitch: 'An edited pitch.',
        expectedUpdatedAt: updatedAt,
      }),
      ideasAdminService.updateIdea(actor, 'kit', {
        expectedUpdatedAt: updatedAt,
        translations: { ja: { pitch: '古いピッチの訳' } },
      }),
    ]);
    expect(results[0]!.status).toBe('fulfilled');
    // Either (a) the translation committed first and the edit cleared it, or
    // (b) the edit committed first and the translation was refused.
    if (results[1]!.status === 'rejected') {
      expect(results[1]!.reason).toBeInstanceOf(IdeaChangedError);
    }
    const after = await ideasAdminService.getForStaff(actor, 'kit');
    expect(after.pitch).toBe('An edited pitch.');
    expect(after.translations?.ja?.pitch).toBeUndefined();
    const committed = results.filter((r) => r.status === 'fulfilled').length;
    expect((await ideaAuditRows()).filter((r) => r.action === 'idea.update')).toHaveLength(
      committed,
    );
  });

  it('two translation-only writes for different locales both succeed', async () => {
    const actor = await staffActor('operator');
    await ideasAdminService.addIdeas(actor, [directionInput('kit')]);
    const { updatedAt } = await ideasAdminService.getForStaff(actor, 'kit');
    const results = await Promise.allSettled([
      ideasAdminService.updateIdea(actor, 'kit', {
        expectedUpdatedAt: updatedAt,
        translations: { ja: { title: '題' } },
      }),
      ideasAdminService.updateIdea(actor, 'kit', {
        expectedUpdatedAt: updatedAt,
        translations: { ko: { title: '제목' } },
      }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const after = await ideasAdminService.getForStaff(actor, 'kit');
    expect(after.translations).toEqual({ ja: { title: '題' }, ko: { title: '제목' } });
  });
});

// ── The staff view's edge rows (MOTIR-7778 coverage top-up) ────────────────

describe('toStaffTranslationView', () => {
  it('omits a locale row with no present field and an empty claim or label text', () => {
    const view = toStaffTranslationView({
      title: 'Pet clinics',
      pitch: 'Booking.',
      capabilities: ['One', 'Two'],
      gap: null,
      whyNow: null,
      whyMotir: null,
      whoElse: null,
      translations: [
        // Only a stale (wrong-length) list: nothing in it is present.
        {
          locale: 'ja',
          title: null,
          pitch: null,
          capabilities: ['一'],
          gap: null,
          whyNow: null,
          whyMotir: null,
          whoElse: null,
        },
      ],
      evidence: [{ claim: 'A claim.', translations: [{ locale: 'de', claim: '' }] }],
      tags: [{ tag: { label: 'SMB', translations: [{ locale: 'pl', label: '' }] } }],
    });
    expect(view.translations).toEqual({});
    expect(view.claimTranslations).toEqual([{}]);
    expect(view.labelTranslations).toEqual([{}]);
    expect(view.missingLocales).toHaveLength(11);
  });
});

describe('the idea.tag_translate audit action', () => {
  it('is a write, so the trail lists it beside the other tag writes', () => {
    expect(isPlatformAuditWrite('idea.tag_translate')).toBe(true);
    expect(isPlatformAuditWrite('idea.tag_add')).toBe(true);
  });
});
