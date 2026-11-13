import { sqlStateOf } from './sqlstate';

/**
 * A DEAD DATABASE CONNECTION, told apart from a failed query (MOTIR-8350).
 *
 * ── What production saw ──────────────────────────────────────────────────────
 * `GET /api/public/ideas` answered an UNHANDLED 500, `Error: Connection terminated
 * unexpectedly`, thrown from `pg-pool/index.js:45` under `PgQueryable.performIO`.
 * Production then connected through Neon's `-pooler` host, where an intermediary
 * closing a pooled socket is ordinary: a compute restart, a pooler restart, an
 * idle cut. Since the MOTIR-9699 cutover it connects straight to an Amazon RDS
 * instance, which closes sockets the same way on a reboot, a failover or a
 * network interruption — so the shape, and the remedy, still hold.
 *
 * ── What it looks like here — MEASURED, not assumed ──────────────────────────
 * A TCP proxy between the pool and a local Postgres, destroying both sockets
 * (the shape of an intermediary hanging up), through `@prisma/adapter-pg` 7.9:
 *
 *   * a socket closed while a query is IN FLIGHT ⇒ a BARE `Error`, message
 *     `Connection terminated unexpectedly`, no `code`, no `meta` — the stack
 *     byte-for-byte the production one (`pg-pool/index.js:45` → `performIO` →
 *     `queryRaw` → `interpretNode`);
 *   * a socket closed while the client sat IDLE, and a read issued in the same
 *     tick ⇒ the SAME error: the pool hands out the client before its `end`
 *     event has run, the query is written to a dead socket, and it fails. A read
 *     issued once that event has run gets a fresh connection and succeeds — which
 *     is why ONE retry, after a turn of the event loop, is the whole remedy;
 *   * a backend terminated SERVER-side mid-query (`pg_terminate_backend`) ⇒ a
 *     Prisma error carrying SQLSTATE `57P01` at
 *     `meta.driverAdapterError.cause.code` (`sqlStateOf` reads both shapes).
 *
 * The motir-ai twin is `src/dbRetry.ts` (MOTIR-7160 · MOTIR-8282 · MOTIR-8337),
 * which measured the transaction (`P1017`) and raw-query (`ConnectionClosed`)
 * shapes; both are carried here too, so the two services classify alike.
 */

/** Prisma error codes that mean the connection, not the query, failed. */
const CONNECTION_PRISMA_CODES: ReadonlySet<string> = new Set([
  'P1001', // Can't reach database server.
  'P1017', // Server has closed the connection.
]);

/** Driver-adapter error kinds that mean the connection failed. */
const CONNECTION_ADAPTER_KINDS: ReadonlySet<string> = new Set([
  'ConnectionClosed',
  'DatabaseNotReachable',
  'SocketTimeout',
]);

/** Node socket error codes that mean the connection failed. */
const CONNECTION_SOCKET_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
]);

/**
 * SQLSTATEs the SERVER sends when it is dropping the session rather than
 * refusing the statement: class 08 (connection exception) and the three
 * operator-intervention shutdowns.
 */
function isConnectionSqlState(state: string): boolean {
  return state.startsWith('08') || state === '57P01' || state === '57P02' || state === '57P03';
}

/**
 * `pg`'s messages for a connection that ended under it: `Connection terminated
 * unexpectedly` (the production one), `Connection terminated` (ended by the
 * client side) and `Connection terminated due to connection timeout` (a new
 * connection that never finished its handshake).
 */
const CONNECTION_TERMINATED = /Connection terminated/i;

/**
 * `pg-pool`'s message when no client could be handed out in time. The query
 * never ran, so it is retryable exactly like a dead socket.
 */
const POOL_ACQUIRE_TIMEOUT = /timeout exceeded when trying to connect/i;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * True when `err` says the CONNECTION failed rather than the query — a dead or
 * unreachable socket, which a fresh connection need not share. A constraint, a
 * bad query, an RLS denial or any domain error is a real answer and is false.
 */
export function isConnectionError(err: unknown): boolean {
  // Walk the error and its `cause` chain: a driver error is usually wrapped.
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const e = asRecord(current);
    if (!e) return false;
    const code = e['code'];
    if (typeof code === 'string') {
      if (CONNECTION_PRISMA_CODES.has(code) || CONNECTION_SOCKET_CODES.has(code)) return true;
    }
    const state = sqlStateOf(current);
    if (state !== undefined && isConnectionSqlState(state)) return true;
    const adapterCause = asRecord(asRecord(asRecord(e['meta'])?.['driverAdapterError'])?.['cause']);
    const kind = adapterCause?.['kind'] ?? e['kind'];
    if (typeof kind === 'string' && CONNECTION_ADAPTER_KINDS.has(kind)) return true;
    const message = e['message'];
    if (typeof message === 'string') {
      if (CONNECTION_TERMINATED.test(message) || POOL_ACQUIRE_TIMEOUT.test(message)) return true;
    }
    current = e['cause'];
  }
  return false;
}

/**
 * Run `read`; if it fails with a connection error, let the event loop turn and
 * run it exactly ONCE more. By then the pool has discarded its dead clients, so
 * the second attempt takes a fresh connection.
 *
 * ⚠️ READS ONLY. A write whose connection died may or may not have committed, so
 * repeating it is not this helper's decision to make. A second connection error
 * in a row is no longer a stale socket but an outage, and is thrown to the
 * caller, which owes it a typed error and a handled status.
 */
export async function retryReadOnceOnConnectionError<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    // Let the event loop run first. The socket that failed is rarely the only
    // dead one: every idle client the intermediary cut is still in the pool until
    // its own `end` event runs, and a retry issued in the same turn would be
    // handed the next of them (measured: an immediate retry failed the same way).
    await new Promise((resolve) => setImmediate(resolve));
    return read();
  }
}
