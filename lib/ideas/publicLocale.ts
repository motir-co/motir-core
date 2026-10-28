import {
  IDEA_TRANSLATABLE_FIELDS,
  isIdeaTranslationLocale,
  isTranslatedFieldPresent,
  type IdeaTranslatableField,
  type IdeaTranslationFields,
  type IdeaTranslationLocale,
} from './translatableFields';

/**
 * The PUBLIC read's locale (Story MOTIR-7772 · MOTIR-7775): which language an
 * anonymous reader asked for, and the per-field merge of that language over the
 * English. Pure functions over rows the repository already returned, so all
 * three public reads share them and they are tested without HTTP.
 *
 * PER FIELD, NEVER PER IDEA: one untranslated claim leaves the rest of the idea
 * in the reader's language. Every field shown in English although a translation
 * was asked for is NAMED, so motir.co can mark exactly those `lang="en"`.
 */

/** The locale a public read serves: English, or one of the eleven translations. */
export type PublicIdeaLocale = 'en' | IdeaTranslationLocale;

/** A served locale as the public contract spells it: `zh_tw` is `zh-tw`, as motir.co's URLs are. */
export type PublicIdeaLocaleCode = 'en' | Exclude<IdeaTranslationLocale, 'zh_tw'> | 'zh-tw';

/**
 * The served locale for a raw `?locale=` value. One of the eleven public codes
 * (`zh-tw` for Traditional Chinese) is served as itself; `en`, nothing, an empty
 * string, an unknown code or a differently-cased one is English. It NEVER throws:
 * an unsupported locale is answered in English, not refused.
 */
export function resolvePublicIdeaLocale(raw: string | null | undefined): PublicIdeaLocale {
  if (raw === 'zh-tw') return 'zh_tw';
  return raw !== 'zh_tw' && isIdeaTranslationLocale(raw) ? raw : 'en';
}

/** The public code for a served locale. */
export function publicIdeaLocaleCode(locale: PublicIdeaLocale): PublicIdeaLocaleCode {
  return locale === 'zh_tw' ? 'zh-tw' : locale;
}

/** An idea's translatable fields as served. */
export type LocalizedIdeaFields = IdeaTranslationFields & { title: string; pitch: string };

export interface LocalizedIdea {
  fields: LocalizedIdeaFields;
  /** The fields served in English although a translation was asked for. */
  fallbackFields: IdeaTranslatableField[];
}

/** The English an idea is localized over, plus its rows for the requested locale. */
export interface LocalizableIdea extends LocalizedIdeaFields {
  translations: ({ locale: IdeaTranslationLocale } & IdeaTranslationFields)[];
}

/**
 * Merge the requested locale's translation over the English, field by field.
 * A field falls back when its translation is missing — null, or a
 * `capabilities` list whose length is not the English list's (the empty list
 * included). A field whose ENGLISH is empty stays empty and is never listed: in
 * that case nothing was missing.
 */
export function localizeIdea(row: LocalizableIdea, locale: PublicIdeaLocale): LocalizedIdea {
  const english: LocalizedIdeaFields = {
    title: row.title,
    pitch: row.pitch,
    capabilities: [...row.capabilities],
    gap: row.gap,
    whyNow: row.whyNow,
    whyMotir: row.whyMotir,
    whoElse: row.whoElse,
  };
  if (locale === 'en') return { fields: english, fallbackFields: [] };

  const translation = row.translations.find((t) => t.locale === locale) ?? null;
  const fields = { ...english };
  const fallbackFields: IdeaTranslatableField[] = [];
  for (const field of IDEA_TRANSLATABLE_FIELDS) {
    const hasEnglish =
      field === 'capabilities' ? english.capabilities.length > 0 : Boolean(english[field]);
    if (!hasEnglish) continue;
    if (!isTranslatedFieldPresent(field, translation, english)) {
      fallbackFields.push(field);
      continue;
    }
    if (field === 'capabilities') fields.capabilities = [...translation!.capabilities];
    else fields[field] = translation![field]!;
  }
  return { fields, fallbackFields };
}

/** One piece of text as served, and whether it is the English. */
export interface LocalizedText {
  text: string;
  fallback: boolean;
}

function localizeText(
  english: string,
  translations: { locale: IdeaTranslationLocale; text: string }[],
  locale: PublicIdeaLocale,
): LocalizedText {
  if (locale === 'en') return { text: english, fallback: false };
  const found = translations.find((t) => t.locale === locale && t.text.length > 0);
  return found ? { text: found.text, fallback: false } : { text: english, fallback: true };
}

/** An evidence claim in the requested locale, or its English. */
export function localizeClaim(
  evidence: { claim: string; translations: { locale: IdeaTranslationLocale; claim: string }[] },
  locale: PublicIdeaLocale,
): LocalizedText {
  return localizeText(
    evidence.claim,
    evidence.translations.map((t) => ({ locale: t.locale, text: t.claim })),
    locale,
  );
}

/** A tag label in the requested locale, or its English. */
export function localizeLabel(
  tag: { label: string; translations: { locale: IdeaTranslationLocale; label: string }[] },
  locale: PublicIdeaLocale,
): LocalizedText {
  return localizeText(
    tag.label,
    tag.translations.map((t) => ({ locale: t.locale, text: t.label })),
    locale,
  );
}
