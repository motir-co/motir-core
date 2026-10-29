'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AutoRerunLine } from './AutoRerunLine';
import Link from 'next/link';
import { AlertTriangle, Maximize2, Minimize2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Pill, type PillProps } from '@/components/ui/Pill';
import { FormField } from '@/components/ui/FormField';
import { Textarea } from '@/components/ui/Textarea';
import {
  RefusalReasonQuote,
  RefusalVerdictChip,
  RefusalVerdictGroup,
  type RefusalVerdictField,
} from './RefusalReason';
import { PortRenderStatusProvider, usePortRenderStatus } from './portRenderStatus';
import type { ApprovalGateDTO, ApprovalGateRefusalVerdictDTO } from '@/lib/dto/approvalGate';
import type { GateDecision } from '@/lib/dto/approvalGate';
import type { GateRefusal } from '@/lib/approvalGates/refusals';
import type { StampComponent } from '@/lib/approvalGates/stamp';

// THE UNIVERSAL APPROVAL FRAME (Story MOTIR-4778 · Subtask MOTIR-4792), built to
// `design/work-items/approval-control.mock.html` + `design-notes.md`
// § The UNIVERSAL APPROVAL FRAME.
//
// ⚠️ THE UNIVERSAL ELEMENT IS THE FRAME, NOT THE VERB PAIR — and that is a
// CORRECTION, recorded here because the obvious refactor undoes it. The first
// design drew the BUTTON as the shared element with the subject left as a stub,
// and was rejected on review: *"Approve button without review doesn't stand —
// the user needs to see what he is approving."* So what a person learns once is
// what REVIEWING looks like, and the button is the last band of it.
//
// THREE BANDS, and the ORDER is the whole of it:
//
//   1 · header — what you are looking at, which version, when it arrived, the state
//   2 · THE PORT — the subject, RENDERED
//   3 · the verbs — BELOW the port, because you decide after you look
//
// ⚠️ SO NEVER MOVE THE VERBS ABOVE THE PORT. The withdrawn first cut also
// carried a rule that "the control sits at the HEAD of the section, never below
// the artefact" — the right observation (a reader should not scroll to discover
// a decision is owed) answered the wrong way, by moving the button FURTHER from
// the thing it decides. The frame removes the problem instead of relocating it.
//
// PRESENTATIONAL PLUS ONE ACTION: fed a gate DTO and a decide callback, it owns
// no fetching and renders every state from the model. The PORT's contents are
// the caller's — that is the only thing a new gate kind supplies, and it is why
// the merge kind needs no second control, no second confirm and no second
// decided treatment.
//
// ── ALL NINE STATES ARE NOW BUILT, AND THE LAST TWO CARDS LANDED TOGETHER ──
// This block used to be a "what this card does not draw" list pointing at two
// siblings. Both have shipped, so it is a record of WHERE each state's
// reasoning lives rather than a deferral.
//
// STATES `E` (approved) AND `G` (superseded) — MOTIR-5033. Each needed
// something the awaiting-only read could not give:
//   · `E` renders the version identifier the audit pinned and says whether the
//     files were kept — and its PORT shows THE VERSION THAT WAS APPROVED, which
//     the caller supplies by reading the gate's own subject rather than the
//     card's current design (ADR §6c);
//   · `G` is written by the PRODUCT, never a person, so it is colourless,
//     verb-less, names nobody, and its port is DEAD — it does not render the
//     subject at all. The audit must never read a withdrawal as somebody's
//     answer, and a live Approve button over a withdrawn question would be
//     exactly that.
//
// THE PORT'S MECHANICS AND STATE `X` — MOTIR-5032, described at `PortBox` and
// at band 3 below. The three mechanics are the design's own, and
// `design-notes.md` insists they are not polish: "The port's mechanics are the
// design, not a detail: a floor height, so the subject is never a sliver; a
// ceiling with its own scroll, so a tall subject never pushes the verbs off
// screen; an Expand affordance, for a subject that deserves the whole
// viewport."
//
// All three protect the ONE ordering above — the verbs sit below the port. A
// port that collapses to a sliver is the button-first cut arrived at by
// accident; a port with no ceiling pushes the verbs past the fold and the
// reader approves something they have scrolled away from.
//
// ⚠️ AND THE TWO CARDS MEET AT BAND 2, WHICH IS WHERE THEIR MERGE CONFLICTED:
// `G`'s port is DEAD BY THE FRAME'S DECISION while `X`'s port FAILED against
// the frame's expectation, and the port BOX belongs to both. The resolution is
// at band 2 below — one box, two contents, and `X`'s alert suppressed under
// `G`, because a subject deliberately not drawn is not a subject that failed
// to draw.

/**
 * One verb in band 3.
 *
 * ⚠️ BAND 3 IS A SLOT THE KIND FILLS, NOT A FIXED PAIR. The verb SET arrives as
 * data, so a pair is ONE CASE rather than the component's shape — ADR §1's
 * amendment registers `decision_choice`, whose set is N options rather than two
 * verbs, and the frame accommodates it without a second control. Drawing that
 * N-option band is MOTIR-4914's; making the band read from data is this card's.
 */
export interface GateVerb {
  /** The decision this verb records — the decide door's own vocabulary. */
  decision: GateDecision;
  /**
   * The verb's IDENTITY when two verbs record the same decision (MOTIR-6825 — the agent
   * review's *Review again* and *Continue without the review* both reach `approve`, one
   * through `perform`). Keys the button; absent, the decision and option do.
   */
  id?: string;
  label: string;
  variant: 'primary' | 'secondary';
  /**
   * Whether pressing it opens the confirm band first. Approving a design is
   * terminal and confirms; sending it back feeds the revise loop and does not,
   * because a reversible act asked twice is friction rather than care.
   */
  confirms: boolean;
  /**
   * DRAWN, BUT NOT PRESSABLE (Story MOTIR-4907 · Subtask MOTIR-5678; design §27 Panels
   * 3a–3d) — a decision whose document cannot be shown keeps its Approve on screen,
   * disabled, while Request changes stays live. ⚠️ ONLY with the reason said in words
   * beside it, as the band's consequence line: the one case a disabled verb is honest is
   * a reader who may decide, looking at a subject that cannot yet be approved. State `B`
   * and state `X` still render no verbs at all. The approval overlay disables BOTH verbs
   * when the question was withdrawn under the reader (Subtask MOTIR-5917; § 30 Panel 4a),
   * with its notice saying why.
   */
  disabled?: boolean;
  /**
   * WHAT PROCEEDING RUNS, when it is not a decision on this gate (Story MOTIR-5799 ·
   * Subtask MOTIR-5806; `design/github/design-notes.md` § 28 panel 8a). A pull-request
   * row's *Queue again* / *Retry merge* IS an approval, and it takes this frame's ONE
   * confirm rather than growing a second one beside the rows — so the verb that opens the
   * band carries its own act. Omitted, `onDecide(verb.decision)` runs, as it always has.
   */
  perform?: () => Promise<GateRefusal | null>;
  /**
   * WHICH OPTION a `choose` verb records (Story MOTIR-4914 · MOTIR-5896) — a
   * `decision_choice` gate's verbs are its options, so the verb carries the one it
   * names and `onDecide` passes it to the door. Absent on every other verb.
   */
  optionId?: string;
  /**
   * A REQUIRED NOTE this verb records (Story MOTIR-5871 · MOTIR-5960; design
   * `approval-control--decision-confirm.mock.html` Panel 2) — a `decision_confirmation`
   * gate's *Overturn* says what was ACTUALLY discussed. The confirm band draws the field
   * and refuses an empty press IN PLACE, before anything reaches the door; the door
   * refuses it again regardless (`overturn_needs_a_note`). Absent on every other verb.
   */
  note?: { label: string; helper: string; required: string };
  /**
   * A REQUIRED VERDICT this verb records beside its note (Story MOTIR-6070 · Subtask
   * MOTIR-6427; design `approval-control--design-verdict.mock.html` panels 1–2) — a design
   * sent back says Revise or Re-plan. The confirm band draws the two tiles under the note,
   * nothing pre-selected, and refuses a press without one IN PLACE, reporting a missing
   * note on the same press; the door refuses it again (`refusal_verdict_required`).
   * Absent on every other verb, whose band is unchanged.
   */
  verdict?: RefusalVerdictField;
  /**
   * WHY NO VERDICT IS ASKED (Story MOTIR-6071 · Subtask MOTIR-6506; design
   * `approval-control--acceptance-verdict.mock.html` choice 1) — ONE line in the verdict's
   * slot, below the reason and above the buttons, for a verb whose kind offers a verdict
   * elsewhere but not on this gate (a finished story has nothing left to re-run). No box,
   * no icon, `--el-text-secondary`. Absent on every other verb.
   */
  absentVerdict?: string;
  /**
   * The confirm band's words FOR THIS VERB, when a kind's verbs confirm different acts
   * (MOTIR-5960 — *Confirming this will:* and *Overturning this will:*). Absent, the
   * frame-level `confirmTitle` / `confirmConsequences` / `confirmProceedLabel` apply.
   */
  confirm?: { title: ReactNode; consequences: ReactNode[]; proceedLabel: string };
  /**
   * The verb's OWN WORDS WHILE ITS PRESS RECORDS (Story MOTIR-7460 · MOTIR-7478; design
   * `approval-overlay--manual-work.mock.html` Panel 3) — Mark done reads *Marking…* with
   * the shipped `Button loading` spinner. Absent, a pending verb is only disabled, as
   * every other kind's always was.
   */
  pendingLabel?: string;
}

