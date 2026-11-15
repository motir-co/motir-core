import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import {
  MissingAuditReasonError,
  NotPlatformStaffError,
  PlatformCreditAmountInvalidError,
  PlatformCreditConflictError,
  PlatformCreditInsufficientBalanceError,
  PlatformCreditRejectedError,
  PlatformCreditServiceUnavailableError,
  PlatformLargeGrantUnconfirmedError,
  PlatformOrganizationNotFoundError,
} from '@/lib/platform/errors';
import {
  CREDIT_LEDGER_PAGE_SIZE,
  LARGE_GRANT_THRESHOLD_CREDITS,
  platformCreditOpsService,
} from '@/lib/services/platformCreditOpsService';
import { _resetAiPlanCache } from '@/lib/services/aiPlanGateService';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

/**
 * Staff CREDIT & PLAN OPS (Story 10.3 · MOTIR-747) — the motir-core half.
 *
 * Real Postgres for the org and the audit trail, motir-ai stubbed at `fetch` with
 * the bodies its contract documents (motir-ai's own suites own the ledger). The
 * property under test is design rule 6 — *the write and its audit row share one
 * outcome* — so every refusal is checked against the AUDIT ROW COUNT and against
 * whether motir-ai was asked at all, not just the thrown type.
 */

vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  return {
    ...actual,
    requirePlatformStaff: vi.fn(
      async (minimum: 'support' | 'operator' | 'superadmin' = 'support') => {
        if (!currentPrincipal) throw new NotPlatformStaffError();
        if (!actual.platformRoleAtLeast(currentPrincipal.role, minimum)) {
          throw new NotPlatformStaffError();
        }
        return currentPrincipal;
      },
    ),
  };
});

let currentPrincipal: PlatformPrincipal | null = null;

async function seedStaff(role: 'support' | 'operator' | 'superadmin') {
  const user = await createTestUser({
    email: `ops+credit-${role}@moooon.net`,
    name: `Ops ${role}`,
  });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return { userId: user.id, email: user.email, role } satisfies PlatformPrincipal;
}

async function seedOrg() {
  return adminDb.organization.create({
    data: { name: 'Northwind Labs', slug: `northwind-${Math.random().toString(36).slice(2, 8)}` },
  });
}

/** The stubbed ledger motir-ai holds. */
let balance = 0;
let tierKey: string | null = 'free';
let unreachable = false;
/** A problem the NEXT write answers with, instead of writing. */
let writeProblem: { status: number; code: string; detail: string } | null = null;
const writes: { path: string; body: Record<string, unknown> }[] = [];
const seenRequestIds = new Set<string>();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

const TIER = (key: string) => ({
  key,
  name: key.toUpperCase(),
  cadence: 'monthly',
  allotmentCredits: 8000,
});

const fetchStub = vi.fn(async (url: string, init: RequestInit) => {
  if (unreachable) throw new TypeError('fetch failed');
  const u = new URL(url);
  if (init.method === 'GET' && u.pathname === '/v1/admin/ledger') {
    return json({
      known: true,
      coreOrganizationId: u.searchParams.get('coreOrganizationId'),
      balanceCredits: balance,
      tier: tierKey ? TIER(tierKey) : null,
      lastTierAssignment: null,
      entries: [
        {
          id: 'ctx_1',
          at: '2026-10-03T09:00:00.000Z',
          kind: 'debit',
          credits: -12,
          balanceAfter: balance,
          reason: 'planning',
          actor: null,
          externalRef: 'job:1',
        },
      ],
      nextCursor: u.searchParams.get('limit') === '1' ? 'c1' : null,
    });
  }
  const body = JSON.parse(String(init.body)) as Record<string, unknown>;
  writes.push({ path: u.pathname, body });
  if (writeProblem) {
    const { status, code, detail } = writeProblem;
    return json({ type: 'about:blank', title: code, status, code, detail }, status);
  }
  const requestId = String(body['requestId']);
  const idempotent = seenRequestIds.has(requestId);
  seenRequestIds.add(requestId);
  if (u.pathname === '/v1/admin/credits') {
    if (!idempotent) balance += Number(body['credits']);
    return json({
      coreOrganizationId: body['coreOrganizationId'],
      transaction: {
        id: `ctx_${requestId}`,
        at: '2026-10-03T09:12:44.120Z',
        kind: body['kind'],
        credits: body['credits'],
        balanceAfter: balance,
        reason: body['reason'],
        actor: body['actor'],
        externalRef: `${String(body['kind'])}:staff:${requestId}`,
      },
      balanceCredits: balance,
      idempotent,
    });
  }
  const from = tierKey;
  tierKey = String(body['tierKey']);
  return json({
    coreOrganizationId: body['coreOrganizationId'],
    assignment: {
      id: `pta_${requestId}`,
      at: '2026-10-03T09:15:02.004Z',
      fromTierKey: from,
      toTierKey: tierKey,
      reason: body['reason'],
      actor: body['actor'],
    },
    tier: TIER(tierKey),
    changed: from !== tierKey,
    idempotent,
  });
});

