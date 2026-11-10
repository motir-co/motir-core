import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  groupOrganizationSettingsNav,
  isOrganizationSettingsEntryActive,
  isOrganizationSettingsPath,
  ORGANIZATION_SETTINGS_NAV,
  ORGANIZATION_SETTINGS_NAV_GROUP_ORDER,
  ORGANIZATION_SETTINGS_ROOT,
  ORGANIZATION_SETTINGS_ROUTES,
  visibleOrganizationSettingsNav,
} from '@/lib/settings/organizationSettingsNav';

// Story MOTIR-4669 · MOTIR-4710 — the organisation-settings registry is the single
// source for the area rail, the command-palette deep links, AND this totality
// guard. The suite fails the moment the registry and the filesystem drift apart
// (mistake #29), and pins the two filter axes and the active-detection contract
// the rail relies on. Mirrors `tests/settings/accountSettingsNav.test.ts` (7.8.12)
// and `projectSettingsNav.test.ts` (the 6.5 precedent).

const SETTINGS_DIR = join(process.cwd(), 'app/(authed)/settings/organization');

/** Enumerate the on-disk `settings/organization/**​/page.tsx` routes → URL paths. */
function collectFsRoutes(dir: string, base: string): string[] {
  const routes: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // Next App Router ignores `_`-prefixed folders (private — e.g. _components).
      if (entry.name.startsWith('_')) continue;
      routes.push(...collectFsRoutes(join(dir, entry.name), `${base}/${entry.name}`));
    } else if (entry.name === 'page.tsx') {
      routes.push(base);
    }
  }
  return routes;
}

describe('organizationSettingsNav — totality (route ↔ entry, mistake #29)', () => {
  it('every organisation-settings route has EXACTLY one registry entry, and vice versa', () => {
    // ⚠️ Unlike the ACCOUNT area, the root is INCLUDED. `/settings/account` is a
    // redirect to the first pane; `/settings/organization` is a real page — the
    // section cards, and below the workspace-tier reveal the folded-in workspace
    // sections too — so it is the `organization` entry, exactly as the project
    // area's root is its `details` entry.
    const fsRoutes = collectFsRoutes(SETTINGS_DIR, ORGANIZATION_SETTINGS_ROOT).sort();
    const registryRoutes = ORGANIZATION_SETTINGS_ROUTES.map((e) => e.href).sort();

    // No drift in either direction: a new page without an entry, or an entry
    // without a page, both fail.
    expect(registryRoutes).toEqual(fsRoutes);
  });

  it('⚠️ the `Git` row arrived WITH its route (MOTIR-4680), and is NOT admin-gated', () => {
    // MOTIR-4710 shipped this registry deliberately WITHOUT this row, and a case
    // here said so — because `accountSettingsNav.ts` records what a row that
    // precedes its pane costs: the "reserved slot" mechanism was RETIRED
    // (MOTIR-4324) after the last one flipped, leaving a flag, a rail branch and a
    // filter unreachable from the product. That case has done its job and is
    // REPLACED by this one rather than deleted, so the reasoning survives its
    // occasion.
    //
    // ⚠️ The gate is the substantive half, and it CHANGED with the role model
    // (MOTIR-6312 · the Git-row flag in `design/org-admin/design-notes.md`,
    // approved 2026-09-25). It used to be org-membership-gated for §6's reason —
    // `/settings/workspace/github` checked no role. A Member's abilities now come
    // entirely from their workspace roles (`role-model.md` §1), so the org
    // repository inventory is Owner/Admin reading, and the page's own read gate
    // moved with the row.
    const git = ORGANIZATION_SETTINGS_NAV.find((e) => e.id === 'git');
    expect(git?.href).toBe('/settings/organization/git');
    expect(git?.group).toBe('general');
    expect(git?.orgAdminOnly).toBe(true);
  });

  it('has no duplicate hrefs and no duplicate ids', () => {
    const hrefs = ORGANIZATION_SETTINGS_ROUTES.map((e) => e.href);
    const ids = ORGANIZATION_SETTINGS_NAV.map((e) => e.id);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every entry names a group the order knows about', () => {
    const known = new Set(ORGANIZATION_SETTINGS_NAV_GROUP_ORDER);
    expect(ORGANIZATION_SETTINGS_NAV.filter((e) => !known.has(e.group))).toEqual([]);
  });
});

