// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import type {
  PlatformPlannerFunctionRowDTO,
  PlatformPlannerModelRowDTO,
  PlatformPlannerModelSettingsDTO,
} from '@/lib/dto/platformPlannerModel';
import type {
  PlatformRunModelDefaultRowDTO,
  PlatformRunModelDefaultsDTO,
} from '@/lib/dto/platformRunModelDefaults';

/**
 * The console's per-function default rows (Story MOTIR-10838 · MOTIR-10844;
 * design `console--function-defaults.mock.html`): Guide, Debug and Ask on the AI
 * planning table, and the Run-side defaults card on the Motir agent models page.
 * The actions are stubbed — their codes have their own suites — and each code is
 * driven to the state the design draws for it.
 */

const setPlannerFunctionModelAction = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true })),
);
const setRunModelDefaultAction = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true })),
);
vi.mock('@/app/(admin)/admin/ai-planning/actions', () => ({
  setPlannerFunctionModelAction,
  setPlannerModelAction: vi.fn(),
  setPlannerReviewModelAction: vi.fn(),
}));
vi.mock('@/app/(admin)/admin/run-models/actions', () => ({ setRunModelDefaultAction }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const { PlannerModelRows } =
  await import('@/app/(admin)/admin/ai-planning/_components/PlannerModelRows');
const { RunModelDefaults } =
  await import('@/app/(admin)/admin/run-models/_components/RunModelDefaults');
const { RunModelDefaultsUnavailable } =
  await import('@/app/(admin)/admin/run-models/_components/RunModelDefaultsUnavailable');

afterEach(() => {
  cleanup();
  setPlannerFunctionModelAction.mockClear();
  setRunModelDefaultAction.mockClear();
  refresh.mockClear();
});

const audience = (a: PlatformPlannerModelRowDTO['audience']): PlatformPlannerModelRowDTO => ({
  audience: a,
  model: 'claude-opus-5-5',
  offered: true,
  reachable: true,
  lastProbeAt: null,
  lastProbeError: null,
  updatedAt: '2026-10-01T00:00:00.000Z',
  updatedBy: null,
  seeded: true,
});

const fn = (
  f: PlatformPlannerFunctionRowDTO['function'],
  over: Partial<PlatformPlannerFunctionRowDTO> = {},
): PlatformPlannerFunctionRowDTO => ({
  function: f,
  model: null,
  offered: null,
  updatedAt: null,
  updatedBy: null,
  seeded: true,
  ...over,
});

function planning(
  over: Partial<PlatformPlannerModelSettingsDTO> = {},
): PlatformPlannerModelSettingsDTO {
  return {
    rows: [audience('customer'), audience('meta'), audience('internal')],
    review: null,
    functions: [fn('guide'), fn('debug'), fn('ask')],
    offered: [
      { id: 'claude-opus-5-5', provider: 'anthropic' },
      { id: 'deepseek-v4-flash', provider: 'deepseek' },
    ],
    canEdit: true,
    ...over,
  };
}

const runRow = (
  key: PlatformRunModelDefaultRowDTO['key'],
  over: Partial<PlatformRunModelDefaultRowDTO> = {},
): PlatformRunModelDefaultRowDTO => ({
  key,
  model: null,
  withdrawn: false,
  inheritsModel: null,
  updatedAt: null,
  updatedBy: null,
  seeded: true,
  ...over,
});

function runSide(over: Partial<PlatformRunModelDefaultsDTO> = {}): PlatformRunModelDefaultsDTO {
  return {
    rows: [
      runRow('review', { inheritsModel: 'claude-sonnet-5-5' }),
      runRow('design'),
      runRow('trivial', { model: 'claude-haiku-5-5' }),
      runRow('low', { model: 'claude-sonnet-5-5' }),
      runRow('medium', { model: null, inheritsModel: 'claude-opus-5-5' }),
      runRow('high', { model: 'claude-opus-5-5' }),
    ],
    options: [
      { id: 'claude-opus-5-5', provider: 'anthropic' },
      { id: 'claude-sonnet-5-5', provider: 'anthropic' },
      { id: 'claude-haiku-5-5', provider: 'anthropic' },
    ],
    canEdit: true,
    ...over,
  };
}

const wrap = (node: React.ReactNode) => render(<ToastProvider>{node}</ToastProvider>);
const rowOf = (id: string) => screen.getByTestId(`function-default-row-${id}`);

async function saveWith(row: HTMLElement, reason: string) {
  fireEvent.click(within(row).getByRole('button', { name: 'Save' }));
  const dialog = await screen.findByRole('alertdialog');
  fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: reason } });
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Change model' }));
  });
  return dialog;
}

