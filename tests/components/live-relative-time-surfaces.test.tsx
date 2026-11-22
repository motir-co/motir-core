// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { renderWithIntl, enMessages } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import {
  observeRelativeTimePin,
  resetRelativeTimeClockForTests,
} from '@/lib/hooks/useRelativeTime';
import { buildEntryParts, type DisplayResolvers } from '@/lib/activity/renderers';
import type {
  ActivityAgentVerdictPartDto,
  ActivityEntryDto,
  ActivityEntryPartDto,
} from '@/lib/dto/activity';
import type { AutomationExecutionPageDto } from '@/lib/dto/automationRules';
import type { NotificationsPageDTO } from '@/lib/dto/notifications';
import type { PageCommentDto } from '@/lib/pages';

// MOTIR-11970 — the client lists that load or append rows after page load. The
// provider's `now` is pinned once per request (finding #89); measured against
// it, a row the browser fetched or appended after load read as a future time
// ("in 3 minutes") and every older row stayed as old as it was at load. Each
// family below pins the provider `now`, lets the clock run, puts a row stamped
// AFTER the pin in front of the surface, and asserts it reads as just made, that
// the older rows have aged, and that nothing reads in the future tense.

vi.mock('@/components/ui/MarkdownView', () => ({
  MarkdownView: ({ value }: { value: string }) => <div>{value}</div>,
}));

beforeAll(() => {
  // Radix probes APIs happy-dom omits, even closed.
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

const { NotificationDrawer } = await import('@/app/(authed)/_components/NotificationDrawer');
const { AutomationRuleAuditLog } =
  await import('@/app/(authed)/settings/project/automation/_components/AutomationRuleAuditLog');
const { PageCommentItem } =
  await import('@/app/(authed)/pages/[pageId]/_components/PageCommentItem');
const { ActivityEntryRow } =
  await import('@/app/(authed)/items/[key]/_components/ActivityEntryRow');

const PIN = new Date('2026-11-21T21:30:00.000Z');
const MIN = 60_000;
const at = (ms: number) => new Date(PIN.getTime() + ms).toISOString();
const FUTURE = /\bin \d+ (second|minute|hour)s?\b/;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(PIN);
  resetRelativeTimeClockForTests();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetRelativeTimeClockForTests();
  vi.useRealTimers();
});

/** The page hydrated at the pin — the root layout's anchor observed it then. */
function pageLoadedAtPin() {
  observeRelativeTimePin(PIN.getTime());
}

async function letTheClockRun(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

function stubFetch(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => body }) as unknown as Response),
  );
}

describe('the notification drawer — opened long after load', () => {
  const row = (id: string, createdAt: string, projectName: string) => ({
    id,
    type: 'code_access_refused',
    category: 'direct' as const,
    readAt: null,
    createdAt,
    actor: null,
    workItemId: null,
    data: { kind: 'code_access_refused' as const, projectKey: 'ACME', projectName, repoRef: 'a/b' },
  });

  it('a notification made just before the open reads as now, an older one at its true age', async () => {
    pageLoadedAtPin();
    const opened = 30 * MIN + 20_000;
    vi.setSystemTime(new Date(PIN.getTime() + opened));
    const page: NotificationsPageDTO = {
      notifications: [row('n-new', at(opened), 'Fresh'), row('n-old', at(-MIN), 'Older')] as never,
      totalCount: 2,
      unreadCount: 2,
      unreadByCategory: { direct: 2, watching: 0 },
      nextCursor: null,
    };
    stubFetch(page);
    renderWithIntl(
      <ToastProvider>
        <NotificationDrawer unreadCount={2} onCountChange={() => {}} onNavigate={() => {}} />
      </ToastProvider>,
      { now: PIN },
    );
    const fresh = await screen.findByRole('link', { name: /Fresh/ });
    const older = screen.getByRole('link', { name: /Older/ });
    expect(fresh.textContent).toContain('now');
    expect(older.textContent).toContain('31 minutes ago');

    await letTheClockRun(3 * MIN);
    expect(fresh.textContent).toContain('3 minutes ago');
    expect(older.textContent).toContain('34 minutes ago');
    expect(fresh.textContent).not.toMatch(FUTURE);
    expect(older.textContent).not.toMatch(FUTURE);
  });
});

describe('the automation audit log — a page loaded in the browser', () => {
  it('a run recorded after the pin reads as now, never "in 3 minutes"', async () => {
    pageLoadedAtPin();
    const opened = 3 * MIN + 30_000;
    vi.setSystemTime(new Date(PIN.getTime() + opened));
    const page: AutomationExecutionPageDto = {
      executions: [
        {
          id: 'x-new',
          status: 'success',
          triggerItem: { key: 'MOTIR-1', title: 'Fresh' },
          error: null,
          durationMs: 120,
          createdAt: at(opened),
        },
        {
          id: 'x-old',
          status: 'success',
          triggerItem: { key: 'MOTIR-2', title: 'Older' },
          error: null,
          durationMs: 80,
          createdAt: at(-MIN),
        },
      ],
      total: 2,
      page: 1,
      pageSize: 25,
    };
    stubFetch(page);
    const { container } = renderWithIntl(
      <AutomationRuleAuditLog projectKey="MOTIR" ruleId="r1" ruleName="Rule" onBack={() => {}} />,
      { now: PIN },
    );
    const fresh = await screen.findByTestId('execution-row-x-new');
    const older = screen.getByTestId('execution-row-x-old');
    expect(fresh.textContent).toContain('now');
    expect(older.textContent).toContain('4 minutes ago');
    // Two minutes on, the clock reads pin + 5 min: the run is a minute and a
    // half old, measured in whole ticks of the clock.
    await letTheClockRun(2 * MIN);
    expect(fresh.textContent).toContain('1 minute ago');
    expect(older.textContent).toContain('6 minutes ago');
    expect(container.textContent).not.toMatch(FUTURE);
  });
});

