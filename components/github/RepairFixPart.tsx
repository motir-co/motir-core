'use client';

import { Fragment, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import {
  CircleEllipsis,
  Cloud,
  CircleX,
  CornerLeftUp,
  TriangleAlert,
  Undo2,
  UserRound,
} from 'lucide-react';
import { Pill } from '@/components/ui/Pill';
import { CopyableCodeBlock } from '@/components/markdown/CopyableCodeBlock';
import type {
  RepairPullRequestRefDto,
  RepairRunRefDto,
  WorkItemRepairViewDto,
} from '@/lib/dto/workItemRepair';
import { formatRunInstant } from '@/lib/runs/runClock';
import { runsHref } from '@/lib/runs/runsAddress';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';

// THE FIX PART of the Development block (Story MOTIR-5460 · MOTIR-5466), built to
// `design/github/design-notes.md` § 21 · Panels F1–F4, and § 26 · Panels X1–X5 for an
// EJECTED card (Story MOTIR-5628 · MOTIR-5721): a member failing only because the
// merge queue threw it out is named on the left-the-queue line, and the offer
// state adds the sentence that says whether *Queue again* or `motir fix` applies.
//
// ⚠️ A FLUSH PART, NOT A BOX. It is the card's own region under a soft rule with
// an `h4`, the grammar How to test uses directly below it — a container does not
// go inside the card that already names it (§ 20, *No card inside a card*).
//
// ⚠️ THE COMMAND BLOCK IS THE SHIPPED `CopyableCodeBlock`, composed exactly as How
// to test's *Locally* fact composes it. Nothing here draws a second code block.
//
// ⚠️ IN PROGRESS SHOWS NO COMMAND AT ALL — not a disabled one. A second person
// must not start a second repair; the claim would refuse it (`taken`) anyway.
//
// The state is decided on the SERVER by the repair claim's own evaluation
// (`workItemRepairService.getRepairView`), so this component never offers a
// command the claim would refuse. `hidden` renders nothing.

/** Relative time in the active locale — minutes, then hours, then days (§ 21). */
export function relativeLabel(iso: string, locale: string, now: number): string {
  const minutes = Math.max(Math.round((now - new Date(iso).getTime()) / 60_000), 0);
  const fmt = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  if (minutes < 60) return fmt.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 48) return fmt.format(-hours, 'hour');
  return fmt.format(-Math.round(hours / 24), 'day');
}

const bold = (chunks: ReactNode) => <b className="font-semibold whitespace-nowrap">{chunks}</b>;

/**
 * A member failing ONLY because the merge queue threw it out — its own checks are
 * not red, and it carries a standing exit (§ 26's show-when rule, MOTIR-5721). It
 * is named on the left-the-queue line, because *Checks are failing* would be false.
 *
 * ⚠️ ONLY A FAILURE (§4 SIXTH AMENDMENT; MOTIR-6849). An exit whose check HUNG is
 * stored `neutral`: nothing failed, so naming it on the failure line would send a
 * person looking for a bug that does not exist.
 */
function isEjectedOnly(pr: RepairPullRequestRefDto): boolean {
  return pr.queueExit !== null && pr.queueExit.disposition === 'failure' && pr.ci !== 'failing';
}

/** Which which-to-use sentence applies. A conflict wins: approving again cannot land
 *  that member, whatever the others need. Every other member the part names left the queue
 *  for a FAILURE — CAN'T-LAND since the FIFTH AMENDMENT (MOTIR-6596, design § 31) — and it
 *  takes a new head too. § 26's *Approve sends the same commits once more* is retired:
 *  nothing offers that press any more. */
function whichVariant(ejected: readonly RepairPullRequestRefDto[]): 'conflict' | 'failed' {
  const reasons = ejected.map((pr) => pr.queueExit!.rawReason);
  return reasons.includes('MERGE_CONFLICT') ? 'conflict' : 'failed';
}

