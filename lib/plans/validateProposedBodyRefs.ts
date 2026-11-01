// ── A proposal body's INTRA-PLAN item links, at EVERY proposal write door ────
// (bug MOTIR-6494.)
//
// A plan's cards point at one another through item-link tokens, and approve
// turns each `[label](motir-ref:planItem:<id>)` into a real `motir:<workItemId>`
// chip (`rewriteIntraPlanRefs`, MOTIR-1418). That rewrite — and every other
// reader of the token (`parseIntraPlanRefIds`, `proseVsGraph`) — recognises the
// CANONICAL form only, through `INTRA_PLAN_REF_TOKEN_RE`. A near-miss such as
// `[label](motir-ref:<id>)` (no `planItem:` prefix) matched nothing: it was not
// rewritten, not reported unresolved, and not refused, so it shipped as dead
// text on the approved card.
//
// MOTIR-6494 made every proposal door REFUSE such a link. MOTIR-10104 turned the
// refusal into a WARNING: a body that is otherwise right was thrown away over one
// link, and the refusal named only the general format while the server could
// compute the exact link that works — an old plan item that became a card, or a
// proposal of this plan written without its prefix. So every door (the append's
// `add` / `modify`, the deepen, the correction) KEEPS the write, and its response
// carries one warning per broken link (`findBodyLinkCandidates` → the service's
// lookup → `judgeBodyLinks`), naming the corrected token whenever it is
// computable. What still stops a broken link is APPROVE: it refuses a plan whose
// bodies still hold a malformed `motir-ref:` link, naming the same correction,
// and `validate_plan` reports it as a rejection before anyone presses the button.
//
// A link inside Markdown CODE — a fenced block or an inline span — renders
// literally rather than as a link, so it is not a dead link and is skipped: a
// card that DOCUMENTS the token syntax must stay authorable.
//
// PURE: no DB, no `tx`. The one refusal left here is MOTIR-9175's
// `assertBodyRefsResolve`, an `InvalidProposalError` (a 422 with code
// `INVALID_PROPOSAL` on every door).

import { InvalidProposalError } from '@/lib/plans/errors';
import { parseIntraPlanRefIds } from '@/lib/mentions/workItemRefs';
import { labelWorkItemKeys } from '@/lib/workItems/proseVsGraph';

/** Where a link's label ends and a `motir-ref:` destination begins. */
const MOTIR_REF_LINK_JOIN = '](motir-ref:';
/** Where a link's label ends and a `motir:` (card) destination begins. */
const MOTIR_LINK_JOIN = '](motir:';

/** The canonical token, anchored — `INTRA_PLAN_REF_TOKEN_RE`'s shape. */
const CANONICAL_MOTIR_REF_LINK_RE = /^\[[^\]\[]*\]\(motir-ref:planItem:[A-Za-z0-9_-]+\)$/;

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;

/** One line with every inline code span (a backtick run to its equal-length closer) removed. */
function withoutInlineCode(line: string): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '`') {
      out += line[i];
      i += 1;
      continue;
    }
    let run = 1;
    while (line[i + run] === '`') run += 1;
    const fence = '`'.repeat(run);
    let close = line.indexOf(fence, i + run);
    // The closer is a run of EXACTLY `run` backticks, not the start of a longer one.
    while (close !== -1 && (line[close + run] === '`' || line[close - 1] === '`')) {
      close = line.indexOf(fence, close + 1);
    }
    if (close === -1) {
      out += fence; // an unclosed run is literal text
      i += run;
    } else {
      i = close + run;
    }
  }
  return out;
}

/** The body with every fenced block and inline code span removed. */
function withoutCode(text: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    if (fence !== null) {
      const closer = line.match(FENCE_OPEN_RE);
      if (closer && closer[1]![0] === fence[0] && closer[1]!.length >= fence.length) fence = null;
      continue;
    }
    const opener = line.match(FENCE_OPEN_RE);
    if (opener) {
      fence = opener[1]!;
      continue;
    }
    kept.push(withoutInlineCode(line));
  }
  return kept.join('\n');
}

/**
 * Every `](motir-ref:` link in `text` that is NOT the canonical
 * `[label](motir-ref:planItem:<id>)` token, in first-seen order, deduplicated.
 * Links inside Markdown code are ignored.
 */
