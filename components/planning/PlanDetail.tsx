'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { shallowPush } from '@/lib/navigation/shallowUrl';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { PlanningWorkspace } from '@/components/planning/PlanningWorkspace';
import { FOLDER_REF_PREFIX } from '@/lib/plans/refs';
import { useGeneratingPlanPoll } from '@/lib/hooks/useGeneratingPlanPoll';
import { PlanProposalViews } from '@/components/planning/PlanProposalViews';
import {
  PLAN_VIEW_PARAM,
  defaultPlanView,
  planViewFromParam,
  type PlanViewDto,
} from '@/lib/planning/planView';
import type { PlanItemOutcome } from '@/components/planning/PlanItemNode';
import { PlanReviewRail, type PlanCodeOutcome } from '@/components/planning/PlanReviewRail';
import { RepositorySetStep } from '@/components/planning/repositories/RepositorySetStep';
import {
  approvePlanRequest,
  declinePlanRequest,
  fetchPlanReview,
  revisePlanRequest,
  PlanRequestError,
} from '@/lib/planning/planReviewClient';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import { mergePlanReview } from '@/lib/planning/mergePlanReview';
import { fetchRepositorySet } from '@/lib/planning/repositorySetClient';
import { useRequestWorkbenchReread } from '@/lib/workbench/workbenchReread';
import type { ProjectRepoEstablishViewDto } from '@/lib/dto/projectRepos';
import {
  isSettledRow,
  rowIsReachable,
  setHasEstablishWork,
} from '@/lib/projectRepos/establishStep';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';

// The plan-detail island (Subtask 7.4.5 / MOTIR-847) — the generation-review MODE
// of the canvas+chat workspace shell (MOTIR-1193). It composes the proposed-plan
// canvas (left) + the review rail (right), and OWNS: the "live while generating"
// poll of the substrate read (`getPlan`, re-fetched — NEVER the 7.4 stream), the
// Approve(materialize) / Decline actions, and the stale-warning confirm before an
// approve when items have drifted. Seeded from the server read; a route refresh
// can't reach a client island's `useState` seed, so state updates flow through
// this island's own refetch on every mutation + poll tick (the page-state rule).
//
// APPROVE REFRESHES NOTHING (Story MOTIR-8539 · MOTIR-8576). It changes this
// island (the review → `approved`, filed through `refetch` and `mergePlanReview`,
// which is what keeps the decided plan and every card's outcome on screen) and it
// REVEALS the establish step, which the page reads only for an approved plan and
// hands down as `repositorySet`. That step used to arrive by a route refresh
// re-running the page's server read (MOTIR-1947); it now arrives by this island's
// own read of the same view (`fetchRepositorySet`, the step's own poll), so the
// approve lands in the same page view with no route refresh. The Workbench behind
// an overlay is asked to re-read itself (`useRequestWorkbenchReread`).

// The REVISION poll's cadence. The generating poll's is `useGeneratingPlanPoll`'s own.
const POLL_MS = 2500;

