import { execFileSync } from 'node:child_process';
import { FRAME_KIND_SWEEP } from '@/lib/planning/planChangeFrames';

// THE FRAME-KIND SWEEP, as core's tests run it (MOTIR-10427). The pattern and
// the paths are `FRAME_KIND_SWEEP` — the same values core publishes in
// `contracts/plan-change-frame-kinds.json` for motir-ai's own check — so the two
// repositories sweep exactly the same thing.

/** The quoted names in `git grep -o` output, unquoted and de-duplicated. */
export function kindsInGrepOutput(out: string): Set<string> {
  return new Set((out.match(/'[a-z_]+'/g) ?? []).map((quoted) => quoted.slice(1, -1)));
}

/**
 * Sweep a checkout's TRACKED files for frame kinds. `git grep` exits 1 when
 * nothing matches; that is an empty sweep, not an error. Anything else throws.
 */
export function sweepFrameKinds(checkout: string): Set<string> {
  try {
    const out = execFileSync(
      'git',
      ['-C', checkout, 'grep', '-ohE', FRAME_KIND_SWEEP.pattern, '--', ...FRAME_KIND_SWEEP.paths],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return kindsInGrepOutput(out);
  } catch (err) {
    if ((err as { status?: number }).status === 1) return new Set();
    throw err;
  }
}
