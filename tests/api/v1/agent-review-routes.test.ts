import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// A hosted REVIEW run's two doors (Story MOTIR-1626 · MOTIR-6821; ADR
// `docs/decisions/hosted-agent-run.md` §3's pointer and §8.2–§8.4, `approval-gates.md`
// §12.3–§12.5) — `GET …/review-prompt` and `POST …/agent-review`, against REAL Postgres
// through the real bearer path, the real webhook-driven green verdict that raises the
// `agent_review` gate, and the real decide door.
//
// ⚠️ EVERY REFUSAL IS DRIVEN, and each one asserts NOTHING WAS DECIDED: a verdict door that
// refuses with the right status but writes anyway is the failure this file exists for.

vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent: async () => undefined }));

import { db } from '@/lib/db';
import type { ApprovalGateKind } from '@/generated/prisma/client';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { HOSTED_RUN_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { RUN_TOKEN_ROUTES } from '@/lib/hostedRuns/runTokenRoutes';
import { WORK_LOOP_OPERATIONS } from '@/lib/api/v1/workLoop/operations';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { linkPrByIdentifier } from '../../helpers/prLink';
import { bearer, withTokenFor } from '../../fixtures/apiV1Fixtures';

const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectsService } = await import('@/lib/services/projectsService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { githubInstallationService } = await import('@/lib/services/githubInstallationService');
const { githubWebhookService } = await import('@/lib/services/githubWebhookService');
const { runCredentialService } = await import('@/lib/services/runCredentialService');
const { _resetInstallationTokenCache } = await import('@/lib/github/appAuth');
const { seedSystemPrincipal } = await import('@/scripts/plan-seed/systemPrincipal');
const { MOTIR_SYSTEM_USER_EMAIL } = await import('@/lib/ai/systemPrincipal');

const BASE = 'http://localhost:3000/api/v1';
const INSTALLATION_ID = 'inst-review-routes';
const REPO_PROVIDER_ID = '6821';
const INSTALLATION = { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } };
const REVIEW = 'agent_review' as const;
const MERGE = 'pull_request_approval' as const;
const version = (number: number, sha: string) => `moooon/acme#${number}@${sha}`;

const DESCRIPTION = [
  'Make the widget count visible.',
  '',
  '## Acceptance criteria',
  '',
  '- The header shows the widget count.',
  '- A zero count renders `0`, never blank.',
].join('\n');

// ── The scenario: a card whose one pull request has gone green with the switch on ───────

async function makeScenario(slug: string) {
  const user = await usersService.createUser({
    email: `owner-${slug}@example.com`,
    password: 'hunter2hunter2',
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Acme ${slug}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: 'ACME',
  });
  await adminDb.project.update({
    where: { id: project.id },
    data: { prMergeMode: 'manual', reviewAgentEnabled: true },
  });
  const ctx = { userId: user.id, workspaceId: workspace.id };
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: INSTALLATION_ID,
      accountLogin: 'moooon',
      accountType: 'Organization',
    },
    repos: [
      {
        providerRepoId: REPO_PROVIDER_ID,
        owner: 'moooon',
        name: 'acme',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  return { user, workspace, project, ctx };
}
type Scenario = Awaited<ReturnType<typeof makeScenario>>;

function pullRequestPayload(action: string, number: number, headRef: string, extra = {}) {
  return {
    action,
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number,
      state: 'open',
      merged: false,
      title: `The widget count (${headRef})`,
      head: { ref: headRef },
      base: { ref: 'main' },
      user: { id: 4242 },
      ...extra,
    },
  };
}

const ci = (headSha: string, number: number) =>
  githubWebhookService.handleEvent('check_suite', {
    action: 'completed',
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_suite: {
      head_sha: headSha,
      head_branch: null,
      status: 'completed',
      conclusion: 'success',
      app: { slug: 'github-actions' },
      pull_requests: [{ number }],
    },
  });

const pushTo = (identifier: string, number: number, sha: string) =>
  githubWebhookService.handleEvent(
    'pull_request',
    pullRequestPayload('synchronize', number, `subtask/${identifier}-${number}`, {
      head: { ref: `subtask/${identifier}-${number}`, sha },
    }),
  );

