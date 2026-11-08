// THE PICK'S ONE-TIME SEND (story MOTIR-6069 · MOTIR-6435;
// `docs/decisions/picked-option-planning-starts.md` §2).
//
// A pick's yes STARTS the planning: the rail sends the seeded first turn for the
// person. "Once" is held at three layers, and this module is the middle one:
//
//  1. the SERVER — the overlay asks for a send only when the seed read reports no
//     session this gate already seeded (`seededSessionId` null); otherwise it
//     reopens that session and sends nothing;
//  2. THE PAGE — a gate is claimed here before its turn is sent, so a remount, a
//     second open of the same address or a re-render racing the first send's
//     response cannot send it again while this page lives;
//  3. THE COMPONENT — the rail's own ref, which absorbs a StrictMode double effect.
//
// A reload starts a fresh page and relies on layer 1 alone, by which point the
// first send has made the seeded session the read returns.

const claimed = new Set<string>();

/** Claim `gateId`'s one-time send. `true` exactly once per gate per page. */
export function claimPickAutoSend(gateId: string): boolean {
  if (claimed.has(gateId)) return false;
  claimed.add(gateId);
  return true;
}

/** Whether `gateId`'s send was already claimed on this page. */
export function pickAutoSendClaimed(gateId: string): boolean {
  return claimed.has(gateId);
}

/**
 * Give a claim back. Only for a send the person can press AGAIN after it failed —
 * the start prompt's Start (MOTIR-10624): a refused start returns the button to
 * live, and a claim that outlived the failure would make it a dead control. An
 * automatic send never releases: its failure puts the turn in the composer.
 */
export function releasePickAutoSend(gateId: string): void {
  claimed.delete(gateId);
}

/** Tests only: forget every claim, so each test starts on a fresh page. */
export function resetPickAutoSendClaimsForTests(): void {
  claimed.clear();
}
