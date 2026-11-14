import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as Sentry from '@sentry/nextjs';
import type { Event, Exception } from '@sentry/nextjs';
import {
  CAUGHT_CHUNK_LOAD_ERROR_TYPE,
  keepChunkLoadEvent,
  reportCaughtError,
} from '@/lib/monitoring/reportCaughtError';

// THE REFERENCE ON THE ERROR PAGE NAMES AN EVENT THAT REACHES SENTRY (MOTIR-11243).
//
// On 2026-11-13 at 22:11 UTC a tab left open across a deploy failed to load a
// script, the root error boundary drew "Motir couldn't load", and Sentry held no
// browser event for it. The cause is not in the browser: the SDK sent it, and
// Sentry's own "Filter out ChunkLoadError(s)" inbound filter — on by default in
// every project — dropped it at ingest, because Turbopack throws exactly the
// shape that filter matches (`ChunkLoadError` / `Failed to load chunk …`).
//
// `matchesSentryChunkLoadFilter` below is that filter's condition, copied from
// getsentry/sentry `src/sentry/ingest/inbound_filters.py`
// (`_chunk_load_error_filter` over `_error_message_condition`: ANY exception in
// `event.exception.values` whose type AND value match one pair of globs). These
// tests send the boundary's report through the REAL SDK, over the wire, and
// read back what Sentry would receive. The CONTROL arm sends the same error the
// way the SDK does by default and shows the filter would drop it — so the
// predicate is live, and the relabel is what makes the difference.

const CHUNK_LOAD_FILTER: ReadonlyArray<readonly [string, string]> = [
  // Webpack
  ['ChunkLoadError', 'Loading chunk *'],
  ['*Uncaught *', 'ChunkLoadError: Loading chunk *'],
  // Turbopack
  ['ChunkLoadError', 'Failed to load chunk *'],
  ['*Uncaught *', 'ChunkLoadError: Failed to load chunk *'],
  // Promise rejections
  ['Error', 'Uncaught (in promise): ChunkLoadError*'],
];

