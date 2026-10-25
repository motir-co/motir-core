'use server';

import { revalidatePath } from 'next/cache';
import { requirePlatformStaff } from '@/lib/platform/auth';
import {
  FleetOrgCiGithubWriteError,
  FleetOrgCiNotReadyError,
  FleetOrgCiTargetUnknownError,
  MissingAuditReasonError,
  NotPlatformStaffError,
} from '@/lib/platform/errors';
import { agentHostingSettingService } from '@/lib/services/agentHostingSettingService';
import { fleetOrgCiSettingService } from '@/lib/services/fleetOrgCiSettingService';

/**
 * The FLEET ORG CI flip — design `platform-admin/design-notes.md` § AMENDMENT
 * 2026-10 (Fleet settings), card MOTIR-8715, story MOTIR-8699.
 *
 * Transport only, the `ai-planning/actions.ts` shape: resolve the platform
 * principal, call ONE service method, translate the typed errors into the
 * discriminated result the island maps to its drawn states. Who may flip it,
 * the reason rule, the readiness check that blocks ON and the audit row live in
 * `fleetOrgCiSettingService.setEnabled`.
 *
 * ⚠️ THE GATE IS ASSERTED HERE AND AGAIN IN THE SERVICE. A Server Action is a
 * POST the `(admin)` layout never renders, so it resolves the principal itself.
 * The disabled switch on a not-ready page is presentation; the service's own
 * readiness read is the rule.
 *
 * ⚠️ A RESULT, NOT A THROW: a thrown error reaches the browser as a stripped
 * digest in production, and the page draws a different state for each answer.
 * No token, no raw GitHub body and no English readiness message is carried in a
 * result — the island renders every word from the catalogue.
 */

const PAGE = '/admin/fleet-settings';

export interface FleetOrgCiNotMetCondition {
  key: string;
  state: 'unmet' | 'unknown';
  reasonCode: string;
}

export type FleetOrgCiActionResult =
  | { ok: true; outcome: 'changed' }
  | { ok: true; outcome: 'unchanged'; enabled: boolean }
  | { ok: false; code: 'NOT_READY'; conditions: FleetOrgCiNotMetCondition[] }
  | {
      ok: false;
      code: 'GITHUB_WRITE_FAILED';
      org: string;
      status: number | null;
      operation: 'read' | 'set' | 'delete';
    }
  | { ok: false; code: 'REASON_REQUIRED' | 'NOT_PERMITTED' | 'TARGET_UNKNOWN' | 'FAILED' };

export async function setFleetOrgCiAction(
  projectId: string,
  org: string,
  enabled: boolean,
  reason: string,
): Promise<FleetOrgCiActionResult> {
  try {
    const principal = await requirePlatformStaff('superadmin');
    const flip = await fleetOrgCiSettingService.setEnabled(
      principal,
      { projectId, org },
      enabled,
      reason,
    );
    // The setting card and the readiness card are server-rendered props: the
    // re-read is what shows the new state, the last-changed line and GitHub's
    // read-back (`CLAUDE.md`'s page-state contract).
    revalidatePath(PAGE);
    if (flip.outcome === 'unchanged') {
      return { ok: true, outcome: 'unchanged', enabled: flip.state.enabled };
    }
    return { ok: true, outcome: 'changed' };
  } catch (err) {
    if (err instanceof FleetOrgCiNotReadyError) {
      // The verdict moved since the page loaded; the readiness card re-reads.
      revalidatePath(PAGE);
      return {
        ok: false,
        code: 'NOT_READY',
        conditions: err.conditions.map((c) => ({
          key: c.key,
          state: c.state,
          reasonCode: c.reasonCode,
        })),
      };
    }
    if (err instanceof FleetOrgCiGithubWriteError) {
      return {
        ok: false,
        code: 'GITHUB_WRITE_FAILED',
        org: err.org,
        status: err.status,
        operation: err.operation,
      };
    }
    if (err instanceof MissingAuditReasonError) return { ok: false, code: 'REASON_REQUIRED' };
    if (err instanceof NotPlatformStaffError) return { ok: false, code: 'NOT_PERMITTED' };
    if (err instanceof FleetOrgCiTargetUnknownError) return { ok: false, code: 'TARGET_UNKNOWN' };
    console.error('[admin] fleet org CI action failed', { projectId, org, enabled });
    return { ok: false, code: 'FAILED' };
  }
}

/**
 * The AGENT HOSTING flip — design `platform-admin/design-notes.md` § Fleet
 * settings · Agent hosting (MOTIR-9534), card MOTIR-9503. The same transport
 * shape as `setFleetOrgCiAction`: the principal, ONE service call, the typed
 * errors as a discriminated result. The switch has no readiness and no remote
 * write, so its refusals are the reason, the gate and anything else.
 */
export type AgentHostingActionResult =
  | { ok: true; outcome: 'changed' }
  | { ok: true; outcome: 'unchanged'; onPool: boolean }
  | { ok: false; code: 'REASON_REQUIRED' | 'NOT_PERMITTED' | 'FAILED' };

export async function setAgentHostingAction(
  onPool: boolean,
  reason: string,
): Promise<AgentHostingActionResult> {
  try {
    const principal = await requirePlatformStaff('superadmin');
    const flip = await agentHostingSettingService.setOnPool(principal, onPool, reason);
    // The section is a server-rendered prop: the re-read shows the new state
    // and its last-changed line (`CLAUDE.md`'s page-state contract).
    revalidatePath(PAGE);
    if (flip.outcome === 'unchanged') {
      return { ok: true, outcome: 'unchanged', onPool: flip.state.onPool };
    }
    return { ok: true, outcome: 'changed' };
  } catch (err) {
    if (err instanceof MissingAuditReasonError) return { ok: false, code: 'REASON_REQUIRED' };
    if (err instanceof NotPlatformStaffError) return { ok: false, code: 'NOT_PERMITTED' };
    console.error('[admin] agent hosting action failed', { onPool });
    return { ok: false, code: 'FAILED' };
  }
}
