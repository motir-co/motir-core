import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { db } from '@/lib/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import type { NormalizedRepo } from '@/lib/git/types';

// THE STORY'S INTEGRATION GATE (Story MOTIR-7250 · Subtask MOTIR-7256).
//
// The restored uploader (`scripts/upload-acceptance-video.mjs`, MOTIR-7253) has a
// unit suite that mocks `fetch`, and the publish routes have suites that never run
// the script. Neither reaches the SEAM between them — and the seam is exactly
// where the two server changes the restore had to meet now live: the renamed
// refusal (`ACCEPTANCE_EVIDENCE_STORY_CLOSED`, MOTIR-5872) and the idempotency key
// (`commitSha` + `producedByKey`, `recordFromPathnames`). So this file drives the
// REAL script through the REAL route handlers, in-process, against a real
// Postgres, authenticated by the REAL `jose` OIDC verifier against a locally
// served JWKS (the `tests/github/oidc-auth.test.ts` pattern).
//
// What is NOT real, and why each is the narrowest substitute available:
//   · The blob adapter (`@/lib/blob/uploader`) — the one mocked external, as in
//     `tests/integration/acceptance-flow.test.ts`. The mint answers a presigned-
//     URL-shaped token, which is the shape the uploader's contract check demands.
//   · `fetch` — routed, not mocked: a call to the Motir base URL is turned into a
//     `Request` and handed to the route's own `POST`; a PUT to the store answers
//     like S3; GitHub's token-request endpoint answers the self-minted OIDC JWT;
//     anything else (the JWKS on 127.0.0.1) passes through to the real `fetch`.
//
// A real GitHub Actions token cannot exist in a test. That half — a real PR, a
// real hosted project — is the verification task MOTIR-7252.

vi.mock('@/lib/blob/uploader', () => ({
  putAttachment: vi.fn(async (p: string) => ({ url: `https://blob.test/${p}` })),
  putPrivateAttachment: vi.fn(async (p: string) => ({ pathname: p })),
  signedDownloadUrl: vi.fn(async (p: string) => `https://blob.test/signed/${p}`),
  deleteAttachmentBlob: vi.fn(async () => {}),
  // The S3 presigned-PUT shape (MOTIR-2389) — `assertPresignedTarget` refuses any
  // other, so a mock returning a bare string would fail the seam for a reason
  // that is not under test.
  mintPrivateUploadToken: vi.fn(
    async (p: string) => `${STORE}/${p}?X-Amz-Signature=sig&X-Amz-SignedHeaders=host`,
  ),
  headPrivateBlob: vi.fn(async (p: string) => ({
    size: 2048,
    contentType: p.endsWith('.zip') ? 'application/zip' : 'video/webm',
  })),
}));

const STORE = 'https://s3.test/motir-private';
const BASE_URL = 'http://motir.test';
const TOKEN_REQUEST_URL = 'https://oidc-request.test/token?api-version=2.0';
const ISSUER = 'https://token.actions.githubusercontent.com';
const AUDIENCE = 'motir-acceptance-video';
const KID = 'ci-publish-key';
const SPEC = 'tests/e2e/acceptance-ci-publish.spec.ts';
const SHA_X = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const SHA_Y = 'ffeeddccbbaa99887766554433221100ffeeddcc';

const REPO: NormalizedRepo = {
  providerRepoId: '7250',
  owner: 'moooon-B-V',
  name: 'motir-core',
  defaultBranch: 'main',
  archived: false,
};

const uploader = await import('../../scripts/upload-acceptance-video.mjs');
const mintRoute = await import('@/app/api/work-items/[id]/acceptance-evidence/upload-token/route');
const registerRoute = await import('@/app/api/work-items/[id]/acceptance-evidence/route');
const { acceptanceEvidenceService } = await import('@/lib/services/acceptanceEvidenceService');
const { githubInstallationService } = await import('@/lib/services/githubInstallationService');
const { workItemsService } = await import('@/lib/services/workItemsService');

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
let keys: KeyPair;
let jwks: Server;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  keys = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(keys.publicKey);
  Object.assign(jwk, { kid: KID, alg: 'RS256', use: 'sig' });
  const body = JSON.stringify({ keys: [jwk] });
  jwks = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  });
  await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', () => resolve()));
  const addr = jwks.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  process.env['GITHUB_OIDC_ISSUER'] = ISSUER;
  process.env['GITHUB_OIDC_JWKS_URL'] = `http://127.0.0.1:${port}/jwks`;
  process.env['GITHUB_OIDC_AUDIENCE'] = AUDIENCE;
});

