import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERMISSION_CATALOG, type PermissionKey } from '@/lib/permissions/catalog';

// THE STORY TEST GATE for MOTIR-2256 (Subtask MOTIR-2302) — the ARCHITECTURE half.
//
// This story's characteristic failure is not an untested branch. It is a policy
// answer derived somewhere the model does not know about, and a coverage number
// is blind to that by construction: a module-private `assertCanManage` that
// re-derives the admin rule from scratch is fully covered by its own service's
// tests and still wrong. Six of them existed when this story started —
// `projectMembersService`, `componentsService`, `customFieldsService`,
// `boardsService`, `workflowsService`, `estimationService` — plus
// `workItemsService`, found by the first guard below and folded in rather than
// exempted. They agreed with `lib/permissions/resolve.ts` by coincidence, and
// nothing kept them that way.
//
// So the guards here answer three questions no coverage report can:
//   1. does anything still derive an administrative answer for itself?
//   2. is every administrative key actually WIRED, not merely marked enforced?
//   3. did the split OVER-tighten — is a read now behind a manage key?
//
// (2) and (3) plus the route→service→gate seams run against real Postgres in
// `storyGate.integration.test.ts`; this file is the pure, filesystem half.

const ROOT = join(__dirname, '..', '..');

/** The twelve administrative keys MOTIR-2256 splits out of `project:administer`. */
const ADMINISTRATIVE_KEYS: readonly PermissionKey[] = [
  'member:manage',
  'project:manage_access',
  'board:configure',
  'workflow:manage',
  'automation:manage',
  'field:manage',
  'component:manage',
  'label:manage',
  'estimation:manage',
  'repository:manage',
  'repository:manage_access',
  'ai:configure',
];

function walk(dir: string, hit: (p: string) => void): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, hit);
    else hit(p);
  }
}

/**
 * Every `.ts`/`.tsx` under `lib/` and `app/`, read ONCE at module load with its
 * comments already stripped.
 *
 * ⚠️ COMPUTED ONCE, DELIBERATELY. The first version re-read the tree and
 * re-stripped comments inside each guard's loop — 12 keys × ~1,500 files × 10 MB
 * of lazy block-comment matching — and the suite HUNG rather than failing, which is
 * the same shape `noUngovernedOperation.test.ts` records about its own shared
 * `g`-flagged regex. A guard that cannot finish is worse than one that is absent,
 * because it looks like infrastructure trouble rather than a test to fix.
 */
const SOURCES: { path: string; code: string }[] = (() => {
  const out: { path: string; code: string }[] = [];
  for (const root of ['lib', 'app']) {
    walk(join(ROOT, root), (p) => {
      if (!p.endsWith('.ts') && !p.endsWith('.tsx')) return;
      out.push({
        path: relative(ROOT, p).replace(/\\/g, '/'),
        code: stripComments(readFileSync(p, 'utf8')),
      });
    });
  }
  return out;
})();

/**
 * Strip comments so a file that DESCRIBES a policy derivation — every one of the
 * adapters this story wrote does, at length — is not mistaken for one that
 * PERFORMS it. Without this the guard fires on its own documentation, which is
 * the fastest way to get a guard deleted.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * The modules ALLOWED to derive a policy answer: the permission model itself and
 * the predicate façade over it.
 */
const POLICY_OWNERS = [
  'lib/permissions/catalog.ts',
  'lib/permissions/builtinRoles.ts',
  'lib/permissions/resolve.ts',
  'lib/projects/access.ts',
  // The two role predicates the model is BUILT FROM. They define
  // `isWorkspaceManager` / `isOwnerRole`; they do not decide anything.
  'lib/projects/roles.ts',
  'lib/workspaces/roles.ts',
];

/**
 * Known-legitimate derivations, BY NAME with a reason — never a directory glob.
 * A glob is a place to put things you would rather not think about, and it grows
 * until the guard means nothing (the same argument
 * `noUngovernedOperation.test.ts` makes about its allowlist).
 *
 * Every entry here is a domain OUTSIDE MOTIR-2256's twelve keys. When MOTIR-2291
 * wires `sprint:manage`, `report:view` and `saved_filter:manage`, its cards delete
 * these lines — which is exactly the signal this list is meant to carry, and the
 * `sprintsService` line is the first one MOTIR-2350 collected.
 *
 * `lib/savedFilters/access.ts` left with MOTIR-5293. Its entry said the file
 * answered a per-ROW question and stayed — right about ownership, wrong about the
 * "admin" half, which was a role read (`isWorkspaceManager || projectRole ===
 * 'admin'`) no custom role could ever hold. That half is now
 * `saved_filter:manage_any`, the file derives nothing, and the staleness test
 * below would have failed on the entry had it stayed.
 */