export interface ApprovalGateControlProps {
  gate: ApprovalGateDTO;
  /**
   * Whether THIS reader may press the verbs. The AUTHORITY answer, never the
   * routing one: a gate is SHOWN to one person and may be PRESSED by three.
   * `false` is state `B` — the port live, the verbs absent.
   */
  canDecide: boolean;
  /** Band 1's label for what is being decided (e.g. "Design result"). */
  kindLabel: string;
  /** Band 1's meta line — when it arrived and which version. */
  subjectMeta: ReactNode;
  /** BAND 2 — the subject, RENDERED. The only thing a kind supplies. */
  port: ReactNode;
  /** The verb SET this kind carries. */
  verbs: GateVerb[];
  /** Band 3's sentence: what approving will DO, beside the verbs. */
  consequence: ReactNode;
  /**
   * THE SETTINGS DOOR (MOTIR-5513; `approval-control.mock.html` panel `S`) — a
   * KIND-SUPPLIED way out of being asked: a link to the project setting that
   * decides whether this kind asks at all. Rendered in band 3's LEFT column, under
   * the consequence line; never a verb and never beside the verbs, and pressing it
   * decides nothing. The CALLER passes it only to a viewer holding the key its
   * destination is guarded by (`settingsDoorFor`) — the frame never guesses.
   * Absent, band 3 is byte-identical to state `A`.
   */
  settingsDoor?: { href: string; label: string };
  /** The confirm band's list — what approving is about to do, per kind. */
  confirmConsequences: ReactNode[];
  /**
   * The confirm band's TITLE, when the kind's verb is not *approving* (MOTIR-5896,
   * the choice design's TAKES 1: *Choosing this will:*). Absent, the shipped words.
   */
  confirmTitle?: ReactNode;
  /**
   * The confirm band's PROCEED label, when the kind words it itself (MOTIR-5896 —
   * *Yes, choose {label}*). Absent, the shipped *Yes, {verb}*.
   */
  confirmProceedLabel?: string;
  /**
   * Band 1's pill on an APPROVED gate, in the kind's own word (MOTIR-5896 — a choice
   * reads *Chosen*). Absent, the shipped *Approved*.
   */
  approvedStateLabel?: string;
  /**
   * The record's line on a CHANGES-REQUESTED gate, when the kind's revise loop is not
   * the agent's (MOTIR-5896, TAKES 2 — a choice's reporter revises the options).
   * Absent, the shipped *the agent will publish a new version*.
   */
  changesRequestedLine?: ReactNode;
  /** Who the gate is waiting on, for state `B`. */
  routedToLabel?: string | null;
  /**
   * State `E` only — whether the approved version's FILES are still there.
   *
   * ⚠️ SUPPLIED BY THE KIND, and nullable, because retention is a fact about
   * the SUBJECT rather than about the gate: a design's answer is
   * `design_evidence.pinned_at`, a merge's would be something else, and a kind
   * that retains nothing has no line to draw. `null` renders NOTHING — it is
   * *not asked* rather than *not kept*, and collapsing the two would put a
   * false reassurance on the one surface built to be checkable.
   */
  filesKept?: boolean | null;
  /** What a refusal's sentence may name — the card key and the host (MOTIR-5916). */
  refusalContext?: RefusalContext;
  /**
   * WHERE THE FRAME SITS — `inline` (the default: a card on a page or inside a
   * row) or `fill` (Subtask MOTIR-5224: the approval OVERLAY, which IS the
   * container).
   *
   * ⚠️ A LAYOUT INPUT, NOT A STATE. `fill` changes the frame's BOX and nothing
   * inside it (`design/workbench/design-notes.md` § 22 *THE FILL FORM*): the
   * card chrome comes off, the port takes the recipe the expanded arm already
   * uses — `min-h-0 flex-1 overflow-y-auto`, floor and ceiling dropped, because
   * the viewport is the ceiling — and Expand is not offered, because the overlay
   * already is the expanded form. Band 1, band 3, every state, every verb, the
   * confirm band and the refusal are byte-identical, and `inline` renders exactly
   * what every call site rendered before this input existed.
   *
   * `section` (Story MOTIR-5215 · Subtask MOTIR-5569) is the frame FLUSH INSIDE A
   * CONTAINER SOMEONE ELSE OWNS — the item page's Design result section card
   * (`design/work-items/design-notes.md` § *The item page HANDS THE DECISION OVER*,
   * *The kept states, flush in the section*). The section card is the only
   * container and its title the only label, so this form draws NO box of its own
   * (no border, no radius) and NO kind label in band 1; the bands' own `px-4`
   * comes off because the host card's padding supplies it, and band 1's
   * `border-b` / band 3's `border-t` become hairline dividers in the host's body.
   * Same rule as `fill`: states, verbs, the confirm band, the refusal and the
   * record are byte-identical, and Expand is still offered — expanded, the frame
   * takes its own chrome back, because it is no longer inside the host.
   *
   * `flush` (Story MOTIR-4909 · Subtask MOTIR-5484; `design/github/design-notes.md` §20
   * *No card inside a card*): the frame sits INSIDE a section card that is already the
   * container — the item page's Development block. The card chrome comes off, as in
   * `fill`; the port keeps its floor, its ceiling and Expand, as in `inline`, because a
   * page card is not the viewport. Nothing inside the box changes either.
   */
  layout?: 'inline' | 'fill' | 'flush' | 'section';
  /**
   * A KIND-SUPPLIED alert band, drawn between the port and band 3 (MOTIR-5484). It is
   * state `H` for a refusal the decide call did NOT return: the approve-and-merge press
   * commits the approval and then reports a pull request the host refused, so there is
   * no refused PHASE to draw, and the kind names that pull request itself. Absent,
   * nothing renders.
   */
  alert?: ReactNode;
  /**
   * More of the DECIDED record strip, after who and when — the kind's own facts about
   * what the decision covered (MOTIR-5484: the commit count, and what the merges still
   * wait on). Absent, the strip is unchanged.
   */
  recordDetail?: ReactNode;
  /**
   * A BAND AFTER THE DECIDED RECORD STRIP (Story MOTIR-6068 · Subtask MOTIR-6211; design
   * `approval-control--replan-door.mock.html` panel 0) — the kind's own question to the
   * reader who has just decided, drawn where its answer will sit. The refusal's *Re-plan
   * {key} with Motir AI?* is the one today. Only a decided gate draws it; absent, the
   * decided frame is unchanged.
   */
  recordBand?: ReactNode;
  /**
   * The SURFACE knows the gate's work item has no open delivery of its own (Story
   * MOTIR-6071 · MOTIR-6506) — a finished story, whose refusal stores no verdict. The
   * record's chip then reads *Sent back for a remedy* for a verdict-less refusal pressed in
   * Motir (`RefusalVerdictChip` decides which kinds that applies to). Omitted: a
   * verdict-less record shows no chip (a record from before the verdict existed).
   */
  refusalRemedy?: boolean;
  /**
   * State `G`'s dead-port words, when the KIND knows its own reason for the withdrawal
   * (MOTIR-5484 / MOTIR-5604: a push moved a pull request's head). Absent, the frame's
   * own words render.
   *
   * ⚠️ AND THE FRAME'S OWN WORDS NAME NO CAUSE — deliberately (Bug MOTIR-5586). FOUR
   * product writes mark a gate `superseded` and only ONE publishes anything: a republish
   * (MOTIR-4913) does; a withdrawal (MOTIR-5574), a hand pull-back out of review or to
   * Cancelled (MOTIR-5527) and linking an OPEN pull request (MOTIR-5534) do not. The ROW
   * cannot tell them apart — ADR §6b makes a supersede write `state` and nothing else —
   * so the default said "A newer design was published … The current version is above"
   * over a DEAD port, which was false three times in four and pointed nowhere even on the
   * fourth. The default is now the fact every writer leaves true, and THIS PROP is where
   * a cause belongs: a kind whose own surface knows why supplies its own two sentences.
   *
   * ⚠️ `keepsRecord` WITHDRAWS THE VERBS, NEVER THE RECORD (Bug MOTIR-5884; `design/github`
   * § 29, Panel 1). The dead port exists for a subject whose bytes are no longer current
   * (a superseded design), and it is still the default. A kind whose subject STAYS true
   * after the withdrawal — the pull requests, which merged, closed or moved but are all
   * still on the card — sets it: the sentence moves into a band ABOVE the port, and the
   * port keeps rendering, floorless and with no Expand, because nothing is being decided.
   */
  withdrawnPort?: { port: ReactNode; cite: ReactNode; keepsRecord?: boolean };
  /**
   * THE RECORD BAND'S LEAD, when a kind says who decided in its own words (MOTIR-5678 —
   * *Decision accepted by Ada L. · 19 Sep*). Replaces the decider and the date; the rest of
   * the band is unchanged. Absent, the band is the shipped one.
   */
  recordLead?: ReactNode;
  /**
   * Record the decision. Resolves to a refusal the frame draws IN PLACE, or
   * null on success — at which point the caller has already reconciled.
   */
  onDecide: (
    decision: GateDecision,
    optionId?: string,
    /** The verb's REQUIRED note (MOTIR-5960), trimmed — only a `note` verb passes one. */
    noteMd?: string,
    /** The verb's REQUIRED verdict (MOTIR-6427) — only a `verdict` verb passes one. */
    refusalVerdict?: ApprovalGateRefusalVerdictDTO,
  ) => Promise<GateRefusal | null>;
  /**
   * RE-READ what is being decided, in place — the STALE refusal's one control,
   * *Show the current version* (Story MOTIR-5232 · Subtask MOTIR-5235; design
   * `approval-control--stale-refusal.mock.html` Panel 4).
   *
   * ⚠️ THE HOST RE-RUNS THE READ IT OPENED WITH, so the current subject and a FRESH
   * stamp arrive together. A control that refetched the subject and kept the old
   * stamp would be refused for ever, and each half would look right alone. The frame
   * only draws the control; a host that supplies none draws the refusal without it.
   */
  onShowCurrentVersion?: () => void;
  /** The host has just re-read after *Show the current version*: focus the port on mount
   *  (design Panel 4). Never on an ordinary first render — that would steal focus. */
  focusPortOnMount?: boolean;
  /**
   * A verb pressed somewhere ELSE inside the frame — a pull-request row's *Queue again* or
   * *Retry merge* — which still takes this frame's ONE confirm (§ 28 panel 8a). The host
   * sets it; the band opens for it; proceeding runs the verb's own `perform`, and the
   * pending and refused phases that follow are the frame's, not a second set beside the
   * row. Cleared through {@link ApprovalGateControlProps.onRequestedVerbDone}.
   */
  requestedVerb?: GateVerb | null;
  /** The requested verb left the band — cancelled, or run. The host clears its request. */
  onRequestedVerbDone?: () => void;
  /**
   * A RECORD BAND OVER A QUESTION STILL BEING ASKED (Story MOTIR-5799 · Subtask
   * MOTIR-5806; § 28 panel 1's `af-record`). Ordinarily the strip belongs to a decided
   * gate — it is the audit's own row. A gate RE-ASKED after a merge did not land is the
   * one awaiting state with history behind it, and the reason it came back has to be on
   * screen while the reader decides, not only after. Rendered above the verbs, in the
   * same strip a decided gate uses, and only when the kind supplies one.
   */
  awaitingRecord?: ReactNode;
  /**
   * BAND 1's PILL, in the kind's own word, while the question AWAITS (Story MOTIR-1626 ·
   * MOTIR-6825; `design/github/design-notes.md` § 30) — the agent review's *Reviewing* (sky,
   * with a spinner) and *Could not run* (peach). Never over a decided or withdrawn gate, and
   * never while a press is recording. Absent, the shipped awaiting pills.
   */
  stateOverride?: { label: ReactNode; pill: PillProps } | null;
  /**
   * A KIND'S BAND BETWEEN BAND 1 AND THE PORT (MOTIR-6825; § 30 — § 29's slot): the agent
   * review's own band — who is reviewing, what it found, why it could not run, or who
   * continued without it. Absent, nothing renders there.
   */
  leadBand?: ReactNode;
  /**
   * Band 3's line for a reader who may NOT decide (state `B`), when the kind says who it
   * waits on in its own words (MOTIR-6825 — *Waiting on the review agent…*). Absent, the
   * shipped *Waiting on {name}*.
   */
  waitingLine?: ReactNode;
  /**
   * BAND 1's KIND GLYPH, before the kind label (Story MOTIR-7460 · MOTIR-7478; design
   * § 33.3 — the manual type's `hand`). Absent, band 1 is unchanged.
   */
  kindGlyph?: ReactNode;
  /**
   * A DOOR BESIDE THE VERBS (MOTIR-7478; § 33.3 — *Guide me through*): drawn in band 3's
   * verb group, before the verbs, exactly when the verbs are — never in state `B`, never
   * over a decided or withdrawn gate. Handed whether a press is recording, so the door
   * can dim for the length of the write. It decides nothing.
   */
  verbsLead?: (pending: boolean) => ReactNode;
}

