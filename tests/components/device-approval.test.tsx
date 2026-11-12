// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { DeviceApproval } from '@/app/(auth)/device/_components/DeviceApproval';
import { DeviceSignedOut } from '@/app/(auth)/device/_components/DeviceSignedOut';
import type { DeviceGrantDescriptionDTO } from '@/lib/dto/cliDevice';

// The `/device` approval page (Story MOTIR-1863 · Subtask MOTIR-1867), built to
// `design/cli-connect/`. This suite pins ALL SIX states the design draws plus the
// branches that route between them, because a dead end on this page strands a
// terminal that is still polling — "no unhandled branch" is the acceptance
// criterion, and the only way to hold it is to name every response the three
// endpoints can give and assert where each one lands.
//
// happy-dom + the repo's own matchers (there is no jest-dom here), so assertions
// read `.toBeTruthy()` / `.textContent`, never `.toBeInTheDocument()`.

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}));

const GRANT: DeviceGrantDescriptionDTO = {
  userCode: 'K4TP9RXM',
  status: 'pending',
  hostname: 'studio-mbp',
  // Fixed instants: the "asked N ago" line is a relative format, so a live clock
  // would make the assertion a moving target ([[timestamp-assertions-are-windows]]
  // — here the fix is to pin the input, not to widen the expectation).
  askedAt: '2026-07-30T12:00:00.000Z',
  expiresAt: '2026-07-30T12:15:00.000Z',
  permissions: ['project:browse', 'work_item:edit', 'comment:add', 'ai:plan'],
  clientId: 'motir-cli',
  update: null,
};

const USER = { name: 'Zhu Yue', email: 'zhuyue11@gmail.com', image: null };
const TWO_WORKSPACES = [
  { id: 'ws-1', label: 'moooon · Motir' },
  { id: 'ws-2', label: 'moooon · Side project' },
];

/** One queued response per call, in order — so a test states the whole exchange. */
function stubFetch(...responses: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift() ?? { status: 500 };
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body ?? {},
    } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function renderPage(props: Partial<Parameters<typeof DeviceApproval>[0]> = {}) {
  return renderWithIntl(
    <DeviceApproval
      initialUserCode=""
      user={USER}
      workspaces={TWO_WORKSPACES}
      activeWorkspaceId="ws-2"
      {...props}
    />,
  );
}

/** Drive entry → confirm with a stubbed describe, and hand back the recorded calls. */
async function reachConfirm(
  props: Partial<Parameters<typeof DeviceApproval>[0]> = {},
  grant: Partial<DeviceGrantDescriptionDTO> = {},
  ...rest: Array<{ status: number; body?: unknown }>
) {
  const calls = stubFetch({ status: 200, body: { ...GRANT, ...grant } }, ...rest);
  renderPage({ initialUserCode: 'K4TP-9RXM', ...props });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByRole('heading', { name: 'Connect this terminal?' });
  return calls;
}

