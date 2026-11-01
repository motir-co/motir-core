import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from './helpers/adminDb';

// The PLANNING-SESSION code context (Story MOTIR-1754 · MOTIR-4604) — the half of
// `context.code` that lets a session say something TRUE about its own freshness.
//
// The guarantee under test is not "a refresh is enqueued". It is that **the
// session never announces a fetch that is not happening**: the REASON explains and
// the IN-FLIGHT FLAG decides which exits the gate (MOTIR-4601) may offer, and they
// are two facts because they answer two questions. A session that says "I've
// started a refresh" while nothing is running would be a new instance of exactly
// the silent dishonesty this story exists to remove, wearing the fix's clothes.

const enqueueMock = vi.fn<(d: unknown, opts?: unknown) => Promise<void>>();
vi.mock('@/lib/github/indexEnqueue', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    enqueueCodeGraphRefresh: (d: unknown, opts?: unknown) => enqueueMock(d, opts),
  };
});

const { resolvePlanningCodeContext, resolveRefreshDisposition } =
  await import('@/lib/ai/codeContext');
const { createTestWorkspace, createTestProject } = await import('./fixtures');
const { githubInstallationService } = await import('@/lib/services/githubInstallationService');
const { linkProjectRepo } = await import('./helpers/projectRepoLink');
const { truncateAuthTables } = await import('./helpers/db');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const REPO = {
  providerRepoId: '901',
  owner: 'acme',
  name: 'web',
  defaultBranch: 'main',
  archived: false,
};

async function connect(workspaceId: string, provider?: 'gitlab') {
  await githubInstallationService.persistInstallation({
    workspaceId,
    installation: {
      installationId: `inst-${workspaceId}`,
      accountLogin: 'acme',
      accountType: 'Organization',
    },
    repos: [REPO],
    ...(provider ? { provider } : {}),
  });
  if (provider) {
    await adminDb.githubRepo.updateMany({
      where: { repoId: REPO.providerRepoId },
      data: { provider },
    });
  }
}

async function setHead(headSha: string | null) {
  await adminDb.githubRepo.updateMany({
    where: { repoId: REPO.providerRepoId },
    data: { defaultBranchHeadSha: headSha },
  });
}

// ⚠️ FRESHNESS IS DB STATE, NOT A MOCKED BOUNDARY ANSWER (MOTIR-4807). This
// suite used to drive the index state by stubbing motir-ai's
// `GET /v1/code-graph/status`; MOTIR-4724 made every fact a motir-core column, so
// the honest fixture writes those columns and the ledger row the derivation
// reads. Nothing is stubbed here any more.
async function setIndexed(
  workspaceId: string,
  indexedHeadSha: string | null,
  isIndexed = true,
): Promise<void> {
  await adminDb.githubRepo.updateMany({
    where: { repoId: REPO.providerRepoId },
    data: { indexedHeadSha, indexedAt: isIndexed ? new Date('2026-09-01T10:00:00Z') : null },
  });
  if (!isIndexed) return;
  // `hasSucceededIndex` is a LEDGER fact — a succeeded run carrying the ref.
  await adminDb.jobRun.create({
    data: {
      workspaceId,
      functionId: 'system.code-graph-index',
      eventName: 'code-graph/index.requested',
      eventId: `evt-${Math.random().toString(36).slice(2)}`,
      lane: 'inngest',
      attempt: 1,
      status: 'succeeded',
      output: { repoRef: 'acme/web' },
    },
  });
}

/** The project's own set row, ESTABLISHED against the connected mirror — what the
 *  code-context read joins on since MOTIR-1767.
 *
 *  ⚠️ `linkProjectRepo`, not `addRow` + a realize: `addRow` records a PROPOSED
 *  row, and `resolveProjectCodeContext` filters proposals out
 *  (`isEstablishedState`), so an `addRow`-built fixture leaves the project
 *  code-blind and every case here reads as an empty answer rather than as a
 *  missing link. */
async function link(projectId: string, ctx: { userId: string; workspaceId: string }) {
  const repo = await adminDb.githubRepo.findFirstOrThrow({
    where: { repoId: REPO.providerRepoId },
  });
  await linkProjectRepo({
    workspaceId: ctx.workspaceId,
    projectId,
    githubRepoId: repo.id,
    name: REPO.name,
    role: 'web',
  });
}

beforeEach(async () => {
  await truncateAuthTables();
  enqueueMock.mockReset();
  enqueueMock.mockResolvedValue(undefined);
});