const ALLOWED_DERIVATIONS: { file: string; why: string }[] = [
  {
    file: 'lib/services/jobsDashboardService.ts',
    why: 'a WORKSPACE-level jobs dashboard, gated on the workspace role. No project is resolved, so no project permission can govern it (the `repository:connect` argument, MOTIR-2294)',
  },
  {
    file: 'lib/services/publicSubdomainService.ts',
    why: "a WORKSPACE's public address (MOTIR-4221), gated on the workspace role — the Manager (Story MOTIR-6168 · MOTIR-6462; it was a `['owner','admin']` set before, which the patterns could not see). The address names the whole workspace, so no project permission can govern it — the `jobsDashboardService` argument",
  },
  {
    file: 'lib/services/twoFactorPolicyService.ts',
    why: 'a WORKSPACE-level and ORGANIZATION-level security policy (Story MOTIR-1215 · MOTIR-3645), gated on the workspace / org role. It resolves no project, so no project permission can govern it — the `jobsDashboardService` argument. Reading the policy needs no role at all; only SETTING it is gated, and that gate is the tier admin',
  },
];

/**
 * The shapes that DERIVE an administrative answer. Deliberately narrow: each is
 * the actor's OWN membership being tested, not a target's role being read (
 * `projectMembersService`'s last-admin guard reads `existing.role === 'admin'`
 * about the PERSON BEING CHANGED, which is business logic, not a gate).
 */
const DERIVATION_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'isWorkspaceManager(...) used as a gate', re: /\bisWorkspaceManager\s*\(/ },
  { label: 'isOwnerRole(...) used as a gate', re: /\bis(?:Legacy)?OwnerRole\s*\(/ },
  {
    label: "the actor's own membership compared to 'admin'",
    re: /\b(?:ws|project|workspace)?[Mm]embership\??\.role\s*===\s*'admin'/,
  },
];

/**
 * The RENDER-SIDE derivations still living in `app/(authed)/**` — a page working
 * out `canManage` / `isAdmin` to decide whether to draw an editable control.
 *
 * ⚠️ PINNED, NOT EXEMPTED, and the difference matters. These are not a second
 * SERVER policy: every one of them sits in front of a surface whose writes are
 * gated by `assertPermission`, so a page that guesses wrong shows the wrong
 * affordance and the server still refuses. That makes them a UI-consistency
 * problem rather than a security one — which is precisely why hiding what an
 * actor cannot reach is MOTIR-2258's story and not this one's.
 *
 * The list is exact, so a NEW one fails this suite, and MOTIR-2258's definition
 * of done is that it reaches zero. An exception list would have let the set grow
 * quietly; a pin makes it a worklist.
 */
