import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { capturePullRequestFiles, githubWebhookService } from '@/lib/services/githubWebhookService';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { toLinkedPullRequestDto } from '@/lib/mappers/githubMappers';
import { MAX_CAPTURED_PR_PATHS } from '@/lib/github/pullRequestFiles';
import type { NormalizedChangeRequest } from '@/lib/git/types';
import { _resetInstallationTokenCache, type GithubAppRole } from '@/lib/github/appAuth';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { stubAppCredentials } from '../helpers/appCredentials';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';

// MOTIR-2922 — the merge CAPTURE: a merged pull request's changed paths and its
// merge instant land on the `github_pull_request` row, and the accessor a
// subsumption check consumes reads them back. Real Postgres (the motir-core
// convention); the GitHub transport is stubbed at `fetch`, so what these tests
// assert is the ROW, never the fetcher's return value.
//
// The load-bearing assertion in this file is the one about FAILURE. The capture
// rides on a delivery whose real job is the status sync, and `notes.html` #39 is
// the standing rule that a post-commit side effect may never fail the committed
// work. A swallowed error that also swallowed the sync would satisfy "no
// exception escaped" while destroying the thing the delivery exists for — so the
// test compares the sync's whole outcome against a control run in which the fetch
// succeeded, rather than merely checking that nothing threw.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-capture';
const REPO_PROVIDER_ID = '777';
const MERGED_AT = '2026-08-15T09:30:00.000Z';

