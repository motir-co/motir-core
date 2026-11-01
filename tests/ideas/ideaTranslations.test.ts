import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { locales } from '@/lib/i18n/locales';
import {
  IDEA_EVIDENCE_TRANSLATABLE_FIELD,
  IDEA_TAG_TRANSLATABLE_FIELD,
  IDEA_TRANSLATABLE_FIELDS,
  IDEA_TRANSLATION_LOCALES,
  isIdeaTranslationLocale,
  isTranslatedFieldPresent,
} from '@/lib/ideas/translatableFields';
import { ideaPublicRepository } from '@/lib/repositories/ideaPublicRepository';
import { ideaRepository } from '@/lib/repositories/ideaRepository';
import { ideaTagRepository } from '@/lib/repositories/ideaTagRepository';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

/**
 * The idea store's PER-LOCALE text (Story MOTIR-7772 · MOTIR-7773) — the
 * translation tables' constraints and the repository methods over them, against
 * real Postgres: the enum, the composite keys, the cascades, the merge-only
 * upsert (including under a real race), the clear across locales, and the
 * guarantee that a translation write never moves `Idea.updatedAt`.
 */

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await truncateAuthTables();
});

/** One active idea with one evidence row and one tag, written as the owner. */
async function seedIdea(slug = 'kit') {
  const tag = await adminDb.ideaTag.create({
    data: { slug: `${slug}-tag`, label: 'Pets', description: 'Why it exists' },
  });
  return adminDb.idea.create({
    data: {
      slug,
      title: 'The kit',
      pitch: 'A pitch.',
      kind: 'direction',
      category: 'ecommerce',
      capabilities: ['one', 'two'],
      gap: 'A gap.',
      evidence: {
        create: [{ position: 0, claim: 'A claim.', sourceName: 'A source', url: 'https://x.test' }],
      },
      tags: { create: [{ tagId: tag.id }] },
    },
    include: { evidence: true, tags: true },
  });
}

/** Run `fn` in one owner transaction (the repositories' writes need a `tx`). */
function inTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return adminDb.$transaction((tx) => fn(tx));
}

function translationOf(ideaId: string, locale: 'ja' | 'ko') {
  return adminDb.ideaTranslation.findUnique({ where: { ideaId_locale: { ideaId, locale } } });
}

describe('the translatable-field list', () => {
  it("names the ten non-English UI locales, and motir.co's Traditional Chinese", () => {
    expect([...IDEA_TRANSLATION_LOCALES].sort()).toEqual(
      [...locales.filter((l) => l !== 'en'), 'zh_tw'].sort(),
    );
    expect(isIdeaTranslationLocale('ja')).toBe(true);
    expect(isIdeaTranslationLocale('en')).toBe(false);
    expect(isIdeaTranslationLocale(7)).toBe(false);
  });

  it('names exactly the seven idea text fields, the claim and the label', () => {
    expect(IDEA_TRANSLATABLE_FIELDS).toEqual([
      'title',
      'pitch',
      'capabilities',
      'gap',
      'whyNow',
      'whyMotir',
      'whoElse',
    ]);
    expect(IDEA_EVIDENCE_TRANSLATABLE_FIELD).toBe('claim');
    expect(IDEA_TAG_TRANSLATABLE_FIELD).toBe('label');
  });

  it('counts a text field present when non-empty, a list only at the English length', () => {
    const english = { capabilities: ['one', 'two'] };
    expect(isTranslatedFieldPresent('title', { title: '題' }, english)).toBe(true);
    expect(isTranslatedFieldPresent('title', { title: '' }, english)).toBe(false);
    expect(isTranslatedFieldPresent('gap', { gap: null }, english)).toBe(false);
    expect(isTranslatedFieldPresent('title', null, english)).toBe(false);
    expect(isTranslatedFieldPresent('capabilities', { capabilities: ['一', '二'] }, english)).toBe(
      true,
    );
    expect(isTranslatedFieldPresent('capabilities', { capabilities: ['一'] }, english)).toBe(false);
    expect(isTranslatedFieldPresent('capabilities', {}, english)).toBe(false);
    expect(
      isTranslatedFieldPresent('capabilities', { capabilities: [] }, { capabilities: [] }),
    ).toBe(false);
  });
});

