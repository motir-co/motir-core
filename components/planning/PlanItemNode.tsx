'use client';

import { AlertTriangle, ArchiveX, ChevronRight, Pencil, Plus, Replace } from 'lucide-react';
import { memo } from 'react';
import { useTranslations } from 'next-intl';
import {
  CardEdgeTab,
  CrossBlockedFlag,
  GhostAnchor,
  WorkItemCardShell,
  WorkItemStatusPill,
} from '@/components/planning/WorkItemNode';
import type { IssueType } from '@/lib/issues/parentRules';
import {
  isMarkChangeField,
  OBSOLESCENCE_CURRENT,
  type PlanItemChangeDto,
  type PlanReviewItemDto,
} from '@/lib/dto/planReview';
import type { WorkItemObsolescenceDto } from '@/lib/dto/workItems';
import { ObsolescencePill } from '@/components/issues/ObsolescencePill';
import { supersedesWords } from '@/components/planning/SupersedesChip';
import {
  changeToText,
  isFolderPlacementChange,
  PlacementLine,
  PlacementSide,
} from '@/components/planning/FolderPlacement';
import type { StaleReason } from '@/lib/dto/plans';
import { DifficultyIndicator } from '@/components/issues/DifficultyPicker';
import { changeCellText } from '@/components/planning/changeCellText';

// The CONTENT of a proposed PlanItem node on the plan-detail canvas (Subtask
// 7.4.5 / MOTIR-847). It draws the SAME compact card language as the shipped
// `WorkItemNode`, layered with the op treatment from the ai-planning design
// (§3 Panel B) — three DISTINCT, non-colliding visual languages that never reuse
// the red dashed/hatched language the canvas reserves for cross-story deps:
//   • add    → dashed ACCENT border + lavender (accent) tint + "add" badge.
//   • modify → the existing node + a solid INFO (sky) ring + "change" badge + an
//              inline old→new diff (old read live, new from the patch; SAME id).
//   • remove → a dimmed, NEUTRAL "will be archived" treatment (muted fill +
//              strike-through title), deliberately not red (archive is reversible).
// Stale items carry a warning badge with the reason. Tokens only; the status pill
// carries TEXT (not colour only); per-kind `IssueTypeIcon`.
//
// ⚠️ A DECIDED plan adds a FOURTH AXIS that CROSSES those three, rather than
// joining them (`design/ai-planning/design-notes.md` Part VI; bug MOTIR-3154).
// Every op can be accepted and every op can be declined, so there are six
// renderings and a fourth `op` member could only express three. The outcome
// therefore rides two channels the op treatments do not use at all — they
// already consume border style, border colour, fill, the ring, opacity and the
// strike:
//   • a TAB on the card's top edge carrying the WORD (`accepted` /
//     `declined`), which is the whole of the meaning — the "You are here" tab's
//     frame (`CardEdgeTab`), so it costs the fixed-width tag row nothing. Until
//     MOTIR-11545 the word rode a second segment fused onto the op badge, and
//     that segment pushed the status pill and the Blocked chip past the card's
//     right edge; and
//   • a solid spine on the node's inline-start edge, decorative (`aria-hidden`),
//     so the outcome survives a zoom-out where 10.5px chip text does not.
// The spine's two values are the review rail's OWN outcome colours one component
// down (`--el-success` on "Added N items to your backlog"; the neutral on "Plan
// declined"), so this introduces no vocabulary. No reserved canvas language is
// approached: each of those is a border STYLE (dashed pending / dotted skippable
// / dashed not-in-sprint) or a red CHIP (blocked elsewhere), and this is neither.

// ⚠️ THE THIRD COPY OF THE STATUS SET USED TO LIVE HERE, AND IT IS GONE (bug
// MOTIR-3170). It was a six-member literal that coerced anything outside itself
// to `todo`, so a `modify` proposal whose live target sat at `implemented` drew
// on the plan canvas as **To Do** — a confident false statement about a card
// whose pull request was open. The status KEY now travels verbatim to the ONE
// shared chip (`WorkItemStatusPill` → `lib/workflows/canvasStatusMeta.ts`), and
// there is deliberately no mapping left in `components/planning/` to forget to
// update the next time a status is added.
const KNOWN_KINDS = new Set<IssueType>(['epic', 'story', 'task', 'bug', 'subtask']);

