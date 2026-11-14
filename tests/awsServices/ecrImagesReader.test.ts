import { afterEach, describe, expect, it, vi } from 'vitest';
import { DescribeImagesCommand, ECRClient } from '@aws-sdk/client-ecr';
import {
  createEcrImagesReader,
  createEcrImageTagsReader,
  parseEcrImageAddress,
  parseEcrImageReference,
} from '@/lib/awsServices/ecrImagesReader';

// THE FLEET STATUS PAGE'S INDEXER IMAGE READ (MOTIR-10986). The SDK client is
// driven at its `send`, so what is asserted is the command, the region the client
// asks, and the plain objects the reader answers with.

const DIGEST = `sha256:${'a'.repeat(64)}`;
const REF = `944842271421.dkr.ecr.us-east-1.amazonaws.com/motir/indexer@${DIGEST}`;
const REPO = { registryId: '944842271421', region: 'us-east-1', repositoryName: 'motir/indexer' };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseEcrImageReference', () => {
  it('splits an ECR reference by digest into registry, region, repository and digest', () => {
    expect(parseEcrImageReference(` ${REF}\n`)).toEqual({
      ...REPO,
      repositoryUri: '944842271421.dkr.ecr.us-east-1.amazonaws.com/motir/indexer',
      digest: DIGEST,
    });
    expect(
      parseEcrImageReference(
        `944842271421.dkr.ecr.cn-north-1.amazonaws.com.cn/motir-prod/indexer@${DIGEST}`,
      ),
    ).toMatchObject({ region: 'cn-north-1', repositoryName: 'motir-prod/indexer' });
  });

  it('is null for a reference that is not ECR by digest', () => {
    expect(parseEcrImageReference(`registry.fly.io/motir-indexer@${DIGEST}`)).toBeNull();
    expect(parseEcrImageReference(`ghcr.io/motir-co/motir-indexer@${DIGEST}`)).toBeNull();
    expect(
      parseEcrImageReference('944842271421.dkr.ecr.us-east-1.amazonaws.com/motir/indexer:0.5.1'),
    ).toBeNull();
  });
});

describe('createEcrImagesReader', () => {
  it('pages through DescribeImages in the reference’s region, skipping images with no digest', async () => {
    const send = vi.spyOn(ECRClient.prototype, 'send').mockImplementation((async (
      command: DescribeImagesCommand,
    ) =>
      command.input.nextToken
        ? { imageDetails: [{ imageDigest: 'sha256:b', imagePushedAt: undefined }] }
        : {
            imageDetails: [
              {
                imageDigest: DIGEST,
                imageTags: ['indexer-0.5.1'],
                imagePushedAt: new Date('2026-11-11T10:00:00Z'),
              },
              { imageTags: ['orphan'] },
            ],
            nextToken: 'n',
          }) as never);
    const reader = createEcrImagesReader();
    expect(await reader.listImages(REPO)).toEqual([
      { digest: DIGEST, tags: ['indexer-0.5.1'], pushedAt: '2026-11-11T10:00:00.000Z' },
      { digest: 'sha256:b', tags: [], pushedAt: null },
    ]);
    const first = send.mock.calls[0]![0] as DescribeImagesCommand;
    expect(first).toBeInstanceOf(DescribeImagesCommand);
    expect(first.input).toEqual({ ...REPOINPUT(), nextToken: undefined, maxResults: 1000 });
    expect((send.mock.calls[1]![0] as DescribeImagesCommand).input.nextToken).toBe('n');
    expect(await (send.mock.contexts[0] as ECRClient).config.region()).toBe('us-east-1');
    // One client per region, reused across reads.
    await reader.listImages(REPO);
    expect(new Set(send.mock.contexts).size).toBe(1);
  });

  it('reads an empty answer as no images, and fails a repository past the pages it reads', async () => {
    let endless = false;
    vi.spyOn(ECRClient.prototype, 'send').mockImplementation((async () =>
      endless ? { imageDetails: [], nextToken: 'more' } : {}) as never);
    const reader = createEcrImagesReader();
    expect(await reader.listImages(REPO)).toEqual([]);
    endless = true;
    await expect(reader.listImages(REPO)).rejects.toThrow('more images than 10 pages');
  });

  it('throws what ECR throws', async () => {
    vi.spyOn(ECRClient.prototype, 'send').mockImplementation((async () => {
      throw new Error('AccessDeniedException');
    }) as never);
    await expect(createEcrImagesReader().listImages(REPO)).rejects.toThrow('AccessDenied');
  });
});

