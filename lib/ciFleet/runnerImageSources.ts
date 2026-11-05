// WHAT THE RUNNER IMAGE IS BUILT FROM, AND HOW AN IMAGE SAYS WHICH COMMIT IT IS
// (MOTIR-10393).
//
// A change to the runner image reaches the fleet only after a person releases it
// (`runner-v*`, `.github/workflows/release-runner-image.yml`) and moves
// `MOTIR_RUNNER_IMAGE` to the published digest. Nothing about a merge does
// either, on purpose. The daily health check's `runner-image-freshness` step
// (`lib/services/runnerImageFreshnessProbeService.ts`) therefore compares the
// commit the pinned image was built from with the newest default-branch commit
// that touched one of the files below, so a merged image change that was never
// released and pinned is reported the next morning instead of being found by
// the job that needed it.
//
// ⚠️ THE INPUT LIST IS THE BUILD'S, NOT THE DIRECTORY'S. The build context is
// `infra/ci-runner`, but the image holds only the Dockerfile's own layers, the
// three scripts it COPYs, and one label computed by `smoke/list-tools.sh` (the
// tool list the fleet readiness verdict reads, MOTIR-10290 — a change to it
// changes what readiness judges, so it is an image change). The rest of
// `smoke/` and the README are never in it; listing the directory would report a
// README edit as an unreleased image change.
// `tests/ciFleet/runnerImageSources.test.ts` holds this list to the Dockerfile's
// COPY lines, the release's label step and the AMI lane's pull-request paths, so
// a new COPY cannot be added without the probe watching it.

/** The repository the runner image and its AMI are built from. */
export const RUNNER_IMAGE_SOURCE_REPO = { owner: 'motir-co', name: 'motir-core' } as const;

/** Every file the Fly runner image is built from. */
export const RUNNER_IMAGE_INPUTS = [
  'infra/ci-runner/Dockerfile',
  'infra/ci-runner/entrypoint.sh',
  'infra/ci-runner/start-dockerd.sh',
  'infra/ci-runner/job-started.sh',
  'infra/ci-runner/smoke/list-tools.sh',
] as const;

/** Every path the AWS runner AMI is built from: the Dockerfile's pins, the
 *  scripts it copies, and the packer tree — the same set as
 *  `release-ci-runner-ami.yml`'s `pull_request.paths`, minus the workflow file
 *  itself. Not judged yet: `RunnerAmiFreshnessDTO` says why. */
export const RUNNER_AMI_INPUTS = [
  'infra/ci-runner-aws',
  'infra/ci-runner/Dockerfile',
  'infra/ci-runner/entrypoint.sh',
  'infra/ci-runner/start-dockerd.sh',
  'infra/ci-runner/job-started.sh',
] as const;

/** The standard OCI label the release stamps with the commit it built
 *  (https://github.com/opencontainers/image-spec/blob/main/annotations.md). */
export const IMAGE_REVISION_LABEL = 'org.opencontainers.image.revision';

const FULL_SHA = /^[0-9a-f]{40}$/;

/** The commit a label set records, or null when the image predates the label
 *  or the value is not a full commit SHA. */
export function imageRevisionFromLabels(labels: Readonly<Record<string, string>>): string | null {
  const raw = labels[IMAGE_REVISION_LABEL]?.trim().toLowerCase();
  return raw && FULL_SHA.test(raw) ? raw : null;
}

/** The commit a `sha-<commit>` registry tag names — the second tag every
 *  release pushes beside its version — or null for any other tag. */
export function commitFromShaTag(tag: string): string | null {
  const match = /^sha-([0-9a-f]{40})$/.exec(tag.trim().toLowerCase());
  return match ? match[1]! : null;
}

/** The repository without the reference: `ghcr.io/o/n@sha256:…` → `ghcr.io/o/n`. */
export function imageRepositoryOf(image: string): string {
  const at = image.indexOf('@');
  const withoutDigest = at >= 0 ? image.slice(0, at) : image;
  const lastSlash = withoutDigest.lastIndexOf('/');
  const colon = withoutDigest.lastIndexOf(':');
  return colon > lastSlash ? withoutDigest.slice(0, colon) : withoutDigest;
}
