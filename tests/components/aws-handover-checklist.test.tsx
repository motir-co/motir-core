// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import {
  AwsHandoverChecklist,
  HANDOVER_POLL_MS,
  handoverInMotion,
} from '@/app/(authed)/settings/project/repositories/_components/AwsHandoverChecklist';
import { AwsHandoverUpstreams } from '@/app/(authed)/settings/project/repositories/_components/AwsHandoverUpstreams';
import { formatAwsAccountId } from '@/app/(authed)/settings/project/repositories/_components/awsHandoverClient';
import {
  TENANT_HANDOVER_STEPS,
  type TenantHandoverStep,
  type TenantHandoverStepStatus,
} from '@/lib/ciFleet/hostingTenantAccounts';
import type {
  TenantAccountHandoverDto,
  TenantHandoverApplicationDto,
} from '@/lib/dto/tenantAccountHandover';
import { renderWithIntl } from '../helpers/renderWithIntl';

// THE HANDOVER CHECKLIST AND THE UPSTREAM LIST (Story MOTIR-9800 · MOTIR-12137 —
// design/repository-set/takeover--aws-handover panels 11–25).
//
// What is pinned:
//   1. Eight rows in run order, each with its status word; the row a person or
//      the job is on carries aria-current="step" (panels 12–13, 21).
//   2. Every act's answer IS the new checklist and is applied in place: Retry
//      (18), the email code (14–15) and Check again (16–17) post the account id
//      and nothing else of the person's, and a refused code is the field's error
//      rather than the row's failure.
//   3. The poll runs while the handover moves by itself and stops once it waits
//      on a person, fails or finishes; a hidden tab does not poll.
//   4. The upstream list appears from Apps reachable without Motir on, with Copy
//      on each address, and has its own loading, empty and error states (22–25).
//
// The only fake is `fetch` (and the clipboard, for Copy).

const ORG_ID = 'org-1';
const ACCOUNT_ID = 'tenant-1';
const BASE = `/api/organizations/${ORG_ID}/hosting/aws-handover`;
const OWNER = { ownerEmail: 'dana@acme.example', githubOwner: 'acme' };

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

let fetchMock: ReturnType<typeof vi.fn>;
let handler: Handler;

