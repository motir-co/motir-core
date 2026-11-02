import type { IssueType } from '@/lib/issues/parentRules';
import {
  SECTION_CATALOGUE,
  checkSections,
  sectionSetFor,
  type SectionName,
  type SectionType,
  type WorkItemSections,
} from '@/lib/workItems/sections/registry';

// THE PARSER (Story MOTIR-9023 · Subtask MOTIR-9028) — the read-side inverse of
// `renderSections`.
//
// Given ANY body (door-rendered, hand-written, or from before sections existed) it
// reports the sections it finds, in their registry shapes, the required ones that
// are missing, the ones it found but could not read into their shape, and every
// piece of text it could not place — kept verbatim under `otherSections`. It never
// throws, never writes, never rewrites its input and never classifies a card as
// "fielded" or "legacy": `descriptionMd` is free text, and a body with no headings
// is a legal body whose sections are simply missing.
//
// The heading table comes from `sectionSetFor(kind, type)`, so a section added to
// the registry is parsed with no edit here. PURE + deterministic.

export const PARSE_SIGNALS = [
  'empty',
  'no-headings',
  'quoted-gutter',
  'duplicate-heading',
] as const;
/** A diagnostic a consumer may show. Never stored, never changes `sections`. */
export type ParseSignal = (typeof PARSE_SIGNALS)[number];

export interface ParsedBody {
  sections: WorkItemSections;
  /** The sections present in `sections`, in registry order. */
  found: SectionName[];
  /** `checkSections`' own answer: a required section that is absent or empty. */
  missing: SectionName[];
  /** `checkSections`' invalid, plus every section found but unreadable into its shape. */
  invalid: { section: SectionName; message: string }[];
  signals: ParseSignal[];
  /** Every registry section whose heading the body carries, whether or not
   *  anything stands under it (an empty heading is in `headed`, not `found`). */
  headed: SectionName[];
}

const HEADING = /^(#{2,})\s+(.*?)\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const ESCAPED_HEADING = /^\\(#{1,6}\s)/;
const MANAGED_MARKER = /^\s*<!--\s*motir:[^>]*-->\s*$/;
const BULLET = /^(?:[-*+]|\d+[.)])\s+(.*)$/;
const GUTTER = /^\s*[|>](\s|$)/;
const CHIP = /\[[^\]]*\]\((?:motir|motir-ref):[^)]*\)/;
const BACKTICK = /`[^`]+`/;
const SEPARATOR = /\s[—–-]\s|:\s/;

/** Walk lines tracking fenced code the way the renderer does, calling `visit`
 *  with whether the line is outside a fence. A fence line itself is "inside". */
function withFences(
  lines: readonly string[],
  visit: (line: string, outside: boolean, i: number) => void,
) {
  let fence: string | null = null;
  lines.forEach((line, i) => {
    const m = FENCE.exec(line);
    if (m) {
      const marker = (m[1] as string)[0] as string;
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      visit(line, false, i);
      return;
    }
    visit(line, fence === null, i);
  });
}

/** Undo the renderer's backslash on a heading-shaped line, outside fences. */
function unneutralise(text: string): string {
  const lines = text.split('\n');
  const out = [...lines];
  withFences(lines, (line, outside, i) => {
    if (!outside) return;
    const m = ESCAPED_HEADING.exec(line);
    if (m) out[i] = line.slice(1);
  });
  return out.join('\n');
}

const clean = (lines: readonly string[]): string => unneutralise(lines.join('\n').trim());

/** A body block: the unheaded preamble, a section, or a named other-section. */
interface Block {
  name: SectionName | null;
  /** The heading text as written, for `otherSections`. */
  heading: string | null;
  lines: string[];
}

function normalise(heading: string): string {
  return heading.trim().replace(/:\s*$/, '').trim().toLowerCase();
}

/** One list item: marker removed, indented continuation lines (two spaces
 *  stripped, the renderer's indent) and managed-block markers attached. */
function listItems(lines: readonly string[]): string[] {
  const items: string[][] = [];
  let pendingStart: string | null = null;
  let blankSince = false;
  for (const line of lines) {
    if (MANAGED_MARKER.test(line)) {
      const marker = line.trim();
      if (/:start/.test(marker)) pendingStart = marker;
      else if (items.length > 0) items[items.length - 1]!.push(marker);
      else pendingStart = marker;
      continue;
    }
    if (line.trim() === '') {
      if (items.length > 0) items[items.length - 1]!.push('');
      blankSince = true;
      continue;
    }
    const bullet = BULLET.exec(line);
    const current = items[items.length - 1];
    if (bullet) {
      items.push([...(pendingStart ? [pendingStart] : []), bullet[1] as string]);
      pendingStart = null;
    } else if (/^[ \t]/.test(line) && current) {
      current.push(line.replace(/^(?: {1,2}|\t)/, ''));
    } else if (current && !blankSince) {
      current.push(line);
    } else {
      items.push([...(pendingStart ? [pendingStart] : []), line.replace(/^(?: {1,2}|\t)/, '')]);
      pendingStart = null;
    }
    blankSince = false;
  }
  if (pendingStart) {
    if (items.length > 0) items[items.length - 1]!.push(pendingStart);
    else items.push([pendingStart]);
  }
  return items.map((item) => unneutralise(item.join('\n').trim())).filter((s) => s.length > 0);
}

function parseContextRef(item: string): { ref: string; why: string } {
  const lead = item.match(new RegExp(`^(?:${CHIP.source}|${BACKTICK.source})`));
  const anywhere = lead ?? CHIP.exec(item) ?? BACKTICK.exec(item);
  if (anywhere) {
    const span = anywhere[0];
    const ref = span.startsWith('`') ? span.slice(1, -1) : span;
    if (lead) return { ref, why: item.slice(span.length).replace(/^\s*(?:—|–|-|:)\s*/, '') };
    return { ref, why: item };
  }
  const sep = SEPARATOR.exec(item);
  if (!sep) return { ref: item, why: '' };
  return {
    ref: item.slice(0, sep.index).trim(),
    why: item.slice(sep.index + sep[0].length).trim(),
  };
}

