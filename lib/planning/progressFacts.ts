// THE CODE-WRITTEN RAIL LINES, AS FACTS (MOTIR-11296).
//
// Between its writing steps a hosted plan runs stages whose progress motir-ai's CODE
// reports, not its model: the claim check after each level and its end-of-walk
// settle, the final check and its repair, the validity re-open, and the
// turn-boundary code-graph refresh. Those lines used to arrive as `note` frames
// carrying an English sentence, and a note is drawn verbatim (it is the model's own
// prose), so every locale read English.
//
// motir-ai now sends each as a `progress_fact` frame carrying WHAT happened and no
// words (`src/llm/progressFacts.ts` there):
//
//   { fact: string,                 // the stage — a key of FACT_KEYS
//     code: string,                 // the outcome — one of that stage's codes
//     ref: string | null,           // the card the line is about, when there is one
//     params: { count?: number,     // cards checked or sent back, issues found
//               title?: string,     // a card's title (or its ref), never translated
//               summary?: string,   // a finding's one-line summary, never translated
//               refreshes?: [{ ref, previousSha, currentSha }],
//               type?: string,      // a work type id, named in the reader's language
//               blocker?: string,   // the card an edge waits on, as the plan spells it
//               reason?: string } } // an edge's reason, the planner's words, never translated
//
// and the line is this catalogue's, under `planningWorkspace.conversation.fact`, in
// the reader's locale. A repository list is joined by the reader's own list rules
// (`Intl.ListFormat`); the content hashes a refresh carries are never kept, so they
// are never drawn (MOTIR-7181).
//
// Two lines the walk itself wrote joined them (MOTIR-11338): the type given to a
// committed card that had none before it was written (`author`, MOTIR-8193) — the type
// arrives as its id and is named in the reader's language from `labels.workItemType` —
// and the reason an edge was drawn with (`edge`), the planner's own words kept as sent
// inside a catalogued frame. Both name the card they are about by its `ref`.
//
// ⚠️ AN UNKNOWN FACT OR CODE IS A VISIBLE GAP, NEVER A HOLE. motir-ai can add a code
// before this file learns it, and the rail must not go quiet while a stage runs —
// that silence is what this card was filed about. So anything this file cannot word
// — a fact or code it does not list, or a line whose parameter did not arrive —
// draws the generic catalogued line (`fact.unknown`, "Working on the plan…") and is
// never dropped.

/** A fact as the rail keeps it: read loosely off the wire, with no hash. */
export interface ProgressFact {
  fact: string;
  code: string;
  /** The card the line is about, as the plan spells it. Never translated. */
  ref: string | null;
  count: number | null;
  title: string | null;
  summary: string | null;
  /** The refreshed repositories, in the order sent. */
  repos: string[];
  /** The work type a typeless card was given, as its id (`code`, `design`…). */
  type: string | null;
  /** The card an edge waits on. Never translated. */
  blocker: string | null;
  /** Why an edge was drawn — the planner's own one line. Never translated. */
  reason: string | null;
}

/** What a catalogue line interpolates. */
type Param = 'count' | 'title' | 'summary' | 'repos' | 'ref' | 'type' | 'blocker' | 'reason';

/** One known code: its catalogue key under `fact.`, and the parameters its line needs. */
interface FactLine {
  key: string;
  needs: readonly Param[];
}

const line = (key: string, ...needs: Param[]): FactLine => ({ key, needs });

/**
 * EVERY fact and code motir-ai sends, with the line each reads as. This is the
 * closed set; `tests/components/plan-change-progress-facts.test.ts` renders every
 * entry in every locale.
 */
