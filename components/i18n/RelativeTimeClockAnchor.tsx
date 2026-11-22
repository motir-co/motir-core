'use client';

import { useNow } from 'next-intl';
import { observeRelativeTimePin } from '@/lib/hooks/useRelativeTime';

/**
 * Observes the provider's pinned `now` as the page hydrates — and again when
 * `router.refresh()` re-pins it — so the live relative-time clock
 * (`lib/hooks/useRelativeTime.ts`, MOTIR-11970) measures elapsed time from the
 * page load, not from whenever the first relative time happens to mount.
 * Renders nothing.
 */
export function RelativeTimeClockAnchor(): null {
  observeRelativeTimePin(useNow().getTime());
  return null;
}
