import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// Story-7.30 ARCHITECTURE + CONTRACT guards (MOTIR-1732) — the half of the
// story-level gate a coverage number cannot see. Coverage says every line ran;
// it says nothing about a client component that reached past the HTTP boundary,
// a route that grew a transaction, or a removal that left a key nothing renders.
// Each guard below is a STANDING invariant, asserted by reading the source the
// way a reviewer would — the `render-single-source` / `i18n-catalog` pattern.

const ROOT = process.cwd();

// The whole `planEdits` namespace went with the dock that was its only reader
// (MOTIR-4261), so these read an EMPTY block — which every "is gone" assertion
// below still means exactly what it says.
const planEditsEn = (en as unknown as Record<string, Record<string, string>>)['planEdits'] ?? {};
const planEditsZh = (zh as unknown as Record<string, Record<string, string>>)['planEdits'] ?? {};
const planningWorkspaceEn = (en as unknown as Record<string, Record<string, unknown>>)[
  'planningWorkspace'
]!;
const planningWorkspaceZh = (zh as unknown as Record<string, Record<string, unknown>>)[
  'planningWorkspace'
]!;

/** Every leaf key path in a catalog subtree, sorted — nesting-aware parity. */
function keyPaths(node: unknown, prefix = ''): string[] {
  if (node === null || typeof node !== 'object') return [prefix];
  return Object.entries(node as Record<string, unknown>)
    .flatMap(([k, v]) => keyPaths(v, prefix ? `${prefix}.${k}` : k))
    .sort();
}

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectSourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const SOURCE_FILES = ['app', 'components', 'lib'].flatMap((d) => collectSourceFiles(join(ROOT, d)));

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

/** A repo-relative file with its comments stripped — for guards that assert the
 *  ABSENCE of something the file legitimately still discusses in prose. */
function codeOf(rel: string): string {
  return read(join(ROOT, rel))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/[^\n]*$/gm, '');
}

function isClientModule(text: string): boolean {
  // The directive must be the module's FIRST statement, so a mention further
  // down — inside a comment, a string, or this very file — is not one.
  //
  // Scanned rather than matched: the obvious regex for "skip leading whitespace
  // and comments" puts an ambiguous alternation under a `*`
  // (`(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*`), which a source file made of many
  // `*//*` repetitions can force into exponential backtracking — a real ReDoS
  // CodeQL flags (js/redos). This walk is linear and never backtracks.
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i += 1;
    } else if (text.startsWith('//', i)) {
      const newline = text.indexOf('\n', i + 2);
      if (newline === -1) return false;
      i = newline + 1;
    } else if (text.startsWith('/*', i)) {
      const close = text.indexOf('*/', i + 2);
      if (close === -1) return false;
      i = close + 2;
    } else {
      // The first thing that is neither whitespace nor a comment decides it.
      return text.startsWith("'use client'", i) || text.startsWith('"use client"', i);
    }
  }
  return false;
}

// ─────────── Guard 1 — no client component reaches the service layer ───────────

