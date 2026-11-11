import { describe, expect, it } from 'vitest';
import { EMAIL_TEMPLATE_CLASS, type EmailTemplate } from '@/lib/services/emailService';
import { renderFixture } from '../helpers/emailTemplateFixtures';

// MOTIR-10964 — the "You're receiving this because…" line is real content: it
// tells the recipient why the email came and is what they act on to stop it, so
// WCAG 2.1 SC 1.4.3 applies to it (4.5:1 at its 12px). Four templates painted it
// #9ca3af on EmailLayout's white body, 2.54:1. They now use #6b7280 (4.83:1), the
// grey the same templates already use for the fallback label.
//
// The line is found by its TEXT in every template's rendered HTML, not by the
// template's name, so a template added later that carries a reason line is held
// to the same bar the moment it renders one.

/** EmailLayout's body (`lib/emailTemplates/_components/EmailLayout.tsx`). */
const BODY_BG = '#ffffff';
/** SC 1.4.3 for normal-size text; 12px is nowhere near "large". */
const AA_NORMAL_TEXT = 4.5;
/** The grey the card's direction names, already used for the fallback label. */
const REASON_GREY = '#6b7280';

/** The templates that carry a reason line, as shipped at MOTIR-10964. */
const WITH_REASON_LINE = new Set<EmailTemplate>([
  'watcher-comment-notification',
  'watcher-transition-notification',
  'filter-subscription',
  'automation-rule-failed',
]);

const TEMPLATES = Object.keys(EMAIL_TEMPLATE_CLASS) as EmailTemplate[];

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/** The inline `color` of every paragraph whose text opens the reason line. */
function reasonLineColours(html: string): string[] {
  const colours: string[] = [];
  for (const [, style = '', inner = ''] of html.matchAll(
    /<p\b[^>]*\bstyle="([^"]*)"[^>]*>([\s\S]*?)<\/p>/g,
  )) {
    const text = decodeEntities(inner.replace(/<[^>]+>/g, '')).trim();
    if (!/^You[’']re receiving this because/.test(text)) continue;
    const colour = /(?:^|;)\s*color\s*:\s*(#[0-9a-f]{6})\b/i.exec(style)?.[1];
    colours.push((colour ?? 'none').toLowerCase());
  }
  return colours;
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r = 0, g = 0, b = 0] = channels.map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
  const [hi = 0, lo = 0] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('the "You\'re receiving this because…" reason line', () => {
  it('measures the old and new greys the way the card does', () => {
    expect(contrastRatio('#9ca3af', BODY_BG)).toBeCloseTo(2.54, 2);
    expect(contrastRatio(REASON_GREY, BODY_BG)).toBeCloseTo(4.83, 2);
  });

  it.each([...WITH_REASON_LINE])(
    '%s renders exactly one reason line, in #6b7280',
    async (template) => {
      const { html } = await renderFixture(template);
      expect(reasonLineColours(html)).toEqual([REASON_GREY]);
    },
  );

  it.each(TEMPLATES)(
    '%s paints any reason line it has at AA on the white body',
    async (template) => {
      const { html } = await renderFixture(template);
      for (const colour of reasonLineColours(html)) {
        expect(colour).not.toBe('none');
        expect(contrastRatio(colour, BODY_BG)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      }
    },
  );
});
