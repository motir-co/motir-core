/**
 * The LOGIC half of `scripts/assert-deploy-freshness.mjs` (MOTIR-3760).
 *
 * WHAT IT ANSWERS: is the commit PRODUCTION IS RUNNING the head of `main`, and
 * if not, how long has the oldest undeployed commit been waiting?
 *
 * ⚠️ WHY IT EXISTS AT ALL — the cost was the SILENCE, not the wait. On
 * 2026-08-28 `6dafd2ee8` merged at 07:44:30Z, the last release (then on Fly)
 * was 08:47:04Z reusing an image built at 07:51, and at 11:00Z the running
 * worker bundle still contained 278 references to a job engine that no longer
 * exists anywhere in the repository. Production ran code `main` had deleted for over three hours, a
 * scheduled health check dead-lettered against it, and every dashboard was
 * green. A deploy's latency is defensible; a deploy's latency that nobody can
 * SEE is not.
 *
 * ⚠️ THE COMPARISON DOES NOT LIVE IN THE DEPLOYMENT, AND THAT IS THE WHOLE
 * DESIGN. A deployment cannot be the thing that reports it is behind: the state
 * being reported on is the state of the reporter, so the failure that matters
 * most — a release that never happened, a machine serving an old image — is
 * exactly the one it answers "fine" to. So the split is:
 *
 *   * the DEPLOYMENT states ONE fact about itself — which commit it was built
 *     from (`GET /api/health/release`, `app/api/health/release/route.ts`);
 *   * everything else — `main`'s head, the ancestry walk, the age arithmetic and
 *     the alarm — happens OUTSIDE it, in a scheduled workflow
 *     (`.github/workflows/deploy-freshness.yml`) that is red when the gap is too
 *     old.
 *
 * Same arrangement, and the same reason, as `scripts/mainCiRetry.mjs` and the
 * other logic halves in this directory: the runner reads a URL, shells out to
 * `git`, prints and `process.exit`s, none of which a test can call. Everything in THIS module is pure — it takes what was
 * read and returns a verdict — so every branch below has a deliberate negative
 * in `tests/scripts/assert-deploy-freshness.test.ts` rather than being trusted
 * because no red run has contradicted it.
 *
 * ⚠️ AND "COULD NOT READ" IS A THIRD STATE, NEVER A PASS. A probe whose failure
 * is indistinguishable from the answer it was looking for is the failure class
 * this whole card is about, one level down: an unreachable endpoint, a body that
 * is not a sha, and a sha that is not in `main`'s history each get their OWN
 * exit code and each is RED. There is no `?? 0` here and there must never be
 * one.
 */

/**
 * Exit codes. `1` means the deployment is genuinely STALE; `3` means the
 * instrument could not see, which is red for a different reason and says so.
 */
export const EXIT_CURRENT = 0;
export const EXIT_STALE = 1;
export const EXIT_USAGE = 2;
export const EXIT_BLIND_READ = 3;

/**
 * How long the oldest undeployed commit may sit before this goes red, in
 * minutes.
 *
 * ⚠️ DERIVED FROM MEASURED merge→released TIME, NOT CHOSEN. Nine consecutive
 * successful push-to-`main` runs, 2026-08-29/30 (33248423068, 33250609131,
 * 33270573757, 33271383815, 33272081857, 33282807240, 33285015926, 33285023182,
 * 33307649462): created→`Deploy to Fly` complete ran 21.2 · 22.1 · 23.0 · 27.1 ·
 * 34.0 · 34.1 · 34.4 · 42.4 · 45.2 minutes. The worst is 45.2. That was the
 * deploy lane then; it was deleted by MOTIR-10935, and production ships through
 * `.github/workflows/aws-deploy.yml` now — re-measure against that lane's
 * merge→`Deploy to AWS` complete before moving the threshold.
 *
 * A merge BURST costs another cycle on top of that, by design rather than by
 * accident: GitHub holds one PENDING run per concurrency group, so a merge
 * landing while another merge's run is working replaces the queued one and waits
 * for the runner to free (`ci.yml`'s concurrency header, MOTIR-3106). Two
 * back-to-back worst cases is ~90 minutes, and that is the number — a ceiling
 * with an incident behind it (3h15m) roughly twice as far away as the worst
 * healthy run.
 *
 * ⚠️ IT IS NOT A LATENCY TARGET. Lowering it does not make deploys faster; it
 * makes an ordinary busy morning red, and a check that is red on ordinary
 * mornings is a check somebody mutes. Raise it only against a re-measurement of
 * the nine numbers above.
 */