describe('Guide, Debug and Ask on the AI planning table', () => {
  it('render under their own caption, between the audiences and the dry-run review', () => {
    wrap(
      <PlannerModelRows
        settings={planning({
          review: { model: null, offered: null, updatedAt: null, updatedBy: null, seeded: true },
        })}
      />,
    );
    const card = screen.getByTestId('ai-planning-card');
    const text = card.textContent ?? '';
    expect(text).toContain('Planning-side models');
    expect(text).toContain('7 settings');
    expect(text).toContain('Applies to');
    const order = [
      'Planning · by audience',
      'Guide · Debug · Ask · platform defaults',
      'Final check review · platform only',
    ];
    const at = order.map((s) => text.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(rowOf('guide').textContent).toContain('Guide me through turns');
    expect(rowOf('debug').textContent).toContain('Diagnosing a defect into a bug');
    expect(rowOf('ask').textContent).toContain('The Motir AI conversation and Grill me');
    expect(rowOf('guide').textContent).toContain('Never set');
  });

  it('an older motir-ai with no function rows draws no function caption', () => {
    wrap(<PlannerModelRows settings={planning({ functions: [] })} />);
    expect(screen.queryByText('Guide · Debug · Ask · platform defaults')).toBeNull();
    expect(screen.queryByTestId('function-default-row-guide')).toBeNull();
  });

  it('the picker leads with Inherits, then only the planning list', () => {
    wrap(<PlannerModelRows settings={planning()} />);
    fireEvent.click(within(rowOf('debug')).getByRole('combobox', { name: 'Model for Debug' }));
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options[0]).toContain('Inherits — the audience’s planning model');
    expect(options).toHaveLength(3);
    expect(options[1]).toMatch(/^claude-opus-5-5/);
    expect(options[2]).toMatch(/^deepseek-v4-flash/);
  });

  it('saves Debug through the confirm, naming the function, and says so', async () => {
    wrap(<PlannerModelRows settings={planning()} />);
    fireEvent.click(within(rowOf('debug')).getByRole('combobox', { name: 'Model for Debug' }));
    fireEvent.click(screen.getByRole('option', { name: /deepseek-v4-flash/ }));
    fireEvent.click(within(rowOf('debug')).getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Change the platform Debug model?');
    expect(dialog.textContent).toContain(
      'Inherits — the audience’s planning model → deepseek-v4-flash. Applies from the next Debug diagnosis',
    );
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: ' cheaper ' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Change model' }));
    });
    expect(setPlannerFunctionModelAction).toHaveBeenCalledWith(
      'debug',
      'deepseek-v4-flash',
      'cheaper',
    );
    expect(await screen.findByText('Debug model changed')).toBeTruthy();
  });

  it('after the save, the re-read row shows the model and who changed it', () => {
    wrap(
      <PlannerModelRows
        settings={planning({
          functions: [
            fn('guide'),
            fn('debug', {
              model: 'deepseek-v4-flash',
              offered: true,
              updatedAt: '2026-11-10T10:00:00.000Z',
              updatedBy: 'Ops superadmin',
              seeded: false,
            }),
            fn('ask'),
          ],
        })}
      />,
    );
    expect(rowOf('debug').textContent).toMatch(/Changed .* by Ops superadmin/);
  });

  it('clearing to Inherits saves null', async () => {
    wrap(
      <PlannerModelRows
        settings={planning({
          functions: [
            fn('guide', { model: 'deepseek-v4-flash', offered: true }),
            fn('debug'),
            fn('ask'),
          ],
        })}
      />,
    );
    fireEvent.click(within(rowOf('guide')).getByRole('combobox', { name: 'Model for Guide' }));
    fireEvent.click(screen.getByRole('option', { name: /Inherits/ }));
    await saveWith(rowOf('guide'), 'follow planning');
    expect(setPlannerFunctionModelAction).toHaveBeenCalledWith('guide', null, 'follow planning');
  });

  it('UNCHANGED is said on the row', async () => {
    setPlannerFunctionModelAction.mockResolvedValueOnce({ ok: false, code: 'UNCHANGED' });
    wrap(<PlannerModelRows settings={planning()} />);
    fireEvent.click(within(rowOf('ask')).getByRole('combobox', { name: 'Model for Ask' }));
    fireEvent.click(screen.getByRole('option', { name: /claude-opus-5-5/ }));
    await saveWith(rowOf('ask'), 'x');
    expect(within(rowOf('ask')).getByRole('alert').textContent).toBe(
      'Ask already runs on claude-opus-5-5.',
    );
  });

  it('a withdrawn stored model gets the chip and names the fallback', () => {
    wrap(
      <PlannerModelRows
        settings={planning({
          functions: [
            fn('guide', { model: 'claude-old-1', offered: false }),
            fn('debug'),
            fn('ask'),
          ],
        })}
      />,
    );
    const chip = within(rowOf('guide')).getByTestId('ai-planning-withdrawn');
    expect(chip.textContent).toContain('No longer offered');
    expect(chip.textContent).toContain(
      'Guide falls back to the audience’s planning model until you choose another.',
    );
  });

  it('read-only staff: text, no picker and no Save; the withdrawn line names a superadmin', () => {
    wrap(
      <PlannerModelRows
        settings={planning({
          canEdit: false,
          functions: [
            fn('guide'),
            fn('debug', { model: 'claude-old-1', offered: false }),
            fn('ask'),
          ],
        })}
      />,
    );
    expect(within(rowOf('guide')).queryAllByRole('combobox')).toHaveLength(0);
    expect(within(rowOf('guide')).queryByRole('button', { name: 'Save' })).toBeNull();
    expect(rowOf('guide').textContent).toContain('Inherits — the audience’s planning model');
    expect(rowOf('debug').textContent).toContain('claude-old-1');
    expect(rowOf('debug').textContent).toContain('until a superadmin chooses another');
  });
});

