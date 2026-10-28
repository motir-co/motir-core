'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowUpRight, CircleDashed, FileX2, Lock, RefreshCw, TriangleAlert } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { OverlayExitButton, OVERLAY_EXIT_CONTROL } from '@/components/ui/OverlayExitButton';
import { Button, buttonVariants } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Pill } from '@/components/ui/Pill';
import { ChoiceGateFrame } from '@/components/approvals/ChoiceGate';
import { WorkItemQuickView } from '@/components/planning/WorkItemQuickView';
import { DecisionConfirmGateFrame } from '@/components/approvals/DecisionConfirmGate';
import { ManualWorkGateFrame } from '@/components/approvals/ManualWorkGate';
import { StatusPill } from '@/components/issues/StatusPill';
import {
  useRefusalVerb,
  type AcceptanceRefusalFacts,
  type DesignRefusalFacts,
} from './RefusalReason';
import { asksAfterPress, useRefusalReplanSlots, type RefusalReplanProps } from './RefusalReplan';
import {
  ApprovalGateControl,
  type ApprovalGateControlProps,
  type GateVerb,
} from '@/components/approvals/ApprovalGateControl';
import { DesignResultPanel } from '@/app/(authed)/items/[key]/_components/DesignResultPanel';
import { AcceptanceDevelopmentSlot } from '@/components/acceptance/AcceptanceDevelopmentSlot';
import {
  AcceptanceReceiptPlayer,
  AcceptanceReceiptProvenance,
} from '@/components/acceptance/AcceptanceReceiptPlayer';
import { DevelopmentSectionBody } from '@/components/github/DevelopmentSection';
import {
  approveAndMergeAction,
  decideApprovalGateAction,
  retryApproveAndMergeMemberAction,
} from '@/app/(authed)/items/[key]/approvalGateActions';
import { shallowPush } from '@/lib/navigation/shallowUrl';
import { usePlanGateForward } from './usePlanGateForward';
import { parseApprovalOverlay, withoutApprovalOverlay } from '@/lib/approvals/overlayAddress';
import { fetchApprovalGateOverlay } from '@/lib/approvals/approvalOverlayClient';
import { useLiveSignal, type LiveTopic } from '@/lib/live/liveSignal';
import type { StampComponent } from '@/lib/approvalGates/stamp';
import {
  announceGateDecided,
  clearGatePressPending,
  markGatePressPending,
} from '@/lib/approvals/decidedGates';
import type {
  ApprovalGateDTO,
  ApprovalGateKindDTO,
  ApprovalGateOverlayReadDTO,
  ApprovalGateRefusalVerdictDTO,
  ApprovalOverlayStatusDTO,
  GateDecision,
} from '@/lib/dto/approvalGate';
import type { GateRefusal } from '@/lib/approvalGates/refusals';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';
import { subjectGoneKey } from './subjectGoneKey';

// THE APPROVAL OVERLAY (Story MOTIR-5214 · Subtask MOTIR-5224) — an approval
// decided FULL SCREEN over whatever authed page is open, built to
// `design/workbench/approval-overlay.mock.html` + `design-notes.md` § 22.
//
// ⚠️ IT IS THE FOURTH INSTANCE OF A DECIDED PATTERN, NOT A FIFTH.
// `components/planning/PlanningWorkspaceOverlay.tsx` is the model and its header
// is the specification; what follows is that shape, and only the places this one
// differs are argued here.
//
// ⚠️ THE OPEN STATE IS THE ADDRESS, AND IS HELD NOWHERE ELSE. It is open when
// `?approval=` is in the query (`lib/approvals/overlayAddress.ts`) and it closes
// by writing the two parameters away with `shallowPush`. There is no state hook,
// context value or ref recording openness — so browser Back closes it with no code
// watching (a `popstate` changes what `useSearchParams` reports), a pasted link
// opens it cold, and nothing can disagree with the address bar.
//
// ⚠️ EVERY CLOSE GOES THROUGH `requestClose()` — the exit row's Close, `Esc` and
// the scrim (both arrive at the dialog's `onOpenChange`), and 5a's own Close
// button. Back is the one vector that has already happened by the time anything
// sees it, and it needs no call: the address it lands on is already closed. The
// seam is ONE function so a later guard has exactly one place to intercept, as
// MOTIR-4731's does on the planning overlay (§ 22 *THE EXIT*: this overlay has
// nothing to guard today).
//
// ⚠️ THE FRAME IS COMPOSED, NEVER RE-IMPLEMENTED. `ApprovalGateControl` renders
// here exactly as on the item page, through ONE layout input (`layout="fill"`)
// that changes its box and nothing inside it — § 22's planning flag 1. There is
// no second approve control, and `tests/approval-gate-one-language.test.ts` is
// what says so.
//
// ⚠️ IT IS A CLIENT ISLAND, SO IT READS OVER HTTP (MOTIR-5223's route). The route
// answers `canDecide`; nothing here derives it. Deciding goes through the shipped
// `decideApprovalGateAction`, which is the write door and is not this card's.
//
// ── PAGE STATE AFTER A DECISION (`CLAUDE.md`) ────────────────────────────────
// Deciding does NOT close the overlay: the frame re-renders with the decided
// record from the action's OWN response (the inline-edit half — never a refetch
// of the thing just written), and `router.refresh()` reaches the server-rendered
// surfaces behind it (the strip count, the readiness of the cards this one was
// blocking). Both halves, for the reason `ApprovalsList` records (MOTIR-5118).
// The To-approve row underneath is a CLIENT island that `router.refresh()` cannot
// reach, so the decision is also ANNOUNCED (`lib/approvals/decidedGates.ts`, § 22
// planning flag 2 — MOTIR-5225) and the row settles in the same reconcile.

/** What the read SETTLED on, and for which address. There is no loading member:
 *  pending is DERIVED at render (`settled.token !== token`), which is the quick
 *  view's own shape and keeps a synchronous `setState` out of the effect body. */
type Load =
  | {
      token: string;
      outcome: 'read';
      read: ApprovalGateOverlayReadDTO;
      /** Which re-read produced it — the frame remounts on a new one, clearing a
       *  refusal and giving the verbs back (MOTIR-5235). */
      reread: number;
    }
  | { token: string; outcome: 'unavailable' };

/** A decision THIS reader made here — the frame's own reconcile, per address. */
interface Decided {
  token: string;
  gate: ApprovalGateDTO;
  filesKept: boolean | null;
}

function tokenOf(itemKey: string, kind: ApprovalGateKindDTO): string {
  return `${itemKey} ${kind}`;
}

