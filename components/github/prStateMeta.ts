import type { ComponentType } from 'react';
import { GitMerge, GitPullRequestArrow, GitPullRequestClosed } from 'lucide-react';
import type { PillProps } from '@/components/ui/Pill';
import type { LinkedPullRequestDto } from '@/lib/dto/github';

// THE PULL-REQUEST STATE VOCABULARY — glyph + Pill tone per state. It lived inside
// `DevelopmentSection.tsx`; it moved here (Bug MOTIR-12232) because the row's state mark
// is now drawn by a CLIENT leaf (`MergeOutcomeSlot.tsx`'s `PullRequestStatePill`), which
// must not import the server-rendered section. `DevelopmentSection` re-exports it, so the
// explicit-link picker's option pills (MOTIR-1596) still read the one mapping.

type PillTone = Pick<PillProps, 'status' | 'severity'>;

/** State → glyph + Pill tone (the design's tone table), shared by the linked-PR
 *  rows AND the explicit-link picker's option pills (MOTIR-1596) so both
 *  read from ONE mapping — no new token/variant. */
export const PR_STATE_META: Record<
  LinkedPullRequestDto['state'],
  { icon: ComponentType<{ className?: string }>; pill: PillTone }
> = {
  open: { icon: GitPullRequestArrow, pill: { status: 'in-progress' } },
  merged: { icon: GitMerge, pill: { status: 'done' } },
  closed: { icon: GitPullRequestClosed, pill: { severity: 'danger' } },
};