type Phase =
  | { kind: 'awaiting' }
  | { kind: 'confirming'; verb: GateVerb }
  | { kind: 'pending' }
  | { kind: 'refused'; refusal: GateRefusal };

/** Band 1 — the same shape for every kind; only the words change. */
function FrameHeader({
  kindLabel,
  kindGlyph,
  subjectMeta,
  pillProps,
  stateLabel,
  sectioned,
}: {
  kindLabel: string;
  kindGlyph?: ReactNode;
  subjectMeta: ReactNode;
  pillProps: PillProps;
  stateLabel: ReactNode;
  /** The `section` form: the host's title names the kind, so band 1 does not. */
  sectioned: boolean;
}) {
  return (
    <div
      className={
        sectioned
          ? 'flex flex-wrap items-center gap-2'
          : 'flex flex-wrap items-center gap-2 border-b border-(--el-border-soft) px-4 py-3'
      }
    >
      {sectioned ? null : (kindGlyph ?? null)}
      {sectioned ? null : (
        <span className="text-sm font-semibold text-(--el-text)">{kindLabel}</span>
      )}
      <span className="text-xs text-(--el-text-secondary)">{subjectMeta}</span>
      <span className="ml-auto">
        <Pill {...pillProps}>{stateLabel}</Pill>
      </span>
    </div>
  );
}

/**
 * BAND 2's box — the port's FLOOR, its CEILING WITH ITS OWN SCROLL, and the
 * EXPAND affordance (MOTIR-5032).
 *
 * ⚠️ THE NUMBERS, AND WHY THE CEILING IS NOT THE MOCK'S. The asset's `.port`
 * rule is `min-height: 196px; max-height: 320px; overflow: auto`. The FLOOR is
 * taken from it verbatim. The CEILING is set just ABOVE the subject's own
 * shipped height instead, and that is a refinement the card asked for — "the
 * shipped `FRAME_HEIGHT` constant (32rem) and its recorded reasoning, which the
 * floor and ceiling refine rather than replace".
 *
 * The reason is that the asset's 320px is the BOARD's compressed representation
 * of a subject, not a measurement of one: the mock stacks nine frames into a
 * single 8602px export, so every port in it is drawn shorter than the real
 * thing. The real design port contains a 32rem (512px) sandboxed frame, whose
 * height `design-notes.md` § Design result panel argues for separately. A 320px
 * ceiling over a 512px subject means a NESTED scrollbar on the single-subject
 * case that is by far the most common — two scrollbars, neither of which is the
 * page's. A ceiling at 34rem clears the subject plus its header strip, so the
 * common case scrolls INSIDE the subject as it already did, and band 2's own
 * scroll engages exactly when the design says it should: when the port holds
 * MORE than one subject (a note AND a mock AND screenshots) and would otherwise
 * push the verbs off screen.
 *
 * ⚠️ HEIGHT IS THE ONE SHAPE AXIS WITH NO TOKEN TO ROUTE TO, AND THAT IS
 * RECORDED RATHER THAN ASSUMED. `tests/theme/shapeSwapLint.test.ts` guards a
 * surface's own RADIUS against the seven element-semantic roles and is
 * "deliberately silent" on padding and height, because "the token set has one
 * value per role while the code uses a scale against each … there is nothing
 * correct to route the other 140 to until MOTIR-2336 decides a density scale".
 * So the two heights below are arbitrary values behind NAMED constants — the
 * same shape as the `FRAME_HEIGHT` constant this refines — and the radius,
 * which IS guarded, flows through `--radius-card` on the frame container.
 */
const PORT_FLOOR = 'min-h-[12.25rem]';
const PORT_CEILING = 'max-h-[34rem]';

function PortBox({
  children,
  expanded,
  fill,
  sectioned,
  showExpand,
  onToggleExpanded,
  focusOnMount = false,
  floorless = false,
}: {
  children: ReactNode;
  /** Drop the floor, keep the ceiling (MOTIR-5884, § 29): a withdrawn frame that keeps its
   *  record holds no decision surface open, so there is nothing for the floor to reserve. */
  floorless?: boolean;
  /** Move focus to the port as it mounts — after *Show the current version*, so the
   *  reader starts again from the top of what changed (MOTIR-5235, Panel 4). */
  focusOnMount?: boolean;
  expanded: boolean;
  /** The `section` form — the floor, ceiling and scroll stay; the side padding
   *  is the host's, and a hairline above divides it from band 1. */
  sectioned: boolean;
  /** The frame's FILL form (MOTIR-5224) — the expanded recipe without its
   *  wrapper, and never an Expand/Collapse control, because there is nothing
   *  to expand into. */
  fill: boolean;
  /**
   * Whether to draw the EXPAND control. The floor, the ceiling and the scroll
   * are unconditional — they are the box — but the control is not.
   *
   * ⚠️ THE ASSET SCOPES IT, AND CHECKING THAT IS WHAT CORRECTED THIS CARD.
   * `approval-control.mock.html` draws `.portExpand` in exactly three frames —
   * panel 1 (the anatomy, state `A`) and panel `U`'s two frames — and all three
   * are AWAITING-YOURS with a rendered port. It is drawn in NONE of the eight
   * state frames `B`–`X`. The states panel's own note says each is "the SAME
   * frame with different props", so the mechanics are shared; the CONTROL is
   * simply not offered where there is no decision to make.
   *
   * That reading is corroborated from the other side: the frame's shipped suite
   * asserts `queryAllByRole('button')` is EMPTY in state `B` and in the decided
   * record, and this card is told not to edit it. Drawing Expand everywhere the
   * port is live broke both — the design and the test pointed the same way, and
   * the always-on version was the improvisation.
   *
   * A reader in `B` who wants the whole viewport is a real want and a DESIGN
   * AMENDMENT — its own card, not something to invent here.
   */
  showExpand: boolean;
  onToggleExpanded: () => void;
}) {
  const t = useTranslations('approvalGate.port');
  const portRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusOnMount) portRef.current?.focus();
    // Mount only: a re-read remounts the frame, and that is the one moment it moves focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={portRef}
      className={
        expanded || fill
          ? // ⚠️ `min-h-0 flex-1 overflow-y-auto` IS THE LOAD-BEARING PART, AND
            // IT IS THE RECIPE `Modal.Body` OWNS. In a flex column a bare child
            // gets `min-height: auto` and cannot shrink below its content, so
            // the overflow is CLIPPED by the panel and no scrollbar appears
            // anywhere — whatever sits at the bottom becomes UNREACHABLE.
            // `tests/theme/modalScrollContainerScan.ts` exists because two
            // instances shipped past their own suites that way (MOTIR-462,
            // MOTIR-2488), and in both the thing made unreachable was the
            // footer, "i.e. the primary action".
            //
            // That is precisely the failure this card must not ship: an
            // expanded port whose verbs are clipped off the bottom is a port
            // that took the decision off screen, which is what the whole frame
            // is arranged to prevent. The floor and ceiling are DROPPED here on
            // purpose — expanded, the viewport is the ceiling.
            'relative flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4'
          : sectioned
            ? `relative mt-3 ${floorless ? 'min-h-0' : PORT_FLOOR} ${PORT_CEILING} overflow-y-auto border-t border-(--el-border-soft) pt-3`
            : `relative ${floorless ? 'min-h-0' : PORT_FLOOR} ${PORT_CEILING} overflow-y-auto px-4 py-4`
      }
      // The port is a scroll container in both forms, so it must be focusable to
      // be scrollable from the keyboard alone (a scrollable region with no
      // focusable content is unreachable by keyboard otherwise).
      tabIndex={0}
      role="group"
      aria-label={t('label')}
    >
      {/* Absolutely positioned top-right, as the asset draws it (`.portExpand`).
          `sticky` rather than `absolute` so it stays in view while the port
          scrolls — the asset's own frames are short enough that the distinction
          never arises in the export, and a control that scrolls away from a
          subject tall enough to need it would be the affordance failing in
          exactly its own case. */}
      {/* `|| expanded` is not belt-and-braces: without it a port that FAILS
          while expanded would drop the only control that gets the reader back
          out, leaving them inside a viewport-sized panel with no way to close
          it. Whatever hides the affordance must never hide the way back. */}
      {!fill && (showExpand || expanded) ? (
        <div className="pointer-events-none sticky top-0 z-10 flex justify-end">
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={onToggleExpanded}
            aria-expanded={expanded}
            className="pointer-events-auto"
            leftIcon={
              expanded ? (
                <Minimize2 className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <Maximize2 className="h-3.5 w-3.5" aria-hidden />
              )
            }
          >
            {expanded ? t('collapse') : t('expand')}
          </Button>
        </div>
      ) : null}

      {children}
    </div>
  );
}

