import { checkRowsAtHead, pullRequestHead } from '@/lib/github/pullRequestHead';
import type { PrCheckRunSlice } from '@/lib/github/prCiState';

// ── MOVING AGAIN, MEASURED AGAINST WHERE THE RUN LEFT THE CODE (MOTIR-10308) ─────────
// A card waiting To resume leaves the tab once CI starts on its delivery set AFTER the
// gated run stopped. "After the stop" cannot be read off the check rows' timestamps
// alone: a run usually pushes and THEN stops at its gate, so the CI of the run's OWN
// last push reaches Motir after `endedAt` — a job that waits on another job gets its
// check run minutes later, and every in-flight event re-writes a pending row. Read by
// time, that CI would take the card off To resume before anyone answered the gate.
//
// So the gated run's recompute records a SNAPSHOT of the delivery set (`WorkItem.
// resumeDetail`): each member's head, and whether CI had already SETTLED there (rows at
// the head, none pending). Later recomputes compare against it:
//
//   · a member at a DIFFERENT head with CI reported there — a push since the stop;
//   · a member at the SAME head whose CI had settled, with a row pending again or
//     created after the stop — a re-run (a new suite, or jobs re-run inside one);
//   · a member at the same head whose CI had NOT settled is the run's own push still
//     being checked: nothing, until its CI settles — the snapshot then records that,
//     and only a LATER re-run counts;
//   · a member the snapshot does not name (opened after the stop) with a row created
//     after the stop.
//
// Once moved, the snapshot latches (`moved: true`) for that run: the card went on
// without a resume, and a later event must not list it again.

/** One member of the delivery set as the gated run left it. */
export interface ResumeCiHead {
  head: string | null;
  /** CI at that head had reported and nothing was pending. */
  settled: boolean;
}

/** `WorkItem.resumeDetail` — the gated run's view of its delivery set. */
export interface ResumeCiSnapshot {
  runId: string;
  moved: boolean;
  heads: Record<string, ResumeCiHead>;
}

/** A delivery-set member as the snapshot reads it. */
export interface ResumeCiMember {
  id: string;
  headSha: string | null;
  checkRuns: ReadonlyArray<PrCheckRunSlice & { updatedAt: Date }>;
}

function settledAtHead(member: ResumeCiMember): boolean {
  const rows = checkRowsAtHead(member);
  return rows.length > 0 && !rows.some((r) => r.conclusion === 'pending');
}

/** The snapshot a fresh gated run takes of its delivery set. */
export function takeResumeCiSnapshot(
  runId: string,
  members: Iterable<ResumeCiMember>,
): ResumeCiSnapshot {
  const heads: Record<string, ResumeCiHead> = {};
  for (const m of members) heads[m.id] = { head: pullRequestHead(m), settled: settledAtHead(m) };
  return { runId, moved: false, heads };
}

/** A stored `resumeDetail`, read defensively — anything malformed reads as none. */
export function toResumeCiSnapshot(value: unknown): ResumeCiSnapshot | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.runId !== 'string' || v.heads === null || typeof v.heads !== 'object') return null;
  const heads: Record<string, ResumeCiHead> = {};
  for (const [id, raw] of Object.entries(v.heads as Record<string, unknown>)) {
    if (raw === null || typeof raw !== 'object') continue;
    const h = raw as Record<string, unknown>;
    heads[id] = {
      head: typeof h.head === 'string' ? h.head : null,
      settled: h.settled === true,
    };
  }
  return { runId: v.runId, moved: v.moved === true, heads };
}

/** Whether ONE member shows CI started since the stop — the rules in the header. */
function memberMoved(
  recorded: ResumeCiHead | undefined,
  member: ResumeCiMember,
  endedAt: Date,
): boolean {
  if (recorded === undefined) return member.checkRuns.some((r) => r.createdAt > endedAt);
  const head = pullRequestHead(member);
  if (head !== recorded.head) return checkRowsAtHead(member).length > 0;
  if (!recorded.settled) return false;
  return checkRowsAtHead(member).some(
    (r) => r.createdAt > endedAt || (r.conclusion === 'pending' && r.updatedAt > endedAt),
  );
}

/**
 * The snapshot after reading the delivery set NOW: `moved` latched when any member shows CI
 * started since the stop, and a member whose CI was still running at the stop marked settled
 * once it has — so a re-run after that counts and the run's own CI never does.
 */
export function advanceResumeCiSnapshot(
  snapshot: ResumeCiSnapshot,
  members: Iterable<ResumeCiMember>,
  endedAt: Date,
): ResumeCiSnapshot {
  if (snapshot.moved) return snapshot;
  const heads = { ...snapshot.heads };
  let moved = false;
  for (const m of members) {
    const recorded = snapshot.heads[m.id];
    if (memberMoved(recorded, m, endedAt)) moved = true;
    else if (
      recorded &&
      !recorded.settled &&
      pullRequestHead(m) === recorded.head &&
      settledAtHead(m)
    ) {
      heads[m.id] = { head: recorded.head, settled: true };
    }
  }
  return { runId: snapshot.runId, moved, heads };
}

/** Two snapshots are the same — what decides whether the recompute writes. */
export function sameResumeCiSnapshot(
  a: ResumeCiSnapshot | null,
  b: ResumeCiSnapshot | null,
): boolean {
  if (a === null || b === null) return a === b;
  if (a.runId !== b.runId || a.moved !== b.moved) return false;
  const keys = Object.keys(b.heads);
  return (
    Object.keys(a.heads).length === keys.length &&
    keys.every((k) => {
      const x = a.heads[k];
      const y = b.heads[k]!;
      return x !== undefined && x.head === y.head && x.settled === y.settled;
    })
  );
}
