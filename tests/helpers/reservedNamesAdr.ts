// The reserved names `docs/decisions/public-tenant-addresses.md` §8 lists under
// rules 1 and 2, read from the ADR's own text rather than restated — so a name
// added to the ADR or to `RESERVED_SUBDOMAIN_LABELS` alone is a difference a
// test can see. Shared by the reserved-names suite and the production-deploy
// story suite (MOTIR-10038), which checks the derivation catches either edit.
export function adrReservedNames(adr: string): string[] {
  const section = adr.slice(adr.indexOf('### The reserved-name set'));
  const listed = (from: string, to: string): string[] => {
    const text = section.slice(section.indexOf(from), section.indexOf(to));
    return [...text.matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1]!);
  };
  return [
    ...listed('1. **Is one of', '2. **Is an impersonation'),
    ...listed('2. **Is an impersonation', '3. **Is structurally'),
  ];
}
