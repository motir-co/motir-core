// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import type { ApprovalRecordsPageDto } from '@/lib/dto/approvalGate';

// THE /approvals ROUTE (Story MOTIR-5299 · the story gate, MOTIR-5303) — the real
// page module rendered, with the session, the active project and the READ stubbed
// at their module boundaries. The read's own suites prove what it returns; this
// file proves what the page does with it:
//
//   · it hands the read ONLY the page number from the URL;
//   · the three EMPTY states are distinct, and none of them is permission-shaped —
//     asserted by the absence of the product's access-denied strings, by key;
//   · the subtitle follows the read's `fullView`, never a check of its own.

const { getSession, redirect, getActiveProject, listRecords, recordViews, notFound, push } =
  vi.hoisted(() => ({
    push: vi.fn(),
    recordViews: vi.fn(),
    notFound: vi.fn(() => {
      throw new Error('notFound');
    }),
    getSession: vi.fn(),
    redirect: vi.fn((to: string) => {
      throw new Error(`redirect:${to}`);
    }),
    getActiveProject: vi.fn(),
    listRecords: vi.fn(),
  }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession,
}));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect,
  notFound,
  useRouter: () => ({ push, refresh: vi.fn() }),
  usePathname: () => '/approvals',
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const messages = (await import('@/messages/en.json')).default;
  return {
    getTranslations: async (namespace: string) =>
      createTranslator({ locale: 'en', messages, namespace } as never),
  };
});
vi.mock('@/lib/projects', () => ({ getActiveProject }));
// An async Server Component cannot be rendered by RTL; the host only mounts the
// title-translation provider around the room, which this file does not exercise.
vi.mock('@/components/workItems/titleTranslation/SurfaceTitleHost', () => ({
  SurfaceTitleHost: ({ children }: { children: ReactElement }) => children,
}));
vi.mock('@/lib/services/approvalGatesService', () => ({
  approvalGatesService: { listRecords, recordViews },
}));

const CTX = {
  userId: 'u1',
  workspaceId: 'ws1',
  projectId: 'p1',
  project: { id: 'p1', identifier: 'ACME', autoTranslateWorkContent: false },
};

function empty(fullView: boolean): ApprovalRecordsPageDto {
  return {
    fullView,
    // One view each, so the switch stays out of these cases (the switch has its own).
    scope: fullView ? 'project' : 'mine',
    views: fullView ? ['project'] : ['mine'],
    sections: { awaiting: { items: [], total: 0 }, decided: { items: [], total: 0 } },
    total: 0,
    page: 1,
    pageSize: 25,
  };
}

async function renderPage(searchParams: Record<string, string | string[] | undefined> = {}) {
  const mod = await import('@/app/(authed)/approvals/page');
  const tree = (await mod.default({ searchParams: Promise.resolve(searchParams) })) as ReactElement;
  render(tree);
}

/** Every access-denied sentence the product already ships, so none can leak in here. */
const ACCESS_DENIED = [
  en.projectAccess.noAccessTitle,
  en.triage.noAccessDescription,
  en.issueViews.refNoAccessTitle,
];

// The page module's first, cold import pulls in most of the app. On a loaded CI shard
// that alone ran past the suite's 15 s testTimeout, and it was charged to whichever
// test ran first. Load it once here, under its own budget, so each test measures only
// its own render.
const COLD_IMPORT_TIMEOUT_MS = 120_000;
beforeAll(async () => {
  await import('@/app/(authed)/approvals/page');
}, COLD_IMPORT_TIMEOUT_MS);

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ user: { id: 'u1' } });
  getActiveProject.mockResolvedValue(CTX);
  listRecords.mockResolvedValue(empty(false));
});
afterEach(cleanup);