function toKind(raw: string): IssueType {
  return KNOWN_KINDS.has(raw as IssueType) ? (raw as IssueType) : 'task';
}

// ⚠️ NO `KIND_TINT` HERE (MOTIR-6296, absorbing bug MOTIR-6196). An identical
// copy of `WorkItemNode`'s map used to live on this line, and with it a second
// drawing of the whole card body (`p-3` against the committed card's `p-3.5`).
// The card is now `WorkItemCardShell`, and this file contributes only the op
// LAYER over it.

/**
 * The hatched surface that makes a LOCKED proposal legibly immutable (the shipped
 * `GhostAnchor` hatch technique, in neutral tokens — the stripes are drawn over
 * the real card, so its own content stays readable underneath).
 *
 * Its HOME is the one card (MOTIR-6296 · Part XXIII §23.4): `locked` is drawn
 * ONLY on a `modify` / `remove` whose target is terminal, which is a fact about a
 * PROPOSAL, so it lives with the proposal's layer, and nowhere else draws it.
 *
 * Deliberately SPARSE + palette-derived: the stripes must read as "hatched, so
 * not editable" without competing with the card's own title underneath (a dense
 * hatch made the struck-through title unreadable in the live render).
 */
export const LOCK_HATCH =
  'repeating-linear-gradient(135deg, transparent, transparent 13px, color-mix(in srgb, var(--el-muted) 60%, transparent) 13px, color-mix(in srgb, var(--el-muted) 60%, transparent) 15px)';

/**
 * Is this proposal LOCKED — one approve will REFUSE? (Part XXIII §23.4: the ONE
 * place `locked` appears; Part XXIV §24.4 narrows it to exactly that meaning.)
 *
 *   · a `remove` of a finished target → locked;
 *   · a `modify` of a finished target → locked, UNLESS it is a MARK `modify` —
 *     every change row in the mark group (mark · note · supersedes edges), the one
 *     `modify` a finished card accepts (MOTIR-6629's mark-only carve-out). That is
 *     every mark a plan can propose, so it is drawn as a mark, never as a refusal;
 *   · a `modify` that SETS `outdated` / `deprecated` on an UNFINISHED target →
 *     locked. It reaches the review one way only — the target was finished when
 *     the plan was written and has been reopened since — and MOTIR-6663 refuses it
 *     at approve.
 *
 * Read off the target's lifecycle CATEGORY from the wire, never a hand-copied
 * status set (bug MOTIR-3170), and off the CHANGE LIST — the projection MOTIR-6629
 * and MOTIR-6663 key their checks on — never a flag. `changes` is optional so a
 * caller holding only `op` × category keeps the pre-mark answer.
 */
export function isLockedProposal(
  item: Pick<PlanReviewItemDto, 'op' | 'statusCategory'> & {
    changes?: readonly Pick<PlanItemChangeDto, 'field' | 'to'>[];
  },
): boolean {
  const changes = item.changes ?? [];
  if (item.statusCategory === 'done') {
    if (item.op === 'remove') return true;
    if (item.op !== 'modify') return false;
    const markOnly = changes.length > 0 && changes.every((c) => isMarkChangeField(c.field));
    return !markOnly;
  }
  return (
    item.op === 'modify' &&
    item.statusCategory != null &&
    changes.some((c) => c.field === 'obsolescence' && c.to !== OBSOLESCENCE_CURRENT)
  );
}

/** The mark approve will WRITE, when this `modify` sets or changes one — `null`
 *  for a clear, for a `modify` that does not touch the mark, and for any other op
 *  (Part XXIV §24.5: a clear draws no pill; an `add` never carries a mark). */
export function proposedMarkOf(
  item: Pick<PlanReviewItemDto, 'op' | 'changes'>,
): WorkItemObsolescenceDto | null {
  if (item.op !== 'modify') return null;
  const row = item.changes.find((c) => c.field === 'obsolescence');
  return row && (row.to === 'outdated' || row.to === 'deprecated') ? row.to : null;
}

