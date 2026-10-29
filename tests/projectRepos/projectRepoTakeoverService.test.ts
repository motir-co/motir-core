import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { projectRepoTakeoverService } from '@/lib/services/projectRepoTakeoverService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { ciMinutesMeterService } from '@/lib/services/ciMinutesMeterService';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import {
  GithubIdentityRequiredError,
  ProjectRepoNotTransferableError,
  ProjectRepoTakeoverStateError,
  RepoTransferRefusedError,
} from '@/lib/projectRepos/errors';
import { encryptToken } from '@/lib/github/tokenCrypto';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { createRunnerGroupFake, type RunnerGroupFake } from '../helpers/runnerGroupFake';

// TAKE IT OVER over real Postgres (Story MOTIR-1775 · MOTIR-711) — the handoff that
// moves a Motir-owned repository into the user's own GitHub.
//
// What is pinned here is every place the saga could be quietly wrong, and each one
// is proved by RUNNING it rather than reasoned about:
//
//   1. THE ORDER OF THE TWO HOST CALLS. `ci-minutes-allowance.md` §G requires the
//      Actions re-enable to happen BEFORE the transfer, because afterwards Motir's
//      credential no longer reaches the repository. Asserted as an ORDER over the
//      recorded calls — an end-state assertion ("enabled at the end") passes with
//      the bug, which is exactly why it is not the assertion.
//   2. `transfer_pending` is a REAL state resolved by the `repository` webhook,
//      never an optimistic assumption — and the webhook is IDEMPOTENT under the
//      redelivery GitHub makes routine.
//   3. `done` requires a real `GithubInstallation` under the new owner. A completed
//      transfer alone must NOT settle the row: that would report a broken loop as a
//      finished handoff.
//   4. A connect-existing row is the already-yours NO-OP, and taking over one row of
//      several leaves the others untouched and working.
//   5. Metering stops at the transfer with NO metering code change — driven through
//      the SHIPPED meter, before and after.
//   6. Concurrency: two simultaneous requests produce ONE consistent outcome.
//
// Real Postgres; the ONLY fake is `fetch` (the GitHub HTTP boundary — the shipped
// convention for these suites). Tests connect as the superuser, so RLS is inert
// here by design; tenancy is proved in `project-repo-rls.test.ts`.

const MOTIR_ORG = 'motir-projects';
const INSTALLATION_ID = '556677';
const NEW_OWNER = 'yue-personal';

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

let calls: Call[];
/** The project's own runner group (MOTIR-1972) — the establish/connect
 *  ARRANGEMENT these tests build now syncs it. */
let runnerGroups: RunnerGroupFake;
/** Status the fake GitHub answers the transfer with; 202 is the real success. */
let transferStatus: number;
/** Whether the transfer response reports the repo ALREADY under the new owner —
 *  how an org target (no acceptance step) is staged versus a personal one. */
let transferCompletes: boolean;
/** Status the fake GitHub answers the Actions PUT with; 204 is the real success. */
let actionsStatus: number;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installGitHub(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      calls.push({ url: u, method, body });

      if (u.includes('/access_tokens')) {
        // GitHub mints only for an installation id IT issued. A token asked for
        // under any other id — Motir's own `GithubInstallation.id` cuid above all,
        // the MOTIR-10062 defect — is the 404 production answers, never a token.
        const id = decodeURIComponent(
          /\/app\/installations\/([^/]+)\/access_tokens/.exec(u)?.[1] ?? '',
        );
        const known = await adminDb.githubInstallation.findUnique({
          where: { installationId: id },
        });
        if (!known) return json(404, { message: 'Not Found' });
        return json(200, {
          token: 'ghs_provisioning',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      // Establishing / connecting a row now syncs the project's own runner
      // group (MOTIR-1972), so this suite's GitHub has to serve those endpoints.
      const group = await runnerGroups.handle(u, method, body);
      if (group) return group;
      if (u.endsWith('/actions/permissions') && method === 'PUT') {
        if (actionsStatus !== 204) return json(actionsStatus, { message: 'nope' });
        return new Response(null, { status: 204 });
      }
      // MOTIR-1900's collaborator invitation, which `attachRealizedRepo` fires
      // post-commit — so the fixture's own establish hop reaches it. Served (not
      // just tolerated) so the fixture builds a row the way production does; it
      // is best-effort in the service, and `hostCallSequence` ignores it.
      if (u.endsWith(`/orgs/${MOTIR_ORG}/installation`)) {
        return json(200, { id: Number(INSTALLATION_ID) });
      }
      if (u.includes('/collaborators/')) {
        return json(201, { id: 1, html_url: 'https://github.com/invitation/1' });
      }
      if (u.includes('/actions/runs/')) {
        // The workflow-jobs read the SHIPPED meter makes. One 10-minute
        // ubuntu-latest job — the amount is irrelevant here; whether it is
        // metered AT ALL is the assertion.
        return json(200, {
          total_count: 1,
          jobs: [
            {
              id: 1,
              name: 'ci',
              started_at: '2026-07-31T11:50:00.000Z',
              completed_at: '2026-07-31T12:00:00.000Z',
              labels: ['ubuntu-latest'],
              run_attempt: 1,
            },
          ],
        });
      }
      if (u.endsWith('/transfer') && method === 'POST') {
        if (transferStatus !== 202) return json(transferStatus, { message: 'no such owner' });
        // GitHub answers 202 in BOTH cases; the BODY is what says where the repo
        // is, which is why the client reads `owner.login` rather than the status.
        return json(202, {
          id: 900_001,
          name: 'acme-web',
          owner: { login: transferCompletes ? NEW_OWNER : MOTIR_ORG },
        });
      }
      throw new Error(`unexpected fetch: ${method} ${u}`);
    }),
  );
}

