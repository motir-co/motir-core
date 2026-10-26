// A HOST ORGANISATION'S OWN ACCOUNT, BY STATE (Story MOTIR-9365 · MOTIR-9585).
// Each own account moves through four states, and never back:
//   * created          — the row exists (`createdAt`);
//   * quota_requested  — a quota raise for the account is recorded;
//   * granted          — one of its raises reads a granted value;
//   * live             — that value fits one job (`LIVE_MIN_VCPU`) AND the
//                        account's network is built.
// A denied or not-approved raise reads no granted value, so the account stays at
// quota_requested until a later raise is granted. Pure: no `db`, no `process.env`.

export type HostAccountState = 'created' | 'quota_requested' | 'granted' | 'live';

export const HOST_ACCOUNT_STATES: readonly HostAccountState[] = [
  'created',
  'quota_requested',
  'granted',
  'live',
];

/** One job's size: every fleet kind boots the fleet machine class, 2 vCPU
 *  (`FLEET_CONTAINER_SIZE` in `@motir/orchestrator`'s rates). */
export const LIVE_MIN_VCPU = 2;

export interface HostAccountFacts {
  /** A quota raise for the account is recorded. */
  hasRequest: boolean;
  /** The largest granted value among its raises; null while none reads one. */
  grantedVcpu: number | null;
  /** The account's network step succeeded. */
  networkBuilt: boolean;
}

/** The state three facts put an account in. */
export function deriveAccountState(facts: HostAccountFacts): HostAccountState {
  if (facts.grantedVcpu !== null) {
    return facts.grantedVcpu >= LIVE_MIN_VCPU && facts.networkBuilt ? 'live' : 'granted';
  }
  return facts.hasRequest ? 'quota_requested' : 'created';
}

/** The state the stored entry times record — the latest one set. */
export function stateFromTimes(times: {
  quotaRequestedAt: Date | null;
  grantedAt: Date | null;
  liveAt: Date | null;
}): HostAccountState {
  if (times.liveAt) return 'live';
  if (times.grantedAt) return 'granted';
  return times.quotaRequestedAt ? 'quota_requested' : 'created';
}

/** Is `state` at or past `step`? */
export function reached(state: HostAccountState, step: HostAccountState): boolean {
  return HOST_ACCOUNT_STATES.indexOf(state) >= HOST_ACCOUNT_STATES.indexOf(step);
}
