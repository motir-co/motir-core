'use client';

import { Fragment, memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Brain, FolderX, PenLine, RotateCw, SearchCheck } from 'lucide-react';

import { Pill } from '@/components/ui/Pill';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { StatusPill } from '@/components/issues/StatusPill';
import { DifficultyIndicator } from '@/components/issues/DifficultyPicker';
import { ProposalPeek } from '@/components/planning/ProposalPeek';
import type { LiveDrafts } from '@/lib/planning/liveDraft';
import type { CardCueState } from '@/lib/planning/cueState';
import { changeCellText } from '@/components/planning/changeCellText';
import { SupersedesChips } from '@/components/planning/SupersedesChip';
import { proposedMarkOf } from '@/components/planning/PlanItemNode';
import { firstLine } from '@/lib/workItems/obsolescenceNote';
import { WorkItemQuickView } from '@/components/planning/WorkItemQuickView';
import type { IssueType } from '@/lib/issues/parentRules';
import type { PlanItemOutcome } from '@/components/planning/PlanItemNode';
import type { PlanItemChangeDto, PlanReviewItemDto } from '@/lib/dto/planReview';
import type { PlanItemOpDto } from '@/lib/dto/plans';
import {
  changeToText,
  FolderPathLabel,
  folderPathText,
  isFolderPlacementChange,
  PlacementSide,
} from '@/components/planning/FolderPlacement';

// The plan detail's LIST body (MOTIR-3239, built to
// `design/ai-planning/design-notes.md` Part VIII §3 and
// `plan-detail-list-view.mock.html` panel 2).
//
// A SECOND BODY in the same pane, never a re-drawing of the first. The canvas
// answers where a proposal LANDS; this answers what exactly is being approved,
// which is a question about a SET.
//
// Presentational: every field comes off the `PlanReviewItemDto`s the island
// already holds, so this adds no read, no route and no service method. The row is
// the shipped `ChildList` row GRAMMAR — kind glyph, identifier, title, a facts
// line, a right-hand chip — so a reader who has read the Children list has read
// this one, and the shape routes through `--radius-control` /
// `--spacing-control-x|y` exactly as that row does.

/** The three sections, in the order Part VIII draws them. Each renders only when
 *  it is non-empty.
 *
 *  THREE ARMS PER OP, because the plan's decision is three-valued (MOTIR-4495).
 *  `key`/`chip` are the PROPOSAL tense a pending plan reads in; `decidedKey`/
 *  `decidedChip` are the past tense an APPROVED plan reads in; `declinedKey`/
 *  `declinedChip` are the proposal tense again, and they are spelled out rather
 *  than folded into a `!== 'accepted'` test because Part VIII §3 DECIDED the
 *  declined arm's words, and a table that names all three is where the next
 *  reader looks when it decides differently. No new copy key: every string the
 *  declined arm renders already ships. */
const SECTIONS = [
  {
    op: 'add',
    key: 'listAdds',
    decidedKey: 'listCreated',
    declinedKey: 'listAdds',
    chip: 'opAdd',
    decidedChip: 'opCreated',
    declinedChip: 'opAdd',
  },
  {
    op: 'modify',
    key: 'listUpdates',
    decidedKey: 'listApplied',
    declinedKey: 'listUpdates',
    chip: 'opModify',
    decidedChip: 'opApplied',
    declinedChip: 'opModify',
  },
  {
    op: 'remove',
    key: 'listArchives',
    decidedKey: 'listArchived',
    declinedKey: 'listArchives',
    chip: 'opRemove',
    decidedChip: 'opArchived',
    declinedChip: 'opRemove',
  },
] as const;

type Section = (typeof SECTIONS)[number];

/**
 * Which of a section's three vocabularies the plan's OUTCOME selects.
 *
 * ⚠️ THE INPUT IS THE OUTCOME, NEVER A `decided` BOOLEAN (MOTIR-4495). Two of
 * the three values collapse onto one arm, which is exactly what made the boolean
 * look sufficient — and it was wrong for the third: a DECLINED plan rendered
 * `Created` / `Applied` / `Archived` about work that never happened, with the
 * `add` row contradicting itself inside one line (`Created … no key yet`). The
 * canvas eleven lines away in `PlanDetail` already computed the three-valued
 * value; the list was handed a boolean derived from the same two statuses.
 */