function PrLine({
  failing,
  message,
}: {
  failing: RepairPullRequestRefDto[];
  message: 'failingOn' | 'leftQueueOn';
}) {
  const t = useTranslations('github.development.fix');
  const locale = useLocale();
  // Each pull request is named as its row's meta line names it, bold and never
  // broken; the SET is joined by the locale's own list format.
  const names = failing.map((pr) => `${pr.repo} · #${pr.number}`);
  const parts = new Intl.ListFormat(locale, { type: 'conjunction' }).formatToParts(names);
  const list = parts.map((part, i) =>
    part.type === 'element' ? (
      <b key={i} className="font-semibold whitespace-nowrap">
        {part.value}
      </b>
    ) : (
      <Fragment key={i}>{part.value}</Fragment>
    ),
  );
  return (
    <p className="flex items-start gap-2 text-[13px] leading-normal text-(--el-text)">
      <CircleX className="mt-0.5 h-4 w-4 shrink-0 text-(--el-danger-on-surface)" aria-hidden />
      <span>{t.rich(message, { prs: () => list })}</span>
    </p>
  );
}

/** A member failing ONLY because the host reports it conflicted with its base (MOTIR-5916;
 *  design § 30's fix part): its checks are not red and no queue removed it, so *Checks
 *  are failing* would be false — it is named on the conflict line instead. */
function isConflictedOnly(pr: RepairPullRequestRefDto): boolean {
  return pr.conflict !== null && pr.ci !== 'failing' && pr.queueExit === null;
}

/** A member failing ONLY because it is out of date with a base that requires it to be up
 *  to date (Bug MOTIR-10054): green checks, no queue exit, no conflict — so it is named on
 *  the out-of-date line, never *Checks are failing*. */
function isOutOfDateOnly(pr: RepairPullRequestRefDto): boolean {
  return (
    pr.outOfDate !== null && pr.conflict === null && pr.ci !== 'failing' && pr.queueExit === null
  );
}

/** A line naming members by their BASE — the conflict line (MOTIR-5916) and the
 *  out-of-date line (MOTIR-10054): `{base}` when every member names the same one, *its base
 *  branch* otherwise. */
function BaseLine({
  members,
  baseOf,
  message,
  testId,
}: {
  members: RepairPullRequestRefDto[];
  baseOf: (pr: RepairPullRequestRefDto) => string | null;
  message: 'conflictOn' | 'outOfDateOn';
  testId: string;
}) {
  const t = useTranslations('github.development.fix');
  const locale = useLocale();
  const names = members.map((pr) => `${pr.repo} · #${pr.number}`);
  const parts = new Intl.ListFormat(locale, { type: 'conjunction' }).formatToParts(names);
  const list = parts.map((part, i) =>
    part.type === 'element' ? (
      <b key={i} className="font-semibold whitespace-nowrap">
        {part.value}
      </b>
    ) : (
      <Fragment key={i}>{part.value}</Fragment>
    ),
  );
  const bases = new Set(members.map(baseOf));
  const base = bases.size === 1 ? [...bases][0]! : null;
  return (
    <p className="flex items-start gap-2 text-[13px] leading-normal text-(--el-text)">
      <CircleX className="mt-0.5 h-4 w-4 shrink-0 text-(--el-danger-on-surface)" aria-hidden />
      <span data-testid={testId}>
        {base !== null
          ? t.rich(message, { prs: () => list, base })
          : t.rich(`${message}NoBase`, { prs: () => list })}
      </span>
    </p>
  );
}

/** The own-checks line, the left-the-queue line, the conflict line and the out-of-date
 *  line — each when the set holds that kind, own-failing first (§ 26; § 30 for the
 *  conflict line; MOTIR-10054 for the out-of-date line). */