export const DEFAULT_MAX_AGE_MINUTES = 90;

/** A commit sha as GitHub and `git rev-parse` render it. */
const SHA = /^[0-9a-f]{40}$/;

/**
 * Read the deployed commit out of `GET /api/health/release`'s body.
 *
 * ⚠️ LOUD ON ANYTHING IT DOES NOT UNDERSTAND, and that is the point. The failure
 * being designed against is a parser that returns `null` for a body it did not
 * recognise — the caller would then report "unknown", which is a state this
 * check already has a use for, and the real cause (a route that moved, a proxy
 * serving an error page, a body whose shape changed) would never be named.
 *
 * @param {string} body the response body, as text
 * @returns {string} the 40-character commit sha
 * @throws {Error} when the body is not a release payload naming one
 */
export function parseReleaseBody(body) {
  if (typeof body !== 'string' || body.trim() === '') {
    throw new Error('the release endpoint returned an empty body');
  }
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(
      `the release endpoint did not return JSON (first 120 chars: ${body.slice(0, 120)})`,
    );
  }
  if (payload === null || typeof payload !== 'object') {
    throw new Error(`the release endpoint returned ${JSON.stringify(payload)}, not an object`);
  }
  const release = /** @type {Record<string, unknown>} */ (payload)['release'];
  if (release === null || release === undefined) {
    throw new Error(
      'the deployment does not know which commit it was built from — `MOTIR_RELEASE` is unset in ' +
        'the running image. A self-hosted build answers this way legitimately; a production ' +
        'release must not, and `aws-deploy.yml` passes `MOTIR_RELEASE=${{ github.sha }}` as a ' +
        'build argument precisely so it cannot.',
    );
  }
  if (typeof release !== 'string' || !SHA.test(release)) {
    throw new Error(
      `the release endpoint named ${JSON.stringify(release)}, which is not a 40-character commit sha`,
    );
  }
  return release;
}

/**
 * The verdict, from what the runner read.
 *
 * `undeployed` is the commits on `main` that the deployment does NOT have, OLDEST
 * FIRST — `git log --reverse <deployed>..<head>`. It is empty exactly when the
 * deployment is at the head, and its FIRST entry is the one the age is measured
 * from: the oldest commit that has been merged and is not running.
 *
 * ⚠️ THE AGE IS MEASURED FROM THE COMMIT, NOT FROM THE GAP'S SIZE. "Behind by 4
 * commits" is not a defect — a busy hour produces it and the next release clears
 * it. "The oldest thing we merged and did not ship has been waiting 3 hours" is,
 * and it is the sentence the 2026-08-28 incident would have produced at 08:45.
 *
 * @param {object} input
 * @param {string} input.deployed the commit production reports it is running
 * @param {string} input.head `main`'s head commit
 * @param {boolean} input.deployedIsAncestor whether `deployed` is reachable from `head`
 * @param {{ sha: string, committedAt: string }[]} input.undeployed oldest first
 * @param {Date} input.now
 * @param {number} input.maxAgeMinutes
 * @returns {{ code: number, state: string, deployed: string, head: string, behindBy: number,
 *   oldestUndeployed: { sha: string, committedAt: string } | null, ageMinutes: number | null,
 *   maxAgeMinutes: number, detail: string }}
 */
