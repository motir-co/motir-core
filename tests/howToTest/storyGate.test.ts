import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { NextRequest } from 'next/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { db } from '@/lib/db';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import {
  currentTestInstructionsSchema,
  dispatchRunCloseOutPromptSchema,
} from '@/lib/api/v1/workLoop/schema';
import { HOW_TO_TEST_TOOL_NAME, RENDERED_SURFACE_TRIGGER } from '@/lib/dispatch/promptTemplate';
import { dispatchPromptService } from '@/lib/services/dispatchPromptService';
import { howToTestService } from '@/lib/services/howToTestService';
import { createTestWorkItem } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import {
  API_BRANCH,
  API_GITLAB_PROJECT_ID,
  API_HEAD,
  GITHUB_INSTALLATION_ID,
  RUN_BODY,
  WEB_BRANCH,
  WEB_HEAD,
  WEB_PROVIDER_REPO_ID,
  buildStoryRun,
  finishRun,
  openScopedRun,
  storyPublishArgs,
  type StoryRunScenario,
} from './storyGateScenario';
import { mcpRouteFetch } from '../helpers/mcpRouteFetch';

// ═══════════════════════════════════════════════════════════════════════════
// THE STORY GATE — HOW TO TEST per RUN (Story MOTIR-4906 · Subtask MOTIR-5337)
// ═══════════════════════════════════════════════════════════════════════════
//
// Every card of this story shipped its own suite, and each one builds its own
// input: the MCP suite publishes against a hand-made story, the read's suite
// publishes through the service, the prompt suites assert text, the ingestion
// suites stop at a `repo_deployment` row. All of them can be green while the
// feature is broken BETWEEN them — a run id the publish does not attribute, a
// section the read binds to the wrong pull request, a trigger that drifts from
// the runbook. (A hook storing a row the read never matches USED to be on this
// list; since MOTIR-5691 it is the design — seam 7.)
//
// So each seam below drives one card's REAL output into the next card's REAL
// consumer, on real Postgres: the close-out ROUTE the CLI calls, the `/api/mcp`
// TRANSPORT the agent calls with a CLI-grant token, the READ the item page calls,
// the v1 read the CLI renders into its pull request bodies, and the webhook ROUTES
// the hosts deliver to. The render half (seam 9) is `storyGateRender.test.tsx`;
// the CLI half (seam 5) is `packages/cli/test/howToTestStoryGate.test.ts`, because
// that package cannot import `lib/`.

const MCP_ENDPOINT = 'http://localhost/api/mcp';
const V1 = 'http://localhost:3000/api/v1';

const flat = (text: string) => text.replace(/\s*\n\s*/g, ' ');

/** Call `publish_test_instructions` over the shipped transport, as the agent does. */
async function publishOverMcp(token: string, args: Record<string, unknown>) {
  const client = new Client({ name: 'how-to-test-story-gate', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP_ENDPOINT), { fetch: mcpRouteFetch(token) }),
  );
  try {
    return await client.callTool({ name: HOW_TO_TEST_TOOL_NAME, arguments: args });
  } finally {
    await client.close();
  }
}

async function getCloseOutPrompt(token: string, runId: string) {
  const { GET } = await import('@/app/api/v1/dispatch-runs/[id]/close-out-prompt/route');
  const res = await GET(
    new Request(`${V1}/dispatch-runs/${runId}/close-out-prompt`, {
      headers: { authorization: `Bearer ${token}` },
    }),
    { params: Promise.resolve({ id: runId }) },
  );
  expect(res.status).toBe(200);
  return dispatchRunCloseOutPromptSchema.parse(await res.json());
}