describe('the shared row (PlatformModelRow) through a function row', () => {
  it('after a save the re-read row says "Changed just now by you"', async () => {
    const { rerender } = wrap(<PlannerModelRows settings={planning()} />);
    fireEvent.click(within(rowOf('guide')).getByRole('combobox', { name: 'Model for Guide' }));
    fireEvent.click(screen.getByRole('option', { name: /deepseek-v4-flash/ }));
    await saveWith(rowOf('guide'), 'x');
    rerender(
      <ToastProvider>
        <PlannerModelRows
          settings={planning({
            functions: [
              fn('guide', {
                model: 'deepseek-v4-flash',
                offered: true,
                updatedAt: '2026-11-10T10:00:00.000Z',
                updatedBy: 'Ops superadmin',
                seeded: false,
              }),
              fn('debug'),
              fn('ask'),
            ],
          })}
        />
      </ToastProvider>,
    );
    expect(rowOf('guide').textContent).toContain('Changed just now by you');
  });

  it('a change by an account since removed reads without a name', () => {
    wrap(
      <PlannerModelRows
        settings={planning({
          functions: [
            fn('guide', {
              model: 'deepseek-v4-flash',
              offered: true,
              updatedAt: '2026-11-10T10:00:00.000Z',
              seeded: false,
            }),
            fn('debug'),
            fn('ask'),
          ],
        })}
      />,
    );
    expect(rowOf('guide').textContent).toMatch(/Changed [^b]*$/);
  });

  it('picking the stored value again leaves nothing to save', () => {
    wrap(<PlannerModelRows settings={planning()} />);
    const combo = () => within(rowOf('ask')).getByRole('combobox', { name: 'Model for Ask' });
    fireEvent.click(combo());
    fireEvent.click(screen.getByRole('option', { name: /claude-opus-5-5/ }));
    const save = within(rowOf('ask')).getByRole('button', { name: 'Save' });
    expect(save.hasAttribute('disabled')).toBe(false);
    fireEvent.click(combo());
    fireEvent.click(screen.getByRole('option', { name: /Inherits/ }));
    expect(save.hasAttribute('disabled')).toBe(true);
  });

  it('Escape closes the confirm without saving', async () => {
    wrap(<PlannerModelRows settings={planning()} />);
    fireEvent.click(within(rowOf('ask')).getByRole('combobox', { name: 'Model for Ask' }));
    fireEvent.click(screen.getByRole('option', { name: /claude-opus-5-5/ }));
    fireEvent.click(within(rowOf('ask')).getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(setPlannerFunctionModelAction).not.toHaveBeenCalled();
  });

  it.each([
    [
      'no enabled channel serves this model',
      'no enabled channel serves this model for the planner',
    ],
    ['the gateway did not answer in 10s', 'timed out'],
    ['something new', 'something new'],
  ])('UNREACHABLE "%s" reads "%s"', async (reason, said) => {
    setPlannerFunctionModelAction.mockResolvedValueOnce({ ok: false, code: 'UNREACHABLE', reason });
    wrap(<PlannerModelRows settings={planning()} />);
    fireEvent.click(within(rowOf('debug')).getByRole('combobox', { name: 'Model for Debug' }));
    fireEvent.click(screen.getByRole('option', { name: /claude-opus-5-5/ }));
    await saveWith(rowOf('debug'), 'x');
    expect(within(rowOf('debug')).getByRole('alert').textContent).toContain(said);
  });
});

describe('the Run-side defaults card', () => {
  it('six rows in the drawn order, each with what it inherits or its model', () => {
    wrap(<RunModelDefaults defaults={runSide()} />);
    const card = screen.getByTestId('run-side-defaults');
    expect(card.textContent).toContain('Run-side defaults');
    expect(card.textContent).toContain('6 settings');
    const ids = within(card)
      .getAllByRole('row')
      .map((r) => r.getAttribute('data-testid'))
      .filter(Boolean);
    expect(ids).toEqual([
      'function-default-row-review',
      'function-default-row-design',
      'function-default-row-trivial',
      'function-default-row-low',
      'function-default-row-medium',
      'function-default-row-high',
    ]);
    fireEvent.click(
      within(rowOf('review')).getByRole('combobox', { name: 'Review agent default model' }),
    );
    expect(screen.getAllByRole('option')[0]?.textContent).toContain(
      'Inherits — the run default (claude-sonnet-5-5)',
    );
    expect(rowOf('review').textContent).toContain('Never set');
    expect(rowOf('trivial').textContent).toContain('Seeded from the environment · never changed');
  });

  it('read-only staff see each value as text: inherits-with-what, the env value, a model', () => {
    wrap(
      <RunModelDefaults
        defaults={runSide({
          canEdit: false,
          rows: [
            runRow('review'),
            runRow('design'),
            runRow('medium', { inheritsModel: 'claude-opus-5-5' }),
            runRow('low'),
            runRow('high', { model: 'claude-opus-5-5' }),
          ],
        })}
      />,
    );
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(rowOf('review').textContent).toContain('Inherits — the run default');
    expect(rowOf('design').textContent).toContain('Inherits — the work item’s difficulty');
    expect(rowOf('medium').textContent).toContain(
      'Inherits — the environment value (claude-opus-5-5)',
    );
    expect(rowOf('low').textContent).toContain('Inherits — the environment value');
    expect(rowOf('high').textContent).toContain('claude-opus-5-5');
    expect(screen.getByTestId('run-side-defaults-read-only').textContent).toBe(
      'Only a superadmin can change these.',
    );
  });

  it('saves the review default through the confirm, and clears a level to null', async () => {
    wrap(<RunModelDefaults defaults={runSide()} />);
    fireEvent.click(
      within(rowOf('review')).getByRole('combobox', { name: 'Review agent default model' }),
    );
    fireEvent.click(screen.getByRole('option', { name: /claude-opus-5-5/ }));
    const dialog = await saveWith(rowOf('review'), 'reviews on opus');
    expect(dialog.textContent).toContain('Change the platform Review agent model?');
    expect(dialog.textContent).toContain('Applies from the next review');
    expect(setRunModelDefaultAction).toHaveBeenCalledWith(
      'review',
      'claude-opus-5-5',
      'reviews on opus',
    );
    expect(await screen.findByText('Review agent model changed')).toBeTruthy();

    fireEvent.click(
      within(rowOf('high')).getByRole('combobox', { name: 'Agent run · High default model' }),
    );
    fireEvent.click(screen.getByRole('option', { name: /Inherits/ }));
    await saveWith(rowOf('high'), 'back to env');
    expect(setRunModelDefaultAction).toHaveBeenLastCalledWith('high', null, 'back to env');
  });

  it('NOT_OFFERED keeps the stored value, says why and re-reads', async () => {
    setRunModelDefaultAction.mockResolvedValueOnce({ ok: false, code: 'NOT_OFFERED' });
    wrap(<RunModelDefaults defaults={runSide()} />);
    fireEvent.click(
      within(rowOf('design')).getByRole('combobox', { name: 'Design run default model' }),
    );
    fireEvent.click(screen.getByRole('option', { name: /claude-haiku-5-5/ }));
    await saveWith(rowOf('design'), 'x');
    expect(within(rowOf('design')).getByRole('alert').textContent).toContain(
      'claude-haiku-5-5 is no longer offered for Motir agent runs or not on the list',
    );
    expect(refresh).toHaveBeenCalled();
  });

  it('UNCHANGED is said on the row', async () => {
    setRunModelDefaultAction.mockResolvedValueOnce({ ok: false, code: 'UNCHANGED' });
    wrap(<RunModelDefaults defaults={runSide()} />);
    fireEvent.click(
      within(rowOf('low')).getByRole('combobox', { name: 'Agent run · Low default model' }),
    );
    fireEvent.click(screen.getByRole('option', { name: /claude-opus-5-5/ }));
    await saveWith(rowOf('low'), 'x');
    expect(within(rowOf('low')).getByRole('alert').textContent).toBe(
      'Agent run · Low is already claude-opus-5-5.',
    );
  });

  it.each([
    ['review', 'the run default'],
    ['design', 'the work item’s difficulty'],
    ['high', 'the environment value'],
  ] as const)('a withdrawn %s carries the chip and falls back to %s', (key, what) => {
    wrap(
      <RunModelDefaults
        defaults={runSide({
          rows: [runRow(key, { model: 'claude-old-1', withdrawn: true })],
        })}
      />,
    );
    const chip = within(rowOf(key)).getByTestId('run-side-withdrawn');
    expect(chip.textContent).toContain('No longer offered');
    expect(chip.textContent).toContain(`falls back to ${what} until you choose another.`);
  });

  it('a withdrawn row for read-only staff names a superadmin', () => {
    wrap(
      <RunModelDefaults
        defaults={runSide({
          canEdit: false,
          rows: [runRow('review', { model: 'claude-old-1', withdrawn: true })],
        })}
      />,
    );
    expect(rowOf('review').textContent).toContain('until a superadmin chooses another');
  });

  it('a changed row names who changed it', () => {
    wrap(
      <RunModelDefaults
        defaults={runSide({
          rows: [
            runRow('review', {
              model: 'claude-opus-5-5',
              updatedAt: '2026-11-10T10:00:00.000Z',
              updatedBy: 'Ops superadmin',
              seeded: false,
            }),
          ],
        })}
      />,
    );
    expect(rowOf('review').textContent).toMatch(/Changed .* by Ops superadmin/);
  });

  it('the unavailable card: no rows, Retry re-reads', () => {
    wrap(<RunModelDefaultsUnavailable />);
    const card = screen.getByTestId('run-side-defaults-unavailable');
    expect(card.textContent).toContain('Couldn’t load the run-side defaults');
    expect(card.textContent).toContain('no value is guessed');
    expect(screen.queryByTestId('function-default-row-review')).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Retry' }));
    expect(refresh).toHaveBeenCalled();
  });
});
