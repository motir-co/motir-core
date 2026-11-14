import type { PlanSessionOriginDto } from '@/lib/dto/planChange';
import type { PlanStatusDto, PlanWalkPhaseDto } from '@/lib/dto/plans';
import type {
  PlanSessionEndReasonDto,
  PlanSessionSeedDto,
  PlanSessionStateDto,
} from '@/lib/dto/planSessions';

// The serializable view-model a Plans-list SESSION row binds to (MOTIR-6025,
// `design/ai-planning/design-notes.md` Part XIX §19.2). Built ON THE SERVER
// (`sessionRowView.ts`) from `PlanSessionRowDto`, so the row stays
// presentational and never re-derives a relative time — which would risk an
// SSR/CSR hydration mismatch.

export interface SessionRowView {
  id: string;
  origin: PlanSessionOriginDto;
  /** What was asked — the first `user` turn — or, with no turn, the latest
   *  plan's title. Empty when the session has neither. */
  title: string;
  /** The anchor set; empty = the whole project. */
  targetKeys: string[];
  /** Pre-formatted relative `lastActivityAt` ("12 minutes ago"). */
  activeLabel: string;
  /** Who started it; null on a cadence session and a departed member's. */
  startedByName: string | null;
  /** The latest plan — what the chip names and opens — or null (`No plan yet`). */
  latestPlan: { id: string; status: PlanStatusDto } | null;
  /** How many plans the session holds, the latest included. */
  planCount: number;
  /** The session's state, END first (AMENDMENT 23 §1) — what the chip says. */
  state: PlanSessionStateDto;
  /** The failed attempt's STOP LINE while the session is OPEN and waiting on it (Story MOTIR-7905
   *  · MOTIR-7921 / MOTIR-7944), else null. Untranslated: the row words it from the codes, so
   *  `walk` (a `waiting` row: where it stopped and why) and `change` (a failure beside a plan
   *  that waits: *your last change could not be made*) are two sentences. `timeLabel` is the
   *  relative time, formatted on the server. */
  failure?: {
    kind: 'walk' | 'change';
    reason: string;
    stopPhase: PlanWalkPhaseDto | null;
    stopTitle: string | null;
    /** The halted walk's "not planned yet" lines, verbatim and in order (MOTIR-10209). */
    notPlannedYet?: readonly string[];
    timeLabel: string;
    fullLabel: string;
  } | null;
  /** How it ENDED, or null while it is open (MOTIR-7642). The time is formatted on
   *  the server: `HH:mm` today, else the short date; `fullLabel` is the whole
   *  date-time, for the line's `title`. */
  end: {
    reason: PlanSessionEndReasonDto;
    timeLabel: string;
    fullLabel: string;
    /** Who ended it; null when Motir did or the member is gone. */
    endedByName: string | null;
    /** Whether the reader ended it — the line then says *you*. */
    endedByViewer: boolean;
  } | null;
  /** The session this one continues (AMENDMENT 23 §6), with its end time
   *  formatted, or null. */
  copiedFrom: { id: string; whenLabel: string } | null;
  /** The refused work item the session was seeded from (MOTIR-6209) — the row's
   *  `Re-plan of {KEY} · {verb}` link — or null, which draws nothing extra. */
  seed: PlanSessionSeedDto | null;
}