/**
 * THE EXIT ROW — Close with its `Esc` chip, then the work item's key and title,
 * then *Open work item*, the one way out that LEAVES the page (§ 22 *THE EXIT*).
 *
 * It names the WORK ITEM, never the kind: "Design result" appears once, in band 1.
 * `workItem` is null while loading and on Panel 5a, where the key in the address
 * is the reader's own text and echoing it beside a refusal reads as a
 * confirmation. Narrow (`< md`, Panel 7): no `Esc` chip, no title, and *Open work
 * item* becomes its icon with the label kept as its accessible name.
 *
 * ⚠️ AMENDED by § 28, DECISION 6 (Story MOTIR-5996 · MOTIR-6000) — the exit row KEEPS
 * YOU IN PLACE. The key and title are ONE link whose plain click opens the work item's
 * QUICK VIEW stacked above the overlay (a modified click keeps the `href`: the card in a
 * new tab); at narrow width the key, the link's visible content, is the door. *Open
 * work item* opens a NEW TAB, and says so in its accessible name.
 */
function ExitRow({
  onClose,
  onPeek,
  workItem,
  status = null,
}: {
  onClose: () => void;
  /** Open the work item's quick view ABOVE the overlay. */
  onPeek: (identifier: string) => void;
  workItem: { identifier: string; title: string } | null;
  /**
   * THE CARD'S STATUS (Story MOTIR-6070 · MOTIR-6427; `approval-control--design-verdict`
   * panel 5b) — the shipped `StatusPill` after the title, fed from the overlay read and
   * REPAINTED from the press's `statusWritten`: a design sent back reads To do here the
   * moment it commits, as the item page's rail does underneath.
   */
  status?: {
    key: string;
    label: string;
    category: ApprovalOverlayStatusDTO['category'] | null;
  } | null;
}) {
  const routes = useReaderRoutes();
  const t = useTranslations('approvalOverlay');
  const tc = useTranslations('common');
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-(--el-border-soft) bg-(--el-surface) px-4 py-2">
      <OverlayExitButton
        onClose={onClose}
        label={tc('close')}
        escLabel={t('escKey')}
        escHint="md"
      />
      {workItem ? (
        <>
          {/* THE TITLE DOOR (§ 28, DECISION 6): `usePeekRowClick`'s condition — a
              modifier or non-primary click keeps its native meaning, the card in a
              new tab, which is why the `href` is real. No fill and no ring of its own:
              it is text in a bar, and a fill would read as a third exit. */}
          <a
            href={routes.item(workItem.identifier)}
            aria-haspopup="dialog"
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
              e.preventDefault();
              onPeek(workItem.identifier);
            }}
            className="flex min-w-0 items-center gap-2 hover:underline focus-visible:underline focus-visible:outline-none"
          >
            {/* `--el-text-secondary`, not muted: the row is `--el-surface`, where
                muted fails AA (6.24:1 vs 4.17:1 — § 22's token map). */}
            <span className="shrink-0 font-mono text-xs text-(--el-text-secondary)">
              {workItem.identifier}
            </span>
            <span className="hidden truncate text-sm text-(--el-text) md:inline">
              {workItem.title}
            </span>
          </a>
          {status ? (
            <StatusPill
              statusKey={status.key}
              category={status.category}
              label={status.label}
              className="ml-2 shrink-0 whitespace-nowrap"
            />
          ) : null}
          <a
            href={routes.item(workItem.identifier)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t('openWorkItemNewTab')}
            className={`ml-auto ${OVERLAY_EXIT_CONTROL}`}
          >
            <span className="hidden md:inline">{t('openWorkItem')}</span>
            <ArrowUpRight className="h-4 w-4 shrink-0" aria-hidden />
          </a>
        </>
      ) : null}
    </div>
  );
}

/** Panel 5b — the frame's three bands as muted blocks at their real proportions,
 *  edge to edge, so an answer that arrives does not reflow the screen. */
function LoadingBands() {
  const t = useTranslations('approvalOverlay');
  return (
    <div aria-busy="true" aria-label={t('loading')} className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-(--el-border-soft) px-4 py-3">
        <span className="h-4 w-28 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
        <span className="h-3 w-48 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
        <span className="ml-auto h-5 w-24 animate-pulse rounded-(--radius-badge) bg-(--el-muted)" />
      </div>
      <div className="flex min-h-0 flex-1 px-4 py-4">
        <span className="flex-1 animate-pulse rounded-(--radius-card) bg-(--el-muted)" />
      </div>
      <div className="flex items-center gap-3 border-t border-(--el-border-soft) px-4 py-3">
        <span className="h-3 w-56 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
      </div>
    </div>
  );
}

/** The three arms that mount NO frame are centred in the body with the card
 *  padding around them (§ 22 *The three arms that mount NO frame*). */
/**
 * THE DESIGN AND ACCEPTANCE ARMS' FRAME (Story MOTIR-6070 · MOTIR-6427; Story MOTIR-6071 ·
 * MOTIR-6506) — the shared control with the refusal's two slots filled: the Re-plan with
 * AI DOOR on a record whose refusal offers the planner, or, right after this reader pressed
 * it, the ASK in the door's place (design panels 6a–6c; acceptance panels 7–8). A design
 * names its PARENT (§10h); an acceptance names the STORY itself. A Revise / Re-run, a
 * GitHub-synced or a pre-verdict design refusal fills neither (6d, 4d).
 */
function RefusalReplanFrame({
  replanKey,
  replan,
  ...frame
}: ApprovalGateControlProps & { replanKey: string; replan: RefusalReplanProps }) {
  const { door, ask } = useRefusalReplanSlots({
    gate: frame.gate,
    itemKey: replanKey,
    replan,
    sectioned: false,
  });
  return <ApprovalGateControl {...frame} recordDetail={door} recordBand={ask} />;
}

function Frameless({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center p-(--spacing-card-padding)">
      {children}
    </div>
  );
}

/**
 * *What you are looking at has moved* — the notice an OPEN approval draws when
 * its subject changes under the reader (Story MOTIR-5238 · Subtask MOTIR-5243;
 * `design/workbench/design-notes.md` § 26, DECISION 2).
 *
 * ⚠️ IT IS INFORMATIVE, NEVER A GATE. The verbs are untouched and Approve still
 * goes to the door — the STAMP is what actually prevents a wrong approval, and a
 * notice can be missed. Drawing this as a block, or disabling the verbs behind
 * it, would claim a guarantee it cannot make.
 *
 * ⚠️ AND IT IS TOLD APART FROM THE REFUSAL IT PRECEDES, which is the design's
 * own constraint. The refusal is `--el-tint-peach` with `RefreshCw`; this is
 * UNTINTED, because the frame has already spent yellow on band 1's *Awaiting
 * you* and peach on that refusal — a third meaning in a third colour on one
 * screen is a reader's problem. What separates them is the words: this one is
 * present tense about the SUBJECT and predicts a refusal, the refusal is past
 * tense about the PRESS and reports that nothing was recorded.
 *
 * ⚠️ IT SHARES THE REFUSAL'S NOUNS AND ITS CONTROL, deliberately. `movedSince`
 * is the same component vocabulary the refusal names, so the two describe one
 * change in one language; and *Show the current version* is the same act, on the
 * same handler, so the reader is not offered two words for one door.
 */
