// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { PlannabilityDto } from '@/lib/dto/plannability';

// THE PLAN BUTTON CHECKS FIRST (MOTIR-10544; design MOTIR-10543,
// `design/roadmap/roadmap--plan-check-alert.mock.html`).
//
// The click asks `GET /api/work-items/plannability` and then does exactly one of
// three things: opens the planning overlay (can plan), opens the can't-plan alert
// (can't plan), or shows the check-failed toast with Retry (the check failed).
// `fetch` is stubbed with the route's own answer shapes, `next/navigation` is
// mocked because the launcher reads the address, and `shallowPush` is spied: it
// is the ONE write that opens the overlay, so "the overlay did not open" is
// "shallowPush was not called" — and no planning session can be created without
// the overlay, which is the only thing that creates one from this door.
const pathname = '/roadmap';
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams('scope=project'),
}));
const { shallowPush } = vi.hoisted(() => ({ shallowPush: vi.fn() }));
vi.mock('@/lib/navigation/shallowUrl', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/navigation/shallowUrl')>()),
  shallowPush,
}));

const { WorkItemNode } = await import('@/components/planning/WorkItemNode');
const { ToastProvider } = await import('@/components/ui/Toast');
const { withPlanningOverlay } = await import('@/lib/planning/launcher');
type WorkItemNodeData = import('@/components/planning/WorkItemNode').WorkItemNodeData;

const story: WorkItemNodeData = {
  id: 'S1',
  identifier: 'MOTIR-10552',
  title: 'Export a sprint report as a PDF',
  kind: 'story',
  status: 'todo',
  statusCategory: 'todo',
  hasChildren: false,
};

const ONE_BLOCKER: PlannabilityDto = {
  plannable: false,
  reasons: [
    {
      kind: 'blocker_has_no_subtasks',
      blockers: [
        {
          id: 'blk-10550',
          identifier: 'MOTIR-10550',
          title: 'Store each sprint’s report data as a snapshot',
          toPlan: true,
        },
      ],
    },
  ],
};

const TWO_BLOCKERS: PlannabilityDto = {
  plannable: false,
  reasons: [
    {
      kind: 'blocker_has_no_subtasks',
      blockers: [
        {
          id: 'blk-10546',
          identifier: 'MOTIR-10546',
          title: 'Pick the report fields',
          toPlan: true,
        },
        { id: 'blk-10548', identifier: 'MOTIR-10548', title: 'Render the PDF', toPlan: false },
      ],
    },
  ],
};

type Answer = PlannabilityDto | 'fail' | Promise<PlannabilityDto>;
const answers = new Map<string, Answer>();
const fetchMock = vi.fn(async (input: string) => {
  const key = new URL(input, 'http://x').searchParams.get('key')!;
  const answer = answers.get(key) ?? { plannable: true, reasons: [] };
  if (answer === 'fail') return new Response('{}', { status: 500 });
  return new Response(JSON.stringify(await answer), { status: 200 });
});

beforeEach(() => {
  answers.clear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchMock.mockClear();
  shallowPush.mockClear();
});

function renderCard(wrapper?: { onClick?: () => void; onKeyDown?: () => void }) {
  return render(
    <ToastProvider>
      <div onClick={wrapper?.onClick} onKeyDown={wrapper?.onKeyDown}>
        <WorkItemNode item={story} nextActions={{ plan: true }} />
      </div>
    </ToastProvider>,
  );
}
function planButton(): HTMLElement {
  return screen.getByTestId('node-next-action');
}
async function press(button: HTMLElement = planButton()) {
  await act(async () => {
    button.focus();
    fireEvent.click(button, { button: 0 });
  });
}
function overlayFor(itemKey: string) {
  return withPlanningOverlay('/roadmap?scope=project', {
    kind: 'work-item',
    itemKey,
    hasPlan: false,
    // The card's Plan opens on the start prompt, as the item page's does (MOTIR-10624).
    confirmStart: true,
  });
}