async function makeScenario(
  email: string,
  ids: {
    installationId?: string;
    providerRepoId?: string;
    identifier?: string;
    /** The repository's OWNER. Defaults to the user-facing case; a HOSTED
     *  repository is owned by the provisioning org (MOTIR-5811). */
    owner?: string;
  } = {},
) {
  const installationId = ids.installationId ?? INSTALLATION_ID;
  const providerRepoId = ids.providerRepoId ?? REPO_PROVIDER_ID;
  const owner = ids.owner ?? 'moooon-B-V';
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: ids.identifier ?? 'ACME',
  });
  const ctx = { userId: user.id, workspaceId: workspace.id };
  const item = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: 'A tracked change' },
    ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', ctx);
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId,
      accountLogin: owner,
      accountType: 'Organization',
    },
    repos: [
      {
        providerRepoId,
        owner,
        name: 'motir-core',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  const repo = await adminDb.githubRepo.findFirstOrThrow({ where: { repoId: providerRepoId } });
  return { user, workspace, project, item, ctx, repo, installationId, providerRepoId, owner };
}

function prPayload(opts: {
  action: string;
  identifier: string;
  number?: number;
  state?: 'open' | 'closed';
  merged?: boolean;
  mergedAt?: string | null;
  owner?: string;
}) {
  return {
    action: opts.action,
    installation: {
      id: INSTALLATION_ID,
      account: { login: opts.owner ?? 'moooon-B-V', type: 'Organization' },
    },
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number: opts.number ?? 11,
      state: opts.state ?? 'open',
      merged: opts.merged ?? false,
      merged_at: opts.mergedAt === undefined ? (opts.merged ? MERGED_AT : null) : opts.mergedAt,
      title: `Some change (${opts.identifier})`,
      head: { ref: `subtask/${opts.identifier}-a-change` },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  };
}

// `stubAppCredentials` moved to `tests/helpers/appCredentials.ts` (MOTIR-5843) —
// the provenance sweep asserts the same property at several call sites, so the
// one-App-wired arm that makes the assertion bite is shared rather than copied.

function tokenResponse(): Response {
  return new Response(
    JSON.stringify({
      token: 'ghs_capture',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    }),
    { status: 201, headers: { 'content-type': 'application/json' } },
  );
}

/** Stub the App-auth mint + the files endpoint, PAGINATING `files` the way GitHub
 *  does. `files: null` makes the files read fail with a non-retryable status —
 *  the "GitHub blip" case. */
function stubGithub(opts: { files: string[] | null; app?: GithubAppRole }) {
  stubAppCredentials(opts.app);
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string): Promise<Response> => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/access_tokens')) return tokenResponse();
    if (u.includes('/files')) {
      if (opts.files === null) return new Response('gone', { status: 404 });
      const page = Number(new URL(u).searchParams.get('page') ?? '1');
      const slice = opts.files.slice((page - 1) * 100, page * 100);
      return new Response(JSON.stringify(slice.map((filename) => ({ filename }))), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('unexpected', { status: 500 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

async function prRow(number: number) {
  return adminDb.githubPullRequest.findFirst({ where: { number } });
}

async function statusOf(workItemId: string): Promise<string> {
  const row = await adminDb.workItem.findUnique({ where: { id: workItemId } });
  return row!.status;
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** MOTIR-3674 — the link that used to come from the head ref. */
async function linkFor(identifier: string, number = 11, owner = 'moooon-B-V') {
  await linkPrByIdentifier({
    identifier,
    owner,
    name: 'motir-core',
    number,
    headRef: `subtask/${identifier}-a-change`,
    title: `Some change (${identifier})`,
  });
}

// MOTIR-5811 — WHICH GitHub App the capture mints through.
//
// Motir runs TWO App registrations (`docs/decisions/project-repository-set.md`'s
// 2026-07-30 amendment): the user-facing App every customer installs, and the
// provisioning App installed ONLY on Motir's own org. A HOSTED repository — one
// owned by that org — is on the provisioning App and on no other, so a mint
// through the user-facing default cannot reach it at all. `mergeChangeRequest`,
// the review-permission read and the decision capture already choose by
// provenance; this capture did not.
//
// ⚠️ WHAT MADE THE DEFECT INVISIBLE is the arm these tests share with the block
// below: the capture's catch turns the refusal into a row with NO changed paths,
// and every reader of `changed_paths` sees that as a pull request that touched
// nothing. Nothing goes red; the only witness is a log line. So the assertion
// here is on the ROW, exactly as the MOTIR-2922 block's is.
//
// ⚠️ AND THE CREDENTIAL STUB IS THE ASSERTION. `stubGithub({ app: 'provisioning' })`
// wires the studio App and blanks the user-facing one, so a mint that ignored
// the repository's provenance could not have produced a token at all. A
// populated `changedPaths` is therefore a fact about WHICH App was asked, not
// merely that the fetch was reached.
const HOSTED_ORG = 'motir-projects';

describe('the capture picks the App by the repository PROVENANCE (MOTIR-5811)', () => {
  it('a HOSTED repository stores the changed paths on a MERGED delivery', async () => {
    vi.stubEnv('GITHUB_FALLBACK_ORG', HOSTED_ORG);
    const s = await makeScenario('hosted-merge-capture@example.com', { owner: HOSTED_ORG });
    await linkFor(s.item.identifier, 11, HOSTED_ORG);
    const { calls } = stubGithub({
      files: ['lib/services/githubWebhookService.ts'],
      app: 'provisioning',
    });

    const result = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({
        action: 'closed',
        identifier: s.item.identifier,
        state: 'closed',
        merged: true,
        owner: HOSTED_ORG,
      }),
    );

    expect(result).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
    const row = await prRow(11);
    expect(row!.changedPaths).toEqual(['lib/services/githubWebhookService.ts']);
    expect(row!.changedPathsTruncated).toBe(false);
    expect(row!.mergedAt?.toISOString()).toBe(MERGED_AT);
    expect(calls.some((u) => u.includes('/pulls/11/files'))).toBe(true);
  });

  // The card reports the failure on `opened` deliveries as well as merged ones,
  // and the two reach the capture by different arms — so both are asserted.
  it('a HOSTED repository stores them on an OPEN delivery too', async () => {
    vi.stubEnv('GITHUB_FALLBACK_ORG', HOSTED_ORG);
    const s = await makeScenario('hosted-open-capture@example.com', { owner: HOSTED_ORG });
    stubGithub({ files: ['lib/git/providers/github.ts'], app: 'provisioning' });

    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened', identifier: s.item.identifier, owner: HOSTED_ORG }),
    );

    const row = await prRow(11);
    expect(row!.state).toBe('open');
    expect(row!.changedPaths).toEqual(['lib/git/providers/github.ts']);
    expect(row!.mergedAt).toBeNull();
  });

  // The CONTROL, and it is the half that makes the pair mean something: with the
  // provisioning org CONFIGURED — so provenance is being evaluated rather than
  // skipped — a repository the customer owns still resolves to the user-facing
  // App. Without this, an implementation that always minted through the
  // provisioning App would pass the two tests above and break every real tenant.
  it('a repository the CUSTOMER owns still mints through the user-facing App', async () => {
    vi.stubEnv('GITHUB_FALLBACK_ORG', HOSTED_ORG);
    const s = await makeScenario('user-facing-capture@example.com');
    await linkFor(s.item.identifier);
    stubGithub({ files: ['lib/services/workflowsService.ts'] });

    const result = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'closed', identifier: s.item.identifier, state: 'closed', merged: true }),
    );

    expect(result).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
    const row = await prRow(11);
    expect(row!.changedPaths).toEqual(['lib/services/workflowsService.ts']);
  });
});

describe('the merge capture writes the row (MOTIR-2922)', () => {
  it('a MERGED delivery stores the changed paths and the merge instant', async () => {
    const s = await makeScenario('merge-capture@example.com');
    await linkFor(s.item.identifier);
    const { calls } = stubGithub({ files: ['lib/services/workflowsService.ts', 'prisma/x.sql'] });

    const result = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'closed', identifier: s.item.identifier, state: 'closed', merged: true }),
    );

    expect(result).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
    const row = await prRow(11);
    expect(row!.changedPaths).toEqual(['lib/services/workflowsService.ts', 'prisma/x.sql']);
    expect(row!.changedPathsTruncated).toBe(false);
    expect(row!.mergedAt?.toISOString()).toBe(MERGED_AT);
    expect(calls.some((u) => u.includes('/pulls/11/files'))).toBe(true);
  });

  // ⚠️ AMENDED ON THE RECORD (MOTIR-3230). This asserted the opposite — that an
  // open delivery stores NEITHER and never reads the host — and its comment gave
  // the reason: *"the capture must not even ASK, or every open and every
  // synchronize delivery would spend a rate-limited request each."*
  //
  // That reasoning is engaged with rather than overridden, and HALF OF IT IS
  // FALSE: `synchronize` has never been in `HANDLED_PR_ACTIONS` — not in the
  // handler's first commit and not since — so the expensive half of the stated
  // cost, one request per PUSH, has never been on the table. The real cost is one
  // file listing per pull request OPENED or REOPENED.
  //
  // And the other half of the trade was not stated at all: without this capture an
  // open pull request's `changedPaths` is empty, so the subsumption check cannot
  // find it however its query is widened — which made that check blind for exactly
  // the window in which somebody is still working. One request per pull request
  // buys the only window in which the finding can change what anybody does.
  it('a delivery for an OPEN pull request STORES the paths, with a null merge instant', async () => {
    const s = await makeScenario('open-capture@example.com');
    const { calls } = stubGithub({ files: ['lib/services/workflowsService.ts'] });

    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened', identifier: s.item.identifier }),
    );

    const row = await prRow(11);
    expect(row!.state).toBe('open');
    expect(row!.changedPaths).toEqual(['lib/services/workflowsService.ts']);
    // The instant is what still separates the two arms — an open row has none.
    expect(row!.mergedAt).toBeNull();
    expect(calls.some((u) => u.includes('/pulls/11/files'))).toBe(true);
  });

  it('a `synchronize` delivery is still ignored — the cost stays bounded per PULL REQUEST', async () => {
    // The bound the amendment above rests on, asserted rather than assumed: if
    // `synchronize` were ever handled, this capture WOULD become one request per
    // push and the original comment's objection would become correct.
    const s = await makeScenario('sync-ignored@example.com');
    const { calls } = stubGithub({ files: ['should-never-be-read.ts'] });

    const result = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'synchronize', identifier: s.item.identifier }),
    );

    expect(result).toMatchObject({ outcome: 'ignored_action' });
    expect(calls.some((u) => u.includes('/files'))).toBe(false);
  });

  it('the merge instant comes from the PAYLOAD, and a payload without one stays null', async () => {
    const s = await makeScenario('no-merged-at@example.com');
    stubGithub({ files: ['a.ts'] });

    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({
        action: 'closed',
        identifier: s.item.identifier,
        state: 'closed',
        merged: true,
        mergedAt: null,
      }),
    );

    const row = await prRow(11);
    // Null, never `now()`: a stamped-at-ingestion time would LOOK like the merge
    // instant and be the delivery instant, and a redelivery would move it.
    expect(row!.mergedAt).toBeNull();
    expect(row!.changedPaths).toEqual(['a.ts']);
  });

  it('a merge instant that does not PARSE is null too, not an Invalid Date', async () => {
    const s = await makeScenario('bad-merged-at@example.com');
    stubGithub({ files: ['a.ts'] });

    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({
        action: 'closed',
        identifier: s.item.identifier,
        state: 'closed',
        merged: true,
        mergedAt: 'the fifteenth of never',
      }),
    );

    const row = await prRow(11);
    // An `Invalid Date` written to the column would surface as a null-ish value a
    // consumer cannot distinguish from "not merged", or as a Prisma error on the
    // write — the parse guard is what keeps a malformed payload from becoming
    // either. The paths are still captured: one bad field is not a bad delivery.
    expect(row!.mergedAt).toBeNull();
    expect(row!.changedPaths).toEqual(['a.ts']);
  });

  it('a delivery carrying NO installation id captures nothing, and asks the host nothing', async () => {
    const s = await makeScenario('no-installation@example.com');
    const { calls } = stubGithub({ files: ['a.ts'] });
    const payload = prPayload({
      action: 'closed',
      identifier: s.item.identifier,
      state: 'closed',
      merged: true,
    }) as Record<string, unknown>;
    delete payload['installation'];

    const result = await githubWebhookService.handleEvent('pull_request', payload);

    // The sync already reports this cleanly; the capture must agree rather than
    // reaching for a token it has no installation to mint against.
    expect(result).toMatchObject({ outcome: 'unknown_installation' });
    expect(calls).toEqual([]);
  });

  it('a delivery from an installation nobody connected captures nothing', async () => {
    const s = await makeScenario('unknown-installation@example.com');
    const { calls } = stubGithub({ files: ['a.ts'] });
    const payload = prPayload({
      action: 'closed',
      identifier: s.item.identifier,
      state: 'closed',
      merged: true,
    }) as Record<string, unknown>;
    payload['installation'] = { id: 'inst-nobody-connected' };

    const result = await githubWebhookService.handleEvent('pull_request', payload);

    // DISTINCT from the payload carrying no installation at all: here there IS an
    // id and it resolves to no mirror row, so the capture has to stop one step
    // later — after asking the database, before asking GitHub.
    expect(result).toMatchObject({ outcome: 'unknown_installation' });
    expect(calls).toEqual([]);
    expect(await prRow(11)).toBeNull();
  });

  it('a delivery for a repo this installation does not mirror captures nothing', async () => {
    const s = await makeScenario('unknown-repo@example.com');
    const { calls } = stubGithub({ files: ['a.ts'] });
    const payload = prPayload({
      action: 'closed',
      identifier: s.item.identifier,
      state: 'closed',
      merged: true,
    }) as Record<string, unknown>;
    payload['repository'] = { id: 999999 };

    const result = await githubWebhookService.handleEvent('pull_request', payload);

    expect(result).toMatchObject({ outcome: 'unknown_repo' });
    expect(calls).toEqual([]);
    expect(await prRow(11)).toBeNull();
  });
});

