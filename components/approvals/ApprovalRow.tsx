'use client';

import { Children, useCallback, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  CircleDashed,
  GitPullRequest,
  Pencil,
  Scale,
  Signpost,
  Sparkles,
  Video,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { shallowPush } from '@/lib/navigation/shallowUrl';
import { withApprovalOverlay } from '@/lib/approvals/overlayAddress';
import { planRowDestination } from '@/lib/planning/planDestination';
import { planSentenceOf } from '@/lib/planning/planSentence';
import { PlanDestinationTag } from '@/components/planning/PlanDestinationTag';
import { BrandMark } from '@/components/brand/BrandMark';
import { usePeekRowClick } from '@/app/(authed)/items/_components/IssueQuickView';
import {
  announceGateDecided,
  clearGatePressPending,
  markGatePressPending,
  useDecidedGateState,
  useGatePressPending,
} from '@/lib/approvals/decidedGates';
import { decideApprovalGateAction } from '@/app/(authed)/items/[key]/approvalGateActions';
import { ManualWorkGlyph, useGuideDoor } from '@/components/approvals/ManualWorkGate';
import { RefusalReasonCell, showsRefusalReason } from './RefusalReason';
import { subjectGoneKey } from './subjectGoneKey';
import { useRelativeLabel } from './useRelativeLabel';
import { PlanningSessionRow } from './PlanningSessionRow';
import { useSurfaceTitleText } from '@/components/workItems/titleTranslation/SurfaceTitleTranslation';
import type {
  ApprovalGateKindDTO,
  ApprovalGateStateDTO,
  ApprovalGateSubjectSummaryDTO,
  ApprovalQueueRowDto,
  ApprovalRecordDecidedRowDto,
  ChosenOptionDTO,
  ManualWorkSubjectSummaryDTO,
  ConfirmedRecordDTO,
  DecisionApprovalSubjectSummaryDTO,
  DesignResultSubjectSummaryDTO,
  PlanApprovalSubjectSummaryDTO,
  PullRequestApprovalSubjectSummaryDTO,
} from '@/lib/dto/approvalGate';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';

// THE APPROVALS ROW — the ONE row both approval lists render: the Workbench's
// To-approve tab (Story MOTIR-4879 · MOTIR-4794) and the Approval records room
// (Story MOTIR-5299 · MOTIR-5302). Built to `design/workbench/approvals-row.mock.html`
// and § 20 of `design/workbench/design-notes.md`, as amended by § 22 (the row OPENS
// the approval overlay), and — for the room — `design/approvals/design-notes.md`
// § The ROW, which COMPOSES this row rather than redrawing it.
//
// ⚠️ EXTRACTED FROM `ApprovalsList.tsx`, NOT WRITTEN BESIDE IT (MOTIR-5302). A
// second row grammar for one object is how two views start disagreeing about what
// a settled gate looks like. An `awaiting` row with no person column renders
// exactly the markup the tab rendered before the move; the room's additions are
// CONDITIONAL ELEMENTS of this one row:
//   · a `decided` record — the decided time in the time cell, *on <version>* in the
//     subject meta, and its state pill in the Decide cell;
//   · a PERSON cell before the Decide cell, only when the list passes `person`
//     (the room's full view: *Asked of* / *Decided by*).
//
// ⚠️ THE ROW OPENS THE APPROVAL FULL SCREEN (Subtask MOTIR-5225). The whole row is a
// real `<a href="/items/<key>">` whose PLAIN PRIMARY click writes the approval
// overlay's address (`?approval=<key>&approvalKind=<kind>`, § 22) with
// `shallowPush`, so the host list never re-renders and closing returns to exactly
// this page of it. A modified, middle or secondary click opens the card in a new
// tab — `usePeekRowClick`'s exact contract. The row writes `approval`, never
// `peek`, so the two cannot collide. A DECIDED row opens it too (§ 22 Panels 8a–8b
// draw the decided states); nothing in either list decides.
//
// ⚠️ THE ROW READS AS A SENTENCE ABOUT THE WORK ITEM (Story MOTIR-5996 · MOTIR-5999;
// `design/workbench/approvals-row--plain-words.mock.html`, design-notes § 28). It
// used to lead with the gate KIND and a host meta line — *Pull requests*,
// `motir-core · #412` — which a non-technical reader had to translate. The first cell
// is now glyph · SENTENCE · key (*Design for {title}*, *{title} is finished*), the
// second cell the DETAILS, and no visible text names a host's vocabulary: repository
// numbers live in the details' `title` attribute. The KIND label is gone from the
// row; `workbench.approvals.kind.*` stays, because the overlay's dialog name reads it.
//
// ⚠️ AN AWAITING ROW DECIDED IN THE OVERLAY SETTLES IN PLACE — it does not vanish
// under the cursor. A row whose gate the overlay decided swaps its Decide cell for
// the state pill, through the signal in `lib/approvals/decidedGates.ts` (§ 22
// planning flag 2) — `router.refresh()` cannot reach a client island.

/**
 * The tab's column set — design-notes § 20, RE-WEIGHTED by § 28 (MOTIR-5999): the
 * sentence is the row's main content now, so the DETAILS track gave it 48px. The
 * room's own-records view uses it unchanged.
 *
 * The WAITED / DECIDED track is 112px (was 88): its header is one word in Polish
 * ("Rozstrzygnięto", 108px in the header's uppercase), which cannot wrap, so the
 * track sizes to it; two-word headers wrap inside it (MOTIR-7759). The sentence
 * track gives up the 24px.
 */
export const APPROVALS_GRID_TEMPLATE = 'minmax(12rem,1fr) 220px 112px 132px';

/**
 * The room's FULL-VIEW column set (`design/approvals` § The grid): the tab's, with
 * the details track narrowed to 200px and a 144px person track before the Decide
 * cell (§ 28 re-weighted it from 228px, for the same reason as the tab's).
 */
export const APPROVALS_FULL_VIEW_GRID_TEMPLATE = 'minmax(12rem,1fr) 200px 112px 144px 132px';

/**
 * WHICH SENTENCE each gate kind reads as (§ 28, DECISION 1) — TOTAL over
 * `ApprovalGateKindDTO`, so a new kind is a compile error here rather than a row that
 * silently falls through to a kind label nobody wrote. A kind this build cannot render
 * takes the neutral *Approval for {title}*: the build has no word for it.
 */
const SENTENCE_KEY: Record<ApprovalGateKindDTO, SentenceKey> = {
  design_result: 'design_result',
  acceptance_result: 'acceptance_result',
  pull_request_approval: 'pull_request_approval',
  decision_approval: 'decision_approval',
  decision_choice: 'decision_choice',
  decision_confirmation: 'decision_confirmation',
  // Superseded everywhere (MOTIR-5614): a row reached by URL is one this build does not draw.
  pull_request_merge: 'other',
  // Not raised by this build yet (MOTIR-6032 ships the kind UNREGISTERED); its row is
  // MOTIR-6037's to draw, from MOTIR-6033's design.
  plan_approval: 'other',
  // Never on a To-approve row: the review AGENT answers it, not a person (ADR §12.1).
  agent_review: 'other',
  // A run's manual card, waiting on a person (MOTIR-7474 · MOTIR-7478; § 33.2). ⚠️ THE ONE
  // KIND WHOSE SENTENCE DEPENDS ON STATE AND ROUTING: this is its awaiting form, and
  // `manualWorkSentenceKey` picks the other three.
  manual_work: 'manual_work',
  // A hosted planning session that needs its person (MOTIR-7913): the Workbench card
  // (MOTIR-7917) draws its row; until then it takes the neutral sentence, as `plan_approval` did.
  planning_session: 'other',
};

type SentenceKey =
  | 'design_result'
  | 'acceptance_result'
  | 'pull_request_approval'
  | 'decision_approval'
  | 'decision_choice'
  | 'decision_confirmation'
  | 'manual_work'
  | 'manual_work_other'
  | 'manual_work_done'
  | 'manual_work_held'
  | 'other';

/** The kinds whose subject this build renders — the rest take the neutral sentence. */
const RENDERABLE_KINDS: ReadonlySet<string> = new Set([
  'design_result',
  'acceptance_result',
  'pull_request_approval',
  'decision_approval',
  'decision_choice',
  'decision_confirmation',
  'manual_work',
]);

/** The sentence a row reads as: its kind's, or the neutral one for a kind not drawn. */
function sentenceKeyOf(kind: ApprovalGateKindDTO): SentenceKey {
  return RENDERABLE_KINDS.has(kind) ? SENTENCE_KEY[kind] : 'other';
}

/**
 * THE SENTENCE (§ 28, DECISION 1) — one ICU message per kind with a `<title>` tag, so
 * the ORDER is the catalogue's (zh puts the title first) and nothing is concatenated.
 * The frame words are `shrink-0` and never cut; the title TRUNCATES inside the
 * sentence, so *… is finished* is always read. The title is the quick-view door
 * (MOTIR-6001).
 */
function Sentence({
  sentenceKey,
  title,
  identifier,
  quiet,
}: {
  sentenceKey: SentenceKey;
  title: string;
  /** The work item's key — the title door's `href` and the quick view it opens. */
  identifier: string;
  /** A settled or unrenderable row — § 20's settled ink on both halves. */
  quiet: boolean;
}) {
  const routes = useReaderRoutes();
  const t = useTranslations('workbench.approvals.sentence');
  const peekRowClick = usePeekRowClick();
  // The ARGUMENT is `name` and the TAG is `title`: next-intl reads both from one
  // values object, so the two cannot share a name.
  const parts: ReactNode = t.rich(sentenceKey, {
    name: title,
    // THE TITLE IS A DOOR (Story MOTIR-5996 · MOTIR-6001; § 28, DECISION 3): the work
    // item's QUICK VIEW, with the exact contract every title link in the product has —
    // `usePeekRowClick`, so a modified / middle / secondary click keeps the real `href`
    // (the card in a new tab). It sits ABOVE the stretched row door on `z-10`, so the
    // rest of the row still opens the approval. No ring of its own: the row draws
    // `focus-within:ring-2` around itself, and the underline says which door has it.
    title: (chunks) => (
      <Link
        key="title"
        href={routes.item(identifier)}
        onClick={(e) => peekRowClick(e, identifier)}
        className={cn(
          'relative z-10 min-w-0 truncate font-medium hover:underline focus-visible:underline focus-visible:outline-none',
          quiet ? 'text-(--el-text-secondary)' : 'text-(--el-text)',
        )}
      >
        {chunks}
      </Link>
    ),
  });
  return (
    <span className="flex min-w-0 items-center gap-1 text-sm">
      {/* The frame words keep the catalogue's own spaces, so the sentence's TEXT reads
          *Design for Pricing page* (copy, a screen reader, a text locator); the space
          at a flex item's edge collapses visually, and `gap-1` does the spacing. */}
      {Children.toArray(parts).map((part, index) =>
        typeof part === 'string' ? (
          part.trim() === '' ? null : (
            <span key={`frame-${index}`} className="shrink-0 text-(--el-text-secondary)">
              {part}
            </span>
          )
        ) : (
          part
        ),
      )}
    </span>
  );
}

/** What one row renders: a live question, or a decided record. */
export type ApprovalRowRecord =
  | { section: 'awaiting'; row: ApprovalQueueRowDto }
  | { section: 'decided'; row: ApprovalRecordDecidedRowDto }
  /**
   * HELD — the row left the awaiting set while the reader was looking at it, and
   * this surface does not know where it went (Story MOTIR-5238 · MOTIR-5242;
   * `design/workbench/design-notes.md` § 26, DECISION 1).
   *
   * ⚠️ IT IS A THIRD SECTION RATHER THAN AN `awaiting` ROW WITH A FLAG, because
   * it answers the state question differently from both of the others. A
   * `decided` row carries the state it reached; an `awaiting` row reaches one
   * through the announcement store when THIS reader decides it. A held row has
   * neither: the tab reads `state = awaiting`, so all the surface knows is that
   * the row is no longer in the set. Drawing a state it cannot read would be the
   * surface guessing, and `approved` / `changes requested` / `withdrawn` are
   * three different pieces of news.
   */
  | { section: 'held'; row: ApprovalQueueRowDto };

/**
 * Open a row's approval over the page the list is on.
 *
 * The host page's own query — the tab, the page of the list — is kept, so the
 * overlay's close lands back on exactly it.
 */
function useOpenApproval(): (row: {
  workItem: { identifier: string };
  kind: ApprovalGateKindDTO;
}) => void {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return useCallback(
    (row) => {
      const qs = searchParams.toString();
      shallowPush(
        withApprovalOverlay(`${pathname}${qs ? `?${qs}` : ''}`, {
          itemKey: row.workItem.identifier,
          kind: row.kind,
        }),
      );
    },
    [pathname, searchParams],
  );
}

/** A row's glyph: the shipped design-type mark for the one registered kind. */
function KindGlyph({ kind }: { kind: ApprovalGateKindDTO }) {
  // The manual TYPE's own mark and hue (MOTIR-7478; § 33.2) — the gate is only ever
  // raised on a manual card, so the reader already knows it.
  if (kind === 'manual_work') return <ManualWorkGlyph />;
  if (kind === 'pull_request_approval') {
    // A LIVE kind's mark (design-notes § 23, Story MOTIR-4909 · MOTIR-5485): the
    // pull-request glyph in the accent ink — never the unregistered row's faint
    // dashed circle, which says the kind is not built.
    return (
      <GitPullRequest className="h-4 w-4 shrink-0 text-(--el-accent-on-surface)" aria-hidden />
    );
  }
  if (kind === 'acceptance_result') {
    // A story's acceptance receipt (MOTIR-4950): the recording's mark in the STORY
    // hue — the question is about the story, so the row reads as one.
    return <Video className="h-4 w-4 shrink-0 text-(--el-type-story)" aria-hidden />;
  }
  if (kind === 'decision_choice') {
    // The choice TYPE's own mark and hue (MOTIR-5897; `approvals-row--choice.mock.html`) —
    // a choice gate is only ever raised on a `type: choice` card.
    return <Signpost className="h-4 w-4 shrink-0 text-(--el-type-choice)" aria-hidden />;
  }
  if (kind === 'decision_approval' || kind === 'decision_confirmation') {
    // A decision to CONFIRM takes the same mark (MOTIR-5961; `approvals-row--decision-
    // confirm.mock.html`) — it is raised only on a `type: decision` card; its KIND label,
    // *Confirm decision*, is what tells the two apart in one list.
    // The decision TYPE's own mark and hue (MOTIR-5679; `design/workbench` § 27) — exactly
    // as a design row takes the design type's pencil, so the reader already knows it.
    return <Scale className="h-4 w-4 shrink-0 text-(--el-type-decision)" aria-hidden />;
  }
  return kind === 'design_result' ? (
    // `lib/issues/workItemTypeMeta.ts`'s own glyph + hue for `design` — a design
    // result IS a design, so the reader already knows this mark.
    <Pencil className="h-4 w-4 shrink-0 text-(--el-type-design)" aria-hidden />
  ) : (
    // Colourless, and deliberately NOT another kind's mark: this row exists to
    // say the kind is not built yet. `--el-text-faint` is legal here because the
    // glyph is `aria-hidden` and the words beside it carry the meaning.
    <CircleDashed className="h-4 w-4 shrink-0 text-(--el-text-faint)" aria-hidden />
  );
}

/**
 * A detail MOVED INTO A `title` (§ 28, DECISION 2) sits ABOVE the stretched row door,
 * as the title door does. The door is `absolute inset-0` over the whole row, so without
 * the lift the pointer never reaches the span and its tooltip never shows: the
 * repository and number would be one hover away from nobody.
 */
const HOVER_DETAIL = 'relative z-10';

/**
 * The pull-request SET an approve-and-merge gate asks about (design-notes § 23, as
 * § 28 amends it): the REPOSITORIES by name — *In motir-core, motir-ai* — two in full,
 * three or more the first two and then *+n more*. ⚠️ No host numbering in the visible
 * text (§ 28, DECISION 2): a GitLab team calls these something else, and a reader who
 * is not a developer should not have to translate. The cell's `title` carries every
 * member as `owner/name · #n`, in the set's canonical order, for the reader who asks.
 */
function PullRequestSetLine({ subject }: { subject: PullRequestApprovalSubjectSummaryDTO }) {
  const t = useTranslations('workbench.approvals.pullRequest');
  const names = subject.members.map((member) => member.repo.split('/').pop() ?? member.repo);
  const repos =
    names.length > 2
      ? `${names.slice(0, 2).join(t('separator'))}${t('moreSeparator')}${t('more', { count: names.length - 2 })}`
      : names.join(t('separator'));
  return (
    <span
      className={cn('truncate text-xs text-(--el-text-secondary)', HOVER_DETAIL)}
      title={subject.members.map((member) => `${member.repo} · #${member.number}`).join(', ')}
    >
      {t('repos', { repos })}
    </span>
  );
}

/**
 * THE DECISION'S SUBJECT LINE (Story MOTIR-4907 · Subtask MOTIR-5679; `design/workbench`
 * § 27, Panels 7a–7c). Read from the capture's summary — NO host call per row, so the
 * title is the file name's (`titleFromDecisionPath`, Panel 7b) and the row never waits on
 * GitHub to draw. An unresolvable decision still lists, and says why in words.
 */
function DecisionSubjectLine({ subject }: { subject: DecisionApprovalSubjectSummaryDTO }) {
  const t = useTranslations('workbench.approvals.decisionSubject');
  const tRow = useTranslations('workbench.approvals.row');
  // A published PAGE (MOTIR-7436, Panel 9a): the page's title and the version asked about.
  if (subject.outcome === 'page') {
    const line = tRow('decisionPage', {
      title: subject.title ?? '',
      number: subject.versionNumber ?? 0,
    });
    return (
      <span className="truncate text-xs text-(--el-text-secondary)" title={line}>
        {line}
      </span>
    );
  }
  const pr = `${subject.repo} · #${subject.number}`;
  if (subject.outcome === 'one' && subject.path) {
    return (
      <span
        className="truncate text-xs text-(--el-text-secondary)"
        title={
          subject.blobSha
            ? t('title', { path: subject.path, blob: subject.blobSha.slice(0, 7) })
            : subject.path
        }
      >
        {subject.title ? `${subject.title} · ${subject.path}` : subject.path}
      </span>
    );
  }
  // The pull request moves to the `title` (§ 28, DECISION 2) — the visible line
  // says only why the decision cannot be approved.
  const line =
    subject.outcome === 'several'
      ? t('several', { count: subject.documentCount })
      : subject.outcome === 'none'
        ? t('none')
        : t('unreadable');
  return (
    <span className={cn('truncate text-xs text-(--el-text-secondary)', HOVER_DETAIL)} title={pr}>
      {line}
    </span>
  );
}

/** What the row says about the thing being decided, per kind. */
function SubjectMeta({
  kind,
  subject,
  decidedVersion,
  chosenOption,
  decided,
}: {
  /** The row's gate kind — what a GONE subject's sentence names (MOTIR-7146). */
  kind: ApprovalGateKindDTO;
  subject: ApprovalGateSubjectSummaryDTO | null;
  /** Set on a DECIDED record: the version the decision was made against. */
  decidedVersion?: string | null;
  /** Set on a DECIDED CHOICE: what was picked, off the immutable row (MOTIR-5897). */
  chosenOption?: ChosenOptionDTO | null;
  /** Set on a DECIDED record: its state and, for a confirmed decision, the record stamp. */
  decided?: { state: ApprovalGateStateDTO; confirmedRecord: ConfirmedRecordDTO | null };
}) {
  const t = useTranslations('workbench.approvals');
  const tConfirm = useTranslations('approvalGate.decisionConfirm');
  // A DECIDED CHOICE names its pick from the RECORD, never from the body — which may
  // have changed, or stopped parsing, since. It is read before the subject check for
  // exactly that reason: a chosen option is still a fact about a body that is gone.
  if (chosenOption) {
    return (
      <span className="truncate text-xs text-(--el-text-secondary)">
        {t.rich('choiceDecided', {
          label: () => <span className="font-medium text-(--el-text)">{chosenOption.label}</span>,
          bestFor: chosenOption.bestFor,
        })}
      </span>
    );
  }
  if (subject === null) {
    // The gate's subject no longer resolves — a DIFFERENT fact from not-built-yet
    // (design-notes § 20). The first is a feature that has not shipped; the
    // second is a gate worth withdrawing, and collapsing them would report a
    // shipped kind as unbuilt. It names its OWN kind's subject (MOTIR-7146), never
    // *the design* for every kind.
    return (
      <span className="truncate text-xs text-(--el-text-secondary)">{t(subjectGoneKey(kind))}</span>
    );
  }
  if (subject.kind === 'pull_request_approval') {
    // The SET names the decision for a live question AND for a decided record: its
    // version is `owner/name#n@sha,…`, whose first 8 characters identify nothing, so
    // the record keeps the set line rather than the design result's *on <version>*.
    return <PullRequestSetLine subject={subject} />;
  }
  if (subject.kind === 'acceptance_result' && decidedVersion === undefined) {
    // THE RECORDING the question is about (MOTIR-4950): how many chapters it walks
    // through, and the commit the recorded run was at.
    return (
      <span className="truncate text-xs text-(--el-text-secondary)">
        {t('acceptanceMeta', {
          chapters: subject.chapterCount,
          version: subject.commitSha ? subject.commitSha.slice(0, 8) : t('noVersion'),
        })}
      </span>
    );
  }
  if (subject.kind === 'decision_choice') {
    // A waiting choice: how many options and the question (MOTIR-5897). A decided one
    // that picked nothing — *None of these* — says so; its pick returned above.
    return (
      <span className="truncate text-xs text-(--el-text-secondary)" title={subject.question}>
        {decidedVersion !== undefined
          ? t('choiceNoneChosen', { count: subject.optionCount })
          : t('choiceMeta', { count: subject.optionCount, question: subject.question })}
      </span>
    );
  }
  if (subject.kind === 'decision_confirmation') {
    // A DECISION TO CONFIRM (MOTIR-5961; `approvals-row--decision-confirm.mock.html`): a
    // waiting one names its changes, how much it supersedes and the decision's first line;
    // a decided one says what happened — the record read from the STAMP.
    const count = subject.supersedesCount;
    const line =
      decided?.state === 'overturned'
        ? tConfirm('row.overturned', { count })
        : decided?.state === 'approved'
          ? decided.confirmedRecord && decided.confirmedRecord.kind !== 'none'
            ? tConfirm('row.confirmedWith', { count })
            : tConfirm('row.confirmedWithout', { count })
          : tConfirm('row.awaiting', {
              changes: subject.changes.map((change) => tConfirm(`change.${change}`)).join(' · '),
              count,
              decision: subject.decision,
            });
    return (
      <span className="truncate text-xs text-(--el-text-secondary)" title={subject.decision}>
        {line}
      </span>
    );
  }
  if (subject.kind === 'decision_approval') {
    // The DOCUMENT names the decision for a live question and a decided record alike: the
    // version is `owner/name:path@blob`, whose first 8 characters identify nothing.
    return <DecisionSubjectLine subject={subject} />;
  }
  if (decidedVersion !== undefined) {
    // A RECORD says WHICH bytes were decided (`design/approvals` § The ROW,
    // addition 3): the first 8 characters, the whole value on hover. The tab's
    // meta reads the subject's CURRENT sha, which is wrong for a decision made
    // against an earlier one.
    return (
      <span
        className="truncate text-xs text-(--el-text-secondary)"
        title={decidedVersion ?? undefined}
      >
        {decidedVersion
          ? t.rich('decidedOn', {
              version: decidedVersion.slice(0, 8),
              mono: (chunks) => <span className="font-mono">{chunks}</span>,
            })
          : t('noVersion')}
      </span>
    );
  }
  // ⚠️ `pull_request_merge` HAS NO ARM HERE ANY MORE (MOTIR-5615; the delta mock
  // `design/workbench/approvals-row--one-gate.mock.html`, panel 2). A card holds ONE
  // approve-to-merge gate over its whole delivery set, so there is no per-pull-request
  // row to name: nothing raises the kind (MOTIR-5611), every row it left is superseded
  // (MOTIR-5614), and the one row the card contributes is the `pull_request_approval`
  // row above, whose subject names every member. A superseded row reached by URL falls
  // to `notRenderable` below with the rest of the kinds this build does not draw.
  if (subject.kind !== 'design_result' && subject.kind !== 'acceptance_result') {
    return (
      <span className="truncate text-xs text-(--el-text-secondary)">{t('notRenderable')}</span>
    );
  }
  if (subject.kind === 'acceptance_result') return null;
  const design: DesignResultSubjectSummaryDTO = subject;
  return (
    <span className="truncate text-xs text-(--el-text-secondary)">
      {t('subjectMeta', {
        files: design.assetCount,
        version: design.commitSha ? design.commitSha.slice(0, 8) : t('noVersion'),
      })}
    </span>
  );
}

/**
 * A Decide-cell pill NEVER WRAPS (§ 28, DECISION 4, added on review 2026-09-22):
 * *Changes requested* fits the 132px track on one line, and a pill allowed to shrink
 * in its `min-w-0` cell broke onto two and doubled the row.
 */
const DECIDE_PILL = 'whitespace-nowrap';

/** The state pill a SETTLED row carries in its Decide cell. */
function StatePill({ state, kind }: { state: ApprovalGateStateDTO; kind: ApprovalGateKindDTO }) {
  const t = useTranslations('approvalGate.state');
  // A CHOICE that was answered reads *Chosen*, not *Approved* — nothing was approved,
  // an option was picked (MOTIR-5897; the frame's own pill says the same).
  const tChoice = useTranslations('approvalGate.choice.state');
  // A decision that was CONFIRMED reads *Confirmed*, not *Approved* (MOTIR-5961).
  const tConfirm = useTranslations('approvalGate.decisionConfirm.state');
  const tManual = useTranslations('approvalGate.manualWork');
  if (state === 'approved' && kind === 'decision_choice') {
    return (
      <Pill severity="success" className={DECIDE_PILL}>
        {tChoice('chosen')}
      </Pill>
    );
  }
  // Manual work that was DONE reads *Marked done* (MOTIR-7478; § 33.2) — nothing was
  // approved: a person did the work and said so. The frame's own pill says the same.
  if (state === 'approved' && kind === 'manual_work') {
    return (
      <Pill severity="success" className={DECIDE_PILL}>
        {tManual('state.markedDone')}
      </Pill>
    );
  }
  if (state === 'approved' && kind === 'decision_confirmation') {
    return (
      <Pill severity="success" className={DECIDE_PILL}>
        {tConfirm('confirmed')}
      </Pill>
    );
  }
  switch (state) {
    // ⚠️ THE SAME PILL RECIPES THE FRAME PICKS, so a settled row and the frame
    // in the overlay above it cannot disagree about what a state looks like.
    case 'approved':
      return (
        <Pill severity="success" className={DECIDE_PILL}>
          {t('approved')}
        </Pill>
      );
    case 'changes_requested':
      return (
        <Pill severity="warning" className={DECIDE_PILL}>
          {t('changesRequested')}
        </Pill>
      );
    // A refused DIRECTION (MOTIR-5956) — its OWN pill, never *Changes requested*:
    // nothing will be revised and re-asked. The design's peach, the warning tint.
    case 'overturned':
      return (
        <Pill severity="warning" className={DECIDE_PILL}>
          {t('overturned')}
        </Pill>
      );
    // A plan ENDED by a person (Story MOTIR-6012 · MOTIR-6032; ADR §11.4) — its own
    // pill, never *Changes requested* (nothing will be revised) nor *Overturned* (no
    // re-plan is owed). A person's decision, so the frame's decided warning tint.
    case 'declined':
      return (
        <Pill severity="warning" className={DECIDE_PILL}>
          {t('declined')}
        </Pill>
      );
    // ⚠️ COLOURLESS, and that is the design's decision rather than a fallback.
    // `superseded` is written by the PRODUCT, never by a person, so a tinted
    // pill would let the audit read a withdrawn question as somebody's answer.
    // `tone="archived"` is the frame's own choice for the same row.
    case 'superseded':
      return (
        <Pill tone="archived" className={DECIDE_PILL}>
          {t('withdrawn')}
        </Pill>
      );
    /* v8 ignore next 2 -- UNREACHABLE: `awaiting` is the one state left, and
       `announceGateDecided` refuses it (`tests/approvals/decidedGates.test.tsx`,
       "does not treat `awaiting` as a decision"). */
    default:
      return null;
  }
}

/** ONE row — and the door to its approval. */
export function ApprovalRow({
  record,
  gridTemplate = APPROVALS_GRID_TEMPLATE,
  person,
  arrived = false,
  routedToReader,
}: {
  record: ApprovalRowRecord;
  gridTemplate?: string;
  /**
   * The row's question is ROUTED TO THE READER (MOTIR-7478; § 33.2) — the Workbench tab,
   * which lists only those. It decides the one sentence that depends on routing, the
   * manual-work row's *is waiting on you* against *is waiting on a person*. `undefined`
   * (the Approvals room, which lists other people's questions too) falls back to the
   * row's authority answer, `canDecide`.
   */
  routedToReader?: boolean;
  /**
   * The room's full-view PERSON cell (`design/approvals` § The ROW, addition 1).
   * `undefined` renders no cell at all — the tab, and the room's own-records view.
   */
  person?: { label: string; value: string };
  /**
   * This row ARRIVED while the reader was looking (design-notes § 26, Panel 1) —
   * it carries `New` until the next load. A WORD in the shipped neutral `Pill`,
   * never a tint and never an animation: a sudden silent insertion teaches a
   * reader to distrust what they have already read, and a flash moves a surface
   * whose whole promise is that it can be left alone.
   */
  arrived?: boolean;
}) {
  const routes = useReaderRoutes();
  const t = useTranslations('workbench.approvals');
  const locale = useLocale();
  const tSentence = useTranslations('workbench.approvals.sentence');
  const tGate = useTranslations('approvalGate');
  const relativeLabel = useRelativeLabel();
  const openApproval = useOpenApproval();
  const { row } = record;
  const announcedState = useDecidedGateState(row.gateId);
  const pressPending = useGatePressPending(row.gateId);
  // A card-less row has no title to translate: an empty id registers nothing.
  const shownCardTitle = useSurfaceTitleText(row.workItem?.id ?? '', row.workItem?.title ?? '');

  // ⚠️ A CARD-LESS ROW IS A PLAN'S (Story MOTIR-6012 · MOTIR-6037; design
  // `design/ai-planning/design-notes.md` Part XXII §22.3). A `plan_approval` gate belongs to
  // no work item (ADR `approval-gates.md` §11.1): it has no key to name and NO overlay
  // address (§11.5b) — its row returns the reader to the PLANNING SURFACE. Any other
  // card-less row (a plan gate whose plan is gone) still draws nothing: there is nothing
  // to name and nowhere to go.
  if (row.workItem === null) {
    // A PLANNING SESSION that needs its person (Story MOTIR-7905 · MOTIR-7917; design § 37.1):
    // no work item either, and no verb — the decision is the next turn.
    if (row.subject?.kind === 'planning_session') {
      return (
        <PlanningSessionRow
          record={record}
          subject={row.subject}
          gridTemplate={gridTemplate}
          arrived={arrived}
        />
      );
    }
    if (row.subject?.kind !== 'plan_approval') return null;
    return (
      <PlanApprovalRow
        record={record}
        subject={row.subject}
        gridTemplate={gridTemplate}
        person={person}
        arrived={arrived}
        announcedState={announcedState}
      />
    );
  }
  const card = row.workItem;

  // A kind with no renderer, or a subject that is gone, still HAS the door — the
  // overlay draws both (§ 22 Panels 4a / 4b). What they lack is anything to
  // decide, so their Decide cell says why in a colourless pill.
  const gone = row.subject === null;
  const renderable = row.subject !== null && RENDERABLE_KINDS.has(row.subject.kind);
  const settledState: ApprovalGateStateDTO | null =
    record.section === 'decided' ? record.row.state : announcedState;
  // ⚠️ A HELD ROW THIS PAGE IS PRESSING IS NOT HELD (Bug MOTIR-9696). A list read can
  // drop the gate before the press's own answer arrives; until that answer settles it,
  // the row keeps drawing the press in flight rather than *Decided elsewhere*.
  const ownPressInFlight = record.section === 'held' && settledState === null && pressPending;
  const held = record.section === 'held' && !ownPressInFlight;
  // A HELD row is settled with no state to show: it has left the awaiting set,
  // so nothing is left to press, and the surface does not know what it became.
  const settled = settledState !== null || held;
  const sentenceKey =
    row.kind === 'manual_work'
      ? manualWorkSentenceKey({
          gone,
          settledState,
          held,
          routedToReader: routedToReader ?? (record.section === 'awaiting' && record.row.canDecide),
        })
      : gone
        ? SENTENCE_KEY[row.kind]
        : sentenceKeyOf(row.kind);
  // The sentence as plain text — the row door's accessible name reads it (MOTIR-5999).
  const sentenceText = tSentence.markup(sentenceKey, {
    name: shownCardTitle,
    title: (chunks: string) => chunks,
  });
  // MANUAL WORK DECIDES FROM THE ROW (MOTIR-7478; ADR `manual-work-gate.md` §5) — the one
  // row with a verb: a live question this reader may press, on a subject that resolves.
  const manualSubject: ManualWorkSubjectSummaryDTO | null =
    row.subject?.kind === 'manual_work' ? row.subject : null;
  const manualPressable =
    manualSubject !== null &&
    (record.section === 'awaiting' || ownPressInFlight) &&
    !settled &&
    record.row.canDecide;
  const timeIso = record.section === 'decided' ? record.row.decidedAt : record.row.waitingSince;

  function onRowClick(e: MouseEvent<HTMLAnchorElement>) {
    // `usePeekRowClick`'s exact condition (`IssueQuickView.tsx`): a modifier or
    // non-primary click keeps its native meaning — the card, in a new tab —
    // which is why the row's href has to be real. Keyboard Enter on the anchor
    // dispatches a primary click, so it takes this same path.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    openApproval({ workItem: card, kind: row.kind });
  }

  return (
    <div
      role="row"
      data-testid={`approval-row-${row.gateId}`}
      className={cn(
        'group relative flex flex-col gap-1 border-b border-(--el-border) px-4 py-2.5 last:border-b-0',
        'hover:bg-(--el-surface) focus-within:ring-2 focus-within:ring-(--focus-ring-color) focus-within:outline-none focus-within:-outline-offset-2',
        'md:grid md:h-11 md:items-center md:gap-x-4 md:gap-y-0 md:py-0 md:pr-4 md:pl-4',
      )}
      style={{ gridTemplateColumns: gridTemplate }}
    >
      <div role="cell" className="flex min-w-0 items-center gap-2">
        {/* THE DOOR (§ 22 Panel 9), stretched behind the cells. The one link that
            visibly leaves the list is the work-item cell, which sits ABOVE this
            on `z-10` so it survives.
            ⚠️ NAMED FOR THE ROW, not "Review". The Decide cell carries a visible
            Review button, and two controls with the SAME accessible name in one
            row is a screen reader reading "Review, Review" with no way to tell
            them apart — the same reason `WorkbenchList`'s row link is labelled
            with the item. */}
        <Link
          href={routes.item(card.identifier)}
          aria-haspopup="dialog"
          aria-label={t('reviewRow', { key: card.identifier, sentence: sentenceText })}
          onClick={onRowClick}
          className="absolute inset-0 z-0 focus:outline-none"
        />
        <KindGlyph kind={row.kind} />
        <Sentence
          sentenceKey={sentenceKey}
          title={shownCardTitle}
          identifier={card.identifier}
          quiet={settled || !renderable}
        />
        {/* The key FOLLOWS the sentence (§ 28, DECISION 1) — `--el-text-secondary`,
            not muted: this row's hover fill is `--el-surface`, where muted is 4.17:1. */}
        <span className="shrink-0 font-mono text-xs text-(--el-text-secondary)">
          {card.identifier}
        </span>
        {/* It ARRIVED while the reader was looking (§ 26, Panel 1) — at the END
            of the sentence cell, which at `< md` is the end of the row's first
            line and so is already reading order. */}
        {arrived ? <Pill tone="neutral">{t('live.new')}</Pill> : null}
      </div>

      <div role="presentation" className="flex flex-wrap items-center gap-2 pl-6 md:contents">
        <div role="cell" className="flex min-w-0 items-center">
          {/* THE DETAILS (§ 28, DECISION 2) — what the kind used to print after its
              label, now in the track the work-item cell held. */}
          {manualSubject !== null ? (
            // THE MANUAL-WORK DETAILS (§ 33.2): the to-do progress, then — while it can be
            // pressed — the Guide me through door.
            <ManualWorkDetails
              subject={manualSubject}
              identifier={card.identifier}
              showDoor={manualPressable}
            />
          ) : record.section === 'decided' &&
            showsRefusalReason(
              record.row.state,
              record.row.refusalReason,
              record.row.decisionSource,
            ) ? (
            // A REFUSAL SAYS WHY (MOTIR-6075; design `approvals-row--refusal-reason`): the
            // reason's FIRST line replaces the details, the version moves into the title.
            <RefusalReasonCell
              reason={record.row.refusalReason}
              version={record.row.subjectVersion}
              // A design sent back LEADS with its verdict (MOTIR-6427; design 4e/4f), and an
              // acceptance's `revise` leads with *Re-run* (MOTIR-6506, panel 5b).
              verdict={record.row.refusalVerdict}
              kind={row.kind}
            />
          ) : record.section === 'decided' ? (
            <SubjectMeta
              kind={row.kind}
              subject={row.subject}
              decidedVersion={record.row.subjectVersion}
              chosenOption={record.row.chosenOption}
              decided={{ state: record.row.state, confirmedRecord: record.row.confirmedRecord }}
            />
          ) : (
            <SubjectMeta kind={row.kind} subject={row.subject} />
          )}
        </div>
        <div role="cell" className="flex min-w-0 items-center">
          {/* Relative in the cell, ABSOLUTE in the title — the absolute one is
              what a person quotes. A record's time is when it was DECIDED; a
              question's is how long it has waited. */}
          <span
            className="truncate text-xs text-(--el-text-secondary)"
            title={new Date(timeIso).toLocaleString(locale)}
          >
            {relativeLabel(timeIso)}
          </span>
        </div>
        {person === undefined ? null : (
          <div role="cell" className="flex min-w-0 items-center">
            {/* Below `md` the column header is gone, so the cell carries its own
                label and is never an unlabelled name (`design/approvals` § Narrow). */}
            <span className="truncate text-xs text-(--el-text-secondary)" title={person.value}>
              <span className="md:sr-only">{person.label}: </span>
              {person.value}
            </span>
          </div>
        )}
        <div role="cell" className="flex min-w-0 items-center md:justify-end">
          {settled ? (
            settledState !== null ? (
              <StatePill state={settledState} kind={row.kind} />
            ) : (
              /* HELD, outcome unknown (§ 26, DECISION 1). Colourless for § 20's
                 own reason, one case over: this was written by somebody else's
                 press, and a tinted pill would let a reader take it for their
                 own answer. The row still OPENS — the overlay reads the gate by
                 (item, kind) and shows the real record. */
              <Pill tone="neutral" className={DECIDE_PILL}>
                {t('live.decidedElsewhere')}
              </Pill>
            )
          ) : gone ? (
            /* A SUBJECT THAT IS GONE is not a kind that is unbuilt (§ 20: "look
               alike and are opposite"; corrected on the record by § 28, DECISION 4).
               The kind is known, so the row keeps its kind's sentence and says the
               subject is gone. */
            <Pill tone="archived" className={DECIDE_PILL}>
              {t('subjectGonePill')}
            </Pill>
          ) : !renderable ? (
            <Pill tone="archived" className={DECIDE_PILL}>
              {t('notBuiltYet')}
            </Pill>
          ) : record.section === 'awaiting' && !record.row.canDecide ? (
            /* SEE but not DECIDE — the row states what it is and carries no
               decide control. The door STAYS: what is withheld is the DECISION,
               never the look, and the overlay draws the frame's state `B`. */
            <Pill tone="awaiting" className={DECIDE_PILL}>
              {tGate('state.awaiting')}
            </Pill>
          ) : manualPressable && manualSubject !== null ? (
            /* MARK DONE takes Review's place (§ 33.2): Guide me through is a door, so it
               lives in the details; the one VERB takes the Decide cell. */
            <MarkDoneButton
              gateId={row.gateId}
              identifier={card.identifier}
              stamp={manualSubject.stamp}
              onRefused={() => openApproval({ workItem: card, kind: row.kind })}
            />
          ) : (
            /* The labelled door a keyboard and a screen reader find (§ 22
               Panel 9) — the same address as the row. */
            <Button
              type="button"
              variant="secondary"
              size="sm"
              aria-haspopup="dialog"
              className="relative z-10"
              onClick={() => openApproval({ workItem: card, kind: row.kind })}
            >
              {t('review')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * WHICH OF THE MANUAL-WORK ROW'S FOUR SENTENCES (Story MOTIR-7460 · MOTIR-7478; design
 * § 33.2). Every other kind reads as a NOUN PHRASE so it stays true once decided (§ 28).
 * This kind's words are a STATE — *is waiting on you* (ADR `manual-work-gate.md` §7) — so
 * they are said only while true: a row marked done says so, and a row whose outcome this
 * surface does not know (held, withdrawn, gone) falls back to the neutral *Manual work on
 * {title}*.
 */
function manualWorkSentenceKey({
  gone,
  settledState,
  held,
  routedToReader,
}: {
  gone: boolean;
  settledState: ApprovalGateStateDTO | null;
  held: boolean;
  routedToReader: boolean;
}): SentenceKey {
  if (settledState === 'approved') return 'manual_work_done';
  if (gone || held || settledState !== null) return 'manual_work_held';
  return routedToReader ? 'manual_work' : 'manual_work_other';
}

/**
 * THE MANUAL-WORK DETAILS CELL (§ 33.2): *{done}/{total} steps* — or *No to-do list*, never
 * *0/0* — then, while the question can be pressed, the GUIDE ME THROUGH door: a real link to
 * the card with the guide open (a modified click opens that in a new tab), whose plain click
 * opens the guide over the Workbench (`useOpenGuide`'s address). It sits ABOVE the stretched
 * row door on `z-10`, as the title door does.
 */
function ManualWorkDetails({
  subject,
  identifier,
  showDoor,
}: {
  subject: ManualWorkSubjectSummaryDTO;
  identifier: string;
  showDoor: boolean;
}) {
  const t = useTranslations('workbench.approvals');
  const tGuide = useTranslations('runs.guide');
  const door = useGuideDoor(identifier);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 text-xs text-(--el-text-secondary)">
        {subject.todos
          ? t('manualSteps', { done: subject.todos.done, total: subject.todos.total })
          : t('manualNoList')}
      </span>
      {showDoor ? (
        <>
          <span aria-hidden className="shrink-0 text-xs text-(--el-text-secondary)">
            ·
          </span>
          <a
            href={door.href}
            onClick={door.onClick}
            data-testid="approval-row-guide-door"
            className="relative z-10 inline-flex shrink-0 items-center gap-1 rounded-(--radius-control) text-xs font-medium text-(--el-link) hover:underline focus-visible:underline focus-visible:outline-none"
          >
            <BrandMark variant="mark" size={12} />
            {tGuide('door')}
          </a>
        </>
      ) : null}
    </span>
  );
}

/**
 * MARK DONE, FROM THE ROW (§ 33.2; ADR `manual-work-gate.md` §5) — the shipped decide door,
 * pressed with the stamp this row was rendered with. NO CONFIRM: the press is the decision,
 * and its consequence is the status move the person asked for.
 *
 * ⚠️ THE ROW SETTLES FROM THE WRITE'S OWN RESPONSE, through the § 22 signal
 * (`announceGateDecided`) — the list is a client island, and `router.refresh()` cannot
 * reach it (CLAUDE.md § *Page state after a mutation*, case 3). The refresh still runs, for
 * the strip's server-rendered count. A REFUSAL opens the approval overlay over the row,
 * where the frame reads the gate afresh and says why — this cell has no room to.
 */
function MarkDoneButton({
  gateId,
  identifier,
  stamp,
  onRefused,
}: {
  gateId: string;
  identifier: string;
  stamp: string;
  onRefused: () => void;
}) {
  const t = useTranslations('workbench.approvals');
  const router = useRouter();
  const [deciding, setDeciding] = useState(false);
  // A press already in flight is not pressed twice (the button is also disabled).
  const inFlight = useRef(false);

  // The row may REMOUNT this button mid-press (a held section arriving first), so the
  // in-flight state is also read from the page-wide mark, not only from local state.
  const pending = useGatePressPending(gateId);
  const showDeciding = deciding || pending;

  async function press() {
    if (inFlight.current) return;
    inFlight.current = true;
    setDeciding(true);
    markGatePressPending(gateId);
    try {
      const result = await decideApprovalGateAction({
        gateId,
        decision: 'approve',
        identifier,
        stamp,
      });
      if (!result.ok) {
        inFlight.current = false;
        setDeciding(false);
        clearGatePressPending(gateId);
        onRefused();
        return;
      }
      announceGateDecided({
        gate: result.gate,
        filesKept: result.filesKept,
        statusWritten: result.statusWritten,
      });
      clearGatePressPending(gateId);
      router.refresh();
    } catch {
      inFlight.current = false;
      setDeciding(false);
      clearGatePressPending(gateId);
      onRefused();
    }
  }

  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      className="relative z-10"
      loading={showDeciding}
      onClick={() => void press()}
    >
      {showDeciding ? t('marking') : t('markDone')}
    </Button>
  );
}

/* ⚠️ `planSentenceOf` LIVES IN `lib/planning/planSentence.ts` NOW (MOTIR-7831), and
 * this note is what a reader meeting the old local name lands on. The rule — design
 * Part XXII §22.3's THREE FORMS of *what the plan is about*, never the gate kind — is
 * unchanged, down to the fall-through when a target's title no longer resolves. What
 * changed is that the Workbench's **Planning** tab names the same plans one step
 * earlier (while they are being WRITTEN; `design/workbench/design-notes.md` § 36.4), so
 * the rule is shared rather than copied: two lists that show plans cannot name one plan
 * two ways. This row's rendering below is untouched.
 */

/* ⚠️ `planDoorContext` IS GONE (Story MOTIR-6043 · MOTIR-6045), and this note is
 * what a reader meeting the old name lands on. It decided this row's destination
 * inline — *"the planning surface at its conversation, or null when it has none
 * to return to"* — and the Plans page's session row decided the same sentence for
 * itself, which is the drift the story exists to remove. Both now call
 * `planRowDestination` (`lib/planning/planDestination.ts`), so one change of rule
 * moves both lists.
 *
 * Its test also changed on the way, and by DECISION rather than by refactor: it
 * read `!subject.sessionId || !subject.sessionHasTurns`, and the turn count no
 * longer decides anything. `docs/decisions/mcp-authored-plan-review.md` overturned
 * it for an agent's plan, and Story MOTIR-6043 settled the rest: a `cadence` and a
 * backfilled `legacy` session are the same shape, so the whole remaining test is
 * whether a session EXISTS. `sessionHasTurns` stays on the DTO for other readers
 * and gates no door. */

/** The version a declined plan record names: the digest after `plan.v1.`, 8 characters. */
function planVersionLabel(version: string): string {
  return version.replace(/^plan\.v\d+\./, '').slice(0, 8);
}

function PlanApprovalRow({
  record,
  subject,
  gridTemplate,
  person,
  arrived,
  announcedState,
}: {
  record: ApprovalRowRecord;
  subject: PlanApprovalSubjectSummaryDTO;
  gridTemplate: string;
  person?: { label: string; value: string };
  arrived: boolean;
  announcedState: ApprovalGateStateDTO | null;
}) {
  const routes = useReaderRoutes();
  const t = useTranslations('workbench.approvals');
  const locale = useLocale();
  const tPlan = useTranslations('approvalGate.planApproval.row');
  const tGate = useTranslations('approvalGate');
  const relativeLabel = useRelativeLabel();
  const peekRowClick = usePeekRowClick();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { row } = record;

  const sentence = planSentenceOf(subject);
  const sentenceText = tPlan.markup(sentence.form, {
    name: sentence.name,
    project: sentence.name,
    title: (chunks: string) => chunks,
  });
  const settledState: ApprovalGateStateDTO | null =
    record.section === 'decided' ? record.row.state : announcedState;
  const settled = settledState !== null || record.section === 'held';
  const timeIso = record.section === 'decided' ? record.row.decidedAt : record.row.waitingSince;
  const planHref = routes.plan(subject.planId);
  const qs = searchParams.toString();
  // THE ONE DESTINATION RULE, shared with the Plans page's session row
  // (design Part XXI). A To-approve row's subject is a PLAN and this list holds
  // only `awaiting` gates, so the arm this row can reach is *undecided*: the
  // surface when the plan has a session, the page when it has none (§21.3).
  const destination = planRowDestination({
    planStatus: 'planned',
    planId: subject.planId,
    sessionId: subject.sessionId,
    host: `${pathname}${qs ? `?${qs}` : ''}`,
    anchorKey: subject.targets[0]?.key ?? null,
    // `planVia=approvals` (§22.2): the reopened line says *Reopened from To approve*.
    via: 'approvals',
    routes,
  });
  const opensSurface = destination.kind === 'planning-surface';

  /** Open the planning surface over the page the list is on — `shallowPush`, so Close
   *  lands back on exactly this list (§22.2). */
  function openPlanningSurface() {
    shallowPush(destination.href);
  }

  function onRowClick(e: MouseEvent<HTMLAnchorElement>) {
    // `usePeekRowClick`'s condition: a modified or non-primary click keeps the real
    // `href` — the plan page, in a new tab.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    // NO CONVERSATION → the real navigation to `/plans/<id>` goes ahead (§22.2).
    if (!opensSurface) return;
    e.preventDefault();
    openPlanningSurface();
  }

  const author =
    subject.author.origin === 'cadence'
      ? tPlan('author.cadence')
      : subject.author.source === 'mcp' && subject.author.harness
        ? tPlan('author.harness', { harness: subject.author.harness })
        : tPlan('author.motir');
  const details = (
    <span
      className={cn('truncate text-xs text-(--el-text-secondary)', HOVER_DETAIL)}
      title={subject.title ?? undefined}
    >
      {tPlan('details', { count: subject.proposalCount, author })}
    </span>
  );

  const titleInk = settled ? 'text-(--el-text-secondary)' : 'text-(--el-text)';
  const parts: ReactNode = tPlan.rich(sentence.form, {
    name: sentence.name,
    project: sentence.name,
    title: (chunks) =>
      sentence.form === 'targeted' ? (
        // THE TITLE IS THE TARGET'S QUICK-VIEW DOOR — the shipped contract, above the
        // stretched row door on `z-10`.
        <Link
          key="title"
          href={routes.item(sentence.key)}
          onClick={(e) => peekRowClick(e, sentence.key)}
          className={cn(
            'relative z-10 min-w-0 truncate font-medium hover:underline focus-visible:underline focus-visible:outline-none',
            titleInk,
          )}
        >
          {chunks}
        </Link>
      ) : (
        // A plan has no quick view: its title is plain text under the row door.
        <span key="title" className={cn('min-w-0 truncate font-medium', titleInk)}>
          {chunks}
        </span>
      ),
  });

  const keys = subject.targets.map((target) => target.key);

  return (
    <div
      role="row"
      data-testid={`approval-row-${row.gateId}`}
      className={cn(
        'group relative flex flex-col gap-1 border-b border-(--el-border) px-4 py-2.5 last:border-b-0',
        'hover:bg-(--el-surface) focus-within:ring-2 focus-within:ring-(--focus-ring-color) focus-within:outline-none focus-within:-outline-offset-2',
        'md:grid md:h-11 md:items-center md:gap-x-4 md:gap-y-0 md:py-0 md:pr-4 md:pl-4',
      )}
      style={{ gridTemplateColumns: gridTemplate }}
    >
      <div role="cell" className="flex min-w-0 items-center gap-2">
        {/* THE DOOR (§22.2): `/plans/<id>` is the real href — a new tab opens the plan
            page — and a plain primary click returns to the planning surface. The
            planning overlay is a dialog, hence `aria-haspopup`. */}
        <Link
          href={planHref}
          aria-haspopup="dialog"
          aria-label={tPlan('reviewRow', { sentence: sentenceText })}
          onClick={onRowClick}
          className="absolute inset-0 z-0 focus:outline-none"
        />
        {/* The Motir-AI mark the Plans nav already carries (§22.3); the words carry the
            meaning, so it is hidden. */}
        <Sparkles className="h-4 w-4 shrink-0 text-(--el-accent-on-surface)" aria-hidden />
        <span className="flex min-w-0 items-center gap-1 text-sm">
          {Children.toArray(parts).map((part, index) =>
            typeof part === 'string' ? (
              part.trim() === '' ? null : (
                <span key={`frame-${index}`} className="shrink-0 text-(--el-text-secondary)">
                  {part}
                </span>
              )
            ) : (
              part
            ),
          )}
        </span>
        {/* The KEY cell names the targets: the first, `+{n}` for the rest, every key in
            its `title` (§22.3, the multi-target form). No target, no key cell. */}
        {keys.length > 0 ? (
          <span
            className="shrink-0 font-mono text-xs text-(--el-text-secondary)"
            title={keys.length > 1 ? keys.join(', ') : undefined}
          >
            {keys.length > 1
              ? `${keys[0]} ${tPlan('moreTargets', { count: keys.length - 1 })}`
              : keys[0]}
          </span>
        ) : null}
        {/* THE DESTINATION TAG (§21.6): the FIRST column, after the key cell — the
            slot this row already keeps for a per-row mark, and the one column that
            FLEXES. `shrink` + `truncate` because that is how this column gives way;
            the details cell beside it is a fixed 220px that would eat the tag whole. */}
        <PlanDestinationTag destination={destination} className="shrink text-xs" />
        {arrived ? <Pill tone="neutral">{t('live.new')}</Pill> : null}
      </div>

      <div role="presentation" className="flex flex-wrap items-center gap-2 pl-6 md:contents">
        <div role="cell" className="flex min-w-0 items-center">
          {record.section === 'decided' && record.row.state === 'declined' ? (
            // A DECLINE's reason is OPTIONAL (§11.4): with one, its first line (as every
            // refusal's); without one, *Declined without a reason · on {version}*.
            showsRefusalReason(
              record.row.state,
              record.row.refusalReason,
              record.row.decisionSource,
            ) ? (
              <RefusalReasonCell
                reason={record.row.refusalReason}
                version={record.row.subjectVersion}
              />
            ) : (
              <span
                className={cn('truncate text-xs text-(--el-text-secondary)', HOVER_DETAIL)}
                title={record.row.subjectVersion ?? undefined}
              >
                {tPlan.rich('declinedNoReason', {
                  version: record.row.subjectVersion
                    ? planVersionLabel(record.row.subjectVersion)
                    : t('noVersion'),
                  mono: (chunks) => <span className="font-mono">{chunks}</span>,
                })}
              </span>
            )
          ) : (
            details
          )}
        </div>
        <div role="cell" className="flex min-w-0 items-center">
          <span
            className="truncate text-xs text-(--el-text-secondary)"
            title={new Date(timeIso).toLocaleString(locale)}
          >
            {relativeLabel(timeIso)}
          </span>
        </div>
        {person === undefined ? null : (
          <div role="cell" className="flex min-w-0 items-center">
            <span className="truncate text-xs text-(--el-text-secondary)" title={person.value}>
              <span className="md:sr-only">{person.label}: </span>
              {person.value}
            </span>
          </div>
        )}
        <div role="cell" className="flex min-w-0 items-center md:justify-end">
          {settled ? (
            settledState !== null ? (
              <StatePill state={settledState} kind={row.kind} />
            ) : (
              <Pill tone="neutral" className={DECIDE_PILL}>
                {t('live.decidedElsewhere')}
              </Pill>
            )
          ) : subject.held ? (
            /* BEING REWRITTEN (§11.5c): the gate is still `awaiting` — ⚠️ NOT § 26's
               `held` section, which is a row that LEFT the set. A word in the sky tint the
               plan rail's in-flight band spends; no verb. The row door still opens (you
               can go and watch). Since §11.5c's MOTIR-7988 amendment the Waiting on you
               queue no longer LISTS a held plan (it is under Planning), so this draws only
               where a held gate's row is rendered from another read. */
            <Pill severity="info" className={DECIDE_PILL} title={tPlan('rewritingTitle')}>
              {tPlan('rewriting')}
            </Pill>
          ) : record.section === 'awaiting' && !record.row.canDecide ? (
            <Pill tone="awaiting" className={DECIDE_PILL}>
              {tGate('state.awaiting')}
            </Pill>
          ) : (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              aria-haspopup="dialog"
              className="relative z-10"
              onClick={() => (opensSurface ? openPlanningSurface() : router.push(planHref))}
            >
              {t('review')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