describe('the translation tables', () => {
  it('refuses a locale outside the ten — en and xx alike', async () => {
    const idea = await seedIdea();
    for (const locale of ['en', 'xx']) {
      await expect(
        adminDb.$executeRawUnsafe(
          `INSERT INTO idea_translation (idea_id, locale) VALUES ($1, $2::idea_translation_locale)`,
          idea.id,
          locale,
        ),
      ).rejects.toThrow(/invalid input value for enum/);
    }
  });

  it('refuses a second row for the same (row, locale) on each table', async () => {
    const idea = await seedIdea();
    const evidenceId = idea.evidence[0]!.id;
    const tagId = idea.tags[0]!.tagId;
    await adminDb.ideaTranslation.create({ data: { ideaId: idea.id, locale: 'ja', title: 'a' } });
    await expect(
      adminDb.ideaTranslation.create({ data: { ideaId: idea.id, locale: 'ja', title: 'b' } }),
    ).rejects.toThrow(/Unique constraint/);
    await adminDb.ideaEvidenceTranslation.create({
      data: { evidenceId, locale: 'ja', claim: 'a' },
    });
    await expect(
      adminDb.ideaEvidenceTranslation.create({ data: { evidenceId, locale: 'ja', claim: 'b' } }),
    ).rejects.toThrow(/Unique constraint/);
    await adminDb.ideaTagTranslation.create({ data: { tagId, locale: 'ja', label: 'a' } });
    await expect(
      adminDb.ideaTagTranslation.create({ data: { tagId, locale: 'ja', label: 'b' } }),
    ).rejects.toThrow(/Unique constraint/);
  });

  it('cascades an idea delete to its translations and its evidence translations', async () => {
    const idea = await seedIdea();
    await adminDb.ideaTranslation.create({ data: { ideaId: idea.id, locale: 'ja', title: 'a' } });
    await adminDb.ideaEvidenceTranslation.create({
      data: { evidenceId: idea.evidence[0]!.id, locale: 'ja', claim: 'a' },
    });
    await adminDb.idea.delete({ where: { id: idea.id } });
    expect(await adminDb.ideaTranslation.count()).toBe(0);
    expect(await adminDb.ideaEvidenceTranslation.count()).toBe(0);
  });

  it('cascades an evidence delete to its claim translations', async () => {
    const idea = await seedIdea();
    const evidenceId = idea.evidence[0]!.id;
    await adminDb.ideaEvidenceTranslation.create({
      data: { evidenceId, locale: 'ko', claim: 'a' },
    });
    await adminDb.ideaEvidence.delete({ where: { id: evidenceId } });
    expect(await adminDb.ideaEvidenceTranslation.count()).toBe(0);
  });

  it('cascades an unused tag delete to its label translations', async () => {
    const tag = await adminDb.ideaTag.create({ data: { slug: 'unused', label: 'Unused' } });
    await adminDb.ideaTagTranslation.create({ data: { tagId: tag.id, locale: 'de', label: 'x' } });
    await adminDb.ideaTag.delete({ where: { id: tag.id } });
    expect(await adminDb.ideaTagTranslation.count()).toBe(0);
  });
});

