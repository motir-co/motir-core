// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { recordDto } from '../helpers/howToTestFixtures';
import type { WorkItemRefMap, WorkItemRefSummaryDto } from '@/lib/dto/workItems';
import type { TriageItemDetailDto } from '@/lib/dto/triage';

// Bug MOTIR-10023 — ten surfaces handed `MarkdownView` a stored body with no
// `workItemRefs`, so every `[KEY](motir:<id>)` in it drew as "This work item no longer
// exists". Each surface now takes the reader's resolved map and passes it on. Every
// surface here is drawn over the SAME body, which links a live card, a deleted one and
// one the reader cannot browse, and each of the three must draw as itself.

const { resolveChatWorkItemRefsAction } = vi.hoisted(() => ({
  resolveChatWorkItemRefsAction: vi.fn(),
}));
vi.mock('@/app/(authed)/my-agents/_actions', () => ({ resolveChatWorkItemRefsAction }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/items/MOTIR-7',
  useSearchParams: () => new URLSearchParams(),
}));

import { ObsolescenceField } from '@/components/issues/ObsolescenceField';
import { TodoRowReadOnly } from '@/app/(authed)/items/[key]/_components/TodoListSection';
import { ChoicePortBody } from '@/components/approvals/ChoiceGate';
import { DecisionPortBody } from '@/components/approvals/DecisionConfirmGate';
import { HowToTestBlock } from '@/components/howToTest/HowToTestBlock';
import { PassedBand, SentBackBand } from '@/components/github/AgentReviewBand';
import { TriageDetail } from '@/app/(authed)/triage/_components/TriageDetail';
import { RequirementDocument } from '@/components/planning/RequirementDocument';
import { ChatTranscript } from '@/app/(authed)/my-agents/_components/chat/ChatTranscript';
import { emptyTranscript } from '@/app/(authed)/my-agents/_components/chat/transcriptModel';

afterEach(() => {
  cleanup();
  resolveChatWorkItemRefsAction.mockReset();
});

const LIVE: WorkItemRefSummaryDto = {
  accessible: true,
  id: 'wi_live',
  identifier: 'MOTIR-706',
  title: 'The seed registry',
  kind: 'subtask',
  archived: false,
  status: { key: 'done', label: 'Done', category: 'done' },
  type: null,
  assignee: null,
};
const HIDDEN: WorkItemRefSummaryDto = { accessible: false, id: 'wi_hidden' };

const BODY =
  'Settles [MOTIR-706](motir:wi_live), retires [MOTIR-1](motir:wi_gone), ' +
  'and hands work to [MOTIR-42](motir:wi_hidden).';
const REFS: WorkItemRefMap = { wi_live: LIVE, wi_hidden: HIDDEN };

function chipFor(root: HTMLElement, key: string): Element {
  const chip = Array.from(root.querySelectorAll('.wi-chip')).find((el) =>
    el.querySelector('.wi-key')?.textContent?.includes(key),
  );
  expect(chip, `a chip for ${key}`).toBeTruthy();
  return chip!;
}

/** The three states, on whatever root the surface drew into. */
function expectThreeChips(root: HTMLElement) {
  const live = chipFor(root, 'MOTIR-706');
  expect(live.classList.contains('is-deleted')).toBe(false);
  expect(live.textContent).toContain('The seed registry');
  expect(chipFor(root, 'MOTIR-1').classList.contains('is-deleted')).toBe(true);
  const hidden = chipFor(root, 'MOTIR-42');
  expect(hidden.classList.contains('is-noaccess')).toBe(true);
  expect(hidden.classList.contains('is-deleted')).toBe(false);
}

const noop = () => {};

const TRIAGE: TriageItemDetailDto = {
  id: 't1',
  kind: 'bug',
  identifier: 'MOTIR-9',
  title: 'Login fails',
  descriptionMd: BODY,
  submitter: { kind: 'member', userId: 'u1', name: 'Ana', email: null, image: null },
  triagedAt: '2026-10-01T00:00:00.000Z',
  comments: [],
  attachments: [],
  workItemRefs: REFS,
};