/** The v1 read the CLI renders into each session pull request body. */
async function getCliRecord(token: string, key: string) {
  const { GET } = await import('@/app/api/v1/work-items/[key]/how-to-test/route');
  const res = await GET(
    new Request(`${V1}/work-items/${key}/how-to-test`, {
      headers: { authorization: `Bearer ${token}` },
    }),
    { params: Promise.resolve({ key }) },
  );
  expect(res.status).toBe(200);
  return currentTestInstructionsSchema.parse(await res.json());
}

beforeEach(async () => {
  await truncateAuthTables();
  resetRateLimitStore();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── Seam 1 — a scoped story run, end to end (the server half) ─────────────────

describe('seam 1 — a scoped story run: close-out prompt → MCP publish → the read', () => {
  let s: StoryRunScenario;

  beforeEach(async () => {
    s = await buildStoryRun();
  });

  it('the close-out prompt the CLI fetches names the story and both LANDED cards, and no failed one', async () => {
    const body = await getCloseOutPrompt(s.cliToken, s.runId);
    expect(body.targetKey).toBe(s.story.identifier);
    expect(body.landedKeys).toEqual([s.web.identifier, s.api.identifier]);
    const text = flat(body.prompt);
    expect(text).toContain(
      `Call the ${HOW_TO_TEST_TOOL_NAME} tool ONCE, with key ${s.story.identifier}`,
    );
    expect(text).toContain(`- ${s.web.identifier} [code] Web half — on ${WEB_BRANCH}`);
    expect(text).toContain(`- ${s.api.identifier} [code] API half — on ${API_BRANCH}`);
    expect(body.prompt).not.toContain(s.failed.identifier);
  });

  it('the publish it asks for, over /api/mcp with a CLI-grant token, is attributed to the run and read back VERBATIM with two bound sections', async () => {
    const result = await publishOverMcp(s.cliToken, storyPublishArgs(s));
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      workItemKey: s.story.identifier,
      created: true,
      dispatchRunId: s.runId,
      repos: [
        { repoId: s.webRepo.id, commitSha: WEB_HEAD },
        { repoId: s.apiRepo.id, commitSha: API_HEAD },
      ],
    });

    const dto = await howToTestService.getForWorkItem(s.story.id, s.fx.ctx);
    expect(dto.state).toBe('record');
    // Byte for byte — sections and both fences as the agent wrote them.
    expect(dto.record!.bodyMd).toBe(RUN_BODY);
    expect(dto.record!.author).toMatchObject({ kind: 'run', runId: s.runId });
    expect(dto.record!.previewPath).toBe(`/items/${s.story.identifier}`);

    // A push to the story's web pull request moves its head past the section — and
    // the read does NOT flag it (MOTIR-6065): How to test is written for the work
    // item, not for a commit, so a new head changes nothing on the read. The
    // agent that pushed is the one told to re-publish when its commit changed
    // the steps.
    const MOVED = 'f'.repeat(40);
    await adminDb.githubCheckRun.create({
      data: {
        pullRequestId: s.webPr.id,
        commitSha: MOVED,
        checkName: 'Vitest',
        conclusion: 'success',
      },
    });
    const moved = await howToTestService.getForWorkItem(s.story.id, s.fx.ctx);
    expect(moved).toEqual(dto);
    // The agent was told not to write the fetch — and Motir no longer composes one:
    // the pull request's row links out to the host, which shows its own checkout.
    expect(RUN_BODY).not.toContain('git fetch');
    expect(JSON.stringify(moved)).not.toContain('git fetch');
  });

  it('a child of the run reads tested_via_ancestor, naming the story', async () => {
    await publishOverMcp(s.cliToken, storyPublishArgs(s));
    for (const child of [s.web, s.api]) {
      await expect(howToTestService.getForWorkItem(child.id, s.fx.ctx)).resolves.toMatchObject({
        state: 'tested_via_ancestor',
        runTarget: { key: s.story.identifier },
        record: null,
      });
    }
  });

  it('the CLI read of the same record carries the same body, the run id and both sections by name', async () => {
    await publishOverMcp(s.cliToken, storyPublishArgs(s));
    const cli = await getCliRecord(s.cliToken, s.story.identifier);
    expect(cli.key).toBe(s.story.identifier);
    expect(cli.record).toMatchObject({
      dispatchRunId: s.runId,
      bodyMd: RUN_BODY,
      repos: [
        { repo: 'acme/web', commitSha: WEB_HEAD },
        { repo: 'acme-gl/api', commitSha: API_HEAD },
      ],
    });
  });
});

