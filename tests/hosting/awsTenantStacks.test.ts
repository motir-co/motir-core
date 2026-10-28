// MOTIR-10003 — the AWS tenant stack templates' static lint. The six
// CloudFormation templates are the ONE source of the AWS adapter's
// infrastructure, and a mistake in one only shows when a stack is applied — so
// the rules they must all agree on (the two tags, the parameters, the outputs the
// adapter reads back, stack and role names, the OIDC trust, the shared listener,
// the retained versions) are asserted here, by parsing the YAML. No AWS call.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, type ScalarTag, type CollectionTag, type YAMLMap, type YAMLSeq } from 'yaml';
import { AWS_TENANT_STACKS_DIR } from '@motir/orchestrator';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };

// CloudFormation's short intrinsic forms, as custom tags: `!Ref X` reads as
// `{ Ref: X }`, `!Sub [...]` as `{ 'Fn::Sub': [...] }`, `!GetAtt A.B` as
// `{ 'Fn::GetAtt': ['A', 'B'] }`.
const INTRINSICS = [
  'Ref',
  'Condition',
  'Sub',
  'GetAtt',
  'If',
  'Select',
  'Split',
  'Join',
  'GetAZs',
  'Cidr',
  'Equals',
  'Not',
  'And',
  'Or',
  'FindInMap',
  'Base64',
  'ImportValue',
];
const fnKey = (name: string) => (name === 'Ref' || name === 'Condition' ? name : `Fn::${name}`);
const customTags: Array<ScalarTag | CollectionTag> = INTRINSICS.flatMap((name) => [
  {
    tag: `!${name}`,
    resolve: (value: string) => ({
      [fnKey(name)]: name === 'GetAtt' ? value.split('.') : value,
    }),
  } as ScalarTag,
  {
    tag: `!${name}`,
    collection: 'seq',
    resolve: (seq: YAMLSeq) => ({ [fnKey(name)]: seq.toJSON() }),
  } as unknown as CollectionTag,
  {
    tag: `!${name}`,
    collection: 'map',
    resolve: (map: YAMLMap) => ({ [fnKey(name)]: map.toJSON() }),
  } as unknown as CollectionTag,
]);

interface Template {
  Parameters?: Record<string, Obj>;
  Conditions?: Record<string, Json>;
  Resources: Record<string, { Type: string; Properties?: Obj } & Obj>;
  Outputs?: Record<string, Obj>;
}

const DIR = AWS_TENANT_STACKS_DIR;
const TEMPLATES = [
  'network.yaml',
  'registry.yaml',
  'database.yaml',
  'preview-database.yaml',
  'function-release.yaml',
  'container-release.yaml',
] as const;
const load = (file: string): Template =>
  parse(readFileSync(join(DIR, file), 'utf8'), { customTags }) as Template;
const T = Object.fromEntries(TEMPLATES.map((f) => [f, load(f)])) as Record<
  (typeof TEMPLATES)[number],
  Template
>;
const resourcesOf = (t: Template, type: string) =>
  Object.values(t.Resources).filter((r) => r.Type === type);
const one = (t: Template, type: string) => {
  const found = resourcesOf(t, type);
  expect(found, type).toHaveLength(1);
  return found[0]!;
};

