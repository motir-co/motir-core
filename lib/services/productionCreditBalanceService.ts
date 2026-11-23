import { idlePolicyRefusal } from '@motir/orchestrator';
import { getOrgUsage } from '@/lib/ai/motirAiClient';
import { HOSTED_IDLE_SECONDS_DEFAULT } from '@/lib/hosting/idlePolicy';
import type { HostedApplicationMeterTarget } from '@/lib/repositories/hostedApplicationRepository';

// THE ORGANISATION'S CREDIT BALANCE AS THE HOSTING PATHS READ IT (Story
// MOTIR-9799 · MOTIR-12108; Decision MOTIR-12100 §9): the live balance read, the
// below-zero test, whether an application can be switched to suspend when idle,
// and how long an always-on application may run below zero first.
//
// Its own module, and a deliberately LIGHT one (MOTIR-12168). The production
// usage meter is a system job, so `@/lib/jobs/registry` reaches it through the
// release path, and the docs-guard lane (`vitest.docs.config.ts`) imports that
// registry with no auth env and only a placeholder `DATABASE_URL`. These reads
// used to live in `productionUsageService`, whose user-facing read imports the
// panel service, whose graph reaches `@/lib/workspaces` → `@/lib/auth` — which
// throws at module scope without `BETTER_AUTH_SECRET`. Keep this file's imports
// to the motir-ai client, the orchestrator's rules and types: the meter, the
// idle-policy path and the Usage read all decide by it.

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long an always-on application may run below zero before it is switched
 *  to suspend when idle (Decision MOTIR-12100 §9). */
export const EXHAUSTED_SUSPEND_AFTER_MS = 7 * DAY_MS;

/** The organisation's credit balance, or null when motir-ai could not answer —
 *  never 0 and never a throw: an outage must not read as exhaustion. */
async function readOrganizationBalance(organizationId: string): Promise<number | null> {
  try {
    const usage = await getOrgUsage({ coreOrganizationId: organizationId, scope: 'org' });
    return typeof usage.balance === 'number' ? usage.balance : null;
  } catch (error) {
    console.warn('[productionCreditBalanceService] could not read an organisation’s balance', {
      organizationId,
      error: error instanceof Error ? error.name : 'UNKNOWN',
    });
    return null;
  }
}

/**
 * Whether the organisation is below zero now: the live balance when it can be
 * read, otherwise the meter's stored transition (`storedSince`). The
 * always-on refusal and the Usage read both decide by it.
 */
async function isBelowZero(
  organizationId: string,
  storedSince: Date | null,
): Promise<{ below: boolean; balance: number | null }> {
  const balance = await readOrganizationBalance(organizationId);
  return { below: balance === null ? storedSince !== null : balance < 0, balance };
}

/** Whether the application's target and shape can run suspend-when-idle. */
function canSuspend(app: Pick<HostedApplicationMeterTarget, 'target' | 'hostingShape'>): boolean {
  return (
    idlePolicyRefusal(app.target, app.hostingShape, {
      mode: 'suspend',
      idleSeconds: HOSTED_IDLE_SECONDS_DEFAULT,
    }) === null
  );
}

export const productionCreditBalanceService = {
  readOrganizationBalance,
  isBelowZero,
  canSuspend,
};
