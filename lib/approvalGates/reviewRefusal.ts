import type { ApprovalGate, Prisma } from '@/generated/prisma/client';
import { deliveryMemberVersion, deliverySetVersion } from '@/lib/approvalGates/deliverySetVersion';
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
  const dismissed = dismissal !== null;
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
