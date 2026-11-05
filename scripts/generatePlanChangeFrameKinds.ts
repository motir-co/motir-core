import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { format, resolveConfig } from 'prettier';
import {
  FRAME_KIND_SWEEP,
  PLAN_CHANGE_FRAME_KINDS,
  SWEEP_FALSE_MATCHES,
} from '@/lib/planning/planChangeFrames';

// THE PUBLISHED FRAME-KIND CONTRACT (MOTIR-10427) — the GENERATOR.
//
// `lib/planning/planChangeFrames.ts` is the one place core decides what the
// plan-change rail does with each frame kind motir-ai emits. motir-ai cannot
// import it (a separate, private repository), so core publishes the part motir-ai
// needs as plain JSON at a stable path on `main`, and motir-ai's CI reads it from
// there (`pnpm check:frame-kinds`, `scripts/ci/frame-kinds.ts` in motir-ai):
//
//   kinds              every kind core has a disposition for
//   sweepFalseMatches  what the sweep matches that is not a frame, with why
//   sweep              the `git grep -E` pattern and paths both sides sweep
//
// This module produces the file's contents in memory and touches no filesystem;
// `scripts/generate-plan-change-frame-kinds.ts` is the half that writes, so
// `tests/planning/frameKindParity.test.ts` can call this and compare — the same
// split `scripts/generateMcpToolSchemas.ts` makes, for the same reason.

/** The published path, relative to the repository root. motir-ai reads it from `main`. */
export const PLAN_CHANGE_FRAME_KINDS_FILE = 'contracts/plan-change-frame-kinds.json';

const COMMENT =
  'GENERATED from lib/planning/planChangeFrames.ts by `pnpm generate:plan-change-frame-kinds` — ' +
  'do not edit by hand. The frame kinds motir-core gives a disposition on the plan-change rail. ' +
  "motir-ai's CI (`pnpm check:frame-kinds`) sweeps its own src/ with `sweep` and fails on a kind " +
  'that is neither in `kinds` nor in `sweepFalseMatches`, so a new kind gets its disposition in ' +
  'motir-core first (MOTIR-10427).';

/**
 * The file's contents. Sorted, so a regeneration is byte-stable, and formatted
 * with the repository's OWN resolved Prettier config so `pnpm format:check`
 * accepts the generated file as written.
 */
export async function generatePlanChangeFrameKinds(): Promise<string> {
  const contract = {
    _comment: COMMENT,
    sweep: { pattern: FRAME_KIND_SWEEP.pattern, paths: [...FRAME_KIND_SWEEP.paths] },
    kinds: [...PLAN_CHANGE_FRAME_KINDS].sort(),
    sweepFalseMatches: Object.fromEntries(
      Object.entries(SWEEP_FALSE_MATCHES).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
  const options = await resolveConfig(PLAN_CHANGE_FRAME_KINDS_FILE);
  return format(JSON.stringify(contract, null, 2), {
    ...options,
    filepath: PLAN_CHANGE_FRAME_KINDS_FILE,
  });
}

/** What is committed today, or `null` when the file does not exist yet. */
export async function readCommittedPlanChangeFrameKinds(root: string): Promise<string | null> {
  try {
    return await readFile(join(root, PLAN_CHANGE_FRAME_KINDS_FILE), 'utf8');
  } catch {
    return null;
  }
}