/** A card delivered by pull request `number`, green at `sha-a`, holding its review. */
async function reviewedCard(s: Scenario, number: number, title = `Card ${number}`) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title, descriptionMd: DESCRIPTION },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  const headRef = `subtask/${item.identifier}-${number}`;
  await linkPrByIdentifier({
    identifier: item.identifier,
    owner: 'moooon',
    name: 'acme',
    number,
    headRef,
  });
  await githubWebhookService.handleEvent(
    'pull_request',
    pullRequestPayload('opened', number, headRef),
  );
  await ci('sha-a', number);
  const [review] = await awaitingOf(item.id, REVIEW);
  expect(review, 'the green verdict raised the review').toBeDefined();
  return { item, review: review! };
}

/** A hosted run over one card, with its own credential. */
async function runFor(
  s: Scenario,
  item: { id: string; identifier: string },
  command: 'review' | 'run',
): Promise<{ runId: string; headers: Record<string, string> }> {
  const run = await adminDb.dispatchRun.create({
    data: {
      workspaceId: s.workspace.id,
      projectId: s.project.id,
      command,
      origin: 'hosted',
      createdById: s.user.id,
      cards: {
        create: [
          {
            workspaceId: s.workspace.id,
            workItemId: item.id,
            workItemKey: item.identifier,
            position: 0,
          },
        ],
      },
    },
  });
  const { token } = await runCredentialService.mintRunCredential({
    dispatchRunId: run.id,
    dispatcherUserId: s.user.id,
    expiresAt: new Date(Date.now() + 60 * 60_000),
  });
  return { runId: run.id, headers: bearer(token) };
}

// ── The doors ────────────────────────────────────────────────────────────────

async function readPrompt(headers: Record<string, string>, key: string): Promise<Response> {
  const { GET } = await import('@/app/api/v1/work-items/[key]/review-prompt/route');
  return GET(new Request(`${BASE}/work-items/${key}/review-prompt`, { headers }), {
    params: Promise.resolve({ key }),
  });
}

async function submit(
  headers: Record<string, string>,
  key: string,
  body: unknown,
): Promise<Response> {
  const { POST } = await import('@/app/api/v1/work-items/[key]/agent-review/route');
  return POST(
    new Request(`${BASE}/work-items/${key}/agent-review`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ key }) },
  );
}

const bodyOf = async (res: Response) => (await res.json()) as Record<string, unknown>;

const gatesOf = (workItemId: string, kind: ApprovalGateKind) =>
  adminDb.approvalGate.findMany({ where: { workItemId, kind }, orderBy: { createdAt: 'asc' } });
const awaitingOf = async (workItemId: string, kind: ApprovalGateKind) =>
  (await gatesOf(workItemId, kind)).filter((g) => g.state === 'awaiting');
const verdictEvents = (dispatchRunId: string) =>
  adminDb.dispatchRunEvent.findMany({
    where: { dispatchRunId, kind: 'review_verdict' },
    orderBy: { seq: 'asc' },
  });

