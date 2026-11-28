import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The SCIP upload script (Story MOTIR-12262 · MOTIR-12341), driven as the REAL script
// with bash against a stub code-graph host served from this test. The script is run
// by an awaited async `spawn`, never `execFileSync`: a synchronous child would block
// this process's event loop, and with it the stub host the script is talking to.

const SCRIPT = join(process.cwd(), 'scripts/scip-upload/scip-upload.sh');
const TOKEN = 'cgk_upload_secret_token_9f8e7d6c5b4a';
const COMMIT = 'c'.repeat(40);
const REPO = '7f3c2a10-0000-4000-8000-000000000001';
const UPLOAD = '9b1d0c22-0000-4000-8000-000000000002';
const BYTES = Buffer.from([0x0a, 0x05, 0x01, 0x02, 0x03, 0xff, 0x00, 0x7f]);

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  authorization: string | undefined;
  contentType: string | undefined;
  body: Buffer;
}
type Answer = { status: number; body?: unknown } | 'drop';

let dir: string;
let server: Server;
let host: string;
let seen: Seen[];
/** Answers for the upload POST, in order; the last one repeats. */
let uploads: Answer[];
/** Answers for the state GET, in order; the last one repeats. */
let states: Answer[];

function next(queue: Answer[]): Answer {
  return queue.length > 1 ? queue.shift()! : queue[0]!;
}

function serve(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://stub');
    seen.push({
      method: req.method ?? '',
      path: url.pathname,
      query: url.searchParams,
      authorization: req.headers['authorization'],
      contentType: req.headers['content-type'],
      body: Buffer.concat(chunks),
    });
    const answer = req.method === 'POST' ? next(uploads) : next(states);
    if (answer === 'drop') {
      req.socket.destroy();
      return;
    }
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    res.end(answer.body === undefined ? '' : JSON.stringify(answer.body));
  });
}

const state = (s: string, reason: string | null = null): Answer => ({
  status: 200,
  body: { uploadId: UPLOAD, repositoryId: REPO, commit: COMMIT, state: s, reason },
});
const accepted: Answer = { status: 202, body: { uploadId: UPLOAD, state: 'accepted' } };

interface Run {
  code: number;
  out: string;
}

async function run(env: Record<string, string | undefined> = {}): Promise<Run> {
  const merged: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    HOME: dir,
    MOTIR_SCIP_UPLOAD_TOKEN: TOKEN,
    MOTIR_CODEGRAPH_REPOSITORY_ID: REPO,
    MOTIR_CODEGRAPH_UPLOAD_URL: host,
    MOTIR_SCIP_COMMIT: COMMIT,
    MOTIR_SCIP_BRANCH: 'main',
    MOTIR_SCIP_DEFAULT_BRANCH: 'main',
    MOTIR_SCIP_EVENT: 'push',
    MOTIR_SCIP_INDEXER: 'scip-typescript',
    MOTIR_SCIP_ROOT: dir,
    MOTIR_SCIP_POLL_SECONDS: '0',
    MOTIR_SCIP_RETRY_SECONDS: '0',
    MOTIR_SCIP_RETRIES: '2',
  };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [SCRIPT], { env: merged, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, out }));
  });
}

/** The lines the script itself printed (its index command's output aside). */
const lines = (r: Run) => r.out.trim().split('\n');

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'scip-upload-'));
  writeFileSync(join(dir, 'index.scip'), BYTES);
  seen = [];
  uploads = [accepted];
  states = [state('ingested')];
  server = createServer(serve);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