function staleReasonLabel(r: StaleReason, t: ReturnType<typeof useTranslations>): string {
  switch (r.code) {
    case 'parent_removed':
      return t('staleParentRemoved');
    case 'blocker_removed':
      return t('staleBlockerRemoved');
    case 'base_revision_drift':
      return t(`staleDrift_${r.change}`);
  }
}

// ⚠️ The node carries NO edit affordance (MOTIR-3084). MOTIR-1370's inline-edit
// pencil and its modal are REMOVED: a proposal is READ — the canvas peek — and
// changed by re-planning, not hand-corrected in a five-field form. The design
// records the supersession in `design/ai-planning/design-notes.md` Part V §3.
/** The plan's decision, once it has one. `null` while the plan is still
 *  `planned` — which is every rendering that shipped before MOTIR-3161. */
export type PlanItemOutcome = 'accepted' | 'declined';

/**
 * A proposal on the canvas, memoised (Story MOTIR-8539 · MOTIR-8575): a plan
 * snapshot is merged by identity (`mergePlanReview`), so an unchanged proposal
 * keeps its `item` object and this node does not re-render on a re-read.
 */
export const PlanItemNode = memo(function PlanItemNode({
  item,
  outcome = null,
  crossBlocked = false,
}: {
  item: PlanReviewItemDto;
  outcome?: PlanItemOutcome | null;
  /**
   * Blocked by a card OFF this level (bug MOTIR-5387) — the dependent's half of
   * the roadmap's off-level treatment, drawn with the roadmap's own chip and in
   * the slot `WorkItemNode` gives it. It is a DEPENDENCY fact, so it crosses
   * every op and outcome rather than joining them: an `add` that will be blocked
   * from another container is exactly the bad plan the legend warns about, and
   * the warning belongs before approve.
   */
  crossBlocked?: boolean;
}) {
  const t = useTranslations('planReview');
  const kind = toKind(item.kind);
  // THE BOTTOM SLOT (Part XVII §17.2, amended by Part XVIII decision 2). A
  // `modify` spends it on its diff line; a proposal naming a DELETED folder spends
  // it on saying so. At most one tenant.
  //
  // ⚠️ A FILED `add` NO LONGER SPENDS IT ON ITS FOLDER (Bug MOTIR-5782). Part XVII
  // drew the placement line because a filed proposal was drawn among the ROOTS —
  // no canvas level was a folder. Both planning canvases now draw it ON its
  // folder's level, where the breadcrumb already says where the reader is
  // standing, so the line would repeat the crumb and cost the title its second
  // line. The LIST body keeps its `in [folder]` fact (§17.3), unchanged.
  const showDiff = item.op === 'modify' && item.changes.length > 0;
  const showPlacement = !showDiff && item.folderMissing;
  // A `remove`'s REASON (MOTIR-6055 · Part XIX §19.5): a remove never spent the
  // slot, so its reason takes it — after a stale folder, which is the one tenant
  // a remove could already have. No reason ⇒ no slot, byte-identical to before.
  const showReason = !showDiff && !showPlacement && item.op === 'remove' && !!item.removeReason;
  const hasSlot = showDiff || showPlacement || showReason;
  // A deleted folder is a STALE fact the staleness read does not report (MOTIR-5415
  // carries it as `folderMissing`), so the node adds its reason beside the shipped ones.
  const staleReasons = item.staleReasons.map((r) => staleReasonLabel(r, t));
  if (item.folderMissing) staleReasons.push(t('staleFolderRemoved'));
  const showStale = item.stale || item.folderMissing;
  const showDifficulty =
    item.op === 'add' && item.difficulty != null && kind !== 'epic' && kind !== 'story';

  const locked = isLockedProposal(item);
  // The mark approve will WRITE (Part XXIV §24.5) — directly before the status
  // pill; a clear draws none, since the card will carry none.
  const proposedMark = proposedMarkOf(item);
  // An `add` that SUPERSEDES cards (§24.8) — a compact count before the
  // difficulty indicator (and before the drill chevron on a container); no refs ⇒
  // nothing, byte-identical to before.
  const supersedes = item.op === 'add' ? (item.supersedesRefs ?? []) : [];
  // THE TAG ROW'S FORMS (MOTIR-11545, design Part XXX; widened to the undecided
  // card by MOTIR-11549, Part XXXI). The card is a fixed 280px with every tag
  // `shrink-0`, so the row takes the committed card's tag-row forms (MOTIR-10508)
  // on EVERY plan card, decided or not: the status as the truncating SLOT and the
  // SHORT blocked flag — and the committed card's GIVE-WAY RULE ("When the tag row
  // overflows"): a right-hand TEXT tag (the blocked flag, the stale badge, the
  // `Supersedes N` chip) drops the status and the op chip to their glyphs (the op
  // chip is this card's Manual chip, a type chip on the left) and the difficulty
  // out of the row (the peek carries it). A fixed rule, not a measurement: with a
  // text tag beside them the words measured 18–34px past the 254px row on a
  // decided card in every style, and an undecided blocked `add` with a difficulty
  // 70px past it (MOTIR-11549).
  //
  // The `Supersedes N` chip is the `Replace` glyph alone — its words on
  // `aria-label`, the keys on `title` — because its words beside the key and two
  // glyphs still ran 1.4px past the row. When it meets ANOTHER text tag (blocked,
  // stale) even the glyph runs 1.7–9.7px past in five styles, so it leaves the row
  // the way the difficulty does: the quick view's Supersedes row
  // (`ProposalSupersedesRows`) carries it. Measured in design Part XXX §30.4.
  //
  // Once the plan is decided an accepted `add` IS a work item: it gains its real
  // five-digit key and a live status, and a card that carries a live STATUS never
  // draws its difficulty in the row — the committed card it now is draws none, and
  // `To Do` beside `High` already overflows the room the op chip leaves. An
  // undecided `add` has no status, so it keeps its difficulty unless it gives way.
  const decided = outcome != null;
  const textTag = crossBlocked || showStale;
  const giveWay = textTag || supersedes.length > 0;
  const supersedesGlyphOnly = supersedes.length > 0;
  const supersedesInRow = supersedes.length > 0 && !textTag;

  // Op-specific frame — what the op MEANS, layered on the shell (which owns the
  // border weight, radius and padding). None reuses the cross-story red
  // dashed/hatch language.
  const frame =
    item.op === 'add'
      ? 'border-dashed border-(--el-accent) bg-(--el-tint-lavender) shadow-(--shadow-card)'
      : item.op === 'remove'
        ? // ⚠️ NO `opacity` ON EITHER ARM (MOTIR-4475). A DECIDED `remove` already
          // dropped the fade (Part VI §3, MOTIR-4260); the PENDING one carried
          // `opacity-80` on this same element, which paints the fill — and CSS
          // `opacity` composites the element AND ITS WHOLE SUBTREE against the
          // backdrop, so the frame and every string inside it were mixed at 0.8
          // over the board's `--el-canvas`. Measured on the composed DOM: the
          // title at 3.95:1, the identifier at 3.95:1, the status pill at 3.95:1
          // and the op badge at 3.98:1, all under AA's 4.50 — and all of it
          // SURVIVING MOTIR-4260's re-inking, because opacity scales whatever ink
          // you pick. That is MOTIR-2495's rule at a second site: "no ink choice
          // can fix it", and its remedy is to carry the state as COLOUR.
          //
          // Nothing is lost by removing it, which is what makes colour the whole
          // remedy here rather than half of one. `remove` already speaks through
          // three other channels — the strong border, the muted fill and the
          // strike — and the PENDING/DECIDED distinction is carried by the two
          // signals a decided node ADDS: the outcome spine below and the outcome
          // tab on its top edge. That is exactly how `add` and
          // `modify` distinguish the same two states, and neither of them dims.
          //
          // `tests/components/composed-surface-ink.test.tsx` mounts the pending
          // node on its own `--el-canvas` board and measures the composite, so a
          // re-introduced `opacity-*` on a text-bearing subtree goes red here
          // rather than on somebody's screen.
          'border-(--el-border-strong) bg-(--el-muted) shadow-(--shadow-subtle)'
        : 'border-(--el-border) bg-(--el-surface) ring-2 ring-(--el-info) shadow-(--shadow-card)';

  return (
    <WorkItemCardShell
      frameClassName={frame}
      data-op={item.op}
      data-outcome={outcome ?? undefined}
      data-locked={locked ? 'true' : undefined}
      data-testid="plan-item-node"
      tab={outcome ? <PlanItemOutcomeTab outcome={outcome} /> : null}
      // A locked proposal cannot be applied — the approve is refused server-side
      // for a finished target — so say so rather than imply it.
      aria-disabled={locked ? true : undefined}
      // TOP ROW — the op badge (left) + the status pill / stale flag (right).
      statusRow={
        <>
          {/* The PLAIN op chip, on a decided plan too (MOTIR-11545): the outcome
              rides the top-edge tab, not a segment fused onto this chip. Under the
              give-way rule above it is the op's glyph alone. */}
          <PlanItemOpBadge op={item.op} glyphOnly={giveWay} />
          {/* `min-w-0`, so the status SLOT below can truncate inside the row rather
              than push the right-hand tags past the card's edge (MOTIR-11545,
              MOTIR-11549). */}
          <div className="ml-auto flex min-w-0 items-center gap-1.5">
            {showStale ? (
              <span
                data-testid="stale-badge"
                title={staleReasons.join(' · ')}
                className="inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) bg-(--el-tint-yellow) px-(--spacing-chip-x-6) py-(--spacing-chip-y) text-[11px] font-semibold text-(--el-text-strong)"
              >
                <AlertTriangle className="size-3" aria-hidden="true" />
                {t('staleBadge')}
              </span>
            ) : null}
            {/* The target's status in the COMMITTED card's vocabulary — the same
                chip, fed the same wire identity (`statusLabel` / `statusCategory`),
                so a custom status reads as itself, never as a default. */}
            {proposedMark ? (
              <ObsolescencePill
                mark={proposedMark}
                size="node"
                srPrefix={t('nodeProposedMark')}
                testId="plan-item-obsolescence"
              />
            ) : null}
            {item.status ? (
              // The TAG-ROW slot form (MOTIR-10508), as on the committed card: it
              // truncates last and carries its name on `title`; under the give-way
              // rule it is the glyph alone (MOTIR-11545, MOTIR-11549).
              <WorkItemStatusPill
                status={item.status}
                label={item.statusLabel}
                category={item.statusCategory}
                slot
                glyphOnly={giveWay}
              />
            ) : null}
            {supersedesInRow ? (
              <span
                className="inline-flex shrink-0 items-center gap-1 text-xs text-(--el-text-secondary)"
                data-testid="plan-item-supersedes"
                title={t('nodeSupersedesTitle', {
                  keys: supersedes
                    .map((c) =>
                      c.proposed ? `${t('proposedCrumb')} · ${c.title}` : (c.identifier ?? c.title),
                    )
                    .join(' · '),
                })}
                // The glyph alone (MOTIR-11545, MOTIR-11549): it is then the
                // chip's only content, so it is a labelled image in the secondary
                // ink (graphics owe 3:1), not the faint decorative glyph that sits
                // beside the words.
                {...(supersedesGlyphOnly
                  ? {
                      role: 'img',
                      'aria-label': t('nodeSupersedes', { n: supersedes.length }),
                    }
                  : {})}
              >
                <Replace
                  className={`h-3 w-3 shrink-0 ${supersedesGlyphOnly ? 'text-(--el-text-secondary)' : 'text-(--el-text-faint)'}`}
                  aria-hidden
                />
                {supersedesGlyphOnly ? null : t('nodeSupersedes', { n: supersedes.length })}
              </span>
            ) : null}
            {crossBlocked ? (
              // The SHORT flag (`blocked`, the sentence on `title` / `aria-label`),
              // the committed card's tag-row form (MOTIR-11545, MOTIR-11549).
              <CrossBlockedFlag short />
            ) : item.hasChildren ? (
              <ChevronRight
                className="size-4 shrink-0 text-(--el-text-muted)"
                aria-hidden="true"
                data-testid="drill-affordance"
              />
            ) : null}
            {/* A leaf `add`'s DIFFICULTY (story MOTIR-6095 · MOTIR-6137, design
                Part XX §20.3) — at the right end of the top row, where an `add`
                has nothing today, never in the bottom slot (spending it clamps the
                title to one line). ONLY an `add`: a `modify` card says what
                CHANGES (its diff line), and a container never carries one. None ⇒
                nothing drawn — the card has no field labels to hang a `None` on. */}
            {showDifficulty && !giveWay && !(decided && item.status) ? (
              <DifficultyIndicator
                difficulty={item.difficulty!}
                compact={{
                  srLabel: t('field_difficulty'),
                  className: 'text-xs text-(--el-text-secondary)',
                  testId: 'plan-item-difficulty',
                }}
              />
            ) : null}
          </div>
        </>
      }
      kind={kind}
      identifier={item.identifier ?? t('newItem')}
      title={item.title}
      // The struck title is `remove`'s second signal (MOTIR-4260) — a strike RULE
      // is a graphic rather than text; the ink is the shell's secondary.
      titleStruck={item.op === 'remove'}
      // ⚠️ ONE LINE WHENEVER THE BOTTOM SLOT IS SPENT (Part XVII §17.2). The node is
      // a fixed 280 × 124: a two-line title plus the key plus a 16px slot does not
      // fit, and the body's `overflow-hidden` cut the second title line through its
      // middle. One clean ellipsis, the full title in `title`.
      titleSingleLine={hasSlot}
      footer={
        showDiff ? (
          // MODIFY diff — a compact old→new line (the first change; "+N" when more).
          <PlanItemDiffLine changes={item.changes} />
        ) : showPlacement ? (
          <PlacementLine folderPath={item.folderPath} folderMissing={item.folderMissing} />
        ) : showReason ? (
          <ReasonLine reason={item.removeReason!} label={t('removeReason')} />
        ) : null
      }
      overlay={
        <>
          {/* The outcome SPINE — decorative reinforcement only; the word in the
              outcome tab carries the meaning, which is what keeps this off colour-alone
              and discharges 1.4.11 on the bar itself. Drawn HERE and nowhere else
              (MOTIR-6296): the one card owns the one spine. */}
          {outcome ? (
            <span
              aria-hidden="true"
              data-testid="plan-item-outcome-spine"
              className={`absolute inset-y-0 start-0 w-1 ${
                outcome === 'accepted' ? 'bg-(--el-success)' : 'bg-(--el-text-muted)'
              }`}
            />
          ) : null}
          {/* LOCKED — the hatch over a `modify` / `remove` of a finished target
              (Part XXIII §23.4). Over the op's own frame, never instead of it: the
              info ring / struck title still say what was proposed. */}
          {locked ? (
            <span
              aria-hidden="true"
              data-testid="plan-item-lock-hatch"
              className="pointer-events-none absolute inset-0 rounded-(--radius-card)"
              style={{ backgroundImage: LOCK_HATCH }}
            />
          ) : null}
        </>
      }
    />
  );
});

