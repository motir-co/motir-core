'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  ArrowRight,
  Bot,
  CornerLeftUp,
  History,
  ListChecks,
  ListTree,
  MessagesSquare,
  RotateCw,
  Sparkles,
} from 'lucide-react';

import { Pill } from '@/components/ui/Pill';
import { PlanDestinationTag } from '@/components/planning/PlanDestinationTag';
import { PlanOverlayDoor } from '@/components/planning/PlanOverlayDoor';
import { NotPlannedYetList } from '@/components/planning/NotPlannedYetList';
import { cn } from '@/lib/utils/cn';
import {
  isPlainPrimaryClick,
  useOpenPlanningWorkspace,
} from '@/lib/hooks/useOpenPlanningWorkspace';
import { shallowPush } from '@/lib/navigation/shallowUrl';
import { planRowDestination, type PlanRowDestination } from '@/lib/planning/planDestination';
import type { PlanningLaunchContext } from '@/lib/planning/launcher';
import type { PlanSessionOriginDto } from '@/lib/dto/planChange';
import type {
  PlanSessionSeedDto,
  PlanSessionSeedGateKindDto,
  PlanSessionStateDto,
} from '@/lib/dto/planSessions';

import {
  resumeReasonKeyOf,
  stopPhraseKeyOf,
} from '@/app/(authed)/workbench/_components/planningSessionWords';
import type { SessionRowView } from './types';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';

// One Plans-list row — ONE PLANNING CONVERSATION (MOTIR-6025), built to
// `design/ai-planning/design-notes.md` Part XIX §19.2 and
// `plans-sessions--list.mock.html`. It is the retired `PlanRow` with the four
// changes §19.2 names, and nothing else:
//
//   1. The square carries the session's ORIGIN; the plan's state has its own
//      chip on the right, so a status tint in the square would say it twice.
//   2. The row is NOT one `<Link>`. It has two destinations — the conversation
//      and the plan — and a link inside a link is invalid. The TITLE is the
//      row's link, stretched over the row by `after:absolute after:inset-0`;
//      the chip is a second link lifted above it with `relative z-10`.
//   3. The title's `href` is the OVERLAY address — this page's own URL plus
//      `planSession=<id>` — from the shipped `useOpenPlanningWorkspace`, so the
//      conversation opens over `/plans` and Close returns to the same filtered,
//      scrolled list.
//   4. Below `sm` the row wraps and the chip takes its own line.
//
// ⚠️ AND SINCE MOTIR-6045 THE ROW HAS TWO POSSIBLE DOORS, decided by
// `planRowDestination` (Story MOTIR-6043, design Part XXI). An UNDECIDED plan's
// row opens the conversation, as it always did; a DECIDED one opens the plan's
// own page, because there is nothing left to decide and the record is what a
// person came for. The To-approve row calls the SAME function, so the two lists
// cannot drift apart. Two consequences here:
//
//   · The row carries a DESTINATION TAG in its meta line, so a reader knows
//     which of the two it will do before pressing (§ 21.2).
//   · The state chip is a LINK, with its `arrow-right`, exactly when the row's
//     own door goes somewhere else (§ 21.5). On a decided row the two would land
//     in the same place, so the chip becomes a plain `Pill` — one control, one
//     tab stop, no arrow that changes nothing.
//
// ⚠️ THE NO-CONVERSATION STATE CANNOT OCCUR HERE, and that is structural rather
// than lucky (§ 21.3): a row IS a session and its `latestPlan` is a plan ON that
// session, so the session id below is never null. The rule stays TOTAL because
// the To-approve row — whose subject is a PLAN — does reach it.
//
// ⚠️ A `No plan yet` row is a conversation, never an invitation to start one
// (§19.3a): it opens exactly like every other row, and carries no chip link and
// no *Plan with AI* control.