// ── Seam 2 — a single-card run ─────────────────────────────────────────────────

describe('seam 2 — a single-card run: the per-item prompt → a publish on the card → the read', () => {
  it('the prompt renders step 4b with bodyMd and the PR-body section, and the publish it asks for reads back on the card', async () => {
    const s = await buildStoryRun();
    await finishRun(s.runId);
    const card = await createTestWorkItem(s.fx, { kind: 'task', type: 'code', title: 'Solo card' });
    const run = await adminDb.dispatchRun.create({
      data: {
        workspaceId: s.fx.workspaceId,
        projectId: s.fx.projectId,
        command: 'run',
        status: 'running',
        cards: {
          create: {
            workspaceId: s.fx.workspaceId,
            workItemId: card.id,
            workItemKey: card.identifier,
            position: 0,
          },
        },
      },
    });

    const { prompt } = await dispatchPromptService.getDispatchPrompt(
      s.fx.projectId,
      card.identifier,
      s.fx.ctx,
    );
    const text = flat(prompt);
    expect(text).toContain(
      `4b. publish this run's HOW TO TEST with the ${HOW_TO_TEST_TOOL_NAME} tool — ONCE, on ${card.identifier}`,
    );
    expect(text).toContain('"bodyMd" is RICH TEXT (Markdown) with sections');
    expect(text).toContain('Put EVERY command in its own fenced code block');
    expect(text).toContain('3. open the pull request. Its body carries a "## How to test" section');

    const body = '## Locally\n\n```sh\npnpm test tests/solo\n```';
    const result = await publishOverMcp(s.cliToken, {
      key: card.identifier,
      bodyMd: body,
      repos: [{ repo: 'web', commitSha: WEB_HEAD }],
    });
    expect(result.isError).toBeFalsy();

    const dto = await howToTestService.getForWorkItem(card.id, s.fx.ctx);
    expect(dto).toMatchObject({
      state: 'record',
      record: { bodyMd: body, author: { kind: 'run', runId: run.id } },
      // The card's section has no pull request bound, so there is no head to move.
    });
    // The single-card record is the card's own — the story's page is untouched.
    expect((await howToTestService.getForWorkItem(s.story.id, s.fx.ctx)).state).toBe(
      'record_missing',
    );
  });
});

// ── Seam 3 — the scoped lineage prompt ───────────────────────────────────────

describe('seam 3 — a card on the scoped run’s lineage gets NO per-card publish step', () => {
  it('its prompt names the story as the run target and asks for nothing the close-out owns', async () => {
    const s = await buildStoryRun();
    await adminDb.workItem.update({ where: { id: s.web.id }, data: { sessionBranch: WEB_BRANCH } });

    const { prompt } = await dispatchPromptService.getDispatchPrompt(
      s.fx.projectId,
      s.web.identifier,
      s.fx.ctx,
    );
    const text = flat(prompt);
    // It IS the lineage grammar …
    expect(text).toContain(`gh pr list --head ${WEB_BRANCH}`);
    // … and it publishes nothing, writes no body section, and points at the story.
    expect(prompt).not.toContain(HOW_TO_TEST_TOOL_NAME);
    expect(prompt).not.toContain('"bodyMd"');
    expect(prompt).not.toContain('"## How to test" section');
    expect(text).toContain(`4b. do NOT publish How to test for ${s.web.identifier}.`);
    expect(text).toContain(`onto ${s.story.identifier}, by the run's close-out step`);

    // And the one place that DOES ask — the same run's close-out — asks on the story.
    const closeOut = await getCloseOutPrompt(s.cliToken, s.runId);
    expect(flat(closeOut.prompt)).toContain(`with key ${s.story.identifier}`);
  });
});

