// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ReviewMarker } from '@/components/approvals/ReviewMarker';
import { ReviewCommand } from '@/components/approvals/ReviewCommand';
import { ReviewedBadge } from '@/components/approvals/ReviewedBadge';
import { ReaderRoutesProvider } from '@/lib/visitor/useReaderRoutes';
import type { CardReviewDTO, ReviewMarkerDTO } from '@/lib/dto/reviewState';
import zhMessages from '@/messages/zh.json';

// THE REVIEW MARKERS, THE COMMAND CHIP AND THE REVIEWED BADGE (Story MOTIR-10327 ·
// MOTIR-10341; `design/github/design-notes.md` § 32.1–32.3, mock M2–M11). Loud and quiet
// differ in fill, ink, glyph AND words — so each pair asserts the treatment, not the words
// alone — and the badge draws only what the read model handed it.

const toast = vi.fn();
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast }) }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeEach(() => toast.mockReset());

const ANA = { id: 'u2', name: 'Ana Ruiz' };
const REVIEWING: ReviewMarkerDTO = { kind: 'agent_reviewing' };
const COULD_NOT_RUN_YOURS: ReviewMarkerDTO = {
  kind: 'could_not_run',
  reason: 'review_failed',
  routedTo: ANA,
  forViewer: true,
};
const WAITING_YOURS: ReviewMarkerDTO = {
  kind: 'waiting_for_own_agent',
  routedTo: ANA,
  forViewer: true,
  command: 'motir review ACME-412',
};

function marker() {
  return document.querySelector('[data-review-marker]') as HTMLElement | null;
}

describe('ReviewMarker — label form', () => {
  it('Agent reviewing is always quiet: neutral pill, Bot glyph', () => {
    render(<ReviewMarker marker={REVIEWING} identifier="ACME-412" id="m-1" />);
    const el = marker()!;
    expect(el.textContent).toBe('Agent reviewing');
    expect(el.getAttribute('title')).toBe('An agent is reviewing this work');
    expect(el.hasAttribute('data-review-loud')).toBe(false);
    expect(el.className).not.toContain('--el-tint-yellow');
    expect(el.querySelector('.lucide-bot')).toBeTruthy();
    expect(document.getElementById('m-1')).toBe(el);
  });

  it('could not run is loud for the routed person, quiet and named for everyone else', () => {
    render(<ReviewMarker marker={COULD_NOT_RUN_YOURS} identifier="ACME-412" />);
    expect(marker()!.textContent).toBe('Review could not run');
    expect(marker()!.hasAttribute('data-review-loud')).toBe(true);
    expect(marker()!.className).toContain('--el-tint-yellow');
    expect(marker()!.querySelector('.lucide-bot-off')).toBeTruthy();
    cleanup();

    render(
      <ReviewMarker marker={{ ...COULD_NOT_RUN_YOURS, forViewer: false }} identifier="ACME-412" />,
    );
    expect(marker()!.textContent).toBe('Review could not run · Ana Ruiz');
    expect(marker()!.getAttribute('title')).toBe(
      'The agent review could not run — waiting on Ana Ruiz',
    );
    expect(marker()!.hasAttribute('data-review-loud')).toBe(false);
    expect(marker()!.className).not.toContain('--el-tint-yellow');
  });

  it('waiting is loud for you with the command in its title; others read whose agent', () => {
    render(<ReviewMarker marker={WAITING_YOURS} identifier="ACME-412" />);
    expect(marker()!.textContent).toBe('Waiting for your review agent');
    expect(marker()!.getAttribute('title')).toBe(
      'Waiting for your review agent — run motir review ACME-412',
    );
    expect(marker()!.querySelector('.lucide-square-terminal')).toBeTruthy();
    cleanup();

    render(
      <ReviewMarker
        marker={{ ...WAITING_YOURS, forViewer: false, routedTo: null }}
        identifier="ACME-412"
      />,
    );
    expect(marker()!.textContent).toBe("Waiting for this work item's assignee's review agent");
  });

  it('carries a trailing glyph and extra classes for the header pointer', () => {
    render(
      <ReviewMarker
        marker={REVIEWING}
        identifier="ACME-412"
        className="extra-class"
        trailing={<i data-testid="trail" />}
      />,
    );
    expect(marker()!.className).toContain('extra-class');
    expect(screen.getByTestId('trail')).toBeTruthy();
  });

  it('is translated in zh, with 智能体 for agent', () => {
    render(<ReviewMarker marker={REVIEWING} identifier="ACME-412" />, {
      locale: 'zh',
      messages: zhMessages,
    });
    expect(marker()!.textContent).toBe('智能体审查中');
  });
});

