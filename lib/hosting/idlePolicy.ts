import { idlePolicyRefusal, type ReleaseIdlePolicy } from '@motir/orchestrator';
import { InvalidIdlePolicyError } from './errors';
import type { HostingShape, HostingTarget } from './vocabulary';

// A hosted application's IDLE POLICY (Story MOTIR-9799 · MOTIR-12107): whether
// its production release stays always on or suspends after a quiet window. The
// value is the deploy port's own `ReleaseIdlePolicy`, stored on the application
// as two columns (`idle_mode`, `idle_seconds`) and passed to every production
// deploy.
//
// ⚠️ WHICH TARGET CAN HONOUR WHICH POLICY IS THE PORT'S RULE, NOT THIS FILE'S.
// `idlePolicyRefusal` (orchestrator `hosting/shape.ts`) is the one statement of
// it, and the adapters refuse through the same function, so the default below
// and the service's check before there is a release read exactly what a deploy
// would refuse. Today that is one pair: an AWS container runs always on only.

/** The policy a hosted application runs — the port's value, verbatim. */
export type HostedIdlePolicy = ReleaseIdlePolicy;
export type HostedIdleMode = HostedIdlePolicy['mode'];

export const HOSTED_IDLE_MODES = [
  'always_on',
  'suspend',
] as const satisfies readonly HostedIdleMode[];

/** The quiet window a suspend policy starts with: the one previews use, so a
 *  production app and its previews sleep alike. Fly ignores the number (it
 *  auto-stops on its own measure); serverless and AWS functions are billed per
 *  request either way. */
export const HOSTED_IDLE_SECONDS_DEFAULT = 300;

/** The window an administrator may set: one minute to one day. Under a minute
 *  a waking app would serve cold starts between ordinary requests; over a day
 *  "suspend" stops meaning anything a person would choose it for. */
export const HOSTED_IDLE_SECONDS_MIN = 60;
export const HOSTED_IDLE_SECONDS_MAX = 86_400;

/** A new application's policy: suspend when idle, wherever its target's shape
 *  can — an AWS container runs always on only, so it starts there. */
export function defaultIdlePolicy(
  target: HostingTarget,
  shape: HostingShape | null,
): HostedIdlePolicy {
  const suspend: HostedIdlePolicy = { mode: 'suspend', idleSeconds: HOSTED_IDLE_SECONDS_DEFAULT };
  return idlePolicyRefusal(target, shape, suspend) ? { mode: 'always_on' } : suspend;
}

/** The policy two stored columns hold. The table's CHECK guarantees the seconds
 *  exist exactly when the mode is `suspend`; a row that somehow breaks it reads
 *  as the default window rather than as a policy with no window. */
export function idlePolicyOfRow(row: {
  idleMode: HostedIdleMode;
  idleSeconds: number | null;
}): HostedIdlePolicy {
  return row.idleMode === 'suspend'
    ? { mode: 'suspend', idleSeconds: row.idleSeconds ?? HOSTED_IDLE_SECONDS_DEFAULT }
    : { mode: 'always_on' };
}

/** The two columns a policy is stored as. */
export function idlePolicyColumns(policy: HostedIdlePolicy): {
  idleMode: HostedIdleMode;
  idleSeconds: number | null;
} {
  return policy.mode === 'suspend'
    ? { idleMode: 'suspend', idleSeconds: policy.idleSeconds }
    : { idleMode: 'always_on', idleSeconds: null };
}

/** Whether two policies are the same policy. */
export function sameIdlePolicy(a: HostedIdlePolicy, b: HostedIdlePolicy): boolean {
  if (a.mode !== b.mode) return false;
  return a.mode === 'always_on' || a.idleSeconds === (b as typeof a).idleSeconds;
}

/**
 * A request body's policy: `{ mode: 'always_on' }`, or `{ mode: 'suspend' }`
 * with an optional whole `idleSeconds` from one minute to one day (the default
 * window when absent). Anything else is {@link InvalidIdlePolicyError}.
 */
export function parseIdlePolicy(body: unknown): HostedIdlePolicy {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new InvalidIdlePolicyError('body');
  }
  const { mode, idleSeconds } = body as { mode?: unknown; idleSeconds?: unknown };
  if (mode === 'always_on') {
    if (idleSeconds !== undefined && idleSeconds !== null) {
      throw new InvalidIdlePolicyError('idleSeconds');
    }
    return { mode: 'always_on' };
  }
  if (mode !== 'suspend') throw new InvalidIdlePolicyError('mode');
  if (idleSeconds === undefined || idleSeconds === null) {
    return { mode: 'suspend', idleSeconds: HOSTED_IDLE_SECONDS_DEFAULT };
  }
  if (
    typeof idleSeconds !== 'number' ||
    !Number.isInteger(idleSeconds) ||
    idleSeconds < HOSTED_IDLE_SECONDS_MIN ||
    idleSeconds > HOSTED_IDLE_SECONDS_MAX
  ) {
    throw new InvalidIdlePolicyError('idleSeconds');
  }
  return { mode: 'suspend', idleSeconds };
}
