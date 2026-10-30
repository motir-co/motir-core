import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROJECT_SETTINGS_NAV, PROJECT_SETTINGS_ROOT } from '@/lib/settings/projectSettingsNav';
import { PROJECT_NAV_ACCESS } from '@/lib/settings/projectNavAccess';
import { PERMISSIONS, type PermissionKey } from '@/lib/permissions/catalog';

// Story MOTIR-2258 · Subtask MOTIR-2476 — THE STORY GATE.
//
// Five cards each changed one surface and each proved its own half. The defect
// this file exists to catch lives BETWEEN them, and it has an unpleasant
// property: it is invisible from every angle the individual cards can see. If
// the rail hides a settings entry on one permission while the page behind it
// refuses on another, every test passes, every page renders, every refusal is
// polite — and the only symptom is that some people are let into a room they
// should not be in, or kept out of one they were given. Nobody files that bug,
// because nobody knows what they were supposed to see.
//
// So the central assertion here is an AGREEMENT rather than a behaviour, and it
// walks the registry rather than listing what exists today, so a room added next
// year joins it automatically.

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const SETTINGS_DIR = join(ROOT, 'app/(authed)/settings/project');

/** Every on-disk settings `page.tsx`, as [urlPath, repo-relative file]. */
function collectPages(dir: string, base: string): [string, string][] {
  const found: [string, string][] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith('_')) continue;
      found.push(...collectPages(join(dir, entry.name), `${base}/${entry.name}`));
    } else if (entry.name === 'page.tsx') {
      found.push([base, relative(ROOT, join(dir, entry.name))]);
    }
  }
  return found;
}
const PAGES = collectPages(SETTINGS_DIR, PROJECT_SETTINGS_ROOT);

/**
 * Which SERVICE owns each settings destination's writes. Read at MOTIR-2468
 * authoring time by opening each destination; the assertions below re-read the
 * source, so a service that stops asserting its key fails here.
 */
/**
 * Keys a service may assert through a NAMED ALIAS instead of spelling
 * (MOTIR-4243). `projectAccessService.assertCanManage` IS
 * `assertPermission(…, 'project:administer')`, so a service that calls it does
 * assert the key — a literal grep just cannot see it.
 *
 * The value is the QUALIFIED call, never the bare method name: `fields` and
 * `components` have module-private `assertCanManage` helpers of their own that
 * assert entirely different keys, and a bare name would silently accept those.
 * The alias's own meaning is pinned in `tests/settings/projectSettingsNav.test.ts`,
 * at its definition.
 */
const ALIAS_ASSERTS: Partial<Record<PermissionKey, string>> = {
  'project:administer': 'projectAccessService.assertCanManage',
};

const SERVICE_OF: Record<string, string> = {
  details: 'lib/services/projectAccessService.ts',
  repositories: 'lib/services/projectRepoSetService.ts',
  // MOTIR-9966 — the Environment room's writes (`set`, `delete`) assert
  // `repository:manage`, spelled literally in `environmentConfigService`.
  environment: 'lib/services/environmentConfigService.ts',
  // MOTIR-10037 — the Production room's one write, Roll back, asserts
  // `project:administer`, spelled literally in `productionRollbackService`; its
  // READ asserts the entry's VIEW key, `project:browse`, which VIEW_KEY_EVIDENCE pins.
  production: 'lib/services/productionRollbackService.ts',
  monitoring: 'lib/services/monitorConnectionService.ts',
  members: 'lib/services/projectMembersService.ts',
  'public-page': 'lib/services/projectsService.ts',
  // MOTIR-4221. The room's WRITES are the customer-domain lifecycle's —
  // add / verify / remove — every one of which asserts `project:manage_access`. The subdomain half of the same room is
  // gated on the WORKSPACE role instead (`publicSubdomainService`), which is a
  // different axis and not expressible as a project permission at all; the
  // rail names the project key its destination checks, which is this one.
  'public-address': 'lib/services/customDomainService.ts',
  'code-access': 'lib/services/projectRepoAccessService.ts',
  workflow: 'lib/services/workflowsService.ts',
  // ⚠️ RESTORED 2026-09-13 — the Approvals room is manage-only (MOTIR-4880 re-plan ·
  // MOTIR-5394); MOTIR-5278's browse view is reverted.
  // MOTIR-5278 had said its READ asserted `project:browse` instead.
  // MOTIR-4925 · MOTIR-5170. The room's writes are `updateSettings`, and its
  // READ asserts the same key — both through `projectAccessService`, which is
  // why the literal `'workflow:manage'` is greppable here with no alias row.
  approvals: 'lib/services/approvalGateSettingsService.ts',
  board: 'lib/services/boardsService.ts',
  estimation: 'lib/services/estimationService.ts',
  fields: 'lib/services/customFieldsService.ts',
  components: 'lib/services/componentsService.ts',
  // MOTIR-4938 — the Bugs room's read and write both assert `project:administer`,
  // spelled literally in `getSettings` / `setDestination`.
  bugs: 'lib/services/bugDestinationService.ts',
  'ai-planning': 'lib/services/projectAiSettingsService.ts',
  // MOTIR-6995 — the Hosted agent room's write (`update`) asserts `ai:configure`;
  // its READ asserts the entry's distinct VIEW key, `work_item:edit`, which
  // `tests/settings/projectSettingsNav.test.ts`'s VIEW_KEY_EVIDENCE pins.
  'hosted-agent': 'lib/services/projectHostedAgentSettingsService.ts',
  // MOTIR-8830 — the Translation room: `updateSettings` asserts `project:administer`
  // (the rail's write key); `getSettings` asserts the entry's VIEW key,
  // `project:browse`, which VIEW_KEY_EVIDENCE pins.
  translation: 'lib/services/projectAutoTranslateSettingsService.ts',
  automation: 'lib/services/automationRulesService.ts',
};

