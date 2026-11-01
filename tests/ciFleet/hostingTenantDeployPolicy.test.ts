// MOTIR-10005 — the tenant deploy role's policy, read as data. A permission
// that is too narrow fails only on a live stack, and one that is too wide breaks
// the tenant boundary silently, so both directions are asserted here: what the
// six templates and the three modules need is granted, under the right tag
// condition for its kind of action, and nothing a tenant deploy must never reach
// is. No AWS call.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AWS_CONTAINER_DEPLOY_ACTIONS,
  AWS_FUNCTION_DEPLOY_ACTIONS,
  AWS_REGISTRY_DEPLOY_ACTIONS,
  AWS_TENANT_STACKS_DIR,
} from '@motir/orchestrator';
import {
  TENANT_ACCOUNT_REGION,
  TENANT_DEPLOY_ROLE_NAME,
  TENANT_MODULE_ACTIONS,
  tenantDeployPolicyDocument,
} from '@/lib/ciFleet/hostingTenantAccounts';

interface Statement {
  Sid?: string;
  Effect: 'Allow' | 'Deny';
  Action?: string | string[];
  NotAction?: string | string[];
  Resource: string | string[];
  Condition?: Record<string, Record<string, unknown>>;
}

const DOCUMENT = tenantDeployPolicyDocument();
const STATEMENTS = DOCUMENT.Statement as unknown as Statement[];
const ALLOWS = STATEMENTS.filter((s) => s.Effect === 'Allow');

const list = (value: string | string[] | undefined) => (value === undefined ? [] : [value].flat());

/** IAM's wildcard match, case-insensitive for actions: `*` is any run of
 *  characters (`:` included), `?` one. */
