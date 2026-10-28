// The tenant seam's CLIENT INTERFACES (MOTIR-10004): provider-neutral slices of
// the AWS services the hosting adapter calls in a tenant account. No AWS SDK
// type appears here; `sdk.ts` implements them over the SDK. A later card adds
// its service to `TenantClients` and to the fake beside it.

/** A stack as the runner reads it. */
export interface TenantStack {
  readonly name: string;
  readonly status: string;
  readonly parameters: Readonly<Record<string, string>>;
  readonly tags: Readonly<Record<string, string>>;
  readonly outputs: Readonly<Record<string, string>>;
}

export interface TenantStackWrite {
  readonly name: string;
  readonly templateBody: string;
  readonly parameters: Readonly<Record<string, string>>;
  readonly tags: Readonly<Record<string, string>>;
}

/** The CloudFormation calls the stack runner makes. */
export interface TenantCloudFormation {
  /** The stack, or null when there is none of that name. */
  describeStack(name: string): Promise<TenantStack | null>;
  /** The template the stack was last applied with, as submitted. */
  getTemplateBody(name: string): Promise<string>;
  createStack(input: TenantStackWrite): Promise<void>;
  /** `no_change` when CloudFormation finds nothing to update. */
  updateStack(input: TenantStackWrite): Promise<'updating' | 'no_change'>;
  deleteStack(name: string): Promise<void>;
}

/** Every client of one tenant account, all under its deploy role. */
export interface TenantClients {
  readonly accountId: string;
  readonly region: string;
  readonly cloudformation: TenantCloudFormation;
}