// ── Seam 4 — a later run supersedes ──────────────────────────────────────────

describe('seam 4 — a later run supersedes; history lists the earlier run', () => {
  it('a second scoped run’s publish becomes current on the story, and the first is history', async () => {
    const s = await buildStoryRun();
    await publishOverMcp(s.cliToken, storyPublishArgs(s));
    await finishRun(s.runId);

    const laterRunId = await openScopedRun(
      s.fx,
      s.story,
      [{ item: s.web, disposition: 'integrated', branch: WEB_BRANCH }],
      new Date('2026-09-14T09:30:00Z'),
    );
    const laterBody = `${RUN_BODY}\n\n## Re-run\n\n\`\`\`sh\npnpm test tests/rerun\n\`\`\``;
    const second = await publishOverMcp(s.cliToken, storyPublishArgs(s, laterBody));
    expect(second.structuredContent).toMatchObject({ created: true, dispatchRunId: laterRunId });

    const dto = await howToTestService.getForWorkItem(s.story.id, s.fx.ctx);
    expect(dto.record).toMatchObject({
      bodyMd: laterBody,
      author: { kind: 'run', runId: laterRunId, label: 'motir run · 2026-09-14 09:30 UTC' },
    });
    expect(dto.history).toHaveLength(1);
    expect(dto.history[0]!.author).toEqual({
      kind: 'run',
      runId: s.runId,
      label: 'motir run · 2026-09-13 12:00 UTC',
    });

    // The CLI's resume check keys on the run id — the later run sees its own record.
    const cli = await getCliRecord(s.cliToken, s.story.identifier);
    expect(cli.record).toMatchObject({ dispatchRunId: laterRunId, bodyMd: laterBody });
    expect(
      await adminDb.testInstructions.count({ where: { workItemId: s.story.id, isCurrent: true } }),
    ).toBe(1);
  });
});

// ── Seam 6 — no provisioning ─────────────────────────────────────────────────

/**
 * The shapes that CREATE a deployment on a host — or ask a hosting CLI to deploy.
 * The ingestion path stores what a host ANNOUNCED; Motir must never make one.
 */
