// @vitest-environment happy-dom
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import {
  PROJECT_SETTINGS_NAV,
  PROJECT_SETTINGS_RETIRED_ROUTES,
  PROJECT_SETTINGS_ROOT,
  settingsEntryViewKey,
  toSettingsNavPermissions,
  visibleSettingsNav,
} from '@/lib/settings/projectSettingsNav';
import { PERMISSIONS } from '@/lib/permissions/catalog';
import { BUILTIN_ROLE_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import {
  SettingsRefusalState,
  resolveSettingsRefusal,
} from '@/app/(authed)/settings/project/_guard';

// Subtask MOTIR-2469 — HIDING IS PRESENTATION AND NEVER PROTECTION.
//
// Once MOTIR-2468's rail stops offering a settings entry, the page behind it is
// still one typed URL, one bookmark and one old link away. The failure mode this
// story has to avoid is an interface that quietly stops offering a page behind
// which the page still works: that would LOOK governed without being it, and the
// first person to find out would find out by accident.
//
// So this guard ENUMERATES THE FILESYSTEM rather than counting pages — the
// technique the shipped route↔registry test already uses (mistake #29). A
// settings page added next year is covered the moment it lands, and the
// assertion needs no number kept up to date to stay true.

const SETTINGS_DIR = join(process.cwd(), 'app/(authed)/settings/project');

/** Every on-disk `settings/project/**​/page.tsx`, as [urlPath, absolute file]. */
function collectPages(dir: string, base: string): [string, string][] {
  const found: [string, string][] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith('_')) continue; // Next ignores `_`-prefixed folders
      found.push(...collectPages(join(dir, entry.name), `${base}/${entry.name}`));
    } else if (entry.name === 'page.tsx') {
      found.push([base, join(dir, entry.name)]);
    }
  }
  return found;
}

// The retired Roles routes only redirect to workspace settings (MOTIR-6466), so
// there is no destination to guard.
const PAGES = collectPages(SETTINGS_DIR, PROJECT_SETTINGS_ROOT).filter(
  ([urlPath]) => !PROJECT_SETTINGS_RETIRED_ROUTES.includes(urlPath),
);

describe('every settings destination is guarded (MOTIR-2469)', () => {
  it('found the settings pages at all — the enumeration is not vacuously empty', () => {
    // A guard that silently walks an empty tree passes forever. This is the
    // tripwire for a moved directory or a renamed route group.
    expect(PAGES.length).toBeGreaterThanOrEqual(PROJECT_SETTINGS_NAV.length);
  });

  it.each(PAGES)('%s calls the shared destination guard', (_urlPath, file) => {
    const source = readFileSync(file, 'utf8');
    // ⚠️ RESTORED 2026-09-13 — the Approvals room is manage-only (MOTIR-4880 re-plan ·
    // MOTIR-5394); MOTIR-5278's browse view is reverted.
    // MOTIR-5278 had widened this pattern so the approvals page could import
    // `settingsEntryKeys` beside the guard. That page imports the guard alone again.
    // MOTIR-6995 widens it again for the one room with a distinct view key
    // (Hosted agent), whose page reads its WRITE key through `settingsEntryKeys`.
    expect(source, `${file} does not import guardSettingsPage`).toMatch(
      /import \{ guardSettingsPage(, settingsEntryKeys)? \} from '\.{1,2}(\/\.\.)*\/_guard';/,
    );
    // Called AND its refusal returned — importing it and ignoring the answer is
    // the shape that would pass a weaker assertion while shipping unguarded.
    expect(source, `${file} does not call guardSettingsPage`).toContain('await guardSettingsPage(');
    expect(source, `${file} does not RETURN the refusal`).toContain('if (refused) return refused;');
  });

  it.each(PAGES)('%s names a real registry entry, and declares no key of its own', (_p, file) => {
    const source = readFileSync(file, 'utf8');
    const called = source.match(/await guardSettingsPage\('([^']+)'/);
    expect(called, `${file}: could not read the guarded entry id`).toBeTruthy();
    const id = called![1]!;
    expect(
      PROJECT_SETTINGS_NAV.some((e) => e.id === id),
      `${file} guards on "${id}", which is not a registry entry`,
    ).toBe(true);
    // The key belongs to the registry. A second copy here is how a row hides on
    // one permission while its page refuses on another — invisible in review,
    // because everything renders and everything refuses.
    for (const key of PERMISSIONS) {
      expect(source, `${file} hardcodes the permission key '${key}'`).not.toContain(`'${key}'`);
    }
  });

  it('every drill-down page inherits its parent entry’s key', () => {
    // The Roles room — the drill-down this test was written for — moved to
    // workspace settings (MOTIR-6466); the rule holds for every drill-down left.
    for (const entry of PROJECT_SETTINGS_NAV) {
      for (const nested of entry.nestedRoutes ?? []) {
        const page = PAGES.find(([p]) => p === nested);
        expect(page, `${nested} has no page`).toBeTruthy();
        expect(readFileSync(page![1], 'utf8')).toContain(`await guardSettingsPage('${entry.id}'`);
      }
    }
  });

  it('every REGISTRY entry has a guarded page, and vice versa', () => {
    // Both directions: a page nothing routes to, and a rail row with no page,
    // are each a way for the guard to look total while missing a destination.
    const guarded = new Set(
      PAGES.map(
        ([, f]) => readFileSync(f, 'utf8').match(/await guardSettingsPage\('([^']+)'/)?.[1],
      ),
    );
    for (const entry of PROJECT_SETTINGS_NAV) {
      expect(guarded.has(entry.id), `no guarded page for registry entry "${entry.id}"`).toBe(true);
    }
  });
});