function FailingLines({ failing }: { failing: RepairPullRequestRefDto[] }) {
  const own = failing.filter(
    (pr) => !isEjectedOnly(pr) && !isConflictedOnly(pr) && !isOutOfDateOnly(pr),
  );
  const ejected = failing.filter(isEjectedOnly);
  const conflicted = failing.filter((pr) => pr.conflict !== null);
  const behind = failing.filter(isOutOfDateOnly);
  return (
    <>
      {own.length > 0 ? <PrLine failing={own} message="failingOn" /> : null}
      {ejected.length > 0 ? <PrLine failing={ejected} message="leftQueueOn" /> : null}
      {conflicted.length > 0 ? (
        <BaseLine
          members={conflicted}
          baseOf={(pr) => pr.conflict!.baseRef ?? null}
          message="conflictOn"
          testId="repair-conflict-line"
        />
      ) : null}
      {behind.length > 0 ? (
        <BaseLine
          members={behind}
          baseOf={(pr) => pr.outOfDate!.baseRef ?? null}
          message="outOfDateOn"
          testId="repair-out-of-date-line"
        />
      ) : null}
    </>
  );
}

/** THE SENT-BACK LINE (Story MOTIR-6071 · MOTIR-6502 / MOTIR-6506; design
 *  `approval-control--acceptance-verdict.mock.html` panel 6a): the story's acceptance video
 *  was sent back with Re-run. Its checks are usually green, so *Checks are failing* would be
 *  false — the part names the review instead. The shipped `pointer` line's recipe, not the
 *  failing line's: a refusal is not a failure. `{count}` is the story's open pull requests,
 *  every one of which the fix is handed. */
function SentBackLine({ count, by }: { count: number; by: SentBackBy | 'acceptance' }) {
  const t = useTranslations('github.development.fix');
  return (
    <p
      className="flex items-start gap-2 text-[13px] leading-normal text-(--el-text-secondary)"
      data-testid="repair-sent-back-line"
      data-sent-back-by={by === 'acceptance' ? 'acceptance' : by.by}
    >
      <Undo2 className="mt-0.5 h-4 w-4 shrink-0 text-(--el-icon-muted)" aria-hidden />
      <span>
        {by === 'acceptance'
          ? t('sentBack', { count })
          : by.by === 'agent'
            ? t('sentBackByAgent', { count })
            : by.name
              ? t.rich('personSentBack', {
                  name: by.name,
                  count,
                  b: (chunks) => <b className="font-semibold text-(--el-text)">{chunks}</b>,
                })
              : t('personSentBackAnon', { count })}
      </span>
    </p>
  );
}

/**
 * WHO SENT A `review` REPAIR'S COMMITS BACK (Story MOTIR-1626 · MOTIR-6825; design
 * `design/github` § 30 Panels 3 and 3e) — the review agent's `changes_requested` on
 * `agent_review`, or a person's *Request changes* on the approve-and-merge gate (§12.7).
 * The host reads it off the gate its frame leads with.
 */
export type SentBackBy = { by: 'agent' } | { by: 'person'; name: string | null };

/** A member the shipped failing lines name — red checks, a queue exit or a conflict. On a
 *  sent-back story the part is handed EVERY open member, green ones included, so only these
 *  follow the sent-back line (design § *Failing lines*). */
function isFailing(pr: RepairPullRequestRefDto): boolean {
  return (
    pr.ci === 'failing' || pr.queueExit !== null || pr.conflict !== null || pr.outOfDate !== null
  );
}

/** The WHICH-TO-USE sentence (§ 26): under the command, in the offer state only,
 *  when a member is failing because the queue threw it out. */
function WhichToUse({ ejected }: { ejected: RepairPullRequestRefDto[] }) {
  const t = useTranslations('github.development.fix');
  return (
    <p className="text-xs leading-normal text-(--el-text-secondary)" data-testid="repair-which">
      {t.rich(`which.${whichVariant(ejected)}`, {
        b: (chunks) => <b className="font-semibold text-(--el-text)">{chunks}</b>,
        code: (chunks) => <span className="font-mono">{chunks}</span>,
      })}
    </p>
  );
}

