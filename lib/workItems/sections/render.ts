import type { IssueType } from '@/lib/issues/parentRules';
import {
  SECTION_CATALOGUE,
  sectionSetFor,
  type SectionName,
  type SectionType,
  type WorkItemSections,
} from '@/lib/workItems/sections/registry';

// THE RENDERER (Story MOTIR-9023 · Subtask MOTIR-9027).
//
// Turns a sections INPUT — what an agent hands a write door — into the free-text
// Markdown the door then stores as `descriptionMd`. It runs on WRITE only; its
// string is the only artifact, nothing structured survives the call, and no
// reader or job calls it to regenerate a stored body.
//
// The parsers are its specification (`splitPlanBody`, `acceptanceCriteriaTexts`,
// `extractScopeBoundary`): fed this output, each returns exactly the sections it
// was rendered from. No section's text can leak into another or end one early —
// a heading-shaped line inside a section value is neutralised with a backslash
// (the text survives, only its heading role is removed), and `framing` is
// rendered as unheaded body text above every heading, so a pasted `| ` gutter
// hides nothing.
//
// PURE + deterministic. Does not validate: that is `checkSections`' job at the
// door, before this is called. Headings and section order come from the
// registry; this module types no heading literal.

export interface RenderOptions {
  /** When given, `**Difficulty: <level>** — <reason>` goes directly above the
   *  boundary heading, where the walk requires it. */
  difficulty?: { level: string; reason: string };
}

/** An ATX heading, including one indented up to three spaces. */
const HEADING_LIKE = /^\s{0,3}#{1,6}\s/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const MARKDOWN_LINK_REF = /^\[[^\]]*\]\((?:motir|motir-ref):[^)]*\)/;

/** Neutralise heading-shaped lines in a section value, leaving fenced code alone. */
function neutralise(text: string): string {
  let fence: string | null = null;
  return text
    .split('\n')
    .map((line) => {
      const fenceMatch = FENCE.exec(line);
      if (fenceMatch) {
        const marker = (fenceMatch[1] as string)[0] as string;
        if (fence === null) fence = marker;
        else if (fence === marker) fence = null;
        return line;
      }
      if (fence !== null) return line;
      return HEADING_LIKE.test(line) ? `\\${line.trimStart()}` : line;
    })
    .join('\n');
}

/** One list item: continuation lines are indented so the item stays one bullet. */
function bullet(text: string): string {
  const [first = '', ...rest] = neutralise(text.trim()).split('\n');
  return [`- ${first}`, ...rest.map((line) => (line.length > 0 ? `  ${line}` : ''))].join('\n');
}

function refText(ref: string): string {
  const value = ref.trim();
  if (MARKDOWN_LINK_REF.test(value) || /^`[^`]+`$/.test(value)) return value;
  return `\`${value}\``;
}

const CHOICE_SITUATION_WORDS = (id: string): string => id.replace(/_/g, ' ');

function renderValue(name: SectionName, value: unknown): string {
  switch (name) {
    case 'acceptanceCriteria':
    case 'states':
    case 'assumptions':
    case 'alternatives':
    case 'consumers':
      return (value as string[]).map(bullet).join('\n');
    case 'contextRefs':
      return (value as { ref: string; why: string }[])
        .map(({ ref, why }) => bullet(`${refText(ref)} — ${why.trim()}`))
        .join('\n');
    case 'options':
      return (value as { label: string; cost: string; forecloses: string }[])
        .map(({ label, cost, forecloses }) =>
          bullet(`**${label.trim()}** — cost: ${cost.trim()} · forecloses: ${forecloses.trim()}`),
        )
        .join('\n');
    case 'choiceOptions':
      return (value as { label: string; bestFor: string; why?: string }[])
        .map(({ label, bestFor, why }) => {
          const lines = [`### ${label.trim()}`, `**Best if you want:** ${bestFor.trim()}`];
          if (why && why.trim().length > 0) lines.push(neutralise(why.trim()));
          return lines.join('\n');
        })
        .join('\n\n');
    case 'why': {
      const { situation, youSaid, evidence } = value as {
        situation: string;
        youSaid?: string;
        evidence: string;
      };
      const lines = [`**Situation:** ${CHOICE_SITUATION_WORDS(situation)}`];
      if (youSaid && youSaid.trim().length > 0) lines.push(`**You said:** "${youSaid.trim()}"`);
      lines.push(neutralise(evidence.trim()));
      return lines.join('\n');
    }
    case 'cases':
      return (value as { condition: string; expected: string }[])
        .map(({ condition, expected }) => bullet(`${condition.trim()} → ${expected.trim()}`))
        .join('\n');
    case 'strings':
      return (value as { key: string; locale: string; says: string }[])
        .map(({ key, locale, says }) =>
          bullet(`\`${key.trim()}\` (${locale.trim()}) — ${says.trim()}`),
        )
        .join('\n');
    default:
      return neutralise(String(value).trim());
  }
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** Render a sections input into the free-text body a door stores as `descriptionMd`. */
export function renderSections(
  kind: IssueType,
  type: SectionType,
  sections: WorkItemSections,
  opts: RenderOptions = {},
): string {
  const set = sectionSetFor(kind, type);
  const blocks: string[] = [];
  const input = sections as Record<string, unknown>;

  for (const name of set.sections) {
    if (name === 'otherSections') continue;
    const value = input[name];
    if (isEmpty(value)) continue;
    const heading = SECTION_CATALOGUE[name].heading;
    if (heading === null) {
      blocks.push(renderValue(name, value));
      continue;
    }
    if (name === 'scopeBoundary' && opts.difficulty) {
      const { level, reason } = opts.difficulty;
      blocks.push(`**Difficulty: ${level.trim()}** — ${reason.trim()}`);
    }
    blocks.push(`## ${heading}\n\n${renderValue(name, value)}`);
  }

  for (const other of sections.otherSections ?? []) {
    const body = neutralise(other.body.trim());
    blocks.push(
      body.length > 0 ? `## ${other.heading.trim()}\n\n${body}` : `## ${other.heading.trim()}`,
    );
  }

  const text = blocks.map((block) => block.replace(/[ \t]+$/gm, '')).join('\n\n');
  return text.length > 0 ? `${text}\n` : '';
}