describe('the /approvals page', () => {
  it('redirects a request with no session before it reads anything', async () => {
    getSession.mockResolvedValue(null);
    await expect(renderPage()).rejects.toThrow('redirect:/sign-in');
    expect(listRecords).not.toHaveBeenCalled();
  });

  it('redirects when no active project resolves', async () => {
    getActiveProject.mockResolvedValue(null);
    await expect(renderPage()).rejects.toThrow('redirect:/no-project');
    expect(listRecords).not.toHaveBeenCalled();
  });

  it('hands the read the page number and the REQUESTED view — nothing else from the URL', async () => {
    await renderPage({ page: '3', userId: 'someone-else', fullView: 'true', scope: 'project' });
    expect(listRecords).toHaveBeenCalledTimes(1);
    expect(listRecords).toHaveBeenCalledWith(CTX, { page: 3, view: null });
    cleanup();
    listRecords.mockClear();
    await renderPage({ view: 'project' });
    expect(listRecords).toHaveBeenCalledWith(CTX, { page: 1, view: 'project' });
  });

  it('a reader with no records reads "no approvals yet" in their own words — never an access message', async () => {
    await renderPage();
    expect(
      screen.getByRole('heading', { name: en.approvalRecords.heading, level: 1 }),
    ).toBeTruthy();
    expect(screen.getByText(en.approvalRecords.empty.title)).toBeTruthy();
    expect(screen.getByText(en.approvalRecords.empty.bodyOwn)).toBeTruthy();
    expect(screen.getByText(en.approvalRecords.subtitle.own)).toBeTruthy();
    for (const denied of ACCESS_DENIED) expect(screen.queryByText(denied)).toBeNull();
    expect(document.body.textContent?.toLowerCase()).not.toMatch(/permission|access|administrator/);
  });

  it('the full view’s nothing-at-all state is its own sentence', async () => {
    listRecords.mockResolvedValue(empty(true));
    await renderPage();
    expect(screen.getByText(en.approvalRecords.empty.bodyFull)).toBeTruthy();
    expect(screen.getByText(en.approvalRecords.subtitle.full)).toBeTruthy();
    expect(screen.queryByText(en.approvalRecords.empty.bodyOwn)).toBeNull();
  });

  it('nothing pending and nothing decided are two DIFFERENT lines, neither permission-shaped', async () => {
    const decidedOnly: ApprovalRecordsPageDto = {
      ...empty(false),
      sections: {
        awaiting: { items: [], total: 0 },
        decided: {
          items: [
            {
              gateId: 'g1',
              kind: 'design_result',
              state: 'approved',
              decidedAt: new Date().toISOString(),
              decidedByLabel: 'Me <me@ex.com>',
              decisionSource: null,
              subjectVersion: 'abcdef0123',
              waitingSince: new Date().toISOString(),
              workItem: {
                id: 'w1',
                key: 1,
                identifier: 'MOTIR-1',
                title: 'A decided thing',
                kind: 'subtask',
                type: 'design',
              },
              subject: null,
              confirmedRecord: null,
              refusalVerdict: null,
              refusalReason: null,
              chosenOption: null,
            },
          ],
          total: 1,
        },
      },
      total: 1,
    };
    listRecords.mockResolvedValue(decidedOnly);
    await renderPage();
    expect(screen.getByText(en.approvalRecords.empty.awaitingOwn)).toBeTruthy();
    expect(screen.queryByText(en.approvalRecords.empty.decidedOwn)).toBeNull();
    expect(screen.queryByText(en.approvalRecords.empty.title)).toBeNull();
    cleanup();

    const pendingOnly: ApprovalRecordsPageDto = {
      ...decidedOnly,
      sections: {
        awaiting: {
          items: [
            {
              gateId: 'g2',
              kind: 'design_result',
              state: 'awaiting',
              canDecide: false,
              routedToName: null,
              waitingSince: new Date().toISOString(),
              workItem: {
                id: 'w2',
                key: 2,
                identifier: 'MOTIR-2',
                title: 'A pending thing',
                kind: 'subtask',
                type: 'design',
              },
              subject: null,
            },
          ],
          total: 1,
        },
        decided: { items: [], total: 0 },
      },
    };
    listRecords.mockResolvedValue(pendingOnly);
    await renderPage();
    expect(screen.getByText(en.approvalRecords.empty.decidedOwn)).toBeTruthy();
    expect(screen.queryByText(en.approvalRecords.empty.awaitingOwn)).toBeNull();
    for (const denied of ACCESS_DENIED) expect(screen.queryByText(denied)).toBeNull();
  });

  // ── The residue the room's own suite left (measured, MOTIR-5303) ──────────
  function decided(over: Record<string, unknown> = {}) {
    return {
      gateId: 'gd',
      kind: 'design_result' as const,
      state: 'approved' as const,
      decidedAt: new Date().toISOString(),
      decidedByLabel: null,
      decisionSource: null,
      subjectVersion: 'abcdef0123',
      waitingSince: new Date().toISOString(),
      workItem: {
        id: 'wd',
        key: 9,
        identifier: 'MOTIR-9',
        title: 'Decided by a departed member',
        kind: 'subtask' as const,
        type: 'design' as const,
      },
      subject: null,
      ...over,
    };
  }
  function awaiting() {
    return {
      gateId: 'ga',
      kind: 'design_result' as const,
      state: 'awaiting' as const,
      canDecide: true,
      routedToName: 'Mara',
      waitingSince: new Date().toISOString(),
      workItem: {
        id: 'wa',
        key: 8,
        identifier: 'MOTIR-8',
        title: 'Waiting thing',
        kind: 'subtask' as const,
        type: 'design' as const,
      },
      subject: null,
    };
  }

  it('in the FULL view, the section empty lines speak for the project, not for the reader', async () => {
    listRecords.mockResolvedValue({
      ...empty(true),
      sections: {
        awaiting: { items: [], total: 0 },
        decided: { items: [decided()], total: 1 },
      },
      total: 1,
    });
    await renderPage();
    expect(screen.getByText(en.approvalRecords.empty.awaitingFull)).toBeTruthy();
    // A decider whose label was never recorded reads "No one", never blank.
    expect(screen.getAllByText(en.approvalRecords.noOne).length).toBeGreaterThan(0);
    cleanup();

    listRecords.mockResolvedValue({
      ...empty(true),
      sections: {
        awaiting: { items: [awaiting()], total: 1 },
        decided: { items: [], total: 0 },
      },
      total: 1,
    });
    await renderPage();
    expect(screen.getByText(en.approvalRecords.empty.decidedFull)).toBeTruthy();
  });

  it('a page that ENDS inside the pending half draws no Decided heading — its rows are on a later page', async () => {
    listRecords.mockResolvedValue({
      fullView: false,
      scope: 'mine',
      views: ['mine'],
      sections: {
        awaiting: { items: [awaiting()], total: 1 },
        decided: { items: [], total: 1 },
      },
      total: 2,
      page: 1,
      pageSize: 1,
    });
    await renderPage();
    expect(screen.getByTestId('approval-records-awaiting')).toBeTruthy();
    expect(screen.queryByTestId('approval-records-decided')).toBeNull();
    // …and the pager moves to the next page of the ROOM.
    fireEvent.click(screen.getByRole('button', { name: en.common.pager.nextPage }));
    expect(push).toHaveBeenCalledWith('/approvals?page=2');
  });
});

