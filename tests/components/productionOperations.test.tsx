// @vitest-environment happy-dom
// MOTIR-12110 — the Production panel's When idle control and Usage section
// (design MOTIR-12101, `design/hosting/production--live-app-ops.mock.html`),
// rendered with the real `en` catalogue and the idle-policy and usage routes
// stubbed at `fetch`. Plus the pure usage-words module and the client calls
// behind them.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { IdlePolicyDto } from '@/lib/dto/idlePolicy';
import type { ProductionUsageDto, ProductionUsageUnitDto } from '@/lib/dto/productionUsage';
import { IdlePolicyControl, type IdlePolicyView } from '@/components/hosting/IdlePolicyControl';
import { ProductionUsage, TOP_UP_HREF, type UsageView } from '@/components/hosting/ProductionUsage';
import { usageUnitWords } from '@/lib/hosting/productionUsageWords';
import { productionPanelClient } from '@/lib/hosting/productionPanelClient';
import { ProductionPanel } from '@/components/hosting/ProductionPanel';
import type { ProductionPanelDto } from '@/lib/dto/productionPanel';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/settings/project/production',
  useSearchParams: () => new URLSearchParams(),
}));

const NOW = new Date('2026-11-23T15:00:00Z');
const BASE = '/api/projects/ACME/repositories/row-1/production';

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function deferred() {
  let resolve!: (res: Response) => void;
  const promise = new Promise<Response>((r) => (resolve = r));
  return { promise, resolve };
}

function idle(overrides: Partial<IdlePolicyDto> = {}): IdlePolicyDto {
  return {
    policy: { mode: 'suspend', idleSeconds: 300 },
    editable: true,
    refusal: null,
    ...overrides,
  };
}

