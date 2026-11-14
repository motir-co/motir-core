'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useInPlaceFindings } from '@/components/approvals/ReviewFindingsInPlace';
import { findingsHrefOf } from '@/lib/agentReview/verdictActivity';
import type { ReviewFindingsRefDto } from '@/lib/dto/agentReview';
import type { FixDetailDto, WorkItemFixReasonDto } from '@/lib/dto/fixReason';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';

// *FINDINGS AND CHECKLIST* ON A CARD THE REVIEW AGENT SENT BACK (MOTIR-11234;
// `design/workbench/design-notes.md` § 43) — the one link the Workbench's To fix row and the
// item page's To fix banner both draw, so the two cannot disagree about when it shows or
// what it opens.
//
// ⚠️ ONLY FOR THE REVIEW AGENT'S SEND-BACK, AND ONLY WHEN THE ROW KNOWS ITS REVIEW (§ 43.1,
// § 43.4): `changes_requested` on `agent_review` with a stored `reviewRef`. A person's Request
// changes, an acceptance Re-run, every other reason and a row stored before the ref existed
// draw nothing — no link to the Development frame stands in for it.
//
// ⚠️ IN PLACE, NEVER AWAY (§ 43.2). A plain primary click opens the shipped
// `ReviewFindingsDialog` over the page for exactly that review; a modified, middle or
// secondary click follows the `href` — the review's address on the card — as the review
// line's findings link does (`useInPlaceFindings`, scope `toFix`).

/** The review the link opens, or null when it draws nothing. */
export function sentBackFindingsRefOf(
  reason: WorkItemFixReasonDto | null,
  detail: FixDetailDto | null,
): ReviewFindingsRefDto | null {
  if (reason !== 'changes_requested' || detail?.gate !== 'agent_review') return null;
  return detail.reviewRef ?? null;
}

/** The Workbench row's form — the review line's findings link, class for class (§ 43.1). */
const ROW_LINK =
  'relative z-10 shrink-0 whitespace-nowrap text-(--el-link) underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none';

/** The banner's form — its own link form: `--el-link` is under AA on `--el-danger-surface`. */
const BANNER_LINK =
  'inline-flex w-fit items-center gap-1 font-sans text-[13px] font-medium text-(--el-text-strong) underline decoration-(--el-border-strong) underline-offset-2 hover:decoration-(--el-text-strong) focus-visible:rounded-(--radius-control) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none';

export function SentBackFindingsLink({
  identifier,
  title = null,
  reviewRef,
  variant,
}: {
  identifier: string;
  /** The card's title, when the surface knows it — the view's subtitle while it loads. */
  title?: string | null;
  reviewRef: ReviewFindingsRefDto;
  /** `row` on the Workbench To fix row, `banner` on the item page's To fix banner. */
  variant: 'row' | 'banner';
}) {
  const t = useTranslations('approvalGate.reviewPath.line');
  const routes = useReaderRoutes();
  const inPlace = useInPlaceFindings('toFix');
  // A ref always yields an address (`findingsHrefOf` is null only for a missing ref).
  const href = findingsHrefOf(routes.item(identifier), reviewRef) as string;
  return (
    <Link
      href={href}
      data-testid={`to-fix-findings-${identifier}`}
      className={variant === 'row' ? ROW_LINK : BANNER_LINK}
      aria-haspopup={inPlace ? 'dialog' : undefined}
      onClick={
        inPlace
          ? (event) => inPlace(event, { identifier, title, ref: reviewRef, earlier: false })
          : undefined
      }
    >
      {t('findings')}
    </Link>
  );
}
