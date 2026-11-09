import type { ApprovalGate, Prisma, ReviewVerdictRecord } from '@/generated/prisma/client';
import { deliveryMemberVersion, deliverySetVersion } from '@/lib/approvalGates/deliverySetVersion';
import { membersOf } from '@/lib/approvalGates/memberVersion';
import { liveCheckRows } from '@/lib/github/checkSuites';
import { foldHeadCheckRows } from '@/lib/github/prCiState';
import { pullRequestHead } from '@/lib/github/pullRequestHead';
import type { WorkItemDeliveryWithChecks } from '@/lib/repositories/workItemDeliveryRepository';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { reviewDismissalRepository } from '@/lib/repositories/reviewDismissalRepository';
import { reviewVerdictRecordRepository } from '@/lib/repositories/reviewVerdictRecordRepository';
import { standingMergeRefusalOf } from '@/lib/workItems/fixReason';

// A CODE REVIEW SENT BACK, STILL STANDING (Story MOTIR-1626 · MOTIR-6822;
// `approval-gates.md` §12.4 and §12.7).
//
// A card is SENT BACK when a review of its delivery set asked for changes — the review
// agent's `changes_requested` on `agent_review`, or a person's *Request changes* on the
// approve-and-merge gate — and nothing has answered it yet. Two readers ask this, and
// both read THIS function so they cannot drift:
//
//   · the REPAIR claim — a standing refusal is the `review` repair class, served by
//     `motir fix <KEY>` even though the card's checks are green;
//   · the To fix column — the same refusal derives `changes_requested`
//     (`fixReasonService`), whose repair is `fix` for both gate kinds.
//
// The RULE is `standingMergeRefusalOf`'s — the card's latest DECIDED gate of any kind,
// a refusal on one of the two review kinds, about the members' CURRENT heads. A push is
// the answer to a refusal: it moves a head, the version no longer matches, and from that
// commit on the card waits on CI (and, with the switch on, on a fresh review).

/**
 * A standing review refusal — the review that sent the card back, and the version it is
 * about. Either a DECIDED GATE (`gateId` set) or, since MOTIR-10333, a GATE-OFF agent
 * send-back stored as a review verdict record (`recordId` set; `approval-gates.md` §12.14).
 */
export interface StandingReviewRefusal {
  kind: 'agent_review' | 'pull_request_approval';
  /** The decided gate, or null for a gate-off record. */
  id: string | null;
  /** The review verdict record, or null for a decided gate. */
  recordId: string | null;
  subjectVersion: string | null;
  /** The findings — the gate's note, or the record's findings. */
  noteMd: string | null;
  decidedById: string | null;
  decidedByLabel: string | null;
  decidedUnderAuthority: ApprovalGate['decidedUnderAuthority'];
  decidedAt: Date;
}

/**
 * The card's standing review refusal, or null. `deliveries` is the card's WHOLE delivery
 * set (merged and closed rows included) as `listByWorkItemWithChecks` reads it — the set
 * whose version the refusal was stamped with.
 *
 * ⚠️ TWO SOURCES, THE NEWER WINS (MOTIR-10333; §12.14). The decided gate is read as
 * before; a gate-off send-back record at the CURRENT version is the second source — the
 * review agent sent the card back with the switch off, so no gate holds the refusal. When
 * both stand at the current version the later one is the card's latest word.
 *
 * ⚠️ A DISMISSED AGENT SEND-BACK DOES NOT STAND (MOTIR-10334; §12.15). A dismissal at the
 * current version removes the review AGENT's refusal from both sources; a person's own
 * *Request changes* on the approve-and-merge gate is never dismissed by it. This is the one
 * predicate the To fix derivation, the repair claim and the dismissal itself read.
 */
