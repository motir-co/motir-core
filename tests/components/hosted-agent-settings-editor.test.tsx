// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { HostedAgentSettingsEditor } from '@/app/(authed)/settings/project/hosted-agent/_components/HostedAgentSettingsEditor';
import { toProjectHostedAgentSettingsDto } from '@/lib/mappers/projectHostedAgentSettingsMappers';
import type { ProjectHostedAgentSettingsDto } from '@/lib/dto/projectHostedAgentSettings';
import type { ProjectHostedModelOverridesRow } from '@/lib/repositories/projectRepository';

// HostedAgentSettingsEditor (Story MOTIR-6989 · MOTIR-6995) — the Hosted agent
// settings room, per `design/settings/hosted-agent.mock.html` (MOTIR-6991).
// Driven under happy-dom (DB-free): the editor is a client island over
// `GET / PATCH /api/projects/[key]/hosted-agent-settings`, so global fetch is
// stubbed and every DTO is built by the SHIPPED mapper — the same
// `resolveHostedModel` rule the server answers with — so the fixtures cannot
// drift from what the route returns. Every panel is asserted:
//   1 default · 2 choosing · 3 overridden + reset · 4 withdrawn · 5 read-only ·
//   6 loading · 7 unavailable (+ Try again) · the empty face · a failed save.

const OFFER = {
  models: ['claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5-5'],
  default: 'claude-opus-5-5',
  defaultsByDifficulty: {
    trivial: 'claude-sonnet-5-5',
    low: 'claude-sonnet-5-5',
    medium: 'claude-opus-5-5',
    high: 'claude-opus-5-5',
  },
  reviewAgentDefault: null as string | null,
  designRunDefault: null as string | null,
};

function settings(
  row: Partial<ProjectHostedModelOverridesRow> = {},
  offer: typeof OFFER = OFFER,
): ProjectHostedAgentSettingsDto {
  return toProjectHostedAgentSettingsDto(
    {
      hostedModelTrivial: null,
      hostedModelLow: null,
      hostedModelMedium: null,
      hostedModelHigh: null,
      ...row,
    },
    offer,
    offer.models.map((id) => ({ id, provider: 'anthropic' })),
  );
}

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function fail(status: number, body: unknown = {}) {
  return { ok: false, status, json: async () => body } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(ok(settings()));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function render(ui: ReactElement) {
  return renderWithIntl(<ToastProvider>{ui}</ToastProvider>);
}

/** Mount and let the mount read land (its state updates flushed inside act). */
async function mount(canConfigure = true) {
  render(<HostedAgentSettingsEditor projectKey="PROD" canConfigure={canConfigure} />);
  await act(async () => {});
}

async function click(el: Element) {
  await act(async () => {
    fireEvent.click(el);
  });
}

const row = (level: string) => screen.getByTestId(`hosted-agent-row-${level}`);
const select = (difficulty: string) =>
  screen.getByRole('combobox', { name: `Model for ${difficulty}` }) as HTMLButtonElement;
const source = (level: string) => screen.getByTestId(`hosted-agent-source-${level}`).textContent;
const saveButton = () => screen.getByTestId('hosted-agent-save') as HTMLButtonElement;
const patchCalls = () =>
  fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');

describe('HostedAgentSettingsEditor — the default room (panel 1)', () => {
  it('reads the settings and shows every difficulty on its platform default, easiest first', async () => {
    await mount();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/PROD/hosted-agent-settings',
      expect.objectContaining({ headers: { accept: 'application/json' } }),
    );
    expect(screen.getAllByRole('combobox').map((c) => c.getAttribute('aria-label'))).toEqual([
      'Model for Trivial',
      'Model for Low',
      'Model for Medium',
      'Model for High',
    ]);
    // The trigger shows the EFFECTIVE model and its provider.
    expect(select('Trivial').textContent).toContain('claude-sonnet-5-5');
    expect(select('Trivial').textContent).toContain('anthropic');
    expect(select('High').textContent).toContain('claude-opus-5-5');
    for (const level of ['trivial', 'low', 'medium', 'high']) {
      expect(source(level)).toBe('Platform default');
      expect(screen.queryByTestId(`hosted-agent-reset-${level}`)).toBeNull();
    }
    // The no-difficulty note names motir-ai's single default.
    expect(screen.getByTestId('hosted-agent-no-difficulty').textContent).toBe(
      'A work item with no difficulty runs on the platform default, claude-opus-5-5 — the model Run hosted marks Default.',
    );
    // The footer is there, and there is nothing to save.
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByTestId('hosted-agent-footer-hint').textContent).toBe('');
    expect(screen.queryByTestId('hosted-agent-readonly-banner')).toBeNull();
  });
});

