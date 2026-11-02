// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl, enMessages } from '../helpers/renderWithIntl';
import {
  CustomDomainsPane,
  refusalOf,
} from '@/app/(authed)/settings/workspace/custom-domains/_components/CustomDomainsPane';
import type { DomainApplicationDto, PublicAddressDto } from '@/lib/dto/publicAddresses';

// THE CUSTOM DOMAINS PANE (Story MOTIR-4533 · MOTIR-9529) — design
// `design/workspace-address/custom-domains.mock.html` panels 1–12.
//
// ⚠️ THE STATE TABLE IS DRIVEN FROM THE ENUM, NOT FROM A LIST WRITTEN HERE. A
// test that enumerated the statuses it happened to remember would go green on
// the day a tenth arrived, which is the failure the total `Record` in the
// component exists to prevent — so the fixture set is derived and its size is
// asserted.

const refreshMock = vi.fn();
vi.mock('next/navigation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/navigation')>();
  return { ...actual, useRouter: () => ({ refresh: refreshMock, push: vi.fn() }) };
});

const toastMock = vi.fn();
vi.mock('@/components/ui/Toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/Toast')>();
  return { ...actual, useToast: () => ({ toast: toastMock }) };
});

const copy = enMessages.settings.customDomains;

/** Every status the STORE can hold — the `PublicAddressDto` union, exhaustively. */
const ALL_STATUSES = [
  'active',
  'alias',
  'unverified',
  'verifying',
  'pending_certificate',
  'issued',
  'failed',
  'expired',
  'revoked',
] as const satisfies readonly PublicAddressDto['status'][];

/** The seven that belong to a CUSTOMER DOMAIN; the other two are the subdomain's. */
const DOMAIN_STATUSES = ALL_STATUSES.filter((s) => s !== 'active' && s !== 'alias');

/** The pill each status reads as (design: four pills). */
const PILL: Record<(typeof DOMAIN_STATUSES)[number], string> = {
  unverified: copy.status.unverified,
  verifying: copy.status.pending,
  pending_certificate: copy.status.pending,
  issued: copy.status.issued,
  failed: copy.status.failed,
  expired: copy.status.failed,
  revoked: copy.status.failed,
};

const TXT = {
  type: 'TXT' as const,
  name: '_motir-verify.shop.acme.com',
  value: 'motir-verify=abc123',
};
const CNAME = { type: 'CNAME' as const, name: 'shop.acme.com', value: 'motir-edge.fly.dev' };

function domain(over: Partial<PublicAddressDto> = {}): PublicAddressDto {
  return {
    id: 'addr_1',
    kind: 'custom_domain',
    hostname: 'shop.acme.com',
    status: 'issued',
    applicationId: null,
    verification: { name: TXT.name, value: TXT.value },
    dns: [TXT, CNAME],
    lastCheckedAt: '2026-10-30T09:00:00.000Z',
    issuedAt: null,
    failureReason: null,
    failureKind: null,
    certificateExpiresAt: null,
    ...over,
  };
}

const SHOP: DomainApplicationDto = { id: 'app_shop', name: 'Shop', slug: 'shop' };
const DOCS: DomainApplicationDto = { id: 'app_docs', name: 'Docs', slug: 'docs' };

function render(
  addresses: PublicAddressDto[],
  over: {
    canManage?: boolean;
    maxDomains?: number | null;
    loadFailed?: boolean;
    applications?: DomainApplicationDto[];
  } = {},
) {
  return renderWithIntl(
    <CustomDomainsPane
      workspaceId="ws_1"
      baseDomain="motir.site"
      workspaceHost="acme.motir.site"
      addresses={addresses}
      applications={over.applications ?? []}
      canManage={over.canManage ?? true}
      maxDomains={over.maxDomains === undefined ? null : over.maxDomains}
      loadFailed={over.loadFailed ?? false}
    />,
  );
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  refreshMock.mockReset();
  toastMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the state set, total over the enum', () => {
  it('the enum has NINE values and exactly two of them are the subdomain’s', () => {
    expect(ALL_STATUSES).toHaveLength(9);
    expect(DOMAIN_STATUSES).toHaveLength(7);
  });

  it.each(DOMAIN_STATUSES)('%s reads as its pill, by text', (status) => {
    render([domain({ status })]);
    const row = document.querySelector(`[data-status="${status}"]`) as HTMLElement;
    expect(row, `no row rendered for ${status}`).toBeTruthy();
    expect(row.textContent).toContain(PILL[status]);
    // Every domain state can be removed by a manager.
    expect(within(row).getByRole('button', { name: copy.action.remove })).toBeTruthy();
  });

  it('NEVER lists the two subdomain states', () => {
    render([domain({ status: 'active' }), domain({ id: 'a2', status: 'alias' })]);
    expect(screen.getByText(copy.empty.title)).toBeTruthy();
  });
});