describe('can plan → the planning overlay opens, as it does today', () => {
  it('asks the check for the card, then opens the overlay with it as the target', async () => {
    renderCard();
    await press();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/work-items/plannability?key=MOTIR-10552');
    expect(shallowPush).toHaveBeenCalledTimes(1);
    expect(shallowPush).toHaveBeenCalledWith(overlayFor('MOTIR-10552'));
    expect(String(vi.mocked(shallowPush).mock.calls[0]![0])).toContain('planAsk=1');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('a modified click (⌘ / ctrl / shift / alt) still does nothing', async () => {
    renderCard();
    await act(async () => {
      fireEvent.click(planButton(), { button: 0, metaKey: true });
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(shallowPush).not.toHaveBeenCalled();
  });
});

describe('the Checking state', () => {
  it('the button is busy, disabled and pinned visible until the answer, and ignores a second click', async () => {
    let release: (a: PlannabilityDto) => void = () => {};
    answers.set(
      'MOTIR-10552',
      new Promise<PlannabilityDto>((resolve) => {
        release = resolve;
      }),
    );
    renderCard();
    await press();

    const button = planButton();
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('data-checking')).toBe('true');
    // The hover-only reveal is overridden so the state does not vanish mid-check.
    expect(button.className.split(/\s+/)).toContain('opacity-100');
    expect(button.className.split(/\s+/)).not.toContain('opacity-0');
    expect(button.textContent).toBe('Plan');
    // A second press while checking does nothing.
    fireEvent.click(button, { button: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(shallowPush).not.toHaveBeenCalled();

    await act(async () => {
      release({ plannable: true, reasons: [] });
    });
    await waitFor(() => expect(shallowPush).toHaveBeenCalledTimes(1));
    expect(planButton().getAttribute('aria-busy')).toBeNull();
    expect(planButton().getAttribute('data-checking')).toBeNull();
  });
});

describe("can't plan → the can't-plan alert, and the overlay does not open", () => {
  it('names the blocker by key and title with a link to it', async () => {
    answers.set('MOTIR-10552', ONE_BLOCKER);
    renderCard();
    await press();

    const alert = await screen.findByRole('alertdialog');
    expect(shallowPush).not.toHaveBeenCalled();
    expect(within(alert).getByText("MOTIR-10552 can't be planned yet")).toBeTruthy();
    expect(within(alert).getByText('It waits on a story that has no subtasks yet.')).toBeTruthy();
    const link = within(alert).getByRole('link', { name: /MOTIR-10550/ });
    expect(link.getAttribute('href')).toBe('/items/MOTIR-10550');
    expect(link.textContent).toBe('MOTIR-10550 Store each sprint’s report data as a snapshot');
    const line = link.closest('li')!;
    expect(line.getAttribute('data-reason')).toBe('blocker_has_no_subtasks');
    expect(
      within(line).getByText(
        'Has no subtasks yet. It needs them before MOTIR-10552 can be planned.',
      ),
    ).toBeTruthy();
  });

  it('with two such blockers lists both, one line each, and Plan only on the To plan one', async () => {
    answers.set('MOTIR-10552', TWO_BLOCKERS);
    renderCard();
    await press();

    const alert = await screen.findByRole('alertdialog');
    expect(
      within(alert).getByText('It waits on 2 stories that have no subtasks yet.'),
    ).toBeTruthy();
    const lines = within(alert).getAllByRole('listitem');
    expect(lines).toHaveLength(2);
    expect(within(lines[0]!).getByRole('link').getAttribute('href')).toBe('/items/MOTIR-10546');
    expect(within(lines[1]!).getByRole('link').getAttribute('href')).toBe('/items/MOTIR-10548');
    expect(within(lines[0]!).getByRole('button', { name: 'Plan MOTIR-10546' })).toBeTruthy();
    expect(within(lines[1]!).queryByRole('button')).toBeNull();
    // No plan-anyway action anywhere: the footer carries Close alone.
    expect(
      within(alert)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Plan', 'Close']);
  });

  it('meets the accessibility contract: labelled, described by the lead AND the list, focus in on Close', async () => {
    answers.set('MOTIR-10552', ONE_BLOCKER);
    renderCard();
    await press();

    const alert = await screen.findByRole('alertdialog');
    const title = within(alert).getByRole('heading');
    expect(alert.getAttribute('aria-labelledby')).toBe(title.id);
    const described = (alert.getAttribute('aria-describedby') ?? '').split(' ');
    const lead = within(alert).getByText('It waits on a story that has no subtasks yet.');
    const list = within(alert).getByRole('list');
    expect(described).toEqual([lead.id, list.id]);
    await waitFor(() =>
      expect(document.activeElement).toBe(within(alert).getByRole('button', { name: 'Close' })),
    );
  });

  it('Escape closes it and focus returns to the card’s Plan button', async () => {
    answers.set('MOTIR-10552', ONE_BLOCKER);
    renderCard();
    await press();
    const alert = await screen.findByRole('alertdialog');

    await act(async () => {
      fireEvent.keyDown(alert, { key: 'Escape' });
    });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(document.activeElement).toBe(planButton());
    expect(shallowPush).not.toHaveBeenCalled();
  });

  it('Close closes it, focus returns to the button, and a new click checks again', async () => {
    answers.set('MOTIR-10552', ONE_BLOCKER);
    renderCard();
    await press();
    const alert = await screen.findByRole('alertdialog');

    await act(async () => {
      fireEvent.click(within(alert).getByRole('button', { name: 'Close' }));
    });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(document.activeElement).toBe(planButton());

    answers.set('MOTIR-10552', { plannable: true, reasons: [] });
    await press();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(shallowPush).toHaveBeenCalledWith(overlayFor('MOTIR-10552'));
  });

  it('a line’s Plan closes the alert and plans THE BLOCKER, checked first', async () => {
    answers.set('MOTIR-10552', ONE_BLOCKER);
    renderCard();
    await press();
    const alert = await screen.findByRole('alertdialog');

    await act(async () => {
      fireEvent.click(within(alert).getByRole('button', { name: 'Plan MOTIR-10550' }));
    });
    await waitFor(() => expect(shallowPush).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      '/api/work-items/plannability?key=MOTIR-10552',
      '/api/work-items/plannability?key=MOTIR-10550',
    ]);
    expect(shallowPush).toHaveBeenCalledWith(overlayFor('MOTIR-10550'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('a press inside the alert never reaches the canvas node beneath the button', async () => {
    answers.set('MOTIR-10552', ONE_BLOCKER);
    const onClick = vi.fn();
    const onKeyDown = vi.fn();
    renderCard({ onClick, onKeyDown });
    await press();
    const alert = await screen.findByRole('alertdialog');
    onClick.mockClear();

    fireEvent.click(within(alert).getByRole('list'));
    fireEvent.keyDown(within(alert).getByRole('list'), { key: 'Enter' });
    expect(onClick).not.toHaveBeenCalled();
    expect(onKeyDown).not.toHaveBeenCalled();
  });
});

describe('check failed → the error toast with Retry, and the overlay does not open', () => {
  it('shows the toast, opens neither the overlay nor the alert, and Retry checks again', async () => {
    answers.set('MOTIR-10552', 'fail');
    renderCard();
    await press();

    expect(await screen.findByText("Couldn't check MOTIR-10552")).toBeTruthy();
    expect(
      screen.getByText("Planning didn't open. Check your connection and try again."),
    ).toBeTruthy();
    expect(shallowPush).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(planButton().getAttribute('aria-busy')).toBeNull();

    answers.set('MOTIR-10552', { plannable: true, reasons: [] });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    await waitFor(() => expect(shallowPush).toHaveBeenCalledWith(overlayFor('MOTIR-10552')));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('usePlanCheck — one check at a time', () => {
  it('a second check while one is in flight is ignored', async () => {
    const { renderHook } = await import('@testing-library/react');
    const { usePlanCheck } = await import('@/lib/hooks/usePlanCheck');
    const { NextIntlClientProvider } = await import('next-intl');
    const enMessages = (await import('@/messages/en.json')).default;
    let release: (a: PlannabilityDto) => void = () => {};
    answers.set(
      'MOTIR-10552',
      new Promise<PlannabilityDto>((resolve) => {
        release = resolve;
      }),
    );
    const { result } = renderHook(() => usePlanCheck(), {
      wrapper: ({ children }) => (
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <ToastProvider>{children}</ToastProvider>
        </NextIntlClientProvider>
      ),
    });

    let first: Promise<void> = Promise.resolve();
    await act(async () => {
      first = result.current.check('MOTIR-10552');
      await result.current.check('MOTIR-10552');
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.checking).toBe(true);
    await act(async () => {
      release(ONE_BLOCKER);
      await first;
    });
    expect(result.current.checking).toBe(false);
    expect(result.current.alert).toEqual({ key: 'MOTIR-10552', reasons: ONE_BLOCKER.reasons });
    expect(shallowPush).not.toHaveBeenCalled();
  });
});
