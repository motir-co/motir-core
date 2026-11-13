// THE SERVICES PAGE'S DTO (MOTIR-10890, design MOTIR-10889): what
// `platformServicesService.read` judged from one read of cluster `motir-core`
// and the Fargate On-Demand vCPU quota. The page renders what is here and
// decides nothing.
//
// ⚠️ A FIGURE AWS DID NOT ANSWER FOR IS NOT A NUMBER HERE. An unread cluster is
// `{ status: 'failed' }` with no row and no total; an unread quota is
// `{ status: 'notRead' }` with no value. Nothing is defaulted to 0.

/** How a service's tasks stand. */
export type PlatformServiceTasksState =
  /** running = desired, desired > 0 */
  | 'full'
  /** a deployment is rolling: old and new tasks run side by side */
  | 'rolling'
  /** running < desired and not rolling */
  | 'short'
  /** desired 0 and running 0 — not a failure */
  | 'scaledToZero';

/** How a service's deployment stands. */
export type PlatformServiceDeploymentState =
  /** one deployment, running = desired */
  | 'steady'
  /** more than one deployment, or the PRIMARY's rollout IN_PROGRESS */
  | 'rolling'
  /** the PRIMARY's rollout FAILED */
  | 'failed'
  /** one deployment, but running < desired — never "Steady" beside a warning */
  | 'notRolling';

/** Why a service's version could not be judged (MOTIR-11112). */
export type PlatformServiceVersionUnknownReason =
  /** The running image carries no tag that is a 40-hex commit SHA. */
  | 'no_sha_tag'
  /** ECR did not answer for the image's tags. */
  | 'ecr_not_read'
  /** GitHub did not answer the comparison. */
  | 'github_not_read'
  /** No source repository is mapped for the image repository. */
  | 'source_not_mapped';

/** Where `behind` stands against the merge → CI → deploy window: `fresh` while
 *  the oldest undeployed commit is under 45 minutes old, `stale` from then on. */
export type PlatformServiceBehindSeverity = 'fresh' | 'stale';

/** One deployment's commit, judged against its repository's default branch head. */
export type PlatformServiceVersionJudgementDTO =
  /** The deployed commit IS the default branch head. */
  | { state: 'latest' }
  /** The head has `count` commits the deployed one lacks. */
  | {
      state: 'behind';
      count: number;
      /** The committer date of the oldest undeployed commit, ISO. */
      oldestUndeployedAt: string;
      severity: PlatformServiceBehindSeverity;
      /** GitHub's compare of the deployed commit with the default branch. */
      compareUrl: string;
    }
  /** The deployed commit is not on the default branch (a branch deploy). */
  | { state: 'diverged' }
  | { state: 'unknown'; reason: PlatformServiceVersionUnknownReason };

/** A service's version: its PRIMARY deployment's judgement, wrapped in
 *  `rolling` while a deployment is in progress (`deployment.state`). */
export type PlatformServiceVersionDTO =
  | PlatformServiceVersionJudgementDTO
  | { state: 'rolling'; primary: PlatformServiceVersionJudgementDTO };

/** The commit the PRIMARY deployment's image was built from. */
export interface PlatformServiceCommitDTO {
  /** The full 40-hex SHA. */
  sha: string;
  /** The source repository's name (`motir-core`), or null when none is mapped. */
  repository: string | null;
  /** The commit on GitHub, or null when no source repository is mapped. */
  url: string | null;
}

export interface PlatformServiceRowDTO {
  name: string;
  /** The current (PRIMARY) task definition. */
  family: string;
  revision: number;
  running: number;
  desired: number;
  /** Desired − running, when short of tasks; 0 otherwise. */
  notStarted: number;
  tasks: PlatformServiceTasksState;
  /** CPU units ÷ 1024 of the current task definition. */
  vcpuPerTask: number;
  memoryMib: number;
  /** Every deployment's running tasks × its own task definition's vCPU. */
  vcpu: number;
  /** Do all running tasks share the current task definition's size? The
   *  `{running} × {perTask}` line is exact only then. */
  uniformSize: boolean;
  deployment: {
    state: PlatformServiceDeploymentState;
    /** The draining deployment's revision while rolling or failed; else null. */
    fromRevision: number | null;
    /** The PRIMARY deployment's revision. */
    toRevision: number;
    /** The PRIMARY deployment's running and desired tasks. */
    newRunning: number;
    newDesired: number;
    /** Running tasks of every non-PRIMARY deployment. */
    oldRunning: number;
    /** When the PRIMARY deployment started, ISO. */
    startedAt: string | null;
  };
  /** The PRIMARY deployment's commit, or null when none resolved (MOTIR-11112). */
  commit: PlatformServiceCommitDTO | null;
  /** Whether that commit is its repository's latest (MOTIR-11112). */
  version: PlatformServiceVersionDTO;
}

export interface PlatformServicesTotalDTO {
  services: number;
  running: number;
  desired: number;
  /** Exactly the sum of the rows' `vcpu`. */
  vcpu: number;
}

export type PlatformServicesClusterDTO =
  | {
      status: 'ok';
      services: PlatformServiceRowDTO[];
      total: PlatformServicesTotalDTO;
      rolling: number;
      failed: number;
      short: number;
      /** Services whose (primary) version is behind-stale or diverged. */
      staleOrDiverged: number;
      /** True when there are services and NOT ONE row's version was judged —
       *  the header then says the versions were not read, never a zero. */
      versionsNotRead: boolean;
    }
  | {
      status: 'failed';
      /** The last successful read of the cluster, ISO, or null if none is on record. */
      lastReadAt: string | null;
    };

/** Where the total stands against the quota. */
export type PlatformServicesVerdict = 'under' | 'over70' | 'atQuota';

export type PlatformServicesQuotaDTO =
  | {
      status: 'ok';
      vcpu: number;
      readAt: string;
    }
  | {
      status: 'notRead';
      lastReadAt: string | null;
    };

/** The total against the quota — only when BOTH were read. */
export interface PlatformServicesShareDTO {
  /** Rounded to a whole percent. */
  percent: number;
  verdict: PlatformServicesVerdict;
  /** vCPU to go before 70% (under), or before the quota (over 70%). */
  headroom: number;
  /** vCPU past the quota (at or past it); 0 exactly at it. */
  over: number;
}

export interface PlatformServicesDTO {
  cluster: string;
  /** The AWS account the cluster is in, or null when it has never been read. */
  account: string | null;
  /** When this read was taken, ISO. */
  readAt: string;
  read: PlatformServicesClusterDTO;
  quota: PlatformServicesQuotaDTO;
  share: PlatformServicesShareDTO | null;
}
