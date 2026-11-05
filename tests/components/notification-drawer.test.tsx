// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import type { NotificationsPageDTO } from '@/lib/dto/notifications';
import en from '@/messages/en.json';

// NotificationDrawer (Subtask 5.7.5) — the Watching-tab regression guard for bug
// 8.8.1. The tab was hardcoded `disabled` as the Story 5.4 seam; with 5.4
// issue-watching shipped and 5.7.10 wiring the `watching` fan-in, the seam is
// open. This asserts: (1) the Watching tab is ENABLED, and (2) each Segmented
// tab shows its OWN category-scoped unread count (from `unreadByCategory`), not
// the global total the bell badge owns. Component test, real `en` catalog, no
// jest-dom (the happy-dom convention).

beforeAll(() => {
  // Radix Popover (the overflow menu) probes APIs happy-dom omits, even closed.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});

import { NotificationDrawer } from '@/app/(authed)/_components/NotificationDrawer';

function pageDTO(over: Partial<NotificationsPageDTO> = {}): NotificationsPageDTO {
  return {
    notifications: [],
    totalCount: 0,
    // Global total (5) ≠ either per-tab count — so a tab badge showing 5 is the bug.
    unreadCount: 5,
    unreadByCategory: { direct: 2, watching: 3 },
    nextCursor: null,
    ...over,
  };
}

function renderDrawer(page: NotificationsPageDTO = pageDTO()) {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL) =>
      ({ ok: true, json: async () => page }) as unknown as Response,
  );
  vi.stubGlobal('fetch', fetchMock);
  const onCountChange = vi.fn();
  const utils = render(
    <ToastProvider>
      <NotificationDrawer unreadCount={5} onCountChange={onCountChange} onNavigate={() => {}} />
    </ToastProvider>,
  );
  return { ...utils, fetchMock, onCountChange };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('NotificationDrawer — Watching tab (bug 8.8.1)', () => {
  it('renders the Watching tab ENABLED (the old disabled 5.4 seam is gone)', async () => {
    renderDrawer();
    const watching = await screen.findByRole('button', { name: /Watching/ });
    expect((watching as HTMLButtonElement).disabled).toBe(false);
    // The disabled-seam tooltip is gone.
    expect(watching.getAttribute('title')).toBeNull();
  });

  it('shows each tab its OWN category-scoped unread count, never the global total', async () => {
    renderDrawer(pageDTO());
    const direct = await screen.findByRole('button', { name: /Direct/ });
    const watching = screen.getByRole('button', { name: /Watching/ });
    // After the mount fetch reconciles: Direct shows 2, Watching shows 3.
    await waitFor(() => {
      expect(within(direct).getByText('2')).toBeTruthy();
      expect(within(watching).getByText('3')).toBeTruthy();
    });
    // The global total (5) is the bell's, never a tab badge.
    expect(screen.queryByText('5')).toBeNull();
  });

  it('switching to the Watching tab fetches that category', async () => {
    const { fetchMock } = renderDrawer();
    const watching = await screen.findByRole('button', { name: /Watching/ });
    fireEvent.click(watching);
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('category=watching'))).toBe(
        true,
      );
    });
  });
});

// ── THE ACCESS-REFUSED ROW (MOTIR-5016 · Story MOTIR-5010) ───────────────────
//
// The first notification whose subject is a PROJECT and whose actor is nobody, so
// the three things the shipped row derives from a work item each need their own
// answer: the summary, the avatar and the destination.

describe('NotificationDrawer — the access-refused row', () => {
  const refusedRow = () => ({
    id: 'n-refused',
    type: 'code_access_refused',
    category: 'direct' as const,
    readAt: null,
    createdAt: new Date().toISOString(),
    actor: null,
    workItemId: null,
    data: {
      kind: 'code_access_refused' as const,
      projectKey: 'ACME',
      projectName: 'Acme booking',
      repoRef: 'motir-projects/acme-web',
    },
  });

  it('renders the DESIGN’s copy — read from the catalog, never re-typed here', async () => {
    renderDrawer(pageDTO({ notifications: [refusedRow()] as never, totalCount: 1 }));

    // ⚠️ THE STRING COMES FROM `messages/en.json`, with the rich-text tag stripped
    // and the placeholder filled the way the row fills it. Re-typing the sentence
    // here would let the catalog and this assertion drift apart while both stayed
    // green — and the copy IS the deliverable of the design card.
    const template = en.notifications.summary.accessRefused;
    const expected = String(template)
      .replace(/<\/?s>/g, '')
      .replace('{project}', 'Acme booking');

    const row = await screen.findByRole('link', { name: new RegExp('Acme booking') });
    expect(row.textContent).toContain(expected);
    // A consequence and a REMEDY — and no internal cause anywhere in it.
    for (const leak of ['403', 'token', 'credential', 'billing', 'status code']) {
      expect(row.textContent?.toLowerCase()).not.toContain(leak);
    }
  });

  it('routes to CODE ACCESS, not to an item — the destination comes from the TYPE', async () => {
    renderDrawer(pageDTO({ notifications: [refusedRow()] as never, totalCount: 1 }));

    const row = await screen.findByRole('link', { name: new RegExp('Acme booking') });
    // `Notification.workItemId` is null on this row, so the shipped
    // `issueKey !== null` routing would have produced a non-navigating button.
    expect(row.getAttribute('href')).toContain('/settings/project/code-access');
    expect(row.getAttribute('href')).not.toContain('/items/');
  });

  it('draws NO actor — no initial letter, and no fallback name in the sentence', async () => {
    renderDrawer(pageDTO({ notifications: [refusedRow()] as never, totalCount: 1 }));

    const row = await screen.findByRole('link', { name: new RegExp('Acme booking') });
    // `actorFallback` ("Someone") would put a FICTIONAL actor into the summary
    // grammar — nobody did this to the user; Motir tried something on their
    // behalf and GitHub said no.
    const fallback = en.notifications.actorFallback;
    expect(row.textContent).not.toContain(fallback);
  });
});

