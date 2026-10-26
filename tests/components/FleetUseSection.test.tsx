// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import { ToastProvider } from '@/components/ui/Toast';
import type { FleetUseDTO, FleetUseHostAccountDTO } from '@/lib/dto/fleetUse';
import { FleetUseSection } from '@/app/(authed)/settings/organization/billing/_components/FleetUseSection';

// MOTIR-9663 (story MOTIR-9368): the Fleet use section of Billing & plans, one
// case per state the design draws (design/billing § Amendment 2026-10-26), and
// the Request more capacity dialog's every answer.

const URL_READ = '/api/organizations/org1/billing/fleet-use';
const URL_POST = '/api/organizations/org1/billing/fleet-use/capacity-requests';

/** Pro, at its figures: 3 agent runs (all busy, 2 held by the plan) and 10 of
 *  10 hosted agents in the org — MOTIR-9357's gate-corrected Pro figures. */
function proAtLimit(over: Partial<FleetUseDTO> = {}): FleetUseDTO {
  return {
    plan: { kind: 'limited', planKey: 'pro', planName: 'Pro', noFleet: false },
    countsRead: true,
    figures: {
      agentRunsInParallel: {
        figure: 3,
        inUse: 3,
        waiting: { planLimit: 2, poolFull: 0, other: 0 },
        figureSource: 'plan',
      },
      agentsRunningInOrg: { figure: 10, inUse: 10, waiting: null, figureSource: 'plan' },
      agentsPerPerson: { figure: 2, inUse: 1, waiting: null, figureSource: 'plan' },
      ciJobsInFlight: {
        figure: 3,
        inUse: 1,
        waiting: { planLimit: 0, poolFull: 0, other: 0 },
        figureSource: 'plan',
      },
    },
    codeGraphIndex: { inUse: 2 },
    whereItRuns: [
      { fleetKind: 'ci_runner', provider: 'fly' },
      { fleetKind: 'code_graph_index', provider: 'fly' },
      { fleetKind: 'hosted_agent', provider: 'shared_aws_pool' },
      { fleetKind: 'agent_instance', provider: 'shared_aws_pool' },
    ],
    hostAccounts: null,
    ...over,
  };
}

function account(over: Partial<FleetUseHostAccountDTO> = {}): FleetUseHostAccountDTO {
  return {
    accountKind: 'ci_runner',
    fleetKinds: ['ci_runner'],
    requestKind: 'ci_runner',
    state: 'live',
    createdAt: '2026-10-20T08:00:00.000Z',
    quotaRequestedAt: '2026-10-21T08:00:00.000Z',
    grantedAt: '2026-10-22T08:00:00.000Z',
    liveAt: '2026-10-23T09:12:00.000Z',
    vcpuAsked: 256,
    vcpuGranted: 256,
    quotaOutcome: 'approved',
    onSharedFloor: false,
    keptIndexSpots: null,
    capacityRequests: [],
    ...over,
  };
}

type Answer = { status: number; body?: unknown } | 'throw';