// ── The Mine / Project switch (Story MOTIR-6179 · MOTIR-6333, design MOTIR-6327) ──
describe('the /approvals page — the view switch and its faces', () => {
  const switchGroup = () => screen.queryByRole('group', { name: en.approvalRecords.viewAria });

  it('a reader with BOTH views (a Member) gets the switch, Mine then Project, on the served view', async () => {
    listRecords.mockResolvedValue({ ...empty(false), scope: 'mine', views: ['mine', 'project'] });
    await renderPage();
    const group = switchGroup();
    expect(group).toBeTruthy();
    const buttons = [...group!.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toEqual([en.roomView.mine, en.roomView.project]);
    expect(buttons[0]!.getAttribute('aria-pressed')).toBe('true');
    // Pressing Project writes an explicit view and drops the page number.
    fireEvent.click(buttons[1]!);
    expect(push).toHaveBeenCalledWith('/approvals?view=project', { scroll: false });
  });

  it('a Viewer (key, no act) gets the Project list with NO switch', async () => {
    listRecords.mockResolvedValue({ ...empty(true), views: ['project'] });
    await renderPage({ view: 'mine' });
    expect(switchGroup()).toBeNull();
    expect(screen.getByText(en.approvalRecords.subtitle.full)).toBeTruthy();
  });

  it('a reader who acts without the key gets Mine with NO switch — `?view=project` is not an error', async () => {
    listRecords.mockResolvedValue({ ...empty(false), views: ['mine'] });
    await renderPage({ view: 'project' });
    expect(switchGroup()).toBeNull();
    expect(screen.getByText(en.approvalRecords.subtitle.own)).toBeTruthy();
  });

  it('a reader with NEITHER the key nor a way to act gets the not-found face', async () => {
    listRecords.mockResolvedValue({ ...empty(false), views: [] });
    await expect(renderPage()).rejects.toThrow('notFound');
  });

  it('a FAILED read renders the ErrorState under the header, the switch staying', async () => {
    listRecords.mockRejectedValue(new Error('db down'));
    recordViews.mockResolvedValue(['mine', 'project']);
    await renderPage({ view: 'project' });
    expect(screen.getByText(en.approvalRecords.readFailedTitle)).toBeTruthy();
    expect(screen.getByText(en.approvalRecords.readFailedBody)).toBeTruthy();
    expect(switchGroup()).toBeTruthy();
    expect(screen.queryByText(en.approvalRecords.empty.title)).toBeNull();
    // …on the view that was ASKED for, since the read never said what it served.
    expect(screen.getByText(en.approvalRecords.subtitle.full)).toBeTruthy();
  });

  it('a FAILED read on a clean URL falls back to the reader’s first view', async () => {
    listRecords.mockRejectedValue(new Error('db down'));
    recordViews.mockResolvedValue(['mine', 'project']);
    await renderPage();
    expect(screen.getByText(en.approvalRecords.readFailedTitle)).toBeTruthy();
    expect(screen.getByText(en.approvalRecords.subtitle.own)).toBeTruthy();
  });

  it('when the VIEWS read fails too, the page still answers — the error face, no switch, never a crash', async () => {
    listRecords.mockRejectedValue(new Error('db down'));
    recordViews.mockRejectedValue(new Error('db still down'));
    await renderPage({ view: 'project' });
    expect(screen.getByText(en.approvalRecords.readFailedTitle)).toBeTruthy();
    expect(switchGroup()).toBeNull();
    expect(screen.getByText(en.approvalRecords.subtitle.own)).toBeTruthy();
  });
});
