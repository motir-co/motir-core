// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl, enMessages } from '../helpers/renderWithIntl';
import { CustomDomainsSection } from '@/app/(authed)/settings/project/public-address/_components/CustomDomainsSection';
import type { PublicAddressDto } from '@/lib/dto/publicAddresses';

// THE CUSTOMER-DOMAIN LIST (Story MOTIR-3878 · MOTIR-4229) — design panels 3,
// 3b, 4, 5, 6 and 7.
//
// ⚠️ THE STATE TABLE IS DRIVEN FROM THE ENUM, NOT FROM A LIST WRITTEN HERE. A
// test that enumerated the seven statuses it happened to remember would go green
// on the day an eighth arrived, which is the exact failure the total `Record` in
// the component exists to prevent — so the fixture set is derived and its size
// is asserted.

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

function domain(over: Partial<PublicAddressDto> = {}): PublicAddressDto {
  return {
    id: 'addr_1',
    kind: 'custom_domain',
    hostname: 'roadmap.acme.com',
    status: 'issued',
    applicationId: null,
    verification: { name: '_motir-verify.roadmap.acme.com', value: 'motir-verify=abc123' },
    dns: [{ type: 'CNAME', name: 'roadmap', value: 'motir-marketing.fly.dev' }],
    lastCheckedAt: '2026-09-03T09:00:00.000Z',
    issuedAt: null,
    failureReason: null,
    ...over,
  };
}