const SURFACES: [string, () => ReactNode][] = [
  [
    'the obsolescence note',
    () => (
      <ObsolescenceField
        value="outdated"
        noteMd={BODY}
        workItemRefs={REFS}
        editing={false}
        locked={false}
        onMark={noop}
        onNote={noop}
      />
    ),
  ],
  [
    'the choice port',
    () => (
      <ChoicePortBody
        body={{
          question: 'Where?',
          why: { situation: 'two_workflows', youSaid: null, evidenceMd: BODY },
          options: [{ id: 'a', label: 'A', bestFor: 'less', whyMd: 'Why A.' }],
          followUpMd: 'Next.',
        }}
        workItemRefs={REFS}
        mode="read"
        groupName="g"
      />
    ),
  ],
  [
    'the decision port',
    () => (
      <DecisionPortBody
        view={{
          decisionMd: BODY,
          changes: [],
          whatChangedMd: '',
          supersedesMd: '',
          resultingDirectionMd: '',
          supersedesItems: [],
        }}
        workItemRefs={REFS}
      />
    ),
  ],
  [
    'How to test',
    () => (
      <HowToTestBlock
        howToTest={recordDto({
          record: { ...recordDto().record!, bodyMd: BODY, workItemRefs: REFS },
        })}
      />
    ),
  ],
  [
    "a sent-back review's findings",
    () => (
      <SentBackBand findingsMd={BODY} findingsRefs={REFS} run={null} decidedAt={null} count={1} />
    ),
  ],
  [
    'the triage body',
    () => (
      <TriageDetail
        detail={TRIAGE}
        busy={false}
        handlers={{
          onAccept: noop,
          onPromote: noop,
          onMerge: noop,
          onSnooze: noop,
          onDecline: noop,
        }}
      />
    ),
  ],
  [
    'the requirement document',
    () => (
      <RequirementDocument
        requestMd="Plan it"
        requirement={{ outcome: BODY }}
        workItemRefs={REFS}
      />
    ),
  ],
];

describe.each(SURFACES)('%s draws each card link as itself (MOTIR-10023)', (_, draw) => {
  it('a live chip, a struck-through deleted one, and the no-access chip', () => {
    const { container } = renderWithIntl(<>{draw()}</>);
    expectThreeChips(container);
  });
});

describe("a to-do row's notes (MOTIR-10023)", () => {
  it('draws the links once the notes open', () => {
    const { container } = renderWithIntl(
      <TodoRowReadOnly
        row={{ text: 'Do it', notesMd: BODY, commandText: null, executor: null }}
        workItemRefs={REFS}
      />,
    );
    fireEvent.click(container.querySelector('button[aria-expanded]')!);
    expectThreeChips(container);
  });
});

describe("a passed review's findings (MOTIR-10023)", () => {
  it('draws the links once the disclosure opens', () => {
    const { container } = renderWithIntl(
      <PassedBand findingsMd={BODY} findingsRefs={REFS} run={null} decidedAt={null} count={1} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /show/i }));
    expectThreeChips(container);
  });
});

describe('a triage comment (MOTIR-10023)', () => {
  it('draws its links from the detail map', () => {
    const { container } = renderWithIntl(
      <TriageDetail
        detail={{
          ...TRIAGE,
          descriptionMd: null,
          comments: [
            {
              id: 'c1',
              bodyMd: BODY,
              createdAt: '2026-10-01T00:00:00.000Z',
              author: { id: 'u1', name: 'Ana' },
            } as TriageItemDetailDto['comments'][number],
          ],
        }}
        busy={false}
        handlers={{
          onAccept: noop,
          onPromote: noop,
          onMerge: noop,
          onSnooze: noop,
          onDecline: noop,
        }}
      />,
    );
    expectThreeChips(container);
  });
});

describe('the agent chat transcript (MOTIR-10023)', () => {
  const transcript = (texts: string[]) => ({
    ...emptyTranscript(),
    rows: texts.map((text, i) => ({ type: 'text' as const, key: `r${i}`, text })),
  });
  const draw = (texts: string[]) => (
    <ChatTranscript
      transcript={transcript(texts)}
      pendingPrompt={null}
      agentName="Claude"
      dimmed={false}
      historyNote={null}
      emptyFace={null}
    />
  );

  it('asks for the ids its text links, once, and draws each chip as itself', async () => {
    resolveChatWorkItemRefsAction.mockResolvedValue(REFS);
    const { container, rerender } = renderWithIntl(draw([BODY]));
    await waitFor(() =>
      expect(chipFor(container, 'MOTIR-706').classList.contains('is-deleted')).toBe(false),
    );
    expectThreeChips(container);
    expect(resolveChatWorkItemRefsAction).toHaveBeenCalledTimes(1);
    expect(resolveChatWorkItemRefsAction).toHaveBeenCalledWith(['wi_live', 'wi_gone', 'wi_hidden']);

    // A later row with a NEW id asks for that id alone.
    rerender(draw([BODY, 'And [MOTIR-8](motir:wi_new).']));
    await waitFor(() => expect(resolveChatWorkItemRefsAction).toHaveBeenCalledTimes(2));
    expect(resolveChatWorkItemRefsAction).toHaveBeenLastCalledWith(['wi_new']);
  });

  it('asks nothing when its text links no card', async () => {
    renderWithIntl(draw(['Plain words, no links.']));
    await Promise.resolve();
    expect(resolveChatWorkItemRefsAction).not.toHaveBeenCalled();
  });
});
