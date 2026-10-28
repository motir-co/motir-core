// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import type { WorkItemDto } from '@/lib/dto/workItems';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkItemTodoDto } from '@/lib/dto/workItemTodos';

// THE EDITORS OPEN THE ORIGINAL AND NAME ITS LANGUAGE (Story MOTIR-7738 ·
// MOTIR-8832; design MOTIR-8837). Whatever the page shows, an editor is seeded
// from the STORED text, and a note says which language that text is recorded in:
// "Original in Korean", "Original language not recorded", or nothing at all for
// an empty field.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => '/items/WFD-7/edit',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/app/(authed)/items/[key]/edit/actions', () => ({
  updateIssueAction: vi.fn(),
  changeStatusAction: vi.fn(),
}));
vi.mock('@/app/(authed)/items/actions', () => ({
  listCandidateParentsAction: vi.fn(async () => ({ ok: true, candidates: [] })),
}));
vi.mock('@/app/(authed)/items/[key]/todoActions', () => ({
  addTodoAction: vi.fn(),
  updateTodoAction: vi.fn(),
  moveTodoAction: vi.fn(),
  setTodoDoneAction: vi.fn(),
  deleteTodoAction: vi.fn(),
}));
// The Tiptap surface is client-only. This stub keeps the two things under test:
// the label row (label + accessory) and the seeded value.
vi.mock('@/components/ui/MarkdownEditor', () => ({
  MarkdownEditor: ({
    value,
    label,
    labelAccessory,
  }: {
    value: string;
    label: string;
    labelAccessory?: ReactNode;
  }) => (
    <div data-editor={label}>
      <span data-editor-label={label}>
        {label}
        {labelAccessory}
      </span>
      <textarea aria-label={label} value={value} readOnly />
    </div>
  ),
}));
vi.mock('@/components/ui/MarkdownView', () => ({
  MarkdownView: ({ value }: { value: string }) => <div>{value}</div>,
}));

import { EditIssueForm } from '@/app/(authed)/items/[key]/edit/_components/EditIssueForm';
import { TodoListSection } from '@/app/(authed)/items/[key]/_components/TodoListSection';

afterEach(cleanup);

const workflow = {
  statuses: [
    {
      id: 's-todo',
      projectId: 'p1',
      key: 'todo',
      label: 'To Do',
      category: 'todo',
      color: null,
      position: 'a',
      isInitial: true,
    },
  ],
  transitions: [],
  policyMode: 'restricted',
} as WorkflowDto;

function issue(over: Partial<WorkItemDto> = {}): WorkItemDto {
  return {
    id: 'wi_1',
    projectId: 'p1',
    parentId: null,
    kind: 'task',
    key: 7,
    identifier: 'WFD-7',
    title: '내보내기 만들기',
    descriptionMd: '설명 본문',
    explanationMd: '이유 본문',
    explanationSource: 'user_authored',
    languages: { title: 'ko', description: 'ko', explanation: 'ko' },
    status: 'todo',
    priority: 'medium',
    assigneeId: null,
    reporterId: 'u1',
    dueDate: null,
    estimateMinutes: null,
    type: null,
    executor: null,
    difficulty: null,
    storyPoints: null,
    position: 'a0',
    sprintId: null,
    backlogRank: 'a0',
    publicChildrenHidden: false,
    sessionBranch: null,
    targetRepo: null,
    targetRepos: [],
    planningSource: null,
    planningHarness: null,
    planningModel: null,
    implementationSource: null,
    implementationHarness: null,
    implementationModel: null,
    subject: null,
    archivedAt: null,
    obsolescence: null,
    obsolescenceNoteMd: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...over,
  } as WorkItemDto;
}

async function mountForm(item: WorkItemDto) {
  render(
    <ToastProvider>
      <EditIssueForm issue={item} workflow={workflow} members={[]} />
    </ToastProvider>,
  );
  await act(async () => {});
}