export async function readStandingReviewRefusal(
  workItemId: string,
  deliveries: readonly WorkItemDeliveryWithChecks[],
  tx: Prisma.TransactionClient,
): Promise<StandingReviewRefusal | null> {
  const currentVersion = deliverySetVersion(deliveries.map((d) => deliveryMemberVersion(d)));
  const [latest, record, dismissal] = await Promise.all([
    approvalGateRepository.findLatestDecidedByWorkItem(workItemId, tx),
    currentVersion === null
      ? Promise.resolve(null)
      : reviewVerdictRecordRepository.findRecordedSendBackAt(workItemId, currentVersion, tx),
    currentVersion === null
      ? Promise.resolve(null)
      : reviewDismissalRepository.findAt(workItemId, currentVersion, tx),
  ]);
  return standingReviewRefusalFrom({
    latest,
    record,
    dismissed: dismissal !== null,
    currentVersion,
  });
}

/**
 * THE RULE ITSELF, over rows already read — {@link readStandingReviewRefusal}'s answer for a
 * caller that reads many cards at once (the review state read model, MOTIR-10340), so the
 * batch reader and the per-card one are the same predicate rather than two copies of it.
 *
 * `latest` is the card's latest DECIDED gate of any kind; `record` its gate-off agent
 * send-back at the CURRENT version (`outcome: 'recorded'`, `verdict: 'changes_requested'`),
 * or null; `dismissed` whether a dismissal stands at the current version.
 */
export function standingReviewRefusalFrom(facts: {
  latest: ApprovalGate | null;
  record: Pick<
    ReviewVerdictRecord,
    'id' | 'subjectVersion' | 'findingsMd' | 'submittedById' | 'createdAt'
  > | null;
  dismissed: boolean;
  currentVersion: string | null;
}): StandingReviewRefusal | null {
  const { latest, record, dismissed, currentVersion } = facts;
  const gate =
    latest &&
    standingMergeRefusalOf(latest, currentVersion) &&
    !(dismissed && latest.kind === 'agent_review')
      ? {
          kind: latest.kind as StandingReviewRefusal['kind'],
          id: latest.id,
          recordId: null,
          subjectVersion: latest.subjectVersion,
          noteMd: latest.noteMd,
          decidedById: latest.decidedById,
          decidedByLabel: latest.decidedByLabel,
          decidedUnderAuthority: latest.decidedUnderAuthority,
          // `findLatestDecidedByWorkItem` reads only rows whose `decidedAt` is set.
          decidedAt: latest.decidedAt as Date,
        }
      : null;
  const sentBack: StandingReviewRefusal | null =
    record && !dismissed
      ? {
          kind: 'agent_review',
          id: null,
          recordId: record.id,
          subjectVersion: record.subjectVersion,
          noteMd: record.findingsMd,
          decidedById: record.submittedById,
          decidedByLabel: null,
          decidedUnderAuthority: 'review_agent',
          decidedAt: record.createdAt,
        }
      : null;
  if (gate && sentBack) return gate.decidedAt > sentBack.decidedAt ? gate : sentBack;
  return gate ?? sentBack;
}

/**
 * The card's review refusal that a PUSH ANSWERED — the review that sent the card back, still
 * the card's latest review word, about a version the delivery set has since moved off — with
 * the head it recorded for each member that is still on the card. Null when the latest word is
 * not a refusal, when that refusal still stands at the current version
 * ({@link readStandingReviewRefusal} answers that one), or when a dismissal at its version
 * took the review agent's refusal back.
 *
 * ⚠️ WHY IT EXISTS (Bug MOTIR-10733). The Fixing rule (MOTIR-10307) keeps the card's PRIOR
 * stored answer while CI runs on a pushed fix — and a stored answer is only as good as the
 * last recompute. GitHub delivers a push's checks one webhook at a time, in no order, so a
 * quick success at the new head (a fast lint job, Motir's own link check) can land before any
 * running check is recorded there. That recompute reads the new head as green, the refusal no
 * longer stands, and the card stores nothing to fix — after which no later recompute had a
 * prior to keep, and the card showed no Fixing for its whole CI run. This read is the durable
 * half: the refusal rows themselves, so the next recompute that sees CI running at a moved head
 * finds the refusal again, however the events before it were ordered.
 *
 * ⚠️ THE SAME TWO SOURCES AS THE STANDING READ, THE NEWER WINS: the card's latest DECIDED gate
 * of any kind (a refusal only when it is a review kind's `changes_requested`), and its newest
 * gate-off agent send-back record, answered by a later recorded pass or a later decided gate.
 */