beforeEach(() => {
  handler = () => json(200, { handover: handover({}) });
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => handler(String(url), init));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('reading the checklist (panels 11–13)', () => {
  it('reads on mount, then draws the header and eight rows in run order', async () => {
    let answer!: (r: Response) => void;
    handler = () => new Promise<Response>((resolve) => (answer = resolve));
    renderChecklist({ initial: null });
    expect(screen.getByText('Reading the handover…')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE}?tenantAccountId=${ACCOUNT_ID}`,
      expect.objectContaining({ cache: 'no-store' }),
    );

    await act(async () =>
      answer(
        json(200, {
          handover: handover({ destroy_previews: 'done', create_deploy_role: 'running' }),
        }),
      ),
    );
    expect(screen.getByRole('heading', { name: 'moooon’s AWS account' })).toBeTruthy();
    expect(screen.getByText('4821 0937 5512')).toBeTruthy();
    expect(screen.getByText(/· 3 repositories$/)).toBeTruthy();

    const items = rowsOf();
    expect(items.map((li) => li.getAttribute('data-step'))).toEqual([...TENANT_HANDOVER_STEPS]);
    expect(items.map((li) => li.getAttribute('data-step-status'))).toEqual([
      'done',
      'running',
      'pending',
      'pending',
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
    expect(within(items[0]!).getByText('Done')).toBeTruthy();
    expect(within(items[1]!).getByText('Running')).toBeTruthy();
    expect(items.map((li) => li.getAttribute('aria-current'))).toEqual([
      null,
      'step',
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(
      within(items[0]!).getByText('The preview environments of the 3 repositories are deleted.'),
    ).toBeTruthy();
    // The owner is known in this session, so the last row names it.
    expect(within(items[7]!).getByText('GitHub moves each repository to acme.')).toBeTruthy();
    expect(screen.getByText('In progress')).toBeTruthy();
  });

  it('shows the error state when the read fails, and Try again re-reads', async () => {
    handler = () => json(500, {});
    renderChecklist({ initial: null });
    await act(async () => {});
    expect(screen.getByText('The handover couldn’t be read')).toBeTruthy();

    handler = () => json(200, { handover: handover({}) });
    await click(screen.getByRole('button', { name: 'Try again' }));
    expect(rowsOf()).toHaveLength(8);
  });

  it('words the rows without the owner when this session did not start it', () => {
    renderChecklist({ owner: null, initial: handover({}, { awsAccountId: null }) });
    expect(screen.getByText('GitHub moves each repository to its new owner.')).toBeTruthy();
    expect(screen.queryByText('Account')).toBeNull();
  });

  it('says Handed over once every row is done', () => {
    renderChecklist({ initial: handover(allDone()) });
    expect(screen.getByText('Handed over')).toBeTruthy();
    expect(rowsOf().every((li) => li.getAttribute('aria-current') === null)).toBe(true);
  });
});

describe('a failed row (panel 18)', () => {
  it('names what went wrong and Retry applies the answer in place', async () => {
    const failed = handover(
      { ...doneUntil('remove_access'), remove_access: 'failed' },
      { lastError: { remove_access: 'AccessDenied: AWS refused to delete Motir’s role.' } },
    );
    renderChecklist({ initial: failed });
    expect(screen.getByText('Needs a retry')).toBeTruthy();
    const row = rowOf('remove_access');
    expect(within(row).getByRole('alert').textContent).toBe(
      'AccessDenied: AWS refused to delete Motir’s role.',
    );

    handler = (url) =>
      url === `${BASE}/retry`
        ? json(200, {
            handover: handover({ ...doneUntil('remove_access'), remove_access: 'running' }),
          })
        : json(200, { handover: failed });
    await click(within(row).getByRole('button', { name: 'Retry' }));

    const post = fetchMock.mock.calls.find(([u]) => u === `${BASE}/retry`)!;
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({
      tenantAccountId: ACCOUNT_ID,
    });
    expect(rowOf('remove_access').getAttribute('data-step-status')).toBe('running');
  });

  it('says the step failed when it carries no error', () => {
    renderChecklist({ initial: handover({ destroy_previews: 'failed' }) });
    expect(
      within(rowOf('destroy_previews')).getByText('This step failed. Nothing after it has run.'),
    ).toBeTruthy();
  });

  it('says an act did not go through, and quietly re-reads', async () => {
    const failed = handover({ destroy_previews: 'failed' });
    renderChecklist({ initial: failed });
    handler = (url) =>
      url === `${BASE}/retry` ? json(409, { code: 'X' }) : json(200, { handover: failed });
    await click(within(rowOf('destroy_previews')).getByRole('button', { name: 'Retry' }));
    expect(
      within(rowOf('destroy_previews')).getByText(
        'That didn’t go through. Nothing was changed — try again in a moment.',
      ),
    ).toBeTruthy();
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith(`${BASE}?`))).toBe(true);
  });
});

describe('the email code (panels 14–15)', () => {
  const waiting = () => handover({ ...doneUntil('move_email'), move_email: 'waiting_on_you' });

  it('asks for the code and refuses an empty one without a request', async () => {
    renderChecklist({ initial: waiting() });
    const row = rowOf('move_email');
    expect(row.getAttribute('aria-current')).toBe('step');
    expect(
      within(row).getByText(
        'AWS emailed a one-time code to dana@acme.example. Motir passes it to AWS and never stores it.',
      ),
    ).toBeTruthy();
    await click(within(row).getByRole('button', { name: 'Confirm code' }));
    expect(within(row).getByText('Enter the code from AWS’s email.')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the code with the account and applies the answer', async () => {
    renderChecklist({ initial: waiting() });
    handler = () =>
      json(200, {
        handover: handover({
          ...doneUntil('await_standalone'),
          await_standalone: 'waiting_on_you',
        }),
      });
    const row = rowOf('move_email');
    fireEvent.change(within(row).getByLabelText('Code from AWS'), {
      target: { value: ' 123456 ' },
    });
    await click(within(row).getByRole('button', { name: 'Confirm code' }));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/email-code`);
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      tenantAccountId: ACCOUNT_ID,
      code: '123456',
    });
    expect(rowOf('move_email').getAttribute('data-step-status')).toBe('done');
  });

  it('shows a refused code as the field’s error, the row still waiting', async () => {
    renderChecklist({ initial: waiting(), owner: null });
    handler = () => json(422, { code: 'HANDOVER_EMAIL_CODE_REFUSED' });
    const row = rowOf('move_email');
    expect(
      within(row).getByText(
        'AWS emailed a one-time code to the new owner. Motir passes it to AWS and never stores it.',
      ),
    ).toBeTruthy();
    fireEvent.change(within(row).getByLabelText('Code from AWS'), { target: { value: '000000' } });
    await click(within(row).getByRole('button', { name: 'Confirm code' }));

    expect(within(row).getByText('AWS didn’t accept that code.')).toBeTruthy();
    expect(
      within(row).getByText(
        'Check the latest email from AWS to the new owner — a new code replaces the old one — and try again.',
      ),
    ).toBeTruthy();
    expect(within(row).queryByText(/didn’t go through/)).toBeNull();
    expect(row.getAttribute('data-step-status')).toBe('waiting_on_you');
  });

  it('names the owner in the refused help when it is known', async () => {
    renderChecklist({ initial: waiting() });
    handler = () => json(422, { code: 'HANDOVER_EMAIL_CODE_REFUSED' });
    const row = rowOf('move_email');
    fireEvent.change(within(row).getByLabelText('Code from AWS'), { target: { value: '1' } });
    await click(within(row).getByRole('button', { name: 'Confirm code' }));
    expect(within(row).getByText(/latest email from AWS to dana@acme\.example/)).toBeTruthy();
  });
});

