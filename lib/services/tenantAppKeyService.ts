import 'server-only';

import type { TenantAppKeyDto, TenantAppKeyRevokeDto } from '@/lib/dto/tenantAppKey';
import {
  GatewayAppKeyConfigError,
  GatewayAppKeyRefusedError,
  GatewayAppKeyUnavailableError,
} from '@/lib/gateway/errors';
import {
  mintGatewayAppKey,
  revokeGatewayAppKey,
  revokeGatewayAppKeysForProject,
} from '@/lib/gateway/appKeyClient';
import {
  TenantAppKeyNotMintedError,
  TenantAppKeyNotRevokedError,
} from '@/lib/tenantAppKeys/errors';

// TENANT-APP KEYS (Story MOTIR-8339) — motir-core's side of the gateway key a
// hosted tenant app (first: a generated prototype on motir.site) calls models with.
// The key carries its project and its paying org INSIDE the credential row, so
// nothing the app sends can change who pays.
//
//   - `mintAppKey`    — for ONE motir-core project and the org that pays for it.
//   - `revokeAppKeys` — one key (rotation: mint the new one, revoke the old keyId)
//     or every live key of a project (teardown).
//
// ⚠️ THIS SERVICE READS NO DATABASE, LOGS NO KEY AND DECIDES NO POLICY. The caller
// resolves the paying organization and hands it in, as `hostedRunKeyService` does;
// WHEN a project gets a key, how it reaches the app and when it rotates belong to
// the caller (the prototype epic, MOTIR-4527). Both functions throw a typed error
// on every failure and leave what to do about it to that caller.

export interface TenantAppKeyMintInput {
  /** The motir-core project id — the key's `projectRef`. */
  projectId: string;
  /** The organization that pays — the key's `coreOrganizationId`. */
  payingOrganizationId: string;
  expiresAt: Date;
  /** Optional model allow-list, bare gateway ids. */
  models?: string[];
}

/** What a revoke names: one key, or every live key of a project. */
export type TenantAppKeyRevokeTarget = { keyId: number } | { projectId: string };

type FailureClass = typeof TenantAppKeyNotMintedError | typeof TenantAppKeyNotRevokedError;

function failure<C extends FailureClass>(Failure: C, err: unknown): InstanceType<C> {
  if (err instanceof GatewayAppKeyConfigError) {
    return new Failure('not_configured', err.message) as InstanceType<C>;
  }
  if (err instanceof GatewayAppKeyRefusedError) {
    return new Failure(
      'refused',
      `the gateway refused (${err.status} ${err.code}): ${err.message}`,
      err.code,
    ) as InstanceType<C>;
  }
  if (err instanceof GatewayAppKeyUnavailableError) {
    return new Failure('unavailable', err.message) as InstanceType<C>;
  }
  return new Failure(
    'unavailable',
    err instanceof Error ? err.message : String(err),
  ) as InstanceType<C>;
}

export const tenantAppKeyService = {
  /**
   * Mint a gateway key bound to `projectId` and billed to `payingOrganizationId`
   * on the `app` lane. Throws {@link TenantAppKeyNotMintedError} on every failure;
   * an empty id or an expiry not after `now` is refused with NO request.
   */
  async mintAppKey(input: TenantAppKeyMintInput, now: Date = new Date()): Promise<TenantAppKeyDto> {
    if (input.projectId.trim() === '' || input.payingOrganizationId.trim() === '') {
      throw new TenantAppKeyNotMintedError(
        'invalid_request',
        'an app key needs a project id and a paying organization id',
      );
    }
    if (input.expiresAt.getTime() <= now.getTime()) {
      throw new TenantAppKeyNotMintedError(
        'invalid_request',
        'an app key must expire in the future',
      );
    }
    try {
      const minted = await mintGatewayAppKey({
        projectRef: input.projectId,
        coreOrganizationId: input.payingOrganizationId,
        expiresAt: input.expiresAt,
        ...(input.models === undefined ? {} : { models: input.models }),
      });
      return {
        key: minted.key,
        keyId: minted.keyId,
        projectId: minted.projectRef,
        payingOrganizationId: minted.coreOrganizationId,
        expiresAt: minted.expiresAt,
        lane: minted.lane,
      };
    } catch (err) {
      throw failure(TenantAppKeyNotMintedError, err);
    }
  },

  /**
   * Revoke one key by its gateway id, or every live key of a project. A repeat
   * answers `revoked: 0`, not an error. Throws {@link TenantAppKeyNotRevokedError}
   * on every failure.
   */
  async revokeAppKeys(target: TenantAppKeyRevokeTarget): Promise<TenantAppKeyRevokeDto> {
    try {
      const result =
        'keyId' in target
          ? await revokeGatewayAppKey(target.keyId)
          : await revokeGatewayAppKeysForProject(target.projectId);
      return { revoked: result.revoked };
    } catch (err) {
      throw failure(TenantAppKeyNotRevokedError, err);
    }
  },
};
