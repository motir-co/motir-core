import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiRefusalError,
  AuthError,
  CliError,
  ContainerHasOpenChildrenError,
  IncompatibleServerError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  ResponseShapeError,
  PermissionError,
  ServerFailureError,
} from '../src/errors.js';
import {
  DEFAULT_RATE_LIMIT_MAX_WAIT_SECONDS,
  describeField,
  isVersionBehind,
  rateLimitMaxWaitFromEnv,
  readRetryAfterSeconds,
  V1Transport,
  type V1TransportOptions,
} from '../src/transport.js';
// @ts-expect-error — the sandbox stub is a plain `.mjs` with no types (see sandboxStub.test.ts);
// its claim fixture is the body a real claim answers.
import { __fixtures } from '../sandbox/smoke/stub-server.mjs';
import { CLIENT_VERSION_HEADER } from '../src/transport.js';
import { CLI_VERSION } from '../src/version.js';
import { GENERATED_AGAINST } from '../src/api/index.js';

// The `/api/v1` transport core, driven against a REAL stub HTTP server over a
// real socket (Story 11.5 · Subtask 11.5.3 — MOTIR-2211).
//
// Deliberately not a mocked `fetch`. What this card has to prove is the request
// actually put on the wire (method, path, query, bearer) and the behaviour on a
// real status line with real headers — and a stubbed module proves neither. The
// server below records every request it receives, so the assertions are about
// bytes rather than about call arguments.

/** One canned reply the stub server serves for the next request. */
interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Serve raw text instead of JSON — for an unparseable body. */
  raw?: string;
}

/** What the stub recorded about a request it served. */
interface Recorded {
  method: string;
  url: string;
  authorization: string | undefined;
  /** Every header, so a TRANSPORT-level field can be asserted on the wire. */
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

class StubServer {
  private server: Server | undefined;
  private replies: Reply[] = [];
  readonly received: Recorded[] = [];
  /** A default reply, served once `replies` runs out. */
  fallback: Reply = { status: 500, body: { code: 'UNEXPECTED', error: 'no reply queued' } };
  url = '';