const PROVISIONING_SHAPES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  // Octokit / GraphQL: `repos.createDeployment(…)`, `createDeploymentStatus(…)`,
  // `mutation { createDeployment(…) }`.
  { name: 'createDeployment call', pattern: /\bcreateDeployment(?:Status)?\s*[(<]/ },
  // Octokit route strings: `'POST /repos/{owner}/{repo}/deployments'`.
  { name: 'POST …/deployments route', pattern: /\bPOST\s+\/[^'"`\n]*\/deployments\b/ },
  // A REST path to a deployments collection, GitHub's or GitLab's, in any literal.
  {
    name: 'deployments REST path',
    pattern: /['"`][^'"`\n]*\/(?:repos|projects)\/[^'"`\n]*\/deployments(?:\/[^'"`\n]*)?['"`]/,
  },
  // A hosting CLI told to deploy.
  {
    name: 'hosting CLI deploy',
    pattern: /\b(?:vercel|netlify|flyctl|fly)['"`]?\s*,?\s*\[?\s*['"`]?deploy\b/,
  },
];

/** The preview lifecycle's GitHub deployments client and its one caller (MOTIR-5776). */
const PREVIEW_DEPLOYMENT_WRITERS = [
  'lib/github/previewDeployments.ts',
  'lib/services/previewLifecycleService.ts',
] as const;

/** Drop comments so a sentence ABOUT deployments is not a call. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line.replace(/(^|[^:\\])\/\/.*$/, '$1')))
    .join('\n');
}

export function findProvisioningCalls(
  files: readonly string[],
  read: (file: string) => string,
): string[] {
  const hits: string[] = [];
  for (const file of files) {
    const lines = stripComments(read(file)).split('\n');
    lines.forEach((line, i) => {
      for (const shape of PROVISIONING_SHAPES) {
        if (shape.pattern.test(line)) hits.push(`${file}:${i + 1} ${shape.name}`);
      }
    });
  }
  return hits;
}

const ROOT = resolve(__dirname, '..', '..');

/**
 * The ONE place Motir creates a deployment: a PRODUCTION release of a Motir
 * repository (Story MOTIR-9797 · MOTIR-10033), which Motir itself deploys and so
 * announces on GitHub. Its statuses still reach `repo_deployment` only through
 * the webhook, so the ingestion path above stays a pure listener. Nothing here
 * provisions a customer's preview — a new file is a new exception to justify.
 */
const PRODUCTION_RELEASE_POSTERS: ReadonlySet<string> = new Set([
  'lib/github/repoDeployments.ts',
  'lib/services/releaseDeploymentStatusService.ts',
]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(?:ts|tsx|js|mjs|cjs)$/.test(entry) && !/\.d\.ts$/.test(entry)) {
      out.push(relative(ROOT, full).split(sep).join('/'));
    }
  }
  return out;
}

describe('seam 6 — no provisioning: nothing under lib/ or packages/cli/ creates a deployment but a production release', () => {
  it('the guard FIRES on each provisioning shape (the negative fixture)', () => {
    const fixture: Record<string, string> = {
      'lib/fake/octokit.ts':
        "await octokit.rest.repos.createDeployment({ owner, repo, ref: sha, environment: 'preview' });",
      'lib/fake/route.ts': "await octokit.request('POST /repos/{owner}/{repo}/deployments', body);",
      'lib/fake/gitlab.ts': 'await fetch(`${host}/api/v4/projects/${id}/deployments`, { method });',
      'packages/cli/src/fake.ts': "run('vercel', ['deploy', '--prebuilt'], cwd);",
      'lib/fake/status.ts': 'await octokit.rest.repos.createDeploymentStatus({ deployment_id });',
    };
    const hits = findProvisioningCalls(Object.keys(fixture), (f) => fixture[f]!);
    for (const file of Object.keys(fixture)) {
      expect(
        hits.some((h) => h.startsWith(`${file}:`)),
        `${file} not caught`,
      ).toBe(true);
    }
  });

  it('and stays quiet on what ingestion legitimately says — comments, the event name, the parser', () => {
    const fixture: Record<string, string> = {
      'lib/fake/ok.ts': [
        '// MOTIR CREATES NOTHING — no POST /repos/{owner}/{repo}/deployments here.',
        "/* repos.createDeployment( is what we never call */ const event = 'deployment_status';",
        'provider.parseDeploymentStatusEvent?.(body);',
        "const url = 'https://acme.vercel.app/items'; // ingestion reads it",
      ].join('\n'),
    };
    expect(findProvisioningCalls(Object.keys(fixture), (f) => fixture[f]!)).toEqual([]);
  });

  it('the real tree has none', () => {
    const files = [
      ...sourceFiles(join(ROOT, 'lib')),
      ...sourceFiles(join(ROOT, 'packages', 'cli', 'src')),
    ];
    // Not vacuous: the ingestion writer and the CLI close-out are in the scan.
    expect(files).toContain('lib/services/repoDeploymentService.ts');
    expect(files).toContain('packages/cli/src/closeOutHowToTest.ts');
    const hits = findProvisioningCalls(files, (f) => readFileSync(join(ROOT, f), 'utf8'));
    // Story MOTIR-5766 (ADR MOTIR-5769 §8): a pull request's PREVIEW is Motir's
    // own release too, so Motir announces it as GitHub's deployment — confined to
    // its two files. Everything else, the How-to-test ingestion and the CLI
    // close-out included, still makes none.
    const sanctioned = (h: string) =>
      PRODUCTION_RELEASE_POSTERS.has(h.slice(0, h.indexOf(':'))) ||
      PREVIEW_DEPLOYMENT_WRITERS.some((file) => h.startsWith(`${file}:`));
    expect(hits.filter((h) => !sanctioned(h))).toEqual([]);
    // Not vacuous either: the exception is real, and the ingestion writer is not in it.
    expect(hits.some((h) => h.startsWith('lib/github/repoDeployments.ts:'))).toBe(true);
    expect(PRODUCTION_RELEASE_POSTERS.has('lib/services/repoDeploymentService.ts')).toBe(false);
    // TIGHT: a preview allowance nothing matches any more is removed, not kept.
    for (const file of PREVIEW_DEPLOYMENT_WRITERS) {
      expect(
        hits.some((h) => h.startsWith(`${file}:`)),
        `stale allowance ${file}`,
      ).toBe(true);
    }
  });
});

// ── Seam 7 — ingestion to the read ───────────────────────────────────────────

const GITHUB_SECRET = 'story-gate-github-secret';
const GITLAB_SECRET = 'story-gate-gitlab-secret';

function githubDeploymentStatus(sha: string, ref: string) {
  const raw = JSON.stringify({
    action: 'created',
    deployment_status: {
      id: 91,
      state: 'success',
      environment: 'Preview',
      environment_url: 'https://web-git-run.vercel.app',
      created_at: '2026-09-13T12:10:00Z',
      updated_at: '2026-09-13T12:10:00Z',
    },
    deployment: { id: 9, sha, ref, environment: 'Preview' },
    repository: { id: Number(WEB_PROVIDER_REPO_ID) },
    installation: { id: GITHUB_INSTALLATION_ID },
  });
  return new NextRequest('http://localhost/api/github/webhook', {
    method: 'POST',
    body: raw,
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'deployment_status',
      'x-hub-signature-256': `sha256=${createHmac('sha256', GITHUB_SECRET).update(raw).digest('hex')}`,
    },
  });
}

