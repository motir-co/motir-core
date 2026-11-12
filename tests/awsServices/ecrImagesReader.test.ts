import { afterEach, describe, expect, it, vi } from 'vitest';
import { DescribeImagesCommand, ECRClient } from '@aws-sdk/client-ecr';
import { createEcrImagesReader, parseEcrImageReference } from '@/lib/awsServices/ecrImagesReader';

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

function REPOINPUT() {
  return { registryId: REPO.registryId, repositoryName: REPO.repositoryName };
}