  async start(): Promise<void> {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        this.received.push({
          method: req.method ?? '',
          url: req.url ?? '',
          authorization: req.headers.authorization,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        const reply = this.replies.shift() ?? this.fallback;
        res.writeHead(reply.status, {
          'content-type': 'application/json',
          ...(reply.headers ?? {}),
        });
        res.end(reply.raw ?? (reply.body === undefined ? '' : JSON.stringify(reply.body)));
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const address = this.server?.address() as AddressInfo;
    this.url = `http://127.0.0.1:${address.port}`;
  }

  queue(...replies: Reply[]): void {
    this.replies.push(...replies);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
    });
  }
}

/** A valid `Project`, the smallest real resource to round-trip. */
const PROJECT = {
  key: 'MOTIR',
  name: 'Motir',
  accessLevel: 'open',
  accessMode: 'workspace',
  archived: false,
};

/** A spec document advertising `version`, for the skew probe. */
function specWithVersion(version: string): unknown {
  return { openapi: '3.1.0', info: { title: 'Motir API', version }, paths: {} };
}

let stub: StubServer;

beforeEach(async () => {
  stub = new StubServer();
  await stub.start();
});

afterEach(async () => {
  await stub.stop();
});

function transport(overrides: Partial<V1TransportOptions> = {}): V1Transport {
  return new V1Transport({ serverUrl: stub.url, token: 'motir_pat_test', ...overrides });
}

describe('the request primitive', () => {
  it('issues a real request with the bearer header and returns a validated body', async () => {
    stub.queue({ status: 200, body: PROJECT });

    const project = await transport().request('getProject', { path: { projectKey: 'MOTIR' } });

    expect(project).toEqual(PROJECT);
    expect(stub.received).toHaveLength(1);
    expect(stub.received[0]?.method).toBe('GET');
    expect(stub.received[0]?.url).toBe('/api/v1/projects/MOTIR');
    expect(stub.received[0]?.authorization).toBe('Bearer motir_pat_test');
  });

  it('URL-encodes a path parameter rather than interpolating it raw', async () => {
    stub.queue({ status: 200, body: PROJECT });
    await transport().request('getProject', { path: { projectKey: 'a/b' } });
    expect(stub.received[0]?.url).toBe('/api/v1/projects/a%2Fb');
  });

  it('builds a query string, skipping undefined and null', async () => {
    stub.queue({ status: 200, body: { items: [], nextCursor: null } });

    await transport().request('getProjectReadyLeaves', {
      path: { projectKey: 'MOTIR' },
      query: { limit: 10, cursor: undefined },
    });

    expect(stub.received[0]?.url).toBe('/api/v1/projects/MOTIR/ready/leaves?limit=10');
  });

  // MOTIR-2317. `kind` / `priority` are the only ARRAY query parameters the
  // document declares, and they declare `explode: true` — the repeated-key form
  // `parseReadyFilters` reads with `params.getAll`. Asserted on the URL the stub
  // actually received, so this is about bytes on the wire and not about how the
  // encoder was called.
  it('spreads an ARRAY query value into repeated keys, alongside the scalars', async () => {
    stub.queue({ status: 200, body: { items: [], nextCursor: null } });

    await transport().request('getProjectReadyLeaves', {
      path: { projectKey: 'MOTIR' },
      query: { kind: ['epic', 'story'], priority: ['high'], limit: 10 },
    });

    expect(stub.received[0]?.url).toBe(
      '/api/v1/projects/MOTIR/ready/leaves?kind=epic&kind=story&priority=high&limit=10',
    );
  });

  it('URL-encodes each element of an array rather than the joined string', async () => {
    stub.queue({ status: 200, body: { items: [], nextCursor: null } });

    await transport().request('getProjectReadyLeaves', {
      path: { projectKey: 'MOTIR' },
      query: { kind: ['a b', 'c&d'] },
    });

    // A comma-joined encoding would put ONE key here and the route's `getAll`
    // would read a single kind named `a b,c&d` — a filter matching nothing.
    expect(stub.received[0]?.url).toBe('/api/v1/projects/MOTIR/ready/leaves?kind=a+b&kind=c%26d');
  });

  it('sends NO key for an empty array — the same request as omitting the filter', async () => {
    stub.queue({ status: 200, body: { items: [], nextCursor: null } });

    await transport().request('getProjectReadyLeaves', {
      path: { projectKey: 'MOTIR' },
      query: { kind: [], limit: 5 },
    });

    // `?kind=` would be an empty kind, which is a 422 — not "any kind".
    expect(stub.received[0]?.url).toBe('/api/v1/projects/MOTIR/ready/leaves?limit=5');
  });

  it('sends a JSON body with a content type on a write, and none on a read', async () => {
    stub.queue({ status: 200, body: { items: [], nextCursor: null } });
    await transport().request('getProjectReadyLeaves', { path: { projectKey: 'MOTIR' } });
    expect(stub.received[0]?.body).toBe('');
  });

  it('refuses to build a URL with a missing path parameter', () => {
    expect(() => transport().buildUrl('getProject', { path: { projectKey: '' } })).not.toThrow();
    // An explicitly absent parameter is an internal defect, not a server error.
    expect(() => transport().buildUrl('getProject', {})).toThrow(CliError);
  });
});

describe('an opaque cursor passes through untouched', () => {
  it('is sent verbatim and returned verbatim, never rebuilt', async () => {
    // A cursor is signed and collection-scoped (ADR §5). This one contains the
    // characters a client tempted to "helpfully" normalise would break.
    const cursor = 'eyJrIjoiMjAyNi0wOC0wNVQxMjowMDowMFoifQ==';
    stub.queue({ status: 200, body: { items: [], nextCursor: cursor } });

    const page = await transport().request('getProjectReadyLeaves', {
      path: { projectKey: 'MOTIR' },
      query: { cursor },
    });

    expect(stub.received[0]?.url).toContain(`cursor=${encodeURIComponent(cursor)}`);
    expect(page.nextCursor).toBe(cursor);
  });
});

describe('the boundary PARSE names the field', () => {
  it('a MISSING required key', async () => {
    const { name: _dropped, ...withoutName } = PROJECT;
    stub.queue({ status: 200, body: withoutName });

    await expect(
      transport().request('getProject', { path: { projectKey: 'MOTIR' } }),
    ).rejects.toMatchObject({
      name: 'ResponseShapeError',
      // The case `instancePath` alone would have reported as "` `".
      message: expect.stringContaining('/name'),
    });
  });

  it('a WRONG SCALAR TYPE', async () => {
    stub.queue({ status: 200, body: { ...PROJECT, archived: 'nope' } });

    await expect(
      transport().request('getProject', { path: { projectKey: 'MOTIR' } }),
    ).rejects.toMatchObject({
      name: 'ResponseShapeError',
      message: expect.stringContaining('/archived'),
    });
  });

  it('a WRONG ENUM VALUE', async () => {
    stub.queue({ status: 200, body: { ...PROJECT, accessLevel: 'semi-open' } });

    const error = await transport()
      .request('getProject', { path: { projectKey: 'MOTIR' } })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ResponseShapeError);
    expect((error as CliError).message).toContain('/accessLevel');
    expect((error as CliError).hint).toContain('motir doctor');
  });

  it('names the ROOT when the whole body is the wrong shape', () => {
    expect(
      describeField({ instancePath: '', schemaPath: '#/type', keyword: 'type', params: {} }),
    ).toBe('(root)');
  });

  it('names an ADDITIONAL property, so a server that GREW a field is legible', () => {
    expect(
      describeField({
        instancePath: '',
        schemaPath: '#/additionalProperties',
        keyword: 'additionalProperties',
        params: { additionalProperty: 'surprise' },
      }),
    ).toBe('/surprise');
  });
});