/**
 * The takeover's OWN two host calls, in the order they were made — the instrument
 * behind the §G ordering assertion.
 *
 * ⚠️ CLASSIFIES BY EXACT ENDPOINT and drops everything else, deliberately. An
 * "everything that isn't /transfer is the Actions call" fallback silently absorbs
 * any OTHER GitHub call in the fixture's path and reports it as an extra
 * `actions` — which is exactly what happened when MOTIR-1900 wired a collaborator
 * invitation into `attachRealizedRepo`, a seam this file's fixture uses. The
 * ordering assertion must be about these two calls and nothing else, or an
 * unrelated card's new side effect breaks it.
 */
function hostCallSequence(): string[] {
  return calls.flatMap((c) => {
    if (c.url.endsWith('/transfer') && c.method === 'POST') return ['transfer'];
    if (c.url.endsWith('/actions/permissions') && c.method === 'PUT') return ['actions'];
    return [];
  });
}

/**
 * A Motir-CREATED row, realized against the shared provisioning installation —
 * the only shape a takeover applies to. `state: 'created'` is reached through the
 * real machine (`proposed → creating → created`), never by writing the column, so
 * the fixture cannot accidentally manufacture an ownership the product could not.
 */
async function motirOwnedRow(
  fx: WorkItemFixture,
  name: string,
  opts: { repoId?: string } = {},
): Promise<{ rowId: string; repoId: string }> {
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId: INSTALLATION_ID },
    create: {
      installationId: INSTALLATION_ID,
      workspaceId: null,
      accountLogin: MOTIR_ORG,
      accountType: 'Organization',
    },
    update: {},
  });
  const repoId = opts.repoId ?? `host-${name}`;
  const mirror = await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      repoId,
      owner: MOTIR_ORG,
      name,
      defaultBranch: 'main',
      archived: false,
    },
  });
  const row = await projectRepoSetService.addRow(fx.projectId, { role: 'web', name }, fx.ctx);
  await projectRepoSetService.markCreating(row.id, fx.ctx);
  await projectRepoSetService.attachRealizedRepo(row.id, mirror.id, fx.ctx);
  return { rowId: row.id, repoId };
}

/** A row realized by CONNECTING a repository the user already owned — the
 *  already-yours case, reached through the real `proposed → connected` hop. */
async function connectedRow(fx: WorkItemFixture, name: string): Promise<string> {
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId: `inst-user-${fx.workspaceId}` },
    create: {
      installationId: `inst-user-${fx.workspaceId}`,
      workspaceId: fx.workspaceId,
      accountLogin: NEW_OWNER,
      accountType: 'User',
    },
    update: {},
  });
  const mirror = await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      repoId: `host-${name}`,
      owner: NEW_OWNER,
      name,
      defaultBranch: 'main',
      archived: false,
    },
  });
  const row = await projectRepoSetService.addRow(fx.projectId, { role: 'api', name }, fx.ctx);
  await projectRepoSetService.attachRealizedRepo(row.id, mirror.id, fx.ctx);
  return row.id;
}

/** Give the acting user a connected GitHub identity — the precondition a takeover
 *  has, and whose absence is the connect-prompt error. */
async function connectIdentity(fx: WorkItemFixture): Promise<void> {
  await adminDb.githubIdentity.create({
    data: {
      userId: fx.ownerId,
      githubUserId: `gh-${fx.ownerId}`,
      githubLogin: NEW_OWNER,
      accessTokenEncrypted: encryptToken('gho_user'),
    },
  });
}

async function readRow(rowId: string, fx: WorkItemFixture) {
  const rows = await projectRepoSetService.listByProject(fx.projectId, fx.ctx);
  return rows.find((r) => r.id === rowId)!;
}