describe('no primary (ADR MOTIR-9521 §1)', () => {
  it('offers no primary control on any row, and the catalogue names none', () => {
    for (const status of DOMAIN_STATUSES) {
      const { unmount } = render([domain({ status })]);
      expect(screen.queryByRole('button', { name: /primary/i }), status).toBeNull();
      unmount();
    }
    expect(JSON.stringify(copy)).not.toMatch(/primary|redirect/i);
  });
});

describe('the DNS records panel', () => {
  it('an unverified row shows the pointing record then the TXT, each with Copy, and Check now', () => {
    render([domain({ status: 'unverified' })]);
    const cells = screen.getAllByRole('cell').map((c) => c.textContent);
    expect(cells.indexOf('CNAME')).toBeLessThan(cells.indexOf('TXT'));
    expect(screen.getByText(TXT.value)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: copy.action.copy })).toHaveLength(2);
    expect(screen.getByRole('button', { name: copy.action.checkNow })).toBeTruthy();
  });

  it('Copy announces Copied', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render([domain({ status: 'unverified' })]);
    fireEvent.click(screen.getAllByRole('button', { name: copy.action.copy })[1]!);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: copy.action.copied })).toBeTruthy(),
    );
    expect(writeText).toHaveBeenCalledWith(TXT.value);
  });

  it('an apex shows A and AAAA, and explains why only then', () => {
    render([
      domain({
        status: 'unverified',
        hostname: 'acme.com',
        dns: [
          TXT,
          { type: 'A', name: 'acme.com', value: '66.241.125.217' },
          { type: 'AAAA', name: 'acme.com', value: '2a09:8280:1::1' },
        ],
      }),
    ]);
    expect(screen.getByText('A')).toBeTruthy();
    expect(screen.getByText('AAAA')).toBeTruthy();
    expect(screen.getByText(copy.records.apexNote)).toBeTruthy();

    cleanup();
    render([domain({ status: 'unverified' })]);
    expect(screen.queryByText(copy.records.apexNote)).toBeNull();
  });

  it('an issued row is a link with the Application line, its records behind Show DNS records', () => {
    render([domain({ status: 'issued' })]);
    expect(screen.getByRole('link', { name: 'shop.acme.com' })).toHaveProperty(
      'href',
      'https://shop.acme.com/',
    );
    expect(screen.getByText(copy.app.none)).toBeTruthy();
    expect(screen.queryByText(TXT.value)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: copy.action.showDns }));
    expect(screen.getByText(TXT.value)).toBeTruthy();

    cleanup();
    render([domain({ status: 'issued', applicationId: SHOP.id })], { applications: [SHOP] });
    expect(document.querySelector('[data-application="bound"]')?.textContent).toBe(
      'Serves Shop shop.',
    );
  });
});

