import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROJECT_SETTINGS_NAV, visibleSettingsNav } from '@/lib/settings/projectSettingsNav';
import { BUILTIN_ROLE_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import { roleMayManageAddress } from '@/lib/services/publicSubdomainService';

// THE PUBLIC ADDRESS ROOM's MOUNT (Story MOTIR-3878 · MOTIR-4221) — the rail
// row, its four gates and the two axes this room is gated on. The registry's
// own guards (totality, key evidence, the three-way agreement) live in
// `projectSettingsNav.test.ts` and `permissions/gatedUiStoryGate.test.ts`; this
// file is about what is SPECIFIC to this destination.
//
// The gate assertions are SOURCE assertions, following the Public page room's
// (MOTIR-4243) and for its stated reason: what they claim is ORDER, and order is
// exactly what a rendered test cannot see. A page whose `notFound()` moved below
// an `await` renders identically once everything resolves, and answers 200
// instead of 404 only to a reader on a self-hosted build.

const ROOT = process.cwd();
const PAGE = 'app/(authed)/settings/project/public-address/page.tsx';
const ECHO = 'app/(authed)/settings/project/public-address/_components/PublicAddressEcho.tsx';
// The subdomain's CONTROL moved to workspace settings (Story MOTIR-4528 ·
// MOTIR-9514/9515); this room keeps a read-only echo of it.
const WS_BODY = 'app/(authed)/settings/workspace/public-address/_components/PublicAddressBody.tsx';
const WS_REFUSAL = 'app/(authed)/settings/workspace/public-address/_components/refusal.ts';
const WS_CONTROL =
  'app/(authed)/settings/workspace/public-address/_components/PublicAddressControl.tsx';
const SLOT = 'app/(authed)/settings/project/public-address/_components/CustomDomainsSection.tsx';

/** Source with comments stripped — a claim in prose is not a claim in code. */
const code = (rel: string) =>
  readFileSync(join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

const ADMIN = BUILTIN_ROLE_PERMISSIONS.admin;
const MEMBER = BUILTIN_ROLE_PERMISSIONS.member;
const VIEWER = BUILTIN_ROLE_PERMISSIONS.viewer;
const ON_CLOUD = { publicProjectsAvailable: true };
const SELF_HOSTED = { publicProjectsAvailable: false };

describe('the rail row', () => {
  const entry = PROJECT_SETTINGS_NAV.find((e) => e.id === 'public-address');

  it('is an Access room at its own route, cloud-only', () => {
    expect(entry?.group).toBe('access');
    expect(entry?.href).toBe('/settings/project/public-address');
    expect(entry?.labelKey).toBe('nav.publicAddress');
    expect(entry?.cloudOnly).toBe(true);
  });

  it('is ABSENT on a self-hosted build even for an admin', () => {
    // ADR §11: off-cloud the capability does not exist. Absent, not disabled —
    // a disabled row is a promise the build cannot keep.
    expect(visibleSettingsNav(ADMIN, undefined, SELF_HOSTED).map((e) => e.id)).not.toContain(
      'public-address',
    );
    expect(visibleSettingsNav(ADMIN, undefined, ON_CLOUD).map((e) => e.id)).toContain(
      'public-address',
    );
  });

  it('does NOT reuse the Globe glyph that Public page owns one row up', () => {
    // Two rooms in the same group sharing a mark is the same confusion
    // MOTIR-4243 refused between a room and a status badge.
    const publicPage = PROJECT_SETTINGS_NAV.find((e) => e.id === 'public-page');
    expect(entry?.icon).toBeTruthy();
    expect(entry?.icon).not.toBe(publicPage?.icon);
  });

  it('is hidden from a member and a VIEWER — no read-only administrative rooms', () => {
    // ⚠️ THE READING THE DESIGN ASSET FLAGGED AND DID NOT MAKE. `project:browse`
    // would have been the tempting key, because the subdomain is readable by any
    // workspace member — and it would have handed every project VIEWER a
    // settings door, since no other entry is gated on it. The 2026-08-08
    // amendment (no read-only administrative rooms) refuses that.
    for (const held of [MEMBER, VIEWER]) {
      expect(visibleSettingsNav(held, undefined, ON_CLOUD).map((e) => e.id)).not.toContain(
        'public-address',
      );
    }
  });
});

describe('the page gates, in order', () => {
  const src = code(PAGE);

  it('`notFound()` is the FIRST statement, and nothing is awaited before it', () => {
    const gate = src.indexOf('if (!isCloud()) notFound()');
    expect(gate).toBeGreaterThan(-1);
    expect(src.slice(0, gate)).not.toMatch(/await /);
  });

  it('asks the CLOUD question, never the billing one', () => {
    expect(src).toContain('isCloud');
    expect(src).not.toContain('isCloudBilling');
    expect(src).not.toMatch(/entitlement/i);
  });

  it('runs the destination guard, and never re-declares the key', () => {
    // MOTIR-2469: the page names the registry ENTRY, and the key lives in one
    // place. A page that spelled its own permission could drift from the row
    // that hides it.
    expect(src).toContain("guardSettingsPage('public-address'");
    expect(src).not.toContain("'project:manage_access'");
  });

  it('the guard runs AFTER the project resolves and BEFORE any address read', () => {
    const guard = src.indexOf('guardSettingsPage');
    expect(src.indexOf('getActiveProject')).toBeLessThan(guard);
    expect(guard).toBeLessThan(src.indexOf('getForWorkspace'));
  });

  it('an unconfigured base domain EXPLAINS itself rather than 404ing', () => {
    // A cloud deployment with no `MOTIR_PUBLIC_TENANT_DOMAIN` is an OPERATOR
    // state. A 404 would tell an admin the room does not exist when it does, and
    // send them looking for the feature instead of for the variable.
    const check = src.indexOf('isTenantDomainConfigured()');
    expect(check).toBeGreaterThan(-1);
    expect(src.slice(check)).toContain('publicAddress.unavailable.title');
    expect(src.slice(check)).not.toContain('notFound()');
  });
});

describe('the two axes this room is gated on', () => {
  it('the rail key is a PROJECT permission; the subdomain write is a WORKSPACE role', () => {
    // The whole reason panel 8 exists: an actor can hold the door key and not
    // the write key, because the two are different axes. ADR §3 makes a
    // subdomain a property of the WORKSPACE, not of one project.
    expect(PROJECT_SETTINGS_NAV.find((e) => e.id === 'public-address')?.permission).toBe(
      'project:manage_access',
    );
    expect(roleMayManageAddress('manager')).toBe(true);
    expect(roleMayManageAddress('member')).toBe(false);
    expect(roleMayManageAddress('viewer')).toBe(false);
    expect(roleMayManageAddress(null)).toBe(false);
  });

  it('the workspace control asks the SERVICE for that predicate rather than restating the roles', () => {
    // A second `['owner','admin']` in a page component is a copy of a
    // security-shaped rule, and its drift shows up as controls that appear and
    // then refuse.
    const src = code(WS_BODY);
    expect(src).toContain('roleMayManageAddress');
    expect(src).not.toMatch(/\[\s*'owner'\s*,\s*'admin'\s*\]/);
  });

  it('this room echoes the subdomain read-only — no role read, no write path (MOTIR-9515)', () => {
    const page = code(PAGE);
    expect(page).toContain('<PublicAddressEcho');
    expect(page).not.toContain('roleMayManageAddress');
    expect(page).not.toContain('getMemberRole');
    const echo = code(ECHO);
    expect(echo).toContain("'/settings/workspace/public-address'");
    expect(echo).not.toMatch(/method:\s*'(PUT|DELETE)'|fetch\(/);
  });
});

describe('the workspace control renders the design, and the refusals come from CODES', () => {
  const refusal = code(WS_REFUSAL);
  const control = code(WS_CONTROL);

  it('maps every refusal the service can raise', () => {
    // MOTIR-4215 put the `refusal` discriminator on the wire precisely because
    // `reserved` and `bad_grammar` send a customer to different next actions.
    for (const discriminator of [
      'reserved',
      'structurally_reserved',
      'too_short',
      'too_long',
      'bad_grammar',
    ]) {
      expect(refusal, `no copy for the ${discriminator} refusal`).toContain(discriminator);
    }
    for (const codeName of [
      'HOSTNAME_TAKEN',
      'NAME_QUARANTINED',
      'SUBDOMAIN_CHANGE_LIMIT',
      'SUBDOMAIN_FORBIDDEN',
    ]) {
      expect(refusal, `no arm for ${codeName}`).toContain(codeName);
    }
  });

  it('never renders the server’s English message', () => {
    expect(refusal + control).not.toMatch(/body\.error|\.error\s*\)/);
  });

  it('speaks through the catalogue, so the other locales are not a second implementation', () => {
    expect(control).toContain("useTranslations('settings.workspaceAddress')");
  });

  it('re-reads after a write instead of patching local state', () => {
    expect(control).toContain('router.refresh()');
  });
});

describe('the custom-domain half (MOTIR-4229) landed in the slot part 1 left', () => {
  it('is composed by the page, with its addresses read SERVER-side', () => {
    // The slot was a typed stub for exactly one commit, which is what made part
    // 2 an addition to one file rather than an edit to the page's body.
    const src = code(PAGE);
    expect(src).toContain('<CustomDomainsSection');
    expect(src).toContain('customDomainService.list');
  });

  it('the state map is TOTAL over the enum, subdomain values included', () => {
    // A `Record<PublicAddressStatus, …>` makes a tenth value a compile error
    // rather than a row that renders blank. The two subdomain states are NAMED
    // and excluded rather than omitted — an omission reads as an oversight.
    const src = code(SLOT);
    expect(src).toContain('Record<DomainStatus, StateRow>');
    for (const status of [
      'active',
      'alias',
      'unverified',
      'verifying',
      'pending_certificate',
      'issued',
      'failed',
      'expired',
      'revoked',
    ]) {
      expect(src, `the state map does not name ${status}`).toContain(status);
    }
  });

  it('does not read a tier — the cap refusal is what raises the prompt', () => {
    // `entitlementsService.assertCanAddCustomDomain` records that `free: 0`
    // exists to make the refusal "the upgrade prompt's trigger instead of an
    // empty state the pane special-cases". A tier read here would be the second
    // copy of a billing rule that note exists to prevent.
    const src = code(SLOT);
    expect(src).toContain("entitlement === 'custom_domains'");
    expect(src).not.toMatch(/maxCustomDomains|entitlementsFor|tierFor/);
  });
});

describe('door ② — the share row in the members pane', () => {
  it('links to this room, and only for an actor who may manage', () => {
    const src = code(
      'app/(authed)/settings/project/members/_components/ProjectMembersSettings.tsx',
    );
    expect(src).toContain("'/settings/project/public-address'");
    expect(src).toContain('public.setUpOwnAddress');
    // Admin-gated exactly as the Hero & overview door beside it.
    const door = src.indexOf('publicAddressPath');
    expect(src.slice(door - 400, door)).toContain('canManage');
  });
});