export interface PlanDetailProps {
  initialReview: PlanReviewDto;
  ariaLabel?: string;
  /**
   * The project's repository SET, when the plan is approved and the project has
   * one (Story MOTIR-1775 · MOTIR-1782). The establish step then takes a BAND
   * across the TOP of the canvas pane, at its own natural height, and the canvas
   * takes the remainder.
   *
   * ⚠️ PRESENT IS NO LONGER THE SAME AS DRAWN (bug MOTIR-5049). This prop is
   * handed down whenever the set EXISTS, because it feeds two consumers asking
   * different questions: the band, gated on `setHasEstablishWork`, and the review
   * rail's approved-outcome line, via `codeOutcomeOf`. A set whose every row is
   * `connected` or `skipped` — every BYOK project, since MOTIR-4753 made a
   * repository a precondition of planning — arrives here in full and draws NO
   * band; the canvas has the whole pane and the rail says the one true thing
   * (`design/repository-set/design-notes.md` §7b). Do not re-gate this prop on
   * the band's predicate: that is the shape that would silently take the rail's
   * line away for exactly that population.
   *
   * ⚠️ THIS REPLACES, AND DOES NOT DELETE, THE RULE THAT STOOD HERE
   * (`design/ai-planning/design-notes.md` Part VI §4; bug MOTIR-3154). It read:
   * *"Present → the canvas pane holds the ESTABLISH STEP instead of the
   * proposals: once the plan has materialized, the canvas of proposals has served
   * its purpose, and replacing it is the truthful use of the space."*
   *
   * That is correct ON ITS OWN PREMISE, and Part VI overturns the premise rather
   * than the conclusion. The premise is that the pane holds PROPOSALS — and a
   * proposal genuinely is spent by the decision that resolves it, so replacing it
   * with the next task WAS the truthful use of the space. After MOTIR-3160 and
   * MOTIR-3161 the pane no longer holds proposals: it holds the RECORD of the
   * decision — the accepted cards, on their real level, on the work items they
   * became — and a record is PRODUCED by the decision rather than spent by it.
   *
   * The second reason they can share the pane at all is that they are different
   * KINDS. The establish step is a TASK — MOTIR-1782's own central claim is that
   * its default path is one sentence, one primary, one quiet secondary. The
   * canvas is a RECORD. A task and a record can share a pane vertically; only two
   * records compete for it. Nothing INSIDE the step changes: MOTIR-1782 keeps
   * every decision it made about what the step says.
   *
   * Null → nothing changes (an un-decided plan, a declined one, a project with no
   * set, or a repo-set read that failed — the step is an addition to this page,
   * never a precondition for it).
   */
  repositorySet?: { projectKey: string; view: ProjectRepoEstablishViewDto } | null;
  /** The plan's project — the canvas reads its per-level roadmap (MOTIR-3083). */
  projectKey: string;
}