describe('the refusal copy, per destination (design panel 3)', () => {
  const en = JSON.parse(readFileSync(join(process.cwd(), 'messages/en.json'), 'utf8'));
  const zh = JSON.parse(readFileSync(join(process.cwd(), 'messages/zh.json'), 'utf8'));

  it('every entry has its OWN description — not one apology reused twelve times', () => {
    const copy = en.settings.noAccess.section as Record<string, string>;
    for (const entry of PROJECT_SETTINGS_NAV) {
      expect(copy[entry.id], `no refusal copy for "${entry.id}"`).toBeTruthy();
    }
    const bodies = PROJECT_SETTINGS_NAV.map((e) => copy[e.id]);
    expect(new Set(bodies).size, 'two destinations share a description').toBe(bodies.length);
  });

  it('every en key has its zh twin', () => {
    expect(zh.settings.noAccess.title).toBeTruthy();
    const zhCopy = zh.settings.noAccess.section as Record<string, string>;
    for (const entry of PROJECT_SETTINGS_NAV) {
      expect(zhCopy[entry.id], `no zh twin for "${entry.id}"`).toBeTruthy();
    }
  });

  it('the superseded automation-only copy is gone from BOTH catalogs', () => {
    // It moved into the uniform namespace with the exemplar it came from; two
    // live copies is how the strings drift apart.
    expect(en.settings.automation?.noAccess).toBeUndefined();
    expect(zh.settings.automation?.noAccess).toBeUndefined();
  });
});

describe('the back action never lands on a second refusal', () => {
  // The guard sends the reader to the FIRST entry their own rail offers, not to
  // Details — Details is gated on `project:administer` now, so a hard-wired back
  // link would bounce a board-only actor straight into another refusal.
  it('an actor holding one non-Details domain is sent to a page they CAN open', () => {
    const held = toSettingsNavPermissions(['project:browse', 'board:configure']);
    // ⚠️ RESTORED 2026-09-13 — the Approvals room is manage-only (MOTIR-4880 re-plan ·
    // MOTIR-5394); MOTIR-5278's browse view is reverted.
    // MOTIR-5278 had made this role's first room `approvals`, ahead of Boards.
    const [first] = visibleSettingsNav(held);
    expect(first?.id).toBe('board');
    expect(first?.href).not.toBe(PROJECT_SETTINGS_ROOT);
  });

  // ⚠️ RESTORED 2026-09-13 — the Approvals room is manage-only (MOTIR-4880 re-plan ·
  // MOTIR-5394); MOTIR-5278's browse view is reverted.
  // MOTIR-5278 had moved this case off the built-in MEMBER, who held Approvals.
  it('an actor holding NOTHING in the area has no in-area destination to be sent to', () => {
    // …which is why the guard falls back out of the area entirely for them.
    // MOTIR-8830: the built-in MEMBER no longer qualifies — it holds `project:browse`,
    // the Translation room's view key — so the case is an actor with no keys.
    expect(visibleSettingsNav(toSettingsNavPermissions([]))).toEqual([]);
    expect(visibleSettingsNav(BUILTIN_ROLE_PERMISSIONS.member).map((e) => e.id)).toEqual([
      'translation',
    ]);
  });

  it('an admin is sent to Details, the shipped behaviour', () => {
    const [first] = visibleSettingsNav(BUILTIN_ROLE_PERMISSIONS.admin);
    expect(first?.href).toBe(PROJECT_SETTINGS_ROOT);
  });
});