function glob(pattern: string, value: string | undefined): boolean {
  if (value === undefined) return false;
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`, 's').test(value);
}

function matchesSentryChunkLoadFilter(event: Event): boolean {
  const values: Exception[] = event.exception?.values ?? [];
  return values.some((exception) =>
    CHUNK_LOAD_FILTER.some(
      ([type, value]) => glob(type, exception.type) && glob(value, exception.value),
    ),
  );
}

/** What Turbopack's runtime throws when a chunk's `<script>` fails to load. */
function turbopackChunkLoadError(): Error {
  const cause = new Error(
    'Failed to load chunk /_next/static/chunks/1icqp_l_jcfyv.js from module 9031',
  );
  cause.name = 'ChunkLoadError';
  const error = new Error(
    'Failed to load chunk /_next/static/chunks/0u6a5fatitug2.js from module 41: ' +
      'ChunkLoadError: Failed to load chunk /_next/static/chunks/1icqp_l_jcfyv.js from module 9031',
    { cause },
  );
  error.name = 'ChunkLoadError';
  return error;
}

describe('keepChunkLoadEvent', () => {
  it('renames every ChunkLoadError exception and keeps its value verbatim', () => {
    const event: Event = {
      exception: {
        values: [
          { type: 'ChunkLoadError', value: 'Failed to load chunk a.js from module 1' },
          { type: 'TypeError', value: 'unrelated' },
          { type: 'ChunkLoadError', value: 'Failed to load chunk b.js from module 2' },
        ],
      },
    };
    expect(matchesSentryChunkLoadFilter(event)).toBe(true);

    const kept = keepChunkLoadEvent(event);

    expect(kept.exception?.values?.map((e) => [e.type, e.value])).toEqual([
      [CAUGHT_CHUNK_LOAD_ERROR_TYPE, 'Failed to load chunk a.js from module 1'],
      ['TypeError', 'unrelated'],
      [CAUGHT_CHUNK_LOAD_ERROR_TYPE, 'Failed to load chunk b.js from module 2'],
    ]);
    expect(kept.tags).toEqual({ 'error.original_type': 'ChunkLoadError' });
    expect(matchesSentryChunkLoadFilter(kept)).toBe(false);
  });

  it('leaves an event with no ChunkLoadError — or no exception — untouched', () => {
    const typeError: Event = { exception: { values: [{ type: 'TypeError', value: 'x' }] } };
    expect(keepChunkLoadEvent(typeError)).toEqual({
      exception: { values: [{ type: 'TypeError', value: 'x' }] },
    });
    const message: Event = { message: 'no exception' };
    expect(keepChunkLoadEvent(message)).toEqual({ message: 'no exception' });
  });
});

describe('the boundary’s report reaches Sentry under the ID the page shows', () => {
  let received: string[] = [];
  let server: Server;
  let dsn: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    dsn = `http://publickey@127.0.0.1:${port}/1`;
  });

  afterAll(async () => {
    await Sentry.close(2_000);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    received = [];
  });

  /** The SDK's own dedupe and cause-chaining are on: they are what a browser runs. */
  function initSentry(): void {
    Sentry.init({
      dsn,
      defaultIntegrations: false,
      integrations: [Sentry.dedupeIntegration(), Sentry.linkedErrorsIntegration()],
    });
  }

  /** The error events the fake ingest received, parsed out of their envelopes. */
  function receivedEvents(): Event[] {
    const events: Event[] = [];
    for (const envelope of received) {
      const lines = envelope.split('\n');
      for (let i = 1; i < lines.length - 1; i += 1) {
        const header = JSON.parse(lines[i] ?? '{}') as { type?: string };
        if (header.type === 'event') events.push(JSON.parse(lines[i + 1] ?? '{}') as Event);
      }
    }
    return events;
  }

  it('sends a script-load failure under the returned ID, in a shape the ChunkLoadError filter keeps', async () => {
    initSentry();

    const eventId = reportCaughtError(turbopackChunkLoadError(), 'global');
    await Sentry.flush(5_000);

    expect(eventId).toMatch(/^[0-9a-f]{32}$/);
    const events = receivedEvents();
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event?.event_id).toBe(eventId);
    expect(event?.tags).toMatchObject({
      boundary: 'error-boundary:global',
      'error.original_type': 'ChunkLoadError',
    });
    // Both the error and its chained cause arrived, values verbatim, and none of
    // them is the type Sentry's inbound filter drops.
    expect(event?.exception?.values?.map((e) => e.type)).toEqual([
      CAUGHT_CHUNK_LOAD_ERROR_TYPE,
      CAUGHT_CHUNK_LOAD_ERROR_TYPE,
    ]);
    expect(event?.exception?.values?.map((e) => e.value)).toContain(
      'Failed to load chunk /_next/static/chunks/1icqp_l_jcfyv.js from module 9031',
    );
    expect(matchesSentryChunkLoadFilter(event!)).toBe(false);
  }, 30_000);

  it('CONTROL: the same error captured the default way is one Sentry’s filter drops', async () => {
    initSentry();

    Sentry.captureException(turbopackChunkLoadError());
    await Sentry.flush(5_000);

    const [event] = receivedEvents();
    expect(event?.exception?.values?.map((e) => e.type)).toEqual([
      'ChunkLoadError',
      'ChunkLoadError',
    ]);
    expect(matchesSentryChunkLoadFilter(event!)).toBe(true);
  }, 30_000);

  it('a retry that fails the same way answers the ID of the event that went out', async () => {
    initSentry();
    const first = new Error('Failed to load chunk /_next/static/chunks/x.js from module 7');
    first.name = 'ChunkLoadError';
    const again = new Error(first.message);
    again.name = first.name;
    again.stack = first.stack;

    const firstId = reportCaughtError(first, 'app');
    const againId = reportCaughtError(again, 'app');
    // The same instance on a re-render is not reported twice either.
    expect(reportCaughtError(first, 'app')).toBe(firstId);
    await Sentry.flush(5_000);

    expect(againId).toBe(firstId);
    const events = receivedEvents();
    expect(events.map((e) => e.event_id)).toEqual([firstId]);
  }, 30_000);

  it('a different error is a new event with its own ID', async () => {
    initSentry();

    const one = reportCaughtError(new Error('first failure'), 'authed-page');
    const two = reportCaughtError(new Error('second failure'), 'authed-page');
    await Sentry.flush(5_000);

    expect(two).not.toBe(one);
    expect(receivedEvents().map((e) => e.event_id)).toEqual([one, two]);
  }, 30_000);

  it('answers no ID when Sentry is off, so the page shows no reference', async () => {
    await Sentry.close(2_000);

    expect(reportCaughtError(new Error('nobody is listening'), 'global')).toBeUndefined();
  });
});
