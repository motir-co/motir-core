// The SHAPE of `lib/ciFleet/fleetJobInventory.json` (Story MOTIR-8699 ·
// MOTIR-8701 wrote it). Since MOTIR-10290 it records only PUBLIC repositories,
// as research; nothing reads it at runtime — readiness computes private
// repositories' coverage from their workflows at head. Declared here so the checker never
// gives a 48 KB manifest a literal type (the MOTIR-8405 sidecar pattern —
// `fleetJobInventory.d.json.ts` points the import at this).

export type FleetJobVerdict = 'runnable' | 'needs-image' | 'cannot-host';

export interface FleetInventoryJob {
  jobId: string;
  runsOn: unknown;
  triggers: unknown;
  verdict: FleetJobVerdict;
  /** Stable tool slugs; `["unverified"]` for a job the inventory did not reach. */
  missing: string[];
  evidence: string | null;
  reason?: string;
  calls?: string;
}

export interface FleetInventoryRepo {
  repoRef: string;
  ref: string;
  sha: string;
  visibility: string;
  /** ISO-8601. */
  measuredAt: string;
  imageDockerfileSha: string;
  /** The MOTIR-8870 structure fingerprint, kept on the record; no longer read. */
  structureFingerprint?: string;
  jobCount: number;
  workflows: Array<{ path: string; jobs: FleetInventoryJob[] }>;
}

export interface FleetJobInventory {
  schemaVersion: number;
  imageDockerfileBlob?: string;
  /** Keyed by `owner/name`, as GitHub spells it. */
  repos: Record<string, FleetInventoryRepo>;
}