async function auditRows() {
  return adminDb.platformAuditLog.findMany({ orderBy: { seq: 'asc' } });
}

let orgId: string;
let orgSlug: string;

beforeEach(async () => {
  process.env['MOTIR_AI_URL'] = 'https://ai.example.test';
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
  vi.stubGlobal('fetch', fetchStub);
  fetchStub.mockClear();
  writes.length = 0;
  seenRequestIds.clear();
  balance = 1250;
  tierKey = 'free';
  unreachable = false;
  writeProblem = null;
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  currentPrincipal = await seedStaff('superadmin');
  const org = await seedOrg();
  orgId = org.id;
  orgSlug = org.slug;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('grantCredits', () => {
  it('grants, sends the contract body, and writes ONE org.credit_grant row with before → after', async () => {
    const out = await platformCreditOpsService.grantCredits(currentPrincipal!, orgId, {
      credits: 500,
      reason: '  Goodwill for the outage  ',
      requestId: 'adm_req_1',
    });

    expect(out).toMatchObject({
      organizationId: orgId,
      balanceCredits: 1750,
      idempotent: false,
      requestId: 'adm_req_1',
      entry: { kind: 'grant', credits: 500, balanceAfter: 1750 },
    });
    expect(out.entry).not.toHaveProperty('externalRef');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({
      path: '/v1/admin/credits',
      body: {
        coreOrganizationId: orgId,
        kind: 'grant',
        credits: 500,
        reason: 'Goodwill for the outage',
        requestId: 'adm_req_1',
        actor: {
          userId: currentPrincipal!.userId,
          label: `Ops superadmin <${currentPrincipal!.email}>`,
        },
      },
    });

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'org.credit_grant',
      targetKind: 'organization',
      targetId: orgId,
      organizationId: orgId,
      reason: 'Goodwill for the outage',
      metadata: { requestId: 'adm_req_1', credits: 500, balanceBefore: 1250, balanceAfter: 1750 },
    });
  });

  it('mints a requestId when none is given', async () => {
    const out = await platformCreditOpsService.grantCredits(currentPrincipal!, orgId, {
      credits: 5,
      reason: 'r',
    });
    expect(out.requestId).toMatch(/^adm_/);
    expect(writes[0]!.body['requestId']).toBe(out.requestId);
  });

  it('a retry with the same requestId replays: no second ledger row, idempotent: true', async () => {
    const input = { credits: 100, reason: 'Retry me', requestId: 'adm_same' };
    await platformCreditOpsService.grantCredits(currentPrincipal!, orgId, input);
    const again = await platformCreditOpsService.grantCredits(currentPrincipal!, orgId, input);
    expect(again.idempotent).toBe(true);
    expect(balance).toBe(1350);
  });

  it.each([0, -5, 1.5, 3_000_000_000])(
    'refuses an amount of %s before anything is sent',
    async (credits) => {
      await expect(
        platformCreditOpsService.grantCredits(currentPrincipal!, orgId, { credits, reason: 'x' }),
      ).rejects.toBeInstanceOf(PlatformCreditAmountInvalidError);
      expect(fetchStub).not.toHaveBeenCalled();
      expect(await auditRows()).toHaveLength(0);
    },
  );

  it('a blank reason is refused with no row and no remote call', async () => {
    await expect(
      platformCreditOpsService.grantCredits(currentPrincipal!, orgId, {
        credits: 5,
        reason: '   ',
      }),
    ).rejects.toBeInstanceOf(MissingAuditReasonError);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(await auditRows()).toHaveLength(0);
  });

  it.each(['support', 'operator'] as const)('a %s cannot grant', async (role) => {
    currentPrincipal = await seedStaff(role);
    await expect(
      platformCreditOpsService.grantCredits(currentPrincipal, orgId, { credits: 5, reason: 'x' }),
    ).rejects.toBeInstanceOf(NotPlatformStaffError);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('a LARGE grant needs the slug typed back; without it nothing is written or recorded', async () => {
    await expect(
      platformCreditOpsService.grantCredits(currentPrincipal!, orgId, {
        credits: LARGE_GRANT_THRESHOLD_CREDITS,
        reason: 'Big one',
        confirmSlug: 'wrong',
      }),
    ).rejects.toBeInstanceOf(PlatformLargeGrantUnconfirmedError);
    expect(writes).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);

    const ok = await platformCreditOpsService.grantCredits(currentPrincipal!, orgId, {
      credits: LARGE_GRANT_THRESHOLD_CREDITS,
      reason: 'Big one',
      confirmSlug: orgSlug,
    });
    expect(ok.balanceCredits).toBe(1250 + LARGE_GRANT_THRESHOLD_CREDITS);
    expect(await auditRows()).toHaveLength(1);
  });

  it('an unknown org is refused BEFORE motir-ai is asked to write (it would provision one)', async () => {
    await expect(
      platformCreditOpsService.grantCredits(currentPrincipal!, 'org_does_not_exist', {
        credits: 5,
        reason: 'x',
      }),
    ).rejects.toBeInstanceOf(PlatformOrganizationNotFoundError);
    expect(writes).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it('an unreachable credit service leaves neither a grant nor a row', async () => {
    unreachable = true;
    await expect(
      platformCreditOpsService.grantCredits(currentPrincipal!, orgId, { credits: 5, reason: 'x' }),
    ).rejects.toBeInstanceOf(PlatformCreditServiceUnavailableError);
    expect(await auditRows()).toHaveLength(0);
  });

  it('a refused write (conflict) rolls the audit row back with it', async () => {
    writeProblem = { status: 409, code: 'conflict', detail: 'org_erased: org_abc was offboarded' };
    const err = await platformCreditOpsService
      .grantCredits(currentPrincipal!, orgId, { credits: 5, reason: 'x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformCreditConflictError);
    expect((err as PlatformCreditConflictError).detail).toContain('org_erased');
    expect(writes).toHaveLength(1);
    expect(await auditRows()).toHaveLength(0);
  });
});

describe('adjustCredits', () => {
  it('a signed adjustment moves the balance and writes org.credit_adjust', async () => {
    const out = await platformCreditOpsService.adjustCredits(currentPrincipal!, orgId, {
      credits: -250,
      reason: 'Double-charged run',
    });
    expect(out.balanceCredits).toBe(1000);
    expect(writes[0]!.body).toMatchObject({ kind: 'adjustment', credits: -250 });
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'org.credit_adjust',
      metadata: { credits: -250, balanceBefore: 1250, balanceAfter: 1000 },
    });
  });

  it('refuses zero', async () => {
    await expect(
      platformCreditOpsService.adjustCredits(currentPrincipal!, orgId, { credits: 0, reason: 'x' }),
    ).rejects.toBeInstanceOf(PlatformCreditAmountInvalidError);
  });

  it('an adjustment that would overdraw the SEEN balance is refused before the trail is touched', async () => {
    const err = await platformCreditOpsService
      .adjustCredits(currentPrincipal!, orgId, { credits: -1251, reason: 'x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformCreditInsufficientBalanceError);
    expect((err as PlatformCreditInsufficientBalanceError).balanceCredits).toBe(1250);
    expect(writes).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it("motir-ai's own insufficient_balance refusal (the balance moved) maps to the same typed error", async () => {
    writeProblem = { status: 409, code: 'conflict', detail: 'insufficient_balance: 10 < 20' };
    await expect(
      platformCreditOpsService.adjustCredits(currentPrincipal!, orgId, {
        credits: -20,
        reason: 'x',
      }),
    ).rejects.toBeInstanceOf(PlatformCreditInsufficientBalanceError);
    expect(await auditRows()).toHaveLength(0);
  });
});

describe('setPlan', () => {
  it('assigns the tier and records org.plan_set from → to', async () => {
    const out = await platformCreditOpsService.setPlan(currentPrincipal!, orgId, {
      tierKey: 'pro',
      reason: 'Sales upgrade INV-204',
      requestId: 'adm_tier_1',
    });
    expect(out).toMatchObject({
      changed: true,
      idempotent: false,
      tier: { key: 'pro' },
      assignment: { fromTierKey: 'free', toTierKey: 'pro' },
    });
    expect(writes[0]).toMatchObject({ path: '/v1/admin/tier', body: { tierKey: 'pro' } });
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'org.plan_set',
      metadata: { requestId: 'adm_tier_1', fromTierKey: 'free', toTierKey: 'pro' },
    });
  });

  it('an unknown tier (validation_error) is a typed rejection with no row', async () => {
    writeProblem = { status: 400, code: 'validation_error', detail: 'unknown tierKey "gold"' };
    await expect(
      platformCreditOpsService.setPlan(currentPrincipal!, orgId, { tierKey: 'gold', reason: 'x' }),
    ).rejects.toBeInstanceOf(PlatformCreditRejectedError);
    expect(await auditRows()).toHaveLength(0);
  });

  it('a blank tier key is refused before anything is sent', async () => {
    await expect(
      platformCreditOpsService.setPlan(currentPrincipal!, orgId, { tierKey: ' ', reason: 'x' }),
    ).rejects.toBeInstanceOf(PlatformCreditRejectedError);
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe('paidAiPlanAnswer — what the plan dialog warns from (MOTIR-8985)', () => {
  /** motir-ai's subscription read for an org with no Stripe subscription — the
   *  EMPTY shape, whatever tier staff assigned. */
  function stubNoSubscription(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({ status: null, currentPeriodEnd: null, priceId: null, planTier: null }),
      ),
    );
  }

  beforeEach(() => {
    _resetAiPlanCache();
    vi.stubEnv('MOTIR_CLOUD', 'true');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('is the gate’s own answer: no subscription is not paid, whatever the tier', async () => {
    stubNoSubscription();
    expect(await platformCreditOpsService.paidAiPlanAnswer(orgId)).toBe(false);
  });

  it('an internal-billing org is paid, without asking motir-ai', async () => {
    await adminDb.organization.update({ where: { id: orgId }, data: { internalBilling: true } });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await platformCreditOpsService.paidAiPlanAnswer(orgId)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('is staff-only, like every read on the page', async () => {
    currentPrincipal = null;
    await expect(platformCreditOpsService.paidAiPlanAnswer(orgId)).rejects.toBeInstanceOf(
      NotPlatformStaffError,
    );
  });
});

describe('getLedger', () => {
  it('any staff role reads one page; it is ONE audited estate.read', async () => {
    currentPrincipal = await seedStaff('support');
    const page = await platformCreditOpsService.getLedger(currentPrincipal, orgId);
    expect(page).toMatchObject({
      organizationId: orgId,
      known: true,
      balanceCredits: 1250,
      tier: { key: 'free' },
      explainsCurrentTier: false,
      largeGrantThresholdCredits: LARGE_GRANT_THRESHOLD_CREDITS,
    });
    expect(page.entries[0]).toEqual({
      id: 'ctx_1',
      at: '2026-10-03T09:00:00.000Z',
      kind: 'debit',
      credits: -12,
      balanceAfter: 1250,
      reason: 'planning',
      actor: null,
    });
    const url = new URL(String(fetchStub.mock.calls[0]![0]));
    expect(url.searchParams.get('limit')).toBe(String(CREDIT_LEDGER_PAGE_SIZE));
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'estate.read', targetId: orgId, reason: null });
  });

  it('an unreachable credit service is a typed error and leaves no row', async () => {
    unreachable = true;
    await expect(
      platformCreditOpsService.getLedger(currentPrincipal!, orgId),
    ).rejects.toBeInstanceOf(PlatformCreditServiceUnavailableError);
    expect(await auditRows()).toHaveLength(0);
  });

  it('an unknown org is not found and leaves no row', async () => {
    await expect(
      platformCreditOpsService.getLedger(currentPrincipal!, 'org_nope'),
    ).rejects.toBeInstanceOf(PlatformOrganizationNotFoundError);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(await auditRows()).toHaveLength(0);
  });
});
