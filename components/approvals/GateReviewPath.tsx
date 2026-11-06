'use client';

import type { ReactNode } from 'react';
import { AuthorNote } from '@/components/approvals/AuthorNote';
import { DismissReviewControl } from '@/components/approvals/DismissReview';
import { ReviewLine } from '@/components/approvals/ReviewLine';
import { SentBackBand } from '@/components/github/AgentReviewBand';
import { membersOf } from '@/lib/approvalGates/memberVersion';
import type { WorkItemRefMap } from '@/lib/dto/workItems';
import type { GateReviewPathDTO, ReviewLineDTO } from '@/lib/dto/reviewState';

// THE REVIEW PATH ON A GATE FRAME (Story MOTIR-10327 · MOTIR-10342; Bug MOTIR-10533;
// `design/github/design-notes.md` § 32.4, § 32.6, § 32.8, `approve-and-merge--review-path.mock.html`
// G1–G7). The two parts a gate in front of the card's merge draws of its agent review — the
// review line with the author note under it, and a gate-off send-back's Sent back band with
// Dismiss the review — composed ONCE, so the Development frame (the approve-and-merge gate,
// or a story run's acceptance leading it) and the overlay's acceptance port cannot draw two
// versions of the same review. Each host decides WHETHER it draws (the version and the
// gate's state are its facts); these only draw.

/**
 * THE REVIEW LINE (G1–G3, G7) and, for the routed author of every pull request, the AUTHOR
 * NOTE (G4) under it — handed the line the host has already decided belongs on its frame.
 */
export function GateReviewSummary({
  line,
  reviewPath,
  identifier,
}: {
  line: ReviewLineDTO;
  reviewPath: GateReviewPathDTO;
  identifier: string;
}) {
  return (
    <div className="mb-3 flex flex-col gap-2" data-review-summary="">
      <ReviewLine
        size="frame"
        line={line}
        identifier={identifier}
        recordRef={reviewPath.recordRef}
      />
      {reviewPath.viewerIsRouted && reviewPath.authorOfEveryPr ? <AuthorNote /> : null}
    </div>
  );
}

/**
 * A GATE-OFF SEND-BACK (G5) — a review RECORD, not a gate — in the shipped Sent back band,
 * with Dismiss the review under it for the routed person. Null when no send-back stands.
 */
export function GateReviewSentBack({
  reviewPath,
  identifier,
  findingsRefs,
  count,
  onDismissed,
}: {
  reviewPath: GateReviewPathDTO | null;
  identifier: string;
  /** The findings' card links, resolved for the reader (MOTIR-10023); `{}` when none were read. */
  findingsRefs: WorkItemRefMap;
  /** How many pull requests the send-back is about — the band's meta. */
  count: number;
  onDismissed: () => void;
}): ReactNode {
  const record = reviewPath?.sentBackRecord ?? null;
  if (!reviewPath || !record) return null;
  return (
    <>
      <SentBackBand
        findingsMd={record.findingsMd}
        findingsRefs={findingsRefs}
        run={null}
        decidedAt={record.at}
        count={count}
      />
      {reviewPath.viewerIsRouted && reviewPath.currentVersion ? (
        <div className="border-b border-(--el-border) px-3.5 py-2.5">
          <DismissReviewControl
            identifier={identifier}
            subjectVersion={reviewPath.currentVersion}
            onDismissed={onDismissed}
          />
        </div>
      ) : null}
    </>
  );
}

/**
 * THE REVIEW PATH IN A PORT WITH NO DEVELOPMENT FRAME — a story run's acceptance opened in
 * the approval overlay while no merge question awaits beside it (Bug MOTIR-10533), so the
 * port is the receipt alone. Above it: a standing gate-off send-back with Dismiss, then — on
 * an AWAITING gate only, as on the frame — the review line and the author note, all at the
 * story's CURRENT delivery-set version. Nothing draws for a story with no pull requests,
 * whose read model answers no version and so no line.
 */
export function GateReviewPathPort({
  reviewPath,
  awaiting,
  identifier,
  onDismissed,
}: {
  reviewPath: GateReviewPathDTO | null;
  awaiting: boolean;
  identifier: string;
  onDismissed: () => void;
}) {
  if (!reviewPath) return null;
  const line = awaiting && reviewPath.currentVersion !== null ? reviewPath.line : null;
  if (!line && !reviewPath.sentBackRecord) return null;
  return (
    <div data-review-path-port="">
      <GateReviewSentBack
        reviewPath={reviewPath}
        identifier={identifier}
        findingsRefs={{}}
        count={membersOf(reviewPath.currentVersion).length}
        onDismissed={onDismissed}
      />
      {line ? (
        <GateReviewSummary line={line} reviewPath={reviewPath} identifier={identifier} />
      ) : null}
    </div>
  );
}
