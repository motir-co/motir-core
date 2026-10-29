import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MAX_APPLICATION_SLUG_LENGTH,
  MAX_SUBDOMAIN_LENGTH,
  MIN_APPLICATION_SLUG_LENGTH,
  MIN_SUBDOMAIN_LENGTH,
  RESERVED_SEPARATOR,
  RESERVED_SUBDOMAIN_LABELS,
  isReservedLabel,
  refuseApplicationSlug,
  refuseLabel,
} from '@/lib/publicAddresses/reservedNames';

// The subdomain label grammar and the reserved set — Story MOTIR-3878 · Subtask
// MOTIR-4209. `docs/decisions/public-tenant-addresses.md` §8 is the record.
//
// ⚠️ THE ENUMERATED SET IS ASSERTED MEMBER BY MEMBER, not by counting. A count
// passes when a name is swapped for another one, which is exactly the edit that
// would quietly un-reserve `admin`.

describe('the ADR §8 reserved set', () => {
  // Not a sample. Each of these is a name a customer holding it could use to
  // serve content that looks like Motir at an address that looks like Motir's.
  const ours = [
    'www',
    'app',
    'api',
    'mail',
    'smtp',
    'imap',
    'mx',
    'ns',
    'ns1',
    'ns2',
    'status',
    'docs',
    'help',
    'support',
    'blog',
    'admin',
    'assets',
    'cdn',
    'static',
    'img',
    'media',
    'motir',
    'moooon',
    'staging',
    'preview',
    'dev',
    'test',
    'internal',
    'dashboard',
    'account',
    'accounts',
    'billing',
    'login',
    'signin',
    'signup',
    'auth',
    'oauth',
    'sso',
    'webhook',
    'webhooks',
    'ai',
    'gateway',
  ];

  it("refuses every one of Motir's own hostnames", () => {
    for (const label of ours) {
      expect(isReservedLabel(label), `${label} must be reserved`).toBe(true);
    }
  });

  it('reports a reserved name as `reserved` — EXCEPT the three that are also too short', () => {
    // ⚠️ Written this way because the first draft asserted `reserved` for all
    // forty-two and went red on `mx`, `ns` and `ai`. That is the two rules
    // INTERACTING, not a defect: `refuseLabel` tests length before membership,
    // so a two-character reserved name is reported as `too_short`.
    //
    // The ordering is right and is kept. Both answers refuse the claim, and
    // `too_short` is the more useful of the two — it is true of every
    // two-character label, reserved or not, so it sends the customer to the fix
    // that actually works. Telling them `ai` is *reserved* would imply that a
    // different two-character name might not be.
    const shortAndReserved = ['mx', 'ns', 'ai'];
    for (const label of ours) {
      const expected = shortAndReserved.includes(label) ? 'too_short' : 'reserved';
      expect(refuseLabel(label), `${label} → ${expected}`).toBe(expected);
    }
    // And the interaction is not silent: every one of the three is still
    // reserved in the SET, so raising the minimum length would not un-reserve
    // them and lowering it hands them straight back to the `reserved` arm.
    for (const label of shortAndReserved) {
      expect(RESERVED_SUBDOMAIN_LABELS.has(label)).toBe(true);
    }
  });

  it('refuses every impersonation risk', () => {
    const risky = [
      'security',
      'abuse',
      'postmaster',
      'hostmaster',
      'webmaster',
      'noreply',
      'no-reply',
      'official',
      'verify',
      'verification',
      'payment',
      'payments',
      'invoice',
      'legal',
      'privacy',
      'terms',
    ];
    for (const label of risky) {
      expect(isReservedLabel(label), `${label} must be reserved`).toBe(true);
    }
  });

  it('holds exactly the two lists and nothing else', () => {
    // The set is asserted TIGHT: a member added here without being added to the
    // ADR fails, and so does the reverse. It is the same discipline the
    // design-asset KNOWN tables use, and for the same reason — a list that only
    // grows becomes a list nobody reads.
    expect(RESERVED_SUBDOMAIN_LABELS.size).toBe(42 + 16);
  });
});

