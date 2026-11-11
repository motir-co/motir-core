// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { NotificationPreferencesCard } from '@/app/(authed)/settings/account/_components/NotificationPreferencesCard';
import type { NotificationPreferenceMatrixDto } from '@/lib/dto/notificationPreferences';
import en from '@/messages/en.json';

// The notification-preferences matrix, rendered (Story MOTIR-10868 · MOTIR-10930).
// The Commented row now governs page replies as well as work-item comments, so its
// label, its description and the defaults note say so. Every expected sentence is
// read from `messages/en.json` at assert time — the copy is the deliverable, and a
// retyped string would let the catalogue and this test drift apart while both
// stayed green. The Mentioned row is pinned beside it so a key typo or a wrong
// branch fails instead of passing on one row.

afterEach(() => {
  cleanup();
});

const copy = en.settings.account.notifications;

const matrix: NotificationPreferenceMatrixDto = {
  channels: ['email', 'in_app'],
  events: [
    { eventType: 'mentioned', settable: true, channels: { email: true, in_app: true } },
    { eventType: 'commented', settable: true, channels: { email: true, in_app: false } },
  ],
};

/** `cellAria` filled the way the cell fills it. */
const cellName = (channel: string, event: string) =>
  copy.cellAria.replace('{channel}', channel).replace('{event}', event);

describe('NotificationPreferencesCard — the Commented row names page replies', () => {
  it('renders the Commented row’s label and description from the catalogue', () => {
    render(<NotificationPreferencesCard initial={matrix} />);
    expect(screen.getByText(copy.events.commented.label)).toBeTruthy();
    expect(screen.getByText(copy.events.commented.desc)).toBeTruthy();
    // Both halves stay named: the work-item cases and the page discussion.
    expect(copy.events.commented.desc).toMatch(/item you reported/);
    expect(copy.events.commented.desc).toMatch(/page discussion/);
  });

  it('both of the row’s switches carry the label in their accessible names', () => {
    render(<NotificationPreferencesCard initial={matrix} />);
    const label = copy.events.commented.label;
    for (const channel of [copy.columns.email, copy.columns.inApp]) {
      const name = cellName(channel, label);
      expect(name).toContain(label);
      expect(screen.getByRole('switch', { name })).toBeTruthy();
    }
  });

  it('renders the defaults note naming page replies among the direct events', () => {
    render(<NotificationPreferencesCard initial={matrix} />);
    expect(screen.getByText(copy.defaultsNote)).toBeTruthy();
    expect(copy.defaultsNote).toContain('replies in your page discussions');
    expect(copy.defaultsNote).toContain(
      'An untouched row uses that default (it is not off until you turn it off).',
    );
  });

  it('leaves the neighbouring Mentioned row on its own strings', () => {
    render(<NotificationPreferencesCard initial={matrix} />);
    expect(screen.getByText(copy.events.mentioned.label)).toBeTruthy();
    expect(screen.getByText(copy.events.mentioned.desc)).toBeTruthy();
    expect(
      screen.getByRole('switch', {
        name: cellName(copy.columns.email, copy.events.mentioned.label),
      }),
    ).toBeTruthy();
  });
});
