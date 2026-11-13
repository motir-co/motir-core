// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import zh from '@/messages/zh.json';
import en from '@/messages/en.json';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { ActivityAgentVerdictPartDto, ActivityEntryDto } from '@/lib/dto/activity';
import type { ApprovedReviewDTO } from '@/lib/dto/reviewState';

// The AGENT-VERDICT activity entry and the APPROVAL-RECORD line (Story MOTIR-10327 ·
// MOTIR-10338), built to `design/github/design-notes.md` § 32.9 (M12) and
// `design/workbench/approvals-row--review-path.mock.html` panel A3.

vi.mock('@/components/ui/MarkdownView', () => ({
  MarkdownView: ({ value, ...rest }: { value: string; 'data-testid'?: string }) => (
    <div data-testid={rest['data-testid']}>{value}</div>
  ),
}));

const { ActivityEntryRow } =
  await import('@/app/(authed)/items/[key]/_components/ActivityEntryRow');
const { ApprovalReviewLine } = await import('@/components/approvals/ApprovalReviewLine');

const V =
  'moooon/acme#88@3f2a9c1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,moooon/api#41@9b07de4bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const COMMITS = 'moooon/acme#88 @ 3f2a9c1, moooon/api#41 @ 9b07de4';

function entry(part: Partial<ActivityAgentVerdictPartDto> = {}): {
  entry: ActivityEntryDto;
  part: ActivityAgentVerdictPartDto;
} {
  const p: ActivityAgentVerdictPartDto = {
    kind: 'agentVerdict',
    recordId: 'rec-1',
    verdict: 'pass',
    outcome: 'decided',
    hosted: false,
    harness: 'Claude Code',
    model: 'claude-opus-5-5',
    subjectVersion: V,
    findingsExcerpt: null,
    notified: null,
    checklist: [],
    ...part,
  };
  return {
    part: p,
    entry: {
      id: 'rev-1',
      workItemId: 'wi-1',
      changeKind: 'agent_verdict',
      changedAt: new Date(Date.now() - 60_000).toISOString(),
      actor: { userId: 'u-1', name: 'Ana Lima', image: null },
      parts: [p],
    },
  };
}

function renderEntry(part: Partial<ActivityAgentVerdictPartDto> = {}, messages?: object) {
  const e = entry(part);
  return renderWithIntl(<ActivityEntryRow entry={e.entry} part={e.part} statusCategories={{}} />, {
    ...(messages ? { messages: messages as Record<string, unknown>, locale: 'zh' } : {}),
  });
}

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

