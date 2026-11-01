import { createHash } from 'node:crypto';

import type { PublicAddressKind } from '@/generated/prisma/client';

// THE §8 RESERVATION — what a hostname leaves behind when its workspace renames,
// releases or deletes it. Bug MOTIR-4366; expiring since §8 Amendment 3
// (Story MOTIR-4528).
//
// ⚠️ A RESERVATION EXPIRES. §8 first decided a subdomain was never released,
// and this file was written to hold names permanently. Amendment 3 replaced that:
// a label held under 24 hours returns to the pool at once, and one held longer
// is reserved for 90 days (`lib/publicAddresses/nameHold.ts` is the rule). The
// history below is kept because the hash's reasoning still rests on it.
//
// `docs/decisions/public-tenant-addresses.md` §8 originally decided that a
// subdomain is never released. MOTIR-4209 implemented that with the `public_address.hostname`
// unique index alone — "a retired label keeps its row, the row keeps the name" —
// which holds for the case §8 was thinking about (a RENAME, where the workspace
// survives) and does not hold for the case it never asked about (the workspace
// itself going away). `public_address.workspace_id` is `ON DELETE CASCADE`, so a
// workspace delete takes the rows, and with them the reservation.
//
// The delete is not an admin curiosity: `accountErasureSweepService` routes a
// sole-membership workspace through `workspacesService.deleteWorkspaceForErasure` on a
// scheduled job, discharging a GDPR erasure request. So the release happened
// with nobody deciding it, and the first evidence would have been a stranger's
// roadmap at an address someone's README still points at.
//
// ── WHY A HASH, AND NOT THE HOSTNAME ───────────────────────────────────────
//
// The two obligations meet inside one row and pull opposite ways: §8 wants the
// name held (for 90 days now, once for good), and Article 17 wants the personal
// data GONE. A hostname
// can itself be the personal datum — `jane-smith.<base>` — so retaining the
// literal string would be retaining exactly what the erasure was asked to
// remove.
//
// A one-way hash is what separates the two. The reservation never has to be
// READ BACK; it only has to be TESTED against a candidate somebody else
// supplies, which is the single operation §8 needs. So we keep the answer to
// "is this name taken?" and not the name.
//
// ⚠️ NO PEPPER, AND THAT IS A DECISION RATHER THAN AN OMISSION. A keyed hash
// would resist an offline dictionary attack better, and it would also mean the
// entire namespace silently reopens the day the key is lost or rotated — a
// reservation whose promise is to hold a name until a date is the wrong place
// for a rotatable secret. The residual is named rather than hidden: someone holding a
// database dump can confirm a hostname they already guessed. That is accepted
// because these hostnames were SERVED ON THE PUBLIC INTERNET by the person who
// chose them; the dump tells an attacker nothing the DNS did not.
//
// The prefix is domain separation, and it is versioned: changing the transform
// means every stored digest stops matching, so a `v2` would have to be a
// migration that re-derives from data this table deliberately does not keep —
// i.e. it is not possible, and the `v1` is there to make that obvious rather
// than to promise an upgrade path.
const RESERVATION_HASH_PREFIX = 'motir:public-hostname-reservation:v1:';

/**
 * Strip every trailing dot, in ONE linear pass.
 *
 * ⚠️ NOT `replace(/\.+$/, '')`, which is what this was and what CodeQL's
 * `js/polynomial-redos` flagged at HIGH on the pull request. An anchored `\.+`
 * has no way to fail early: the engine retries the quantifier from every
 * starting offset, so a hostname of many dots costs O(n²). The two existing
 * `/\.+$/` sites in this tree are not equivalent —`tenantBaseDomain` normalises
 * a value read from `process.env`, which is operator configuration and not
 * reachable from a request — but THIS one takes a hostname composed from a
 * label a claimant typed, so the taint path is real and the alert is right.
 *
 * A length bound would also close it and is the worse fix: it makes the cost
 * acceptable rather than removing it, and it puts a second, silent opinion
 * about how long a hostname may be next to the one the label grammar already
 * enforces.
 */
function stripTrailingDots(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 46 /* '.' */) end -= 1;
  return value.slice(0, end);
}

/**
 * The digest a hostname is reserved under.
 *
 * Normalises the way `normaliseCustomHostname` and `tenantBaseDomain` both do —
 * trimmed, lowercased, no trailing dot — so a reservation written from a stored
 * row and a check run against a freshly composed `<label>.<base>` land on the
 * same digest.
 */
export function hostnameReservationHash(hostname: string): string {
  const normalised = stripTrailingDots(hostname.trim().toLowerCase());
  return createHash('sha256').update(`${RESERVATION_HASH_PREFIX}${normalised}`).digest('hex');
}

/**
 * Which address kinds leave a reservation behind — the workspace subdomain and
 * every label it has retired.
 *
 * ⚠️ A `custom_domain` DELIBERATELY DOES NOT, and that is the one judgement in
 * this module. §8's never-released rule is about MOTIR'S OWN namespace: we hand
 * out `<label>.<base>` from a space we own, so releasing a label lets a stranger
 * inherit somebody's inbound links. A customer domain is the CUSTOMER's
 * property — `docs.acme.com` is theirs whatever happens to their Motir account —
 * and reserving it at all would lock the rightful owner out of connecting
 * their own domain again. Holding a name we do not own is not a protection, it
 * is a hostage.
 *
 * ⚠️ AND THAT REASONING IS WHAT AMENDMENT 2 READS THIS RULE BY
 * (`docs/decisions/public-tenant-addresses.md` §8, Story MOTIR-4451). The
 * sentence above says never-released is about who may take the name NEXT — not
 * about who must keep SERVING it — so a workspace may RELEASE its own subdomain:
 * this predicate chooses the kinds that go, and each is held by digest in the
 * same transaction as the delete for as long as §8 Amendment 3's hold says.
 * The judgement here is unchanged and is now load-bearing in a second place: a
 * release must select its rows through THIS function and never through a
 * hand-written kind list, or it takes a customer's own domain with it.
 */
export function reservesItsHostname(kind: PublicAddressKind): boolean {
  return kind === 'workspace_subdomain' || kind === 'workspace_subdomain_alias';
}
