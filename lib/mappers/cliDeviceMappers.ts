import type { DeviceCode, User, Workspace } from '@/generated/prisma/client';
import type { ApiTokenDto } from '@/lib/dto/apiTokens';
import type {
  DeviceGrantDescriptionDTO,
  DeviceGrantStartDTO,
  DeviceGrantStatus,
  DeviceGrantTokenDTO,
  DeviceGrantUpdatedDTO,
} from '@/lib/dto/cliDevice';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { InvalidDeviceGrantError } from '@/lib/cliDevice/errors';

// Prisma/plugin → DTO conversion for the CLI device-authorization surface (Story
// MOTIR-1863 · Subtasks MOTIR-1865 / MOTIR-1888). Pure functions; the service calls
// them just before returning (CLAUDE.md 4-layer split).

/** What Better-Auth's `deviceCode` endpoint hands back. Declared structurally
 * rather than imported: it is the plugin's internal response type, and pinning our
 * dependency to the five fields we actually forward means a plugin upgrade that
 * ADDS a field cannot silently change Motir's contract with the CLI. */
export interface IssuedDeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/** The RFC 8628 §3.2 grant response, forwarded field-for-field. */
export function toDeviceGrantStartDTO(issued: IssuedDeviceCode): DeviceGrantStartDTO {
  return {
    device_code: issued.device_code,
    user_code: issued.user_code,
    verification_uri: issued.verification_uri,
    verification_uri_complete: issued.verification_uri_complete,
    expires_in: issued.expires_in,
    interval: issued.interval,
  };
}

/**
 * The successful poll (RFC 8628 §3.4 + Motir's `user` / `workspace` additions).
 *
 * `expires_in` is derived from the minted token's own `expiresAt` rather than from
 * the 90-day constant, so the number the CLI stores can never disagree with the
 * number the DB will enforce.
 */
export function toDeviceGrantTokenDTO(input: {
  token: string;
  dto: ApiTokenDto;
  user: User;
  workspace: Workspace;
}): DeviceGrantTokenDTO {
  const expiresAtMs = input.dto.expiresAt ? new Date(input.dto.expiresAt).getTime() : null;
  return {
    access_token: input.token,
    token_type: 'Bearer',
    // RFC 6749's `scope` response parameter reports WHAT WAS GRANTED. Since
    // MOTIR-2572 that is a permission set, so the field keeps its protocol name
    // and carries the grant — reporting the retired strings would describe an
    // authority the token does not have.
    scope: input.dto.permissions.join(' '),
    expires_in:
      expiresAtMs === null ? 0 : Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000)),
    user: { id: input.user.id, name: input.user.name, email: input.user.email },
    workspace: {
      id: input.workspace.id,
      name: input.workspace.name,
      slug: input.workspace.slug,
    },
  };
}

/**
 * Narrow the plugin-owned `status` column to the machine's three values.
 *
 * `status` is a plain `String` in the schema because Better-Auth's adapter owns it,
 * so the type system cannot promise the union the page branches on. A value outside
 * the three is therefore not a user error but a corrupted or hand-edited row — and
 * the honest answer to a browser asking about it is the same as for a code that does
 * not exist, rather than a 500 or a fourth state the page has no screen for.
 */
function toGrantStatus(raw: string): DeviceGrantStatus {
  if (raw === 'pending' || raw === 'approved' || raw === 'denied') return raw;
  throw new InvalidDeviceGrantError(`Unrecognised device-grant status: ${raw}`);
}

/**
 * The grant as the `/device` page reads it (Subtask MOTIR-1888).
 *
 * `scopes` comes from the CONSTANT, not from `row.scope`: the grant is unconfigurable
 * (ADR Q2), so what approval will grant is `CLI_TOKEN_GRANT` regardless of what the
 * request asked for. Mapping the row's requested string here would let a widened
 * `scope` on the wire change what the approval screen PROMISES without changing what
 * the mint actually does — the one drift that would make the screen lie.
 *
 * This is also the boundary that DROPS `deviceCode` / `userId` / `workspaceId`: the
 * page's DTO is built field-by-field from the row rather than spread from it, so a new
 * column cannot leak onto a browser surface by default.
 */
/** An approved UPDATE's poll answer (MOTIR-10189) — the token as it now stands. */
export function toDeviceGrantUpdatedDTO(input: {
  dto: ApiTokenDto;
  user: User;
}): DeviceGrantUpdatedDTO {
  return {
    updated: true,
    label: input.dto.label,
    scope: input.dto.permissions.join(' '),
    user: { id: input.user.id, name: input.user.name, email: input.user.email },
    workspace: { id: input.dto.workspace.id, name: input.dto.workspace.name },
  };
}

/** `update` is the token an UPDATE grant would change (MOTIR-10189), read by the
 * service as the approver; omitted for a `motir login` grant. */
export function toDeviceGrantDescriptionDTO(
  row: DeviceCode,
  update?: ApiTokenDto,
): DeviceGrantDescriptionDTO {
  return {
    userCode: row.userCode,
    status: toGrantStatus(row.status),
    hostname: row.hostname,
    askedAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    permissions: [...CLI_TOKEN_GRANT],
    clientId: row.clientId,
    update: update
      ? {
          label: update.label,
          tokenPrefix: update.tokenPrefix,
          workspaceName: update.workspace.name,
          expiresAt: update.expiresAt,
          permissions: update.permissions,
        }
      : null,
  };
}
