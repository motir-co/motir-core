// The provider-agnostic COMMIT-ID guard: ONE pattern and ONE normalisation,
// shared by every surface that stores a commit a reader is later shown
// (MOTIR-5619).
//
// ⚠️ IT IS CALLED BY THE SERVICE, NOT BY THE DOOR, AND THAT IS THE WHOLE POINT.
// A stored `commitSha` does two jobs at once: it is the CITATION on a published
// record — the only thing tying a recording or an asset to the code it shows —
// and it is the IDEMPOTENCY KEY that stops a redelivery superseding a good
// record. A value doing both jobs has to be canonical before either job runs.
// A guard written at one entry point is correct on the day it lands and absent
// the first time anything else reaches the same service: the acceptance-receipt
// path has TWO entry points (the MCP tool and the HTTP route), and for as long
// as only one of them looked they disagreed silently. Same argument, and the
// same file, as `normalizeRepoFilePath` beside the provider seam.
//
// ⚠️ NORMALISE, THEN VALIDATE — in that order — AND STORE WHAT COMES BACK. A
// client building JSON from `$(git rev-parse HEAD)` without stripping the
// newline sends `"<sha>\n"`. That is a non-blank string, so an emptiness check
// passes it, and it is a DIFFERENT key from `"<sha>"` under `===` — so the
// redelivery supersedes the current record and writes a history row, which is
// precisely what the idempotency check exists to prevent. Upper-case hex is the
// same failure with a different cause. Comparing and storing the value this
// returns is what makes the key canonical.
//
// ⚠️ FORMAT IS NOT EXISTENCE, and this guard deliberately does not claim to be.
// A 40-character string of valid hex that names no commit in any repository
// passes every check here. Verifying that a commit EXISTS needs the host, costs
// an API call on the publish path, and has to decide what happens when the host
// is unreachable or the commit sits on an unpushed branch — its own decision,
// not something to half-do here.
//
// Imported DEEP (`@/lib/git/commitSha`), never through `@/lib/git`: that barrel
// is the provider resolver's entry and registers every provider as an import
// side-effect, which a pure string guard has no use for. `hostOwnership`,
// `types` and `provider` are all reached the same way.

/** A git object id: SHA-1 (40) or SHA-256 (64), abbreviated to no fewer than 7. */
export const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,64}$/;

/** A FULL object id — SHA-1 (40) or SHA-256 (64) — what a host resolves a ref to (MOTIR-10122). */
export const FULL_COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Why a commit id was refused. Rendered to the caller verbatim by whichever
 * domain error carries it, so it says what to fix rather than that something
 * was wrong.
 */
export const COMMIT_SHA_REFUSAL = 'expected a hex commit id of 7 to 64 characters.';

export interface CommitShaOk {
  ok: true;
  /** The id in its canonical form — trimmed and lower-cased. */
  commitSha: string;
}

export interface CommitShaRefused {
  ok: false;
  reason: string;
}

/**
 * Normalize a commit id, or refuse it.
 *
 * ACCEPTED and normalized: surrounding whitespace (including the trailing
 * newline a shell pipeline leaves), and upper-case hex.
 *
 * REFUSED: anything that is not 7–64 hex characters once normalized — `"HEAD"`,
 * a branch name, a placeholder, an empty string, a short id under 7, and
 * anything over 64.
 *
 * The caller decides what an ABSENT id means: this takes a string, so a field
 * that is optional is checked for presence by its own service first. Refusing
 * is the caller's job too — each domain raises its own typed error naming its
 * own field, which is why this returns a result rather than throwing.
 */
export function normalizeCommitSha(raw: string): CommitShaOk | CommitShaRefused {
  if (typeof raw !== 'string') return { ok: false, reason: COMMIT_SHA_REFUSAL };
  const commitSha = raw.trim().toLowerCase();
  if (!COMMIT_SHA_PATTERN.test(commitSha)) return { ok: false, reason: COMMIT_SHA_REFUSAL };
  return { ok: true, commitSha };
}
