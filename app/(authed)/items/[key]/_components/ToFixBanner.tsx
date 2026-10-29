'use client';

import { useCallback, useState, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ArrowDown, ArrowRight, LoaderCircle, Wrench } from 'lucide-react';
import { relativeLabel, RepairRunLink } from '@/components/github/RepairFixPart';
import { CopyableCodeBlock } from '@/components/markdown/CopyableCodeBlock';
import { toFixTagState } from '@/components/workItems/ToFixTag';
import Link from 'next/link';
import type { FixDetailDto, FixGroupPointerDto, WorkItemFixReasonDto } from '@/lib/dto/fixReason';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import type { OpenRepairRunDto } from '@/lib/dto/workItemRepair';
import { isReviewSentBack } from '@/lib/workItems/reviewSentBack';
import { formatRunInstant } from '@/lib/runs/runClock';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';
import { DEVELOPMENT_SECTION_ID } from './decisionAnchor';
import { useLandOnLateSection } from './useLandOnLateSection';

// THE TO FIX BANNER (Story MOTIR-6589 · MOTIR-6611) — the item page says WHY the
// card is stuck and WHAT repairs it, before a reader has opened a pull request.
//
// Design: `design/work-items/to-fix--tag-and-banner.mock.html` panels 5 and 6,
// specified in `design/work-items/design-notes.md` § *The TO FIX tag and banner
// (MOTIR-6608)*. It sits in the main column's state-banner slot:
// `ArchivedBanner` › THIS › `PendingPlanNotice` › Description.
//
// ⚠️ THE COMMAND COMES FROM `fixDetail.repair`, NEVER FROM THE REASON — the
// Workbench To fix row's rule (`workbench/design-notes.md` § 30), so the two can
// never name different commands for one card. Every review refusal — the review
// agent's, a person's approve-to-merge Request changes, an acceptance Re-run — is
// `fix` (MOTIR-6822; `approval-gates.md` §12.7), and the lead is *Repair it with this
// command:* for every command (`leadRun` retired, MOTIR-6825; § 32).
//
// ⚠️ A REFUSAL THE REVIEW AGENT WROTE (`fixDetail.gate === 'agent_review'`) NAMES THE
// AGENT and the findings' first line (§ 32), never the run's attributed user — the
// findings in full are one link below, in the Development frame's review band.
//
// ⚠️ IT DRAWS WHAT THE STORED DETAIL SAYS AND NOTHING ELSE. No pull request is
// read here: the Development block below already lists them, and the banner points
// there rather than repeating them.
//
// ⚠️ A DEAD RUN (`run_died`, MOTIR-6880) DRAWS NO COMMAND. The run-died marker in the
// Development block already carries `motir continue` and Continue hosted, and one page
// must not hold two copies of one control (`design/work-items/design-notes.md` § *The
// TO FIX tag and banner: RUN DIED*). The banner says one sentence and points there.
//
// ⚠️ ONE ENTRY PER RUN (MOTIR-7589; § _The TO FIX tag and banner: ONE ENTRY PER RUN_). A
// card stuck WITH others — the legs of one dead run, the cards one pull-request set
// delivers — is repaired through its entry's HEAD. Only the head shows a command, under a
// meta line naming the cards it carries; every other card names the head and links to the
// head's Development block, which is where both repairs live.

/** How many carried keys the head's meta line names before *and N more*. */
const CARRIED_KEYS_SHOWN = 5;

/** GitHub's raw queue reasons the Workbench humanises (`workbench.toFix.queueReason.*`);
 *  any other raw reason falls to the bare sentence, as the Workbench row does. */
const QUEUE_REASONS = new Set([
  'CI_FAILURE',
  'CI_TIMEOUT',
  'MERGE_CONFLICT',
  'INVALID_MERGE_COMMIT',
]);

const code = (chunks: ReactNode) => (
  <code className="rounded-(--radius-control) bg-(--el-code-bg) px-(--spacing-control-x-4) font-mono text-xs font-semibold text-(--el-code-text)">
    {chunks}
  </code>
);
const bold = (chunks: ReactNode) => <b className="font-semibold">{chunks}</b>;

export interface ToFixBannerProps {
  /** The `PROD-N` key — the command names it. */
  identifier: string;
  fixReason: WorkItemFixReasonDto | null;
  fixDetail: FixDetailDto | null;
  /** The item's status CATEGORY — a `done` card draws nothing (`toFixTagState`). */
  statusCategory: StatusCategoryDto | null;
  /**
   * *FIX ON THE HOSTED AGENT* (MOTIR-6930; `design/workbench` § 32 Panel 4) — the door the
   * page passes for a viewer who may run the card hosted. Drawn only for a card a REVIEW
   * sent back, and only while no repair is open: it LEADS, under `hostedLead`, and the
   * command follows under `orTerminal`. Absent, `leadFix` and the command alone.
   */
  hostedDoor?: ReactNode;
  /**
   * The To fix ENTRY this card is one of (MOTIR-7589), or null for a card stuck alone —
   * which keeps today's banner exactly.
   */
  fixGroup?: FixGroupPointerDto | null;
  /** The card's OPEN repair (MOTIR-6930) — the one-repair lock. A hosted one replaces the
   *  lead, the door and the command with *A hosted repair is running*; a local one keeps
   *  the command alone. Null when none is open. */
  repairRun?: OpenRepairRunDto | null;
}

