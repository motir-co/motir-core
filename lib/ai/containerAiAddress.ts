import 'server-only';

// WHICH HOSTS A FLEET MACHINE CANNOT USE — the structural half of the address
// checks, decided from an address's shape with no network access.
//
// The module began as the index container's motir-ai address preflight
// (MOTIR-4518): motir-core handed that container its own private 6PN address,
// which resolves perfectly from motir-core and never from the fleet's
// organization, so no probe from here could have reported it broken. A PRIVATE,
// network-scoped address can never resolve from another network — a property of
// the addressing scheme, not an observation — and that half outlived the index
// container (MOTIR-12037 retired the container, its address variable and its
// preflight). It is what `fleetOrigins.ts` asks of every origin a fleet machine is
// handed, and what `runKeyClient.ts` asks of the gateway's run lane.

/**
 * DNS suffixes a fleet machine cannot use: names resolved only on the private
 * network of the app they name, and names Motir does not publish.
 *
 * ⚠️ IT IS A SUFFIX LIST, AND THE LIST IS NOT THE TEST — the QUESTION is: can a
 * machine OUTSIDE this deployment's own private network use this name as an
 * address Motir publishes? Add a form when a deployment gains one; do not read
 * the absence of an entry as a verdict that an address is public. Since
 * MOTIR-10749 it also covers a `.fly.dev` name (public, but not an address Motir
 * publishes since the move to AWS: an origin on it points at Fly) and, through
 * `AWS_INTERNAL_LOAD_BALANCER`, AWS internal load balancer names. Address
 * LITERALS are judged by their numeric range below, never by a string prefix.
 */
const PRIVATE_HOST_SUFFIXES = [
  // Fly 6PN — the form MOTIR-4518 was actually handed. Also EC2's private DNS
  // (`ip-10-0-1-5.ec2.internal`).
  '.internal',
  // Fly Flycast — org-scoped like 6PN; the gateway's only address (MOTIR-7656).
  '.flycast',
  // Fly's own app names — not an origin Motir publishes (MOTIR-9714).
  '.fly.dev',
  // Kubernetes' in-cluster DNS, for the deployment shape that would replace it.
  '.svc.cluster.local',
  '.cluster.local',
  // A local process is not a fleet-reachable address either (RFC 6761).
  '.localhost',
] as const;

/**
 * An AWS INTERNAL load balancer's DNS name — `internal-<name>-<id>.<region>.elb.amazonaws.com`
 * (or the region-less legacy form). It resolves publicly, to PRIVATE addresses
 * in the load balancer's VPC, so no fleet machine elsewhere can reach it. A
 * public load balancer's name carries no `internal-` prefix and is not refused
 * here: it is reachable, and an unpublished origin is the per-fleet-kind test's
 * call, not this classifier's.
 */
const AWS_INTERNAL_LOAD_BALANCER = /^internal-[a-z0-9-]+\.(?:[a-z0-9-]+\.)?elb\.amazonaws\.com$/;

/** Private, shared, loopback, link-local and "this network" IPv4 ranges, as [first octet, second-octet range]. */
const PRIVATE_IPV4_RANGES: readonly (readonly [number, number, number])[] = [
  [0, 0, 255], // 0.0.0.0/8 — "this network"
  [10, 0, 255], // 10.0.0.0/8
  [100, 64, 127], // 100.64.0.0/10 — shared address space (CGNAT)
  [127, 0, 255], // 127.0.0.0/8 — loopback
  [169, 254, 254], // 169.254.0.0/16 — link-local, the instance metadata address
  [172, 16, 31], // 172.16.0.0/12
  [192, 168, 168], // 192.168.0.0/16
];

/** The four octets of a dotted-decimal IPv4 literal, or null when `host` is not one. */
function ipv4Octets(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null;
  const octets = parts.map(Number);
  return octets.every((o) => o <= 255) ? octets : null;
}

function isPrivateIpv4(octets: readonly number[]): boolean {
  const [a, b] = octets as [number, number];
  return PRIVATE_IPV4_RANGES.some(([first, low, high]) => a === first && b >= low && b <= high);
}

/**
 * The IPv4 address inside an IPv4-MAPPED (`::ffff:a.b.c.d`) or IPv4-COMPATIBLE
 * (`::a.b.c.d`) IPv6 literal, in its dotted or its hex form (`::ffff:a00:1`,
 * which is how `new URL` writes it) — or null. Without it, `[::ffff:10.0.0.1]`
 * would pass as a public host.
 */
function embeddedIpv4(host: string): number[] | null {
  const compact = host.replace(/^(?:0{1,4}:){5}ffff:/, '::ffff:').replace(/^(?:0{1,4}:){6}/, '::');
  const m = /^::(?:ffff:)?(?:(\d{1,3}(?:\.\d{1,3}){3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(
    compact,
  );
  if (!m) return null;
  if (m[1]) return ipv4Octets(m[1]);
  const hi = parseInt(m[2]!, 16);
  const lo = parseInt(m[3]!, 16);
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

/**
 * A private IPv6 literal: unspecified (`::`), loopback (`::1`), unique local
 * (fc00::/7, Fly 6PN is `fdaa:`), link-local (fe80::/10), and an IPv4 address
 * in a private range embedded in an IPv4-mapped or -compatible literal.
 */
function isPrivateIpv6(host: string): boolean {
  if (host === '::' || host === '::1') return true;
  const embedded = embeddedIpv4(host);
  if (embedded) return isPrivateIpv4(embedded);
  const first = host.split(':')[0] ?? '';
  if (!/^[0-9a-f]{1,4}$/.test(first)) return false;
  const group = parseInt(first.padStart(4, '0'), 16);
  return (group & 0xfe00) === 0xfc00 || (group & 0xffc0) === 0xfe80;
}

/**
 * Is this host one a fleet machine cannot use — resolvable only from inside one
 * deployment's own network, or a name Motir does not publish? A literal is
 * judged by its numeric range, a name by its DNS suffix. Pure, so it is a unit
 * test rather than a network call.
 */
export function isPrivateNetworkHost(host: string): boolean {
  const bare = host
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (bare.includes(':')) return isPrivateIpv6(bare);
  const octets = ipv4Octets(bare);
  if (octets) return isPrivateIpv4(octets);
  if (PRIVATE_HOST_SUFFIXES.some((s) => bare === s.slice(1) || bare.endsWith(s))) return true;
  return AWS_INTERNAL_LOAD_BALANCER.test(bare);
}