beforeEach(async () => {
  await truncateAuthTables();
  resetRateLimitStore();
  _resetInstallationTokenCache();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('GET …/review-prompt — the brief, for the review run’s own card only', () => {
  it('serves the card, its criteria and every pull request at the REVIEWED head', async () => {
    const s = await makeScenario('prompt');
    const { item, review } = await reviewedCard(s, 71, 'Show the widget count');
    const { headers } = await runFor(s, item, 'review');

    // The branch moves on AFTER the review was raised — the prompt still names `sha-a`.
    // (A synchronize supersedes the review, so read the prompt first, then prove the pin
    // against the stored version.)
    const res = await readPrompt(headers, item.identifier);
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body['gateId']).toBe(review.id);
    expect(body['subjectVersion']).toBe(version(71, 'sha-a'));
    expect(body['pullRequests']).toEqual([
      {
        repository: 'moooon/acme',
        number: 71,
        headSha: 'sha-a',
        baseBranch: 'main',
        headBranch: `subtask/${item.identifier}-71`,
        url: 'https://github.com/moooon/acme/pull/71',
      },
    ]);
    const prompt = String(body['prompt']);
    expect(prompt).toContain('Show the widget count');
    expect(prompt).toContain('Make the widget count visible.');
    expect(prompt).toContain('- A zero count renders `0`, never blank.');
    expect(prompt).toContain('reviewed head: sha-a');
    expect(prompt).toContain('Push NOTHING');
    expect(prompt).toContain('Post NOTHING to GitHub');
    expect(prompt).toContain(`"subjectVersion": "${version(71, 'sha-a')}"`);
    // No UNCONDITIONAL CLAUDE.md / AGENTS.md line (MOTIR-6904): the only mention is the
    // "if the checkout has one" instruction.
    expect(prompt.split('\n').filter((l) => /CLAUDE\.md|AGENTS\.md/.test(l))).toEqual([
      '  - If a repository’s checkout has a CLAUDE.md or AGENTS.md at its root, read it as',
    ]);
    // A read — the gate is untouched.
    expect(await awaitingOf(item.id, REVIEW)).toHaveLength(1);
  });

  it('lists the criteria of the run target and every descendant in tree order, and nothing of another workspace (MOTIR-10336)', async () => {
    const s = await makeScenario('prompt-tree');
    const crit = (line: string) => `Intro.\n\n## Acceptance criteria\n\n- ${line}\n`;
    const make = (kind: 'story' | 'task' | 'subtask', title: string, parentId?: string) =>
      workItemsService.createWorkItem(
        { projectId: s.project.id, kind, title, descriptionMd: crit(`${title} holds.`), parentId },
        s.ctx,
      );
    const story = await make('story', 'The story');
    const first = await make('task', 'First child', story.id);
    const second = await make('task', 'Second child', story.id);
    const grandchild = await make('subtask', 'Grandchild', first.id);
    const dropped = await make('task', 'Dropped child', story.id);
    const bare = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Bare child', parentId: story.id },
      s.ctx,
    );
    // A card of ANOTHER workspace, forced under the story behind every guard: the tree is
    // read inside the run's workspace context, so it never appears.
    const strangerUser = await usersService.createUser({
      email: 'stranger-tree@example.com',
      password: 'hunter2hunter2',
      name: 'Stranger',
    });
    const { workspace: strangerSpace } = await workspacesService.createWorkspace({
      name: 'Elsewhere',
      ownerUserId: strangerUser.id,
    });
    const strangerProject = await projectsService.createProject({
      workspaceId: strangerSpace.id,
      actorUserId: strangerUser.id,
      name: 'Elsewhere',
      identifier: 'ELSE',
    });
    const foreign = await workItemsService.createWorkItem(
      { projectId: strangerProject.id, kind: 'task', title: 'Foreign child' },
      { userId: strangerUser.id, workspaceId: strangerSpace.id },
    );
    await adminDb.$executeRawUnsafe('ALTER TABLE "work_item" DISABLE TRIGGER USER');
    try {
      await adminDb.workItem.update({ where: { id: foreign.id }, data: { parentId: story.id } });
    } finally {
      await adminDb.$executeRawUnsafe('ALTER TABLE "work_item" ENABLE TRIGGER USER');
    }
    await workItemsService.updateStatus(dropped.id, 'cancelled', s.ctx);
    // The story is reviewed once the cards under it are finished.
    for (const child of [grandchild, first, second, bare]) {
      await workItemsService.updateStatus(child.id, 'in_progress', s.ctx);
      await workItemsService.updateStatus(child.id, 'done', s.ctx);
    }
    await workItemsService.updateStatus(story.id, 'in_progress', s.ctx);
    const headRef = `story/${story.identifier}-75`;
    await linkPrByIdentifier({
      identifier: story.identifier,
      owner: 'moooon',
      name: 'acme',
      number: 75,
      headRef,
    });
    await githubWebhookService.handleEvent(
      'pull_request',
      pullRequestPayload('opened', 75, headRef),
    );
    await ci('sha-a', 75);
    expect(await awaitingOf(story.id, REVIEW)).toHaveLength(1);
    const { headers } = await runFor(s, story, 'review');

    const res = await readPrompt(headers, story.identifier);
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(Object.keys(body).sort()).toEqual(
      ['gateId', 'key', 'prompt', 'pullRequests', 'subjectVersion'].sort(),
    );
    const prompt = String(body['prompt']);
    expect(prompt).toContain('CRITERIA CHECKLIST');
    const heads = [
      `${story.identifier} — The story (the run target)`,
      `${first.identifier} — First child (done`,
      `${second.identifier} — Second child (done`,
      `${dropped.identifier} — Dropped child (skipped`,
      `${bare.identifier} — Bare child`,
      `${grandchild.identifier} — Grandchild`,
    ];
    const at = heads.map((head) => prompt.indexOf(head));
    expect(
      at.every((i) => i > 0),
      JSON.stringify(at),
    ).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(prompt).toContain('    - Grandchild holds.');
    expect(prompt).toContain('    - Second child holds.');
    expect(prompt).not.toContain('Dropped child holds.');
    expect(prompt).not.toContain('Foreign child');
    expect(prompt).toContain('    (This card names no acceptance criteria.');
    expect(prompt).toContain(`ONE verdict, for ${story.identifier} — the run target — only.`);
  });

  it('is SERVED when motir-ai fails every convention read — each repository reviewed against the card alone (MOTIR-6904)', async () => {
    const s = await makeScenario('prompt-no-convention');
    const { item } = await reviewedCard(s, 74, 'Show the widget count');
    const { headers } = await runFor(s, item, 'review');

    // motir-ai configured and answering 503 to every convention read — faked at the HTTP
    // boundary, every other request passing through.
    const aiUrl = 'http://motir-ai.review-routes.test';
    vi.stubEnv('MOTIR_AI_URL', aiUrl);
    vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
    const realFetch = globalThis.fetch;
    const conventionReads: string[] = [];
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(url instanceof Request ? url.url : String(url));
      if (parsed.host === new URL(aiUrl).host) {
        conventionReads.push(`${parsed.pathname}?repoKey=${parsed.searchParams.get('repoKey')}`);
        return new Response(
          JSON.stringify({ code: 'internal_error', status: 503, title: 'down' }),
          {
            status: 503,
            headers: { 'content-type': 'application/problem+json' },
          },
        );
      }
      return realFetch(url, init);
    });
    try {
      const res = await readPrompt(headers, item.identifier);
      expect(res.status).toBe(200);
      const prompt = String((await bodyOf(res))['prompt']);
      expect(conventionReads).toEqual(['/v1/convention?repoKey=moooon/acme']);
      expect(prompt).toContain('CODING CONVENTIONS');
      expect(prompt).toContain(
        '  moooon/acme\n    No coding convention is recorded for this repository. Review it against the card only.',
      );
      expect(prompt).not.toContain("Motir's coding convention, version");
      // Nothing is held: the review stays awaiting, with no reason written.
      const [gate] = await awaitingOf(item.id, REVIEW);
      expect(gate).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it('refuses a BUILD run’s token, a review run naming another card, a PAT, and a session', async () => {
    const s = await makeScenario('prompt-refusals');
    const { item } = await reviewedCard(s, 72);
    const { item: other } = await reviewedCard(s, 73);
    const build = await runFor(s, item, 'run');
    const otherReview = await runFor(s, other, 'review');
    const pat = await withTokenFor(s.user as never, s.workspace as never, {
      projectId: s.project.id,
      scopes: ['read', 'work_items:write'],
    });

    const asBuild = await readPrompt(build.headers, item.identifier);
    expect(asBuild.status).toBe(403);
    expect((await bodyOf(asBuild))['code']).toBe('REVIEW_RUN_TOKEN_REQUIRED');

    const asOtherCard = await readPrompt(otherReview.headers, item.identifier);
    expect(asOtherCard.status).toBe(403);
    expect((await bodyOf(asOtherCard))['code']).toBe('DISPATCH_RUN_TOKEN_OUT_OF_SCOPE');

    const asPat = await readPrompt(pat.headers, item.identifier);
    expect(asPat.status).toBe(403);
    expect((await bodyOf(asPat))['code']).toBe('REVIEW_RUN_TOKEN_REQUIRED');

    const asSession = await readPrompt(
      { cookie: 'better-auth.session_token=abc' },
      item.identifier,
    );
    expect(asSession.status).toBe(401);
  });
});

describe('POST …/agent-review — the ONE verdict', () => {
  it('PASS decides the gate `approved` by `review_agent` and raises the approve-and-merge gate', async () => {
    const s = await makeScenario('pass');
    const { item, review } = await reviewedCard(s, 74);
    const { runId, headers } = await runFor(s, item, 'review');

    const res = await submit(headers, item.identifier, {
      subjectVersion: version(74, 'sha-a'),
      verdict: 'pass',
      summaryMd: 'Meets both criteria.',
    });
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toMatchObject({
      key: item.identifier,
      gateId: review.id,
      verdict: 'pass',
      state: 'approved',
      subjectVersion: version(74, 'sha-a'),
    });

    const decided = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: review.id } });
    expect(decided.state).toBe('approved');
    expect(decided.decidedUnderAuthority).toBe('review_agent');
    expect(decided.decidedById).toBe(s.user.id);
    expect(decided.decisionSource).toBe('api');
    // No findings on a pass: the summary is what the row says.
    expect(decided.noteMd).toBe('Meets both criteria.');

    const merge = await awaitingOf(item.id, MERGE);
    expect(merge).toHaveLength(1);
    expect(merge[0]!.subjectVersion).toBe(version(74, 'sha-a'));

    const events = await verdictEvents(runId);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({
      verdict: 'pass',
      subjectVersion: version(74, 'sha-a'),
      outcome: 'decided',
      gateId: review.id,
      summaryMd: 'Meets both criteria.',
    });
    // On the card's leg.
    expect(events[0]!.dispatchRunCardId).not.toBeNull();
  });

  it('CHANGES_REQUESTED records the findings VERBATIM, moves nothing, and the card is To fix', async () => {
    const s = await makeScenario('refuse');
    const { item, review } = await reviewedCard(s, 75);
    const { headers } = await runFor(s, item, 'review');
    const statusBefore = (await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } }))
      .status;
    const findings =
      '- `app/header.tsx:12` — breaks “A zero count renders `0`”: `count || ""` blanks a zero.\n' +
      '  Change it to `count ?? 0`.';

    const res = await submit(headers, item.identifier, {
      subjectVersion: version(75, 'sha-a'),
      verdict: 'changes_requested',
      summaryMd: 'A zero count renders blank.',
      findingsMd: findings,
    });
    expect(res.status).toBe(200);
    expect((await bodyOf(res))['state']).toBe('changes_requested');

    const decided = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: review.id } });
    expect(decided.state).toBe('changes_requested');
    expect(decided.decidedUnderAuthority).toBe('review_agent');
    expect(decided.noteMd).toBe(findings);
    expect(await gatesOf(item.id, MERGE)).toHaveLength(0);
    const card = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(card.status).toBe(statusBefore);
    expect(card.fixReason).toBe('changes_requested');
  });

  it('422 names the field: findings missing on a refusal, an unknown verdict, a missing version, a long summary — nothing decided', async () => {
    const s = await makeScenario('invalid');
    const { item, review } = await reviewedCard(s, 76);
    const { runId, headers } = await runFor(s, item, 'review');

    const cases: Array<[unknown, string]> = [
      [{ subjectVersion: version(76, 'sha-a'), verdict: 'changes_requested' }, 'findingsMd'],
      [
        { subjectVersion: version(76, 'sha-a'), verdict: 'changes_requested', findingsMd: '  ' },
        'findingsMd',
      ],
      [{ subjectVersion: version(76, 'sha-a'), verdict: 'maybe' }, 'verdict'],
      [{ verdict: 'pass' }, 'subjectVersion'],
      [
        { subjectVersion: version(76, 'sha-a'), verdict: 'pass', summaryMd: 'x'.repeat(501) },
        'summaryMd',
      ],
      [
        {
          subjectVersion: version(76, 'sha-a'),
          verdict: 'changes_requested',
          findingsMd: 'x'.repeat(65_537),
        },
        'findingsMd',
      ],
    ];
    for (const [body, field] of cases) {
      const res = await submit(headers, item.identifier, body);
      expect(res.status, field).toBe(422);
      const out = await bodyOf(res);
      expect(out['code']).toBe('INVALID_BODY');
      expect(String(out['error'])).toContain(field);
    }

    expect((await adminDb.approvalGate.findUniqueOrThrow({ where: { id: review.id } })).state).toBe(
      'awaiting',
    );
    expect(await verdictEvents(runId)).toHaveLength(0);
  });

  it('a SECOND verdict from the same run is refused 409, and the first stands', async () => {
    const s = await makeScenario('second');
    const { item, review } = await reviewedCard(s, 77);
    const { runId, headers } = await runFor(s, item, 'review');
    const pass = { subjectVersion: version(77, 'sha-a'), verdict: 'pass' };

    expect((await submit(headers, item.identifier, pass)).status).toBe(200);
    const again = await submit(headers, item.identifier, {
      ...pass,
      verdict: 'changes_requested',
      findingsMd: 'Second thoughts.',
    });
    expect(again.status).toBe(409);
    expect((await bodyOf(again))['code']).toBe('REVIEW_VERDICT_ALREADY_SUBMITTED');

    expect((await adminDb.approvalGate.findUniqueOrThrow({ where: { id: review.id } })).state).toBe(
      'approved',
    );
    expect(await verdictEvents(runId)).toHaveLength(1);
  });

  it('a STALE version is recorded on the run and answered 409 REVIEW_STALE — nothing decided', async () => {
    const s = await makeScenario('stale');
    const { item, review } = await reviewedCard(s, 78);
    const { runId, headers } = await runFor(s, item, 'review');

    const res = await submit(headers, item.identifier, {
      subjectVersion: version(78, 'sha-old'),
      verdict: 'pass',
      summaryMd: 'Looked fine.',
    });
    expect(res.status).toBe(409);
    expect((await bodyOf(res))['code']).toBe('REVIEW_STALE');

    expect((await adminDb.approvalGate.findUniqueOrThrow({ where: { id: review.id } })).state).toBe(
      'awaiting',
    );
    expect(await gatesOf(item.id, MERGE)).toHaveLength(0);
    const events = await verdictEvents(runId);
    expect(events.map((e) => e.data)).toEqual([
      {
        verdict: 'pass',
        subjectVersion: version(78, 'sha-old'),
        outcome: 'stale_version',
        gateId: review.id,
        summaryMd: 'Looked fine.',
      },
    ]);
  });

  it('a verdict for a SUPERSEDED review (the head moved mid-review) is recorded and decides nothing', async () => {
    const s = await makeScenario('superseded');
    const { item, review } = await reviewedCard(s, 79);
    const { runId, headers } = await runFor(s, item, 'review');
    await pushTo(item.identifier, 79, 'sha-b');
    expect((await adminDb.approvalGate.findUniqueOrThrow({ where: { id: review.id } })).state).toBe(
      'superseded',
    );

    const res = await submit(headers, item.identifier, {
      subjectVersion: version(79, 'sha-a'),
      verdict: 'changes_requested',
      findingsMd: '- `a.ts:1` — wrong.',
    });
    expect(res.status).toBe(409);
    expect((await bodyOf(res))['code']).toBe('REVIEW_STALE');

    const gate = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: review.id } });
    expect(gate.state).toBe('superseded');
    expect(gate.decidedById).toBeNull();
    expect(gate.noteMd).toBeNull();
    expect(
      (await verdictEvents(runId)).map((e) => (e.data as { outcome: string }).outcome),
    ).toEqual(['superseded']);
  });

  it('refuses a BUILD run’s token, another card’s review run, a PAT, and a session — nothing decided', async () => {
    const s = await makeScenario('verdict-refusals');
    const { item, review } = await reviewedCard(s, 80);
    const { item: other } = await reviewedCard(s, 81);
    const build = await runFor(s, item, 'run');
    const otherReview = await runFor(s, other, 'review');
    const pat = await withTokenFor(s.user as never, s.workspace as never, {
      projectId: s.project.id,
      scopes: ['read', 'work_items:write'],
    });
    const pass = { subjectVersion: version(80, 'sha-a'), verdict: 'pass' };

    const asBuild = await submit(build.headers, item.identifier, pass);
    expect(asBuild.status).toBe(403);
    expect((await bodyOf(asBuild))['code']).toBe('REVIEW_RUN_TOKEN_REQUIRED');

    const asOtherCard = await submit(otherReview.headers, item.identifier, pass);
    expect(asOtherCard.status).toBe(403);
    expect((await bodyOf(asOtherCard))['code']).toBe('DISPATCH_RUN_TOKEN_OUT_OF_SCOPE');

    const asPat = await submit(pat.headers, item.identifier, pass);
    expect(asPat.status).toBe(403);
    expect((await bodyOf(asPat))['code']).toBe('REVIEW_RUN_TOKEN_REQUIRED');

    const asSession = await submit(
      { cookie: 'better-auth.session_token=abc' },
      item.identifier,
      pass,
    );
    expect(asSession.status).toBe(401);

    expect((await adminDb.approvalGate.findUniqueOrThrow({ where: { id: review.id } })).state).toBe(
      'awaiting',
    );
    expect(await verdictEvents(build.runId)).toHaveLength(0);
    expect(await verdictEvents(otherReview.runId)).toHaveLength(0);
  });
});

