// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { REPO_ROOT, stripComments } from '../helpers/importGraph';

// Story MOTIR-4843 · MOTIR-4848 — §6d's CAPABILITY SET, below the reveal.
//
// ⚠️ ASSERTED AS A SET, NOT PER SURFACE, AND THAT IS THE POINT. Progressive
// disclosure hides CONCEPTS and may not remove ABILITIES
// (`docs/decisions/organization-tier.md` §6d: *a hidden tier may not remove a
// capability … relocating a surface preserves its gate*). The way that rule
// fails is never a missing page — it is ONE capability, belonging to the
// smallest customers, that nobody thought to look for after the surface it
// lived on stopped existing. Four green per-surface tests are exactly what that
// failure looks like from the inside.
//
// This story is the worked example: the workspace Job runs route was left out of
// MOTIR-3502's collapse for a defensible reason, kept answering at every count,
// and its absence from `WorkspaceFoldInSection` went unnoticed for months —
// until it was read as an EXEMPTION and nearly written into the plan as one
// (MOTIR-4859). A set assertion is what makes the hole visible.
//
// ⚠️ This card asserts the SET IS COMPLETE. It does NOT re-assert each
// section's gates — the workspace cards own theirs.
//
// ⚠️ THE SET WAS FIVE AND IS FOUR (Story MOTIR-9982 · MOTIR-10042). `Job runs`
// was the fifth, folded in by MOTIR-4861, and it was RETIRED rather than lost:
// decision MOTIR-4896 found the tenant ledger to be operator noise, moved it to
// staff-only `/admin/jobs`, and gave tenants the one thing the dead-letter page
// was their only door for — pending invitations with Resend, on the Members
// card this set already carries. A removal by decision is not the hidden-tier
// omission §6d forbids, and the last describe below pins that it stays gone.

vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}));

const getWorkspaceSummary = vi.fn();
const listMembers = vi.fn();
const getMemberRole = vi.fn();
const getWorkspacePolicy = vi.fn();

vi.mock('@/lib/services/roleMigrationReportService', () => ({
  roleMigrationReportService: { firstPageForViewer: async () => null },
}));
vi.mock('@/lib/services/workspacesService', () => ({
  workspacesService: {
    getWorkspaceSummary: (...a: unknown[]) => getWorkspaceSummary(...a),
    listMembers: (...a: unknown[]) => listMembers(...a),
    getMemberRole: (...a: unknown[]) => getMemberRole(...a),
    // The Members role column's context (MOTIR-6465) — inert here.
    getMemberRoleContext: async () => ({
      canManageRoles: false,
      orgManagedUserIds: [],
      organizationName: 'Acme',
      customRoles: [],
    }),
  },
}));
vi.mock('@/lib/services/twoFactorPolicyService', () => ({
  twoFactorPolicyService: {
    getWorkspacePolicy: (...a: unknown[]) => getWorkspacePolicy(...a),
  },
}));
vi.mock('@/app/(authed)/settings/workspace/security/actions', () => ({
  setWorkspaceRequireTwoFactorAction: vi.fn(),
}));

// The four cards are STUBBED, deliberately. This file asks which sections the
// host mounts, not what each renders — mounting the real ones would test their
// own cards' work and would couple this assertion to their copy.
vi.mock('@/app/(authed)/settings/workspace/_components/NameCard', () => ({
  NameCard: () => <div data-testid="cap-name" />,
}));
vi.mock('@/app/(authed)/settings/workspace/_components/MembersCard', () => ({
  MembersCard: () => <div data-testid="cap-members" />,
}));
vi.mock('@/app/(authed)/settings/workspace/_components/DangerZoneCard', () => ({
  DangerZoneCard: () => <div data-testid="cap-danger" />,
}));
vi.mock('@/app/(authed)/settings/organization/_components/RequireTwoFactorCard', () => ({
  RequireTwoFactorCard: () => <div data-testid="cap-two-factor" />,
}));

// The Roles DOOR (Story MOTIR-6168 · MOTIR-6466) — a link to
// `/settings/workspace/roles`, which answers at every workspace count. It is not
// one of the capabilities the fold-in HOSTS, so it is stubbed apart from the set.
vi.mock('@/app/(authed)/settings/organization/_components/RolesDoorCard', () => ({
  RolesDoorCard: () => <div data-testid="door-roles" />,
}));

import { WorkspaceFoldInSection } from '@/app/(authed)/settings/organization/_components/WorkspaceFoldInSection';