function Command({
  itemIdentifier,
  many,
  conflict,
  reviewedAgain = false,
  hostedDoor = null,
  myAgentDoor = null,
}: {
  /** *Fix in my agent* (MOTIR-9053): drawn beside the copyable command of a red-checks
   *  repair, in the offer state only. */
  myAgentDoor?: ReactNode;
  /** A card a REVIEW sent back (MOTIR-6825): the next green version is reviewed again. */
  reviewedAgain?: boolean;
  /** *Fix on the hosted agent* (MOTIR-6930; § 30 Panel 3): it LEADS, under its own lead,
   *  and the command follows under *Or hand the repair to an agent from your terminal*. */
  hostedDoor?: ReactNode;
  itemIdentifier: string;
  many: boolean;
  /** A member conflicts (MOTIR-5916): the agent rebases or resolves, and there is nothing
   *  to approve until a push re-arms the question (§ 28's fix-part strings). */
  conflict: boolean;
}) {
  const t = useTranslations('github.development.fix');
  return (
    <>
      {hostedDoor ? (
        <>
          <p className="text-[13px] leading-normal text-(--el-text)">{t('hosted.lead')}</p>
          {hostedDoor}
          <p className="text-xs leading-normal text-(--el-text-secondary)">
            {t('hosted.orTerminal')}
          </p>
        </>
      ) : (
        <p className="text-[13px] leading-normal text-(--el-text)">{t('lead')}</p>
      )}
      {myAgentDoor}
      <CopyableCodeBlock language="shell" code={`motir fix ${itemIdentifier}`} />
      <p className="text-xs leading-normal text-(--el-text-secondary)">
        {hostedDoor
          ? t('hosted.eitherWay')
          : t(conflict ? 'howConflict' : many ? 'howMany' : 'how')}
        {reviewedAgain ? ` ${t('reviewedAgain')}` : null}
      </p>
      {conflict ? (
        <p className="text-xs leading-normal text-(--el-text-secondary)">{t('rearm')}</p>
      ) : null}
    </>
  );
}

function When({ iso, now }: { iso: string; now: number }) {
  const locale = useLocale();
  return (
    <time className="whitespace-nowrap" dateTime={iso} title={formatRunInstant(iso, locale)}>
      {relativeLabel(iso, locale, now)}
    </time>
  );
}

/**
 * A HOSTED REPAIR RUNNING (MOTIR-6930; design § 30 Panel 3b) — § 21's F2 *Fixing* state,
 * told it is hosted: who pressed, since when, and the run's link. The door and the command
 * are gone: the open repair run IS the one-repair-at-a-time lock (`hosted-agent-run.md`
 * §8.6). A local `motir fix` holding the claim draws F2 unchanged.
 */
function HostedFixing({
  repair,
  run,
  now,
}: {
  repair: Extract<WorkItemRepairViewDto, { state: 'in_progress' }>;
  run: RepairRunRefDto;
  now: number;
}) {
  const t = useTranslations('github.development.fix.hosted.fixing');
  return (
    <>
      <p
        className="flex items-start gap-2 text-[13px] leading-normal text-(--el-text-secondary)"
        data-testid="repair-hosted-fixing"
      >
        <Cloud className="mt-0.5 h-4 w-4 shrink-0 text-(--el-icon-muted)" aria-hidden />
        <span>
          {t.rich(repair.byViewer ? 'byYou' : 'by', {
            name: repair.holder?.name ?? '—',
            label: run.label,
            b: (chunks) => <b className="font-medium text-(--el-text)">{chunks}</b>,
            when: () => <When iso={repair.startedAt} now={now} />,
            run: (chunks) => <RepairRunLink runId={run.id}>{chunks}</RepairRunLink>,
          })}
        </span>
      </p>
      <p className="text-xs leading-normal text-(--el-text-secondary)">{t('why')}</p>
    </>
  );
}

