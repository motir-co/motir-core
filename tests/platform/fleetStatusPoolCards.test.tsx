// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToHtml } from '../helpers/serverPageHarness';
import en from '@/messages/en.json';
import type {
  InstallFleetBlockDTO,
  InstallPoolDTO,
  ShardAccountDTO,
  ShardBlockDTO,
  ShardPoolDTO,
} from '@/lib/dto/fleetStatusPools';

// THE FLEET STATUS PAGE'S POOLS CARDS (MOTIR-10887; design MOTIR-10885 Panels 1,
// 7–10). Rendered to HTML through Fizz over the REAL `en` catalogue, one case
// per state the mock draws: the install fleet in place, near its quota, with a
// pool not enabled, with the quota not read, and unanswered; the add-shard pools
// with a pool at and near its size, one with no account, one on Fly, an account
// paused, set by an admin, the spare, a quota not read, a pool whose read failed
// and the whole block unanswered. The disclosure's one boolean is driven in a
// client root.

vi.mock('next-intl/server', async () => {
  const { createTranslator, createFormatter } = await import('next-intl');
  const messages = (await import('@/messages/en.json')).default;
  return {
    getTranslations: async (namespace: string) =>
      createTranslator({ locale: 'en', messages, namespace } as never),
    getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
  };
});

const { InstallFleetCard, ShardPoolsCard } =
  await import('@/app/(admin)/admin/fleet-status/_components/PoolCards');
const { PoolDisclosure } =
  await import('@/app/(admin)/admin/fleet-status/_components/PoolDisclosure');

const NOW = new Date('2026-11-11T12:00:00.000Z');
const minAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();
const minLater = (n: number) => new Date(NOW.getTime() + n * 60_000).toISOString();
const f = en.platformAdmin.fleetStatus;
const mon = en.platformAdmin.monitoring.pools;

