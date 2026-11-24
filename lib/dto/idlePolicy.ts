import type { HostedIdlePolicy } from '@/lib/hosting/idlePolicy';
import type { HostingShape, HostingTarget } from '@/lib/hosting/vocabulary';

// An application's IDLE POLICY as the Production panel reads it (Story MOTIR-9799
// · MOTIR-12107), from `GET …/repositories/[rowId]/production/idle-policy` and as
// the answer to its `PUT`.

/** The policy the application's target and shape cannot run — today a suspend
 *  policy on an AWS container — so the panel can say why before anyone asks. */
export interface IdlePolicyRefusalDto {
  /** The deploy port's code for the refusal. */
  code: 'HOSTING_IDLE_POLICY_UNSUPPORTED';
  target: HostingTarget;
  shape: HostingShape | null;
  /** The mode it refuses. */
  mode: HostedIdlePolicy['mode'];
}

export interface IdlePolicyDto {
  /** The policy the application runs; null while the repository has no
   *  production application yet. */
  policy: HostedIdlePolicy | null;
  /** Whether the viewer may change it: a project administrator, on an
   *  application that exists. The service stays the authority. */
  editable: boolean;
  /** The policy its target refuses, or null when it can run either. */
  refusal: IdlePolicyRefusalDto | null;
}