describe('the capture survives the races the handler cannot stage', () => {
  /** The normalized change request the handler would hand the capture. */
  function normalized(number: number, providerRepoId = REPO_PROVIDER_ID): NormalizedChangeRequest {
    return {
      providerRepoId,
      number,
      state: 'closed',
      merged: true,
      headRef: 'subtask/ACME-1-a-change',
      baseRef: 'main',
      title: 'Some change (ACME-1)',
      draft: false, // MOTIR-4968 — a merged pull request is never a draft.
      headSha: null,
    };
  }

  function body() {
    return {
      installation: { id: INSTALLATION_ID },
      repository: { id: Number(REPO_PROVIDER_ID) },
      pull_request: { merged_at: MERGED_AT },
    } as Record<string, unknown>;
  }

  it('a mirror row that is GONE by the time the capture writes is logged, never thrown', async () => {
    // The race: a repo removal cascades away the PR row between the sync's commit
    // and this write. Unstageable through a delivery — the sync upserts the row on
    // the very payload that drives the capture — so the capture is called directly
    // for a number no delivery ever wrote.
    await makeScenario('capture-missing-row@example.com');
    stubGithub({ files: ['a.ts'] });

    await expect(capturePullRequestFiles(body(), normalized(4242))).resolves.toBeUndefined();

    expect(await prRow(4242)).toBeNull();
  });

  it('a failure escaping the inner fetch guard is swallowed by the outer one', async () => {
    // A pull-request number Postgres cannot store: the fetch succeeds, and the
    // WRITE is what fails — the path the inner try does not cover. It has to be as
    // invisible as a failed fetch, because by now the status sync has committed.
    await makeScenario('capture-write-throws@example.com');
    stubGithub({ files: ['a.ts'] });

    await expect(capturePullRequestFiles(body(), normalized(2 ** 40))).resolves.toBeUndefined();
  });
});

