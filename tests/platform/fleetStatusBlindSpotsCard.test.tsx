// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToHtml } from '../helpers/serverPageHarness';
import en from '@/messages/en.json';
import type { CiFleetBlindSpotOrgDTO, CiFleetBlindSpotsDTO } from '@/lib/dto/ciFleetBlindSpots';

// THE FLEET STATUS PAGE'S CI FLEET BLIND SPOTS CARD (MOTIR-11439; design
// MOTIR-11467 Panels 1–7). Rendered to HTML through Fizz over the REAL `en`
// catalogue, one case per state the delta mock draws: some blind spots, no blind
// spots and no orgs, one org not read, the read failed, the reconcile failed, not
// computed, not configured, and many repos. The loading skeleton is the page's
// own and is covered by `fleetStatusPage.test.tsx`.

vi.mock('next-intl/server', async () => {
  const { createTranslator, createFormatter } = await import('next-intl');
  const messages = (await import('@/messages/en.json')).default;
  return {
    getTranslations: async (namespace: string) =>
      createTranslator({ locale: 'en', messages, namespace } as never),
    getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
  };
});

const { BlindSpotsCard } =
  await import('@/app/(admin)/admin/fleet-status/_components/BlindSpotsCard');

const NOW = new Date('2026-11-16T19:50:00.000Z');
const TICK = '2026-11-16T19:45:00.000Z';
const b = en.platformAdmin.fleetStatus.blindSpots;

