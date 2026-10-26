import 'server-only';

import { MOTIR_AI_CONTAINER_URL_ENV_VAR, motirAiContainerBaseUrl } from './motirAiClient';
import { MotirAiConfigError } from './errors';

// THE INDEX CONTAINER'S motir-ai ADDRESS, PREFLIGHTED (MOTIR-4518) — the guard
// that would have caught a code-complete fleet running unreachable for two weeks.
//
// The fleet already had a boot preflight, and it asked the wrong question. It
// verified that the IMAGE is pullable, which was the fault of the day
// (MOTIR-1980 · MOTIR-2006 · MOTIR-2030) and is still worth asking daily. It has
// nothing to say about whether the booted container can REACH anything, and
// reachability is where the next outage was: motir-core handed the container its
// own `MOTIR_AI_URL`, a private 6PN address scoped to motir-core's organization,
// and the container runs in a different one. Nineteen minutes of graph build,
// then `getaddrinfo ENOTFOUND motir-ai.internal`, then an exit the ledger read as
// success. Every gating signal was green because none of them was looking here.
//
// ⚠️ WHAT motir-core CAN AND CANNOT ESTABLISH FROM WHERE IT STANDS — stated
// rather than papered over, because the card asks for the check OR for the
// reason it cannot be made.
//
// It CANNOT prove reachability from the fleet's organization. This process runs
// inside `moooon`, on `moooon`'s resolver and `moooon`'s private network; a fetch
// that succeeds from here is evidence about here. Proving the fleet's view
// requires being in the fleet — which is a container, i.e. the very thing whose
// boot this preflight is trying to gate. So a probe alone would be a check that
// passes in exactly the state it exists to catch, which is worse than no check.
//
// It CAN establish the two things that actually decide it:
//
//   1. STRUCTURAL — a PRIVATE, network-scoped address can NEVER resolve from
//      another organization's network. That is a property of the addressing
//      scheme, not an observation, so it needs no probe, cannot flake, and is a
//      DEFINITE verdict. It is also the whole of the MOTIR-4518 defect: the
//      address handed over was `http://motir-ai.internal:8080`, and no amount of
//      probing from inside `moooon` could ever have reported that as broken —
//      from here it resolves perfectly.
//   2. LIVENESS — the configured address answers at all. From `moooon` this is
//      necessary and not sufficient, and it is reported as such: a failure to
//      reach it is `indeterminate`, never a claim, in the same discipline
//      `verifyFleetBootable` applies to a registry it cannot reach.
//
// So the loud arms are the ones motir-core is entitled to be loud about — unset,
// and structurally unreachable — and the soft arm is the one it is not.

/** What the preflight concluded about the address the index container is given. */
export type ContainerAiAddressVerdict =
  /** Nothing to check — this deployment runs no index containers. */
  | { verdict: 'not_applicable'; detail: string }
  /** The variable is unset. This deployment indexes and cannot tell a container
   *  where motir-ai is; every boot throws in the deployment gate. LOUD. */
  | { verdict: 'unconfigured'; detail: string }
  /** DEFINITE: the configured address cannot work for a container, whatever this
   *  process sees. Two shapes share the arm because they share the disposition —
   *  an address that is PRIVATE/network-scoped (the MOTIR-4518 defect) and one
   *  that is not a usable absolute `http(s)` URL at all. Both are loud, both are
   *  fixed by setting the variable correctly, and neither is a claim a probe
   *  could have made. */
  | { verdict: 'private_address'; address: string; detail: string }
  /** The address is publicly-formed AND answered this process. */
  | { verdict: 'reachable'; address: string; status: number }
  /** Publicly-formed, but this process could not get an answer. A statement
   *  about this probe, never about the address. */
  | { verdict: 'indeterminate'; address: string; detail: string };

/**
 * Host suffixes and address literals that are PRIVATE by construction — resolved
 * only for machines on the same private network as the app they name, and
 * therefore unusable by a container in another organization.
 *
 * ⚠️ IT IS A SUFFIX LIST, AND THE LIST IS NOT THE TEST — the QUESTION is: can a
 * machine OUTSIDE this deployment's own private network resolve this name? Add a
 * form when a deployment gains one; do not read the absence of a fifth entry as a
 * verdict that an address is public. `unspecified` and loopback are here because
 * they are the same mistake in its most local form.
 */
const PRIVATE_HOST_SUFFIXES = [
  // Fly 6PN — the form MOTIR-4518 was actually handed.
  '.internal',
  // Fly Flycast — org-scoped like 6PN; the gateway's only address (MOTIR-7656).
  '.flycast',
  // Kubernetes' in-cluster DNS, for the deployment shape that would replace it.
  '.svc.cluster.local',
  '.cluster.local',
  // A local process is not a fleet-reachable address either.
  'localhost',
] as const;

/** IPv6 ULA prefixes used for private-network addressing (Fly 6PN is `fdaa:`). */
const PRIVATE_IP_PREFIXES = ['fd', 'fc', '127.', '10.', '192.168.', '::1'] as const;

