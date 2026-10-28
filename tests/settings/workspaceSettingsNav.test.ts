import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  groupWorkspaceSettingsNav,
  isWorkspaceSettingsEntryActive,
  isWorkspaceSettingsPath,
  visibleWorkspaceSettingsNav,
  WORKSPACE_SETTINGS_NAV,
  WORKSPACE_SETTINGS_NAV_GROUP_ORDER,
  WORKSPACE_SETTINGS_ROOT,
  WORKSPACE_SETTINGS_ROUTES,
} from '@/lib/settings/workspaceSettingsNav';

// Story MOTIR-4843 · MOTIR-4846 — the workspace-settings registry is the single
// source for the area rail AND this totality guard. The suite fails the moment
// the registry and the filesystem drift apart (mistake #29), and pins the ONE
// filter axis and the active-detection contract the rail relies on. Mirrors
// `tests/settings/organizationSettingsNav.test.ts` (MOTIR-4710).

const SETTINGS_DIR = join(process.cwd(), 'app/(authed)/settings/workspace');

/** Enumerate the on-disk `settings/workspace/**​/page.tsx` routes → URL paths. */
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

describe('workspaceSettingsNav — totality (route ↔ entry, mistake #29)', () => {
  it('every workspace-settings route has EXACTLY one registry entry, and vice versa', () => {
    // The root is INCLUDED, as the organisation and project areas' roots are:
    // `/settings/workspace` is a real page (Name / Members / Danger zone), not a
    // redirect to a first pane the way `/settings/account` is.
    const fsRoutes = collectFsRoutes(SETTINGS_DIR, WORKSPACE_SETTINGS_ROOT).sort();
    // A drill-down's routes (the Roles room's detail / edit / new, MOTIR-6466)
    // are registered on its row, the way the project registry does.
    const registryRoutes = WORKSPACE_SETTINGS_ROUTES.flatMap((e) => [
      e.href,
      ...(e.nestedRoutes ?? []),
    ]).sort();

    // No drift in either direction: a new page without an entry, or an entry
    // without a page, both fail.
    expect(registryRoutes).toEqual(fsRoutes);
    expect(fsRoutes).toHaveLength(8);
  });
});

describe('workspaceSettingsNav — the ONE filter axis, and it defaults closed', () => {
  it('returns EVERY row when the tier is revealed — Roles & permissions under Access (MOTIR-6466)', () => {
    expect(
      visibleWorkspaceSettingsNav(true, undefined, { publicProjectsAvailable: true }).map(
        (e) => e.id,
      ),
    ).toEqual(['workspace', 'security', 'roles', 'public-address', 'jobs']);
  });

  it('drops the cloud-only Public address row off-cloud, and by default (MOTIR-9514)', () => {
    // Off-cloud the room 404s, so the row is ABSENT rather than a door onto it.
    const offCloud = visibleWorkspaceSettingsNav(true, undefined, {
      publicProjectsAvailable: false,
    }).map((e) => e.id);
    expect(offCloud).toEqual(['workspace', 'security', 'roles', 'jobs']);
    expect(visibleWorkspaceSettingsNav(true).map((e) => e.id)).toEqual(offCloud);
  });

  it('returns NO rows below the reveal — not fewer rows, none', () => {
    // ⚠️ This is the assertion the re-plan turns on. An earlier shape of this
    // registry exempted `jobs`, because `/settings/workspace/jobs` answered 200
    // at every workspace count while its siblings 404'd (MOTIR-3502 AC 6). That
    // was an UNFINISHED COLLAPSE, not a decision: it was the one workspace
    // surface with no fold-in. MOTIR-4861 gives it one on
    // `/settings/organization`, so the axis is uniform and the rail below the
    // reveal is EMPTY. MOTIR-4859 is the planning bug.
    expect(visibleWorkspaceSettingsNav(false)).toEqual([]);
  });

  it('DEFAULTS CLOSED — a caller that forgets to thread the predicate gets no rows', () => {
    // The same default-closed discipline `organizationSettingsNav.ts` applies to
    // its own axes: a surface that forgets to thread it drops the row rather
    // than offering a door onto a route that `notFound()`s.
    expect(visibleWorkspaceSettingsNav()).toEqual([]);
  });

  it('has NO role axis — no entry carries an admin-style flag', () => {
    // §6d forbids a relocation that NARROWS a gate. All three routes check a
    // session and a workspace context and no role at all, so a role flag here
    // would take a shipped capability away silently.
    for (const entry of WORKSPACE_SETTINGS_NAV) {
      // A drill-down's `nestedRoutes` (the Roles room, MOTIR-6466) is routing,
      // not a gate; `cloudOnly` (Public address, MOTIR-9514) is the DEPLOYMENT
      // axis — whether the room exists on this build — never a role.
      const keys = Object.keys(entry).filter((k) => k !== 'nestedRoutes' && k !== 'cloudOnly');
      expect(keys.sort()).toEqual(
        entry.exact
          ? ['exact', 'group', 'href', 'icon', 'id', 'labelKey']
          : ['group', 'href', 'icon', 'id', 'labelKey'],
      );
    }
  });
});

describe('workspaceSettingsNav — grouping and active detection', () => {
  it('groups in rail order and renders NO empty group', () => {
    const groups = groupWorkspaceSettingsNav(visibleWorkspaceSettingsNav(true));
    expect(groups.map((g) => g.group)).toEqual(WORKSPACE_SETTINGS_NAV_GROUP_ORDER);
    expect(groups.every((g) => g.entries.length > 0)).toBe(true);
  });

  it('drops EVERY group below the reveal — no empty heading, no disabled row', () => {
    expect(groupWorkspaceSettingsNav(visibleWorkspaceSettingsNav(false))).toEqual([]);
  });

  it('the root is EXACT, so exactly one row reads active on each of the three routes', () => {
    const routes = [
      '/settings/workspace',
      '/settings/workspace/security',
      '/settings/workspace/jobs',
    ];
    for (const pathname of routes) {
      const active = WORKSPACE_SETTINGS_NAV.filter((e) =>
        isWorkspaceSettingsEntryActive(e, pathname),
      );
      expect(active, `exactly one active row at ${pathname}`).toHaveLength(1);
      expect(active[0]!.href).toBe(pathname);
    }
  });

  it('recognises the area, and nothing outside it', () => {
    expect(isWorkspaceSettingsPath('/settings/workspace')).toBe(true);
    expect(isWorkspaceSettingsPath('/settings/workspace/jobs')).toBe(true);
    expect(isWorkspaceSettingsPath('/settings/organization')).toBe(false);
    expect(isWorkspaceSettingsPath('/settings/project')).toBe(false);
    // A sibling route whose path merely STARTS with the root's string must not
    // be swallowed — the guard is a segment boundary, not a prefix.
    expect(isWorkspaceSettingsPath('/settings/workspaces')).toBe(false);
  });
});
