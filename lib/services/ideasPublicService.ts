import 'server-only';

import type { IdeaCategory, IdeaKind } from '@/generated/prisma/client';
import type { PublicIdeaDto, PublicIdeaListDto, PublicIdeaTagDto } from '@/lib/dto/ideas';
import {
  IDEA_CATEGORIES,
  ideaCategoryLabel,
  isIdeaCategory,
  isIdeaKind,
} from '@/lib/ideas/categories';
import {
  IdeaListCapExceededError,
  IdeaNotFoundError,
  IdeasUnavailableError,
  InvalidIdeaFilterError,
} from '@/lib/ideas/errors';
import {
  localizeLabel,
  publicIdeaLocaleCode,
  type PublicIdeaLocale,
} from '@/lib/ideas/publicLocale';
import type { PublicIdeaFilters } from '@/lib/ideas/types';
import { toPublicIdeaDto } from '@/lib/mappers/ideaMappers';
import { isConnectionError, retryReadOnceOnConnectionError } from '@/lib/prisma/connectionError';
import {
  ideaPublicRepository,
  type PublicIdeaQuery,
} from '@/lib/repositories/ideaPublicRepository';

/**
 * The idea store's PUBLIC read service (Story MOTIR-7662 · MOTIR-7672) — what
 * `/api/public/ideas` serves anonymously and motir.co renders.
 *
 * UNPAGINATED BY DESIGN. The store is curated — 15 today, growing by 5–10 a
 * research run, with retirements — so a full read stays in the low hundreds,
 * and a page that renders categories as sections needs the whole filtered set.
 * The read is capped at `PUBLIC_IDEA_LIST_CAP` and the service THROWS when the
 * cap is reached, so the day pagination is owed it announces itself instead of
 * truncating silently.
 *
 * EVERY READ TAKES A LOCALE (Story MOTIR-7772 · MOTIR-7775), resolved by the
 * route from `?locale=` alone (`resolvePublicIdeaLocale`). It loads that
 * locale's translations and serves each field in it where it has text, in
 * English elsewhere, naming the English ones. `'en'` loads none and serves the
 * English as before.
 */
export const PUBLIC_IDEA_LIST_CAP = 500;

/**
 * Every public read goes through here (MOTIR-8350). A connection the pool hands
 * out can already be dead — Neon's pooler, a compute restart or an idle cut
 * closed it, and the pool has not processed the close yet — and the read then
 * fails with `Connection terminated unexpectedly`. One retry takes a fresh
 * connection and answers. A second connection failure is an outage, and is
 * named, so the route answers a handled 503 rather than an unhandled 500.
 * These reads write nothing, so repeating one is always safe.
 */
async function publicRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await retryReadOnceOnConnectionError(read);
  } catch (err) {
    if (isConnectionError(err)) throw new IdeasUnavailableError(err);
    throw err;
  }
}

/** Both results once BOTH have settled; the first failure, in order, is thrown. */
async function bothSettled<A, B>(a: Promise<A>, b: Promise<B>): Promise<[A, B]> {
  const [first, second] = await Promise.allSettled([a, b]);
  if (first.status === 'rejected') throw first.reason;
  if (second.status === 'rejected') throw second.reason;
  return [first.value, second.value];
}

/** The longest free-text query honoured; longer input is cut, not refused. */
export const PUBLIC_IDEA_QUERY_MAX = 200;

function parseFilters(filters: PublicIdeaFilters): PublicIdeaQuery {
  let category: IdeaCategory | undefined;
  if (filters.category !== undefined && filters.category !== '') {
    if (!isIdeaCategory(filters.category)) throw new InvalidIdeaFilterError('category');
    category = filters.category;
  }
  let kind: IdeaKind | undefined;
  if (filters.kind !== undefined && filters.kind !== '') {
    if (!isIdeaKind(filters.kind)) throw new InvalidIdeaFilterError('kind');
    kind = filters.kind;
  }
  const tags = [...new Set((filters.tags ?? []).map((t) => t.trim()).filter((t) => t.length > 0))];
  const q = filters.q?.trim().slice(0, PUBLIC_IDEA_QUERY_MAX) || undefined;
  return { category, kind, tags, q };
}

export const ideasPublicService = {
  /**
   * Active ideas narrowed by any combination of category, tags (all must
   * match), text and kind — with per-category counts computed over every filter
   * EXCEPT the category, so the chips stay choosable.
   *
   * @throws InvalidIdeaFilterError for a category or kind outside the closed set.
   *   An unknown TAG is not an error: it simply matches nothing.
   * @throws IdeaListCapExceededError when the read reaches the cap.
   * @throws IdeasUnavailableError when the database connection drops twice.
   */
  async listActive(
    filters: PublicIdeaFilters = {},
    locale: PublicIdeaLocale = 'en',
  ): Promise<PublicIdeaListDto> {
    const query = parseFilters(filters);
    const translated = locale === 'en' ? undefined : locale;
    // Each read is retried on its own, and the pair is SETTLED before either
    // failure is thrown: a sibling still running when the request answers would
    // hold a connection the pool has already been asked to replace.
    const [rows, counts] = await bothSettled(
      publicRead(() =>
        ideaPublicRepository.listActive(query, PUBLIC_IDEA_LIST_CAP + 1, translated),
      ),
      publicRead(() =>
        ideaPublicRepository.categoryCounts({ ...query, category: undefined }, translated),
      ),
    );
    if (rows.length > PUBLIC_IDEA_LIST_CAP)
      throw new IdeaListCapExceededError(PUBLIC_IDEA_LIST_CAP);

    const byCategory = new Map(counts.map((c) => [c.category, c.count]));
    return {
      items: rows.map((row) => toPublicIdeaDto(row, locale)),
      categories: IDEA_CATEGORIES.filter((c) => (byCategory.get(c) ?? 0) > 0).map((c) => ({
        slug: c,
        label: ideaCategoryLabel(c, locale),
        count: byCategory.get(c)!,
      })),
      total: rows.length,
      locale: publicIdeaLocaleCode(locale),
    };
  },

  /** Every tag in use on an active idea, with its active count, labelled in `locale`. */
  async listTags(locale: PublicIdeaLocale = 'en'): Promise<PublicIdeaTagDto[]> {
    const rows = await publicRead(() =>
      ideaPublicRepository.tagCounts(locale === 'en' ? undefined : locale),
    );
    return rows.map((r) => {
      const label = localizeLabel(
        {
          label: r.label,
          translations:
            locale !== 'en' && r.translatedLabel !== null
              ? [{ locale, label: r.translatedLabel }]
              : [],
        },
        locale,
      );
      return { slug: r.slug, label: label.text, labelFallback: label.fallback, count: r.count };
    });
  },

  /**
   * One active idea. An unknown slug and a retired one throw the SAME error, so
   * a public reader cannot tell a retired idea ever existed.
   */
  async getBySlug(slug: string, locale: PublicIdeaLocale = 'en'): Promise<PublicIdeaDto> {
    const row = await publicRead(() =>
      ideaPublicRepository.findActiveBySlug(slug, locale === 'en' ? undefined : locale),
    );
    if (!row) throw new IdeaNotFoundError(slug);
    return toPublicIdeaDto(row, locale);
  },
};