describe('the client/server boundary holds', () => {
  it("no 'use client' module imports a service, a repository, or the Prisma singleton", () => {
    // The conversation rail, the canvas and the host are client islands; every
    // read/write they make is an HTTP hop to a route (`planChangeClient`). An
    // import of `@/lib/services/*` from a client module compiles and even runs
    // during SSR — then fails in the browser, or worse, bundles the DB client
    // and the tenant scoping into the page. Repo-wide, because the invariant is
    // not this story's alone.
    const offenders = SOURCE_FILES.filter((file) => {
      const text = read(file);
      if (!isClientModule(text)) return false;
      return /from '@\/lib\/(services|repositories)\/|from '@\/lib\/db'/.test(text);
    }).map((f) => relative(ROOT, f));

    expect(offenders).toEqual([]);
  });

  it('the story’s own client modules talk to the routes, not to the service', () => {
    // Named explicitly so the guard above cannot pass by accident if one of
    // these ever stops being a client module.
    const storyClientModules = [
      'components/planning/PlanningWorkspaceHost.tsx',
      'components/planning/PlanChangeRail.tsx',
      // The pane, before and after a plan exists (MOTIR-11513).
      'components/planning/PlanProposalViews.tsx',
      'components/planning/PlanReviewCanvas.tsx',
      'components/planning/PlanChangeConfirmBar.tsx',
      'lib/hooks/usePlanChangeConversation.ts',
      // The `@`-mention target picker (MOTIR-1491) joins the same island: its
      // search is the shipped mention-search ROUTE, never the service behind it.
      'components/planning/PlanChangeComposer.tsx',
      'components/planning/TargetSearchListbox.tsx',
      'components/planning/PlanningTargetChip.tsx',
      'components/planning/PlanningTargetNode.tsx',
      'lib/hooks/useWorkItemTargetSearch.ts',
    ];

    for (const rel of storyClientModules) {
      const text = read(join(ROOT, rel));
      expect(isClientModule(text), `${rel} is a client module`).toBe(true);
      expect(text, `${rel} must not import the service layer`).not.toMatch(
        /from '@\/lib\/(services|repositories)\/|from '@\/lib\/db'/,
      );
    }

    // …and the one module that IS allowed to speak HTTP names the shipped
    // endpoints, so the seam test's URLs are the product's URLs.
    const client = read(join(ROOT, 'lib/planning/planChangeClient.ts'));
    expect(client).toContain('/api/ai/plan-change/session');
    expect(client).toContain('/api/ai/plan-change/session/turns');
    expect(client).toContain('/api/ai/plan-change/session/submit');
    // A TARGETED turn (MOTIR-1491) rides the shipped contextual route — the
    // picker added no endpoint of its own.
    expect(client).toContain('/ai/plan');
  });
});

// ─────── Guard 1b — the conversation confirms the PLAN, through ONE gate ───────