const ORIGIN_ICON: Record<PlanSessionOriginDto, typeof MessagesSquare> = {
  conversation: MessagesSquare,
  mcp: Bot,
  generation: Sparkles,
  expand: ListTree,
  cadence: RotateCw,
  legacy: History,
  // A guide conversation (MOTIR-7464) is left out of the Plans room by the list
  // read, so this row never renders one; the entry keeps the map TOTAL.
  guide: ListChecks,
};

/** The chip, one `Pill` tone per plan state — the tones the Plans page has always
 *  given these statuses (§19.3). TOTAL over the vocabulary, `none` included. */
function StateChip({ state, label }: { state: PlanSessionStateDto; label: React.ReactNode }) {
  switch (state) {
    case 'none':
      return <Pill tone="neutral">{label}</Pill>;
    case 'generating':
      return <Pill severity="info">{label}</Pill>;
    case 'waiting':
      // Waiting to resume (Story MOTIR-7905 · MOTIR-7921): the To resume state pill's yellow
      // — distinct from Generating's sky and Closed's peach, and no danger ink.
      return <Pill tone="awaiting">{label}</Pill>;
    case 'planned':
      return <Pill status="planned">{label}</Pill>;
    case 'approving':
      // Being approved (Bug MOTIR-9006) — work in progress, so Generating's sky; it no
      // longer waits for a decision, so it is not *Waiting for approval*'s lavender.
      return <Pill severity="info">{label}</Pill>;
    case 'stale':
      return <Pill severity="danger">{label}</Pill>;
    case 'approved':
      return <Pill severity="success">{label}</Pill>;
    case 'declined':
      return <Pill tone="archived">{label}</Pill>;
    case 'closed':
      // Motir ended the session (AMENDMENT 23 §1; MOTIR-7634). Peach — the one
      // tint left whose meaning ("needs a second look") fits "Motir stopped this,
      // not a person", and never the archived fill Declined wears. The REASON is
      // in the end line's words, never in the hue.
      return <Pill severity="warning">{label}</Pill>;
  }
}

/** THE STOP LINE (Story MOTIR-7905 · MOTIR-7921 / MOTIR-7944): in the place *active {when}* takes,
 *  the failed attempt in the same step and reason words as the To resume entry — *Stopped at
 *  {where} · because {why} · {time}* for a failed walk, *Your last change could not be made ·
 *  {time}* for a failure beside a plan that waits. Keyed on the stable codes, never raw. */
function FailureLine({ failure }: { failure: NonNullable<SessionRowView['failure']> }) {
  const t = useTranslations('aiPlanning.sessions');
  const tp = useTranslations('workbench.planningSession');
  const text =
    failure.kind === 'change'
      ? t('stopChange', { time: failure.timeLabel })
      : t('stop', {
          where: tp(`stop.${stopPhraseKeyOf(failure)}`, { title: failure.stopTitle ?? '' }),
          why: tp(`reason.${resumeReasonKeyOf(failure.reason)}`),
          time: failure.timeLabel,
        });
  return (
    <span data-testid="plans-stop-line" title={failure.fullLabel}>
      {text}
    </span>
  );
}

/** Where the conversation opens: anchored at its first key, or project-wide. */
function launchContextFor(view: SessionRowView): PlanningLaunchContext {
  const [first] = view.targetKeys;
  return first
    ? { kind: 'work-item', itemKey: first, sessionId: view.id }
    : { kind: 'project', sessionId: view.id };
}

/** Meta 1 — the ANCHOR: the first key, `+N` for the rest, the full set in `title`. */
function Anchor({ keys }: { keys: string[] }) {
  const t = useTranslations('aiPlanning.sessions');
  const [first] = keys;
  if (!first) return <span>{t('anchorProject')}</span>;
  return (
    <span className="font-mono" title={keys.join(', ')}>
      {keys.length > 1 ? t('anchorMore', { first, count: keys.length - 1 }) : first}
    </span>
  );
}

/** Meta 3 — WHO started it, and for every origin but a conversation, which door
 *  opened it. A cadence session has no starter and reads its label alone. */