describe('the two FILTER AXES — what the actor holds, and what this build has', () => {
  const ADMIN = { isOrgAdmin: true, workspaceTierRevealed: true };
  const MEMBER = { isOrgAdmin: false, workspaceTierRevealed: false };
  const MEMBER_REVEALED = { isOrgAdmin: false, workspaceTierRevealed: true };
  const CLOUD = { billingAvailable: true };
  const SELF_HOST = { billingAvailable: false };

  it('an org ADMIN on cloud sees every row', () => {
    const ids = visibleOrganizationSettingsNav(ADMIN, undefined, CLOUD).map((e) => e.id);
    expect(ids).toEqual([
      'organization',
      'git',
      'ai-models',
      'members',
      'security',
      'usage',
      'fleet',
      'billing',
    ]);
  });

  it('a PLAIN org member BELOW the reveal sees `Organisation` alone', () => {
    // The row that must survive, and the reason it carries no admin flag: below
    // the workspace-tier reveal the index page hosts the FOLDED-IN workspace
    // sections (`organization-tier.md` §6d), and a workspace invitee reaches
    // their team roster — and **Leave workspace**, which has no other surface
    // anywhere in the product — only through it. Hiding this row closes the only
    // route to a capability, which is exactly the defect §6d was written to
    // repair.
    // `Git` is gone since the role model (MOTIR-6312, see the registry entry).
    const ids = visibleOrganizationSettingsNav(MEMBER, undefined, CLOUD).map((e) => e.id);
    expect(ids).toEqual(['organization']);
  });

  it('a PLAIN org member ABOVE the reveal sees NO row — the index page 404s for them', () => {
    // MOTIR-6312 · panel 3d: at 2+ workspaces nothing on the org page is theirs,
    // so the row would be a door onto a 404. An Admin keeps it at every count.
    expect(visibleOrganizationSettingsNav(MEMBER_REVEALED, undefined, CLOUD)).toEqual([]);
    expect(visibleOrganizationSettingsNav(ADMIN, undefined, CLOUD).map((e) => e.id)).toContain(
      'organization',
    );
  });

  it('`Billing & plans` is ABSENT off cloud, and `Usage & cost` is not', () => {
    // The route `notFound()`s on a self-host build, so a row would point at a 404.
    // Usage is not commercial and stays — which is what keeps the `billing` group
    // rendered with one row rather than disappearing.
    const ids = visibleOrganizationSettingsNav(ADMIN, undefined, SELF_HOST).map((e) => e.id);
    expect(ids).toContain('usage');
    expect(ids).not.toContain('billing');
  });

  it('`Fleet` sits after Usage & cost, Owner/Admin only and cloud only (MOTIR-10369)', () => {
    // Off cloud there is no fleet meter and the route answers 404, so no row.
    const self = visibleOrganizationSettingsNav(ADMIN, undefined, SELF_HOST).map((e) => e.id);
    expect(self).not.toContain('fleet');
    const member = visibleOrganizationSettingsNav(MEMBER, undefined, CLOUD).map((e) => e.id);
    expect(member).not.toContain('fleet');
    const fleet = ORGANIZATION_SETTINGS_NAV.find((e) => e.id === 'fleet')!;
    expect(fleet).toMatchObject({
      group: 'billing',
      href: '/settings/organization/fleet',
      orgAdminOnly: true,
      cloudOnly: true,
    });
  });

  it('`AI models` sits in General under Git, Owner/Admin only and cloud only (MOTIR-10846)', () => {
    // Off cloud there is no plan tier to qualify on, so the route answers 404.
    const self = visibleOrganizationSettingsNav(ADMIN, undefined, SELF_HOST).map((e) => e.id);
    expect(self).not.toContain('ai-models');
    // A plain member gets no row; the page still serves them the read-only room.
    for (const actor of [MEMBER, MEMBER_REVEALED]) {
      const ids = visibleOrganizationSettingsNav(actor, undefined, CLOUD).map((e) => e.id);
      expect(ids).not.toContain('ai-models');
    }
    const general = groupOrganizationSettingsNav(
      visibleOrganizationSettingsNav(ADMIN, undefined, CLOUD),
    ).find((g) => g.group === 'general');
    expect(general?.entries.map((e) => e.id)).toEqual(['organization', 'git', 'ai-models']);
    expect(ORGANIZATION_SETTINGS_NAV.find((e) => e.id === 'ai-models')).toMatchObject({
      href: '/settings/organization/ai-models',
      labelKey: 'aiModels',
      orgAdminOnly: true,
      cloudOnly: true,
    });
  });

  it('⚠️ BOTH axes DEFAULT CLOSED — a caller that forgets to thread one loses rows', () => {
    // The property that makes a missing prop safe. `visibleSettingsNav` on the
    // project registry defaults closed for the same reason: a surface that forgets
    // the availability flag must drop the row, never offer a door onto a corridor.
    // Since MOTIR-6312 the actor default is a Member ABOVE the reveal, which is
    // the most closed arm there is: no row at all.
    expect(visibleOrganizationSettingsNav().map((e) => e.id)).toEqual([]);
  });
});