/** The remove's reason on ONE line — the node is a glance; the list row and the
 *  peek carry it in full, and so does `title` here. Written by the planner for
 *  the reviewer, so it is shown verbatim, never translated. */
function ReasonLine({ reason, label }: { reason: string; label: string }) {
  return (
    <div
      data-testid="remove-reason"
      className="mt-1.5 flex shrink-0 items-center gap-1 overflow-hidden text-xs text-(--el-text-secondary)"
    >
      <span className="shrink-0 font-medium text-(--el-text-secondary)">{label}</span>
      <span className="truncate text-(--el-text)" title={reason}>
        {reason}
      </span>
    </div>
  );
}

/**
 * A decided plan card's OUTCOME — `accepted` / `declined` — as a tab on the
 * card's top edge (MOTIR-11545, `design/ai-planning/design-notes.md` Part XXX),
 * in the "You are here" tab's frame and the outcome's own tones from Part VI §3:
 * mint + strong ink for accepted, muted + secondary ink for declined, both AA.
 * The word is the whole of the meaning and is read out; the spine is decoration.
 */
export function PlanItemOutcomeTab({ outcome }: { outcome: PlanItemOutcome }) {
  const t = useTranslations('planReview');
  return (
    <CardEdgeTab
      testId="plan-item-outcome-tab"
      toneClassName={
        outcome === 'accepted'
          ? 'bg-(--el-tint-mint) text-(--el-text-strong)'
          : 'bg-(--el-muted) text-(--el-text-secondary)'
      }
    >
      {outcome === 'accepted' ? t('outcomeAccepted') : t('outcomeDeclined')}
    </CardEdgeTab>
  );
}

