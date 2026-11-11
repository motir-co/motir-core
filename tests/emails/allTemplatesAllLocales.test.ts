import { describe, expect, it } from 'vitest';
import { getMessagesFor } from '@/lib/i18n/messages';
import { locales, type Locale } from '@/lib/i18n/locales';
import { EMAIL_TEMPLATE_CLASS, type EmailTemplate } from '@/lib/services/emailService';
import type { RenderedEmail } from '@/lib/emailTemplates/types';
import { BCP47, formatDate } from '@/lib/utils/datetime';
import { quotedIn, renderWithQuotes, QUOTED } from './fixtures/recipientLanguage';

// Story MOTIR-7732 · MOTIR-8111, PART B — the WHOLE email in the recipient's
// language. Every template in the `EmailTemplate` union × every one of the
// eleven locales, rendered directly from the shipped templates and catalogues:
// no database, no job, no provider. The template list is the keys of
// `EMAIL_TEMPLATE_CLASS` (a `Record` over the union), so a new template is in
// the matrix the moment it exists — and fails to compile in the fixtures until
// it has props.
//
// PART C's date cases live here too: a deletion date is written the way the
// recipient's language writes dates.

/** Staff mail, English by design: it goes to Motir's team, not a customer.
 *  Empty since the Contact-sales staff email went with its feature
 *  (MOTIR-9386); a staff template added later joins it here. */
const ENGLISH_ONLY = new Set<EmailTemplate>([]);
const TEMPLATES = Object.keys(EMAIL_TEMPLATE_CLASS) as EmailTemplate[];
/** The templates whose email carries no button. */
const NO_BUTTON = new Set<EmailTemplate>(['two-factor-otp', 'organization-erased']);
const NON_ENGLISH = locales.filter((l) => l !== 'en');

