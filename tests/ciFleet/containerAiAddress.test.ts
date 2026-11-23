import { describe, expect, it } from 'vitest';
import { isPrivateNetworkHost } from '@/lib/ai/containerAiAddress';

// WHICH HOSTS A FLEET MACHINE CANNOT USE — the structural classifier that
// outlived the index container's motir-ai address preflight (MOTIR-4518). The
// preflight, its accessor and their cases left with the container (MOTIR-12037);
// these are the classifier's own cases, kept as they were. `fleetOrigins.ts` and
// `runKeyClient.ts` ask it of every origin a fleet machine is handed.

describe('isPrivateNetworkHost — the structural half, decided without a network', () => {
  it.each([
    ['motir-ai.internal', true],
    // Flycast is org-scoped like 6PN (MOTIR-7656).
    ['motir-gateway.flycast', true],
    ['MOTIR-AI.INTERNAL', true],
    ['some.service.svc.cluster.local', true],
    ['localhost', true],
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['192.168.0.9', true],
    ['fdaa:0:1::3', true],
    ['[fdaa:0:1::3]', true],
    ['::1', true],
    // The bare suffix, with no label in front of it — a host that IS the
    // private zone rather than one inside it.
    ['internal', true],
    // A Fly app name is not an origin Motir publishes since the move to AWS
    // (MOTIR-9714): an address on it points at Fly.
    ['motir-ai.fly.dev', true],
    ['ai.motir.co', false],
    ['66.241.125.195', false],
  ])('%s → private: %s', (host, expected) => {
    expect(isPrivateNetworkHost(host)).toBe(expected);
  });

  // MOTIR-10749 — the forms a fleet machine cannot use that the first list missed.
  it.each([
    // Fly-owned names, any case, and the bare zone.
    ['motir-ai.fly.dev', true],
    ['fly.dev', true],
    ['MOTIR-AI.FLY.DEV', true],
    ['notfly.dev', false],
    // Flycast and `.internal`, including EC2's private DNS.
    ['motir-gateway.flycast', true],
    ['motir-ai.internal', true],
    ['ip-10-0-1-5.ec2.internal', true],
    ['motir-ai.internal.', true],
    // AWS internal load balancers resolve publicly to private addresses.
    ['internal-motir-core-123.us-east-1.elb.amazonaws.com', true],
    ['internal-x-1.elb.amazonaws.com', true],
    // A public load balancer name is reachable; an unpublished host is not this check's call.
    ['motir-core-123.us-east-1.elb.amazonaws.com', false],
    // Motir's published origins.
    ['ai.motir.co', false],
    ['app.motir.co', false],
    ['gateway-run.motir.co', false],
    // `localhost` is a zone, not a string suffix.
    ['localhost', true],
    ['app.localhost', true],
    ['notlocalhost.com', false],
  ])('names: %s → private: %s', (host, expected) => {
    expect(isPrivateNetworkHost(host)).toBe(expected);
  });

  it.each([
    // Both edges of 172.16.0.0/12, on each side.
    ['172.15.255.255', false],
    ['172.16.0.1', true],
    ['172.20.5.5', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['172.217.1.1', false],
    ['10.1.2.3', true],
    ['192.168.0.9', true],
    ['127.0.0.1', true],
    ['169.254.169.254', true],
    ['100.64.0.1', true],
    ['100.128.0.1', false],
    ['0.0.0.0', true],
    ['66.241.125.195', false],
    // Four numeric labels with an octet over 255 is a name, not a literal.
    ['10.0.0.256', false],
  ])('IPv4 literals: %s → private: %s', (host, expected) => {
    expect(isPrivateNetworkHost(host)).toBe(expected);
  });

  it.each([
    ['::1', true],
    ['::', true],
    ['fdaa:0:1::3', true],
    ['[fdaa:0:1::3]', true],
    ['fc00::1', true],
    ['fe80::1', true],
    ['2606:4700::1111', false],
    // IPv4-mapped and -compatible literals are judged by the IPv4 inside them.
    ['::ffff:a00:1', true],
    ['[::ffff:10.0.0.1]', true],
    ['::ffff:127.0.0.1', true],
    ['::ffff:7f00:1', true],
    ['0:0:0:0:0:ffff:c0a8:9', true],
    ['::ac14:505', true],
    ['::ffff:808:808', false],
    ['::ffff:8.8.8.8', false],
  ])('IPv6 literals: %s → private: %s', (host, expected) => {
    expect(isPrivateNetworkHost(host)).toBe(expected);
  });

  it.each([
    // The old string-prefix tests refused these ordinary hostnames.
    ['fdic.example.com', false],
    ['fcm.motir.co', false],
    ['10.motir.co', false],
  ])('hostnames are judged by suffix, not prefix: %s → private: %s', (host, expected) => {
    expect(isPrivateNetworkHost(host)).toBe(expected);
  });
});