// Resource types that take tags, and those CloudFormation gives no `Tags` at
// all. A template using a type in neither list fails, so a new resource is
// classified before it ships.
const TAGGABLE = new Set([
  'AWS::EC2::VPC',
  'AWS::EC2::InternetGateway',
  'AWS::EC2::Subnet',
  'AWS::EC2::RouteTable',
  'AWS::EC2::EIP',
  'AWS::EC2::NatGateway',
  'AWS::EC2::SecurityGroup',
  'AWS::IAM::OIDCProvider',
  'AWS::IAM::Role',
  'AWS::ElasticLoadBalancingV2::LoadBalancer',
  'AWS::ElasticLoadBalancingV2::TargetGroup',
  'AWS::ECR::Repository',
  'AWS::SecretsManager::Secret',
  'AWS::RDS::DBSubnetGroup',
  'AWS::RDS::DBCluster',
  'AWS::RDS::DBInstance',
  'AWS::Logs::LogGroup',
  'AWS::Lambda::Function',
  'AWS::ECS::Cluster',
  'AWS::ECS::TaskDefinition',
  'AWS::ECS::Service',
]);
const UNTAGGABLE = new Set([
  'AWS::EC2::VPCGatewayAttachment',
  'AWS::EC2::Route',
  'AWS::EC2::SubnetRouteTableAssociation',
  'AWS::EC2::SecurityGroupIngress',
  'AWS::ElasticLoadBalancingV2::Listener',
  'AWS::ElasticLoadBalancingV2::ListenerRule',
  'AWS::SecretsManager::SecretTargetAttachment',
  'AWS::Lambda::Version',
  'AWS::Lambda::Alias',
  'AWS::Lambda::Url',
  'AWS::Lambda::Permission',
]);

/** A `!Sub` string with its parameters filled in, at the longest values a name
 *  can take: a 25-character cuid and a six-digit pull request. */
const LONGEST_RID = 'c'.repeat(25);
const LONGEST_APP_REF = `mh-${LONGEST_RID}-pr999999`;
function longestName(value: Json): string {
  const sub = (value as Obj)['Fn::Sub'];
  expect(typeof sub, JSON.stringify(value)).toBe('string');
  return (sub as string)
    .replaceAll('${RepositoryId}', LONGEST_RID)
    .replaceAll('${AppRef}', LONGEST_APP_REF);
}