describe('the application a domain serves (delta panels A–F)', () => {
  it('an id the workspace no longer lists says so, and never reads as unbound', () => {
    render([domain({ status: 'issued', applicationId: 'app_gone' })], { applications: [SHOP] });
    expect(screen.getByText(copy.app.gone)).toBeTruthy();
    expect(screen.queryByText(copy.app.none)).toBeNull();
  });

  it('the certificate line carries the platform’s expiry, and drops the clause without one', () => {
    render([domain({ status: 'issued', certificateExpiresAt: '2027-01-28T00:00:00.000Z' })]);
    expect(screen.getByText(/valid until .*2027/)).toBeTruthy();
    cleanup();
    render([domain({ status: 'issued' })]);
    expect(screen.getByText(copy.cert)).toBeTruthy();
  });

  it('an apex note names the edge’s own addresses, never a shared one', () => {
    expect(copy.records.apexNote).toContain('own addresses');
    expect(copy.records.apexNote).not.toMatch(/shared/i);
  });

  it('the control names its domain, and Save waits for a different choice', () => {
    render([domain({ status: 'issued', applicationId: SHOP.id })], {
      applications: [SHOP, DOCS],
    });
    fireEvent.click(screen.getByRole('button', { name: `${copy.app.change} for shop.acme.com` }));
    const dialog = screen.getByRole('dialog', { name: 'Application for shop.acme.com' });
    const save = within(dialog).getByRole('button', { name: copy.app.save }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('combobox', { name: copy.dialog.appLabel }));
    fireEvent.click(screen.getByRole('option', { name: /Docs/ }));
    expect(save.disabled).toBe(false);
    expect(dialog.textContent).toContain('shop.acme.com serves Docs as soon as you save.');
  });

  it('PATCHes the re-point and the row names the new application', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => domain({ status: 'issued', applicationId: DOCS.id }),
    });
    render([domain({ status: 'issued', applicationId: SHOP.id })], {
      applications: [SHOP, DOCS],
    });
    fireEvent.click(screen.getByRole('button', { name: `${copy.app.change} for shop.acme.com` }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('combobox', { name: copy.dialog.appLabel }));
    fireEvent.click(screen.getByRole('option', { name: /Docs/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: copy.app.save }));

    await waitFor(() =>
      expect(document.querySelector('[data-application="bound"]')?.textContent).toBe(
        'Serves Docs docs.',
      ),
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/workspaces/ws_1/custom-domains/addr_1');
    expect(fetchMock.mock.calls[0]?.[1].method).toBe('PATCH');
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body as string)).toEqual({
      applicationId: DOCS.id,
    });
  });

  it('unbinding says what stops, and a failed save leaves the row as it was with Retry', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    render([domain({ status: 'issued', applicationId: SHOP.id })], { applications: [SHOP] });
    fireEvent.click(screen.getByRole('button', { name: `${copy.app.change} for shop.acme.com` }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('combobox', { name: copy.dialog.appLabel }));
    fireEvent.click(screen.getByRole('option', { name: copy.dialog.appNone }));
    expect(dialog.textContent).toContain('shop.acme.com stops serving Shop as soon as you save');
    fireEvent.click(within(dialog).getByRole('button', { name: copy.app.save }));

    await waitFor(() => expect(screen.getByText(copy.app.error)).toBeTruthy());
    expect(within(dialog).getByRole('button', { name: copy.action.retry })).toBeTruthy();
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body as string)).toEqual({
      applicationId: null,
    });
    expect(document.querySelector('[data-application="bound"]')?.textContent).toBe(
      'Serves Shop shop.',
    );
  });

  it('two applications with one name are told apart by their slug in the option’s name', () => {
    const blog: DomainApplicationDto = { id: 'app_blog', name: 'Shop', slug: 'blog' };
    render([domain({ status: 'issued', applicationId: SHOP.id })], {
      applications: [SHOP, blog],
    });
    fireEvent.click(screen.getByRole('button', { name: `${copy.app.change} for shop.acme.com` }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('combobox', { name: copy.dialog.appLabel }),
    );
    expect(screen.getByRole('option', { name: 'Shop (shop)' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Shop (blog)' })).toBeTruthy();
  });

  it('an unbound row offers Choose application', () => {
    render([domain({ status: 'issued' })], { applications: [SHOP] });
    expect(
      screen.getByRole('button', { name: `${copy.app.choose} for shop.acme.com` }),
    ).toBeTruthy();
  });
});

describe('the failure banner, by failureKind', () => {
  it('txt_lost names the TXT to restore, with Re-check', () => {
    render([domain({ status: 'failed', failureKind: 'txt_lost', failureReason: 'gone' })]);
    const banner = document.querySelector('[data-failure="txt_lost"]') as HTMLElement;
    expect(banner.textContent).toContain(copy.fail.txt);
    expect(banner.textContent).toContain(TXT.value);
    expect(within(banner).getByRole('button', { name: copy.action.recheck })).toBeTruthy();
  });

  it('pointing_lost names the record and its expected value, with Re-check', () => {
    render([
      domain({
        status: 'failed',
        failureKind: 'pointing_lost',
        failureReason: 'The CNAME for shop.acme.com no longer points at Motir.',
      }),
    ]);
    const banner = document.querySelector('[data-failure="pointing_lost"]') as HTMLElement;
    expect(banner.textContent).toContain('shop.acme.com no longer points at Motir');
    expect(banner.textContent).toContain(CNAME.value);
    expect(banner.textContent).not.toContain(TXT.value);
    expect(within(banner).getByRole('button', { name: copy.action.recheck })).toBeTruthy();
  });

  it('a null kind is an issuance failure: the reason verbatim, Retry and Remove', () => {
    render([domain({ status: 'failed', failureReason: 'CAA record forbids issuance' })]);
    const banner = document.querySelector('[data-failure="issuance"]') as HTMLElement;
    expect(banner.textContent).toContain(copy.fail.issuance);
    expect(banner.textContent).toContain('CAA record forbids issuance');
    expect(within(banner).getByRole('button', { name: copy.action.retry })).toBeTruthy();
    expect(within(banner).getByRole('button', { name: copy.action.remove })).toBeTruthy();
  });

  it('Re-check shows Checking… in flight and the row updates from the response', async () => {
    let answer: (v: unknown) => void = () => {};
    fetchMock.mockReturnValue(new Promise((r) => (answer = r)));
    render([domain({ status: 'failed', failureKind: 'txt_lost', failureReason: 'gone' })]);
    fireEvent.click(screen.getByRole('button', { name: copy.action.recheck }));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/workspaces/ws_1/custom-domains/addr_1/verify');
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: copy.action.checking }) as HTMLButtonElement).disabled,
      ).toBe(true),
    );
    answer({ ok: true, json: async () => domain({ status: 'issued' }) });
    await waitFor(() => expect(document.querySelector('[data-status="issued"]')).toBeTruthy());
    expect(refreshMock).toHaveBeenCalled();
  });
});

