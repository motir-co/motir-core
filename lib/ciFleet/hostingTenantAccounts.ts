import {
  AWS_CONTAINER_DEPLOY_ACTIONS,
  AWS_FUNCTION_DEPLOY_ACTIONS,
  AWS_REGISTRY_DEPLOY_ACTIONS,
  AWS_TENANT_DEPLOY_ROLE,
  type AwsPolicyDocument,
  type AwsQuotaTarget,
} from '@motir/orchestrator';
import { orgSegment } from '@/lib/ciFleet/hostAccounts';
import {
  memberAccountEmail,
  memberEmailTemplateProblems,
} from '@/lib/fleetShards/awsMemberAccountPlan';

// AN ENTERPRISE TENANT'S AWS HOSTING ACCOUNT (Story MOTIR-9792 · MOTIR-9939). One
// account per organisation, in Motir's AWS Organization under the `Tenants` OU,
// where every AWS-target application of every project of that organisation runs.
// It is NOT a fleet account: it has its own record (`hosting_tenant_account`), no
// `fleet_shard` row, and nothing that places fleet jobs reads it.
//
// The name is derived from the organisation id ONLY — `tenant-<org>`, with the
// same `orgSegment` the Host account names use — so a pass interrupted after
// `CreateAccount` recomputes the same name, and with it the member email, and
// FINDS the account instead of creating a second. The email is derived on demand
// from the add-shard's template and never stored. Pure: no `db`, no
// `process.env` — the template is the caller's read.

/** Where a tenant account stands. A state is written only after the step it
 *  names has succeeded (the reconcile, `hostingTenantAccountService`). */
export type HostingTenantAccountState =
  | 'requested'
  | 'creating'
  | 'bootstrapping'
  | 'ready'
  | 'refused';

export const HOSTING_TENANT_ACCOUNT_STATES: readonly HostingTenantAccountState[] = [
  'requested',
  'creating',
  'bootstrapping',
  'ready',
  'refused',
];

/** The tenant accounts' region, beside the fleet pools (MOTIR-9701). The one
 *  place to change it. */
export const TENANT_ACCOUNT_REGION = 'us-east-1';

/** The organisational unit, directly under the Organization root, every tenant
 *  account sits in — apart from the pool and Host accounts, ready for handover. */
export const TENANT_OU_NAME = 'Tenants';

/** AWS's limit on an account name. */
export const AWS_ACCOUNT_NAME_MAX = 50;

export interface HostingTenantAccountPlan {
  /** `tenant-<org>` — what the account is created as, and found by on replay. */
  name: string;
  /** The member account's root email, from the add-shard's template; null when
   *  no usable template was passed. Never persisted. */
  memberEmail: string | null;
  region: string;
  ouName: string;
}

/** `tenant-<org>` — the tenant account's name. */
export function tenantAccountName(organizationId: string): string {
  return `tenant-${orgSegment(organizationId)}`;
}

/** What one organisation's tenant account is created as. `memberEmailTemplate` is
 *  the add-shard's `FLEET_AWS_MEMBER_EMAIL_TEMPLATE`, read by the caller. */
export function hostingTenantAccountPlan(
  organizationId: string,
  memberEmailTemplate?: string,
): HostingTenantAccountPlan {
  const name = tenantAccountName(organizationId);
  const usable =
    memberEmailTemplate !== undefined &&
    memberEmailTemplateProblems(memberEmailTemplate).length === 0;
  return {
    name,
    memberEmail: usable ? memberAccountEmail(memberEmailTemplate, name) : null,
    region: TENANT_ACCOUNT_REGION,
    ouName: TENANT_OU_NAME,
  };
}

/** The role a tenant's deploys run as in its account (MOTIR-9941), trusted only by
 *  Motir's management role. */
export const TENANT_DEPLOY_ROLE_NAME = AWS_TENANT_DEPLOY_ROLE;

/** The cost-allocation tag on a tenant account: `motir:organization=<id>`. */
export const TENANT_ORGANIZATION_TAG_KEY = 'motir:organization';

/** A quota raise the bootstrap files in a new tenant account. */
export interface TenantQuotaTarget extends AwsQuotaTarget {
  /** What the quota is, for outcomes and logs. */
  name: string;
}

/** The pre-launch quota targets of a tenant account (Story MOTIR-9792); the AWS
 *  adapter story may change them here. */