function gitlabDeployment(sha: string, ref: string) {
  return new NextRequest('http://localhost/api/gitlab/webhook', {
    method: 'POST',
    body: JSON.stringify({
      object_kind: 'deployment',
      status: 'success',
      status_changed_at: '2026-09-13 14:10:00 +0200',
      deployment_id: 27,
      deployable_id: 796,
      environment: 'review/run',
      environment_slug: 'review-run',
      environment_external_url: 'https://run.review.acme-gl.dev/',
      project: { id: Number(API_GITLAB_PROJECT_ID), name: 'api' },
      ref,
      sha,
    }),
    headers: {
      'content-type': 'application/json',
      'x-gitlab-event': 'Deployment Hook',
      'x-gitlab-token': GITLAB_SECRET,
    },
  });
}

// ⚠️ SEAM 7 WAS INVERTED BY MOTIR-5691. It used to prove a delivered deployment
// SURFACED in the read as a section's `preview.available`; design/github § 25
// retired the per-repository preview (a preview is per SYSTEM, not per head), so it
// now proves the opposite half of the same seam: both hosts' hooks are still
// RECORDED — ingestion is unchanged — and the How to test read carries none of it.
describe('seam 7 — a delivered deployment is recorded, and How to test does not surface it', () => {
  it('a GitHub deployment_status and a GitLab deployment hook are each recorded; the read is unchanged by them', async () => {
    const s = await buildStoryRun();
    await publishOverMcp(s.cliToken, storyPublishArgs(s));

    const before = await howToTestService.getForWorkItem(s.story.id, s.fx.ctx);

    vi.stubEnv('GITHUB_WEBHOOK_SECRET', GITHUB_SECRET);
    vi.stubEnv('GITLAB_WEBHOOK_SECRET', GITLAB_SECRET);
    vi.stubEnv('GITLAB_APP_CLIENT_ID', 'client-id');
    vi.stubEnv('GITLAB_APP_CLIENT_SECRET', 'client-secret');
    vi.stubEnv('GITLAB_TOKEN_ENCRYPTION_KEY', 'a'.repeat(64));
    // Ingestion is read-only toward both hosts: any outbound call fails the seam.
    const outbound = vi.fn(async () => {
      throw new Error('deployment ingestion made an outbound call');
    });
    vi.stubGlobal('fetch', outbound);

    const { POST: githubPost } = await import('@/app/api/github/webhook/route');
    const { POST: gitlabPost } = await import('@/app/api/gitlab/webhook/route');
    const gh = await githubPost(githubDeploymentStatus(WEB_HEAD, WEB_BRANCH));
    expect(gh.status).toBe(200);
    expect((await gh.json()).result).toEqual({ event: 'deployment_status', outcome: 'recorded' });
    const gl = await gitlabPost(gitlabDeployment(API_HEAD, API_BRANCH));
    expect(gl.status).toBe(200);
    expect((await gl.json()).result).toEqual({ event: 'deployment_status', outcome: 'recorded' });
    expect(outbound).not.toHaveBeenCalled();
    vi.unstubAllGlobals();

    expect(await adminDb.repoDeployment.count({ where: { workspaceId: s.fx.workspaceId } })).toBe(
      2,
    );
    const after = await howToTestService.getForWorkItem(s.story.id, s.fx.ctx);
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toMatch(/vercel\.app|acme-gl\.dev|"preview"/);
  });
});