function vocabularyFor(
  section: Section,
  outcome: PlanItemOutcome | null,
): { headingKey: string; chipKey: string } {
  if (outcome === 'accepted')
    return { headingKey: section.decidedKey, chipKey: section.decidedChip };
  if (outcome === 'declined')
    return { headingKey: section.declinedKey, chipKey: section.declinedChip };
  return { headingKey: section.key, chipKey: section.chip };
}

// ⚠️ TOTAL over `PlanItemOpDto`, at BUILD time (MOTIR-3242). The list renders one
// section per op, so an op the sections do not cover is a proposal that silently
// never appears — under a plan item COUNT that includes it, which is exactly the
// self-contradiction the three-section decision exists to prevent. A fourth op
// must therefore be a compile error here, not a row nobody sees. Same shape as
// `lib/dto/plans.ts`'s `PLAN_DECISION_REASONS`.
type AssertTotalListOps = [Exclude<PlanItemOpDto, (typeof SECTIONS)[number]['op']>] extends [never]
  ? true
  : never;
const _planListOpsTotal: AssertTotalListOps = true;
void _planListOpsTotal;

const KNOWN_KINDS: readonly IssueType[] = ['epic', 'story', 'task', 'bug', 'subtask'];

function issueTypeOf(kind: string): IssueType {
  return (KNOWN_KINDS as readonly string[]).includes(kind) ? (kind as IssueType) : 'task';
}

/** The op chip — panel B's own vocabulary, unchanged. The list introduces no
 *  fourth language for the same three facts. */
function OpChip({ op, outcome }: { op: string; outcome: PlanItemOutcome | null }) {
  const t = useTranslations('planReview');
  const section = SECTIONS.find((s) => s.op === op);
  if (!section) return null;
  // ⚠️ The CHIP carries panel B's own op vocabulary — the SHIPPED
  // `planReview.opAdd` / `opModify` / `opRemove` strings the canvas badges
  // already use (`add` / `change` / `remove`) — and the SECTION HEADER carries
  // the list's own (`Adds` / `Updates` / `Archives`). They are deliberately different words: the header names a GROUP,
  // the chip names what will happen to THIS card, and giving them one string made
  // the row read as an echo of the heading above it.
  //
  // A DECIDED plan's list is a RECORD, in the same tense Part VI gave the canvas,
  // so both move: `created` / `applied` / `archived`.
  //
  // ⚠️ AND THE SENTENCE THAT FOLLOWS THAT ONE IN PART VIII §3 IS THE OTHER HALF,
  // which this comment used to quote without implementing (MOTIR-4495):
  // *"A declined plan's list keeps the proposal tense and adds no outcome chip:
  // nothing happened to those cards."* `decided` was a BOOLEAN over a
  // three-valued axis, so the decline took the approve arm and the list said
  // `Created` / `Applied` / `Archived` about work that never happened.
  const { chipKey } = vocabularyFor(section, outcome);
  const label = t(chipKey);
  if (op === 'add') return <Pill severity="info">{label}</Pill>;
  if (op === 'modify') return <Pill status="planned">{label}</Pill>;
  return <Pill tone="archived">{label}</Pill>;
}

/**
 * A `modify`'s changed fields, old → new — as TWO-LINE TEXT, one line per field.
 *
 * ⚠️ Deliberately NOT the canvas's inline diff overlay. That overlay answers
 * *this node is changing*, inside a node card ~280px wide: it is a SIGNAL. This
 * answers *changing to WHAT*, at the full width of the pane, for a reader
 * deciding whether to approve. So the list is the only surface that spells a
 * change out and the canvas is the only surface that marks a node — neither is
 * built twice.
 *
 * A field whose new value is a BODY (`description`, `explanation`) is NAMED, not
 * quoted: a rewritten description is not a diff a review list can carry, and a
 * truncated one is worse than a pointer.
 */
const BODY_FIELDS = new Set(['description', 'explanation']);

/** The field's human LABEL, not its wire name (MOTIR-3242).
 *
 *  ⚠️ The key is INTERPOLATED (`field_<name>`), so nothing checks it at build
 *  time — which is how the canvas once rendered `planReview.field_storyPoints`
 *  to a person deciding whether to approve a plan, with nothing red anywhere
 *  (MOTIR-3151). `t.has()` degrades to the wire name, which is at least a word;
 *  `tests/components/plan-change-field-labels.test.tsx` is what keeps every
 *  member of `PLAN_ITEM_CHANGE_FIELDS` from needing that fallback, and this list
 *  is the FOURTH surface it now covers rather than a fifth copy of the idea. */
function fieldLabel(t: ReturnType<typeof useTranslations>, field: string): string {
  const key = `field_${field}`;
  return t.has(key) ? t(key) : field;
}

