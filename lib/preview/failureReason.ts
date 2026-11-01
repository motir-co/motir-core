// The lifecycle stores a failed preview's reason as English text on
// `preview_deployment.failure_reason` (MOTIR-5776). The design (MOTIR-5774,
// "Handed to serving") puts the reasons it writes in the copy table, so a page in
// another language shows the translated sentence when the stored text is one of
// them, and the stored text VERBATIM otherwise — a reason Motir did not write
// from a template (an adapter's error message) is never paraphrased.
//
// Each pattern is the lifecycle's own template (`previewLifecycleService.ts`), and
// `tests/preview/failureReason.test.ts` feeds it the lifecycle's literal output.

/** A stored reason recognised as one of the lifecycle's templates. */
export type KnownFailureReason =
  | { readonly key: 'imageBuild'; readonly values: { readonly conclusion: string } }
  | { readonly key: 'healthTimeout'; readonly values: { readonly minutes: string } }
  | { readonly key: 'healthFailed'; readonly values: Record<string, never> };

const IMAGE_BUILD =
  /^The preview image did not build: the "Preview image" workflow ended with "([^"]*)"\. Its run log on GitHub says why\.$/;
const HEALTH_TIMEOUT =
  /^The preview did not pass its health check within (\d+(?:\.\d+)?) minutes\.$/;
const HEALTH_FAILED = 'The preview started but failed its health check.';

/** The template a stored reason was written from, or null to show it verbatim. */
export function knownFailureReason(stored: string): KnownFailureReason | null {
  const build = IMAGE_BUILD.exec(stored);
  if (build) return { key: 'imageBuild', values: { conclusion: build[1]! } };
  const timeout = HEALTH_TIMEOUT.exec(stored);
  if (timeout) return { key: 'healthTimeout', values: { minutes: timeout[1]! } };
  if (stored === HEALTH_FAILED) return { key: 'healthFailed', values: {} };
  return null;
}
