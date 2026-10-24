import { expect } from 'vitest';
import type { WorkItemTransitionedData } from '@/lib/jobs/types';
import { adminDb } from './adminDb';

// THE HOPS A GATE DECISION WROTE, AND THE EVENTS IT OWES FOR THEM (Bug MOTIR-9415).
//
// Read off `job_event`, where the real `sendEvent` writes them — a suite that stubs
// `sendEvent` records nothing there — and off the status revisions, which are what a
// hop IS. Only what `act` adds is judged: a fixture's own setup moves are not the
// decision's, and some of them are written by paths that emit nothing on purpose.

interface Hop {
  revisionId: string;
  fromStatusKey: string;
  toStatusKey: string;
}

/** Every `work-item/transitioned` event recorded for one work item, in no order. */
export async function transitionedEventsFor(
  workItemId: string,
): Promise<WorkItemTransitionedData[]> {
  const rows = await adminDb.jobEvent.findMany({
    where: { name: 'work-item/transitioned', data: { path: ['workItemId'], equals: workItemId } },
  });
  return rows.map((row) => row.data as unknown as WorkItemTransitionedData);
}

async function statusHopsFor(workItemId: string): Promise<Hop[]> {
  const rows = await adminDb.workItemRevision.findMany({ where: { workItemId } });
  return rows.flatMap((row) => {
    const diff = row.diff as { status?: { from?: string; to?: string } } | null;
    return diff?.status?.from && diff.status.to
      ? [{ revisionId: row.id, fromStatusKey: diff.status.from, toStatusKey: diff.status.to }]
      : [];
  });
}

const byRevision = (a: { revisionId: string }, b: { revisionId: string }) =>
  a.revisionId.localeCompare(b.revisionId);

/**
 * Run `act` and assert that every status hop it wrote on `workItemId` was announced by
 * exactly one `work-item/transitioned` carrying `updateStatus`'s payload, and that it
 * announced nothing else. Compared as sets: hops written in one transaction share a
 * timestamp, so no order is recorded. Returns what `act` returned and the hops it wrote
 * (`[]` for a decision that moved nothing).
 */
export async function expectEachHopAnnounced<T>(
  workItemId: string,
  { workspaceId, actorId }: { workspaceId: string; actorId: string },
  act: () => Promise<T>,
): Promise<{ result: T; hops: Array<Omit<Hop, 'revisionId'>> }> {
  const [eventsBefore, hopsBefore] = await Promise.all([
    transitionedEventsFor(workItemId),
    statusHopsFor(workItemId),
  ]);
  const result = await act();
  const [eventsAfter, hopsAfter] = await Promise.all([
    transitionedEventsFor(workItemId),
    statusHopsFor(workItemId),
  ]);
  const seenEvents = new Set(eventsBefore.map((event) => event.revisionId));
  const seenHops = new Set(hopsBefore.map((hop) => hop.revisionId));
  const events = eventsAfter.filter((event) => !seenEvents.has(event.revisionId));
  const hops = hopsAfter.filter((hop) => !seenHops.has(hop.revisionId));
  expect(events.sort(byRevision)).toEqual(
    hops.sort(byRevision).map((hop) => ({ workspaceId, workItemId, actorId, ...hop })),
  );
  return {
    result,
    hops: hops.map(({ fromStatusKey, toStatusKey }) => ({ fromStatusKey, toStatusKey })),
  };
}
