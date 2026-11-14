// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { planReviewItem } from '../helpers/planReview';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';
import type { PlanItemDraftDto } from '@/lib/dto/plans';
import type { LiveDrafts } from '@/lib/planning/liveDraft';

// FOLLOW THE WRITING, IN THE PROPOSAL QUICK VIEW (MOTIR-11248; design
// `design/ai-planning/design-notes.md` Part XXX, `peek-proposal-mode--follow-the-writing.mock.html`).
//
// While a card is being written the quick view offers a toggle; pressed, it keeps
// the caret in view after every read, in whichever field holds it; the reader's own
// scroll turns it off; writing ending takes it away without moving the view. Each
// read is a re-render with the next read's values.
//
// happy-dom lays nothing out, so the column's geometry is given here: the main
// column is 400px tall over 2000px of content, at the top of the viewport, and the
// caret sits where `caretAt` says in the column's own content coordinates.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/plans/p1',
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('@/app/(authed)/items/[key]/edit/actions', () => ({
  updateIssueAction: vi.fn(),
  changeStatusAction: vi.fn(),
}));

import { ProposalPeek } from '@/components/planning/ProposalPeek';

const ADD = planReviewItem({
  planItemId: 'pi_add',
  nodeId: 'pi_add',
  title: 'Remember me on this device',
  descriptionMd: null,
  explanationMd: null,
  priority: null,
});

function draft(over: Partial<PlanItemDraftDto> = {}): PlanItemDraftDto {
  return {
    planItemId: 'pi_add',
    sessionKey: 's1',
    seq: 1,
    title: null,
    descriptionMd: null,
    explanationMd: null,
    updatedAt: '2026-11-14T10:00:00.000Z',
    ...over,
  };
}

const drafts = (list: PlanItemDraftDto[], authoring: string[] = []): LiveDrafts => ({
  drafts: list,
  authoring: new Set(authoring),
});

const peek = (item: PlanReviewItemDto | null, liveDrafts: LiveDrafts | null, live = true) => (
  <ProposalPeek item={item} live={live} liveDrafts={liveDrafts} onClose={() => {}} />
);

/** Where the caret is, in the column's content coordinates. */
let caretAt = { top: 600, bottom: 616 };
let scrollTo: ReturnType<typeof vi.fn<(opts: ScrollToOptions) => void>>;

function rect(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    left: 0,
    right: 100,
    x: 0,
    y: top,
    width: 100,
    height: bottom - top,
    toJSON: () => ({}),
  } as DOMRect;
}

