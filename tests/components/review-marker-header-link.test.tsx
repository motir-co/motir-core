// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ReviewMarkerHeaderLink } from '@/app/(authed)/items/[key]/_components/ReviewMarkerHeaderLink';
import { LATE_FALLBACK_ATTR } from '@/app/(authed)/items/[key]/_components/decisionAnchor';
import type { ReviewMarkerDTO } from '@/lib/dto/reviewState';
import zhMessages from '@/messages/zh.json';

// THE ITEM HEADER'S REVIEW MARKER (Story MOTIR-10327 · MOTIR-10341; design § 32.1–32.2,
// mock M9). The decision marker's twin: a POINTER to the Development section (the one
// carrying `agent_review`), and — for the waiting marker aimed at the reader — the
// copyable `motir review <KEY>` beside it, never inside it.

vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const WAITING: ReviewMarkerDTO = {
  kind: 'waiting_for_own_agent',
  routedTo: { id: 'u1', name: 'Ana Ruiz' },
  forViewer: true,
  command: 'motir review ACME-412',
};

let scrolled: Element[] = [];
beforeEach(() => {
  scrolled = [];
  Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
    scrolled.push(this);
  });
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

function section(kinds: string) {
  const el = document.createElement('div');
  el.setAttribute('data-decision-anchor', kinds);
  el.tabIndex = -1;
  document.body.appendChild(el);
  return el;
}

describe('ReviewMarkerHeaderLink', () => {
  it('reads as the state and the destination, and lands on the section carrying agent_review', () => {
    const design = section('design_result');
    const development = section('pull_request_approval decision_approval agent_review');
    render(<ReviewMarkerHeaderLink marker={{ kind: 'agent_reviewing' }} identifier="ACME-412" />);
    const button = screen.getByRole('button', {
      name: 'An agent is reviewing this work. Go to the agent review',
    });
    expect(button.querySelector('[data-review-marker="agent_reviewing"]')).toBeTruthy();
    expect(button.querySelector('.lucide-arrow-down')).toBeTruthy();
    // Not the waiting marker: no command.
    expect(screen.queryByRole('button', { name: /Copy motir review/ })).toBeNull();

    fireEvent.click(button);
    expect(scrolled).toEqual([development]);
    expect(scrolled).not.toContain(design);
    expect(document.activeElement).toBe(development);
  });

  it('the waiting marker for the reader carries the command chip AFTER the pointer', () => {
    render(<ReviewMarkerHeaderLink marker={WAITING} identifier="ACME-412" />);
    const pointer = screen.getByRole('button', {
      name: 'Waiting for your review agent — run motir review ACME-412. Go to the agent review',
    });
    const copy = screen.getByRole('button', { name: 'Copy motir review ACME-412' });
    expect(pointer.contains(copy)).toBe(false);
    expect(pointer.compareDocumentPosition(copy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('someone else’s waiting marker names them and offers no command', () => {
    render(
      <ReviewMarkerHeaderLink marker={{ ...WAITING, forViewer: false }} identifier="ACME-412" />,
    );
    expect(
      screen.getByRole('button', {
        name: "Waiting for Ana Ruiz's review agent. Go to the agent review",
      }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Copy motir review/ })).toBeNull();
  });

  it('pressed before Development has streamed: waits at the fallback, then lands once', async () => {
    const fallback = document.createElement('div');
    fallback.setAttribute(LATE_FALLBACK_ATTR, '');
    document.body.appendChild(fallback);
    render(<ReviewMarkerHeaderLink marker={{ kind: 'agent_reviewing' }} identifier="ACME-412" />);
    const button = screen.getAllByRole('button')[0]!;
    fireEvent.click(button);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.querySelector('.lucide-loader-circle')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Opening the agent review…');

    let development!: HTMLElement;
    await act(async () => {
      fallback.remove();
      development = section('agent_review');
    });
    expect(scrolled).toEqual([fallback, development]);
    expect(button.getAttribute('aria-busy')).toBeNull();
  });

  it('renders in Chinese', () => {
    render(<ReviewMarkerHeaderLink marker={{ kind: 'agent_reviewing' }} identifier="ACME-412" />, {
      locale: 'zh',
      messages: zhMessages,
    });
    expect(document.querySelector('[data-review-marker]')?.textContent).toBe('智能体审查中');
  });
});