describe('HostedAgentSettingsEditor — overriding a level (panels 2 and 3)', () => {
  it('offers exactly the offered list, marks the row’s own default, and stages an override', async () => {
    await mount();
    await click(select('Low'));
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining('claude-opus-5'),
      expect.stringContaining('claude-opus-5-5'),
      expect.stringContaining('claude-sonnet-5-5'),
    ]);
    // The row's own platform default is marked by its description line.
    expect(options[2]!.textContent).toContain('Platform default for Low');
    expect(options[0]!.textContent).not.toContain('Platform default for');

    await click(options[0]!);
    expect(select('Low').textContent).toContain('claude-opus-5');
    expect(source('low')).toBe('Override');
    expect(screen.getByTestId('hosted-agent-reset-low')).toBeTruthy();
    expect(screen.getByTestId('hosted-agent-footer-hint').textContent).toBe('Unsaved changes');
    expect(saveButton().disabled).toBe(false);
    expect(patchCalls()).toHaveLength(0);
  });

  it('Save PATCHes ONLY the changed level, applies the response in place and says so', async () => {
    await mount();
    await click(select('Low'));
    await click(screen.getAllByRole('option')[0]!);
    fetchMock.mockResolvedValueOnce(ok(settings({ hostedModelLow: 'claude-opus-5' })));
    await click(saveButton());

    const [url, init] = patchCalls()[0]!;
    expect(url).toBe('/api/projects/PROD/hosted-agent-settings');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ low: 'claude-opus-5' });
    expect(source('low')).toBe('Override');
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText('Hosted agent settings saved')).toBeTruthy();
  });

  it('Reset to default on a saved override stages a null, which Save sends', async () => {
    fetchMock.mockResolvedValueOnce(ok(settings({ hostedModelLow: 'claude-opus-5' })));
    await mount();
    expect(source('low')).toBe('Override');
    await click(screen.getByTestId('hosted-agent-reset-low'));
    expect(source('low')).toBe('Platform default');
    expect(select('Low').textContent).toContain('claude-sonnet-5-5');
    expect(screen.queryByTestId('hosted-agent-reset-low')).toBeNull();

    fetchMock.mockResolvedValueOnce(ok(settings()));
    await click(saveButton());
    expect(JSON.parse((patchCalls()[0]![1] as RequestInit).body as string)).toEqual({ low: null });
  });

  it('choosing a level’s own platform default IS a reset — no override is stored', async () => {
    fetchMock.mockResolvedValueOnce(ok(settings({ hostedModelHigh: 'claude-opus-5' })));
    await mount();
    await click(select('High'));
    await click(screen.getByRole('option', { name: /claude-opus-5-5/ }));
    expect(source('high')).toBe('Platform default');
    expect(screen.queryByTestId('hosted-agent-reset-high')).toBeNull();

    fetchMock.mockResolvedValueOnce(ok(settings()));
    await click(saveButton());
    expect(JSON.parse((patchCalls()[0]![1] as RequestInit).body as string)).toEqual({
      high: null,
    });
  });

  it('Cancel drops the staged change', async () => {
    await mount();
    await click(select('Medium'));
    await click(screen.getAllByRole('option')[0]!);
    expect(source('medium')).toBe('Override');
    await click(screen.getByRole('button', { name: 'Cancel' }));
    expect(source('medium')).toBe('Platform default');
    expect(saveButton().disabled).toBe(true);
  });

  it('a failed save reverts the committed state and says it was not saved', async () => {
    await mount();
    await click(select('Low'));
    await click(screen.getAllByRole('option')[0]!);
    fetchMock.mockResolvedValueOnce(fail(422, { code: 'HOSTED_MODEL_NOT_OFFERED' }));
    await click(saveButton());
    expect(screen.getByText('Couldn’t save')).toBeTruthy();
    // The edit is still staged, so it can be retried.
    expect(source('low')).toBe('Override');
    expect(saveButton().disabled).toBe(false);
  });
});

