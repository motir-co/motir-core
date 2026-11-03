// WHAT THE PINNED RUNNER IMAGE SAYS IT HOLDS (MOTIR-10290).
//
// The runner image's release measures the commands a job step can run inside
// the image it just built — `infra/ci-runner/smoke/list-tools.sh`, run as the
// runner user with the image's own PATH — and stamps the answer onto that image
// as an OCI label, then re-measures the PUBLISHED image by digest and fails the
// release unless the label matches it (`.github/workflows/runner-image.yml`).
// So the list travels with the image: pinning a new digest in
// `MOTIR_RUNNER_IMAGE` changes what the fleet readiness verdict compares jobs
// against, and nobody edits a second list by hand.
//
// An image released before this label existed carries none. That is not "an
// image with no tools": the parser answers null and the verdict says the pinned
// image records no tool list.

/** The OCI label the runner image's release writes. */
export const RUNNER_IMAGE_TOOLS_LABEL = 'co.motir.ci-runner.tools';

/** The tool list a label value holds — comma-separated command names — or null
 *  when the label is absent or empty. */
export function parseRunnerImageTools(
  labels: Readonly<Record<string, string>>,
): ReadonlySet<string> | null {
  const raw = labels[RUNNER_IMAGE_TOOLS_LABEL];
  if (typeof raw !== 'string') return null;
  const tools = raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '');
  return tools.length > 0 ? new Set(tools) : null;
}

/** The label value for a tool list: distinct, sorted, comma-joined — the form
 *  `list-tools.sh` writes. */
export function formatRunnerImageTools(tools: Iterable<string>): string {
  return [...new Set(tools)].sort().join(',');
}