function stubFetch(reads: Answer[], post?: Answer) {
  let i = 0;
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    const answer = url === URL_POST ? post : reads[Math.min(i++, reads.length - 1)];
    if (!answer || answer === 'throw') throw new TypeError('network');
    return new Response(JSON.stringify(answer.body ?? null), { status: answer.status });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const ok = (fleetUse: FleetUseDTO): Answer => ({ status: 200, body: { fleetUse } });

function renderSection(opts: { locale?: string; messages?: Record<string, unknown> } = {}) {
  return render(
    <ToastProvider>
      <FleetUseSection orgId="org1" />
    </ToastProvider>,
    opts,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('FleetUseSection — the figures', () => {
  it('reads Pro at its limits: 3 of 3 agent runs with 2 waiting on the plan, 10 of 10 hosted agents', async () => {
    stubFetch([ok(proAtLimit())]);
    renderSection();
    const runs = await screen.findByTestId('fleet-figure-agentRunsInParallel');
    expect(within(runs).getByText('Agent runs in parallel')).toBeTruthy();
    expect(within(runs).getByText('3 of 3')).toBeTruthy();
    expect(within(runs).getByText('2 waiting')).toBeTruthy();
    expect(within(runs).getByText(/for your plan's limit/)).toBeTruthy();
    const org = screen.getByTestId('fleet-figure-agentsRunningInOrg');
    expect(within(org).getByText('10 of 10')).toBeTruthy();
    expect(within(org).queryByText(/waiting/)).toBeNull();
    const person = screen.getByTestId('fleet-figure-agentsPerPerson');
    expect(within(person).getByText('1 member at 2 of 2')).toBeTruthy();
    const ci = screen.getByTestId('fleet-figure-ciJobsInFlight');
    expect(within(ci).getByText('1 of 3')).toBeTruthy();
    expect(within(ci).getByText('Nothing waiting')).toBeTruthy();
    expect(screen.getByText(/Your plan:/).textContent).toContain('Pro');
    expect(screen.getByText(/Code-graph indexing: 2 running/)).toBeTruthy();
    expect(screen.queryByTestId('fleet-own-accounts')).toBeNull();
  });

  it('tells pool-full waiting apart from the plan', async () => {
    const data = proAtLimit();
    data.figures.ciJobsInFlight = {
      figure: 3,
      inUse: 3,
      waiting: { planLimit: 0, poolFull: 4, other: 1 },
      figureSource: 'plan',
    };
    stubFetch([ok(data)]);
    renderSection();
    const ci = await screen.findByTestId('fleet-figure-ciJobsInFlight');
    expect(within(ci).getByText('4 waiting')).toBeTruthy();
    expect(within(ci).getByText(/every CI runner account is full/)).toBeTruthy();
    expect(within(ci).getByText('1 waiting')).toBeTruthy();
    expect(within(ci).getByText('for another reason')).toBeTruthy();
    expect(within(ci).queryByText(/plan's limit/)).toBeNull();
  });

  it('draws a staff override and an unreadable CI figure as their own source lines', async () => {
    const data = proAtLimit();
    data.figures.ciJobsInFlight = {
      ...data.figures.ciJobsInFlight,
      figure: 8,
      figureSource: 'staff_override',
    };
    stubFetch([ok(data)]);
    renderSection();
    expect(await screen.findByText(/Set by Motir for your organisation: 8/)).toBeTruthy();
    cleanup();

    const unread = proAtLimit();
    unread.figures.ciJobsInFlight = {
      figure: null,
      inUse: 1,
      waiting: null,
      figureSource: 'not_read',
    };
    stubFetch([ok(unread)]);
    renderSection();
    const ci = await screen.findByTestId('fleet-figure-ciJobsInFlight');
    expect(within(ci).getByText('Not read')).toBeTruthy();
    expect(within(ci).getByText(/Your CI figure couldn't be read/)).toBeTruthy();
  });

  it('renders the whole section as not read — never zero — and retries', async () => {
    const fetchMock = stubFetch([{ status: 500 }, ok(proAtLimit())]);
    renderSection();
    const notice = await screen.findByRole('status');
    expect(notice.textContent).toContain('Nothing here is zero; it is unknown.');
    expect(screen.getByText('Plan not read')).toBeTruthy();
    for (const key of [
      'agentRunsInParallel',
      'agentsRunningInOrg',
      'agentsPerPerson',
      'ciJobsInFlight',
    ]) {
      expect(within(screen.getByTestId(`fleet-figure-${key}`)).getByText('Not read')).toBeTruthy();
    }
    expect(screen.queryByText(/^0 of/)).toBeNull();
    fireEvent.click(within(notice).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('3 of 3')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats counts it could not read as not read', async () => {
    stubFetch([ok(proAtLimit({ countsRead: false }))]);
    renderSection();
    expect(await screen.findByText('Plan not read')).toBeTruthy();
    expect(screen.getByText(/Code-graph indexing: not read/)).toBeTruthy();
  });

  it('renders nothing for a member (403) or an org off the cloud (404)', async () => {
    for (const status of [403, 404]) {
      const fetchMock = stubFetch([{ status }]);
      renderSection();
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      await waitFor(() => expect(screen.queryByTestId('fleet-use')).toBeNull());
      cleanup();
    }
  });

  it('shows use alone, with no figures, for a Motir-owned org', async () => {
    stubFetch([
      ok(
        proAtLimit({
          plan: { kind: 'no_plan_limits' },
          figures: {
            agentRunsInParallel: { figure: null, inUse: 4, waiting: null, figureSource: 'plan' },
            agentsRunningInOrg: { figure: null, inUse: 12, waiting: null, figureSource: 'plan' },
            agentsPerPerson: { figure: null, inUse: 0, waiting: null, figureSource: 'plan' },
            ciJobsInFlight: { figure: null, inUse: 7, waiting: null, figureSource: 'plan' },
          },
        }),
      ),
    ]);
    renderSection();
    expect(await screen.findByText('No plan limits')).toBeTruthy();
    expect(screen.getByText('4 running')).toBeTruthy();
    expect(screen.getByText('12 running')).toBeTruthy();
    expect(screen.queryByTestId('fleet-figure-agentsPerPerson')).toBeNull();
    expect(screen.getAllByText('No limit')).toHaveLength(3);
  });

  it('says the Free plan runs no fleet', async () => {
    stubFetch([
      ok(
        proAtLimit({ plan: { kind: 'limited', planKey: 'free', planName: 'Free', noFleet: true } }),
      ),
    ]);
    renderSection();
    expect(await screen.findByText(/Your plan includes no hosted agent runs/)).toBeTruthy();
    expect(screen.queryByTestId('fleet-figure-agentRunsInParallel')).toBeNull();
  });

  it('lists where each kind runs', async () => {
    stubFetch([ok(proAtLimit())]);
    renderSection();
    expect(await screen.findByText('Where it runs')).toBeTruthy();
    expect(screen.getAllByText('Fly')).toHaveLength(2);
    expect(screen.getAllByText("Motir's shared AWS pool")).toHaveLength(2);
  });

  it('renders in Chinese', async () => {
    stubFetch([ok(proAtLimit())]);
    renderSection({ locale: 'zh', messages: zhMessages });
    expect(await screen.findByText('集群用量')).toBeTruthy();
    expect(screen.getByText('并行智能体运行')).toBeTruthy();
    expect(screen.getByText('每个组织托管智能体')).toBeTruthy();
    expect(screen.getByText('2 个排队')).toBeTruthy();
  });
});

describe('FleetUseSection — own AWS accounts', () => {
  const host = (accounts: FleetUseDTO['hostAccounts'], over: Partial<FleetUseDTO> = {}) =>
    proAtLimit({
      plan: { kind: 'limited', planKey: 'host', planName: 'Host', noFleet: false },
      hostAccounts: accounts,
      ...over,
    });

  it('shows each account by what it runs, with its state, vCPU and granted figure source', async () => {
    const data = host([
      account(),
      account({
        accountKind: 'hosted_agent',
        fleetKinds: ['hosted_agent'],
        requestKind: 'hosted_agent',
        state: 'quota_requested',
        vcpuAsked: 64,
        vcpuGranted: null,
        quotaOutcome: 'pending',
        onSharedFloor: true,
      }),
    ]);
    data.figures.ciJobsInFlight = {
      ...data.figures.ciJobsInFlight,
      figure: 128,
      figureSource: 'granted_quota',
    };
    data.figures.agentRunsInParallel = {
      ...data.figures.agentRunsInParallel,
      figure: 5,
      figureSource: 'shared_floor',
    };
    stubFetch([ok(data)]);
    renderSection();
    const ci = await screen.findByTestId('fleet-account-ci_runner');
    expect(within(ci).getByText('CI runner')).toBeTruthy();
    expect(within(ci).getByText('Live')).toBeTruthy();
    expect(within(ci).getAllByText('256')).toHaveLength(2);
    expect(within(ci).getByText(/since Oct 23, 09:12/)).toBeTruthy();
    const agents = screen.getByTestId('fleet-account-hosted_agent');
    expect(within(agents).getByText('Quota requested')).toBeTruthy();
    expect(within(agents).getByText('None yet')).toBeTruthy();
    expect(
      within(agents).getByText(/Still on the shared floor at Max's limits: 5 agent runs at once/),
    ).toBeTruthy();
    expect(screen.getByText(/128 — 256 vCPU granted ÷ 2/)).toBeTruthy();
  });

  it('reads a denied raise beside the state it leaves the account in', async () => {
    stubFetch([
      ok(host([account({ state: 'quota_requested', quotaOutcome: 'denied', vcpuGranted: null })])),
    ]);
    renderSection();
    const row = await screen.findByTestId('fleet-account-ci_runner');
    expect(within(row).getByText('Quota denied')).toBeTruthy();
    expect(within(row).getByText(/stays at “Quota requested”/)).toBeTruthy();
  });

  it('shows the merged account kept index spots and a granted account waiting on its network', async () => {
    stubFetch([
      ok(
        host([
          account({
            accountKind: 'indexer_and_hoster',
            fleetKinds: ['code_graph_index', 'agent_instance'],
            requestKind: 'agent_instance',
            state: 'granted',
            keptIndexSpots: 4,
          }),
        ]),
      ),
    ]);
    renderSection();
    const row = await screen.findByTestId('fleet-account-indexer_and_hoster');
    expect(within(row).getByText(/4 machine spots are always kept for indexing/)).toBeTruthy();
    expect(within(row).getByText(/Live once the account's network is built/)).toBeTruthy();
  });

  it('notes an accounts read it could not make, with a retry', async () => {
    stubFetch([ok(host({ kind: 'not_read' }))]);
    renderSection();
    const block = await screen.findByTestId('fleet-own-accounts');
    expect(within(block).getByRole('status').textContent).toContain("couldn't read your accounts");
  });

  it('replaces the button with an open request’s status', async () => {
    stubFetch([
      ok(
        host([
          account({
            capacityRequests: [
              {
                id: 'r1',
                fleetKind: 'ci_runner',
                desiredVcpu: 512,
                reasonMd: 'x',
                status: 'filed',
                closedNote: null,
                createdAt: '2026-10-24T10:00:00.000Z',
                filedAt: '2026-10-24T11:00:00.000Z',
                closedAt: null,
                outcome: { status: 'case_opened', grantedValue: null, lastReadAt: null },
              },
            ],
          }),
        ]),
      ),
    ]);
    renderSection();
    const row = await screen.findByTestId('fleet-account-ci_runner');
    const line = within(row).getByTestId('fleet-request-status');
    expect(line.textContent).toContain('Filed with AWS');
    expect(line.textContent).toContain('Asked 512 vCPU on');
    expect(line.textContent).toContain('AWS has not answered yet');
    expect(within(row).queryByRole('button', { name: 'Request more capacity' })).toBeNull();
  });

  it('shows a closed request’s answer and offers the button again', async () => {
    stubFetch([
      ok(
        host([
          account({
            capacityRequests: [
              {
                id: 'r1',
                fleetKind: 'ci_runner',
                desiredVcpu: 512,
                reasonMd: 'x',
                status: 'closed',
                closedNote: null,
                createdAt: '2026-10-24T10:00:00.000Z',
                filedAt: '2026-10-24T11:00:00.000Z',
                closedAt: '2026-10-25T11:00:00.000Z',
                outcome: { status: 'approved', grantedValue: 384, lastReadAt: null },
              },
            ],
          }),
        ]),
      ),
    ]);
    renderSection();
    const row = await screen.findByTestId('fleet-account-ci_runner');
    expect(within(row).getByText('Granted 384 vCPU')).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Request more capacity' })).toBeTruthy();
  });
});

describe('FleetUseSection — Request more capacity', () => {
  const hostData = () =>
    proAtLimit({
      plan: { kind: 'limited', planKey: 'host', planName: 'Host', noFleet: false },
      hostAccounts: [account()],
    });

  async function openDialog(post?: Answer, reads: Answer[] = [ok(hostData())]) {
    const fetchMock = stubFetch(reads, post);
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Request more capacity' }));
    const dialog = await screen.findByRole('dialog');
    return { fetchMock, dialog };
  }

  function fill(dialog: HTMLElement, figure: string, reason: string) {
    fireEvent.change(within(dialog).getByLabelText('vCPU you need'), { target: { value: figure } });
    fireEvent.change(within(dialog).getByLabelText('Why you need it'), {
      target: { value: reason },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));
  }

  it('names the account and what is granted', async () => {
    const { dialog } = await openDialog();
    expect(within(dialog).getByText(/CI runner account · 256 vCPU granted/)).toBeTruthy();
  });

  it('refuses a figure not above what is granted, and an empty reason, before sending', async () => {
    const { dialog, fetchMock } = await openDialog();
    fill(dialog, '256', 'more builds');
    expect(await within(dialog).findByText(/Ask for a whole number above 256/)).toBeTruthy();
    fill(dialog, '512', '   ');
    expect(await within(dialog).findByText(/Say why you need it/)).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => url === URL_POST)).toBe(false);
  });

  it('sends, confirms, closes and re-reads the section', async () => {
    const after = hostData();
    (after.hostAccounts as FleetUseHostAccountDTO[])[0]!.capacityRequests = [
      {
        id: 'r2',
        fleetKind: 'ci_runner',
        desiredVcpu: 512,
        reasonMd: 'more builds',
        status: 'open',
        closedNote: null,
        createdAt: '2026-10-26T10:00:00.000Z',
        filedAt: null,
        closedAt: null,
        outcome: null,
      },
    ];
    const { dialog, fetchMock } = await openDialog({ status: 200, body: { request: {} } }, [
      ok(hostData()),
      ok(after),
    ]);
    fill(dialog, '512', 'more builds');
    expect(
      await screen.findByText('Request sent. Motir will tell you what AWS answers.'),
    ).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const post = fetchMock.mock.calls.find(([url]) => url === URL_POST)!;
    expect(JSON.parse(String(post[1]!.body))).toEqual({
      fleetKind: 'ci_runner',
      desiredVcpu: 512,
      reason: 'more builds',
    });
    const line = await screen.findByTestId('fleet-request-status');
    expect(line.textContent).toContain('sent to Motir');
    expect(fetchMock.mock.calls.filter(([url]) => url === URL_READ)).toHaveLength(2);
  });

  it.each([
    [
      { status: 409, body: { code: 'FLEET_CAPACITY_REQUEST_OPEN', requestId: 'r1' } },
      /already open/,
    ],
    [{ status: 404, body: { code: 'NOT_FOUND' } }, /no account of its own of this kind/],
    [{ status: 403, body: {} }, /Only an owner or admin/],
    [{ status: 400, body: { code: 'INVALID_BODY', field: 'fleetKind' } }, /could not be read/],
    [{ status: 500, body: {} }, /was not sent/],
    ['throw' as const, /couldn't send the request/],
  ])('tells a refused request apart by its code (%#)', async (answer, words) => {
    const { dialog } = await openDialog(answer as Answer);
    fill(dialog, '512', 'more builds');
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toMatch(words);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('puts a server field refusal on its field', async () => {
    const { dialog } = await openDialog({
      status: 400,
      body: { code: 'FLEET_POOL_VALUE_INVALID', field: 'desiredVcpu' },
    });
    fill(dialog, '512', 'more builds');
    expect(await within(dialog).findByText(/Ask for a whole number above 256/)).toBeTruthy();
    expect(within(dialog).queryByText(/could not be read/)).toBeNull();
  });
});

// ── Top-ups for MOTIR-9664's coverage lane: the rarer readings, the races the
// sequence guard settles, and the dialog's edges. ──────────────────────────────

describe('FleetUseSection — rarer account and request readings', () => {
  const host = (accounts: FleetUseHostAccountDTO[], over: Partial<FleetUseDTO> = {}) =>
    proAtLimit({
      plan: { kind: 'limited', planKey: 'host', planName: 'Host', noFleet: false },
      hostAccounts: accounts,
      ...over,
    });

  it('a just-created account on the shared floor, with nothing asked and no readable time', async () => {
    const data = host([
      account({
        state: 'created',
        createdAt: 'not a date',
        quotaRequestedAt: null,
        grantedAt: null,
        liveAt: null,
        vcpuAsked: null,
        vcpuGranted: null,
        quotaOutcome: null,
        onSharedFloor: true,
      }),
    ]);
    data.figures.ciJobsInFlight = { ...data.figures.ciJobsInFlight, figure: null };
    stubFetch([ok(data)]);
    renderSection();
    const row = await screen.findByTestId('fleet-account-ci_runner');
    expect(within(row).getByText('Created')).toBeTruthy();
    expect(within(row).queryByText(/^since /)).toBeNull();
    expect(within(row).getByText('—')).toBeTruthy();
    expect(within(row).getByText('None yet')).toBeTruthy();
    expect(within(row).getByText(/Still on the shared floor: CI at — runners/)).toBeTruthy();
  });

  const request = (over: Record<string, unknown>) => ({
    id: 'r1',
    fleetKind: 'ci_runner' as const,
    desiredVcpu: 512,
    reasonMd: 'x',
    status: 'closed' as const,
    closedNote: null,
    createdAt: '2026-10-24T10:00:00.000Z',
    filedAt: null,
    closedAt: '2026-10-25T10:00:00.000Z',
    outcome: null,
    ...over,
  });

  it.each([
    ['open', request({ status: 'open', closedAt: null }), 'Open', /sent to Motir/],
    [
      'closed with a note',
      request({ closedNote: 'Duplicate' }),
      'Closed',
      /closed by Motir: “Duplicate”/,
    ],
    [
      'denied',
      request({ outcome: { status: 'not_approved', grantedValue: null, lastReadAt: null } }),
      'Denied by AWS',
      /AWS refused the raise/,
    ],
    [
      'closed by AWS',
      request({ outcome: { status: 'case_closed', grantedValue: null, lastReadAt: null } }),
      'Closed',
      /AWS answered: AWS closed the case/,
    ],
    ['closed with no answer', request({ createdAt: 'bad' }), 'Closed', /AWS answered: Not read/],
    [
      'granted with no value read',
      request({ outcome: { status: 'approved', grantedValue: null, lastReadAt: null } }),
      'Granted 512 vCPU',
      /AWS granted it/,
    ],
  ])('a request %s reads its own pill and words', async (_, req, pill, words) => {
    stubFetch([ok(host([account({ capacityRequests: [req as never] })]))]);
    renderSection();
    const line = await screen.findByTestId('fleet-request-status');
    expect(within(line).getByText(pill)).toBeTruthy();
    expect(line.textContent).toMatch(words);
  });

  it('retries an accounts read it could not make', async () => {
    const fetchMock = stubFetch([ok(host({ kind: 'not_read' } as never)), ok(host([account()]))]);
    renderSection();
    const block = await screen.findByTestId('fleet-own-accounts');
    fireEvent.click(within(block).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('fleet-account-ci_runner')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('FleetUseSection — only the latest read lands', () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  /** Each read answers when the test says so. */
  function manualFetch() {
    const pending: ReturnType<typeof deferred<Response>>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        const d = deferred<Response>();
        pending.push(d);
        return d.promise;
      }),
    );
    return pending;
  }

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it('a slower, older read is ignored — whether it answers, fails or throws late', async () => {
    const reads = manualFetch();
    renderSection();
    reads[0]!.resolve(json(null, 500));
    const retry = await screen.findByRole('button', { name: 'Try again' });
    fireEvent.click(retry);
    fireEvent.click(retry);
    fireEvent.click(retry);
    await waitFor(() => expect(reads).toHaveLength(4));

    reads[3]!.resolve(json({ fleetUse: proAtLimit() }));
    expect(await screen.findByText('3 of 3')).toBeTruthy();

    // An older read answering 500, one throwing, one whose body arrives late.
    reads[1]!.resolve(json(null, 500));
    reads[2]!.reject(new TypeError('network'));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText('3 of 3')).toBeTruthy();
    expect(screen.queryByText('Plan not read')).toBeNull();
  });

  it('a body that arrives after a newer read began is ignored', async () => {
    const reads = manualFetch();
    renderSection();
    reads[0]!.resolve(json(null, 500));
    const retry = await screen.findByRole('button', { name: 'Try again' });
    fireEvent.click(retry);
    await waitFor(() => expect(reads).toHaveLength(2));
    const late = deferred<unknown>();
    reads[1]!.resolve({ ok: true, status: 200, json: () => late.promise } as unknown as Response);
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(retry);
    await waitFor(() => expect(reads).toHaveLength(3));
    late.resolve({ fleetUse: proAtLimit({ plan: { kind: 'no_plan_limits' } }) });
    reads[2]!.resolve(json({ fleetUse: proAtLimit() }));
    expect(await screen.findByText('3 of 3')).toBeTruthy();
    expect(screen.queryByText('No plan limits')).toBeNull();
  });

  it('a read that throws reads as not read', async () => {
    const reads = manualFetch();
    renderSection();
    reads[0]!.reject(new TypeError('network'));
    expect(await screen.findByText('Plan not read')).toBeTruthy();
  });
});

describe('FleetUseSection — the dialog’s edges', () => {
  const hostWith = (over: Partial<FleetUseHostAccountDTO> = {}) =>
    proAtLimit({
      plan: { kind: 'limited', planKey: 'host', planName: 'Host', noFleet: false },
      hostAccounts: [account(over)],
    });

  async function open(reads: Answer[], post?: Answer) {
    const fetchMock = stubFetch(reads, post);
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Request more capacity' }));
    return { fetchMock, dialog: await screen.findByRole('dialog') };
  }

  it('an account with nothing granted says so and asks for more than 0', async () => {
    const { dialog } = await open([ok(hostWith({ vcpuGranted: null }))]);
    expect(within(dialog).getByText(/nothing granted yet/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));
    expect(await within(dialog).findByText(/above 0/)).toBeTruthy();
  });

  it('closes from its own close button', async () => {
    const { dialog } = await open([ok(hostWith())]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a refusal with no readable body reads as not sent', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url === URL_POST
        ? new Response('<html>bad gateway</html>', { status: 502 })
        : new Response(JSON.stringify({ fleetUse: hostWith() }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Request more capacity' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('vCPU you need'), { target: { value: '512' } });
    fireEvent.change(within(dialog).getByLabelText('Why you need it'), {
      target: { value: 'more' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/was not sent/);
  });

  it('a second press while sending sends nothing more', async () => {
    let answer!: (r: Response) => void;
    const fetchMock = vi.fn((url: string) =>
      url === URL_POST
        ? new Promise<Response>((res) => (answer = res))
        : Promise.resolve(new Response(JSON.stringify({ fleetUse: hostWith() }), { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Request more capacity' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('vCPU you need'), { target: { value: '512' } });
    fireEvent.change(within(dialog).getByLabelText('Why you need it'), {
      target: { value: 'more' },
    });
    const send = within(dialog).getByRole('button', { name: 'Send request' });
    fireEvent.click(send);
    fireEvent.click(send);
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([url]) => url === URL_POST)).toHaveLength(1),
    );
    answer(new Response(JSON.stringify({ code: 'X' }), { status: 500 }));
    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([url]) => url === URL_POST)).toHaveLength(1);
  });
});