describe('the agent-verdict activity entry', () => {
  it('a pass names the own agent with its harness, the commits, and the model on the agent', () => {
    const { container } = renderEntry();
    expect(container.textContent).toContain(
      `Ana Lima's agent (Claude Code) passed the review at ${COMMITS}`,
    );
    const agent = screen.getByText("Ana Lima's agent (Claude Code)");
    expect(agent.getAttribute('title')).toBe('Claude Code · claude-opus-5-5');
    expect(container.querySelector('#agent-verdict-rec-1')).not.toBeNull();
    // A pass with no findings draws no Findings door and names nobody notified.
    expect(screen.queryByRole('button', { name: 'Findings' })).toBeNull();
  });

  it('the hosted agent is named as Motir’s', () => {
    const { container } = renderEntry({ hosted: true, harness: 'Motir hosted review' });
    expect(container.textContent).toContain(`Motir agent passed the review at ${COMMITS}`);
  });

  it('a send-back opens its findings and says who was notified', () => {
    renderEntry({
      verdict: 'changes_requested',
      findingsExcerpt: '**major** — no header row.',
      notified: { type: 'user', userId: 'u-2', name: 'Bo Chen', image: null },
    });
    expect(screen.getByText(/asked for changes at/)).toBeTruthy();
    expect(screen.getByText('Bo Chen was notified.')).toBeTruthy();
    const door = screen.getByRole('button', { name: 'Findings' });
    expect(door.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('agent-verdict-findings')).toBeNull();
    fireEvent.click(door);
    expect(door.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('agent-verdict-findings').textContent).toContain('no header row');
    fireEvent.click(door);
    expect(screen.queryByTestId('agent-verdict-findings')).toBeNull();
  });

  it('a notified person who has left reads as a former member', () => {
    const { container } = renderEntry({
      verdict: 'changes_requested',
      notified: { type: 'user', userId: 'u-2', name: null, image: null },
    });
    expect(container.textContent).toContain(
      String(en.approvalGate.reviewPath.activity.notified).replace(
        '{name}',
        String(en.activity.formerMember),
      ),
    );
  });

  it('the link from the notification opens the findings on arrival', async () => {
    window.location.hash = '#agent-verdict-rec-1';
    await act(async () => {
      renderEntry({ verdict: 'changes_requested', findingsExcerpt: 'The finding.' });
    });
    expect(screen.getByTestId('agent-verdict-findings').textContent).toBe('The finding.');
  });

  it('arriving at the entry’s address scrolls it into view once it streams in (MOTIR-10458)', async () => {
    const scrolled = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrolled;
    try {
      window.location.hash = '#agent-verdict-rec-1';
      let container!: HTMLElement;
      await act(async () => {
        ({ container } = renderEntry({ verdict: 'changes_requested', findingsExcerpt: 'Here.' }));
      });
      expect(scrolled).toHaveBeenCalledWith({ block: 'start' });
      expect(scrolled.mock.contexts[0]).toBe(container.querySelector('#agent-verdict-rec-1'));
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('an entry the address does not name does not move the page', async () => {
    const scrolled = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrolled;
    try {
      window.location.hash = '#agent-verdict-another';
      await act(async () => {
        renderEntry({ verdict: 'changes_requested', findingsExcerpt: 'Elsewhere.' });
      });
      expect(scrolled).not.toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('a later move to the entry’s address opens it too, until the reader closes it', async () => {
    const { unmount } = renderEntry({ verdict: 'changes_requested', findingsExcerpt: 'Later.' });
    expect(screen.queryByTestId('agent-verdict-findings')).toBeNull();
    await act(async () => {
      window.location.hash = '#agent-verdict-rec-1';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(screen.getByTestId('agent-verdict-findings').textContent).toBe('Later.');
    fireEvent.click(screen.getByRole('button', { name: 'Findings' }));
    expect(screen.queryByTestId('agent-verdict-findings')).toBeNull();
    unmount();
  });

  it('a late verdict is marked Late, says why it decided nothing, and offers no findings', () => {
    const { container } = renderEntry({
      outcome: 'late',
      verdict: 'changes_requested',
      findingsExcerpt: 'Ignored.',
    });
    expect(screen.getByText('Late')).toBeTruthy();
    expect(container.textContent).toContain(
      `Reviewed ${COMMITS}, which is no longer the current version. It decided nothing.`,
    );
    expect(screen.queryByRole('button', { name: 'Findings' })).toBeNull();
  });

  it('a second verdict is marked Second review and decided nothing', () => {
    const { container } = renderEntry({ outcome: 'second' });
    expect(screen.getByText('Second review')).toBeTruthy();
    expect(container.textContent).toContain(
      'A second review at a version already decided. It decided nothing.',
    );
  });

  it('renders in zh with the glossary’s 智能体', () => {
    const { container } = renderEntry({ hosted: true }, zh);
    expect(container.textContent).toContain(`Motir 智能体 在 ${COMMITS} 上通过了审查`);
  });
});

describe('the approval-record line', () => {
  const cases: Array<[ApprovedReviewDTO, string]> = [
    [
      { kind: 'reviewed', commits: COMMITS },
      `Approved by Ana Lima · reviewed by agent at ${COMMITS}`,
    ],
    [
      { kind: 'skipped', by: 'Bo Chen', reason: 'No staging access.' },
      'Approved by Ana Lima · review skipped by Bo Chen',
    ],
    [
      { kind: 'dismissed', by: 'Bo Chen', reason: 'Out of scope.' },
      'Approved by Ana Lima · review dismissed by Bo Chen',
    ],
    [{ kind: 'none' }, 'Approved by Ana Lima · not reviewed by an agent'],
  ];

  it.each(cases)('reads %o as its sentence, the name without the address', (review, text) => {
    renderWithIntl(<ApprovalReviewLine review={review} deciderLabel="Ana Lima <ana@ex.com>" />);
    const line = screen.getByTestId('approval-review-line');
    expect(line.textContent?.startsWith(text)).toBe(true);
    expect(line.getAttribute('data-review')).toBe(review.kind);
    expect(line.className).toContain('text-(--el-text-secondary)');
  });

  it('a skipped or dismissed line carries the reason as its title and for a screen reader', () => {
    renderWithIntl(
      <ApprovalReviewLine
        review={{ kind: 'dismissed', by: 'Bo Chen', reason: 'Out of scope.' }}
        deciderLabel="Ana Lima <ana@ex.com>"
      />,
    );
    const line = screen.getByTestId('approval-review-line');
    expect(line.getAttribute('title')).toBe('Out of scope.');
    expect(line.querySelector('.sr-only')?.textContent).toBe('Reason: Out of scope.');
  });

  it('names nobody as “someone” rather than a blank', () => {
    renderWithIntl(
      <ApprovalReviewLine
        review={{ kind: 'skipped', by: null, reason: null }}
        deciderLabel={null}
      />,
    );
    const line = screen.getByTestId('approval-review-line');
    expect(line.textContent).toBe('Approved by someone · review skipped by someone');
    expect(line.getAttribute('title')).toBeNull();
  });

  it('renders in zh', () => {
    renderWithIntl(
      <ApprovalReviewLine review={{ kind: 'none' }} deciderLabel="Ana Lima <ana@ex.com>" />,
      { messages: zh as Record<string, unknown>, locale: 'zh' },
    );
    expect(screen.getByTestId('approval-review-line').textContent).toBe(
      'Ana Lima 已批准 · 未经智能体审查',
    );
  });
});