const UI_AFFORDANCE_DERIVATIONS = [
  // ⚠️ MOTIR-2258 EMPTIED THE PROJECT HALF, which is what this pin was written
  // to be a worklist for. Seven entries left in one story: the six project-
  // settings pages and the work-item detail page each derived `canManage` /
  // `isAdmin` for themselves, and each is now reached only by an actor who holds
  // the key its own registry entry names (MOTIR-2469's destination guard), so the
  // affordance question the derivation answered has already been answered by the
  // gate above it.
  //
  // Worth recording that the pin found MORE than the cards did. MOTIR-2469 named
  // three pages, grepped on the membership-comparison shape; `board`,
  // `estimation` and `workflow` used `isOwnerRole` instead — a WORKSPACE-owner
  // check standing in for "may configure this", both a second policy and a
  // tighter one than the key their services assert. This guard is the reason
  // they were found, and it is exactly the worklist behaviour its author
  // intended.
  //
  // The jobs dashboard's `isOwnerRole` was the one survivor of that sweep,
  // pinned in the tenant jobs pane; it LEFT with the tenant Job runs surface (Story
  // MOTIR-9982 · MOTIR-10043), which retired the page rather than fixing it.
  // ⚠️ Story MOTIR-1215 · Subtask MOTIR-3647 — the require-2FA switch, at the
  // workspace tier and in its organization-tier fold-in. Both derive
  // `isWorkspaceManager` for the reason the retired jobs page did, and the
  // same reason keeps them out of MOTIR-2258's reach: the question is a
  // WORKSPACE-tier role, so no project permission could govern it either way.
  //
  // They are affordance-only in the strict sense this pin means. The control is
  // rendered READ-ONLY rather than hidden for somebody who may not set it (the
  // card's own decision — a member should see the policy that governs them), and
  // the write is refused by `twoFactorPolicyService.setWorkspacePolicy`, which
  // asserts the role server-side and is covered by
  // `tests/twoFactorPolicy.test.ts`. A page that guessed wrong would draw an
  // enabled switch that the server then refuses.
  'app/(authed)/settings/organization/_components/WorkspaceFoldInSection.tsx',
  'app/(authed)/settings/workspace/security/page.tsx',
];

function derivations(): { path: string; label: string }[] {
  const allowed = new Set([...POLICY_OWNERS, ...ALLOWED_DERIVATIONS.map((a) => a.file)]);
  const found: { path: string; label: string }[] = [];
  for (const { path, code } of SOURCES) {
    if (allowed.has(path)) continue;
    for (const { label, re } of DERIVATION_PATTERNS) {
      if (re.test(code)) found.push({ path, label });
    }
  }
  return found;
}