describe('the STRUCTURAL rules — predicates, not list entries', () => {
  it('refuses the whole underscore space, which is what makes it total', () => {
    // `_acme-challenge` and `_motir-verify` are the two names that matter today.
    // The rule refuses the SPACE, so a protocol inventing a third underscore
    // name tomorrow needs no edit here.
    for (const label of ['_acme-challenge', '_motir-verify', '_dmarc', '_anything-at-all']) {
      expect(isReservedLabel(label), `${label} must be structurally reserved`).toBe(true);
      expect(refuseLabel(label)).toBe('bad_grammar');
    }
  });

  it('refuses punycode, which is the form a homograph attack arrives in', () => {
    expect(isReservedLabel('xn--80ak6aa92e')).toBe(true);
    expect(refuseLabel('xn--80ak6aa92e')).toBe('structurally_reserved');
  });

  it('keeps the motir- prefix ours', () => {
    expect(isReservedLabel('motir-cloud')).toBe(true);
    expect(refuseLabel('motir-cloud')).toBe('structurally_reserved');
  });

  it('reserves the `--` separator ANYWHERE in a workspace label', () => {
    // `shop--acme` as a workspace label would read as application `shop` of
    // workspace `acme`. Reserving the separator is what keeps the parse of an
    // application host unambiguous (AMENDMENT 4 §4).
    for (const label of ['ab--cd', 'acme--', 'shop--acme', 'a-b--c-d']) {
      expect(isReservedLabel(label), `${label} must be structurally reserved`).toBe(true);
    }
    expect(refuseLabel('ab--cd')).toBe('structurally_reserved');
    expect(refuseLabel('shop--acme')).toBe('structurally_reserved');
    // A single hyphen stays an ordinary label.
    expect(refuseLabel('a-b-c')).toBeNull();
  });
});

describe('the application slug — AMENDMENT 4', () => {
  it('accepts an ordinary slug, and a listed reserved NAME', () => {
    // The listed names guard Motir's own hostnames at the workspace label. An
    // application host always carries `--<workspace>`, so `admin--acme` can
    // never be mistaken for Motir's `admin` (AMENDMENT 4 §4 rule 4).
    for (const slug of ['web', 'shop', 'admin', 'api', 'x'.repeat(MAX_APPLICATION_SLUG_LENGTH)]) {
      expect(refuseApplicationSlug(slug), `${slug} should be a valid slug`).toBeNull();
    }
  });

  it('refuses a slug outside 3–30 characters', () => {
    expect(refuseApplicationSlug('ab')).toBe('too_short');
    expect(refuseApplicationSlug('x'.repeat(MAX_APPLICATION_SLUG_LENGTH + 1))).toBe('too_long');
  });

  it('refuses the separator inside a slug, so the host parses one way only', () => {
    expect(refuseApplicationSlug('ab--cd')).toBe('structurally_reserved');
  });

  it('refuses bad grammar first', () => {
    for (const slug of ['Shop', '-shop', 'shop-', 'sh_op', '_shop', '']) {
      expect(refuseApplicationSlug(slug), `${slug} must be refused`).toBe('bad_grammar');
    }
  });

  it('fits a whole application host label inside one DNS label', () => {
    const longest = `${'a'.repeat(MAX_APPLICATION_SLUG_LENGTH)}${RESERVED_SEPARATOR}${'w'.repeat(
      MAX_SUBDOMAIN_LENGTH,
    )}`;
    expect(longest.length).toBeLessThanOrEqual(63);
  });
});