export const TENANT_QUOTA_TARGETS: readonly TenantQuotaTarget[] = [
  {
    name: 'fargate-on-demand-vcpu',
    serviceCode: 'fargate',
    quotaCode: 'L-3032A538',
    desiredValue: 64,
  },
  {
    name: 'lambda-concurrent-executions',
    serviceCode: 'lambda',
    quotaCode: 'L-B99A9384',
    desiredValue: 1000,
  },
];

// ── THE DEPLOY ROLE'S POLICY (MOTIR-10005) ──────────────────────────────────
//
// What the six tenant stacks and the registry, function and container modules
// need, and no wider, in the tenant region only (one deny refuses every non-IAM
// action elsewhere). Built from one small statement per service and KIND of
// action, so a test can ask what is granted under which condition:
//
//   create        a taggable resource is created only carrying
//                 `motir:organization` (`aws:RequestTag`) — CloudFormation
//                 propagates the stack's tags onto every resource it creates;
//   change        a change or delete reaches only a resource carrying it
//                 (`aws:ResourceTag`);
//   child         an action on a child of a tagged parent (a function's version,
//                 alias or URL; a listener's rule; a route table's route) takes
//                 the parent's resource tag, or no tag where AWS evaluates none;
//   read          describe, list and get calls; `*` only where AWS supports no
//                 resource-level permission.
//
// No IAM user, access key, Organizations or billing action; no S3 or ACM; no ECR
// push or `ecr:GetAuthorizationToken` (the push roles hold those). Role
// management reaches only `motir-*` roles and the two `mh-*-push` roles, PassRole
// only `motir-*` roles to Lambda and ECS tasks, and the deploy role can never
// touch itself.

/** The tag every tenant resource carries. */
const ORG_TAG = TENANT_ORGANIZATION_TAG_KEY;
const REGION = TENANT_ACCOUNT_REGION;

type Statement = Record<string, unknown>;
type Condition = Record<string, Record<string, unknown>>;

const REQUEST_TAG: Condition = { Null: { [`aws:RequestTag/${ORG_TAG}`]: 'false' } };
const RESOURCE_TAG: Condition = { Null: { [`aws:ResourceTag/${ORG_TAG}`]: 'false' } };

function allow(
  sid: string,
  action: readonly string[],
  resource: string | readonly string[],
  condition?: Condition,
): Statement {
  return {
    Sid: sid,
    Effect: 'Allow',
    Action: [...action],
    Resource: typeof resource === 'string' ? resource : [...resource],
    ...(condition ? { Condition: condition } : {}),
  };
}

const arn = (service: string, resource: string) => `arn:aws:${service}:${REGION}:*:${resource}`;

/** Every release's app name begins `mh-`; every stack, role and log group the
 *  templates make begins `motir-` (or `/motir/`). An ARN wildcard matches `:`
 *  too, so a function's pattern covers its versions and aliases, and a log
 *  group's covers its streams. */
const FUNCTIONS = arn('lambda', 'function:mh-*');
const STACKS = arn('cloudformation', 'stack/motir-*/*');
const LOG_GROUPS = [arn('logs', 'log-group:/aws/lambda/mh-*'), arn('logs', 'log-group:/motir/*')];
const ROLES = ['arn:aws:iam::*:role/motir-*', 'arn:aws:iam::*:role/mh-*-push'];
const GITHUB_OIDC = 'arn:aws:iam::*:oidc-provider/token.actions.githubusercontent.com';

/** Every action but IAM's (which AWS serves from us-east-1) is refused outside
 *  the tenant region, so no allow below needs to repeat it. */
function regionStatements(): Statement[] {
  return [
    {
      Sid: 'OnlyTheTenantRegion',
      Effect: 'Deny',
      NotAction: 'iam:*',
      Resource: '*',
      Condition: { StringNotEquals: { 'aws:RequestedRegion': REGION } },
    },
  ];
}

function cloudFormationStatements(): Statement[] {
  return [
    allow(
      'CloudFormationMotirStacks',
      [
        'cloudformation:CreateStack',
        'cloudformation:UpdateStack',
        'cloudformation:DeleteStack',
        'cloudformation:DescribeStacks',
        'cloudformation:DescribeStackEvents',
        'cloudformation:DescribeStackResources',
        'cloudformation:ListStackResources',
        'cloudformation:GetTemplate',
        'cloudformation:TagResource',
      ],
      STACKS,
    ),
  ];
}