describe('guard 1 — nothing derives an administrative answer for itself', () => {
  it('NO SERVER-side policy derivation survives outside the model', () => {
    // The hard tier. A second implementation of the policy under `lib/` is the
    // failure this story exists to end — six of them were deleted here, and the
    // seventh (`workItemsService`) was found by this very assertion.
    const offenders = derivations()
      .filter((d) => d.path.startsWith('lib/'))
      .map((d) => `${d.path} — ${d.label}`);
    expect(
      offenders,
      'a file under lib/ outside lib/permissions/** and lib/projects/access.ts derives an ' +
        'administrative answer for itself. Route it through ' +
        'projectAccessService.assertPermission, or add it to ALLOWED_DERIVATIONS by NAME with a ' +
        'reason — never a directory glob.',
    ).toEqual([]);
  });

  it('the RENDER-side derivations are exactly the pinned set — MOTIR-2258 empties it', () => {
    const found = [
      ...new Set(
        derivations()
          .filter((d) => d.path.startsWith('app/'))
          .map((d) => d.path),
      ),
    ].sort();
    expect(
      found,
      'a page derives an administrative answer to decide what to DRAW. That is not a second ' +
        'server policy (the writes are gated either way), but it is the drift that makes the UI ' +
        'and the server disagree — MOTIR-2258 owns removing them. Adding one is a regression; ' +
        'removing one means updating UI_AFFORDANCE_DERIVATIONS in the same change.',
    ).toEqual([...UI_AFFORDANCE_DERIVATIONS].sort());
  });

  it('every named exception still EXISTS and still derives — a stale allowance is a lie', () => {
    // An exception whose file was deleted or already fixed makes the list read as
    // "we looked and decided", when nobody has looked since. It must fail.
    for (const { file } of ALLOWED_DERIVATIONS) {
      const code = stripComments(readFileSync(join(ROOT, file), 'utf8'));
      const derives = DERIVATION_PATTERNS.some((p) => p.re.test(code));
      expect(derives, `${file} no longer derives a policy answer — delete its exception`).toBe(
        true,
      );
    }
  });

  it("the ACCESS SERVICE answers no ROLE question on a caller's behalf (MOTIR-5292)", () => {
    // `projectAccessService.ts` is an allowed derivation because it RESOLVES the
    // model — which also made it the one place a role check could be laundered
    // past every pattern above. `isWorkspaceManagerFor` was exactly that: a method
    // whose whole body was `return isWorkspaceManager(inputs.workspaceRole)`,
    // asked by `approvalGatesService` as the approval escape hatch, so the gate
    // decided on a ROLE while the guard saw only a call into the allowed file.
    // A caller that needs such an answer needs a permission key instead.
    const ROLE_VERDICT =
      /\breturn\s+(?:await\s+)?(?:isWorkspaceManager|is(?:Legacy)?OwnerRole)\s*\(/;
    const code = stripComments(
      readFileSync(join(ROOT, 'lib/services/projectAccessService.ts'), 'utf8'),
    );
    expect(
      ROLE_VERDICT.test(code),
      'projectAccessService returns a bare role predicate as its answer — that is a role gate ' +
        'handed to its caller. Give the operation a catalog key and ask hasPermission instead.',
    ).toBe(false);

    // Positive control: the deleted method's own shape is caught…
    const laundered = `
      async isWorkspaceManagerFor(projectId, ctx, tx) {
        const inputs = await resolveInputs(projectId, ctx, tx);
        return isWorkspaceManager(inputs.workspaceRole);
      },
    `;
    expect(ROLE_VERDICT.test(stripComments(laundered))).toBe(true);
    // …and the resolution's own branch on the role, which is the MODEL, is not.
    expect(ROLE_VERDICT.test('if (isWorkspaceManager(workspaceRole)) return projects;')).toBe(
      false,
    );
  });

  it('THE GUARD CAN ACTUALLY FAIL — a synthetic derivation is caught, and prose is not', () => {
    // Positive control: the real shape, in code.
    const offending = `
      const m = await workspaceMembershipRepository.findByUserAndWorkspace(userId, workspaceId);
      if (!isOwnerRole(m?.role)) throw new SomeForbiddenError();
    `;
    expect(DERIVATION_PATTERNS.some((p) => p.re.test(stripComments(offending)))).toBe(true);

    // Negative control 1: the SAME words inside a comment. Every adapter this
    // story wrote documents the gate it replaced, so a guard that fires on prose
    // fires on its own evidence and gets deleted.
    const documented = `
      /**
       * Until this card the body resolved isOwnerRole(membership?.role) — the
       * workspace OWNER, and nobody else.
       */
      await projectAccessService.assertPermission(projectId, ctx, 'board:configure');
    `;
    expect(DERIVATION_PATTERNS.some((p) => p.re.test(stripComments(documented)))).toBe(false);

    // Negative control 2: reading the TARGET's role is business logic, not a gate
    // (the last-admin guard in projectMembersService).
    const lastAdminGuard = `if (existing.role === 'admin' && role !== 'admin') { … }`;
    expect(DERIVATION_PATTERNS.some((p) => p.re.test(stripComments(lastAdminGuard)))).toBe(false);
  });
});

describe('guard 2 — every administrative key is ENFORCED and actually WIRED', () => {
  it('marks all twelve `enforcement: enforced`', () => {
    for (const key of ADMINISTRATIVE_KEYS) {
      expect(PERMISSION_CATALOG[key].enforcement, `${key} is still planned`).toBe('enforced');
    }
  });

  it('finds each of the twelve as a LITERAL in a gate call outside tests/', () => {
    // The orphan guard at full strength for this story's keys: a card can mark a
    // key enforced and forget to wire it, and nothing else would notice — the
    // catalog would advertise a permission no gate consults, which is exactly the
    // lie `lib/permissions/catalog.ts`'s opening rule forbids.
    const sources = SOURCES.filter(
      (f) => !f.path.startsWith('lib/permissions/') && !f.path.includes('/dto/'),
    );
    const unwired: string[] = [];
    for (const key of ADMINISTRATIVE_KEYS) {
      // A plain substring test, not a regex: the key is a fixed string, and the
      // shape that matters is that some non-model file NAMES it.
      const wired = sources.some((f) => f.code.includes(`'${key}'`));
      if (!wired) unwired.push(key);
    }
    expect(
      unwired,
      'these keys are marked `enforced` but appear in no gate call — either wire them or mark ' +
        'them `planned` again',
    ).toEqual([]);
  });

  // ⚠️ RETIRED BY MOTIR-2356. The control needed a key that was justified by the
  // inventory and deliberately unwired, and there is no longer one — every key in
  // the catalog is `enforced`. It moved three times as its subject was wired
  // (`import:run` → `work_item:delete` → `ai:view_plan` → `ai:plan`), which is
  // exactly the signal it was built to carry, and it has now carried it to the
  // end. What survives is the assertion ABOVE, which is the one with teeth: every
  // enforced key must appear in a gate call somewhere outside `lib/permissions/`.
  it.skip('THE GUARD CAN ACTUALLY FAIL — a key nothing consults is reported', () => {
    // A key from MOTIR-2291's eight that is justified by the inventory and
    // deliberately unwired. It is the honest negative control, and when a card
    // wires it this assertion flips and asks to be updated — which is exactly
    // what happened: the control was `import:run` until MOTIR-2353 wired it and
    // `work_item:delete` until MOTIR-2354 did, each time moving on rather than
    // being deleted. MOTIR-2356 retires it for good.
    // ⚠️ ONLY `ai:plan` IS LEFT, and it is a control of a different kind: its
    // operations ARE wired (MOTIR-2355 / -2357 / -2358), and the FLAG is what
    // MOTIR-2359 and then MOTIR-2356 still owe. So the assertion inverts — the
    // key is consulted and still `planned`, which is exactly the seam that lets
    // naming and wiring land separately. MOTIR-2356 retires this control with the
    // arm it belongs to.
    const wired = SOURCES.filter((f) => !f.path.startsWith('lib/permissions/')).some((f) =>
      f.code.includes("'ai:plan'"),
    );
    expect(wired, 'ai:plan should be consulted by the cards that wired it').toBe(true);
    expect(PERMISSION_CATALOG['ai:plan'].enforcement).toBe('planned');
  });
});

describe('the story leaves nothing behind', () => {
  it('NO key is `planned` any more — both stories have landed (MOTIR-2356)', () => {
    const stillPlanned = Object.values(PERMISSION_CATALOG)
      .filter((d) => d.enforcement === 'planned')
      .map((d) => d.key)
      .sort();
    // This array was MOTIR-2291's worklist: each wiring card deleted its own key
    // in the same change — `sprint:manage` (2350), `report:view` (2351),
    // `saved_filter:manage` (2352), `import:run` (2353), `work_item:triage` +
    // `work_item:delete` (2354), `ai:view_plan` (2363), and `ai:plan` across
    // 2355/2357/2358/2359 with the flag flipped here. It is empty, and the
    // emptiness is the story's definition of done. (MOTIR-5305 parked
    // `approval:view_any` here for one commit; MOTIR-5301 wired it and emptied it.)
    // (MOTIR-6328 parked `plan:view_any` / `run:view_any` here for two commits;
    // MOTIR-6330 and MOTIR-6331 wired them and emptied it.)
    expect(stillPlanned).toEqual([]);
  });
});

/**
 * The service METHODS that can now raise `PermissionDeniedError` — those whose
 * body calls `assertPermission`, directly or through a module-local helper in the
 * same file (the adapters MOTIR-2296/2297/2298 kept for readability).
 *
 * The same-file hop is the one MOTIR-2304 taught the ungoverned-operation walk;
 * without it `boardsService.addColumn` looks unreachable because its gate sits
 * behind `assertBoardConfigAdmin`.
 */
function raisingMethods(): Set<string> {
  const dir = join(ROOT, 'lib', 'services');
  const raising = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts')) continue;
    const svc = file.slice(0, -3);
    const src = readFileSync(join(dir, file), 'utf8');

    const locals = new Map<string, string>();
    const localRe = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/gm;
    for (let m = localRe.exec(src); m !== null; m = localRe.exec(src)) {
      const body = bodyAfterSignature(src, m.index + m[0].length);
      if (body) locals.set(m[1]!, body);
    }

    const methodRe = /^ {2}(?:async\s+)?([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/gm;
    for (let m = methodRe.exec(src); m !== null; m = methodRe.exec(src)) {
      const name = m[1]!;
      if (['if', 'for', 'while', 'switch', 'catch', 'return'].includes(name)) continue;
      const body = bodyAfterSignature(src, m.index + m[0].length);
      if (!body) continue;
      let hit = body.includes('assertPermission(');
      if (!hit) {
        for (const [localName, localBody] of locals) {
          if (
            new RegExp(`(?<![.\\w$])${localName}\\s*\\(`).test(body) &&
            localBody.includes('assertPermission(')
          ) {
            hit = true;
            break;
          }
        }
      }
      if (hit) raising.add(`${svc}.${name}`);
    }
  }
  return raising;
}

/** A method/function body, given the offset just past its signature's opening paren. */
function bodyAfterSignature(src: string, afterOpenParen: number): string | null {
  let depth = 1;
  let i = afterOpenParen;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') depth -= 1;
  }
  if (depth > 0) return null;
  const open = src.indexOf('{', i);
  if (open < 0) return null;
  let braces = 0;
  let j = open;
  for (; j < src.length; j++) {
    if (src[j] === '{') braces += 1;
    else if (src[j] === '}' && --braces === 0) break;
  }
  return src.slice(open, j + 1);
}

/** Whether a route file, or a `@/lib/**` module it imports, knows the error.
 *
 *  ⚠️ The module that DEFINES the class does not count. `lib/projects/errors.ts`
 *  is where `PermissionDeniedError` is declared, so ANY route importing a
 *  sibling from it — `ProjectNotFoundError`, say — used to satisfy this walk
 *  without owning a single arm. That false negative is not hypothetical: it let
 *  `POST /api/import` ship with a three-arm hand-rolled mapper that knew
 *  `ProjectNotFoundError` and not the refusal, so a project member's
 *  `import:run` denial came back as a **500**, and this guard stayed green until
 *  the E2E spec ran it. A definition is not a mapping. */
function definesTheError(src: string): boolean {
  return /export\s+class\s+PermissionDeniedError\b/.test(src);
}

function mapsPermissionDenied(src: string, routePath: string): boolean {
  if (src.includes('PermissionDeniedError') && !definesTheError(src)) return true;
  // ⚠️ BOTH IMPORT FORMS, and the second was a BLIND SPOT (MOTIR-1343).
  //
  // This used to follow `@/lib/…` only. A route whose mapper is a SIBLING —
  // `app/api/ai/ask/route.ts` imports `../plan-change/_errors`, which maps the
  // refusal correctly — was reported as an offender the guard could not see
  // through. That is worse than a miss: the remedy it prints ("add the error to
  // the route") would have had somebody add a redundant arm to silence a guard
  // that was wrong, and left the actual blind spot in place for the next route
  // that reaches for a co-located mapper.
  for (const [re, resolve] of [
    [/from '(@\/lib\/[^']+)'/g, (spec: string) => join(ROOT, `${spec.replace('@/', '')}.ts`)],
    [/from '(\.[^']+)'/g, (spec: string) => join(dirname(routePath), `${spec}.ts`)],
  ] as const) {
    for (let m = re.exec(src); m !== null; m = re.exec(src)) {
      try {
        const imported = readFileSync(resolve(m[1]!), 'utf8');
        if (imported.includes('PermissionDeniedError') && !definesTheError(imported)) return true;
      } catch {
        // a directory import or a .tsx module — not an error mapper
      }
    }
  }
  return false;
}