beforeEach(async () => {
  await truncateAuthTables();
  calls = [];
  transferStatus = 202;
  transferCompletes = false;
  actionsStatus = 204;
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  // BOTH App identities: the takeover's own calls mint under the PROVISIONING
  // app (`Administration: write` — MOTIR-1779), while the CI meter reads a run's
  // jobs under the USER-FACING one. The metering assertion drives the shipped
  // meter, so it needs the second pair too.
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  vi.stubEnv('GITHUB_APP_ID', '999');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
  _resetInstallationTokenCache();
  runnerGroups = createRunnerGroupFake(MOTIR_ORG);
  installGitHub();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── §G — the ORDER of the two host calls ────────────────────────────────────

describe('the runner variable needs no unset — the ORG scope is the mechanism (MOTIR-2015)', () => {
  it('makes NO Actions-variable call on the handover path, and needs none', async () => {
    const fx = await makeWorkItemFixture();
    await connectIdentity(fx);
    const { rowId } = await motirOwnedRow(fx, 'acme-web');

    await projectRepoTakeoverService.requestTakeover(rowId, NEW_OWNER, fx.ctx);

    // §N.1. `MOTIR_RUNNER` is an ORGANIZATION variable, so it is a property of
    // `motir-projects` and not of the repository: the transfer moves the repo OUT
    // of the org, it stops resolving the org's variables the instant the move
    // lands, `vars.MOTIR_RUNNER` is empty in the new owner's account, and
    // `runs-on: ${{ vars.MOTIR_RUNNER || 'ubuntu-latest' }}` falls back on its own.
    //
    // This asserts the ABSENCE deliberately, because the absence is the design.
    // A REPOSITORY variable would travel with the repo and take PRECEDENCE, so the
    // handed-over repo would keep asking for `motir-runner` in an account where no
    // runner will ever register — and a job nobody can serve does not fail, it
    // QUEUES until GitHub expires it at 24 hours. If a future card ever introduces
    // a repo-scoped `MOTIR_RUNNER` (§7.3's per-project-label fallback), this test
    // is what will fail, and the unset belongs in this saga, ordered BEFORE the
    // transfer for the same reason §G orders the Actions re-enable before it.
    expect(calls.filter((c) => c.url.includes('/actions/variables'))).toEqual([]);
  });
});

describe('the Actions re-enable', () => {
  it('happens BEFORE the transfer — the ordering §G makes binding', async () => {
    // The whole point: once the repo leaves Motir's org, the provisioning App's
    // `Administration: write` no longer reaches it, so a re-enable issued after
    // the transfer would 404 and the repo would arrive at its new owner with
    // Actions dead. This asserts the ORDER, not the end state — an end-state
    // assertion passes with the bug.
    const fx = await makeWorkItemFixture();
    await connectIdentity(fx);
    const { rowId } = await motirOwnedRow(fx, 'acme-web');

    await projectRepoTakeoverService.requestTakeover(rowId, NEW_OWNER, fx.ctx);

    expect(hostCallSequence()).toEqual(['actions', 'transfer']);
  });

  it('mints its token for GitHub\u2019s NUMERIC installation id, never Motir\u2019s cuid (MOTIR-10062)', async () => {
    // The mirror row's `installationId` is the foreign key to
    // `GithubInstallation.id` — a cuid GitHub has never heard of. The token must be
    // minted for the installation's own `installationId`, the id GitHub issued.
    const fx = await makeWorkItemFixture();
    await connectIdentity(fx);
    const { rowId } = await motirOwnedRow(fx, 'acme-web');
    const cuid = (
      await adminDb.githubInstallation.findUniqueOrThrow({
        where: { installationId: INSTALLATION_ID },
      })
    ).id;

    await projectRepoTakeoverService.requestTakeover(rowId, NEW_OWNER, fx.ctx);

    const minted = calls.filter((c) => c.url.includes('/access_tokens')).map((c) => c.url);
    expect(minted).toContain(
      `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`,
    );
    expect(minted.some((u) => u.includes(cuid))).toBe(false);
    expect(hostCallSequence()).toEqual(['actions', 'transfer']);
  });

  it('fails the takeover, calling nothing, when the installation is no longer on record', async () => {
    // Nothing on GitHub can be addressed without the installation GitHub issued,
    // so the row records `failed` with its reason and is never transferred.
    const fx = await makeWorkItemFixture();
    await connectIdentity(fx);
    const { rowId } = await motirOwnedRow(fx, 'acme-web');
    vi.spyOn(githubInstallationRepository, 'findHostInstallationIdsByIds').mockResolvedValue(
      new Map(),
    );

    await expect(
      projectRepoTakeoverService.requestTakeover(rowId, NEW_OWNER, fx.ctx),
    ).rejects.toBeInstanceOf(RepoTransferRefusedError);

    expect(hostCallSequence()).toEqual([]);
    const row = await readRow(rowId, fx);
    expect(row.takeover).toMatchObject({ state: 'failed' });
    expect(row.takeover?.failureReason).toMatch(/installation/);
  });

  it('re-enables UNCONDITIONALLY — even for a repo Motir had PAUSED at exhaustion', async () => {
    // §G: "the transfer RESUMES Actions on the repository, unconditionally — even
    // while the org is still exhausted." Once GitHub bills the user, Motir has no
    // reason to hold their CI off.
    const fx = await makeWorkItemFixture();
    await connectIdentity(fx);
    const { rowId } = await motirOwnedRow(fx, 'acme-web');
    // Stage the MOTIR-1907 pause: intent disabled, already asserted on the host.
    await withWorkspaceContext({ userId: fx.ownerId, workspaceId: fx.workspaceId }, async (tx) => {
      await projectRepoRepository.setCiActionsIntent([rowId], true, new Date(), tx);
      await projectRepoRepository.markCiActionsApplied(rowId, tx);
    });

    await projectRepoTakeoverService.requestTakeover(rowId, NEW_OWNER, fx.ctx);

    const enable = calls.find((c) => c.url.endsWith('/actions/permissions'));
    expect(enable?.body).toEqual({ enabled: true });

    // And the stored INTENT is cleared, or MOTIR-1907's sweep would re-assert the
    // disable Motir just deliberately lifted — a real re-pause of the user's CI.
    const persisted = await adminDb.projectRepo.findUniqueOrThrow({ where: { id: rowId } });
    expect(persisted.ciActionsDisabled).toBe(false);
    expect(persisted.ciActionsAppliedAt?.getTime()).toBe(persisted.ciActionsIntentAt?.getTime());
  });

  it('does NOT transfer when the re-enable fails — the repo stays Motir-reachable', async () => {
    // Transferring after a failed re-enable would strand the repository: Motir can
    // no longer reach it to fix what it just failed to do.
    const fx = await makeWorkItemFixture();
    await connectIdentity(fx);
    const { rowId } = await motirOwnedRow(fx, 'acme-web');
    actionsStatus = 500;

    await expect(
      projectRepoTakeoverService.requestTakeover(rowId, NEW_OWNER, fx.ctx),
    ).rejects.toBeInstanceOf(RepoTransferRefusedError);

    expect(hostCallSequence()).toEqual(['actions']);
    const row = await readRow(rowId, fx);
    expect(row.takeover).toMatchObject({ state: 'failed' });
    expect(row.takeover?.failureReason).toBeTruthy();
  });
});

// ── The asynchronous transfer + its confirmation ────────────────────────────

describe('the transfer', () => {
  it('lands in `transfer_pending` for a personal target — never an optimistic done', async () => {
    const fx = await makeWorkItemFixture();
    await connectIdentity(fx);
    const { rowId } = await motirOwnedRow(fx, 'acme-web');

    const out = await projectRepoTakeoverService.requestTakeover(rowId, NEW_OWNER, fx.ctx);

    expect(out.state).toBe('transfer_pending');
    expect(out.transferAccepted).toBe(false);
    const row = await readRow(rowId, fx);
    expect(row.takeover).toMatchObject({ state: 'transfer_pending', targetOwner: NEW_OWNER });
    // NOT transferred yet — the accept has not happened.
    expect(row.takeover?.transferredAt).toBeNull();
  });

  it('skips straight to `awaiting_reinstall` when GitHub reports the new owner already', async () => {
    // An ORG target usually needs no acceptance, and GitHub says so in the body.
    const fx = await makeWorkItemFixture();
    await connectIdentity(fx);
    const { rowId } = await motirOwnedRow(fx, 'acme-web');
    transferCompletes = true;

    const out = await projectRepoTakeoverService.requestTakeover(rowId, NEW_OWNER, fx.ctx);

    expect(out).toMatchObject({ state: 'awaiting_reinstall', transferAccepted: true });
  });

  it('records `failed` WITH ITS REASON when GitHub refuses, and stays re-promptable', async () => {
    const fx = await makeWorkItemFixture();
    await connectIdentity(fx);
    const { rowId } = await motirOwnedRow(fx, 'acme-web');
    transferStatus = 422;

    await expect(
      projectRepoTakeoverService.requestTakeover(rowId, NEW_OWNER, fx.ctx),
    ).rejects.toBeInstanceOf(RepoTransferRefusedError);

    const failed = await readRow(rowId, fx);
    expect(failed.takeover?.state).toBe('failed');
    expect(failed.takeover?.failureReason).toContain('422');

    // RE-PROMPTABLE: asking again restarts the saga rather than wedging.
    transferStatus = 202;
    const retried = await projectRepoTakeoverService.requestTakeover(rowId, NEW_OWNER, fx.ctx);
    expect(retried.state).toBe('transfer_pending');
    // And the retry does not carry the previous attempt's excuse.
    expect((await readRow(rowId, fx)).takeover?.failureReason).toBeNull();
  });
});

// ── The `repository` transferred webhook ────────────────────────────────────

describe('the `repository` transferred delivery', () => {
  async function deliver(repoId: string, owner = NEW_OWNER) {
    return githubWebhookService.handleEvent('repository', {
      action: 'transferred',
      repository: {
        id: repoId,
        name: 'acme-web',
        default_branch: 'main',
        owner: { login: owner },
      },
    });
  }

  it('advances `transfer_pending → awaiting_reinstall` and re-stamps the mirror', async () => {
    const fx = await makeWorkItemFixture();
    await connectIdentity(fx);
    const { rowId, repoId } = await motirOwnedRow(fx, 'acme-web');
    await projectRepoTakeoverService.requestTakeover(rowId, NEW_OWNER, fx.ctx);

    expect(await deliver(repoId)).toEqual({ event: 'repository', outcome: 'applied' });

    const row = await readRow(rowId, fx);
    expect(row.takeover?.state).toBe('awaiting_reinstall');
    expect(row.takeover?.transferredAt).not.toBeNull();
    // The mirror now says the repo is THEIRS — which is also what silently drops
    // the row out of MOTIR-1907's pause fan-out (it re-checks the owner at call
    // time), with no code in this card doing the excluding.
    const githubRepoRow = await adminDb.githubRepo.findFirstOrThrow({ where: { repoId } });
    expect(githubRepoRow).toMatchObject({
      owner: NEW_OWNER,
    });
  });

  it('is IDEMPOTENT under redelivery — a second delivery does not re-advance', async () => {
    const fx = await makeWorkItemFixture();
    await connectIdentity(fx);
    const { rowId, repoId } = await motirOwnedRow(fx, 'acme-web');
    await projectRepoTakeoverService.requestTakeover(rowId, NEW_OWNER, fx.ctx);

    await deliver(repoId);
    const afterFirst = await adminDb.projectRepo.findUniqueOrThrow({ where: { id: rowId } });

    expect(await deliver(repoId)).toEqual({ event: 'repository', outcome: 'already_applied' });

    const afterSecond = await adminDb.projectRepo.findUniqueOrThrow({ where: { id: rowId } });
    expect(afterSecond.takeoverState).toBe('awaiting_reinstall');
    // The stamp did not move — a redelivery is a no-op, not a re-application.
    expect(afterSecond.takeoverTransferredAt?.getTime()).toBe(
      afterFirst.takeoverTransferredAt?.getTime(),
    );
  });

  it('updates the mirror but drives NO saga for a transfer to an owner nobody asked for', async () => {
    const fx = await makeWorkItemFixture();
    await connectIdentity(fx);
    const { rowId, repoId } = await motirOwnedRow(fx, 'acme-web');
    await projectRepoTakeoverService.requestTakeover(rowId, NEW_OWNER, fx.ctx);

    expect(await deliver(repoId, 'someone-else')).toEqual({
      event: 'repository',
      outcome: 'owner_mismatch',
    });

    // The coordinates are a FACT and are recorded; the saga is not advanced by a
    // move Motir did not request.
    const githubRepoRow2 = await adminDb.githubRepo.findFirstOrThrow({ where: { repoId } });
    expect(githubRepoRow2).toMatchObject({
      owner: 'someone-else',
    });
    expect((await readRow(rowId, fx)).takeover?.state).toBe('transfer_pending');
  });

  it('acks a repository it does not know rather than 500ing GitHub into retries', async () => {
    expect(await deliver('host-nobody')).toEqual({ event: 'repository', outcome: 'unknown_repo' });
  });

  it('ignores every non-`transferred` repository action', async () => {
    const result = await githubWebhookService.handleEvent('repository', {
      action: 'created',
      repository: { id: '1', name: 'x', owner: { login: 'y' } },
    });
    expect(result).toMatchObject({ event: 'ignored' });
  });

  // A webhook body is the one input Motir does not control, so every field the
  // handler reads is asserted to degrade into a typed `malformed` no-op rather
  // than a 500 — a 500 makes GitHub retry a delivery no retry can fix.
  it.each([
    ['no repository object at all', { action: 'transferred' }],
    ['a repository that is not an object', { action: 'transferred', repository: 'nope' }],
    [
      'no repository id',
      { action: 'transferred', repository: { name: 'x', owner: { login: 'y' } } },
    ],
    ['no owner object', { action: 'transferred', repository: { id: '1', name: 'x' } }],
    [
      'a non-string owner login',
      { action: 'transferred', repository: { id: '1', name: 'x', owner: { login: 42 } } },
    ],
    [
      'a non-string repo name',
      { action: 'transferred', repository: { id: '1', name: null, owner: { login: 'y' } } },
    ],
  ])('is a typed no-op for a delivery with %s', async (_label, body) => {
    expect(await githubWebhookService.handleEvent('repository', body)).toEqual({
      event: 'repository',
      outcome: 'malformed',
    });
  });

  it('accepts a NUMERIC repository id, as GitHub actually sends it', async () => {
    // The mirror stores the id as a string; GitHub sends a JSON number. Coercing
    // is what lets the row be found at all — a bug here reads as `unknown_repo`.
    const fx = await makeWorkItemFixture();
    await connectIdentity(fx);
    const { rowId } = await motirOwnedRow(fx, 'acme-web', { repoId: '900001' });
    await projectRepoTakeoverService.requestTakeover(rowId, NEW_OWNER, fx.ctx);

    const result = await githubWebhookService.handleEvent('repository', {
      action: 'transferred',
      // A NUMBER, not a string — and no `default_branch`, which is optional.
      repository: { id: 900001, name: 'acme-web', owner: { login: NEW_OWNER } },
    });

    expect(result).toEqual({ event: 'repository', outcome: 'applied' });
    // The optional branch was absent, so the stored one is left alone.
    expect(
      await adminDb.githubRepo.findFirstOrThrow({ where: { repoId: '900001' } }),
    ).toMatchObject({
      owner: NEW_OWNER,
      defaultBranch: 'main',
      archived: false,
    });
  });
});

// ── `done` requires the loop to have SURVIVED ───────────────────────────────

describe('completing the handoff', () => {
  it('does NOT settle on the transfer alone — an uninstalled App is a broken loop', async () => {
    // The load-bearing detail of the whole card: a GitHub App installation is
    // ACCOUNT-scoped, so a transferred repo with no installation under its new
    // owner cannot be dispatched to and cannot be indexed. Calling that `done`
    // would report a broken loop as a finished handoff.
    const fx = await makeWorkItemFixture();
    await connectIdentity(fx);
    const { rowId, repoId } = await motirOwnedRow(fx, 'acme-web');
    await projectRepoTakeoverService.requestTakeover(rowId, NEW_OWNER, fx.ctx);
    await githubWebhookService.handleEvent('repository', {
      action: 'transferred',
      repository: { id: repoId, name: 'acme-web', owner: { login: NEW_OWNER } },
    });

    const probed = await projectRepoTakeoverService.completeIfReinstalled(rowId, fx.ctx);

    expect(probed.takeover?.state).toBe('awaiting_reinstall');
    expect(probed.takeover?.completedAt).toBeNull();
  });

  it('settles `done` once an installation exists under the new owner', async () => {
    const fx = await makeWorkItemFixture();
    await connectIdentity(fx);
    const { rowId, repoId } = await motirOwnedRow(fx, 'acme-web');
    await projectRepoTakeoverService.requestTakeover(rowId, NEW_OWNER, fx.ctx);
    await githubWebhookService.handleEvent('repository', {
      action: 'transferred',
      repository: { id: repoId, name: 'acme-web', owner: { login: NEW_OWNER } },
    });

    // The user installs the Motir App on their own account and selects the repo.
    await adminDb.githubInstallation.create({
      data: {
        installationId: 'inst-new-owner',
        workspaceId: fx.workspaceId,
        accountLogin: NEW_OWNER,
        accountType: 'User',
      },
    });

    const done = await projectRepoTakeoverService.completeIfReinstalled(rowId, fx.ctx);

    expect(done.takeover?.state).toBe('done');
    expect(done.takeover?.completedAt).not.toBeNull();
    // Re-probing a settled row is a clean no-op, so the surface may poll freely.
    expect(
      (await projectRepoTakeoverService.completeIfReinstalled(rowId, fx.ctx)).takeover?.state,
    ).toBe('done');
  });

  it('matches the installation login case-INSENSITIVELY, as GitHub logins are', async () => {
    const fx = await makeWorkItemFixture();
    await connectIdentity(fx);
    const { rowId, repoId } = await motirOwnedRow(fx, 'acme-web');
    await projectRepoTakeoverService.requestTakeover(rowId, NEW_OWNER.toUpperCase(), fx.ctx);
    await githubWebhookService.handleEvent('repository', {
      action: 'transferred',
      repository: { id: repoId, name: 'acme-web', owner: { login: NEW_OWNER } },
    });
    await adminDb.githubInstallation.create({
      data: {
        installationId: 'inst-new-owner',
        workspaceId: fx.workspaceId,
        accountLogin: NEW_OWNER,
        accountType: 'User',
      },
    });

    expect(
      (await projectRepoTakeoverService.completeIfReinstalled(rowId, fx.ctx)).takeover?.state,
    ).toBe('done');
  });
});

// ── Per-ROW, not per-project ────────────────────────────────────────────────

describe('a set with mixed ownership', () => {
  it('is a clean NO-OP for a connect-existing row — it is already yours', async () => {
    const fx = await makeWorkItemFixture();
    await connectIdentity(fx);
    const rowId = await connectedRow(fx, 'my-own-api');
    // The ARRANGEMENT itself now talks to GitHub — connecting a row syncs the
    // project's runner group (MOTIR-1972) — so the "nothing was called"
    // assertion below is scoped to what the ACT does, not to the whole test.
    calls.length = 0;

    const err = await projectRepoTakeoverService
      .requestTakeover(rowId, NEW_OWNER, fx.ctx)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProjectRepoNotTransferableError);
    // The REASON is what lets the surface render this as the calm already-yours
    // state rather than as a failure.
    expect((err as ProjectRepoNotTransferableError).reason).toBe('already_yours');
    // Nothing was called and nothing was written.
    expect(calls).toHaveLength(0);
  });

  it('leaves the OTHER rows untouched and working when one is taken over', async () => {
    const fx = await makeWorkItemFixture();
    await connectIdentity(fx);
    const first = await motirOwnedRow(fx, 'acme-web');
    const second = await motirOwnedRow(fx, 'acme-api', { repoId: 'host-acme-api' });

    await projectRepoTakeoverService.requestTakeover(first.rowId, NEW_OWNER, fx.ctx);

    const other = await readRow(second.rowId, fx);
    expect(other.takeover).toBeNull();
    expect(other).toMatchObject({ state: 'created', established: true });
    expect(other.realizedRepo).toMatchObject({ owner: MOTIR_ORG });
  });

  it('refuses a row with no repository on the host at all', async () => {
    const fx = await makeWorkItemFixture();
    await connectIdentity(fx);
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'not-yet' },
      fx.ctx,
    );

    const err = await projectRepoTakeoverService
      .requestTakeover(row.id, NEW_OWNER, fx.ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProjectRepoNotTransferableError);
    expect((err as ProjectRepoNotTransferableError).reason).toBe('not_realized');
  });
});