const text = (el: Element | null | undefined) =>
  (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

function install(over: Partial<Extract<InstallFleetBlockDTO, { status: 'ok' }>> = {}) {
  const pools: InstallPoolDTO[] = [
    {
      fleetKind: 'hosted_agent',
      enabled: true,
      running: 4,
      hibernated: null,
      machineVcpu: 2,
      vcpu: 8,
      sharePercent: 2,
    },
    {
      fleetKind: 'code_graph_index',
      enabled: true,
      running: 0,
      hibernated: null,
      machineVcpu: 2,
      vcpu: 0,
      sharePercent: 0,
    },
    {
      fleetKind: 'agent_instance',
      enabled: true,
      running: 5,
      hibernated: 9,
      machineVcpu: 2,
      vcpu: 10,
      sharePercent: 3,
    },
  ];
  return {
    status: 'ok' as const,
    quota: { status: 'ok' as const, vcpu: 384, readAt: minAgo(6) },
    usedVcpu: 18,
    percent: 5,
    nearQuota: false,
    leftVcpu: 366,
    pools,
    ...over,
  };
}

function acct(over: Partial<ShardAccountDTO> = {}): ShardAccountDTO {
  return {
    name: 'ci-iad-1',
    role: 'shared',
    state: 'active',
    sizeMachines: 128,
    sizeSource: 'granted',
    grantedVcpu: 256,
    grantedReadAt: minAgo(60),
    running: 22,
    pausedUntil: null,
    pausedReason: null,
    ...over,
  };
}

function awsPool(
  over: Partial<Extract<ShardPoolDTO, { provider: 'aws' }>> = {},
): Extract<ShardPoolDTO, { provider: 'aws' }> {
  return {
    fleetKind: 'ci_runner',
    provider: 'aws',
    accounts: [
      acct(),
      acct({
        name: 'ci-iad-2',
        sizeMachines: 64,
        sizeSource: 'override',
        running: 13,
        pausedUntil: minLater(48),
        pausedReason: 'capacity_refused',
      }),
      acct({
        name: 'ci-iad-3',
        state: 'provisioning',
        sizeMachines: null,
        sizeSource: null,
        grantedVcpu: null,
        grantedReadAt: null,
        running: 0,
        pausedUntil: new Date(NOW.getTime() + 26 * 3600_000).toISOString(),
        pausedReason: 'provider_unavailable',
      }),
      acct({
        name: 'ci-iad-4',
        role: 'spare',
        sizeMachines: 128,
        running: 0,
        state: 'disabled',
      }),
      acct({
        name: 'ci-iad-5',
        sizeMachines: null,
        sizeSource: null,
        grantedVcpu: null,
        grantedReadAt: minAgo(3 * 24 * 60),
        running: 1,
        state: 'odd',
      }),
    ],
    sharedCount: 3,
    spareNames: ['ci-iad-4'],
    sizeMachines: 320,
    notReadCount: 0,
    running: 41,
    percent: 13,
    flag: null,
    ...over,
  };
}

async function renderInto(node: React.ReactNode) {
  document.body.innerHTML = await renderToHtml(node);
  return document.body;
}
const installCard = async (block: InstallFleetBlockDTO) =>
  renderInto(await InstallFleetCard({ block, now: NOW }));
const shardCard = async (block: ShardBlockDTO) =>
  renderInto(await ShardPoolsCard({ block, now: NOW }));
const poolRow = (root: HTMLElement, kind: string) =>
  root.querySelector<HTMLElement>(`tr[data-install-pool="${kind}"]`)!;
const cells = (tr: Element) => [...tr.querySelectorAll('td')].map((td) => text(td));

beforeAll(async () => {
  await installCard(install());
}, 120_000);

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the install fleet card', () => {
  it('reads the quota, its use and each pool’s running machines and share (Panel 1)', async () => {
    const root = await installCard(install());
    const card = root.querySelector('[data-pool="install-fleet"]')!;
    expect(card.getAttribute('data-state')).toBe('ok');
    expect(text(card.querySelector('h3'))).toBe(f.install.title);
    expect(text(card)).toContain(mon.provider.aws);
    expect(card.querySelector('[data-flag="near-quota"]')).toBeNull();
    const quota = text(card.querySelector('[data-element="quota"]'));
    expect(quota).toContain('384 vCPU');
    expect(quota).toContain('Running On-Demand Standard instances · read 6 min ago');
    expect(quota).toContain('18 vCPU');
    expect(quota).toContain('5%');
    expect(card.querySelector('[data-element="near-quota"]')).toBeNull();

    expect([...card.querySelectorAll('thead th')].map(text)).toEqual([
      'Pool',
      'On the install fleet',
      'Running',
      'vCPU',
      'Share of the quota',
    ]);
    expect(cells(poolRow(root, 'hosted_agent'))).toEqual([
      'Agent runner',
      'Yes',
      '4 machines',
      '8 vCPU',
      '2%',
    ]);
    expect(cells(poolRow(root, 'code_graph_index'))).toEqual([
      'Indexer',
      'Yes',
      'None running',
      '0 vCPU',
      '0%',
    ]);
    expect(cells(poolRow(root, 'agent_instance'))).toEqual([
      'Agent hoster',
      'Yes',
      '5 awake9 hibernated, not counted',
      '10 vCPU',
      '3%',
    ]);
    expect(text(card)).toContain(f.install.readOnly);
  });

  it('flags the quota near at 70%, and a pool not on the fleet reads Not applicable (Panel 7)', async () => {
    const pools = install().pools;
    pools[0] = { fleetKind: 'hosted_agent', enabled: false };
    pools[2] = { ...(pools[2] as Extract<InstallPoolDTO, { enabled: true }>), running: 1 };
    const root = await installCard(
      install({ pools, usedVcpu: 288, percent: 75, nearQuota: true, leftVcpu: 96 }),
    );
    expect(text(root.querySelector('[data-flag="near-quota"]'))).toBe(f.install.nearQuota);
    expect(text(root.querySelector('[data-element="near-quota"]'))).toBe(
      'At 75% of the quota, past the 70% headroom mark. 96 vCPU are left for all three pools.',
    );
    const off = poolRow(root, 'hosted_agent');
    expect(off.getAttribute('data-enabled')).toBe('false');
    expect(cells(off)).toEqual([
      'Agent runner',
      f.install.notOnFleet,
      '—Not applicable',
      '—Not applicable',
      '—Not applicable',
    ]);
    expect(off.querySelector('[aria-hidden]')?.textContent).toBe('—');
    expect(cells(poolRow(root, 'agent_instance'))[2]).toBe('1 awake9 hibernated, not counted');
  });

  it('marks a quota AWS did not answer Not read, with its last read, and every figure from it Not available', async () => {
    const pools = install().pools.map((p) =>
      p.enabled
        ? { ...p, sharePercent: null, ...(p.fleetKind === 'hosted_agent' ? { vcpu: null } : {}) }
        : p,
    );
    let root = await installCard(
      install({
        quota: { status: 'notRead', lastReadAt: minAgo(120) },
        usedVcpu: null,
        percent: null,
        leftVcpu: null,
        pools,
      }),
    );
    const card = root.querySelector('[data-pool="install-fleet"]')!;
    expect(card.getAttribute('data-state')).toBe('quota-not-read');
    const mark = card.querySelector('[data-mark="not-read"]')!;
    expect(mark.getAttribute('aria-label')).toBe(mon.notReadLabel);
    expect(text(mark)).toContain(mon.notRead);
    expect(text(mark)).toContain('AWS didn’t answer · last read 2 h ago');
    const quota = text(card.querySelector('[data-element="quota"]'));
    expect(quota.match(/Not available/g)).toHaveLength(2);
    expect(quota).not.toContain('0 vCPU');
    expect(cells(poolRow(root, 'hosted_agent')).slice(3)).toEqual([
      'Not available',
      'Not available',
    ]);
    expect(cells(poolRow(root, 'code_graph_index')).slice(3)).toEqual(['0 vCPU', 'Not available']);

    root = await installCard(
      install({ quota: { status: 'notRead', lastReadAt: null }, usedVcpu: 18, percent: null }),
    );
    expect(text(root.querySelector('[data-mark="not-read"]'))).toContain(
      'AWS didn’t answer · never read',
    );
  });

  it('is the block error when the read did not answer (Panel 9)', async () => {
    const root = await installCard({ status: 'unavailable' });
    const card = root.querySelector('[data-pool="install-fleet"]')!;
    expect(card.getAttribute('data-state')).toBe('failed');
    expect(card.querySelector('[role="alert"]')).not.toBeNull();
    expect(text(card)).toContain(f.install.error.title);
    expect(text(card)).toContain(f.install.error.body);
    expect(text(card)).not.toContain(mon.provider.aws);
    expect(card.querySelector('table')).toBeNull();
  });
});

