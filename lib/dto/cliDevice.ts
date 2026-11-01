// DTOs for the CLI device-authorization surface (Story MOTIR-1863 · Subtasks
// MOTIR-1865 / MOTIR-1888) — what crosses `/api/cli/device/*` to `packages/cli` and
// to the `/device` page (Subtask MOTIR-1867).
//
// TWO NAMING CONVENTIONS LIVE IN THIS FILE, and the split is deliberate — read the
// per-interface notes before adding a third shape:
//
// - `DeviceGrantStartDTO` / `DeviceGrantTokenDTO` are snake_case, unlike every other
//   Motir DTO: they are RFC 8628 §3.2 / §3.4 payloads, so a standard device-flow
//   poller works against Motir unchanged and the CLI's branch is the standard one.
//   Deviating to camelCase there would buy internal consistency and cost
//   interoperability.
// - `DeviceGrantDescriptionDTO` is camelCase, the repo's normal convention: its only
//   consumer is Motir's own `/device` page, not an OAuth client, so there is no
//   interoperability to buy and the repo-wide convention wins.

import type { PermissionKey } from '@/lib/permissions/catalog';

/**
 * The grant, as `POST /api/cli/device/start` hands it to the terminal. Everything
 * the CLI needs to print instructions and start polling — and nothing about the
 * user, who has not been identified yet.
 */
export interface DeviceGrantStartDTO {
  /** The CLI's polling credential. High-entropy, never shown to the human. */
  device_code: string;
  /** The short code the human reads out and types (8 chars, no `0/O/1/I/L`). */
  user_code: string;
  /** Where the human goes to approve. Absolute, resolved against Better-Auth's
   * `baseURL`, so a preview deployment prints its own URL. */
  verification_uri: string;
  /** The same URL with `?user_code=…` pre-filled — what the CLI opens in a browser
   * when it can, and prints either way. */
  verification_uri_complete: string;
  /** Seconds until the codes expire (900 — the ADR's 15m). */
  expires_in: number;
  /** Minimum seconds between polls; polling faster answers `slow_down`. */
  interval: number;
}

/**
 * The successful poll — the ONE place a device-minted PAT's plaintext ever exists.
 *
 * `user` and `workspace` are Motir additions to the RFC shape so `motir login` can
 * print the same `Logged in as … (workspace …)` confirmation `motir auth login`
 * prints today WITHOUT a second `whoami` round trip. The device path skips the
 * connect + `listToolNames` validation the paste path performs: a server-minted
 * token cannot be the wrong token.
 */
export interface DeviceGrantTokenDTO {
  /** The `motir_pat_…` plaintext. Returned exactly once — the grant row is deleted
   * in the same transaction that claims it, so a second poll cannot re-issue it. */
  access_token: string;
  token_type: 'Bearer';
  /** The granted scopes, space-separated (`CLI_TOKEN_SCOPES`). Fixed — the approval
   * screen shows them and cannot change them. */
  scope: string;
  /** Seconds until the PAT expires (90 days). */
  expires_in: number;
  user: { id: string; name: string; email: string };
  workspace: { id: string; name: string; slug: string };
}

/** The three states of the plugin's grant machine — the only values it ever writes
 * to `DeviceCode.status`, and the three the `/device` page branches on. */
export type DeviceGrantStatus = 'pending' | 'approved' | 'denied';

/**
 * The grant as the `/device` approval screen reads it (`GET /api/cli/device/grant`,
 * Subtask MOTIR-1888) — the answer to "what is connecting", which is the ADR's whole
 * phishing mitigation and which no shipped endpoint could supply: Better-Auth's own
 * `GET /api/auth/device?user_code=…` returns `{ user_code, status }` and nothing more.
 *
 * DELIBERATELY WITHOUT `deviceCode`, `userId`, `workspaceId`, or a token. The device
 * code is the CLI's polling credential and putting it on a browser surface would hand
 * a phishing page the one value it cannot otherwise obtain; the ids are things the
 * page already knows (the session) or resolves server-side (`getWorkspaceContext`).
 * The asserted-absence test in `tests/cli/` is what keeps this list from growing.
 */
export interface DeviceGrantDescriptionDTO {
  /** The canonical code (dashes stripped, upper-cased) — so the screen echoes the
   * form the server matched, not whatever the human happened to type. */
  userCode: string;
  status: DeviceGrantStatus;
  /** What the CLI reported it is running on. Display-only and never interpreted
   * (ADR Q4) — the screen renders it as untrusted, attacker-suppliable text. */
  hostname: string | null;
  /** When the terminal opened the grant — the screen's "asked for 20 seconds ago",
   * the cue that catches a code the human did not just generate. ISO string (the
   * API-boundary convention). */
  askedAt: string;
  /** When the code ages out (15m after `askedAt`). ISO string. */
  expiresAt: string;
  /** What approval WILL GRANT — `CLI_TOKEN_GRANT` (MOTIR-2577), never the row's
   * requested `scope` string, which the substrate is explicit is "a record of what
   * was asked, not what is granted". The grant is unconfigurable, so this is a fact
   * about the deployment, not about the request.
   *
   * The FIELD keeps its name for now; MOTIR-2579 re-points the approval screen
   * onto the shared permission presenter and renames it with that surface. */
  permissions: PermissionKey[];
  /** The client that opened the grant (`motir-cli`). Pinned server-side at start, so
   * it is a display fact, not an input. */
  clientId: string | null;
  /**
   * Set when this grant UPDATES an existing CLI token (`motir auth refresh`,
   * MOTIR-10189) instead of minting one; null for `motir login`. The screen names
   * the token and shows what approving changes — `permissions` is what it holds
   * NOW, and the diff is computed against the field above (`CLI_TOKEN_GRANT`).
   * Never the secret; the prefix is the same display hint the tokens list shows.
   */
  update: DeviceGrantUpdateTargetDTO | null;
}

/** The token an UPDATE grant would change, as the `/device` confirm screen names it. */
export interface DeviceGrantUpdateTargetDTO {
  label: string;
  tokenPrefix: string;
  workspaceName: string;
  /** ISO string, or null for a token that never expires. Unchanged by the update. */
  expiresAt: string | null;
  /** The token's grant as it stands before approval. */
  permissions: PermissionKey[];
}

/**
 * An approved UPDATE's poll (`motir auth refresh`, MOTIR-10189). There is no
 * `access_token`: the terminal keeps the secret it already holds, and that is the
 * point of the flow. `updated` is the discriminator the CLI branches on.
 */
export interface DeviceGrantUpdatedDTO {
  updated: true;
  /** The token's label, e.g. `CLI · yue-mbp`. */
  label: string;
  /** The grant now held, space-separated — `CLI_TOKEN_GRANT`. */
  scope: string;
  user: { id: string; name: string; email: string };
  workspace: { id: string; name: string };
}

/** What `GET /api/cli/token` answers about the presented token (MOTIR-10189) —
 * the input to `motir auth status`'s refresh hint. */
export interface CliTokenStatusDTO {
  /** A `motir login` device credential (no project, no run). Only these can be
   * refreshed; a hand-minted token's grant is edited in Settings. */
  cliSignIn: boolean;
  /** The keys of today's `CLI_TOKEN_GRANT` this token lacks — always empty when
   * `cliSignIn` is false. */
  missing: PermissionKey[];
}