const text = (el: Element | null | undefined) =>
  (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

function org(name: string, over: Partial<CiFleetBlindSpotOrgDTO> = {}): CiFleetBlindSpotOrgDTO {
  return { org: name, undeliveredRepos: [], unreadableRepos: [], error: null, ...over };
}

async function card(block: CiFleetBlindSpotsDTO) {
  document.body.innerHTML = await renderToHtml(await BlindSpotsCard({ block, now: NOW }));
  return document.body.querySelector<HTMLElement>('[data-element="blind-spots"]')!;
}
const row = (root: Element, login: string) =>
  root.querySelector<HTMLElement>(`li[data-org="${login}"]`)!;
const flags = (el: Element) =>
  [...el.querySelectorAll(':scope > div:first-child [data-flag]')].map((p) => [
    p.getAttribute('data-flag'),
    text(p),
  ]);
const headerFlags = (root: Element) =>
  [...root.querySelectorAll('[data-flag]')]
    .filter((p) => !p.closest('li'))
    .map((p) => [p.getAttribute('data-flag'), text(p)]);
const computedLine =
  'Computed by the provision sweep of Nov 16, 2026, 7:45 PM (5 min ago). Read-only: motir-studio is installed on a repo in GitHub, not here.';

beforeAll(async () => {
  await card({ status: 'notComputed' });
}, 120_000);

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the blind-spots card', () => {
  it('some blind spots: per org its repos, pills and rail, in the outcome’s order (Panel 1)', async () => {
    const root = await card({
      status: 'ok',
      computedAt: TICK,
      orgs: [
        org('acme-labs', { undeliveredRepos: ['acme-labs/billing-api', 'acme-labs/web'] }),
        org('motir-co', {
          undeliveredRepos: ['motir-co/motir-codegraph'],
          unreadableRepos: ['motir-co/motir-infra'],
        }),
        org('northwind-data', { unreadableRepos: ['northwind-data/etl-jobs'] }),
        org('fernwood-io'),
      ],
    });
    expect(root.getAttribute('data-state')).toBe('read');
    expect(text(root.querySelector('h3'))).toBe(b.card.title);
    expect(text(root)).toContain(b.card.subtitle);
    expect(headerFlags(root)).toEqual([['orgs-blind', '3 organisations with blind spots']]);
    expect(
      [...root.querySelectorAll('li[data-org]')].map((li) => li.getAttribute('data-org')),
    ).toEqual(['acme-labs', 'motir-co', 'northwind-data', 'fernwood-io']);

    const acme = row(root, 'acme-labs');
    expect(acme.getAttribute('data-state')).toBe('blind');
    expect(acme.className).toContain('border-l-(--el-warning)');
    expect(text(acme.querySelector('h4'))).toBe('acme-labs');
    expect(flags(acme)).toEqual([['undelivered', '2 repos with no deliveries']]);
    const undelivered = acme.querySelector('[data-element="undelivered"]')!;
    expect(text(undelivered.querySelector('h5'))).toBe(b.undelivered.title);
    const links = [...undelivered.querySelectorAll('a')];
    expect(links.map((a) => [a.getAttribute('href'), a.getAttribute('aria-label')])).toEqual([
      ['https://github.com/acme-labs/billing-api', 'acme-labs/billing-api on GitHub'],
      ['https://github.com/acme-labs/web', 'acme-labs/web on GitHub'],
    ]);
    // The design's copy, under every undelivered repo.
    expect(text(undelivered)).toContain(
      'motir-runner jobs but no workflow_job deliveries — is motir-studio installed on this repo?',
    );
    expect(undelivered.querySelector('ul')!.className).not.toContain('sm:grid-cols-2');
    expect(acme.querySelector('[data-element="unreadable"]')).toBeNull();

    const motir = row(root, 'motir-co');
    expect(flags(motir)).toEqual([
      ['undelivered', '1 repo with no deliveries'],
      ['unreadable', '1 repo unreadable'],
    ]);
    const unreadable = motir.querySelector('[data-element="unreadable"]')!;
    expect(text(unreadable.querySelector('h5'))).toBe(b.unreadable.title);
    expect(text(unreadable)).toContain(b.unreadable.body);
    expect(unreadable.querySelector('a')!.getAttribute('href')).toBe(
      'https://github.com/motir-co/motir-infra',
    );

    expect(row(root, 'northwind-data').querySelector('[data-element="undelivered"]')).toBeNull();

    const fernwood = row(root, 'fernwood-io');
    expect(fernwood.getAttribute('data-state')).toBe('seen');
    expect(fernwood.className).toContain('border-l-transparent');
    expect(flags(fernwood)).toEqual([['seen', b.pill.allSeen]]);
    expect(text(fernwood)).toContain(b.org.seen);

    expect(text(root.querySelector('[data-element="computed"]'))).toBe(computedLine);
    expect(root.querySelector('[role="alert"]')).toBeNull();
  });

  it('no blind spots: the empty state with the org count, the pill and the time (Panel 2)', async () => {
    const root = await card({
      status: 'ok',
      computedAt: TICK,
      orgs: [org('acme-labs'), org('fernwood-io'), org('motir-co')],
    });
    expect(root.getAttribute('data-state')).toBe('read');
    expect(root.querySelector('li[data-org]')).toBeNull();
    expect(text(root.querySelector('h4'))).toBe(b.empty.title);
    expect(text(root)).toContain(
      'The CI fleet sees every repo of the 3 organisations it served in the last 3 days',
    );
    expect(headerFlags(root)).toEqual([['all-seen', b.pill.allSeen]]);
    expect(text(root.querySelector('[data-element="computed"]'))).toBe(computedLine);
  });

  it('no org in the lookback: the same state with the no-orgs sentence (Panel 2)', async () => {
    const root = await card({ status: 'ok', computedAt: TICK, orgs: [] });
    expect(text(root.querySelector('h4'))).toBe(b.empty.title);
    expect(text(root)).toContain(b.empty.noOrgs);
    expect(root.querySelector('[data-element="computed"]')).not.toBeNull();
  });

  it('one org not read: its 401 verbatim on a danger rail, the others render (Panel 3)', async () => {
    const error = 'HttpError: Bad credentials - https://docs.github.com/rest (401)';
    const root = await card({
      status: 'ok',
      computedAt: TICK,
      orgs: [
        org('northwind-data', { error }),
        org('motir-co', { undeliveredRepos: ['motir-co/motir-codegraph'] }),
        org('acme-labs'),
      ],
    });
    expect(headerFlags(root)).toEqual([
      ['orgs-not-read', '1 organisation not read'],
      ['orgs-blind', '1 organisation with blind spots'],
    ]);
    const failed = row(root, 'northwind-data');
    expect(failed.getAttribute('data-state')).toBe('failed');
    expect(failed.className).toContain('border-l-(--el-danger)');
    expect(flags(failed)).toEqual([['not-read', b.pill.notRead]]);
    const alert = failed.querySelector('[role="alert"][data-element="org-error"]')!;
    expect(text(alert)).toContain(b.orgError.title);
    expect(text(alert)).toContain(b.orgError.body);
    expect(text(alert.querySelector('pre'))).toBe(error);
    // A failed org never reads as seen.
    expect(text(failed)).not.toContain(b.pill.allSeen);
    expect(row(root, 'motir-co').getAttribute('data-state')).toBe('blind');
    expect(row(root, 'acme-labs').getAttribute('data-state')).toBe('seen');
  });

  it('every org not read: no Every repo seen anywhere', async () => {
    const root = await card({
      status: 'ok',
      computedAt: TICK,
      orgs: [org('a-org', { error: 'boom' }), org('b-org', { error: 'boom' })],
    });
    expect(headerFlags(root)).toEqual([['orgs-not-read', '2 organisations not read']]);
    expect(text(root)).not.toContain(b.pill.allSeen);
    expect(text(root)).not.toContain(b.empty.title);
  });

  it('the read failed: the error state, no pill and no time (Panel 4)', async () => {
    const root = await card({ status: 'unavailable' });
    expect(root.getAttribute('data-state')).toBe('failed');
    const alert = root.querySelector('[role="alert"]')!;
    expect(text(alert.querySelector('h4'))).toBe(b.error.title);
    expect(text(alert)).toContain(b.error.body);
    expect(root.querySelector('[data-flag]')).toBeNull();
    expect(root.querySelector('[data-element="computed"]')).toBeNull();
  });

  it('the reconcile failed: the error verbatim and the sweep’s time (Panel 4)', async () => {
    const root = await card({
      status: 'reconcileFailed',
      error: 'PrismaClientKnownRequestError: Timed out fetching a new connection (P2024)',
      computedAt: TICK,
    });
    expect(root.getAttribute('data-state')).toBe('reconcile-failed');
    expect(text(root.querySelector('[role="alert"] h4'))).toBe(b.reconcileError.title);
    expect(text(root.querySelector('pre'))).toBe(
      'PrismaClientKnownRequestError: Timed out fetching a new connection (P2024)',
    );
    expect(root.querySelector('[data-flag]')).toBeNull();
    expect(text(root.querySelector('[data-element="computed"]'))).toBe(computedLine);
  });

  it('not computed yet (Panel 5)', async () => {
    const root = await card({ status: 'notComputed' });
    expect(root.getAttribute('data-state')).toBe('not-computed');
    expect(text(root.querySelector('h4'))).toBe(b.notComputed.title);
    expect(text(root)).toContain(b.notComputed.body);
    expect(root.querySelector('[role="alert"], [data-flag], [data-element="computed"]')).toBeNull();
  });

  it('not configured, with the way to Fleet settings (Panel 5)', async () => {
    const root = await card({ status: 'notConfigured' });
    expect(root.getAttribute('data-state')).toBe('not-configured');
    expect(text(root.querySelector('h4'))).toBe(b.notConfigured.title);
    const link = root.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('/admin/fleet-settings');
    expect(text(link)).toBe('Fleet settings');
    expect(text(root)).toContain('has the switch.');
    expect(root.querySelector('[data-flag], [data-element="computed"]')).toBeNull();
  });

  it('many repos: every repo listed, two columns from sm (Panel 7)', async () => {
    const undelivered = Array.from({ length: 14 }, (_, i) => `globex-platform/svc-${i + 1}`);
    const unreadable = Array.from({ length: 9 }, (_, i) => `globex-platform/lib-${i + 1}`);
    const root = await card({
      status: 'ok',
      computedAt: TICK,
      orgs: [
        org('globex-platform', { undeliveredRepos: undelivered, unreadableRepos: unreadable }),
        org('motir-co', { unreadableRepos: ['motir-co/motir-infra'] }),
      ],
    });
    const globex = row(root, 'globex-platform');
    expect(flags(globex)).toEqual([
      ['undelivered', '14 repos with no deliveries'],
      ['unreadable', '9 repos unreadable'],
    ]);
    expect(globex.querySelectorAll('a')).toHaveLength(23);
    for (const list of globex.querySelectorAll('ul')) {
      expect(list.className).toContain('sm:grid-cols-2');
    }
    expect(row(root, 'motir-co').querySelector('ul')!.className).not.toContain('sm:grid-cols-2');
  });
});
