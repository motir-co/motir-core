import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OrchestratorApiError,
  serverlessRegistryLogin,
  type ServerlessSdkClientFactory,
} from '../src/index';
import { SIM_ACCOUNT, SIM_REGION } from './contract/hostingLambdaSim';

// MOTIR-11847 — the serverless registry login is requested under the SCOPED
// ROLE. The live deploy check (MOTIR-9977) was refused its push because the
// login came from the operator's ambient credentials, a principal the `mh/*`
// repositories do not admit; these tests fail if the token request is made by
// any client but one signing with the assumed role's session.

const ROLE = `arn:aws:iam::${SIM_ACCOUNT}:role/motir-hosting-serverless-deploy`;
const CONFIG = { roleArn: ROLE, region: SIM_REGION };
const REGISTRY = `${SIM_ACCOUNT}.dkr.ecr.${SIM_REGION}.amazonaws.com`;
const SCOPED = { AccessKeyId: 'ASIA-SCOPED', SecretAccessKey: 's', SessionToken: 't' };

const token = (text: string) => Buffer.from(text, 'utf8').toString('base64');

interface Made {
  readonly service: string;
  readonly credentials: unknown;
  readonly sent: string[];
}

/** A factory recording every client it makes; STS assumes the scoped role and
 *  ECR answers `ecr`. */
function account(ecr: () => unknown) {
  const made: Made[] = [];
  const assumed: string[] = [];
  const factory: ServerlessSdkClientFactory = (service, options) => {
    const client: Made = { service, credentials: options.credentials, sent: [] };
    made.push(client);
    return {
      async send(command) {
        const name = (command as object).constructor.name;
        client.sent.push(name);
        if (name === 'AssumeRoleCommand') {
          assumed.push((command as { input: { RoleArn: string } }).input.RoleArn);
          return { Credentials: SCOPED };
        }
        if (name === 'GetAuthorizationTokenCommand') return ecr();
        throw new Error(`unexpected ${name}`);
      },
    };
  };
  return { factory, made, assumed };
}

const answer = (data: object) => () => ({ authorizationData: [data] });
const GOOD = answer({
  authorizationToken: token('AWS:p4ss:word'),
  proxyEndpoint: `https://${REGISTRY}`,
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('serverlessRegistryLogin', () => {
  it('requests the token with an ECR client signing as the assumed scoped role', async () => {
    const { factory, made, assumed } = account(GOOD);
    await serverlessRegistryLogin({ config: CONFIG, clientFactory: factory });

    const ecr = made.find((c) => c.service === 'ecr');
    expect(ecr?.sent).toEqual(['GetAuthorizationTokenCommand']);
    // Ambient credentials would leave the client with none, for the SDK's
    // default chain to fill in: the login must carry the role's session.
    expect(typeof ecr?.credentials).toBe('function');
    const identity = await (ecr!.credentials as () => Promise<{ accessKeyId: string }>)();
    expect(identity.accessKeyId).toBe('ASIA-SCOPED');
    expect(assumed).toEqual([ROLE]);
  });

  it('answers the registry host and the decoded username and password', async () => {
    const { factory } = account(GOOD);
    await expect(
      serverlessRegistryLogin({ config: CONFIG, clientFactory: factory }),
    ).resolves.toEqual({
      registry: REGISTRY,
      username: 'AWS',
      password: 'p4ss:word',
    });
  });

  it('signs with credentials it is handed instead of assuming the role again', async () => {
    const { factory, made, assumed } = account(GOOD);
    const credentials = async () => ({ accessKeyId: 'ASIA-SHARED', secretAccessKey: 's' });
    await serverlessRegistryLogin({ config: CONFIG, clientFactory: factory, credentials });
    expect(made.find((c) => c.service === 'ecr')?.credentials).toBe(credentials);
    expect(assumed).toEqual([]);
  });

  it('reads the role and region from the environment when no config is given', async () => {
    vi.stubEnv('MOTIR_HOSTING_AWS_SERVERLESS_ROLE_ARN', ROLE);
    vi.stubEnv('MOTIR_HOSTING_AWS_REGION', 'eu-west-1');
    const regions: string[] = [];
    const { factory } = account(GOOD);
    await serverlessRegistryLogin({
      clientFactory: (service, options) => {
        regions.push(options.region);
        return factory(service, options);
      },
    });
    // The ECR client: the role's session is assumed lazily, when it signs.
    expect(regions).toEqual(['eu-west-1']);
  });

  it('carries the ECR error code on a refusal, never its message', async () => {
    const { factory } = account(() => {
      throw Object.assign(new Error('token for secret-value'), {
        name: 'AccessDeniedException',
        $metadata: { httpStatusCode: 400 },
      });
    });
    const error = await serverlessRegistryLogin({ config: CONFIG, clientFactory: factory }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OrchestratorApiError);
    expect((error as Error).message).toContain('ecr: AccessDeniedException');
    expect((error as Error).message).not.toContain('secret-value');
  });

  it.each([
    ['no authorization data', () => ({ authorizationData: [] }), /returned no authorization data/],
    ['an empty answer', () => ({}), /returned no authorization data/],
    ['no token', answer({ proxyEndpoint: `https://${REGISTRY}` }), /returned no token/],
    [
      'a token with no colon',
      answer({ authorizationToken: token('AWS'), proxyEndpoint: `https://${REGISTRY}` }),
      /unreadable token/,
    ],
    [
      'a token with no username',
      answer({ authorizationToken: token(':pw'), proxyEndpoint: `https://${REGISTRY}` }),
      /unreadable token/,
    ],
    [
      'a token with no password',
      answer({ authorizationToken: token('AWS:'), proxyEndpoint: `https://${REGISTRY}` }),
      /unreadable token/,
    ],
    [
      'no endpoint',
      answer({ authorizationToken: token('AWS:pw') }),
      /returned no registry endpoint/,
    ],
  ])('refuses %s without echoing the token', async (_label, ecr, message) => {
    const { factory } = account(ecr);
    const error = await serverlessRegistryLogin({ config: CONFIG, clientFactory: factory }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OrchestratorApiError);
    expect((error as Error).message).toMatch(message);
    expect((error as Error).message).not.toContain('pw');
  });

  it('strips the scheme and any trailing slash from the endpoint', async () => {
    const { factory } = account(
      answer({ authorizationToken: token('AWS:pw'), proxyEndpoint: `https://${REGISTRY}/` }),
    );
    expect(
      (await serverlessRegistryLogin({ config: CONFIG, clientFactory: factory })).registry,
    ).toBe(REGISTRY);
  });
});