// THE SERVICES PAGE'S DEPLOYED-COMMIT READ (MOTIR-11112): the tags of the ONE
// image a task definition runs, by digest or by tag.

const SHA = 'db9aef8a3c51e7f02b6d4a9e1c8f37b25d06e4a1';
const CORE = '944842271421.dkr.ecr.us-east-1.amazonaws.com/motir/motir-core';
const CORE_REPO = {
  registryId: '944842271421',
  region: 'us-east-1',
  repositoryName: 'motir/motir-core',
};

describe('parseEcrImageAddress', () => {
  it('reads a reference by digest, by tag, and by both', () => {
    expect(parseEcrImageAddress(` ${CORE}@${DIGEST} `)).toEqual({
      ...CORE_REPO,
      tag: null,
      digest: DIGEST,
    });
    expect(parseEcrImageAddress(`${CORE}:${SHA}`)).toEqual({
      ...CORE_REPO,
      tag: SHA,
      digest: null,
    });
    expect(parseEcrImageAddress(`${CORE}:main@${DIGEST}`)).toEqual({
      ...CORE_REPO,
      tag: 'main',
      digest: DIGEST,
    });
  });

  it('is null for an image outside ECR, or one that names neither a tag nor a digest', () => {
    expect(parseEcrImageAddress(`ghcr.io/motir-co/motir-core:${SHA}`)).toBeNull();
    expect(parseEcrImageAddress(CORE)).toBeNull();
    expect(parseEcrImageAddress(`${CORE}@sha256:short`)).toBeNull();
  });
});

describe('createEcrImageTagsReader', () => {
  it('describes the one image by digest, in the reference’s region, and answers its tags', async () => {
    const send = vi.spyOn(ECRClient.prototype, 'send').mockImplementation((async () => ({
      imageDetails: [{ imageDigest: DIGEST, imageTags: [SHA, 'main'] }],
    })) as never);
    const reader = createEcrImageTagsReader();
    const image = { ...CORE_REPO, region: 'eu-central-1', tag: 'main', digest: DIGEST };
    expect(await reader.tagsOf(image)).toEqual([SHA, 'main']);
    const command = send.mock.calls[0]![0] as DescribeImagesCommand;
    expect(command).toBeInstanceOf(DescribeImagesCommand);
    expect(command.input).toEqual({
      registryId: CORE_REPO.registryId,
      repositoryName: CORE_REPO.repositoryName,
      imageIds: [{ imageDigest: DIGEST }],
    });
    expect(await (send.mock.contexts[0] as ECRClient).config.region()).toBe('eu-central-1');
  });

  it('describes by tag when the reference names no digest; an untagged image has no tags', async () => {
    const send = vi.spyOn(ECRClient.prototype, 'send').mockImplementation((async () => ({
      imageDetails: [{ imageDigest: DIGEST }],
    })) as never);
    expect(
      await createEcrImageTagsReader().tagsOf({ ...CORE_REPO, tag: 'latest', digest: null }),
    ).toEqual([]);
    expect((send.mock.calls[0]![0] as DescribeImagesCommand).input.imageIds).toEqual([
      { imageTag: 'latest' },
    ]);
  });

  it('fails when ECR describes no image, and throws what ECR throws', async () => {
    const send = vi
      .spyOn(ECRClient.prototype, 'send')
      .mockImplementation((async () => ({})) as never);
    const image = { ...CORE_REPO, tag: null, digest: DIGEST };
    await expect(createEcrImageTagsReader().tagsOf(image)).rejects.toThrow('described no image');
    send.mockImplementation((async () => {
      throw new Error('ImageNotFoundException');
    }) as never);
    await expect(createEcrImageTagsReader().tagsOf(image)).rejects.toThrow('ImageNotFound');
  });
});

function REPOINPUT() {
  return { registryId: REPO.registryId, repositoryName: REPO.repositoryName };
}
