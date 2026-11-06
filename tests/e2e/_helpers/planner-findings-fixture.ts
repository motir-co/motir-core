// The planner-findings console's boundary fixture (Story MOTIR-10353 · MOTIR-10529).
//
// The console's pages are server rendered and triage through Server Actions, so
// `page.route` reaches none of it: `lib/test-planner-findings-mock.ts` answers
// motir-ai's `/v1/admin/planner-findings…`, `POST /v1/lessons` and the plan jobs
// this fixture names from this FILE, re-read on every request and rewritten by a
// write. A spec seeds it, drives the page, and reads back what the write stored;
// the JOURNAL records what the page asked motir-ai for.
//
// ⚠️ THE SPEC AND THE SERVER MUST NAME THE SAME FILES. The acceptance lane hands
// its webServer `<repo>/out/e2e-planner-findings-fixture.json` and
// `<repo>/out/e2e-planner-findings-journal.jsonl`; each env var is honoured first
// only for a lane that sets it on both sides.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RawPlannerFinding } from '@/lib/ai/motirAiClient';
import type { PlannerDryRunCounts, StageUsageLine } from '@/lib/ai/types';
import type {
  PlannerFindingsFixture,
  PlannerFindingsFixtureJob,
  PlannerFindingsJournalLine,
} from '@/lib/test-planner-findings-mock';

export const PLANNER_FINDINGS_FIXTURE =
  process.env['MOTIR_AI_PLANNER_FINDINGS_FIXTURE_PATH'] ??
  path.join(process.cwd(), 'out', 'e2e-planner-findings-fixture.json');

export const PLANNER_FINDINGS_JOURNAL =
  process.env['MOTIR_AI_PLANNER_FINDINGS_JOURNAL_PATH'] ??
  path.join(process.cwd(), 'out', 'e2e-planner-findings-journal.jsonl');

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

/**
 * A stored finding with every column filled, so a spec states only what it
 * asserts. The fingerprint defaults to one per site: rows a spec wants grouped
 * share a fingerprint it names.
 */
export function fixtureFinding(
  over: Partial<RawPlannerFinding> & Pick<RawPlannerFinding, 'id'>,
): RawPlannerFinding {
  const site = over.site ?? `leaf:ACME-${over.id}`;
  return {
    coreOrganizationId: 'org_e2e',
    coreWorkspaceId: 'ws_e2e',
    coreProjectId: 'proj_e2e',
    aiProjectId: 'aip_proj_e2e',
    planId: 'plan_e2e_1',
    jobId: null,
    planTitle: 'E2E plan',
    cardRef: null,
    source: 'in_loop',
    planner: 'hosted',
    authorModel: null,
    authorSessionKey: null,
    baselineBranch: 'main',
    baselineCommit: 'abc123def4567890',
    prediction: 'STOPS',
    whatHappened: `${site} named a file that does not exist at main.`,
    evidence: `read_file ${site} → not found`,
    correction: 'Name the file that exists.',
    outcome: 'fixed',
    rule: 'context-refs-exist',
    attribution: null,
    why: null,
    hostedCell: null,
    planpyCell: null,
    fixDirection: null,
    fingerprint: `fp_${site}`,
    status: 'new',
    lessonId: null,
    bugKey: null,
    triageNote: null,
    triagedBy: null,
    triagedAt: null,
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
    ...over,
    site,
  };
}

/** A succeeded plan job carrying the dry run's usage lines and counts. */
export function fixtureJob(
  stageUsage: StageUsageLine[] | undefined,
  counts: Partial<PlannerDryRunCounts> = {},
): PlannerFindingsFixtureJob {
  return {
    status: 'succeeded',
    result: {
      ...(stageUsage ? { stageUsage } : {}),
      dryRun: {
        outcome: 'ran',
        counts: { findingsAccepted: 0, fixed: 0, reported: 0, fixFailed: 0, ...counts },
      },
    },
  };
}

export function writePlannerFindingsFixture(fixture: PlannerFindingsFixture): void {
  mkdirSync(path.dirname(PLANNER_FINDINGS_FIXTURE), { recursive: true });
  writeFileSync(PLANNER_FINDINGS_FIXTURE, JSON.stringify(fixture, null, 2));
}

export function readPlannerFindingsFixture(): PlannerFindingsFixture {
  return JSON.parse(readFileSync(PLANNER_FINDINGS_FIXTURE, 'utf8')) as PlannerFindingsFixture;
}

/** The finding as the fixture stores it — what motir-ai would now hold. */
export function storedFinding(id: string): RawPlannerFinding | undefined {
  return readPlannerFindingsFixture().findings.find((f) => f.id === id);
}

/** Take motir-ai down (every route the seam owns answers 503) or bring it back. */
export function setPlannerFindingsMode(mode: 'live' | 'down'): void {
  writePlannerFindingsFixture({ ...readPlannerFindingsFixture(), mode });
}

/** Every request the seam answered since the last reset, in order. */
export function readJournal(): PlannerFindingsJournalLine[] {
  if (!existsSync(PLANNER_FINDINGS_JOURNAL)) return [];
  return readFileSync(PLANNER_FINDINGS_JOURNAL, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as PlannerFindingsJournalLine);
}

export function resetPlannerFindingsJournal(): void {
  rmSync(PLANNER_FINDINGS_JOURNAL, { force: true });
  mkdirSync(path.dirname(PLANNER_FINDINGS_JOURNAL), { recursive: true });
}
