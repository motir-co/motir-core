// E2E seed + fixture helpers for the billing journeys (Subtask 8.1.10).
//
// The billing surfaces are CLOUD-ONLY (MOTIR_CLOUD), so these specs run in the
// dedicated cloud-on lane (playwright.cloud.config.ts). The motir-ai side of
// billing (AI plan/usage + Stripe sessions) is stood in for by the E2E_TEST_BILLING
// boundary mock (lib/test-billing-mock.ts); these helpers (1) seed the local org /
// membership / project + the active-context cookies, and (2) WRITE the per-org
// fixture file the mock reads, so a spec controls exactly what the boundary reports
// for its org — and can REWRITE it mid-test to simulate a Stripe webhook landing.

import { writeFileSync, readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { db } from './db-reset';
import { signUpToOnboarding, SHELL_PASSWORD } from './shell-session';
import { organizationsService } from '@/lib/services/organizationsService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';
import { ORGANIZATION_COOKIE_NAME } from '@/lib/organizations/cookie';
import type {
  BillingFixture,
  BillingFixtureEntry,
  BillingFixtureTier,
} from '@/lib/test-billing-mock';

export interface BillingSeed {
  ownerId: string;
  ownerEmail: string;
  workspaceId: string;
  organizationId: string;
  projectId: string;
}

/** Sign up an org owner via the UI (auto workspace + auto org, owner role), then
 *  server-side: a project pinned active, and the active-context cookies (the
 *  `workspace_id` cookie the getWorkspaceContext-gated routes read + the
 *  `motir.org` cookie the billing page resolves the active org from). Leaves the
 *  page signed in as the owner. */
export async function seedBillingOwner(page: Page, email: string): Promise<BillingSeed> {
  // ⚠️ `signUpToOnboarding`, NOT `signUp` (MOTIR-4876). Since a registration
  // lands on the onboarding entrance, `signUp` settles THERE and then navigates
  // on to `/workbench` to keep its "leave the caller in the app" contract — a
  // second, heavy authed page load. This seed does not want it: it pins the
  // context cookies itself two statements below, creates the project it cares
  // about, and every one of its seven callers navigates explicitly afterwards.
  // Paying for the landing here bought nothing and spent budget the acceptance
  // lane measures in seconds (its per-test timeout is 90s, and
  // `regression-repository-tenancy.spec.ts` runs close enough to it that the
  // extra navigation tipped it over under CI load).
  await signUpToOnboarding(page, email);
  const local = email.split('@')[0]!;
  const owner = await db.user.findFirstOrThrow({ where: { email } });
  const workspace = await db.workspace.findFirstOrThrow({
    where: { name: `${local}'s Workspace` },
  });
  const membership = await db.organizationMembership.findFirstOrThrow({
    where: { userId: owner.id, role: ORGANIZATION_ROLE.owner },
  });
  const organizationId = membership.organizationId;

  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Billing E2E',
    identifier: 'BILL',
  });

  // Pin the active project (so /onboarding + /api/ai/access resolve a context)
  // and the active-context cookies (workspace + org) so routing is deterministic.
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  await pinContextCookies(page, { workspaceId: workspace.id, organizationId });

  return {
    ownerId: owner.id,
    ownerEmail: email,
    workspaceId: workspace.id,
    organizationId,
    projectId: project.id,
  };
}

/** Add a plain (non-admin) MEMBER to the seeded org — the permission-gate actor
 *  (a member who can VIEW nothing billable: the 403 → "ask your owner" gate). */
export async function addOrgMember(
  seed: BillingSeed,
  email: string,
): Promise<{ id: string; email: string }> {
  const member = await usersService.createUser({
    email,
    password: SHELL_PASSWORD,
    name: 'Org Member',
  });
  await organizationsService.addMember({
    organizationId: seed.organizationId,
    userId: member.id,
    role: ORGANIZATION_ROLE.member,
    actorUserId: seed.ownerId,
  });
  return { id: member.id, email };
}

/** Set the `motir.org` (active org) + `workspace_id` cookies on the browser
 *  context, so the billing page resolves the right org and the workspace-gated
 *  routes resolve the right workspace. */
export async function pinContextCookies(
  page: Page,
  ctx: { workspaceId?: string; organizationId?: string },
): Promise<void> {
  const cookies = [];
  if (ctx.workspaceId) {
    cookies.push({ name: 'workspace_id', value: ctx.workspaceId, domain: 'localhost', path: '/' });
  }
  if (ctx.organizationId) {
    cookies.push({
      name: ORGANIZATION_COOKIE_NAME,
      value: ctx.organizationId,
      domain: 'localhost',
      path: '/',
    });
  }
  if (cookies.length) await page.context().addCookies(cookies);
}

