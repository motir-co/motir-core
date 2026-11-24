import { LOG_SECRET_MASK } from '@/lib/hosting/logMasking';

// The words the Production panel's Health state, Crash events and Logs view
// draw from route data (Story MOTIR-9799 · MOTIR-12109, per
// `design/hosting/design-notes.md` § Copy). Pure: message KEYS under
// `settings.production` and their values, never English.

/** The Logs view's time ranges, in the design's order; `1h` is the default. */
export const LOG_RANGES = ['15m', '1h', '24h', '7d'] as const;
export type LogRange = (typeof LOG_RANGES)[number];
export const DEFAULT_LOG_RANGE: LogRange = '1h';

const RANGE_MS: Record<LogRange, number> = {
  '15m': 15 * 60_000,
  '1h': 3_600_000,
  '24h': 24 * 3_600_000,
  '7d': 7 * 24 * 3_600_000,
};

/** The start of `range`, ending `now`, as the logs route reads it. */
export function rangeSince(range: LogRange, now: Date): string {
  return new Date(now.getTime() - RANGE_MS[range]).toISOString();
}

/** A crash event's reason as the route words it, turned into the design's key. */
export function eventReasonMessage(reason: string): {
  key: string;
  values?: Record<string, string>;
} {
  const exit = /^exit code (-?\d+)$/i.exec(reason.trim());
  if (exit) return { key: 'events.reason.exit', values: { code: exit[1]! } };
  const http = /^HTTP (\d{3})$/i.exec(reason.trim());
  if (http) return { key: 'events.reason.http', values: { status: http[1]! } };
  if (/^out of memory$/i.test(reason.trim())) return { key: 'events.reason.oom' };
  if (/^timed out$/i.test(reason.trim())) return { key: 'events.reason.timeout' };
  return { key: 'events.reason.exited' };
}

/** Whether a crash event's reason is the process running out of memory. */
export function isOutOfMemory(reason: string): boolean {
  return eventReasonMessage(reason).key === 'events.reason.oom';
}

/** How long a state has lasted, in its two largest units — "2 h 58 min",
 *  "3 min", "4 d 2 h" — in the viewer's locale. Under a minute is "< 1 min". */
export function formatStateDuration(from: Date, now: Date, locale: string): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60_000));
  const unit = (value: number, u: 'day' | 'hour' | 'minute') =>
    new Intl.NumberFormat(locale, { style: 'unit', unit: u, unitDisplay: 'short' }).format(value);
  if (minutes < 1) return `< ${unit(1, 'minute')}`;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0)
    return hours > 0 ? `${unit(days, 'day')} ${unit(hours, 'hour')}` : unit(days, 'day');
  if (hours > 0)
    return mins > 0 ? `${unit(hours, 'hour')} ${unit(mins, 'minute')}` : unit(hours, 'hour');
  return unit(mins, 'minute');
}

/** A log message split around the mask, so the mask can be drawn as a token
 *  while the text read is the message exactly as the route returned it. */
export function maskSegments(message: string): Array<{ text: string; mask: boolean }> {
  const parts = message.split(LOG_SECRET_MASK);
  const out: Array<{ text: string; mask: boolean }> = [];
  parts.forEach((text, i) => {
    if (i > 0) out.push({ text: LOG_SECRET_MASK, mask: true });
    if (text) out.push({ text, mask: false });
  });
  return out;
}

/** A line longer than this is collapsed to one line, with an arrow to open it
 *  (design § Width, second revision). */
export const LONG_LINE_CHARS = 120;