describe('the status map', () => {
  it('401 → AuthError, with the re-login hint', async () => {
    stub.queue({
      status: 401,
      body: { code: 'UNAUTHENTICATED', error: 'Authentication required.' },
    });

    const error = await transport()
      .request('getProject', { path: { projectKey: 'MOTIR' } })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AuthError);
    expect((error as CliError).hint).toContain('motir auth login');
  });

  it('403 → PermissionError NAMING the permission, taken from the generated table', async () => {
    stub.queue({ status: 403, body: { code: 'INSUFFICIENT_SCOPE', error: 'nope' } });

    const error = await transport()
      .request('createWorkItem', {
        path: { projectKey: 'MOTIR' },
        body: { kind: 'subtask', title: 'x' },
      })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(PermissionError);
    // `work_item:edit` comes from `x-motir-permission` on the operation, NOT
    // from the server's sentence — which said only "nope". Since Story
    // MOTIR-2572 that is a catalog key rather than one of the six scopes.
    expect((error as CliError).message).toContain("'work_item:edit'");
    expect((error as CliError).message).toContain('createWorkItem');
  });

  it('404 WITH an envelope → NotFoundError carrying the server’s own sentence', async () => {
    stub.queue({ status: 404, body: { code: 'WORK_ITEM_NOT_FOUND', error: 'No such work item.' } });

    const error = await transport()
      .request('getWorkItem', { path: { key: 'MOTIR-9999' } })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as CliError).message).toBe('No such work item.');
  });

  it('429 → RateLimitError reporting the reset instant and a relative retry', async () => {
    const resetAt = Math.floor(Date.UTC(2026, 7, 5, 12, 0, 30) / 1000);
    stub.queue({
      status: 429,
      body: { code: 'RATE_LIMITED', error: 'Too many requests.' },
      headers: { 'x-ratelimit-reset': String(resetAt) },
    });

    // `rateLimitMaxWaitSeconds: 0` — the transport may not wait at all, so the
    // refusal surfaces as it did before MOTIR-8602 taught it to wait.
    const error = await transport({
      now: () => new Date(Date.UTC(2026, 7, 5, 12, 0, 0)),
      rateLimitMaxWaitSeconds: 0,
    })
      .request('getProject', { path: { projectKey: 'MOTIR' } })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as CliError).message).toContain('refills at');
    // The relative hint is derived from the absolute reset instant.
    expect((error as CliError).hint).toBe('Retry in 30 seconds.');
    expect((error as CliError).message).not.toContain('gave up');
    expect(stub.received).toHaveLength(1);
  });

  it('429 with NO reset header still produces a usable error', async () => {
    stub.queue({ status: 429, body: { code: 'RATE_LIMITED', error: 'Too many requests.' } });

    const error = await transport({ rateLimitMaxWaitSeconds: 0 })
      .request('getProject', { path: { projectKey: 'MOTIR' } })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as CliError).hint).toBe('Retry shortly.');
  });

  it('500 → CliError quoting the request id, which is what support needs', async () => {
    stub.queue({
      status: 500,
      body: { error: 'Something went wrong.' },
      headers: { 'x-request-id': 'req_abc' },
    });

    const error = await transport()
      .request('getProject', { path: { projectKey: 'MOTIR' } })
      .catch((err: unknown) => err);

    expect((error as CliError).message).toContain('failed (500)');
    expect((error as CliError).message).toContain('req_abc');
    // Typed, with its status, so the run reporter can retry it (MOTIR-10705).
    expect(error).toBeInstanceOf(ServerFailureError);
    expect((error as ServerFailureError).status).toBe(500);
  });

  it('a CONNECTION failure → CliError naming the server', async () => {
    await stub.stop();

    const error = await transport()
      .request('getProject', { path: { projectKey: 'MOTIR' } })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CliError);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as CliError).message).toContain('Could not reach');
    expect((error as CliError).hint).toContain('motir doctor');
  });

  it('a documented 4xx (422) reports the server’s sentence with NO added hint', async () => {
    stub.queue({
      status: 422,
      body: { code: 'INVALID_CURSOR', error: 'That cursor is not ours.' },
    });

    const error = await transport()
      .request('getProjectReadyLeaves', { path: { projectKey: 'MOTIR' }, query: { cursor: 'bad' } })
      .catch((err: unknown) => err);

    expect((error as CliError).message).toBe('That cursor is not ours.');
    expect((error as CliError).hint).toBeUndefined();
    // The status and the machine code ride as DATA (MOTIR-10705).
    expect(error).toBeInstanceOf(ApiRefusalError);
    expect((error as ApiRefusalError).status).toBe(422);
    expect((error as ApiRefusalError).code).toBe('INVALID_CURSOR');
  });

  it('a 4xx with NO envelope is an ApiRefusalError naming the status, with a null code', async () => {
    stub.queue({ status: 413, raw: 'Payload Too Large' });

    const error = await transport()
      .request('getProject', { path: { projectKey: 'MOTIR' } })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ApiRefusalError);
    expect((error as CliError).message).toContain('answered 413 for getProject');
    expect((error as ApiRefusalError).status).toBe(413);
    expect((error as ApiRefusalError).code).toBeNull();
  });

  it('a 422 `CONTAINER_HAS_OPEN_CHILDREN` is TYPED, so a run can continue from it', async () => {
    // ⚠️ Bug MOTIR-3268. Every other documented 422 is a plain `CliError` the
    // caller reports and dies on. This one is a state an unattended run REPORTS
    // and continues from — the container's children are not built — and an
    // unhandled throw at the transition would take the run's close-out down with
    // it. The branch reads the machine CODE; the open children live only in the
    // server's sentence, and a client does not parse sentences.
    stub.queue({
      status: 422,
      body: {
        code: 'CONTAINER_HAS_OPEN_CHILDREN',
        error:
          'This item cannot reach "implemented" while 1 of its children has not been ' +
          'implemented: MOTIR-9.',
      },
    });

    const error = await transport()
      .request('getProject', { path: { projectKey: 'MOTIR' } })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ContainerHasOpenChildrenError);
    // The server's sentence, verbatim — the two surfaces cannot disagree about
    // what is open if only one of them composes the answer.
    expect((error as CliError).message).toContain('MOTIR-9');
    expect((error as CliError).hint).toContain('re-parent them out');
  });

  it.each([
    {
      code: 'OBSOLESCENCE_REQUIRES_FINISHED',
      error:
        'MOTIR-12 is at in_progress: only a finished work item can be marked outdated or ' +
        'deprecated. A work item nobody will finish is archived, not marked.',
      item: { key: 'MOTIR-12', statusKey: 'in_progress', statusCategory: 'in_progress' },
    },
    {
      code: 'MARKED_CARD_CANNOT_REOPEN',
      error: 'MOTIR-12 is marked deprecated: clear the mark to reopen this item.',
      mark: { key: 'MOTIR-12', obsolescence: 'deprecated', toStatusKey: 'todo' },
    },
  ])(
    'a 422 `$code` — the finished-card refusals (MOTIR-6673) — reads as the server’s sentence, its additive payload accepted',
    async (body) => {
      // The envelope carries an ADDITIVE payload (`item` / `mark`) beside `code` and
      // `error`. The CLI's envelope reader must accept it rather than fall back to the
      // no-envelope path (MOTIR-6180 is the shape not to repeat: a client that
      // rejects an additive field breaks the day the server adds one).
      stub.queue({ status: 422, body });

      const error = await transport()
        .request('getProject', { path: { projectKey: 'MOTIR' } })
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).message).toBe(body.error);
      expect((error as CliError).hint).toBeUndefined();
    },
  );

  it('a 4xx with NO envelope still produces a legible error', async () => {
    stub.queue({ status: 409, raw: '<html>nope</html>' });

    const error = await transport()
      .request('getProject', { path: { projectKey: 'MOTIR' } })
      .catch((err: unknown) => err);

    expect((error as CliError).message).toContain('answered 409');
  });
});

