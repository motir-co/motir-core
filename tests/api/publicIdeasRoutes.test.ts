import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as listGET } from '@/app/api/public/ideas/route';
import { GET as detailGET } from '@/app/api/public/ideas/[slug]/route';
import { GET as tagsGET } from '@/app/api/public/ideas/tags/route';
import { ideasAdminService } from '@/lib/services/ideasAdminService';
import { ideasPublicService } from '@/lib/services/ideasPublicService';
import { runAsCloudBuild } from '../helpers/cloudBuild';
import { truncateAuthTables } from '../helpers/db';
import { stripSourceComments } from '../helpers/stripSourceComments';
import { directionInput, motirBuysInput, seedTags, staffActor } from '../ideas/_helpers';

// The idea store's PUBLIC routes (Story MOTIR-7662 · MOTIR-7676), anonymous,
// over real Postgres: the DTOs with the cache header, each filter forwarded, the
// 400 and 404 answers, the cloud gate, and no session read in any of the three.

runAsCloudBuild();

const CACHE = 'public, s-maxage=300, stale-while-revalidate=3300';

async function seed(): Promise<void> {
  await seedTags('smb', 'consumer');
  const actor = await staffActor('operator');
  await ideasAdminService.addIdeas(actor, [
    motirBuysInput('legal-team', { tags: ['smb'] }),
    directionInput('store-visibility', { category: 'ecommerce', tags: ['smb'] }),
    directionInput('pet-clinics', { category: 'pets', tags: ['smb', 'consumer'] }),
    directionInput('gone', { category: 'pets', tags: ['consumer'] }),
  ]);
  await ideasAdminService.retireIdea(actor, 'gone', 'Merged into pet-clinics');
}

const get = (path: string) => new Request(`https://app.motir.co/api/public/ideas${path}`);
const slugCtx = (slug: string) => ({ params: Promise.resolve({ slug }) });

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await truncateAuthTables();
});

describe('GET /api/public/ideas', () => {
  it('answers anonymously with the active list, its counts and the cache header', async () => {
    await seed();
    const res = await listGET(get(''));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(CACHE);
    const body = await res.json();
    expect(body.total).toBe(3);
    expect(body.items.map((i: { slug: string }) => i.slug)).not.toContain('gone');
    expect(body.items[0]).not.toHaveProperty('status');
  });

  it('forwards category, repeated tag, q and kind', async () => {
    await seed();
    const slugs = async (qs: string) =>
      ((await (await listGET(get(qs))).json()) as { items: { slug: string }[] }).items.map(
        (i) => i.slug,
      );
    expect(await slugs('?category=pets')).toEqual(['pet-clinics']);
    expect((await slugs('?tag=smb')).sort()).toEqual([
      'legal-team',
      'pet-clinics',
      'store-visibility',
    ]);
    expect(await slugs('?tag=smb&tag=consumer')).toEqual(['pet-clinics']);
    expect(await slugs('?q=STORE-visibility')).toEqual(['store-visibility']);
    expect(await slugs('?kind=motir_buys')).toEqual(['legal-team']);
    expect(await slugs('?tag=unknown')).toEqual([]);
  });

  it('answers 400 for a category or kind outside the closed set, uncached', async () => {
    for (const qs of ['?category=astrology', '?kind=maybe']) {
      const res = await listGET(get(qs));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ code: 'INVALID_IDEA_FILTER' });
      expect(res.headers.get('cache-control')).not.toBe(CACHE);
    }
  });
});