describe('the plan-change conversation reviews and confirms the PLAN (MOTIR-1746)', () => {
  // The whole defect: every plan-edit handler in motir-ai returns
  // `planDelta: { operations: [] }` and writes its output as PlanItem proposals
  // instead, so a surface that reads the delta can only ever show "nothing was
  // proposed" — while the proposals sit in the Plan unread. These are STANDING
  // invariants, not one-off assertions: a future edit that reaches back for the
  // delta re-opens exactly that bug, silently.
  const CONVERSATION_MODULES = [
    'lib/hooks/usePlanChangeConversation.ts',
    'components/planning/PlanningWorkspaceHost.tsx',
    'components/planning/PlanChangeRail.tsx',
    'components/planning/PlanReviewCanvas.tsx',
    'components/planning/PlanChangeConfirmBar.tsx',
    'lib/planning/planChangeDiff.ts',
    // The `/ready` expansion nudge moved off the same dead delta by MOTIR-1747,
    // and since story MOTIR-5266 it reviews nothing at all: it opens the overlay
    // (guarded below). The item-scoped expand/replan dock was RETIRED whole by
    // MOTIR-4261 — see the guard at the foot.
    'app/(authed)/ready/_components/ExpansionNudgeBanner.tsx',
  ];

  it.each(CONVERSATION_MODULES)('%s reads no planDelta and calls no delta approve', (rel) => {
    const text = read(join(ROOT, rel));
    // A prose mention in the header comment is the RECORD of why; an import or a
    // call is the regression. So match code, not commentary.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
    expect(code, `${rel} must not read the job's planDelta`).not.toMatch(/planDelta/);
    expect(code, `${rel} must not call the delta approve`).not.toMatch(
      /approvePlanDelta|plan-delta\/approve/,
    );
  });

  it('every AI-planning entrance confirms through the SAME client', () => {
    // TWO entrances confirm (the rail and `/plans/[id]`), ONE gate: both go through
    // `planReviewClient` → `POST /api/plans/[id]/approve` → `materialize`. A second
    // write path is how the same proposal lands twice. The `/ready` nudge no longer
    // confirms anything — it opens the overlay, whose rail confirms (story
    // MOTIR-5266) — and the item-scoped dock was retired by MOTIR-4261.
    for (const rel of [
      'lib/hooks/usePlanChangeConversation.ts',
      'components/planning/PlanDetail.tsx',
    ]) {
      expect(read(join(ROOT, rel)), rel).toMatch(/from '@\/lib\/planning\/planReviewClient'/);
    }
    const client = read(join(ROOT, 'lib/planning/planReviewClient.ts'));
    expect(client).toContain('/approve');
    expect(client).toContain('/decline');
  });

  it('the `/ready` nudge runs no job and decides no plan — it opens the overlay (MOTIR-7876)', () => {
    const banner = read(join(ROOT, 'app/(authed)/ready/_components/ExpansionNudgeBanner.tsx'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/[^\n]*$/gm, '');
    expect(banner).not.toMatch(
      /submitExpandJob|approvePlanRequest|declinePlanRequest|fetchPlanReview/,
    );
    expect(banner).toMatch(/withPlanningOverlay\(/);
  });

  it('EXACTLY ONE proposal→tree write path survives, repo-wide (MOTIR-1747)', () => {
    // The bug this closes: two independent paths turned proposals into work
    // items — `approvePlan` → `materialize` (live) and `approveDelta` (dead,
    // because every planner returns an empty delta). The dead one is gone, and
    // this asserts it stays gone WITHOUT naming the files that used to hold it:
    // a scan of the whole app/components/lib tree, so a reintroduction anywhere
    // fails here.
    const offenders = SOURCE_FILES.filter((file) => {
      const code = read(file)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/[^\n]*$/gm, '');
      return /planDelta|approvePlanDelta|plan-delta\/approve|approveDelta/.test(code);
    }).map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);

    // The route, the service method, the client helper and the shape gate are
    // deleted — not merely unreferenced.
    for (const gone of [
      'app/api/ai/plan-delta/approve/route.ts',
      'lib/ai/planDelta.ts',
      'lib/ai/planDeltaGate.ts',
    ]) {
      expect(existsSync(join(ROOT, gone)), `${gone} must not exist`).toBe(false);
    }

    // …and no OTHER endpoint persists proposals: the only route that materializes
    // a plan is the plans approve route the entrances share — which, since
    // MOTIR-6038, decides the plan's gate through `planDecisionService`.
    const approveRoutes = SOURCE_FILES.filter((file) => {
      if (!relative(ROOT, file).startsWith(`app${sep}api`)) return false;
      const code = read(file)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/[^\n]*$/gm, '');
      return /plansService\.approvePlan\(|planDecisionService\.approve\(|materializePlan\(/.test(
        code,
      );
    }).map((f) => relative(ROOT, f));
    expect(approveRoutes).toEqual([join('app', 'api', 'plans', '[id]', 'approve', 'route.ts')]);
  });
});

// ─────────── Guard 2 — the story's routes stay a thin HTTP layer ───────────

describe('the story’s routes are HTTP-only (4-layer)', () => {
  const STORY_ROUTES = [
    'app/api/ai/plan-change/session/route.ts',
    'app/api/ai/plan-change/session/turns/route.ts',
    'app/api/ai/plan-change/session/submit/route.ts',
    // RESUME of a failed session (Story MOTIR-7905 · MOTIR-7916) — one service call, mapped errors.
    'app/api/ai/plan-change/session/resume/route.ts',
    // The BOUNDARY MAILBOX's two doors (Story MOTIR-4054 · MOTIR-4067) — the
    // INGEST a session posts a mid-run turn to, and the READ DOOR motir-ai
    // consumes at a phase boundary. Listed here rather than left implicit: the
    // read door WRITES (it stamps what it returns as consumed), which is exactly
    // the shape most likely to grow a `$transaction` in the route.
    'app/api/ai/plan-change/session/mailbox/route.ts',
    'app/api/internal/ai/plan-change-mailbox/route.ts',
  ];

  it.each(STORY_ROUTES)('%s calls no db.* and opens no $transaction', (rel) => {
    const text = read(join(ROOT, rel));
    expect(text).not.toMatch(/from '@\/lib\/db'/);
    expect(text).not.toMatch(/\bdb\.[a-zA-Z]/);
    expect(text).not.toMatch(/\$transaction/);
    // Prisma is a repository-only import.
    expect(text).not.toMatch(/from '@prisma\/client'/);
  });

  it('the workspace’s own server read goes through a service, never Prisma', () => {
    // ⚠️ RE-POINTED (MOTIR-4732). This read `app/(planning)/planning/page.tsx`,
    // the route host, which is deleted — the workspace is an OVERLAY, a client
    // island, and a client island may not reach a service at all. So the one
    // server read it makes is an HTTP door (MOTIR-4727), and the 4-layer
    // invariant lands there instead: a route handler may call services, and what
    // it may not do is skip them.
    // Comment-stripped, like every other guard in this file: the handler's own
    // header states the rule it follows, and prose describing a trap must not
    // trip the trap's test.
    const text = codeOf('app/api/work-items/planning-anchor/route.ts');
    expect(text).toMatch(/from '@\/lib\/services\//);
    expect(text).not.toMatch(/from '@\/lib\/db'/);
    expect(text).not.toMatch(/\$transaction/);
  });

  it('the transaction lives in the SERVICE, and every repository write requires a tx', () => {
    const service = read(join(ROOT, 'lib/services/planChangeSessionsService.ts'));
    expect(service).toMatch(/withWorkspaceContext/);
    // Same for the mailbox's service (MOTIR-4067): the `seq` allocation is
    // read-derived, so its transaction and its row lock live here or nowhere.
    const mailbox = read(join(ROOT, 'lib/services/planChangeMailboxService.ts'));
    expect(mailbox).toMatch(/withWorkspaceContext/);
    expect(mailbox).toMatch(/lockById/);

    for (const rel of [
      'lib/repositories/planChangeSessionRepository.ts',
      'lib/repositories/planChangeTurnRepository.ts',
      'lib/repositories/planChangeMailboxRepository.ts',
    ]) {
      const repo = read(join(ROOT, rel));
      // No optional `tx?` on a write — the compile-time guarantee the 4-layer
      // rule buys. (Reads legitimately take `tx?`.)
      expect(repo, `${rel} must not own a transaction`).not.toMatch(/\$transaction/);
      for (const method of ['create', 'update']) {
        const signature = new RegExp(`async ${method}\\([\\s\\S]*?\\): Promise`);
        const match = signature.exec(repo);
        if (!match) continue;
        expect(match[0], `${rel}#${method} must REQUIRE a tx`).toMatch(
          /tx: Prisma\.TransactionClient/,
        );
      }
    }
  });
});

// ────── Guard 2b — the workspace OPENS before its data arrives (MOTIR-2069) ──────

describe('the workspace is not hostage to the roadmap read', () => {
  it('the overlay shows the workspace SKELETON while it waits', () => {
    // ⚠️ RE-POINTED (MOTIR-4732). The route had `app/(planning)/loading.tsx` for
    // exactly one reason: without a boundary, Next held the NAVIGATION on the
    // previous route until the page's slowest await settled — the whole "loads
    // first, then opens" defect. An overlay has no navigation to hold, so the
    // boundary is gone with the group and the SHAPE it showed is not: the
    // overlay renders the same skeleton inside the dialog while a work-item
    // launch resolves its anchor.
    const overlay = read(join(ROOT, 'components/planning/PlanningWorkspaceOverlay.tsx'));
    expect(overlay).toMatch(/PlanningWorkspaceSkeleton/);
    expect(existsSync(join(ROOT, 'app/(planning)'))).toBe(false);
  });

  it('the overlay reads NO roadmap data — the blocking, duplicate read stays gone', () => {
    // Both files keep a prose RECORD of the defect in their header comments, so
    // these read CODE only — the same comment-stripping the delta guards use.
    const overlay = codeOf('components/planning/PlanningWorkspaceOverlay.tsx');
    // The exact shape that caused the bug: the root level read inline to
    // pre-compute `hasItems`. The canvas reads that same level itself, so
    // whatever mounts it must not read it at all.
    expect(overlay).not.toMatch(/getProjectRoadmap/);
    expect(overlay).not.toMatch(/fetchRoadmapLevel/);
    expect(overlay).not.toMatch(/hasItems/);
  });

  it('the canvas owns the loading and empty states the page used to pre-decide', () => {
    const host = read(join(ROOT, 'components/planning/PlanningWorkspaceHost.tsx'));
    // Mounted unconditionally — no `hasItems ? canvas : empty` branch to revive.
    expect(host).toMatch(/loadingFallback=\{<PlanningCanvasSkeleton \/>\}/);
    // The empty-root statement rides the pane's "no plan" state (MOTIR-11513).
    expect(host).toMatch(/emptyRoot: \(/);

    // …and the canvas honours both, with the shipped behaviour as the default so
    // the other four consumers of the reusable canvas are untouched.
    const canvas = read(join(ROOT, 'components/planning/ProjectRoadmapCanvas.tsx'));
    expect(canvas).toMatch(/loadingFallback \?\? <Spinner/);
    expect(canvas).toMatch(/!drilled && emptyRoot/);
    // The pane forwards both to the canvas it mounts (MOTIR-11513).
    expect(read(join(ROOT, 'components/planning/PlanProposalViews.tsx'))).toMatch(
      /loadingFallback=\{loadingFallback\}/,
    );
    const review = read(join(ROOT, 'components/planning/PlanReviewCanvas.tsx'));
    expect(review).toMatch(/loadingFallback=\{loadingFallback\}/);
    expect(review).toMatch(/emptyRoot=\{prePlan\?\.emptyRoot\}/);
  });

  it('the ACCESS gate still resolves BEFORE the workspace renders', () => {
    // The other half of the invariant, and it SURVIVED the move (MOTIR-4732): a
    // `no-access` actor must never be shown a workspace frame for a project they
    // cannot browse. What changed is where the inputs come from — the shell's
    // session and its permission provider, both resolved above this component —
    // so the assertion is that the gate is consulted and its arm is honoured
    // before the host mounts.
    //
    // ⚠️ THE SECOND ARM IS GONE ON PURPOSE (MOTIR-4765). This used to also
    // require `gate === 'onboarding'`, because a null-marker project "must still
    // forward". It must not: the marker says *"has never had a plan APPROVED"*,
    // so forwarding on it ejected established, code-bearing projects out of the
    // window they had just opened. The negative below is the replacement, and it
    // is the stronger assertion — the verdict cannot be re-derived here because
    // the type no longer has it.
    const overlay = read(join(ROOT, 'components/planning/PlanningWorkspaceOverlay.tsx'));
    const gateAt = overlay.indexOf('resolvePlanningHostGate({');
    expect(gateAt).toBeGreaterThan(-1);
    // The access arm is honoured, and the host is mounted only past it.
    expect(overlay).toMatch(/gate === 'no-access'/);
    expect(overlay.indexOf('<PlanningWorkspaceHost')).toBeGreaterThan(gateAt);
    // NO onboarding arm: the gate's verdict cannot be re-derived here, because
    // the type no longer has it. (The navigation half is asserted below.)
    expect(overlay).not.toMatch(/gate === 'onboarding'/);
    const beforeGate = overlay.slice(0, gateAt);
    // The provider is read ABOVE the gate — that is the ordering half.
    expect(beforeGate).toMatch(/useProjectAccess\(\)/);
    // An awaited ACCESS read before the gate — whichever capability reader it is.
    // MOTIR-2250 moved this to `getSettingsCapabilities`, a superset over the SAME
    // `resolveInputs` round-trip, so the audit-coverage banner's `canManage` gate
    // costs no EXTRA read on this page's critical path. The invariant this guards
    // is "the access read resolves before anything renders", not the method name —
    // but it stays pinned to the reader so a future edit cannot drop it — and
    // the gate's browse input is named by the PERMISSION its own server check
    // asserts, not by a rank.
    expect(overlay).toMatch(/canBrowse: can\('project:browse'\)/);
    // ⚠️ And it must remain exactly ONE access read. On the route this meant one
    // awaited `projectAccessService` round-trip; in the overlay it is stronger
    // and free — the shell resolved the whole permission set once, for every
    // affordance on the page, and this component reads it out of context. So
    // there is no access QUERY on this path at all, which is what it now says.
    expect(overlay).not.toMatch(/projectAccessService/);
    expect((overlay.match(/= useProjectAccess\(\)/g) ?? []).length).toBe(1);
    // …and the never-onboarded REDIRECT is gone from this path, which is the
    // half of this guard MOTIR-4765 inverts.
    //
    // ⚠️ THIS BLOCK USED TO REQUIRE THE REDIRECT, and its history is worth
    // keeping because both earlier revisions were right about their own moment
    // and wrong about this one. It first matched `redirect('/onboarding')`; then
    // MOTIR-4403 re-pointed it at `ONBOARDING_ENTRY_PATH` (a re-typed literal
    // under `app/` is forbidden by `tests/navigation/landing-owner-guard.test.ts`);
    // then MOTIR-4732 made it a client `router.push` when the route became an
    // overlay. Each revision preserved an invariant nobody had questioned —
    // *"a never-onboarded project leaves for onboarding rather than being shown
    // a workspace"* — and that invariant is the defect. `onboardingRanAt` means
    // *"has never had a plan APPROVED"*, so it fired for projects with an
    // indexed repository and an imported backlog, and on the overlay it fired
    // AFTER the user had opened the window.
    //
    // The assertion is now the negative, and it is deliberately wider than the
    // one line it replaces: no push, no router, no import of the entrance
    // constant. The move to onboarding is a thing the SESSION asks for once it
    // has read the project (MOTIR-4767) and the surface SHOWS before it happens
    // (MOTIR-4769) — never something this component does to somebody for
    // arriving.
    // ⚠️ TIGHTENED RATHER THAN RELAXED (MOTIR-4769). This read "no `router.push`
    // at all", which was right while the component had no navigation of any
    // kind — and the hand-off gives it one: the user presses a button and is
    // taken to onboarding. That is the opposite of the defect. The defect was a
    // navigation NOBODY ASKED FOR, fired from an effect on arrival, so that is
    // what the guard now says: no push inside a `useEffect`, ever.
    for (const block of overlay.split('useEffect(').slice(1)) {
      const body = block.slice(0, block.indexOf('\n  }, ['));
      expect(body, 'a push inside an effect is a navigation nobody asked for').not.toMatch(
        /router\.push\(/,
      );
    }
    // …and the destination is still not written here: it is computed by
    // `handoffDestination` from the VERDICT, so no branch in this component
    // decides where a user goes.
    expect(overlay).not.toMatch(/ONBOARDING_ENTRY_PATH/);
  });

  it('the host takes no roadmap data at all', () => {
    // The prop whose await held the paint. Its absence is the invariant: a host
    // that cannot be handed roadmap data cannot be blocked waiting for it.
    expect(codeOf('components/planning/PlanningWorkspaceHost.tsx')).not.toMatch(/hasItems/);
  });

  it('the skeleton is presentational only — no strings to translate, no client JS', () => {
    const skeleton = read(join(ROOT, 'components/planning/PlanningWorkspaceSkeleton.tsx'));
    expect(isClientModule(skeleton)).toBe(false);
    expect(skeleton).not.toMatch(/useTranslations|\bt\(/);
    // It composes the REAL frame rather than redrawing one, so the two cannot
    // drift apart.
    expect(skeleton).toMatch(/from '@\/components\/planning\/PlanningWorkspace'/);
    // Colour through --el-* fills only; no invented colour, no raw Tailwind palette.
    expect(skeleton).not.toMatch(/bg-(gray|slate|zinc|neutral|stone)-\d/);
  });
});

// ─────────── Guard 3 — MOTIR-1731's removal left nothing dangling ───────────

describe('retiring “Augment from prompt” left no dangling key or import', () => {
  const RETIRED_KEYS = ['augmentPromptLabel', 'augmentPromptPlaceholder', 'augmentPromptSubmit'];

  it.each(RETIRED_KEYS)('planEdits.%s is gone from BOTH catalogs', (key) => {
    // Removing it from en.json only would pass the catalog PARITY gate in the
    // wrong direction on the next add; removing it from neither leaves a string
    // translators keep maintaining for a door that no longer exists.
    expect(planEditsEn).not.toHaveProperty(key);
    expect(planEditsZh).not.toHaveProperty(key);
  });

  it('no source file still asks for a retired key', () => {
    const offenders = SOURCE_FILES.filter((file) => {
      const text = read(file);
      return RETIRED_KEYS.some((key) => text.includes(key));
    }).map((f) => relative(ROOT, f));

    expect(offenders).toEqual([]);
  });

  it('the removed component is gone and nothing imports it', () => {
    const offenders = SOURCE_FILES.filter((file) => /AugmentPromptButton/.test(read(file))).map(
      (f) => relative(ROOT, f),
    );
    // The only surviving mention is the NOTE recording why the door was retired
    // — a breadcrumb, not an import. It sat in `PlanEditsLauncher.tsx` until
    // MOTIR-4258 deleted that file with the ⋯ menu that mounted it, and moved to
    // `WorkItemPlanEntrance` — the door that REPLACED both retired ones, and so
    // the file a reader asking "why is there only one?" actually opens. The
    // assertion is pinned to exactly one carrier on purpose: a breadcrumb in two
    // places is a breadcrumb that can rot in one of them.
    const carrier = join('components', 'planning', 'WorkItemPlanEntrance.tsx');
    expect(offenders).toEqual([carrier]);

    const entrance = read(join(ROOT, carrier));
    expect(entrance).not.toMatch(/^import[^\n]*AugmentPromptButton/m);
    expect(entrance).not.toMatch(/<AugmentPromptButton/);
  });

  it('the surfaces it was mounted on no longer reference it', () => {
    for (const rel of [
      join('app', '(authed)', 'backlog', 'page.tsx'),
      join('app', '(authed)', 'items', '_components', 'IssueListToolbar.tsx'),
    ]) {
      expect(read(join(ROOT, rel)), rel).not.toMatch(/AugmentPrompt/);
    }
  });

  it('the augment JOB path is UNTOUCHED — only the door was retired', () => {
    // The conversation submits to exactly this endpoint. If the removal had
    // swept the route too, the whole story would be dead and every seam test
    // above would be asserting a stub.
    const routes = SOURCE_FILES.filter((f) =>
      relative(ROOT, f).startsWith(join('app', 'api', 'ai', 'augment')),
    );
    expect(routes.length).toBeGreaterThan(0);
    expect(read(join(ROOT, 'lib/services/aiPlanEditsService.ts'))).toMatch(/submitAugment/);
  });
});

// ─────────── Guard 3b — MOTIR-4261 retired the in-place plan-edits dock ───────────
//
// MOTIR-4258 removed the dock's only door (the `/items` row ⋯), which left the
// whole chain behind it reachable from nowhere: the hook, the dock, the replan
// route and its stream, the expand STREAM (nothing ever streamed it), and the client + service functions only those reached.
// MOTIR-4261 RETIRED it rather than re-homing it — re-planning an item is
// `WorkItemPlanEntrance` → the planning workspace, one door. This guard is what
// stops the chain coming back one piece at a time as a "helper".

describe('retiring the in-place plan-edits dock left nothing on the old path', () => {
  const GONE_FILES = [
    'lib/hooks/usePlanEditsJob.ts',
    'components/planning/PlanEditsReviewDock.tsx',
    'app/api/ai/replan/route.ts',
    'app/api/ai/replan/[jobId]/stream/route.ts',
    'app/api/ai/expand/[jobId]/stream/route.ts',
  ];

  it.each(GONE_FILES)('%s is deleted, not merely unreferenced', (rel) => {
    expect(existsSync(join(ROOT, rel)), `${rel} must not exist`).toBe(false);
  });

  it('no source file defines or calls a retired symbol', () => {
    // CODE, not commentary: a note recording why the path went is a breadcrumb.
    const retired =
      /\b(usePlanEditsJob|PlanEditsReviewDock|submitReplanJob|streamReplanJob|streamExpandJob|submitReplan|streamReplan|streamExpand)\b|\/api\/ai\/replan/;
    const offenders = SOURCE_FILES.filter((file) => {
      const code = read(file)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/[^\n]*$/gm, '');
      return retired.test(code);
    }).map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it('its i18n namespace is gone from BOTH catalogs', () => {
    expect(en).not.toHaveProperty('planEdits');
    expect(zh).not.toHaveProperty('planEdits');
  });

  it('the EXPAND submit survives — the MCP `expand_item` still drives it', () => {
    expect(existsSync(join(ROOT, 'app/api/ai/expand/route.ts'))).toBe(true);
    expect(read(join(ROOT, 'lib/planning/planEditsClient.ts'))).toMatch(
      /export async function submitExpandJob\(/,
    );
    expect(read(join(ROOT, 'lib/services/aiPlanEditsService.ts'))).toMatch(/async submitExpand\(/);
  });
});

// ─────────── Guard 4 — the story's i18n additions are catalog-complete ───────────

describe('the story’s new copy exists in every locale', () => {
  it('planningWorkspace exists in en AND zh with the same key set', () => {
    // The i18n-catalog test proves whole-file parity; this states the story's
    // OWN namespace so a future removal can't pass parity by deleting both
    // halves of a key the UI still renders. `planningWorkspace` is the one
    // namespace this story added (MOTIR-1729); the conversation's copy
    // (MOTIR-1730) extended the `planEdits` namespace, retired whole with the
    // item-scoped dock by MOTIR-4261.
    expect(planningWorkspaceEn).toBeDefined();
    expect(planningWorkspaceZh).toBeDefined();
    expect(keyPaths(planningWorkspaceZh)).toEqual(keyPaths(planningWorkspaceEn));
    expect(keyPaths(planningWorkspaceEn).length).toBeGreaterThan(0);
  });

  it('the rail’s conversation copy matches key-for-key across locales, nesting included', () => {
    // `planningWorkspace.conversation` is a NESTED subtree (the opener, the
    // composer, the confirm bar's plural forms, the starters, the progress
    // narration). Whole-file parity is proven elsewhere; this walks the story's
    // own subtree so a zh block that lost a nested group cannot pass.
    const enConv = (planningWorkspaceEn as Record<string, unknown>)['conversation'];
    const zhConv = (planningWorkspaceZh as Record<string, unknown>)['conversation'];
    expect(enConv).toBeDefined();
    expect(keyPaths(enConv)).toEqual(keyPaths(zhConv));
    expect(keyPaths(enConv).length).toBeGreaterThan(10);
    for (const required of ['opener', 'asking', 'submitted', 'starters.addWork']) {
      expect(keyPaths(enConv)).toContain(required);
    }
  });

  it('every planningWorkspace key the OVERLAY names actually resolves', () => {
    // ⚠️ RE-POINTED (MOTIR-4732): the page that named these keys is deleted, and
    // the overlay is what names them now.
    const page = read(join(ROOT, 'components/planning/PlanningWorkspaceOverlay.tsx'));
    const ns = (en as unknown as Record<string, Record<string, string>>)['planningWorkspace']!;
    const used = [...page.matchAll(/\bt\('([^']+)'/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(0);
    for (const key of used) expect(ns, `planningWorkspace.${key}`).toHaveProperty(key);
  });
});

// A guard on the guards: the scan must actually be looking at files.
describe('the source scan is not vacuous', () => {
  it('walked the app, components and lib trees', () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(200);
    expect(SOURCE_FILES.some((f) => f.endsWith(`planning${sep}launcher.ts`))).toBe(true);
  });

  it('classifies client modules correctly — a false-everywhere scanner would pass guard 1 vacuously', () => {
    expect(isClientModule("'use client';\nexport const a = 1;\n")).toBe(true);
    expect(isClientModule('"use client";\n')).toBe(true);
    expect(isClientModule("// a leading comment\n\n'use client';\n")).toBe(true);
    expect(isClientModule("/* block */ 'use client';\n")).toBe(true);
    expect(isClientModule("/* one */\n// two\n/* three */\n'use client';\n")).toBe(true);

    // A mention that is NOT the first statement — the false positives the walk
    // exists to reject (this very file contains one).
    expect(isClientModule("import x from 'y';\n'use client';\n")).toBe(false);
    expect(isClientModule("// mentions 'use client' in prose\nexport const a = 1;\n")).toBe(false);
    expect(isClientModule('const s = "\'use client\'";\n')).toBe(false);
    expect(isClientModule('')).toBe(false);
    expect(isClientModule('   \n\n')).toBe(false);
    // Unterminated comments: bail rather than loop or mis-read past them.
    expect(isClientModule("/* never closed\n'use client';")).toBe(false);
    expect(isClientModule('// no trailing newline')).toBe(false);
  });

  it('classifies in linear time on the input that made the old regex backtrack', () => {
    // The js/redos repro: many `*//*` repetitions with no directive after them.
    // Exponential backtracking would hang here; the walk returns immediately.
    const adversarial = `/*${'*//*'.repeat(2000)}`;
    const started = process.hrtime.bigint();
    expect(isClientModule(adversarial)).toBe(false);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeLessThan(1000);
  });
});