function lambdaStatements(): Statement[] {
  return [
    allow('LambdaCreate', ['lambda:CreateFunction', 'lambda:TagResource'], FUNCTIONS, REQUEST_TAG),
    allow(
      'LambdaChange',
      [
        'lambda:UpdateFunctionCode',
        'lambda:UpdateFunctionConfiguration',
        'lambda:DeleteFunction',
        'lambda:TagResource',
        'lambda:UntagResource',
        'lambda:DeleteAlias',
        'lambda:UpdateFunctionUrlConfig',
        'lambda:DeleteFunctionUrlConfig',
        'lambda:DeleteProvisionedConcurrencyConfig',
        'lambda:RemovePermission',
      ],
      FUNCTIONS,
      RESOURCE_TAG,
    ),
    allow(
      'LambdaChild',
      [
        'lambda:PublishVersion',
        'lambda:CreateAlias',
        'lambda:UpdateAlias',
        'lambda:CreateFunctionUrlConfig',
        'lambda:AddPermission',
        'lambda:PutProvisionedConcurrencyConfig',
      ],
      FUNCTIONS,
      RESOURCE_TAG,
    ),
    allow('LambdaRead', ['lambda:Get*', 'lambda:List*'], FUNCTIONS),
  ];
}

function ecsStatements(): Statement[] {
  return [
    allow(
      'EcsCreate',
      ['ecs:CreateCluster', 'ecs:CreateService', 'ecs:RegisterTaskDefinition', 'ecs:TagResource'],
      '*',
      REQUEST_TAG,
    ),
    allow(
      'EcsChange',
      [
        'ecs:UpdateService',
        'ecs:DeleteService',
        'ecs:DeleteCluster',
        'ecs:DeregisterTaskDefinition',
        'ecs:TagResource',
        'ecs:UntagResource',
      ],
      '*',
      RESOURCE_TAG,
    ),
    allow('EcsRead', ['ecs:Describe*', 'ecs:List*'], '*'),
  ];
}

function loadBalancingStatements(): Statement[] {
  const elb = (resource: string) => arn('elasticloadbalancing', resource);
  const own = [
    elb('loadbalancer/app/motir-*/*'),
    elb('listener/app/motir-*/*'),
    elb('targetgroup/*/*'),
  ];
  return [
    allow(
      'LoadBalancingCreate',
      [
        'elasticloadbalancing:CreateLoadBalancer',
        'elasticloadbalancing:CreateListener',
        'elasticloadbalancing:CreateTargetGroup',
        'elasticloadbalancing:AddTags',
      ],
      own,
      REQUEST_TAG,
    ),
    allow(
      'LoadBalancingChange',
      [
        'elasticloadbalancing:DeleteLoadBalancer',
        'elasticloadbalancing:ModifyLoadBalancerAttributes',
        'elasticloadbalancing:SetSecurityGroups',
        'elasticloadbalancing:SetSubnets',
        'elasticloadbalancing:DeleteListener',
        'elasticloadbalancing:ModifyListener',
        'elasticloadbalancing:DeleteTargetGroup',
        'elasticloadbalancing:ModifyTargetGroup',
        'elasticloadbalancing:ModifyTargetGroupAttributes',
        'elasticloadbalancing:AddTags',
        'elasticloadbalancing:RemoveTags',
      ],
      own,
      RESOURCE_TAG,
    ),
    // A listener rule is a child of the shared listener and takes no tag of its own.
    allow(
      'LoadBalancingChild',
      [
        'elasticloadbalancing:CreateRule',
        'elasticloadbalancing:ModifyRule',
        'elasticloadbalancing:DeleteRule',
        'elasticloadbalancing:SetRulePriorities',
      ],
      [elb('listener/app/motir-*/*'), elb('listener-rule/app/motir-*/*')],
    ),
    allow('LoadBalancingRead', ['elasticloadbalancing:Describe*'], '*'),
  ];
}