describe('the refusal DECISION, over every destination × role (MOTIR-2469)', () => {
  // `resolveSettingsRefusal` is the guard with the IO and the JSX taken out, so
  // the whole matrix is assertable without a database. The resolution half — that
  // a seeded role really produces this set — is proven against real Postgres in
  // `tests/settings/settings-area-access-matrix.test.ts`.
  const ROLES = {
    admin: BUILTIN_ROLE_PERMISSIONS.admin,
    member: BUILTIN_ROLE_PERMISSIONS.member,
    viewer: BUILTIN_ROLE_PERMISSIONS.viewer,
  } as const;

  for (const [role, held] of Object.entries(ROLES)) {
    it.each(PROJECT_SETTINGS_NAV.map((e) => [e.id, e] as const))(
      `${role} on %s — the decision follows the entry's own key`,
      (_id, entry) => {
        const refusal = resolveSettingsRefusal(entry.id, held);
        // ⚠️ RESTORED 2026-09-13 — the Approvals room is manage-only (MOTIR-4880 re-plan ·
        // MOTIR-5394); MOTIR-5278's browse view is reverted.
        // MOTIR-5278 had read the entry's VIEW key here.
        // The invariant, stated once: refused EXACTLY when the key is absent.
        // Not "usually", and never on a different key than the rail hid it on.
        // MOTIR-6995 — read through the entry's effective VIEW key: Hosted agent
        // declares `work_item:edit`; every other entry's view key IS `permission`.
        expect(refusal === null).toBe(held.has(settingsEntryViewKey(entry)));
      },
    );
  }

  it('an ADMIN is refused nothing', () => {
    for (const entry of PROJECT_SETTINGS_NAV) {
      expect(resolveSettingsRefusal(entry.id, BUILTIN_ROLE_PERMISSIONS.admin)).toBeNull();
    }
  });

  // ⚠️ RESTORED 2026-09-13 — the Approvals room is manage-only (MOTIR-4880 re-plan ·
  // MOTIR-5394); MOTIR-5278's browse view is reverted.
  // MOTIR-5278 had inverted this to "refused everything but Approvals".
  // MOTIR-6995 — bar ONE room: Hosted agent opens on `work_item:edit`, which a
  // member holds, so a member stands in it read-only (design MOTIR-6991).
  // MOTIR-8830 — and bar Translation, whose view key is `project:browse`.
  it('a MEMBER is refused everything but Environment, Hosted agent and Translation, each with its OWN copy key', () => {
    const admitted = new Set(['environment', 'hosted-agent', 'translation']);
    const refused = PROJECT_SETTINGS_NAV.filter((entry) => !admitted.has(entry.id));
    const keys = refused.map(
      (entry) => resolveSettingsRefusal(entry.id, BUILTIN_ROLE_PERMISSIONS.member)!.descriptionKey,
    );
    expect(keys.every(Boolean)).toBe(true);
    expect(new Set(keys).size, 'two destinations share a copy key').toBe(keys.length);
    expect(resolveSettingsRefusal('hosted-agent', BUILTIN_ROLE_PERMISSIONS.member)).toBeNull();
    expect(resolveSettingsRefusal('translation', BUILTIN_ROLE_PERMISSIONS.member)).toBeNull();
    // Environment's view key is `project:browse` (MOTIR-9966): a member reads it.
    expect(resolveSettingsRefusal('environment', BUILTIN_ROLE_PERMISSIONS.member)).toBeNull();
    // A VIEWER holds `project:browse` too, so it is admitted to Translation as well.
    expect(resolveSettingsRefusal('translation', BUILTIN_ROLE_PERMISSIONS.viewer)).toBeNull();
    // Its refusal copy still exists, for the actor who lacks the view key.
    expect(
      resolveSettingsRefusal('hosted-agent', BUILTIN_ROLE_PERMISSIONS.viewer)!.descriptionKey,
    ).toBe('noAccess.section.hosted-agent');
  });

  it('the back action of a PARTIAL role points at a page that role can open', () => {
    // The trap this exists to prevent: a back button that lands on a second
    // refusal. `Details` is gated now, so it cannot be the hard-wired answer.
    const held = toSettingsNavPermissions(['project:browse', 'board:configure']);
    const refusal = resolveSettingsRefusal('members', held)!;
    // ⚠️ RESTORED 2026-09-13 — the Approvals room is manage-only (MOTIR-4880 re-plan ·
    // MOTIR-5394); MOTIR-5278's browse view is reverted.
    // MOTIR-5278 had sent this role back to Approvals.
    expect(refusal.backHref).toBe('/settings/project/board');
    expect(resolveSettingsRefusal('board', held)).toBeNull();
  });

  // ⚠️ RESTORED 2026-09-13 — the Approvals room is manage-only (MOTIR-4880 re-plan ·
  // MOTIR-5394); MOTIR-5278's browse view is reverted.
  // MOTIR-5278 had sent a MEMBER back to Approvals and moved this case onto an empty
  // set.
  it('the back action leaves the AREA when the actor holds nothing in it', () => {
    const refusal = resolveSettingsRefusal('members', toSettingsNavPermissions([]))!;
    expect(refusal.backHref).toBe('/dashboard');
    expect(refusal.backLabelKey).toBeNull();
  });

  // MOTIR-8830 — a member DOES hold something in the area now (Translation), so
  // the back action stays inside it, on a page that member can open.
  it('a MEMBER refused a destination is sent back to Translation, not out of the area', () => {
    const refusal = resolveSettingsRefusal('members', BUILTIN_ROLE_PERMISSIONS.member)!;
    expect(refusal.backHref).toBe('/settings/project/translation');
    expect(refusal.backLabelKey).not.toBeNull();
  });

  it('throws loudly on an id the registry does not carry', () => {
    // Unreachable through the typed id, but a future registry edit must fail
    // here rather than silently opening a page to everyone.
    expect(() =>
      resolveSettingsRefusal('not-an-entry' as never, toSettingsNavPermissions([])),
    ).toThrow(/No settings registry entry/);
  });
});

