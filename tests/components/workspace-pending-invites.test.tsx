// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import type { InviteDeliveryState, PendingInviteDTO } from '@/lib/dto/invites';
import type { MemberRoleContextDTO } from '@/lib/dto/workspaces';

// The Members card's Pending invitations block (MOTIR-9997 ·
// `design/settings/members-pending-invitations--pending-list.mock.html`). The
// Resend server action is the seam mocked; the block, its pills, toasts and
// tooltips are the real ones.

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const resendInviteAction = vi.fn();
vi.mock('@/app/(authed)/settings/workspace/actions', () => ({
  resendInviteAction: (...a: unknown[]) => resendInviteAction(...a),
  setMemberRoleAction: vi.fn(async () => ({ ok: true })),
  removeMemberAction: vi.fn(async () => ({ ok: true })),
  setMemberAccessScopeAction: vi.fn(async () => ({ ok: true })),
  listMemberAddedProjectsAction: vi.fn(async () => ({ ok: true, projects: [] })),
  openProjectAccessAction: vi.fn(async () => undefined),
}));

import { PendingInvitesSection } from '@/app/(authed)/settings/workspace/_components/PendingInvitesSection';
import { MembersCard } from '@/app/(authed)/settings/workspace/_components/MembersCard';

const NOW = new Date('2026-10-28T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

let seq = 0;
function invite(over: Partial<PendingInviteDTO> = {}): PendingInviteDTO {
  seq += 1;
  return {
    id: `inv-${seq}`,
    email: `person${seq}@example.com`,
    accessScope: 'full',
    projectCount: 0,
    invitedBy: { userId: 'u-ana', name: 'Ana Ruiz' },
    sentAt: new Date(NOW.getTime() - DAY).toISOString(),
    expiresAt: new Date(NOW.getTime() + 6 * DAY + 60_000).toISOString(),
    deliveryState: 'queued',
    canResend: true,
    ...over,
  };
}

function renderSection(invites: PendingInviteDTO[]) {
  return render(
    <ToastProvider>
      <PendingInvitesSection invites={invites} />
    </ToastProvider>,
    { now: NOW },
  );
}

const rowOf = (email: string) => screen.getByText(email).closest('li')!;
const resendOf = (email: string) =>
  screen.getByRole('button', { name: `Resend the invitation to ${email}` });

beforeEach(() => {
  seq = 0;
  refresh.mockReset();
  resendInviteAction.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => cleanup());

describe('the Pending block', () => {
  it('draws the heading, the count and one row per invite in the order given, with every field', () => {
    renderSection([
      invite({ email: 'full@example.com' }),
      invite({
        email: 'limited@example.com',
        accessScope: 'limited',
        projectCount: 2,
        invitedBy: { userId: 'u-jo', name: 'Jonas Berg' },
      }),
    ]);

    const block = screen.getByTestId('pending-invitations');
    expect(within(block).getByRole('heading', { name: 'Pending invitations' })).toBeTruthy();
    expect(within(block).getByText('2')).toBeTruthy();
    const rows = within(block).getAllByRole('listitem');
    expect(rows.map((r) => within(r).getByText(/@example\.com/).textContent)).toEqual([
      'full@example.com',
      'limited@example.com',
    ]);

    const full = rowOf('full@example.com').textContent!;
    expect(full).toContain('Invited by Ana Ruiz, Oct 27');
    expect(full).toContain('Full');
    expect(full).toContain('Expires in 6 days');
    const limited = rowOf('limited@example.com').textContent!;
    expect(limited).toContain('Invited by Jonas Berg');
    expect(limited).toContain('Limited · 2 projects');
  });

  it('names a deleted inviter as a former member', () => {
    renderSection([invite({ email: 'x@example.com', invitedBy: { userId: 'gone', name: null } })]);
    expect(rowOf('x@example.com').textContent).toContain('Invited by a former member, Oct 27');
  });

  it('shows the absolute expiry in a tooltip, and the last day in the warning tone', async () => {
    renderSection([
      invite({
        email: 'soon@example.com',
        expiresAt: new Date(NOW.getTime() + 3 * 60 * 60 * 1000).toISOString(),
      }),
    ]);
    const expiry = within(rowOf('soon@example.com')).getByText('Expires today');
    expect(expiry.closest('span')!.querySelector('.text-\\(--el-warning\\)')).toBeTruthy();
    fireEvent.focus(expiry.closest('span')!);
    expect((await screen.findAllByText(/^Expires Oct 28, 2026/)).length).toBeGreaterThan(0);
  });

  it('renders nothing at all when there is nothing pending', () => {
    const { container } = renderSection([]);
    expect(container.textContent).toBe('');
  });

  it('collapses past five rows behind Show all, which reveals the rest and folds back', () => {
    renderSection(Array.from({ length: 7 }, () => invite()));
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'Show all 7 pending invitations' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(7);
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
  });
});

describe('the Delivery pill', () => {
  const expected: Record<InviteDeliveryState, { label: string; tone: string }> = {
    queued: { label: 'Queued', tone: 'neutral' },
    accepted: { label: 'Accepted', tone: 'tint-sky' },
    delivered: { label: 'Delivered', tone: 'tint-mint' },
    bounced: { label: 'Bounced', tone: 'tint-rose' },
    complained: { label: 'Complained', tone: 'tint-rose' },
    delayed: { label: 'Delayed', tone: 'tint-peach' },
    failed: { label: 'Failed', tone: 'tint-rose' },
  };

  it('draws each of the seven states with its label, tone and icon — Accepted is never the success tone', () => {
    const states = Object.keys(expected) as InviteDeliveryState[];
    renderSection(states.map((s) => invite({ email: `${s}@example.com`, deliveryState: s })));
    fireEvent.click(screen.getByRole('button', { name: 'Show all 7 pending invitations' }));
    for (const state of states) {
      const pill = rowOf(`${state}@example.com`).querySelector(`[data-delivery="${state}"]`)!;
      expect(pill.textContent).toBe(expected[state].label);
      expect(pill.querySelector('svg')).toBeTruthy();
      const cls = pill.firstElementChild!.className;
      if (expected[state].tone === 'neutral') {
        expect(cls).not.toMatch(/tint-(sky|mint|rose|peach)/);
      } else {
        expect(cls).toContain(expected[state].tone);
      }
    }
    expect(rowOf('accepted@example.com').textContent).not.toContain('Delivered');
    expect(document.body.textContent).not.toMatch(/inbox/i);
  });

  it("the pill's tooltip carries the helper line", async () => {
    renderSection([invite({ email: 'b@example.com', deliveryState: 'bounced' })]);
    fireEvent.focus(rowOf('b@example.com').querySelector('[data-delivery]')!);
    expect((await screen.findAllByText('The address refused it')).length).toBeGreaterThan(0);
  });
});

describe('Resend', () => {
  it('calls the action with the row id, spins only that row, then toasts and refreshes', async () => {
    let finish: (v: unknown) => void = () => undefined;
    resendInviteAction.mockReturnValue(new Promise((r) => (finish = r)));
    renderSection([invite({ email: 'a@example.com' }), invite({ email: 'b@example.com' })]);

    fireEvent.click(resendOf('a@example.com'));
    expect(resendInviteAction).toHaveBeenCalledWith('inv-1');
    await waitFor(() =>
      expect((resendOf('a@example.com') as HTMLButtonElement).disabled).toBe(true),
    );
    expect((resendOf('b@example.com') as HTMLButtonElement).disabled).toBe(false);

    finish({ ok: true });
    expect(await screen.findByText('New invitation sent to a@example.com')).toBeTruthy();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['RATE_LIMITED', 'Limit reached: 3 invitations per address per hour.', false],
    ['ALREADY_MEMBER', 'This person has already joined the workspace.', true],
    ['INVITE_EXPIRED_OR_MISSING', 'This invitation is no longer pending.', true],
    ['INVITE_NOT_ALLOWED_FOR_SCOPE', "You can't resend this invitation.", false],
    ['INVITE_SCOPE_FORBIDDEN', "You can't resend this invitation.", false],
    ['NOT_A_MEMBER', "You can't resend this invitation.", false],
    ['SOMETHING_ELSE', 'Something went wrong. Please try again.', false],
  ])('a %s refusal says "%s" (refreshes: %s)', async (code, message, refreshes) => {
    resendInviteAction.mockResolvedValue({ ok: false, code });
    renderSection([invite({ email: 'r@example.com' })]);
    fireEvent.click(resendOf('r@example.com'));
    expect(await screen.findByText(message)).toBeTruthy();
    if (code === 'RATE_LIMITED') expect(screen.getByText('Try again later.')).toBeTruthy();
    expect(refresh).toHaveBeenCalledTimes(refreshes ? 1 : 0);
  });

  it('is disabled with the scope tooltip exactly when the row cannot be resent', async () => {
    renderSection([
      invite({ email: 'ok@example.com' }),
      invite({ email: 'no@example.com', accessScope: 'limited', canResend: false }),
    ]);
    expect((resendOf('ok@example.com') as HTMLButtonElement).disabled).toBe(false);
    const blocked = resendOf('no@example.com') as HTMLButtonElement;
    expect(blocked.disabled).toBe(true);
    fireEvent.focus(blocked.parentElement!);
    expect(
      (await screen.findAllByText('Only a Manager can resend a Limited invitation')).length,
    ).toBeGreaterThan(0);
    fireEvent.click(blocked);
    expect(resendInviteAction).not.toHaveBeenCalled();
  });

  it('a problem state makes Resend the secondary button, a healthy one the ghost', () => {
    renderSection([
      invite({ email: 'bounced@example.com', deliveryState: 'bounced' }),
      invite({ email: 'fine@example.com', deliveryState: 'delivered' }),
    ]);
    expect(resendOf('bounced@example.com').className).not.toBe(
      resendOf('fine@example.com').className,
    );
  });
});

describe('on the Members card', () => {
  const roleContext: MemberRoleContextDTO = {
    canManageRoles: true,
    canInvite: true,
    inviteProjects: [],
    orgManagedUserIds: [],
    organizationName: 'moooon',
    customRoles: [],
  };
  const members = [
    {
      userId: 'u-me',
      name: 'Zhu Yue',
      email: 'me@motir.co',
      workspaceRole: 'manager' as const,
      customRole: null,
      accessScope: 'full' as const,
      addedProjectCount: 0,
    },
  ];

  function renderCard(pendingInvites: PendingInviteDTO[] | undefined, canInvite = true) {
    return render(
      <ToastProvider>
        <MembersCard
          workspaceId="ws1"
          workspaceName="Sales"
          members={members}
          currentUserId="u-me"
          roleContext={{ ...roleContext, canInvite }}
          pendingInvites={pendingInvites}
        />
      </ToastProvider>,
      { now: NOW },
    );
  }

  it('sits under the members list when the viewer may invite', () => {
    renderCard([invite({ email: 'p@example.com' })]);
    expect(screen.getByRole('heading', { name: 'Pending invitations' })).toBeTruthy();
  });

  it('is absent with no invites, and absent for a viewer who may not invite', () => {
    renderCard(undefined);
    expect(screen.queryByText('Pending invitations')).toBeNull();
    cleanup();
    renderCard([invite({ email: 'p@example.com' })], false);
    expect(screen.queryByText('Pending invitations')).toBeNull();
    expect(screen.queryByRole('button', { name: /Resend/ })).toBeNull();
  });
});