function ec2Statements(): Statement[] {
  return [
    allow(
      'NetworkCreate',
      [
        'ec2:CreateVpc',
        'ec2:CreateSubnet',
        'ec2:CreateInternetGateway',
        'ec2:CreateNatGateway',
        'ec2:AllocateAddress',
        'ec2:CreateRouteTable',
        'ec2:CreateSecurityGroup',
        'ec2:CreateTags',
      ],
      '*',
      REQUEST_TAG,
    ),
    allow(
      'NetworkChange',
      [
        'ec2:DeleteVpc',
        'ec2:ModifyVpcAttribute',
        'ec2:DeleteSubnet',
        'ec2:ModifySubnetAttribute',
        'ec2:AttachInternetGateway',
        'ec2:DetachInternetGateway',
        'ec2:DeleteInternetGateway',
        'ec2:DeleteNatGateway',
        'ec2:ReleaseAddress',
        'ec2:DeleteRouteTable',
        'ec2:DeleteSecurityGroup',
        'ec2:AuthorizeSecurityGroupIngress',
        'ec2:AuthorizeSecurityGroupEgress',
        'ec2:RevokeSecurityGroupIngress',
        'ec2:RevokeSecurityGroupEgress',
        'ec2:CreateTags',
        'ec2:DeleteTags',
      ],
      '*',
      RESOURCE_TAG,
    ),
    // Routes and subnet associations are children of a tagged route table.
    allow(
      'NetworkChild',
      [
        'ec2:CreateRoute',
        'ec2:ReplaceRoute',
        'ec2:DeleteRoute',
        'ec2:AssociateRouteTable',
        'ec2:DisassociateRouteTable',
      ],
      '*',
      RESOURCE_TAG,
    ),
    allow('NetworkRead', ['ec2:Describe*'], '*'),
  ];
}

function rdsStatements(): Statement[] {
  return [
    allow(
      'DatabaseCreate',
      [
        'rds:CreateDBCluster',
        'rds:CreateDBInstance',
        'rds:CreateDBSubnetGroup',
        'rds:AddTagsToResource',
      ],
      '*',
      REQUEST_TAG,
    ),
    allow(
      'DatabaseChange',
      [
        'rds:ModifyDBCluster',
        'rds:DeleteDBCluster',
        'rds:EnableHttpEndpoint',
        'rds:DisableHttpEndpoint',
        'rds:ModifyDBInstance',
        'rds:DeleteDBInstance',
        'rds:ModifyDBSubnetGroup',
        'rds:DeleteDBSubnetGroup',
        'rds:AddTagsToResource',
        'rds:RemoveTagsFromResource',
      ],
      '*',
      RESOURCE_TAG,
    ),
    // The Data API: SQL on a tagged cluster, authorised by its tagged secret.
    allow(
      'DatabaseDataApi',
      ['rds-data:ExecuteStatement', 'rds-data:BatchExecuteStatement'],
      arn('rds', 'cluster:*'),
      RESOURCE_TAG,
    ),
    allow('DatabaseRead', ['rds:Describe*', 'rds:ListTagsForResource'], '*'),
  ];
}

function ecrStatements(): Statement[] {
  const repositories = arn('ecr', 'repository/mh/*');
  return [
    allow('RegistryCreate', ['ecr:CreateRepository', 'ecr:TagResource'], repositories, REQUEST_TAG),
    allow(
      'RegistryChange',
      [
        'ecr:DeleteRepository',
        'ecr:PutImageScanningConfiguration',
        'ecr:SetRepositoryPolicy',
        'ecr:TagResource',
        'ecr:UntagResource',
      ],
      repositories,
      RESOURCE_TAG,
    ),
    // Lambda reads the image a function runs with its creator's rights.
    allow(
      'RegistryRead',
      [
        'ecr:DescribeRepositories',
        'ecr:ListTagsForResource',
        'ecr:GetRepositoryPolicy',
        'ecr:BatchGetImage',
        'ecr:GetDownloadUrlForLayer',
      ],
      repositories,
    ),
  ];
}

function secretsStatements(): Statement[] {
  const secrets = arn('secretsmanager', 'secret:motir/*');
  return [
    allow(
      'SecretsCreate',
      ['secretsmanager:CreateSecret', 'secretsmanager:TagResource'],
      secrets,
      REQUEST_TAG,
    ),
    allow(
      'SecretsChange',
      [
        'secretsmanager:GetSecretValue',
        'secretsmanager:PutSecretValue',
        'secretsmanager:DescribeSecret',
        'secretsmanager:UpdateSecret',
        'secretsmanager:DeleteSecret',
        'secretsmanager:TagResource',
        'secretsmanager:UntagResource',
      ],
      secrets,
      RESOURCE_TAG,
    ),
    // A generated secret's value; supports no resource.
    allow('SecretsRandom', ['secretsmanager:GetRandomPassword'], '*'),
  ];
}