describe('the three-way key agreement — rail ↔ page ↔ service (MOTIR-2476)', () => {
  it('is TOTAL over the registry — a new entry joins it without an edit here', () => {
    expect(Object.keys(SERVICE_OF).sort()).toEqual(PROJECT_SETTINGS_NAV.map((e) => e.id).sort());
  });

  it.each(PROJECT_SETTINGS_NAV.map((e) => [e.id, e] as const))(
    '%s — the rail, the page and the service name the SAME key',
    (id, entry) => {
      // 1 · THE RAIL. What `visibleSettingsNav` hides the row on.
      const railKey = entry.permission;

      // 2 · THE PAGE. Which registry entry it guards on — the page never names a
      //     key itself (MOTIR-2469), so agreement is by construction here and
      //     this asserts the construction is still what ships.
      const page = PAGES.find(([, file]) => {
        const source = readFileSync(join(ROOT, file), 'utf8');
        return source.includes(`await guardSettingsPage('${id}'`);
      });
      expect(page, `no guarded page resolves to registry entry "${id}"`).toBeTruthy();

      // 3 · THE SERVICE. The key the destination's own writes assert.
      const service = read(SERVICE_OF[id]!);
      if (ALIAS_ASSERTS[railKey] && !service.includes(`'${railKey}'`)) {
        // The service asserts the key through an ALIAS that does not spell it
        // (MOTIR-4243) — see ALIAS_ASSERTS, and the pin below.
        expect(
          service,
          `${SERVICE_OF[id]} neither names '${railKey}' nor reaches it through ` +
            `${ALIAS_ASSERTS[railKey]} — the rail now hides "${id}" on a key its own ` +
            'service does not check.',
        ).toContain(`${ALIAS_ASSERTS[railKey]}(`);
      } else {
        expect(
          service,
          `${SERVICE_OF[id]} no longer asserts '${railKey}' — the rail now hides ` +
            `"${id}" on a key its own service does not check.`,
        ).toContain(`'${railKey}'`);
      }
    },
  );

  // The Roles room left project settings for the workspace (Story MOTIR-6168 ·
  // MOTIR-6466): its four old routes have no rail row and so no key to agree
  // on — each is a permanent redirect, and none guards on a registry entry.
  it('the retired Roles routes carry no gate of their own — each permanently redirects', () => {
    const retired = PAGES.filter(([p]) => p.includes('/roles'));
    expect(retired).toHaveLength(4);
    for (const [, file] of retired) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      expect(source, file).not.toContain('guardSettingsPage(');
      expect(source, file).toContain('permanentRedirect(');
    }
  });
});

