// MOTIR-10003 — the AWS tenant stack templates' static lint. The six
// CloudFormation templates are the ONE source of the AWS adapter's
// infrastructure, and a mistake in one only shows when a stack is applied — so
// the rules they must all agree on (the two tags, the parameters, the outputs the
// adapter reads back, stack and role names, the OIDC trust, the shared listener,
// the front door, the retained versions) are asserted here, by parsing the YAML. No AWS call.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, type ScalarTag, type CollectionTag, type YAMLMap, type YAMLSeq } from 'yaml';
import { AWS_TENANT_STACKS_DIR, deriveOriginSecret } from '@motir/orchestrator';

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
  'AWS::CloudFront::Distribution',
  'AWS::CloudFront::VpcOrigin',
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
        'FrontDoorDomainName',
        'FrontDoorVpcOriginId',
      ].sort(),
    );
  });

  // MOTIR-11846: a forwarder reaches a container release over TLS at CloudFront's
  // own name; the load balancer is internal and admits CloudFront alone.
  it('keeps the load balancer internal, in the private subnets, admitting CloudFront only', () => {
    const lb = one(t, 'AWS::ElasticLoadBalancingV2::LoadBalancer').Properties!;
    expect(lb['Scheme']).toBe('internal');
    expect(lb['Subnets']).toEqual([{ Ref: 'PrivateSubnetA' }, { Ref: 'PrivateSubnetB' }]);
    const group = resourcesOf(t, 'AWS::EC2::SecurityGroup').find((r) =>
      (r.Properties!['GroupDescription'] as string).includes('load balancer'),
    )!;
    expect(group.Properties!['SecurityGroupIngress']).toEqual([
      {
        IpProtocol: 'tcp',
        FromPort: 80,
        ToPort: 80,
        SourcePrefixListId: { Ref: 'CloudFrontOriginFacingPrefixListId' },
      },
    ]);
    expect(t.Parameters!['CloudFrontOriginFacingPrefixListId']).toMatchObject({
      AllowedPattern: '^pl-[0-9a-f]+$',
    });
    expect(t.Parameters!['CloudFrontOriginFacingPrefixListId']!['Default']).toBeUndefined();
  });

  it('fronts the load balancer with one https-only, uncached CloudFront distribution', () => {
    const origin = one(t, 'AWS::CloudFront::VpcOrigin').Properties!;
    expect(origin['VpcOriginEndpointConfig']).toMatchObject({
      Arn: { Ref: 'LoadBalancer' },
      HTTPPort: 80,
      OriginProtocolPolicy: 'http-only',
    });
    const config = one(t, 'AWS::CloudFront::Distribution').Properties!['DistributionConfig'] as Obj;
    expect(config['Enabled']).toBe(true);
    expect(config['Origins']).toEqual([
      expect.objectContaining({
        Id: 'load-balancer',
        DomainName: { 'Fn::GetAtt': ['LoadBalancer', 'DNSName'] },
        VpcOriginConfig: expect.objectContaining({
          VpcOriginId: { 'Fn::GetAtt': ['FrontDoorOrigin', 'Id'] },
        }),
      }),
    ]);
    const behavior = config['DefaultCacheBehavior'] as Obj;
    expect(behavior).toMatchObject({
      TargetOriginId: 'load-balancer',
      ViewerProtocolPolicy: 'https-only',
      // Managed CachingDisabled and AllViewerExceptHostHeader.
      CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
      OriginRequestPolicyId: 'b689b0a8-53d0-40ab-baf2-68738e2966ac',
    });
    expect([...(behavior['AllowedMethods'] as string[])].sort()).toEqual(
      ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'].sort(),
    );
    expect(config['ViewerCertificate']).toEqual({ CloudFrontDefaultCertificate: true });
    expect(t.Outputs!['FrontDoorDomainName']).toEqual({
      Value: { 'Fn::GetAtt': ['FrontDoor', 'DomainName'] },
    });
    // An open container release's own distribution reuses it (MOTIR-12128).
    expect(t.Outputs!['FrontDoorVpcOriginId']).toEqual({
      Value: { 'Fn::GetAtt': ['FrontDoorOrigin', 'Id'] },
    });
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
    expect(t.Resources['Function']!.Properties).toMatchObject({
      FunctionName: { Ref: 'AppRef' },
      PackageType: 'Image',
      MemorySize: 1769,
      Architectures: ['x86_64'],
      VpcConfig: expect.objectContaining({ SubnetIds: { Ref: 'PrivateSubnetIds' } }),
    });
  });

  it('retains each replaced version behind the alias live, and fronts it with an IAM function URL', () => {
    const version = t.Resources['Version']!;
    expect(version).toMatchObject({ UpdateReplacePolicy: 'Retain', DeletionPolicy: 'Retain' });
    const alias = t.Resources['LiveAlias']!.Properties!;
    expect(alias['Name']).toBe('live');
    expect(t.Resources['FunctionUrl']!.Properties).toMatchObject({
      AuthType: 'AWS_IAM',
      Qualifier: 'live',
    });
    // A URL created since October 2025 admits the forwarder only when it holds
    // both actions; InvokeFunction only through the URL (MOTIR-10304).
    expect(t.Resources['ForwarderInvoke']).toMatchObject({
      Type: 'AWS::Lambda::Permission',
      Condition: 'Published',
      Properties: {
        Action: 'lambda:InvokeFunctionUrl',
        FunctionName: { Ref: 'LiveAlias' },
        FunctionUrlAuthType: 'AWS_IAM',
        Principal: { Ref: 'InvokePrincipalArn' },
      },
    });
    expect(t.Resources['ForwarderInvokeFunction']).toMatchObject({
      Type: 'AWS::Lambda::Permission',
      Condition: 'Published',
      Properties: {
        Action: 'lambda:InvokeFunction',
        FunctionName: { Ref: 'LiveAlias' },
        InvokedViaFunctionUrl: true,
        Principal: { Ref: 'InvokePrincipalArn' },
      },
    });
    // The forwarder's two, and the front door's public two.
    expect(resourcesOf(t, 'AWS::Lambda::Permission')).toHaveLength(4);
    expect(t.Outputs!['FunctionUrl']).toBeDefined();
  });

  it('fronts live with a public front door that only the origin secret passes (MOTIR-10129)', () => {
    const published = (name: string) => {
      const resource = t.Resources[name];
      expect(resource, name).toBeDefined();
      expect(resource!['Condition'], name).toBe('Published');
      return resource!.Properties!;
    };
    expect(t.Parameters!['OriginSecret']).toMatchObject({ Type: 'String', NoEcho: true });
    expect(t.Parameters!['OriginSecret']).not.toHaveProperty('Default');
    const fn = published('FrontDoorFunction');
    expect(fn).toMatchObject({
      FunctionName: { 'Fn::Sub': '${AppRef}-front-door' },
      Runtime: 'nodejs22.x',
      Handler: 'index.handler',
      Environment: {
        Variables: {
          // The secret only under motir_edge; the mode explicit (MOTIR-12128).
          MOTIR_FRONT_DOOR_MODE: { 'Fn::If': ['Open', 'open', 'motir_edge'] },
          MOTIR_FRONT_DOOR_SECRET: {
            'Fn::If': ['Open', { Ref: 'AWS::NoValue' }, { Ref: 'OriginSecret' }],
          },
          MOTIR_FRONT_DOOR_TARGET: { Ref: 'LiveAlias' },
        },
      },
    });
    // It answers after the app would: the app's own timeout decides first.
    expect(fn['Timeout'] as number).toBeGreaterThan(
      t.Resources['Function']!.Properties!['Timeout'] as number,
    );
    // It calls only the Lambda API, so it sits outside the VPC.
    expect(fn).not.toHaveProperty('VpcConfig');
    expect(String((fn['Code'] as Obj)['ZipFile'])).toContain("'x-motir-origin-secret'");
    // Its role may invoke `live` and nothing else of the account's.
    const role = published('FrontDoorRole');
    const statements = ((role['Policies'] as Obj[])[0]!['PolicyDocument'] as Obj)[
      'Statement'
    ] as Obj[];
    expect(statements).toContainEqual({
      Effect: 'Allow',
      Action: 'lambda:InvokeFunction',
      Resource: { Ref: 'LiveAlias' },
    });
    expect(statements.map((st) => st['Action'])).toEqual([
      ['logs:CreateLogStream', 'logs:PutLogEvents'],
      'lambda:InvokeFunction',
    ]);
    expect(published('FrontDoorVersion')['Description']).toEqual({
      'Fn::Sub': 'front door ${FrontDoorRevision}',
    });
    expect(published('FrontDoorAlias')).toMatchObject({
      Name: 'live',
      FunctionVersion: { 'Fn::GetAtt': ['FrontDoorVersion', 'Version'] },
      ProvisionedConcurrencyConfig: {
        'Fn::If': ['AlwaysOn', { ProvisionedConcurrentExecutions: 1 }, { Ref: 'AWS::NoValue' }],
      },
    });
    expect(published('FrontDoorUrl')).toEqual({
      TargetFunctionArn: { Ref: 'FrontDoorFunction' },
      Qualifier: 'live',
      AuthType: 'NONE',
      InvokeMode: 'BUFFERED',
    });
    // A public URL created since October 2025 needs both actions granted to `*`.
    expect(published('FrontDoorPublicUrl')).toEqual({
      Action: 'lambda:InvokeFunctionUrl',
      FunctionName: { Ref: 'FrontDoorAlias' },
      FunctionUrlAuthType: 'NONE',
      Principal: '*',
    });
    expect(published('FrontDoorPublicInvoke')).toEqual({
      Action: 'lambda:InvokeFunction',
      FunctionName: { Ref: 'FrontDoorAlias' },
      InvokedViaFunctionUrl: true,
      Principal: '*',
    });
    expect(t.Outputs!['FrontDoorUrl']).toEqual({
      Condition: 'Published',
      Value: { 'Fn::GetAtt': ['FrontDoorUrl', 'FunctionUrl'] },
    });
  });

  it('sets provisioned concurrency 1 on live only when the idle policy is always_on', () => {
    const alias = t.Resources['LiveAlias']!.Properties!;
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

  it('creates no load balancer and no listener — only a target group and one rule on the given listener, matching the origin secret alone', () => {
    expect(resourcesOf(t, 'AWS::ElasticLoadBalancingV2::LoadBalancer')).toEqual([]);
    expect(resourcesOf(t, 'AWS::ElasticLoadBalancingV2::Listener')).toEqual([]);
    one(t, 'AWS::ElasticLoadBalancingV2::TargetGroup');
    // The open rule is MOTIR-12128's, and only under Open (below).
    const rules = resourcesOf(t, 'AWS::ElasticLoadBalancingV2::ListenerRule').filter(
      (r) => r['Condition'] === undefined,
    );
    expect(rules).toHaveLength(1);
    const rule = rules[0]!.Properties!;
    expect(rule['ListenerArn']).toEqual({ Ref: 'AlbListenerArn' });
    expect(rule['Conditions']).toEqual([
      {
        Field: 'http-header',
        HttpHeaderConfig: {
          HttpHeaderName: 'X-Motir-Origin-Secret',
          Values: [{ Ref: 'OriginSecret' }],
        },
      },
    ]);
    expect(t.Parameters!['OriginSecret']!['NoEcho']).toBe(true);
    // No app host and no apps domain (MOTIR-11846).
    expect(t.Parameters!['AppHost']).toBeUndefined();
  });

  it('retains replaced task definitions and always runs at least one task', () => {
    expect(one(t, 'AWS::ECS::TaskDefinition').UpdateReplacePolicy).toBe('Retain');
    const service = one(t, 'AWS::ECS::Service').Properties!;
    expect(service['DesiredCount']).toBeGreaterThanOrEqual(1);
    expect(service['ServiceName']).toEqual({ Ref: 'AppRef' });
    expect(t.Parameters!['IdlePolicy']!['AllowedValues']).toEqual(['always_on']);
  });
});