/**
 * The label/value grid every list row's `<dl>` uses (Part XXIV §24.9): ONE grid
 * per proposal whose label column is exactly the shipped 6rem unless that
 * proposal carries a longer label — *SUPERSEDED BY* was cut to *SUPERSEDE…* by the
 * per-row `grid-cols-[6rem_1fr]`, ambiguous with *SUPERSEDES*. Each row is a
 * `col-span-2` subgrid of it.
 */
const ROW_GRID =
  'mt-1.5 grid grid-cols-[minmax(6rem,max-content)_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-xs';
const ROW_SUBGRID = 'col-span-2 grid grid-cols-subgrid items-baseline';
const ROW_LABEL = 'truncate font-medium tracking-wide text-(--el-text-secondary) uppercase';

function ChangeLines({ changes }: { changes: PlanItemChangeDto[] }) {
  const t = useTranslations('planReview');
  const tl = useTranslations('labels');
  if (changes.length === 0) return null;
  const current = t('obsolescenceCurrent');
  return (
    <dl className={ROW_GRID}>
      {changes.map((change) => (
        <div key={change.field} className={ROW_SUBGRID}>
          <dt className={ROW_LABEL}>
            {/* A move into or out of a FOLDER is `Placement`, not `Parent` — a
                folder is not a parent (Part XVII §17.4). */}
            {isFolderPlacementChange(change) ? t('field_placement') : fieldLabel(t, change.field)}
          </dt>
          <dd className="min-w-0">
            {isFolderPlacementChange(change) && change.placement ? (
              <span className="inline-flex max-w-full min-w-0 items-baseline gap-1.5">
                <PlacementSide
                  side={change.placement.from}
                  fallback={change.from}
                  max={4}
                  className="text-(--el-text-secondary)"
                  segmentClassName="line-through"
                />
                <span className="shrink-0 text-(--el-text-secondary)" aria-hidden>
                  →
                </span>
                <PlacementSide
                  side={change.placement.to}
                  fallback={change.to}
                  max={4}
                  className="font-semibold text-(--el-text-strong)"
                />
              </span>
            ) : (change.field === 'supersedes' || change.field === 'supersededBy') &&
              change.refs ? (
              // The supersedes EDGES as key chips, `+` / `−`, three then `+N more`
              // (Part XXIV §24.7). No second control: the row opens the peek.
              <SupersedesChips
                added={change.refs.added}
                removed={change.refs.removed}
                signed
                layout="wrap"
              />
            ) : change.field === 'obsolescenceNote' && change.to ? (
              // The NOTE's first line, one line, the whole note in `title` —
              // prose, in `--el-text` (§24.6). Verbatim: the planner wrote it.
              <span className="block truncate text-(--el-text)" title={change.to}>
                {firstLine(change.to)}
              </span>
            ) : BODY_FIELDS.has(change.field) ? (
              <span className="font-semibold text-(--el-text-strong)">
                {t('listBodyRewritten')}
              </span>
            ) : (
              <>
                {change.from ? (
                  <span className="text-(--el-text-secondary) line-through">
                    {changeCellText(change.field, change.from, tl, current)}
                  </span>
                ) : null}
                {change.from ? (
                  <span className="px-1.5 text-(--el-text-secondary)" aria-hidden>
                    →
                  </span>
                ) : null}
                <span className="font-semibold text-(--el-text-strong)">
                  {changeCellText(
                    change.field,
                    changeToText(change, t('proposedCrumb')),
                    tl,
                    current,
                  ) ?? '—'}
                </span>
              </>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A `remove`'s REASON (MOTIR-6055 · Part XIX §19.5), in the SAME label/value
 *  grid the change lines use, WRAPPING — the list is the body that says exactly
 *  what is being approved. Verbatim: the planner wrote it for the reviewer. */
function ReasonRow({ reason }: { reason: string }) {
  const t = useTranslations('planReview');
  return (
    <dl data-testid="remove-reason" className={ROW_GRID}>
      <div className={ROW_SUBGRID}>
        <dt className={ROW_LABEL}>{t('removeReason')}</dt>
        <dd className="min-w-0 text-(--el-text)">{reason}</dd>
      </div>
    </dl>
  );
}

/** An `add`'s SUPERSEDES row (Part XXIV §24.8) — under the facts line, in the
 *  same label/value grid, unsigned chips. No refs ⇒ no row. */
function SupersedesRow({ refs }: { refs: NonNullable<PlanReviewItemDto['supersedesRefs']> }) {
  const t = useTranslations('planReview');
  return (
    <dl data-testid="supersedes-row" className={ROW_GRID}>
      <div className={ROW_SUBGRID}>
        <dt className={ROW_LABEL}>{t('field_supersedes')}</dt>
        <dd className="min-w-0">
          <SupersedesChips added={refs} signed={false} layout="wrap" />
        </dd>
      </div>
    </dl>
  );
}

/** The row cue chip's look per state (Part XXXI §31.6) — the canvas chip's token,
 *  glyph, word and name, at the list's density. */
const ROW_CUE = {
  thinking: {
    box: 'border-(--el-thinking) bg-(--el-card) text-(--el-text-secondary)',
    glyph: 'text-(--el-thinking)',
    Icon: Brain,
  },
  drafting: {
    box: 'border-(--el-drafting) bg-(--el-drafting-surface) text-(--el-text-strong)',
    glyph: 'text-(--el-drafting)',
    Icon: PenLine,
  },
  checking: {
    box: 'border-(--el-checking) bg-(--el-card) text-(--el-text-secondary)',
    glyph: 'text-(--el-checking)',
    Icon: SearchCheck,
  },
} as const;

/**
 * WHAT THE PLANNER IS DOING TO THIS ROW (Task MOTIR-11254; design Part XXXI §31.6,
 * amending §26.18) — Thinking · Drafting · Checking, the canvas chip's state at the
 * list's density. Static in every state: the list is a reading surface, so the
 * chip appears, swaps and leaves with the read. Not a live region (§31.9).
 */
function RowCue({ state }: { state: CardCueState }) {
  const t = useTranslations('planReview.cue');
  const look = ROW_CUE[state];
  return (
    <span
      role="img"
      aria-label={t(`${state}Name`)}
      data-cue={state}
      data-testid={`list-cue-${state}`}
      className={`inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) border px-(--spacing-chip-x-6) py-(--spacing-chip-y) text-[11px] leading-none font-semibold ${look.box}`}
    >
      <look.Icon aria-hidden="true" className={`size-3 ${look.glyph}`} />
      {t(state)}
    </span>
  );
}

/** A proposal row, memoised for the same reason as `PlanItemNode` (MOTIR-8575). */
const ProposalRow = memo(function ProposalRow({
  item,
  outcome,
  onOpen,
  motion,
  cue = null,
}: {
  item: PlanReviewItemDto;
  outcome: PlanItemOutcome | null;
  onOpen: (item: PlanReviewItemDto, trigger: HTMLButtonElement) => void;
  /** The live list's entrance / exit (MOTIR-6300, §23.9) — absent on a still list. */
  motion?: 'enter' | 'exit';
  /** What the planner is doing to this row right now (MOTIR-11254, §31.6). */
  cue?: CardCueState | null;
}) {
  const t = useTranslations('planReview');
  // The facts line is NODES joined by `·`, not one string (story MOTIR-6095 ·
  // MOTIR-6137, design Part XX §20.7): a leaf's DIFFICULTY rides directly after
  // the points — size beside hardness, read ACROSS siblings — as the compact
  // glyph + label. A missing value is dropped like every other empty fact, and a
  // container never carries one.
  const isContainer = item.kind === 'epic' || item.kind === 'story';
  const facts: ReactNode[] = [
    item.kind,
    item.type,
    item.storyPoints != null ? t('listPoints', { n: item.storyPoints }) : null,
    item.difficulty != null && !isContainer ? (
      <DifficultyIndicator
        difficulty={item.difficulty}
        compact={{
          srLabel: t('field_difficulty'),
          className: 'align-top',
          testId: 'plan-list-difficulty',
        }}
      />
    ) : null,
    item.estimateMinutes != null ? t('listMinutes', { n: item.estimateMinutes }) : null,
    item.targetRepo,
  ].filter((fact) => fact != null && fact !== '');

  // WHERE it lands. An INTRA-PLAN parent is marked, because that container does
  // not exist yet either and a reader deciding on this row should know.
  const parent = item.parentTitle ?? item.parentIdentifier;
  const intraPlanParent = item.parentNodeId != null && item.parentIdentifier == null;

  // THE ROW OPENS ITS PROPOSAL (MOTIR-4022, design Part XIII §7).
  //
  // ONE control per row, and it is the TITLE with a stretched `::after` — not a
  // wrapper around the whole row. Three constraints decide that shape and each
  // rules out the obvious alternative:
  //   • it may not become a row of BUTTONS (the shipped listbox-rows a11y
  //     lesson), so there is exactly one interactive element and one tab stop;
  //   • `<button>` takes PHRASING content and the change lines are a `<dl>`,
  //     which is flow — so wrapping the row would be invalid markup, and the
  //     `<dl>` stays a sibling while `after:inset-0` still makes it clickable;
  //   • the ring belongs on the ROW, not on the title's text box, so the focus
  //     outline frames the target — hence `focus-within` on the `<li>`.
  //
  // This is `ChildList`'s row grammar with a `<button>` where its `<a>` is,
  // because a proposal has no page and therefore no `href` — the one place the
  // two rows must differ.
  const name = item.identifier
    ? `${item.identifier} · ${item.title}`
    : `${t('newItem')} · ${item.title}`;

  return (
    <li
      className={
        'relative grid grid-cols-[1.125rem_1fr_auto] items-start gap-3 rounded-(--radius-control) ' +
        'px-(--spacing-control-x) py-(--spacing-control-y) hover:bg-(--el-surface) ' +
        'focus-within:ring-2 focus-within:ring-(--focus-ring-color) active:bg-(--el-surface-soft)' +
        (motion ? ` plan-list-row--${motion}` : '')
      }
      data-motion={motion}
      // A leaving row is on its way out: it takes no focus and no click.
      inert={motion === 'exit' || undefined}
    >
      <IssueTypeIcon type={issueTypeOf(item.kind)} className="mt-0.5 h-4 w-4" />
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          {item.identifier ? (
            <span className="shrink-0 font-mono text-xs font-semibold text-(--el-text-secondary)">
              {item.identifier}
            </span>
          ) : (
            // An `add` has NO KEY until approve materializes it. An empty slot in
            // a column of keys reads as a missing value; this reads as the fact.
            <span className="shrink-0 font-mono text-xs font-semibold text-(--el-text-secondary)">
              {t('listNoKey')}
            </span>
          )}
          <button
            type="button"
            aria-label={t('rowOpenAria', { name })}
            onClick={(event) => onOpen(item, event.currentTarget)}
            className={
              'truncate text-left text-sm font-semibold text-(--el-text) ' +
              'after:absolute after:inset-0 hover:underline focus-visible:outline-none' +
              (item.op === 'remove' ? ' line-through' : '')
            }
          >
            {item.title}
          </button>
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-(--el-text-secondary)">
          {facts.length > 0 ? (
            <span>
              {facts.map((fact, i) => (
                <Fragment key={i}>
                  {i > 0 ? ' · ' : null}
                  {fact}
                </Fragment>
              ))}
            </span>
          ) : null}
          {/* WHERE it is FILED, where `under {parent}` sits — a fact on the row,
              never a grouping (Part XVII §17.3); a deleted folder says so (§17.5). */}
          {item.folderMissing ? (
            <span className="inline-flex items-center gap-1" data-testid="list-folder-missing">
              <FolderX className="h-3 w-3 shrink-0" aria-hidden />
              {t('folderMissing')}
            </span>
          ) : item.op === 'add' && item.folderPath && item.folderPath.length > 0 ? (
            <span className="inline-flex min-w-0 items-center gap-1" data-testid="list-folder-fact">
              <span aria-hidden>{t('listInFolder', { path: '' }).trim()}</span>
              <FolderPathLabel
                path={item.folderPath}
                max={4}
                glyphClassName="h-3 w-3"
                lastClassName=""
                srText={t('listInFolder', { path: folderPathText(item.folderPath) })}
              />
            </span>
          ) : null}
          {parent ? (
            <span>
              {t('listUnder', { parent })}
              {intraPlanParent ? <em className="not-italic"> {t('listProposedParent')}</em> : null}
            </span>
          ) : null}
        </div>
        <ChangeLines changes={item.changes} />
        {/* What the mark does to the card, said ONCE, in words (Part XXIV
            §24.4): drawn when the plan SETS or CHANGES a mark on a finished card
            — not on a clear, not on an edges-only `modify`, and never on a
            decided plan, whose record tense forecasts nothing. */}
        {outcome === null && proposedMarkOf(item) && item.statusCategory === 'done' ? (
          <p data-testid="mark-holds-status" className="mt-1 text-xs text-(--el-text-secondary)">
            {t('markHoldsStatus', { status: item.statusLabel ?? item.status ?? '' })}
          </p>
        ) : null}
        {item.op === 'add' && item.supersedesRefs && item.supersedesRefs.length > 0 ? (
          <SupersedesRow refs={item.supersedesRefs} />
        ) : null}
        {item.op === 'remove' && item.removeReason ? (
          <ReasonRow reason={item.removeReason} />
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {/* THE ROW CUE CHIP (MOTIR-11254, §31.6) — FIRST in the cluster, before
            the Revised / Stale pills, the status pill and the op chip. */}
        {cue ? <RowCue state={cue} /> : null}
        {/* MOVED in the plan's latest revision (Part XII §E). The SHIPPED `Pill`
            in the SHIPPED slot, in front of the op chip — the same cluster the
            stale pill uses, which is also a "something happened to this row"
            marker. It contains its own WORD, so no row's state is carried by
            colour alone, and the op chip is untouched: op says WHICH kind of
            change this is, the pill says THAT this one moved. */}
        {item.revised ? (
          <Pill severity="info">
            <RotateCw className="h-3 w-3" aria-hidden />
            {t('listRevised')}
          </Pill>
        ) : null}
        {item.stale || item.folderMissing ? (
          <Pill severity="warning">
            <AlertTriangle className="h-3 w-3" aria-hidden />
            {t('listStale')}
          </Pill>
        ) : null}
        {item.statusLabel ? (
          <StatusPill
            statusKey={item.status}
            category={item.statusCategory}
            label={item.statusLabel}
          />
        ) : null}
        <OpChip op={item.op} outcome={outcome} />
      </div>
    </li>
  );
});

export interface PlanProposalListProps {
  items: PlanReviewItemDto[];
  /**
   * The plan's DECISION — `'accepted'` / `'declined'` / `null` — the same value
   * `PlanDetail` already computes for the canvas, never a `decided` boolean
   * (MOTIR-4495).
   *
   * An APPROVED plan's list is a RECORD, in the past tense Part VI gave the
   * canvas. A DECLINED plan's keeps the PROPOSAL tense: nothing happened to
   * those cards, and saying `Created` about a card that was never created is
   * wrong in the same line that says `no key yet` (Part VIII §3).
   */
  outcome: PlanItemOutcome | null;
  /**
   * The plan is being WRITTEN (MOTIR-6300; design Part XXIII §23.9). The empty
   * statement is present-tense — the shipped one says the plan FINISHED, which a
   * generating plan has not — and rows that arrive after the list mounted enter
   * with the card's entrance, while a withdrawn row leaves with the exit. OFF by
   * default: the plan page never passes it.
   */
  live?: boolean;
  /**
   * The cards being WRITTEN (MOTIR-11201, Part XXIX) — handed to the open
   * proposal's quick view. Read only while `live`.
   */
  liveDrafts?: LiveDrafts | null;
  /**
   * What the planner is doing to each row right now (Task MOTIR-11254; design
   * Part XXXI §31.6) — `thinking` · `drafting` · `checking` by `planItemId`, the
   * canvas's derivation after its two-read hold, the container review left out.
   * Read on every host, the plan page included. Absent ⇒ no row carries a cue.
   */
  rowCues?: ReadonlyMap<string, CardCueState> | null;
  /**
   * The plan was DISCARDED before it finished (§23.12): the empty statement keeps
   * the shipped title and drops the body, whose *"Declining ends it"* is false of
   * a plan already declined.
   */
  discarded?: boolean;
}

export function PlanProposalList({
  items,
  outcome,
  live = false,
  liveDrafts = null,
  rowCues = null,
  discarded = false,
}: PlanProposalListProps) {
  const t = useTranslations('planReview');
  const { entering, leaving } = useLiveRows(items, live);
  // The SAME read modal the canvas's View pill opens — this body does not gain a
  // second read view, which is the property Part XIII §7 is about. It is mounted
  // HERE rather than lifted to the island because the two bodies are mutually
  // exclusive (only one renders at a time, so the two mounts can never both be
  // open).
  //
  // ⚠️ AND THE STATE IS THE CANVAS'S COMPOUND ONE — a proposal OR a committed
  // key (`PlanReviewCanvas.tsx:231-234`), because a list row can be EITHER
  // (bug MOTIR-4471). This is the correction MOTIR-4185 item 4 asked for and did
  // not get: what stood here claimed, as a fact about the code beneath it, that
  // a row could only ever hold the proposal half — and on a DECIDED plan that is
  // false. An `add`'s `identifier` is null until approve materializes it, so an
  // `add` WITH one has become a work item; opening it as a proposal renders
  // `not yet created`, an `Open the work item as it stands →` link and a rail
  // foot saying approval will create these values, over a card that exists and
  // whose real key and status the same peek is displaying. That false premise is
  // what produced the defect, so it is gone rather than annotated.
  const [peeked, setPeeked] = useState<{ proposal: PlanReviewItemDto | null; key: string | null }>({
    proposal: null,
    key: null,
  });
  // WHILE THE PLAN IS WRITTEN the open peek follows the live item by its
  // `planItemId` (MOTIR-8595), so a field that arrives mid-view reaches it. A
  // proposal withdrawn mid-view keeps its last copy: closing is the reader's act.
  // Off `live` it is the copy taken at open, as shipped.
  const peekedProposal =
    live && peeked.proposal
      ? (items.find((i) => i.planItemId === peeked.proposal?.planItemId) ?? peeked.proposal)
      : peeked.proposal;
  // ⚠️ FOCUS RETURN IS EXPLICIT HERE, and it is not redundant with the modal's own
  // (MOTIR-4022). The dialog is mounted INSIDE this list, so closing it unmounts
  // the dialog in the same commit that re-renders the rows — and the restore the
  // shipped `Modal` performs on unmount lands before the row it should return to
  // is settled, leaving focus on the body. Measured: a keyboard user who opened a
  // row with Enter and pressed Escape was returned to nothing and had to Tab from
  // the top of the page. Remembering the trigger and refocusing it after the close
  // is one ref and closes that.
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const openPeek = useCallback((item: PlanReviewItemDto, trigger: HTMLButtonElement) => {
    triggerRef.current = trigger;
    // The SAME test the canvas's View pill applies (`PlanReviewCanvas.onView`,
    // MOTIR-3161), and the one `op === 'add'` test that survived Part XIV's
    // collapse: an `add` carrying an identifier is a COMMITTED card, so it opens
    // the ordinary work-item peek. Every other proposal — an un-materialized
    // `add`, and a `modify` / `remove` on a plan whether decided or not — opens
    // the shipped peek in PROPOSAL MODE, unchanged (MOTIR-4185).
    const materializedAdd = item.op === 'add' && item.identifier != null;
    if (!materializedAdd) setPeeked({ proposal: item, key: null });
    else setPeeked({ proposal: null, key: item.identifier });
  }, []);
  const closePeek = useCallback(() => {
    // BOTH halves, from the one handler: the two peeks are mutually exclusive by
    // construction, and a close that cleared only the half it knew about would
    // leave the other mounted.
    setPeeked({ proposal: null, key: null });
    // After the close has flushed, so the restore is not racing the unmount.
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);
  // A proposed supersedes chip on the peek's rail opens THAT proposal's peek
  // (MOTIR-6632, Part XXIV §24.7) — swapped in place; the row that opened the
  // first peek still takes focus back on close.
  const openProposalById = useCallback(
    (planItemId: string) => {
      const next = items.find((i) => i.planItemId === planItemId);
      if (next) setPeeked({ proposal: next, key: null });
    },
    [items],
  );

  // ⚠️ BOTH BOXES RESERVE `--canvas-foot-inset` AT THEIR BOTTOM (MOTIR-7726). On
  // the planning surface the confirm bar FLOATS over the pane's bottom edge
  // (MOTIR-6186, Part XXI 21.8) and the host publishes its height as that
  // variable. A scroller that ignores it ends its scroll range at the pane's edge,
  // under the bar: a list that fits the box but not the space above the bar never
  // overflows — no scrollbar, the wheel does nothing — and a list that does
  // overflow still ends with its last row behind the bar. Padding the scroller's
  // own end puts that strip INSIDE the scroll range. The `0px` fallback keeps the
  // plan page, which sets no inset, exactly as it was.
  if (items.length === 0 && leaving.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8 pb-[calc(--spacing(8)+var(--canvas-foot-inset,0px))]">
        <div className="max-w-[24rem] text-center">
          <p className="text-sm font-semibold text-(--el-text)">
            {t(live ? 'listWritingTitle' : 'listEmptyTitle')}
          </p>
          {discarded ? null : (
            <p className="mt-1 text-xs text-(--el-text-secondary)">
              {t(live ? 'listWritingBody' : 'listEmptyBody')}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className="h-full overflow-y-auto p-3 pb-[calc(--spacing(3)+var(--canvas-foot-inset,0px))]"
      data-testid="plan-proposal-list"
    >
      {SECTIONS.map((section) => {
        const rows = items.filter((item) => item.op === section.op);
        // A WITHDRAWN row is drawn at the end of its section while it leaves.
        const gone = leaving.filter((item) => item.op === section.op);
        // ⚠️ ALL THREE SECTIONS, and each only when non-empty. A list showing two
        // ops under a row whose item count includes three is a surface arguing
        // with itself — and that count is on the row that got the reader here.
        // `remove` is rare, not excluded.
        if (rows.length === 0 && gone.length === 0) return null;
        return (
          <section key={section.op} className="mb-4 last:mb-0">
            <h3 className="mb-1.5 flex items-center gap-2 px-(--spacing-control-x) text-xs font-semibold tracking-wide text-(--el-text-secondary) uppercase">
              {t(vocabularyFor(section, outcome).headingKey)}
              <Pill tone="neutral">{rows.length}</Pill>
            </h3>
            <ul className="flex flex-col">
              {rows.map((item) => (
                <ProposalRow
                  key={item.planItemId}
                  item={item}
                  outcome={outcome}
                  onOpen={openPeek}
                  cue={rowCues?.get(item.planItemId) ?? null}
                  {...(entering.has(item.planItemId) ? { motion: 'enter' as const } : {})}
                />
              ))}
              {gone.map((item) => (
                <ProposalRow
                  key={item.planItemId}
                  item={item}
                  outcome={outcome}
                  onOpen={openPeek}
                  motion="exit"
                />
              ))}
            </ul>
          </section>
        );
      })}
      {/* BOTH peeks, exactly as the canvas mounts them (`PlanReviewCanvas.tsx:432-433`).
          The SHIPPED peek in proposal mode (MOTIR-4185) for a proposal; the ordinary
          work-item peek for an `add` that approval has already materialized
          (MOTIR-3161, bug MOTIR-4471). Each renders nothing when its half is null, so
          only one is ever open. */}
      <ProposalPeek
        item={peekedProposal}
        live={live}
        liveDrafts={liveDrafts}
        outcome={outcome}
        onClose={closePeek}
        onOpenProposal={openProposalById}
      />
      <WorkItemQuickView peekKey={peeked.key} onClose={closePeek} />
    </div>
  );
}

/** How long a withdrawn row is retained for its exit: `--transition-duration` + 50ms. */
const ROW_EXIT_MS = 150 + 50;

/**
 * THE LIVE LIST's presence (MOTIR-6300; design Part XXIII §23.9) — which rows
 * ARRIVED since the list mounted, and which LEFT and are still fading out. The
 * snapshot is the unit, exactly as on the canvas: an id that appears enters, one
 * that disappears leaves. The first read of the list plays nothing, a read that
 * changes nothing plays nothing, and under reduced motion rows simply are or are
 * not there — nothing is retained. Off (`live` false) it is inert.
 */
function useLiveRows(
  items: PlanReviewItemDto[],
  live: boolean,
): { entering: ReadonlySet<string>; leaving: PlanReviewItemDto[] } {
  const [seen, setSeen] = useState<{
    items: PlanReviewItemDto[];
    entering: ReadonlySet<string>;
    leaving: PlanReviewItemDto[];
  }>(() => ({ items, entering: new Set(), leaving: [] }));
  if (live && items !== seen.items) {
    const before = new Set(seen.items.map((i) => i.planItemId));
    const now = new Set(items.map((i) => i.planItemId));
    const arrived = items.filter((i) => !before.has(i.planItemId)).map((i) => i.planItemId);
    const reduced = prefersReducedMotion();
    const left = reduced ? [] : seen.items.filter((i) => !now.has(i.planItemId));
    setSeen({
      items,
      // An entrance stays marked once played — the class holds its end state.
      entering: reduced
        ? new Set()
        : new Set([...[...seen.entering].filter((id) => now.has(id)), ...arrived]),
      leaving: [...seen.leaving.filter((i) => !now.has(i.planItemId)), ...left],
    });
  } else if (!live && seen.items !== items) {
    setSeen({ items, entering: new Set(), leaving: [] });
  }
  // A leaving row is dropped once its exit has played.
  const leavingCount = seen.leaving.length;
  useEffect(() => {
    if (leavingCount === 0) return;
    const timer = setTimeout(() => setSeen((s) => ({ ...s, leaving: [] })), ROW_EXIT_MS);
    return () => clearTimeout(timer);
  }, [leavingCount]);
  return live
    ? { entering: seen.entering, leaving: seen.leaving }
    : { entering: EMPTY, leaving: [] };
}

const EMPTY: ReadonlySet<string> = new Set();

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;
