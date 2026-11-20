// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import {
  CAPACITY_VIEW_ROUTE,
  CapacityScreen,
  type CapacityScreenProps,
} from '@/app/(admin)/admin/capacity/_components/CapacityScreen';
import { CAPACITY_SCREEN_REFRESH_MS } from '@/lib/capacity/screenRefresh';
import type { PlatformCapacityViewDTO } from '@/lib/dto/platformCapacity';
import {
  READ_AT,
  liveView,
  saturationNotConfigured,
  saturationOver,
  storeDownView,
} from '../../fixtures/capacityViewFixtures';

/**
 * The CAPACITY SCREEN island (MOTIR-9614, design `platform-admin` AMENDMENT
 * 2026-10-25, Panels 1–11, 16, 17). The actions are fakes and the poll's `fetch`
 * is stubbed: no gateway, no database.
 */

const editLimits = vi.fn<CapacityScreenProps['editLimits']>();
const setAlertShare = vi.fn<CapacityScreenProps['setAlertShare']>();
let visibility: DocumentVisibilityState = 'visible';

function okResponse(view: PlatformCapacityViewDTO): Response {
  return { ok: true, status: 200, json: async () => view } as Response;
}

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => okResponse(liveView()));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function render(view: PlatformCapacityViewDTO, messages?: Record<string, unknown>) {
  const props: CapacityScreenProps = {
    initialView: view,
    refreshMs: CAPACITY_SCREEN_REFRESH_MS,
    editLimits,
    setAlertShare,
  };
  return { props, ...renderWithIntl(<CapacityScreen {...props} />, messages ? { messages } : {}) };
}

describe('a live read', () => {
  it('one provider group per provider in read order, one entry per model', () => {
    render(liveView());
    const groups = screen.getAllByTestId(/^capacity-group-/).map((g) => g.dataset.testid);
    expect(groups).toEqual([
      'capacity-group-claude',
      'capacity-group-qwen',
      'capacity-group-deepseek',
    ]);
    const claude = screen.getByTestId('capacity-entry-claude-claude-example-1');
    expect(claude.textContent).toContain('Tier note: Example tier 4');
    expect(claude.textContent).toContain('Planning share 50 %');
    const qwen = screen.getByTestId('capacity-entry-qwen-qwen-example-1');
    expect(qwen.textContent).toContain('No tier note');
    expect(qwen.textContent).toContain('Unknown: rpm: not published for this tier');
  });

  it('puts the units a provider does not enforce in the closed fold only', () => {
    render(liveView());
    const claude = screen.getByTestId('capacity-entry-claude-claude-example-1');
    const fold = within(claude).getByTestId('capacity-not-enforced') as HTMLDetailsElement;
    expect(fold.open).toBe(false);
    expect(fold.textContent).toContain('Units this provider does not enforce (3)');
    expect(within(fold).getAllByText('Not applicable')).toHaveLength(3);
    expect(within(claude).queryByTestId('capacity-row-tpm')).toBeNull();
    expect(within(claude).getByTestId('capacity-row-rpm')).toBeTruthy();
  });

  it('prints the read time in UTC and the interval from the constant', () => {
    render(liveView());
    expect(screen.getByTestId('capacity-freshness').textContent).toContain(
      `Read at 12:00:04 UTC · refreshes every ${CAPACITY_SCREEN_REFRESH_MS / 1000} s`,
    );
    expect(READ_AT.slice(11, 19)).toBe('12:00:04');
  });

  it('shows no scope or unavailable notice on a shared, live read', () => {
    render(liveView());
    expect(screen.queryByText(/one gateway instance/)).toBeNull();
    expect(screen.queryByText(/Live numbers are unavailable/)).toBeNull();
  });
});

