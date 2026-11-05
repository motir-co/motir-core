'use client';

import { useState } from 'react';
import type { PrMergeModeValue } from '@/lib/dto/projects';
import type { ReviewAgentSourceValue } from '@/lib/dto/approvalGateSettings';
import { PrMergeModeCard } from './PrMergeModeCard';
import { ReviewAgentCard } from './ReviewAgentCard';

// The two Approvals cards that EXCLUDE each other (`docs/decisions/approval-gates.md`
// §12.2a · MOTIR-6823): the review agent and *Merge automatically* cannot both be
// on. Each card still owns its own optimistic value; this island only MIRRORS the
// value each one shows, so choosing a mode re-renders the review-agent card and
// flipping the switch re-renders the merge-mode card — without a reload (the
// page-state contract, case 3: `router.refresh()` could not reach either island).
// The review source and bot posting (MOTIR-10337) are seeded straight through to
// the review-agent card: the exclusion reads the switch, never the source.

export interface MergeModeAndReviewAgentCardsProps {
  projectKey: string;
  initialPrMergeMode: PrMergeModeValue;
  initialReviewAgentEnabled: boolean;
  initialReviewAgentSource?: ReviewAgentSourceValue;
  initialReviewBotPostsEnabled?: boolean;
}

export function MergeModeAndReviewAgentCards({
  projectKey,
  initialPrMergeMode,
  initialReviewAgentEnabled,
  initialReviewAgentSource = 'hosted',
  initialReviewBotPostsEnabled = true,
}: MergeModeAndReviewAgentCardsProps) {
  const [prMergeMode, setPrMergeMode] = useState(initialPrMergeMode);
  const [reviewAgentEnabled, setReviewAgentEnabled] = useState(initialReviewAgentEnabled);

  return (
    <>
      <PrMergeModeCard
        projectKey={projectKey}
        initialMode={initialPrMergeMode}
        reviewAgentEnabled={reviewAgentEnabled}
        onModeChange={setPrMergeMode}
      />
      <ReviewAgentCard
        projectKey={projectKey}
        initialEnabled={initialReviewAgentEnabled}
        initialSource={initialReviewAgentSource}
        initialBotPostsEnabled={initialReviewBotPostsEnabled}
        prMergeMode={prMergeMode}
        onEnabledChange={setReviewAgentEnabled}
      />
    </>
  );
}
