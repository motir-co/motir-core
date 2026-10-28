import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/tests/helpers/importGraph';

// Guard for MOTIR-4137: an E2E spec does not name the application origin.
//
// ## The failure this exists to prevent
//
// `acceptance-public-redirect.spec.ts` opened with `const APP =
// 'http://localhost:3200'` — correct for the acceptance lane, and correct
// nowhere else. MOTIR-4094 promoted it to `cloud-public-redirect.spec.ts`,
// which moves it under `playwright.cloud.config.ts` and its port 3100, and
// every request in it died `connect ECONNREFUSED ::1:3200`. `CI complete` gates
// `Deploy to Fly`, so `main` stopped deploying for 13 hours.
//
// The promotion was correct; the spec was the thing that could not survive it.
// MOTIR-4093 will drain more specs across the same boundary, so this is the
// guard that makes the NEXT promotion safe rather than a fix for the last one.
//
// ## The rule
//
// The origin comes from the LANE — Playwright's `baseURL`, which every config
// derives from `E2E_BASE_URL ?? http://localhost:<that lane's port>`. A spec
// reaches it through a relative path (`request.get('/explore')`) or the
// `baseURL` fixture; it never writes the origin down. A literal origin is
// allowed only as opaque DATA inside a payload the spec hands to a mock —
// there it is a string under assertion, not somewhere anything connects.

const SPEC_DIR = 'tests/e2e';

/** `localhost:3000` / `127.0.0.1:3100` and friends, in code (never comments).
 *  A FUNCTION rather than a shared `/g` literal: a global regex carries
 *  `lastIndex` between calls, so a shared one would skip every other match. */
const originLiterals = (s: string): string[] =>
  s.match(/(?:localhost|127\.0\.0\.1):\d{2,5}/g) ?? [];

/**
 * The literals that are PAYLOAD DATA, not an origin anything connects to —
 * each with the field that carries it. Keyed by file so a spec that grows a
 * real origin still fails; asserted to be non-empty per entry below, so an
 * entry left behind by a deleted spec fails rather than silently exempting
 * nothing.
 */
// Empty since MOTIR-10042 deleted the two specs that seeded mocked email
// payloads (`jobs-dashboard.spec.ts`'s `resetUrl`, `jobs-flow.spec.ts`'s
// `acceptUrl`). Kept, with its stale-entry check, so the next payload literal
// has a recorded home rather than a reason to weaken the guard.
const PAYLOAD_ONLY: Record<string, string> = {};

function specFiles(): string[] {
  return readdirSync(SPEC_DIR)
    .filter((f) => f.endsWith('.spec.ts'))
    .sort();
}

function codeOf(file: string): string {
  return stripComments(readFileSync(join(SPEC_DIR, file), 'utf8'));
}

describe('an E2E spec takes its origin from the lane', () => {
  it('finds specs to check at all', () => {
    // A glob that silently matches nothing is a guard that passes forever.
    expect(specFiles().length).toBeGreaterThan(20);
  });

  it.each(specFiles())('%s writes down no application origin', (file) => {
    const hits = originLiterals(codeOf(file));
    const allowedField = PAYLOAD_ONLY[file];

    if (!allowedField) {
      expect(
        hits,
        `${file} hard-codes an application origin. The origin belongs to the LANE: use a ` +
          `relative path, or the \`baseURL\` fixture where an absolute URL is required. A ` +
          `literal is right for exactly one lane and silently wrong the moment the spec is ` +
          `promoted into another (MOTIR-4137).`,
      ).toEqual([]);
      return;
    }

    // An allowed file still has to be allowed for the REASON recorded — the
    // literal must sit on the payload field named above, and nowhere else.
    for (const line of codeOf(file)
      .split('\n')
      .filter((l) => originLiterals(l).length > 0)) {
      expect(
        line,
        `${file} carries an origin literal outside its recorded \`${allowedField}\` payload — ` +
          `either move it onto the lane's baseURL, or update PAYLOAD_ONLY with the new reason.`,
      ).toContain(allowedField);
    }
  });

  it('keeps no stale PAYLOAD_ONLY entry', () => {
    for (const [file, field] of Object.entries(PAYLOAD_ONLY)) {
      const code = codeOf(file);
      expect(originLiterals(code).length, `${file} no longer needs an entry`).toBeGreaterThan(0);
      expect(code, `${file} no longer carries a \`${field}\` payload`).toContain(field);
    }
  });
});