export function PlanDetail({
  initialReview,
  ariaLabel,
  repositorySet,
  projectKey,
}: PlanDetailProps) {
  const routes = useReaderRoutes();
  const t = useTranslations('planReview');
  const requestWorkbenchReread = useRequestWorkbenchReread();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [review, setReview] = useState<PlanReviewDto>(initialReview);
  // The one line the rail's approved outcome carries about the project's code.
  // DERIVED from the server read so a page load is already correct, then taken
  // over by the step reporting its own outcome — the rail is a sibling client
  // component, so nothing here needs a server round-trip to say "your code is
  // ready".
  //
  // Derived rather than `useState`-seeded (MOTIR-1947): the seed of a client
  // island runs ONCE at mount, so the prop the approve refresh delivers would be
  // ignored and the rail would carry no code line in the very breath it starts
  // saying "Approved". Only the step's OWN report is state, and null there simply
  // means "the step has not spoken yet" — it never emits null itself.
  const [reportedCodeOutcome, setReportedCodeOutcome] = useState<PlanCodeOutcome | null>(null);
  // ⚠️ THE ESTABLISH VIEW AN APPROVE REVEALS, read by this island (MOTIR-8576).
  // The page reads it only for a plan that was ALREADY approved when it rendered;
  // a plan approved here has no `repositorySet` prop until something reads it, and
  // the route refresh that used to is gone. A failed read degrades to "no step",
  // exactly as the page's own read does — the permanent door still leads back.
  const [readEstablishView, setReadEstablishView] = useState<ProjectRepoEstablishViewDto | null>(
    null,
  );
  const establishSet =
    repositorySet ?? (readEstablishView ? { projectKey, view: readEstablishView } : null);
  const codeOutcome = reportedCodeOutcome ?? codeOutcomeOf(establishSet?.view ?? null);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  // The proposal a refusal names (MOTIR-5418) — today only the approve refused by a
  // folder deleted since the plan was written, whose alert names that proposal.
  const [errorPlanItemId, setErrorPlanItemId] = useState<string | null>(null);
  // ── THE REVISION (Subtask MOTIR-3601) ────────────────────────────────────
  // The DRAFT and the local in-flight window live here rather than in the rail:
  // the island is what submits, and the rail is presentational, exactly as the
  // approve/decline handlers already are.
  const [reviseDraft, setReviseDraft] = useState('');
  const [revising, setRevising] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);

  const planId = initialReview.id;

  // ⚠️ ONE APPLIER FOR EVERY SNAPSHOT THIS ISLAND FILES (Story MOTIR-8539 ·
  // MOTIR-8575): its own `refetch`, the revision poll that goes through it, and the
  // generating poll. Each is MERGED into the held review by identity, so a read that
  // changed nothing hands the plan tree the same `items` and the same `version`, and
  // a changed proposal is the only node that re-renders.
  const heldReview = useRef(review);
  const applySnapshot = useCallback((fresh: PlanReviewDto): PlanReviewDto => {
    const merged = mergePlanReview(heldReview.current, fresh);
    heldReview.current = merged.review;
    setReview(merged.review);
    if (merged.itemsChanged) setVersion((v) => v + 1);
    return merged.review;
  }, []);

  const refetch = useCallback(
    async (signal?: AbortSignal) => applySnapshot(await fetchPlanReview(planId, signal)),
    [planId, applySnapshot],
  );

  // ⚠️ POLL WHILE A REVISION HOLDS THE PLAN, and re-run the SERVER read when it
  // lands (Part XII §F). The revision arrives from a JOB while the reviewer sits
  // on the page, so nothing on the client knows when it finished; the same
  // `getPlan` re-fetch the generating poll uses answers it, because the lease it
  // must observe is derived from the plan's own trail.
  //
  // The LANDING files the fresh review like any read and clears `revising`. It
  // refreshes nothing (MOTIR-8576): a revision leaves the plan `planned`, so no
  // surface only the server renders has moved.
  useEffect(() => {
    if (review.revision === null) return;
    const ctrl = new AbortController();
    const handle = setInterval(() => {
      void refetch(ctrl.signal)
        .then((fresh) => {
          if (fresh.revision === null) setRevising(false);
        })
        .catch(() => {
          /* best-effort poll — a transient failure just retries next tick */
        });
    }, POLL_MS);
    return () => {
      ctrl.abort();
      clearInterval(handle);
    };
  }, [review.revision, refetch]);

  // Live polling WHILE generating — the proposed items stream in per level as the
  // engine emits them. Stops the instant the plan leaves `generating`. The poll
  // itself is the shared one (MOTIR-6295); this island only files each snapshot
  // into its own state, exactly as `refetch` does. Not `immediate`: the island is
  // seeded from the server read, so the first re-read waits a full interval.
  // Its `failing` feeds the progress line's dropped-read row (MOTIR-7829, §26.10).
  const { failing: liveFailing, reads: liveReads } = useGeneratingPlanPoll(
    review.status === 'generating' ? planId : null,
    {
      immediate: false,
      onSnapshot: (fresh) => {
        applySnapshot(fresh);
      },
    },
  );

  const onRevise = useCallback(
    async (prompt: string) => {
      const text = prompt.trim();
      if (!text) return;
      setRevising(true);
      setErrorCode(null);
      try {
        await revisePlanRequest(planId, text);
        // Clear the field only on a DISPATCHED revision: a submit that was
        // refused leaves the instruction where the reviewer can send it again.
        setReviseDraft('');
        // Read the lease back immediately rather than waiting a poll tick, so
        // the gate holds in the same breath the reviewer pressed Send.
        await refetch();
      } catch (err) {
        setRevising(false);
        setErrorCode(
          err instanceof PlanRequestError ? (err.code ?? 'REVISE_FAILED') : 'REVISE_FAILED',
        );
        // ⚠️ PUT THE INSTRUCTION BACK. The shipped composer clears its own draft
        // the moment it submits (`onSubmit(text); onDraftChange('')`), which is
        // right for a chat turn that always lands and wrong for a submit that can
        // be REFUSED — a reviewer whose revision was refused by a lease would
        // otherwise have to retype what they just asked for, at the exact moment
        // they are being told to try again.
        setReviseDraft(text);
        // A refusal is usually a fact about the plan (a lease, a frozen status),
        // so show the reader what the plan actually is beside the message.
        await refetch().catch(() => undefined);
      }
    },
    [planId, refetch],
  );

  // After a DECISION (an approve, or the 409 that says one was already made): the
  // Workbench behind an overlay re-reads itself, and an approved plan's establish
  // step is read if the page did not hand it down.
  const afterDecision = useCallback(
    (fresh: PlanReviewDto) => {
      requestWorkbenchReread();
      if (fresh.status !== 'approved' || repositorySet) return;
      // A body that is not a view (no `set`) is a failed read, like a thrown one.
      void fetchRepositorySet(projectKey)
        .then((view) => {
          if (view?.set) setReadEstablishView(view);
        })
        .catch(() => {});
    },
    [requestWorkbenchReread, repositorySet, projectKey],
  );

  const runAction = useCallback(
    async (
      action: (id: string) => Promise<unknown>,
      { decides = false }: { decides?: boolean } = {},
    ) => {
      setBusy(true);
      setErrorCode(null);
      setErrorPlanItemId(null);
      try {
        await action(planId);
        const fresh = await refetch();
        // The decision committed work items: the establish step it reveals and the
        // Workbench behind an overlay are brought current by their OWN reads.
        if (decides) afterDecision(fresh);
      } catch (err) {
        // A 409 is NOT an error on this surface (MOTIR-3240). It means the plan
        // moved between render and click — a concurrent reviewer decided it, or
        // the producer finished and it left `generating` — and the refetch below
        // shows the reader exactly that. The decision was still made, so a server
        // surface it reveals is just as due as on our own success.
        //
        // ⚠️ This used to set `errorCode` FIRST and then refetch, so the rail
        // rendered "that didn't work" above a plan whose real state was right
        // there beside it. That was wrong for the approve path too, and it is
        // corrected for both rather than special-cased for the discard — the two
        // are the same event and there is no reading on which one of them is a
        // failure and the other is not.
        if (err instanceof PlanRequestError && err.status === 409) {
          // …except the HELD refusal (MOTIR-6038), which the rail already has its own
          // sentence for: a revision took the lease between the render and the press,
          // and the reader is told why rather than shown a plan that looks decidable.
          if (err.code === 'PLAN_REVISION_IN_FLIGHT') setErrorCode(err.code);
          // …and the STALE refusal of an asked plan (MOTIR-6037; design Part XXII §22.5):
          // nothing was decided, and the reader is told the plan moved under them, in
          // the design's words, above the re-read verbs.
          if (err.code === 'APPROVAL_GATE_STALE_SUBJECT' || err.code === 'PLAN_GATE_AWAITING') {
            setErrorCode('APPROVAL_GATE_STALE_SUBJECT');
          }
          const fresh = await refetch().catch(() => null);
          if (decides && fresh) afterDecision(fresh);
        } else if (isFolderMissingRefusal(err)) {
          // THE DELETED FOLDER (Part XVII §17.5, 4b) — keyed on the refusal, not
          // the generic action error: approve re-checks every `folder:<id>` a plan
          // names and refuses the WHOLE approve for one deleted since the append
          // (MOTIR-5423). Refetch, so the card, the summary and the disabled
          // Approve settle into the planned-state treatment under the alert.
          setErrorCode(FOLDER_MISSING_REFUSAL);
          setErrorPlanItemId(err.detail.planItemId);
          await refetch().catch(() => {});
        } else {
          setErrorCode(err instanceof PlanRequestError ? (err.code ?? 'ERROR') : 'ERROR');
        }
      } finally {
        setBusy(false);
        // Both confirms close on the way out, success or 409 alike: the action
        // has resolved and the refetch has already shown the plan's real state,
        // so leaving either dialog open would ask the reader to confirm a
        // decision that has already been made.
        setConfirmOpen(false);
        setDiscardOpen(false);
      }
    },
    [planId, refetch, afterDecision],
  );

  // Approving REVEALS the establish step — so this is the one action that reads it
  // (MOTIR-1947; MOTIR-8576 replaced the route refresh that used to deliver it).
  // Every press hands back the stamp of the review it was made on (MOTIR-6038), so the
  // decide door refuses a press against proposals that moved since this render.
  const stamp = review.gate?.stamp ?? null;
  const approve = useCallback(
    () => runAction((id) => approvePlanRequest(id, stamp), { decides: true }),
    [runAction, stamp],
  );
  // An asked plan's decline carries its OPTIONAL reason (ADR §11.4; MOTIR-6037's band).
  const decline = useCallback(
    (noteMd: string | null = null) =>
      runAction((id) =>
        noteMd ? declinePlanRequest(id, stamp, noteMd) : declinePlanRequest(id, stamp),
      ),
    [runAction, stamp],
  );

  const onApprove = useCallback(() => {
    if (review.stale) {
      setConfirmOpen(true);
      return;
    }
    void approve();
  }, [review.stale, approve]);

  // DECLINE, and its one confirming arm (MOTIR-3240). Ending a plan that is still
  // being written is irreversible from this surface and the plan is still moving,
  // so it confirms — the same shape the stale-approve confirm already uses, and
  // for the sharper reason. A `planned` plan has been read and declining it is
  // the ordinary decision; that path is unchanged.
  const onDecline = useCallback(
    (noteMd: string | null = null) => {
      if (review.status === 'generating') {
        setDiscardOpen(true);
        return;
      }
      void decline(noteMd);
    },
    [review.status, decline],
  );

  const discard = useCallback(() => void decline(), [decline]);

  // ⚠️ THE TERMINAL-EMPTY HAND-OFF IS GONE FROM THIS SURFACE (MOTIR-4124), and
  // what replaced it is the RAIL. A `return` before the workspace was mounted
  // took `PlanReviewRail` with it, so the one plan a reviewer could do nothing
  // about — zero proposals — was also the one plan they were given no Approve
  // and no Decline for. The Plans list offered none either (its row is a bare
  // link), so an empty plan sitting in the queue could not be ended from the UI
  // at all, and one undecided plan pauses that project's auto-plan cadence.
  //
  // The narrow fix — exclude the two AWAITING-DECISION statuses — would have
  // left a branch nothing can reach: `generating` was already excluded, decided
  // plans were already excluded, and `planned` / `stale` are the rest of the
  // vocabulary. So the branch goes, rather than being kept as a guard that can
  // never fire. A plan with no items now renders exactly as the design of
  // record draws a decided one with none (`design/ai-planning/design-notes.md`
  // Part VIII): the pane holds the roadmap's own empty state, and the rail
  // states the outcome or offers the decision.
  //
  // WHERE THE HAND-OFF LIVES INSTEAD — it was never only here. A generation
  // that produces nothing settles `usePlanGeneration`'s own `empty` phase, and
  // `GenerationFlow` draws that terminal with the same copy plus a Retry, on
  // the surface the person is actually standing on. This surface is reached by
  // opening a plan from the list, where "describe what you want to build" is
  // not what a reader came for.
  //
  // MOTIR-833 / MOTIR-1377 / MOTIR-3161 / MOTIR-3578 are what this replaces:
  // MOTIR-1377 stopped the empty state shadowing a DECLINED plan's outcome, and
  // MOTIR-3578 kept `stale` out of `decided` for the same reason. Both were
  // narrowing a branch whose real defect was that it could suppress the rail.
  //
  // ⚠️ THE `decided` BOOLEAN THAT STOOD HERE IS GONE (MOTIR-4495). It survived
  // one consumer past its usefulness: `PlanProposalList` swapped BOTH its
  // vocabularies on it, so a DECLINED plan's list rendered the APPROVED past
  // tense — `Created` / `Applied` / `Archived` about work that never happened,
  // the `add` row contradicting itself inside one line. Both bodies now read the
  // three-valued `outcome` eleven lines below, which is the value the canvas has
  // taken since MOTIR-3161 and the reason the canvas never had this bug.
  // The plan's decision, drawn on every node the plan contributes (MOTIR-3161).
  // WHICH BODY the pane shows. THE URL IS THE SINGLE SOURCE OF TRUTH (MOTIR-3239),
  // derived on every render exactly as `ChildPanel` derives `?children=` — so a
  // deep link, a reload and browser Back/forward all agree, and no local state
  // can disagree with the address bar.
  //
  // ⚠️ THE DEFAULT IS PINNED AT MOUNT (MOTIR-3262). It is DERIVED from the plan's
  // shape — the list when the proposals straddle more than one container — and a
  // `generating` plan's item set grows under the 2.5s poll below, so a plan can
  // cross that threshold while a reviewer is reading it. The default is a SEED
  // for the arriving reader, not a controlled value: recomputing it per render
  // would yank somebody between views on a poll tick. `useState`'s initializer
  // runs once, which is exactly the semantics wanted here.
  const [pinnedDefaultView] = useState<PlanViewDto>(() => defaultPlanView(initialReview));
  const view: PlanViewDto = planViewFromParam(searchParams.get(PLAN_VIEW_PARAM), pinnedDefaultView);

  const onViewChange = useCallback(
    (next: PlanViewDto) => {
      const params = new URLSearchParams(searchParams.toString());
      // THE DEFAULT WRITES A CLEAN URL, whatever the default is — so every
      // existing `/plans/[id]` link stays byte-identical, and the property
      // survives MOTIR-3262 making the default conditional.
      if (next === pinnedDefaultView) params.delete(PLAN_VIEW_PARAM);
      else params.set(PLAN_VIEW_PARAM, next);
      const query = params.toString();
      // SHALLOW (MOTIR-3434). BOTH bodies render from the `review` this island
      // already holds in `useState`, so the server has nothing to say — and
      // `router.push` here re-ran `/plans/[id]/page.tsx`'s seven awaits to
      // render what was already in the browser. That round trip is the
      // "clicking canvas or list doesn't go there immediately" this story was
      // reported for. `shallowPush` writes the same URL without it, keeps the
      // history entry so Back restores the previous view, and does not scroll —
      // which is what the old `scroll: false` was asking for (a body must never
      // yank the reader to the top of a pane they were already reading).
      shallowPush(query ? `${pathname}?${query}` : pathname);
    },
    [pathname, pinnedDefaultView, searchParams],
  );

  const outcome: PlanItemOutcome | null =
    review.status === 'approved' ? 'accepted' : review.status === 'declined' ? 'declined' : null;
  return (
    <>
      <PlanningWorkspace
        className="h-full w-full"
        canvas={
          // BOTH, STACKED (Part VI §4). The step takes a band at the top at its
          // own natural height; the canvas takes the remainder with `min-h-0` so
          // it SHRINKS rather than pushing the band out, and is never replaced.
          //
          // ⚠️ THE CLAUSE THAT USED TO CLOSE THIS COMMENT WAS FALSE, AND IT IS
          // WHAT LET MOTIR-5049 SHIP. It read: *"Once the step settles it
          // collapses to its own one-line form and the canvas has effectively
          // the whole pane — no extra rule needed, because the step's own design
          // already shrinks."* No collapsed form exists in `RepositorySetStep`.
          // Settling GROWS it: `state === 'ready'` renders the overline, the
          // `<h2>`, the status line, `OwnershipPromise` AND `AccessReport`,
          // inside `StepShell`'s `p-8` — two blocks and a button MORE than
          // `working`. `design/ai-planning/design-notes.md` Part VI §4 carries
          // the same amendment against the same sentence.
          //
          // So the extra rule the comment said was unnecessary is the one below,
          // and Part VI §4's stacking decision is UNCHANGED by it: the band still
          // takes a band and never the pane, for every project with code to
          // establish. What is added is the population where the band is not
          // drawn AT ALL (`design/repository-set/design-notes.md` §7b).
          // ⚠️ THE HEADER, THE SWITCH AND BOTH BODIES NOW LIVE IN
          // `PlanProposalViews` (Subtask MOTIR-6185). They were inline here, and
          // this page was their only host; the planning SURFACE is about to mount
          // the same component (MOTIR-6186), and two copies of the list, the
          // canvas and the switch between them are two places that can disagree
          // about what a plan contains.
          //
          // Nothing moved out of THIS island except the JSX. The URL binding
          // stays here — the view is CONTROLLED, and the two hosts hold it
          // differently on purpose (this page in the URL, the overlay locally,
          // `design-notes.md` Part XXI decision 3) — and so do the pinned
          // default, the establish band's own predicate, `refetch` and `version`.
          <PlanProposalViews
            items={review.items}
            edgeCoverage={review.edgeCoverage}
            outcome={outcome}
            projectKey={projectKey}
            version={version}
            ariaLabel={ariaLabel ?? t('canvasAria')}
            view={view}
            onViewChange={onViewChange}
            // The progress line (MOTIR-7829) — on `progress`, never on `live`:
            // this page passes no `live` and still shows the plan being written.
            progress={review.progress ?? null}
            progressFailing={liveFailing}
            // The cards' cue state (MOTIR-11254, §31.5): Thinking until a draft
            // exists, Drafting once it does. The same polled read already carries
            // them; this page still shows no partial text (`live` is off).
            inFlightDrafts={review.inFlightDrafts ?? null}
            cueReads={liveReads}
            band={
              establishSet && setHasEstablishWork(establishSet.view.set.rows) ? (
                <div
                  data-testid="plan-detail-establish-band"
                  className="shrink-0 border-b border-(--el-border) bg-(--el-surface)"
                >
                  {/* ⚠️ `connectHref` is the MEMBER's own GitHub account (Story
                      MOTIR-4669 · MOTIR-4682). Both places it is used ask the
                      reader to connect THEIR identity — the "connect your own"
                      CTA and a row's `not invited` action — and an identity is
                      the one git fact that is not the organisation's to grant. It
                      pointed at `/settings/workspace/github`, a route MOTIR-4680
                      deleted. */}
                  <RepositorySetStep
                    projectKey={establishSet.projectKey}
                    initialView={establishSet.view}
                    backlogHref={routes.view('/items')}
                    connectHref="/settings/account/git"
                    onOutcomeChange={setReportedCodeOutcome}
                  />
                </div>
              ) : null
            }
          />
        }
        chat={
          <PlanReviewRail
            review={review}
            onApprove={onApprove}
            onDecline={onDecline}
            busy={busy}
            errorCode={errorCode}
            errorPlanItemId={errorPlanItemId}
            codeOutcome={codeOutcome}
            onRevise={onRevise}
            reviseDraft={reviseDraft}
            onReviseDraftChange={setReviseDraft}
            revising={revising}
          />
        }
      />

      <Modal
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title={t('discardConfirmTitle')}
        // The confirm NAMES the proposals already appended: the count is the one
        // fact that tells the reader what they are throwing away, and the second
        // half is the reassurance the whole substrate rests on — nothing was ever
        // created, so nothing is lost from the tree.
        description={t('discardConfirmBody', { n: review.itemCount })}
        size="sm"
      >
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDiscardOpen(false)} disabled={busy}>
            {t('discardConfirmCancel')}
          </Button>
          <Button variant="primary" onClick={() => void discard()} loading={busy} disabled={busy}>
            {t('discardConfirmCta')}
          </Button>
        </div>
      </Modal>

      <Modal
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('staleConfirmTitle')}
        description={t('staleConfirmBody', { n: review.staleCount })}
        size="sm"
      >
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={busy}>
            {t('staleConfirmCancel')}
          </Button>
          <Button variant="primary" onClick={() => void approve()} loading={busy} disabled={busy}>
            {t('staleConfirmApprove')}
          </Button>
        </div>
      </Modal>
    </>
  );
}

