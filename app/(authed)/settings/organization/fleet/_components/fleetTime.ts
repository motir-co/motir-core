'use client';

import { useFormatter, useNow, useTranslations } from 'next-intl';

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * The page's two ways of saying a time (design panels 2, 9a):
 * - `at` — a row's time: the clock time today ("14:05"), else the day and time
 *   ("Mon 2 Nov, 03:14");
 * - `when` — the last-stop and result lines: "today at 14:33", "yesterday at
 *   17:20", else the day and time.
 */
export function useFleetTime() {
  const t = useTranslations('settings.organization.fleet.when');
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });

  const clock = (date: Date) => format.dateTime(date, { timeStyle: 'short' });
  const dayAndTime = (date: Date) =>
    format.dateTime(date, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });

  return {
    clock(iso: string): string {
      return clock(new Date(iso));
    },
    at(iso: string): string {
      const date = new Date(iso);
      return sameDay(date, now) ? clock(date) : dayAndTime(date);
    },
    when(iso: string): string {
      const date = new Date(iso);
      if (sameDay(date, now)) return t('today', { time: clock(date) });
      const yesterday = new Date(now);
      yesterday.setDate(now.getDate() - 1);
      if (sameDay(date, yesterday)) return t('yesterday', { time: clock(date) });
      return dayAndTime(date);
    },
  };
}