const labelRow = (label: string) =>
  document.querySelector(`[data-editor-label="${label}"]`)!.textContent;

describe('the edit form', () => {
  it('seeds every editor with the stored text and names the language it is recorded in', async () => {
    await mountForm(issue());
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('내보내기 만들기');
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('설명 본문');
    expect((screen.getByLabelText('Explanation') as HTMLTextAreaElement).value).toBe('이유 본문');

    // The title's note is the helper line; the bodies' are label accessories.
    expect(screen.getByText('Original in Korean')).toBeTruthy();
    expect(labelRow('Description')).toContain('— Original in Korean');
    expect(labelRow('Explanation')).toContain('— Original in Korean');
  });

  it('puts the explanation’s note after its gloss', async () => {
    await mountForm(issue());
    const text = labelRow('Explanation')!;
    expect(text.indexOf('why it matters')).toBeGreaterThan(-1);
    expect(text.indexOf('why it matters')).toBeLessThan(text.indexOf('Original in Korean'));
  });

  it('names the reader’s own language the same way', async () => {
    await mountForm(issue({ languages: { title: 'en', description: 'en', explanation: 'en' } }));
    expect(labelRow('Description')).toContain('— Original in English');
  });

  it('says so for a field that records no language, and never guesses one', async () => {
    await mountForm(issue({ languages: { title: null, description: null, explanation: null } }));
    expect(screen.getByText('Original language not recorded')).toBeTruthy();
    expect(labelRow('Description')).toContain('— Original language not recorded');
    expect(screen.queryByText(/Original in/)).toBeNull();
  });

  it('shows no note for an empty field', async () => {
    await mountForm(issue({ descriptionMd: null, explanationMd: '' }));
    expect(labelRow('Description')).not.toContain('Original');
    expect(labelRow('Explanation')).not.toContain('Original');
    // The title still has text, so its note stays.
    expect(screen.getByText('Original in Korean')).toBeTruthy();
  });

  it('a title error replaces the note and the note returns when it clears', async () => {
    await mountForm(issue());
    const title = screen.getByLabelText('Title') as HTMLInputElement;
    fireEvent.change(title, { target: { value: '' } });
    fireEvent.submit(title.closest('form')!);
    // The shipped primitive shows the error OR the helper, never both.
    expect(screen.queryByText('Original in Korean')).toBeNull();
    fireEvent.change(title, { target: { value: '다시' } });
    expect(screen.getByText('Original in Korean')).toBeTruthy();
  });
});

function todo(over: Partial<WorkItemTodoDto> = {}): WorkItemTodoDto {
  return {
    id: 'todo-1',
    text: '단계 하나',
    notesMd: '지침 본문',
    textLanguage: 'ko',
    notesLanguage: null,
    commandText: null,
    executor: 'human',
    position: 'a1',
    done: false,
    doneAt: null,
    doneBy: null,
    ...over,
  };
}

describe('the to-do row editor', () => {
  function open(row: WorkItemTodoDto) {
    render(
      <TodoListSection
        initialWorkItemRefs={{}}
        workItemId="wi-1"
        initialTodos={[row]}
        initialProgress={{ done: 0, total: 1 }}
        canEdit
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit step' }));
  }

  it('seeds from the stored row and names each field’s own recorded language', () => {
    open(todo());
    expect((screen.getByLabelText('Step') as HTMLInputElement).value).toBe('단계 하나');
    expect((screen.getByLabelText('Instructions') as HTMLTextAreaElement).value).toBe('지침 본문');
    // Step: recorded (helper line). Instructions: not recorded (label accessory).
    expect(screen.getByText('Original in Korean')).toBeTruthy();
    expect(labelRow('Instructions')).toContain('— Original language not recorded');
  });

  it('shows no note on empty instructions', () => {
    open(todo({ notesMd: null, notesLanguage: 'ko' }));
    expect(labelRow('Instructions')).not.toContain('Original');
  });
});
