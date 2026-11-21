'use client';

import type { MouseEvent } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ScanEye } from 'lucide-react';
import { buttonVariants } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { withApprovalOverlay } from '@/lib/approvals/overlayAddress';
import { shallowPush } from '@/lib/navigation/shallowUrl';
import type { ApprovalGateKindDTO } from '@/lib/dto/approvalGate';
import { useRelativeTime } from '@/lib/hooks/useRelativeTime';

/**
 * THE CALL-TO-ACTION BAND — `approval-cta.mock.html` panels 1, 2 and 5, flush in
 * the section card (`design/work-items/design-notes.md` § *Anatomy — the band,
 * flush in the section*). It takes primitives, not the gate: it shows a question
 * and opens the surface that answers it.
 *
 * ⚠️ SHARED BY KIND, NEVER COPIED (Story MOTIR-4949 · Subtask MOTIR-5790). It was
 * written inside `DesignResultSection` for the design gate; the acceptance gate's
 * section needs the SAME door (§ *The item page HANDS THE DECISION OVER* — a
 * decision is made in ONE place, the approval overlay), so the band moved here and
 * takes the KIND the overlay is opened on and the line naming what is being asked.
 * Nothing here can submit a `GateDecision`.
 */
export function GateCallToActionBand({
  kind,
  subjectLabel,
  askedAt,
  itemIdentifier,
  routedElsewhereName,
  body,
  buttonLabel,
}: {
  /** Which gate the overlay opens on. */
  kind: ApprovalGateKindDTO;
  /** What is being asked about, in the kind's own words (a version, a recording). */
  subjectLabel: string;
  askedAt: string;
  itemIdentifier: string;
  /** The routed recipient's name, when that is somebody other than the reader. */
  routedElsewhereName: string | null;
  /**
   * The band's sentence and its button, when the KIND words its question itself
   * (MOTIR-5896 — a choice is *Review & choose*, not *Review & approve*). Absent,
   * the shipped approve words.
   */
  body?: string;
  buttonLabel?: string;
}) {
  const t = useTranslations('approvalGate');
  const relativeTime = useRelativeTime();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // THE DOOR — the current page with the overlay's address added, so the
  // overlay opens OVER this card and its close strips exactly the two
  // parameters it added (`lib/approvals/overlayAddress.ts`).
  const qs = searchParams.toString();
  const href = withApprovalOverlay(`${pathname}${qs ? `?${qs}` : ''}`, {
    itemKey: itemIdentifier,
    kind,
  });

  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    // A modifier or non-primary click keeps its native meaning (the address in a
    // new tab), which is why the href is real — the To-approve row's condition.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
      return;
    event.preventDefault();
    // `shallowPush`, never `router.push`: the page underneath is already on
    // screen and the overlay reads its address client-side (CLAUDE.md § *URL
    // state the CLIENT reads*).
    shallowPush(href);
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {/* `suppressHydrationWarning`: a relative time is measured against the
            clock of whichever side renders it, and a minute can tick between the
            server's render and hydration. */}
        <span className="text-xs text-(--el-text-secondary)" suppressHydrationWarning>
          {subjectLabel}
          {' · '}
          {t('cta.asked', { when: relativeTime(new Date(askedAt)) })}
        </span>
        <span className="ml-auto">
          <Pill tone="awaiting">{t('state.awaitingYou')}</Pill>
        </span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-(--el-border-soft) pt-3">
        <span className="text-[13px] text-(--el-text-secondary)">
          {routedElsewhereName
            ? t.rich('cta.bodyRoutedElsewhere', {
                name: routedElsewhereName,
                person: (chunks) => <span className="font-medium text-(--el-text)">{chunks}</span>,
              })
            : (body ?? t('cta.body'))}
        </span>
        <Link
          href={href}
          onClick={onClick}
          aria-haspopup="dialog"
          data-variant="primary"
          className={`${buttonVariants({ variant: 'primary', size: 'sm' })} md:ml-auto`}
        >
          <ScanEye className="h-3.5 w-3.5" aria-hidden />
          <span>{buttonLabel ?? t('statusHeld.reviewAndApprove')}</span>
        </Link>
      </div>
    </div>
  );
}