/**
 * The one line the approved outcome gains about the project's code — `ready` once
 * every row of the set has SETTLED, `unfinished` while any is still unresolved
 * (proposed, creating or failed), and null when there is no set to speak of.
 *
 * "Settled" is the ADR §4.1 word: `created`, `connected` and `skipped` all count,
 * because a deliberately skipped row is a finished decision, not an unfinished
 * one — telling the user to "finish setting up repositories" they chose to go
 * without would be a nag about a choice they already made.
 *
 * ⚠️ THIS IS THE LINE THE USER IS LEFT WITH ONCE THE BAND IS GONE, so it is
 * computed from the set whether or not the band is drawn (bug MOTIR-5049). For a
 * settled organisation-owned set it resolves `ready` and the rail renders "Your
 * code is ready" — true of an organisation's own repository, claiming nothing
 * about who hosts it, and per `design/repository-set/design-notes.md` §7b it is
 * the WHOLE answer: nothing is added to the rail, deliberately.
 *
 * ⚠️ AND ITS TWO PREDICATES ARE NO LONGER LOCAL COPIES. `isSettledRow` and
 * `rowIsReachable` were duplicated verbatim here and in `RepositorySetStep`;
 * both now come from `lib/projectRepos/establishStep.ts`, which reaches the
 * settled answer through the ADR §4.1 edge table rather than restating it. They
 * are NOT the band's predicate — see that module's header for why `state`
 * decides the band and settledness cannot.
 *
 * ⚠️ RE-READ AGAINST THE STEP'S THIRD ARM AND DELIBERATELY LEFT ALONE
 * (bug MOTIR-5036 · design v7 · 2026-09-11). `AccessReport` now splits its
 * non-invited report into TWO arms — no account (B) and GitHub refused (C) —
 * and the question this header owes an answer to is whether the rail must split
 * with it. **It must not, and the reason is that the rail answers a different
 * question.**
 *
 * `codeOutcomeOf` resolves BOTH arms to `needs_access`, because `needs_access`
 * is TRUE of both: a `created` row nobody has been invited to is code the user
 * cannot clone, and WHY the invitation never landed does not change that. The
 * rail's line is the standing outcome of the plan; the step's line is the
 * report of what just happened. Splitting the rail would put the cause of a
 * one-off event into a sentence that outlives it, and it would duplicate a
 * distinction the step and `/settings/project/code-access` already draw — the
 * latter branching on the DTO's own `reason === 'no_github_identity'`.
 *
 * So this function is UNCHANGED by MOTIR-5036, and that is a decision rather
 * than an omission: `the rail says needs_access for BOTH of the step's
 * non-invited arms` in `tests/components/plan-detail-settled-set.test.tsx` is
 * what pins it, so a later reader who thinks the rail should split has to
 * delete an assertion that says why it should not.
 */
