import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The PRODUCER seam of code-aware planning (Subtask 7.10.15 · MOTIR-1598): a
// planning-job submit resolves the workspace's connected repo SET from the
// persisted installation grant mirror (7.10.3) and carries it on the envelope
// as `context.code.repos[]` — the cross-repo contract with motir-ai's
// multi-repo reads (7.10.16 · MOTIR-1599). Real Postgres (the motir-core
// convention): seed a workspace + project + installation grants for real; mock
// ONLY the boundary client (no network). Exact-shape assertions per the
// seam-test convention — the ABSENT case must leave the envelope byte-identical
// to today's (no `code` key, not an empty one).
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(),
  streamJob: vi.fn(),
}));

import { db } from '@/lib/db';
import { submitJob } from '@/lib/ai/motirAiClient';
import { resolveProjectCodeContext, resolveWorkspaceConnectedRepos } from '@/lib/ai/codeContext';
import { aiGenerationService } from '@/lib/services/aiGenerationService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { linkProjectRepo } from '../helpers/projectRepoLink';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import type { ProjectContext } from '@/lib/projects';
import { seedRegistryService } from '@/lib/services/seedRegistryService';

const PASSWORD = 'hunter2hunter2';

async function seedProjectContext(): Promise<ProjectContext> {
  const user = await usersService.createUser({
    email: 'code-ctx@example.com',
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Alpha',
    identifier: 'ALPHA',
  });
  return {
    userId: user.id,
    workspaceId: workspace.id,
    projectId: project.id,
    project,
  };
}

/** The Motir-shaped grant: ONE workspace (one product), FOUR connected repos. */
const FOUR_REPOS = [
  {
    providerRepoId: '101',
    owner: 'moooon',
    name: 'motir-core',
    defaultBranch: 'main',
    archived: false,
  },
  {
    providerRepoId: '102',
    owner: 'moooon',
    name: 'motir-ai',
    defaultBranch: 'main',
    archived: false,
  },
  {
    providerRepoId: '103',
    owner: 'moooon',
    name: 'motir-gateway',
    defaultBranch: 'master',
    archived: false,
  },
  {
    providerRepoId: '104',
    owner: 'moooon',
    name: 'motir-meta',
    defaultBranch: 'main',
    archived: false,
  },
];

