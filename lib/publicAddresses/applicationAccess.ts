// WHO MAY OPEN AN APPLICATION, as the host contract reads it — Story MOTIR-4533
// · MOTIR-9819.
//
// The member gate (MOTIR-5779) is bound to the `motir.site` host: its sign-in
// handshake returns there and its `__Host-` cookie is set there. A customer
// domain is a second door to the same application, and neither decision
// (MOTIR-9790, MOTIR-9521 "What this does NOT decide") records the gate on a
// customer host. So a members-only application is REFUSED on one: the contract
// answers `members_only_application`, never the application.
//
// ⚠️ FAIL CLOSED. The access setting arrives with "Who can open a built app"
// (MOTIR-9817); until it does, and whenever it is absent or not a value this
// file knows, the application is members only. Only an explicit `public` opens
// a customer host.

export type ApplicationAccess = 'public' | 'members_only';

/** The access an application's stored setting grants, failing closed. */
export function applicationAccessOf(stored: unknown): ApplicationAccess {
  return stored === 'public' ? 'public' : 'members_only';
}