describe('adding a domain', () => {
  it('POSTs the hostname and shows the new row as Unverified', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => domain({ status: 'unverified' }),
    });
    render([]);
    fireEvent.click(screen.getByRole('button', { name: copy.add }));
    fireEvent.change(screen.getByLabelText(copy.dialog.label), {
      target: { value: 'shop.acme.com' },
    });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: copy.add }));

    await waitFor(() => expect(document.querySelector('[data-status="unverified"]')).toBeTruthy());
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/workspaces/ws_1/custom-domains');
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body as string)).toEqual({
      hostname: 'shop.acme.com',
      applicationId: null,
    });
  });

  it('with no application the picker is absent and its line stands in', () => {
    render([]);
    fireEvent.click(screen.getByRole('button', { name: copy.add }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(copy.dialog.noApps)).toBeTruthy();
    expect(within(dialog).queryByRole('combobox')).toBeNull();
  });

  it('one application is preselected and sent as applicationId', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => domain({ status: 'unverified', applicationId: SHOP.id }),
    });
    render([], { applications: [SHOP] });
    fireEvent.click(screen.getByRole('button', { name: copy.add }));
    fireEvent.change(screen.getByLabelText(copy.dialog.label), {
      target: { value: 'shop.acme.com' },
    });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: copy.add }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body as string)).toEqual({
      hostname: 'shop.acme.com',
      applicationId: SHOP.id,
    });
  });

  it('several applications: nothing is preselected and Add waits for a choice', () => {
    render([], { applications: [SHOP, DOCS] });
    fireEvent.click(screen.getByRole('button', { name: copy.add }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(screen.getByLabelText(copy.dialog.label), {
      target: { value: 'shop.acme.com' },
    });
    const add = within(dialog).getByRole('button', { name: copy.add }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('combobox', { name: copy.dialog.appLabel }));
    fireEvent.click(screen.getByRole('option', { name: copy.dialog.appNone }));
    expect(add.disabled).toBe(false);
  });

  it.each([
    [422, { code: 'NOT_A_CUSTOMER_DOMAIN', reason: 'tenant_base' }, 'is a Motir address'],
    [422, { code: 'NOT_A_CUSTOMER_DOMAIN', reason: 'site_origin' }, 'belongs to Motir'],
    [422, { code: 'INVALID_HOSTNAME' }, 'Enter only the domain'],
    [409, { code: 'HOSTNAME_TAKEN' }, 'already connected to another Motir workspace'],
    [
      402,
      { code: 'ENTITLEMENT_EXCEEDED', entitlement: 'custom_domains', detail: { limit: 5 } },
      'all 5 are in use',
    ],
  ])(
    'a %s %j refusal shows its own sentence and keeps the dialog open',
    async (status, body, text) => {
      fetchMock.mockResolvedValue({ ok: false, status, json: async () => body });
      render([]);
      fireEvent.click(screen.getByRole('button', { name: copy.add }));
      fireEvent.change(screen.getByLabelText(copy.dialog.label), {
        target: { value: 'shop.acme.com' },
      });
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: copy.add }));
      await waitFor(() => expect(screen.getByText(new RegExp(text))).toBeTruthy());
      expect(screen.getByRole('dialog')).toBeTruthy();
    },
  );

  it('refusalOf reads the typed codes, never the prose', () => {
    expect(refusalOf(500, {}, 'x')).toEqual({ kind: 'other' });
    expect(refusalOf(409, { code: 'HOSTNAME_TAKEN', error: 'whatever' }, 'x')).toEqual({
      kind: 'taken',
      host: 'x',
    });
  });
});