describe('POST …/agent-review — the BUGS a verdict logs (MOTIR-10513, `hosted-agent-run.md` §8.7)', () => {
  /** The bugs of the project that relate to `workItemId`, as stored. */
  const bugsRelatedTo = async (workItemId: string) =>
    (
      await adminDb.workItemLink.findMany({
        where: { kind: 'relates_to', OR: [{ fromId: workItemId }, { toId: workItemId }] },
        include: { fromItem: true, toItem: true },
      })
    )
      .map((l) => (l.fromId === workItemId ? l.toItem : l.fromItem))
      .filter((w) => w.kind === 'bug');

  it('files each bug as Motir in the bug destination, linked to the card, and names its key on the gate, the event and the record', async () => {
    const s = await makeScenario('bugs-filed');
    const { userId: motirId } = await seedSystemPrincipal({
      workspaceId: s.workspace.id,
      projectId: s.project.id,
    });
    const { item, review } = await reviewedCard(s, 81);
    const { runId, headers } = await runFor(s, item, 'review');
    const findings = '- `app/header.tsx:12` — a zero blanks. Change it to `count ?? 0`.';

    const res = await submit(headers, item.identifier, {
      subjectVersion: version(81, 'sha-a'),
      verdict: 'changes_requested',
      summaryMd: 'A zero renders blank. Logged 1 bug: The footer clock drifts.',
      findingsMd: findings,
      bugs: [
        {
          title: '  The footer clock drifts  ',
          descriptionMd:
            '`app/footer.tsx:40` uses `setInterval(1000)`; it drifts. Use the wall clock.',
        },
      ],
    });
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    const logged = body['bugs'] as Array<{ key: string; title: string; outcome: string }>;
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ title: 'The footer clock drifts', outcome: 'filed' });

    const [bug] = await bugsRelatedTo(item.id);
    expect(bug, 'the bug relates to the reviewed card').toBeDefined();
    expect(bug!.identifier).toBe(logged[0]!.key);
    expect(bug!.reporterId).toBe(motirId);
    expect(bug!.parentId).toBeNull();
    const destination = await adminDb.project.findUniqueOrThrow({ where: { id: s.project.id } });
    expect(bug!.folderId).toBe(destination.bugDestinationFolderId);
    // The card's key is written as its link, as every key in a body is.
    expect(bug!.descriptionMd).toMatch(
      new RegExp(
        `^\\*\\*Found while:\\*\\* reviewing \\[${item.identifier}\\]\\(motir:${item.id}\\) at `,
      ),
    );
    expect(bug!.descriptionMd).toContain('uses `setInterval(1000)`');
    // The verdict rule is untouched: a refusal with ONE gate decided.
    const decided = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: review.id } });
    expect(decided.state).toBe('changes_requested');
    expect(decided.noteMd).toContain(findings);
    expect(decided.noteMd).toContain('### Bugs logged by this review');
    expect(decided.noteMd).toContain(`[${bug!.identifier}](`);
    const [event] = await verdictEvents(runId);
    expect((event!.data as Record<string, unknown>)['bugKeys']).toEqual([bug!.identifier]);
    const [record] = await adminDb.reviewVerdictRecord.findMany({ where: { workItemId: item.id } });
    expect(record!.findingsMd).toContain(`[${bug!.identifier}](`);
  });

  it('a title matching a not-done bug of the project, or an earlier entry, is answered already_filed and filed once', async () => {
    const s = await makeScenario('bugs-dupe');
    await seedSystemPrincipal({ workspaceId: s.workspace.id, projectId: s.project.id });
    const known = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'bug', title: 'The Footer Clock Drifts' },
      s.ctx,
    );
    const { item } = await reviewedCard(s, 82);
    const { headers } = await runFor(s, item, 'review');
    const before = await adminDb.workItem.count({ where: { kind: 'bug' } });

    const res = await submit(headers, item.identifier, {
      subjectVersion: version(82, 'sha-a'),
      verdict: 'pass',
      summaryMd: 'Meets both criteria.',
      bugs: [
        { title: 'the footer clock drifts', descriptionMd: 'Already known.' },
        { title: 'The sidebar flickers', descriptionMd: 'New.' },
        { title: 'THE SIDEBAR FLICKERS', descriptionMd: 'The same, twice.' },
      ],
    });
    expect(res.status).toBe(200);
    const logged = (await bodyOf(res))['bugs'] as Array<{ key: string; outcome: string }>;
    expect(logged.map((b) => b.outcome)).toEqual(['already_filed', 'filed', 'already_filed']);
    expect(logged[0]!.key).toBe(known.identifier);
    expect(logged[2]!.key).toBe(logged[1]!.key);
    expect(await adminDb.workItem.count({ where: { kind: 'bug' } })).toBe(before + 1);
    // A pass's note is its summary, with the bugs named after it.
    const [gate] = await gatesOf(item.id, REVIEW);
    expect(gate!.noteMd).toMatch(/^Meets both criteria\.\n\n### Bugs logged by this review/);
    expect(gate!.noteMd).toContain('(already filed; not logged twice)');
  });

  it('a LATE verdict still files its bugs and the REVIEW_STALE message names them', async () => {
    const s = await makeScenario('bugs-late');
    await seedSystemPrincipal({ workspaceId: s.workspace.id, projectId: s.project.id });
    const { item, review } = await reviewedCard(s, 83);
    const { headers } = await runFor(s, item, 'review');

    const res = await submit(headers, item.identifier, {
      subjectVersion: version(83, 'sha-old'),
      verdict: 'pass',
      bugs: [{ title: 'The export button is dead', descriptionMd: 'Root cause here.' }],
    });
    expect(res.status).toBe(409);
    const body = await bodyOf(res);
    expect(body['code']).toBe('REVIEW_STALE');
    const [bug] = await bugsRelatedTo(item.id);
    expect(bug).toBeDefined();
    expect(String(body['error'])).toContain(`The bugs it logged stand: ${bug!.identifier}.`);
    expect((await adminDb.approvalGate.findUniqueOrThrow({ where: { id: review.id } })).state).toBe(
      'awaiting',
    );
  });

  it('422 for a bug with no title, an unknown key, or more than five — nothing filed, nothing decided', async () => {
    const s = await makeScenario('bugs-invalid');
    const { item, review } = await reviewedCard(s, 84);
    const { headers } = await runFor(s, item, 'review');
    const base = { subjectVersion: version(84, 'sha-a'), verdict: 'pass' as const };
    const one = { title: 'A bug', descriptionMd: 'Why.' };
    for (const bugs of [
      [{ title: '  ', descriptionMd: 'Why.' }],
      [{ ...one, kind: 'bug' }],
      Array.from({ length: 6 }, (_, i) => ({ ...one, title: `Bug ${i}` })),
    ]) {
      const res = await submit(headers, item.identifier, { ...base, bugs });
      expect(res.status).toBe(422);
    }
    expect(await adminDb.workItem.count({ where: { kind: 'bug' } })).toBe(0);
    expect((await adminDb.approvalGate.findUniqueOrThrow({ where: { id: review.id } })).state).toBe(
      'awaiting',
    );
    // The system account was never needed: nothing reached the filing.
    expect(await adminDb.user.count({ where: { email: MOTIR_SYSTEM_USER_EMAIL } })).toBe(0);
  });

  it('the prompt lists the not-done bugs already linked to the card, and says how to log one', async () => {
    const s = await makeScenario('bugs-prompt');
    const { item } = await reviewedCard(s, 85);
    const open = await workItemsService.createWorkItem(
      {
        projectId: s.project.id,
        kind: 'bug',
        title: 'The header overflows',
        links: [{ targetId: item.id, relationship: 'relates_to' }],
      },
      s.ctx,
    );
    const closed = await workItemsService.createWorkItem(
      {
        projectId: s.project.id,
        kind: 'bug',
        title: 'An old fixed bug',
        links: [{ targetId: item.id, relationship: 'relates_to' }],
      },
      s.ctx,
    );
    await workItemsService.updateStatus(closed.id, 'cancelled', s.ctx);
    const { headers } = await runFor(s, item, 'review');

    const res = await readPrompt(headers, item.identifier);
    expect(res.status).toBe(200);
    const prompt = String((await bodyOf(res))['prompt']);
    expect(prompt).toContain('A DEFECT THE VERDICT CANNOT CARRY — log it as a bug');
    expect(prompt).toContain(`    - ${open.identifier} — The header overflows (`);
    expect(prompt).not.toContain('An old fixed bug');
  });
});

describe('the grant (`hosted-agent-run.md` §3’s pointer)', () => {
  it('HOSTED_RUN_TOKEN_GRANT already holds what both review routes assert — nothing added', () => {
    const reviewOps = ['getWorkItemReviewPrompt', 'submitWorkItemAgentReview'];
    for (const operationId of reviewOps) {
      const op = WORK_LOOP_OPERATIONS.find((o) => o.operationId === operationId);
      expect(op, operationId).toBeDefined();
      expect(HOSTED_RUN_TOKEN_GRANT).toContain(op!.permission);
      expect(RUN_TOKEN_ROUTES.some((r) => r.operationId === operationId)).toBe(true);
    }
    // Widened since only by the run's repository door (MOTIR-11055), which no review calls.
    expect([...HOSTED_RUN_TOKEN_GRANT]).toEqual([
      'project:browse',
      'work_item:edit',
      'repository:manage',
    ]);
  });
});