describe('the page discussion — comments appended in place', () => {
  const ME = { id: 'u-me', name: 'Ana Ruiz', image: null };
  const comment = (id: string, createdAt: string, bodyMd: string): PageCommentDto => ({
    id,
    pageId: 'page-1',
    parentCommentId: null,
    author: ME,
    bodyMd,
    editedAt: null,
    createdAt,
    resolvedAt: null,
    resolvedBy: null,
    anchor: null,
  });
  function List({ comments }: { comments: PageCommentDto[] }) {
    return (
      <ToastProvider>
        {comments.map((c) => (
          <div key={c.id} data-testid={c.id}>
            <PageCommentItem
              comment={c}
              canComment
              canModerate={false}
              currentUserId={ME.id}
              mentionCandidates={[]}
              workItemRefs={{}}
              onEdit={async () => null}
              onDelete={async () => null}
            />
          </div>
        ))}
      </ToastProvider>
    );
  }

  it('a comment posted after load reads as just made, and the earlier one ages', async () => {
    const first = comment('c-1', at(-MIN), 'First');
    const { rerender } = renderWithIntl(<List comments={[first]} />, { now: PIN });
    expect(screen.getByTestId('c-1').textContent).toContain('1 minute ago');

    await letTheClockRun(3 * MIN);
    expect(screen.getByTestId('c-1').textContent).toContain('4 minutes ago');

    // Posted half a minute after the last tick — the panel appends it, no refresh.
    vi.setSystemTime(new Date(Date.now() + 30_000));
    const posted = comment('c-2', new Date().toISOString(), 'Second');
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages} now={PIN}>
        <List comments={[first, posted]} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('c-2').textContent).toContain('now');
    for (const id of ['c-1', 'c-2']) {
      expect(screen.getByTestId(id).textContent).not.toMatch(FUTURE);
    }
  });
});

describe('the item history — entries paged in with fetch', () => {
  const resolvers: DisplayResolvers = {
    user: (id) => ({ type: 'user', userId: id, name: 'Ann', image: null }),
    status: (key) => ({ type: 'text', text: key }),
    sprint: (id) => ({ type: 'sprint', sprintId: id, name: 'Sprint 4' }),
    issue: (id) => ({ type: 'issue', workItemId: id, identifier: 'MOTIR-2' }),
    folder: (id) => ({ type: 'text', text: id }),
    reviewChecklist: () => [],
  };
  const titlePart = buildEntryParts('updated', { title: { from: 'a', to: 'b' } }, resolvers)[0]!;
  const verdictPart: ActivityAgentVerdictPartDto = {
    kind: 'agentVerdict',
    recordId: 'rec-1',
    verdict: 'pass',
    outcome: 'decided',
    hosted: false,
    harness: 'Claude Code',
    model: 'claude-opus-5-5',
    subjectVersion: 'moooon/acme#88@3f2a9c1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    findingsExcerpt: null,
    notified: null,
    checklist: [],
  };
  const entry = (id: string, changedAt: string, part: ActivityEntryPartDto): ActivityEntryDto => ({
    id,
    workItemId: 'w1',
    changeKind: part.kind === 'agentVerdict' ? 'agent_verdict' : 'updated',
    changedAt,
    actor: { userId: 'u1', name: 'Mo', image: null },
    parts: [part],
  });
  function History({ entries }: { entries: ActivityEntryDto[] }) {
    return (
      <>
        {entries.map((e) => (
          <div key={e.id} data-testid={e.id}>
            <ActivityEntryRow entry={e} part={e.parts[0]!} statusCategories={{}} />
          </div>
        ))}
      </>
    );
  }

  it('a field change and an agent verdict recorded after load read as now; older rows age', async () => {
    const old = entry('e-old', at(-2 * MIN), titlePart);
    const { rerender } = renderWithIntl(<History entries={[old]} />, { now: PIN });
    expect(screen.getByTestId('e-old').textContent).toContain('2 minutes ago');

    await letTheClockRun(5 * MIN);
    expect(screen.getByTestId('e-old').textContent).toContain('7 minutes ago');

    vi.setSystemTime(new Date(Date.now() + 40_000));
    const nowIso = new Date().toISOString();
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages} now={PIN}>
        <History
          entries={[
            entry('e-field', nowIso, titlePart),
            entry('e-verdict', nowIso, verdictPart),
            old,
          ]}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('e-field').textContent).toContain('now');
    expect(screen.getByTestId('e-verdict').textContent).toContain('now');
    for (const id of ['e-old', 'e-field', 'e-verdict']) {
      expect(screen.getByTestId(id).textContent).not.toMatch(FUTURE);
    }
  });
});
