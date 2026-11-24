// The function shape's CLIENT INTERFACES (MOTIR-10008): provider-neutral slices
// of Lambda and CloudWatch. No AWS SDK type appears here; the seam's `sdk.ts`
// implements them (the one file of the tenant directory that imports the SDK),
// and `fake.ts` fakes them with the same Nth-call fault injection. Secret values
// go through the seam's `TenantSecretsManager`.

/** A function version's readiness, as Lambda reports it. */
export type TenantFunctionState = 'pending' | 'active' | 'inactive' | 'failed';

export interface TenantLambda {
  /** The version the alias points at, or null when there is no such alias. */
  getAlias(functionName: string, alias: string): Promise<string | null>;
  /** Point the alias at a version. */
  updateAlias(functionName: string, alias: string, version: string): Promise<void>;
  /** The function's published versions (never `$LATEST`), as Lambda numbers them. */
  listVersions(functionName: string): Promise<string[]>;
  /** One version's state, or null when the function or version does not exist. */
  getFunctionState(functionName: string, version: string): Promise<TenantFunctionState | null>;
  /** One version's state with when it last changed and how its last update
   *  went (MOTIR-12104), or null when the function or version does not exist. */
  getFunctionVersion(functionName: string, version: string): Promise<TenantFunctionVersion | null>;
  /** The provisioned-concurrency status on the alias (`IN_PROGRESS`, `READY`,
   *  `FAILED`), or null when it has none (MOTIR-12104). */
  getProvisionedConcurrency(functionName: string, alias: string): Promise<string | null>;
}

export interface TenantFunctionVersion {
  readonly state: TenantFunctionState;
  /** `successful` · `failed` · `inprogress`; null when Lambda gives none. */
  readonly lastUpdateStatus: string | null;
  readonly lastModified: Date | null;
}

export interface TenantMetricSum {
  readonly namespace: string;
  readonly metricName: string;
  readonly dimensions: Readonly<Record<string, string>>;
  readonly start: Date;
  readonly end: Date;
}

/** A metric read as one statistic per fixed period (MOTIR-12191). */
export interface TenantMetricSeriesQuery extends TenantMetricSum {
  readonly stat: 'Average' | 'Maximum';
  /** A multiple of 60, at least the resolution CloudWatch still keeps for
   *  `start`'s age (1 minute up to 15 days, 5 minutes up to 63, then 1 hour). */
  readonly periodSeconds: number;
}

/** One period's statistic, stamped with the period's start. */
export interface TenantMetricPoint {
  readonly at: Date;
  readonly value: number;
}

export interface TenantCloudWatch {
  /** The metric's sum over `[start, end)`; zero when nothing was recorded. */
  sumMetric(query: TenantMetricSum): Promise<number>;
  /** The periods of `[start, end)` that hold data, OLDEST FIRST; a period
   *  nothing was recorded in is absent, not zero. */
  metricPoints(query: TenantMetricSeriesQuery): Promise<TenantMetricPoint[]>;
}
