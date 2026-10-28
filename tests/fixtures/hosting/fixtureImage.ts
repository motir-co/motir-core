// The prebuilt image the fixture manifest (`motir.hosting.json` beside this file)
// describes — the public `traefik/whoami`, pinned by its multi-arch index digest
// (v1.11.0, read from Docker Hub 2026-10-28). The manifest schema refuses unknown
// keys, so the image cannot ride inside the manifest; the operator deploy check
// reads it from here. `whoami` answers `GET /health` with 200 and `GET /` with the
// `WHOAMI_NAME` it was started with, so the answer names the release.
export const HOSTING_FIXTURE_IMAGE =
  'docker.io/traefik/whoami@sha256:200689790a0a0ea48ca45992e0450bc26ccab5307375b41c84dfc4f2475937ab';

export const HOSTING_FIXTURE_MANIFEST_PATH = 'tests/fixtures/hosting/motir.hosting.json';