beforeEach(async () => {
  await truncateAuthTables();
  vi.mocked(submitJob).mockReset();
  vi.mocked(submitJob).mockResolvedValue({ jobId: 'job_code_1' });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/**
 * Put `name` into a project's configured set and REALIZE it against the
 * workspace's grant mirror — the two halves `tests/fixtures/codeContextFixtures.ts`
 * does together, inline here because these cases vary WHICH project gets WHICH
 * repository, which is the whole subject of the describe below.
 */
async function linkIntoSet(
  ctx: { userId: string; workspaceId: string; projectId: string },
  name: string,
  opts: { repoWorkspaceId?: string; role?: 'web' | 'api' } = {},
): Promise<void> {
  const repo = await adminDb.githubRepo.findFirstOrThrow({
    where: { workspaceId: opts.repoWorkspaceId ?? ctx.workspaceId, name },
  });
  // ⚠️ AN ESTABLISHED ROW, THROUGH `linkProjectRepo` — not `addRow` + a realize.
  // `addRow` records a PROPOSED row, and `resolveProjectCodeContext` filters
  // proposals out (`isEstablishedState`), so an `addRow`-built fixture is code-
  // blind however carefully it is realized. The bare `addRow` calls further down
  // are deliberate and stay: they are the UNESTABLISHED rows whose absence from
  // the answer is what those cases assert.
  await linkProjectRepo({
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    githubRepoId: repo.id,
    name,
    role: opts.role ?? 'web',
  });
}

// ⚠️ THE WORKSPACE-GRANT READ KEEPS ITS OWN TESTS (MOTIR-4653), and this block
// exists because moving them was a real coverage regression rather than a
// tidy-up. `resolveWorkspaceConnectedRepos` IS the read `resolveProjectCodeContext`
// used to perform; when the describe below was re-pointed at the project set,
// its "no installation" and "no granted repos" cases went with it — and those
// are branches of the RENAMED function, which nothing else asserts directly.
// The per-file coverage gate caught it (branches 84.78% against a 90% floor).
//
// The onboarding wizard is this function's only production caller, so its
// branches are load-bearing for a gate a person walks through, not for a
// planning envelope.
describe('resolveWorkspaceConnectedRepos', () => {
  it('resolves EVERY granted repo of the workspace installation, stable-ordered', async () => {
    const ctx = await seedProjectContext();
    await githubInstallationService.persistInstallation({
      workspaceId: ctx.workspaceId,
      installation: {
        installationId: 'inst-grant',
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: FOUR_REPOS,
    });

    // ⚠️ NO PROJECT SET IS CONFIGURED, deliberately. This read answers "what has
    // the workspace connected?", so it must see all four with the project's own
    // set empty — the exact case that makes it different from
    // `resolveProjectCodeContext`, which returns `undefined` here.
    const code = await resolveWorkspaceConnectedRepos({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });

    expect(code?.repos.map((r) => r.repoRef)).toEqual([
      'moooon/motir-ai',
      'moooon/motir-core',
      'moooon/motir-gateway',
      'moooon/motir-meta',
    ]);
    // The ledger read ran and said nothing is indexed — measured, not assumed.
    expect(code?.repos.every((r) => r.indexed === false)).toBe(true);
  });

  it('resolves undefined when the workspace has NO installation', async () => {
    // The wizard's CONNECT step gates on this: no installation means the user has
    // not connected anything yet, and the step must not exit.
    const ctx = await seedProjectContext();

    await expect(
      resolveWorkspaceConnectedRepos({ userId: ctx.userId, workspaceId: ctx.workspaceId }),
    ).resolves.toBeUndefined();
  });

  it('resolves undefined when the installation granted NO repos', async () => {
    // Distinct from the branch above: the installation EXISTS and its grant list
    // is empty. Both reach the same answer by different paths, and the ledger
    // read is skipped entirely — there is no set to ask about.
    const ctx = await seedProjectContext();
    await githubInstallationService.persistInstallation({
      workspaceId: ctx.workspaceId,
      installation: {
        installationId: 'inst-empty',
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: [],
    });

    await expect(
      resolveWorkspaceConnectedRepos({ userId: ctx.userId, workspaceId: ctx.workspaceId }),
    ).resolves.toBeUndefined();
  });

  it("is UNAFFECTED by the project's configured set — it answers about the workspace", async () => {
    // The inverse of `resolveProjectCodeContext`'s central case, and what keeps the two
    // functions from silently converging: configuring one repository for the
    // project must not narrow the workspace answer.
    const ctx = await seedProjectContext();
    await githubInstallationService.persistInstallation({
      workspaceId: ctx.workspaceId,
      installation: {
        installationId: 'inst-both',
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: FOUR_REPOS,
    });
    await linkIntoSet(ctx, 'motir-core');

    const workspaceAnswer = await resolveWorkspaceConnectedRepos({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    const projectAnswer = await resolveProjectCodeContext({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
    });

    expect(workspaceAnswer?.repos).toHaveLength(4);
    expect(projectAnswer?.repos.map((r) => r.repoRef)).toEqual(['moooon/motir-core']);
  });
});

// ⚠️ RE-POINTED TO THE PROJECT'S SET BY MOTIR-4653 (MOTIR-4642 · MOTIR-2029).
// This describe used to assert the WORKSPACE's whole installation grant. The
// deferral its subject carried — *"this resolver is DELIBERATELY left at
// workspace scope … that adoption belongs to MOTIR-1754"* — is discharged, and
// what a planning job sees is now the set somebody configured for THIS project.
describe('resolveProjectCodeContext', () => {
  it('resolves the PROJECT’s configured set — not every repo the workspace granted', async () => {
    const ctx = await seedProjectContext();
    await githubInstallationService.persistInstallation({
      workspaceId: ctx.workspaceId,
      installation: {
        installationId: 'inst-1',
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: FOUR_REPOS,
    });
    // FOUR granted, TWO configured. The two the project does not work on are the
    // point of the assertion.
    await linkIntoSet(ctx, 'motir-core');
    await linkIntoSet(ctx, 'motir-gateway', { role: 'api' });

    const code = await resolveProjectCodeContext({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
    });

    // ⚠️ EXACT SHAPE, AND THAT IS DELIBERATE — it pins `JobCodeRepo`'s keys.
    // This card changes the SET, never the contract: `provider` / `repoRef` /
    // `defaultBranch` (+ MOTIR-4826's `indexed`) are what motir-ai's multi-repo
    // reads parse, so a `toEqual` here fails on a key added, renamed or dropped
    // in passing.
    //
    // ⚠️ `indexed: false` ON EVERY ROW, AND IT IS MEASURED RATHER THAN ASSUMED
    // (MOTIR-4826). The field is read from the SUCCEEDED `system.code-graph-index`
    // ledger, and this fixture seeds no index run — so false is what the ledger
    // actually says here. The mixed and indexed cases are driven in
    // `tests/integration/onboarding/routing-run-triggers-index.test.ts`.
    expect(code).toEqual({
      repos: [
        { provider: 'github', repoRef: 'moooon/motir-core', defaultBranch: 'main', indexed: false },
        {
          provider: 'github',
          repoRef: 'moooon/motir-gateway',
          defaultBranch: 'master',
          indexed: false,
        },
      ],
    });
  });

  it('gives two projects of ONE workspace their own sets, and only their own', async () => {
    // The card's central criterion. Same workspace, same grant, two projects —
    // and the resolver must answer differently for each, which the workspace-
    // scoped read could not do even in principle.
    const alpha = await seedProjectContext();
    await githubInstallationService.persistInstallation({
      workspaceId: alpha.workspaceId,
      installation: {
        installationId: 'inst-1',
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: FOUR_REPOS,
    });
    const betaProject = await projectsService.createProject({
      workspaceId: alpha.workspaceId,
      actorUserId: alpha.userId,
      name: 'Beta',
      identifier: 'BETA',
    });
    const beta = { ...alpha, projectId: betaProject.id };

    await linkIntoSet(alpha, 'motir-core');
    await linkIntoSet(beta, 'motir-ai');

    const alphaCode = await resolveProjectCodeContext({
      userId: alpha.userId,
      workspaceId: alpha.workspaceId,
      projectId: alpha.projectId,
    });
    const betaCode = await resolveProjectCodeContext({
      userId: beta.userId,
      workspaceId: beta.workspaceId,
      projectId: beta.projectId,
    });

    expect(alphaCode!.repos.map((r) => r.repoRef)).toEqual(['moooon/motir-core']);
    expect(betaCode!.repos.map((r) => r.repoRef)).toEqual(['moooon/motir-ai']);
  });

  it('⚠️ resolves a project whose workspace did NOT install the App — the set is not workspace-tiered', async () => {
    // Requested on the card by Yue (2026-09-07) off MOTIR-4836's caller sweep,
    // and it is the case the criteria as written could not see: seeding two
    // projects in ONE workspace passes whether or not the resolver still hops
    // through `findByWorkspaceId`, because there the installation is right there.
    //
    // The OLD read went `findByWorkspaceId(workspaceId)` → `listByInstallation`,
    // and `installationOrganisationTenancy.test.ts` measures that hop returning
    // NULL for a sibling workspace of the installing one. So before this card a
    // project in the sibling workspace got `undefined` — no `context.code` at
    // all — for an organisation with repositories connected AND indexed. This
    // asserts the new resolver has not inherited that tier by some other route.
    const user = await usersService.createUser({
      email: 'sibling-ctx@example.com',
      password: PASSWORD,
      name: 'Owner',
    });
    const { workspace: installing } = await workspacesService.createWorkspace({
      name: 'Moooon',
      ownerUserId: user.id,
    });
    const { workspace: sibling } = await workspacesService.createWorkspace({
      name: 'Taq',
      ownerUserId: user.id,
      // The second workspace joins the FIRST's organisation instead of minting
      // its own — the one argument that makes this fixture different.
      organizationId: installing.organizationId,
    });
    await githubInstallationService.persistInstallation({
      workspaceId: installing.id,
      installation: {
        installationId: 'inst-installing',
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: FOUR_REPOS,
    });
    const project = await projectsService.createProject({
      workspaceId: sibling.id,
      actorUserId: user.id,
      name: 'Sibling',
      identifier: 'SIB',
    });
    const ctx = { userId: user.id, workspaceId: sibling.id, projectId: project.id };
    await linkIntoSet(ctx, 'motir-core', { repoWorkspaceId: installing.id });

    const code = await resolveProjectCodeContext(ctx);

    expect(code?.repos.map((r) => r.repoRef)).toEqual(['moooon/motir-core']);
  });

  it('resolves undefined when the project’s set is EMPTY, however much the workspace granted', async () => {
    const ctx = await seedProjectContext();
    await githubInstallationService.persistInstallation({
      workspaceId: ctx.workspaceId,
      installation: {
        installationId: 'inst-1',
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: FOUR_REPOS,
    });

    // Four repositories connected and none configured. `undefined`, never an
    // empty `repos` array — the caller omits `context.code` entirely and the
    // envelope stays byte-identical to a code-less one.
    const code = await resolveProjectCodeContext({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
    });
    expect(code).toBeUndefined();
  });

  it('resolves undefined when an UNREALIZED row is all the set holds', async () => {
    // A `project_repository` row is an INTENT until something realizes it. With
    // `githubRepoId` null there is no host, no default branch and no graph, so
    // there is nothing honest to put on the wire.
    const ctx = await seedProjectContext();
    await githubInstallationService.persistInstallation({
      workspaceId: ctx.workspaceId,
      installation: {
        installationId: 'inst-1',
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: FOUR_REPOS,
    });
    await projectRepoSetService.addRow(
      ctx.projectId,
      { role: 'web', name: 'motir-core' },
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
    );

    const code = await resolveProjectCodeContext({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
    });
    expect(code).toBeUndefined();
  });

  it('drops ONLY the unrealized rows when the set is mixed', async () => {
    const ctx = await seedProjectContext();
    await githubInstallationService.persistInstallation({
      workspaceId: ctx.workspaceId,
      installation: {
        installationId: 'inst-1',
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: FOUR_REPOS,
    });
    await linkIntoSet(ctx, 'motir-core');
    await projectRepoSetService.addRow(
      ctx.projectId,
      { role: 'api', name: 'motir-ai' },
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
    );

    const code = await resolveProjectCodeContext({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
    });
    expect(code!.repos.map((r) => r.repoRef)).toEqual(['moooon/motir-core']);
  });

  it('resolves undefined when the workspace has no installation at all', async () => {
    const ctx = await seedProjectContext();
    const code = await resolveProjectCodeContext({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
    });
    expect(code).toBeUndefined();
  });
});

describe('aiGenerationService.startGeneration — the context.code envelope seam', () => {
  it('carries context.code.repos[] on the generate_tree envelope for the project’s set', async () => {
    const ctx = await seedProjectContext();
    await githubInstallationService.persistInstallation({
      workspaceId: ctx.workspaceId,
      installation: {
        installationId: 'inst-3',
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: FOUR_REPOS,
    });
    // ⚠️ THE SET IS CONFIGURED EXPLICITLY NOW (MOTIR-4653). Connecting the four
    // to the workspace used to be enough, because `resolveProjectCodeContext` read the
    // grant; it reads the PROJECT's set, so this fixture states which
    // repositories the project works on. All four, to keep the envelope
    // assertion below exactly what it was.
    for (const repo of FOUR_REPOS) await linkIntoSet(ctx, repo.name);

    await aiGenerationService.startGeneration(ctx, { prompt: 'extend the tracker' });

    const [jobKind, , context] = vi.mocked(submitJob).mock.calls[0]!;
    expect(jobKind).toBe('plan');
    // The WHOLE context bag, exact shape (the read-back seam-test convention):
    // the code set rides beside the existing fields, nothing else drifts.
    expect(context).toEqual({
      prompt: 'extend the tracker',
      generateExplanations: false,
      // ⚠️ AND `repositories` IS HERE NOW, WHICH IS THE MOTIR-3044 INVARIANT
      // ASSERTED RATHER THAN DESCRIBED. It appears because this fixture
      // configures the project's set (it must, since MOTIR-4653), and the two
      // fields ride the envelope SIDE BY SIDE over the same four repositories —
      // `code` as the code-graph view, `repositories` as the configuration view.
      // Neither absorbed the other, which is the thing that was forbidden.
      //
      // `ref` is a cuid, so it is matched by type; `state: 'connected'` is what a
      // row linked by a fixture carries (the same shape
      // `tests/fixtures/codeContextFixtures.ts` produces). It used to read
      // `proposed`, because the fixture built its rows with `addRow` and the
      // resolver keyed on the REALIZED repo rather than on the state — and that
      // is exactly what changed: `resolveProjectCodeContext` filters on
      // `isEstablishedState`, so a fixture that leaves its rows proposed is
      // code-blind. The `repositories` view is the configuration view and reports
      // the state it finds; both halves moved together.
      repositories: {
        repos: FOUR_REPOS.map((repo) => ({
          ref: expect.any(String),
          name: repo.name,
          role: 'web',
          label: null,
          state: 'connected',
          // MOTIR-10014 — the owner input and the (unrecorded) hosting fields.
          seedSource: expect.any(String),
          hostingTarget: null,
          hostingUseCase: null,
          hostingSize: null,
        })),
        starterByTarget: await seedRegistryService.starterByHostingTarget(),
      },
      // The consent flag rides every planning submit (MOTIR-4343), generation
      // included — ON here because this fixture never touches the setting.
      recordPlanningMistakes: true,
      // The onboarding marker (MOTIR-4736) — `true` here because this fixture's
      // project has never had a plan approved (`onboardingRanAt` is null).
      onboarding: true,
      // ⚠️ AMENDED BY MOTIR-4604, RE-POINTED BY MOTIR-4807 — `context.code`'s repo
      // entries carry each repo's INDEX STATE beside its coordinates, plus the
      // reason it is behind and an explicit in-flight flag. The state comes from
      // the ONE derivation (`lib/codeGraph/indexState.ts`) over motir-core's own
      // columns; the `freshnessUnknown` flag this block once carried is gone with
      // the boundary read that made it possible.
      //
      // ⚠️ THE INVARIANT THIS ASSERTION PROTECTS SURVIVES MOTIR-4653, AND ITS
      // OLD JUSTIFICATION DOES NOT. It used to read: *`code` is the WORKSPACE
      // grant list, `repositories` is the PROJECT set, and the two are separate
      // fields with separate scopes.* The SCOPES now coincide — `code` is drawn
      // from the project's set too — so that sentence no longer distinguishes
      // them and would read as an argument for merging.
      //
      // What MOTIR-3044 actually forbade was MERGING THE FIELDS, and that is
      // untouched: they answer different questions about the same set. `code` is
      // the code-graph view (coordinates + index state, for grounding);
      // `repositories` is the configuration view (roles, realization, ownership).
      // Two views of one set is not one field, and widening a repo's own entry
      // with facts about that same repo was never the thing forbidden.
      code: {
        repos: [
          // ⚠️ THE ORDER IS THE PROJECT SET'S, NOT THE MIRROR'S (MOTIR-4653).
          // This list used to be owner-asc / name-asc, because it came from the
          // grant mirror's display order. It comes from `project_repository`
          // now, which is ORDERED and whose FIRST row is the project's PRIMARY
          // repository (ADR `work-item-repository-set.md` §1.3) — so the planner
          // is handed the project's own ordering rather than an alphabetical
          // one. Asserted positionally, deliberately: a set that silently
          // re-sorted would change which repository reads as primary.
          {
            provider: 'github',
            repoRef: 'moooon/motir-core',
            defaultBranch: 'main',
            // ⚠️ THE UNION OF TWO INDEPENDENT ADDITIONS, and it is a union because
            // `resolvePlanningCodeContext` SPREADS the thin entry: `indexed` is
            // MOTIR-4826's ledger fact, carried up from `resolveProjectCodeContext`, and
            // the five below are MOTIR-4604's freshness. Neither replaced the
            // other and the planning envelope carries both.
            indexed: false,
            indexState: 'never',
            reason: 'never_indexed',
            refreshInFlight: false,
            indexedAt: null,
            commitsBehind: null,
          },
          {
            provider: 'github',
            repoRef: 'moooon/motir-ai',
            defaultBranch: 'main',
            indexed: false,
            indexState: 'never',
            reason: 'never_indexed',
            refreshInFlight: false,
            indexedAt: null,
            commitsBehind: null,
          },
          {
            provider: 'github',
            repoRef: 'moooon/motir-gateway',
            defaultBranch: 'master',
            indexed: false,
            indexState: 'never',
            reason: 'never_indexed',
            refreshInFlight: false,
            indexedAt: null,
            commitsBehind: null,
          },
          {
            provider: 'github',
            repoRef: 'moooon/motir-meta',
            defaultBranch: 'main',
            indexed: false,
            indexState: 'never',
            reason: 'never_indexed',
            refreshInFlight: false,
            indexedAt: null,
            commitsBehind: null,
          },
        ],
      },
    });
  });

  it('OMITS context.code entirely when the workspace has no installation (byte-identical envelope)', async () => {
    const ctx = await seedProjectContext();

    await aiGenerationService.startGeneration(ctx, { prompt: 'start fresh' });

    const [jobKind, , context] = vi.mocked(submitJob).mock.calls[0]!;
    expect(jobKind).toBe('plan');
    // Exact shape: today's envelope, with NO `code` key (absent, not empty).
    // `recordPlanningMistakes` is the opposite discipline and is why it appears
    // in BOTH arms: `code` uses absence to mean "this workspace has none", while
    // an absent consent flag is read as ON, so it is sent unconditionally.
    expect(context).toEqual({
      prompt: 'start fresh',
      generateExplanations: false,
      recordPlanningMistakes: true,
      // The onboarding marker (MOTIR-4736) — `true` here because this fixture's
      // project has never had a plan approved (`onboardingRanAt` is null).
      onboarding: true,
    });
    expect(Object.keys(context as object)).not.toContain('code');
  });

  it('OMITS context.code entirely when the project’s SET is empty, though the workspace granted four', async () => {
    // MOTIR-4653's criterion, and it is asserted on the SERIALIZED ENVELOPE
    // rather than on a null check for a reason: what the contract promises is
    // that a project with no configured repositories produces the SAME bytes as
    // one whose workspace never connected anything. A `code` key carrying an
    // empty `repos` array would satisfy every null check and break that promise,
    // and motir-ai would read it as "asked and answered: none" rather than as
    // "not asked".
    const ctx = await seedProjectContext();
    await githubInstallationService.persistInstallation({
      workspaceId: ctx.workspaceId,
      installation: {
        installationId: 'inst-4',
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: FOUR_REPOS,
    });

    await aiGenerationService.startGeneration(ctx, { prompt: 'start fresh' });

    const [, , context] = vi.mocked(submitJob).mock.calls[0]!;
    expect(context).toEqual({
      prompt: 'start fresh',
      generateExplanations: false,
      recordPlanningMistakes: true,
      onboarding: true,
    });
    expect(Object.keys(context as object)).not.toContain('code');
  });
});
