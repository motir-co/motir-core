'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { CircleDashed, SkipForward, Undo2, User } from 'lucide-react';
import { ReviewCommand } from '@/components/approvals/ReviewCommand';
import { ReviewedGlyph } from '@/components/approvals/ReviewedBadge';
import { useInPlaceFindings } from '@/components/approvals/ReviewFindingsInPlace';
import { cn } from '@/lib/utils/cn';
import { findingsHrefOf } from '@/lib/agentReview/verdictActivity';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';
import type { ReviewLineDTO, ReviewRecordRefDTO } from '@/lib/dto/reviewState';

// THE REVIEW LINE (Story MOTIR-10327 · MOTIR-10342; `design/github/design-notes.md` § 32.4,
// `approvals-row--review-path.mock.html` A1, `approve-and-merge--review-path.mock.html`
// G1–G3, G7). ONE presentational line, fed by the review state read model, drawn on every
// approve-and-merge row on To approve and in the gate frame — so the two cannot disagree.
//
// Four values, and the GitHub approvals BESIDE any of them after a divider:
//   Reviewed by agent · who · when — Findings and checklist
//   Review skipped by {name} — “reason”
//   Review dismissed by {name} — “reason”
//   Not reviewed by an agent — [Last reviewed at an earlier commit] the command chip
//
// ⚠️ EVIDENCE, NEVER A DECISION: its one verb is Copy. It computes nothing — a missing
// field draws nothing rather than a guess. Glyphs are decorative; the words carry the value.
// Secondary ink throughout (a row's hover fill is `--el-surface`, where muted fails AA).

const LINK =
  'relative z-10 text-(--el-link) underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none';
const GLYPH = 'h-3.5 w-3.5 shrink-0 text-(--el-icon-muted)';

export function ReviewLine({
  line,
  identifier,
  recordRef,
  title = null,
  size = 'row',
  className,
}: {
  line: ReviewLineDTO;
  identifier: string;
  /** The card's title — the in-place view's subtitle while its read loads. */
  title?: string | null;
  /** The answering pass — what *Findings and checklist* opens. */
  recordRef: ReviewRecordRefDTO | null;
  /** `row` on a To approve row (`text-xs`), `frame` in the gate frame (its META size). */
  size?: 'row' | 'frame';
  className?: string;
}) {
  const t = useTranslations('approvalGate.reviewPath.line');
  const tGate = useTranslations('approvalGate');
  const format = useFormatter();
  const routes = useReaderRoutes();
  const itemHref = routes.item(identifier);
  const b = (chunks: ReactNode) => <b className="font-semibold text-(--el-text)">{chunks}</b>;
  const nameOf = (person: { name: string | null } | null) => person?.name ?? tGate('theAssignee');
  // ON THE WORKBENCH the two findings links open the review IN PLACE (MOTIR-10460; § 42.3):
  // a plain primary click opens the view, any other click keeps the card link.
  const inPlace = useInPlaceFindings();
  const findingsLink = (href: string, ref: ReviewRecordRefDTO, earlier: boolean, label: string) => (
    <Link
      href={href}
      className={LINK}
      aria-haspopup={inPlace ? 'dialog' : undefined}
      onClick={inPlace ? (e) => inPlace(e, { identifier, title, ref, earlier }) : undefined}
    >
      {label}
    </Link>
  );

  let glyph: ReactNode;
  let body: ReactNode;
  switch (line.value) {
    case 'reviewed_by_agent': {
      const reviewer = line.reviewer;
      const who = !reviewer
        ? t('whoHosted')
        : reviewer.kind === 'hosted'
          ? t('whoHosted')
          : t('whoOwn', { name: nameOf(reviewer.person), harness: reviewer.harness });
      const when = line.at ? format.relativeTime(new Date(line.at)) : '';
      const findings = findingsHrefOf(itemHref, recordRef);
      glyph = <ReviewedGlyph className="text-(--el-icon-muted)" />;
      body = (
        <>
          <span>{t.rich('reviewed', { b, who, when })}</span>
          {findings && recordRef ? findingsLink(findings, recordRef, false, t('findings')) : null}
        </>
      );
      break;
    }
    case 'review_skipped':
      glyph = <SkipForward className={GLYPH} aria-hidden />;
      body = (
        <span>{t.rich('skipped', { b, name: nameOf(line.actor), reason: line.reason ?? '' })}</span>
      );
      break;
    case 'review_dismissed':
      glyph = <Undo2 className={GLYPH} aria-hidden />;
      body = (
        <span>
          {t.rich('dismissed', { b, name: nameOf(line.actor), reason: line.reason ?? '' })}
        </span>
      );
      break;
    case 'not_reviewed': {
      const earlier = line.lastReviewedVersion
        ? findingsHrefOf(itemHref, line.lastReviewedRef)
        : null;
      glyph = <CircleDashed className={GLYPH} aria-hidden />;
      body = (
        <>
          <span>{t.rich('notReviewed', { b })}</span>
          {earlier && line.lastReviewedRef
            ? findingsLink(earlier, line.lastReviewedRef, true, t('earlier'))
            : null}
          {line.command ? (
            <span className="relative z-10">
              <ReviewCommand command={line.command} identifier={identifier} />
            </span>
          ) : null}
        </>
      );
      break;
    }
  }

  const logins = [...new Set(line.githubApprovals.map((a) => `@${a.login}`))];

  return (
    <div
      role="group"
      aria-label={t('label')}
      data-review-line={line.value}
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-(--el-text-secondary)',
        size === 'row' ? 'text-xs' : 'text-[12.5px]',
        className,
      )}
    >
      <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {glyph}
        {body}
      </span>
      {logins.length > 0 ? (
        <span
          data-review-github=""
          className="inline-flex items-center gap-2 border-l border-(--el-border) pl-2"
        >
          <User className={GLYPH} aria-hidden />
          <span>{t.rich('github', { b, logins: logins.join(', ') })}</span>
        </span>
      ) : null}
    </div>
  );
}