// ── The connect prompt, not a failure ───────────────────────────────────────

describe('a user with no connected GitHub identity', () => {
  it('gets the typed connect-prompt error, and nothing is called or written', async () => {
    const fx = await makeWorkItemFixture();
    const { rowId } = await motirOwnedRow(fx, 'acme-web');
    // See above: establishing the row syncs the project's runner group, so the
    // assertion is about the ACT, not the arrangement.
    calls.length = 0;

    await expect(
      projectRepoTakeoverService.requestTakeover(rowId, NEW_OWNER, fx.ctx),
    ).rejects.toBeInstanceOf(GithubIdentityRequiredError);

    expect(calls).toHaveLength(0);
    expect((await readRow(rowId, fx)).takeover).toBeNull();
  });
});

// ── Concurrency ─────────────────────────────────────────────────────────────

describe('two simultaneous takeover requests for one row', () => {
  it('produce ONE consistent outcome and no lost update', async () => {
    // The claim is a locked read-derived write: the legality of STARTING is
    // derived from the current takeover state, so that state must not move
    // between the read and the write.
    //
    // ⚠️ THE WARM-UP IS LOAD-BEARING, not tidiness. Without it the two calls do
    // NOT overlap: each one's pre-transaction work (the identity read, the access
    // check, and Prisma opening a fresh pooled connection) takes long enough that
    // the first claim COMMITS before the second one begins, so the test passes
    // with the lock deleted — proving nothing. Mutation-checked: with the warm-up
    // in place, removing `lockById` makes this fail (both claims succeed); with
    // the warm-up removed, it passes either way.
    const fx = await makeWorkItemFixture();
    await connectIdentity(fx);
    const { rowId } = await motirOwnedRow(fx, 'acme-web');

    // Warm the pool AND every read the claim makes before it opens its
    // transaction, so both racers arrive at the row at the same moment.
    await Promise.all([
      projectRepoTakeoverService.completeIfReinstalled(rowId, fx.ctx),
      projectRepoTakeoverService.completeIfReinstalled(rowId, fx.ctx),
      projectRepoTakeoverService.completeIfReinstalled(rowId, fx.ctx),
      projectRepoTakeoverService.completeIfReinstalled(rowId, fx.ctx),
    ]);

    const results = await Promise.allSettled([
      projectRepoTakeoverService.requestTakeover(rowId, NEW_OWNER, fx.ctx),
      projectRepoTakeoverService.requestTakeover(rowId, NEW_OWNER, fx.ctx),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason,
    ).toBeInstanceOf(ProjectRepoTakeoverStateError);
    // Exactly ONE transfer was issued for one repository.
    expect(hostCallSequence().filter((c) => c === 'transfer')).toHaveLength(1);
  });
});

// ── Metering stops at the transfer, with NO metering code change ────────────

describe('the CI meter', () => {
  /** Drive the SHIPPED meter with a completed run for `owner/acme-web`. */
  async function meterRun(owner: string, runId: string, repoId: string) {
    return ciMinutesMeterService.meterWorkflowRun(
      {
        providerRepoId: repoId,
        runId,
        attempt: 1,
        repoOwner: owner,
        repoName: 'acme-web',
        workflowName: 'CI',
        completedAt: new Date('2026-07-31T12:00:00.000Z'),
      },
      INSTALLATION_ID,
    );
  }

  it('meters a run under Motir\u2019s org and NONE after the owner changes \u2014 no branch here', async () => {
    // `ci-minutes-allowance.md` \u00a75.1/\u00a75.5 gate metering on the RUN's own repository
    // owner, so the transfer stops the billing with NO code in this card. This
    // asserts the property against the SHIPPED gate; if a later change moved the
    // gate onto the mirror (or onto a project column), this is what would go red.
    vi.stubEnv('MOTIR_CLOUD', 'true');
    const fx = await makeWorkItemFixture();
    await connectIdentity(fx);
    const { repoId } = await motirOwnedRow(fx, 'acme-web');

    const before = await meterRun(MOTIR_ORG, '7001', repoId);
    // The same repository, one transfer later: GitHub now reports the run under
    // the USER's login, and that is the only thing that changed.
    const after = await meterRun(NEW_OWNER, '7002', repoId);

    expect(before.outcome).toBe('metered');
    expect(after).toEqual({ outcome: 'not_metered', reason: 'foreign_owner' });
    const ciWorkflowRunUsageCount = await adminDb.ciWorkflowRunUsage.count();
    expect(ciWorkflowRunUsageCount).toBe(1);
  });
});

// ── The `repository` ARCHIVED / UNARCHIVED delivery (MOTIR-1959) ─────────────
//
// The same event the takeover saga listens on carries a second, independent
// fact: whether the repository still accepts writes. It matters here rather than
// only at establish time because archiving is something the repository's OWNER
// does, typically long after the row settled — which is precisely the MOTIR-1956
// incident, and the reason a state recorded once and never refreshed would be a
// guard in name only.
describe('the `repository` archived / unarchived delivery', () => {
  async function deliver(action: 'archived' | 'unarchived', repoId: string) {
    return githubWebhookService.handleEvent('repository', {
      action,
      repository: { id: repoId, name: 'acme-web', owner: { login: MOTIR_ORG } },
    });
  }

  const mirror = (repoId: string) => adminDb.githubRepo.findFirst({ where: { repoId } });

  it('flips the mirror row and reports it applied', async () => {
    const fx = await makeWorkItemFixture();
    const { repoId } = await motirOwnedRow(fx, 'acme-web');
    expect((await mirror(repoId))?.archived).toBe(false);

    expect(await deliver('archived', repoId)).toEqual({
      event: 'repository',
      outcome: 'archived_applied',
    });
    expect((await mirror(repoId))?.archived).toBe(true);
  });

  it('flips it BACK on `unarchived` — the recorded state follows the host both ways', async () => {
    const fx = await makeWorkItemFixture();
    const { repoId } = await motirOwnedRow(fx, 'acme-web');
    await deliver('archived', repoId);

    expect(await deliver('unarchived', repoId)).toEqual({
      event: 'repository',
      outcome: 'archived_applied',
    });
    expect((await mirror(repoId))?.archived).toBe(false);
  });

  it('is idempotent under REDELIVERY', async () => {
    // GitHub retries. A second delivery writes the same value rather than
    // throwing, so a retry can never be the thing that breaks the mirror.
    const fx = await makeWorkItemFixture();
    const { repoId } = await motirOwnedRow(fx, 'acme-web');
    await deliver('archived', repoId);
    expect(await deliver('archived', repoId)).toEqual({
      event: 'repository',
      outcome: 'archived_applied',
    });
    expect((await mirror(repoId))?.archived).toBe(true);
  });

  it('NEVER throws for a repository Motir does not mirror', async () => {
    // The shared provisioning installation sees deliveries for repositories that
    // belong to no project row; a 500 here would make GitHub retry a delivery no
    // retry can fix. Same answer the transfer path gives.
    expect(await deliver('archived', 'host-nobody')).toEqual({
      event: 'repository',
      outcome: 'unknown_repo',
    });
  });

  it('reports `malformed` for a delivery carrying no repository id', async () => {
    expect(await githubWebhookService.handleEvent('repository', { action: 'archived' })).toEqual({
      event: 'repository',
      outcome: 'malformed',
    });
  });

  it('leaves an unrelated `repository` action ignored, exactly as before', async () => {
    // The two handled actions must not swallow the rest of the event: a
    // `renamed` / `edited` delivery is still a fast 2xx no-op.
    expect(
      await githubWebhookService.handleEvent('repository', {
        action: 'renamed',
        repository: { id: 'host-acme-web' },
      }),
    ).toEqual({ event: 'ignored', reason: 'unhandled_repository_action:renamed' });
  });
});
