import type { FleetInventoryRepo } from './fleetJobInventoryTypes';
import {
  canonicalRunsOn,
  fingerprintedStructure,
  structureDigest,
  type WorkflowSourceFile,
  type WorkflowStructure,
} from './workflowFingerprint';

// IS A FLEET INVENTORY ENTRY STILL A MEASUREMENT OF ITS REPOSITORY? (MOTIR-8870 ·
// MOTIR-10211)
//
// One rule, read by two callers so they cannot drift apart: the readiness verdict
// (`lib/services/fleetReadinessService.ts`, the guard on the Motir-CI-on-fleet
// switch) and the daily drift probe (`lib/services/fleetInventoryDriftService.ts`,
// which finds a stale entry without anyone opening /admin/fleet-settings). Both
// reach it through `entryStaleness` there, which does the GitHub reads; this file
// is pure, so a script can judge a local checkout with it.
//
// An entry is CURRENT at a newer workflow commit when both halves hold:
//
//   1. the repository-wide digest is unchanged — no new runner, reusable
//      workflow, action, executable or shell anywhere (`structureDigest`); and
//   2. no RECORDED job changed its runner or the workflow it calls. A flat set
//      cannot see a job move between two runners the repository already used —
//      a job moving onto the seam changes what requests the fleet without adding
//      a runner — so each recorded job's `runsOn` is read against its runner at
//      the head.
//
// A job ADDED on a known runner with known tools passes both, and is reported as
// `addedJobs` so the next re-measure lists it. A REMOVED job is not a change: it
// can only take a requirement away.
//
// ⚠️ FAILS CLOSED. No recorded fingerprint, or a head that is not valid YAML, is
// stale.

export type StaleReason =
  /** The entry predates MOTIR-8870 and records no fingerprint. */
  | 'no_fingerprint'
  /** A new runner, reusable workflow, action, executable or shell. */
  | 'digest_moved'
  /** A recorded job now runs on a different runner or calls a different workflow. */
  | 'job_moved'
  /** A workflow file at the head is not valid YAML. */
  | 'invalid_yaml';

export type StructureVerdict =
  | { current: true; addedJobs: string[] }
  | { current: false; reason: StaleReason; movedJobs: string[]; addedJobs: string[] };

const jobKey = (path: string, jobId: string) => `${path}#${jobId}`;

/** The recorded jobs still present at the head whose runner or reusable call moved,
 *  as `path#jobId`. A caller job's recorded `runsOn` is its callee's runners, so a
 *  job with `calls` is compared on the call alone. */
export function recordedJobsMoved(entry: FleetInventoryRepo, head: WorkflowStructure): string[] {
  const moved: string[] = [];
  for (const workflow of entry.workflows) {
    for (const job of workflow.jobs) {
      const key = jobKey(workflow.path, job.jobId);
      const now = head.jobs[key];
      if (!now) continue;
      const changed =
        job.calls !== undefined
          ? now.calls !== job.calls
          : now.calls !== null || canonicalRunsOn(now.runsOn) !== canonicalRunsOn(job.runsOn);
      if (changed) moved.push(key);
    }
  }
  return moved.sort();
}

/** The head's jobs the entry does not record, as `path#jobId`. */
export function jobsNotRecorded(entry: FleetInventoryRepo, head: WorkflowStructure): string[] {
  const recorded = new Set(
    entry.workflows.flatMap((w) => w.jobs.map((j) => jobKey(w.path, j.jobId))),
  );
  return Object.keys(head.jobs)
    .filter((key) => !recorded.has(key))
    .sort();
}

/** Judge an entry against the workflow files at a newer head. Pure. */
export function judgeStructure(
  entry: FleetInventoryRepo,
  files: WorkflowSourceFile[],
): StructureVerdict {
  let head: WorkflowStructure;
  try {
    head = fingerprintedStructure(files);
  } catch {
    return { current: false, reason: 'invalid_yaml', movedJobs: [], addedJobs: [] };
  }
  const addedJobs = jobsNotRecorded(entry, head);
  const movedJobs = recordedJobsMoved(entry, head);
  if (!entry.structureFingerprint) {
    return { current: false, reason: 'no_fingerprint', movedJobs, addedJobs };
  }
  if (structureDigest(head) !== entry.structureFingerprint) {
    return { current: false, reason: 'digest_moved', movedJobs, addedJobs };
  }
  if (movedJobs.length > 0) return { current: false, reason: 'job_moved', movedJobs, addedJobs };
  return { current: true, addedJobs };
}
