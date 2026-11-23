import { adminDb } from './adminDb';

// THE RETIRED `code_graph_index` FLEET KIND, FOR TESTS OF THE PAST (MOTIR-12041).
//
// The kind left motir-core with Story MOTIR-11026, and
// `20261123180000_retire_code_graph_index_fleet_kind` deleted its rows and
// tightened the three `fleet_kind` CHECK constraints to the three live kinds. A
// test that must seed the database AS IT STOOD BEFORE — the migration that
// retired the kind, and the merged-account re-home that ran before it — loosens
// those constraints for its own file with `allowRetiredFleetKind()` and puts
// them back with `refuseRetiredFleetKind()` in its `afterAll`, so no other file
// on the worker's database sees the old shape. This file is the one place a
// test names the kind or its pool's two pause reasons.

/** The retired fleet kind's stored value — the rows it left are history. */
export const RETIRED_FLEET_KIND = 'code_graph_index';

/**
 * The two index pause reasons that belonged to the retired kind's pool
 * (MOTIR-9451, MOTIR-10600), as a past `github_repo` row may still store them.
 * Nothing writes them since MOTIR-12036; the catch-up re-asks such a row like
 * any other pause, and the reads report its stored reason.
 */
export const RETIRED_CAPACITY_PAUSES = [
  'paused_index_pool_full',
  'paused_index_no_indexer_account',
] as const;

const CHECKS = [
  ['fleet_shard', 'fleet_shard_fleet_kind_check'],
  ['fleet_quota_request', 'fleet_quota_request_fleet_kind_check'],
  ['fleet_growth_event', 'fleet_growth_event_fleet_kind_check'],
] as const;

const LIVE_KINDS = `'ci_runner', 'hosted_agent', 'agent_instance'`;

async function replaceChecks(kinds: string): Promise<void> {
  for (const [table, constraint] of CHECKS) {
    await adminDb.$executeRawUnsafe(
      `ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${constraint}"`,
    );
    await adminDb.$executeRawUnsafe(
      `ALTER TABLE "${table}" ADD CONSTRAINT "${constraint}" CHECK ("fleet_kind" IN (${kinds}))`,
    );
  }
}

/** The constraints as they stood before the retirement: the four kinds. */
export async function allowRetiredFleetKind(): Promise<void> {
  await replaceChecks(`${LIVE_KINDS}, '${RETIRED_FLEET_KIND}'`);
}

/**
 * The constraints as the retirement migration leaves them. Call it after every
 * row of the retired kind the file seeded is gone, or the ADD fails on them.
 */
export async function refuseRetiredFleetKind(): Promise<void> {
  await replaceChecks(LIVE_KINDS);
}