describe('ReviewMarker — glyph form (status cell)', () => {
  it('is an image named by the full sentence; loud is the yellow disc, quiet is bare', () => {
    render(<ReviewMarker form="glyph" marker={WAITING_YOURS} identifier="ACME-412" />);
    const loud = screen.getByRole('img', {
      name: 'Waiting for your review agent — run motir review ACME-412',
    });
    expect(loud.className).toContain('--el-tint-yellow');
    expect(loud.className).toContain('shrink-0');
    cleanup();

    render(<ReviewMarker form="glyph" marker={REVIEWING} identifier="ACME-412" />);
    const quiet = screen.getByRole('img', { name: 'An agent is reviewing this work' });
    expect(quiet.className).not.toContain('--el-tint-yellow');
    expect(quiet.className).toContain('--el-text-secondary');
    expect(quiet.querySelector('.lucide-bot')).toBeTruthy();
  });
});

describe('ReviewCommand', () => {
  it('copies the command, toasts it, and says Copied in place for two seconds', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const outer = vi.fn();
    render(
      <div onClick={outer}>
        <ReviewCommand command="motir review ACME-412" identifier="ACME-412" />
      </div>,
    );
    expect(screen.getByText('motir review ACME-412').tagName).toBe('CODE');
    const button = screen.getByRole('button', { name: 'Copy motir review ACME-412' });
    expect(button.getAttribute('data-testid')).toBe('review-command-copy-ACME-412');

    await act(async () => {
      fireEvent.click(button);
    });
    expect(writeText).toHaveBeenCalledWith('motir review ACME-412');
    expect(outer).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith({
      variant: 'success',
      title: 'Command copied',
      description: 'Run motir review ACME-412 in your own agent to review this work.',
    });
    expect(screen.getByRole('status').textContent).toBe('Copied');
    expect(button.querySelector('.lucide-check')).toBeTruthy();

    // A second press restarts the window rather than stacking timers.
    await act(async () => {
      fireEvent.click(button);
    });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByRole('status').textContent).toBe('');
    expect(button.querySelector('.lucide-copy')).toBeTruthy();
  });
});

const REVIEWED: CardReviewDTO = {
  identifier: 'ACME-412',
  marker: null,
  reviewed: {
    reviewer: {
      kind: 'own',
      person: ANA,
      harness: 'Claude Code',
      model: 'some-model',
    },
    at: '2026-11-05T09:00:00.000Z',
    commits: [
      { repo: 'acme/web', number: 88, headSha: '3f2a9c1aaaaaaaa' },
      { repo: 'acme/api', number: 41, headSha: '9b07de4bbbbbbbb' },
    ],
  },
  recordRef: { kind: 'record', id: 'rec1' },
};
const NOW = new Date('2026-11-05T10:00:00.000Z');

