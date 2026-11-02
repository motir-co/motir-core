import { getFormatter } from 'next-intl/server';

import type { PlanSessionRowDto } from '@/lib/dto/planSessions';

import type { SessionRowView } from './_components/types';

// Server-side view-model builder for the Plans SESSION list (MOTIR-6025). Shared
// by the page's first render AND the load-more action, so a streamed page renders
// identically to the first. It adds what the row needs that the DTO does not
// carry — times formatted on the server — and settles the title.

type Formatter = Awaited<ReturnType<typeof getFormatter>>;

/** An END time (MOTIR-7634's rule): the short time when it is today, otherwise
 *  the short date; the full date-time always rides `title`. */
function endTime(format: Formatter, iso: string, now: Date) {
  const at = new Date(iso);
  const day = (d: Date) =>
    format.dateTime(d, { year: 'numeric', month: 'numeric', day: 'numeric' });
  return {
    timeLabel:
      day(at) === day(now)
        ? format.dateTime(at, { hour: '2-digit', minute: '2-digit' })
        : format.dateTime(at, { month: 'short', day: 'numeric' }),
    fullLabel: format.dateTime(at, { dateStyle: 'medium', timeStyle: 'short' }),
  };
}

export async function buildSessionRowViews(
  sessions: PlanSessionRowDto[],
  /** The reader — an end line they caused says *you*. Null for a Visitor. */
  viewerId: string | null,
): Promise<SessionRowView[]> {
  const format = await getFormatter();
  const now = new Date();
  return sessions.map((session) => ({
    id: session.id,
    origin: session.origin,
    // What was asked; a session opened without a turn (an agent's, a
    // generation's, a backfilled one) is known by its latest plan instead
    // (§19.2, MOTIR-6025 AC 1).
    title: session.firstTurn ?? session.latestPlan?.title ?? '',
    targetKeys: session.targetKeys,
    activeLabel: format.relativeTime(new Date(session.lastActivityAt)),
    startedByName: session.startedBy?.name ?? null,
    latestPlan: session.latestPlan
      ? { id: session.latestPlan.id, status: session.latestPlan.status }
      : null,
    planCount: session.planCount,
    state: session.state,
    failure: session.failure
      ? {
          // A row that reads `waiting` stopped mid-WALK; one that reads its plan's own state
          // (`planned` / `stale`) failed a CHANGE to that plan (design § _The Plans page_).
          kind: session.state === 'waiting' ? 'walk' : 'change',
          reason: session.failure.reason,
          stopPhase: session.failure.stopPhase,
          stopTitle: session.failure.stopTitle,
          notPlannedYet: session.failure.notPlannedYet ?? [],
          timeLabel: format.relativeTime(new Date(session.failure.failedAt)),
          fullLabel: format.dateTime(new Date(session.failure.failedAt), {
            dateStyle: 'medium',
            timeStyle: 'short',
          }),
        }
      : null,
    end:
      session.endedAt && session.endReason
        ? {
            reason: session.endReason,
            ...endTime(format, session.endedAt, now),
            endedByName: session.endedBy?.name ?? null,
            endedByViewer: viewerId !== null && session.endedBy?.id === viewerId,
          }
        : null,
    // Only an ENDED session is copied (AMENDMENT 23 §6), so a source with no end
    // time is not one this row can name — it reads like no source.
    copiedFrom: session.copiedFrom?.endedAt
      ? {
          id: session.copiedFrom.id,
          whenLabel: endTime(format, session.copiedFrom.endedAt, now).timeLabel,
        }
      : null,
    seed: session.seed,
  }));
}