describe('the AWS tenant stacks directory', () => {
  it('holds the six templates, the manifest and the README, and ships in the package', () => {
    expect(readdirSync(DIR).sort()).toEqual([...TEMPLATES, 'parameters.json', 'README.md'].sort());
    const pkg = JSON.parse(readFileSync(resolve(DIR, '..', 'package.json'), 'utf8')) as {
      files: string[];
    };
    expect(pkg.files).toContain('aws-tenant-stacks');
  });

  it('names no path outside itself', () => {
    for (const file of readdirSync(DIR)) {
      const text = readFileSync(join(DIR, file), 'utf8');
      expect(text, file).not.toMatch(
        /\.\.\/|\b(?:packages|lib|src|tests|app)\/|@motir\/|motir-core/,
      );
    }
  });

  it('lists every parameter and output of every template in the manifest, and no other', () => {
    const manifest = JSON.parse(readFileSync(join(DIR, 'parameters.json'), 'utf8')) as {
      templates: Record<
        string,
        {
          stackName: string;
          parameters: Array<{ name: string; required: boolean }>;
          outputs: string[];
        }
      >;
    };
    expect(Object.keys(manifest.templates).sort()).toEqual([...TEMPLATES].sort());
    for (const file of TEMPLATES) {
      const entry = manifest.templates[file]!;
      const declared = T[file].Parameters ?? {};
      expect(entry.parameters.map((p) => p.name).sort(), file).toEqual(
        Object.keys(declared).sort(),
      );
      for (const p of entry.parameters) {
        expect(p.required, `${file} ${p.name}`).toBe(!('Default' in declared[p.name]!));
      }
      expect([...entry.outputs].sort(), file).toEqual(Object.keys(T[file].Outputs ?? {}).sort());
      expect(entry.stackName, file).toMatch(/^motir-/);
    }
  });

  it('states a stack name beginning motir- for every template in the README', () => {
    const readme = readFileSync(join(DIR, 'README.md'), 'utf8');
    for (const file of TEMPLATES) {
      const row = readme.split('\n').find((l) => l.startsWith(`| \`${file}\``));
      expect(row, file).toBeDefined();
      const stack = row!.split('|')[3]!.trim();
      expect(stack, file).toMatch(/^`motir-[^`]*`$/);
    }
  });
});

describe('every template', () => {
  it.each(TEMPLATES)(
    '%s takes OrganizationId, and RepositoryId unless it is the network',
    (file) => {
      const params = Object.keys(T[file].Parameters ?? {});
      expect(params).toContain('OrganizationId');
      if (file === 'network.yaml') expect(params).not.toContain('RepositoryId');
      else expect(params).toContain('RepositoryId');
    },
  );

  it.each(TEMPLATES)(
    '%s tags every taggable resource motir:organization and motir:repository',
    (file) => {
      const repository = file === 'network.yaml' ? 'shared' : { Ref: 'RepositoryId' };
      for (const [name, resource] of Object.entries(T[file].Resources)) {
        const known = TAGGABLE.has(resource.Type) || UNTAGGABLE.has(resource.Type);
        expect(known, `${file} ${name}: unclassified type ${resource.Type}`).toBe(true);
        if (!TAGGABLE.has(resource.Type)) continue;
        const tags = Object.fromEntries(
          ((resource.Properties?.['Tags'] ?? []) as Obj[]).map((t) => [t['Key'], t['Value']]),
        );
        expect(tags['motir:organization'], `${file} ${name}`).toEqual({ Ref: 'OrganizationId' });
        expect(tags['motir:repository'], `${file} ${name}`).toEqual(repository);
      }
    },
  );

  it.each(TEMPLATES)(
    '%s names every IAM role motir-… within 64 characters, but the push roles',
    (file) => {
      for (const role of resourcesOf(T[file], 'AWS::IAM::Role')) {
        const name = longestName(role.Properties!['RoleName']!);
        expect(name.length, name).toBeLessThanOrEqual(64);
        if (file === 'registry.yaml') {
          expect(name).toMatch(new RegExp(`^mh-${LONGEST_RID}-(preview|production)-push$`));
        } else {
          expect(name).toMatch(/^motir-/);
        }
      }
    },
  );
});

describe('network.yaml', () => {
  const t = T['network.yaml'];

  it('declares the GitHub OIDC provider, one load balancer and one listener that answers 403', () => {
    expect(one(t, 'AWS::IAM::OIDCProvider').Properties).toMatchObject({
      Url: 'https://token.actions.githubusercontent.com',
      ClientIdList: ['sts.amazonaws.com'],
    });
    one(t, 'AWS::ElasticLoadBalancingV2::LoadBalancer');
    const listener = one(t, 'AWS::ElasticLoadBalancingV2::Listener');
    expect(listener.Properties!['DefaultActions']).toEqual([
      expect.objectContaining({
        Type: 'fixed-response',
        FixedResponseConfig: expect.objectContaining({ StatusCode: '403' }),
      }),
    ]);
  });

  it('admits Postgres to the database group from the app group only', () => {
    const ingress = resourcesOf(t, 'AWS::EC2::SecurityGroupIngress').find(
      (r) => (r.Properties!['GroupId'] as Obj)['Ref'] === 'DatabaseSecurityGroup',
    )!;
    expect(ingress.Properties).toMatchObject({
      FromPort: 5432,
      ToPort: 5432,
      SourceSecurityGroupId: { Ref: 'AppSecurityGroup' },
    });
  });

  it('outputs what the adapter reads back', () => {
    expect(Object.keys(t.Outputs!).sort()).toEqual(
      [
        'VpcId',
        'PrivateSubnetIds',
        'PublicSubnetIds',
        'DatabaseSecurityGroupId',
        'AppSecurityGroupId',
        'AlbArn',
        'AlbListenerArn',
        'AlbDnsName',
      ].sort(),
    );
  });
});

describe('registry.yaml', () => {
  const t = T['registry.yaml'];
  const roles = resourcesOf(t, 'AWS::IAM::Role');
  const roleNamed = (suffix: string) =>
    roles.find((r) => longestName(r.Properties!['RoleName']!).endsWith(suffix))!;

  it('declares the two ECR repositories mh/<rid>/preview and mh/<rid>/production', () => {
    expect(
      resourcesOf(t, 'AWS::ECR::Repository').map((r) => r.Properties!['RepositoryName']),
    ).toEqual([
      { 'Fn::Sub': 'mh/${RepositoryId}/preview' },
      { 'Fn::Sub': 'mh/${RepositoryId}/production' },
    ]);
  });

  it.each([
    ['-preview-push', 'PreviewRepository', ':pull_request'],
    ['-production-push', 'ProductionRepository', ':environment:production'],
  ])('the %s role pushes only to %s and trusts the GitHub ids on %s', (suffix, repo, context) => {
    const role = roleNamed(suffix).Properties!;
    const statements = ((role['Policies'] as Obj[])[0]!['PolicyDocument'] as { Statement: Obj[] })
      .Statement;
    const push = statements.find((s) => (s['Action'] as string[]).includes('ecr:PutImage'))!;
    expect(push['Resource']).toEqual({ 'Fn::GetAtt': [repo, 'Arn'] });
    expect(statements).toContainEqual(
      expect.objectContaining({ Action: 'ecr:GetAuthorizationToken', Resource: '*' }),
    );
    // No statement other than the token reaches beyond the role's own repository.
    for (const s of statements) {
      if (s['Action'] !== 'ecr:GetAuthorizationToken')
        expect(s['Resource']).toEqual(push['Resource']);
    }

    const trust = (role['AssumeRolePolicyDocument'] as { Statement: Obj[] }).Statement[0]!;
    expect(JSON.stringify(trust['Principal'])).toContain(
      'oidc-provider/token.actions.githubusercontent.com',
    );
    const equals = (trust['Condition'] as Obj)['StringEquals'] as Obj;
    expect(equals['token.actions.githubusercontent.com:aud']).toBe('sts.amazonaws.com');
    const sub = (equals['token.actions.githubusercontent.com:sub'] as Obj)['Fn::Sub'] as string;
    expect(sub).toBe(
      `repository_owner_id:\${GithubOwnerId}:repository_id:\${GithubRepositoryId}${context}`,
    );
    // Bound by id, never by name: no `repo:<owner>/<name>` subject.
    expect(JSON.stringify(trust)).not.toMatch(/repo:/);
  });

  it('outputs the repository URIs and the push-role ARNs', () => {
    expect(Object.keys(t.Outputs!).sort()).toEqual(
      [
        'PreviewPushRoleArn',
        'PreviewRepositoryUri',
        'ProductionPushRoleArn',
        'ProductionRepositoryUri',
      ].sort(),
    );
  });
});

describe('database.yaml and preview-database.yaml', () => {
  it('declares an Aurora PostgreSQL Serverless v2 cluster that idles down, with the Data API', () => {
    const t = T['database.yaml'];
    const cluster = one(t, 'AWS::RDS::DBCluster').Properties!;
    expect(cluster).toMatchObject({ Engine: 'aurora-postgresql', EnableHttpEndpoint: true });
    expect((cluster['ServerlessV2ScalingConfiguration'] as Obj)['MinCapacity']).toBe(0);
    expect(one(t, 'AWS::RDS::DBInstance').Properties!['DBInstanceClass']).toBe('db.serverless');
    // The master password is the stack's own tagged secret, not RDS-managed.
    expect(cluster['ManageMasterUserPassword']).toBeUndefined();
    expect(JSON.stringify(cluster['MasterUserPassword'])).toContain('MasterSecret');
    expect(resourcesOf(t, 'AWS::SecretsManager::Secret')).toHaveLength(2);
    expect(Object.keys(t.Outputs!).sort()).toEqual(
      [
        'ClusterArn',
        'ClusterEndpoint',
        'DatabaseName',
        'MasterSecretArn',
        'ProductionConnectionSecretArn',
      ].sort(),
    );
  });

  it('declares one generated preview secret whose name carries the stack id', () => {
    const t = T['preview-database.yaml'];
    const secret = one(t, 'AWS::SecretsManager::Secret').Properties!;
    expect(secret['GenerateSecretString']).toBeDefined();
    expect(JSON.stringify(secret['Name'])).toContain('AWS::StackId');
    expect(Object.keys(t.Outputs!)).toEqual(['PreviewSecretArn']);
  });
});

describe('function-release.yaml', () => {
  const t = T['function-release.yaml'];

  it('declares a 1,769 MB x86_64 image function in the VPC', () => {
    expect(one(t, 'AWS::Lambda::Function').Properties).toMatchObject({
      FunctionName: { Ref: 'AppRef' },
      PackageType: 'Image',
      MemorySize: 1769,
      Architectures: ['x86_64'],
      VpcConfig: expect.objectContaining({ SubnetIds: { Ref: 'PrivateSubnetIds' } }),
    });
  });

  it('retains each replaced version behind the alias live, and fronts it with an IAM function URL', () => {
    const version = one(t, 'AWS::Lambda::Version');
    expect(version).toMatchObject({ UpdateReplacePolicy: 'Retain', DeletionPolicy: 'Retain' });
    const alias = one(t, 'AWS::Lambda::Alias').Properties!;
    expect(alias['Name']).toBe('live');
    expect(one(t, 'AWS::Lambda::Url').Properties).toMatchObject({
      AuthType: 'AWS_IAM',
      Qualifier: 'live',
    });
    expect(one(t, 'AWS::Lambda::Permission').Properties).toMatchObject({
      Action: 'lambda:InvokeFunctionUrl',
      FunctionUrlAuthType: 'AWS_IAM',
      Principal: { Ref: 'InvokePrincipalArn' },
    });
    expect(t.Outputs!['FunctionUrl']).toBeDefined();
  });

  it('sets provisioned concurrency 1 on live only when the idle policy is always_on', () => {
    const alias = one(t, 'AWS::Lambda::Alias').Properties!;
    expect(alias['ProvisionedConcurrencyConfig']).toEqual({
      'Fn::If': ['AlwaysOn', { ProvisionedConcurrentExecutions: 1 }, { Ref: 'AWS::NoValue' }],
    });
    expect(t.Conditions!['AlwaysOn']).toEqual({
      'Fn::Equals': [{ Ref: 'IdlePolicy' }, 'always_on'],
    });
  });
});

describe('container-release.yaml', () => {
  const t = T['container-release.yaml'];

  it('creates no load balancer and no listener — only a target group and one rule on the given listener', () => {
    expect(resourcesOf(t, 'AWS::ElasticLoadBalancingV2::LoadBalancer')).toEqual([]);
    expect(resourcesOf(t, 'AWS::ElasticLoadBalancingV2::Listener')).toEqual([]);
    one(t, 'AWS::ElasticLoadBalancingV2::TargetGroup');
    const rule = one(t, 'AWS::ElasticLoadBalancingV2::ListenerRule').Properties!;
    expect(rule['ListenerArn']).toEqual({ Ref: 'AlbListenerArn' });
    expect(rule['Conditions']).toEqual([
      { Field: 'host-header', HostHeaderConfig: { Values: [{ Ref: 'AppHost' }] } },
      {
        Field: 'http-header',
        HttpHeaderConfig: {
          HttpHeaderName: 'X-Motir-Origin-Secret',
          Values: [{ Ref: 'OriginSecret' }],
        },
      },
    ]);
    expect(t.Parameters!['OriginSecret']!['NoEcho']).toBe(true);
  });

  it('retains replaced task definitions and always runs at least one task', () => {
    expect(one(t, 'AWS::ECS::TaskDefinition').UpdateReplacePolicy).toBe('Retain');
    const service = one(t, 'AWS::ECS::Service').Properties!;
    expect(service['DesiredCount']).toBeGreaterThanOrEqual(1);
    expect(service['ServiceName']).toEqual({ Ref: 'AppRef' });
    expect(t.Parameters!['IdlePolicy']!['AllowedValues']).toEqual(['always_on']);
  });
});
