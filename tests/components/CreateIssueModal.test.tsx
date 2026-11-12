// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render, enMessages } from '../helpers/renderWithIntl';
import { clearToastTimersAfterEach } from '../helpers/toastTimers';
import zhMessages from '@/messages/zh.json';
import { ToastProvider } from '@/components/ui/Toast';

// The Due-date DatePicker opens a Radix Popover (Popper), which needs
// ResizeObserver + pointer-capture / scrollIntoView APIs happy-dom omits.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});

// Hoisted spies the mock factories close over (vi.mock is hoisted above imports).
const { refresh, createIssueActionSpy, listCreateLinkCandidatesSpy } = vi.hoisted(() => ({
  refresh: vi.fn(),
  createIssueActionSpy: vi.fn(),
  listCreateLinkCandidatesSpy: vi.fn(),
}));

const { navSearchParams } = vi.hoisted(() => ({ navSearchParams: new URLSearchParams() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
  // AppCommandPalette (rendered by the ⌘K test) reads usePathname for its
  // post-switch navigation (MOTIR-1312); provide it so the render doesn't throw.
  usePathname: () => '/dashboard',
  // MOTIR-4730 — the palette's planning door reads the address to compose the
  // overlay onto it, so a partial navigation mock is now a crash.
  useSearchParams: () => navSearchParams,
}));
vi.mock('@/app/(authed)/items/actions', () => ({
  createIssueAction: createIssueActionSpy,
  // The modal now renders ParentPicker, which fetches candidates on mount.
  listCandidateParentsAction: vi.fn(async () => ({ ok: true, candidates: [] })),
  // 2.4.10: the Linked-issues section fetches link candidates on mount.
  listCreateLinkCandidatesAction: (...args: unknown[]) => listCreateLinkCandidatesSpy(...args),
}));
// Heavy palette deps — only the ⌘K-command test renders AppCommandPalette, but
// the mocks must exist at module-eval time.
vi.mock('@/lib/contexts/theme-context', () => ({
  useTheme: () => ({ pattern: 'system', setPattern: vi.fn() }),
}));
vi.mock('@/lib/auth/client', () => ({ signOut: vi.fn() }));
vi.mock('@/app/(authed)/_actions', () => ({ switchWorkspaceAction: vi.fn() }));
vi.mock('@/app/(authed)/_project-actions', () => ({ setActiveProjectAction: vi.fn() }));
// The modal now renders the real MarkdownEditor (client-only Tiptap WYSIWYG) —
// stub it to a textarea labelled by its `label` prop so the Description AND
// Explanation editors are individually addressable.
vi.mock('@/components/ui/MarkdownEditor', () => ({
  MarkdownEditor: ({
    value,
    onChange,
    label,
    labelHidden,
  }: {
    value: string;
    onChange: (v: string) => void;
    label?: string;
    labelHidden?: boolean;
  }) => (
    <>
      {/* Mirror the real editor: a VISIBLE label span unless labelHidden, plus
          an always-present aria-label on the field (MOTIR-1313). */}
      {labelHidden ? null : <span>{label}</span>}
      <textarea
        aria-label={label ?? 'Description'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </>
  ),
}));
vi.mock('@/lib/blob/uploadClient', () => ({ uploadIssueAttachment: vi.fn() }));

import { CreateIssueProvider } from '@/app/(authed)/_components/CreateIssueProvider';
import { CreateIssueButton } from '@/app/(authed)/_components/CreateIssueButton';
import { CommandPaletteProvider } from '@/app/(authed)/_components/CommandPaletteProvider';
import { CommandPaletteTrigger } from '@/app/(authed)/_components/CommandPaletteTrigger';
import { AppCommandPalette } from '@/app/(authed)/_components/AppCommandPalette';

function Shell() {
  return (
    <ToastProvider>
      <CommandPaletteProvider>
        <CreateIssueProvider>
          <CommandPaletteTrigger />
          <CreateIssueButton />
          <AppCommandPalette
            workspaces={[]}
            activeWorkspaceId={null}
            projects={[]}
            activeProjectId={null}
            // The palette offers Create only to an actor who can create (MOTIR-6175).
            settingsPermissions={['work_item:edit']}
          />
        </CreateIssueProvider>
      </CommandPaletteProvider>
    </ToastProvider>
  );
}

const modalHeading = () => screen.queryByRole('heading', { name: 'Create work item' });

clearToastTimersAfterEach();

beforeEach(() => {
  // Default: the Linked-issues section's mount fetch resolves to no candidates.
  // Individual link tests override this with a candidate set.
  listCreateLinkCandidatesSpy.mockResolvedValue({ ok: true, candidates: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('CreateIssueModal — entry points', () => {
  it('the top-nav "+" button opens the modal', async () => {
    render(<Shell />);
    expect(modalHeading()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Create work item' }));
    expect(modalHeading()).not.toBeNull();
    // Opening mounts ParentPicker, which loads its candidates in an effect.
    await act(async () => {});
  });

  it('the global "C" shortcut opens the modal', async () => {
    render(<Shell />);
    expect(modalHeading()).toBeNull();
    fireEvent.keyDown(window, { key: 'c' });
    expect(modalHeading()).not.toBeNull();
    await act(async () => {});
  });

  it('the ⌘K palette "Create issue" command opens the modal', async () => {
    render(<Shell />);
    // Open the palette via its trigger (deterministic — no platform-key path).
    fireEvent.click(screen.getByRole('button', { name: 'Shortcut' }));
    const command = await screen.findByText('Create work item');
    fireEvent.click(command);
    await waitFor(() => expect(modalHeading()).not.toBeNull());
  });

  // ⚠️ REMOVED (MOTIR-4873): 'no entry points when there is no active project'.
  // It rendered the shell with `hasProject={false}` and asserted the button was
  // hidden, "C" inert and the modal unmounted. Every member is now inside a
  // project (MOTIR-4870), so the prop is gone and the state it described cannot
  // be produced — the spec would have had to fabricate it to keep asserting it.
  // What still gates these three entry points is `canEdit`, which is a
  // different question and is covered by the permission specs.
});

describe('CreateIssueModal — validation + submit', () => {
  function openModal() {
    render(<Shell />);
    fireEvent.click(screen.getByRole('button', { name: 'Create work item' }));
  }

  it('Create is disabled until a non-empty title is entered', async () => {
    openModal();
    const submit = screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Ship it' } });
    expect(submit.disabled).toBe(false);
    // Whitespace-only is still empty.
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: '   ' } });
    expect(submit.disabled).toBe(true);
    await act(async () => {});
  });

  it('submit calls createIssueAction with the form values, toasts, and closes', async () => {
    createIssueActionSpy.mockResolvedValue({ ok: true, id: 'wi_1', identifier: 'WFD-7' });
    openModal();

    // Type is now the combobox picker — open it and choose Bug.
    fireEvent.click(screen.getByRole('combobox', { name: 'Type' }));
    fireEvent.click(screen.getByRole('option', { name: 'Bug' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Login is broken' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Repro steps…' } });
    // Priority is the combobox picker now (like Type) — open it and choose High.
    fireEvent.click(screen.getByRole('combobox', { name: 'Priority' }));
    fireEvent.click(screen.getByRole('option', { name: 'High' }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });

    expect(createIssueActionSpy).toHaveBeenCalledTimes(1);
    expect(createIssueActionSpy).toHaveBeenCalledWith({
      kind: 'bug',
      title: 'Login is broken',
      descriptionMd: 'Repro steps…',
      explanationMd: null,
      priority: 'high',
      parentId: null,
    });
    // Success path: toast surfaces the identifier, list revalidates, modal closes.
    await waitFor(() => expect(screen.getByText('WFD-7 created')).toBeTruthy());
    expect(refresh).toHaveBeenCalled();
    await waitFor(() => expect(modalHeading()).toBeNull());
  });

  it('expands the optional explanation section and submits its markdown', async () => {
    createIssueActionSpy.mockResolvedValue({ ok: true, id: 'wi_2', identifier: 'WFD-8' });
    openModal();

    // Collapsed by default — the editor isn't mounted until expanded.
    expect(screen.queryByLabelText('Explanation')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Explanation' }));

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Add OAuth' } });
    fireEvent.change(screen.getByLabelText('Explanation'), {
      target: { value: 'Why it matters: fewer drop-offs.' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });

    expect(createIssueActionSpy).toHaveBeenCalledWith(
      expect.objectContaining({ explanationMd: 'Why it matters: fewer drop-offs.' }),
    );
  });

  // MOTIR-1313 — the expanded explanation section showed "Explanation" twice
  // (the disclosure toggle header AND the editor's own visible label). The editor
  // label is now hidden (the toggle supplies the visible label), so exactly one
  // visible "Explanation" renders, while the editor keeps its accessible name.
  it('renders the "Explanation" label only once when the section is expanded', async () => {
    openModal();
    fireEvent.click(screen.getByRole('button', { name: 'Explanation' }));

    // One VISIBLE "Explanation" — the disclosure header (not the editor's label).
    expect(screen.getAllByText('Explanation')).toHaveLength(1);
    // The explanation editor is still reachable by its accessible name.
    expect(screen.getByLabelText('Explanation')).toBeTruthy();
    await act(async () => {});
  });

  it('threads a chosen Due date through as a UTC ISO string; a plain create omits it', async () => {
    createIssueActionSpy.mockResolvedValue({ ok: true, id: 'wi_3', identifier: 'WFD-9' });
    openModal();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Ship the thing' } });

    // Open the Due-date DatePicker and pick TODAY (always present in the
    // default-open month, whatever date CI runs on).
    fireEvent.click(screen.getByRole('button', { name: 'Due date' }));
    const calendar = await screen.findByRole('dialog', { name: 'Due date' });
    const MONTHS = [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ];
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    const d = now.getUTCDate();
    const pad = (n: number) => String(n).padStart(2, '0');
    const expectedIso = new Date(`${y}-${pad(m + 1)}-${pad(d)}T00:00:00.000Z`).toISOString();
    fireEvent.click(within(calendar).getByRole('button', { name: `${MONTHS[m]} ${d}, ${y}` }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });
    expect(createIssueActionSpy).toHaveBeenCalledWith(
      expect.objectContaining({ dueDate: expectedIso }),
    );

    // And a create with no date chosen sends no dueDate key at all (the
    // exact-match test above already pins the plain-create payload shape).
    createIssueActionSpy.mockClear();
    cleanup();
    createIssueActionSpy.mockResolvedValue({ ok: true, id: 'wi_4', identifier: 'WFD-10' });
    openModal();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'No due date' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });
    expect(createIssueActionSpy).toHaveBeenCalledWith(
      expect.not.objectContaining({ dueDate: expect.anything() }),
    );
  });

  it('an error result keeps the modal open and toasts the message', async () => {
    createIssueActionSpy.mockResolvedValue({ ok: false, error: 'That project no longer exists.' });
    openModal();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Anything' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });
    await waitFor(() => expect(screen.getByText('That project no longer exists.')).toBeTruthy());
    expect(modalHeading()).not.toBeNull(); // stays open so the user can retry
  });

  // MOTIR-5133 — a §4.1 cap refusal is toasted in the reader's language, picked
  // by its `entitlement` kind. `error` is the server's English sentence, which a
  // `zh` reader used to be shown verbatim; here it is a sentinel no toast may carry.
  const SERVER_ENGLISH = 'SERVER-SIDE ENGLISH — must never reach a reader';
  const CAP_REFUSAL = { ok: false, error: SERVER_ENGLISH, entitlement: 'work_items' };

  it('a cap refusal toasts the catalogue sentence for its kind, not the server string', async () => {
    createIssueActionSpy.mockResolvedValue(CAP_REFUSAL);
    openModal();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'One too many' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });
    await waitFor(() =>
      expect(screen.getByText(enMessages.errors.entitlementExceeded.work_items)).toBeTruthy(),
    );
    expect(screen.queryByText(SERVER_ENGLISH)).toBeNull();
    expect(modalHeading()).not.toBeNull();
  });

  it('a cap refusal reaches a zh reader in Chinese', async () => {
    createIssueActionSpy.mockResolvedValue(CAP_REFUSAL);
    render(<Shell />, { locale: 'zh', messages: zhMessages });
    fireEvent.click(screen.getByRole('button', { name: zhMessages.shell.createIssue.title }));
    fireEvent.change(screen.getByLabelText(zhMessages.shell.createIssue.titleLabel), {
      target: { value: '超出上限' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zhMessages.shell.createIssue.create }));
    });
    await waitFor(() =>
      expect(screen.getByText(zhMessages.errors.entitlementExceeded.work_items)).toBeTruthy(),
    );
    expect(screen.queryByText(SERVER_ENGLISH)).toBeNull();
  });
});