/** The FOUR capabilities a single-workspace org must still reach (Job runs, the fifth, was retired). */
const CAPABILITY_SET = ['cap-name', 'cap-members', 'cap-two-factor', 'cap-danger'] as const;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the below-reveal capability SET — what a plain workspace member can still reach', () => {
  /** A plain org member who is a `member` (not manager) of the one workspace. */
  function seedPlainMember() {
    getWorkspaceSummary.mockResolvedValue({ id: 'ws1', name: 'Acme' });
    listMembers.mockResolvedValue([
      { userId: 'u1', role: 'member' },
      { userId: 'u2', role: 'owner' },
    ]);
    getMemberRole.mockResolvedValue('member');
    getWorkspacePolicy.mockResolvedValue({
      requiresTwoFactor: false,
      lockedByOrganization: false,
      organizationName: null,
    });
  }

  it('hosts all FOUR sections itself — and the set is asserted whole, not one by one', async () => {
    seedPlainMember();
    render(
      await WorkspaceFoldInSection({
        workspaceId: 'ws1',
        actorUserId: 'u1',
        workspaceCount: 1,
        canManageWorkspaces: true,
      }),
    );

    // `toEqual` on the full list rather than four `getByTestId` calls: a missing
    // capability shows up as a DIFF of the set, which is how the omission this
    // file exists for actually reads.
    const mounted = CAPABILITY_SET.filter((id) => screen.queryByTestId(id) !== null);
    expect(mounted).toEqual([...CAPABILITY_SET]);
  });

  it('does so for a plain MEMBER — the gate is workspace membership, never the org role', async () => {
    // §6d's substantive half. MOTIR-3519 moved the org refusal DOWN to the
    // org-scoped cards precisely so a plain org member — which is what a
    // workspace invitee is — could still reach **Leave workspace**, which has no
    // other surface anywhere in the product.
    seedPlainMember();
    render(
      await WorkspaceFoldInSection({
        workspaceId: 'ws1',
        actorUserId: 'u1',
        workspaceCount: 1,
        canManageWorkspaces: true,
      }),
    );
    expect(screen.getByTestId('cap-danger')).toBeTruthy();
    // Nothing in this section's inputs is an org role.
    expect(getMemberRole).toHaveBeenCalledWith('u1', 'ws1');
  });

  it('hosts NOTHING when the workspace vanished between the two reads', async () => {
    // The one arm that legitimately renders no set: the caller resolved the
    // workspace from the actor's own membership list, so a null here means it
    // went away. Not a capability loss — there is no workspace to configure.
    getWorkspaceSummary.mockResolvedValue(null);
    listMembers.mockResolvedValue([]);
    getMemberRole.mockResolvedValue(null);
    getWorkspacePolicy.mockResolvedValue({
      requiresTwoFactor: false,
      lockedByOrganization: false,
      organizationName: null,
    });
    const { container } = render(
      await WorkspaceFoldInSection({
        workspaceId: 'ws1',
        actorUserId: 'u1',
        workspaceCount: 1,
        canManageWorkspaces: true,
      }),
    );
    expect(container.innerHTML).toBe('');
  });
});

// The host page is an async Server Component over a session, a workspace
// context and half a dozen service reads: there is no unit render of it, and
// the seam it owns is one conditional wide. That conditional is exactly what a
// green section test cannot see, so it is asserted from the SOURCE, with
// comments blanked so a sentence about a section is never mistaken for the
// section.
describe('the host page mounts the fold-in on ONE condition, and no Job runs section', () => {
  const source = stripComments(
    readFileSync(join(REPO_ROOT, 'app/(authed)/settings/organization/page.tsx'), 'utf8'),
  );

  it('`WorkspaceFoldInSection` is rendered, and guarded by `foldInWorkspace`', () => {
    expect(source).toMatch(/\{foldInWorkspace \? \(\s*<WorkspaceFoldInSection\b/);
  });

  it('⚠️ it is NOT inside the `isAdmin` branch — that is the whole §6d correction', () => {
    // The failure this guards reads as conservative and is the defect: gating a
    // relocated section on the HOST's org-admin check instead of on the SOURCE
    // surface's membership check closes it to exactly the smallest customers —
    // the only people who ever see the folded-in state at all.
    const adminBranch = source.slice(
      source.indexOf('{isAdmin ? ('),
      source.indexOf('{foldInWorkspace ? ('),
    );
    expect(adminBranch).not.toContain('WorkspaceFoldInSection');
  });

  it('reads ONE `foldInWorkspace`, derived from the reveal predicate', () => {
    // Exactly one guarded mount: the retired `Job runs` section was the second.
    const guards = source.match(/\{foldInWorkspace \? \(/g) ?? [];
    expect(guards).toHaveLength(1);
    expect(source).toMatch(/const foldInWorkspace = isWorkspaceTierRevealed\(/);
  });

  it('hosts no Job runs section and carries no job-dashboard query (MOTIR-9982)', () => {
    expect(source).not.toMatch(/JobRunsFold|JobsPa|jobsParams|workspace\/jobs/);
  });
});