describe('no second gating list — every gated surface resolves through its registry', () => {
  const SIDEBAR = read('app/(authed)/_components/SidebarNav.tsx');
  const PALETTE = read('app/(authed)/_components/AppCommandPalette.tsx');

  // ⚠️ THESE THREE MATCH A PREFIX, NOT A WHOLE CALL — CHANGED BY MOTIR-4243, and
  // the reason is worth stating so the next widening does not read as a
  // loosening. They asserted the exact strings `visibleSettingsNav(held)` /
  // `hasVisibleSettingsArea(held)` / `visibleSettingsNav(held, PROJECT_SETTINGS_ROUTES)`,
  // which pinned the ARITY as a side effect of pinning the SOURCE. The registry
  // now takes a second axis — what this BUILD has, beside what the actor holds —
  // so every one of those calls grew an argument. What these tests are for is
  // that the gated surfaces read the registry rather than keeping a list of
  // their own; the prefix is exactly that claim, and the arity is pinned where
  // it belongs, in the registry's own suite.
  it('the settings rail reads the registry', () => {
    expect(SIDEBAR).toContain('visibleSettingsNav(held, PROJECT_SETTINGS_NAV, availability)');
    // ⚠️ AMENDED (MOTIR-5319): the door's VISIBILITY and its DESTINATION are now
    // ONE `visibleSettingsNav` read — it renders when that list has a first entry
    // and links to it — so the separate `hasVisibleSettingsArea(held, availability)`
    // call this pinned is gone from the sidebar. The predicate itself is still
    // asserted equal to "the filter is non-empty" by the access-matrix suite, so
    // the claim this line made (the door reads the registry) is unchanged.
    expect(SIDEBAR).toContain(
      'const settingsDoorHref = visibleSettingsNav(held, PROJECT_SETTINGS_NAV, availability)[0]?.href',
    );
  });

  it('the palette settings block reads the SAME registry', () => {
    expect(PALETTE).toContain('visibleSettingsNav(held, PROJECT_SETTINGS_ROUTES, {');
  });

  it('BOTH gated surfaces filter on the DEPLOYMENT axis too, not only on the actor', () => {
    // The failure this catches: a surface that reads the registry correctly and
    // then offers a room the build does not have. It is invisible to the three
    // assertions above, because such a surface reads the registry perfectly.
    for (const source of [SIDEBAR, PALETTE]) {
      expect(source).toContain('publicProjectsAvailable');
      // MOTIR-6995 — the registry's second build axis.
      expect(source).toContain('hostedRunsAvailable');
    }
  });

  it('the project nav and the palette navigations read the SAME map', () => {
    expect(SIDEBAR).toContain('canOfferNavDestination(item.href, held)');
    expect(PALETTE).toContain('canOfferNavDestination(href, held)');
  });

  it('neither surface spells a settings route or a permission key by hand', () => {
    for (const source of [SIDEBAR, PALETTE]) {
      for (const entry of PROJECT_SETTINGS_NAV) {
        // The area ROOT is exempt: it is the door's own destination, and the
        // sidebar now names it as `PROJECT_SETTINGS_ROOT` rather than a literal
        // (a one-line change this guard is what prompted).
        if (!entry.href || entry.href === PROJECT_SETTINGS_ROOT) continue;
        expect(source).not.toContain(`'${entry.href}'`);
      }
      for (const key of PERMISSIONS) {
        expect(source, `a gated surface hardcodes '${key}'`).not.toContain(`'${key}'`);
      }
    }
  });

  it('the nav map covers every destination BOTH surfaces offer', () => {
    const known = new Set(PROJECT_NAV_ACCESS.map((e) => e.href));
    expect(known.size).toBe(PROJECT_NAV_ACCESS.length);
  });
});

describe('no legacy boolean survives, repo-wide', () => {
  /** Every `.ts`/`.tsx` under the app's own source roots. */
  function sources(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) sources(path, acc);
      else if (/\.tsx?$/.test(entry.name)) acc.push(path);
    }
    return acc;
  }
  const FILES = ['app', 'components', 'lib'].flatMap((d) => sources(d));

  /**
   * Strip comments before matching. A guard that reads PROSE reports the
   * paragraphs explaining why a component does NOT use this context — which is
   * a false positive that teaches people to loosen the guard.
   */
  const code = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('found the source tree — the sweep is not walking an empty directory', () => {
    expect(FILES.length).toBeGreaterThan(500);
  });

  it('nothing reads canEdit or canManage off the project-access context', () => {
    // The sweep is SELF-RECOUNTING: a consumer added between planning and running
    // cannot be missed by a stale count, because this walks the tree.
    const offenders = FILES.filter((file) => {
      const source = code(read(file));
      if (!source.includes('useProjectAccess')) return false;
      return /useProjectAccess\(\)[^;]*\b(canEdit|canManage)\b|\{\s*[^}]*\b(canEdit|canManage)\b[^}]*\}\s*=\s*useProjectAccess/.test(
        source,
      );
    });
    expect(offenders).toEqual([]);
  });

  it('the context type offers only `can`', () => {
    const provider = read('app/(authed)/_components/ProjectAccessProvider.tsx');
    const shape = provider.split('interface ProjectAccessContextValue {')[1]!.split('}')[0]!;
    expect(shape).toContain('can:');
    expect(shape).not.toContain('canEdit');
    expect(shape).not.toContain('canManage');
  });
});

