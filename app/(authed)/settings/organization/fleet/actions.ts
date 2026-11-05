'use server';

import { getSession } from '@/lib/auth';
import { BillingForbiddenError, BillingNotAvailableError } from '@/lib/billing/errors';
import type {
  OrgFleetCancelRunOutcomeDTO,
  OrgFleetStopPreviewDTO,
  OrgFleetStopResultDTO,
} from '@/lib/dto/orgFleetStop';
import { OrgFleetInstanceNotFoundError, OrgFleetRunNotFoundError } from '@/lib/orgFleet/errors';
import { OrganizationNotFoundError } from '@/lib/organizations/errors';
import { orgFleetStopService } from '@/lib/services/orgFleetStopService';

// The Settings › Organization › Fleet page's stops (MOTIR-10369 · Story
// MOTIR-10363). Transport only: read the session, call exactly ONE stop-service
// method, and translate its typed errors into a result the island renders.
//
// ⚠️ WHO MAY STOP IS DECIDED IN THE SERVICE, never here: every service method
// starts with Billing & plans' view gate, so a plain member's call is refused there
// and arrives as `forbidden`. The org id comes from the page, and the service
// re-checks the caller's membership of exactly that org on every call.

export type FleetActionRefusal =
  | { ok: false; code: 'forbidden' }
  | { ok: false; code: 'notFound' }
  | { ok: false; code: 'failed' };

export type CancelRunActionResult =
  | { ok: true; outcome: OrgFleetCancelRunOutcomeDTO }
  | FleetActionRefusal;

export type HibernateActionResult =
  | { ok: true; code: 'hibernated'; at: string }
  | { ok: true; code: 'alreadyResting' }
  | { ok: true; code: 'inMotion' }
  | FleetActionRefusal;

export type PreviewActionResult =
  | { ok: true; preview: OrgFleetStopPreviewDTO; countedAt: string }
  | FleetActionRefusal;

export type StopEverythingActionResult =
  | { ok: true; result: OrgFleetStopResultDTO }
  | FleetActionRefusal;

const LOG = '[settings/organization/fleet]';

/** A refusal the island can say in words, or the fault rethrown as `failed`. */
function refusalOf(err: unknown, action: string): FleetActionRefusal {
  if (err instanceof BillingForbiddenError) return { ok: false, code: 'forbidden' };
  if (
    err instanceof OrganizationNotFoundError ||
    err instanceof BillingNotAvailableError ||
    err instanceof OrgFleetRunNotFoundError ||
    err instanceof OrgFleetInstanceNotFoundError
  ) {
    return { ok: false, code: 'notFound' };
  }
  console.error(`${LOG} ${action} failed`, {
    error: err instanceof Error ? err.name : 'UnknownError',
  });
  return { ok: false, code: 'failed' };
}

async function actorFor(organizationId: string) {
  const session = await getSession();
  if (!session) return null;
  return { organizationId, actorUserId: session.user.id };
}

export async function cancelHostedRunAction(
  organizationId: string,
  dispatchRunId: string,
): Promise<CancelRunActionResult> {
  const input = await actorFor(organizationId);
  if (!input) return { ok: false, code: 'forbidden' };
  try {
    return { ok: true, outcome: await orgFleetStopService.cancelHostedRun(input, dispatchRunId) };
  } catch (err) {
    return refusalOf(err, 'cancel run');
  }
}

export async function hibernateAgentAction(
  organizationId: string,
  instanceId: string,
): Promise<HibernateActionResult> {
  const input = await actorFor(organizationId);
  if (!input) return { ok: false, code: 'forbidden' };
  try {
    const outcome = await orgFleetStopService.hibernateAgent(input, instanceId);
    if (outcome.kind === 'hibernated') return { ok: true, code: 'hibernated', at: outcome.at };
    return { ok: true, code: outcome.kind === 'already_resting' ? 'alreadyResting' : 'inMotion' };
  } catch (err) {
    return refusalOf(err, 'hibernate agent');
  }
}

export async function previewStopEverythingAction(
  organizationId: string,
): Promise<PreviewActionResult> {
  const input = await actorFor(organizationId);
  if (!input) return { ok: false, code: 'forbidden' };
  try {
    const countedAt = new Date();
    const preview = await orgFleetStopService.previewStopEverything(input, countedAt);
    return { ok: true, preview, countedAt: countedAt.toISOString() };
  } catch (err) {
    return refusalOf(err, 'preview stop everything');
  }
}

export async function stopEverythingAction(
  organizationId: string,
): Promise<StopEverythingActionResult> {
  const input = await actorFor(organizationId);
  if (!input) return { ok: false, code: 'forbidden' };
  try {
    return { ok: true, result: await orgFleetStopService.stopEverything(input) };
  } catch (err) {
    return refusalOf(err, 'stop everything');
  }
}