describe('a failed capture leaves the status sync untouched (notes.html #39)', () => {
  it('the sync outcome and the transition are IDENTICAL to a run whose fetch succeeded', async () => {
    // Control: the fetch succeeds.
    const ok = await makeScenario('capture-control@example.com');
    await linkFor(ok.item.identifier);
    stubGithub({ files: ['lib/db.ts'] });
    const okResult = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({
        action: 'closed',
        identifier: ok.item.identifier,
        state: 'closed',
        merged: true,
      }),
    );
    const okStatus = await statusOf(ok.item.id);
    const okRow = await prRow(11);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();

    // The same delivery, with GitHub refusing the files read.
    await truncateAuthTables();
    _resetInstallationTokenCache();
    const bad = await makeScenario('capture-blip@example.com');
    await linkFor(bad.item.identifier);
    stubGithub({ files: null });
    const badResult = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({
        action: 'closed',
        identifier: bad.item.identifier,
        state: 'closed',
        merged: true,
      }),
    );
    const badStatus = await statusOf(bad.item.id);
    const badRow = await prRow(11);

    // The outcome the delivery reports — the whole object, not just "it didn't
    // throw". A swallowed error that also swallowed the sync passes the weaker
    // check and fails this one.
    expect(badResult).toEqual({
      ...okResult,
      workItemId: bad.item.id,
    });
    expect(badStatus).toBe(okStatus);
    expect(badStatus).toBe('done');
    // The row is written all the same: the merge instant is read from the
    // delivery we already hold, so only the paths are lost.
    expect(badRow!.merged).toBe(true);
    expect(badRow!.state).toBe(okRow!.state);
    expect(badRow!.mergedAt?.toISOString()).toBe(MERGED_AT);
    expect(badRow!.changedPaths).toEqual([]);
    expect(badRow!.changedPathsTruncated).toBe(false);
  });

  it('an unreachable host is swallowed the same way a 4xx is', async () => {
    const s = await makeScenario('capture-unreachable@example.com');
    await linkFor(s.item.identifier);
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    vi.stubEnv('GITHUB_APP_ID', '999');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    );

    const result = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'closed', identifier: s.item.identifier, state: 'closed', merged: true }),
    );

    expect(result).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
    expect(await statusOf(s.item.id)).toBe('done');
    const row = await prRow(11);
    expect(row!.changedPaths).toEqual([]);
    expect(row!.mergedAt?.toISOString()).toBe(MERGED_AT);
  });
});