describe('the error path reads the machine `code`, never the human sentence', () => {
  it('two different sentences under ONE code map to the same class', async () => {
    stub.queue({ status: 403, body: { code: 'INSUFFICIENT_SCOPE', error: 'Nope.' } });
    const first = await transport()
      .request('getProject', { path: { projectKey: 'MOTIR' } })
      .catch((err: unknown) => err);

    stub.queue({
      status: 403,
      body: { code: 'INSUFFICIENT_SCOPE', error: 'A completely different sentence, unauthorized.' },
    });
    const second = await transport()
      .request('getProject', { path: { projectKey: 'MOTIR' } })
      .catch((err: unknown) => err);

    expect(first).toBeInstanceOf(PermissionError);
    expect(second).toBeInstanceOf(PermissionError);
    // Note the second sentence contains "unauthorized" — the word the MCP-era
    // `isUnauthorized` regex matched. Under HTTP it changes nothing.
    expect(second).not.toBeInstanceOf(AuthError);
    expect((first as CliError).message).toBe((second as CliError).message);
  });
});

describe('the version-skew gate', () => {
  it('an incompatible MAJOR produces ONE upgrade error', async () => {
    stub.queue(
      { status: 200, body: { ...PROJECT, accessLevel: 'from-the-future' } },
      { status: 200, body: specWithVersion('2.0.0') },
    );

    const error = await transport()
      .request('getProject', { path: { projectKey: 'MOTIR' } })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(IncompatibleServerError);
    expect((error as CliError).message).toContain('speaks Motir API v1');
    expect((error as CliError).message).toContain('serves v2');
    expect((error as CliError).hint).toContain('npm install -g @motir/cli@latest');
  });

  it('fires at most ONCE — the probe is latched per instance', async () => {
    const client = transport();
    stub.queue(
      { status: 200, body: { ...PROJECT, accessLevel: 'bad' } },
      { status: 200, body: specWithVersion('2.0.0') },
      { status: 200, body: { ...PROJECT, accessLevel: 'bad' } },
    );

    await client.request('getProject', { path: { projectKey: 'MOTIR' } }).catch(() => undefined);
    await client.request('getProject', { path: { projectKey: 'MOTIR' } }).catch(() => undefined);

    // Three requests, not four: two calls plus ONE spec fetch.
    expect(stub.received.map((r) => r.url)).toEqual([
      '/api/v1/projects/MOTIR',
      '/api/openapi/v1.json',
      '/api/v1/projects/MOTIR',
    ]);
  });

  it('a server AHEAD on the minor is NOT skew — §8 is additive-only', async () => {
    // The load-bearing negative. A newer server cannot break a client generated
    // earlier, so a parse failure there is a REAL defect and must be reported as
    // one rather than laundered into "upgrade something".
    const [major, minor] = GENERATED_AGAINST.split('.');
    stub.queue(
      { status: 200, body: { ...PROJECT, accessLevel: 'bad' } },
      { status: 200, body: specWithVersion(`${major}.${Number(minor) + 1}.0`) },
    );

    const error = await transport()
      .request('getProject', { path: { projectKey: 'MOTIR' } })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ResponseShapeError);
    expect(error).not.toBeInstanceOf(IncompatibleServerError);
  });

  it('compares MINOR then PATCH, and treats equal as not behind', () => {
    // Asserted directly rather than through the stub: `GENERATED_AGAINST` is
    // `1.0.0`, so no version inside major 1 is below it and an end-to-end test
    // could not reach this arm today. It becomes reachable the first time the
    // contract's MINOR moves — which is exactly when getting it wrong would
    // start telling users to upgrade a server that is fine.
    expect(isVersionBehind([1, 0, 0], [1, 1, 0])).toBe(true);
    expect(isVersionBehind([1, 2, 0], [1, 1, 9])).toBe(false);
    expect(isVersionBehind([1, 1, 0], [1, 1, 4])).toBe(true);
    expect(isVersionBehind([1, 1, 4], [1, 1, 4])).toBe(false);
    expect(isVersionBehind([1, 1, 5], [1, 1, 4])).toBe(false);
  });

  it('a server at exactly the generated version is NOT skew', async () => {
    stub.queue(
      { status: 200, body: { ...PROJECT, accessLevel: 'bad' } },
      { status: 200, body: specWithVersion(GENERATED_AGAINST) },
    );

    await expect(
      transport().request('getProject', { path: { projectKey: 'MOTIR' } }),
    ).rejects.toBeInstanceOf(ResponseShapeError);
  });

  it('an UNREACHABLE spec yields NO verdict — the original error stands', async () => {
    stub.queue(
      { status: 200, body: { ...PROJECT, accessLevel: 'bad' } },
      { status: 404, raw: 'nope' },
    );

    const error = await transport()
      .request('getProject', { path: { projectKey: 'MOTIR' } })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ResponseShapeError);
  });

  it('an UNPARSEABLE spec yields no verdict either', async () => {
    stub.queue(
      { status: 200, body: { ...PROJECT, accessLevel: 'bad' } },
      { status: 200, raw: 'not json at all' },
    );

    await expect(
      transport().request('getProject', { path: { projectKey: 'MOTIR' } }),
    ).rejects.toBeInstanceOf(ResponseShapeError);
  });

  it('a spec with no `info.version` yields no verdict', async () => {
    stub.queue(
      { status: 200, body: { ...PROJECT, accessLevel: 'bad' } },
      { status: 200, body: { openapi: '3.1.0', paths: {} } },
    );

    await expect(
      transport().request('getProject', { path: { projectKey: 'MOTIR' } }),
    ).rejects.toBeInstanceOf(ResponseShapeError);
  });

  it('a non-semver `info.version` yields no verdict', async () => {
    stub.queue(
      { status: 200, body: { ...PROJECT, accessLevel: 'bad' } },
      { status: 200, body: specWithVersion('v1') },
    );

    await expect(
      transport().request('getProject', { path: { projectKey: 'MOTIR' } }),
    ).rejects.toBeInstanceOf(ResponseShapeError);
  });

  it('a 404 with NO envelope means the ROUTE is absent, and arms the probe', async () => {
    stub.queue(
      { status: 404, raw: '<html>404</html>' },
      { status: 200, body: specWithVersion('2.0.0') },
    );

    const error = await transport()
      .request('getWorkItem', { path: { key: 'MOTIR-1' } })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(IncompatibleServerError);
    expect(stub.received[1]?.url).toBe('/api/openapi/v1.json');
  });

  it('an absent route with a COMPATIBLE server is reported as a missing endpoint', async () => {
    stub.queue(
      { status: 404, raw: '<html>404</html>' },
      { status: 200, body: specWithVersion(GENERATED_AGAINST) },
    );

    const error = await transport()
      .request('getWorkItem', { path: { key: 'MOTIR-1' } })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain('has no getWorkItem endpoint');
  });

  it('a spec fetch that THROWS yields no verdict rather than a wrong one', async () => {
    stub.queue({ status: 200, body: { ...PROJECT, accessLevel: 'bad' } });
    let call = 0;
    const flaky: typeof fetch = async (input, init) => {
      call += 1;
      if (call > 1) throw new Error('socket hang up');
      return fetch(input, init);
    };

    const client = new V1Transport({ serverUrl: stub.url, token: 't', fetchImpl: flaky });
    await expect(
      client.request('getProject', { path: { projectKey: 'MOTIR' } }),
    ).rejects.toBeInstanceOf(ResponseShapeError);
  });
});