/**
 * The op badge, with the OUTCOME fused to its trailing edge once the plan is
 * decided — so the chip reads `op × outcome` (Part VI §3). The fused form is the
 * LEVEL band's (`LevelChangeBand`), which is not a fixed-width card; the canvas
 * card passes no outcome and draws it as {@link PlanItemOutcomeTab} instead.
 *
 * Segment 1 is the SHIPPED op tone, unchanged; segment 2 is the outcome. The
 * word is the whole of the meaning, which is what keeps the decided state off
 * colour-alone (Part I §4's a11y rule) — the spine on the node is decorative
 * reinforcement for a zoom-out, never the signal.
 */
export function PlanItemOpBadge({
  op,
  outcome = null,
  glyphOnly = false,
}: {
  op: PlanReviewItemDto['op'];
  outcome?: PlanItemOutcome | null;
  /** The give-way form (MOTIR-11545): the op's glyph alone, its word on
   *  `aria-label` (`role="img"`) and `title` — the committed card drops its Manual
   *  chip the same way. Only the plain chip has this form: with an `outcome`
   *  (the level band's fused chip) it is ignored. */
  glyphOnly?: boolean;
}) {
  const t = useTranslations('planReview');
  const seg = 'inline-flex shrink-0 items-center gap-1 px-1.5 py-0.5 text-[11px] font-semibold';
  const opSeg =
    op === 'add'
      ? `${seg} bg-(--el-surface) text-(--el-accent-on-surface)`
      : op === 'remove'
        ? `${seg} bg-(--el-surface) text-(--el-text-secondary)`
        : `${seg} bg-(--el-tint-sky) text-(--el-text-strong)`;
  const glyph =
    op === 'add' ? (
      <Plus className="size-3" aria-hidden="true" />
    ) : op === 'remove' ? (
      <ArchiveX className="size-3" aria-hidden="true" />
    ) : (
      <Pencil className="size-3" aria-hidden="true" />
    );
  const label = op === 'add' ? t('opAdd') : op === 'remove' ? t('opRemove') : t('opModify');

  if (!outcome && glyphOnly) {
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        data-testid="plan-item-op-glyph"
        className={`${opSeg} rounded-(--radius-badge)`}
      >
        {glyph}
      </span>
    );
  }

  // Undecided: exactly the shipped badge, byte for byte.
  if (!outcome) {
    return (
      <span className={`${opSeg} rounded-(--radius-badge)`}>
        {glyph}
        {label}
      </span>
    );
  }

  return (
    <span
      className="inline-flex shrink-0 items-stretch overflow-hidden rounded-(--radius-badge)"
      data-testid="plan-item-op-chip"
    >
      <span className={opSeg}>
        {glyph}
        {label}
      </span>
      <span
        data-testid="plan-item-outcome"
        className={`${seg} border-s border-(--el-border-soft) ${
          outcome === 'accepted'
            ? 'bg-(--el-tint-mint) text-(--el-text-strong)'
            : 'bg-(--el-muted) text-(--el-text-secondary)'
        }`}
      >
        {outcome === 'accepted' ? t('outcomeAccepted') : t('outcomeDeclined')}
      </span>
    </span>
  );
}