/** A repair run's label, linked to the run — the review band's `ar-run` (§ 30 Panel 3b). */
export function RepairRunLink({ runId, children }: { runId: string; children: ReactNode }) {
  // The READER's address (MOTIR-6888): this body renders on the Visitor tree too.
  const routes = useReaderRoutes();
  return (
    <Link
      href={routes.view(runsHref({ run: runId }))}
      className="font-semibold text-(--el-link) underline hover:text-(--el-link-pressed)"
      data-testid="repair-hosted-run-link"
    >
      {children}
    </Link>
  );
}

export function RepairFixPart({
  repair,
  itemIdentifier,
  now,
  sentBackBy = null,
  hostedDoor = null,
  myAgentDoor = null,
}: {
  repair: WorkItemRepairViewDto;
  /**
   * *FIX IN MY AGENT* (MOTIR-9053) — drawn beside the copyable `motir fix <KEY>` of a
   * red-checks (`ci`) repair in the offer state, and only where the host passes it: the
   * item page, for a viewer who may use agents on the project. Every other class and state
   * draws no door, and the read-only peek omits it.
   */
  myAgentDoor?: ReactNode;
  /** Who sent a `review` repair's commits back — the host's frame knows (MOTIR-6825). */
  sentBackBy?: SentBackBy | null;
  /**
   * *FIX ON THE HOSTED AGENT* (MOTIR-6930; design § 30 Panels 3–3e) — drawn above the
   * copyable `motir fix <KEY>` of a card a REVIEW sent back, in the offer state only, and
   * only where the host passes it: the item page, for a viewer who may press Run hosted.
   * Absent — anyone else, every other host — the part draws the command alone.
   */
  hostedDoor?: ReactNode;
  /** The card's own `MOTIR-<n>` — the command names it. */
  itemIdentifier: string;
  /** The clock the relative times read. Injected by tests; `Date.now()` otherwise. */
  now?: number;
}) {
  const routes = useReaderRoutes();
  const t = useTranslations('github.development.fix');
  // Read ONCE per mount: a clock read during render is impure, and a relative
  // label that moved between renders would be a hydration mismatch waiting to happen.
  const [clock] = useState(() => now ?? Date.now());
  if (repair.state === 'hidden') return null;
  // An acceptance sent back to Re-run names the review, never failing checks (MOTIR-6502);
  // its title and first line are the design's sent-back class (MOTIR-6506). The command,
  // the lead, `how` / `howMany`, in progress and gave up are the shipped ones.
  const acceptanceSentBack =
    repair.state !== 'pointer' && repair.repairClass === 'acceptance_rerun';
  // A card a REVIEW sent back (MOTIR-6822's `review` class; § 30 Panels 3 and 3e): its checks
  // are green, so it names the review — the agent or the person — never failing checks.
  const reviewSentBack = repair.state !== 'pointer' && repair.repairClass === 'review';
  const sentBack = acceptanceSentBack || reviewSentBack;
  const failingLines = sentBack ? repair.failing.filter(isFailing) : repair.failing;

  const pill =
    repair.state === 'in_progress' ? (
      <Pill status="in-progress">
        <CircleEllipsis className="h-3 w-3" aria-hidden />
        {t('fixing.pill')}
      </Pill>
    ) : repair.state === 'offer' && repair.lastGaveUp ? (
      <Pill severity="danger">
        <TriangleAlert className="h-3 w-3" aria-hidden />
        {t('gaveUp.pill')}
      </Pill>
    ) : null;

  return (
    <div
      role="group"
      aria-label={t(sentBack ? 'aria.partSentBack' : 'aria.part')}
      data-testid="repair-fix-part"
      data-state={repair.state}
      data-repair-kind={sentBack ? 'sent_back' : 'failing'}
      className="mt-4 flex min-w-0 flex-col gap-2 border-t border-(--el-border-soft) pt-4"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h4 className="text-[13px] font-semibold text-(--el-text)">
          {t(sentBack ? 'titleSentBack' : 'title')}
        </h4>
        {pill}
      </div>
      {acceptanceSentBack ? <SentBackLine count={repair.failing.length} by="acceptance" /> : null}
      {reviewSentBack && sentBackBy ? (
        <SentBackLine count={repair.failing.length} by={sentBackBy} />
      ) : null}
      <FailingLines failing={failingLines} />

      {repair.state === 'in_progress' && repair.run?.hosted ? (
        <HostedFixing repair={repair} run={repair.run} now={clock} />
      ) : null}

      {repair.state === 'in_progress' && !repair.run?.hosted ? (
        <>
          <p className="flex items-start gap-2 text-[13px] leading-normal text-(--el-text-secondary)">
            <UserRound className="mt-0.5 h-4 w-4 shrink-0 text-(--el-icon-muted)" aria-hidden />
            <span>
              {t.rich(
                repair.byViewer ? 'fixing.byYou' : repair.holder ? 'fixing.by' : 'fixing.bySomeone',
                {
                  name: repair.holder?.name ?? '',
                  b: (chunks) => <b className="font-medium text-(--el-text)">{chunks}</b>,
                  when: () => <When iso={repair.startedAt} now={clock} />,
                },
              )}
            </span>
          </p>
          <p className="text-xs leading-normal text-(--el-text-secondary)">{t('fixing.why')}</p>
        </>
      ) : null}

      {repair.state === 'offer' ? (
        <>
          {repair.lastGaveUp ? (
            <div
              role="status"
              className="flex items-start gap-2.5 rounded-(--radius-card) bg-(--el-danger-surface) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) text-[13px] leading-normal text-(--el-danger-surface-text)"
            >
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <div>
                <p>
                  {repair.lastGaveUp.attempts === null
                    ? t.rich('gaveUp.titleNoCount', {
                        b: bold,
                        when: () => <When iso={repair.lastGaveUp!.endedAt} now={clock} />,
                      })
                    : t.rich('gaveUp.title', {
                        attempts: repair.lastGaveUp.attempts,
                        b: bold,
                        when: () => <When iso={repair.lastGaveUp!.endedAt} now={clock} />,
                      })}
                </p>
                <p>{t('gaveUp.body')}</p>
              </div>
            </div>
          ) : null}
          <Command
            itemIdentifier={itemIdentifier}
            many={repair.failing.length > 1}
            conflict={repair.failing.some((pr) => pr.conflict !== null)}
            reviewedAgain={reviewSentBack}
            hostedDoor={reviewSentBack ? hostedDoor : null}
            myAgentDoor={repair.repairClass === 'ci' ? myAgentDoor : null}
          />
          {!sentBack && repair.failing.some(isEjectedOnly) ? (
            <WhichToUse ejected={repair.failing.filter(isEjectedOnly)} />
          ) : null}
          {/* § 31 panel 1 (MOTIR-6596): a member held by a queue FAILURE, with no conflict
              anywhere (whose `Command` already says it), ends on the re-arm line — nothing
              is asked until a push goes green. */}
          {!sentBack &&
          repair.failing.some(isEjectedOnly) &&
          !repair.failing.some((pr) => pr.conflict !== null) &&
          whichVariant(repair.failing.filter(isEjectedOnly)) === 'failed' ? (
            <p className="text-xs leading-normal text-(--el-text-secondary)">{t('rearm')}</p>
          ) : null}
        </>
      ) : null}

      {repair.state === 'pointer' ? (
        <p className="flex items-start gap-2 text-[13px] leading-normal text-(--el-text-secondary)">
          <CornerLeftUp className="mt-0.5 h-4 w-4 shrink-0 text-(--el-icon-muted)" aria-hidden />
          <span>
            {t.rich('child.pointer', {
              key: repair.runTargetKey,
              link: (chunks) => (
                <Link
                  href={routes.item(repair.runTargetKey)}
                  className="font-medium text-(--el-link) underline-offset-2 hover:underline"
                >
                  {chunks}
                </Link>
              ),
            })}
          </span>
        </p>
      ) : null}
    </div>
  );
}