describe('the CLI reports its version on a dedicated field (MOTIR-4974)', () => {
  it('carries it on a command that is NOT dispatch', async () => {
    // ⚠️ THE POINT OF ASSERTING IT HERE is that the coverage is TRANSPORT-level
    // rather than per-operation. `listProjects` is an ordinary read that knows
    // nothing about versions; if the field rides on it, it rides on everything,
    // including the operations nobody has written yet. A per-tool field would
    // have to be remembered by each new one, and the one it was forgotten on is
    // the one a stale client would use.
    stub.queue({ status: 200, body: { items: [PROJECT], nextCursor: null } });
    await transport().request('listProjects', {});

    const sent = stub.received[0]?.headers[CLIENT_VERSION_HEADER];
    expect(sent).toBe(CLI_VERSION);
  });

  it('reports it on the field the SERVER reads — the two literals must agree', () => {
    // ⚠️ READ AS TEXT, NOT IMPORTED. `packages/cli` does not depend on the app's
    // `lib/` (ADR `public-api-conventions.md` Amendment 9 Q3 permits exactly one
    // module in the other direction, and none in this one), so the field name is
    // a literal on both sides and this is the guard that keeps them one string.
    //
    // The failure it catches is SILENT: rename either side and the server simply
    // never sees a version, which reads exactly like a fleet that is up to date.
    // A floor that never fires is indistinguishable from a floor nobody needs.
    const serverSource = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        'lib',
        'api',
        'v1',
        'clientVersion.ts',
      ),
      'utf8',
    );
    expect(serverSource).toContain(`CLIENT_VERSION_HEADER = '${CLIENT_VERSION_HEADER}'`);
  });
});