function logsAndMetricsStatements(): Statement[] {
  return [
    allow(
      'LogsCreate',
      ['logs:CreateLogGroup', 'logs:TagResource', 'logs:TagLogGroup'],
      LOG_GROUPS,
      REQUEST_TAG,
    ),
    allow(
      'LogsChange',
      [
        'logs:DeleteLogGroup',
        'logs:PutRetentionPolicy',
        'logs:DeleteRetentionPolicy',
        'logs:TagResource',
        'logs:UntagResource',
        'logs:TagLogGroup',
        'logs:UntagLogGroup',
      ],
      LOG_GROUPS,
      RESOURCE_TAG,
    ),
    allow(
      'LogsRead',
      ['logs:DescribeLogGroups', 'logs:ListTagsForResource', 'logs:ListTagsLogGroup'],
      '*',
    ),
    // A function's billed duration; metrics support no resource.
    allow('MetricsRead', ['cloudwatch:GetMetricData', 'cloudwatch:GetMetricStatistics'], '*'),
    // The container shape's usage accrual, one parameter per release.
    allow(
      'UsageParameters',
      ['ssm:GetParameter', 'ssm:PutParameter', 'ssm:DeleteParameter', 'ssm:AddTagsToResource'],
      arn('ssm', 'parameter/motir/hosting/*'),
    ),
  ];
}

function iamStatements(): Statement[] {
  return [
    allow(
      'ReleaseRoles',
      [
        'iam:CreateRole',
        'iam:DeleteRole',
        'iam:GetRole',
        'iam:UpdateAssumeRolePolicy',
        'iam:PutRolePolicy',
        'iam:GetRolePolicy',
        'iam:DeleteRolePolicy',
        'iam:TagRole',
        'iam:UntagRole',
        'iam:ListRolePolicies',
        'iam:ListAttachedRolePolicies',
      ],
      ROLES,
    ),
    allow('PassReleaseRoles', ['iam:PassRole'], 'arn:aws:iam::*:role/motir-*', {
      StringEquals: { 'iam:PassedToService': ['lambda.amazonaws.com', 'ecs-tasks.amazonaws.com'] },
    }),
    allow(
      'GithubOidcProvider',
      [
        'iam:CreateOpenIDConnectProvider',
        'iam:GetOpenIDConnectProvider',
        'iam:TagOpenIDConnectProvider',
      ],
      GITHUB_OIDC,
    ),
    allow(
      'ServiceLinkedRoles',
      ['iam:CreateServiceLinkedRole'],
      'arn:aws:iam::*:role/aws-service-role/*',
      {
        StringEquals: {
          'iam:AWSServiceName': [
            'ecs.amazonaws.com',
            'elasticloadbalancing.amazonaws.com',
            'rds.amazonaws.com',
          ],
        },
      },
    ),
    {
      Sid: 'NeverTheDeployRoleItself',
      Effect: 'Deny',
      Action: 'iam:*',
      Resource: `arn:aws:iam::*:role/${TENANT_DEPLOY_ROLE_NAME}`,
    },
  ];
}

/** The actions the tenant modules call outside CloudFormation, as each module
 *  exports them (registry, function shape, container shape). */
export const TENANT_MODULE_ACTIONS: readonly string[] = [
  ...new Set([
    ...AWS_REGISTRY_DEPLOY_ACTIONS,
    ...AWS_FUNCTION_DEPLOY_ACTIONS,
    ...AWS_CONTAINER_DEPLOY_ACTIONS,
  ]),
];

/** The deploy role's permissions (see above). */
export function tenantDeployPolicyDocument(): AwsPolicyDocument {
  return {
    Version: '2012-10-17',
    Statement: [
      ...regionStatements(),
      ...cloudFormationStatements(),
      ...lambdaStatements(),
      ...ecsStatements(),
      ...loadBalancingStatements(),
      ...ec2Statements(),
      ...rdsStatements(),
      ...ecrStatements(),
      ...secretsStatements(),
      ...logsAndMetricsStatements(),
      ...iamStatements(),
    ],
  };
}

/** Is `value` one of the tenant account states? */
export function isHostingTenantAccountState(value: string): value is HostingTenantAccountState {
  return (HOSTING_TENANT_ACCOUNT_STATES as readonly string[]).includes(value);
}
