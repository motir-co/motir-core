import {
  type CertificateProvider,
  type CertificateState,
} from '@/lib/publicAddresses/certificateProvider';
import { type DnsResolver, nodeDnsResolver } from '@/lib/publicAddresses/dnsResolver';
import { isE2EProdHarness } from '@/lib/e2eProdHarness';

// THE PROVIDER FACTORY — Story MOTIR-3878 · Subtask MOTIR-4216.
//
// One place chooses the bindings for the two systems this story cannot reach
// from a test: public DNS and Fly's certificates API.
//
// ⚠️ WHY A TEST SEAM EXISTS AT ALL, since one is a cost. The customer-domain
// lifecycle's whole value is the walk `unverified → verifying →
// pending_certificate → issued`, and every step of it crosses one of those two
// systems. An E2E lane with no seam can reach `unverified` and nothing else, so
// it would assert the states it CAN reach and silently not the ones it cannot —
// a suite that passes while proving nothing about the feature. The alternative,
// stubbing the API from inside the browser, tests the stub.
//
// ⚠️ AND WHY IT CANNOT ARM IN PRODUCTION. A flag that binds a certificate
// provider which reports `issued` without asking anyone would, in production,
// mark customer domains live that have no certificate — visitors would meet a
// TLS error on an address the settings pane calls healthy. So the flag is read
// at call time AND refused outright when `NODE_ENV === 'production'`, and a test
// asserts the refusal. An env var is a thing an operator can set by accident;
// this is the guard that makes that harmless.

const FAKE_FLAG = 'MOTIR_E2E_FAKE_PUBLIC_ADDRESS_PROVIDERS';

/**
 * Are the in-memory bindings armed? Never true in a REAL production build.
 *
 * ⚠️ THE SECOND CONDITION IS `isE2EProdHarness()`, AND IT IS NOT A WEAKENING —
 * added by MOTIR-4225, which found the guard shut the door on the only lane that
 * needs it. The acceptance and cloud Playwright lanes serve a `next build`, so
 * `NODE_ENV` is `production` there: a raw check makes the flag INERT in exactly
 * the place a browser walk has to reach `issued`, and the walk would then film
 * an unreachable state or assert nothing. `lib/e2eProdHarness.ts` is the seam
 * this repository already uses for that collision — the same one that decides
 * whether a session cookie is `Secure`.
 *
 * The safety property is unchanged in substance: arming the fakes in a real
 * deployment now takes TWO deliberate misconfigurations rather than one, and
 * `E2E_PROD_HARNESS` is set by a Playwright config and by nothing else. The cost
 * of getting it wrong is what the original comment says — customer domains
 * reported live with no certificate — so the bar stays high and stays asserted.
 */
export function usingFakePublicAddressProviders(): boolean {
  if (process.env.NODE_ENV === 'production' && !isE2EProdHarness()) return false;
  return process.env[FAKE_FLAG] === '1';
}

/**
 * The in-memory certificate provider: everything it is asked for is configured
 * and issued, immediately.
 *
 * It models the HAPPY path only, deliberately. A fake that could also fail would
 * need a way to be told which way to behave, and that channel becomes a second
 * thing the lane has to configure and keep true. The failure arms are proved at
 * the SERVICE tier with a stubbed port, where a test can hand the service any
 * outcome directly; the lane's job is to prove the walk reaches `issued`.
 */
const fakeCertificateProvider: CertificateProvider = {
  async request(hostname: string): Promise<CertificateState> {
    return state(hostname);
  },
  async check(hostname: string): Promise<CertificateState> {
    return state(hostname);
  },
  async remove(): Promise<void> {
    // Nothing to remove — and it must not throw, because the real one is
    // documented not to throw when the hostname is already absent.
  },
};

function state(hostname: string): CertificateState {
  return {
    hostname,
    configured: !fakeUnpointed.has(hostname.toLowerCase()),
    issued: true,
    dnsRequirements: [],
    checkedAt: new Date(),
    // The fake has no certificate to read a date from, and inventing one is
    // exactly what the port forbids.
    expiresAt: null,
  };
}

/**
 * Hostnames the fake provider reports as no longer pointed at Motir
 * (`configured: false`, still `issued`) — the reading the sweep turns into
 * `pointing_lost` (MOTIR-9526).
 *
 * ⚠️ THE ONE FAILURE THE FAKE CAN BE TOLD, AND WHY IT EARNED A CHANNEL. The
 * happy-path rule above still holds for issuance; this is not an issuance
 * failure but the customer's record going away, and the acceptance walk
 * (MOTIR-9533) has to show the pane's banner for it from a browser. The spec
 * lives in another process, so it flips this through the lane-only
 * `/api/_test/public-addresses/fakes` door — gated like every `_test` door, and
 * inert anyway outside the fakes.
 */
const fakeUnpointed = new Set<string>();

export function setFakePointing(hostname: string, pointed: boolean): void {
  const name = hostname.toLowerCase();
  if (pointed) fakeUnpointed.delete(name);
  else fakeUnpointed.add(name);
}

/**
 * The in-memory resolver: it answers whatever token it is told about.
 *
 * The lane seeds it through {@link seedFakeTxt} as the address is created, so
 * the verify step reads back the token the service just minted — which is what
 * the real flow does, with the customer in between.
 */
const fakeTxt = new Map<string, string[]>();

export function seedFakeTxt(name: string, values: string[]): void {
  fakeTxt.set(name, values);
}

export function resetFakeTxt(): void {
  fakeTxt.clear();
  fakeUnpointed.clear();
}

const fakeDnsResolver: DnsResolver = {
  async resolveTxt(name: string): Promise<string[]> {
    return fakeTxt.get(name) ?? [];
  },
};

/** The certificate provider this deployment should use. */
export async function certificateProvider(): Promise<CertificateProvider> {
  if (usingFakePublicAddressProviders()) return fakeCertificateProvider;
  // Lazily imported so a deployment using the fakes — and every unit test —
  // never loads the Fly adapter, and so the adapter's config is read only on the
  // path that actually calls Fly.
  const { flyCertificateProvider } =
    await import('@/lib/publicAddresses/adapters/fly/flyCertificates');
  return flyCertificateProvider;
}

/**
 * Is a certificate provider WIRED on this deployment?
 *
 * Asked here rather than of the adapter, because "is this configured?" is a
 * question about the SELECTION, not about Fly: under the E2E fakes the answer is
 * yes and no Fly variable is set at all. The sweep (MOTIR-4219) calls this to
 * decide whether to run — and it was reaching into the adapter directly until
 * the port's boundary guard caught it, which is precisely the leak that guard
 * exists for.
 */
export async function certificatesConfigured(): Promise<boolean> {
  if (usingFakePublicAddressProviders()) return true;
  const { isFlyCertsConfigured } =
    await import('@/lib/publicAddresses/adapters/fly/flyCertificates');
  return isFlyCertsConfigured();
}

/** The DNS resolver this deployment should use. */
export function dnsResolver(): DnsResolver {
  return usingFakePublicAddressProviders() ? fakeDnsResolver : nodeDnsResolver;
}