export function ToFixBanner({
  identifier,
  fixReason,
  fixDetail,
  statusCategory,
  hostedDoor = null,
  repairRun = null,
  fixGroup = null,
}: ToFixBannerProps) {
  const t = useTranslations('toFix.banner');
  const routes = useReaderRoutes();
  const tw = useTranslations('workbench.toFix');
  const locale = useLocale();
  // Read ONCE per mount: a relative label that moved between renders would be a
  // hydration mismatch (the continue part's rule).
  const [clock] = useState(() => Date.now());
  const findDevelopment = useCallback(() => document.getElementById(DEVELOPMENT_SECTION_ID), []);
  const { press, pending } = useLandOnLateSection(findDevelopment);

  const reason = toFixTagState(fixReason, statusCategory);
  if (!reason || !fixDetail) return null;

  const when = (iso: string) =>
    function BannerWhen() {
      return (
        <time className="whitespace-nowrap" dateTime={iso} title={formatRunInstant(iso, locale)}>
          {relativeLabel(iso, locale, clock)}
        </time>
      );
    };
  const isDeadRun = reason === 'run_died';
  // A card carried by another card's entry: it names the head and offers no repair.
  const carriedBy = fixGroup && !fixGroup.isHead ? fixGroup.headKey : null;
  const carries = fixGroup?.isHead ? fixGroup.carriedKeys : [];
  const nothingPushed = isDeadRun && fixDetail.pushed === false;
  // FIX ON THE HOSTED AGENT (MOTIR-6930): a review's refusal only; a hosted repair already
  // running replaces both repairs, and ANY open repair withdraws the door.
  const reviewSentBack = isReviewSentBack(fixReason, fixDetail);
  const hostedRepair = reviewSentBack && repairRun?.hosted ? repairRun : null;
  const door = reviewSentBack && !repairRun ? hostedDoor : null;

  const sentence = ((): ReactNode => {
    switch (reason) {
      case 'run_died': {
        // A detail missing its time is a row written by a newer shape than this
        // reader: the plainest true sentence is the pushed one without a time.
        const heard = when(fixDetail.lastHeardAt ?? new Date(clock).toISOString());
        if (nothingPushed) return t.rich('runDiedNothingPushed', { when: heard });
        const parent =
          carriedBy ??
          (fixDetail.continueKey !== null && fixDetail.continueKey !== identifier
            ? fixDetail.continueKey
            : null);
        return parent
          ? t.rich('runDiedParent', { parent, b: bold, when: heard })
          : t.rich('runDied', { when: heard });
      }
      case 'queue_failed':
        if (fixDetail.check) return t.rich('queueFailed', { check: fixDetail.check, code });
        if (fixDetail.queueReason && QUEUE_REASONS.has(fixDetail.queueReason)) {
          return t('queueFailedReason', {
            reason: tw(`queueReason.${fixDetail.queueReason}`),
          });
        }
        return t('queueFailedBare');
      case 'conflicted':
        return fixDetail.base
          ? t.rich('conflicted', { base: fixDetail.base, code })
          : t('conflictedNoBase');
      case 'out_of_date':
        return fixDetail.base
          ? t.rich('outOfDate', { base: fixDetail.base, code })
          : t('outOfDateNoBase');
      case 'ci_failed':
        return fixDetail.check
          ? t.rich('ciFailed', { check: fixDetail.check, code })
          : t('ciFailedBare');
      case 'changes_requested':
        if (fixDetail.gate === 'agent_review') {
          return fixDetail.notePreview
            ? t('sentBackByAgent', { note: fixDetail.notePreview })
            : t('sentBackByAgentNoNote');
        }
        if (!fixDetail.reviewerName) return t('changesRequestedAnon');
        return fixDetail.notePreview
          ? t.rich('changesRequested', {
              name: fixDetail.reviewerName,
              note: fixDetail.notePreview,
              b: bold,
            })
          : t.rich('changesRequestedNoNote', { name: fixDetail.reviewerName, b: bold });
      default: {
        const unreachable: never = reason;
        return unreachable;
      }
    }
  })();

  // THE HEAD'S META LINE (§ _ONE ENTRY PER RUN_): the cards its one repair also clears.
  const carriesLine =
    carries.length > 0
      ? t.rich('carries', {
          count: carries.length,
          keys: () => (
            <>
              {carries.slice(0, CARRIED_KEYS_SHOWN).map((key, i) => (
                <span key={key}>
                  {i > 0 ? ', ' : null}
                  <b className="font-semibold">{key}</b>
                </span>
              ))}
              {carries.length > CARRIED_KEYS_SHOWN
                ? ` ${t('carriesMore', { count: carries.length - CARRIED_KEYS_SHOWN })}`
                : null}
            </>
          ),
        })
      : null;

  const meta = (
    isDeadRun
      ? []
      : [
          fixDetail.gate === 'acceptance_result' ? t('onAcceptance') : null,
          fixDetail.total > 1
            ? tw('affected', { affected: fixDetail.affected, total: fixDetail.total })
            : null,
        ]
  ).filter((line): line is string => line !== null);

  return (
    <div
      role="status"
      data-testid="to-fix-banner"
      data-to-fix={reason}
      className="flex items-start gap-3 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-danger-surface) px-(--spacing-card-padding-12) py-(--spacing-card-padding-12)"
    >
      {/* The tag's own disc — the banner and the tag are recognisably one signal. */}
      <span
        className="mt-px inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-(--el-danger) text-(--el-danger-text)"
        aria-hidden
      >
        <Wrench className="h-3 w-3 shrink-0" aria-hidden />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="m-0 font-sans text-sm font-semibold text-(--el-danger-surface-text)">
          {sentence}
        </p>
        {meta.length > 0 ? (
          <p className="m-0 font-sans text-[13px] text-(--el-danger-surface-text)">
            {meta.join(' · ')}
          </p>
        ) : null}
        {carriesLine ? (
          <p
            className="m-0 font-sans text-[13px] text-(--el-danger-surface-text)"
            data-testid="to-fix-banner-carries"
          >
            {carriesLine}
          </p>
        ) : null}
        {isDeadRun ? null : carriedBy ? (
          // A card on its head's pull requests: one sentence in place of the lead and the
          // command — two copies of one repair is what the entry removes.
          <p
            className="m-0 mt-1 font-sans text-[13px] text-(--el-danger-surface-text)"
            data-testid="to-fix-banner-repaired-with-head"
          >
            {t.rich('repairedWithHead', { head: carriedBy, b: bold })}
          </p>
        ) : hostedRepair ? (
          // § 32 Panel 4, running: the lead, the door and the command give way to one line
          // — the open repair IS the lock (`hosted-agent-run.md` §8.6).
          <p
            className="m-0 mt-1 font-sans text-[13px] text-(--el-danger-surface-text)"
            data-testid="to-fix-banner-hosted-fixing"
          >
            {t.rich(hostedRepair.byViewer ? 'fixingHostedByYou' : 'fixingHosted', {
              name: hostedRepair.holder?.name ?? '—',
              label: hostedRepair.label,
              b: bold,
              when: when(hostedRepair.startedAt),
              run: (chunks) => <RepairRunLink runId={hostedRepair.id}>{chunks}</RepairRunLink>,
            })}
          </p>
        ) : (
          <>
            {door ? (
              <>
                {/* § 32 Panel 4: the Continue hosted part's order — the door leads. */}
                <p className="m-0 mt-1 font-sans text-[13px] text-(--el-danger-surface-text)">
                  {t('hostedLead')}
                </p>
                {door}
              </>
            ) : null}
            <p className="m-0 mt-1 font-sans text-[13px] text-(--el-danger-surface-text)">
              {t(door ? 'orTerminal' : 'leadFix')}
            </p>
            <CopyableCodeBlock language="shell" code={`motir ${fixDetail.repair} ${identifier}`} />
          </>
        )}
        {carriedBy ? (
          // A carried card points at the HEAD's page — its Development block holds both
          // repairs — never at a Workbench row the reader may not have.
          <Link
            href={routes.item(carriedBy, DEVELOPMENT_SECTION_ID)}
            data-testid="to-fix-banner-to-head"
            className="inline-flex w-fit items-center gap-1 font-sans text-[13px] font-medium text-(--el-text-strong) underline decoration-(--el-border-strong) underline-offset-2 hover:decoration-(--el-text-strong) focus-visible:rounded-(--radius-control) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
          >
            {t('toHead', { head: carriedBy })}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        ) : (
          <>
            {/* A real `#development` link, so it works with scripting off; with it on,
            the press waits for the late stack the way the header marker does. */}
            <a
              href={`#${DEVELOPMENT_SECTION_ID}`}
              onClick={(event) => {
                event.preventDefault();
                press();
              }}
              aria-busy={pending || undefined}
              className="inline-flex w-fit items-center gap-1 font-sans text-[13px] font-medium text-(--el-text-strong) underline decoration-(--el-border-strong) underline-offset-2 hover:decoration-(--el-text-strong) focus-visible:rounded-(--radius-control) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
            >
              {t(isDeadRun ? (nothingPushed ? 'toStartOver' : 'toContinue') : 'toDevelopment')}
              {pending ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <ArrowDown className="h-3.5 w-3.5" aria-hidden />
              )}
            </a>
            <span className="sr-only" role="status" aria-live="polite">
              {pending ? t(isDeadRun ? 'openingDevelopment' : 'opening') : ''}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