/** The label for a changed field, degrading to the field's own WIRE NAME when
 *  the catalog has no message for it (MOTIR-3151).
 *
 *  The key is INTERPOLATED (`field_<name>`), so nothing checks it at build time:
 *  `buildChanges` grew `storyPoints` / `estimateMinutes` in MOTIR-1532 and the
 *  labels never followed, and with no `getMessageFallback` configured
 *  (`i18n/request.ts`) `t()` renders the KEY PATH — a reader of the approve
 *  screen saw `planReview.field_storyPoints` where a word belongs. `t.has()`
 *  asks the catalog first, so the NEXT field somebody teaches `buildChanges` to
 *  emit degrades to something readable instead of leaking a key. This is the
 *  same fallback the (since retired, MOTIR-4261) `PlanEditsReviewDock` had,
 *  which is why its own gap was cosmetic and this one was not.
 *
 *  The copy itself is still owed — `plan-change-field-labels.test.tsx` fails
 *  when a `PLAN_ITEM_CHANGE_FIELDS` member has no message.
 *
 *  EXPORTED (MOTIR-6223) so the level change band names a field in exactly the
 *  card's words; `t` must be the `planReview` translator. */
export function fieldLabel(t: ReturnType<typeof useTranslations>, field: string): string {
  const key = `field_${field}`;
  return t.has(key) ? t(key) : field;
}

