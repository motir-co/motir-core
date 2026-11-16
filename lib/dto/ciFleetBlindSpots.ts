/**
 * THE CI FLEET'S BLIND SPOTS, as the Fleet status page reads them (MOTIR-11439;
 * design MOTIR-11467, `platform-admin/design-notes.md` § AMENDMENT 2026-11-16).
 *
 * Only the reconcile outcome's drawn fields cross this boundary: per org its
 * GitHub login, its `undeliveredRepos`, its `unreadableRepos` and its read
 * `error`, and the reconcile's own `error`. Queued, idle, awaiting, added and
 * skipped runs are not drawn, so they are not carried.
 */

/** One GitHub organisation the last reconcile served. */
export interface CiFleetBlindSpotOrgDTO {
  /** The org's GitHub login. */
  org: string;
  /** `owner/repo`s with queued fleet jobs but no `workflow_job` delivery in the lookback. */
  undeliveredRepos: string[];
  /** Linked `owner/repo`s the fleet's credential cannot read. */
  unreadableRepos: string[];
  /** The org's read error, verbatim; `null` when the org was read. */
  error: string | null;
}

/**
 * The block's whole state. Every arm but `unavailable`, `notConfigured` and
 * `notComputed` carries `computedAt`: the ISO time of the provision-sweep tick
 * whose reconcile produced it.
 *
 * - `unavailable` — the page's read of the record failed.
 * - `notConfigured` — the CI fleet is not configured on this deployment.
 * - `notComputed` — no sweep has stored an outcome yet.
 * - `reconcileFailed` — the last sweep's reconcile threw; `error` is its message.
 * - `ok` — the outcome, its orgs ordered not read → with blind spots → seen, then
 *   by login.
 */
export type CiFleetBlindSpotsDTO =
  | { status: 'unavailable' }
  | { status: 'notConfigured' }
  | { status: 'notComputed' }
  | { status: 'reconcileFailed'; error: string; computedAt: string }
  | { status: 'ok'; orgs: CiFleetBlindSpotOrgDTO[]; computedAt: string };
