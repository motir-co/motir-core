'use client';

import { ReviewDoors } from '@/components/github/ReviewDoors';
import { useHostedRun } from './HostedRunProvider';

// THE REVIEW DOORS IN THE DEVELOPMENT FRAME'S REVIEW PART (Story MOTIR-11941 · MOTIR-11948;
// design `design/github` § 33.4).
//
// ⚠️ THE ITEM PAGE'S PLACEMENT OF THE SHARED DOORS, as `FixHostedDoor` / `FixInMyAgentDoor`
// place the fix part's. It is mounted only where `LateUpperSections` draws the Run hosted
// door (a viewer who may run the card), with *Review with Motir agent* — and *Review in my
// agent* only where the Run section's *Send to my agent* is (`agents`). The frame decides
// WHEN the doors show. A start, and a stale-page refusal, change a SERVER read (the review
// part, the marker, To approve) and a CLIENT island (the Run section's history), so both go
// through the provider's `notifyRunsChanged`.
export function ReviewDoorsDoor({ agents }: { agents: { projectName: string } | null }) {
  const door = useHostedRun();
  if (!door) return null;
  return (
    <ReviewDoors
      itemKey={door.itemKey}
      command={`motir review ${door.itemKey}`}
      hosted
      myAgent={agents}
      onStarted={door.notifyRunsChanged}
      onStateMoved={door.notifyRunsChanged}
    />
  );
}