function render(addresses: PublicAddressDto[], canManage = true) {
  return renderWithIntl(
    <CustomDomainsSection workspaceId="ws_1" canManage={canManage} addresses={addresses} />,
  );
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  refreshMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('panel 5 — the state set, total over the enum', () => {
  it('the enum has NINE values and exactly two of them are the subdomain’s', () => {
    // The floor that makes the table below mean something: if the union grows,
    // this fails before the per-status cases can pass vacuously.
    expect(ALL_STATUSES).toHaveLength(9);
    expect(DOMAIN_STATUSES).toHaveLength(7);
  });

  it.each(DOMAIN_STATUSES)('%s renders a chip, a meaning and at least one action', (status) => {
    render([domain({ status })]);

    const row = document.querySelector(`[data-status="${status}"]`);
    expect(row, `no row rendered for ${status}`).toBeTruthy();

    // ⚠️ THE CHIP AND THE MEANING BOTH COME FROM THE CATALOGUE, and the
    // expectation is READ from it rather than restated — a literal here would
    // pass while the zh half was empty, which is precisely the parity failure
    // this room's copy is most likely to have.
    const copy = enMessages.settings.publicAddress.domains.state[status];
    expect(copy.label, `${status} has no chip label`).toBeTruthy();
    expect(copy.label).not.toBe(status);
    expect(row!.textContent).toContain(copy.label);
    expect(row!.textContent).toContain(copy.hint.slice(0, 40));
    // Every domain state can at least be removed — a row you cannot get rid of
    // is a row that outlives the mistake that made it.
    expect(within(row as HTMLElement).getByRole('button', { name: 'Remove' })).toBeTruthy();
  });

  it('NEVER lists the two subdomain states — they belong to the other card', () => {
    render([domain({ status: 'active' }), domain({ id: 'a2', status: 'alias' })]);
    expect(screen.getByText('No domain connected')).toBeTruthy();
  });

  it('renders `failureReason` rather than summarising it away', () => {
    // A failure with no reason is not actionable, which is why MOTIR-4209 stores
    // it and MOTIR-4219 writes it.
    render([domain({ status: 'failed', failureReason: 'DNS record not found' })]);
    expect(screen.getByText(/DNS record not found/)).toBeTruthy();
  });
});

describe('no primary (ADR MOTIR-9521 §1)', () => {
  it('offers no Make primary on any row — a domain serves an application, not a project', () => {
    // The primary customer domain is retired: the product's single link is the
    // application's production address, else its earliest-issued domain.
    for (const status of DOMAIN_STATUSES) {
      const { unmount } = render([domain({ status })]);
      expect(screen.queryByRole('button', { name: 'Make primary' }), status).toBeNull();
      unmount();
    }
  });
});

describe('panel 4 — the records the customer has to create', () => {
  it('renders every record the DTO carries, each copyable', () => {
    // ⚠️ AND TODAY THE DTO CARRIES ONLY THE OWNERSHIP TXT. This case used to
    // hand in a `dns: [CNAME]` alongside a `verification` and assert both — a
    // shape `customDomainService`'s mapper never produces, so it asserted a
    // screen the product cannot render. The pointing record is parsed by the Fly
    // adapter and dropped at the mapper: **MOTIR-4278**. Corrected to the real
    // shape rather than left describing a fiction.
    render([
      domain({
        status: 'unverified',
        dns: [
          { type: 'TXT', name: '_motir-verify.roadmap.acme.com', value: 'motir-verify=abc123' },
        ],
      }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Show DNS records' }));

    expect(screen.getByText('TXT')).toBeTruthy();
    expect(screen.getByText('motir-verify=abc123')).toBeTruthy();
    expect(screen.getAllByLabelText('Copy value')).toHaveLength(1);
  });

  it('explains the apex pinning only when the records ARE an apex’s', () => {
    // RFC 1034 §3.6.2 in the customer's words. On a CNAME it would be noise.
    render([
      domain({
        status: 'unverified',
        dns: [
          { type: 'A', name: '@', value: '66.241.125.217' },
          { type: 'AAAA', name: '@', value: '2a09:8280:1::17d:93fd:0' },
        ],
      }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Show DNS records' }));
    expect(screen.getByText(/pinned to our IP addresses/)).toBeTruthy();

    cleanup();
    render([domain({ status: 'unverified' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Show DNS records' }));
    expect(screen.queryByText(/pinned to our IP addresses/)).toBeNull();
  });
});

describe('the tier gate', () => {
  it('renders the upgrade prompt from the ROUTE’S REFUSAL, not from a tier read', () => {
    // ⚠️ A DELIBERATE DEPARTURE FROM THE CARD, and the shipped service asked for
    // it: `assertCanAddCustomDomain` records that `free: 0` exists precisely to
    // make the refusal "the upgrade prompt's trigger instead of an empty state
    // the pane special-cases". Pre-disabling would put a second copy of a
    // billing rule in this component.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 402,
      json: async () => ({ code: 'ENTITLEMENT_EXCEEDED', entitlement: 'custom_domains' }),
    });
    render([]);
    fireEvent.click(screen.getByRole('button', { name: 'Add a domain' }));
    fireEvent.change(screen.getByLabelText('Domain'), {
      target: { value: 'roadmap.acme.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add domain' }));

    return waitFor(() => {
      expect(screen.getByText('Custom domains are on the paid plan.')).toBeTruthy();
      expect(screen.getByRole('link', { name: 'See plans' })).toBeTruthy();
    });
  });
});

describe('liveness — the states this pane does not write', () => {
  it('re-reads on the tick while a row is waiting on the JOB', async () => {
    // `verifying` and `pending_certificate` end when MOTIR-4219's job sees the
    // platform change its mind. Without the tick the pane reads "Issuing…" until
    // somebody reloads, which looks like a stuck product.
    vi.useFakeTimers();
    render([domain({ status: 'pending_certificate' })]);
    expect(refreshMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('and STOPS once nothing is pending — a settled pane costs nothing', () => {
    vi.useFakeTimers();
    render([domain({ status: 'issued' })]);
    vi.advanceTimersByTime(120_000);
    expect(refreshMock).not.toHaveBeenCalled();
  });
});

describe('panel 7 — removing a domain', () => {
  it('asks first, and names what will break', () => {
    render([domain({ status: 'issued' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(screen.getByText('Remove roadmap.acme.com?')).toBeTruthy();
    expect(screen.getByText('Anyone using this address will get an error.')).toBeTruthy();
    expect(screen.getByText(/Links already shared/)).toBeTruthy();
  });

  it('DELETEs the address and re-reads on confirm', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    render([domain({ status: 'issued' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove domain' }));

    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/workspaces/ws_1/custom-domains/addr_1');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'DELETE' });
  });
});

describe('the reader who may not manage', () => {
  it('sees the addresses and none of the controls', () => {
    render([domain({ status: 'issued' })], false);
    expect(screen.getByText('roadmap.acme.com')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add a domain' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });
});
