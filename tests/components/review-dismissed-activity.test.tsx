// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';
import zh from '@/messages/zh.json';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { ActivityEntryDto, ActivityReviewDismissedPartDto } from '@/lib/dto/activity';

// The REVIEW-DISMISSAL activity entry (bug MOTIR-10434): the routed person's dismissal of the
// agent's send-back shows in the card's History and All feeds, in the shipped History row
// grammar — the person as the actor, the commits in the sentence, the reason underneath.

const { ActivityEntryRow } =
  await import('@/app/(authed)/items/[key]/_components/ActivityEntryRow');

const V =
  'moooon/acme#88@3f2a9c1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,moooon/api#41@9b07de4bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const COMMITS = 'moooon/acme#88 @ 3f2a9c1, moooon/api#41 @ 9b07de4';

function renderEntry(
  actorName: string | null = 'Ana Lima',
  reasonMd = 'The finding is about code this card does not change.',
  messages?: object,
) {
  const part: ActivityReviewDismissedPartDto = {
    kind: 'reviewDismissed',
    dismissalId: 'dis-1',
    subjectVersion: V,
    reasonMd,
  };
  const entry: ActivityEntryDto = {
    id: 'rev-1',
    workItemId: 'wi-1',
    changeKind: 'review_dismissed',
    changedAt: new Date(Date.now() - 60_000).toISOString(),
    actor: { userId: 'u-1', name: actorName, image: null },
    parts: [part],
  };
  return renderWithIntl(<ActivityEntryRow entry={entry} part={part} statusCategories={{}} />, {
    ...(messages ? { messages: messages as Record<string, unknown>, locale: 'zh' } : {}),
  });
}

afterEach(() => cleanup());

describe('the review-dismissal activity entry', () => {
  it('names who dismissed the review, at which commits, with the reason', () => {
    const { container } = renderEntry();
    expect(container.textContent).toContain(`Ana Lima dismissed the agent's review at ${COMMITS}`);
    expect(container.textContent).toContain(
      'Reason: The finding is about code this card does not change.',
    );
    // The person is the actor: the initial avatar, not the agent's Bot disc.
    expect(container.querySelector('[aria-hidden]')?.textContent).toBe('A');
  });

  it('keeps a multi-line reason as written', () => {
    const { container } = renderEntry('Ana Lima', 'First line.\nSecond line.');
    const reason = [...container.querySelectorAll('div')].find((el) =>
      el.textContent?.startsWith('Reason:'),
    );
    expect(reason?.textContent).toBe('Reason: First line.\nSecond line.');
    expect(reason?.className).toContain('whitespace-pre-wrap');
  });

  it('a deleted dismisser reads as a former member', () => {
    const { container } = renderEntry(null);
    expect(container.textContent).toContain(`Former member dismissed the agent's review`);
  });

  it('reads in zh', () => {
    const { container } = renderEntry('Ana Lima', '与本卡无关。', zh);
    expect(container.textContent).toContain(`Ana Lima 驳回了智能体在 ${COMMITS} 上的审查`);
    expect(container.textContent).toContain('理由：与本卡无关。');
  });
});