describe('AWS’s own steps (panels 16–17)', () => {
  it('lists what the owner does in AWS, what is still missing, and Check again', async () => {
    const waiting = handover(
      { ...doneUntil('await_standalone'), await_standalone: 'waiting_on_you' },
      { missing: { await_standalone: ['payment_method', 'contact_information', 'unheard_of'] } },
    );
    renderChecklist({ initial: waiting });
    const row = rowOf('await_standalone');
    expect(within(row).getByText('dana@acme.example does these in AWS:')).toBeTruthy();
    for (const step of [
      'Sign in to the account as its root user and set a password',
      'Add a payment method',
      'Confirm the contact details',
      'Accept AWS’s customer agreement',
    ]) {
      expect(within(row).getByText(step)).toBeTruthy();
    }
    const missing = within(row).getByRole('status');
    expect(
      within(missing)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['a payment method', 'the account’s contact details']);
    const link = within(row).getByRole('link', { name: /Open the AWS sign-in page/ });
    expect(link.getAttribute('href')).toBe('https://signin.aws.amazon.com/');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');

    handler = () => json(200, { handover: handover(doneUntil('remove_access')) });
    await click(within(row).getByRole('button', { name: 'Check again' }));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/recheck`);
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ tenantAccountId: ACCOUNT_ID });
    expect(rowOf('await_standalone').getAttribute('data-step-status')).toBe('done');
  });

  it('words the intro without the owner, and draws no missing list when AWS named none known', () => {
    renderChecklist({
      owner: null,
      initial: handover(
        { ...doneUntil('await_standalone'), await_standalone: 'waiting_on_you' },
        { missing: { await_standalone: ['unheard_of'] } },
      ),
    });
    const row = rowOf('await_standalone');
    expect(within(row).getByText('The new owner does these in AWS:')).toBeTruthy();
    expect(within(row).queryByRole('status')).toBeNull();
  });

  it('offers Check again on a later step that waits on the owner', async () => {
    renderChecklist({
      initial: handover({
        ...doneUntil('leave_organization'),
        leave_organization: 'waiting_on_you',
      }),
    });
    const row = rowOf('leave_organization');
    await click(within(row).getByRole('button', { name: 'Check again' }));
    expect(fetchMock.mock.calls[0]![0]).toBe(`${BASE}/recheck`);
  });
});

describe('the poll', () => {
  it('re-reads while the handover moves, and stops once it waits on a person', async () => {
    vi.useFakeTimers();
    renderChecklist({ initial: handover({ destroy_previews: 'running' }) });
    handler = () =>
      json(200, {
        handover: handover({ ...doneUntil('move_email'), move_email: 'waiting_on_you' }),
      });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HANDOVER_POLL_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rowOf('move_email').getAttribute('data-step-status')).toBe('waiting_on_you');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HANDOVER_POLL_MS * 3);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not poll a hidden tab, and a failed quiet read keeps the checklist', async () => {
    vi.useFakeTimers();
    renderChecklist({ initial: handover({ destroy_previews: 'running' }) });
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HANDOVER_POLL_MS * 2);
    });
    expect(fetchMock).not.toHaveBeenCalled();

    visibility.mockReturnValue('visible');
    handler = () => json(500, {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HANDOVER_POLL_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rowsOf()).toHaveLength(8);
    expect(screen.queryByText('The handover couldn’t be read')).toBeNull();
    visibility.mockRestore();
  });

  it('knows when a handover moves by itself', () => {
    expect(handoverInMotion(null)).toBe(false);
    expect(handoverInMotion(handover({}))).toBe(true);
    expect(handoverInMotion(handover({ destroy_previews: 'running' }))).toBe(true);
    expect(handoverInMotion(handover({ destroy_previews: 'failed' }))).toBe(false);
    expect(
      handoverInMotion(handover({ ...doneUntil('move_email'), move_email: 'waiting_on_you' })),
    ).toBe(false);
    expect(handoverInMotion(handover(allDone()))).toBe(false);
  });
});

describe('the upstream addresses (panels 22–25)', () => {
  const apps: TenantHandoverApplicationDto[] = [
    {
      applicationId: 'app-web',
      slug: 'acme-booking-web',
      state: 'handing_over',
      upstreamAddress: 'd2k8f4w1q9x3ab.cloudfront.net',
      customerDomains: [
        { host: 'book.acme.example', upstreamAddress: null },
        { host: 'www.acme.example', upstreamAddress: 'edge.acme-web.example' },
      ],
    },
    {
      applicationId: 'app-api',
      slug: 'acme-booking-api',
      state: 'handing_over',
      upstreamAddress: null,
      customerDomains: [{ host: 'api.acme.example', upstreamAddress: null }],
    },
    {
      applicationId: 'app-intranet',
      slug: 'acme-intranet',
      state: 'handing_over',
      upstreamAddress: 'intranet.elb.example',
      customerDomains: [],
    },
  ];

  it('stays hidden until Apps reachable without Motir is done', () => {
    renderChecklist({ initial: handover({ destroy_previews: 'running' }, { applications: apps }) });
    expect(screen.queryByText('Where your apps answer without Motir')).toBeNull();
  });

  it('lists each app’s own address and where each domain points, with Copy', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    renderChecklist({ initial: handover(doneUntil('move_email'), { applications: apps }) });
    const list = screen.getByRole('region', { name: 'Where your apps answer without Motir' });

    // The app's own address, and the domain that points at it.
    expect(within(list).getAllByText('d2k8f4w1q9x3ab.cloudfront.net')).toHaveLength(2);
    // A domain with no upstream of its own points at its app's address.
    expect(
      within(list).getByRole('button', { name: 'Copy where book.acme.example points' }),
    ).toBeTruthy();
    expect(within(list).getByText('edge.acme-web.example')).toBeTruthy();
    // An app whose address is not open yet says so, and offers nothing to copy.
    expect(within(list).getAllByText('Not open yet')).toHaveLength(2);
    expect(
      within(list).queryByRole('button', { name: 'Copy the address of acme-booking-api' }),
    ).toBeNull();
    expect(
      within(list).queryByRole('button', { name: 'Copy where api.acme.example points' }),
    ).toBeNull();
    expect(within(list).getByText('No custom domains — nothing to repoint.')).toBeTruthy();
    expect(within(list).getAllByRole('img', { name: 'point at' })).toHaveLength(3);

    const copy = within(list).getByRole('button', { name: 'Copy where book.acme.example points' });
    await click(copy);
    expect(writeText).toHaveBeenCalledWith('d2k8f4w1q9x3ab.cloudfront.net');
    expect(copy.textContent).toContain('Copied');
  });

  it('leaves the address on screen when the browser refuses the clipboard', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) },
    });
    renderChecklist({ initial: handover(doneUntil('move_email'), { applications: apps }) });
    const copy = screen.getByRole('button', { name: 'Copy the address of acme-intranet' });
    await click(copy);
    expect(copy.textContent).toContain('Copy');
    expect(copy.textContent).not.toContain('Copied');
  });

  it('has its own loading, empty and error states', async () => {
    const onRetry = vi.fn();
    const { rerender } = renderWithIntl(
      <AwsHandoverUpstreams applications={[]} loading onRetry={onRetry} />,
    );
    expect(screen.getByText('Reading the addresses…')).toBeTruthy();
    rerender(<AwsHandoverUpstreams applications={[]} onRetry={onRetry} />);
    expect(screen.getByText('No apps to list yet.')).toBeTruthy();
    rerender(<AwsHandoverUpstreams applications={apps} failed onRetry={onRetry} />);
    expect(screen.getByText('The addresses couldn’t be read')).toBeTruthy();
    await click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('formatAwsAccountId', () => {
  it('groups a 12-digit id in fours and leaves anything else alone', () => {
    expect(formatAwsAccountId('482109375512')).toBe('4821 0937 5512');
    expect(formatAwsAccountId('not-an-id')).toBe('not-an-id');
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

function renderChecklist(
  opts: {
    initial?: TenantAccountHandoverDto | null;
    owner?: typeof OWNER | null;
  } = {},
) {
  return renderWithIntl(
    <AwsHandoverChecklist
      organizationId={ORG_ID}
      organizationName="moooon"
      tenantAccountId={ACCOUNT_ID}
      repositoryCount={3}
      initial={opts.initial === undefined ? handover({}) : opts.initial}
      owner={opts.owner === undefined ? OWNER : opts.owner}
    />,
  );
}

type Statuses = Partial<Record<TenantHandoverStep, TenantHandoverStepStatus>>;

function doneUntil(step: TenantHandoverStep): Statuses {
  const out: Statuses = {};
  for (const s of TENANT_HANDOVER_STEPS) {
    if (s === step) break;
    out[s] = 'done';
  }
  return out;
}

function allDone(): Statuses {
  return Object.fromEntries(TENANT_HANDOVER_STEPS.map((s) => [s, 'done'])) as Statuses;
}

function handover(
  statuses: Statuses,
  extra: {
    awsAccountId?: string | null;
    lastError?: Partial<Record<TenantHandoverStep, string>>;
    missing?: Partial<Record<TenantHandoverStep, string[]>>;
    applications?: TenantHandoverApplicationDto[];
  } = {},
): TenantAccountHandoverDto {
  return {
    tenantAccountId: ACCOUNT_ID,
    organizationId: ORG_ID,
    state: 'handing_over',
    awsAccountId: extra.awsAccountId === undefined ? '482109375512' : extra.awsAccountId,
    deployRoleArn: null,
    steps: TENANT_HANDOVER_STEPS.map((step) => ({
      step,
      status: statuses[step] ?? 'pending',
      lastError: extra.lastError?.[step] ?? null,
      missing: extra.missing?.[step] ?? [],
      attempts: 0,
      completedAt: null,
    })),
    applications: extra.applications ?? [],
  };
}

function rowsOf(): HTMLElement[] {
  return within(screen.getByRole('list', { name: 'Handover steps' }))
    .getAllByRole('listitem', {
      // Only the step rows, not the lists nested inside a row.
    })
    .filter((li) => li.hasAttribute('data-step'));
}

function rowOf(step: TenantHandoverStep): HTMLElement {
  return rowsOf().find((li) => li.getAttribute('data-step') === step)!;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function click(target: Element): Promise<void> {
  fireEvent.click(target);
  await act(async () => {});
}