describe('guard 3 — every route that can RAISE the new refusal can also MAP it', () => {
  it('finds no route reaching an assertPermission method without a PermissionDeniedError arm', () => {
    // ⚠️ THIS GUARD EXISTS BECAUSE THE GAP IT CHECKS SHIPPED. The domain cards
    // re-pointed nine services to `assertPermission`, which raises a NEW error
    // class — and six error mappers still knew only `NotProjectAdminError`, so
    // the refusal fell through to a **500** instead of a 403. Every service test
    // stayed green, because they exercise the SERVICE; only the route knows the
    // mapper. CI found it across `epic6-journey` (Vitest + E2E), the components
    // routes and the estimation route.
    //
    // Method-precise on purpose. At SERVICE granularity this flags five read
    // paths — `workflowsService.getWorkflow`, `estimationService.rollupForSprint`
    // and friends — that never reach a gate, and a guard with five standing false
    // positives is a guard that gets deleted.
    const raising = raisingMethods();
    expect(
      raising.size,
      'no service appears to call assertPermission — the walk is broken',
    ).toBeGreaterThan(10);

    const offenders: string[] = [];
    let reached = 0;
    walk(join(ROOT, 'app', 'api'), (p) => {
      if (!p.endsWith(`${'route'}.ts`)) return;
      const src = readFileSync(p, 'utf8');
      const called = new Set(
        [...src.matchAll(/\b([a-z][A-Za-z0-9]*Service)\.([A-Za-z_]\w*)\s*\(/g)].map(
          (m) => `${m[1]}.${m[2]}`,
        ),
      );
      const hits = [...called].filter((k) => raising.has(k));
      if (hits.length === 0) return;
      reached += 1;
      if (!mapsPermissionDenied(src, p)) {
        offenders.push(`${relative(ROOT, p).replace(/\\/g, '/')} — reaches ${hits.join(', ')}`);
      }
    });

    expect(reached, 'no route reaches a gated method — the walk is broken').toBeGreaterThan(10);
    expect(
      offenders,
      'these routes can receive a PermissionDeniedError and have no arm for it, so the refusal ' +
        'becomes a 500 instead of a 403. Add the error to the route or to the mapper it imports.',
    ).toEqual([]);
  });
});

/** Comment-stripped source by repo-relative path, for following a route's imports. */
const SOURCE_BY_PATH = new Map(SOURCES.map((s) => [s.path, s.code]));

function importedSources(code: string, fromPath: string): { path: string; code: string }[] {
  const out: { path: string; code: string }[] = [];
  for (const m of code.matchAll(/from '((?:@\/|\.)[^']+)'/g)) {
    const spec = m[1]!;
    const base = spec.startsWith('@/')
      ? spec.slice(2)
      : join(dirname(fromPath), spec).replace(/\\/g, '/');
    for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
      const src = SOURCE_BY_PATH.get(candidate);
      if (src !== undefined) {
        out.push({ path: candidate, code: src });
        break;
      }
    }
  }
  return out;
}