function SubjectMovedNotice({
  moved,
  onShow,
}: {
  moved: readonly StampComponent[];
  onShow: () => void;
}) {
  const t = useTranslations('approvalOverlay.moved');
  const tStale = useTranslations('approvalGate.refusal.stale');
  const nouns: Record<StampComponent, string> = {
    subject: tStale('noun.subject'),
    pull_requests: tStale('noun.pullRequests'),
    criteria: tStale('noun.criteria'),
  };
  const things = moved.map((component) => nouns[component]);
  const headline =
    things.length === 1
      ? t('one', { thing: things[0]! })
      : t('several', { things: listFormat(things, t('and')) });
  return (
    <LiveNotice
      testId="approval-subject-moved"
      headline={headline}
      next={t('next')}
      control={tStale('control')}
      onShow={onShow}
    />
  );
}

/**
 * THE QUESTION WAS WITHDRAWN UNDER AN OPEN OVERLAY (Subtask MOTIR-5917;
 * `design/github/design-notes.md` § 30 Panel 4a). A base-branch push put a member in
 * conflict and the approve-to-merge gate was superseded with `conflict` — which moves no
 * STAMP, so § 26's notice above never fires for it. Same place, same tokens, same
 * *Show the current version*; the difference is what the frame does with its verbs,
 * which the host decides (they are disabled, because the question is gone).
 */
function ConflictWithdrawnNotice({
  conflict,
  onShow,
}: {
  /** The member the host reports conflicted, and the branch it conflicts with; null when
   *  the probe's rows name none (the rows and the gate are read in one pass, so this is a
   *  race with a later push, and the sentence falls back to the cause's own words). */
  conflict: { pr: string; base: string } | null;
  onShow: () => void;
}) {
  const t = useTranslations('approvalOverlay.withdrawn');
  const tGate = useTranslations('approvalGate');
  return (
    <LiveNotice
      testId="approval-withdrawn-conflict"
      headline={conflict ? t('conflict', conflict) : tGate('withdrawn.cause.conflict')}
      next={t('next')}
      control={tGate('refusal.stale.control')}
      onShow={onShow}
    />
  );
}

/** § 26 DECISION 2's notice band: band 3's first child, untinted, the reason in words and
 *  the one control that replaces the render. */
function LiveNotice({
  testId,
  headline,
  next,
  control,
  onShow,
}: {
  testId: string;
  headline: string;
  next: string;
  control: string;
  onShow: () => void;
}) {
  return (
    <div
      role="status"
      data-testid={testId}
      className="flex flex-wrap items-start gap-x-3 gap-y-2 border-t border-(--el-border-soft) bg-(--el-surface-soft) px-4 py-3"
    >
      <div className="flex min-w-0 flex-1 basis-full gap-2.5 sm:basis-0">
        <TriangleAlert
          className="mt-0.5 h-4 w-4 flex-none text-(--el-text-secondary)"
          aria-hidden
        />
        <p className="text-[13px] leading-snug text-(--el-text-strong)">
          <b>{headline}</b> <span className="text-(--el-text-secondary)">{next}</span>
        </p>
      </div>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="shrink-0"
        leftIcon={<RefreshCw className="h-3.5 w-3.5" aria-hidden />}
        onClick={onShow}
      >
        {control}
      </Button>
    </div>
  );
}

