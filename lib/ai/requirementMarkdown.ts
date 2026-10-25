import type { RequirementRecommendation, SubmittedRequirement } from '@/lib/ai/types';

// The pure half of the requirement page (Story MOTIR-9430 · MOTIR-9433): a confirmed
// `SubmittedRequirement` as the markdown body of a page. Six `##` sections in the
// contract's canonical order, then ONE provenance line. No I/O and no clock — the
// caller passes the time and the conversation's label, so the same input always
// renders the same page.

/** The languages the page is written in. Any other interface language falls back to en. */
export type RequirementPageLocale = 'en' | 'zh';

export function requirementPageLocale(locale: string | null | undefined): RequirementPageLocale {
  return locale === 'zh' ? 'zh' : 'en';
}

const LABELS: Record<
  RequirementPageLocale,
  {
    headings: [string, string, string, string, string, string];
    none: string;
    fallbackTitle: string;
    provenance: (conversation: string, date: string) => string;
  }
> = {
  en: {
    headings: ['Outcome', 'Behaviour', 'Scope edge', 'Constraints', 'Acceptance', 'Assumptions'],
    none: 'None.',
    fallbackTitle: 'Requirement',
    provenance: (conversation, date) =>
      `Composed by Motir AI in the conversation "${conversation}" on ${date}.`,
  },
  zh: {
    headings: ['成果', '行为', '范围边界', '约束', '验收', '假设'],
    none: '无。',
    fallbackTitle: '需求',
    provenance: (conversation, date) => `由 Motir AI 于 ${date} 在对话“${conversation}”中整理。`,
  },
};

/** The localized title used when the request text has no first line to take. */
export function requirementFallbackTitle(locale: RequirementPageLocale): string {
  return LABELS[locale].fallbackTitle;
}

/** One assumption as the page lists it. */
export interface RequirementAssumption {
  id: string;
  text: string;
}

/**
 * The assumptions as `{ id, text }`: a bare string is ONE entry, an entry with no id
 * takes `r<position>` (the reader convention `RequirementRecommendation` documents),
 * and a blank entry is dropped before positions are counted.
 */
export function normaliseAssumptions(
  assumptions: SubmittedRequirement['assumptions'],
): RequirementAssumption[] {
  const entries: (string | RequirementRecommendation)[] =
    typeof assumptions === 'string' ? [assumptions] : (assumptions ?? []);
  const out: RequirementAssumption[] = [];
  for (const entry of entries) {
    const text = (typeof entry === 'string' ? entry : entry.text).trim();
    if (!text) continue;
    const id = typeof entry === 'string' ? undefined : entry.id?.trim();
    out.push({ id: id || `r${out.length + 1}`, text });
  }
  return out;
}

export interface RenderRequirementOptions {
  locale: RequirementPageLocale;
  /** The conversation's title, or its id when it has none. */
  conversationLabel: string;
  /** When the requirement was confirmed. Rendered as a UTC date. */
  at: Date;
}

/** A requirement as the page's markdown body. */
export function renderRequirementMarkdown(
  requirement: SubmittedRequirement,
  { locale, conversationLabel, at }: RenderRequirementOptions,
): string {
  const labels = LABELS[locale];
  const [outcome, behaviour, scopeEdge, constraints, acceptance, assumptionsHeading] =
    labels.headings;
  // Blank scope edge and constraints mean "considered, nothing to say".
  const prose = (value: string | undefined, blankIsNone: boolean): string => {
    const text = (value ?? '').trim();
    return text || (blankIsNone ? labels.none : '');
  };
  const assumptions = normaliseAssumptions(requirement.assumptions);
  const sections: [string, string][] = [
    [outcome, prose(requirement.outcome, false)],
    [behaviour, prose(requirement.behaviour, false)],
    [scopeEdge, prose(requirement.scopeEdge, true)],
    [constraints, prose(requirement.constraints, true)],
    [acceptance, prose(requirement.acceptance, false)],
    [
      assumptionsHeading,
      assumptions.length > 0
        ? assumptions.map((a) => `- [${a.id}] ${a.text}`).join('\n')
        : labels.none,
    ],
  ];
  const body = sections
    .map(([heading, text]) => (text ? `## ${heading}\n\n${text}` : `## ${heading}`))
    .join('\n\n');
  const date = at.toISOString().slice(0, 10);
  return `${body}\n\n${labels.provenance(conversationLabel.trim(), date)}\n`;
}
