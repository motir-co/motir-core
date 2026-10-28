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
}

export interface TenantMetricSum {
  readonly namespace: string;
  readonly metricName: string;
  readonly dimensions: Readonly<Record<string, string>>;
  readonly start: Date;
  readonly end: Date;
}

export interface TenantCloudWatch {
  /** The metric's sum over `[start, end)`; zero when nothing was recorded. */
  sumMetric(query: TenantMetricSum): Promise<number>;
}