describe('hiding never became enforcement (MOTIR-2476)', () => {
  // The honest fear about moving access decisions closer to the surface is that
  // enforcement follows them out of the services, where it stops being
  // enforcement. This pins the server-side gate population so that cannot happen
  // by accident — a card that drops a gate has to change this number on purpose.
  const GATE = /projectAccessService\.(assertPermission|assertCan[A-Za-z]+)\(/g;

  function serverSources(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) serverSources(path, acc);
      else if (/\.ts$/.test(entry.name)) acc.push(path);
    }
    return acc;
  }

  const SERVER = [...serverSources('lib/services'), ...serverSources('app/api')];

  it('every settings destination’s service still calls the shared gate', () => {
    // Deliberately NOT a total count of call sites: this repo's services change
    // for a hundred unrelated reasons and a brittle number would be silenced
    // rather than read (`notes.html` #231 — a guard nobody trusts is a guard
    // nobody keeps). What is pinned is the property that matters to THIS story.
    for (const [id, file] of Object.entries(SERVICE_OF)) {
      const source = read(file);
      if (file.endsWith('projectAccessService.ts')) {
        // `details` is gated by the module that DEFINES the gate, so it cannot
        // call itself through the namespace. Assert it still exports the gate.
        expect(source, 'projectAccessService no longer exports assertPermission').toContain(
          'async assertPermission(',
        );
        continue;
      }
      expect(source.match(GATE), `${file} (${id}) calls no shared gate at all`).toBeTruthy();
    }
  });

  it('no gate moved into the PRESENTATION layer', () => {
    // A component that calls the service gate directly is enforcement in the
    // wrong place: it runs on data the client already has, and it can be skipped.
    const clientFiles = [
      ...sourcesUnder('app/(authed)/_components'),
      ...sourcesUnder('components'),
    ];
    for (const file of clientFiles) {
      const source = read(file);
      if (!source.includes("'use client'")) continue;
      expect(source, `${file} calls a server gate from a client component`).not.toMatch(GATE);
    }
  });

  function sourcesUnder(dir: string): string[] {
    const acc: string[] = [];
    const walk = (d: string) => {
      for (const entry of readdirSync(join(ROOT, d), { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const path = `${d}/${entry.name}`;
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name)) acc.push(path);
      }
    };
    walk(dir);
    return acc;
  }

  it('the server tree is non-empty — the pin is not vacuous', () => {
    expect(SERVER.length).toBeGreaterThan(50);
  });
});

describe('the settings guard never decides BROWSE — the 404 arm stays the layout’s', () => {
  it('the guard tests a domain key and nothing else', () => {
    const guard = read('app/(authed)/settings/project/_guard.tsx');
    expect(guard).toContain('getPermissions');
    // Collapsing the two refusals would let someone who cannot browse the project
    // learn that a section exists.
    expect(guard).not.toContain('canBrowse');
    expect(guard).not.toContain('ProjectNotFoundError');
  });

  it('and the layout still answers a non-browser first', () => {
    const layout = read('app/(authed)/settings/project/layout.tsx');
    expect(layout.indexOf('if (!canBrowse)')).toBeGreaterThan(-1);
    expect(layout.indexOf('if (!canBrowse)')).toBeLessThan(layout.indexOf('return children;'));
  });
});

describe('the partial-administrative-domain case, asserted where it is assertable today', () => {
  // No built-in role holds ONE administrative key without the other eleven, so
  // the live walkthrough is MOTIR-2257's. This is the honest interim: the same
  // capability, over a set constructed by hand, so it does not go unverified for
  // a whole story.
  const held = new Set<PermissionKey>(['project:browse', 'board:configure']);

  it('the rail yields Board and omits Members', async () => {
    const { visibleSettingsNav } = await import('@/lib/settings/projectSettingsNav');
    const ids = visibleSettingsNav(held).map((e) => e.id);
    expect(ids).toContain('board');
    expect(ids).not.toContain('members');
  });

  it('the destination guard REFUSES /settings/project/members for the same actor', async () => {
    const { resolveSettingsRefusal } = await import('@/app/(authed)/settings/project/_guard');
    expect(resolveSettingsRefusal('members', held)).not.toBeNull();
    expect(resolveSettingsRefusal('board', held)).toBeNull();
  });

  it('and the area door opens, because ONE room is enough', async () => {
    const { hasVisibleSettingsArea } = await import('@/lib/settings/projectSettingsNav');
    expect(hasVisibleSettingsArea(held)).toBe(true);
  });
});
