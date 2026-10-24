// The E2E boundary mocks' fixture I/O — ONE module, because the reason it
// exists is a BUILD fact rather than a testing one (MOTIR-3219).
//
// ## What goes wrong without it
//
// Every `lib/test-*-mock.ts` reads (and two of them write) a fixture whose path
// the lane chooses at RUN time — `/tmp/motir-acceptance-ai-jobs-fixture.json`
// and friends, handed over in an env var. So the argument to `readFileSync` is
// fully dynamic, and Turbopack's output-file tracer cannot resolve it. Its
// fallback for an unresolvable filesystem read is to assume the module might
// read ANYTHING, so it traces the WHOLE PROJECT into that entry's NFT list.
//
// `instrumentation.ts` dynamic-imports all of these mocks, so the whole project
// lands in `.next/server/instrumentation.js.nft.json`, and `copyTracedFiles`
// copies every one of those files into `output: 'standalone'`. Measured on
// `origin/main` @ `bd86ed80`: **4510 traced files** — all of `tests/**`,
// `design/**`, `prisma/migrations/**`, `packages/cli/**` and
// `scripts/plan-seed/**` — and a 464 MB `.next/standalone`.
//
// Next says so, once per build:
//
//     Encountered unexpected file in NFT list
//     A file was traced that indicates that the whole project was traced
//     unintentionally.
//     Import trace: ./next.config.ts → ./lib/test-ai-jobs-mock.ts
//                                    → ./instrumentation.ts
//
// ⚠️ **It names ONE file, and that is the trap.** Turbopack reports a single
// warning for the condition and names whichever instrumentation-reachable
// module it happens to reach first; unwiring the named mock only promotes the
// next one (MOTIR-3219 proved that by experiment, watching the trace flip from
// `test-ai-jobs-mock` to `test-code-health-mock`). There were EIGHT such calls
// across FIVE modules, so fixing only the two the warning had ever named would
// have left the whole-project trace exactly where it was, still warning, now
// about a third file.
//
// ## The fix
//
// `/* turbopackIgnore: true */` on the dynamic argument — one of the two
// remedies the warning itself proposes. The other one, *"make sure they are
// statically scoped to some subfolder"*, is wrong here: it would mean moving
// the fixtures INTO the repo and then tracing that folder into the production
// bundle, which is this bug in miniature. These paths are `/tmp` scratch files
// that exist only while a Playwright lane runs, and nothing about them should
// ever reach a build output.
//
// The comment suppresses the TRACING, not the read: at run time these are
// ordinary `node:fs` calls and the mocks behave exactly as before.
//
// ⚠️ So a boundary mock must NEVER import `node:fs` / `node:fs/promises`
// itself — it goes through this module, or the whole-project trace comes back
// SILENTLY, because the warning does not fail the build.
// `tests/build/nft-trace-guard.test.ts` asserts both halves of that, and
// `ci.yml`'s build job greps its own build output for the warning.

import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

/**
 * Read a fixture file as UTF-8 text. Throws exactly as `readFileSync` does —
 * every caller already wraps its read in a `try` that treats an absent or
 * half-written fixture as "nothing declared", and that behaviour is unchanged.
 */
export function readFixtureFileSync(path: string): string {
  return readFileSync(/* turbopackIgnore: true */ path, 'utf8');
}

/** The `node:fs/promises` form, for a mock whose reply callback is async. */
export async function readFixtureFile(path: string): Promise<string> {
  return readFile(/* turbopackIgnore: true */ path, 'utf8');
}

/** Overwrite a fixture file with UTF-8 text. */
export function writeFixtureFileSync(path: string, contents: string): void {
  writeFileSync(/* turbopackIgnore: true */ path, contents);
}

/** Append UTF-8 text to a fixture file (the JSONL journals). */
export function appendFixtureFileSync(path: string, contents: string): void {
  appendFileSync(/* turbopackIgnore: true */ path, contents, 'utf8');
}

/**
 * Replace a fixture file whole: write a sibling, then rename it over the path,
 * so a reader in another process sees the old file or the new one and never half
 * of one (the fake AWS's state, which three lane processes write, MOTIR-9429).
 */
export function replaceFixtureFileSync(path: string, contents: string): void {
  const sibling = `${path}.${process.pid}.tmp`;
  writeFileSync(/* turbopackIgnore: true */ sibling, contents);
  renameSync(/* turbopackIgnore: true */ sibling, /* turbopackIgnore: true */ path);
}
