// The AWS TENANT SEAM's public entry (MOTIR-10004). Nothing exported from here
// names an AWS SDK type (asserted by `test/awsTenantSeam.test.ts`).
export * from './clients';
export * from './errors';
export * from './factory';
export * from './fake';
export * from './session';
export * from './stackRunner';
export {
  createTenantSdkClient,
  sdkTenantCloudFormation,
  sdkTenantCloudWatch,
  sdkTenantEcs,
  sdkTenantElb,
  sdkTenantLambda,
  sdkTenantRdsData,
  sdkTenantSecretsManager,
  sdkTenantSsm,
  tenantApiError,
  type TenantSdkClientFactory,
  type TenantSdkCredentials,
  type TenantSdkService,
} from './sdk';
export * from './registry';
export * from './network';
export * from './database';
export * from './releaseTemplate';
export * from './function';
export * from './container';
export * from './releaseIds';
export * from './hostingAdapter';