afterAll(async () => {
  await new Promise<void>((resolve) => jwks.close(() => resolve()));
  delete process.env['GITHUB_OIDC_ISSUER'];
  delete process.env['GITHUB_OIDC_JWKS_URL'];
  delete process.env['GITHUB_OIDC_AUDIENCE'];
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Mint the token GitHub Actions would hand a job with `id-token: write`. */
function mintOidc(opts: { repository?: string; audience?: string } = {}): Promise<string> {
  return new SignJWT({ repository: opts.repository ?? `${REPO.owner}/${REPO.name}` })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(opts.audience ?? AUDIENCE)
    .setExpirationTime('5m')
    .sign(keys.privateKey);
}

/** What each store PUT received, and what it should answer. */
interface Wire {
  puts: string[];
  refuse: (url: string) => number | null;
}

/**
 * Route the uploader's `fetch` onto the real handlers. Everything the script
 * does over HTTP passes through here, so a wrong path, method, header or body
 * shape reaches the route exactly as it would in CI.
 */
function routeFetch(oidcToken: string | null, wire: Wire) {
  const handler = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    // Matched on the parsed ORIGIN, never a string prefix: `http://motir.test`
    // is also a prefix of `http://motir.test.evil.example`.
    const origin = new URL(url).origin;
    if (origin === new URL(TOKEN_REQUEST_URL).origin) {
      return oidcToken
        ? Response.json({ value: oidcToken })
        : new Response('forbidden', { status: 403 });
    }
    if (origin === new URL(STORE).origin) {
      wire.puts.push(url);
      const refused = wire.refuse(url);
      return new Response(refused ? 'AccessDenied' : '', {
        status: refused ?? 200,
        headers: { 'x-amz-request-id': `req-${wire.puts.length}` },
      });
    }
    if (origin === BASE_URL) {
      const m = /\/api\/work-items\/([^/]+)\/acceptance-evidence(\/upload-token)?$/.exec(
        new URL(url).pathname,
      );
      if (!m) throw new Error(`unrouted Motir URL ${url}`);
      const req = new Request(url, init);
      const params = { params: Promise.resolve({ id: decodeURIComponent(m[1]!) }) };
      return m[2] ? mintRoute.POST(req, params) : registerRoute.POST(req, params);
    }
    return realFetch(input, init);
  });
  vi.stubGlobal('fetch', handler);
  return handler;
}

/** One recording as the acceptance harness leaves it on disk. */
function writeRecording(root: string, declaredKey: string, chapters: unknown[]): string {
  const dir = path.join(root, 'acceptance-ci-publish-chromium');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'video.webm'), 'clip-bytes');
  fs.writeFileSync(path.join(dir, 'trace.zip'), 'trace-bytes');
  fs.writeFileSync(path.join(dir, 'chapters.json'), JSON.stringify(chapters));
  fs.writeFileSync(
    path.join(dir, 'acceptance-story.json'),
    JSON.stringify({ storyKey: declaredKey }),
  );
  fs.writeFileSync(path.join(dir, 'recording-meta.json'), JSON.stringify({ specFile: SPEC }));
  return dir;
}

