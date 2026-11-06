'use client';

import { WorkItemBlockedTag, WorkItemStateTags } from '@/components/workItems/WorkItemStateTags';
import type { ExecutorDto, WorkItemKindDto, WorkItemTypeDto } from '@/lib/dto/workItems';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import { isReadyToStart } from '@/lib/workItems/statusSlot';
import { useDisplayedStatus } from './OptimisticStatusProvider';

// THE ITEM PAGE'S STATE TAGS (MOTIR-10534) — the canvas card's tag row in the
// header eyebrow, right after the identifier: the status slot (Done › To plan ›
// Ready › the status chip), the Manual chip, and the blocked flag when readiness
// says the item is blocked. So the page names the item's state the way the roadmap
// card, the board card and the quick view do.
//
// A client island because the status it draws is the PAGE's status channel
// (`useDisplayedStatus`): a decision taken on the page, or a status picked in the
// rail, repaints the eyebrow in the same frame as the rail rather than after the
// next server render.

export function ItemHeaderStateTags({
  item,
  statuses,
  hasChildren,
  unblocked,
}: {
  item: {
    kind: WorkItemKindDto;
    status: string;
    type: WorkItemTypeDto | null;
    executor: ExecutorDto | null;
  };
  /** The project's workflow — the displayed status's label and category. */
  statuses: readonly WorkflowStatusDto[];
  hasChildren: boolean;
  /** The readiness verdict: own blockers done and every ancestor ready. */
  unblocked: boolean;
}) {
  const status = useDisplayedStatus(item.status);
  const meta = statuses.find((s) => s.key === status);
  const statusCategory = meta?.category ?? null;
  return (
    <>
      <WorkItemStateTags
        item={{
          kind: item.kind,
          status,
          statusLabel: meta?.label ?? null,
          statusCategory,
          hasChildren,
          type: item.type,
          executor: item.executor,
        }}
        ready={isReadyToStart(statusCategory, unblocked)}
        blocked={!unblocked}
      />
      {unblocked ? null : <WorkItemBlockedTag />}
    </>
  );
}