describe('a default-branch run', () => {
  it('uploads the file once with the commit, indexer and root, polls to ingested and exits 0', async () => {
    states = [state('accepted'), state('ingesting'), state('ingested')];
    const r = await run();
    expect(r.code).toBe(0);
    expect(lines(r).at(-1)).toBe(`ingested: upload ${UPLOAD} is ingested for ${COMMIT}`);

    const posts = seen.filter((s) => s.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.path).toBe(`/v1/repositories/${REPO}/scip-uploads`);
    expect(posts[0]!.body.equals(BYTES)).toBe(true);
    expect(posts[0]!.contentType).toBe('application/octet-stream');
    expect(Object.fromEntries(posts[0]!.query)).toEqual({
      commit: COMMIT,
      indexer: 'scip-typescript',
      root: dir,
    });
    const gets = seen.filter((s) => s.method === 'GET');
    expect(gets.map((g) => g.path)).toEqual(
      Array(3).fill(`/v1/repositories/${REPO}/scip-uploads/${UPLOAD}`),
    );
    for (const s of seen) expect(s.authorization).toBe(`Bearer ${TOKEN}`);
    expect(r.out).not.toContain(TOKEN);
  });

  it('runs the index command in the root without the token, then uploads what it wrote', async () => {
    rmSync(join(dir, 'index.scip'));
    const r = await run({
      MOTIR_SCIP_INDEX_COMMAND:
        'printf "%s" "${MOTIR_SCIP_UPLOAD_TOKEN:-no-token}" > seen-token; printf "built" > out.scip',
      MOTIR_SCIP_FILE: 'out.scip',
      MOTIR_SCIP_ROOT: dir,
    });
    expect(r.code).toBe(0);
    expect(seen.find((s) => s.method === 'POST')!.body.toString()).toBe('built');
    expect(readFileSync(join(dir, 'seen-token'), 'utf8')).toBe('no-token');
  });

  it('an upload answered already ingested exits 0 with no poll', async () => {
    uploads = [{ status: 202, body: { uploadId: UPLOAD, state: 'ingested' } }];
    const r = await run();
    expect(r.code).toBe(0);
    expect(seen.filter((s) => s.method === 'GET')).toEqual([]);
  });

  it('superseded exits 0 and says so', async () => {
    states = [state('superseded')];
    const r = await run();
    expect(r.code).toBe(0);
    expect(lines(r).at(-1)).toMatch(new RegExp(`^superseded: upload ${UPLOAD} was replaced`));
  });

  it.each(['not_default_branch', 'commit_not_indexed', 'scip_indexer_mismatch'])(
    'an ingest refused with %s exits 1, printing the upload id and the reason',
    async (reason) => {
      states = [state('ingesting'), state('refused', reason)];
      const r = await run();
      expect(r.code).toBe(1);
      expect(lines(r).at(-1)).toBe(`refused: upload ${UPLOAD} was refused: ${reason}`);
    },
  );

  it('still ingesting at the deadline exits 3 with the upload id and its last state', async () => {
    states = [state('ingesting')];
    const r = await run({ MOTIR_SCIP_WAIT_SECONDS: '0' });
    expect(r.code).toBe(3);
    expect(lines(r).at(-1)).toBe(
      `timeout: upload ${UPLOAD} is still accepted after 0s — its ingest may still finish`,
    );
    const later = await run({ MOTIR_SCIP_WAIT_SECONDS: '1', MOTIR_SCIP_POLL_SECONDS: '1' });
    expect(later.code).toBe(3);
    expect(lines(later).at(-1)).toMatch(
      new RegExp(`^timeout: upload ${UPLOAD} is still ingesting`),
    );
  });
});

describe('a refused request', () => {
  it('a revoked token prints 401 and unauthenticated, and exits 1', async () => {
    uploads = [
      {
        status: 401,
        body: { error: { code: 'unauthenticated', message: 'the credential is not valid' } },
      },
    ];
    const r = await run();
    expect(r.code).toBe(1);
    expect(lines(r).at(-1)).toBe(
      'refused: the upload answered HTTP 401 unauthenticated: the credential is not valid',
    );
    expect(r.out).not.toContain(TOKEN);
  });

  it.each([
    [400, 'unknown_indexer'],
    [403, 'credential_not_scoped'],
    [413, 'too_large'],
  ])('an upload answered %i %s exits 1 with no retry', async (status, code) => {
    uploads = [{ status, body: { error: { code, message: 'no' } } }];
    const r = await run();
    expect(r.code).toBe(1);
    expect(lines(r).at(-1)).toBe(`refused: the upload answered HTTP ${status} ${code}: no`);
    expect(seen).toHaveLength(1);
  });

  it('a state read answered 404 exits 1', async () => {
    states = [{ status: 404, body: { error: { code: 'upload_not_found', message: 'gone' } } }];
    const r = await run();
    expect(r.code).toBe(1);
    expect(lines(r).at(-1)).toBe(
      'refused: the state read answered HTTP 404 upload_not_found: gone',
    );
  });

  it('a refusal with an unreadable body still names its status', async () => {
    uploads = [{ status: 500 }];
    const r = await run();
    expect(r.code).toBe(1);
    expect(lines(r).at(-1)).toBe('refused: the upload answered HTTP 500 unknown');
  });

  it('a 202 with no upload id exits 1', async () => {
    uploads = [{ status: 202, body: { state: 'accepted' } }];
    const r = await run();
    expect(r.code).toBe(1);
    expect(lines(r).at(-1)).toBe('refused: the upload answered 202 with no upload id');
  });
});

describe('an unreachable code graph', () => {
  it.each([[503], [429]])('retries %i with backoff, then recovers', async (status) => {
    uploads = [{ status }, accepted];
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.out).toContain(`retrying: the code graph answered ${status} — attempt 1 of 2`);
    expect(seen.filter((s) => s.method === 'POST')).toHaveLength(2);
  });

  it('a 503 that never clears exits 4 and says to re-run', async () => {
    uploads = [{ status: 503 }];
    const r = await run();
    expect(r.code).toBe(4);
    expect(seen.filter((s) => s.method === 'POST')).toHaveLength(3);
    expect(lines(r).at(-1)).toBe(
      `unreachable: the code graph at ${host} could not be reached (last answer: 503) — re-run the job`,
    );
  });

  it('a dropped connection on the state read is retried and, still failing, exits 4', async () => {
    states = ['drop'];
    const r = await run();
    expect(r.code).toBe(4);
    expect(lines(r).at(-1)).toMatch(/\(last answer: no connection\) — re-run the job$/);
  });

  it('no listener at all exits 4, never 0', async () => {
    const r = await run({ MOTIR_CODEGRAPH_UPLOAD_URL: 'http://127.0.0.1:1' });
    expect(r.code).toBe(4);
    expect(r.out).not.toContain(TOKEN);
  });
});

