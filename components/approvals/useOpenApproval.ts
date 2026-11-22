'use client';

import { useCallback } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { shallowPush } from '@/lib/navigation/shallowUrl';
import { withApprovalOverlay } from '@/lib/approvals/overlayAddress';
import type { ApprovalGateKindDTO } from '@/lib/dto/approvalGate';

/**
 * Open a row's approval over the page the list is on.
 *
 * The host page's own query — the tab, the page of the list — is kept, so the
 * overlay's close lands back on exactly it. Shared by the approval rows and the
 * review-to-run row (Bug MOTIR-11983), so every To approve row opens one way.
 */
export function useOpenApproval(): (row: {
  workItem: { identifier: string };
  kind: ApprovalGateKindDTO;
}) => void {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return useCallback(
    (row) => {
      const qs = searchParams.toString();
      shallowPush(
        withApprovalOverlay(`${pathname}${qs ? `?${qs}` : ''}`, {
          itemKey: row.workItem.identifier,
          kind: row.kind,
        }),
      );
    },
    [pathname, searchParams],
  );
}