afterAll(async () => {
  await db.$disconnect();
});

// ── The disposition, as a pure function: EVERY reason arm is drivable ───────
describe('resolveRefreshDisposition — a TOTAL mapping, two arms shipping unreachable', () => {
  it('a CURRENT graph enqueues nothing, carries no reason and reports nothing in flight', () => {
    expect(resolveRefreshDisposition({ indexState: 'indexed', canIndex: true })).toEqual({
      refreshInFlight: false,
      enqueue: false,
    });
  });

  it('STALE and indexable → the session enqueues, and the wait is honest', () => {
    expect(resolveRefreshDisposition({ indexState: 'stale', canIndex: true })).toEqual({
      reason: 'refresh_enqueued',
      refreshInFlight: true,
      enqueue: true,
    });
  });

  it('INDEXING → already running: in flight, nothing to enqueue', () => {
    expect(resolveRefreshDisposition({ indexState: 'indexing', canIndex: true })).toEqual({
      reason: 'refresh_pending',
      refreshInFlight: true,
      enqueue: false,
    });
  });

  it('NEVER INDEXED → no wait is offered; a first index is the connect path’s', () => {
    expect(resolveRefreshDisposition({ indexState: 'never', canIndex: true })).toEqual({
      reason: 'never_indexed',
      refreshInFlight: false,
      enqueue: false,
    });
  });

  it('a host that CANNOT be indexed outranks every other explanation', () => {
    // Nothing to enqueue and no wait to offer, whatever else is true — so it is
    // checked before `paused` and before `refresh_failing` rather than after.
    for (const indexState of ['stale', 'indexing', 'never'] as const) {
      expect(resolveRefreshDisposition({ indexState, canIndex: false })).toEqual({
        reason: 'provider_unsupported',
        refreshInFlight: false,
        enqueue: false,
      });
    }
    expect(
      resolveRefreshDisposition({
        indexState: 'stale',
        canIndex: false,
        paused: true,
        refreshFailing: true,
      }),
    ).toMatchObject({ reason: 'provider_unsupported' });
  });

  it('PAUSED and FAILING are pinned now, and both offer NO wait', () => {
    // ⚠️ Both ship UNREACHABLE from production signals, on purpose — `paused`
    // waits on MOTIR-4593, and no per-repo failure signal exists (a refresh run
    // writes `output.repoRef` only on SUCCESS, so a failed row cannot be
    // attributed to a repository at all). They are pinned HERE, from constructed
    // inputs, so the day a producer lands the arm is already correct and tested.
    expect(
      resolveRefreshDisposition({ indexState: 'stale', canIndex: true, paused: true }),
    ).toEqual({
      reason: 'paused',
      refreshInFlight: false,
      enqueue: false,
    });
    expect(
      resolveRefreshDisposition({ indexState: 'stale', canIndex: true, refreshFailing: true }),
    ).toEqual({ reason: 'refresh_failing', refreshInFlight: false, enqueue: false });
  });

  it('EVERY reason value is produced by some input — none is unreachable by accident', () => {
    // AC 3: a new reason cannot appear without a consumer. This is the pin.
    const produced = new Set(
      (
        [
          { indexState: 'stale', canIndex: true },
          { indexState: 'indexing', canIndex: true },
          { indexState: 'never', canIndex: true },
          { indexState: 'stale', canIndex: false },
          { indexState: 'stale', canIndex: true, refreshFailing: true },
          { indexState: 'stale', canIndex: true, paused: true },
        ] as Parameters<typeof resolveRefreshDisposition>[0][]
      )
        .map((i) => resolveRefreshDisposition(i).reason)
        .filter((r): r is NonNullable<typeof r> => r !== undefined),
    );
    expect([...produced].sort()).toEqual([
      'never_indexed',
      'paused',
      'provider_unsupported',
      'refresh_enqueued',
      'refresh_failing',
      'refresh_pending',
    ]);
  });

  it('NO reason value names a commercial cause — no credit, allowance or quota word', () => {
    // MOTIR-4541: a paused reason names the STATE, never why in cost terms, and
    // nothing a session could echo into a card body a customer reads.
    const all = [
      'refresh_enqueued',
      'refresh_pending',
      'never_indexed',
      'provider_unsupported',
      'refresh_failing',
      'paused',
    ];
    for (const reason of all) {
      expect(reason).not.toMatch(/credit|allowance|quota|balance|billing|cost|spend|exhaust/i);
    }
  });
});

