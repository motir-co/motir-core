// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { planReviewItem } from '../helpers/planReview';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';
import type { PlanItemDraftDto } from '@/lib/dto/plans';
import type { LiveDrafts } from '@/lib/planning/liveDraft';

// A CARD BEING WRITTEN, IN THE PROPOSAL QUICK VIEW (Story MOTIR-11190 · Subtask
// MOTIR-11201; design `design/ai-planning/design-notes.md` Part XXIX).
//
// The overlay's live read carries the partial fields an `author` session has
// written so far; the open quick view shows them in the fields' own elements
// with the in-progress cue, hands over to the stored card in place when the write
// lands, and drops them without a word when the draft goes with no write. Each
// read here is a re-render with the next read's values: the text grows because
// the read grew, never on a clock.

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
import { PlanProposalList } from '@/components/planning/PlanProposalList';

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
    updatedAt: '2026-11-13T10:00:00.000Z',
    ...over,
  };
}

function drafts(list: PlanItemDraftDto[], authoring: string[] = []): LiveDrafts {
  return { drafts: list, authoring: new Set(authoring) };
}

function peek(item: PlanReviewItemDto | null, liveDrafts: LiveDrafts | null, live = true) {
  return <ProposalPeek item={item} live={live} liveDrafts={liveDrafts} onClose={() => {}} />;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const box = (field: string) => screen.queryByTestId(`quick-view-live-${field}`);
const shown = (field: string) =>
  box(field)?.querySelector('[data-live-partial]')?.textContent ?? null;
const caretIn = (field: string) =>
  box(field)?.querySelector('[data-live-partial] [data-live-caret]') ?? null;
const cue = () => screen.queryByTestId('quick-view-live-cue');

describe('the in-progress cue', () => {
  it('shows while the card is written, before any partial arrives (P1)', () => {
    render(peek(ADD, drafts([], ['pi_add'])));
    const line = cue()!;
    expect(line.getAttribute('role')).toBe('status');
    expect(line.getAttribute('data-live-cue')).toBe('writing');
    expect(line.textContent).toBe('Being written');
    expect(line.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    // Every field waits: the stored title, the shipped empty bodies, no wrapper.
    expect(box('title')).toBeNull();
    expect(box('descriptionMd')).toBeNull();
    expect(screen.getByText('No description yet.')).toBeTruthy();
    expect(screen.getByText('No explanation yet.')).toBeTruthy();
  });

  it('sits right after the op chip, and wraps by the peek width', () => {
    render(peek(ADD, drafts([draft({ title: 'Remember' })])));
    const line = cue()!;
    expect(line.previousElementSibling?.getAttribute('data-testid')).toMatch(/^quick-view-op/);
    expect(line.className).toContain('@max-[32rem]/peek:basis-full');
    expect(line.closest('header')!.className).toContain('flex-wrap');
    expect(screen.getByTestId('proposal-peek').className).toContain('@container/peek');
  });

  it('is mounted empty when no session writes the card, and absent off the overlay', () => {
    const r = render(peek(ADD, drafts([])));
    expect(cue()!.getAttribute('data-live-cue')).toBe('idle');
    expect(cue()!.textContent).toBe('');
    r.rerender(peek(ADD, drafts([draft({ title: 'x' })]), false));
    expect(cue()).toBeNull();
    expect(box('title')).toBeNull();
  });
});

describe('a live field grows with the read', () => {
  it('shows the partial through the field element, the stored value sr-only (P2, §29.6)', () => {
    const r = render(peek(ADD, drafts([draft({ descriptionMd: 'Keep the session' })])));
    const field = box('descriptionMd')!;
    expect(field.getAttribute('data-live-field')).toBe('growing');
    expect(shown('descriptionMd')).toBe('Keep the session');
    const copy = field.querySelector('[data-live-partial]')!;
    expect(copy.getAttribute('aria-hidden')).toBe('true');
    expect(copy.hasAttribute('inert')).toBe(true);
    // Rendered by the markdown renderer: the caret sits inside its paragraph.
    expect(caretIn('descriptionMd')!.parentElement!.tagName).toBe('P');
    const stored = field.lastElementChild!;
    expect(stored.className).toBe('sr-only');
    expect(stored.textContent).toBe('No description yet.');

    r.rerender(peek(ADD, drafts([draft({ descriptionMd: 'Keep the session for 30 days' })])));
    expect(shown('descriptionMd')).toBe('Keep the session for 30 days');
    expect(document.querySelectorAll('[data-live-caret]')).toHaveLength(1);
  });

  it('puts the one caret on the field that grew last, in reading order (P3)', () => {
    const r = render(peek(ADD, drafts([draft({ title: 'Remember me', descriptionMd: 'Keep' })])));
    expect(box('title')!.getAttribute('data-live-field')).toBe('partial');
    expect(box('descriptionMd')!.getAttribute('data-live-field')).toBe('growing');
    expect(caretIn('title')).toBeNull();
    expect(caretIn('descriptionMd')).not.toBeNull();
    // The title partial is the field's own h2, plain text.
    expect(box('title')!.querySelector('[data-live-partial] h2')!.textContent).toBe('Remember me');

    // Only the title grows on this read: the caret moves to it.
    r.rerender(peek(ADD, drafts([draft({ title: 'Remember me on', descriptionMd: 'Keep' })])));
    expect(box('title')!.getAttribute('data-live-field')).toBe('growing');
    expect(caretIn('title')).not.toBeNull();
    expect(caretIn('descriptionMd')).toBeNull();

    // A read that grows nothing keeps the caret where it was.
    r.rerender(
      peek(ADD, drafts([draft({ title: 'Remember me on', descriptionMd: 'Keep', seq: 2 })])),
    );
    expect(box('title')!.getAttribute('data-live-field')).toBe('growing');
  });

  it('withholds an open bold run at the cut (§29.3, P3)', () => {
    render(peek(ADD, drafts([draft({ explanationMd: 'Tokens are revoked by **Sign out' })])));
    expect(shown('explanationMd')).toBe('Tokens are revoked by Sign out');
  });

  it('withholds a list item with nothing in it yet, the caret in the last item', () => {
    render(peek(ADD, drafts([draft({ explanationMd: 'Two rules:\n\n- first\n- ' })])));
    const copy = box('explanationMd')!.querySelector('[data-live-partial]')!;
    expect(copy.querySelectorAll('li')).toHaveLength(1);
    expect(caretIn('explanationMd')!.closest('li')!.textContent).toBe('first');
  });

  it('places the caret even when the partial is still empty', () => {
    render(peek(ADD, drafts([draft({ title: '' })])));
    expect(caretIn('title')!.parentElement!.tagName).toBe('H2');
  });

  it('opened mid-stream, the first frame already shows the partial (P5, P8)', () => {
    const live = drafts([draft({ title: 'Remember me on this' })]);
    const r = render(peek(ADD, live));
    expect(shown('title')).toBe('Remember me on this');
    r.rerender(peek(null, live));
    expect(box('title')).toBeNull();
    r.rerender(peek(ADD, live));
    expect(shown('title')).toBe('Remember me on this');
    expect(cue()!.getAttribute('data-live-cue')).toBe('writing');
  });

  it("ignores another proposal's draft", () => {
    render(peek(ADD, drafts([draft({ planItemId: 'pi_other', title: 'Not this one' })])));
    expect(box('title')).toBeNull();
    expect(cue()!.getAttribute('data-live-cue')).toBe('idle');
  });
});

describe('the hand-over and the refused write', () => {
  it('the stored card lands in place and Written is announced once (P6)', () => {
    const r = render(peek(ADD, drafts([draft({ descriptionMd: 'Keep the session for 30' })])));
    expect(cue()!.getAttribute('data-live-cue')).toBe('writing');

    const LANDED = { ...ADD, descriptionMd: 'Keep the session for 30 days.' };
    r.rerender(peek(LANDED, drafts([])));
    expect(box('descriptionMd')).toBeNull();
    expect(document.querySelector('[data-live-caret]')).toBeNull();
    expect(screen.getByText('Keep the session for 30 days.')).toBeTruthy();
    const line = cue()!;
    expect(line.getAttribute('data-live-cue')).toBe('written');
    expect(line.className).toBe('sr-only');
    expect(line.textContent).toBe('Written');
  });

  it('a draft dropped with no write vanishes and announces nothing (P7)', () => {
    const r = render(peek(ADD, drafts([draft({ descriptionMd: 'Half a thought' })])));
    r.rerender(peek(ADD, drafts([])));
    expect(box('descriptionMd')).toBeNull();
    expect(screen.queryByText('Half a thought')).toBeNull();
    expect(screen.getByText('No description yet.')).toBeTruthy();
    expect(cue()!.getAttribute('data-live-cue')).toBe('idle');
    expect(cue()!.textContent).toBe('');
  });

  it('the plan leaving generating with the hand-over still says Written', () => {
    const r = render(peek(ADD, drafts([draft({ title: 'Remember me' })])));
    r.rerender(peek({ ...ADD, title: 'Remember me on this device!' }, null, false));
    expect(cue()!.getAttribute('data-live-cue')).toBe('written');
  });
});

describe('only the live overlay shows a partial (P9)', () => {
  it('the plan page (no `live`) never does, whatever the read carries', () => {
    render(peek(ADD, drafts([draft({ title: 'Remember me' })], ['pi_add']), false));
    expect(box('title')).toBeNull();
    expect(cue()).toBeNull();
    expect(screen.getAllByText('Remember me on this device').length).toBeGreaterThan(0);
  });

  it('the list forwards the drafts to its peek', () => {
    render(
      <PlanProposalList
        items={[ADD]}
        outcome={null}
        live
        liveDrafts={drafts([draft({ title: 'Remember me on' })])}
      />,
    );
    fireEvent.click(screen.getAllByText('Remember me on this device')[0]!);
    expect(shown('title')).toBe('Remember me on');
  });
});