const ENV_KEYS = [
  'ACCEPTANCE_OUTPUT_DIR',
  'ACCEPTANCE_CHANGED_SPECS',
  'ACCEPTANCE_PR_REF',
  'ACCEPTANCE_PR_TITLE',
  'ACCEPTANCE_STORY_KEY',
  'ACCEPTANCE_FALLBACK_STORY_KEY',
  'ACCEPTANCE_MAX_ARTIFACT_BYTES',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'MOTIR_BASE_URL',
  'MOTIR_PUBLISH_TOKEN',
  'GITHUB_SHA',
  'GITHUB_SERVER_URL',
  'GITHUB_REPOSITORY',
  'GITHUB_RUN_ID',
  'GITHUB_ACTIONS',
  'GITHUB_STEP_SUMMARY',
] as const;
const savedEnv: Record<string, string | undefined> = {};

let fx: WorkItemFixture;
let story: { id: string; identifier: string };
let subtask: { id: string; identifier: string };
let outDir: string;

beforeEach(async () => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "acceptance_evidence", "attachment" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  await githubInstallationService.persistInstallation({
    workspaceId: fx.workspaceId,
    installation: {
      installationId: 'inst-7250',
      accountLogin: REPO.owner,
      accountType: 'Organization',
    },
    repos: [REPO],
  });
  story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Receipts come back from CI' },
    fx.ctx,
  );
  await workItemsService.updateStatus(story.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(story.id, 'in_review', fx.ctx);
  subtask = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', title: 'Record it', parentId: story.id },
    fx.ctx,
  );
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-ci-publish-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** The lane's step env, as `.github/workflows/acceptance-tests.yml` sets it. */
function laneEnv(prRef: string) {
  process.env['ACCEPTANCE_OUTPUT_DIR'] = outDir;
  process.env['ACCEPTANCE_CHANGED_SPECS'] = SPEC;
  process.env['ACCEPTANCE_PR_REF'] = prRef;
  process.env['ACCEPTANCE_PR_TITLE'] = 'feat: receipts';
  process.env['MOTIR_BASE_URL'] = BASE_URL;
  process.env['ACTIONS_ID_TOKEN_REQUEST_URL'] = TOKEN_REQUEST_URL;
  process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'] = 'actions-runtime-token';
  process.env['GITHUB_SHA'] = SHA_X;
  process.env['GITHUB_SERVER_URL'] = 'https://github.com';
  process.env['GITHUB_REPOSITORY'] = `${REPO.owner}/${REPO.name}`;
  process.env['GITHUB_RUN_ID'] = '987654321';
}

const currentRows = () =>
  adminDb.acceptanceEvidence.findMany({
    where: { workItemId: story.id },
    orderBy: { createdAt: 'asc' },
  });

/** Drive the uploader's own library entry against the real routes. */
function publishDirect(opts: { oidcToken: string; commitSha?: string; producedByKey?: string }) {
  const dir = path.join(outDir, 'direct');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'video.webm'), 'clip-bytes');
  return uploader.uploadAcceptanceVideo({
    baseUrl: BASE_URL,
    oidcToken: opts.oidcToken,
    storyKey: subtask.identifier,
    artifacts: { video: path.join(dir, 'video.webm'), trace: null, chapters: null },
    provenance: {
      commitSha: opts.commitSha ?? SHA_X,
      ciRunUrl: null,
      producedByKey: opts.producedByKey ?? subtask.identifier,
    },
  });
}