describe('the cap is stored, and it SAYS it capped (MOTIR-2922)', () => {
  it('a file list past MAX_CAPTURED_PR_PATHS stores exactly the cap and flags truncation', async () => {
    const s = await makeScenario('capture-cap@example.com');
    // 301 files across four pages of 100 — one past the cap.
    const files = Array.from({ length: 301 }, (_, i) => `packages/generated/f-${i}.ts`);
    stubGithub({ files });

    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'closed', identifier: s.item.identifier, state: 'closed', merged: true }),
    );

    const row = await prRow(11);
    expect(row!.changedPaths).toHaveLength(MAX_CAPTURED_PR_PATHS);
    expect(row!.changedPaths[0]).toBe('packages/generated/f-0.ts');
    expect(row!.changedPathsTruncated).toBe(true);
  });

  it('a file list under the cap stores every path and leaves the flag false', async () => {
    const s = await makeScenario('capture-under-cap@example.com');
    const files = Array.from({ length: 5 }, (_, i) => `app/page-${i}.tsx`);
    stubGithub({ files });

    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'closed', identifier: s.item.identifier, state: 'closed', merged: true }),
    );

    const row = await prRow(11);
    expect(row!.changedPaths).toEqual(files);
    expect(row!.changedPathsTruncated).toBe(false);
  });
});