function Starter({ view }: { view: SessionRowView }) {
  const t = useTranslations('aiPlanning.sessions');
  const originLabel = view.origin === 'conversation' ? null : t(`origin.${view.origin}`);
  if (!view.startedByName && !originLabel) return null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {view.startedByName ? (
        <>
          <span
            className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-(--el-text) text-[9px] font-semibold text-(--el-text-inverted)"
            aria-hidden
          >
            {view.startedByName.charAt(0).toUpperCase()}
          </span>
          <b className="max-w-[10rem] truncate font-semibold" title={view.startedByName}>
            {view.startedByName}
          </b>
        </>
      ) : null}
      {view.startedByName && originLabel ? (
        <span className="text-(--el-text-faint)" aria-hidden>
          ·
        </span>
      ) : null}
      {originLabel ? <span className="min-w-0">{originLabel}</span> : null}
    </span>
  );
}

/** The END LINE (MOTIR-7642; MOTIR-7634 § _The end line for every end reason_) —
 *  on an ended row it REPLACES `active {when}`: the end time is the session's last
 *  moment, so both would say the same thing. One unit that wraps whole; the full
 *  date-time rides `title`. */
function EndLine({ end }: { end: NonNullable<SessionRowView['end']> }) {
  const t = useTranslations('aiPlanning.sessions');
  const time = end.timeLabel;
  const name = end.endedByName;
  let text: string;
  switch (end.reason) {
    case 'failed':
      text = t('end.failed', { time });
      break;
    case 'idle':
      text = t('end.idle', { time });
      break;
    case 'restarted':
      text = end.endedByViewer
        ? t('end.restartedYou', { time })
        : name
          ? t('end.restartedBy', { name, time })
          : t('end.restarted', { time });
      break;
    case 'declined':
      text = end.endedByViewer
        ? t('end.declinedYou', { time })
        : name
          ? t('end.declinedBy', { name, time })
          : t('end.declined', { time });
      break;
    case 'approved':
      text = end.endedByViewer
        ? t('end.approvedYou', { time })
        : name
          ? t('end.approvedBy', { name, time })
          : t('end.approved', { time });
      break;
  }
  return (
    <span data-testid="plan-session-end" title={end.fullLabel}>
      {text}
    </span>
  );
}

/** "Continued from …" (AMENDMENT 23 §6) — a copied session's link to the one it
 *  continues, opened as a read over this page. The seed link's face; it names the
 *  OLD session by its end time, since the copy's first turn IS the old one's. */
function ContinuedFromLink({
  from,
  anchorKey,
}: {
  from: NonNullable<SessionRowView['copiedFrom']>;
  /** A copy keeps its source's anchor set, so it opens where the source did. */
  anchorKey: string | null;
}) {
  const t = useTranslations('aiPlanning.sessions');
  const { href, open } = useOpenPlanningWorkspace(
    anchorKey
      ? { kind: 'work-item', itemKey: anchorKey, sessionId: from.id }
      : { kind: 'project', sessionId: from.id },
  );
  return (
    <Link
      href={href}
      onClick={open}
      aria-label={t('continuedFromAria', { when: from.whenLabel })}
      data-testid="plan-session-continued-from"
      className="relative z-10 inline-flex items-center gap-1 rounded-(--radius-control) text-(--el-text-secondary) underline decoration-(--el-border-strong) underline-offset-2 hover:text-(--el-text) hover:decoration-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
    >
      <CornerLeftUp aria-hidden className="h-3 w-3 shrink-0" />
      <span>{t('continuedFrom', { when: from.whenLabel })}</span>
    </Link>
  );
}

/** The refusal's own button word, one catalogue key per seeding kind — TOTAL
 *  over `PlanSessionSeedGateKindDto`, so widening the union fails the type-check
 *  here (MOTIR-6206 design § "A Plans row names the refused work item"). */