describe('GET /api/public/ideas/tags', () => {
  it('counts active ideas only', async () => {
    await seed();
    const res = await tagsGET(get('/tags'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(CACHE);
    expect(await res.json()).toEqual({
      tags: [
        { slug: 'consumer', label: 'CONSUMER', labelFallback: false, count: 1 },
        { slug: 'smb', label: 'SMB', labelFallback: false, count: 3 },
      ],
      locale: 'en',
    });
  });
});

describe('GET /api/public/ideas/{slug}', () => {
  it('answers one active idea', async () => {
    await seed();
    const res = await detailGET(get('/pet-clinics'), slugCtx('pet-clinics'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(CACHE);
    expect(await res.json()).toMatchObject({ slug: 'pet-clinics', category: { slug: 'pets' } });
  });

  it('answers the SAME 404 for an unknown slug and a retired one', async () => {
    await seed();
    const unknown = await detailGET(get('/never-was'), slugCtx('never-was'));
    const retired = await detailGET(get('/gone'), slugCtx('gone'));
    expect([unknown.status, retired.status]).toEqual([404, 404]);
    expect(await unknown.json()).toEqual({ code: 'IDEA_NOT_FOUND' });
    expect(await retired.json()).toEqual({ code: 'IDEA_NOT_FOUND' });
  });
});

describe('an unexpected failure', () => {
  it('propagates from the slug read as a 500, never as a 404', async () => {
    const spy = vi
      .spyOn(ideasPublicService, 'getBySlug')
      .mockRejectedValueOnce(new Error('db down'));
    await expect(detailGET(get('/x'), slugCtx('x'))).rejects.toThrow('db down');
    spy.mockRestore();
  });

  it('propagates from the list as a 500, including the cap being reached', async () => {
    const spy = vi
      .spyOn(ideasPublicService, 'listActive')
      .mockRejectedValueOnce(new Error('cap reached'));
    await expect(listGET(get(''))).rejects.toThrow('cap reached');
    spy.mockRestore();
  });

  it('propagates from the tags read as a 500 — only a lost connection is a 503', async () => {
    const spy = vi
      .spyOn(ideasPublicService, 'listTags')
      .mockRejectedValueOnce(new Error('db down'));
    await expect(tagsGET(get('/tags'))).rejects.toThrow('db down');
    spy.mockRestore();
  });
});

describe('posture', () => {
  it('answers as an absent capability on a self-hosted build', async () => {
    const previous = process.env['MOTIR_CLOUD'];
    delete process.env['MOTIR_CLOUD'];
    try {
      for (const res of [
        await listGET(get('')),
        await tagsGET(get('/tags')),
        await detailGET(get('/x'), slugCtx('x')),
      ]) {
        expect(res.status).toBe(404);
      }
    } finally {
      process.env['MOTIR_CLOUD'] = previous;
    }
  });

  it('reads no session in any of the three handlers', () => {
    for (const file of ['route.ts', 'tags/route.ts', '[slug]/route.ts']) {
      const source = stripSourceComments(
        readFileSync(join(process.cwd(), 'app/api/public/ideas', file), 'utf8'),
      );
      expect(source, file).not.toMatch(/getSession|requireCompliantSession/);
    }
  });
});

// ── ?locale= (Story MOTIR-7772 · MOTIR-7775) ────────────────────────────────

describe('?locale=', () => {
  async function seedJa() {
    const actor = await staffActor('operator');
    await ideasAdminService.addTag(actor, {
      slug: 'pets',
      label: 'Pets',
      description: 'Pet businesses.',
      labelTranslations: { ja: 'ペット' },
    });
    await ideasAdminService.addIdeas(actor, [
      directionInput('clinic', {
        category: 'pets',
        tags: ['pets'],
        translations: { ja: { title: '動物病院' } },
      }),
    ]);
  }

  it('forwards the locale on each route', async () => {
    await seedJa();
    const list = await (await listGET(get('?locale=ja'))).json();
    expect(list.locale).toBe('ja');
    expect(list.items[0]).toMatchObject({ title: '動物病院', locale: 'ja' });
    expect(list.items[0].fallbackFields).toContain('pitch');

    const one = await (await detailGET(get('/clinic?locale=ja'), slugCtx('clinic'))).json();
    expect(one).toMatchObject({ title: '動物病院', locale: 'ja' });

    const tags = await (await tagsGET(get('/tags?locale=ja'))).json();
    expect(tags).toEqual({
      tags: [{ slug: 'pets', label: 'ペット', labelFallback: false, count: 1 }],
      locale: 'ja',
    });
  });

  it('localizes the category label on the list, its category list and one idea (MOTIR-8082)', async () => {
    await seedJa();
    for (const [locale, label] of [
      ['zh', '宠物'],
      ['ko', '반려동물'],
    ] as const) {
      const list = await (await listGET(get(`?locale=${locale}`))).json();
      expect(list.items[0].category).toEqual({ slug: 'pets', label });
      expect(list.categories).toEqual([{ slug: 'pets', label, count: 1 }]);
      const one = await (
        await detailGET(get(`/clinic?locale=${locale}`), slugCtx('clinic'))
      ).json();
      expect(one.category).toEqual({ slug: 'pets', label });
    }
    // The filter value is the slug in every locale.
    const filtered = await (await listGET(get('?locale=zh&category=pets'))).json();
    expect(filtered.total).toBe(1);
  });

  it('serves Traditional Chinese at ?locale=zh-tw, and names it zh-tw on every route', async () => {
    const actor = await staffActor('operator');
    await ideasAdminService.addTag(actor, {
      slug: 'pets',
      label: 'Pets',
      description: 'Pet businesses.',
      labelTranslations: { zh_tw: '寵物' },
    });
    await ideasAdminService.addIdeas(actor, [
      directionInput('clinic', {
        category: 'pets',
        tags: ['pets'],
        translations: { zh_tw: { title: '動物醫院' } },
      }),
    ]);
    const list = await (await listGET(get('?locale=zh-tw'))).json();
    expect(list.locale).toBe('zh-tw');
    expect(list.items[0]).toMatchObject({ title: '動物醫院', locale: 'zh-tw' });
    expect(list.items[0].category).toEqual({ slug: 'pets', label: '寵物' });
    const one = await (await detailGET(get('/clinic?locale=zh-tw'), slugCtx('clinic'))).json();
    expect(one).toMatchObject({ title: '動物醫院', locale: 'zh-tw' });
    const tags = await (await tagsGET(get('/tags?locale=zh-tw'))).json();
    expect(tags).toEqual({
      tags: [{ slug: 'pets', label: '寵物', labelFallback: false, count: 1 }],
      locale: 'zh-tw',
    });
  });

  it('keeps the English category label for an unsupported locale (MOTIR-8082)', async () => {
    await seedJa();
    const list = await (await listGET(get('?locale=xx'))).json();
    expect(list.items[0].category).toEqual({ slug: 'pets', label: 'Pets' });
    expect(list.categories[0].label).toBe('Pets');
  });

  it('answers an unsupported or differently-cased locale in English, 200', async () => {
    await seedJa();
    for (const qs of ['?locale=xx', '?locale=JA', '?locale=en', '?locale=']) {
      const res = await listGET(get(qs));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.locale).toBe('en');
      expect(body.items[0]).toMatchObject({ title: 'Direction clinic', fallbackFields: [] });
    }
  });

  it('ignores Accept-Language: identical bodies, the same cache header, no Vary on it', async () => {
    await seedJa();
    const withHeader = (path: string, lang: string) =>
      new Request(`https://app.motir.co/api/public/ideas${path}`, {
        headers: { 'accept-language': lang },
      });
    for (const [path, call] of [
      ['?locale=ja', (r: Request) => listGET(r)],
      ['/clinic', (r: Request) => detailGET(r, slugCtx('clinic'))],
      ['/tags', (r: Request) => tagsGET(r)],
    ] as const) {
      const a = await call(withHeader(path, 'ja'));
      const b = await call(withHeader(path, 'de-DE,de;q=0.9'));
      expect(await a.text()).toBe(await b.text());
      for (const res of [a, b]) {
        expect(res.headers.get('cache-control')).toBe(CACHE);
        expect(res.headers.get('vary') ?? '').not.toMatch(/accept-language/i);
      }
    }
  });
});
