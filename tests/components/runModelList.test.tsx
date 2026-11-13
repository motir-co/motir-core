// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import type { PlatformRunModelEntryDTO, PlatformRunModelListDTO } from '@/lib/dto/platformRunModel';

/**
 * The HOSTED-RUN MODELS card (MOTIR-7528, design `platform-admin` § AMENDMENT
 * 2026-10-04 Model lists, Panels 5–9 and 11–12). The actions are stubbed: their
 * codes have their own suite (`runModelAction.test.ts`); here each code is
 * driven to the state the design draws for it.
 */

const addRunModelAction = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true })),
);
const removeRunModelAction = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true })),
);
vi.mock('@/app/(admin)/admin/run-models/actions', () => ({
  addRunModelAction,
  removeRunModelAction,
}));
const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const { RunModelList } = await import('@/app/(admin)/admin/run-models/_components/RunModelList');
const { RunModelListUnavailable } =
  await import('@/app/(admin)/admin/run-models/_components/RunModelListUnavailable');

afterEach(() => {
  cleanup();
  addRunModelAction.mockClear();
  removeRunModelAction.mockClear();
  refresh.mockClear();
});

function entry(
  model: string,
  over: Partial<PlatformRunModelEntryDTO> = {},
): PlatformRunModelEntryDTO {
  return {
    model,
    provider: 'anthropic',
    offered: true,
    createdAt: '2026-10-01T09:00:00.000Z',
    addedBy: null,
    seeded: true,
    platformDefaultLevels: [],
    projects: [],
    ...over,
  };
}

function list(over: Partial<PlatformRunModelListDTO> = {}): PlatformRunModelListDTO {
  return {
    entries: [
      entry('claude-opus-5-5', {
        platformDefaultLevels: ['high', 'medium'],
        projects: [{ projectKey: 'ACME', projectName: 'Acme', levels: ['high'] }],
      }),
      entry('glm-5.2', {
        provider: null,
        offered: false,
        seeded: false,
        addedBy: 'ops@moooon.net',
      }),
    ],
    addable: [
      { id: 'kimi-k2.6', provider: 'moonshot' },
      { id: 'claude-haiku-4-5', provider: 'anthropic' },
    ],
    canEdit: true,
    ...over,
  };
}

function renderList(l: PlatformRunModelListDTO) {
  return render(
    <ToastProvider>
      <RunModelList list={l} />
    </ToastProvider>,
  );
}

const rowOf = (model: string) => screen.getByTestId(`run-model-list-row-${model}`);

async function removeWith(model: string, reason: string) {
  fireEvent.click(within(rowOf(model)).getByRole('button', { name: `Remove ${model}` }));
  const dialog = await screen.findByRole('alertdialog');
  fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: reason } });
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove model' }));
  });
}

async function openAdd() {
  fireEvent.click(screen.getByRole('button', { name: 'Add model' }));
  return screen.findByRole('alertdialog');
}

async function pickAndAdd(dialog: HTMLElement, model: string, reason: string) {
  fireEvent.click(within(dialog).getByRole('combobox'));
  fireEvent.click(await screen.findByRole('option', { name: new RegExp(model) }));
  fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: reason } });
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add model' }));
  });
}