describe('the read’s other states', () => {
  it('counter store unavailable: every judged row Unavailable, limits and notes still shown', () => {
    render(storeDownView());
    expect(screen.getByText(/Live numbers are unavailable/)).toBeTruthy();
    const claude = screen.getByTestId('capacity-entry-claude-claude-example-1');
    expect(claude.textContent).toContain('Tier note: Example tier 4');
    expect(claude.textContent).toContain('Planning share 50 %');
    const rpm = within(claude).getByTestId('capacity-row-rpm');
    expect(rpm.textContent).toContain('/ 1,000');
    expect(within(rpm).getAllByText('Unavailable')).toHaveLength(2);
    // The per-entry "slow" notice is for a live store only.
    expect(screen.queryByText(/were not read in time/)).toBeNull();
  });

  it('one entry slow on a live store says so on that entry', () => {
    const view = storeDownView();
    if (view.capacity.outcome !== 'answered') throw new Error('fixture');
    view.capacity.counterStore.state = 'live';
    render(view);
    expect(screen.getAllByText(/were not read in time/)).toHaveLength(2);
  });

  it('counter scope instance shows the scope notice', () => {
    const view = liveView();
    if (view.capacity.outcome !== 'answered') throw new Error('fixture');
    view.capacity.counterStore.scope = 'instance';
    render(view);
    expect(
      screen.getByText('Numbers are from one gateway instance and may be partial.'),
    ).toBeTruthy();
  });

  it.each([
    ['credential', 'The gateway credential is not accepted'],
    ['unreachable', 'Capacity could not be read'],
  ] as const)(
    'unavailable (%s): the error panel, no rows, the share card and banner stay',
    (reason, title) => {
      render(
        liveView({
          capacity: { outcome: 'unavailable', reason },
          raised: [
            {
              provider: 'qwen',
              model: 'qwen-example-1',
              unit: 'rpm',
              raisedAt: '2026-10-25T11:58:00.000Z',
              observedValue: 480,
              limitValue: 600,
              alertSharePercent: 80,
            },
          ],
        }),
      );
      const panel = screen.getByTestId(`capacity-error-${reason}`);
      expect(panel.textContent).toContain(title);
      expect(panel.textContent).not.toMatch(/\d/);
      expect(screen.queryByTestId(/^capacity-row-/)).toBeNull();
      expect(screen.queryByTestId('capacity-freshness')).toBeNull();
      expect(screen.getByTestId('capacity-alert-share')).toBeTruthy();
      expect(screen.getByTestId('capacity-raised-alerts')).toBeTruthy();
    },
  );

  it('an answered read with no entries is the empty state', () => {
    const view = liveView();
    if (view.capacity.outcome !== 'answered') throw new Error('fixture');
    view.capacity.entries = [];
    render(view);
    expect(screen.getByText('No provider models configured')).toBeTruthy();
    expect(screen.queryByTestId(/^capacity-group-/)).toBeNull();
  });
});

describe('the raised-alerts banner', () => {
  it('one line per raised alert naming provider, model and limit', () => {
    render(
      liveView({
        raised: [
          {
            provider: 'claude',
            model: 'claude-example-2',
            unit: 'rpm',
            raisedAt: '2026-10-25T11:52:30.000Z',
            observedValue: 3400,
            limitValue: 4000,
            alertSharePercent: 80,
          },
          {
            provider: 'qwen',
            model: 'qwen-example-1',
            unit: 'tpm',
            raisedAt: '2026-10-25T11:58:00.000Z',
            observedValue: 640000,
            limitValue: 800000,
            alertSharePercent: 80,
          },
        ],
      }),
    );
    const banner = screen.getByRole('alert');
    expect(banner.textContent).toContain('2 limits are over the alert share');
    const lines = within(banner)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(lines[0]).toContain('Claude · claude-example-2 · Requests / min — 85 %');
    expect(lines[0]).toContain('raised since 11:52 UTC');
    expect(lines[1]).toContain('Qwen · qwen-example-1 · Tokens / min — 80 %');
  });

  it('is absent with nothing raised, and nothing stands in its place', () => {
    render(liveView());
    expect(screen.queryByTestId('capacity-raised-alerts')).toBeNull();
    expect(screen.queryByText(/over the alert share/)).toBeNull();
  });
});

describe('the gateway-saturation row (MOTIR-9675)', () => {
  it('with no source wired, reads unavailable: no figure, no share, and says why', () => {
    render(liveView({ saturation: saturationNotConfigured() }));
    const card = screen.getByTestId('capacity-gateway-saturation');
    expect(card.textContent).toContain('Gateway saturation');
    expect(card.textContent).toContain('Alerts at 70 %');
    expect(card.textContent).toContain('No source for these numbers is connected yet');
    expect(within(card).getByTestId('saturation-connections').textContent).toBe('Unavailable');
    expect(within(card).getByTestId('saturation-machines').textContent).toBe('Unavailable');
    expect(within(card).getByTestId('saturation-hard-limit').textContent).toBe('Unavailable');
    expect(within(card).getByTestId('saturation-share').textContent).toBe('—');
    expect(screen.queryByTestId('capacity-raised-alerts')).toBeNull();
  });

  it('shows connections, created machines, hard limit and the share of their product', () => {
    render(liveView({ saturation: { ...saturationOver(), raised: null } }));
    const card = screen.getByTestId('capacity-gateway-saturation');
    expect(within(card).getByTestId('saturation-connections').textContent).toBe('6,300');
    expect(within(card).getByTestId('saturation-machines').textContent).toBe('12');
    expect(within(card).getByTestId('saturation-hard-limit').textContent).toBe('750');
    expect(within(card).getByTestId('saturation-share').textContent).toContain('70 % of 9,000');
    expect(card.textContent).toContain('Over alert share');
    expect(card.textContent).not.toContain('No source');
  });

  it('a raised saturation alert is a line in the raised-alerts banner', () => {
    render(liveView({ saturation: saturationOver() }));
    const banner = screen.getByRole('alert');
    expect(banner.textContent).toContain('1 limit is over the alert share');
    expect(within(banner).getByTestId('capacity-raised-saturation').textContent).toContain(
      'motir-gateway · connections — 70 % of created machines × hard limit',
    );
    expect(banner.textContent).toContain('raised since 11:58 UTC');
  });
});