// ── Seam 8 — trigger parity ─────────────────────────────────────────────────

/**
 * The runbook's sentence, as `motir-meta` `prompts/run.md` § *The how-to-test
 * rule* states it. Re-typed ON PURPOSE (a CI checkout has no motir-meta): the
 * constant is what the prompts say, this literal is what the runbook says.
 */
const RUNBOOK_TRIGGER =
  'creates or changes any rendered surface (a UI `type: code` subtask, or any subtask adding/editing a page, component, route-rendered view, modal, or interactive control)';

function runbookPath(): string | null {
  const candidates = [process.env['MOTIR_META_DIR'], resolve(ROOT, '..', 'motir-meta')].filter(
    (dir): dir is string => Boolean(dir),
  );
  for (const dir of candidates) {
    const file = join(dir, 'prompts', 'run.md');
    if (existsSync(file)) return file;
  }
  return null;
}

describe('seam 8 — RENDERED_SURFACE_TRIGGER is the runbook’s sentence, in every prompt that asks', () => {
  it('equals the runbook sentence byte for byte', () => {
    expect(RENDERED_SURFACE_TRIGGER).toBe(RUNBOOK_TRIGGER);
  });

  it.skipIf(runbookPath() === null)(
    'and the runbook, where a motir-meta checkout is present, still says it',
    () => {
      const runbook = readFileSync(runbookPath()!, 'utf8');
      const section = runbook.slice(runbook.indexOf('### The how-to-test rule'));
      expect(flat(section)).toContain(RENDERED_SURFACE_TRIGGER);
    },
  );

  it('the per-item prompt and the close-out prompt a real run serves both carry it', async () => {
    const s = await buildStoryRun();
    const closeOut = await getCloseOutPrompt(s.cliToken, s.runId);
    expect(flat(closeOut.prompt)).toContain(`If any card in this run ${RENDERED_SURFACE_TRIGGER}`);

    await finishRun(s.runId);
    const { prompt } = await dispatchPromptService.getDispatchPrompt(
      s.fx.projectId,
      s.web.identifier,
      s.fx.ctx,
    );
    expect(flat(prompt)).toContain(`If this change ${RENDERED_SURFACE_TRIGGER}`);
  });
});