beforeEach(() => {
  push.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('/device — state 1: code entry (design Panels 1 + 2)', () => {
  it('shows the empty entry form on a bare arrival', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: 'Connect the Motir CLI' })).toBeTruthy();
    expect(screen.getByText('Enter the code your terminal is showing.')).toBeTruthy();
    expect((screen.getByLabelText('Device code') as HTMLInputElement).value).toBe('');
  });

  it('pre-fills and re-groups the code carried in from `?user_code=`, with its own subhead', () => {
    renderPage({ initialUserCode: 'k4tp9rxm' });
    expect((screen.getByLabelText('Device code') as HTMLInputElement).value).toBe('K4TP-9RXM');
    expect(
      screen.getByText('Check this is the code your terminal is showing, then continue.'),
    ).toBeTruthy();
    expect(screen.getByText('Filled in from the link your terminal opened.')).toBeTruthy();
  });

  it('normalises a hand-typed code — lower case, a stray space, no dash — before sending it', async () => {
    const calls = stubFetch({ status: 200, body: GRANT });
    renderPage();
    fireEvent.change(screen.getByLabelText('Device code'), { target: { value: ' k4tp9rxm ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'Connect this terminal?' });
    expect(calls[0]?.url).toBe('/api/cli/device/grant?user_code=K4TP9RXM');
  });

  it('refuses a short code in the client rather than spending a round trip on it', () => {
    const calls = stubFetch();
    renderPage();
    fireEvent.change(screen.getByLabelText('Device code'), { target: { value: 'K4TP' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('A device code is eight characters.')).toBeTruthy();
    expect(calls).toHaveLength(0);
  });
});

describe('/device — state 2: confirm (design Panels 3 + 4)', () => {
  it('inventories all four facts: who, what is connecting, which workspace, what scopes', async () => {
    await reachConfirm();

    expect(screen.getByText('Zhu Yue')).toBeTruthy();
    expect(screen.getByText('zhuyue11@gmail.com')).toBeTruthy();
    expect(screen.getByText('Motir CLI on studio-mbp')).toBeTruthy();
    // The code the SERVER matched, echoed in the grouped display form.
    expect(screen.getByText('K4TP-9RXM')).toBeTruthy();
    // Scope NAMES, reused from the Tokens catalog rather than duplicated.
    // The rows are DERIVED from `CLI_TOKEN_GRANT` through the shared presenter
    // (MOTIR-2579), and their names are the shipped `permissions.*` labels — the
    // same strings Roles & permissions renders. Asserting the labels rather than
    // a count is what would catch this screen drifting into its own vocabulary.
    expect(screen.getByText('View project')).toBeTruthy();
    expect(screen.getByText('Edit work items')).toBeTruthy();
    expect(screen.getByText('Add comments')).toBeTruthy();
    expect(screen.getByText('Run AI planning')).toBeTruthy();
    // MOTIR-7412 — the page keys joined the grant, so the screen names them with
    // their shipped `permissions.page_*` labels.
    expect(screen.getByText('Read pages')).toBeTruthy();
    expect(screen.getByText('Edit pages')).toBeTruthy();
    // MOTIR-11038 — `repository:manage` joined the grant for `create_project_repository`.
    expect(screen.getByText('Manage repositories')).toBeTruthy();
    expect(screen.getByText('Not: archive or delete work items, members, billing.')).toBeTruthy();
    expect(screen.getByText('In 90 days')).toBeTruthy();
  });

  it('widens the auth column — the fold invariant the design measured lives on this state', async () => {
    const { container } = renderWithIntl(
      <DeviceApproval
        initialUserCode=""
        user={USER}
        workspaces={TWO_WORKSPACES}
        activeWorkspaceId="ws-1"
      />,
    );
    expect(container.querySelector('[data-auth-wide]')).toBeNull();
    cleanup();
    await reachConfirm();
    expect(document.querySelector('[data-auth-wide]')).not.toBeNull();
  });

  it('offers the workspace picker to a multi-workspace user, defaulted to the ACTIVE workspace', async () => {
    await reachConfirm();
    const picker = screen.getByRole('combobox', { name: 'Workspace this terminal can see' });
    expect(picker.textContent).toContain('moooon · Side project'); // activeWorkspaceId = ws-2
    expect(screen.getByText('You belong to 2 — it sees only this one.')).toBeTruthy();
  });

  it('renders NO picker for a single-workspace user — no choice to make, no control', async () => {
    await reachConfirm({ workspaces: [TWO_WORKSPACES[0]!], activeWorkspaceId: 'ws-1' });
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText('moooon · Motir')).toBeTruthy();
    expect(screen.getByText('Your only workspace.')).toBeTruthy();
  });

  it('puts Deny FIRST in the DOM and gives it equal weight — border-danger, never danger TEXT', async () => {
    await reachConfirm();
    const group = screen.getByRole('group', { name: 'Approve or deny this terminal' });
    const buttons = Array.from(group.querySelectorAll('button'));
    expect(buttons.map((b) => b.textContent)).toEqual(['Deny', 'Approve and connect']);
    const deny = buttons[0]!;
    // The hue is in the BORDER; the label keeps `--el-text` (the MOTIR-1553 class:
    // `--el-danger-text` is the ink FOR a danger fill, white in the light palette).
    expect(deny.className).toContain('border-(--el-danger)');
    expect(deny.className).not.toContain('text-(--el-danger');
  });

  it('states the phishing warning naming the host that asked', async () => {
    await reachConfirm();
    expect(screen.getByText(/Approve only if you just ran/)).toBeTruthy();
    expect(screen.getByText(/deny it/)).toBeTruthy();
  });
});

describe('/device — state 3: approved (design Panel 5)', () => {
  it('approves against the chosen workspace and names the token that now exists', async () => {
    const calls = await reachConfirm({}, {}, { status: 200, body: { ok: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve and connect' }));

    await screen.findByRole('heading', { name: 'Terminal connected' });
    expect(calls[1]?.url).toBe('/api/cli/device/approve');
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      userCode: 'K4TP9RXM',
      workspaceId: 'ws-2',
    });
    expect(screen.getByText(/CLI · studio-mbp/)).toBeTruthy();
    expect(screen.getByText(/90 days/)).toBeTruthy();
    // The forward path off a terminal screen.
    expect(screen.getByRole('link', { name: 'View tokens' }).getAttribute('href')).toBe(
      '/settings/account/tokens',
    );
  });

  it('announces the result in a live region so it is heard, not just seen', async () => {
    await reachConfirm({}, {}, { status: 200, body: { ok: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve and connect' }));
    const status = await screen.findByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toContain('Terminal connected');
  });

  it('surfaces the server 403 as a real message and STAYS on confirm when the workspace is refused', async () => {
    await reachConfirm({}, {}, { status: 403, body: { code: 'WORKSPACE_FORBIDDEN' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve and connect' }));

    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('not a member of that workspace');
    // Still the confirm screen — the picker that caused it is still on screen.
    expect(screen.getByRole('heading', { name: 'Connect this terminal?' })).toBeTruthy();
  });

  it('routes a 409 (already approved elsewhere) by RE-READING, not by guessing', async () => {
    await reachConfirm(
      {},
      {},
      { status: 409, body: { code: 'DEVICE_GRANT_NOT_PENDING' } },
      { status: 200, body: { ...GRANT, status: 'approved' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Approve and connect' }));
    await screen.findByRole('heading', { name: 'Terminal connected' });
    expect(screen.getByText(/already approved/)).toBeTruthy();
  });
});

describe('/device — state 4: denied (design Panel 6)', () => {
  it('denies through the plugin endpoint and says nothing was created', async () => {
    const calls = await reachConfirm({}, {}, { status: 200, body: { success: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));

    await screen.findByRole('heading', { name: 'Request denied' });
    expect(calls[1]?.url).toBe('/api/auth/device/deny');
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ userCode: 'K4TP9RXM' });
    expect(screen.getByText(/no token was created/)).toBeTruthy();
  });

  it('offers a way back — "Enter another code" returns to a blank field', async () => {
    await reachConfirm({}, {}, { status: 200, body: { success: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await screen.findByRole('heading', { name: 'Request denied' });

    fireEvent.click(screen.getByRole('button', { name: 'Enter another code' }));
    expect(screen.getByRole('heading', { name: 'Connect the Motir CLI' })).toBeTruthy();
    expect((screen.getByLabelText('Device code') as HTMLInputElement).value).toBe('');
  });
});

describe('/device — state 5: expired / unknown (design Panel 7)', () => {
  it('renders the expired screen with the "run motir login again" path on a 410', async () => {
    stubFetch({ status: 410, body: { code: 'DEVICE_GRANT_EXPIRED' } });
    renderPage({ initialUserCode: 'K4TP-9RXM' });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await screen.findByRole('heading', { name: 'That code has expired' });
    // The lifetime the ADR pinned (15m), not the plugin's 30m default.
    expect(screen.getByText('Codes last 15 minutes.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enter a new code' })).toBeTruthy();
  });

  it('renders the unknown-code screen on a 404 and KEEPS the field so a typo is one edit away', async () => {
    stubFetch({ status: 404, body: { code: 'DEVICE_GRANT_INVALID' } });
    renderPage({ initialUserCode: 'K4TP-9RXN' });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await screen.findByRole('heading', { name: 'We don’t recognise that code' });
    expect((screen.getByLabelText('Device code') as HTMLInputElement).value).toBe('K4TP-9RXN');
    expect(screen.getByText('One character off is the usual cause.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('names the phishing-relevant 403 — the grant belongs to a different account', async () => {
    stubFetch({ status: 403, body: { code: 'DEVICE_GRANT_FORBIDDEN' } });
    renderPage({ initialUserCode: 'K4TP-9RXM' });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('different Motir account');
  });

  it('never blanks the page on an unroutable failure — a network error is a banner, not a void', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    renderPage({ initialUserCode: 'K4TP-9RXM' });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('couldn’t reach Motir');
    expect(screen.getByRole('heading', { name: 'Connect the Motir CLI' })).toBeTruthy();
  });

  it('sends a session that expired mid-flow back through sign-in, code intact', async () => {
    stubFetch({ status: 401, body: { code: 'UNAUTHENTICATED' } });
    renderPage({ initialUserCode: 'K4TP-9RXM' });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(push).toHaveBeenCalledWith('/sign-in?next=%2Fdevice%3Fuser_code%3DK4TP9RXM');
  });
});

describe('/device — state 6: signed-out arrival (design Panel 8)', () => {
  it('carries the pending code across sign-in and comes BACK to it', () => {
    renderWithIntl(<DeviceSignedOut userCode="k4tp-9rxm" />);
    expect(screen.getByRole('heading', { name: 'Sign in to connect the CLI' })).toBeTruthy();
    // The code sits in its own `CodeChip`, so it is its own text node.
    expect(screen.getByText('K4TP-9RXM')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign in to continue' }).getAttribute('href')).toBe(
      '/sign-in?next=%2Fdevice%3Fuser_code%3DK4TP9RXM',
    );
  });

  it('degrades to a bare return when no code came with the URL', () => {
    renderWithIntl(<DeviceSignedOut userCode="" />);
    expect(screen.getByRole('link', { name: 'Sign in to continue' }).getAttribute('href')).toBe(
      '/sign-in?next=%2Fdevice',
    );
  });
});

describe('/device — accessibility', () => {
  // colour-contrast needs real layout + computed colours, which happy-dom does not
  // produce; the design measured those ratios directly (design-notes.md § Token +
  // a11y discipline) and the E2E sweep re-checks them in a real browser. Everything
  // structural — labels, names, roles, listbox shape — is checked here.
  //
  // The sweep runs over `document.body`, which in a test holds only the island — so
  // the `<main>` landmark the shipped `(auth)` layout wraps every page in is put
  // back. Without it axe reports `region` for content the real page always has
  // inside a landmark: an artifact of the harness, not a defect in the screen.
  const options = { rules: { 'color-contrast': { enabled: false } } } as const;

  // Swept against `document.body`, which in a test holds only the island — so the
  // `<main>` landmark the shipped `(auth)` layout wraps every page in is added back
  // here. Without it axe reports `region` for content the real page always has in a
  // landmark, which would be an artifact of the harness, not a defect in the screen.
  function renderInLandmark(initialUserCode: string) {
    const main = document.createElement('main');
    document.body.appendChild(main);
    return renderWithIntl(
      <DeviceApproval
        initialUserCode={initialUserCode}
        user={USER}
        workspaces={TWO_WORKSPACES}
        activeWorkspaceId="ws-2"
      />,
      { container: main },
    );
  }

  it('the entry screen is clean', async () => {
    stubFetch();
    renderInLandmark('K4TP-9RXM');
    const result = await axe.run(document.body, options);
    expect(result.violations.map((v) => v.id)).toEqual([]);
  }, 30_000);

  it('the confirm screen is clean, picker and all', async () => {
    stubFetch({ status: 200, body: GRANT });
    renderInLandmark('K4TP-9RXM');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'Connect this terminal?' });

    const result = await axe.run(document.body, options);
    expect(result.violations.map((v) => v.id)).toEqual([]);
  }, 30_000);
});

// ── the story gate's residue (Subtask MOTIR-1870) ────────────────────────────
// Branches the suite above left unproven, found by measuring the whole story's
// surface. Every one of them is a state a real reader reaches — an unknown host,
// a session that ended mid-flow, a re-read that lands somewhere terminal, the
// "not you" hand-off — and on THIS page an unhandled branch strands a terminal
// that is still polling, which is exactly what the state coverage is for.

describe('/device — the paths a first pass leaves for later', () => {
  it('drops the hostname from BOTH warnings when the terminal reported none', async () => {
    await reachConfirm({}, { hostname: null });

    // The generic warning still names the act (`motir login`), because the
    // phishing mitigation cannot depend on a field the CLI may not have sent.
    expect(screen.getByText(/Approve only if you just ran/)).toBeTruthy();
    expect(screen.getByText(/deny it/)).toBeTruthy();
    // And the "what is connecting" line degrades to the client, not to a blank.
    expect(screen.getByText('Motir CLI')).toBeTruthy();
  });

  it('confirms an unknown-host grant WITHOUT inventing a token label', async () => {
    await reachConfirm({}, { hostname: null }, { status: 200, body: { ok: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve and connect' }));

    await screen.findByRole('heading', { name: 'Terminal connected' });
    // The workspace is still named — that is the fact the reader approved.
    expect(screen.getByText(/moooon · Side project/)).toBeTruthy();
    // But no `CLI · <host>` chip, because there is no host to name.
    expect(screen.queryByText(/CLI · /)).toBeNull();
  });

  it('routes a DENY that the server has already moved past by re-reading, not by guessing', async () => {
    // Deny raced an approval elsewhere: the 409 is not a dead end, it is a
    // re-read that lands on the true terminal screen.
    await reachConfirm(
      {},
      {},
      { status: 409, body: { code: 'DEVICE_GRANT_NOT_PENDING' } },
      { status: 200, body: { ...GRANT, status: 'approved' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));

    await screen.findByRole('heading', { name: 'Terminal connected' });
    expect(screen.getByText(/already approved/)).toBeTruthy();
  });

  it('sends a session that expired before the DENY back through sign-in, code intact', async () => {
    await reachConfirm({}, {}, { status: 401, body: { code: 'UNAUTHENTICATED' } });
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));

    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(push).toHaveBeenCalledWith('/sign-in?next=%2Fdevice%3Fuser_code%3DK4TP9RXM');
  });

  it('shows a banner — never a blank page — when the network dies mid-DENY', async () => {
    await reachConfirm({});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));

    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('couldn’t reach Motir');
    // Still on confirm, so the reader can retry the same decision.
    expect(screen.getByRole('heading', { name: 'Connect this terminal?' })).toBeTruthy();
  });

  it('shows a banner when the RE-READ itself fails, rather than stranding the reader', async () => {
    // The 409 → refresh path with a dead network on the second call: the page must
    // still say something, because the terminal is still polling either way.
    const responses = [{ status: 409, body: { code: 'DEVICE_GRANT_NOT_PENDING' } }];
    await reachConfirm({}, {}, ...responses);
    const failing = vi.fn(async (url: string) => {
      if (String(url).endsWith('/approve')) {
        return {
          ok: false,
          status: 409,
          json: async () => ({ code: 'DEVICE_GRANT_NOT_PENDING' }),
        } as Response;
      }
      throw new Error('offline');
    });
    vi.stubGlobal('fetch', failing);
    fireEvent.click(screen.getByRole('button', { name: 'Approve and connect' }));

    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('couldn’t reach Motir');
  });

  it('carries an unroutable RE-READ failure to the right screen (the grant expired meanwhile)', async () => {
    await reachConfirm(
      {},
      {},
      { status: 409, body: { code: 'DEVICE_GRANT_NOT_PENDING' } },
      { status: 410, body: { code: 'DEVICE_GRANT_EXPIRED' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Approve and connect' }));

    await screen.findByRole('heading', { name: 'That code has expired' });
  });

  it('the "not you" hand-off signs the reader OUT before sending them to sign-in', async () => {
    // The phishing-adjacent case the confirm screen exists for: the person at the
    // browser is not the person at the terminal. Signing out FIRST is the point —
    // sending them to /sign-in with the old session live would land them straight
    // back here as the wrong user.
    const signOut = vi.fn(async () => undefined);
    vi.doMock('@/lib/auth/client', () => ({ signOut }));
    await reachConfirm({});

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(signOut).toHaveBeenCalled());
    expect(push).toHaveBeenCalledWith('/sign-in?next=%2Fdevice%3Fuser_code%3DK4TP9RXM');
    vi.doUnmock('@/lib/auth/client');
  });

  it('reads Better-Auth’s `{ error }` body as well as Motir’s `{ code }`', async () => {
    // The two credential systems answer in two shapes and the page consumes both;
    // an unrecognised code must still land on a message, never a blank screen.
    await reachConfirm({}, {}, { status: 403, body: { error: 'access_denied' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve and connect' }));

    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('different Motir account');
  });

  it('treats an unparseable error body as "no code" and still says something', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json');
      },
    }));
    vi.stubGlobal('fetch', fetchMock);
    renderPage({ initialUserCode: 'K4TP-9RXM' });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent!.length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Connect the Motir CLI' })).toBeTruthy();
  });

  it('names the sequencing bug when the server says the code was never claimed', async () => {
    // 409 NOT_CLAIMED is its own screen-level message, not the already-handled
    // re-read: the page skipped the claim, so telling the reader "already
    // approved" would be a lie about a state nobody is in.
    await reachConfirm({}, {}, { status: 409, body: { code: 'DEVICE_GRANT_NOT_CLAIMED' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve and connect' }));

    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent!.length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Connect this terminal?' })).toBeTruthy();
  });

  it('lands on the DENIED screen when the re-read finds the grant was denied elsewhere', async () => {
    await reachConfirm(
      {},
      {},
      { status: 409, body: { code: 'DEVICE_GRANT_NOT_PENDING' } },
      { status: 200, body: { ...GRANT, status: 'denied' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Approve and connect' }));

    await screen.findByRole('heading', { name: 'Request denied' });
  });

  it('falls back to the first workspace when the active one is not one the user may bind in', async () => {
    // `activeWorkspaceId` comes from the app-shell cookie and can name a workspace
    // this user cannot mint a token in; defaulting the picker to it would post an
    // id the server then refuses.
    const calls = await reachConfirm(
      { activeWorkspaceId: 'ws-not-mine' },
      {},
      { status: 200, body: { ok: true } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Approve and connect' }));

    await screen.findByRole('heading', { name: 'Terminal connected' });
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({ workspaceId: 'ws-1' });
  });
});