export function findMalformedIntraPlanRefs(text: string): string[] {
  const found: string[] = [];
  for (const token of linksJoinedBy(withoutCode(text), MOTIR_REF_LINK_JOIN)) {
    if (!CANONICAL_MOTIR_REF_LINK_RE.test(token) && !found.includes(token)) found.push(token);
  }
  return found;
}

/**
 * Every `[label](<join>…)` link in `text` — a label holding no bracket, a
 * destination running to the first `)` on its line — canonical or not.
 *
 * A single left-to-right pass rather than a regex: an unanchored pattern with a
 * free-running destination re-scans the rest of the line from every
 * `](motir-ref:` it meets, which is quadratic on a body that repeats the
 * opener without ever closing it (CodeQL `js/polynomial-redos`). Here every
 * character is visited once: a destination with no `)` before its line ends
 * is not a link, and nothing inside it can start one that closes.
 */
function linksJoinedBy(text: string, join: string): string[] {
  const links: string[] = [];
  let open = -1; // the last `[` with no bracket after it — a label's start
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '[') {
      open = i;
    } else if (ch === ']') {
      if (open !== -1 && text.startsWith(join, i)) {
        let end = i + join.length;
        while (end < text.length && text[end] !== ')' && text[end] !== '\n') end += 1;
        if (text[end] === ')') links.push(text.slice(open, end + 1));
        open = -1;
        i = end + 1;
        continue;
      }
      open = -1;
    }
    i += 1;
  }
  return links;
}

/** The body fields a proposal can carry, as any door hands them over. */
export interface ProposedBodies {
  descriptionMd?: string | null;
  explanationMd?: string | null;
}

/** The two bodies a proposal link can sit in. */
export type BodyLinkField = 'descriptionMd' | 'explanationMd';

const BODY_LINK_FIELDS: readonly BodyLinkField[] = ['descriptionMd', 'explanationMd'];

/** The two well-formed item links, as a warning names them when it can compute neither. */
export const CANONICAL_ITEM_LINK_FORMS: readonly string[] = [
  '[label](motir:<workItemId>)',
  '[label](motir-ref:planItem:<planItemId>)',
];

const LINK_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * One item link a proposal body carries that MAY open nothing once approved
 * (MOTIR-10104): every `](motir-ref:` link that is not the canonical token, and
 * every `[label](motir:<id>)` link — the latter is judged only once its id is
 * known to name a plan item rather than a card.
 */
export interface BodyLinkCandidate {
  field: BodyLinkField;
  /** The link as written, e.g. `[the host card](motir-ref:cmu8imhdz…)`. */
  link: string;
  label: string;
  /** The id the link names, read past a stray `planItem:` prefix; `null` when it names none. */
  id: string | null;
  scheme: 'motir-ref' | 'motir';
}

/** `[label](<scheme>:<dest>)` → its label and destination. */
function splitLink(link: string, join: string): { label: string; dest: string } {
  const at = link.indexOf(join);
  return { label: link.slice(1, at), dest: link.slice(at + join.length, -1) };
}

/** The id a malformed `motir-ref:` destination names — `planItem:` in any case stripped. */
function motirRefId(dest: string): string | null {
  const id = dest.trim().replace(/^planItem:/i, '');
  return LINK_ID_RE.test(id) ? id : null;
}

/**
 * Every item link in a proposal's bodies a write door warns about or must look
 * up (MOTIR-10104), in field order then first-seen order, deduplicated per
 * field. Links inside Markdown code are ignored, as everywhere in this module.
 */
export function findBodyLinkCandidates(bodies: ProposedBodies): BodyLinkCandidate[] {
  const found: BodyLinkCandidate[] = [];
  for (const field of BODY_LINK_FIELDS) {
    const text = bodies[field];
    if (typeof text !== 'string') continue;
    for (const link of findMalformedIntraPlanRefs(text)) {
      const { label, dest } = splitLink(link, MOTIR_REF_LINK_JOIN);
      found.push({ field, link, label, id: motirRefId(dest), scheme: 'motir-ref' });
    }
    const seen = new Set<string>();
    for (const link of linksJoinedBy(withoutCode(text), MOTIR_LINK_JOIN)) {
      const { label, dest } = splitLink(link, MOTIR_LINK_JOIN);
      if (!LINK_ID_RE.test(dest) || seen.has(link)) continue;
      seen.add(link);
      found.push({ field, link, label, id: dest, scheme: 'motir' });
    }
  }
  return found;
}