/**
 * A `modify`'s FIELD-CHANGE line — the first change as old → new, "+N" when more.
 * Exported (MOTIR-6296) so a later surface composes it rather than copying it.
 */
export function PlanItemDiffLine({ changes }: { changes: PlanItemChangeDto[] }) {
  const t = useTranslations('planReview');
  const first = changes[0]!;
  const more = changes.length - 1;
  // A move into or out of a FOLDER is labelled `Placement` and draws its folder
  // side with the glyph and path (Part XVII §17.4); a work-item → work-item move
  // keeps the shipped `Parent` row byte for byte.
  const placement = isFolderPlacementChange(first) ? first.placement : undefined;
  // A move under a PROPOSED parent names it `New · <title>` (Part XIX §19.3); on
  // the 280px node it may ellipsize, so the full string rides `title`.
  const tl = useTranslations('labels');
  const current = t('obsolescenceCurrent');
  const from = changeCellText(first.field, first.from, tl, current);
  // A SUPERSEDES row that leads the line renders its chips as words —
  // `+PROD-52 · +New · <title>` (Part XXIV §24.7); no canvas edge is drawn.
  const to =
    first.field === 'supersedes' || first.field === 'supersededBy'
      ? supersedesWords(first, t('proposedCrumb'))
      : changeCellText(first.field, changeToText(first, t('proposedCrumb')), tl, current);
  return (
    <div
      data-testid="diff-line"
      className="mt-1.5 flex shrink-0 items-center gap-1 overflow-hidden text-xs text-(--el-text-secondary)"
    >
      <span className="shrink-0 font-medium text-(--el-text-secondary)">
        {placement ? t('field_placement') : fieldLabel(t, first.field)}
      </span>
      {placement ? (
        <>
          <PlacementSide
            side={placement.from}
            fallback={first.from}
            max={3}
            className="text-(--el-text-secondary)"
            segmentClassName="line-through"
          />
          <ChevronRight className="size-3 shrink-0 text-(--el-text-faint)" aria-hidden="true" />
          <PlacementSide
            side={placement.to}
            fallback={first.to}
            max={3}
            className="font-medium text-(--el-text)"
          />
        </>
      ) : (
        <>
          {from != null ? (
            <span className="truncate text-(--el-text-secondary) line-through">{from}</span>
          ) : null}
          <ChevronRight className="size-3 shrink-0 text-(--el-text-faint)" aria-hidden="true" />
          <span className="truncate font-medium text-(--el-text)" title={to ?? undefined}>
            {to ?? '—'}
          </span>
        </>
      )}
      {more > 0 ? (
        <span className="ml-auto shrink-0 text-(--el-text-secondary)">
          {t('moreChanges', { n: more })}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The ghost anchor for an off-level blocker that is itself an un-materialized
 * PROPOSAL (bug MOTIR-5387).
 *
 * Such a card has no key by construction, and a placeholder key would assert a
 * work item that does not exist. So the anchor keeps the roadmap's `KEY / title`
 * grammar and puts the proposed word in the key's SLOT — the substitution the
 * breadcrumb already makes (`design/ai-planning/design-notes.md` Part IX §1.3).
 */
export function ProposedBlockerAnchor({ title }: { title: string }) {
  const t = useTranslations('planReview');
  return <GhostAnchor identifier={t('proposedCrumb')} title={title} />;
}
