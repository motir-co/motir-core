import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

// A REAL device-authorization server for `motir login`'s tests (Subtask
// MOTIR-1868), mirroring what `testServer.ts` does for the `/api/v1` client.
//
// The thing under test IS the transport — that the CLI sends the RFC 8628 body
// the route requires, branches correctly on an error shape it only ever sees as
// an HTTP 400, and never writes a credential on any of the losing paths. Stubbing
// `fetch` would replace exactly that layer with a stand-in. So these tests speak
// real HTTP over a real socket to a genuine `node:http` server; only the DECISION
// (approve / deny / expire / throttle) is scripted, and every request the CLI
// makes is RECORDED so what it asked for is itself asserted.
//
// The shapes are copied from `lib/dto/cliDevice.ts` and
// `app/api/cli/device/token/route.ts` on origin/main — a start payload
// field-for-field, and errors as HTTP 400 `{ error, error_description }` with
// `server_error` as the single 500.

/** What the CLI sent to `/api/cli/device/start`. */
export interface RecordedStart {
  hostname: unknown;
  /** The bearer `motir auth refresh` presents; absent on a login (MOTIR-10189). */
  authorization?: string;
}

/** What the CLI sent to `/api/cli/device/token`. */
export interface RecordedPoll {
  grant_type: unknown;
  device_code: unknown;
  client_id: unknown;
}

/**
 * One scripted poll answer. `granted` completes the flow; `error` is the RFC 8628
 * code the route would return (`authorization_pending`, `slow_down`,
 * `access_denied`, `expired_token`, `invalid_grant`, `server_error`).
 */
export type PollReply = { granted: true } | { updated: true } | { error: string };

export interface DeviceTestServerOptions {
  /** Overrides for the start payload (interval / expires_in / the codes). */
  grant?: Partial<StartPayload>;
  /** Poll answers, consumed in order; the LAST one repeats forever, so a
   *  `[{ error: 'authorization_pending' }]` script is an approval that never
   *  comes — which is how the timeout path is driven. */
  poll?: PollReply[];
  /** Answer `/start` with this status instead of 200 (the refusal paths). */
  startStatus?: number;
  /** Replace the whole `/start` body — for a 200 that is not a grant. */
  startBody?: unknown;
  /** Replace the whole body a `granted` poll returns — for a 200 that carries
   *  no `access_token` (a server that approved but could not mint). */
  grantedBody?: unknown;
  /** `GET /api/cli/token`'s answer (MOTIR-10189). Absent, the route 404s with
   *  HTML, as on a server that predates it. */
  tokenStatus?: { status: number; body: unknown };
}

export interface StartPayload {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface DeviceTestServer {
  /** Base URL for `--server`, no trailing slash. */
  url: string;
  /** The grant this server hands out — the values the CLI must echo/print. */
  grant: StartPayload;
  starts: RecordedStart[];
  polls: RecordedPoll[];
  /** The `Authorization` header of each `GET /api/cli/token`. */
  tokenStatusRequests: (string | undefined)[];
  /** Replace the poll script mid-test. */
  script(poll: PollReply[]): void;
  close(): Promise<void>;
}

/** The credential a `granted` poll returns — Motir's RFC-shape + user/workspace. */
export const GRANTED_CREDENTIAL = {
  access_token: 'motir_pat_device_minted_value',
  token_type: 'Bearer',
  scope: 'work_items:read work_items:write',
  expires_in: 7_776_000,
  user: { id: 'u-device', name: 'Zhu Yue', email: 'yue@motir.test' },
  workspace: { id: 'w-device', name: 'Moooon', slug: 'moooon' },
} as const;

/** What an approved UPDATE grant's poll returns — `DeviceGrantUpdatedDTO`. */
export const UPDATED_GRANT = {
  updated: true,
  label: 'CLI · yue-mbp',
  scope: 'project:browse work_item:edit comment:add',
  user: { id: 'u-device', name: 'Zhu Yue', email: 'yue@motir.test' },
  workspace: { id: 'w-device', name: 'Moooon' },
} as const;

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function startDeviceTestServer(
  options: DeviceTestServerOptions = {},
): Promise<DeviceTestServer> {
  let pollScript: PollReply[] = options.poll ?? [{ granted: true }];
  const starts: RecordedStart[] = [];
  const polls: RecordedPoll[] = [];
  const tokenStatusRequests: (string | undefined)[] = [];
  let pollIndex = 0;
  // Filled once the socket is listening — the verification URIs carry the port,
  // which does not exist until then. A holder rather than a bare binding so the
  // handler can close over it; the handler cannot run before `listen` resolves.
  const issued: { grant?: StartPayload } = {};

  const server: HttpServer = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      const json = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
      };

      if (req.url === '/api/cli/device/start') {
        starts.push({
          hostname: body['hostname'],
          ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
        });
        if (options.startStatus !== undefined) {
          json(options.startStatus, { code: 'NOPE' });
          return;
        }
        json(200, options.startBody ?? issued.grant);
        return;
      }

      if (req.url === '/api/cli/device/token') {
        polls.push({
          grant_type: body['grant_type'],
          device_code: body['device_code'],
          client_id: body['client_id'],
        });
        // The last entry repeats: a script is "what happens next", and the tail
        // is the steady state (still pending, or approved and idempotent here).
        const reply = pollScript[Math.min(pollIndex, pollScript.length - 1)] as PollReply;
        pollIndex += 1;
        if ('updated' in reply) {
          json(200, UPDATED_GRANT);
          return;
        }
        if ('granted' in reply) {
          json(200, options.grantedBody ?? GRANTED_CREDENTIAL);
          return;
        }
        json(reply.error === 'server_error' ? 500 : 400, {
          error: reply.error,
          error_description: reply.error,
        });
        return;
      }

      if (req.url === '/api/cli/token' && req.method === 'GET' && options.tokenStatus) {
        tokenStatusRequests.push(req.headers.authorization);
        json(options.tokenStatus.status, options.tokenStatus.body);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<html>not found</html>');
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  const grant: StartPayload = {
    device_code: 'device-code-40-chars-of-entropy-goes-here',
    user_code: 'K4TP9RXM',
    verification_uri: `${url}/device`,
    verification_uri_complete: `${url}/device?user_code=K4TP9RXM`,
    expires_in: 900,
    interval: 5,
    ...options.grant,
  };
  issued.grant = grant;

  return {
    url,
    grant,
    starts,
    polls,
    tokenStatusRequests,
    script(poll: PollReply[]) {
      pollScript = poll;
      pollIndex = 0;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
