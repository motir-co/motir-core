// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import {
  ToFixTag,
  toFixTagId,
  toFixTagNameKey,
  toFixTagState,
} from '@/components/workItems/ToFixTag';
import type { WorkItemFixReasonDto } from '@/lib/dto/fixReason';
import { FIX_REASON_PRIORITY } from '@/lib/workItems/fixReason';
import enMessages from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';

// THE TO FIX TAG (Story MOTIR-6589 · MOTIR-6610; design MOTIR-6608). One
// component, two forms, one done-category rule. The tag is the one SOLID danger
// fill on its surfaces, so every form asserts the fill and its ink together — the
// ink is legal only on that fill (MOTIR-3663).

afterEach(cleanup);

const NAMES: Record<WorkItemFixReasonDto, string> = {
  run_died: 'To fix · run died',
  queue_failed: 'To fix · failed in the merge queue',
  conflicted: 'To fix · conflicts with its base branch',
  out_of_date: 'To fix · out of date with its base branch',
  ci_failed: 'To fix · CI failed',
  changes_requested: 'To fix · changes requested',
};

describe('toFixTagState — the drawing rule', () => {
  it('draws the reason off the done category, and nothing without one', () => {
    for (const reason of FIX_REASON_PRIORITY) {
      expect(toFixTagState(reason, 'in_progress')).toBe(reason);
      expect(toFixTagState(reason, 'todo')).toBe(reason);
      expect(toFixTagState(reason, null)).toBe(reason);
    }
    expect(toFixTagState(null, 'in_progress')).toBeNull();
    expect(toFixTagState(undefined, 'in_progress')).toBeNull();
  });

  it('draws NOTHING for a done-category card, even with a stale reason', () => {
    expect(toFixTagState('ci_failed', 'done')).toBeNull();
  });
});

describe('ToFixTag — the glyph form (List / Tree status cell)', () => {
  it.each(FIX_REASON_PRIORITY)('%s: a wrench on a danger disc, named for its reason', (reason) => {
    render(<ToFixTag fixReason={reason} statusCategory="in_progress" form="glyph" />);
    const el = screen.getByRole('img', { name: NAMES[reason] });
    expect(el.getAttribute('title')).toBe(NAMES[reason]);
    expect(el.getAttribute('data-to-fix')).toBe(reason);
    expect(el.className).toContain('bg-(--el-danger)');
    expect(el.className).toContain('text-(--el-danger-text)');
    expect(el.className).toContain('shrink-0');
    expect(el.querySelector('.lucide-wrench')).toBeTruthy();
  });

  it('renders nothing for no reason, and for a done card', () => {
    const { container: none } = render(
      <ToFixTag fixReason={null} statusCategory="in_progress" form="glyph" />,
    );
    expect(none.innerHTML).toBe('');
    cleanup();
    const { container: done } = render(
      <ToFixTag fixReason="conflicted" statusCategory="done" form="glyph" />,
    );
    expect(done.innerHTML).toBe('');
  });
});

