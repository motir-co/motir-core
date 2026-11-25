'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
  CircleEllipsis,
  CircleMinus,
  CircleX,
  Clock,
  GitBranch,
  GitPullRequestArrow,
  ShieldAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { parseMemberVersion } from '@/lib/approvalGates/memberVersion';
import { classOfQueueExit } from '@/lib/mergeQueue/queueExit';
import type { PullRequestApprovalMemberDTO } from '@/lib/dto/approvalGate';
import type { LinkedPullRequestDto } from '@/lib/dto/github';
import { PR_STATE_META } from './prStateMeta';

// A PULL-REQUEST ROW'S SECOND PILL SLOT, after Approve and merge (Story MOTIR-4909 ·
// MOTIR-5484; `design/github/design-notes.md` §20 *The verbs and their states*, decision
// *where a row's outcome shows*).
//
// ⚠️ THE ROW STAYS `PullRequestRow`, DERIVED AND UNCHANGED (§19). The rows are rendered on
// the SERVER, inside the approval frame's port, and the press's outcome lives in the
// frame's CLIENT state. So the frame provides the outcomes through context, and this slot —
// a client leaf inside each server-rendered row — reads its own. The quick view, which draws
// no frame, provides the persisted half through `PersistedMergeOutcomes` (Bug MOTIR-5650).
// With no provider (the frame before anything was pressed, a card with no approved gate) it
// renders exactly what it was handed: the row's CI pill.
//
// ⚠️ IT REPLACES THE CI PILL, IT DOES NOT SIT BESIDE IT. Every member was green by
// construction (decision 3), so after the press the CI pill has nothing left to say, and the
// slot says what happened instead.

/** What one row shows once the frame has something to report about it. */
export type RowMergeOutcome =
  | { kind: 'merging' }
  | { kind: 'merged' }
  | { kind: 'queued' }
  | {
      kind: 'refused' | 'notMergedYet';
      /** Retry this member's merge; `null` for a reader who may not decide. */
      onRetry: (() => void) | null;
      retrying: boolean;
    }
  // THE MERGE QUEUE REMOVED IT (MOTIR-5635; design § 22, E1–E7). A FAILURE is rose, a
  // NEUTRAL removal is not — nothing was said about the work.
  | {
      kind: 'leftQueue' | 'removedFromQueue';
      /** *Queue again*; `null` when the approval no longer covers the head, or for a
       *  reader who may not press it. */
      onQueueAgain: (() => void) | null;
      /** The press is in flight: the pill stays, the button waits (E2). */
      queueing: boolean;
    }
  /** Removed, and a push moved the head since: the approval no longer describes the code,
   *  so nothing is offered (E3). */
  | { kind: 'newCommits' }
  // THE HOST REFUSED THE MERGE (MOTIR-5833; § 28 panels 3 and 4). What the row offers is
  // the CLASS's answer to one question: could a person still make these commits land?
  | {
      kind: 'refusedSetting';
      /** *Retry merge*, which DECIDES the re-asked gate (MOTIR-5834); `null` for a reader
       *  who may not press it. */
      onRetry: (() => void) | null;
      retrying: boolean;
    }
  /** The commits cannot land as they stand — a conflict, or checks the host will not
   *  merge past. No verb: `motir fix` is the way forward (§4 FOURTH AMENDMENT, point 2). */
  | { kind: 'cannotLand' }
  /** The merge queue FAILED it and it is held at Implemented (§4 FIFTH AMENDMENT;
   *  MOTIR-6596, design § 31 panel 1). The pill still says what the queue did — *Left the
   *  queue* — but no verb is offered: a second yes would queue the same refused commits. */
  | { kind: 'failedHeld' };

const MergeOutcomeContext = createContext<ReadonlyMap<string, RowMergeOutcome> | null>(null);

/** A row's identity — `owner/name#number`, case-insensitive on the repository, as
 *  `mergePullRequestRows` identifies a pull request. */