function iamMatches(pattern: string, value: string, caseless = false): boolean {
  const source = pattern
    .split('')
    .map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${source}$`, caseless ? 'i' : '').test(value);
}

/** The allow statements granting `action`. */
function grantsOf(action: string): Statement[] {
  return ALLOWS.filter((s) => list(s.Action).some((p) => iamMatches(p, action, true)));
}

/** Does any allow grant `action` on `resource`? */
function grantedOn(action: string, resource: string): boolean {
  return grantsOf(action).some((s) => list(s.Resource).some((r) => iamMatches(r, resource)));
}

const REQUEST_TAG = 'aws:RequestTag/motir:organization';
const RESOURCE_TAG = 'aws:ResourceTag/motir:organization';
const tagKeys = (s: Statement) => Object.keys(s.Condition?.['Null'] ?? {});

/** Each template resource type and an action CloudFormation calls to create it
 *  under the deploy role. A new resource type fails until it is mapped here. */
const RESOURCE_TYPE_ACTIONS: Record<string, string> = {
  'AWS::EC2::EIP': 'ec2:AllocateAddress',
  'AWS::EC2::InternetGateway': 'ec2:CreateInternetGateway',
  'AWS::EC2::NatGateway': 'ec2:CreateNatGateway',
  'AWS::EC2::Route': 'ec2:CreateRoute',
  'AWS::EC2::RouteTable': 'ec2:CreateRouteTable',
  'AWS::EC2::SecurityGroup': 'ec2:CreateSecurityGroup',
  'AWS::EC2::SecurityGroupIngress': 'ec2:AuthorizeSecurityGroupIngress',
  'AWS::EC2::Subnet': 'ec2:CreateSubnet',
  'AWS::EC2::SubnetRouteTableAssociation': 'ec2:AssociateRouteTable',
  'AWS::EC2::VPC': 'ec2:CreateVpc',
  'AWS::EC2::VPCGatewayAttachment': 'ec2:AttachInternetGateway',
  'AWS::ECR::Repository': 'ecr:CreateRepository',
  'AWS::ECS::Cluster': 'ecs:CreateCluster',
  'AWS::ECS::Service': 'ecs:CreateService',
  'AWS::ECS::TaskDefinition': 'ecs:RegisterTaskDefinition',
  'AWS::ElasticLoadBalancingV2::Listener': 'elasticloadbalancing:CreateListener',
  'AWS::ElasticLoadBalancingV2::ListenerRule': 'elasticloadbalancing:CreateRule',
  'AWS::ElasticLoadBalancingV2::LoadBalancer': 'elasticloadbalancing:CreateLoadBalancer',
  'AWS::ElasticLoadBalancingV2::TargetGroup': 'elasticloadbalancing:CreateTargetGroup',
  'AWS::IAM::OIDCProvider': 'iam:CreateOpenIDConnectProvider',
  'AWS::IAM::Role': 'iam:CreateRole',
  'AWS::Lambda::Alias': 'lambda:CreateAlias',
  'AWS::Lambda::Function': 'lambda:CreateFunction',
  'AWS::Lambda::Permission': 'lambda:AddPermission',
  'AWS::Lambda::Url': 'lambda:CreateFunctionUrlConfig',
  'AWS::Lambda::Version': 'lambda:PublishVersion',
  'AWS::Logs::LogGroup': 'logs:CreateLogGroup',
  'AWS::RDS::DBCluster': 'rds:CreateDBCluster',
  'AWS::RDS::DBInstance': 'rds:CreateDBInstance',
  'AWS::RDS::DBSubnetGroup': 'rds:CreateDBSubnetGroup',
  'AWS::SecretsManager::Secret': 'secretsmanager:CreateSecret',
  'AWS::SecretsManager::SecretTargetAttachment': 'secretsmanager:UpdateSecret',
};

function templateResourceTypes(): string[] {
  const files = readdirSync(AWS_TENANT_STACKS_DIR).filter((f) => f.endsWith('.yaml'));
  expect(files, `no templates in ${AWS_TENANT_STACKS_DIR}`).toHaveLength(6);
  const types = new Set<string>();
  for (const file of files) {
    const text = readFileSync(join(AWS_TENANT_STACKS_DIR, file), 'utf8');
    for (const match of text.matchAll(/^\s+Type: (AWS::[\w:]+)\s*$/gm)) types.add(match[1]!);
  }
  return [...types].sort();
}

describe('the tenant deploy policy — what it grants', () => {
  it("grants an action of every resource type's service in the six templates", () => {
    const types = templateResourceTypes();
    expect(types.length).toBeGreaterThan(20);
    for (const type of types) {
      const action = RESOURCE_TYPE_ACTIONS[type];
      expect(action, `${type} is not mapped to an action`).toBeDefined();
      expect(grantsOf(action!), `${type} needs ${action}`).not.toHaveLength(0);
    }
  });

  it('grants every action the registry, function and container modules export', () => {
    const exported = [
      ...AWS_REGISTRY_DEPLOY_ACTIONS,
      ...AWS_FUNCTION_DEPLOY_ACTIONS,
      ...AWS_CONTAINER_DEPLOY_ACTIONS,
    ];
    expect(new Set(TENANT_MODULE_ACTIONS)).toEqual(new Set(exported));
    for (const action of exported) {
      expect(grantsOf(action), `${action} is not granted`).not.toHaveLength(0);
    }
  });

  it('grants RDS, the Data API, CloudWatch metric reads and the other stack services', () => {
    for (const action of [
      'rds:CreateDBCluster',
      'rds-data:ExecuteStatement',
      'rds-data:BatchExecuteStatement',
      'cloudformation:CreateStack',
      'lambda:UpdateFunctionCode',
      'ecs:UpdateService',
      'elasticloadbalancing:CreateLoadBalancer',
      'ecr:CreateRepository',
      'secretsmanager:GetSecretValue',
      'logs:CreateLogGroup',
      'cloudwatch:GetMetricData',
      'cloudwatch:GetMetricStatistics',
    ]) {
      expect(grantsOf(action), action).not.toHaveLength(0);
    }
  });

  it('refuses every non-IAM action outside the tenant region', () => {
    const regional = STATEMENTS.filter((s) => s.Effect === 'Deny' && s.NotAction !== undefined);
    expect(regional).toEqual([
      {
        Sid: 'OnlyTheTenantRegion',
        Effect: 'Deny',
        NotAction: 'iam:*',
        Resource: '*',
        Condition: { StringNotEquals: { 'aws:RequestedRegion': TENANT_ACCOUNT_REGION } },
      },
    ]);
  });

  it('fits the 10,240-character limit AWS sets on a role’s inline policies', () => {
    expect(JSON.stringify(DOCUMENT).length).toBeLessThanOrEqual(10_240);
  });
});

describe('the tenant deploy policy — its tag conditions', () => {
  it('covers the secrets with tag conditions, never a change or read on * unconditioned', () => {
    const secret = `arn:aws:secretsmanager:${TENANT_ACCOUNT_REGION}:111122223333:secret:motir/repo/x-AbCd`;
    for (const action of [
      'secretsmanager:CreateSecret',
      'secretsmanager:GetSecretValue',
      'secretsmanager:PutSecretValue',
      'secretsmanager:DescribeSecret',
      'secretsmanager:TagResource',
      'secretsmanager:DeleteSecret',
    ]) {
      expect(grantedOn(action, secret), action).toBe(true);
    }
    for (const s of grantsOf('secretsmanager:CreateSecret')) {
      if (list(s.Action).includes('secretsmanager:CreateSecret')) {
        expect(tagKeys(s)).toEqual([REQUEST_TAG]);
      }
    }
    for (const action of ['secretsmanager:GetSecretValue', 'secretsmanager:DeleteSecret']) {
      for (const s of grantsOf(action)) expect(tagKeys(s), action).toEqual([RESOURCE_TAG]);
    }
  });

  it('allows the Data API only on clusters carrying the organisation tag', () => {
    for (const s of grantsOf('rds-data:ExecuteStatement')) {
      expect(tagKeys(s)).toEqual([RESOURCE_TAG]);
      expect(list(s.Resource).every((r) => r.includes(':cluster:'))).toBe(true);
    }
  });

  it('allows on * unconditioned only describe, list, get and read-only calls', () => {
    const unconditioned = ALLOWS.filter(
      (s) => list(s.Resource).includes('*') && s.Condition === undefined,
    );
    for (const s of unconditioned) {
      for (const action of list(s.Action)) {
        expect(action, s.Sid).toMatch(
          /^[\w-]+:(Describe|List|Get)[\w*]*$|^secretsmanager:GetRandomPassword$/,
        );
        expect(action).not.toBe('secretsmanager:GetSecretValue');
      }
    }
  });

  it('puts create actions under the request tag and change actions under the resource tag', () => {
    const expected: Array<[string, string, string]> = [
      ['LambdaCreate', 'lambda:CreateFunction', REQUEST_TAG],
      ['LambdaChange', 'lambda:UpdateFunctionConfiguration', RESOURCE_TAG],
      ['EcsCreate', 'ecs:CreateService', REQUEST_TAG],
      ['EcsChange', 'ecs:UpdateService', RESOURCE_TAG],
      ['DatabaseCreate', 'rds:CreateDBCluster', REQUEST_TAG],
      ['DatabaseChange', 'rds:DeleteDBCluster', RESOURCE_TAG],
      ['LoadBalancingCreate', 'elasticloadbalancing:CreateLoadBalancer', REQUEST_TAG],
      ['LoadBalancingChange', 'elasticloadbalancing:DeleteLoadBalancer', RESOURCE_TAG],
    ];
    for (const [sid, action, tag] of expected) {
      const statement = ALLOWS.find((s) => s.Sid === sid);
      expect(statement, sid).toBeDefined();
      expect(list(statement!.Action)).toContain(action);
      expect(tagKeys(statement!)).toEqual([tag]);
    }
  });

  it('never puts a child-resource action under a request tag', () => {
    for (const action of [
      'lambda:PublishVersion',
      'lambda:CreateAlias',
      'lambda:UpdateAlias',
      'lambda:CreateFunctionUrlConfig',
      'lambda:AddPermission',
      'lambda:PutProvisionedConcurrencyConfig',
      'elasticloadbalancing:CreateRule',
      'elasticloadbalancing:ModifyRule',
      'elasticloadbalancing:DeleteRule',
      'ec2:CreateRoute',
      'ec2:AssociateRouteTable',
    ]) {
      const grants = grantsOf(action);
      expect(grants, action).not.toHaveLength(0);
      for (const s of grants) expect(tagKeys(s), action).not.toContain(REQUEST_TAG);
    }
  });

  it('limits CloudFormation to stacks named motir-*', () => {
    const grants = ALLOWS.filter((s) =>
      list(s.Action).some((a) => a.startsWith('cloudformation:')),
    );
    expect(grants).not.toHaveLength(0);
    for (const s of grants) {
      expect(list(s.Resource)).toEqual([
        `arn:aws:cloudformation:${TENANT_ACCOUNT_REGION}:*:stack/motir-*/*`,
      ]);
    }
    const stack = (name: string) =>
      `arn:aws:cloudformation:${TENANT_ACCOUNT_REGION}:111122223333:stack/${name}/abc`;
    expect(grantedOn('cloudformation:CreateStack', stack('motir-release-mh-x'))).toBe(true);
    expect(grantedOn('cloudformation:CreateStack', stack('someone-else'))).toBe(false);
  });
});

describe('the tenant deploy policy — its narrow IAM', () => {
  it('grants SSM only on the usage parameters', () => {
    for (const action of [
      'ssm:GetParameter',
      'ssm:PutParameter',
      'ssm:DeleteParameter',
      'ssm:AddTagsToResource',
    ]) {
      const grants = grantsOf(action);
      expect(grants, action).not.toHaveLength(0);
      for (const s of grants) {
        expect(list(s.Resource)).toEqual([
          `arn:aws:ssm:${TENANT_ACCOUNT_REGION}:*:parameter/motir/hosting/*`,
        ]);
      }
    }
  });

  it('grants the OIDC provider actions only on the GitHub provider', () => {
    for (const action of [
      'iam:CreateOpenIDConnectProvider',
      'iam:GetOpenIDConnectProvider',
      'iam:TagOpenIDConnectProvider',
    ]) {
      for (const s of grantsOf(action)) {
        expect(list(s.Resource)).toEqual([
          'arn:aws:iam::*:oidc-provider/token.actions.githubusercontent.com',
        ]);
      }
    }
  });

  it('grants service-linked roles only for ECS, load balancing and RDS', () => {
    const grants = grantsOf('iam:CreateServiceLinkedRole');
    expect(grants).toHaveLength(1);
    expect(list(grants[0]!.Resource)).toEqual(['arn:aws:iam::*:role/aws-service-role/*']);
    expect(grants[0]!.Condition).toEqual({
      StringEquals: {
        'iam:AWSServiceName': [
          'ecs.amazonaws.com',
          'elasticloadbalancing.amazonaws.com',
          'rds.amazonaws.com',
        ],
      },
    });
  });

  it('limits role management to motir-* and mh-*-push roles, never *', () => {
    for (const action of [
      'iam:CreateRole',
      'iam:DeleteRole',
      'iam:TagRole',
      'iam:PutRolePolicy',
      'iam:DeleteRolePolicy',
      'iam:PassRole',
    ]) {
      for (const s of grantsOf(action)) {
        expect(list(s.Resource), action).not.toContain('*');
      }
    }
    const role = (name: string) => `arn:aws:iam::111122223333:role/${name}`;
    expect(grantedOn('iam:CreateRole', role('motir-mh-x-fn'))).toBe(true);
    expect(grantedOn('iam:CreateRole', role('mh-repo-preview-push'))).toBe(true);
    expect(grantedOn('iam:CreateRole', role('admin'))).toBe(false);
  });

  it('passes only motir-* roles, only to Lambda and ECS tasks, never a push role', () => {
    const grants = grantsOf('iam:PassRole');
    expect(grants).toHaveLength(1);
    expect(list(grants[0]!.Resource)).toEqual(['arn:aws:iam::*:role/motir-*']);
    expect(grants[0]!.Condition).toEqual({
      StringEquals: { 'iam:PassedToService': ['lambda.amazonaws.com', 'ecs-tasks.amazonaws.com'] },
    });
    expect(
      grantedOn('iam:PassRole', 'arn:aws:iam::111122223333:role/mh-repo-production-push'),
    ).toBe(false);
  });

  it('still denies every IAM action on the deploy role itself', () => {
    expect(STATEMENTS).toContainEqual(
      expect.objectContaining({
        Effect: 'Deny',
        Action: 'iam:*',
        Resource: `arn:aws:iam::*:role/${TENANT_DEPLOY_ROLE_NAME}`,
      }),
    );
  });

  it('grants no IAM user or key, Organizations, billing, S3, ACM or ECR push action', () => {
    for (const action of [
      'iam:CreateUser',
      'iam:CreateAccessKey',
      'iam:AttachUserPolicy',
      'organizations:CreateAccount',
      'organizations:ListAccounts',
      'aws-portal:ViewBilling',
      'billing:GetBillingData',
      'account:CloseAccount',
      's3:CreateBucket',
      's3:GetObject',
      'acm:RequestCertificate',
      'ecr:GetAuthorizationToken',
      'ecr:InitiateLayerUpload',
      'ecr:UploadLayerPart',
      'ecr:CompleteLayerUpload',
      'ecr:PutImage',
    ]) {
      expect(grantsOf(action), action).toEqual([]);
    }
    const prefixes = new Set(
      ALLOWS.flatMap((s) => list(s.Action)).map((action) => action.split(':')[0]),
    );
    for (const absent of ['s3', 'acm', 'organizations', 'aws-portal', 'billing', 'account']) {
      expect(prefixes.has(absent), absent).toBe(false);
    }
  });
});