// MOTIR-12128 — the open mode, rendered: the templates' conditions evaluated for
// a parameter set, the resources and outputs that set creates, and their
// properties with every `!If` and parameter `!Ref` resolved.
describe('the open mode (MOTIR-12128)', () => {
  const APP = 'mh-cmrepo1';
  const SECRET = deriveOriginSecret('origin-key-do-not-leak', APP);

  function render(t: Template, given: Record<string, string>) {
    const params: Record<string, string> = {};
    for (const [name, p] of Object.entries(t.Parameters ?? {})) {
      if (name in given) params[name] = given[name]!;
      else if ('Default' in p) params[name] = String(p['Default']);
    }
    const NO_VALUE = Symbol('NoValue');
    const condition = (name: string): boolean => test(t.Conditions![name]!);
    function test(expr: Json): boolean {
      const [op, args] = Object.entries(expr as Obj)[0]!;
      const list = args as Json[];
      if (op === 'Condition') return condition(args as string);
      if (op === 'Fn::Equals') return resolve(list[0]!) === resolve(list[1]!);
      if (op === 'Fn::Not') return !test(list[0]!);
      if (op === 'Fn::And') return list.every(test);
      if (op === 'Fn::Or') return list.some(test);
      throw new Error(`unknown condition ${op}`);
    }
    function resolve(value: Json): Json | typeof NO_VALUE {
      if (Array.isArray(value)) {
        return value.map(resolve).filter((v): v is Json => v !== NO_VALUE);
      }
      if (value === null || typeof value !== 'object') return value;
      const keys = Object.keys(value);
      if (keys.length === 1 && keys[0] === 'Ref') {
        const ref = value['Ref'] as string;
        if (ref === 'AWS::NoValue') return NO_VALUE;
        return ref in params ? params[ref]! : value;
      }
      if (keys.length === 1 && keys[0] === 'Fn::If') {
        const [name, yes, no] = value['Fn::If'] as [string, Json, Json];
        return resolve(condition(name) ? yes : no);
      }
      const out: Obj = {};
      for (const [k, v] of Object.entries(value)) {
        const r = resolve(v);
        if (r !== NO_VALUE) out[k] = r;
      }
      return out;
    }
    const kept = (entries: Record<string, Obj>) =>
      Object.entries(entries)
        .filter(([, r]) => r['Condition'] === undefined || condition(r['Condition'] as string))
        .map(([name]) => name)
        .sort();
    return {
      resources: kept(t.Resources),
      outputs: kept(t.Outputs ?? {}),
      properties: (name: string) => resolve(t.Resources[name]!.Properties!) as Obj,
      output: (name: string) => resolve(t.Outputs![name]!) as Obj,
    };
  }

  const FUNCTION_RESOURCES = [
    'EnvironmentSecret',
    'LogGroup',
    'ExecutionRole',
    'Function',
    'Version',
    'LiveAlias',
    'FunctionUrl',
    'ForwarderInvoke',
    'ForwarderInvokeFunction',
    'FrontDoorLogGroup',
    'FrontDoorRole',
    'FrontDoorFunction',
    'FrontDoorVersion',
    'FrontDoorAlias',
    'FrontDoorUrl',
    'FrontDoorPublicUrl',
    'FrontDoorPublicInvoke',
  ].sort();
  const FUNCTION_OUTPUTS = [
    'FunctionName',
    'FunctionArn',
    'EnvironmentSecretArn',
    'FunctionUrl',
    'LiveVersion',
    'FrontDoorUrl',
  ].sort();
  const CONTAINER_RESOURCES = [
    'EnvironmentSecret',
    'LogGroup',
    'Cluster',
    'ExecutionRole',
    'TaskRole',
    'TaskDefinition',
    'TargetGroup',
    'ListenerRule',
    'Service',
  ].sort();
  const CONTAINER_OUTPUTS = [
    'ClusterArn',
    'ServiceArn',
    'ServiceName',
    'TaskDefinitionArn',
    'TargetGroupArn',
    'EnvironmentSecretArn',
  ].sort();

  const published = { AppRef: APP, ConfigHash: 'h'.repeat(64), OriginSecret: SECRET };
  const containerOpen = {
    ...published,
    OriginAccess: 'open',
    OpenListenerRulePriority: '4242',
    FrontDoorVpcOriginId: 'vo_tenant',
    AlbDnsName: 'internal-motir-tenant-1.us-east-1.elb.amazonaws.com',
  };

  it.each(['function-release.yaml', 'container-release.yaml'] as const)(
    '%s takes OriginAccess, motir_edge or open, defaulting to motir_edge',
    (file) => {
      expect(T[file].Parameters!['OriginAccess']).toMatchObject({
        Type: 'String',
        Default: 'motir_edge',
        AllowedValues: ['motir_edge', 'open'],
      });
      expect(T[file].Conditions!['Open']).toEqual({
        'Fn::Equals': [{ Ref: 'OriginAccess' }, 'open'],
      });
    },
  );

  it('creates, without OriginAccess, exactly what each release stack created before it', () => {
    for (const [file, resources, outputs] of [
      ['function-release.yaml', FUNCTION_RESOURCES, FUNCTION_OUTPUTS],
      ['container-release.yaml', CONTAINER_RESOURCES, CONTAINER_OUTPUTS],
    ] as const) {
      const t = T[file];
      const bare = render(t, published);
      expect(bare.resources, file).toEqual(resources);
      expect(bare.outputs, file).toEqual(outputs);
      // `motir_edge` said out loud is the same stack, and no resource or output
      // conditioned on Open is in it.
      const edge = render(t, { ...published, OriginAccess: 'motir_edge' });
      expect(edge.resources, file).toEqual(bare.resources);
      expect(edge.outputs, file).toEqual(bare.outputs);
      const open = Object.entries({ ...t.Resources, ...t.Outputs })
        .filter(([, r]) => r['Condition'] === 'Open')
        .map(([name]) => name);
      for (const name of open) expect(bare.resources).not.toContain(name);
      expect(
        bare.properties('Function' in t.Resources ? 'FrontDoorFunction' : 'ListenerRule'),
      ).toEqual(edge.properties('Function' in t.Resources ? 'FrontDoorFunction' : 'ListenerRule'));
    }
  });

  it('opens a function release by its front door alone: the same resources, a mode and no secret', () => {
    const t = T['function-release.yaml'];
    const edge = render(t, published);
    const open = render(t, { ...published, OriginAccess: 'open' });
    expect(open.resources).toEqual(FUNCTION_RESOURCES);
    expect(open.outputs).toEqual(FUNCTION_OUTPUTS);
    const variables = (r: ReturnType<typeof render>) =>
      (r.properties('FrontDoorFunction')['Environment'] as Obj)['Variables'] as Obj;
    expect(variables(edge)).toEqual({
      MOTIR_FRONT_DOOR_MODE: 'motir_edge',
      MOTIR_FRONT_DOOR_SECRET: SECRET,
      MOTIR_FRONT_DOOR_TARGET: { Ref: 'LiveAlias' },
    });
    expect(variables(open)).toEqual({
      MOTIR_FRONT_DOOR_MODE: 'open',
      MOTIR_FRONT_DOOR_TARGET: { Ref: 'LiveAlias' },
    });
    expect(JSON.stringify(open.properties('FrontDoorFunction'))).not.toContain(SECRET);
    // The app's own URL stays IAM-only in both modes.
    expect(open.properties('FunctionUrl')['AuthType']).toBe('AWS_IAM');
    expect(open.properties('FrontDoorUrl')).toEqual(edge.properties('FrontDoorUrl'));
  });

  it('opens a container release with a second rule on X-Motir-App and its own distribution, the secret rule unchanged', () => {
    const t = T['container-release.yaml'];
    const edge = render(t, published);
    const open = render(t, containerOpen);
    expect(open.resources).toEqual(
      [...CONTAINER_RESOURCES, 'OpenFrontDoor', 'OpenListenerRule'].sort(),
    );
    expect(open.outputs).toEqual([...CONTAINER_OUTPUTS, 'OpenUpstreamUrl'].sort());
    expect(open.properties('ListenerRule')).toEqual(edge.properties('ListenerRule'));
    expect(open.properties('OpenListenerRule')).toEqual({
      ListenerArn: { Ref: 'AlbListenerArn' },
      Priority: '4242',
      Conditions: [
        {
          Field: 'http-header',
          HttpHeaderConfig: { HttpHeaderName: 'X-Motir-App', Values: [APP] },
        },
      ],
      Actions: [{ Type: 'forward', TargetGroupArn: { Ref: 'TargetGroup' } }],
    });

    const config = open.properties('OpenFrontDoor')['DistributionConfig'] as Obj;
    expect(config['Origins']).toEqual([
      {
        Id: 'load-balancer',
        DomainName: containerOpen.AlbDnsName,
        OriginCustomHeaders: [{ HeaderName: 'X-Motir-App', HeaderValue: APP }],
        VpcOriginConfig: {
          VpcOriginId: 'vo_tenant',
          OriginReadTimeout: 60,
          OriginKeepaliveTimeout: 60,
        },
      },
    ]);
    // Cached and forwarded exactly as the network's own front door.
    const network = (
      one(T['network.yaml'], 'AWS::CloudFront::Distribution').Properties![
        'DistributionConfig'
      ] as Obj
    )['DefaultCacheBehavior'];
    expect(config['DefaultCacheBehavior']).toEqual(network);
    expect(config['ViewerCertificate']).toEqual({ CloudFrontDefaultCertificate: true });
    expect(open.output('OpenUpstreamUrl')).toEqual({
      Condition: 'Open',
      Value: { 'Fn::Sub': 'https://${OpenFrontDoor.DomainName}' },
    });
    // No value derived from the origin-secret key is on the open path.
    expect(
      JSON.stringify([open.properties('OpenFrontDoor'), open.properties('OpenListenerRule')]),
    ).not.toContain(SECRET);
  });
});