function usage(overrides: Partial<ProductionUsageDto> = {}): ProductionUsageDto {
  return {
    period: { start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z' },
    usage: [
      { unit: 'fly_small_seconds', quantity: 5400, credits: 90 },
      { unit: 'neon_compute_hours', quantity: 2.5, credits: 12.345 },
    ],
    credits: 102,
    motirCostRecorded: true,
    state: 'ok',
    exhausted: null,
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** The control with the panel's state around it, so an answer replaces the view. */
function IdleHarness({
  initial,
  hasRelease = true,
  creditsExhausted = false,
  onRetry = () => {},
}: {
  initial: IdlePolicyView;
  hasRelease?: boolean;
  creditsExhausted?: boolean;
  onRetry?: () => void;
}) {
  const [view, setView] = useState(initial);
  return (
    <IdlePolicyControl
      projectKey="ACME"
      repositoryId="row-1"
      view={view}
      onView={setView}
      onRetry={onRetry}
      hasRelease={hasRelease}
      creditsExhausted={creditsExhausted}
    />
  );
}

function renderIdle(props: Parameters<typeof IdleHarness>[0]) {
  return renderWithIntl(<IdleHarness {...props} />, { now: NOW });
}

function option(name: string) {
  return within(screen.getByRole('group', { name: 'When idle' })).getByRole('button', { name });
}

describe('When idle — reading', () => {
  it('shows loading, then a load error with Try again', () => {
    const onRetry = vi.fn();
    const { rerender } = renderWithIntl(
      <IdlePolicyControl
        projectKey="ACME"
        repositoryId="row-1"
        view={{ kind: 'loading' }}
        onView={() => {}}
        onRetry={onRetry}
        hasRelease
        creditsExhausted={false}
      />,
      { now: NOW },
    );
    expect(screen.getByText('Loading the setting…')).toBeTruthy();
    rerender(
      <IdlePolicyControl
        projectKey="ACME"
        repositoryId="row-1"
        view={{ kind: 'failed' }}
        onView={() => {}}
        onRetry={onRetry}
        hasRelease
        creditsExhausted={false}
      />,
    );
    expect(screen.getByText('Couldn’t load this setting.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('gives an administrator the two options with the stored one pressed', () => {
    renderIdle({ initial: { kind: 'ready', idle: idle() } });
    expect(option('Suspend when idle').getAttribute('aria-pressed')).toBe('true');
    expect(option('Always on').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText(/The app sleeps when nothing asks for it/)).toBeTruthy();
    expect(screen.queryByTestId('production-idle-read-only')).toBeNull();
  });

  it('shows a member the setting as text, saying who can change it', () => {
    renderIdle({
      initial: { kind: 'ready', idle: idle({ editable: false, policy: { mode: 'always_on' } }) },
    });
    const block = screen.getByTestId('production-idle-read-only');
    expect(within(block).getByText('Always on')).toBeTruthy();
    expect(within(block).getByText('Only project administrators can change this.')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'When idle' })).toBeNull();
  });

  it('reads the default with no application and says when it applies', () => {
    renderIdle({
      initial: { kind: 'ready', idle: idle({ editable: false, policy: null }) },
      hasRelease: false,
    });
    const block = screen.getByTestId('production-idle-read-only');
    expect(within(block).getByText('Suspend when idle')).toBeTruthy();
    expect(within(block).queryByText('Only project administrators can change this.')).toBeNull();
    expect(
      screen.getByText('New apps start with Suspend when idle. It applies to the first release.'),
    ).toBeTruthy();
  });

  it('says why an AWS container cannot suspend, and disables that option', () => {
    renderIdle({
      initial: {
        kind: 'ready',
        idle: idle({
          policy: { mode: 'always_on' },
          refusal: {
            code: 'HOSTING_IDLE_POLICY_UNSUPPORTED',
            target: 'aws',
            shape: 'container',
            mode: 'suspend',
          },
        }),
      },
    });
    expect((option('Suspend when idle') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('production-idle-unsupported').textContent).toContain(
      'a container can only stay always on',
    );
    expect(screen.getByTestId('production-idle-unsupported').textContent).toContain(
      'This app keeps running all the time.',
    );
  });

  it('names a container when the refusal carries no shape', () => {
    renderIdle({
      initial: {
        kind: 'ready',
        idle: idle({
          refusal: {
            code: 'HOSTING_IDLE_POLICY_UNSUPPORTED',
            target: 'aws',
            shape: null,
            mode: 'suspend',
          },
        }),
      },
    });
    expect(screen.getByTestId('production-idle-unsupported').textContent).toContain('container');
  });

  it('refuses Always on while the balance is below zero, with the reason', () => {
    renderIdle({ initial: { kind: 'ready', idle: idle() }, creditsExhausted: true });
    expect((option('Always on') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('production-idle-credits').textContent).toContain(
      'Always on isn’t available while',
    );
  });

  it('leaves an always-on app as it is when the balance is below zero', () => {
    renderIdle({
      initial: { kind: 'ready', idle: idle({ policy: { mode: 'always_on' } }) },
      creditsExhausted: true,
    });
    expect((option('Always on') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId('production-idle-credits')).toBeNull();
  });
});

describe('When idle — switching', () => {
  it('is busy until the route answers, then shows the answer', async () => {
    const answer = deferred();
    const fetchMock = vi.fn(() => answer.promise);
    vi.stubGlobal('fetch', fetchMock);
    renderIdle({ initial: { kind: 'ready', idle: idle() } });

    fireEvent.click(option('Always on'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/idle-policy`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ mode: 'always_on' });
    expect(screen.getByText('Applying to the running release…')).toBeTruthy();
    expect(
      screen.getByText('The same build is redeployed with the new setting. Nothing is rebuilt.'),
    ).toBeTruthy();
    expect(option('Always on').getAttribute('aria-pressed')).toBe('true');
    expect((option('Suspend when idle') as HTMLButtonElement).disabled).toBe(true);

    answer.resolve(respond(200, idle({ policy: { mode: 'always_on' } })));
    await flush();
    expect(screen.queryByText('Applying to the running release…')).toBeNull();
    expect(option('Always on').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(/The app keeps running all the time/)).toBeTruthy();
  });

  it('returns to the stored mode and says why when the route refuses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        respond(409, { error: { code: 'always_on_refused_out_of_credits', message: 'x' } }),
      ),
    );
    renderIdle({ initial: { kind: 'ready', idle: idle() } });
    fireEvent.click(option('Always on'));
    await flush();
    expect(option('Suspend when idle').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('production-idle-refused').textContent).toContain(
      'Always on isn’t available while',
    );
    // The same words are not said twice once the read agrees.
    expect(screen.queryByTestId('production-idle-credits')).toBeNull();
  });

  it.each([
    [409, { error: { code: 'release_in_progress' } }, 'A release is in progress.'],
    [403, {}, 'Only project administrators can change this.'],
    [404, {}, 'This repository is no longer available'],
    [500, 'not json', 'The new setting didn’t apply'],
    [422, { error: { code: 'HOSTING_IDLE_POLICY_UNSUPPORTED' } }, 'can’t run that setting'],
    [409, { error: { code: 'no_application' } }, 'Nothing is in production yet.'],
  ])('words a %s refusal for the control', async (status, body, text) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        typeof body === 'string' ? new Response(body, { status }) : respond(status, body),
      ),
    );
    renderIdle({ initial: { kind: 'ready', idle: idle() } });
    fireEvent.click(option('Always on'));
    await flush();
    expect(screen.getByTestId('production-idle-refused').textContent).toContain(text);
  });

  it('says the switch failed when the network does', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('offline'))),
    );
    renderIdle({ initial: { kind: 'ready', idle: idle() } });
    fireEvent.click(option('Always on'));
    await flush();
    expect(screen.getByTestId('production-idle-refused').textContent).toContain(
      'The new setting didn’t apply',
    );
  });

  it('says the switch failed when the answer is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>', { status: 200 })),
    );
    renderIdle({ initial: { kind: 'ready', idle: idle() } });
    fireEvent.click(option('Always on'));
    await flush();
    expect(screen.getByTestId('production-idle-refused').textContent).toContain(
      'The new setting didn’t apply',
    );
  });

  it('ignores a click on the stored mode', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderIdle({ initial: { kind: 'ready', idle: idle() } });
    fireEvent.click(option('Suspend when idle'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops an answer that a newer read overtook', async () => {
    const answer = deferred();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => answer.promise),
    );
    const { rerender } = renderWithIntl(
      <IdlePolicyControl
        projectKey="ACME"
        repositoryId="row-1"
        view={{ kind: 'ready', idle: idle() }}
        onView={() => {}}
        onRetry={() => {}}
        hasRelease
        creditsExhausted={false}
      />,
      { now: NOW },
    );
    fireEvent.click(option('Always on'));
    // The read is replaced (a retry, say) and the switch control unmounts.
    rerender(
      <IdlePolicyControl
        projectKey="ACME"
        repositoryId="row-1"
        view={{ kind: 'loading' }}
        onView={() => {}}
        onRetry={() => {}}
        hasRelease
        creditsExhausted={false}
      />,
    );
    answer.resolve(respond(500, {}));
    await flush();
    // The pending switch's answer still settles; a refusal is shown only once.
    expect(screen.getAllByText('Loading the setting…')).toHaveLength(1);
  });
});

function renderUsage(view: UsageView, isAdministrator = true, onRetry = () => {}) {
  return renderWithIntl(
    <ProductionUsage view={view} isAdministrator={isAdministrator} onRetry={onRetry} />,
    { now: NOW },
  );
}

describe('Usage this period', () => {
  it('shows loading, then a load error with Try again', () => {
    const onRetry = vi.fn();
    const { rerender } = renderUsage({ kind: 'loading' }, true, onRetry);
    expect(screen.getByText('Loading usage…')).toBeTruthy();
    rerender(<ProductionUsage view={{ kind: 'failed' }} isAdministrator onRetry={onRetry} />);
    expect(screen.getByText('Couldn’t load this period’s usage.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('lists each unit in its human measure, with the credits charged', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    renderUsage({ kind: 'ready', usage: usage() });
    const rows = screen.getAllByTestId('production-usage-row');
    expect(rows.map((r) => r.getAttribute('data-unit'))).toEqual([
      'fly_small_seconds',
      'neon_compute_hours',
    ]);
    expect(rows[0]!.textContent).toContain('Fly machine · small');
    expect(rows[0]!.textContent).toContain('1.5 h');
    expect(rows[0]!.textContent).toContain('90');
    expect(rows[1]!.textContent).toContain('Neon database compute');
    expect(rows[1]!.textContent).toContain('2.5 CU-h');
    expect(rows[1]!.textContent).toContain('12.35');
    expect(screen.getByTestId('production-usage-total').textContent).toBe('102');
    // The period runs to the last charged day: yesterday.
    expect(screen.getByTestId('production-usage-period').textContent).toMatch(/Nov 1.*22.*2026/);
    expect(screen.getByText(/so today’s is not in the total yet/)).toBeTruthy();
    expect(screen.queryByTestId('production-credits-exhausted')).toBeNull();
  });

  it('shows the period’s first day alone on its first day', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T09:00:00Z'));
    renderUsage({ kind: 'ready', usage: usage() });
    expect(screen.getByTestId('production-usage-period').textContent).toBe('Nov 1, 2026');
  });

  it('says nothing is used yet when there are no rows', () => {
    renderUsage({ kind: 'ready', usage: usage({ usage: [], credits: 0, state: 'no_release' }) });
    expect(screen.getByText(/Nothing used yet\./)).toBeTruthy();
    expect(screen.queryByTestId('production-usage-total')).toBeNull();
  });

  it('shows an administrator the out-of-credits box with the switch date and Top up', () => {
    renderUsage({
      kind: 'ready',
      usage: usage({
        state: 'credits_exhausted',
        exhausted: {
          since: '2026-11-20T00:00:00.000Z',
          balance: -42,
          canSuspend: true,
          suspendsAt: '2026-11-27T00:00:00.000Z',
        },
      }),
    });
    const box = screen.getByTestId('production-credits-exhausted');
    expect(box.textContent).toContain('Out of credits · balance -42');
    expect(box.textContent).toContain('still below zero on Nov 27');
    const topUp = within(box).getByTestId('production-top-up');
    expect(topUp.getAttribute('href')).toBe(TOP_UP_HREF);
    expect(topUp.textContent).toBe('Top up credits');
  });

  it('tells a member who can top up, and words a suspended app and an unread balance', () => {
    renderUsage(
      {
        kind: 'ready',
        usage: usage({
          state: 'credits_exhausted',
          exhausted: {
            since: '2026-11-20T00:00:00.000Z',
            balance: null,
            canSuspend: true,
            suspendsAt: null,
          },
        }),
      },
      false,
    );
    const box = screen.getByTestId('production-credits-exhausted');
    expect(within(box).getByText('Out of credits')).toBeTruthy();
    expect(box.textContent).toContain(
      'This app keeps running and sleeps when nothing asks for it.',
    );
    expect(within(box).queryByTestId('production-top-up')).toBeNull();
    expect(box.textContent).toContain('An organisation owner or admin can top up credits.');
  });

  it('says an AWS container keeps running always on in overdraft', () => {
    renderUsage({
      kind: 'ready',
      usage: usage({
        state: 'credits_exhausted',
        exhausted: {
          since: '2026-11-20T00:00:00.000Z',
          balance: -5,
          canSuspend: false,
          suspendsAt: null,
        },
      }),
    });
    expect(screen.getByTestId('production-credits-exhausted').textContent).toContain(
      'which can’t be suspended',
    );
  });
});

describe('usageUnitWords', () => {
  it.each<[ProductionUsageUnitDto, number, Record<string, unknown>]>([
    [
      'fly_small_seconds',
      3600,
      { labelKey: 'unit.machine', sizeKey: 'size.small', amountKey: 'amount.hours', amount: 1 },
    ],
    ['fly_medium_seconds', 7200, { sizeKey: 'size.medium', amount: 2 }],
    ['fly_large_seconds', 1800, { sizeKey: 'size.large', amount: 0.5 }],
    [
      'lambda_gb_seconds',
      12,
      { labelKey: 'unit.lambdaCompute', amountKey: 'amount.gbSeconds', amount: 12 },
    ],
    [
      'lambda_requests',
      900,
      { labelKey: 'unit.lambdaRequests', amountKey: 'amount.count', amount: 900 },
    ],
    [
      'fargate_vcpu_seconds',
      3600,
      { labelKey: 'unit.containerCpu', amountKey: 'amount.vcpuHours', amount: 1 },
    ],
    [
      'fargate_gb_seconds',
      7200,
      { labelKey: 'unit.containerMemory', amountKey: 'amount.gbHours', amount: 2 },
    ],
    [
      'neon_compute_hours',
      3,
      { labelKey: 'unit.dbCompute', provider: 'Neon', amountKey: 'amount.cuHours', amount: 3 },
    ],
    [
      'neon_storage_gb_hours',
      4,
      { labelKey: 'unit.dbStorage', provider: 'Neon', amountKey: 'amount.gbHours', amount: 4 },
    ],
    [
      'aurora_compute_hours',
      5,
      { labelKey: 'unit.dbCompute', provider: 'Aurora', amountKey: 'amount.acuHours', amount: 5 },
    ],
    [
      'aurora_storage_gb_hours',
      6,
      { labelKey: 'unit.dbStorage', provider: 'Aurora', amountKey: 'amount.gbHours', amount: 6 },
    ],
  ])('words %s', (unit, quantity, expected) => {
    expect(usageUnitWords(unit, quantity)).toMatchObject(expected);
  });

  it('has a label and an amount in the catalogue for every key it answers', async () => {
    const en = (await import('@/messages/en.json')).default as unknown as {
      settings: { production: { usage: Record<string, Record<string, string>> } };
    };
    const words = en.settings.production.usage;
    for (const unit of [
      'fly_small_seconds',
      'lambda_gb_seconds',
      'lambda_requests',
      'fargate_vcpu_seconds',
      'fargate_gb_seconds',
      'neon_compute_hours',
      'aurora_compute_hours',
      'aurora_storage_gb_hours',
    ] as const) {
      const w = usageUnitWords(unit, 1);
      const [labelGroup, label] = w.labelKey.split('.') as [string, string];
      const [amountGroup, amount] = w.amountKey.split('.') as [string, string];
      expect(words[labelGroup]![label]).toBeTruthy();
      expect(words[amountGroup]![amount]).toBeTruthy();
    }
  });
});

describe('productionPanelClient — idle policy and usage reads', () => {
  it('reads the idle policy and the usage from their routes', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('/idle-policy') ? respond(200, idle()) : respond(200, usage()),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(productionPanelClient.readIdlePolicy('ACME', 'row-1')).resolves.toEqual({
      ok: true,
      data: idle(),
    });
    await expect(productionPanelClient.readUsage('ACME', 'row-1')).resolves.toEqual({
      ok: true,
      data: usage(),
    });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([`${BASE}/idle-policy`, `${BASE}/usage`]);
  });

  it('answers a refusal for a failed, unreadable or unreachable read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(500, {})),
    );
    expect((await productionPanelClient.readUsage('ACME', 'row-1')).ok).toBe(false);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>', { status: 200 })),
    );
    expect(await productionPanelClient.readUsage('ACME', 'row-1')).toEqual({
      ok: false,
      refusalKey: 'dialog.error',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('offline'))),
    );
    expect(await productionPanelClient.readIdlePolicy('ACME', 'row-1')).toEqual({
      ok: false,
      refusalKey: 'dialog.error',
    });
  });

  it('sends a suspend switch with its quiet window', async () => {
    const fetchMock = vi.fn(async () => respond(200, idle()));
    vi.stubGlobal('fetch', fetchMock);
    await productionPanelClient.setIdlePolicy('ACME', 'row-1', {
      mode: 'suspend',
      idleSeconds: 600,
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ mode: 'suspend', idleSeconds: 600 });
  });
});

const PANEL: ProductionPanelDto = {
  application: { id: 'app-1', target: 'fly', productionAddress: 'shop--acme.motir.site' },
  currentRelease: null,
  previousRelease: null,
  releases: [],
  nextCursor: null,
  isAdministrator: true,
  canRollback: false,
};

describe('the Production panel mounts When idle and Usage', () => {
  function renderPanel(seeded: { idle?: IdlePolicyDto; usage?: ProductionUsageDto } = {}) {
    return renderWithIntl(
      <ProductionPanel
        projectKey="ACME"
        repositoryId="row-1"
        repositoryName="shop"
        initial={PANEL}
        initialHealth={null}
        initialIdle={seeded.idle ?? null}
        initialUsage={seeded.usage ?? null}
      />,
      { now: NOW },
    );
  }

  it('reads both when the page did not seed them, and refuses Always on out of credits', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.endsWith('/idle-policy')) return respond(200, idle());
        if (url.endsWith('/usage')) {
          return respond(
            200,
            usage({
              state: 'credits_exhausted',
              exhausted: {
                since: '2026-11-20T00:00:00.000Z',
                balance: -3,
                canSuspend: true,
                suspendsAt: '2026-11-27T00:00:00.000Z',
              },
            }),
          );
        }
        return respond(200, {
          state: 'unknown',
          since: null,
          condition: null,
          healthCheckPath: null,
          events: [],
        });
      }),
    );
    renderPanel();
    await flush();
    expect(calls).toContain(`${BASE}/idle-policy`);
    expect(calls).toContain(`${BASE}/usage`);
    const row = screen.getByTestId('production-operations-row');
    expect(within(row).getByTestId('production-idle-policy')).toBeTruthy();
    expect(within(row).getByTestId('production-credits-exhausted')).toBeTruthy();
    expect((option('Always on') as HTMLButtonElement).disabled).toBe(true);
  });

  it('reads nothing more when seeded, and Try again reads a failed one again', async () => {
    let usageReads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/usage')) {
          usageReads += 1;
          return usageReads === 1 ? respond(500, {}) : respond(200, usage());
        }
        if (url.endsWith('/idle-policy'))
          return usageReads > 1 ? respond(200, idle()) : respond(500, {});
        return respond(500, {});
      }),
    );
    renderPanel();
    await flush();
    const usageCard = screen.getByTestId('production-usage');
    const idleCard = screen.getByTestId('production-idle-policy');
    fireEvent.click(within(usageCard).getByRole('button', { name: 'Try again' }));
    expect(within(usageCard).getByText('Loading usage…')).toBeTruthy();
    await flush();
    expect(within(usageCard).getAllByTestId('production-usage-row')).toHaveLength(2);
    fireEvent.click(within(idleCard).getByRole('button', { name: 'Try again' }));
    expect(within(idleCard).getByText('Loading the setting…')).toBeTruthy();
    await flush();
    expect(option('Suspend when idle').getAttribute('aria-pressed')).toBe('true');
  });
});