const DECISION_OPTION =
  /^\*\*(.+?)\*\*\s*[—–-]\s*cost:\s*([\s\S]*?)\s*·\s*forecloses:\s*([\s\S]*)$/;
const STRING_ITEM = /^`([^`]+)`\s*\(([^)]+)\)\s*[—–-]\s*([\s\S]*)$/;

function parseChoiceOptions(lines: readonly string[]): WorkItemSections['choiceOptions'] | null {
  const groups: { label: string; lines: string[] }[] = [];
  const head: string[] = [];
  withFences(lines, (line, outside) => {
    const m = outside ? /^###\s+(.*?)\s*$/.exec(line) : null;
    if (m) groups.push({ label: m[1] as string, lines: [] });
    else if (groups.length > 0) groups[groups.length - 1]!.lines.push(line);
    else head.push(line);
  });
  if (head.join('').trim() !== '' || groups.length === 0) return null;
  const options: NonNullable<WorkItemSections['choiceOptions']> = [];
  for (const group of groups) {
    const first = group.lines.findIndex((l) => l.trim() !== '');
    const best =
      first < 0 ? null : /^\*\*Best if you want:\*\*\s*(.*)$/.exec(group.lines[first] as string);
    if (!best) return null;
    const why = clean(group.lines.slice(first + 1));
    options.push({
      label: group.label,
      bestFor: (best[1] as string).trim(),
      ...(why ? { why } : {}),
    });
  }
  return options;
}

function parseWhy(lines: readonly string[]): WorkItemSections['why'] | null {
  const rest = [...lines];
  const at = rest.findIndex((l) => l.trim() !== '');
  const situation = at < 0 ? null : /^\*\*Situation:\*\*\s*(.*)$/.exec(rest[at] as string);
  if (!situation) return null;
  rest.splice(0, at + 1);
  const next = rest.findIndex((l) => l.trim() !== '');
  const said = next < 0 ? null : /^\*\*You said:\*\*\s*"([\s\S]*)"\s*$/.exec(rest[next] as string);
  if (said) rest.splice(0, next + 1);
  return {
    situation: (situation[1] as string).trim().toLowerCase().replace(/\s+/g, '_'),
    ...(said ? { youSaid: said[1] as string } : {}),
    evidence: clean(rest),
  };
}

/** Read a block's lines into the section's shape, or `null` when they cannot be. */
function readSection(name: SectionName, lines: readonly string[]): unknown | null {
  const shape = SECTION_CATALOGUE[name].shape;
  if (name === 'choiceOptions') return parseChoiceOptions(lines);
  if (name === 'why') return parseWhy(lines);
  switch (shape.type) {
    case 'string':
    case 'enum': {
      const text = clean(lines);
      return text.length > 0 ? text : null;
    }
    case 'stringList': {
      const items = listItems(lines);
      return items.length > 0 ? items : null;
    }
    case 'object':
      return null;
    case 'objectList': {
      const items = listItems(lines);
      if (items.length === 0) return null;
      const out: unknown[] = [];
      for (const item of items) {
        let value: unknown = null;
        if (name === 'contextRefs') value = parseContextRef(item);
        else if (name === 'options') {
          const m = DECISION_OPTION.exec(item);
          if (m) value = { label: m[1], cost: m[2], forecloses: m[3] };
        } else if (name === 'cases') {
          const at = item.indexOf(' → ');
          if (at >= 0) {
            value = { condition: item.slice(0, at).trim(), expected: item.slice(at + 3).trim() };
          }
        } else if (name === 'strings') {
          const m = STRING_ITEM.exec(item);
          if (m) value = { key: m[1], locale: m[2], says: (m[3] as string).trim() };
        }
        if (value === null) return null;
        out.push(value);
      }
      return out;
    }
  }
}

/** Read a free-text body into the sections of its kind × type cell. */
export function parseSections(
  md: string | null | undefined,
  kind: IssueType,
  type: SectionType,
): ParsedBody {
  const set = sectionSetFor(kind, type);
  const signals: ParseSignal[] = [];
  const done = (sections: WorkItemSections, invalid: ParsedBody['invalid']): ParsedBody => {
    // A stored body is read, so a committed card in its type's legacy shape
    // reads complete (MOTIR-10206).
    const check = checkSections(kind, type, sections, { acceptLegacy: true });
    return {
      sections,
      found: set.sections.filter((name) => sections[name] !== undefined),
      missing: check.missing as SectionName[],
      invalid: [...(check.invalid as ParsedBody['invalid']), ...invalid],
      signals,
      headed: [] as SectionName[],
    };
  };

  if (typeof md !== 'string' || md.trim() === '') {
    signals.push('empty');
    return done({}, []);
  }

  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const table = new Map<string, SectionName>();
  for (const name of set.sections) {
    const heading = SECTION_CATALOGUE[name].heading;
    if (heading !== null && name !== 'otherSections') table.set(normalise(heading), name);
  }

  const blocks: Block[] = [{ name: null, heading: null, lines: [] }];
  const seen = new Set<SectionName>();
  withFences(lines, (line, outside) => {
    const current = blocks[blocks.length - 1] as Block;
    const m = outside ? HEADING.exec(line) : null;
    if (!m) {
      current.lines.push(line);
      return;
    }
    const level = (m[1] as string).length;
    const text = m[2] as string;
    const name = table.get(normalise(text));
    if (name && !seen.has(name) && !(current.name === 'choiceOptions' && level >= 3)) {
      seen.add(name);
      blocks.push({ name, heading: text, lines: [] });
    } else if (name && seen.has(name)) {
      if (!signals.includes('duplicate-heading')) signals.push('duplicate-heading');
      blocks.push({ name: null, heading: text, lines: [] });
    } else if (level >= 3) {
      current.lines.push(line);
    } else {
      blocks.push({ name: null, heading: text, lines: [] });
    }
  });

  const sections: Record<string, unknown> = {};
  const others: { heading: string; body: string }[] = [];
  const invalid: ParsedBody['invalid'] = [];
  for (const block of blocks) {
    if (block.name === null && block.heading === null) {
      const framing = clean(block.lines);
      if (framing && set.sections.includes('framing')) sections.framing = framing;
      else if (framing) others.push({ heading: 'Introduction', body: framing });
      continue;
    }
    if (block.name === null) {
      others.push({ heading: block.heading as string, body: clean(block.lines) });
      continue;
    }
    const value = readSection(block.name, block.lines);
    if (value !== null) {
      sections[block.name] = value;
    } else if (block.lines.join('').trim() !== '') {
      invalid.push({ section: block.name, message: 'Could not be read into its shape' });
      others.push({ heading: block.heading as string, body: clean(block.lines) });
    }
  }
  if (others.length > 0) sections.otherSections = others;

  const body = lines.filter((l) => l.trim() !== '');
  if (body.length > 0 && body.every((l) => GUTTER.test(l))) signals.push('quoted-gutter');
  if (!blocks.some((b) => b.name !== null)) signals.push('no-headings');

  const result = done(sections as WorkItemSections, invalid);
  result.headed = set.sections.filter((n) => blocks.some((b) => b.name === n));
  return result;
}