/**
 * Band 3's decided form — the provenance strip, carried from the shipped
 * acceptance panel so the two read as one gesture rather than two features.
 */
function RecordStrip({ children, sectioned }: { children: ReactNode; sectioned: boolean }) {
  return (
    <div
      className={
        sectioned
          ? 'mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-(--el-border-soft) pt-3 text-xs text-(--el-text-secondary)'
          : 'flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-(--el-border-soft) px-4 py-3 text-xs text-(--el-text-secondary)'
      }
    >
      {children}
    </div>
  );
}

/**
 * A refusal, drawn IN PLACE — the design's `H`. It sits between the port and the
 * verbs so the reader's eye lands on it without the subject leaving the screen,
 * and it always carries a NEXT ACTION: a refusal that only says no is a dead end
 * on the one surface built to explain itself.
 *
 * `--el-danger-on-surface` for the ink, never `--el-danger-text`, which is the
 * ink FOR a danger fill and renders white-on-white here (CLAUDE.md's danger rule).
 */
function RefusalAlert({
  refusal,
  sectioned,
  onShowCurrentVersion,
  context,
}: {
  refusal: GateRefusal;
  sectioned: boolean;
  onShowCurrentVersion?: () => void;
  context?: RefusalContext;
}) {
  const { headline, nextAction } = useRefusalCopy(refusal, context);
  const t = useTranslations('approvalGate.refusal.stale');

  // ⚠️ THE STALE REFUSAL IS THE ONLY ONE WITH A CONTROL (MOTIR-5235; design
  // `approval-control--stale-refusal.mock.html`). The other two mean *there is nothing
  // here for you*; this one means *still yours, and it moved*. Same band, same place —
  // told apart by the words, the glyph and the control, never by colour alone. The
  // glyph is secondary ink, not danger: nothing failed.
  if (refusal.tag === 'APPROVAL_GATE_STALE_SUBJECT') {
    return (
      <div
        role="alert"
        className={`${sectioned ? 'mt-3 ' : ''}flex flex-wrap items-start gap-x-3 gap-y-2 border-t border-(--el-border-soft) bg-(--el-tint-peach) px-4 py-3`}
      >
        {/* The sentence takes the full width below `sm`, so the control drops under it
            and the reason is read before the action (Panel 6). */}
        <div className="flex min-w-0 flex-1 basis-full gap-2.5 sm:basis-0">
          <RefreshCw className="mt-0.5 h-4 w-4 flex-none text-(--el-text-secondary)" aria-hidden />
          <p className="text-[13px] leading-snug text-(--el-text-strong)">
            <b>{headline}</b> <span className="text-(--el-text-secondary)">{nextAction}</span>
          </p>
        </div>
        {onShowCurrentVersion ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="shrink-0"
            leftIcon={<RefreshCw className="h-3.5 w-3.5" aria-hidden />}
            onClick={onShowCurrentVersion}
          >
            {t('control')}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div
      role="alert"
      className={`${sectioned ? 'mt-3 ' : ''}flex gap-2.5 border-t border-(--el-border-soft) bg-(--el-tint-peach) px-4 py-3`}
    >
      <AlertTriangle
        className="mt-0.5 h-4 w-4 flex-none text-(--el-danger-on-surface)"
        aria-hidden
      />
      <p className="text-[13px] leading-snug text-(--el-text-strong)">
        <b>{headline}</b> <span className="text-(--el-text-secondary)">{nextAction}</span>
      </p>
    </div>
  );
}

/**
 * A refusal's WORDS — its headline and its next action — in the frame's one vocabulary.
 * Exported for a kind that names a refusal inside its own alert (MOTIR-5484: a pull
 * request the approve-and-merge press could not merge), so the words stay these and a
 * second copy of them never exists.
 */
/** What a refusal's sentence can NAME beyond the refusal itself — the card key and the host
 *  (MOTIR-5916; § 30 Panels 5a and 5b). Absent, the shipped sentences are used unchanged. */
export interface RefusalContext {
  itemIdentifier: string;
  /** The host's display name, as *Open on {host}* renders it. */
  host: string;
}

export function useRefusalCopy(
  refusal: GateRefusal,
  context?: RefusalContext,
): { headline: string; nextAction: string } {
  const t = useTranslations('approvalGate.refusal');
  const locale = useLocale();
  // The withdrawal's CAUSE sentences live beside state `G`'s, not under `refusal`,
  // because the two surfaces must say the same thing about one event (MOTIR-5667).
  const tGate = useTranslations('approvalGate');

  // ⚠️ EXHAUSTIVE over `GateRefusal`, which is itself total over the service's
  // `ApprovalGateErrorTag` (`lib/approvalGates/refusals.ts`). A tag added there
  // and not handled here fails the type-check at the `never` below — which is
  // the point of the union: a new server-side failure becomes a compile error on
  // the screen that has to explain it, not a blank box in production.
  let headline: string;
  switch (refusal.tag) {
    case 'APPROVAL_GATE_ALREADY_DECIDED':
      headline = refusal.decidedByLabel
        ? t('alreadyDecided.byName', { name: refusal.decidedByLabel })
        : t('alreadyDecided.unattributed');
      break;
    case 'APPROVAL_GATE_SUPERSEDED':
      // The refusal says WHY, exactly as state `G`'s port does (MOTIR-5667). The
      // two must agree: a reader who presses a withdrawn question and then looks
      // at the frame is being told about one event, and two sentences that differ
      // read as two events.
      headline = tGate(`withdrawn.cause.${refusal.supersedeCause ?? 'unknown'}`);
      break;
    case 'APPROVAL_GATE_STALE_SUBJECT':
      // WHAT MOVED, one sentence per component and one for more than one (MOTIR-5235;
      // design `approval-control--stale-refusal.mock.html` Panel 3). The list joins the
      // component NOUNS in the one order the server reports them, with the locale's own
      // list format — so zh reads `a、b和c` rather than an English comma list.
      headline =
        refusal.moved.length === 1
          ? t(`stale.${STALE_KEY[refusal.moved[0]!]}`)
          : t('stale.several', {
              things: new Intl.ListFormat(locale, { type: 'conjunction' }).format(
                refusal.moved.map((component) => t(`stale.noun.${STALE_KEY[component]}`)),
              ),
            });
      break;
    case 'APPROVAL_GATE_NOT_AUTHORISED':
      headline = t('notAuthorised.title');
      break;
    case 'APPROVAL_GATE_NOT_FOUND':
      headline = t('notFound.title');
      break;
    case 'APPROVAL_GATE_KIND_UNREGISTERED':
      headline = t('kindUnregistered.title');
      break;
    case 'APPROVAL_GATE_DECISION_UNRESOLVABLE':
      headline = t('decisionUnresolvable.title');
      break;
    case 'APPROVAL_GATE_VERB_NOT_OFFERED':
      // A verdict sent where none is offered (MOTIR-6421) has its own words (MOTIR-6427).
      headline =
        refusal.reason === 'refusal_verdict_not_offered'
          ? t('verbNotOffered.verdict.title')
          : t('verbNotOffered.title');
      break;
    case 'APPROVAL_GATE_PRIMARY_PENDING':
      // Names WHICH question the merge follows (MOTIR-5785) — the next action differs.
      headline = t(`primaryPending.${refusal.primary}.title`);
      break;
    case 'APPROVAL_GATE_ALREADY_AWAITING':
      headline = t('alreadyAwaiting.title');
      break;
    case 'APPROVAL_GATE_DELIVERY_UNREADABLE':
      headline = t('deliveryUnreadable.title');
      break;
    case 'APPROVAL_GATE_DECIDED_IMMUTABLE':
      headline = t('decidedImmutable.title');
      break;
    case 'APPROVAL_GATE_SYNCED_ACTOR_MISMATCH':
      headline = t('syncedActorMismatch.title');
      break;
    // A card path met a card-less gate (MOTIR-6032) — a defect, never a refusal a
    // person can act on, so it reads as the unexpected refusal does.
    case 'APPROVAL_GATE_HAS_NO_CARD':
      headline = t('unexpected.title');
      break;
    case 'MERGE_CHECKS_NOT_GREEN':
      headline = t('mergeChecksNotGreen.title');
      break;
    case 'MERGE_CONFLICT':
      headline = t('mergeConflict.title');
      break;
    case 'MERGE_OUT_OF_DATE':
      headline = t('mergeOutOfDate.title');
      break;
    case 'MERGE_BRANCH_PROTECTED':
      // `refusal.reason` is the host's sentence: not part of this copy — the
      // Development frame quotes it beneath the line (MOTIR-6735; see the union).
      headline = t('mergeBranchProtected.title');
      break;
    case 'MERGE_ALREADY_MERGED':
      headline = t('mergeAlreadyMerged.title');
      break;
    case 'MERGE_ALREADY_REQUEUED':
      headline = t('mergeAlreadyRequeued.title');
      break;
    case 'MERGE_REQUEUE_NEEDS_APPROVAL':
      headline = t('mergeRequeueNeedsApproval.title');
      break;
    // A queue FAILURE's Queue again (MOTIR-6594 · MOTIR-6596; design § 31): named as a
    // failure, never as the conflict it is not.
    case 'MERGE_QUEUE_FAILED_NEEDS_FIX':
      headline = t('mergeQueueFailedNeedsFix.title');
      break;
    case 'MERGE_APP_PERMISSION_MISSING':
      headline = t('mergeAppPermissionMissing.title');
      break;
    case 'UNEXPECTED':
      headline = t('unexpected.title');
      break;
    // UNREACHABLE, and the compiler is what makes it so: `GateRefusal` is a
    // closed union, `REFUSAL_TAGS_ARE_TOTAL` proves it covers every server tag,
    // and `toGateRefusal` narrows anything it does not recognise to
    // `UNEXPECTED` rather than passing a tag through. The `never` binding below
    // is the third proof — it stops compiling the moment a member is added to
    // the union and not handled here.
    //
    // It is kept as a RUNTIME arm anyway, because the three proofs are all
    // compile-time and this file ships to a browser that may be running an
    // older bundle than the server it is talking to. What it must not do is
    // depress the coverage number and invite somebody to "cover" it with a
    // fixture that lies about the union being open.
    //
    // The invariant is pinned by `tests/approval-gate-coverage-floor.test.ts`
    // § 'toGateRefusal — the client reads the SERVER’s vocabulary', whose last
    // case drives seven unrecognised codes and asserts every one arrives as
    // `UNEXPECTED` — i.e. that this arm has no producer.
    /* v8 ignore next 4 */
    default: {
      const exhaustive: never = refusal;
      throw new Error(`Unhandled gate refusal: ${JSON.stringify(exhaustive)}`);
    }
  }

  const nextActionKey = refusal.tag === 'UNEXPECTED' ? 'unexpected' : refusalKeyOf(refusal.tag);
  // The one next action that names something: the permission the host asked for.
  // Unnamed when the host did not say, so the sentence never carries a blank.
  const nextAction =
    refusal.tag === 'MERGE_APP_PERMISSION_MISSING'
      ? refusal.permission
        ? t('mergeAppPermissionMissing.next', { permission: refusal.permission })
        : t('mergeAppPermissionMissing.nextUnnamed')
      : refusal.tag === 'APPROVAL_GATE_PRIMARY_PENDING'
        ? t(`primaryPending.${refusal.primary}.next`)
        : refusal.tag === 'APPROVAL_GATE_VERB_NOT_OFFERED' &&
            refusal.reason === 'refusal_verdict_not_offered'
          ? t('verbNotOffered.verdict.next')
          : t(`${nextActionKey}.next`);

  // ⚠️ A CONFLICT FOUND AT THE PRESS WROTE NOTHING, AND SAYS SO (MOTIR-5916; design/github
  // § 30 Panel 5a). The press-time host read refused before the decision write, so the
  // card did not move and § 28's *your approval was spent* would be false. Named members
  // and base come off the refusal; one shared base names it, several (or none recorded)
  // say *its base branch*.
  if (refusal.tag === 'MERGE_CONFLICT' && refusal.atPress && context) {
    const names = refusal.conflicts.map((c) => c.pullRequest.replace('#', ' · #'));
    const pr = new Intl.ListFormat(locale, { type: 'conjunction' }).format(names);
    const bases = new Set(refusal.conflicts.map((c) => c.baseRef ?? null));
    const base = bases.size === 1 ? [...bases][0]! : null;
    const values = { host: context.host, pr, key: context.itemIdentifier };
    const atPress =
      base !== null
        ? t('mergeConflict.atPress', { ...values, base })
        : t('mergeConflict.atPressNoBase', values);
    return { headline, nextAction: `${atPress} ${nextAction}` };
  }
  // ⚠️ A PRESS ON A TAB THAT HAD NOT HEARD THE WITHDRAWAL (Panel 5b): the shipped
  // SUPERSEDED refusal, headed by the shared cause sentence, says the tab was stale and
  // nothing moved — and a conflict's own next action follows, because that is what the
  // reader has to do next.
  if (
    refusal.tag === 'APPROVAL_GATE_SUPERSEDED' &&
    refusal.supersedeCause === 'conflict' &&
    context
  ) {
    return {
      headline,
      nextAction: `${t('superseded.staleTab', { key: context.itemIdentifier })} ${t('mergeConflict.next')}`,
    };
  }

  return { headline, nextAction };
}

/**
 * STATE `X` — the port failed, so there are no verbs (MOTIR-5032).
 *
 * Drawn as the asset's `X` panel draws it: the alert sits BETWEEN the port and
 * band 3, carrying the design's own sentence and a next action.
 *
 *   "⚠ You cannot approve what cannot be shown. Retry, or ask the agent to
 *    republish."
 *
 * ⚠️ THE NEXT ACTION IS TEXT HERE AND A BUTTON IN THE PORT — a DEVIATION from
 * the asset, recorded rather than silent. The asset draws a `Retry` button in
 * band 3's verb slot. The shipped design port ALREADY owns retry: `MockFrame`
 * holds the `attempt` counter that remounts the frame for a fresh signed URL,
 * and its own failure card renders that button one line above this alert. Two
 * Retry buttons is worse than the asset's one, and lifting the port's retry
 * into band 3 would mean the frame reaching into its own opaque port — the
 * thing the universal frame exists not to do — and would edit a suite this card
 * is told not to edit (`design-result-panel.test.ts` asserts that button). So
 * the ACT stays where the reader's eye already is, and this alert names it.
 *
 * Same ink rule as `RefusalAlert`: `--el-danger-on-surface`, never
 * `--el-danger-text`, which is the ink FOR a danger fill (CLAUDE.md).
 */
function PortFailedAlert({ sectioned }: { sectioned: boolean }) {
  const t = useTranslations('approvalGate.port.failed');

  return (
    <div
      role="alert"
      className={`${sectioned ? 'mt-3 ' : ''}flex gap-2.5 border-t border-(--el-border-soft) bg-(--el-tint-peach) px-4 py-3`}
    >
      <AlertTriangle
        className="mt-0.5 h-4 w-4 flex-none text-(--el-danger-on-surface)"
        aria-hidden
      />
      <p className="text-[13px] leading-snug text-(--el-text-strong)">
        <b>{t('title')}</b> <span className="text-(--el-text-secondary)">{t('next')}</span>
      </p>
    </div>
  );
}

/** A stale component → its copy key under `approvalGate.refusal.stale`. */
const STALE_KEY: Record<StampComponent, string> = {
  subject: 'subject',
  pull_requests: 'pullRequests',
  criteria: 'criteria',
};

/** Tag → its copy namespace. Kept beside the switch it mirrors. */
function refusalKeyOf(tag: Exclude<GateRefusal['tag'], 'UNEXPECTED'>): string {
  switch (tag) {
    case 'APPROVAL_GATE_ALREADY_DECIDED':
      return 'alreadyDecided';
    case 'APPROVAL_GATE_SUPERSEDED':
      return 'superseded';
    case 'APPROVAL_GATE_STALE_SUBJECT':
      return 'stale';
    case 'APPROVAL_GATE_NOT_AUTHORISED':
      return 'notAuthorised';
    case 'APPROVAL_GATE_NOT_FOUND':
      return 'notFound';
    case 'APPROVAL_GATE_KIND_UNREGISTERED':
      return 'kindUnregistered';
    case 'APPROVAL_GATE_DECISION_UNRESOLVABLE':
      return 'decisionUnresolvable';
    case 'APPROVAL_GATE_VERB_NOT_OFFERED':
      return 'verbNotOffered';
    case 'APPROVAL_GATE_PRIMARY_PENDING':
      return 'primaryPending';
    case 'APPROVAL_GATE_ALREADY_AWAITING':
      return 'alreadyAwaiting';
    case 'APPROVAL_GATE_DELIVERY_UNREADABLE':
      return 'deliveryUnreadable';
    case 'APPROVAL_GATE_DECIDED_IMMUTABLE':
      return 'decidedImmutable';
    case 'APPROVAL_GATE_SYNCED_ACTOR_MISMATCH':
      return 'syncedActorMismatch';
    case 'APPROVAL_GATE_HAS_NO_CARD':
      return 'unexpected';
    case 'MERGE_CHECKS_NOT_GREEN':
      return 'mergeChecksNotGreen';
    case 'MERGE_CONFLICT':
      return 'mergeConflict';
    case 'MERGE_OUT_OF_DATE':
      return 'mergeOutOfDate';
    case 'MERGE_BRANCH_PROTECTED':
      return 'mergeBranchProtected';
    case 'MERGE_ALREADY_MERGED':
      return 'mergeAlreadyMerged';
    case 'MERGE_ALREADY_REQUEUED':
      return 'mergeAlreadyRequeued';
    case 'MERGE_REQUEUE_NEEDS_APPROVAL':
      return 'mergeRequeueNeedsApproval';
    case 'MERGE_QUEUE_FAILED_NEEDS_FIX':
      return 'mergeQueueFailedNeedsFix';
    case 'MERGE_APP_PERMISSION_MISSING':
      return 'mergeAppPermissionMissing';
  }
}

export function ApprovalGateControl({
  gate,
  canDecide,
  kindLabel,
  subjectMeta,
  port,
  verbs,
  consequence,
  settingsDoor,
  confirmConsequences,
  confirmTitle,
  confirmProceedLabel,
  approvedStateLabel,
  changesRequestedLine,
  routedToLabel,
  filesKept = null,
  refusalContext,
  layout = 'inline',
  alert,
  recordDetail,
  recordBand,
  refusalRemedy = false,
  withdrawnPort,
  recordLead,
  onDecide,
  onShowCurrentVersion,
  focusPortOnMount = false,
  requestedVerb = null,
  onRequestedVerbDone,
  awaitingRecord = null,
  stateOverride = null,
  leadBand = null,
  waitingLine,
  kindGlyph,
  verbsLead,
}: ApprovalGateControlProps) {
  const t = useTranslations('approvalGate');
  const locale = useLocale();
  const tGithub = useTranslations('approvalGate.pullRequestApproval.github');
  const tPort = useTranslations('approvalGate.port');
  const [ownPhase, setPhase] = useState<Phase>({ kind: 'awaiting' });
  // A `note` verb's draft, and whether an empty press was just refused (MOTIR-5960).
  const [noteDraft, setNoteDraft] = useState('');
  const [noteRefused, setNoteRefused] = useState(false);
  // A `verdict` verb's choice, and whether a press without one was just refused (MOTIR-6427).
  // NO DEFAULT: the verdict is only worth recording if a person chose it (design § *Why no
  // default*).
  const [verdictDraft, setVerdictDraft] = useState<ApprovalGateRefusalVerdictDTO | null>(null);
  const [verdictRefused, setVerdictRefused] = useState(false);
  // ⚠️ A REQUEST FROM OUTSIDE THE VERB ROW OPENS THE SAME BAND (§ 28 panel 8a), and it is
  // DERIVED rather than written into state: a press is a render's fact here, and an effect
  // that set the phase would fight every phase the press itself writes (and is what
  // `react-hooks/set-state-in-effect` exists to stop). Once anything has been pressed the
  // frame's own phase wins, which is how pending and refused survive the request.
  const phase: Phase =
    requestedVerb && ownPhase.kind === 'awaiting'
      ? { kind: 'confirming', verb: requestedVerb }
      : ownPhase;
  const [expanded, setExpanded] = useState(false);
  const fill = layout === 'fill';
  const flush = layout === 'flush';
  // Expanded, the frame leaves its host for the viewport, so it takes its own
  // chrome back — `sectioned` holds only while it is still inside the section.
  const sectioned = layout === 'section' && !expanded;

  // MOTIR-5032 — the port's own report, and the gate on band 3 that follows from
  // it. `usePortRenderStatus` defaults to `'rendered'` when NOTHING reports, so
  // a static port and every state MOTIR-4792 shipped are untouched.
  const { reporter, status: portStatus } = usePortRenderStatus();

  // An OVERTURN is a decision too (MOTIR-5956) — a person refused the direction, with
  // a note — so it takes the verb-less, decided treatment, never the awaiting arm. So is
  // a DECLINE (Story MOTIR-6012 · MOTIR-6032; ADR `approval-gates.md` §11.4): a person
  // ended the plan a `plan_approval` gate asked about — terminal, and a fold that left
  // it out would draw live verbs over a question already answered.
  const decided =
    gate.state === 'approved' ||
    gate.state === 'changes_requested' ||
    gate.state === 'overturned' ||
    gate.state === 'declined';
  // ⚠️ `withdrawn` IS NOT A KIND OF `decided`, and the whole of state `G` is
  // that distinction. `superseded` is written by the PRODUCT when a newer
  // version is published (ADR §6b) — no actor, no authority, no note — so it
  // shares the verb-less treatment and shares nothing else: it names nobody,
  // and it must never be summarised as a decision anybody made.
  //
  // ⚠️ AND BEFORE THIS BRANCH EXISTED IT FELL THROUGH TO THE AWAITING ARM,
  // which drew LIVE VERBS over a question the product had already withdrawn.
  // The door refused them (`ApprovalGateSupersededError`), so the cost was a
  // reader pressing Approve on a design nobody could approve — but the frame
  // is the thing that is supposed to make that unpressable.
  const withdrawn = gate.state === 'superseded';

  // ⚠️ AND IT SAYS WHY (Story MOTIR-5652 · Subtask MOTIR-5667; `design-result.md`
  // AMENDMENT 6 Q5). This line rendered ONE sentence for every superseded gate,
  // whatever had happened to it. MOTIR-5586 made that sentence vaguer because
  // there was no way to make it true — the row recorded `state` and nothing else,
  // so *a newer design was published* was right about one of the six paths and
  // wrong about the other five. The row carries its cause now.
  //
  // ⚠️ `unknown` SAYS THE REASON WAS NOT RECORDED, and never picks a real cause.
  // A row that predates the column genuinely does not know, and inferring one
  // from its shape would manufacture evidence a reader is shown as fact. A null
  // cause on a superseded row is the same situation — a row written between the
  // migration and the writes — and reads the same way.
  //
  // A KIND THAT KNOWS BETTER STILL WINS: `withdrawnPort` is the merge gate's own
  // two sentences, which name the pull request, and this is the default beneath it.
  const withdrawnSentence = t(`withdrawn.cause.${gate.supersededCause ?? 'unknown'}`);
  const withdrawnKeepsRecord = withdrawn && withdrawnPort?.keepsRecord === true;

  // ⚠️ THE GATE LIVES HERE, IN THE FRAME'S OWN RENDER PATH — not in a consumer,
  // and not in the port. A consumer that passes a verb set and a failing port
  // gets no verbs, because the decision is taken from the port's report on this
  // line rather than from anything the call site remembered to do.
  //
  // `'rendering'` withholds the verbs too: you cannot approve what is not yet on
  // screen. Only `'failed'` is state `X` — only it owes the reader the alert and
  // a next action, which is why the two are separate rather than one boolean.
  const portShown = portStatus === 'rendered';
  const portFailed = portStatus === 'failed';

  async function run(verb: GateVerb) {
    // A verb that REQUIRES a note is refused in place while it has none (MOTIR-5960):
    // the band stays open with the field's error, and nothing reaches the door.
    const note = verb.note ? noteDraft.trim() : undefined;
    // …and one that requires a VERDICT, the same way (MOTIR-6427, design panel 2). ONE press
    // reports BOTH missing inputs, each under its own field, and focus goes to the first
    // invalid one in reading order: the reason, else the verdict group's first tile.
    const noteMissing = Boolean(verb.note) && !note;
    const verdictMissing = Boolean(verb.verdict) && verdictDraft === null;
    if (noteMissing || verdictMissing) {
      setNoteRefused(noteMissing);
      setVerdictRefused(verdictMissing);
      const target = noteMissing
        ? document.getElementById(`gate-note-${gate.id}`)
        : document.querySelector<HTMLInputElement>(
            `input[type="radio"][name="gate-verdict-${gate.id}"]`,
          );
      target?.focus();
      return;
    }
    setPhase({ kind: 'pending' });
    // A verb that carries its own act runs THAT (§ 28 panel 8a: a row's *Queue again* is
    // an approval, and it is this frame's confirm, pending and refusal that report it).
    // Only a verb that NAMES an option passes one, so every other kind's `onDecide`
    // is called exactly as it always was.
    // ⚠️ A SEND THAT THROWS — the action failed, the network died — is the union's own
    // `UNEXPECTED` arm (`lib/approvalGates/refusals.ts`), drawn IN PLACE like every other
    // refusal. Unhandled, the rejection left the frame at *Recording…* for ever, with no
    // way on (MOTIR-6077 found it by injecting a 5xx).
    let refusal: GateRefusal | null;
    try {
      refusal = verb.perform
        ? await verb.perform()
        : verb.verdict && note !== undefined && verdictDraft !== null
          ? await onDecide(verb.decision, undefined, note, verdictDraft)
          : note !== undefined
            ? await onDecide(verb.decision, undefined, note)
            : verb.optionId !== undefined
              ? await onDecide(verb.decision, verb.optionId)
              : await onDecide(verb.decision);
    } catch {
      refusal = { tag: 'UNEXPECTED' };
    }
    // A note verb the DOOR refused as not offered is the empty-reason refusal arriving
    // late (a stale client, a race — MOTIR-6075): it is answered IN PLACE, with the
    // field's own error, exactly as the empty press above is. The band stays open.
    // A MISSING VERDICT the door refused (`refusal_verdict_required`, MOTIR-6421) is the
    // verdict's own error, in place, for the same reason. `refusal_verdict_not_offered` is
    // NOT an input the reader can supply, so it is drawn as the frame's refusal, with its
    // own words (`useRefusalCopy`).
    if (
      refusal &&
      (verb.note || verb.verdict) &&
      refusal.tag === 'APPROVAL_GATE_VERB_NOT_OFFERED' &&
      refusal.reason !== 'refusal_verdict_not_offered'
    ) {
      setPhase({ kind: 'confirming', verb });
      if (refusal.reason === 'refusal_verdict_required' && verb.verdict) {
        setVerdictRefused(true);
      } else {
        setNoteRefused(true);
      }
      return;
    }
    // On success the CALLER has reconciled and re-rendered us with the decided
    // gate, so there is no success branch to draw here — which is what keeps
    // this component free of the write's own state.
    setPhase(refusal ? { kind: 'refused', refusal } : { kind: 'awaiting' });
    if (verb.perform) onRequestedVerbDone?.();
  }

  // The kind's own awaiting word (MOTIR-6825), only while nothing is being recorded.
  const overridden = stateOverride && !withdrawn && !decided && phase.kind !== 'pending';
  const stateLabel: ReactNode = overridden
    ? stateOverride.label
    : withdrawn
      ? t('state.withdrawn')
      : decided
        ? gate.state === 'approved'
          ? (approvedStateLabel ?? t('state.approved'))
          : gate.state === 'overturned'
            ? t('state.overturned')
            : gate.state === 'declined'
              ? t('state.declined')
              : t('state.changesRequested')
        : phase.kind === 'pending'
          ? t('state.recording')
          : canDecide
            ? t('state.awaitingYou')
            : t('state.awaiting');

  // The four chips a reader must tell apart at a glance. `tone="awaiting"` is
  // the frame's own (added to the primitive by this card); the other three reuse
  // the shipped severities the design's tints already name.
  const pillProps: PillProps = overridden
    ? stateOverride.pill
    : withdrawn
      ? // ⚠️ DELIBERATELY COLOURLESS — the design's `pill-gone`, a quiet muted
        // fill with slate ink. `tone="archived"` already IS that recipe (an
        // inactive state, not a severity), so this reuses it rather than minting
        // a fifth tone for the same two tokens. Any hue here would read as a
        // judgement, and nobody made one.
        { tone: 'archived' }
      : decided
        ? gate.state === 'approved'
          ? { severity: 'success' }
          : { severity: 'warning' }
        : phase.kind === 'pending'
          ? { severity: 'info' }
          : { tone: 'awaiting' };

  // Band 3's left-hand sentence — what approving will DO, who it waits on, or
  // (state `X`) that the verbs return once the subject renders. Hoisted so the
  // settings door can sit UNDER it without the no-door row changing by a byte.
  const consequenceLine = (
    <span className="text-[13px] text-(--el-text-secondary)">
      {!canDecide
        ? (waitingLine ?? t('waitingOn', { name: routedToLabel ?? t('theAssignee') }))
        : portShown
          ? consequence
          : // The asset's `X` footer, verbatim in intent: "The verbs
            // return when the subject renders." It replaces the
            // consequence sentence because there is no consequence to
            // state — nothing is pressable.
            tPort('verbsReturn')}
    </span>
  );

  const frame = (
    <div
      className={
        fill
          ? // THE FILL FORM (MOTIR-5224): the overlay is the container, so no
            // radius, no border and no fixed wrapper — a flex column that takes
            // the height it is given.
            'flex min-h-0 flex-1 flex-col overflow-hidden'
          : expanded
            ? // The expanded form is dialog-SHAPED and is deliberately not a
              // `Modal`: it holds no focus trap and steals nothing, because the
              // frame is still the page's own content — just given the viewport.
              // The recipe (scrim token, panel token, the `max-h`/flex column)
              // mirrors `Modal` so the two read as one language.
              'fixed top-1/2 left-1/2 z-50 flex max-h-[90vh] w-[90vw] max-w-[72rem] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-(--radius-modal) border border-(--el-border) bg-(--el-page-bg)'
            : flush
              ? // THE FLUSH FORM (MOTIR-5484): the host card is the container, so no
                // radius and no border of its own — the bands run edge to edge in it.
                'flex flex-col overflow-hidden'
              : sectioned
                ? // THE SECTION FORM (MOTIR-5569): the host card is the container,
                  // so the frame draws no box of its own at all.
                  'min-w-0'
                : 'overflow-hidden rounded-(--radius-card) border border-(--el-border)'
      }
      onKeyDown={(event) => {
        if (expanded && event.key === 'Escape') setExpanded(false);
      }}
    >
      <FrameHeader
        kindLabel={kindLabel}
        kindGlyph={kindGlyph}
        subjectMeta={subjectMeta}
        pillProps={pillProps}
        stateLabel={stateLabel}
        sectioned={sectioned}
      />

      {/* BAND 2 — THE PORT: one BOX (MOTIR-5032's floor, ceiling-with-own-scroll
          and Expand) around one of TWO contents (MOTIR-5033's dead port for
          `G`, otherwise the subject).

          ⚠️ IN `G` THE PORT IS DEAD AND THE FRAME DECIDES THAT, NOT THE CALLER.
          A withdrawn question is about bytes that are no longer current and
          were never approved, so they are not pinned and are reclaimed —
          rendering them would show a reader a version the product has moved
          past, in the one state whose entire message is that it HAS moved past
          it. Gating it here rather than in each consumer is the same discipline
          the verb set gets: a rule a call site must remember is a convention,
          and the first consumer to forget it draws the withdrawn subject as
          though it were live.

          ⚠️ THE BOX WRAPS BOTH, AND THE PROVIDER IS UNCONDITIONAL. The dead
          port keeps band 2's geometry, so a withdrawn frame is the same shape
          as every other rather than a short panel that reflows the card. And
          the provider stays outside the branch deliberately: making it
          conditional would remount the subject whenever the state changed,
          re-probing the design port and spending a fresh signed URL. Nothing
          inside the dead port reports, which is exactly right — there is no
          subject there to have rendered or failed. */}
      {/* STATE `G` THAT KEEPS ITS RECORD (Bug MOTIR-5884; § 29, Panel 1): the withdrawn
          sentence is a BAND between band 1 and the port, so the reader learns why there is
          no button before reading the rows it would have merged. § 20's withdrawn tokens,
          unchanged — only the shape moved, from a centred box to a left-aligned band. */}
      {withdrawnKeepsRecord && withdrawnPort ? (
        <div
          role="status"
          className="flex flex-col gap-1 border-b border-(--el-border) bg-(--el-muted) px-3.5 py-2.5 text-[13px] text-(--el-text-secondary)"
          data-withdrawn-band
        >
          <span>{withdrawnPort.port}</span>
          <span className="text-xs">{withdrawnPort.cite}</span>
        </div>
      ) : null}
      {/* THE KIND'S LEAD BAND (MOTIR-6825; § 30): the agent review, in § 29's slot. */}
      {leadBand}
      <PortRenderStatusProvider reporter={reporter}>
        <PortBox
          expanded={expanded}
          fill={fill}
          sectioned={sectioned}
          // Drawn where the asset draws it: a decision that is YOURS to make,
          // not yet made, over a subject that actually rendered — and never
          // over `G`'s port, dead or kept: there is no decision to expand into.
          showExpand={!fill && canDecide && !decided && !withdrawn && portShown}
          onToggleExpanded={() => setExpanded((v) => !v)}
          focusOnMount={focusPortOnMount}
          floorless={withdrawnKeepsRecord}
        >
          {withdrawn && !withdrawnKeepsRecord ? (
            <div className="flex flex-col items-center justify-center gap-1 bg-(--el-muted) px-4 py-10 text-center">
              <p className="text-[13px] text-(--el-text-secondary)">
                {withdrawnPort ? withdrawnPort.port : withdrawnSentence}
              </p>
              <p className="text-xs text-(--el-text-secondary)">
                {withdrawnPort ? withdrawnPort.cite : t('withdrawn.portCite')}
              </p>
            </div>
          ) : (
            port
          )}
        </PortBox>
      </PortRenderStatusProvider>

      {/* STATE `X` — between the port and the verbs, as the asset draws it.
          ⚠️ SUPPRESSED UNDER `G`: a subject the frame deliberately did not draw
          is not a subject that failed to draw. Nothing reports from inside the
          dead port, so this is belt-and-braces today — and it is the kind of
          belt that stops a later `G` port which DOES render something from
          accidentally inheriting `X`'s alert.
          ⚠️ AND SUPPRESSED UNDER `E` / `F` (Bug MOTIR-5551). The alert's whole
          meaning is *the verbs are withheld*, and a decided frame has none to
          withhold. This one is NOT belt-and-braces: a decided version's bytes
          are routinely gone (only an approval pins, §6c), the panel then
          reports `failed` over its own empty state, and the alert told a
          reader they could not approve what had already been decided. */}
      {portFailed && !decided && !withdrawn ? <PortFailedAlert sectioned={sectioned} /> : null}

      {alert ?? null}

      {phase.kind === 'refused' ? (
        <RefusalAlert
          refusal={phase.refusal}
          sectioned={sectioned}
          onShowCurrentVersion={onShowCurrentVersion}
          context={refusalContext}
        />
      ) : null}

      {/* BAND 3 — withdrawn: no decision at all. Decided: the record. Awaiting:
          the verbs, or who it waits on. */}
      {withdrawn ? (
        // ⚠️ NO ACTOR AND NO DECISION TIME. `decidedById` / `decidedAt` /
        // `noteMd` are all null on a `superseded` row by construction, so this
        // strip could not name a person even if it tried — but rendering the
        // ordinary record strip with its fallbacks would print "No longer
        // attributable", which says *somebody decided and we lost who*. The
        // opposite is true and the audit turns on the difference. The time
        // shown is when the question was WITHDRAWN (the row's own clock), said
        // in those words: it is not a decision time, and there is no decision.
        <RecordStrip sectioned={sectioned}>
          <span>{t('withdrawn.record')}</span>
          <span>
            {t('withdrawn.at', { when: new Date(gate.updatedAt).toLocaleString(locale) })}
          </span>
        </RecordStrip>
      ) : decided ? (
        <>
          <RecordStrip sectioned={sectioned}>
            {/* WHO decided — and, for a decision synced out of GitHub, that it happened
              THERE (Story MOTIR-4910 · MOTIR-5599; design § 23, Panels G4–G6). The
              GitHub arm is a different SENTENCE rather than a suffix, because the band
              is read as prose and *"Ada Lovelace (@ada-l) · on GitHub"* reads as a
              handle rather than as an account of what happened. */}
            {recordLead ? (
              <span>{recordLead}</span>
            ) : gate.decisionSource === 'system' ? (
              // A SYSTEM approval (MOTIR-702; `design-result--system-approved.mock.html`):
              // WHAT happened in the slot a name takes, then WHY — a link to the switch
              // for a reader who may open it, plain text for everyone else. Never the
              // null-label fallback below, which would say a name was lost (§6a).
              <>
                <span className="font-medium text-(--el-text)">{t('record.systemApproved')}</span>
                {gate.systemApprovalSettingsHref ? (
                  <Link
                    className="text-(--el-link) underline underline-offset-2"
                    href={gate.systemApprovalSettingsHref}
                  >
                    {t('record.systemApprovedWhy')}
                  </Link>
                ) : (
                  <span>{t('record.systemApprovedWhy')}</span>
                )}
              </>
            ) : (
              <span className="font-medium text-(--el-text)">
                {gate.decisionSource === 'github' && gate.decidedByLabel
                  ? tGithub(
                      gate.state === 'changes_requested'
                        ? 'record.changesRequested'
                        : 'record.approved',
                      { name: gate.decidedByLabel },
                    )
                  : (gate.decidedByLabel ?? t('record.unattributed'))}
              </span>
            )}
            {/* ⚠️ A LINE, NEVER A DIMMED NAME (§6b — an unattributable presence must not
              read as nobody). The pair (source `github`, `decidedById` null) is the
              whole of what says *not a Motir member*, and saying it in words is what
              stops a reader taking the bare handle for a missing name. */}
            {gate.decisionSource === 'github' && gate.decidedById === null ? (
              <span>{tGithub('record.notMember')}</span>
            ) : null}
            {gate.decidedAt && !recordLead ? (
              <span>{new Date(gate.decidedAt).toLocaleString(locale)}</span>
            ) : null}
            {/* ⚠️ THE VERSION, FROM THE AUDIT COLUMN — never re-derived from
              whatever design is current now. `subjectVersion` is the immutable
              answer to WHAT was approved (ADR §6a), and it is the reason this
              row is evidence rather than a name with a date beside it. */}
            {gate.subjectVersion ? (
              <span className="font-mono text-(--el-text-identifier)">
                {t('record.version', { version: gate.subjectVersion.slice(0, 8) })}
              </span>
            ) : null}
            {gate.state === 'changes_requested' ? (
              <span>{changesRequestedLine ?? t('record.willRepublish')}</span>
            ) : null}
            {/* A DESIGN SENT BACK IS A VERDICT (MOTIR-6427; design panel 4): the chip sits
              after the kind's line and BEFORE the quote, which starts the next line. */}
            {gate.state === 'changes_requested' ? (
              <RefusalVerdictChip
                verdict={gate.refusalVerdict}
                kind={gate.kind}
                decisionSource={gate.decisionSource}
                remedy={refusalRemedy}
              />
            ) : null}
            {/* A REFUSAL SAYS WHY (MOTIR-6075; design Panel 4) — quoted as the overturned
              record quotes its note, after who / when / version and the kind's line. */}
            {gate.state === 'changes_requested' ? (
              <RefusalReasonQuote noteMd={gate.noteMd} decisionSource={gate.decisionSource} />
            ) : null}
            {/* THE AUTOMATIC RE-RUN LINE (MOTIR-702) — after the quote, its own row; absent
              when this refusal attempted nothing. */}
            {gate.state === 'changes_requested' ? <AutoRerunLine rerun={gate.autoRerun} /> : null}
            {/* ⚠️ ONLY ON AN APPROVAL, AND ONLY WHEN THE KIND ANSWERED. §6c pins
              for approvals alone, so the line has no meaning on a rejection —
              and `null` means the kind was not asked, which renders nothing
              rather than a guess. The NOT-kept arm is drawn as plainly as the
              kept one: an unconditional reassurance is the failure this line
              exists to prevent. */}
            {gate.state === 'approved' && filesKept !== null ? (
              filesKept ? (
                <span className="inline-flex items-center rounded-(--radius-badge) bg-(--el-tint-mint) px-(--spacing-chip-x-8) py-(--spacing-chip-y) font-semibold text-(--el-text-strong)">
                  {t('record.filesKept')}
                </span>
              ) : (
                <span className="inline-flex items-center rounded-(--radius-badge) bg-(--el-muted) px-(--spacing-chip-x-8) py-(--spacing-chip-y) font-semibold text-(--el-text-secondary)">
                  {t('record.filesNotKept')}
                </span>
              )
            ) : null}
            {recordDetail ?? null}
          </RecordStrip>
          {/* The kind's question to the reader who just decided (MOTIR-6211, panel 0). */}
          {recordBand ?? null}
        </>
      ) : (
        <>
          {/* The re-asked gate's history and reason, above the verbs (§ 28 panel 1). */}
          {awaitingRecord ? (
            <RecordStrip sectioned={sectioned}>{awaitingRecord}</RecordStrip>
          ) : null}
          {phase.kind === 'confirming' ? (
            // ⚠️ AN INLINE BAND OVER THE VERBS, NEVER A MODAL — a modal would take
            // the port off screen at exactly the moment the reader wants one last
            // look, which is the thing the whole frame is arranged to prevent.
            <div
              className={`${sectioned ? 'mt-3 ' : ''}border-t border-(--el-border-soft) bg-(--el-surface-soft) px-4 py-3`}
            >
              <p className="text-[13px] font-semibold text-(--el-text)">
                {phase.verb.confirm?.title ?? confirmTitle ?? t('confirm.title')}
              </p>
              <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-[13px] text-(--el-text-secondary)">
                {(phase.verb.confirm?.consequences ?? confirmConsequences).map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
              {phase.verb.note ? (
                // THE REQUIRED NOTE (MOTIR-5960, design Panel 2): the shipped FormField +
                // Textarea, and the FormField error treatment on an empty press.
                <FormField
                  className="mt-3"
                  htmlFor={`gate-note-${gate.id}`}
                  label={phase.verb.note.label}
                  helperText={phase.verb.note.helper}
                  error={noteRefused ? phase.verb.note.required : undefined}
                  errorVariant="box"
                >
                  <Textarea
                    id={`gate-note-${gate.id}`}
                    value={noteDraft}
                    onChange={(event) => {
                      setNoteDraft(event.target.value);
                      if (noteRefused) setNoteRefused(false);
                    }}
                    rows={3}
                    aria-invalid={noteRefused || undefined}
                  />
                </FormField>
              ) : null}
              {phase.verb.verdict ? (
                // THE VERDICT (MOTIR-6427, design panels 1–2) — in the slot MOTIR-6073
                // reserved: below the reason, above the buttons.
                <RefusalVerdictGroup
                  field={phase.verb.verdict}
                  groupId={`gate-verdict-${gate.id}`}
                  value={verdictDraft}
                  refused={verdictRefused}
                  onChange={(value) => {
                    setVerdictDraft(value);
                    if (verdictRefused) setVerdictRefused(false);
                  }}
                />
              ) : phase.verb.absentVerdict ? (
                // WHY NO VERDICT (MOTIR-6506, choice 1): the one line where the tiles would be.
                <p
                  className="mt-3 text-[13px] leading-snug text-(--el-text-secondary)"
                  data-testid="refusal-no-rerun"
                >
                  {phase.verb.absentVerdict}
                </p>
              ) : null}
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setPhase({ kind: 'awaiting' });
                    if (phase.verb.perform) onRequestedVerbDone?.();
                  }}
                  type="button"
                >
                  {t('confirm.cancel')}
                </Button>
                <Button variant="primary" size="sm" onClick={() => run(phase.verb)} type="button">
                  {phase.verb.confirm?.proceedLabel ??
                    confirmProceedLabel ??
                    t('confirm.proceed', { verb: phase.verb.label })}
                </Button>
              </div>
            </div>
          ) : (
            <div
              className={
                sectioned
                  ? 'mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-(--el-border-soft) pt-3'
                  : 'flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-(--el-border-soft) px-4 py-3'
              }
            >
              {settingsDoor ? (
                // THE SETTINGS DOOR (MOTIR-5513, panel `S`): band 3's LEFT column,
                // UNDER the consequence line. A column only when a kind supplies one,
                // so a kind that supplies none renders this row exactly as before.
                <span className="flex min-w-0 flex-col gap-1">
                  {consequenceLine}
                  <Link
                    href={settingsDoor.href}
                    className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-(--el-link) hover:text-(--el-link-pressed)"
                  >
                    {settingsDoor.label}
                  </Link>
                </span>
              ) : (
                consequenceLine
              )}
              {/* ⚠️ STATE `B` RENDERS NO VERBS AT ALL — not disabled ones. A reader
              who may not decide can still SEE what is being decided; a greyed
              button would tell them the control is theirs and broken.
              ⚠️ AND STATE `X` (MOTIR-5032) IS THE SAME ABSENCE FOR THE SAME
              REASON, one axis over: `portShown` is false, so the verbs are not
              rendered at all. A `disabled` button here would say the decision is
              yours and the control is broken, when the truth is that the SUBJECT
              is missing — "you cannot approve what cannot be shown". */}
              {canDecide && portShown ? (
                <span className="ml-auto flex flex-wrap gap-2">
                  {verbsLead ? verbsLead(phase.kind === 'pending') : null}
                  {verbs.map((verb) => (
                    <Button
                      // Keyed by the verb's IDENTITY — a decision and, for a choice,
                      // the option it names (the choice design's TAKES 3).
                      key={verb.id ?? `${verb.decision}:${verb.optionId ?? ''}`}
                      variant={verb.variant}
                      size="sm"
                      type="button"
                      // ⚠️ DISABLED UNDER ANY REFUSAL, not only while pending (design
                      // `approval-control--stale-refusal.mock.html`, Panel 1). A second press
                      // would be refused again — for a stale one, with the same stamp — so the
                      // refusal's own next action is the only live one. A re-read remounts the
                      // frame, which is what gives the verbs back.
                      disabled={
                        verb.disabled === true ||
                        phase.kind === 'pending' ||
                        // ⚠️ EXCEPT `UNEXPECTED` — a send that failed in transit is RETRIED,
                        // and its own copy says so ("check your connection and try again").
                        // Every other refusal is about the question and would be refused again.
                        (phase.kind === 'refused' && phase.refusal.tag !== 'UNEXPECTED')
                      }
                      aria-disabled={verb.disabled === true ? true : undefined}
                      // A verb with its own pending words draws the shipped loading
                      // button while its press records (MOTIR-7478, Panel 3).
                      loading={phase.kind === 'pending' && verb.pendingLabel !== undefined}
                      onClick={() =>
                        verb.confirms ? setPhase({ kind: 'confirming', verb }) : void run(verb)
                      }
                    >
                      {phase.kind === 'pending' && verb.pendingLabel !== undefined
                        ? verb.pendingLabel
                        : verb.label}
                    </Button>
                  ))}
                </span>
              ) : null}
            </div>
          )}
        </>
      )}
    </div>
  );

  // ⚠️ BOTH FORMS RENDER THE SAME TWO CHILDREN IN THE SAME ORDER, and that is
  // load-bearing rather than tidy. React reconciles by position, so wrapping the
  // frame in an extra element only when expanded would UNMOUNT the port on every
  // toggle — re-running the design port's probe, spending a fresh signed URL and
  // throwing away the reader's scroll position, each time they expand. The scrim
  // is therefore always present and merely hidden.
  return (
    <>
      <div
        aria-hidden
        className={expanded ? 'fixed inset-0 z-40 bg-(--el-overlay-scrim)' : 'hidden'}
        onClick={() => setExpanded(false)}
      />
      {frame}
    </>
  );
}
