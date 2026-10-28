// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { WorkItemTodoDto } from '@/lib/dto/workItemTodos';
import type { TranslationOfferDTO } from '@/lib/dto/workItemTranslation';

// THE TO-DO LIST UNDER TRANSLATION (Story MOTIR-7735 · MOTIR-8122; design
// MOTIR-8112 § Where each field's mark sits). A to-do's text and its
// instructions are fields of their own: each is swapped and marked alone, and a
// to-do already in the reader's language is left untouched.

vi.mock('@/app/(authed)/items/[key]/todoActions', () => ({
  addTodoAction: vi.fn(),
  updateTodoAction: vi.fn(),
  moveTodoAction: vi.fn(),
  setTodoDoneAction: vi.fn(),
  deleteTodoAction: vi.fn(),
}));
vi.mock('@/components/ui/MarkdownEditor', () => ({
  MarkdownEditor: () => <textarea aria-label="editor" />,
}));

import { TodoListSection } from '@/app/(authed)/items/[key]/_components/TodoListSection';
import { TranslationProvider } from '@/app/(authed)/items/[key]/_components/translation/TranslationProvider';
import { TranslateControl } from '@/app/(authed)/items/[key]/_components/translation/TranslateControl';

afterEach(cleanup);

function todo(id: string, text: string, notesMd: string | null): WorkItemTodoDto {
  return {
    id,
    text,
    notesMd,
    textLanguage: null,
    notesLanguage: null,
    commandText: null,
    executor: 'human',
    position: id,
    done: false,
    doneAt: null,
    doneBy: null,
  };
}

const TODOS = [todo('t1', '检查日志', '先**打开**控制台'), todo('t2', 'Already English', null)];

const OFFER: TranslationOfferDTO = {
  targetLanguage: 'en',
  anyNeedsTranslation: true,
  fields: {
    'todo:t1:text': { needsTranslation: true, kept: false, sourceLanguage: 'zh', revision: 'r0' },
    'todo:t1:notes': { needsTranslation: true, kept: false, sourceLanguage: 'zh', revision: 'r0' },
    'todo:t2:text': { needsTranslation: false, kept: false, sourceLanguage: 'en', revision: 'r0' },
  },
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function mount() {
  return render(
    <TranslationProvider itemId="item-1" translation={{ offer: OFFER, canAddCredits: false }}>
      <TranslateControl />
      <TodoListSection
        initialWorkItemRefs={{}}
        workItemId="item-1"
        initialTodos={TODOS}
        initialProgress={{ done: 0, total: 2 }}
        canEdit={false}
      />
    </TranslationProvider>,
  );
}

describe('to-dos', () => {
  it('swaps a to-do’s text and instructions, each with its own mark', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        targetLanguage: 'en',
        fields: [
          { fieldRef: 'todo:t1:text', status: 'ready', text: 'Check the logs' },
          { fieldRef: 'todo:t1:notes', status: 'ready', text: 'First **open** the console' },
        ],
      }),
    } as Response);
    const { container } = mount();
    expect(screen.getByText('检查日志')).toBeTruthy();

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Translate' })));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(screen.getAllByText('Check the logs').length).toBeGreaterThan(0);
    expect(screen.queryByText('检查日志')).toBeNull();
    // The to-do already in the reader's language is unchanged.
    expect(screen.getAllByText('Already English').length).toBeGreaterThan(0);

    const marks = [...container.querySelectorAll('[data-translation-mark="translated"]')].map(
      (m) => m.textContent,
    );
    expect(marks).toEqual([
      'To-do: Translated from Chinese',
      'Instructions: Translated from Chinese',
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Show instructions' }));
    const strong = container.querySelector('strong');
    expect(strong?.textContent).toBe('open');
    expect(container.textContent).toContain('First open the console');
  });
});