describe('the 404-vs-403 posture is NOT flattened (MOTIR-2469)', () => {
  it('a NON-BROWSER is still answered by the area layout, before any page runs', () => {
    // The two refusals are different on purpose and must not collapse: someone
    // who cannot browse the project must not learn that a section exists, while
    // someone who CAN browse and lacks this domain's key gets the named refusal.
    // The layout owns the first and this story does not touch it.
    const layout = readFileSync(
      join(process.cwd(), 'app/(authed)/settings/project/layout.tsx'),
      'utf8',
    );
    expect(layout).toContain('canBrowse');
    expect(layout).toContain('NoAccessState');
    // And it still short-circuits BEFORE rendering children.
    expect(layout.indexOf('if (!canBrowse)')).toBeLessThan(layout.indexOf('return children;'));
  });

  it('the guard itself makes no browse decision — it would be the wrong altitude', () => {
    const guard = readFileSync(
      join(process.cwd(), 'app/(authed)/settings/project/_guard.tsx'),
      'utf8',
    );
    expect(guard).not.toContain('canBrowse');
    expect(guard).not.toContain('ProjectNotFoundError');
  });
});

afterEach(cleanup);

describe('the refusal a person actually reads (MOTIR-2476)', () => {
  // `guardSettingsPage` is IO plus two translation lookups; everything with a
  // decision in it is either `resolveSettingsRefusal` above or this component.
  it('renders the shipped no-access shape, with the copy it was handed', () => {
    renderWithIntl(
      <SettingsRefusalState
        title="Admins only"
        description="Who is on this project is managed by project admins."
        backHref="/settings/project/board"
        backLabel="Boards"
      />,
    );
    expect(screen.getByText('Admins only')).toBeTruthy();
    expect(screen.getByText('Who is on this project is managed by project admins.')).toBeTruthy();
    const back = screen.getByRole('link', { name: 'Boards' });
    expect(back.getAttribute('href')).toBe('/settings/project/board');
  });

  it('offers exactly ONE action — no dead "Request access" button', () => {
    // `NoAccessState`'s own note: notifying an admin needs a backend flow this
    // story does not ship, and a dead button is worse than its honest absence.
    renderWithIntl(
      <SettingsRefusalState
        title="Admins only"
        description="Board configuration is managed by project admins."
        backHref="/dashboard"
        backLabel="Back to projects"
      />,
    );
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });
});