describe('ReviewedBadge — reviewed', () => {
  it('the label form is a success pill that opens its card on hover and closes on leave', () => {
    render(<ReviewedBadge review={REVIEWED} />, { now: NOW });
    const badge = screen.getByRole('note', { name: 'Reviewed by an agent at the current commits' });
    expect(badge.textContent).toBe('Reviewed');
    expect(badge.getAttribute('data-reviewed-badge')).toBe('reviewed');
    expect(screen.queryByTestId('reviewed-card')).toBeNull();

    fireEvent.mouseEnter(badge.parentElement!);
    const card = screen.getByTestId('reviewed-card');
    expect(badge.getAttribute('aria-describedby')).toBe(card.id);
    expect(card.getAttribute('data-surface')).toBe('popover');
    expect(card.textContent).toContain("Reviewed by Ana Ruiz's own agent");
    expect(card.textContent).toContain('Claude Code · some-model');
    expect(card.textContent).toContain('1 hour ago');
    expect(card.textContent).toContain('At these commits');
    expect(card.textContent).toContain('acme/web#88 @ 3f2a9c1');
    expect(card.textContent).toContain('acme/api#41 @ 9b07de4');
    expect(screen.getByRole('link', { name: 'Findings and checklist' }).getAttribute('href')).toBe(
      '/items/ACME-412?activity=all#agent-verdict-rec1',
    );

    fireEvent.mouseLeave(badge.parentElement!);
    expect(screen.queryByTestId('reviewed-card')).toBeNull();
  });

  it('on the Visitor tree its Findings and checklist keeps the reader’s own route, on the All tab', () => {
    render(
      <ReaderRoutesProvider identifier="acme">
        <ReviewedBadge review={REVIEWED} />
      </ReaderRoutesProvider>,
      { now: NOW },
    );
    fireEvent.mouseEnter(screen.getByRole('note').parentElement!);
    expect(screen.getByRole('link', { name: 'Findings and checklist' }).getAttribute('href')).toBe(
      '/p/acme/items/ACME-412?activity=all#agent-verdict-rec1',
    );
  });

  it('a pass with only a gate opens the Development section, unchanged', () => {
    render(<ReviewedBadge review={{ ...REVIEWED, recordRef: { kind: 'gate', id: 'g1' } }} />, {
      now: NOW,
    });
    fireEvent.mouseEnter(screen.getByRole('note').parentElement!);
    expect(screen.getByRole('link', { name: 'Findings and checklist' }).getAttribute('href')).toBe(
      '/items/ACME-412#development',
    );
  });

  it('opens on keyboard focus, stays open while focus moves into its link, closes on Escape', () => {
    render(<ReviewedBadge review={REVIEWED} />, { now: NOW });
    const badge = screen.getByRole('note');
    expect(badge.tabIndex).toBe(0);
    act(() => badge.focus());
    const link = screen.getByRole('link', { name: 'Findings and checklist' });
    fireEvent.blur(badge, { relatedTarget: link });
    expect(screen.getByTestId('reviewed-card')).toBeTruthy();

    fireEvent.keyDown(badge, { key: 'Escape' });
    expect(screen.queryByTestId('reviewed-card')).toBeNull();
    // Escape on a closed card is left for the page.
    fireEvent.keyDown(badge, { key: 'Escape' });

    act(() => badge.focus());
    fireEvent.blur(badge, { relatedTarget: document.body });
    expect(screen.queryByTestId('reviewed-card')).toBeNull();
  });

  it('names the hosted agent, falls back for an unnamed person and links a gate to Development', () => {
    render(
      <ReviewedBadge
        review={{
          ...REVIEWED,
          reviewed: { ...REVIEWED.reviewed!, reviewer: { kind: 'hosted', model: null } },
          recordRef: { kind: 'gate', id: 'g1' },
        }}
      />,
      { now: NOW },
    );
    fireEvent.mouseEnter(screen.getByRole('note').parentElement!);
    const card = screen.getByTestId('reviewed-card');
    expect(card.textContent).toContain('Reviewed by Motir agent');
    expect(card.textContent).not.toContain('·');
    expect(screen.getByRole('link').getAttribute('href')).toBe('/items/ACME-412#development');
    cleanup();

    render(
      <ReviewedBadge
        review={{
          ...REVIEWED,
          reviewed: {
            ...REVIEWED.reviewed!,
            reviewer: { kind: 'own', person: null, harness: 'Codex', model: 'm' },
          },
          recordRef: null,
        }}
      />,
      { now: NOW },
    );
    fireEvent.mouseEnter(screen.getByRole('note').parentElement!);
    expect(screen.getByTestId('reviewed-card').textContent).toContain(
      "Reviewed by this work item's assignee's own agent",
    );
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('on a board card it is not interactive: a title, no focus, no card', () => {
    render(<ReviewedBadge review={REVIEWED} interactive={false} id="rb-1" />);
    const badge = document.getElementById('rb-1')!;
    expect(badge.getAttribute('title')).toBe('Reviewed by an agent at the current commits');
    expect(badge.hasAttribute('tabindex')).toBe(false);
    expect(screen.queryByRole('note')).toBeNull();
    fireEvent.mouseEnter(badge);
    expect(screen.queryByTestId('reviewed-card')).toBeNull();
  });

  it('the glyph form is a focusable mint disc with the same card', () => {
    render(<ReviewedBadge review={REVIEWED} form="glyph" />, { now: NOW });
    const glyph = screen.getByRole('img', { name: 'Reviewed by an agent at the current commits' });
    expect(glyph.tabIndex).toBe(0);
    expect(glyph.className).toContain('--el-tint-mint');
    act(() => glyph.focus());
    expect(screen.getByTestId('reviewed-card')).toBeTruthy();
  });

  it('draws nothing when the read model handed it no Reviewed state (a push, a Done card)', () => {
    const { container } = render(
      <ReviewedBadge review={{ ...REVIEWED, reviewed: null, marker: REVIEWING }} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('is translated in zh', () => {
    render(<ReviewedBadge review={REVIEWED} />, { locale: 'zh', messages: zhMessages, now: NOW });
    expect(screen.getByRole('note').textContent).toBe('已审查');
  });
});
