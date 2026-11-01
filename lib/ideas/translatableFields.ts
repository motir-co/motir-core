import type { IdeaTranslationLocale } from '@/generated/prisma/client';

/**
 * What of an idea is TRANSLATED, and into which locales (Story MOTIR-7772 ·
 * MOTIR-7773) — ONE list, read by the repositories, the staff write service and
 * the public read service, so none of them re-lists the fields.
 *
 * English lives on the base rows and is required there; a translation is held
 * per locale beside it (`IdeaTranslation`, `IdeaEvidenceTranslation`,
 * `IdeaTagTranslation`). What is NEVER translated: slugs, URLs, source names,
 * source dates, categories' stored keys, figures, and a tag's staff-facing
 * description.
 */

/**
 * The eleven locales a translation may be written in — motir.co's twelve minus `en`.
 * `zh_tw` is Traditional Chinese (Taiwan); the public reads spell it `zh-tw`.
 */
export const IDEA_TRANSLATION_LOCALES = [
  'zh',
  'zh_tw',
  'ja',
  'ko',
  'de',
  'fr',
  'es',
  'it',
  'nl',
  'pl',
  'pt',
] as const satisfies readonly IdeaTranslationLocale[];

export type { IdeaTranslationLocale };

export function isIdeaTranslationLocale(value: unknown): value is IdeaTranslationLocale {
  return (
    typeof value === 'string' && (IDEA_TRANSLATION_LOCALES as readonly string[]).includes(value)
  );
}

/** The idea's own translatable fields, in the order a reader meets them. */
export const IDEA_TRANSLATABLE_FIELDS = [
  'title',
  'pitch',
  'capabilities',
  'gap',
  'whyNow',
  'whyMotir',
  'whoElse',
] as const;

export type IdeaTranslatableField = (typeof IDEA_TRANSLATABLE_FIELDS)[number];

/** The one translated field of an evidence row. */
export const IDEA_EVIDENCE_TRANSLATABLE_FIELD = 'claim' as const;

/** The one translated field of a vocabulary tag. */
export const IDEA_TAG_TRANSLATABLE_FIELD = 'label' as const;

/**
 * One locale's text for an idea's fields. A text field is `null` (or absent)
 * when it is missing in that locale; `capabilities` is the translated list.
 */
export interface IdeaTranslationFields {
  title: string | null;
  pitch: string | null;
  capabilities: string[];
  gap: string | null;
  whyNow: string | null;
  whyMotir: string | null;
  whoElse: string | null;
}

/** The text fields — every translatable field but the `capabilities` list. */
export type IdeaTranslatableTextField = Exclude<IdeaTranslatableField, 'capabilities'>;

/**
 * Whether a field has text in a translation, against its English. A text field
 * is present when it is a non-empty string; `capabilities` is present only when
 * the translated list has exactly the English list's length — the length rule
 * that makes a list whose English changed stale by construction.
 */
export function isTranslatedFieldPresent(
  field: IdeaTranslatableField,
  translation: Partial<IdeaTranslationFields> | null | undefined,
  english: { capabilities: string[] },
): boolean {
  if (!translation) return false;
  if (field === 'capabilities') {
    const list = translation.capabilities ?? [];
    return english.capabilities.length > 0 && list.length === english.capabilities.length;
  }
  const value = translation[field];
  return typeof value === 'string' && value.length > 0;
}