function codeOutcomeOf(view: ProjectRepoEstablishViewDto | null): PlanCodeOutcome | null {
  if (!view || view.set.rows.length === 0) return null;
  if (!view.set.rows.every(isSettledRow)) return 'unfinished';
  // Settled is not the same as REACHABLE (MOTIR-1900). A repository Motir created
  // lives in Motir's org and is private, so a `created` row nobody has been
  // invited to is code the user cannot clone — the rail says so rather than
  // claiming it is ready. A `connected` row is the user's own repository and a
  // `skipped` row has none, so neither raises the question.
  return view.set.rows.every(rowIsReachable) ? 'ready' : 'needs_access';
}

/** The rail's error code for an approve refused by a deleted folder (MOTIR-5418). */
export const FOLDER_MISSING_REFUSAL = 'PLAN_FOLDER_MISSING';

/**
 * An approve refused because a proposal names a folder that no longer exists
 * (MOTIR-5423): `INVALID_PLAN_REF_GRAPH` whose sentence names a `folder:<id>` ref.
 * The code alone is shared with every other dangling ref, so the ref's PREFIX is
 * what tells this refusal apart.
 */
function isFolderMissingRefusal(err: unknown): err is PlanRequestError {
  return (
    err instanceof PlanRequestError &&
    err.code === 'INVALID_PLAN_REF_GRAPH' &&
    (err.detail.message ?? '').includes(FOLDER_REF_PREFIX)
  );
}