describe('the refresh', () => {
  it('re-reads the route with no-store every interval and on Refresh', async () => {
    vi.useFakeTimers();
    render(liveView());
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CAPACITY_SCREEN_REFRESH_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenLastCalledWith(CAPACITY_VIEW_ROUTE, { cache: 'no-store' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CAPACITY_SCREEN_REFRESH_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('applies a fresh read: the new readAt and rows replace the old', async () => {
    const next = liveView();
    if (next.capacity.outcome !== 'answered') throw new Error('fixture');
    next.capacity.readAt = '2026-10-25T12:00:19.000Z';
    fetchMock.mockImplementation(async () => okResponse(next));
    render(liveView());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    });
    expect(screen.getByTestId('capacity-freshness').textContent).toContain('12:00:19');
  });

  it('ignores an older response that lands after a newer one', async () => {
    const older = liveView();
    const newer = liveView();
    if (older.capacity.outcome !== 'answered' || newer.capacity.outcome !== 'answered') {
      throw new Error('fixture');
    }
    older.capacity.readAt = '2026-10-25T12:00:10.000Z';
    newer.capacity.readAt = '2026-10-25T12:00:20.000Z';
    let releaseOlder: (r: Response) => void = () => {};
    fetchMock
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (releaseOlder = resolve)))
      .mockImplementationOnce(async () => okResponse(newer));
    vi.useFakeTimers();
    render(liveView());
    // The first poll hangs; the next tick's poll answers first.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CAPACITY_SCREEN_REFRESH_MS);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CAPACITY_SCREEN_REFRESH_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('capacity-freshness').textContent).toContain('12:00:20');
    await act(async () => {
      releaseOlder(okResponse(older));
    });
    expect(screen.getByTestId('capacity-freshness').textContent).toContain('12:00:20');
  });

  it('pauses while the tab is hidden and resumes when it is shown', async () => {
    vi.useFakeTimers();
    render(liveView());
    visibility = 'hidden';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CAPACITY_SCREEN_REFRESH_MS * 3);
    });
    expect(fetchMock).not.toHaveBeenCalled();
    visibility = 'visible';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CAPACITY_SCREEN_REFRESH_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a non-200', async () => ({ ok: false, status: 404, json: async () => ({}) }) as Response],
    [
      'a network failure',
      async () => {
        throw new TypeError('fetch failed');
      },
    ],
  ])('%s keeps the last view and says Could not refresh beside its own readAt', async (_, impl) => {
    fetchMock.mockImplementation(impl);
    render(liveView());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    });
    const line = screen.getByTestId('capacity-freshness').textContent;
    expect(line).toContain('Could not refresh');
    expect(line).toContain('Read at 12:00:04 UTC');
    expect(screen.getAllByTestId('capacity-row-rpm')).toHaveLength(2);
  });
});

describe('the role views', () => {
  it('canEdit false: no Edit button and no alert-share edit control in the DOM', () => {
    render(liveView({ canEdit: false }));
    expect(screen.queryByRole('button', { name: 'Edit limits' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('canEdit true: an Edit limits button per entry and the alert-share Edit', () => {
    render(liveView());
    expect(screen.getAllByRole('button', { name: 'Edit limits' })).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
  });
});

describe('Chinese', () => {
  it('renders the zh column of the copy deck', () => {
    render(liveView(), zhMessages as Record<string, unknown>);
    expect(screen.getByTestId('capacity-freshness').textContent).toContain('读取于 UTC 12:00:04');
    expect(screen.getByText('告警比例')).toBeTruthy();
    expect(screen.getAllByText('编辑限额')).toHaveLength(3);
    expect(screen.getAllByText('正常').length).toBeGreaterThan(0);
  });
});

describe('what reaches the browser', () => {
  it('the client screen’s props carry no identifier and no credential', () => {
    const { props } = render(liveView());
    const json = JSON.stringify(props.initialView);
    for (const key of [
      'userId',
      'email',
      'organizationId',
      'orgId',
      'workspaceId',
      'tenantId',
      'token',
      'Authorization',
      'MOTIR_GATEWAY_CAPACITY_TOKEN',
    ]) {
      expect(json).not.toContain(`"${key}"`);
    }
    expect(json).not.toMatch(/token/i);
  });
});
