import type {
  IdeaCategory,
  IdeaKind,
  IdeaStatus,
  IdeaTranslationLocale,
} from '@/generated/prisma/client';
import type { IdeaTranslatableField } from '@/lib/ideas/translatableFields';

/**
 * The idea store's DTOs (Story MOTIR-7662) — two contracts in one file, kept
 * apart on purpose:
 *
 *  - the PUBLIC contract (`PublicIdea*Dto`) is what `/api/public/ideas` serves
 *    anonymously and what motir.co builds against. It carries NO status, no
 *    retirement reason, no ids and no audit field — asserted by
 *    `tests/ideas/ideasPublicService.test.ts`. Change it additively only.
 *  - the STAFF contract (`StaffIdea*Dto` and friends) is what the console and the
 *    `motir-ideas` skill read over `/api/platform/ideas`: every status, the
 *    retirement record, the review stamp.
 */

/** A category with its display label. */
export interface IdeaCategoryRefDto {
  slug: IdeaCategory;
  label: string;
}

/** A tag with its display label. */
export interface IdeaTagRefDto {
  slug: string;
  label: string;
}

/** One sourced claim. `sourceDate` is `YYYY-MM-DD`, or null when the source has none. */
export interface IdeaEvidenceDto {
  claim: string;
  sourceName: string;
  url: string;
  sourceDate: string | null;
}

// ── PUBLIC ──────────────────────────────────────────────────────────────────

/** The locale a public read served: English, or one of the eleven translations (`zh-tw`, not `zh_tw`). */
export type PublicIdeaLocaleDto = 'en' | Exclude<IdeaTranslationLocale, 'zh_tw'> | 'zh-tw';

/** A public evidence row; `claimFallback` is true when the claim is the English. */
export interface PublicIdeaEvidenceDto extends IdeaEvidenceDto {
  claimFallback: boolean;
}

/** A public tag reference; `labelFallback` is true when the label is the English. */
export interface PublicIdeaTagRefDto extends IdeaTagRefDto {
  labelFallback: boolean;
}

export interface PublicIdeaDto {
  slug: string;
  title: string;
  pitch: string;
  kind: IdeaKind;
  category: IdeaCategoryRefDto;
  tags: PublicIdeaTagRefDto[];
  capabilities: string[];
  evidence: PublicIdeaEvidenceDto[];
  gap: string | null;
  whyNow: string | null;
  whyMotir: string | null;
  whoElse: string | null;
  addedAt: string;
  lastReviewedAt: string | null;
  /** The locale served (Story MOTIR-7772 · MOTIR-7775). */
  locale: PublicIdeaLocaleDto;
  /** The idea fields shown in English although a translation was asked for. */
  fallbackFields: IdeaTranslatableField[];
}

export interface PublicIdeaCategoryCountDto extends IdeaCategoryRefDto {
  count: number;
}

export interface PublicIdeaListDto {
  items: PublicIdeaDto[];
  /** Counts over every filter EXCEPT `category`, so the chips stay choosable. */
  categories: PublicIdeaCategoryCountDto[];
  total: number;
  /** The locale served. Category labels stay English: motir.co names its own sections. */
  locale: PublicIdeaLocaleDto;
}

export interface PublicIdeaTagDto extends PublicIdeaTagRefDto {
  /** How many ACTIVE ideas carry the tag. */
  count: number;
}

/** `GET /api/public/ideas/tags`. */
export interface PublicIdeaTagListDto {
  tags: PublicIdeaTagDto[];
  locale: PublicIdeaLocaleDto;
}

// ── STAFF ───────────────────────────────────────────────────────────────────

/** Text by non-English locale; a locale with no text is ABSENT (Story MOTIR-7772). */
export type IdeaLocaleTextDto = Partial<Record<IdeaTranslationLocale, string>>;

/** One locale's idea text. A field missing in that locale is absent, never null. */
export interface IdeaTranslationDto {
  title?: string;
  pitch?: string;
  capabilities?: string[];
  gap?: string;
  whyNow?: string;
  whyMotir?: string;
  whoElse?: string;
}

/** A staff evidence row, with its claim in every locale it has one. */
export interface StaffIdeaEvidenceDto extends IdeaEvidenceDto {
  claimTranslations?: IdeaLocaleTextDto;
}

/** A staff tag reference, with its label in every locale it has one. */
export interface StaffIdeaTagRefDto extends IdeaTagRefDto {
  labelTranslations?: IdeaLocaleTextDto;
}

/**
 * The staff idea. The translation fields (Story MOTIR-7772 · MOTIR-7774) are
 * typed OPTIONAL so a hand-built fixture without them still type-checks — the
 * mapper always sets every one of them.
 */
export interface StaffIdeaDto extends Omit<
  PublicIdeaDto,
  'addedAt' | 'evidence' | 'tags' | 'locale' | 'fallbackFields'
> {
  id: string;
  status: IdeaStatus;
  retiredReason: string | null;
  retiredAt: string | null;
  addedAt: string;
  updatedAt: string;
  evidence: StaffIdeaEvidenceDto[];
  tags: StaffIdeaTagRefDto[];
  /** Every locale's text for the idea's own fields. */
  translations?: Partial<Record<IdeaTranslationLocale, IdeaTranslationDto>>;
  /**
   * The locales where any field with English text — the idea's own, an evidence
   * claim, an assigned tag's label — has none. A `capabilities` list counts only
   * at the English list's length.
   */
  missingLocales?: IdeaTranslationLocale[];
}

export interface StaffIdeaListDto {
  items: StaffIdeaDto[];
  /** Pass back as `cursor` for the next page; null on the last one. */
  nextCursor: string | null;
}

export interface StaffIdeaTagDto extends IdeaTagRefDto {
  description: string | null;
  /** Ideas of ANY status carrying the tag. */
  count: number;
  /** The label in every locale it has one; absent when it has none. */
  labelTranslations?: IdeaLocaleTextDto;
}

export interface IdeaResearchRunDto {
  id: string;
  ranAt: string;
  actorUserId: string;
  areasCovered: string[];
  addedCount: number;
  retiredCount: number;
  reportMd: string;
}

export interface AddIdeasResultDto {
  slugs: string[];
}