describe('no shipped consumer of GithubPullRequest changes shape', () => {
  it('the Development-surface DTO carries exactly its documented keys after a capture', async () => {
    const s = await makeScenario('dto-shape@example.com');
    await linkFor(s.item.identifier);
    stubGithub({ files: ['lib/db.ts'] });
    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'closed', identifier: s.item.identifier, state: 'closed', merged: true }),
    );

    // Read through a BOUND context, as the Development surface itself does: an
    // unbound read of `github_pull_request` under `motir_app` returns [] without
    // raising, so it would assert the DTO's shape against no rows at all.
    const rows = await withWorkspaceContext(s.ctx, (tx) =>
      githubPullRequestRepository.listByWorkItemWithContext(s.item.id, tx),
    );
    expect(rows).toHaveLength(1);
    const dto = toLinkedPullRequestDto(rows[0]!);

    // The mapper enumerates its fields, so a new column cannot leak into the wire
    // shape — this pins that, because "it enumerates" is a property of today's
    // mapper and the DTO is what a client parses.
    // MOTIR-4894 took `linkedManually` OFF this list, which is the half of the
    // retirement a client can observe: the wire shape lost a key.
    // MOTIR-5005 ADDS `id` — the pull-request row's own cuid — because the
    // Development row had no way to ADDRESS a delivery: `unlinkPullRequest`
    // takes that cuid, so the remove control could not call the service the
    // service was written for. A key GAINED is as observable as one lost, which
    // is why it is edited here deliberately rather than discovered in CI.
    // MOTIR-5691 ADDS `headSha` — the head the `ci` pill is formed over. The
    // approve-to-merge frame names the member a push moved by it, and used to
    // borrow it from How to test's per-repository read, which design/github § 25
    // retired: a pull request's head is the pull request's fact, so it rides the row.
    // MOTIR-5916 ADDS `baseRef` and `conflicted` — the branch the row targets and whether
    // the host reports it conflicted AT its head, which the row's *Conflicts with {base}*
    // pill and the `conflict` withdrawal band name (design/github § 30).
    // MOTIR-10099 ADDS `preview` — the pull request's preview deployment, or null when
    // it has none, which the row's preview line draws (design/preview).
    expect(Object.keys(dto).sort()).toEqual(
      [
        'baseRef',
        'ci',
        'conflicted',
        'githubReview',
        'headSha',
        'id',
        'number',
        'preview',
        'repo',
        'state',
        'title',
        'url',
      ].sort(),
    );
    expect(dto).toMatchObject({ state: 'merged', number: 11, repo: 'moooon-B-V/motir-core' });
  });
});

