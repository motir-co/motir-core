'use client';

import { useFormatter } from 'next-intl';
import { useLiveNow } from '@/lib/hooks/useRelativeTime';

// WHEN A PAGE WAS ARCHIVED, as the archive surfaces say it (Story MOTIR-5755 ·
// MOTIR-7423/7424) — the History panel's rule for a time, which design MOTIR-7416
// reuses: relative under a day ("1 hour ago"), absolute after ("Sep 1, 2026,
// 9:30 AM"). Shared by the archived banner and the Archived pages list.
//
// Measured against the LIVE clock (MOTIR-11993), not `useNow()`'s pinned
// request instant: the Archived pages list loads and appends rows in the
// browser, so a page archived after load read "in 3 minutes" against the pin
// and every row stayed as old as it was at load. First paint is still the pin,
// so the server and hydration agree. An `archivedAt` after the clock (a row
// written since the last tick, or a server clock slightly ahead) reads as now,
// never as a future time — the same clamp `useRelativeTime()` applies.

const DAY_MS = 24 * 60 * 60 * 1000;

export function useArchivedAtLabel(iso: string): string {
  const format = useFormatter();
  const now = useLiveNow();
  const date = new Date(iso);
  return now.getTime() - date.getTime() < DAY_MS
    ? format.relativeTime(date > now ? now : date, now)
    : format.dateTime(date, { dateStyle: 'medium', timeStyle: 'short' });
}