describe('ideaRepository — translation writes', () => {
  it('merges partial upserts: { title } then { pitch } leaves both', async () => {
    const idea = await seedIdea();
    expect(
      await inTx((tx) => ideaRepository.upsertTranslations(idea.id, 'ja', { title: '題' }, tx)),
    ).toBe(1);
    await inTx((tx) => ideaRepository.upsertTranslations(idea.id, 'ja', { pitch: '売り' }, tx));
    const row = await translationOf(idea.id, 'ja');
    expect(row).toMatchObject({ title: '題', pitch: '売り', gap: null, capabilities: [] });
  });

  it('writes the capabilities list and the snake-cased columns', async () => {
    const idea = await seedIdea();
    await inTx((tx) =>
      ideaRepository.upsertTranslations(
        idea.id,
        'ja',
        { capabilities: ['一', '二'], whyNow: '今', whyMotir: 'M', whoElse: '他', gap: '隙' },
        tx,
      ),
    );
    expect(await translationOf(idea.id, 'ja')).toMatchObject({
      capabilities: ['一', '二'],
      whyNow: '今',
      whyMotir: 'M',
      whoElse: '他',
      gap: '隙',
      title: null,
    });
  });

  it('writes nothing when no field is supplied', async () => {
    const idea = await seedIdea();
    expect(await inTx((tx) => ideaRepository.upsertTranslations(idea.id, 'ja', {}, tx))).toBe(0);
    expect(await adminDb.ideaTranslation.count()).toBe(0);
  });

  it('clears a field in EVERY locale and leaves the others', async () => {
    const idea = await seedIdea();
    await inTx(async (tx) => {
      await ideaRepository.upsertTranslations(
        idea.id,
        'ja',
        { title: '題', pitch: '売り', capabilities: ['一', '二'] },
        tx,
      );
      await ideaRepository.upsertTranslations(idea.id, 'ko', { title: '제목', pitch: '피치' }, tx);
    });
    expect(
      await inTx((tx) =>
        ideaRepository.clearTranslatedFields(idea.id, ['pitch', 'capabilities'], tx),
      ),
    ).toBe(2);
    expect(await translationOf(idea.id, 'ja')).toMatchObject({
      title: '題',
      pitch: null,
      capabilities: [],
    });
    expect(await translationOf(idea.id, 'ko')).toMatchObject({ title: '제목', pitch: null });
    expect(await inTx((tx) => ideaRepository.clearTranslatedFields(idea.id, [], tx))).toBe(0);
  });

  it('never moves Idea.updatedAt; an English update does', async () => {
    const idea = await seedIdea();
    const before = idea.updatedAt;
    await new Promise((r) => setTimeout(r, 15));
    await inTx(async (tx) => {
      await ideaRepository.upsertTranslations(idea.id, 'ja', { title: '題' }, tx);
      await ideaRepository.clearTranslatedFields(idea.id, ['title'], tx);
      await ideaRepository.upsertEvidenceTranslation(idea.evidence[0]!.id, 'ja', '主張', tx);
      await ideaRepository.replaceEvidenceTranslations(idea.evidence[0]!.id, { ko: '주장' }, tx);
    });
    const after = await adminDb.idea.findUniqueOrThrow({ where: { id: idea.id } });
    expect(after.updatedAt.getTime()).toBe(before.getTime());

    await adminDb.idea.update({ where: { id: idea.id }, data: { pitch: 'A new pitch.' } });
    const edited = await adminDb.idea.findUniqueOrThrow({ where: { id: idea.id } });
    expect(edited.updatedAt.getTime()).toBeGreaterThan(before.getTime());
  });

  it('upserts one evidence claim per locale and replaces the set wholesale', async () => {
    const idea = await seedIdea();
    const evidenceId = idea.evidence[0]!.id;
    await inTx(async (tx) => {
      await ideaRepository.upsertEvidenceTranslation(evidenceId, 'ja', '一', tx);
      await ideaRepository.upsertEvidenceTranslation(evidenceId, 'ja', '二', tx);
      await ideaRepository.upsertEvidenceTranslation(evidenceId, 'de', 'zwei', tx);
    });
    expect(
      (await adminDb.ideaEvidenceTranslation.findMany({ orderBy: { locale: 'asc' } })).map((r) => [
        r.locale,
        r.claim,
      ]),
    ).toEqual([
      ['ja', '二'],
      ['de', 'zwei'],
    ]);

    await inTx((tx) => ideaRepository.replaceEvidenceTranslations(evidenceId, { fr: 'deux' }, tx));
    expect(
      (await adminDb.ideaEvidenceTranslation.findMany()).map((r) => [r.locale, r.claim]),
    ).toEqual([['fr', 'deux']]);
  });

  it('a race on a fresh (idea, locale): both partial upserts land on one row', async () => {
    const idea = await seedIdea();
    // Two transactions that each hold their statement open until both have
    // started, so neither can see the other's row when it inserts.
    let arrive!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      let count = 0;
      arrive = () => {
        count += 1;
        if (count === 2) resolve();
      };
    });
    const write = (fields: { title?: string; pitch?: string }) =>
      adminDb.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1`;
        arrive();
        await bothStarted;
        return ideaRepository.upsertTranslations(idea.id, 'ja', fields, tx);
      });

    const results = await Promise.allSettled([write({ title: '題' }), write({ pitch: '売り' })]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await adminDb.ideaTranslation.count()).toBe(1);
    expect(await translationOf(idea.id, 'ja')).toMatchObject({ title: '題', pitch: '売り' });
  });
});

describe('ideaRepository — staff reads', () => {
  it('carry every locale of the idea, its evidence and its tags, and updatedAt', async () => {
    const idea = await seedIdea();
    const evidenceId = idea.evidence[0]!.id;
    const tagId = idea.tags[0]!.tagId;
    await inTx(async (tx) => {
      await ideaRepository.upsertTranslations(idea.id, 'ja', { title: '題' }, tx);
      await ideaRepository.upsertTranslations(idea.id, 'ko', { title: '제목' }, tx);
      await ideaRepository.upsertEvidenceTranslation(evidenceId, 'ja', '主張', tx);
      await ideaRepository.upsertEvidenceTranslation(evidenceId, 'ko', '주장', tx);
      await ideaTagRepository.upsertTagTranslation(tagId, 'ja', 'ペット', tx);
      await ideaTagRepository.upsertTagTranslation(tagId, 'ko', '반려동물', tx);
    });

    const one = await ideaRepository.findBySlugForStaff('kit');
    const page = await ideaRepository.findAllForStaff({ limit: 10 });
    const inTxRead = await inTx((tx) => ideaRepository.findBySlugInTx('kit', tx));
    for (const row of [one!, page[0]!, inTxRead!]) {
      expect(row.updatedAt).toBeInstanceOf(Date);
      expect(row.translations.map((t) => t.locale).sort()).toEqual(['ja', 'ko']);
      expect(row.evidence[0]!.translations.map((t) => t.locale).sort()).toEqual(['ja', 'ko']);
      expect(row.tags[0]!.tag.translations.map((t) => t.locale).sort()).toEqual(['ja', 'ko']);
    }
  });
});

describe('ideaPublicRepository — the locale argument', () => {
  async function seedTranslated() {
    const idea = await seedIdea();
    await inTx(async (tx) => {
      await ideaRepository.upsertTranslations(idea.id, 'ja', { title: '題' }, tx);
      await ideaRepository.upsertTranslations(idea.id, 'ko', { title: '제목' }, tx);
      await ideaRepository.upsertEvidenceTranslation(idea.evidence[0]!.id, 'ja', '主張', tx);
      await ideaRepository.upsertEvidenceTranslation(idea.evidence[0]!.id, 'ko', '주장', tx);
      await ideaTagRepository.upsertTagTranslation(idea.tags[0]!.tagId, 'ja', 'ペット', tx);
      await ideaTagRepository.upsertTagTranslation(idea.tags[0]!.tagId, 'ko', '반려동물', tx);
    });
    return idea;
  }

  it('with locale: ja, carries only the ja rows', async () => {
    await seedTranslated();
    const list = await ideaPublicRepository.listActive({ tags: [] }, 10, 'ja');
    const one = await ideaPublicRepository.findActiveBySlug('kit', 'ja');
    for (const row of [list[0]!, one!]) {
      expect(row.translations.map((t) => [t.locale, t.title])).toEqual([['ja', '題']]);
      expect(row.evidence[0]!.translations.map((t) => t.claim)).toEqual(['主張']);
      expect(row.tags[0]!.tag.translations.map((t) => t.label)).toEqual(['ペット']);
    }
    expect(await ideaPublicRepository.tagCounts('ja')).toEqual([
      { slug: 'kit-tag', label: 'Pets', translatedLabel: 'ペット', count: 1 },
    ]);
  });

  it('with no locale, carries no translation rows at all', async () => {
    await seedTranslated();
    const list = await ideaPublicRepository.listActive({ tags: [] }, 10);
    const one = await ideaPublicRepository.findActiveBySlug('kit');
    for (const row of [list[0]!, one!]) {
      expect(row.title).toBe('The kit');
      expect(row.translations).toEqual([]);
      expect(row.evidence[0]!.translations).toEqual([]);
      expect(row.tags[0]!.tag.translations).toEqual([]);
    }
    expect(await ideaPublicRepository.tagCounts()).toEqual([
      { slug: 'kit-tag', label: 'Pets', translatedLabel: null, count: 1 },
    ]);
  });
});

describe('ideaTagRepository — label translations', () => {
  it('upserts a label per locale, reads every locale or one, and clears them all', async () => {
    const tag = await adminDb.ideaTag.create({ data: { slug: 'pets', label: 'Pets' } });
    await inTx(async (tx) => {
      await ideaTagRepository.upsertTagTranslation(tag.id, 'ja', 'ペ', tx);
      await ideaTagRepository.upsertTagTranslation(tag.id, 'ja', 'ペット', tx);
      await ideaTagRepository.upsertTagTranslation(tag.id, 'fr', 'Animaux', tx);
    });

    const all = await ideaTagRepository.listAll();
    expect(all[0]!.translations.map((t) => [t.locale, t.label]).sort()).toEqual([
      ['fr', 'Animaux'],
      ['ja', 'ペット'],
    ]);
    expect(all[0]!._count.assignments).toBe(0);
    expect((await ideaTagRepository.listAll('fr'))[0]!.translations.map((t) => t.label)).toEqual([
      'Animaux',
    ]);
    const found = await inTx((tx) => ideaTagRepository.findBySlugs(['pets'], tx, 'ja'));
    expect(found[0]!.translations.map((t) => t.label)).toEqual(['ペット']);
    const foundAll = await inTx((tx) => ideaTagRepository.findBySlugs(['pets'], tx));
    expect(foundAll[0]!.translations).toHaveLength(2);

    expect(await inTx((tx) => ideaTagRepository.clearTagLabelTranslations(tag.id, tx))).toBe(2);
    expect(await adminDb.ideaTagTranslation.count()).toBe(0);
  });
});