/** *a, b and c* — in the reader's locale-agnostic simplest form. */
function listFormat(items: readonly string[], and: string): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} ${and} ${items[items.length - 1]!}`;
}

/** The topic the open approval probes on — "something on the Workbench moved". */
const WORKBENCH_TOPIC: LiveTopic = { kind: 'workbench' };

export function ApprovalOverlay() {
  const routes = useReaderRoutes();
  const t = useTranslations('approvalOverlay');
  const tc = useTranslations('common');
  const tRow = useTranslations('workbench.approvals');
  const tGate = useTranslations('approvalGate');
  // A refusal SAYS WHY (MOTIR-6075) — built here, used in the branch that knows the subject.
  const refusalVerb = useRefusalVerb();
  const tDesign = useTranslations('approvalGate.designResult');
  const tAcceptance = useTranslations('approvalGate.acceptanceResult');
  const tPullRequest = useTranslations('approvalGate.pullRequestApproval');
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();

  const address = useMemo(() => parseApprovalOverlay(searchParams), [searchParams]);
  const open = address !== null;
  const itemKey = address?.itemKey ?? null;
  const kind = address?.kind ?? null;
  // An address missing either half OPENS and says the approval is not available
  // (Panel 5a) — never a guessed kind, because a card can carry more than one gate.
  const token = itemKey !== null && kind !== null ? tokenOf(itemKey, kind) : null;

  const [load, setLoad] = useState<Load | null>(null);
  const [decided, setDecided] = useState<Decided | null>(null);
  // THE ASK (Story MOTIR-6068 · MOTIR-6211; `approval-control--replan-door.mock.html`
  // panel 0): the gate whose refusal THIS reader just pressed here — an Overturn or None
  // of these — so its decided band asks whether to re-plan with Motir AI before anything
  // opens. Transient: a close, a reload or another address forgets it, and the record's
  // door stands in its place. (A decision's Request changes is pressed inside the
  // Development frame, which holds its own.)
  const [replanAsk, setReplanAsk] = useState<string | null>(null);
  // THE STATUS A PRESS HERE WROTE (MOTIR-6427, design panel 5b), per address — what the
  // exit row's chip repaints to. Null until a press writes one; a decision that moved
  // nothing (`statusWritten: null`) leaves the read's status standing.
  const [written, setWritten] = useState<{ token: string; status: string } | null>(null);
  // *Show the current version* (MOTIR-5235) — bumping it re-runs THIS read, the one
  // the overlay opened with, so the current subject and a FRESH stamp arrive together.
  // The previous read stays on screen until the new one lands: re-read in place, never
  // re-open, never navigate.
  const [reread, setReread] = useState(0);
  /**
   * THE QUICK VIEW STACKED ABOVE THE OVERLAY (Story MOTIR-5996 · MOTIR-6000). LOCAL
   * state, never `?peek=`: the page's quick-view controller is mounted per page, and
   * this overlay opens on pages that have none. Keyed by the address's token, so a
   * different approval never inherits a peek opened on this one.
   */
  const [peek, setPeek] = useState<{ token: string; key: string } | null>(null);

  // ⚠️ FOCUS RETURN, and why it is not free here — the planning overlay's reason
  // verbatim: Radix returns focus only to its own `Trigger`, and this dialog is
  // opened by a URL write from a door (a row, a Review button) that is not one.
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      const active = document.activeElement;
      openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
    }
    if (!open && wasOpenRef.current) {
      const opener = openerRef.current;
      openerRef.current = null;
      if (opener?.isConnected) opener.focus();
    }
    wasOpenRef.current = open;
  }, [open]);

  /** THE ONE CLOSE. `shallowPush`, never `router.push`: the page underneath never
   *  unmounted, so a server round trip would re-render what is already on screen
   *  and throw away its scroll and its client islands. */
  const requestClose = useCallback(() => {
    // Forget this address's answers, so re-opening it asks the server again
    // rather than showing a gate somebody may have decided in the meantime.
    setLoad(null);
    setDecided(null);
    setPeek(null);
    setReplanAsk(null);
    setWritten(null);
    // Open means `?approval=` is in the query, so the query is never empty here.
    shallowPush(withoutApprovalOverlay(`${pathname}?${searchParams.toString()}`));
  }, [pathname, searchParams]);

  // ⚠️ A PLAN GATE IS NEVER DECIDED HERE (ADR `approval-gates.md` §11.5b; MOTIR-6037):
  // the overlay renders no frame for it and FORWARDS the reader to the planning surface
  // — `usePlanGateForward`, a forward rather than a close, kept out of this file's one
  // close seam.
  usePlanGateForward(kind === 'plan_approval' ? itemKey : null);

  useEffect(() => {
    if (itemKey === null || kind === null || kind === 'plan_approval') return;
    const controller = new AbortController();
    const forToken = tokenOf(itemKey, kind);
    void (async () => {
      try {
        const read = await fetchApprovalGateOverlay(itemKey, kind, controller.signal);
        if (controller.signal.aborted) return;
        setLoad(
          read
            ? { token: forToken, outcome: 'read', read, reread }
            : { token: forToken, outcome: 'unavailable' },
        );
      } catch {
        if (controller.signal.aborted) return;
        // ⚠️ A failed read is drawn as NOT AVAILABLE, because it is the one arm
        // with nothing to press and a way out — never a blank dialog, and never
        // a live frame over an answer that did not arrive. The design draws no
        // separate "could not load" state; this is the nearest honest one.
        setLoad({ token: forToken, outcome: 'unavailable' });
      }
    })();
    return () => controller.abort();
  }, [itemKey, kind, reread]);

  // ⚠️ AFTER A PRESS THAT MERGES, THE ROWS ARE RE-READ — AND ONLY THE ROWS (Bug MOTIR-6079).
  // The frame's `router.refresh()` reaches the server surfaces behind the overlay, never
  // this client island, so a merged or queued pull request kept its old row until the
  // overlay was closed and opened again. It is not *Show the current version*: that re-read
  // remounts the frame (a fresh stamp), which would throw away the outcome, the refusal and
  // the decided record the press just drew — and for a PRIMARY it would re-port the block
  // away, because a decided design or acceptance gate is no longer ported by it. So the
  // read is the MERGE gate's (whichever gate led the frame, the rows are its delivery set),
  // and it patches the row facts into the read on screen and leaves the gate and stamp
  // alone. This moves nothing under a reader mid-sentence: it lands the result of their own
  // press, the inline-edit half of the page-state contract.
  const rereadRows = useCallback(() => {
    if (itemKey === null || kind === null) return;
    const forToken = tokenOf(itemKey, kind);
    void (async () => {
      try {
        const fresh = await fetchApprovalGateOverlay(itemKey, 'pull_request_approval');
        if (fresh?.subject.state !== 'resolved' || fresh.subject.kind !== 'pull_request_approval') {
          return;
        }
        const { pullRequests, repoDelivery, deliveries, members, repair } = fresh.subject;
        setLoad((prev) =>
          prev?.token === forToken &&
          prev.outcome === 'read' &&
          prev.read.subject.state === 'resolved' &&
          prev.read.subject.kind === 'pull_request_approval'
            ? {
                ...prev,
                read: {
                  ...prev.read,
                  subject: {
                    ...prev.read.subject,
                    pullRequests,
                    repoDelivery,
                    deliveries,
                    members,
                    // `motir fix` after an acceptance Re-run (MOTIR-6506) — the repair
                    // view is the server's, never guessed from the verdict here.
                    repair,
                  },
                },
              }
            : prev,
        );
      } catch {
        // A failed re-read changes nothing: the rows keep what the press reported.
      }
    })();
  }, [itemKey, kind]);

  // ⚠️ WHAT THIS READER IS LOOKING AT MAY HAVE MOVED (Story MOTIR-5238 · Subtask
  // MOTIR-5243). The shell's live host holds ONE stream and hands its signal down
  // through the seam (`useLiveSignal`, Story MOTIR-8539 · MOTIR-8577); this
  // surface OPENS NOTHING, and with no provider above it it is simply never nudged.
  //
  // ⚠️ A NUDGE IS NOT AN ANSWER. A frame says a TAB moved, which is mostly other
  // people's rows; the question this surface has is narrower — *did the gate I am
  // holding open move?* — so a signal triggers ONE probe, and the probe hands back
  // the stamp this reader was shown. The SERVER compares, with the decide door's
  // own `stampMoved`, so this notice and the refusal a press would meet cannot
  // disagree. The signal's payload is not read: what moved is the probe's answer.
  //
  // ⚠️ AND THE PROBE DOES NOT TOUCH WHAT IS ON SCREEN. Its read is used for one
  // thing — `movedSince` (and the withdrawal) — and never applied to `load`.
  // Swapping the port's bytes under a reader mid-sentence is the one outcome the
  // design forbids outright; *Show the current version* is the reader's own act,
  // and it is the only thing that replaces the render. Nothing a signal sets is
  // state the port renders from, which is what keeps the reader's scroll, their
  // selection, their focus and a half-typed refusal where they were.
  //
  // ⚠️ ONE PROBE IN FLIGHT (MOTIR-8577), `useGeneratingPlanPoll`'s discipline. A
  // signal during a probe sets `pending`, and exactly one more probe runs once it
  // settles — a burst of N signals costs two probes, not N. The probe is aborted
  // on unmount, on a change of address and when the held stamp changes; an answer
  // for an address or a stamp the reader has left is dropped.
  const [moved, setMoved] = useState<StampComponent[]>([]);
  // THE QUESTION WENT AWAY (MOTIR-5917; § 30 Panel 4a) — the gate this reader holds is now
  // superseded with `conflict`. `undefined` = not withdrawn; the value is what the notice
  // names. Never a re-render of the frame: only *Show the current version* replaces it.
  const [withdrawn, setWithdrawn] = useState<{ conflict: { pr: string; base: string } | null }>();
  const settledRead =
    token !== null && load?.token === token && load.outcome === 'read' ? load.read : null;
  const heldStamp = settledRead?.stamp ?? null;
  const heldGateId = settledRead?.gate?.id ?? null;

  // What a probe is FOR, read when one is issued and again when it lands.
  const probeView = useRef({ itemKey, kind, heldStamp, heldGateId });
  const prober = useRef({ inFlight: null as AbortController | null, pending: false });
  useEffect(() => {
    probeView.current = { itemKey, kind, heldStamp, heldGateId };
    const r = prober.current;
    // A new address or a new stamp: what was out is about a view the reader left.
    return () => {
      r.inFlight?.abort();
      r.inFlight = null;
      r.pending = false;
    };
  }, [itemKey, kind, heldStamp, heldGateId]);

  const probe = useCallback(function issue(): void {
    const r = prober.current;
    if (r.inFlight) {
      r.pending = true;
      return;
    }
    const view = probeView.current;
    // Nothing to compare against: no live question, or nothing on screen yet.
    if (view.itemKey === null || view.kind === null || !view.heldStamp) return;
    const controller = new AbortController();
    r.inFlight = controller;
    const isCurrent = () =>
      !controller.signal.aborted &&
      probeView.current.itemKey === view.itemKey &&
      probeView.current.kind === view.kind &&
      probeView.current.heldStamp === view.heldStamp;
    void fetchApprovalGateOverlay(view.itemKey, view.kind, controller.signal, view.heldStamp)
      .then((answer) => {
        if (!isCurrent() || !answer) return;
        // One move produces one notice; a second, different move UPDATES it
        // rather than stacking — this is a set, not a log.
        setMoved((prev) =>
          prev.join(',') === answer.movedSince.join(',') ? prev : answer.movedSince,
        );
        // ⚠️ A WITHDRAWAL MOVES NO STAMP, so `movedSince` is `[]` for it and the probe's
        // GATE is what says so: the same row, no longer awaiting, superseded for a
        // conflict. Only the gate THIS READER HOLDS counts — a later gate would be a new
        // question with its own stamp.
        if (
          answer.gate?.id === view.heldGateId &&
          answer.gate.state === 'superseded' &&
          answer.gate.supersededCause === 'conflict'
        ) {
          const conflicted =
            answer.subject.state === 'resolved' && answer.subject.kind === 'pull_request_approval'
              ? answer.subject.pullRequests.find((pr) => pr.conflicted)
              : undefined;
          setWithdrawn(
            (prev) =>
              prev ?? {
                conflict: conflicted?.baseRef
                  ? { pr: `${conflicted.repo} · #${conflicted.number}`, base: conflicted.baseRef }
                  : null,
              },
          );
        }
      })
      .catch(() => {
        // A failed probe says nothing. The reader keeps what they have, and the
        // stamp still protects the press — a notice is a courtesy layered on a
        // precondition, never the precondition.
      })
      .finally(() => {
        if (r.inFlight !== controller) return;
        r.inFlight = null;
        if (r.pending && !controller.signal.aborted) {
          r.pending = false;
          issue();
        }
      });
  }, []);

  useLiveSignal(WORKBENCH_TOPIC, probe, {
    enabled: itemKey !== null && kind !== null && heldStamp !== null,
  });
  // A fresh render — a different address, or *Show the current version* — carries
  // a fresh stamp, so the notice it was about is gone.
  const shownFor = useRef<string | null>(null);
  if (shownFor.current !== heldStamp) {
    shownFor.current = heldStamp;
    if (moved.length > 0) setMoved([]);
    if (withdrawn) setWithdrawn(undefined);
  }

  if (!open) return null;
  // The plan arm above is sending the reader on — never an empty frame (§11.5b).
  if (kind === 'plan_approval') return null;

  // The stacked quick view belongs to THIS address: a different approval, or none,
  // shows none (§ 28, DECISION 6).
  const peekKey = peek !== null && peek.token === token ? peek.key : null;

  const settled = token !== null && load?.token === token ? load : null;
  const read = settled?.outcome === 'read' ? settled.read : null;
  const unavailable =
    token === null ||
    settled?.outcome === 'unavailable' ||
    (read !== null && (read.gate === null || read.subject.state === 'no_gate'));
  const loading = !unavailable && read === null;
  // ⚠️ THE APPROVE-TO-MERGE KIND IS NAMED BY ITS FRAME, NOT BY THE ROW VOCABULARY
  // (§ 24: the dialog's accessible name is *Pull requests for ACME-12*). Band 1 renders
  // `approvalGate.pullRequestApproval.kindLabel`, and a dialog announcing a different
  // name for the same thing is two names for one gate. Every other kind keeps the row's
  // label, which is what its own arms render.
  const kindLabel = !kind
    ? ''
    : kind === 'pull_request_approval'
      ? tPullRequest('kindLabel')
      : tRow(`kind.${kind}`);

  let workItem: { identifier: string; title: string } | null = null;
  let headerStatus: {
    key: string;
    label: string;
    category: ApprovalOverlayStatusDTO['category'] | null;
  } | null = null;
  let srTitle = t('loading');
  let body: ReactNode = <LoadingBands />;

  if (unavailable) {
    // Panel 5a — ONE answer for "does not exist" and "not yours to see": the read
    // returns one 404 for both, and a second message would say which.
    srTitle = t('notAvailable.title');
    body = (
      <Frameless>
        <EmptyState
          icon={<Lock className="h-12 w-12" aria-hidden />}
          title={t('notAvailable.title')}
          description={t('notAvailable.body')}
          action={
            <Button type="button" variant="primary" size="sm" onClick={requestClose}>
              {tc('close')}
            </Button>
          }
        />
      </Frameless>
    );
  } else if (!loading && read !== null && read.gate !== null) {
    workItem = { identifier: read.workItem.identifier, title: read.workItem.title };
    const statusKey =
      written !== null && written.token === token ? written.status : read.workItem.status;
    const statusRow = read.statuses.find((s) => s.key === statusKey);
    headerStatus = {
      key: statusKey,
      label: statusRow?.label ?? statusKey,
      category: statusRow?.category ?? null,
    };
    // A DESIGN SENT BACK (MOTIR-6427): where its Re-plan opens — the PARENT (§10h), or the
    // card itself when it has none — and the status either verdict returns it to, the
    // project's initial To-do (`returnCardToTodo`'s own rule).
    const designRefusal: DesignRefusalFacts = {
      replanKey: read.workItem.parentIdentifier ?? read.workItem.identifier,
      returnStatusLabel:
        read.statuses.find((s) => s.isInitial && s.category === 'todo')?.label ?? null,
    };
    srTitle = t('dialogTitle', { kind: kindLabel, key: read.workItem.identifier });
    // A NEW TAB, like the exit row's (§ 28, DECISION 6): this used to `router.push`,
    // which navigated the whole tab away from the approval the reader was on.
    const openWorkItem = (
      <a
        href={routes.item(read.workItem.identifier)}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t('openWorkItemNewTab')}
        className={buttonVariants({ variant: 'secondary', size: 'sm' })}
      >
        <span>{t('openWorkItem')}</span>
        <ArrowUpRight className="h-4 w-4 shrink-0" aria-hidden />
      </a>
    );
    const subject = read.subject;

    if (subject.state === 'kind_not_built') {
      // Panel 4a — a feature that has not shipped. Opposite in meaning to 4b,
      // which is a gate worth withdrawing, however alike they look.
      body = (
        <Frameless>
          <EmptyState
            icon={<CircleDashed className="h-12 w-12" aria-hidden />}
            title={tRow('notRenderable')}
            description={
              <>
                {t('notRenderable.body', { kind: kindLabel })}
                <span className="mt-(--spacing-sm) block">
                  <Pill tone="archived">{tRow('notBuiltYet')}</Pill>
                </span>
              </>
            }
            action={openWorkItem}
          />
        </Frameless>
      );
    } else if (subject.state === 'gone' && read.gate?.state === 'superseded') {
      // A WITHDRAWN QUESTION OVER A GONE SUBJECT IS STATE `G`, NOT PANEL 4b (Bug MOTIR-7146).
      // The read withdraws an awaiting gate whose subject no longer resolves before it
      // answers, so this is what opening one now shows. `G`'s port is DEAD by the frame's
      // own rule — it never renders the subject — so the frame needs no port to be drawn:
      // the cause sentence says why, nobody is named and nothing can be pressed.
      body = (
        <ApprovalGateControl
          layout="fill"
          gate={read.gate}
          canDecide={false}
          kindLabel={kindLabel}
          subjectMeta={null}
          port={null}
          verbs={[]}
          consequence={null}
          confirmConsequences={[]}
          routedToLabel={read.routedToLabel}
          onDecide={async () => null}
        />
      );
    } else if (subject.state === 'gone') {
      // Panel 4b — a registered kind whose subject no longer resolves, on a gate that
      // was DECIDED before it went (an awaiting one is withdrawn by the read, above). It
      // names its own kind's subject (MOTIR-7146), never *the design* for every kind.
      body = (
        <Frameless>
          <EmptyState
            icon={<FileX2 className="h-12 w-12" aria-hidden />}
            title={tRow(subjectGoneKey(kind!))}
            description={t(subjectGoneKey(kind!))}
            action={openWorkItem}
          />
        </Frameless>
      );
    } else if (subject.state === 'resolved') {
      const local = decided?.token === token ? decided : null;
      const gate = local?.gate ?? read.gate;
      const identifier = read.workItem.identifier;
      const decidedState = gate.state !== 'awaiting';

      const approveVerb: GateVerb = {
        decision: 'approve',
        label: tGate('verb.approve'),
        variant: 'primary',
        confirms: true,
      };
      // A DESIGN sent back takes a reason (ADR §10a) AND a VERDICT — Revise or Re-plan
      // (MOTIR-6427; design `approval-control--design-verdict.mock.html` panels 1–3).
      const designVerbs: GateVerb[] = [
        refusalVerb('design', identifier, {}, designRefusal),
        approveVerb,
      ];
      // AN ACCEPTANCE ASKS BY RUN SHAPE (MOTIR-6506): the Re-run / Re-plan pair when the
      // AWAITING gate offers a verdict (a story run — `offersRefusalVerdict`, read off the
      // DTO, never re-derived), the reason plus the no-re-run line on a finished story. The
      // standalone arm cannot count the story's pull requests, so the tile reads one.
      const acceptanceRefusal: AcceptanceRefusalFacts = {
        offersVerdict: read.gate.offersRefusalVerdict,
        pullRequestCount: 1,
      };
      const acceptanceVerbs: GateVerb[] = [
        refusalVerb('acceptance', identifier, {}, undefined, acceptanceRefusal),
        approveVerb,
      ];

      const onDecide = async (
        decision: GateDecision,
        optionId?: string,
        noteMd?: string,
        refusalVerdict?: ApprovalGateRefusalVerdictDTO,
      ): Promise<GateRefusal | null> => {
        // ⚠️ THE STAMP THIS READ HANDED OVER, never one fetched at press time (MOTIR-5235).
        // A stamp asked for when the reader presses always matches, so the check would pass
        // every time and protect nothing: it has to be the record of what is on screen.
        // The row underneath may be dropped by a list read before this answer arrives;
        // the mark keeps it from drawing *Decided elsewhere* for this press (MOTIR-9696).
        markGatePressPending(gate.id);
        let result: Awaited<ReturnType<typeof decideApprovalGateAction>>;
        try {
          result = await decideApprovalGateAction({
            gateId: gate.id,
            decision,
            // A CHOICE names its option (MOTIR-5896); no other verb carries one.
            ...(optionId ? { optionId } : {}),
            // An OVERTURN carries its required note (MOTIR-5960); no other verb here does.
            ...(noteMd ? { noteMd } : {}),
            // A DESIGN refusal carries its REQUIRED verdict (MOTIR-6427); no other verb does.
            ...(refusalVerdict ? { refusalVerdict } : {}),
            identifier,
            stamp: read.stamp ?? '',
          });
        } catch (error) {
          clearGatePressPending(gate.id);
          throw error;
        }
        // A refusal applies nothing; the frame draws it IN PLACE and the overlay
        // stays open over it.
        if (!result.ok) {
          clearGatePressPending(gate.id);
          return result.refusal;
        }
        setDecided({ token: token!, gate: result.gate, filesKept: result.filesKept });
        // The exit row's chip, from what the decision WROTE (panel 5b). ⚠️ NEVER for an
        // acceptance sent back (MOTIR-6506; `acceptance-refusal-verdict.md` §2): no
        // acceptance refusal writes a status, so the chip keeps the story's — even if a
        // stale server answered one.
        const acceptanceRefused =
          result.gate.kind === 'acceptance_result' && decision === 'request_changes';
        if (result.statusWritten && !acceptanceRefused) {
          setWritten({ token: token!, status: result.statusWritten });
        }
        // The WHOLE decision, not only its state: the To-approve row reads the
        // state, and the item page underneath reads `outcomeRef` for its status
        // rail and `filesKept` for its record (MOTIR-5570).
        announceGateDecided({
          gate: result.gate,
          filesKept: result.filesKept,
          // What the decision WROTE onto the card — the item page's status rail reads
          // this, never `outcomeRef`, which is a CHOICE's option id (MOTIR-5893).
          statusWritten: result.statusWritten,
        });
        clearGatePressPending(gate.id);
        // A refusal that offers the seeded planner ASKS first (§10h; the design gate's
        // amendment of 2026-09-25), and so does an option CHOSEN (MOTIR-6436) — nothing
        // opens until the reader says yes.
        if (asksAfterPress(result.gate)) setReplanAsk(result.gate.id);
        router.refresh();
        return null;
      };
      // The decided record's Re-plan with AI door, and the ask in its place right after the
      // press (MOTIR-6211). The door's condition is the read's; the ask is this reader's.
      const replan = {
        canReplan: read.canReplan,
        asking: replanAsk === gate.id,
        onAskDone: () => setReplanAsk(null),
      };

      body =
        subject.kind === 'pull_request_approval' ? (
          // THE APPROVE-TO-MERGE PORT (Story MOTIR-5437 · Subtask MOTIR-5440;
          // `design/workbench/design-notes.md` § 24). Band 2 is the item page's
          // Development block — every pull-request row, then the run's How to test,
          // and on a design card its result first — COMPOSED, never redrawn: the same
          // component the page renders, handed the same fields from this overlay's own
          // read (MOTIR-5439). The only difference is the BOX: `fill`, because the
          // viewport is the container here and a section card is there.
          //
          // The frame, its verbs, its confirm step, the per-row merge outcomes and the
          // refusal are `DevelopmentGateFrame`'s (MOTIR-5484) — so there is still exactly
          // ONE approve control in the product, and How to test carries no verb.
          <DevelopmentSectionBody
            pullRequests={subject.pullRequests}
            itemIdentifier={identifier}
            repoDelivery={subject.repoDelivery}
            deliveries={subject.deliveries}
            howToTest={subject.howToTest}
            // THE DECISION PORT (MOTIR-5678, §27 Panel 7) — the document leads, and the
            // block draws no How to test for it.
            decision={subject.decision ? { document: subject.decision.document, gate } : null}
            // `motir fix` beside the approve, exactly as the page draws it (MOTIR-5806).
            repair={subject.repair ?? null}
            // AN `agent_review` ADDRESS (§12.3): the review's state above the delivery set, and
            // its one person's verb — *Continue without the review*, a required note — which
            // the item page hands over to this frame. Absent for every other kind.
            agentReview={subject.agentReview ?? null}
            designResult={
              subject.designEvidence ? (
                <DesignResultPanel
                  evidence={subject.designEvidence}
                  isDesignCard={subject.isDesignCard}
                  placement="development"
                />
              ) : subject.acceptanceEvidence && subject.acceptanceGate ? (
                // A STORY RUN (MOTIR-5790): the receipt leads, the pull requests beneath it.
                <AcceptanceDevelopmentSlot
                  evidence={subject.acceptanceEvidence}
                  accepted={
                    subject.acceptanceGate.state === 'approved'
                      ? {
                          name: subject.acceptanceGate.decidedByLabel ?? '',
                          at: subject.acceptanceGate.decidedAt ?? '',
                        }
                      : null
                  }
                  mergeAwaiting={gate.kind === 'pull_request_approval' && !decidedState}
                  // The overlay's port is height-bounded: the recording fits it (MOTIR-6042).
                  fit="viewport"
                />
              ) : undefined
            }
            mergeGate={{
              gate,
              stamp: read.stamp,
              // A decided gate has nothing left to press, exactly as on the design arm.
              canDecide: read.canDecide && !decidedState,
              routedToLabel: read.routedToLabel,
              members: subject.members,
              // A PRIMARY's own version is not a delivery set — an acceptance's recording, a
              // design's commit, a decision's blob — so the members the press merges come from
              // the merge gate's version (Bugs MOTIR-6079, MOTIR-6080), the value the item page
              // hands the same frame. Absent for the approve-to-merge gate's own port.
              mergeSubjectVersion: subject.mergeSubjectVersion,
              earlierApproval: read.earlierApproval,
            }}
            // A design that leads this frame (Workflow B) is sent back with a verdict too
            // (MOTIR-6427): the parent its Re-plan opens on, and the status it returns to.
            designRefusal={designRefusal}
            gateActions={{
              // The exit row's chip repaints from what the press WROTE (MOTIR-6427, 5b).
              decide: async (input) => {
                const result = await decideApprovalGateAction(input);
                // ⚠️ A STORY RUN'S ACCEPTANCE SENT BACK (MOTIR-6506) writes no status — the
                // chip is never repainted for it — and it withdrew the merge gate and (on a
                // Re-run) opened `motir fix`: the rows and the repair part are RE-READ, so
                // the block shows what the server now holds.
                if (result.ok && result.gate.kind === 'acceptance_result') {
                  rereadRows();
                } else if (result.ok && result.statusWritten) {
                  setWritten({ token: token!, status: result.statusWritten });
                }
                return result;
              },
              // A press that merges re-reads the rows it merged (`rereadRows`, MOTIR-6079).
              approveAndMerge: async (input) => {
                const result = await approveAndMergeAction(input);
                if (result.ok) rereadRows();
                if (result.ok && result.gate.outcomeRef) {
                  setWritten({ token: token!, status: result.gate.outcomeRef });
                }
                return result;
              },
              retryMember: async (input) => {
                const result = await retryApproveAndMergeMemberAction(input);
                if (result.ok) rereadRows();
                return result;
              },
            }}
            gateLayout="fill"
            // The approve-to-merge port re-reads through the SAME overlay read.
            onShowCurrentVersion={() => setReread((n) => n + 1)}
            gateKey={settled?.outcome === 'read' ? settled.reread : 0}
            // § 30 Panel 4a: the question was withdrawn under the reader. The frame stays as
            // it was drawn; the notice says why, and the verbs stay put but cannot be pressed.
            gateNotice={
              withdrawn && !decidedState ? (
                <ConflictWithdrawnNotice
                  conflict={withdrawn.conflict}
                  onShow={() => setReread((n) => n + 1)}
                />
              ) : undefined
            }
            gateVerbsDisabled={withdrawn !== undefined && !decidedState}
            canReplan={read.canReplan}
          />
        ) : subject.kind === 'acceptance_result' ? (
          // THE ACCEPTANCE PORT (MOTIR-4950) — the recording the gate asks about, read
          // by the gate's own `subjectId`, in the same player and provenance the story
          // page shows. The frame, its verbs, its confirm step and its refusals are
          // `ApprovalGateControl`'s, exactly as for a design: one approve control.
          // Its refusal asks by run shape and hands off (MOTIR-6506): the door or the ask,
          // named on the STORY, filled exactly as the design arm fills them.
          <RefusalReplanFrame
            key={`${gate.id}:${settled?.outcome === 'read' ? settled.reread : 0}`}
            replanKey={identifier}
            replan={replan}
            // *Sent back for a remedy* needs the run shape of a DECIDED gate, which its DTO
            // no longer carries (`offersRefusalVerdict` is false once decided). The overlay
            // knows it only for THIS reader's own press — the gate it pressed awaited without
            // offering a verdict, so the story is finished. A later reader sees the remedy
            // chip in `AcceptancePanel`, which renders only for a finished story.
            refusalRemedy={local !== null && !read.gate.offersRefusalVerdict}
            layout="fill"
            gate={gate}
            canDecide={read.canDecide && !decidedState}
            kindLabel={tAcceptance('kindLabel')}
            subjectMeta={
              gate.subjectVersion
                ? tAcceptance('meta.withVersion', { version: gate.subjectVersion.slice(0, 8) })
                : tAcceptance('meta.plain')
            }
            port={
              <div className="flex flex-col gap-(--spacing-sm)">
                {/* The port is height-bounded here, so the recording fits it (MOTIR-6042). */}
                <AcceptanceReceiptPlayer evidence={subject.evidence} fit="viewport" />
                <AcceptanceReceiptProvenance evidence={subject.evidence} />
              </div>
            }
            verbs={acceptanceVerbs}
            consequence={tAcceptance('consequence', { key: identifier })}
            confirmConsequences={[
              tAcceptance('confirm.records'),
              tAcceptance('confirm.freezes'),
              tAcceptance('confirm.movesToDone', { key: identifier }),
            ]}
            routedToLabel={read.routedToLabel}
            // An approved receipt's bytes are always kept (MOTIR-5872 — a later
            // publish supersedes it without unlinking them), so there is no
            // per-version files-kept answer to show.
            filesKept={null}
            alert={
              moved.length > 0 && gate.state === 'awaiting' && !decidedState ? (
                <SubjectMovedNotice moved={moved} onShow={() => setReread((n) => n + 1)} />
              ) : undefined
            }
            onDecide={onDecide}
            onShowCurrentVersion={() => setReread((n) => n + 1)}
            focusPortOnMount={settled?.outcome === 'read' && settled.reread > 0}
          />
        ) : subject.kind === 'decision_confirmation' ? (
          // THE CONFIRM PORT (Story MOTIR-5871 · MOTIR-5960) — the decision's four sections
          // in the SAME frame, Overturn · Confirm, and Overturn's required note.
          <DecisionConfirmGateFrame
            key={`${gate.id}:${settled?.outcome === 'read' ? settled.reread : 0}`}
            layout="fill"
            gate={gate}
            view={subject.confirm}
            workItemRefs={subject.confirm.workItemRefs}
            record={subject.confirm.record}
            recordCount={subject.confirm.recordCount}
            presentRecordIds={subject.confirm.presentRecordIds}
            replan={replan}
            canDecide={read.canDecide && !decidedState}
            // The decider may choose a page as the written record (MOTIR-7444); a choice is
            // a publication, so the overlay re-reads the subject after it.
            recordPicker={
              read.canDecide && !decidedState
                ? { itemIdentifier: identifier, onChosen: () => setReread((n) => n + 1) }
                : undefined
            }
            routedToLabel={read.routedToLabel}
            identifier={identifier}
            alert={
              moved.length > 0 && gate.state === 'awaiting' && !decidedState ? (
                <SubjectMovedNotice moved={moved} onShow={() => setReread((n) => n + 1)} />
              ) : undefined
            }
            onDecide={onDecide}
            onShowCurrentVersion={() => setReread((n) => n + 1)}
            focusPortOnMount={settled?.outcome === 'read' && settled.reread > 0}
          />
        ) : subject.kind === 'manual_work' ? (
          // THE MANUAL-WORK PORT (Story MOTIR-7460 · MOTIR-7478; design § 33.3) — the card's
          // to-do list read-only, *Guide me through* and *Mark done*, in the SAME frame.
          <ManualWorkGateFrame
            key={`${gate.id}:${settled?.outcome === 'read' ? settled.reread : 0}`}
            gate={gate}
            view={subject.manualWork}
            identifier={identifier}
            canDecide={read.canDecide && !decidedState}
            routedToLabel={read.routedToLabel}
            alert={
              moved.length > 0 && gate.state === 'awaiting' && !decidedState ? (
                <SubjectMovedNotice moved={moved} onShow={() => setReread((n) => n + 1)} />
              ) : undefined
            }
            onDecide={(decision) => onDecide(decision)}
            onShowCurrentVersion={() => setReread((n) => n + 1)}
            focusPortOnMount={settled?.outcome === 'read' && settled.reread > 0}
          />
        ) : subject.kind === 'decision_choice' ? (
          // THE CHOICE PORT (Story MOTIR-4914 · MOTIR-5896) — the options, each with its
          // WHY and what it is best for, in the SAME frame: select a row, then commit.
          <ChoiceGateFrame
            key={`${gate.id}:${settled?.outcome === 'read' ? settled.reread : 0}`}
            layout="fill"
            gate={gate}
            port={subject.choice}
            workItemRefs={subject.choice.workItemRefs}
            replan={replan}
            canDecide={read.canDecide && !decidedState}
            routedToLabel={read.routedToLabel}
            identifier={identifier}
            alert={
              moved.length > 0 && gate.state === 'awaiting' && !decidedState ? (
                <SubjectMovedNotice moved={moved} onShow={() => setReread((n) => n + 1)} />
              ) : undefined
            }
            onDecide={onDecide}
            onShowCurrentVersion={() => setReread((n) => n + 1)}
            focusPortOnMount={settled?.outcome === 'read' && settled.reread > 0}
          />
        ) : (
          <RefusalReplanFrame
            // A fresh read is a fresh frame: a stale refusal clears and the verbs return.
            key={`${gate.id}:${settled?.outcome === 'read' ? settled.reread : 0}`}
            replanKey={designRefusal.replanKey}
            replan={replan}
            layout="fill"
            gate={gate}
            // THE READ'S ANSWER, never this component's — a decided gate is
            // immutable, so nothing is left to press on one either way.
            canDecide={read.canDecide && !decidedState}
            kindLabel={tDesign('kindLabel')}
            subjectMeta={
              gate.subjectVersion
                ? tDesign('meta.withVersion', { version: gate.subjectVersion.slice(0, 8) })
                : tDesign('meta.plain')
            }
            // The route reads the GATE's own subject, so a decided gate shows the
            // version that was decided on (ADR §6c), not whatever is current now.
            port={<DesignResultPanel evidence={subject.evidence} isDesignCard />}
            verbs={designVerbs}
            consequence={tDesign('consequence', { key: identifier })}
            confirmConsequences={[
              tDesign('confirm.records'),
              tDesign('confirm.keepsFiles'),
              tDesign('confirm.movesToDone', { key: identifier }),
            ]}
            routedToLabel={read.routedToLabel}
            filesKept={local ? local.filesKept : subject.filesKept}
            // ⚠️ THE FRAME'S OWN SLOT, drawn BETWEEN THE PORT AND BAND 3 — which
            // is where design-notes § 26's DECISION 2 puts the notice, above the
            // verbs. Nothing in `ApprovalGateControl` changes: this card passes a
            // node to an input that already exists.
            alert={
              moved.length > 0 && gate.state === 'awaiting' && !decidedState ? (
                <SubjectMovedNotice moved={moved} onShow={() => setReread((n) => n + 1)} />
              ) : undefined
            }
            onDecide={onDecide}
            onShowCurrentVersion={() => setReread((n) => n + 1)}
            focusPortOnMount={settled?.outcome === 'read' && settled.reread > 0}
          />
        );
    }
  }

  return (
    <Modal
      open
      onOpenChange={(next) => {
        // `Esc` and the scrim both arrive here; the dialog is controlled, so this
        // IS the interception point.
        if (!next) requestClose();
      }}
      size="full"
      srTitle={srTitle}
      // At full size the dialog IS the surface: edge to edge, no radius, no border.
      className="flex flex-col rounded-none border-0 p-0"
      // The overlay carries its own Close, top-left — two Closes in one dialog is
      // a question nobody should be asked.
      hideClose
    >
      {/* modal-scroll-container: measured 1136x360, tallest = a design subject of six 32rem frames in the fill form (design-notes § 22 Panel 2b), band 2 the only scroll owner and band 3 on the bottom edge, panel 360px */}
      <ExitRow
        onClose={requestClose}
        onPeek={(key) => token !== null && setPeek({ token, key })}
        workItem={workItem}
        status={headerStatus}
      />
      <div className="flex min-h-0 flex-1 flex-col">{body}</div>
      {/* NESTED inside this dialog's content, so Radix stacks it as the TOP layer: its
          `Esc` and scrim close it alone, and the approval stays open (the planning
          overlay's precedent, MOTIR-4185). Its scrim is raised to `z-50` so it dims
          this panel rather than painting beneath it (§ 28, DECISION 6). An edit made
          in it settles with a refresh on close — `WorkItemQuickView`'s own contract. */}
      <WorkItemQuickView
        peekKey={peekKey}
        onClose={() => setPeek(null)}
        onEdited={() => router.refresh()}
        overlayClassName="z-50"
      />
    </Modal>
  );
}
