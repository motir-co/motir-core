'use client';

import {
  ContinueHostedAnswer,
  ContinueHostedButtonRow,
} from '@/components/hosted/ContinueHostedControl';
import { useHostedRun } from './HostedRunProvider';

// THE CONTINUE HOSTED DOOR (Story MOTIR-6527 · MOTIR-6796), built to
// `design/runs/design-notes.md` § Continue hosted, Panels C1–C5
// (`design/runs/development--continue-hosted.mock.html`, approved on MOTIR-6789).
//
// ⚠️ THE ITEM PAGE'S PLACEMENT OF THE SHARED CONTROL (MOTIR-6879). The markup is
// `components/hosted/ContinueHostedControl`'s; what this file adds is where the page
// puts its two halves — the door in the Development block's continue part, its
// answers beside it — and the provider's press, which the Run section's refresh
// shares. Where the door is offered stays the provider's decision (`continueTarget`).

/** The picker and the button — the part's primary action (C1–C3, C4a). */
export function ContinueHostedDoor() {
  const door = useHostedRun();
  if (!door || !door.continueTarget) return null;
  return (
    <ContinueHostedButtonRow
      continueTarget={door.continueTarget}
      itemKey={door.itemKey}
      starting={door.continueStarting}
      onPress={() => void door.startContinue()}
      refused={door.continueRefusal?.kind === 'noCapacity'}
    />
  );
}

/** What the door answered — kept after the part re-reads its view (C5a). */
export function ContinueHostedNotice() {
  const door = useHostedRun();
  if (!door) return null;
  return (
    <ContinueHostedAnswer
      continueTarget={door.continueTarget}
      refusal={door.continueRefusal}
      viewerId={door.viewerId}
    />
  );
}
