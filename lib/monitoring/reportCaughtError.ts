'use client';

import { useEffect, useSyncExternalStore } from 'react';
import * as Sentry from '@sentry/nextjs';
import type { Event } from '@sentry/nextjs';

// Report an error that one of motir-core's ERROR BOUNDARIES caught
// (MOTIR-6855 · Bug MOTIR-6776), and hand back the Sentry EVENT ID the error
// page shows as its reference when the error has no digest (MOTIR-11243).
//
// ⚠️ A CAUGHT ERROR NO LONGER REACHES SENTRY ON ITS OWN. Before these boundaries
// existed a server render failure reached Next's `onUncaughtError`, which
// Sentry's global handler reports. Once `error.tsx` catches it, Next routes it
// to `onCaughtError` instead, which in a production build only
// `console.error`s it (`next/dist/client/react-client-callbacks/
// error-boundary-callbacks.js`) — and this app does not capture the console.
// Without this call the boundary would TRADE a visible crash for a silent one,
// which is worse than the crash.
//
// The `digest` tag is what matches the browser event to its server twin: a
// Server Component error reaches the client with its message stripped and a
// digest in its place, and `instrumentation.ts`'s `onRequestError` has already
// reported the real server exception.
//
// ⚠️ THE EVENT ID IS A PROMISE TO SUPPORT, SO THE EVENT HAS TO ARRIVE
// (MOTIR-11243). A browser-side error has no digest, so the page shows the ID of
// the event this module sends. Three things would make that ID point at nothing,
// and each is handled here rather than left to the SDK's defaults:
//
//   1. SENTRY'S OWN INBOUND FILTER. Every Sentry project ships the
//      "Filter out ChunkLoadError(s)" inbound filter switched ON, and Relay
//      drops a matching event at ingest — after the browser has sent it and been
//      given an ID. The filter matches an exception whose TYPE is
//      `ChunkLoadError` and whose value is `Failed to load chunk *` (Turbopack)
//      or `Loading chunk *` (webpack): getsentry/sentry
//      `src/sentry/ingest/inbound_filters.py`, `_chunk_load_error_filter`. That
//      is exactly the error a tab left open across a deploy throws (MOTIR-11241),
//      and it is why the 2026-11-13 22:11 error page left no event behind. So the
//      boundary's report renames that type (`keepChunkLoadEvent`). Only the
//      boundary's report: a chunk failure nobody was shown stays filtered, which
//      is the noise the filter exists to remove.
//   2. THE SDK'S DEDUPE. `dedupeIntegration` drops an event identical (type,
//      value, stack, fingerprint) to the one before it, and still hands the
//      caller an ID. A Retry that fails the same way throws a NEW error instance
//      with the same signature, so its report would be dropped and its ID would
//      be one Sentry never saw. Such a repeat is not re-sent: it is answered with
//      the ID of the report that did go out, which is the same failure.
//   3. SENTRY BEING OFF (no DSN — local dev, a self-hosted build). Then there is
//      no event and no ID, and the page shows no reference, as before.

/** Which boundary caught it — the depth it failed at (design MOTIR-6854's states 1–3). */
export type ErrorBoundaryName = 'authed-page' | 'app' | 'global';

type DigestError = Error & { digest?: string };

/** The type the bundlers give a script that failed to load (Turbopack and webpack alike). */
export const CHUNK_LOAD_ERROR_TYPE = 'ChunkLoadError';

/**
 * What a boundary-caught chunk-load error is reported as: still searchable as
 * `*ChunkLoadError`, and no longer the exact type Sentry's inbound filter drops.
 */
export const CAUGHT_CHUNK_LOAD_ERROR_TYPE = 'CaughtChunkLoadError';

/**
 * An event processor for the boundary's report: renames every `ChunkLoadError`
 * exception in it (the error and any chained `cause`) so Sentry's default
 * ChunkLoadError inbound filter does not drop the event whose ID the page shows.
 * The value — which chunk, loaded from which module — is kept verbatim.
 */
export function keepChunkLoadEvent(event: Event): Event {
  const values = event.exception?.values;
  if (!values?.some((exception) => exception.type === CHUNK_LOAD_ERROR_TYPE)) return event;
  for (const exception of values) {
    if (exception.type === CHUNK_LOAD_ERROR_TYPE) exception.type = CAUGHT_CHUNK_LOAD_ERROR_TYPE;
  }
  event.tags = { ...event.tags, 'error.original_type': CHUNK_LOAD_ERROR_TYPE };
  return event;
}

// Exactly once per error INSTANCE, not once per effect run: a re-mount (React's
// dev double-invoke, a boundary re-rendering the same error) must not file the
// same failure twice — it is answered with the ID it was given the first time.
// A retry that fails again throws a NEW instance, which is a new failure and is
// reported (unless it is the dedupe repeat in point 2 above).
const eventIds = new WeakMap<Error, string | undefined>();

/** The last report sent, by the signature the SDK's dedupe compares. */
let lastReport: { signature: string; eventId: string } | undefined;

function signatureOf(error: DigestError): string {
  return JSON.stringify([error.name, error.message, error.stack ?? '', error.digest ?? '']);
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Report `error` to Sentry once, and return the ID of the Sentry event that
 * carries it — `undefined` when Sentry is not enabled in this browser.
 */
export function reportCaughtError(
  error: DigestError,
  boundary: ErrorBoundaryName,
): string | undefined {
  if (eventIds.has(error)) return eventIds.get(error);

  let eventId: string | undefined;
  const signature = signatureOf(error);
  if (lastReport?.signature === signature) {
    eventId = lastReport.eventId;
  } else {
    // `captureException` answers an ID even with no client at all, so the ID is
    // only trusted when an enabled client exists to send the event.
    const enabled = Sentry.isEnabled();
    const id = Sentry.withScope((scope) => {
      scope.setTags({
        boundary: `error-boundary:${boundary}`,
        ...(error.digest ? { digest: error.digest } : {}),
      });
      scope.addEventProcessor(keepChunkLoadEvent);
      return Sentry.captureException(error);
    });
    if (enabled) {
      eventId = id;
      lastReport = { signature, eventId: id };
    }
  }

  eventIds.set(error, eventId);
  for (const listener of listeners) listener();
  return eventId;
}

/**
 * Report `error` once, after the boundary has committed its fallback, and
 * return the Sentry event ID once it exists. It is `undefined` on the server
 * render and the first client render (the report is an effect), and stays
 * `undefined` when Sentry is not enabled.
 */
export function useReportCaughtError(
  error: DigestError,
  boundary: ErrorBoundaryName,
): string | undefined {
  useEffect(() => {
    reportCaughtError(error, boundary);
  }, [error, boundary]);
  return useSyncExternalStore(
    subscribe,
    () => eventIds.get(error),
    () => undefined,
  );
}