/** What the server knows about the ids a proposal's links name. */
export interface BodyLinkResolution {
  /** The `add` proposals on THIS plan. */
  thisPlanAddIds: ReadonlySet<string>;
  /** An earlier plan's materialized `add` → the card it became (one the reader can see). */
  becameCard: ReadonlyMap<string, string>;
  /** Ids that name a card the reader can see. */
  cardIds: ReadonlySet<string>;
  /** The keys of the projects the reader can browse, upper-cased — what makes a label's `ACME-12` a key. */
  knownPrefixes: ReadonlySet<string>;
  /** A key a dead `motir:` link's label names (upper-cased) → the id of that card, one the reader can see. */
  cardByKey: ReadonlyMap<string, string>;
}

/** One link a write KEPT that would ship dead, and how to fix it. */
export interface BodyLinkWarning {
  field: BodyLinkField;
  /** The link as written. */
  link: string;
  /** Why approve would ship it as dead text. */
  reason: string;
  /** The link to write instead, when the server can compute it. */
  correctedLink: string | null;
  /** The two canonical forms — present only when no correction could be computed. */
  canonicalForms?: string[];
}

/**
 * Judge each candidate against what the server knows (MOTIR-10104). A link is
 * WARNED, never refused: the write that carries it is kept, and the warning
 * names the corrected token whenever the id names something — a proposal on
 * this plan, an earlier plan's proposal that became a card, or a card itself.
 * A `motir:` link to a card the reader can see is an ordinary card link and is
 * not warned. One whose id names nothing at all is (MOTIR-10111), corrected from
 * the key its label names when that key is one card the reader can see.
 */
export function judgeBodyLinks(
  candidates: readonly BodyLinkCandidate[],
  known: BodyLinkResolution,
): BodyLinkWarning[] {
  const warnings: BodyLinkWarning[] = [];
  for (const c of candidates) {
    const warning = c.scheme === 'motir-ref' ? judgeMotirRef(c, known) : judgeMotir(c, known);
    if (warning) warnings.push(warning);
  }
  return warnings;
}

function judgeMotirRef(c: BodyLinkCandidate, known: BodyLinkResolution): BodyLinkWarning {
  const base = { field: c.field, link: c.link };
  if (c.id !== null && known.thisPlanAddIds.has(c.id)) {
    return {
      ...base,
      reason:
        'it names a proposal on this plan without the `planItem:` prefix, so approve cannot ' +
        'turn it into an item link',
      correctedLink: `[${c.label}](motir-ref:planItem:${c.id})`,
    };
  }
  const card = c.id === null ? undefined : known.becameCard.get(c.id);
  if (card) {
    return {
      ...base,
      reason:
        'it names a proposal of an earlier, approved plan, which is now a card — a link to an ' +
        'existing card names the card, not the proposal it came from',
      correctedLink: `[${c.label}](motir:${card})`,
    };
  }
  if (c.id !== null && known.cardIds.has(c.id)) {
    return {
      ...base,
      reason: 'it names an existing card in the proposal scheme, which approve does not rewrite',
      correctedLink: `[${c.label}](motir:${c.id})`,
    };
  }
  return {
    ...base,
    reason:
      c.id === null
        ? 'its destination names no id, so approve cannot turn it into an item link'
        : `no proposal on this plan, no earlier proposal and no card carries the id \`${c.id}\``,
    correctedLink: null,
    canonicalForms: [...CANONICAL_ITEM_LINK_FORMS],
  };
}