describe('grouping — a group with no surviving rows is not rendered', () => {
  it('renders the three groups in order for an admin on cloud', () => {
    const groups = groupOrganizationSettingsNav(
      visibleOrganizationSettingsNav({ isOrgAdmin: true, workspaceTierRevealed: true }, undefined, {
        billingAvailable: true,
      }),
    );
    expect(groups.map((g) => g.group)).toEqual(['general', 'access', 'billing']);
  });

  it('drops the emptied groups entirely — no heading over nothing', () => {
    const groups = groupOrganizationSettingsNav(
      visibleOrganizationSettingsNav(
        { isOrgAdmin: false, workspaceTierRevealed: false },
        undefined,
        { billingAvailable: true },
      ),
    );
    // `access` (Members, Security) and `billing` (Usage & cost, Billing) both
    // empty for a plain member and are dropped with their headings — Usage & cost
    // is Owner/Admin again since the org-roles merge (MOTIR-6167 over MOTIR-6175).
    expect(groups.map((g) => g.group)).toEqual(['general']);
  });

  it('keeps a PARTIALLY filtered group, with its survivors', () => {
    const groups = groupOrganizationSettingsNav(
      visibleOrganizationSettingsNav({ isOrgAdmin: true, workspaceTierRevealed: true }, undefined, {
        billingAvailable: false,
      }),
    );
    const billing = groups.find((g) => g.group === 'billing');
    expect(billing?.entries.map((e) => e.id)).toEqual(['usage']);
  });
});

describe('active detection — the area root needs `exact`', () => {
  const root = ORGANIZATION_SETTINGS_NAV.find((e) => e.id === 'organization')!;
  const members = ORGANIZATION_SETTINGS_NAV.find((e) => e.id === 'members')!;

  it('⚠️ the root row is active on the root ALONE', () => {
    // Every other entry's href is a prefix-sibling under the root's, so without
    // `exact` the `Organisation` row would read as current on all five routes at
    // once and the rail would have no answer to "where am I".
    expect(isOrganizationSettingsEntryActive(root, '/settings/organization')).toBe(true);
    expect(isOrganizationSettingsEntryActive(root, '/settings/organization/members')).toBe(false);
    expect(isOrganizationSettingsEntryActive(root, '/settings/organization/billing')).toBe(false);
  });

  it('a leaf row is active on itself and on anything beneath it', () => {
    expect(isOrganizationSettingsEntryActive(members, '/settings/organization/members')).toBe(true);
    expect(isOrganizationSettingsEntryActive(members, '/settings/organization/members/x')).toBe(
      true,
    );
    expect(isOrganizationSettingsEntryActive(members, '/settings/organization')).toBe(false);
  });

  it('the area predicate covers the root and everything under it — and nothing else', () => {
    expect(isOrganizationSettingsPath('/settings/organization')).toBe(true);
    expect(isOrganizationSettingsPath('/settings/organization/usage')).toBe(true);
    expect(isOrganizationSettingsPath('/settings/project')).toBe(false);
    expect(isOrganizationSettingsPath('/settings/account')).toBe(false);
    // …and NOT a sibling route that merely starts with the same characters.
    expect(isOrganizationSettingsPath('/settings/organizations')).toBe(false);
  });
});