describe('HostedAgentSettingsEditor — a withdrawn override (panel 4)', () => {
  it('shows what runs use, keeps the platform-default source and flags the saved model', async () => {
    fetchMock.mockResolvedValueOnce(ok(settings({ hostedModelLow: 'claude-opus-4' })));
    await mount();
    expect(select('Low').textContent).toContain('claude-sonnet-5-5');
    expect(source('low')).toBe('Platform default');
    const note = screen.getByTestId('hosted-agent-withdrawn-low');
    expect(note.getAttribute('role')).toBe('note');
    expect(note.textContent).toBe(
      'The saved model, claude-opus-4, is no longer offered, so Low runs use the platform default. Reset to clear it.',
    );
    // The stored override is still there, so Reset is offered.
    await click(screen.getByTestId('hosted-agent-reset-low'));
    expect(screen.queryByTestId('hosted-agent-withdrawn-low')).toBeNull();
    fetchMock.mockResolvedValueOnce(ok(settings()));
    await click(saveButton());
    expect(JSON.parse((patchCalls()[0]![1] as RequestInit).body as string)).toEqual({ low: null });
  });
});

describe('HostedAgentSettingsEditor — read-only (panel 5)', () => {
  it('a member without ai:configure sees the values, a lock banner, and no controls', async () => {
    fetchMock.mockResolvedValueOnce(ok(settings({ hostedModelHigh: 'claude-opus-5' })));
    await mount(false);
    expect(screen.getByTestId('hosted-agent-readonly-banner').textContent).toBe(
      'Only a project admin can change hosted agent settings.',
    );
    for (const difficulty of ['Trivial', 'Low', 'Medium', 'High']) {
      expect(select(difficulty).disabled).toBe(true);
    }
    expect(select('High').textContent).toContain('claude-opus-5');
    expect(source('high')).toBe('Override');
    expect(screen.queryByTestId('hosted-agent-reset-high')).toBeNull();
    expect(screen.queryByTestId('hosted-agent-save')).toBeNull();
  });
});

describe('HostedAgentSettingsEditor — loading, unavailable, empty (panels 6, 7)', () => {
  it('holds the rows while the read is in flight: disabled selects, skeleton sources, no footer', async () => {
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    await mount();
    for (const difficulty of ['Trivial', 'Low', 'Medium', 'High']) {
      expect(select(difficulty).disabled).toBe(true);
      expect(select(difficulty).textContent).toContain('Loading models…');
    }
    expect(screen.getByTestId('hosted-agent-skeleton-low')).toBeTruthy();
    expect(screen.queryByTestId('hosted-agent-save')).toBeNull();
  });

  it('says Motir AI did not answer, empties the source column, and Try again re-reads', async () => {
    fetchMock.mockResolvedValueOnce(fail(503, { code: 'HOSTED_MODELS_UNAVAILABLE' }));
    await mount();
    const callout = screen.getByTestId('hosted-agent-unavailable');
    expect(callout.getAttribute('role')).toBe('status');
    expect(callout.textContent).toContain(
      'Couldn’t reach Motir AI, so the hosted models can’t be shown or changed right now. Hosted runs are off until it answers.',
    );
    expect(select('Low').textContent).toContain('Models unavailable');
    expect(select('Low').disabled).toBe(true);
    expect(within(row('low')).queryByText('Platform default')).toBeNull();
    expect(screen.queryByTestId('hosted-agent-save')).toBeNull();
    // The rows keep their difficulty labels, so the room still explains itself.
    expect(within(row('low')).getByText('Low')).toBeTruthy();

    fetchMock.mockResolvedValueOnce(ok(settings()));
    await click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.queryByTestId('hosted-agent-unavailable')).toBeNull();
    expect(select('Low').textContent).toContain('claude-sonnet-5-5');
    expect(source('low')).toBe('Platform default');
  });

  it('when nothing is offered, reads No model available and says there is nothing to choose', async () => {
    fetchMock.mockResolvedValueOnce(
      ok(
        settings({}, {
          models: [],
          default: null,
          defaultsByDifficulty: { trivial: null, low: null, medium: null, high: null },
          reviewAgentDefault: null,
          designRunDefault: null,
        } as unknown as typeof OFFER),
      ),
    );
    await mount();
    expect(screen.getByTestId('hosted-agent-empty').textContent).toBe(
      'No model can run a hosted work item right now, so there is nothing to choose.',
    );
    expect(select('Low').textContent).toContain('No model available');
    expect(select('Low').disabled).toBe(true);
    expect(screen.queryByTestId('hosted-agent-save')).toBeNull();
    expect(screen.queryByTestId('hosted-agent-no-difficulty')).toBeNull();
  });
});