export async function readAnsweredReviewRefusal(
  workItemId: string,
  deliveries: readonly WorkItemDeliveryWithChecks[],
  tx: Prisma.TransactionClient,
): Promise<AnsweredReviewRefusal | null> {
  const currentVersion = deliverySetVersion(deliveries.map((d) => deliveryMemberVersion(d)));
  const [latest, record] = await Promise.all([
    approvalGateRepository.findLatestDecidedByWorkItem(workItemId, tx),
    reviewVerdictRecordRepository.findLatestRecordedSendBack(workItemId, tx),
  ]);
  const [passAfterRecord, dismissedRecord, dismissedGate] = await Promise.all([
    record
      ? reviewVerdictRecordRepository.hasAnsweringPassAfter(workItemId, record.createdAt, tx)
      : Promise.resolve(false),
    record
      ? reviewDismissalRepository.findAt(workItemId, record.subjectVersion, tx)
      : Promise.resolve(null),
    latest?.kind === 'agent_review' && latest.subjectVersion
      ? reviewDismissalRepository.findAt(workItemId, latest.subjectVersion, tx)
      : Promise.resolve(null),
  ]);
  return answeredReviewRefusalFrom({
    latest,
    record,
    passAfterRecord,
    recordDismissed: dismissedRecord !== null,
    gateDismissed: dismissedGate !== null,
    currentVersion,
    deliveries,
  });
}

/** {@link readAnsweredReviewRefusal}'s answer: the refusal, and the heads it was about. */
export type AnsweredReviewRefusal = StandingReviewRefusal & {
  subjectVersion: string;
  /** The head the refusal's version recorded for each member still on the card. */
  raisedHeads: Record<string, string>;
};

/**
 * THE RULE ITSELF, over rows already read — {@link readAnsweredReviewRefusal}'s answer, split
 * out as {@link standingReviewRefusalFrom} is so the rule is a pure function of its facts.
 *
 * `latest` is the card's latest DECIDED gate of any kind; `record` its newest gate-off agent
 * send-back, whatever its version; `passAfterRecord` whether a recorded or decided pass came
 * after that record; the two `…Dismissed` flags whether a dismissal stands at the record's and
 * at the gate's version (a dismissal takes back only the review AGENT's refusal).
 */
export function answeredReviewRefusalFrom(facts: {
  latest: ApprovalGate | null;
  record: Pick<
    ReviewVerdictRecord,
    'id' | 'subjectVersion' | 'findingsMd' | 'submittedById' | 'createdAt'
  > | null;
  passAfterRecord: boolean;
  recordDismissed: boolean;
  gateDismissed: boolean;
  currentVersion: string | null;
  deliveries: readonly Pick<WorkItemDeliveryWithChecks, 'pullRequest' | 'repo'>[];
}): AnsweredReviewRefusal | null {
  const { latest, record, currentVersion } = facts;
  // A gate-off send-back is the latest word unless a pass or a decided REVIEW gate came after
  // it. A later gate of another kind (acceptance, design) is no review word, so it hides
  // nothing — the standing read's rule (`standingReviewRefusalFrom`), not a second one.
  const laterReviewGate =
    latest !== null &&
    isReviewKind(latest.kind) &&
    latest.decidedAt !== null &&
    record !== null &&
    latest.decidedAt > record.createdAt;
  const recordIsLatest = record !== null && !facts.passAfterRecord && !laterReviewGate;
  let word: StandingReviewRefusal | null = null;
  if (recordIsLatest) {
    if (facts.recordDismissed) return null;
    word = {
      kind: 'agent_review',
      id: null,
      recordId: record.id,
      subjectVersion: record.subjectVersion,
      noteMd: record.findingsMd,
      decidedById: record.submittedById,
      decidedByLabel: null,
      decidedUnderAuthority: 'review_agent',
      decidedAt: record.createdAt,
    };
  } else if (
    latest &&
    isReviewKind(latest.kind) &&
    latest.state === 'changes_requested' &&
    !(facts.gateDismissed && latest.kind === 'agent_review')
  ) {
    word = {
      kind: latest.kind,
      id: latest.id,
      recordId: null,
      subjectVersion: latest.subjectVersion,
      noteMd: latest.noteMd,
      decidedById: latest.decidedById,
      decidedByLabel: latest.decidedByLabel,
      decidedUnderAuthority: latest.decidedUnderAuthority,
      // `findLatestDecidedByWorkItem` reads only rows whose `decidedAt` is set.
      decidedAt: latest.decidedAt as Date,
    };
  }
  // Still standing at the current version is the standing read's, not this one's.
  if (word?.subjectVersion == null || word.subjectVersion === currentVersion) return null;
  const raisedHeads = headsInVersion(word.subjectVersion, facts.deliveries);
  // A fix that already PROVED GREEN answered it for good: a later push is not a fix for it.
  if (provedGreenSince(word.decidedAt, raisedHeads, facts.deliveries)) return null;
  return { ...word, subjectVersion: word.subjectVersion, raisedHeads };
}