describe('the restored uploader → the real publish routes, over OIDC (MOTIR-7256)', () => {
  it('a green PR run lands a PENDING receipt on the subtask’s parent STORY, with the PR’s card key', async () => {
    writeRecording(outDir, subtask.identifier, [{ label: 'Open the story', tSeconds: 2 }]);
    laneEnv(`subtask/${subtask.identifier}-record-it`);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    routeFetch(await mintOidc(), { puts: [], refuse: () => null });

    await uploader.main();

    expect(exit).not.toHaveBeenCalled();
    const rows = await currentRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.isCurrent).toBe(true);
    expect(row.status).toBe('pending');
    expect(row.commitSha).toBe(SHA_X);
    expect(row.ciRunUrl).toBe(
      `https://github.com/${REPO.owner}/${REPO.name}/actions/runs/987654321`,
    );
    // producedByKey is the PR's own card key — not the story, not a constant.
    expect(row.producedByKey).toBe(subtask.identifier);
    expect(row.chapters).toEqual([{ label: 'Open the story', tSeconds: 2 }]);
    // The run log names the auth path and the receipt id.
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('keyless GitHub OIDC');
    expect(out).toContain(`Published acceptance evidence for ${subtask.identifier}: ${row.id}`);
    // And the panel's own read path sees it.
    const panel = await acceptanceEvidenceService.getCurrentForStory(story.id, fx.ctx);
    expect(panel?.id).toBe(row.id);
  });

  it('a CI publish and an MCP publish of the SAME commit + card collapse to ONE receipt', async () => {
    routeFetch(await mintOidc(), { puts: [], refuse: () => null });
    const ci = await publishDirect({ oidcToken: await mintOidc() });

    // The agent's door: `publish_acceptance_result` calls `recordFromPathnames`
    // with this card's key as `producedByKey` and the commit it recorded at.
    const prefix = `acceptance/${fx.workspaceId}/${story.id}/`;
    const mcp = await acceptanceEvidenceService.recordFromPathnames(
      {
        workItemId: story.id,
        videoPathname: `${prefix}agent-acceptance.webm`,
        commitSha: SHA_X,
        producedByKey: subtask.identifier,
      },
      fx.ctx,
    );

    expect(mcp.id).toBe(ci.evidence.id);
    const rows = await currentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isCurrent).toBe(true);
  });

  it('a DIFFERENT commit supersedes — the first row reads superseded', async () => {
    routeFetch(await mintOidc(), { puts: [], refuse: () => null });
    const first = await publishDirect({ oidcToken: await mintOidc(), commitSha: SHA_X });
    const second = await publishDirect({ oidcToken: await mintOidc(), commitSha: SHA_Y });

    expect(second.evidence.id).not.toBe(first.evidence.id);
    const rows = await currentRows();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === first.evidence.id)!.isCurrent).toBe(false);
    expect(rows.find((r) => r.id === second.evidence.id)!.isCurrent).toBe(true);
  });

  it('a CLOSED story answers 409 STORY_CLOSED — the uploader SKIPS, writes nothing, exits 0', async () => {
    await workItemsService.updateStatus(story.id, 'done', fx.ctx);
    const token = await mintOidc();
    routeFetch(token, { puts: [], refuse: () => null });

    const result = await publishDirect({ oidcToken: token });
    expect(result).toEqual({ skipped: true, reason: expect.stringContaining('closed') });
    expect(await currentRows()).toHaveLength(0);

    // …and through `main`, the lane's exit path stays 0.
    writeRecording(outDir, subtask.identifier, []);
    laneEnv(`subtask/${subtask.identifier}-record-it`);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    await uploader.main();
    expect(exit).not.toHaveBeenCalled();
    expect(await currentRows()).toHaveLength(0);
  });

  it('an UNCONNECTED repository is refused loudly — 403 repo_not_connected, the uploader rejects', async () => {
    const token = await mintOidc({ repository: 'someone-else/forked-copy' });
    routeFetch(token, { puts: [], refuse: () => null });

    await expect(publishDirect({ oidcToken: token })).rejects.toThrow(
      /403[\s\S]*repo_not_connected/,
    );
    expect(await currentRows()).toHaveLength(0);

    // Through `main`, a refusal fails the lane rather than passing silently.
    writeRecording(outDir, subtask.identifier, []);
    laneEnv(`subtask/${subtask.identifier}-record-it`);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    await uploader.main();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('a token minted for another AUDIENCE is refused — 401, the uploader rejects', async () => {
    const token = await mintOidc({ audience: 'sigstore' });
    routeFetch(token, { puts: [], refuse: () => null });

    await expect(publishDirect({ oidcToken: token })).rejects.toThrow(/token mint failed: 401/);
    expect(await currentRows()).toHaveLength(0);
  });

  it('a TRACE the store refuses is dropped — the video still registers through the real route', async () => {
    writeRecording(outDir, subtask.identifier, []);
    laneEnv(`subtask/${subtask.identifier}-record-it`);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const wire: Wire = { puts: [], refuse: (url) => (/-trace\.zip\?/.test(url) ? 403 : null) };
    routeFetch(await mintOidc(), wire);

    await uploader.main();

    expect(wire.puts.some((u) => /-trace\.zip\?/.test(u))).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    const rows = await currentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.traceAttachmentId).toBeNull();
    expect(rows[0]!.attachmentId).not.toBeNull();
  });

  it('a run GitHub mints no OIDC token for (a fork PR) publishes nothing and exits 0', async () => {
    writeRecording(outDir, subtask.identifier, []);
    laneEnv(`subtask/${subtask.identifier}-record-it`);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const fetchMock = routeFetch(null, { puts: [], refuse: () => null });

    await uploader.main();

    expect(exit).not.toHaveBeenCalled();
    expect(await currentRows()).toHaveLength(0);
    expect(fetchMock.mock.calls.some(([u]) => new URL(String(u)).origin === BASE_URL)).toBe(false);
  });
});