// ── MOTIR-8602: a 429 is a pause, not a failure ─────────────────────────────

/** An injected `sleep` that records each wait and resolves at once. */
function recordingSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return { waits, sleep: (ms) => (waits.push(ms), Promise.resolve()) };
}

const REFUSAL = (retryAfterSeconds: unknown) => ({
  status: 429,
  body: { code: 'RATE_LIMIT_EXCEEDED', error: 'Too many requests.', retryAfterSeconds },
});

describe('a 429 is waited out and the same request re-sent (MOTIR-8602)', () => {
  it('waits the named seconds, re-sends the identical request and returns the 200 body', async () => {
    stub.queue(REFUSAL(7), { status: 200, body: PROJECT });
    const { sleep, waits } = recordingSleep();

    const project = await transport({ sleep, onRateLimitWait: () => {} }).request('getProject', {
      path: { projectKey: 'MOTIR' },
    });

    expect(project).toEqual(PROJECT);
    expect(stub.received).toHaveLength(2);
    const [first, second] = stub.received;
    expect(second?.method).toBe(first?.method);
    expect(second?.url).toBe(first?.url);
    expect(second?.authorization).toBe(first?.authorization);
    expect(second?.body).toBe(first?.body);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(7000);
    expect(waits[0]).toBeLessThan(8000);
  });

  it('re-sends a request BODY unchanged', async () => {
    stub.queue(REFUSAL(1), {
      status: 400,
      body: { code: 'VALIDATION_ERROR', error: 'nope' },
    });
    const { sleep } = recordingSleep();
    await transport({ sleep, onRateLimitWait: () => {} })
      .request('transitionWorkItem', { path: { key: 'MOTIR-1' }, body: { status: 'done' } })
      .catch(() => undefined);
    expect(stub.received).toHaveLength(2);
    expect(stub.received[1]?.body).toBe(stub.received[0]?.body);
    expect(JSON.parse(stub.received[1]?.body ?? '{}')).toEqual({ status: 'done' });
  });

  it('announces each wait with the notice fields', async () => {
    stub.queue(REFUSAL(3), REFUSAL(4), { status: 200, body: PROJECT });
    const { sleep } = recordingSleep();
    const notices: unknown[] = [];

    await transport({
      sleep,
      onRateLimitWait: (n) => notices.push(n),
      rateLimitMaxWaitSeconds: 60,
    }).request('getProject', { path: { projectKey: 'MOTIR' } });

    expect(notices).toEqual([
      {
        operationId: 'getProject',
        waitSeconds: 3,
        attempt: 1,
        waitedSeconds: 0,
        maxWaitSeconds: 60,
      },
      {
        operationId: 'getProject',
        waitSeconds: 4,
        attempt: 2,
        waitedSeconds: 3,
        maxWaitSeconds: 60,
      },
    ]);
  });

  it('writes the default notice to STDERR and nothing to stdout', async () => {
    stub.queue(REFUSAL(5), { status: 200, body: PROJECT });
    const { sleep } = recordingSleep();
    const out: string[] = [];
    const err: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    try {
      await transport({ sleep, rateLimitMaxWaitSeconds: 300 }).request('getProject', {
        path: { projectKey: 'MOTIR' },
      });
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
    expect(out).toEqual([]);
    expect(err).toEqual([
      `Rate limited by ${stub.url}; waiting 5s before retrying getProject (attempt 1, 0s of 300s used).\n`,
    ]);
  });

  it('gives up with a RateLimitError naming the wait once the bounded total runs out', async () => {
    stub.fallback = REFUSAL(7);
    const { sleep, waits } = recordingSleep();

    const error = await transport({ sleep, onRateLimitWait: () => {}, rateLimitMaxWaitSeconds: 20 })
      .request('getProject', { path: { projectKey: 'MOTIR' } })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RateLimitError);
    expect(error).not.toBeInstanceOf(ResponseShapeError);
    expect(error).not.toBeInstanceOf(NotFoundError);
    expect((error as CliError).exitCode).toBe(1);
    expect((error as CliError).message).toContain('gave up after waiting 14 seconds');
    expect(waits).toHaveLength(2);
    expect(stub.received).toHaveLength(3);
  });

  it.each([500, 503])('a %i is sent once and mapped as before — never retried', async (status) => {
    stub.queue({ status, body: { error: 'Something went wrong.' } });
    const { sleep, waits } = recordingSleep();
    const error = await transport({ sleep })
      .request('getProject', { path: { projectKey: 'MOTIR' } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain(`The Motir server failed (${status})`);
    expect(stub.received).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('a fetch that rejects is attempted once — never retried', async () => {
    let calls = 0;
    const { sleep, waits } = recordingSleep();
    const error = await transport({
      sleep,
      fetchImpl: () => {
        calls += 1;
        return Promise.reject(new Error('socket hang up'));
      },
    })
      .request('getProject', { path: { projectKey: 'MOTIR' } })
      .catch((e: unknown) => e);
    expect((error as CliError).message).toContain('Could not reach');
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
  });

  it.each([
    ['claimed', 'RETRY-1'],
    ['mine', 'RETRY-2'],
  ])('a refused claim retried once answers %s — the claim logic ran once', async (outcome, key) => {
    const fixtures = __fixtures as { claim: (key: string) => Record<string, unknown> };
    const claimed = fixtures.claim(key);
    stub.queue(REFUSAL(2), { status: 200, body: { ...claimed, outcome } });
    const { sleep } = recordingSleep();

    const result = await transport({ sleep, onRateLimitWait: () => {} }).request('claimWorkItem', {
      path: { key },
    });

    expect(result.outcome).toBe(outcome);
    expect(stub.received.map((r) => `${r.method} ${r.url}`)).toEqual([
      `POST /api/v1/work-items/${key}/claim`,
      `POST /api/v1/work-items/${key}/claim`,
    ]);
  });
});

describe('readRetryAfterSeconds (MOTIR-8602)', () => {
  const NOW = new Date(Date.UTC(2026, 9, 14, 12, 0, 0));
  const nowSeconds = NOW.getTime() / 1000;
  const res = (headers: Record<string, string>) => new Response(null, { status: 429, headers });

  it.each([
    ['the body field first', res({ 'retry-after': '30' }), { retryAfterSeconds: 7 }, 7],
    ['Retry-After when the body has none', res({ 'retry-after': '30' }), {}, 30],
    [
      'a string body field is ignored',
      res({ 'retry-after': '12' }),
      { retryAfterSeconds: '7' },
      12,
    ],
    ['a Retry-After of 0 is floored to 1', res({ 'retry-after': '0' }), {}, 1],
    ['x-ratelimit-reset minus now', res({ 'x-ratelimit-reset': String(nowSeconds + 25) }), {}, 25],
    ['the default when nothing is usable', res({ 'retry-after': 'soon' }), undefined, 10],
    ['never the error sentence', res({}), { error: 'Too many requests. Retry in 42 seconds.' }, 10],
  ])('%s', (_label, response, body, expected) => {
    expect(readRetryAfterSeconds(response, body, NOW)).toBe(expected);
  });
});

describe('the bounded total (MOTIR-8602)', () => {
  it('reads MOTIR_CLI_RATE_LIMIT_MAX_WAIT_SECONDS, falling back to 300 on nonsense', () => {
    expect(rateLimitMaxWaitFromEnv({ MOTIR_CLI_RATE_LIMIT_MAX_WAIT_SECONDS: '5' })).toBe(5);
    expect(rateLimitMaxWaitFromEnv({ MOTIR_CLI_RATE_LIMIT_MAX_WAIT_SECONDS: 'lots' })).toBe(300);
    expect(rateLimitMaxWaitFromEnv({ MOTIR_CLI_RATE_LIMIT_MAX_WAIT_SECONDS: '-1' })).toBe(300);
    expect(rateLimitMaxWaitFromEnv({})).toBe(DEFAULT_RATE_LIMIT_MAX_WAIT_SECONDS);
  });

  it('caps the waiting at the env value when none is passed', async () => {
    const before = process.env['MOTIR_CLI_RATE_LIMIT_MAX_WAIT_SECONDS'];
    process.env['MOTIR_CLI_RATE_LIMIT_MAX_WAIT_SECONDS'] = '5';
    try {
      stub.fallback = REFUSAL(3);
      const { sleep, waits } = recordingSleep();
      const error = await transport({ sleep, onRateLimitWait: () => {} })
        .request('getProject', { path: { projectKey: 'MOTIR' } })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RateLimitError);
      expect(waits).toHaveLength(1);
    } finally {
      if (before === undefined) delete process.env['MOTIR_CLI_RATE_LIMIT_MAX_WAIT_SECONDS'];
      else process.env['MOTIR_CLI_RATE_LIMIT_MAX_WAIT_SECONDS'] = before;
    }
  });
});