describe('the constants agree with the ADR', () => {
  // Read from the ADR rather than restated, so an amendment that changes a
  // number without changing the code (or the reverse) fails here.
  const adr = readFileSync(
    join(process.cwd(), 'docs/decisions/public-tenant-addresses.md'),
    'utf8',
  );
  const amendment = adr.slice(adr.indexOf('### ⚠️ AMENDMENT 4'));
  const row = (label: string): string => {
    const match = amendment.match(
      new RegExp(`^\\|\\s*${label}\\s*\\|\\s*\`([^\`]+)\`\\s*\\|`, 'm'),
    );
    expect(match, `AMENDMENT 4 §4 must carry a "${label}" row`).not.toBeNull();
    return match![1]!;
  };

  it('§8 rules 1 and 2 are exactly RESERVED_SUBDOMAIN_LABELS', () => {
    const section = adr.slice(adr.indexOf('### The reserved-name set'));
    const listed = (from: string, to: string): string[] => {
      const text = section.slice(section.indexOf(from), section.indexOf(to));
      return [...text.matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1]!);
    };
    const named = [
      ...listed('1. **Is one of', '2. **Is an impersonation'),
      ...listed('2. **Is an impersonation', '3. **Is structurally'),
    ];
    expect(named).toHaveLength(42 + 16);
    expect(new Set(named)).toEqual(RESERVED_SUBDOMAIN_LABELS);
  });

  it('AMENDMENT 4 §4 table', () => {
    expect(row('reserved separator in a workspace label')).toBe(RESERVED_SEPARATOR);
    expect(Number(row('longest workspace label'))).toBe(MAX_SUBDOMAIN_LENGTH);
    expect(Number(row('shortest application slug'))).toBe(MIN_APPLICATION_SLUG_LENGTH);
    expect(Number(row('longest application slug'))).toBe(MAX_APPLICATION_SLUG_LENGTH);
  });
});

describe('the label grammar', () => {
  it('accepts an ordinary label', () => {
    for (const label of ['acme', 'acme-inc', 'acme2', 'a1b', 'x'.repeat(MAX_SUBDOMAIN_LENGTH)]) {
      expect(refuseLabel(label), `${label} should be claimable`).toBeNull();
    }
  });

  it('refuses a label below the minimum length', () => {
    // Short labels are the scarcest in the namespace, so they are held back
    // deliberately rather than handed to whoever signs up first.
    expect(refuseLabel('a')).toBe('too_short');
    expect(refuseLabel('ab')).toBe('too_short');
    expect(MIN_SUBDOMAIN_LENGTH).toBe(3);
  });

  it('refuses a label past the AMENDMENT 4 cap of 30', () => {
    // 30, not the DNS limit of 63: the label now shares one 63-octet DNS label
    // with an application slug and the `--` separator (ADR §8 AMENDMENT 4).
    expect(refuseLabel('x'.repeat(MAX_SUBDOMAIN_LENGTH + 1))).toBe('too_long');
    expect(MAX_SUBDOMAIN_LENGTH).toBe(30);
  });

  it('refuses uppercase as GRAMMAR, not as a name to fold', () => {
    // The refusal a customer gets should send them to the fix they actually
    // need. Reporting `Admin` as "reserved" sends them looking for a different
    // name; reporting it as bad grammar sends them to the shift key.
    expect(refuseLabel('Admin')).toBe('bad_grammar');
    expect(refuseLabel('ACME')).toBe('bad_grammar');
    // And the un-folded form is NOT in the set, which is what makes the
    // ordering above load-bearing rather than cosmetic.
    expect(RESERVED_SUBDOMAIN_LABELS.has('Admin')).toBe(false);
  });

  it('refuses a leading or trailing hyphen, a dot, and whitespace', () => {
    for (const label of ['-acme', 'acme-', 'ac.me', 'ac me', '', 'ac_me']) {
      expect(refuseLabel(label), `${label} must be refused`).toBe('bad_grammar');
    }
  });

  it('reports grammar BEFORE reservation, so the refusal names the real problem', () => {
    // `_motir-verify` fails both rules. Grammar wins, because the underscore is
    // what a customer would have to change either way.
    expect(refuseLabel('_motir-verify')).toBe('bad_grammar');
  });
});