function judgeMotir(c: BodyLinkCandidate, known: BodyLinkResolution): BodyLinkWarning | null {
  if (c.id === null) return null;
  if (known.thisPlanAddIds.has(c.id)) {
    return {
      field: c.field,
      link: c.link,
      reason:
        'it names a proposal on this plan in the card scheme — no card carries that id, so it ' +
        'opens nothing until approve',
      correctedLink: `[${c.label}](motir-ref:planItem:${c.id})`,
    };
  }
  const card = known.becameCard.get(c.id);
  if (card) {
    return {
      field: c.field,
      link: c.link,
      reason:
        'it names a proposal of an earlier, approved plan rather than the card that proposal ' +
        'became, so it opens nothing',
      correctedLink: `[${c.label}](motir:${card})`,
    };
  }
  if (known.cardIds.has(c.id)) return null;
  return deadCardLinkWarning(c, known);
}

/**
 * A `motir:` link whose id names no plan item, no earlier proposal and no card
 * the reader can see (MOTIR-10111) — the zero-padded id copied from memory. The
 * label usually names the card it meant, so the correction is computed from it
 * when it names exactly ONE key and that key is a card the reader can see. A
 * card the reader cannot see is absent from `cardByKey`, so it reads exactly as
 * a key that names nothing and the warning never carries its id.
 */
function deadCardLinkWarning(c: BodyLinkCandidate, known: BodyLinkResolution): BodyLinkWarning {
  const base = {
    field: c.field,
    link: c.link,
    reason: `no proposal on this plan, no earlier proposal and no card you can see carries the id \`${c.id}\`, so it opens nothing`,
  };
  const keys = labelWorkItemKeys(c.label, known.knownPrefixes);
  const card = keys.length === 1 ? known.cardByKey.get(keys[0]!) : undefined;
  if (card) {
    return {
      ...base,
      reason: `${base.reason} — its label names ${keys[0]}`,
      correctedLink: `[${c.label}](motir:${card})`,
    };
  }
  return { ...base, correctedLink: null, canonicalForms: [...CANONICAL_ITEM_LINK_FORMS] };
}

/** One warning as a line a refusal or a tool result can print. */
export function bodyLinkWarningLine(w: BodyLinkWarning): string {
  const fix = w.correctedLink
    ? `write \`${w.correctedLink}\``
    : `write one of ${(w.canonicalForms ?? CANONICAL_ITEM_LINK_FORMS).map((f) => `\`${f}\``).join(' or ')}`;
  return `\`${w.field}\` carries \`${w.link}\`: ${w.reason}; ${fix}`;
}

/**
 * Every canonical `[label](motir-ref:planItem:<id>)` link in `text` whose id is
 * not in `resolvableIds`, in first-seen order, deduplicated. Links inside
 * Markdown code are ignored, as in {@link findMalformedIntraPlanRefs}.
 */
export function findUnresolvedIntraPlanRefIds(
  text: string,
  resolvableIds: ReadonlySet<string>,
): string[] {
  return parseIntraPlanRefIds(withoutCode(text)).filter((id) => !resolvableIds.has(id));
}

/**
 * Refuse a proposal whose `descriptionMd` or `explanationMd` links a
 * `motir-ref:planItem:<id>` that names no proposal on the plan (bug MOTIR-9175).
 * The form check above only tests the token's SHAPE; a well-formed link to an id
 * the plan does not hold passed every door and shipped as dead text, because
 * approve leaves an unresolved token verbatim and wires no `relates_to` edge.
 * This is the body-link twin of MOTIR-3539's structural-ref refusal.
 *
 * @param resolvableIds the ids of the `add` proposals the plan holds. A proposal
 *   appended in the SAME call has no id until that call returns, so a link to
 *   one cannot be written and is refused like any other id the plan lacks.
 * @param label how the proposal is named in a refusal
 */
export function assertBodyRefsResolve(
  bodies: ProposedBodies,
  resolvableIds: ReadonlySet<string>,
  label: string,
): void {
  for (const field of ['descriptionMd', 'explanationMd'] as const) {
    const text = bodies[field];
    if (typeof text !== 'string') continue;
    const unresolved = findUnresolvedIntraPlanRefIds(text, resolvableIds);
    if (unresolved.length === 0) continue;
    throw new InvalidProposalError(
      `${label}: \`${field}\` links ${unresolved.map((id) => `\`planItem:${id}\``).join(', ')}, ` +
        `which names no proposal in this plan — approve would leave the link as dead text ` +
        `and wire no edge. Use an id \`add_plan_items\` returned for an \`add\` already on this plan.`,
    );
  }
}