const isReviewKind = (kind: ApprovalGate['kind']): kind is StandingReviewRefusal['kind'] =>
  kind === 'agent_review' || kind === 'pull_request_approval';

/**
 * Whether CI already decided GREEN on a commit pushed after the refusal — a commit that is
 * neither the head the refusal was about nor the head the member is at now.
 *
 * ⚠️ WHY (review of MOTIR-10733). The refusal stays the card's latest review word until a
 * newer review lands, and its recorded heads are the REVIEWED ones, so without this bound
 * every later push — a main merge, an *Update branch* — read as a moved head and put a card
 * whose fix had already passed back on To fix, Fixing, with findings it had answered. The fix
 * push is the one Fixing is for (MOTIR-10305); once its CI went green, the stored answer was
 * rightly nothing, and a later push keeps it so. Check rows of older commits are kept, so the
 * proof is read from them: a commit FIRST SEEN after the refusal was decided (a commit from
 * before it — the one CI passed before the review — proves nothing), folding to passing.
 *
 * A commit that went green on a PARTIAL set of checks before the next push reads as proved:
 * the same ambiguity the quick-green read itself has, and it errs toward no tag.
 */
export function provedGreenSince(
  decidedAt: Date,
  raisedHeads: Record<string, string>,
  deliveries: readonly Pick<WorkItemDeliveryWithChecks, 'pullRequest'>[],
): boolean {
  for (const { pullRequest } of deliveries) {
    const reviewed = raisedHeads[pullRequest.id];
    if (reviewed === undefined) continue;
    const head = pullRequestHead(pullRequest);
    const byCommit = new Map<string, typeof pullRequest.checkRuns>();
    for (const row of pullRequest.checkRuns) {
      if (row.commitSha === reviewed || row.commitSha === head) continue;
      byCommit.set(row.commitSha, [...(byCommit.get(row.commitSha) ?? []), row]);
    }
    for (const rows of byCommit.values()) {
      const firstSeen = Math.min(...rows.map((r) => r.createdAt.getTime()));
      if (firstSeen <= decidedAt.getTime()) continue;
      if (foldHeadCheckRows(liveCheckRows(rows)) === 'passing') return true;
    }
  }
  return false;
}

/**
 * The head a set `version` recorded for each of `deliveries`, keyed by pull-request id — only
 * the members the version names. Members are read with `membersOf`, the one parser of the
 * spelling, and matched on repository and number.
 */
export function headsInVersion(
  version: string,
  deliveries: readonly Pick<WorkItemDeliveryWithChecks, 'pullRequest' | 'repo'>[],
): Record<string, string> {
  const members = membersOf(version);
  const heads: Record<string, string> = {};
  for (const delivery of deliveries) {
    const repo = `${delivery.repo.owner}/${delivery.repo.name}`;
    const member = members.find((m) => m.repo === repo && m.number === delivery.pullRequest.number);
    if (member) heads[delivery.pullRequest.id] = member.headSha;
  }
  return heads;
}