// ── THE ARCHITECTURE GUARD ──────────────────────────────────────────────────
//
// Asserted from the files, so an edit that wires a PAT back into a workflow, or
// hands the GitHub OIDC identity to a workflow that has no business with it, goes
// red here. ⚠️ `id-token: write` is NOT unique to the acceptance lane and the card
// that commissioned this guard assumed it was: the three npm release lanes hold it
// for npm Trusted Publishing (provenance), and the AWS runner AMI lane holds it to
// assume its build role (MOTIR-9272). So the guard PINS the set — the acceptance
// lane plus those four — and a sixth workflow fails it.
describe('the acceptance identity stays where it belongs (MOTIR-7256)', () => {
  const ROOT = process.cwd();
  const codeOf = (text: string) =>
    text
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
  const walk = (dir: string): string[] =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((e) =>
        e.isDirectory()
          ? walk(path.join(dir, e.name))
          : /\.ya?ml$/.test(e.name)
            ? [path.join(dir, e.name)]
            : [],
      );
  const githubYaml = () =>
    walk(path.join(ROOT, '.github')).map(
      (f) => [path.relative(ROOT, f), fs.readFileSync(f, 'utf8')] as const,
    );

  it('no workflow or action under .github/ names MOTIR_UPLOAD_TOKEN', () => {
    const offenders = githubYaml()
      .filter(([, text]) => /MOTIR_UPLOAD_TOKEN/.test(codeOf(text)))
      .map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  it('`id-token: write` is granted by exactly the pinned workflows', () => {
    const granting = githubYaml()
      .filter(([f]) => f.startsWith('.github/workflows/'))
      .filter(([, text]) => /^\s*id-token:\s*write\s*$/m.test(codeOf(text)))
      .map(([f]) => f)
      .sort();
    expect(granting).toEqual([
      '.github/workflows/acceptance-tests.yml', // the receipt publish (MOTIR-7253)
      '.github/workflows/aws-deploy.yml', // the ECR push and deploy roles (MOTIR-9928)
      '.github/workflows/release-brand.yml', // npm Trusted Publishing
      '.github/workflows/release-ci-runner-ami.yml', // the AMI build's AWS role (MOTIR-9272)
      '.github/workflows/release-cli.yml', // npm Trusted Publishing
      '.github/workflows/release-design-system.yml', // npm Trusted Publishing
    ]);
  });

  it('inside the acceptance lane only the shard job holds it, and nothing passes a token', () => {
    const lane = codeOf(
      fs.readFileSync(path.join(ROOT, '.github/workflows/acceptance-tests.yml'), 'utf8'),
    );
    const jobs = lane.split(/^jobs:\s*$/m)[1] ?? '';
    const granted = [...jobs.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)]
      .map((m, i, all) => {
        const end = all[i + 1]?.index ?? jobs.length;
        return [m[1]!, jobs.slice(m.index, end)] as const;
      })
      .filter(([, body]) => /^\s*id-token:\s*write/m.test(body))
      .map(([id]) => id);
    expect(granted).toEqual(['acceptance']);
    expect(lane).not.toMatch(/upload-acceptance-video[\s\S]*?^\s{10}token:/m);
  });
});