describe('ToFixTag — the label form (board card, quick view)', () => {
  it.each(FIX_REASON_PRIORITY)(
    '%s: "To fix", with the reason in the title and a sr-only tail',
    (reason) => {
      render(<ToFixTag fixReason={reason} statusCategory="in_progress" id="t-1" />);
      const el = document.getElementById('t-1')!;
      expect(el.getAttribute('data-to-fix')).toBe(reason);
      expect(el.getAttribute('title')).toBe(NAMES[reason]);
      // The whole text, sr-only tail included, IS the sentence — what a board card's
      // aria-describedby reads.
      expect(el.textContent).toBe(NAMES[reason]);
      expect(el.querySelector('.sr-only')?.textContent).toBe(NAMES[reason].slice('To fix'.length));
      expect(el.className).toContain('bg-(--el-danger)');
      expect(el.className).toContain('text-(--el-danger-text)');
      expect(el.className).toContain('whitespace-nowrap');
    },
  );

  it('reads in zh', () => {
    render(<ToFixTag fixReason="queue_failed" statusCategory="in_progress" id="t-zh" />, {
      locale: 'zh',
      messages: zhMessages,
    });
    const el = document.getElementById('t-zh')!;
    expect(el.textContent).toBe('待修复 · 在合并队列中失败');
    expect(el.getAttribute('title')).toBe('待修复 · 在合并队列中失败');
  });

  it('names a dead run in zh', () => {
    render(<ToFixTag fixReason="run_died" statusCategory="in_progress" form="glyph" />, {
      locale: 'zh',
      messages: zhMessages,
    });
    expect(screen.getByRole('img', { name: '待修复 · 运行已中断' })).toBeTruthy();
  });

  // § 32 (MOTIR-6825): the SAME tag, its name naming the review agent — keyed by the gate
  // the refusal was on. A surface that cannot tell the decider keeps the reason's name.
  it('names the review agent when the gate says it sent the card back', () => {
    render(
      <ToFixTag
        fixReason="changes_requested"
        statusCategory="in_progress"
        id="t-agent"
        fixGate="agent_review"
      />,
    );
    const el = document.getElementById('t-agent')!;
    expect(el.getAttribute('title')).toBe('To fix · sent back by the review agent');
    expect(el.textContent).toBe('To fix · sent back by the review agent');
    expect(el.dataset.toFix).toBe('changes_requested');
    cleanup();
    render(
      <ToFixTag
        fixReason="changes_requested"
        statusCategory="in_progress"
        form="glyph"
        fixGate="agent_review"
      />,
      { locale: 'zh', messages: zhMessages },
    );
    expect(screen.getByRole('img', { name: '待修复 · 已被审查智能体退回' })).toBeTruthy();
    cleanup();
    render(
      <ToFixTag
        fixReason="changes_requested"
        statusCategory="in_progress"
        form="glyph"
        fixGate="pull_request_approval"
      />,
    );
    expect(screen.getByRole('img', { name: 'To fix · changes requested' })).toBeTruthy();
    expect(toFixTagNameKey('ci_failed', 'agent_review')).toBe('ci_failed');
  });

  it('builds the card-scoped id the board points aria-describedby at', () => {
    expect(toFixTagId('card-9')).toBe('to-fix-card-9');
  });
});

describe('the catalogues', () => {
  it('name every reason in BOTH locales, each beginning with the tag words', () => {
    for (const [messages, words] of [
      [enMessages, enMessages.workbench.tabs.toFix],
      [zhMessages, zhMessages.workbench.tabs.toFix],
    ] as const) {
      const names = messages.toFix.tagName as Record<string, string>;
      for (const reason of FIX_REASON_PRIORITY) {
        expect(names[reason], reason).toBeTruthy();
        expect(names[reason]!.startsWith(words), reason).toBe(true);
      }
    }
  });
});

describe("ToFixTag — a card carried by another card's entry (MOTIR-7589)", () => {
  it('adds the head to the accessible name, in both forms', () => {
    render(
      <ToFixTag fixReason="run_died" statusCategory="in_progress" form="glyph" headKey="PROD-12" />,
    );
    expect(screen.getByRole('img', { name: `${NAMES.run_died} · with PROD-12` })).toBeTruthy();
    cleanup();
    render(
      <ToFixTag fixReason="ci_failed" statusCategory="in_progress" id="t-2" headKey="PROD-12" />,
    );
    expect(document.getElementById('t-2')!.textContent).toBe(`${NAMES.ci_failed} · with PROD-12`);
  });

  it('keeps its own name with no head', () => {
    render(
      <ToFixTag fixReason="ci_failed" statusCategory="in_progress" form="glyph" headKey={null} />,
    );
    expect(screen.getByRole('img', { name: NAMES.ci_failed })).toBeTruthy();
  });
});