// ── THE HIBERNATED-AGENT ROW (MOTIR-10368 · Story MOTIR-10363) ───────────────
//
// design/org-admin/design-notes.md, the Fleet delta's panel 12: the admin's
// initial avatar with a `Moon` badge, "{actor} hibernated your agent {agent}", the
// time in the excerpt, and NO destination — no route to an agent's panel or
// terminal.

describe('NotificationDrawer — the hibernated-agent row', () => {
  const hibernatedRow = (actor: { id: string; name: string; image: null } | null) => ({
    id: 'n-hibernated',
    type: 'agent_hibernated_by_admin',
    category: 'direct' as const,
    readAt: null,
    createdAt: new Date().toISOString(),
    actor,
    workItemId: null,
    data: {
      kind: 'agent_hibernated_by_admin' as const,
      agentName: 'night-owl',
      hibernatedAt: '2026-11-05T14:33:00.000Z',
    },
  });
  const ada = { id: 'u-ada', name: 'Ada Admin', image: null };

  it('names the admin and the agent, in the catalog’s words, with the time below', async () => {
    renderDrawer(pageDTO({ notifications: [hibernatedRow(ada)] as never, totalCount: 1 }));

    const expected = String(en.notifications.summary.agentHibernatedByAdmin)
      .replace(/<\/?s>/g, '')
      .replace('{actor}', 'Ada Admin')
      .replace('{agent}', 'night-owl');
    const row = await screen.findByRole('button', { name: new RegExp('night-owl') });
    expect(row.textContent).toContain(expected);
    const [before, after] = String(en.notifications.excerpt.agentHibernatedByAdmin).split('{time}');
    expect(row.textContent).toContain(before);
    expect(row.textContent).toContain(after);
    // It HAS an actor: the initial avatar is drawn, as for a work-item row.
    expect(row.textContent).toContain('A');
  });

  it('deep-links nowhere — a button, never a link to an agent', async () => {
    renderDrawer(pageDTO({ notifications: [hibernatedRow(ada)] as never, totalCount: 1 }));

    await screen.findByRole('button', { name: new RegExp('night-owl') });
    for (const link of screen.queryAllByRole('link')) {
      expect(link.getAttribute('href') ?? '').not.toMatch(/agent|terminal/i);
    }
  });

  it('a deleted admin reads as the shipped actor fallback', async () => {
    renderDrawer(pageDTO({ notifications: [hibernatedRow(null)] as never, totalCount: 1 }));

    const row = await screen.findByRole('button', { name: new RegExp('night-owl') });
    expect(row.textContent).toContain(`${en.notifications.actorFallback} hibernated your agent`);
  });
});

// MOTIR-10340 — a review waiting for the recipient's OWN agent: actorless, about a card.
describe('NotificationDrawer — the review-to-run row', () => {
  const reviewRow = () => ({
    id: 'n-review',
    type: 'review_to_run',
    category: 'direct' as const,
    readAt: null,
    createdAt: new Date().toISOString(),
    actor: null,
    workItemId: 'wi-1',
    data: {
      kind: 'review_to_run' as const,
      issueKey: 'ACME-412',
      title: 'Export the report',
      command: 'motir review ACME-412',
    },
  });

  it('reads the catalogue copy, names no actor, and opens the card', async () => {
    renderDrawer(pageDTO({ notifications: [reviewRow()] as never, totalCount: 1 }));

    const expected = String(en.notifications.summary.reviewToRun)
      .replace(/<\/?s>/g, '')
      .replace('{key}', 'ACME-412');
    const row = await screen.findByRole('link', { name: new RegExp('ACME-412') });
    expect(row.textContent).toContain(expected);
    expect(row.textContent).not.toContain(en.notifications.actorFallback);
    expect(row.getAttribute('href')).toBe('/items/ACME-412');
  });
});

// MOTIR-10338 — an agent sent the recipient's card back: actorless, opening the findings.
describe('NotificationDrawer — the review-sent-back row', () => {
  const sentBackRow = () => ({
    id: 'n-sent-back',
    type: 'review_sent_back',
    category: 'direct' as const,
    readAt: null,
    createdAt: new Date().toISOString(),
    actor: null,
    workItemId: 'wi-1',
    data: {
      kind: 'review_sent_back' as const,
      issueKey: 'ACME-412',
      title: 'Export the report',
      recordId: 'rec-1',
    },
  });

  it('reads the catalogue copy, names no actor, and opens the verdict’s findings', async () => {
    renderDrawer(pageDTO({ notifications: [sentBackRow()] as never, totalCount: 1 }));

    const expected = String(en.notifications.summary.reviewSentBack)
      .replace(/<\/?s>/g, '')
      .replace('{key}', 'ACME-412');
    const row = await screen.findByRole('link', { name: new RegExp('ACME-412') });
    expect(row.textContent).toContain(expected);
    expect(row.textContent).not.toContain(en.notifications.actorFallback);
    expect(row.getAttribute('href')).toBe('/items/ACME-412#agent-verdict-rec-1');
  });
});