/**
 * Is this host PRIVATE — resolvable only from inside one deployment's own
 * network? Pure, so it is a unit test rather than a network call.
 */
export function isPrivateNetworkHost(host: string): boolean {
  const bare = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (PRIVATE_HOST_SUFFIXES.some((s) => bare === s.replace(/^\./, '') || bare.endsWith(s))) {
    return true;
  }
  return PRIVATE_IP_PREFIXES.some((p) => bare.startsWith(p));
}

/**
 * The STRUCTURAL half, with no network access: what can be decided about the
 * configured address from its shape alone.
 *
 * Returns `null` when the address is well-formed and public — i.e. when there is
 * a liveness probe left to make. Every other answer is terminal.
 */
export function classifyContainerAiAddress(
  raw: string | undefined,
): Extract<ContainerAiAddressVerdict, { verdict: 'unconfigured' | 'private_address' }> | null {
  if (!raw) {
    return {
      verdict: 'unconfigured',
      detail:
        `${MOTIR_AI_CONTAINER_URL_ENV_VAR} is not set, so no index container can be told where ` +
        `motir-ai is. There is deliberately no fallback to MOTIR_AI_URL: that address is ` +
        `motir-core's own, is private in production, and does not resolve from the fleet's ` +
        `organization (MOTIR-4518).`,
    };
  }
  let url: URL | null = null;
  try {
    url = new URL(raw);
  } catch {
    // Left null — handled with the other malformed shapes below.
  }
  // ⚠️ `new URL()` NOT THROWING IS NOT A HOST. `new URL('motir-ai:8080')` parses
  // happily, as a scheme of `motir-ai:` with a path of `8080` and an EMPTY
  // hostname — so a bare-authority typo passes a try/catch and then hands the
  // container something no `fetch` can resolve. The protocol is checked for the
  // same reason: this value is concatenated with a path and fetched.
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname) {
    return {
      verdict: 'private_address',
      address: raw,
      detail:
        `${MOTIR_AI_CONTAINER_URL_ENV_VAR} is not an absolute http(s) URL with a host, so no ` +
        `container can fetch anything from it.`,
    };
  }
  if (isPrivateNetworkHost(url.hostname)) {
    return {
      verdict: 'private_address',
      address: raw,
      detail:
        `${url.hostname} is a PRIVATE, network-scoped address: it resolves only for machines on ` +
        `this deployment's own private network, and an index container runs in the fleet's ` +
        `organization instead. It will answer with NXDOMAIN there however well it resolves from ` +
        `motir-core (MOTIR-4518).`,
    };
  }
  return null;
}

/** The path the probe asks for. motir-ai serves it unauthenticated. */
const HEALTH_PATH = '/health';
/** Short: this runs inside a daily health check, not a request. */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * CAN THE ADDRESS THIS DEPLOYMENT WOULD HAND AN INDEX CONTAINER ACTUALLY WORK?
 *
 * NEVER THROWS — the caller is a health check, and every "no" is more useful as a
 * sentence than as a stack trace, exactly as its two image-pull siblings decided.
 *
 * `isConfigured` is injected rather than imported so this module stays free of
 * the orchestrator (and therefore of any provider), and so the test can drive
 * both arms without an environment.
 */
export async function verifyIndexContainerAiAddress(args: {
  isConfigured: boolean;
  fetchImpl?: typeof fetch;
}): Promise<ContainerAiAddressVerdict> {
  if (!args.isConfigured) {
    return {
      verdict: 'not_applicable',
      detail: 'this deployment is not configured to run index containers',
    };
  }

  const structural = classifyContainerAiAddress(process.env[MOTIR_AI_CONTAINER_URL_ENV_VAR]);
  if (structural) return structural;

  // Past the structural gate the accessor cannot throw; it is still called rather
  // than re-reading the variable, so the probe normalises the address exactly the
  // way the dispatcher does.
  let address: string;
  try {
    address = motirAiContainerBaseUrl();
  } catch (err) {
    /* c8 ignore next 5 -- unreachable: `classifyContainerAiAddress` returns
       `unconfigured` for every input this accessor throws on. Kept so a future
       widening of the accessor's refusals cannot turn a health check into a
       crash. */
    return {
      verdict: 'unconfigured',
      detail: err instanceof MotirAiConfigError ? err.message : String(err),
    };
  }

  const doFetch = args.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${address}${HEALTH_PATH}`, {
      method: 'GET',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      return {
        verdict: 'indeterminate',
        address,
        detail: `${address}${HEALTH_PATH} answered ${res.status}.`,
      };
    }
    return { verdict: 'reachable', address, status: res.status };
  } catch (err) {
    // A transport failure is a statement about this probe's network, not about
    // the address — the same refusal to over-claim the image probe makes.
    return {
      verdict: 'indeterminate',
      address,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
