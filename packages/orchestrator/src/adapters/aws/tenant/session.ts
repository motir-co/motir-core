import { AwsManagementApiError, type AwsManagementApi } from '../management';
import type { TenantSdkCredentials } from './sdk';
import { TenantRoleUnavailableError } from './errors';

// The DEPLOY-ROLE SESSION of a tenant account (MOTIR-10004). The chain is the
// management code's own: base credentials → the management role
// (`AWS_ORG_ADMIN_ROLE_ARN`) → `motir-tenant-deploy` in the tenant account, the
// only principal that role trusts (`assumeTenantDeployRole`). The session lives
// in this closure only — never written, logged or returned past the SDK's
// credential provider — and is assumed again once it is near its expiry.

/** Re-assume this long before the session expires. */
export const TENANT_SESSION_RENEW_MS = 5 * 60_000;

export interface TenantSessionOptions {
  readonly management: Pick<AwsManagementApi, 'assumeTenantDeployRole'>;
  readonly accountId: string;
  readonly now?: () => number;
}

/** A credential provider for the tenant account's deploy role. */
export function tenantDeploySession(
  options: TenantSessionOptions,
): () => Promise<TenantSdkCredentials> {
  const now = options.now ?? (() => Date.now());
  let held: TenantSdkCredentials | null = null;
  return async () => {
    const expiresAt = held?.expiration?.getTime() ?? Infinity;
    if (held && expiresAt - now() > TENANT_SESSION_RENEW_MS) return held;
    try {
      const session = await options.management.assumeTenantDeployRole(options.accountId);
      held = {
        accessKeyId: session.accessKeyId,
        secretAccessKey: session.secretAccessKey,
        sessionToken: session.sessionToken,
        ...(session.expiration ? { expiration: session.expiration } : {}),
      };
      return held;
    } catch (err) {
      held = null;
      if (err instanceof AwsManagementApiError) {
        throw new TenantRoleUnavailableError(options.accountId, err.awsCode);
      }
      throw err;
    }
  };
}
