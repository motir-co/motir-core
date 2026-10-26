import type { FleetWorkloadKind } from '@motir/orchestrator';

// A HOST ORGANISATION'S OWN AWS ACCOUNTS (Story MOTIR-9365 · MOTIR-9582). A Host
// organisation runs on three AWS accounts of its own, each created by the
// unattended add-shard and asked for its `L-1216C47A` quota at creation:
//   * the CI runner account          — `ci_runner`,                  200 vCPU;
//   * the agent runner account       — `hosted_agent`,                32 vCPU;
//   * ONE merged account             — `code_graph_index` + `agent_instance`,
//                                      120 vCPU, recorded as TWO rows naming one
//                                      AWS account (an account has one quota, so
//                                      one raise, on the first kind's row).
//
// Each name is derived from the organisation id, so a pass interrupted after
// `CreateAccount` recomputes the same name — and with it the member email — and
// FINDS the account instead of creating a second. Pure: no `db`, no `process.env`.

export type HostAccountSlot = 'ci_runner' | 'agent_runner' | 'merged';

export const HOST_ACCOUNT_SLOTS: readonly HostAccountSlot[] = [
  'ci_runner',
  'agent_runner',
  'merged',
];

/** The vCPU each Host account asks AWS for at creation — pre-launch targets,
 *  beside the shared pool's `POOL_ACCOUNT_RAISE_TARGET_VCPU`. */
export const HOST_ACCOUNT_RAISE_TARGET_VCPU: Readonly<Record<HostAccountSlot, number>> = {
  ci_runner: 200,
  agent_runner: 32,
  merged: 120,
};

export interface HostAccountRowPlan {
  name: string;
  fleetKind: FleetWorkloadKind;
}

export interface HostAccountPlan {
  slot: HostAccountSlot;
  /** The row the AWS account is created for, and its raise recorded against. */
  account: HostAccountRowPlan;
  /** The merged slot's second row: the same AWS account, another fleet kind. */
  sharedRow: HostAccountRowPlan | null;
  raiseTargetVcpu: number;
}

/** The organisation id as a name segment: lower case, `[a-z0-9-]` only. */
function orgSegment(organizationId: string): string {
  return organizationId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** `host-<org>-<suffix>` — a Host account row's name. */
function hostName(organizationId: string, suffix: string): string {
  return `host-${orgSegment(organizationId)}-${suffix}`;
}

/** What one slot of one organisation creates. */
export function hostAccountPlan(organizationId: string, slot: HostAccountSlot): HostAccountPlan {
  const raiseTargetVcpu = HOST_ACCOUNT_RAISE_TARGET_VCPU[slot];
  switch (slot) {
    case 'ci_runner':
      return {
        slot,
        account: { name: hostName(organizationId, 'ci'), fleetKind: 'ci_runner' },
        sharedRow: null,
        raiseTargetVcpu,
      };
    case 'agent_runner':
      return {
        slot,
        account: { name: hostName(organizationId, 'agent-runner'), fleetKind: 'hosted_agent' },
        sharedRow: null,
        raiseTargetVcpu,
      };
    case 'merged':
      return {
        slot,
        account: { name: hostName(organizationId, 'index'), fleetKind: 'code_graph_index' },
        sharedRow: { name: hostName(organizationId, 'agent-host'), fleetKind: 'agent_instance' },
        raiseTargetVcpu,
      };
  }
}