export function rowKey(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${number}`;
}

export function MergeOutcomeProvider({
  value,
  children,
}: {
  value: ReadonlyMap<string, RowMergeOutcome>;
  children: ReactNode;
}) {
  return <MergeOutcomeContext.Provider value={value}>{children}</MergeOutcomeContext.Provider>;
}

/**
 * What a RELOAD still knows about one member of an approved set (MOTIR-5484) — the one
 * reading of `PullRequestApprovalMemberDTO` every surface shares, so the item page's frame
 * and the quick view cannot say different things about the same row (Bug MOTIR-5650).
 * `null` when there is nothing to report and the row keeps its CI pill.
 *
 * An exit nobody has put back (MOTIR-5635) outranks everything but a queued merge: it is the
 * newest thing that happened to the pull request. While the approval still covers its head
 * it reads *Left the queue* (a failure) or *Removed from the queue*; once a push moved it,
 * *New commits since approval*.
 */
export type PersistedRowOutcome =
  | 'queued'
  | 'leftQueue'
  | 'removedFromQueue'
  | 'newCommits'
  | 'notMergedYet'
  /** The host refused the merge, and the CLASS says a person can still act — a setting
   *  to change, then *Retry merge* (MOTIR-5833 · MOTIR-5834; § 28 panel 4). */
  | 'refusedSetting'
  /** The host refused, and the commits CANNOT land as they stand — a conflict, or red
   *  checks. No verb at all; `motir fix` is the way forward (§ 28 panel 3). */
  | 'cannotLand'
  /** A queue FAILURE, CAN'T-LAND since the FIFTH AMENDMENT — held, no verb (§ 31). */
  | 'failedHeld';

export function persistedRowOutcome(
  fact: Pick<
    PullRequestApprovalMemberDTO,
    'queued' | 'retryable' | 'exit' | 'exitAtApprovedHead' | 'refusal'
  >,
): PersistedRowOutcome | null {
  if (fact.queued) return 'queued';
  // ⚠️ THE HOST'S REFUSAL OUTRANKS AN OLDER EXIT (MOTIR-5833): it is the newest thing
  // that happened to this pull request, and before it was recorded a reload could not
  // say it happened at all.
  if (fact.refusal) {
    if (fact.refusal.landingClass === 'cant_land') return 'cannotLand';
    if (fact.refusal.landingClass === 'setting') return 'refusedSetting';
  }
  if (fact.exit && fact.exit.requeuedAt === null) {
    // The HEAD decides *New commits*, not whether a verb is offered: an exit at the
    // approved head may be unpressable (MOTIR-5802) and still *Left the queue*.
    if (!fact.exitAtApprovedHead) return 'newCommits';
    // ⚠️ THE CLASS DECIDES, NEVER THE REASON STRING (MOTIR-6596). A CAN'T-LAND exit cannot
    // land as it stands, whatever anybody approves (§4 FOURTH AMENDMENT, point 2), so the row
    // offers no retry: a conflict says *Cannot be merged*, and a queue FAILURE — can't-land
    // since the FIFTH AMENDMENT — keeps saying it *Left the queue*, held. The next
    // reclassification changes `queueExit.ts` and nothing here.
    if (classOfQueueExit(fact.exit) === 'cant_land') {
      return fact.exit.rawReason === 'MERGE_CONFLICT' ? 'cannotLand' : 'failedHeld';
    }
    return fact.exit.disposition === 'failure' ? 'leftQueue' : 'removedFromQueue';
  }
  if (fact.retryable) return 'notMergedYet';
  return null;
}

/** A persisted outcome with nothing to press — the READ-ONLY reading of every kind. */
const READ_ONLY: Record<PersistedRowOutcome, RowMergeOutcome> = {
  queued: { kind: 'queued' },
  leftQueue: { kind: 'leftQueue', onQueueAgain: null, queueing: false },
  removedFromQueue: { kind: 'removedFromQueue', onQueueAgain: null, queueing: false },
  newCommits: { kind: 'newCommits' },
  notMergedYet: { kind: 'notMergedYet', onRetry: null, retrying: false },
  refusedSetting: { kind: 'refusedSetting', onRetry: null, retrying: false },
  cannotLand: { kind: 'cannotLand' },
  failedHeld: { kind: 'failedHeld' },
};

/**
 * The READ-ONLY provider (Bug MOTIR-5650) — the quick view has no approval frame, and must
 * still show what a reload of the item page shows. It takes the members of an APPROVED gate
 * (the server reads none for any other state) and offers no Retry and no Queue again: the
 * peek has no verbs.
 */
export function PersistedMergeOutcomes({
  members,
  children,
}: {
  members: readonly PullRequestApprovalMemberDTO[];
  children: ReactNode;
}) {
  const value = new Map<string, RowMergeOutcome>();
  for (const fact of members) {
    const member = parseMemberVersion(fact.subjectVersion);
    const kind = member ? persistedRowOutcome(fact) : null;
    if (!member || !kind) continue;
    value.set(rowKey(member.repo, member.number), READ_ONLY[kind]);
  }
  if (value.size === 0) return <>{children}</>;
  return <MergeOutcomeProvider value={value}>{children}</MergeOutcomeProvider>;
}

/**
 * The state a row DRAWS (Bug MOTIR-12232): a row still delivered `open` whose press the host
 * answered `merged` is drawn **Merged**. The press outcome is the host's own answer, and it is
 * in the frame's client state the moment the press returns — before `router.refresh()` lands,
 * and before GitHub's merge delivery is processed. Read from the stored row, the state pill
 * said **Open** beside the slot's **Merged** for that whole window. Only `open` yields: a
 * `closed` or `merged` row is the host's later word and stands as delivered.
 */
export function useShownPullRequestState(
  repo: string,
  number: number,
  state: LinkedPullRequestDto['state'],
): LinkedPullRequestDto['state'] {
  const outcome = useContext(MergeOutcomeContext)?.get(rowKey(repo, number)) ?? null;
  return state === 'open' && outcome?.kind === 'merged' ? 'merged' : state;
}

/** The row's leading state glyph — a client leaf, so it follows the press (MOTIR-12232). */
export function PullRequestStateGlyph({
  repo,
  number,
  state,
}: {
  repo: string;
  number: number;
  state: LinkedPullRequestDto['state'];
}) {
  const Glyph = PR_STATE_META[useShownPullRequestState(repo, number, state)].icon;
  return <Glyph className="h-[17px] w-[17px] shrink-0 text-(--el-icon-muted)" aria-hidden />;
}

/** The row's state pill — a client leaf, so it follows the press (MOTIR-12232). */
export function PullRequestStatePill({
  repo,
  number,
  state,
}: {
  repo: string;
  number: number;
  state: LinkedPullRequestDto['state'];
}) {
  const t = useTranslations('github');
  const shown = useShownPullRequestState(repo, number, state);
  const meta = PR_STATE_META[shown];
  const Glyph = meta.icon;
  return (
    <Pill {...meta.pill}>
      <Glyph className="h-3 w-3" aria-hidden />
      {t(`development.prState.${shown}`)}
    </Pill>
  );
}

export function MergeOutcomeSlot({
  repo,
  number,
  merged,
  children,
}: {
  repo: string;
  number: number;
  /** The row was delivered merged: its state pill reads *Merged*, and the slot empties. */
  merged: boolean;
  /** What the slot shows with nothing to report — the row's CI pill. */
  children?: ReactNode;
}) {
  const t = useTranslations('approvalGate.pullRequestApproval.outcome');
  const outcome = useContext(MergeOutcomeContext)?.get(rowKey(repo, number)) ?? null;
  if (!outcome) return <>{children}</>;
  // ⚠️ A `merged` PRESS IS DRAWN BY THE STATE PILL, NEVER HERE (Bug MOTIR-12232). The row's
  // state pill reads *Merged* for it (`useShownPullRequestState`) — before the re-read and
  // before the host's delivery — so the slot empties exactly as it does for a row delivered
  // merged. Drawing it here too said *Merged* twice, or *Open · Merged* while the row was
  // still delivered open.
  if (merged || outcome.kind === 'merged') return null;

  switch (outcome.kind) {
    case 'merging':
      return (
        <Pill status="in-progress">
          <CircleEllipsis className="h-3 w-3" aria-hidden />
          {t('merging')}
        </Pill>
      );
    case 'queued':
      return (
        <Pill severity="warning">
          <Clock className="h-3 w-3" aria-hidden />
          {t('queued')}
        </Pill>
      );
    case 'refused':
    case 'notMergedYet':
      return (
        <>
          {outcome.kind === 'refused' ? (
            <Pill severity="danger">
              <CircleX className="h-3 w-3" aria-hidden />
              {t('refused')}
            </Pill>
          ) : (
            // Neutral, not rose: after a reload the reason is gone, and a red pill with no
            // reason beside it would assert a refusal the page can no longer explain.
            <Pill tone="neutral">
              <GitPullRequestArrow className="h-3 w-3" aria-hidden />
              {t('notMergedYet')}
            </Pill>
          )}
          {outcome.onRetry ? (
            <Button
              variant="secondary"
              size="sm"
              type="button"
              disabled={outcome.retrying}
              onClick={outcome.onRetry}
            >
              {t('retry')}
            </Button>
          ) : null}
        </>
      );
    case 'leftQueue':
    case 'removedFromQueue':
      return (
        <>
          {outcome.kind === 'leftQueue' ? (
            <Pill severity="danger">
              <CircleX className="h-3 w-3" aria-hidden />
              {t('leftQueue')}
            </Pill>
          ) : (
            <Pill tone="neutral">
              <CircleMinus className="h-3 w-3" aria-hidden />
              {t('removedFromQueue')}
            </Pill>
          )}
          {outcome.onQueueAgain ? (
            <Button
              variant="secondary"
              size="sm"
              type="button"
              disabled={outcome.queueing}
              onClick={outcome.onQueueAgain}
            >
              {t('queueAgain')}
            </Button>
          ) : null}
        </>
      );
    case 'newCommits':
      return (
        <Pill tone="neutral">
          <GitBranch className="h-3 w-3" aria-hidden />
          {t('newCommits')}
        </Pill>
      );
    case 'refusedSetting':
      return (
        <>
          {/* ⚠️ THE PILL SAYS THE CLASS; THE BAND SAYS WHICH SETTING (§ 28's slot table).
              A pill is read at a glance beside a pull request's name, and a permission
              string in it — *Blocked: contents: write* — reads as the row's own state
              rather than as something a person can go and change. The record band names
              the rule, in a sentence with room to say what to do about it. */}
          <Pill severity="warning">
            <ShieldAlert className="h-3 w-3" aria-hidden />
            {t('settingHeld')}
          </Pill>
          {outcome.onRetry ? (
            <Button
              variant="secondary"
              size="sm"
              type="button"
              disabled={outcome.retrying}
              onClick={outcome.onRetry}
            >
              {t('retry')}
            </Button>
          ) : null}
        </>
      );
    case 'failedHeld':
      // § 31 panel 1: § 22's pill, and NO *Queue again* beside it — the queue refused these
      // commits, so a press could only queue them to fail again. `motir fix` is below.
      return (
        <Pill severity="danger">
          <CircleX className="h-3 w-3" aria-hidden />
          {t('leftQueue')}
        </Pill>
      );
    case 'cannotLand':
      // No verb at all, deliberately: a button here would be guaranteed to fail, and
      // `motir fix` is offered by the block's own part below the rows.
      return (
        <Pill severity="danger">
          <CircleX className="h-3 w-3" aria-hidden />
          {t('cannotLand')}
        </Pill>
      );
  }
}