beforeEach(() => {
  caretAt = { top: 600, bottom: 616 };
  scrollTo = vi.fn<(opts: ScrollToOptions) => void>();
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.hasAttribute('data-live-caret')) {
      const column = this.closest<HTMLElement>('[data-testid="quick-view-main"]');
      const scrolled = column?.scrollTop ?? 0;
      return rect(caretAt.top - scrolled, caretAt.bottom - scrolled);
    }
    return rect(0, 400);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Give the rendered column its geometry, and record (and apply) every scroll. */
function column(): HTMLElement {
  const main = screen.getByTestId('quick-view-main');
  if (!(main as HTMLElement & { __laidOut?: boolean }).__laidOut) {
    Object.defineProperty(main, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(main, 'scrollHeight', { configurable: true, value: 2000 });
    main.scrollTo = ((opts: ScrollToOptions) => {
      scrollTo(opts);
      main.scrollTop = opts.top ?? main.scrollTop;
    }) as typeof main.scrollTo;
    (main as HTMLElement & { __laidOut?: boolean }).__laidOut = true;
  }
  return main;
}

const toggle = () => screen.queryByTestId('quick-view-live-follow');
const group = () => screen.queryByTestId('quick-view-live-group');
const cue = () => screen.queryByTestId('quick-view-live-cue');

function reduceMotion(reduce: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: reduce && query.includes('reduce'),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

describe('the control (§30.3, F1, F7)', () => {
  it('is offered while the card is written, not pressed, beside the cue', () => {
    render(peek(ADD, drafts([draft({ descriptionMd: 'Keep the session' })])));
    const button = toggle()!;
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    // Its name is the visible label, in both states.
    expect(screen.getByRole('button', { name: 'Follow the writing' })).toBe(button);
    expect(button.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    // The group holds the cue then the toggle, right after the op chip, and wraps
    // as one under the per-op header at the narrow width.
    const g = group()!;
    expect(g.previousElementSibling?.getAttribute('data-testid')).toMatch(/^quick-view-op/);
    expect(g.firstElementChild).toBe(cue());
    expect(cue()!.nextElementSibling).toBe(button);
    expect(g.className).toContain('@max-[32rem]/peek:order-last');
    expect(g.className).toContain('@max-[32rem]/peek:basis-full');
    expect(cue()!.className).not.toContain('basis-full');
  });

  it('is offered before any partial arrives, and pressing then moves nothing (P1)', () => {
    const r = render(peek(ADD, drafts([], ['pi_add'])));
    column();
    fireEvent.click(toggle()!);
    expect(toggle()!.getAttribute('aria-pressed')).toBe('true');
    expect(scrollTo).not.toHaveBeenCalled();
    // The first partial is then brought into view like any read.
    r.rerender(peek(ADD, drafts([draft({ descriptionMd: 'Keep' })], ['pi_add'])));
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 264, behavior: 'auto' });
  });

  it('is absent on a stored proposal, and on the plan page (F7, P9)', () => {
    const r = render(peek(ADD, drafts([])));
    expect(cue()!.getAttribute('data-live-cue')).toBe('idle');
    expect(toggle()).toBeNull();
    expect(group()!.className).toBe('contents');
    r.rerender(peek(ADD, drafts([draft({ title: 'Remember' })]), false));
    expect(toggle()).toBeNull();
    expect(group()).toBeNull();
  });
});

describe('following (§30.4, F2, F3)', () => {
  it('starts off: reads do not move the column until the toggle is pressed (F1)', () => {
    const r = render(peek(ADD, drafts([draft({ descriptionMd: 'Keep' })])));
    const main = column();
    r.rerender(peek(ADD, drafts([draft({ descriptionMd: 'Keep the session' })])));
    expect(scrollTo).not.toHaveBeenCalled();
    expect(main.scrollTop).toBe(0);
  });

  it('the press brings the caret into view smoothly, every later read instantly', () => {
    const r = render(peek(ADD, drafts([draft({ descriptionMd: 'Keep' })])));
    const main = column();
    fireEvent.click(toggle()!);
    expect(toggle()!.getAttribute('aria-pressed')).toBe('true');
    // 616 + 48 clear − 400 visible.
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 264, behavior: 'smooth' });
    expect(main.scrollTop).toBe(264);

    caretAt = { top: 900, bottom: 916 };
    r.rerender(peek(ADD, drafts([draft({ descriptionMd: 'Keep the session for 30' })])));
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 564, behavior: 'auto' });
    expect(main.scrollTop).toBe(564);
  });

  it('a read that leaves the caret inside the band moves nothing', () => {
    const r = render(peek(ADD, drafts([draft({ descriptionMd: 'Keep' })])));
    column();
    fireEvent.click(toggle()!);
    scrollTo.mockClear();
    // 612 + 48 = 660, inside the 264 + 400 = 664 the column shows.
    caretAt = { top: 605, bottom: 612 };
    r.rerender(peek(ADD, drafts([draft({ descriptionMd: 'Keep the' })])));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('follows the caret into the field that grew last — up to the title (F3)', () => {
    const r = render(
      peek(ADD, drafts([draft({ title: 'Remember', descriptionMd: 'Keep the session' })])),
    );
    const main = column();
    caretAt = { top: 1500, bottom: 1516 };
    fireEvent.click(toggle()!);
    expect(main.scrollTop).toBe(1164);

    // Only the title grows: the caret moves to it, near the top, and the column
    // scrolls UP to it — following follows the caret, not the bottom.
    caretAt = { top: 40, bottom: 72 };
    r.rerender(
      peek(ADD, drafts([draft({ title: 'Remember me', descriptionMd: 'Keep the session' })])),
    );
    expect(
      document.querySelector('[data-testid="quick-view-live-title"] [data-live-caret]'),
    ).not.toBeNull();
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'auto' });
    expect(main.scrollTop).toBe(0);
  });

  it('writes only the column, never scrollIntoView', () => {
    const into = vi.fn();
    Element.prototype.scrollIntoView = into;
    render(peek(ADD, drafts([draft({ descriptionMd: 'Keep' })])));
    column();
    fireEvent.click(toggle()!);
    expect(into).not.toHaveBeenCalled();
  });

  it('a second press turns it off, and a third resumes from that read', () => {
    const r = render(peek(ADD, drafts([draft({ descriptionMd: 'Keep' })])));
    const main = column();
    fireEvent.click(toggle()!);
    fireEvent.click(toggle()!);
    expect(toggle()!.getAttribute('aria-pressed')).toBe('false');
    scrollTo.mockClear();
    caretAt = { top: 1200, bottom: 1216 };
    r.rerender(peek(ADD, drafts([draft({ descriptionMd: 'Keep the session' })])));
    expect(scrollTo).not.toHaveBeenCalled();

    fireEvent.click(toggle()!);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 864, behavior: 'smooth' });
    expect(main.scrollTop).toBe(864);
  });
});