describe('the tier', () => {
  it('not on the plan: the upsell replaces Add', () => {
    render([], { maxDomains: 0 });
    expect(screen.getByText(copy.upsell.title)).toBeTruthy();
    expect(screen.getByText(/acme\.motir\.site/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: copy.add })).toBeNull();
  });

  it('at the cap: Add is disabled with the N of M count', () => {
    render([domain({ id: 'a1' }), domain({ id: 'a2', hostname: 'b.acme.com' })], {
      maxDomains: 2,
    });
    expect((screen.getByRole('button', { name: copy.add }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText('2 of 2 domains')).toBeTruthy();
  });

  it('below the cap or uncapped: Add is enabled', () => {
    render([domain()], { maxDomains: 5 });
    expect((screen.getByRole('button', { name: copy.add }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

describe('liveness — the states this pane does not write', () => {
  it('re-reads on the tick while a row is pending', () => {
    vi.useFakeTimers();
    render([domain({ status: 'pending_certificate' })]);
    expect(screen.getByText(copy.pending)).toBeTruthy();
    expect(refreshMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('and STOPS once nothing is pending', () => {
    vi.useFakeTimers();
    render([domain({ status: 'issued' })]);
    vi.advanceTimersByTime(120_000);
    expect(refreshMock).not.toHaveBeenCalled();
  });
});

describe('removing a domain', () => {
  it('says it stops at once, nothing is reserved, and the DNS records are the customer’s', () => {
    render([domain({ status: 'issued' })]);
    fireEvent.click(screen.getByRole('button', { name: copy.action.remove }));
    expect(screen.getByText('Remove shop.acme.com?')).toBeTruthy();
    expect(screen.getByText(copy.remove.body)).toBeTruthy();
  });

  it('DELETEs on the workspace route, drops the row and confirms with a toast', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204, json: async () => ({}) });
    render([domain({ status: 'issued' })]);
    fireEvent.click(screen.getByRole('button', { name: copy.action.remove }));
    fireEvent.click(screen.getByRole('button', { name: copy.remove.confirm }));

    await waitFor(() => expect(document.querySelector('[data-status="issued"]')).toBeNull());
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/workspaces/ws_1/custom-domains/addr_1');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'DELETE' });
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ variant: 'success' }));
  });

  it('a failed delete shows the error, offers Retry and leaves the row', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    render([domain({ status: 'issued' })]);
    fireEvent.click(screen.getByRole('button', { name: copy.action.remove }));
    fireEvent.click(screen.getByRole('button', { name: copy.remove.confirm }));

    await waitFor(() => expect(screen.getByText(copy.remove.error)).toBeTruthy());
    expect(screen.getByRole('button', { name: copy.action.retry })).toBeTruthy();
    expect(document.querySelector('[data-status="issued"]')).toBeTruthy();
  });
});

describe('the reader who may not manage', () => {
  it('sees the domains, the read-only line, and none of the controls', () => {
    render([domain({ status: 'unverified' })], { canManage: false });
    expect(screen.getAllByText('shop.acme.com').length).toBeGreaterThan(0);
    expect(screen.getByText(copy.readOnly)).toBeTruthy();
    expect(screen.queryByRole('button', { name: copy.add })).toBeNull();
    expect(screen.queryByRole('button', { name: copy.action.remove })).toBeNull();
    expect(screen.queryByRole('button', { name: copy.action.checkNow })).toBeNull();
  });

  it('reads an issued row’s application with no control to change it', () => {
    render([domain({ status: 'issued', applicationId: SHOP.id })], {
      canManage: false,
      applications: [SHOP],
    });
    expect(screen.getByText(/Serves/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /application for/i })).toBeNull();
  });
});

describe('the load error', () => {
  it('is one line and a retry, not the route’s error boundary', () => {
    render([], { loadFailed: true });
    expect(screen.getByText(copy.loadError)).toBeTruthy();
  });
});
