// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { ReactNode } from 'react';
import type { AutoTranslateContextDTO } from '@/lib/dto/autoTranslate';
import type { BoardCardDto } from '@/lib/dto/boards';
import type { TriageQueueItemDto } from '@/lib/dto/triage';
import { SurfaceTitleTranslationProvider } from '@/components/workItems/titleTranslation/SurfaceTitleTranslation';
import { BoardCard } from '@/app/(authed)/boards/_components/BoardCard';
import { TriageRow } from '@/app/(authed)/triage/_components/TriageRow';
import { WorkItemNode } from '@/components/planning/WorkItemNode';

// THE TITLE COMPONENTS OF THE SURFACES, inside the provider (Story MOTIR-7738 ·
// MOTIR-8833): each draws the translated title with its mark and an accessible
// name that follows the screen, and is the shipped markup without a provider.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const CONTEXT: AutoTranslateContextDTO = {
  autoTranslateWorkContent: true,
  targetLanguage: 'ko',
  credit: 'ok',
  canAddCredit: false,
};

function stubRoute(id: string, text: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            targetLanguage: 'ko',
            enabled: true,
            truncated: false,
            titles: [
              {
                workItemId: id,
                fieldRef: `${id}:title`,
                status: 'ready',
                text,
                sourceLanguage: 'en',
              },
            ],
          }),
          { status: 200 },
        ),
    ),
  );
}

async function inProvider(ui: ReactNode) {
  const r = render(
    <SurfaceTitleTranslationProvider projectKey="PROD" context={CONTEXT}>
      {ui}
    </SurfaceTitleTranslationProvider>,
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return r;
}

const card: BoardCardDto = {
  projectId: 'p1',
  parentId: null,
  kind: 'task',
  identifier: 'PROD-7',
  id: 'w1',
  key: 7,
  title: 'Wire OAuth',
  status: 'todo',
  priority: 'medium',
  assigneeId: null,
  dueDate: null,
  estimateMinutes: null,
  storyPoints: null,
  position: 'a0',
  ready: true,
  readyToStart: false,
  statusLabel: 'To Do',
  hasChildren: false,
  type: null,
  executor: null,
  pendingDecision: null,
  planHold: null,
  ciState: null,
  fixReason: null,
  obsolescence: null,
  statusCategory: 'todo',
};

describe('board card', () => {
  it('shows the translation, marks it, reserves two lines, and names itself by what is on screen', async () => {
    stubRoute('w1', 'OAuth 연결');
    await inProvider(<BoardCard card={card} assigneeName={null} onOpenQuickView={() => {}} />);
    const button = screen.getByTestId('board-card-PROD-7');
    expect(button.textContent).toContain('OAuth 연결');
    expect(button.querySelector('[data-title-mark="translated"]')).not.toBeNull();
    const title = button.querySelector('[lang="ko"]') as HTMLElement;
    expect(title.className).toContain('line-clamp-2');
    expect(title.className).toContain('min-h-[2lh]');
    expect(button.getAttribute('aria-label')).toContain('OAuth 연결. Translated from English');
  });

  it('is the shipped markup without a provider', () => {
    render(<BoardCard card={card} assigneeName={null} onOpenQuickView={() => {}} />);
    const button = screen.getByTestId('board-card-PROD-7');
    expect(button.querySelector('[data-title-mark]')).toBeNull();
    expect(button.getAttribute('aria-label')).toContain('Wire OAuth');
    expect(button.getAttribute('aria-label')).not.toContain('Translated');
  });
});

describe('triage row', () => {
  const item: TriageQueueItemDto = {
    id: 't1',
    kind: 'bug',
    key: 3,
    identifier: 'PROD-3',
    title: 'Login fails',
    descriptionSnippet: null,
    status: 'triage',
    priority: 'medium',
    submitter: { kind: 'member', userId: 'u1', name: 'Ana', email: null, image: null },
    triagedAt: '2026-10-01T00:00:00.000Z',
    snoozedUntil: null,
    voteCount: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
  };

  it('translates the clamped title and marks it', async () => {
    stubRoute('t1', '로그인 실패');
    await inProvider(<TriageRow item={item} active={false} onSelect={() => {}} />);
    const row = screen.getByRole('button');
    expect(row.textContent).toContain('로그인 실패');
    expect(row.querySelector('[data-title-mark="translated"]')).not.toBeNull();
  });
});

describe('roadmap node', () => {
  const node = {
    id: 'n1',
    identifier: 'PROD-9',
    title: 'Ship the roadmap',
    kind: 'story' as const,
    status: 'todo',
    assigneeName: null,
  };

  it('keeps the node box and the struck/clamp classes while showing the translation', async () => {
    stubRoute('n1', '로드맵 출시');
    const { container } = await inProvider(<WorkItemNode item={node} />);
    expect((container.firstChild as HTMLElement).style.height).toBe('124px');
    const title = container.querySelector('[data-node-title]') as HTMLElement;
    // No footer → the three-line clamp (MOTIR-10508).
    expect(title.className).toContain('line-clamp-3');
    expect(title.textContent).toContain('로드맵 출시');
  });

  it('keeps the shipped title element without a provider', () => {
    const { container } = render(<WorkItemNode item={node} />);
    const title = container.querySelector('[data-node-title]') as HTMLElement;
    expect(title.textContent).toBe('Ship the roadmap');
    expect(title.querySelector('[data-title-mark]')).toBeNull();
  });
});