describe('RunModelList', () => {
  it('Panel 5: each entry with its offered state, platform default, projects and added line', () => {
    renderList(list());
    expect(screen.getByText('2 listed')).toBeTruthy();
    const opus = rowOf('claude-opus-5-5');
    expect(opus.textContent).toContain('Offered');
    expect(opus.textContent).toContain('Platform default · medium, high');
    expect(opus.textContent).toContain('1 project');
    expect(opus.textContent).toContain('Seeded on first read');
    const glm = rowOf('glm-5.2');
    expect(glm.textContent).toContain('not in the catalog');
    expect(glm.textContent).toContain('Not offered');
    expect(glm.textContent).toContain('Not in motir-ai’s Motir agent offer right now');
    expect(glm.textContent).toContain('Nothing');
    expect(glm.textContent).toMatch(/Added .* by ops@moooon\.net/);
  });

  it('Panel 6: picks an addable model, sends it with the trimmed reason, and says so', async () => {
    renderList(list());
    const dialog = await openAdd();
    expect(within(dialog).getByRole('button', { name: 'Add model' }).hasAttribute('disabled')).toBe(
      true,
    );
    await pickAndAdd(dialog, 'kimi-k2.6', ' Try it ');
    expect(addRunModelAction).toHaveBeenCalledWith('kimi-k2.6', 'Try it');
    expect(
      await screen.findByText('kimi-k2.6 added. Projects can choose it for Motir agent runs now.'),
    ).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it.each([
    ['NOT_OFFERED', 'Not added: motir-ai no longer offers kimi-k2.6 for Motir agent runs.'],
    ['ALREADY_LISTED', 'Not added: kimi-k2.6 is already listed.'],
    ['UNAVAILABLE', 'motir-ai didn’t respond, so nothing was changed. Try again.'],
  ])('a %s add keeps the dialog open with its line', async (code, text) => {
    addRunModelAction.mockResolvedValueOnce({ ok: false, code });
    renderList(list());
    const dialog = await openAdd();
    await pickAndAdd(dialog, 'kimi-k2.6', 'r');
    expect(within(screen.getByRole('alertdialog')).getByRole('alert').textContent).toBe(text);
  });

  it('Panel 6: nothing addable — the dialog says so instead of a picker', async () => {
    renderList(list({ addable: [] }));
    const dialog = await openAdd();
    expect(within(dialog).getByTestId('run-model-add-nothing').textContent).toBe(
      'Every model motir-ai offers for Motir agent runs is already listed.',
    );
    expect(within(dialog).queryByRole('combobox')).toBeNull();
  });

  it('Panel 7a: a remove sends the model and the reason, and says so', async () => {
    renderList(list());
    await removeWith('glm-5.2', ' unused ');
    expect(removeRunModelAction).toHaveBeenCalledWith('glm-5.2', 'unused');
    expect(await screen.findByText('glm-5.2 removed from Motir agent models.')).toBeTruthy();
  });

  it('Panel 7b: refused in use — the row names the platform default and the projects', async () => {
    removeRunModelAction.mockResolvedValueOnce({
      ok: false,
      code: 'IN_USE',
      platformLevels: ['high', 'medium'],
      platformRoles: [],
      projects: [
        { projectKey: 'ACME', projectName: 'Acme', levels: ['high'] },
        { projectKey: 'BETA', projectName: 'Beta', levels: ['low', 'trivial'] },
      ],
    });
    renderList(list());
    await removeWith('claude-opus-5-5', 'tidy');
    expect(within(rowOf('claude-opus-5-5')).getByRole('alert').textContent).toBe(
      'Not removed: claude-opus-5-5 is in use. It is Motir’s platform default for medium, high. ' +
        '2 projects use it: Acme (ACME) for high; Beta (BETA) for trivial, low. Change those first.',
    );
  });

  it('refused in use by the review-agent and design-run defaults — each named (MOTIR-10844)', async () => {
    removeRunModelAction.mockResolvedValueOnce({
      ok: false,
      code: 'IN_USE',
      platformLevels: [],
      platformRoles: ['review', 'design'],
      projects: [],
    });
    renderList(list());
    await removeWith('claude-opus-5-5', 'tidy');
    expect(within(rowOf('claude-opus-5-5')).getByRole('alert').textContent).toBe(
      'Not removed: claude-opus-5-5 is in use. It is Motir’s platform review-agent default. ' +
        'It is Motir’s platform design-run default.  Change those first.',
    );
  });

  it('refused in use by projects alone — no platform-default clause', async () => {
    removeRunModelAction.mockResolvedValueOnce({
      ok: false,
      code: 'IN_USE',
      platformLevels: [],
      platformRoles: [],
      projects: [{ projectKey: 'ACME', projectName: 'Acme', levels: ['high'] }],
    });
    renderList(list());
    await removeWith('claude-opus-5-5', 'tidy');
    expect(within(rowOf('claude-opus-5-5')).getByRole('alert').textContent).toBe(
      'Not removed: claude-opus-5-5 is in use. 1 project uses it: Acme (ACME) for high. Change those first.',
    );
  });

  it.each([
    ['NOT_LISTED', 'Not removed: glm-5.2 is no longer listed.'],
    ['NOT_PERMITTED', 'Only a superadmin can change this list.'],
    ['REASON_REQUIRED', 'A reason is required.'],
    ['FAILED', 'Something went wrong, and nothing was changed. Try again.'],
  ])('a %s remove shows its line on the row', async (code, text) => {
    removeRunModelAction.mockResolvedValueOnce({ ok: false, code });
    renderList(list());
    await removeWith('glm-5.2', 'r');
    expect(within(rowOf('glm-5.2')).getByRole('alert').textContent).toBe(text);
  });

  it('Panel 8: read-only — no Add, no Remove, one quiet line', () => {
    renderList(list({ canEdit: false }));
    expect(screen.queryByRole('button', { name: 'Add model' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(screen.getByTestId('run-model-list-read-only').textContent).toBe(
      'Only a superadmin can change these lists.',
    );
  });

  it('Panel 9: empty — the empty state with Add for a superadmin', () => {
    renderList(list({ entries: [] }));
    const empty = screen.getByTestId('run-model-list-empty');
    expect(empty.textContent).toContain('No model is listed');
    expect(empty.textContent).toContain('Add one from motir-ai’s offer.');
    expect(within(empty).getByRole('button', { name: 'Add model' })).toBeTruthy();
  });

  it('Panel 9: empty and read-only — who can add, and no Add', () => {
    renderList(list({ entries: [], canEdit: false }));
    expect(screen.getByTestId('run-model-list-empty').textContent).toContain(
      'No Motir agent run can start until a superadmin adds a model.',
    );
    expect(screen.queryByRole('button', { name: 'Add model' })).toBeNull();
  });

  it('Panel 12: a model this tab added reads “Added just now by you” once listed', async () => {
    const { rerender } = renderList(list());
    const dialog = await openAdd();
    await pickAndAdd(dialog, 'kimi-k2.6', 'r');
    const next = list();
    next.entries.push(entry('kimi-k2.6', { seeded: false, addedBy: 'me@moooon.net' }));
    rerender(
      <ToastProvider>
        <RunModelList list={next} />
      </ToastProvider>,
    );
    expect(rowOf('kimi-k2.6').textContent).toContain('Added just now by you');
  });

  it('Cancel and Escape close each dialog without calling an action', async () => {
    renderList(list());
    let dialog = await openAdd();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(within(rowOf('glm-5.2')).getByRole('button', { name: 'Remove glm-5.2' }));
    dialog = await screen.findByRole('alertdialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(within(rowOf('glm-5.2')).getByRole('button', { name: 'Remove glm-5.2' }));
    dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(addRunModelAction).not.toHaveBeenCalled();
    expect(removeRunModelAction).not.toHaveBeenCalled();
  });

  it('Panel 9: the empty state’s Add opens the picker and adds', async () => {
    renderList(list({ entries: [] }));
    fireEvent.click(
      within(screen.getByTestId('run-model-list-empty')).getByRole('button', { name: 'Add model' }),
    );
    const dialog = await screen.findByRole('alertdialog');
    await pickAndAdd(dialog, 'kimi-k2.6', 'first');
    expect(addRunModelAction).toHaveBeenCalledWith('kimi-k2.6', 'first');
  });

  it('Panel 11: unavailable — the error card with Retry re-reads', async () => {
    render(<RunModelListUnavailable />);
    expect(screen.getByText('Couldn’t load Motir agent models')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    expect(refresh).toHaveBeenCalled();
  });
});
