import { describe, expect, it } from 'vitest';
import {
  AWS_CONTAINER_PREVIEW_SIZE,
  CustomerRepositoryRefusedError,
  IdlePolicyUnsupportedError,
  ReleaseShapeRequiredError,
  awsContainerSize,
  computeUsageFor,
  requireReleaseShape,
  type ReleaseShape,
} from '../src/index';

// The release SHAPE gate and the AWS size table (MOTIR-10002, to MOTIR-5769 §4):
// the shape is an input refused by name when absent, and the compute units a
// release reports come from the same table it was sized with.

describe('requireReleaseShape', () => {
  it('returns the shape it was given', () => {
    expect(requireReleaseShape('aws', { shape: 'function' })).toBe('function');
    expect(requireReleaseShape('aws', { shape: 'container' })).toBe('container');
  });

  it('refuses a missing or unknown shape, naming the target', () => {
    expect(() => requireReleaseShape('aws', {})).toThrow(ReleaseShapeRequiredError);
    const unknown = { shape: 'vm' as unknown as ReleaseShape };
    expect(() => requireReleaseShape('aws', unknown)).toThrow(/aws target needs a release shape/);
  });
});

describe('the AWS size table', () => {
  it('sizes a production container by its row, small when absent; a preview at the preview size', () => {
    const production = { kind: 'production' } as const;
    expect(awsContainerSize(undefined, production)).toEqual({ vcpu: 0.25, memoryGb: 0.5 });
    expect(awsContainerSize('medium', production)).toEqual({ vcpu: 0.5, memoryGb: 1 });
    expect(awsContainerSize('large', production)).toEqual({ vcpu: 1, memoryGb: 2 });
    expect(awsContainerSize('large', { kind: 'preview', pullRequest: 3 })).toBe(
      AWS_CONTAINER_PREVIEW_SIZE,
    );
  });

  it('turns running seconds into Lambda GB-seconds or Fargate units', () => {
    const production = { kind: 'production' } as const;
    expect(computeUsageFor('function', 'large', production, 2048)).toEqual({
      unit: 'lambda',
      gbSeconds: 3538,
    });
    expect(computeUsageFor('container', 'large', production, 10)).toEqual({
      unit: 'fargate',
      vcpuSeconds: 10,
      gbSeconds: 20,
    });
  });
});

describe('the AWS refusals', () => {
  it('carry a stable code and the names they refused', () => {
    expect(new ReleaseShapeRequiredError('aws')).toMatchObject({
      code: 'HOSTING_SHAPE_REQUIRED',
      target: 'aws',
      name: 'ReleaseShapeRequiredError',
    });
    expect(new CustomerRepositoryRefusedError('cmc')).toMatchObject({
      code: 'HOSTING_CUSTOMER_REPOSITORY_REFUSED',
      repositoryId: 'cmc',
      message: expect.stringContaining('cmc'),
    });
    expect(new IdlePolicyUnsupportedError('aws', 'container', 'suspend')).toMatchObject({
      code: 'HOSTING_IDLE_POLICY_UNSUPPORTED',
      shape: 'container',
      mode: 'suspend',
      message: expect.stringContaining('"suspend"'),
    });
  });
});