describe('skipped runs — no index, no request, exit 0', () => {
  it.each(['pull_request', 'pull_request_target'])('a %s event', async (event) => {
    const r = await run({
      MOTIR_SCIP_EVENT: event,
      MOTIR_SCIP_BRANCH: 'feature/x',
      MOTIR_SCIP_UPLOAD_TOKEN: '',
      MOTIR_SCIP_INDEX_COMMAND: 'touch indexed',
    });
    expect(r.code).toBe(0);
    expect(lines(r)).toEqual([
      `skipped: a ${event} run on branch 'feature/x' — only the default branch is uploaded`,
    ]);
    expect(seen).toEqual([]);
  });

  it('a branch that is not the default branch', async () => {
    const r = await run({ MOTIR_SCIP_BRANCH: 'release', MOTIR_SCIP_INDEX_COMMAND: 'exit 9' });
    expect(r.code).toBe(0);
    expect(lines(r)).toEqual([
      "skipped: branch 'release' is not the default branch 'main' — only the default branch is uploaded",
    ]);
    expect(seen).toEqual([]);
  });
});

describe('configuration errors — exit 2 before any request', () => {
  it.each([
    [{ MOTIR_SCIP_BRANCH: undefined }, 'MOTIR_SCIP_BRANCH is not set'],
    [{ MOTIR_SCIP_DEFAULT_BRANCH: '' }, 'MOTIR_SCIP_DEFAULT_BRANCH is not set'],
    [{ MOTIR_SCIP_UPLOAD_TOKEN: undefined }, 'MOTIR_SCIP_UPLOAD_TOKEN is not set'],
    [{ MOTIR_CODEGRAPH_REPOSITORY_ID: '' }, 'MOTIR_CODEGRAPH_REPOSITORY_ID is not set'],
    [{ MOTIR_CODEGRAPH_REPOSITORY_ID: '../x' }, 'is not a repository id'],
    [{ MOTIR_SCIP_COMMIT: 'C'.repeat(40) }, 'MOTIR_SCIP_COMMIT must be the run'],
    [{ MOTIR_SCIP_COMMIT: 'abc123' }, 'MOTIR_SCIP_COMMIT must be the run'],
    [{ MOTIR_SCIP_INDEXER: undefined }, 'MOTIR_SCIP_INDEXER is not set'],
    [{ MOTIR_SCIP_INDEXER: 'Bad Name' }, 'is not an indexer name'],
    [{ MOTIR_CODEGRAPH_UPLOAD_URL: 'http://evil.example' }, 'must be an https:// host'],
    [{ MOTIR_CODEGRAPH_UPLOAD_URL: 'https://cg.example/v1' }, 'must be an https:// host'],
    [{ MOTIR_SCIP_WAIT_SECONDS: 'soon' }, 'must be whole seconds'],
    [{ MOTIR_SCIP_ROOT: '/no/such/root' }, "the root '/no/such/root' is not a directory"],
    [{ MOTIR_SCIP_FILE: 'missing.scip' }, 'does not exist'],
    [{ MOTIR_SCIP_INDEX_COMMAND: 'exit 3' }, 'the index command failed'],
  ] as Array<[Record<string, string | undefined>, string]>)(
    '%j names what is wrong',
    async (env, message) => {
      const r = await run(env);
      expect(r.code).toBe(2);
      expect(lines(r).at(-1)).toMatch(/^error: /);
      expect(lines(r).at(-1)).toContain(message);
      expect(seen).toEqual([]);
      expect(r.out).not.toContain(TOKEN);
    },
  );

  it('an empty file', async () => {
    writeFileSync(join(dir, 'index.scip'), '');
    const r = await run();
    expect(r.code).toBe(2);
    expect(lines(r).at(-1)).toContain('is empty');
    expect(seen).toEqual([]);
  });

  it('defaults the host to the public code graph, which this test never reaches', async () => {
    // Proved by refusing on an unset repository id first: the default host is set,
    // and no request is made to it here.
    const r = await run({
      MOTIR_CODEGRAPH_UPLOAD_URL: undefined,
      MOTIR_CODEGRAPH_REPOSITORY_ID: '',
    });
    expect(r.code).toBe(2);
    expect(readFileSync(SCRIPT, 'utf8')).toContain('host="${host:-https://codegraph.motir.co}"');
  });
});