// ── The producer, end to end ────────────────────────────────────────────────
describe('resolvePlanningCodeContext', () => {
  it('a STALE graph whose INSTALLATION is gone enqueues nothing, and does not throw', async () => {
    // ⚠️ THE `installationIdForWorkspace` NULL PATH, and the `if (installationId)`
    // arm behind it — the state left when the GitHub App is uninstalled while the
    // repository rows it created survive. The graph is stale, so the read WANTS
    // to enqueue a refresh; there is no installation to mint a token from, so it
    // cannot. It must say so quietly rather than throw, because this runs on the
    // PLANNING SUBMIT path and a person's plan must not fail over a connection
    // somebody removed.
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    await connect(workspace.id);
    await setHead(SHA_B);
    await setIndexed(workspace.id, SHA_A);
    await link(project.id, { userId: owner.id, workspaceId: workspace.id });
    // The installation stops belonging to THIS workspace while its mirror rows
    // stay — which is the state that matters and the one a delete cannot
    // reproduce (deleting the installation cascades the repository away, and then
    // there is no repository left to report). `GithubRepo.workspaceId` is the
    // repository's own tenancy column since MOTIR-1931, so the row survives the
    // installation moving.
    const { workspace: elsewhere } = await createTestWorkspace();
    await adminDb.githubInstallation.updateMany({
      where: { workspaceId: workspace.id },
      data: { workspaceId: elsewhere.id },
    });

    const code = await resolvePlanningCodeContext({
      userId: owner.id,
      workspaceId: workspace.id,
      projectId: project.id,
    });

    // The repository is still reported — it is still the project's — and it is
    // still honestly stale.
    expect(code?.repos[0]).toMatchObject({ repoRef: 'acme/web', indexState: 'stale' });
    // But nothing was enqueued: there is no installation to act through.
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('an UNREGISTERED provider cannot be indexed, and says so instead of throwing on the submit path', async () => {
    // ⚠️ THE `catch` IN `resolvePlanningCodeContext`, which nothing reached.
    // `getGitProvider` THROWS on a provider id no provider registered, and this
    // read runs on the PLANNING SUBMIT path — so the throw would fail a person's
    // plan over a repository row nobody can index anyway. The code answers
    // `canIndex = false` instead, and the disposition then reports
    // `provider_unsupported`, which is the same verdict a registered-but-
    // incapable host gets.
    //
    // `resolveRefreshDisposition` is already asserted directly with
    // `canIndex: false` further up this file; that pins the DISPOSITION and
    // cannot reach the computation of `canIndex`, which is the branch here.
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    await connect(workspace.id);
    // A provider string no provider is registered under — the row shape a
    // future host, or a bad backfill, would leave behind.
    await adminDb.githubRepo.updateMany({
      where: { repoId: REPO.providerRepoId },
      data: { provider: 'bitbucket' },
    });
    await setHead(SHA_B);
    await setIndexed(workspace.id, SHA_A);
    await link(project.id, { userId: owner.id, workspaceId: workspace.id });

    const code = await resolvePlanningCodeContext({
      userId: owner.id,
      workspaceId: workspace.id,
      projectId: project.id,
    });

    expect(code?.repos[0]).toMatchObject({
      repoRef: 'acme/web',
      reason: 'provider_unsupported',
      refreshInFlight: false,
    });
    // …and NOTHING was enqueued: there is no container that could index it.
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('a STALE graph enqueues a refresh THROUGH the shipped path, as a session start, and says so', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    await connect(workspace.id);
    await setHead(SHA_B);
    await setIndexed(workspace.id, SHA_A);
    await link(project.id, { userId: owner.id, workspaceId: workspace.id });

    const code = await resolvePlanningCodeContext({
      userId: owner.id,
      workspaceId: workspace.id,
      projectId: project.id,
    });

    expect(code?.repos[0]).toMatchObject({
      repoRef: 'acme/web',
      indexState: 'stale',
      reason: 'refresh_enqueued',
      refreshInFlight: true,
      indexedAt: expect.any(Date),
      commitsBehind: null,
      // MOTIR-10094 — the pair rides the envelope, so the session can list what
      // changed between the graph's commit and the head.
      indexedSha: SHA_A,
      defaultHead: SHA_B,
    });
    // Through `enqueueCodeGraphRefresh` — the same event and debounce key a push
    // uses, rather than a second trigger with its own semantics — but as a
    // SESSION START, so it is due now instead of sitting out the 2-minute push
    // debounce (MOTIR-5360; the row-level assertion is
    // tests/jobs/code-graph-refresh-session-start.test.ts).
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock.mock.calls[0]![0]).toMatchObject({
      workspaceId: workspace.id,
      repoOwner: 'acme',
      repoName: 'web',
      defaultBranch: 'main',
    });
    expect(enqueueMock.mock.calls[0]![1]).toEqual({ trigger: 'session_start' });
  });

  it('repeated session starts stay IN FLIGHT on every one of them — not only the first', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    await connect(workspace.id);
    await setHead(SHA_B);
    await setIndexed(workspace.id, SHA_A);
    await link(project.id, { userId: owner.id, workspaceId: workspace.id });
    const args = { userId: owner.id, workspaceId: workspace.id, projectId: project.id };

    const runs = [
      await resolvePlanningCodeContext(args),
      await resolvePlanningCodeContext(args),
      await resolvePlanningCodeContext(args),
    ];

    // ⚠️ A DEBOUNCED NO-OP STILL COUNTS AS IN FLIGHT. The coalescing happens in
    // the scheduler — five sessions in ten minutes are five events and ONE run —
    // so every session must still be told a wait is honest. Backwards, the
    // come-back exit goes silent exactly when it is most useful.
    for (const code of runs) {
      expect(code?.repos[0]).toMatchObject({ reason: 'refresh_enqueued', refreshInFlight: true });
    }
  });

  it('a CURRENT graph enqueues nothing, adds no reason and reports no refresh', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    await connect(workspace.id);
    await setHead(SHA_A);
    await setIndexed(workspace.id, SHA_A);
    await link(project.id, { userId: owner.id, workspaceId: workspace.id });

    const code = await resolvePlanningCodeContext({
      userId: owner.id,
      workspaceId: workspace.id,
      projectId: project.id,
    });

    expect(code?.repos[0]).toMatchObject({ indexState: 'indexed', refreshInFlight: false });
    expect(code?.repos[0]).not.toHaveProperty('reason');
    // The common path is untouched.
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('a NEVER-INDEXED repo enqueues NOTHING and offers no wait', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    await connect(workspace.id);
    await setHead(SHA_B);
    await setIndexed(workspace.id, null, false);
    await link(project.id, { userId: owner.id, workspaceId: workspace.id });

    const code = await resolvePlanningCodeContext({
      userId: owner.id,
      workspaceId: workspace.id,
      projectId: project.id,
    });

    expect(code?.repos[0]).toMatchObject({
      indexState: 'never',
      reason: 'never_indexed',
      refreshInFlight: false,
    });
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('a provider that CANNOT be indexed enqueues nothing and offers no wait', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    await connect(workspace.id, 'gitlab');
    await setHead(SHA_B);
    await setIndexed(workspace.id, SHA_A);
    await link(project.id, { userId: owner.id, workspaceId: workspace.id });

    const code = await resolvePlanningCodeContext({
      userId: owner.id,
      workspaceId: workspace.id,
      projectId: project.id,
    });

    expect(code?.repos[0]).toMatchObject({
      reason: 'provider_unsupported',
      refreshInFlight: false,
    });
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('NO connected repo returns undefined — `context.code` is omitted, nothing is enqueued', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });

    const code = await resolvePlanningCodeContext({
      userId: owner.id,
      workspaceId: workspace.id,
      projectId: project.id,
    });

    // Byte-identical to a code-less envelope, exactly as before this card.
    expect(code).toBeUndefined();
    expect(enqueueMock).not.toHaveBeenCalled();
    // This case used to also assert motir-ai's status endpoint was never called.
    // There is no such call left to make (MOTIR-4724 moved every freshness fact
    // into motir-core), so the claim is now that no INDEX was enqueued for a
    // project that has no repository to index — which the line above states.
  });

  it('the session is NEVER blocked by the enqueue — a queue failure is logged and planning proceeds', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    await connect(workspace.id);
    await setHead(SHA_B);
    await setIndexed(workspace.id, SHA_A);
    await link(project.id, { userId: owner.id, workspaceId: workspace.id });
    enqueueMock.mockRejectedValue(new Error('queue down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const code = await resolvePlanningCodeContext({
      userId: owner.id,
      workspaceId: workspace.id,
      projectId: project.id,
    });

    expect(code?.repos).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
