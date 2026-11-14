import { afterEach, describe, expect, it, vi } from 'vitest';
import { ECRClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr';
import {
  createEcrRegistryCredentialReader,
  decodeEcrAuthorizationToken,
  parseEcrRegistryHost,
} from '@/lib/awsServices/ecrRegistryCredential';

// THE INDEX-FLEET PREFLIGHT'S ECR LOGIN (MOTIR-11277). The SDK client is driven
// at its `send`, so what is asserted is the command, the region the client asks,
// and the username/password pair the reader answers with.

const HOST = '944842271421.dkr.ecr.us-east-1.amazonaws.com';
const REGISTRY = { host: HOST, registryId: '944842271421', region: 'us-east-1' };
const b64 = (raw: string) => Buffer.from(raw, 'utf8').toString('base64');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseEcrRegistryHost', () => {
  it('splits a private ECR host into its account and region', () => {
    expect(parseEcrRegistryHost(` ${HOST}\n`)).toEqual(REGISTRY);
    expect(parseEcrRegistryHost('123456789012.dkr.ecr.cn-north-1.amazonaws.com.cn')).toEqual({
      host: '123456789012.dkr.ecr.cn-north-1.amazonaws.com.cn',
      registryId: '123456789012',
      region: 'cn-north-1',
    });
  });

  it('is null for a host that is not a private ECR registry', () => {
    expect(parseEcrRegistryHost('registry.fly.io')).toBeNull();
    expect(parseEcrRegistryHost('ghcr.io')).toBeNull();
    expect(parseEcrRegistryHost('public.ecr.aws')).toBeNull();
    expect(parseEcrRegistryHost('94484227142.dkr.ecr.us-east-1.amazonaws.com')).toBeNull();
    expect(parseEcrRegistryHost(`${HOST}.evil.example`)).toBeNull();
  });
});

describe('decodeEcrAuthorizationToken', () => {
  it('decodes `AWS:<password>`, splitting at the FIRST colon only', () => {
    expect(decodeEcrAuthorizationToken(b64('AWS:pass:with:colons'))).toEqual({
      username: 'AWS',
      password: 'pass:with:colons',
    });
  });

  it.each([
    ['no colon', 'AWSpassword'],
    ['an empty username', ':password'],
    ['an empty password', 'AWS:'],
  ])('refuses a token with %s, naming neither half', (_label, raw) => {
    expect(() => decodeEcrAuthorizationToken(b64(raw))).toThrow(
      'ECR returned an authorization token that is not a user:password pair',
    );
  });
});

describe('createEcrRegistryCredentialReader', () => {
  it('asks GetAuthorizationToken in the registry’s region and decodes the answer', async () => {
    const regions: string[] = [];
    const send = vi.spyOn(ECRClient.prototype, 'send').mockImplementation(async function (
      this: ECRClient,
    ) {
      regions.push(await this.config.region());
      return { authorizationData: [{ authorizationToken: b64('AWS:secret') }] };
    } as never);

    const reader = createEcrRegistryCredentialReader();
    await expect(reader.credentialFor(REGISTRY)).resolves.toEqual({
      username: 'AWS',
      password: 'secret',
    });
    await reader.credentialFor(REGISTRY); // the region's client is reused
    await reader.credentialFor({ ...REGISTRY, region: 'eu-west-1' });

    expect(send).toHaveBeenCalledTimes(3);
    const command = send.mock.calls[0]![0] as GetAuthorizationTokenCommand;
    expect(command).toBeInstanceOf(GetAuthorizationTokenCommand);
    expect(command.input).toEqual({});
    expect(regions).toEqual(['us-east-1', 'us-east-1', 'eu-west-1']);
  });

  it.each([
    ['no authorization data', {}],
    ['an empty list', { authorizationData: [] }],
    ['no token', { authorizationData: [{}] }],
  ])('throws when ECR answers with %s', async (_label, answer) => {
    vi.spyOn(ECRClient.prototype, 'send').mockImplementation((async () => answer) as never);

    await expect(createEcrRegistryCredentialReader().credentialFor(REGISTRY)).rejects.toThrow(
      'ECR returned no authorization token',
    );
  });

  it('lets an SDK refusal through, for the caller to name', async () => {
    vi.spyOn(ECRClient.prototype, 'send').mockImplementation((async () => {
      throw Object.assign(new Error('not authorized to perform: ecr:GetAuthorizationToken'), {
        name: 'AccessDeniedException',
      });
    }) as never);

    await expect(createEcrRegistryCredentialReader().credentialFor(REGISTRY)).rejects.toMatchObject(
      { name: 'AccessDeniedException' },
    );
  });
});