// ── The motir-ai billing fixture (what the boundary mock reports per org) ──────

const STANDARD_TIER: BillingFixtureTier = {
  key: 'standard',
  name: 'Standard',
  monthlyCreditAllotment: 2000,
};
const PRO_TIER: BillingFixtureTier = { key: 'pro', name: 'Pro', monthlyCreditAllotment: 8000 };
/** The top of the ladder (MOTIR-9363): the figures the flat limits used to be —
 *  5 hosted runs at once, 10 agents per person, 50 running. */
const MAX_X2_TIER: BillingFixtureTier = {
  key: 'max_x2',
  name: 'Max ×2',
  monthlyCreditAllotment: 60000,
};

/** A free org: no AI plan, out of trial credits (balance 0 → the paywall's
 *  proactive `blocked` threshold + the tier-gate variant). */
export function freeOrgState(balance = 0): BillingFixtureEntry {
  return {
    balance,
    tier: null,
    subscription: { status: null, currentPeriodEnd: null, priceId: null, planTier: null },
  };
}

/** A paid org on an active AI plan with the given tier + balance. */
export function paidOrgState(opts?: {
  tier?: BillingFixtureTier;
  balance?: number;
  status?: string;
  priceLookupKey?: string;
  currentPeriodEnd?: string;
}): BillingFixtureEntry {
  const tier = opts?.tier ?? STANDARD_TIER;
  return {
    balance: opts?.balance ?? tier.monthlyCreditAllotment,
    tier,
    subscription: {
      status: opts?.status ?? 'active',
      currentPeriodEnd: opts?.currentPeriodEnd ?? '2026-12-01T00:00:00.000Z',
      priceId: opts?.priceLookupKey ?? 'standard_pool_monthly',
      planTier: tier,
    },
  };
}

export const TIERS = { standard: STANDARD_TIER, pro: PRO_TIER, maxX2: MAX_X2_TIER } as const;

function fixturePath(): string {
  const p = process.env['MOTIR_AI_BILLING_FIXTURE_PATH'];
  if (!p)
    throw new Error('MOTIR_AI_BILLING_FIXTURE_PATH not set — the billing E2E lane must define it');
  return p;
}

function readFixture(): BillingFixture {
  try {
    return JSON.parse(readFileSync(fixturePath(), 'utf8')) as BillingFixture;
  } catch {
    return {};
  }
}

/** Merge one org's state into the fixture file the boundary mock reads on every
 *  request. Re-callable mid-test (the webhook-landed simulation): the next
 *  authoritative read reflects the new state. */
export function setOrgBillingState(organizationId: string, entry: BillingFixtureEntry): void {
  const fixture = readFixture();
  fixture[organizationId] = entry;
  writeFileSync(fixturePath(), JSON.stringify(fixture), 'utf8');
}

/** Change PART of one org's state, keeping the rest — above all its `agents`
 *  ledger, which the app server's own debits have been writing (MOTIR-6924). */
export function patchOrgBillingState(
  organizationId: string,
  patch: Partial<BillingFixtureEntry>,
): void {
  const fixture = readFixture();
  fixture[organizationId] = { ...(fixture[organizationId] ?? freeOrgState()), ...patch };
  writeFileSync(fixturePath(), JSON.stringify(fixture), 'utf8');
}

/** Reset the fixture file to empty (every org free) — call in beforeEach so a
 *  prior test's state never leaks. */
export function resetBillingFixture(): void {
  writeFileSync(fixturePath(), '{}', 'utf8');
}

/**
 * Give an org a paid AI plan in the billing fixture — for a seed whose journey
 * spends Motir's fleet (a hosted run, a hosted repository) rather than testing
 * billing. The fleet is paid-AI-plan only (Story MOTIR-6906 · MOTIR-6909), so on
 * a cloud-on lane an org the fixture does not name reads as free and every door
 * that spends the fleet refuses it. A no-op on a lane with no billing fixture:
 * there the build is not cloud-billed and the gate answers yes by itself.
 *
 * Max ×2, not the default Standard (MOTIR-9363): every door now holds the org to
 * its plan's figures, and Standard's (1 agent run at once, 1 agent per person)
 * would refuse a journey that is not about the caps. A spec that IS about them
 * sets its own tier with {@link setOrgBillingState}.
 */
export function grantPaidAiPlanIfBilled(organizationId: string): void {
  if (!process.env['MOTIR_AI_BILLING_FIXTURE_PATH']) return;
  setOrgBillingState(organizationId, paidOrgState({ tier: MAX_X2_TIER }));
}
