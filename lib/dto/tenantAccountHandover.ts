import type {
  HostingTenantAccountState,
  TenantHandoverStep,
  TenantHandoverStepStatus,
} from '@/lib/ciFleet/hostingTenantAccounts';

// THE TAKEOVER HANDOVER'S CHECKLIST (Story MOTIR-9800 · MOTIR-12131) — what
// `tenantAccountHandoverService.status` answers and the handover screen draws.
//
// ⚠️ IT NEVER CARRIES the owner's email address, the one-time code, a payment
// detail or a root credential: the address is typed by the admin and kept only
// so a resumed step can re-send it to AWS; the code is passed straight to AWS
// and never stored. `tests/hosting/tenantAccountHandoverService.test.ts` feeds a
// sentinel code through `submitEmailCode` and asserts it appears in no answer.

/** One step of the handover, in run order. */
export interface TenantHandoverStepDto {
  step: TenantHandoverStep;
  status: TenantHandoverStepStatus;
  /** The typed error's code and message when the step `failed`, else null. */
  lastError: string | null;
  /** What a `waiting_on_you` step waits on the new owner for: AWS's unmet
   *  standalone requirements (`wait_period`, `delegated_administrator`,
   *  `payment_method`, `support_plan`, `contact_information`) or AWS's reason
   *  for refusing the removal. Empty otherwise. */
  missing: string[];
  attempts: number;
  completedAt: string | null;
}

/** One customer domain the new owner repoints, and where to. */
export interface TenantHandoverDomainDto {
  host: string;
  upstreamAddress: string | null;
}

/** One production application in the account. */
export interface TenantHandoverApplicationDto {
  applicationId: string;
  slug: string;
  state: 'live' | 'handing_over' | 'grace' | 'handed_over';
  /** The address its own front door answers on without Motir, once opened. */
  upstreamAddress: string | null;
  /** The customer domains still bound to it, each with its upstream. */
  customerDomains: TenantHandoverDomainDto[];
}

export interface TenantAccountHandoverDto {
  tenantAccountId: string;
  organizationId: string;
  state: HostingTenantAccountState;
  /** The AWS account id the organisation receives. */
  awsAccountId: string | null;
  /** The handover deploy role the repositories' workflows assume, once made. */
  deployRoleArn: string | null;
  steps: TenantHandoverStepDto[];
  applications: TenantHandoverApplicationDto[];
}

/** One AWS-target repository of the organisation, as the Repositories room
 *  lists it in the handover step (MOTIR-12137). */
export interface TenantHandoverRepositoryDto {
  id: string;
  name: string;
  /** `owner/name` of the realized repository, or null before it exists. */
  repoRef: string | null;
  projectName: string;
}

/** What the Repositories room reads of the organisation's AWS hosting
 *  (MOTIR-12137), for an organisation admin only: the AWS-target repositories
 *  handed over together and, once a handover has started, which one. */
export interface TenantHandoverRoomDto {
  organizationId: string;
  /** The organisation's tenant account, or null when it has none. */
  tenantAccountId: string | null;
  accountState: HostingTenantAccountState | null;
  /** Whether a handover has started on the account (it is in a handover
   *  state): the room then shows its checklist, not the entry. */
  handoverStarted: boolean;
  /** Every AWS-target repository of the organisation, oldest first. */
  repositories: TenantHandoverRepositoryDto[];
}