describe('findTouchingPaths — the single read the subsumption check consumes', () => {
  /** Seed one PR row directly: these cases are about the QUERY, so they are set
   *  up as data rather than driven through six webhook deliveries. */
  async function seedPr(
    repoId: string,
    number: number,
    opts: {
      merged?: boolean;
      state?: string;
      mergedAt?: Date | null;
      changedPaths?: string[];
      /** Every card this pull request DELIVERS — `work_item_delivery` rows, the
       *  only association a pull request has since MOTIR-3757. */
      delivers?: string[];
    },
  ) {
    const row = await adminDb.githubPullRequest.create({
      data: {
        repoId,
        number,
        state: opts.state ?? 'closed',
        merged: opts.merged ?? true,
        headRef: `subtask/MOTIR-${number}`,
        title: `PR ${number}`,
        mergedAt: opts.mergedAt === undefined ? new Date('2026-08-15T12:00:00Z') : opts.mergedAt,
        changedPaths: opts.changedPaths ?? ['lib/services/workflowsService.ts'],
      },
    });
    const repo = await adminDb.githubRepo.findUniqueOrThrow({ where: { id: repoId } });
    for (const workItemId of opts.delivers ?? []) {
      await adminDb.workItemDelivery.create({
        data: { workspaceId: repo.workspaceId, workItemId, githubPullRequestId: row.id, repoId },
      });
    }
    return row;
  }

  async function query(s: Awaited<ReturnType<typeof makeScenario>>, paths: string[], since: Date) {
    return withWorkspaceContext(s.ctx, (tx) =>
      githubPullRequestRepository.findTouchingPaths(s.workspace.id, paths, since, tx),
    );
  }

  it('returns a merged row whose paths intersect and whose merge is after `since`', async () => {
    const s = await makeScenario('accessor-hit@example.com');
    await seedPr(s.repo.id, 101, {});

    const found = await query(
      s,
      ['lib/services/workflowsService.ts'],
      new Date('2026-08-12T00:00:00Z'),
    );

    expect(found.map((r) => r.number)).toEqual([101]);
    expect(found[0]!.repo.name).toBe('motir-core');
  });

  it('omits a row merged BEFORE `since`', async () => {
    const s = await makeScenario('accessor-old@example.com');
    await seedPr(s.repo.id, 102, { mergedAt: new Date('2026-08-01T00:00:00Z') });

    const found = await query(
      s,
      ['lib/services/workflowsService.ts'],
      new Date('2026-08-12T00:00:00Z'),
    );

    expect(found).toEqual([]);
  });

  it('omits a row whose paths do not intersect', async () => {
    const s = await makeScenario('accessor-miss@example.com');
    await seedPr(s.repo.id, 103, { changedPaths: ['README.md'] });

    const found = await query(
      s,
      ['lib/services/workflowsService.ts'],
      new Date('2026-08-12T00:00:00Z'),
    );

    expect(found).toEqual([]);
  });

  // ⚠️ THIS ASSERTION IS INVERTED FROM ITS ORIGINAL, DELIBERATELY (MOTIR-3230).
  // It read `omits an OPEN row even when its paths intersect` and asserted `[]`,
  // which was a correct statement of MOTIR-2922's merge-only scope. Returning the
  // open row IS this card's deliverable — a merged-only read is available for the
  // whole period in which the answer no longer changes anything, and blind for the
  // one window in which it would — so the guarantee is amended on the record here
  // rather than quietly deleted.
  it('RETURNS an open row whose paths intersect — the window a merged-only read misses', async () => {
    const s = await makeScenario('accessor-open@example.com');
    await seedPr(s.repo.id, 104, { state: 'open', merged: false, mergedAt: null });

    const found = await query(
      s,
      ['lib/services/workflowsService.ts'],
      new Date('2026-08-12T00:00:00Z'),
    );

    expect(found.map((r) => r.number)).toEqual([104]);
    expect(found[0]!.merged).toBe(false);
    expect(found[0]!.mergedAt).toBeNull();
  });

  it('returns an open row filed BEFORE `since` — the interval clause is the merged arm alone', async () => {
    // A pull request opened before this card was filed and still open is not old
    // evidence; it is a colleague with the file open right now. Applying the merged
    // arm's ordering clause to it would re-create exactly the blindness this card
    // exists to remove.
    const s = await makeScenario('accessor-open-old@example.com');
    await seedPr(s.repo.id, 109, { state: 'open', merged: false, mergedAt: null });

    const found = await query(
      s,
      ['lib/services/workflowsService.ts'],
      new Date('2030-01-01T00:00:00Z'),
    );

    expect(found.map((r) => r.number)).toEqual([109]);
  });

  it('omits a CLOSED-UNMERGED row — abandoned work is neither shipped nor in flight', async () => {
    // The open arm is keyed on `state: 'open'` AND `merged: false`, so a pull
    // request somebody closed without merging matches neither arm. It is the one
    // row for which both dispositions would be wrong.
    const s = await makeScenario('accessor-abandoned@example.com');
    await seedPr(s.repo.id, 110, { state: 'closed', merged: false, mergedAt: null });

    const found = await query(
      s,
      ['lib/services/workflowsService.ts'],
      new Date('2026-08-12T00:00:00Z'),
    );

    expect(found).toEqual([]);
  });

  it('returns BOTH arms together, distinguishable by their own columns', async () => {
    const s = await makeScenario('accessor-both@example.com');
    await seedPr(s.repo.id, 111, {});
    await seedPr(s.repo.id, 112, { state: 'open', merged: false, mergedAt: null });

    const found = await query(
      s,
      ['lib/services/workflowsService.ts'],
      new Date('2026-08-12T00:00:00Z'),
    );

    expect(found.map((r) => r.number).sort()).toEqual([111, 112]);
    expect(found.find((r) => r.number === 111)!.mergedAt).not.toBeNull();
    expect(found.find((r) => r.number === 112)!.mergedAt).toBeNull();
  });

  // MOTIR-3756 — this test used to be *"omits the row linked to
  // `excludeWorkItemId`, and KEEPS an unlinked one"*, and it was the ONLY caller
  // of that parameter: the one production caller passed `null`, because the
  // exclusion is a per-SUBJECT fact and `buildSubsumptionIndex` widens the query
  // to a whole batch. The parameter is deleted rather than ported to the delivery
  // table (ADR `docs/decisions/delivery-reader-migration.md` §4), so the test is
  // RETARGETED at what the accessor now promises: it returns every touching row
  // and excludes nothing. The exclusion itself is asserted where it actually
  // runs, over the delivery SET, in `tests/workItems/proseAdvisories.test.ts`.
  it('excludes NOTHING — a linked row and an unlinked one both come back', async () => {
    const s = await makeScenario('accessor-exclude@example.com');
    await seedPr(s.repo.id, 105, { delivers: [s.item.id] });
    await seedPr(s.repo.id, 106, {});

    const found = await query(
      s,
      ['lib/services/workflowsService.ts'],
      new Date('2026-08-12T00:00:00Z'),
    );

    // The KEEP half of the retired parameter's argument survives and is now
    // trivially true: an UNLINKED merge touched the paths just the same, and the
    // missing link is a fact about the tracker, not about the repository. With no
    // exclusion clause there is nothing that could drop it.
    expect(found.map((r) => r.number).sort()).toEqual([105, 106]);
  });

  it('is scoped to the workspace, and an empty path set reads nothing', async () => {
    const s = await makeScenario('accessor-tenant@example.com');
    const other = await makeScenario('accessor-tenant-other@example.com', {
      installationId: 'inst-capture-other',
      providerRepoId: '778',
      identifier: 'OTHR',
    });
    // One PR in EACH workspace's repo, identical in every other respect.
    await seedPr(s.repo.id, 107, {});
    await seedPr(other.repo.id, 108, {});

    const mine = await query(
      s,
      ['lib/services/workflowsService.ts'],
      new Date('2026-08-12T00:00:00Z'),
    );
    expect(mine.map((r) => r.number)).toEqual([107]);

    const theirs = await query(
      other,
      ['lib/services/workflowsService.ts'],
      new Date('2026-08-12T00:00:00Z'),
    );
    expect(theirs.map((r) => r.number)).toEqual([108]);

    // No paths to ask about is not "match everything" — it is nothing to match.
    expect(await query(s, [], new Date('2026-08-12T00:00:00Z'))).toEqual([]);
  });
});