export const FACT_KEYS: Readonly<Record<string, Readonly<Record<string, FactLine>>>> = {
  claim_check: {
    started: line('claimCheck.started', 'count'),
    held: line('claimCheck.held'),
    sent_back: line('claimCheck.sentBack', 'count'),
    settle_started: line('claimCheck.settleStarted', 'count'),
    settle_held: line('claimCheck.settleHeld'),
    settle_unresolved: line('claimCheck.settleUnresolved', 'count'),
  },
  dry_run: {
    started: line('dryRun.started'),
    skipped_no_tenant: line('dryRun.skippedNoTenant'),
    skipped_no_plan_id: line('dryRun.skippedNoPlanId'),
    skipped_question: line('dryRun.skippedQuestion'),
    skipped_user_stop: line('dryRun.skippedUserStop'),
    skipped_turned_off: line('dryRun.skippedTurnedOff'),
    skipped_no_containers: line('dryRun.skippedNoContainers'),
    skipped_by_person: line('dryRun.skippedByPerson'),
    selection_failed: line('dryRun.selectionFailed'),
    checking: line('dryRun.checking', 'title'),
    not_finished: line('dryRun.notFinished', 'title'),
    container_clean: line('dryRun.containerClean', 'title'),
    container_found: line('dryRun.containerFound', 'title', 'count'),
    finding: line('dryRun.finding', 'summary'),
  },
  dry_run_repair: {
    started: line('repair.started'),
    retrying: line('repair.retrying'),
    failed: line('repair.failed'),
    finding_fixed: line('repair.findingFixed', 'summary'),
    not_fixed_open_what: line('repair.notFixedOpenWhat', 'summary'),
    not_fixed_whole_what_disproved: line('repair.notFixedWholeWhatDisproved', 'summary'),
    not_fixed_extension_contradicted: line('repair.notFixedExtensionContradicted', 'summary'),
    not_fixed_committed_in_progress: line('repair.notFixedCommittedInProgress', 'summary'),
    not_fixed_sizing: line('repair.notFixedSizing', 'summary'),
    not_fixed_fix_failed: line('repair.notFixedFixFailed', 'summary'),
    not_fixed_skipped: line('repair.notFixedSkipped', 'summary'),
  },
  validity_reopen: {
    started: line('reopen.started'),
    started_again: line('reopen.startedAgain'),
    card_removed: line('reopen.cardRemoved', 'title'),
    card_added: line('reopen.cardAdded', 'title'),
  },
  code_graph_refreshed: {
    refreshed: line('codeGraph.refreshed', 'repos', 'count'),
  },
  author: {
    typed: line('author.typed', 'ref', 'type'),
    made_story: line('author.madeStory', 'ref'),
  },
  edge: {
    explained: line('edge.explained', 'ref', 'blocker', 'reason'),
  },
};

/** The generic line for a fact this file cannot word. */
export const UNKNOWN_FACT_KEY = 'unknown';

const text = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null;

function reposOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const ref = text((entry as Record<string, unknown> | null)?.['ref']);
    return ref === null ? [] : [ref];
  });
}

/**
 * Read one `progress_fact` frame's data. Never null: a frame with no fact or code
 * still says the plan is being worked on, through the generic line.
 */
export function readProgressFact(data: unknown): ProgressFact {
  const d = (data ?? {}) as Record<string, unknown>;
  const p = (typeof d['params'] === 'object' && d['params'] !== null ? d['params'] : {}) as Record<
    string,
    unknown
  >;
  const count = p['count'];
  return {
    fact: text(d['fact']) ?? '',
    code: text(d['code']) ?? '',
    ref: text(d['ref']),
    count: typeof count === 'number' && Number.isFinite(count) ? count : null,
    title: text(p['title']),
    summary: text(p['summary']),
    repos: reposOf(p['refreshes']),
    type: text(p['type']),
    blocker: text(p['blocker']),
    reason: text(p['reason']),
  };
}

/** The catalogue line a fact reads as, or `null` when it cannot be worded. */
function knownLine(fact: ProgressFact): FactLine | null {
  const line = FACT_KEYS[fact.fact]?.[fact.code];
  if (line === undefined) return null;
  const has: Record<Param, boolean> = {
    count: fact.count !== null || fact.repos.length > 0,
    title: fact.title !== null,
    summary: fact.summary !== null,
    repos: fact.repos.length > 0,
    ref: fact.ref !== null,
    type: fact.type !== null,
    blocker: fact.blocker !== null,
    reason: fact.reason !== null,
  };
  return line.needs.every((n) => has[n]) ? line : null;
}

/** A translator over the `planningWorkspace.conversation` namespace. */
type Tc = (key: string, values?: Record<string, string | number>) => string;

/** Names a work type id in the reader's language. */
export type TypeLabel = (type: string) => string;

/** The type id as sent — the fallback when no catalogue names it. */
const typeId: TypeLabel = (type) => type;

/** The line one fact reads as, in the reader's locale. `typeLabel` names a work type
 *  in the reader's language (`labels.workItemType`); without it the id is drawn. */
export function factLine(
  fact: ProgressFact,
  tc: Tc,
  locale: string,
  typeLabel: TypeLabel = typeId,
): string {
  const known = knownLine(fact);
  if (known === null) return tc(`fact.${UNKNOWN_FACT_KEY}`);
  const values: Record<string, string | number> = {};
  if (fact.title !== null) values['title'] = fact.title;
  if (fact.summary !== null) values['summary'] = fact.summary;
  if (fact.ref !== null) values['ref'] = fact.ref;
  if (fact.type !== null) values['type'] = typeLabel(fact.type);
  if (fact.blocker !== null) values['blocker'] = fact.blocker;
  if (fact.reason !== null) values['reason'] = fact.reason;
  if (fact.repos.length > 0) {
    values['repos'] = new Intl.ListFormat(locale, { type: 'conjunction' }).format(fact.repos);
    values['count'] = fact.repos.length;
  } else if (fact.count !== null) {
    values['count'] = fact.count;
  }
  return tc(`fact.${known.key}`, values);
}