const SEED_VERB_KEY: Record<PlanSessionSeedGateKindDto, string> = {
  decision_approval: 'seed.verb.decisionApproval',
  decision_confirmation: 'seed.verb.decisionConfirmation',
  decision_choice: 'seed.verb.decisionChoice',
  design_result: 'seed.verb.designResult',
  acceptance_result: 'seed.verb.acceptanceResult',
};

/** Meta 5 (MOTIR-6209) — `Re-plan of {KEY} · {verb}`, a link to the refused work
 *  item. Raised above the stretched title link (`relative z-10`, as the chip
 *  is), so pressing it opens the work item and anywhere else reopens the
 *  conversation. Never truncated: the meta line wraps and it moves as one unit.
 *  A null seed draws nothing — not dimmed, not labelled. */
function SeedLink({ seed }: { seed: PlanSessionSeedDto }) {
  const routes = useReaderRoutes();
  const t = useTranslations('aiPlanning.sessions');
  if (seed.origin === 'pick') return <PickSeedLink seed={seed} />;
  if (seed.origin === 'guide') return <GuideSeedLink seed={seed} />;
  // A refusal always carries its gate's kind; a seed without one names no verb
  // rather than reading `SEED_VERB_KEY` off a null (MOTIR-8697).
  const verbKey = seed.gateKind === null ? null : SEED_VERB_KEY[seed.gateKind];
  return (
    <Link
      href={routes.item(seed.cardKey)}
      aria-label={t('seed.aria', { key: seed.cardKey })}
      data-testid="plan-session-seed"
      className="relative z-10 inline-flex items-center gap-1 rounded-(--radius-control) text-(--el-text-secondary) underline decoration-(--el-border-strong) underline-offset-2 hover:text-(--el-text) hover:decoration-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
    >
      <span>
        {t.rich('seed.label', {
          key: seed.cardKey,
          mono: (chunks) => <span className="font-mono">{chunks}</span>,
        })}
      </span>
      {verbKey ? (
        <>
          <span className="text-(--el-text-faint)" aria-hidden>
            ·
          </span>
          <span>{t(verbKey)}</span>
        </>
      ) : null}
    </Link>
  );
}

/** A PICK-seeded session (MOTIR-6434; MOTIR-6432's design, sheet 3):
 *  `Follow-up to {KEY} · chose {label}`, a link to the CHOICE work item — never
 *  the refusal's `Re-plan of` wording. The label truncates at `max-w-[10rem]`;
 *  the whole label is on the link's accessible name. */
function PickSeedLink({ seed }: { seed: PlanSessionSeedDto }) {
  const routes = useReaderRoutes();
  const t = useTranslations('aiPlanning.sessions');
  const label = seed.chosenLabel ?? '';
  return (
    <Link
      href={routes.item(seed.cardKey)}
      aria-label={t('seed.pickAria', { key: seed.cardKey, label })}
      data-testid="plan-session-seed"
      data-seed-origin="pick"
      className="relative z-10 inline-flex items-center gap-1 rounded-(--radius-control) text-(--el-text-secondary) underline decoration-(--el-border-strong) underline-offset-2 hover:text-(--el-text) hover:decoration-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
    >
      <span>
        {t.rich('seed.pickLabel', {
          key: seed.cardKey,
          mono: (chunks) => <span className="font-mono">{chunks}</span>,
        })}
      </span>
      <span className="text-(--el-text-faint)" aria-hidden>
        ·
      </span>
      <span className="max-w-[10rem] truncate">{t('seed.chose', { label })}</span>
    </Link>
  );
}

/** A GUIDE-seeded session (MOTIR-8697; MOTIR-8686's design,
 *  `plans-sessions--guide-seeded.mock.html`): `From the guide on {KEY}`, a link to
 *  the GUIDED work item — the one the person was walking through when Motir AI
 *  offered the re-plan — never the row's anchor. A guide refuses nothing and
 *  picks nothing, so there is no gate verb and no chosen label. The label
 *  truncates as the pick row's does; the full text is the accessible name. */
