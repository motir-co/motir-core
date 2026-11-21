// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/messages/en.json';
import { observeRelativeTimePin, useRelativeTime } from '@/lib/hooks/useRelativeTime';
import { RelativeTimeClockAnchor } from '@/components/i18n/RelativeTimeClockAnchor';

// The server half of the live relative-time clock (MOTIR-11970): with no
// `window`, the hook measures against the request's pinned `now` and keeps no
// clock — a server process renders many requests, and a module-level
// observation per request would only grow.

const PIN = new Date('2026-11-21T21:30:00.000Z');

function Label({ at }: { at: Date }) {
  const relativeTime = useRelativeTime();
  return <span>{relativeTime(at)}</span>;
}

describe('useRelativeTime on the server', () => {
  it('renders against the pin, whatever the process clock says', () => {
    observeRelativeTimePin(PIN.getTime());
    const html = renderToString(
      <NextIntlClientProvider locale="en" messages={enMessages} now={PIN} timeZone="UTC">
        <RelativeTimeClockAnchor />
        <Label at={new Date(PIN.getTime() - 3 * 60_000)} />
        <Label at={new Date(PIN.getTime() + 60_000)} />
      </NextIntlClientProvider>,
    );
    expect(html).toContain('3 minutes ago');
    // A timestamp ahead of the pin is clamped to it.
    expect(html).toContain('now');
    expect(html).not.toMatch(/in 1 minute/);
  });
});