/** `password-reset` → `passwordReset`; the invite's namespace is `invite`. */
function namespaceOf(template: EmailTemplate): string {
  if (template === 'workspace-invite') return 'invite';
  return template.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

type Catalogue = Record<string, unknown>;
function emailCatalogue(locale: Locale, template: EmailTemplate): Record<string, string> {
  const ns = (getMessagesFor(locale) as { email: Record<string, Catalogue> }).email[
    namespaceOf(template)
  ];
  const leaves: Record<string, string> = {};
  const walk = (node: unknown, path: string) => {
    if (typeof node === 'string') leaves[path] = node;
    else if (node && typeof node === 'object')
      for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
  };
  walk(ns, '');
  return leaves;
}

/** The literal text of a catalogue message, outside every `{…}` (placeholders,
 *  plural and select blocks): the pieces that reach the email verbatim. */
function literalFragments(message: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of message) {
    if (ch === '{') {
      if (depth === 0 && current.trim()) out.push(current.trim());
      if (depth === 0) current = '';
      depth++;
    } else if (ch === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0) current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** Whitespace as a reader sees it — including the narrow and non-breaking
 *  spaces French puts before a colon, and the zero-width padding the button
 *  primitive wraps its label in. */
const norm = (s: string) =>
  s
    .replace(/[\u200b\u2060\ufeff]/g, '')
    .replace(/[\s\u00a0\u202f]+/g, ' ')
    .trim();

/** An HTML fragment's text, its tags replaced by `sep`. Repeated until nothing
 *  tag-shaped is left, so a tag split around another (`<scr<b>ipt>`) cannot
 *  survive one pass. */
function stripTags(html: string, sep: string): string {
  let prev: string;
  let out = html;
  do {
    prev = out;
    out = out.replace(/<[^>]*>/g, sep);
  } while (out !== prev);
  return out;
}

/** The text of every link in an HTML email. */
function anchorLabels(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)].map((m) =>
    norm(decodeEntities(stripTags(m[1]!, ''))),
  );
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** What a reader sees: the subject, the preview and body (the HTML's text), and
 *  the plain-text part. */
function visible(email: RenderedEmail): string {
  const htmlText = decodeEntities(stripTags(email.html, ' ')).replace(/\s+/g, ' ');
  return [email.subject, htmlText, email.text].join('\n');
}

/** Strip what may legitimately stay English in any language: the product name,
 *  and the quoted content people typed. */
function withoutAllowed(text: string, template: EmailTemplate): string {
  let out = text;
  for (const q of quotedIn(template)) out = out.split(q).join(' ');
  // "Motir AI" before "Motir", so the longer name goes whole.
  return out.replace(/Motir AI/g, ' ').replace(/Motir/g, ' ');
}

const RAW_KEY = /\bemail\.[a-zA-Z]+\.[a-zA-Z]+/;

const renders = new Map<string, Promise<RenderedEmail>>();
function render(template: EmailTemplate, locale: Locale): Promise<RenderedEmail> {
  const key = `${template}:${locale}`;
  if (!renders.has(key)) renders.set(key, renderWithQuotes(template, locale));
  return renders.get(key)!;
}

describe('the matrix', () => {
  it('covers every template in the union', () => {
    expect(TEMPLATES).toHaveLength(19);
    expect([...ENGLISH_ONLY].every((t) => TEMPLATES.includes(t))).toBe(true);
  });
});

describe.each(TEMPLATES.filter((t) => !ENGLISH_ONLY.has(t)))('%s', (template) => {
  it.each([...locales])('in %s: html lang, no raw key, quoted content intact', async (locale) => {
    const email = await render(template, locale);
    expect(email.html).toMatch(new RegExp(`<html[^>]*\\slang="${BCP47[locale]}"`));
    for (const part of [email.subject, email.html, email.text]) expect(part).not.toMatch(RAW_KEY);
    for (const q of quotedIn(template)) {
      expect(email.text, `quoted "${q}" in the text part`).toContain(q);
      expect(visible(email), `quoted "${q}" in the html`).toContain(q);
    }
  });

  it.each(NON_ENGLISH)('in %s: no English catalogue sentence survives', async (locale) => {
    const english = Object.values(emailCatalogue('en', template))
      .flatMap(literalFragments)
      .filter((f) => words(f) >= 3);
    expect(english.length, 'the English catalogue yielded nothing to check').toBeGreaterThan(0);
    const seen = withoutAllowed(visible(await render(template, locale)), template);
    const leaked = english.filter((sentence) => seen.includes(sentence));
    expect(leaked, `English left in the ${locale} ${template} email`).toEqual([]);
  });

  it.each(NON_ENGLISH)(
    'in %s: button labels and plain text are the locale’s own',
    async (locale) => {
      const en = emailCatalogue('en', template);
      const local = emailCatalogue(locale, template);
      // BUTTONS: a catalogue message with no placeholder that is a link's whole
      // label in the English email is a button (or link) label. The same key's
      // message must be a link label in the locale's email.
      const englishLabels = anchorLabels((await render(template, 'en')).html);
      const buttonKeys = Object.keys(en).filter(
        (k) => !en[k]!.includes('{') && englishLabels.includes(norm(en[k]!)),
      );
      // Every template but the two with no call to action has a button, so an
      // empty set here means the label match broke, not that there is none.
      if (!NO_BUTTON.has(template))
        expect(buttonKeys.length, 'no button label found').toBeGreaterThan(0);
      const email = await render(template, locale);
      const labels = anchorLabels(email.html);
      for (const key of buttonKeys) {
        expect(labels, `${locale} ${template}: the "${key}" label`).toContain(norm(local[key]!));
      }
      // PLAIN TEXT: written from the locale's catalogue — its own literal pieces
      // (those that are not also English) are in the text part.
      const englishPieces = new Set(Object.values(en).flatMap(literalFragments).map(norm));
      const ownPieces = Object.values(local)
        .flatMap(literalFragments)
        .map(norm)
        .filter((p) => p.length >= 4 && !englishPieces.has(p));
      const inText = ownPieces.filter((p) => norm(email.text).includes(p));
      expect(
        inText.length,
        `${locale} ${template}: the text part carries the locale’s strings`,
      ).toBeGreaterThanOrEqual(2);
    },
  );
});

describe.each([...ENGLISH_ONLY])('the English-only staff template %s', (template) => {
  it('renders in English with lang="en-US"', async () => {
    const email = await render(template, 'en');
    expect(email.html).toMatch(/<html[^>]*\slang="en-US"/);
    expect(email.text).not.toMatch(RAW_KEY);
  });
});

describe('PART C — dates are written in the recipient’s language', () => {
  const DUE = '2026-10-07T00:00:00.000Z';

  it('the formatter writes the two reference dates', () => {
    expect(formatDate(DUE, 'ja')).toBe('2026年10月7日');
    expect(formatDate(DUE, 'de')).toBe('7. Okt. 2026');
  });

  it.each([
    ['organization-deletion-scheduled', 'dueDate'],
    ['organization-deletion-reminder', 'dueDate'],
    ['agents-deletion-scheduled', 'deletionDate'],
  ] as const)('%s carries the localized date, never the US form', async (template, field) => {
    for (const [locale, expected] of [
      ['ja', '2026年10月7日'],
      ['de', '7. Okt. 2026'],
    ] as const) {
      const email = await renderWithQuotes(template, locale, {
        [field]: formatDate(DUE, locale),
      });
      expect(email.text).toContain(expected);
      expect(visible(email)).toContain(expected);
      expect(visible(email)).not.toContain('Oct 7, 2026');
    }
  });

  it('quoted names in a dated email stay as written', async () => {
    const email = await renderWithQuotes('agents-deletion-scheduled', 'ja');
    expect(email.text).toContain(QUOTED.agentName);
    expect(email.text).toContain(QUOTED.organizationName);
  });
});