export function assertFreshness({
  deployed,
  head,
  deployedIsAncestor,
  undeployed,
  now,
  maxAgeMinutes = DEFAULT_MAX_AGE_MINUTES,
}) {
  const base = {
    deployed,
    head,
    behindBy: undeployed.length,
    oldestUndeployed: undeployed[0] ?? null,
    ageMinutes: /** @type {number | null} */ (null),
    maxAgeMinutes,
  };

  if (deployed === head) {
    return {
      ...base,
      code: EXIT_CURRENT,
      state: 'current',
      behindBy: 0,
      oldestUndeployed: null,
      detail: 'production is running the head of `main`',
    };
  }

  // ⚠️ THE ONE CASE THAT LOOKS LIKE FRESHNESS AND IS THE OPPOSITE. A deployed
  // commit that is NOT an ancestor of `main` produces an EMPTY `<deployed>..HEAD`
  // — the same emptiness as being up to date — so a check that only counted
  // commits would report "current" for a production running a commit that is not
  // on the trunk at all. That is the state a force-push, a merge into a stale
  // base, or a hand-deploy leaves behind, and it is strictly worse than being
  // behind: nothing that merges later will fix it.
  if (!deployedIsAncestor) {
    return {
      ...base,
      code: EXIT_BLIND_READ,
      state: 'off-trunk',
      behindBy: 0,
      oldestUndeployed: null,
      detail:
        `production reports ${deployed}, which is NOT an ancestor of \`main\` (${head}). It is ` +
        'not behind — it is running something that is not on the trunk, which no later merge ' +
        'will correct. Check for a merge into a stale base, a force-push, or a deploy made by ' +
        'hand.',
    };
  }

  if (undeployed.length === 0) {
    // An ancestor, with nothing between it and the head, and yet not equal to it
    // — arithmetically impossible from a consistent pair of reads, so it is a
    // statement about the READ rather than about the deployment.
    return {
      ...base,
      code: EXIT_BLIND_READ,
      state: 'inconsistent',
      detail:
        `production reports ${deployed} and \`main\` is at ${head}, but the walk between them ` +
        'is empty. The two reads did not see the same history — re-run with a full-depth ' +
        'checkout before drawing any conclusion from this.',
    };
  }

  const oldest = /** @type {{ sha: string, committedAt: string }} */ (undeployed[0]);
  const committedAt = new Date(oldest.committedAt);
  if (Number.isNaN(committedAt.getTime())) {
    return {
      ...base,
      code: EXIT_BLIND_READ,
      state: 'unreadable-date',
      detail: `commit ${oldest.sha} carries an unparseable committer date (${oldest.committedAt})`,
    };
  }

  const ageMinutes = (now.getTime() - committedAt.getTime()) / 60_000;
  const rounded = Math.round(ageMinutes * 10) / 10;
  const shared = { ...base, ageMinutes: rounded, oldestUndeployed: oldest };

  if (ageMinutes > maxAgeMinutes) {
    return {
      ...shared,
      code: EXIT_STALE,
      state: 'stale',
      detail:
        `production is running ${deployed} while \`main\` is at ${head}: ${undeployed.length} ` +
        `commit(s) behind, and the OLDEST of them (${oldest.sha}) merged ${rounded} minutes ago, ` +
        `past the ${maxAgeMinutes}-minute ceiling. Read the push-to-\`main\` runs — the usual ` +
        'causes are a red or cancelled run, and a deploy that never started.',
    };
  }

  return {
    ...shared,
    code: EXIT_CURRENT,
    state: 'behind-within-grace',
    detail:
      `production is running ${deployed}, ${undeployed.length} commit(s) behind \`main\` ` +
      `(${head}). The oldest undeployed commit is ${rounded} minutes old, inside the ` +
      `${maxAgeMinutes}-minute ceiling — a release is expected to be on its way.`,
  };
}

/**
 * The report, for the log and the run summary. One block, so a reader who opens
 * a red run has "behind by what, since when" on the first screen.
 *
 * @param {string} url the endpoint that was read
 * @param {ReturnType<typeof assertFreshness>} result
 * @returns {string}
 */
export function formatResult(url, result) {
  const lines = [
    `deploy freshness — ${result.state.toUpperCase()}`,
    `  read from   ${url}`,
    `  deployed    ${result.deployed}`,
    `  main head   ${result.head}`,
  ];
  if (result.behindBy > 0) lines.push(`  behind by   ${result.behindBy} commit(s)`);
  if (result.oldestUndeployed) {
    lines.push(
      `  oldest      ${result.oldestUndeployed.sha} at ${result.oldestUndeployed.committedAt}`,
    );
  }
  if (result.ageMinutes !== null) {
    lines.push(`  waiting     ${result.ageMinutes} min (ceiling ${result.maxAgeMinutes})`);
  }
  lines.push('', result.detail);
  return lines.join('\n');
}
