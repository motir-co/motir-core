// How long an answer from `GET /api/public/hosts/{host}` may be cached —
// Story MOTIR-4528 · Subtask MOTIR-9511, ADR §8 Amendment 3 rule 2.
//
// Rule 2 says a renamed or released name stops answering AT ONCE. The database
// side holds that exactly: the rename or release deletes the row in the same
// transaction. What can still serve the old name afterwards is a CACHED answer,
// so the bound is a promise this file states and the route keeps:
//
//   a retired name can keep answering for at most HOST_CONTRACT_MAX_AGE_SECONDS,
//   and only from a cache that honours `max-age`.
//
// ⚠️ NO `stale-while-revalidate`. A revalidate window lets a cache serve the
// stale answer while it refetches, which is exactly a retired name answering
// past the bound. The previous header (`max-age=60, stale-while-revalidate=300`)
// let it answer for up to six minutes and said so nowhere.
//
// ⚠️ A 404 IS NEVER CACHED. A name freed by a release can be claimed seconds
// later; a cached refusal would hide the new owner's address for the length of
// the cache, which is rule 2's failure in the other direction.
//
// The consumer (`motir-marketing`'s host router) must not add a longer cache of
// its own on top of this one — two caches in series add their bounds.

/** The one place the bound is written. */
export const HOST_CONTRACT_MAX_AGE_SECONDS = 30;

/** Sent with every 200 resolution. */
export const HOST_CONTRACT_CACHE_CONTROL = `public, max-age=${HOST_CONTRACT_MAX_AGE_SECONDS}`;

/**
 * Sent with a 200 to the EDGE's bearer (ADR MOTIR-9521 §3): the answer carries
 * an upstream, so no shared cache may hold it — the same bound, kept private.
 */
export const HOST_CONTRACT_CREDENTIALED_CACHE_CONTROL = `private, max-age=${HOST_CONTRACT_MAX_AGE_SECONDS}`;

/** Sent with every 404, so a refusal is never served for a name claimed since. */
export const NOT_FOUND_CACHE_CONTROL = 'no-store';