describe("the reader's own scroll turns it off (§30.5, F4, F9)", () => {
  function following() {
    const r = render(peek(ADD, drafts([draft({ descriptionMd: 'Keep' })])));
    const main = column();
    fireEvent.click(toggle()!);
    expect(toggle()!.getAttribute('aria-pressed')).toBe('true');
    return { r, main };
  }

  function stopsOn(input: (main: HTMLElement) => void) {
    const { r, main } = following();
    act(() => input(main));
    expect(toggle()!.getAttribute('aria-pressed')).toBe('false');
    // Their position is kept across later reads.
    main.scrollTop = 120;
    scrollTo.mockClear();
    caretAt = { top: 1500, bottom: 1516 };
    r.rerender(peek(ADD, drafts([draft({ descriptionMd: 'Keep the session for 30 days' })])));
    expect(scrollTo).not.toHaveBeenCalled();
    expect(main.scrollTop).toBe(120);
  }

  it('the wheel', () => stopsOn((main) => fireEvent.wheel(main, { deltaY: -40 })));
  it('a finger', () =>
    stopsOn((main) =>
      fireEvent.touchStart(main, {
        touches: [{ clientX: 0, clientY: 0 }],
        changedTouches: [{ clientX: 0, clientY: 0 }],
      }),
    ));
  it('a press on the scrollbar (the column itself)', () =>
    stopsOn((main) => fireEvent.pointerDown(main)));
  it('a scroll key with focus in the column', () =>
    stopsOn((main) => fireEvent.keyDown(main, { key: 'ArrowUp' })));
  it('a scroll key after clicking into the column, focus left on the page', () =>
    stopsOn((main) => {
      fireEvent.pointerDown(main.querySelector('[data-live-partial]') ?? main.firstElementChild!);
      (document.activeElement as HTMLElement | null)?.blur();
      fireEvent.keyDown(document.body, { key: 'PageUp' });
    }));

  it('a press on the text, a key elsewhere, or the follow scroll itself do not', () => {
    const { r, main } = following();
    fireEvent.pointerDown(main.firstElementChild!);
    fireEvent.keyDown(toggle()!, { key: 'Tab' });
    fireEvent.scroll(main);
    caretAt = { top: 900, bottom: 916 };
    r.rerender(peek(ADD, drafts([draft({ descriptionMd: 'Keep the session' })])));
    expect(toggle()!.getAttribute('aria-pressed')).toBe('true');
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 564, behavior: 'auto' });
  });

  it('a scroll key on the page while focus is elsewhere does not', () => {
    following();
    fireEvent.keyDown(document.body, { key: 'PageDown' });
    expect(toggle()!.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('per open (§30.2)', () => {
  it('opening a card mid-stream, or reopening it, starts off at the top (P5)', () => {
    const live = drafts([draft({ descriptionMd: 'Keep' })]);
    const r = render(peek(ADD, live));
    column();
    fireEvent.click(toggle()!);
    r.rerender(peek(null, live));
    r.rerender(peek(ADD, live));
    const main = column();
    expect(toggle()!.getAttribute('aria-pressed')).toBe('false');
    expect(main.scrollTop).toBe(0);
  });
});

describe('writing ends while following (F5, F6)', () => {
  it('the stored card lands: the control goes, the cue says Written, the view stays', () => {
    const r = render(peek(ADD, drafts([draft({ descriptionMd: 'Keep the session for 30' })])));
    const main = column();
    fireEvent.click(toggle()!);
    const at = main.scrollTop;
    scrollTo.mockClear();
    r.rerender(peek({ ...ADD, descriptionMd: 'Keep the session for 30 days.' }, drafts([])));
    expect(toggle()).toBeNull();
    expect(cue()!.getAttribute('data-live-cue')).toBe('written');
    expect(group()!.className).toBe('contents');
    expect(scrollTo).not.toHaveBeenCalled();
    expect(main.scrollTop).toBe(at);
  });

  it('the draft goes with no write: the control goes, nothing is announced, nothing moves', () => {
    const r = render(peek(ADD, drafts([draft({ descriptionMd: 'Half a thought' })])));
    const main = column();
    fireEvent.click(toggle()!);
    const at = main.scrollTop;
    scrollTo.mockClear();
    r.rerender(peek(ADD, drafts([])));
    expect(toggle()).toBeNull();
    expect(cue()!.getAttribute('data-live-cue')).toBe('idle');
    expect(cue()!.textContent).toBe('');
    expect(scrollTo).not.toHaveBeenCalled();
    expect(main.scrollTop).toBe(at);
  });

  it('writing on the same card again starts off', () => {
    const r = render(peek(ADD, drafts([draft({ descriptionMd: 'Half' })])));
    column();
    fireEvent.click(toggle()!);
    r.rerender(peek(ADD, drafts([])));
    r.rerender(peek(ADD, drafts([draft({ descriptionMd: 'Again' })])));
    expect(toggle()!.getAttribute('aria-pressed')).toBe('false');
  });

  it('focus on the control moves to the next stop in the header, never to <body> (§30.6)', () => {
    const r = render(peek(ADD, drafts([draft({ descriptionMd: 'Keep' })])));
    toggle()!.focus();
    expect(document.activeElement).toBe(toggle());
    r.rerender(peek({ ...ADD, descriptionMd: 'Keep it.' }, drafts([])));
    expect(toggle()).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
  });
});

describe('reduced motion (F8)', () => {
  it('the press scrolls instantly too', () => {
    reduceMotion(true);
    render(peek(ADD, drafts([draft({ descriptionMd: 'Keep' })])));
    column();
    fireEvent.click(toggle()!);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 264, behavior: 'auto' });
  });
});

describe('opening the quick view on a card being written (§30.6)', () => {
  it('never lands focus on the toggle, so its tooltip stays shut and Escape closes the view', () => {
    render(peek(ADD, drafts([draft({ descriptionMd: 'Keep' })])));
    expect(toggle()).not.toBeNull();
    expect(document.activeElement).not.toBe(toggle());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
  });

  it('firstOpeningStop passes over an opted-out control, inert and hidden stops', async () => {
    const { firstOpeningStop } = await import('@/components/planning/FollowWritingControl');
    document.body.innerHTML = `
      <div id="root">
        <button data-skip-opening-focus id="skip">skip</button>
        <div inert><a href="/x">inert</a></div>
        <div hidden><input id="hidden" /></div>
        <textarea id="first"></textarea>
      </div>`;
    const root = document.getElementById('root')!;
    expect(firstOpeningStop(root)?.id).toBe('first');
    document.getElementById('first')!.remove();
    expect(firstOpeningStop(root)).toBeNull();
    document.body.innerHTML = '';
  });

  it('with no stop, or no element, the dialog keeps its own default', async () => {
    const { focusFirstStopOnOpen } = await import('@/components/planning/ProposalPeek');
    const opening = (target: EventTarget | null) => {
      const event = new Event('focusScope.autoFocusOnMount', { cancelable: true });
      Object.defineProperty(event, 'currentTarget', { value: target });
      focusFirstStopOnOpen(event);
      return event.defaultPrevented;
    };
    expect(opening(null)).toBe(false);
    expect(opening(document.createElement('div'))).toBe(false);
  });
});

describe('nextFocusStop — where focus goes when the control leaves (§30.6)', () => {
  it('takes the next focusable in the header, skipping the control, earlier stops and inert ones', async () => {
    const { nextFocusStop } = await import('@/components/planning/FollowWritingControl');
    document.body.innerHTML = `
      <header>
        <a href="/x" id="before">before</a>
        <button id="from">from</button>
        <div inert><button id="inert">inert</button></div>
        <button disabled id="disabled">disabled</button>
        <button id="close">Close</button>
      </header>`;
    const from = document.getElementById('from')!;
    expect(nextFocusStop(from)?.id).toBe('close');
    document.getElementById('close')!.remove();
    expect(nextFocusStop(from)).toBeNull();
    document.body.innerHTML = '<div><button id="lone">x</button></div>';
    expect(nextFocusStop(document.getElementById('lone')!)).toBeNull();
    document.body.innerHTML = '';
  });
});