// ── Subtask 2.4.10 — the create-modal "Linked issues" section ──────────────────
describe('CreateIssueModal — linked issues (2.4.10)', () => {
  const candidate = {
    id: 'cand-1',
    parentId: null,
    kind: 'task' as const,
    key: 9,
    identifier: 'PROD-9',
    title: 'Callback bug',
    status: 'todo',
    priority: 'medium' as const,
    assigneeId: null,
    position: 'a1',
    archivedAt: null,
  };

  function openModal() {
    render(<Shell />);
    fireEvent.click(screen.getByRole('button', { name: 'Create work item' }));
  }

  // Type a query (the candidate read is query-driven since 6.9.2 — debounced
  // server fetch per keystroke), pick the fetched candidate, and click Add.
  async function addPendingLink() {
    fireEvent.click(await screen.findByRole('combobox', { name: 'Work item to link' }));
    fireEvent.change(
      await screen.findByRole('combobox', { name: /Search by identifier or title/ }),
      { target: { value: 'Callback' } },
    );
    fireEvent.click(await screen.findByRole('option', { name: /Callback bug/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  }

  it('collects a pending link as a row and a second Add is excluded for the same pair', async () => {
    listCreateLinkCandidatesSpy.mockResolvedValue({ ok: true, candidates: [candidate] });
    openModal();

    await addPendingLink();

    // The pending row renders (default relationship "Blocked by" + the issue).
    expect(await screen.findByText('Callback bug')).toBeTruthy();
    expect(screen.getByText('PROD-9')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /Remove pending blocked by link to PROD-9/ }),
    ).toBeTruthy();

    // The same (target, relationship) pair is now excluded — reopening the
    // combobox offers no candidates.
    fireEvent.click(screen.getByRole('combobox', { name: 'Work item to link' }));
    expect(await screen.findByText('No matching work items.')).toBeTruthy();
  });

  it('removing a pending row drops it', async () => {
    listCreateLinkCandidatesSpy.mockResolvedValue({ ok: true, candidates: [candidate] });
    openModal();

    await addPendingLink();
    const remove = await screen.findByRole('button', {
      name: /Remove pending blocked by link to PROD-9/,
    });
    fireEvent.click(remove);
    await waitFor(() => expect(screen.queryByText('Callback bug')).toBeNull());
  });

  it('submit threads the collected links to createIssueAction', async () => {
    listCreateLinkCandidatesSpy.mockResolvedValue({ ok: true, candidates: [candidate] });
    createIssueActionSpy.mockResolvedValue({ ok: true, id: 'wi_9', identifier: 'WFD-9' });
    openModal();

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Needs PROD-9' } });
    await addPendingLink();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });

    expect(createIssueActionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Needs PROD-9',
        links: [{ targetId: 'cand-1', relationship: 'blocked_by' }],
      }),
    );
  });

  it('a links-field error result keeps the modal open and surfaces inline (no toast)', async () => {
    listCreateLinkCandidatesSpy.mockResolvedValue({ ok: true, candidates: [candidate] });
    createIssueActionSpy.mockResolvedValue({
      ok: false,
      error: 'That would create a dependency cycle.',
      field: 'links',
    });
    openModal();

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Cyclic' } });
    await addPendingLink();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });

    await waitFor(() =>
      expect(screen.getByText('That would create a dependency cycle.')).toBeTruthy(),
    );
    expect(modalHeading()).not.toBeNull(); // stays open; the pending link is preserved
  });
});