function GuideSeedLink({ seed }: { seed: PlanSessionSeedDto }) {
  const routes = useReaderRoutes();
  const t = useTranslations('aiPlanning.sessions');
  return (
    <Link
      href={routes.item(seed.cardKey)}
      aria-label={t('seed.guideAria', { key: seed.cardKey })}
      data-testid="plan-session-seed"
      data-seed-origin="guide"
      className="relative z-10 inline-flex min-w-0 items-center gap-1 rounded-(--radius-control) text-(--el-text-secondary) underline decoration-(--el-border-strong) underline-offset-2 hover:text-(--el-text) hover:decoration-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
    >
      <span className="max-w-[16rem] truncate">
        {t.rich('seed.guideLabel', {
          key: seed.cardKey,
          mono: (chunks) => <span className="font-mono">{chunks}</span>,
        })}
      </span>
    </Link>
  );
}

export function SessionRow({
  view,
  highlighted = false,
}: {
  view: SessionRowView;
  /** The `?session=<id>` landing — the shipped selected-row treatment (§19.5 panel 3). */
  highlighted?: boolean;
}) {
  const routes = useReaderRoutes();
  const t = useTranslations('aiPlanning.sessions');
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // A session with NO plan has nothing for the rule to answer about, so it keeps
  // the shipped opener verbatim (§ 19.3a: it opens its conversation like any
  // other row). Everything else goes through the one rule.
  const { href: conversationHref, open: openConversation } = useOpenPlanningWorkspace(
    launchContextFor(view),
  );
  const qs = searchParams.toString();
  const isVisitor = routes.identifier !== null;
  // A CLOSED row opens its CONVERSATION, as a read (MOTIR-7634 § _Where a Closed
  // row goes_) — but ONLY when its latest plan is absent or decided. An ended
  // session whose plan is still undecided is decided in the overlay like any other
  // (Story MOTIR-7883 · MOTIR-7889), so it takes the plan rule below.
  const latestUndecided =
    view.latestPlan !== null &&
    (view.latestPlan.status === 'generating' ||
      view.latestPlan.status === 'planned' ||
      view.latestPlan.status === 'approving' ||
      view.latestPlan.status === 'stale');
  const closedRead = view.state === 'closed' && !isVisitor && !latestUndecided;
  const destination: PlanRowDestination | null = closedRead
    ? { kind: 'planning-surface', href: conversationHref }
    : view.latestPlan
      ? planRowDestination({
          planStatus: view.latestPlan.status,
          planId: view.latestPlan.id,
          // A Plans row IS a session, so this is never null (§ 21.3).
          sessionId: view.id,
          host: `${pathname}${qs ? `?${qs}` : ''}`,
          anchorKey: view.targetKeys[0] ?? null,
          routes,
        })
      : null;
  const doorHref = destination?.href ?? conversationHref;
  const Icon = ORIGIN_ICON[view.origin];
  const state: PlanSessionStateDto = view.state;
  const stateLabel = t(`planState.${state}`);
  // THE CHIP RULE (§ 21.5): a door to the plan in the overlay while there is
  // something to decide — and never on an ENDED row whose plan is decided (the
  // Closed read, MOTIR-7634). An ended row with an UNDECIDED plan keeps its door
  // (Story MOTIR-7883 · MOTIR-7889).
  // …and NEVER on a `waiting` row (MOTIR-7921): its chip is a plain pill — one control, one
  // tab stop — because the row's own door already opens the same overlay at that session.
  const chipIsDoor =
    !closedRead &&
    state !== 'waiting' &&
    view.latestPlan !== null &&
    destination?.kind === 'planning-surface';
  // `Waiting for approval` keeps the accent border — the retired row's
  // `awaitingReview` rule, same meaning: this one needs a decision.
  const awaitingReview = state === 'planned';

  return (
    <div
      className={cn(
        'relative flex flex-wrap items-center gap-3 rounded-(--radius-card) sm:flex-nowrap',
        'border px-(--spacing-control-x) py-(--spacing-control-y) shadow-(--shadow-subtle)',
        'transition-colors hover:border-(--el-border-strong)',
        awaitingReview || highlighted ? 'border-(--el-accent)' : 'border-(--el-border)',
        highlighted ? 'bg-(--el-selection-bg)' : 'bg-(--el-surface)',
      )}
    >
      <span
        className="inline-flex h-(--height-control-32) w-8 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-muted)"
        aria-hidden
      >
        <Icon className="h-4 w-4 text-(--el-text-strong)" aria-hidden />
      </span>

      <div className="min-w-0 flex-1">
        <Link
          href={doorHref}
          // The overlay opens IN PLACE on a plain primary click; the plan page is
          // a real navigation, and every modified click stays the browser's.
          onClick={(event) => {
            if (destination === null) {
              openConversation(event);
              return;
            }
            if (destination.kind !== 'planning-surface') return;
            if (!isPlainPrimaryClick(event)) return;
            event.preventDefault();
            shallowPush(destination.href);
          }}
          className="block truncate text-sm font-semibold text-(--el-text) after:absolute after:inset-0 after:rounded-(--radius-card) focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-(--focus-ring-color)"
        >
          {view.title || t('untitled')}
        </Link>
        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-(--el-text-secondary)">
          <Anchor keys={view.targetKeys} />
          {view.failure ? (
            <FailureLine failure={view.failure} />
          ) : view.end ? (
            <EndLine end={view.end} />
          ) : (
            <span>{t('lastActive', { when: view.activeLabel })}</span>
          )}
          <Starter view={view} />
          {/* `shrink-0`: this line WRAPS rather than truncating, so the tag takes
              its own line before it loses a word (§ 21.6). */}
          {destination ? (
            <PlanDestinationTag destination={destination} className="shrink-0" />
          ) : null}
          {view.seed ? <SeedLink seed={view.seed} /> : null}
          {/* A Visitor is served no planning workspace, so there is no read to open. */}
          {view.copiedFrom && !isVisitor ? (
            <ContinuedFromLink from={view.copiedFrom} anchorKey={view.targetKeys[0] ?? null} />
          ) : null}
        </div>
        {/* A halted WALK's unplanned cards (MOTIR-10209), under the meta line. A failure beside a
            waiting plan (`change`) has no stop line to put them under, and is not drawn. */}
        {view.failure?.kind === 'walk' ? (
          <NotPlannedYetList lines={view.failure.notPlannedYet} surface="row" />
        ) : null}
      </div>

      <div className="flex w-full shrink-0 items-center gap-2 pl-11 sm:w-auto sm:pl-0">
        {view.planCount > 1 ? (
          <span className="text-xs text-(--el-text-secondary)">
            {t('earlierPlans', { count: view.planCount - 1 })}
          </span>
        ) : null}
        {chipIsDoor && view.latestPlan ? (
          // The chip opens the PLAN in the overlay (Story MOTIR-7883 · MOTIR-7889),
          // never the plan page: the row already knows every fact, so no read.
          <PlanOverlayDoor
            planId={view.latestPlan.id}
            known={{
              planStatus: view.latestPlan.status,
              sessionId: view.id,
              anchorKey: view.targetKeys[0] ?? null,
            }}
            aria-label={t('openPlanAria', { state: stateLabel })}
            className="relative z-10 rounded-(--radius-badge) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
          >
            <StateChip
              state={state}
              label={
                <>
                  {stateLabel}
                  <ArrowRight className="h-3 w-3 shrink-0" aria-hidden />
                </>
              }
            />
          </PlanOverlayDoor>
        ) : (
          <StateChip state={state} label={stateLabel} />
        )}
      </div>
    </div>
  );
}