/**
 * Does this route map the not-found refusal — itself, or through a mapper it
 * imports, two hops deep (a route → its `withV1Route` wrapper → the status table)?
 * By class name or by the stable code, since the v1 table keys on the code.
 */
function mapsProjectNotFound(code: string, path: string, depth = 2): boolean {
  if (/\bProjectNotFoundError\b|'PROJECT_NOT_FOUND'|\bPROJECT_NOT_FOUND:/.test(code)) return true;
  if (depth === 0) return false;
  return importedSources(code, path).some(
    (imp) =>
      !imp.path.endsWith('lib/projects/errors.ts') &&
      mapsProjectNotFound(imp.code, imp.path, depth - 1),
  );
}

describe('guard 4 — every route that resolves a project BY KEY maps the not-found refusal (MOTIR-5320)', () => {
  it('finds no route calling projectsService.getByKey / resolveByKey without a ProjectNotFoundError arm', () => {
    // ⚠️ THE OTHER HALF OF THIS GUARD IS BEHAVIOURAL, AND THIS HALF IS NOT ENOUGH
    // ALONE. Before MOTIR-5320 every one of these routes already mapped
    // `ProjectNotFoundError` — and a workspace member who could not browse a
    // private project still got a 500 from some and a 403 from others, because
    // the lookup threw `ProjectAccessDeniedError` instead. So the contract has two
    // halves, each with its own test:
    //   1. the lookup refuses a non-browser with `ProjectNotFoundError` —
    //      `tests/projects/key-lookup-browse-denial.test.ts`, against Postgres;
    //   2. every route that calls the lookup MAPS that error — here.
    // Together they make a route added later answer a non-browser with the same
    // 404 a missing key gets, without anybody remembering to write the arm.
    const offenders: string[] = [];
    let reached = 0;
    for (const { path, code } of SOURCES) {
      if (!path.startsWith('app/api/') || !path.endsWith('/route.ts')) continue;
      if (!/\bprojectsService\.(?:getByKey|resolveByKey)\s*\(/.test(code)) continue;
      reached += 1;
      if (!mapsProjectNotFound(code, path)) offenders.push(path);
    }

    expect(reached, 'no route resolves a project by key — the walk is broken').toBeGreaterThan(20);
    expect(
      offenders,
      'these routes resolve a project by key and have no ProjectNotFoundError arm, so a missing ' +
        'or un-browsable project becomes a 500 instead of a 404. Map it in the route or its mapper.',
    ).toEqual([]);
  });
});
