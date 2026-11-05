import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  commitFromShaTag,
  IMAGE_REVISION_LABEL,
  imageRepositoryOf,
  imageRevisionFromLabels,
  RUNNER_AMI_INPUTS,
  RUNNER_IMAGE_INPUTS,
} from '@/lib/ciFleet/runnerImageSources';

// WHAT THE RUNNER IMAGE IS BUILT FROM (MOTIR-10393), held to the build itself.
// The freshness probe watches exactly `RUNNER_IMAGE_INPUTS`; a COPY added to the
// Dockerfile without it here would be an image change the probe never reports,
// and listing a file the image does not hold would report a change that is not
// one. Both lists are read from their sources, never restated.

const ROOT = process.cwd();
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

describe('the runner image inputs', () => {
  it('are the Dockerfile, exactly the files it COPYs or ADDs, and the tool-label script', () => {
    const dockerfile = read('infra/ci-runner/Dockerfile');
    const copied = [...dockerfile.matchAll(/^(?:COPY|ADD)\s+(.+)$/gm)].flatMap((m) => {
      // A `--from=<stage>` copy reads another stage, not the build context.
      if (/--from=/.test(m[1]!)) return [];
      const parts = m[1]!.split(/\s+/).filter((p) => !p.startsWith('--'));
      return parts.slice(0, -1).map((source) => `infra/ci-runner/${source}`);
    });
    expect(copied.length).toBeGreaterThan(0);
    // The release stamps the tool-list label from this script's output, so the
    // script is an input of the published image.
    expect(read('.github/workflows/runner-image.yml')).toMatch(
      /tools=\$\(infra\/ci-runner\/smoke\/list-tools\.sh/,
    );
    expect([...RUNNER_IMAGE_INPUTS].sort()).toEqual(
      ['infra/ci-runner/Dockerfile', 'infra/ci-runner/smoke/list-tools.sh', ...copied].sort(),
    );
  });

  it("are the AMI's too, beside the packer tree — the AMI lane's pull-request paths", () => {
    const workflow = parse(read('.github/workflows/release-ci-runner-ami.yml')) as {
      on: { pull_request: { paths: string[] } };
    };
    const lanePaths = workflow.on.pull_request.paths
      .filter((p) => p !== '.github/workflows/release-ci-runner-ami.yml')
      .map((p) => p.replace(/\/\*\*$/, ''));
    expect([...RUNNER_AMI_INPUTS].sort()).toEqual(lanePaths.sort());
  });

  it('the release stamps the revision label the probe reads, and verifies it on the published bytes', () => {
    const lane = read('.github/workflows/runner-image.yml');
    expect(lane).toContain(`${IMAGE_REVISION_LABEL}=\${{ github.sha }}`);
    expect(lane).toContain(`"${IMAGE_REVISION_LABEL}"`);
    // The sha- tag the probe falls back to on an image released before the label.
    expect(lane).toContain(':sha-${{ github.sha }}');
  });
});

describe('imageRevisionFromLabels', () => {
  it('reads a full commit SHA, lower-cased, and nothing else', () => {
    const sha = 'A4E83F13C8A344FD306993B997C9C361C29AA3E4';
    expect(imageRevisionFromLabels({ [IMAGE_REVISION_LABEL]: ` ${sha} ` })).toBe(sha.toLowerCase());
    expect(imageRevisionFromLabels({ [IMAGE_REVISION_LABEL]: 'a4e83f1' })).toBeNull();
    expect(imageRevisionFromLabels({ [IMAGE_REVISION_LABEL]: '' })).toBeNull();
    expect(imageRevisionFromLabels({})).toBeNull();
  });
});

describe('commitFromShaTag', () => {
  it('reads the commit of a sha- tag and ignores a version tag', () => {
    const sha = '4a9cb14b54e2366d2a30ad19ac4b924dddca6d31';
    expect(commitFromShaTag(`sha-${sha}`)).toBe(sha);
    expect(commitFromShaTag('0.2.4')).toBeNull();
    expect(commitFromShaTag('sha-4a9cb14')).toBeNull();
  });
});

describe('imageRepositoryOf', () => {
  it('drops a digest or a tag, and keeps a registry port', () => {
    expect(imageRepositoryOf(`ghcr.io/motir-co/motir-ci-runner@sha256:${'46'.repeat(32)}`)).toBe(
      'ghcr.io/motir-co/motir-ci-runner',
    );
    expect(imageRepositoryOf('ghcr.io/motir-co/motir-ci-runner:0.2.4')).toBe(
      'ghcr.io/motir-co/motir-ci-runner',
    );
    expect(imageRepositoryOf('localhost:5000/runner')).toBe('localhost:5000/runner');
  });
});