describe('the add-shard card', () => {
  const block = (pools: ShardPoolDTO[], nearCount = 0): ShardBlockDTO => ({
    status: 'ok',
    pools,
    nearCount,
  });

  it('reads each kind’s size, accounts, running and use, with its accounts behind the disclosure (Panels 1, 8)', async () => {
    const root = await shardCard(
      block(
        [
          awsPool(),
          {
            ...awsPool({ fleetKind: 'hosted_agent' }),
            accounts: [],
            sharedCount: 0,
            spareNames: [],
            sizeMachines: null,
            running: 0,
            percent: null,
          },
          awsPool({
            fleetKind: 'code_graph_index',
            sizeMachines: 32,
            running: 32,
            percent: 100,
            flag: 'atSize',
            spareNames: [],
            sharedCount: 1,
          }),
          awsPool({
            fleetKind: 'agent_instance',
            sizeMachines: 24,
            running: 19,
            percent: 79,
            flag: 'near',
          }),
        ],
        2,
      ),
    );
    const card = root.querySelector('[data-pool="add-shard"]')!;
    expect(text(card.querySelector('h3'))).toBe(f.shard.title);
    expect(text(card.querySelector('[data-flag="near-size"]'))).toBe('2 pools near their size');
    expect([...card.querySelectorAll(':scope table > thead th')].slice(0, 5).map(text)).toEqual([
      'Pool',
      'Size',
      'Accounts',
      'Running',
      'Of its size in use',
    ]);

    const ci = card.querySelector('tr[data-shard-pool="ci_runner"]')!;
    expect(cells(ci)).toEqual([
      'CI runner',
      '320 machines640 vCPU',
      '3 sharedspare ci-iad-4, not counted',
      '41 machines82 vCPU',
      '13%',
    ]);
    const toggle = ci.querySelector('button')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe('pool-ci_runner-accounts');
    const accounts = card.querySelector('#pool-ci_runner-accounts')!;
    expect(accounts.hasAttribute('hidden')).toBe(true);

    const none = card.querySelector('tr[data-shard-pool="hosted_agent"]')!;
    expect(none.getAttribute('data-state')).toBe('no-account');
    expect(cells(none)).toEqual([
      'Agent runner',
      f.shard.noAccount,
      'No add-shard run for this kind yet. Its first account is added with fleet-admin add-shard.',
      'None running',
      '—Not applicable',
    ]);

    const full = card.querySelector('tr[data-shard-pool="code_graph_index"]')!;
    expect(full.querySelector('[data-rail="warning"]')).not.toBeNull();
    expect(text(full.querySelector('[data-flag="atSize"]'))).toBe(f.shard.atSize);
    expect(cells(full)[2]).toBe('1 sharedno Motir spare yet');
    const near = card.querySelector('tr[data-shard-pool="agent_instance"]')!;
    expect(text(near.querySelector('[data-flag="near"]'))).toBe(f.shard.near);
    expect(cells(near)[4]).toContain('79%');
    expect(text(card)).toContain(
      'Read-only. To ask AWS for more quota, run fleet-admin request-quota --account <name> --vcpu <n> at a terminal; an account’s ceiling override stays on its existing door.',
    );
  });

  it('lists the accounts: name, role, state, size and its source, running, pause (Panel 8)', async () => {
    const root = await shardCard(block([awsPool()]));
    const table = root.querySelector('#pool-ci_runner-accounts')!;
    expect(text(table.querySelector('h4'))).toBe('CI runner · accounts');
    expect(text(table)).toContain('5 accounts');
    expect([...table.querySelectorAll('thead th')].map(text)).toEqual([
      'Account',
      'Role',
      'State',
      'Size',
      'Running',
      'Paused until',
    ]);
    const row = (name: string) => cells(table.querySelector(`tr[data-account="${name}"]`)!);
    expect(row('ci-iad-1')).toEqual([
      'ci-iad-1',
      'Shared',
      'Active',
      '128 machinesfrom 256 vCPU granted',
      '22 · 44 vCPU',
      'Not paused',
    ]);
    expect(row('ci-iad-2')).toEqual([
      'ci-iad-2',
      'Shared',
      'Active',
      '64 machinesset by a platform admin',
      '13 · 26 vCPU',
      'Paused · capacity refuseduntil 12:48 PM, in 48 min',
    ]);
    const paused = table.querySelector('tr[data-account="ci-iad-2"] td')!;
    expect(paused.className).toContain('border-l');
    expect(row('ci-iad-3')).toEqual([
      'ci-iad-3',
      'Shared',
      'Provisioning',
      'Not readnever read',
      '0 · 0 vCPU',
      'Paused · unreachableuntil Nov 12, 02:00 PM, in 1 d 2 h',
    ]);
    expect(row('ci-iad-4')).toEqual([
      'ci-iad-4',
      'Spare',
      'Disabled',
      '128 machinesthe spare, not counted',
      '0 · 0 vCPU',
      'Not paused',
    ]);
    expect(row('ci-iad-5').slice(2, 4)).toEqual(['odd', 'Not readlast read 3 d ago']);
    expect(
      table
        .querySelector('tr[data-account="ci-iad-3"] [data-mark="not-read"] [aria-label]')
        ?.getAttribute('aria-label'),
    ).toBe(mon.notReadLabel);
  });

  it('an account sized by its machine limit says so, never a granted vCPU of 0', async () => {
    const root = await shardCard(
      block([
        awsPool({
          accounts: [
            acct({ name: 'ci-limit', sizeMachines: 40, sizeSource: 'machineLimit' }),
            acct({
              name: 'ci-limit-only',
              sizeMachines: 12,
              sizeSource: 'machineLimit',
              grantedVcpu: null,
            }),
          ],
        }),
      ]),
    );
    const table = root.querySelector('#pool-ci_runner-accounts')!;
    const size = (name: string) => cells(table.querySelector(`tr[data-account="${name}"]`)!)[3];
    expect(size('ci-limit')).toBe('40 machinesfrom its machine limit');
    expect(size('ci-limit-only')).toBe('12 machinesfrom its machine limit');
  });

  it('a pool whose size is unknown reads Not available with how many are not read (Panel 9)', async () => {
    const root = await shardCard(
      block([awsPool({ sizeMachines: null, notReadCount: 1, percent: null, flag: null })]),
    );
    const ci = root.querySelector('tr[data-shard-pool="ci_runner"]')!;
    expect(cells(ci)[1]).toBe('Not available1 account’s quota is not read');
    expect(cells(ci)[4]).toBe('Not available');
    expect(root.querySelector('[data-flag="near-size"]')).toBeNull();

    const zero = await shardCard(
      block([awsPool({ sizeMachines: null, notReadCount: 0, percent: null })]),
    );
    expect(cells(zero.querySelector('tr[data-shard-pool="ci_runner"]')!)[1]).toBe('Not available');
  });

  it('a Fly kind and a pool whose read failed say so, and the rest renders', async () => {
    const root = await shardCard(
      block([
        { fleetKind: 'ci_runner', provider: 'fly' },
        { fleetKind: 'hosted_agent', provider: 'unavailable' },
        awsPool({ fleetKind: 'code_graph_index' }),
      ]),
    );
    const fly = root.querySelector('tr[data-shard-pool="ci_runner"]')!;
    expect(cells(fly)).toEqual([
      'CI runner',
      mon.provider.fly,
      f.shard.fly,
      '—Not applicable',
      '—Not applicable',
    ]);
    const failed = root.querySelector('tr[data-shard-pool="hosted_agent"]')!;
    expect(failed.querySelector('[role="alert"]')).not.toBeNull();
    expect(text(failed)).toContain('Couldn’t read the Agent runner pool');
    expect(root.querySelector('tr[data-shard-pool="code_graph_index"] button')).not.toBeNull();
  });

  it('is the block error when the pools read did not answer', async () => {
    const root = await shardCard({ status: 'unavailable' });
    const card = root.querySelector('[data-pool="add-shard"]')!;
    expect(card.getAttribute('data-state')).toBe('failed');
    expect(text(card)).toContain(mon.sectionError.title);
    expect(card.querySelector('table')).toBeNull();
  });
});

describe('PoolDisclosure', () => {
  it('shows and hides the account row it controls, and owns nothing else', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const table = document.createElement('table');
    host.appendChild(table);
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    const root = createRoot(tbody);
    await act(async () => {
      root.render(
        <PoolDisclosure
          kind="ci_runner"
          label="CI runner"
          controlsId="pool-ci_runner-accounts"
          rail={false}
          colSpan={5}
          cells={<td>320 machines</td>}
          accounts={<p>the accounts</p>}
        />,
      );
    });
    const button = tbody.querySelector('button')!;
    const row = tbody.querySelector<HTMLElement>('#pool-ci_runner-accounts')!;
    expect(tbody.querySelector('[data-rail]')).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(row.hidden).toBe(true);
    expect(row.querySelector('td')?.getAttribute('colspan')).toBe('5');

    await act(async () => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(row.hidden).toBe(false);
    expect(tbody.querySelector('tr')?.getAttribute('data-expanded')).toBe('true');
    expect(text(row)).toBe('the accounts');

    await act(async () => button.click());
    expect(row.hidden).toBe(true);
    root.unmount();
  });
});
