import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// THE CERTIFICATE PORT'S DEPENDENCY GUARD — Story MOTIR-3878 · Subtask MOTIR-4210.
//
// `docs/decisions/public-tenant-addresses.md` §6 decides that FLY issues and
// renews customer certificates. A decision is only reversible if the thing it
// decided is confined, and a boundary whose enforcement is a comment erodes the
// first time somebody needs one more field — invisibly, until the day a second
// provider is actually needed, by which point "swap the adapter" has become
// "re-plan the lifecycle". That argument is `tests/ciFleet/orchestratorPortBoundary.test.ts`'s,
// and it transfers unchanged; this file is the same rule for a different port.
//
// It scans SOURCE rather than a module graph, for that guard's reason: half the
// ways a provider leaks — a hardcoded API host, an env var, a magic status
// string — are not imports at all.

/** Where Fly's CERTIFICATES resource may be named. */
const CERT_ADAPTER_DIR = join('lib', 'publicAddresses', 'adapters', 'fly');

/**
 * The FLEET's adapter directory, which is not this port and is not scanned.
 *
 * It names Fly for its own reasons and has its own guard. Excluding it here
 * keeps the two guards independent: neither can go green because the other is
 * doing the work, and neither reports the other's violations.
 */
const FLEET_ADAPTER_DIR = join('lib', 'orchestrator', 'adapters', 'fly');

/** Roots that must stay provider-agnostic about certificates. */
const SCANNED_ROOTS = ['lib', 'app', 'components'];

/**
 * The tells — each a way THIS port's provider leaks. Narrow on purpose: a guard
 * that cries wolf gets deleted.
 */
const CERT_TELLS: ReadonlyArray<{ pattern: RegExp; what: string }> = [
  { pattern: /publicAddresses\/adapters\/fly/, what: 'an import from the certificate adapter' },
  { pattern: /\bFLY_CERTS_[A-Z_]+\b/, what: 'a FLY_CERTS_* environment variable' },
  { pattern: /\bflyCert(ificate|s)[A-Za-z]*\b/, what: 'a Fly-certificates symbol' },
  { pattern: /certificates\/acme/, what: "Fly's ACME certificates path" },
  { pattern: /\bacme_challenge\b/, what: "Fly's DNS-requirements key" },
];

/**
 * The COMPOSITION ROOT — the one file outside the adapter allowed to name it.
 *
 * ⚠️ IT FILLED IN WITHIN THE SAME STORY, which is worth reading as evidence
 * rather than as bookkeeping. This list was written EMPTY, with a comment
 * predicting that "when a second lands, a selector goes here and this list gains
 * exactly one entry". MOTIR-4216 landed that second provider — the in-memory
 * pair the E2E lane binds — and the list gained exactly one entry. The
 * reversibility claim §6 rests on is now a measured fact rather than an
 * intention.
 *
 * `providers.ts` is a selector, not a leak: it names the Fly adapter to CHOOSE
 * it (lazily, so the adapter's config is read only on the path that calls Fly),
 * and it declares the fake it chooses instead under the E2E flag. A selector
 * that cannot name what it selects is not a selector.
 */
const ALLOWED: ReadonlyArray<{ file: string; tell: RegExp; why: string }> = [
  {
    file: join('lib', 'publicAddresses', 'providers.ts'),
    tell: /publicAddresses\/adapters\/fly|flyCertificateProvider/,
    why: 'the composition root — it selects between the Fly adapter and the E2E fake',
  },
  {
    file: join('lib', 'health', 'credentialRegistry.ts'),
    tell: /\b(FLY_CERTS_TOKEN|FLY_CERTS_APP)\b/,
    why: "declares the certificate token's expiry for the daily health check — a name, not a client (MOTIR-7332, MOTIR-9408)",
  },
];

/** The composition root may also DECLARE an implementation: the fake it selects. */
const IMPLEMENTERS_ALLOWED: readonly string[] = [join('lib', 'publicAddresses', 'providers.ts')];

function walk(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else if (/\.tsx?$/.test(full)) files.push(full);
  }
  return files;
}

/** A comment EXPLAINING the boundary is not a violation of it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const root = process.cwd();

function violations(): Array<{ file: string; what: string; line: string }> {
  const found: Array<{ file: string; what: string; line: string }> = [];
  for (const scanRoot of SCANNED_ROOTS) {
    for (const file of walk(join(root, scanRoot))) {
      const rel = relative(root, file);
      if (rel.startsWith(CERT_ADAPTER_DIR + sep)) continue;
      if (rel.startsWith(FLEET_ADAPTER_DIR + sep)) continue;
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const { pattern, what } of CERT_TELLS) {
        for (const line of source.split('\n')) {
          if (!pattern.test(line)) continue;
          if (ALLOWED.some((a) => a.file === rel && a.tell.test(line))) continue;
          found.push({ file: rel, what, line: line.trim().slice(0, 120) });
        }
      }
    }
  }
  return found;
}

describe('the certificate port — no provider escapes its adapter', () => {
  it('nothing in lib/, app/ or components/ names Fly certificates outside the adapter', () => {
    const found = violations();
    // The failure message IS the value: it names the file, the line and WHICH
    // tell fired, so a violation is fixed rather than merely reported.
    expect(found, found.map((v) => `${v.file}: ${v.what}\n    ${v.line}`).join('\n')).toEqual([]);
  });

  it('the guard actually detects a leak (mutation check)', () => {
    // ⚠️ A guard nobody has watched FAIL is a guard that may be matching
    // nothing. This proves the tells fire on the strings they exist to catch, so
    // a green run above means "no leak" rather than "no scan".
    const leaks = [
      "import { flyCertificateProvider } from '@/lib/publicAddresses/adapters/fly/flyCertificates';",
      "const token = process.env['FLY_CERTS_TOKEN'];",
      'const app = flyCertsConfig().app;',
      "await fetch(base + '/certificates/acme', { method: 'POST' });",
      'const name = body.dns_requirements.acme_challenge.name;',
    ];
    for (const leak of leaks) {
      expect(
        CERT_TELLS.some(({ pattern }) => pattern.test(leak)),
        leak,
      ).toBe(true);
    }
  });

  it('the adapter is the ONLY implementation of the port', () => {
    // The port's acceptance criterion, asserted rather than assumed: a second
    // `implements CertificateProvider` / `: CertificateProvider` outside the
    // adapter directory would be a provider nobody selected between.
    const implementers: string[] = [];
    for (const scanRoot of SCANNED_ROOTS) {
      for (const file of walk(join(root, scanRoot))) {
        const rel = relative(root, file);
        if (rel.startsWith(CERT_ADAPTER_DIR + sep)) continue;
        // The port file itself DECLARES the interface; declaring is not
        // implementing.
        if (rel === join('lib', 'publicAddresses', 'certificateProvider.ts')) continue;
        // The composition root declares the fake it selects — see above.
        if (IMPLEMENTERS_ALLOWED.includes(rel)) continue;
        const source = stripComments(readFileSync(file, 'utf8'));
        if (/:\s*CertificateProvider\b|implements\s+CertificateProvider\b/.test(source)) {
          implementers.push(rel);
        }
      }
    }
    expect(implementers).toEqual([]);
  });
});
