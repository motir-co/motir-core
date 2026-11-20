import type { AwsPolicyDocument } from '../aws/management';
import { SERVERLESS_ECR_ROOT, SERVERLESS_EXEC_ROLE } from './names';

// THE SERVERLESS ACCOUNT'S TWO IAM ROLES, AS CODE (MOTIR-11921). Both were
// created by hand under MOTIR-9970 and lived only in AWS, so the first live run
// of the deploy check found four gaps in the deploy role one deploy at a time
// (MOTIR-11829, MOTIR-11847, MOTIR-11920 and the function-URL invoke). This
// module is now the definition of record:
//
//   - `motir-hosting-serverless-deploy`, the scoped role every call of
//     `./client` and `./registry` is made under and `./sign` signs function-URL
//     requests with. It may only touch `mh-*` functions, secrets and log groups
//     and `mh/*` repositories, and may pass only `mh-shared-exec`.
//   - `mh-shared-exec`, the role every hosted function runs as: its own log
//     streams and its overflow environment secret, nothing else.
//
// Each statement is the one the live policy held on 2026-11-20, by the same
// statement id. `./roleConvergence` brings the live roles onto these documents
// and `test/serverlessRoles.test.ts` ties the deploy role to every action the
// adapter sends, so a missing grant fails in CI instead of in a live deploy.
//
// ⚠️ NEVER WIDEN A STATEMENT HERE WITHOUT A CALL THAT NEEDS IT. Every resource is
// bounded by the `mh` names the adapter derives in `./names`; the only `*`
// resources are the four reads IAM cannot scope.

/** The scoped role every serverless call assumes (MOTIR-9970). */
export const SERVERLESS_DEPLOY_ROLE = 'motir-hosting-serverless-deploy';
/** Its one inline policy, named after the role. */
export const SERVERLESS_DEPLOY_POLICY = 'motir-hosting-serverless-deploy';
/** The execution role's one inline policy, named after the role. */
export const SERVERLESS_EXEC_POLICY = SERVERLESS_EXEC_ROLE;

/** The account and region the two roles' resources live in. */
export interface ServerlessRoleScope {
  readonly accountId: string;
  readonly region: string;
}

/** One role as it should stand: its trust policy and its one inline policy. */
export interface ServerlessRoleDefinition {
  readonly roleName: string;
  readonly policyName: string;
  readonly trustPolicy: AwsPolicyDocument;
  readonly policy: AwsPolicyDocument;
}

/** The `mh` name prefix of every function, secret and log group (`mh-`). */
const UNIT_PREFIX = `${SERVERLESS_ECR_ROOT}-`;

export function serverlessFunctionArns(scope: ServerlessRoleScope): string[] {
  const base = `arn:aws:lambda:${scope.region}:${scope.accountId}:function:${UNIT_PREFIX}*`;
  // The bare function and every qualifier (`:live`, a version).
  return [base, `${base}:*`];
}

export function serverlessRepositoryArn(scope: ServerlessRoleScope): string {
  return `arn:aws:ecr:${scope.region}:${scope.accountId}:repository/${SERVERLESS_ECR_ROOT}/*`;
}

export function serverlessSecretArn(scope: ServerlessRoleScope): string {
  return `arn:aws:secretsmanager:${scope.region}:${scope.accountId}:secret:${UNIT_PREFIX}*`;
}

export function serverlessLogGroupArns(scope: ServerlessRoleScope): string[] {
  const base = `arn:aws:logs:${scope.region}:${scope.accountId}:log-group:/aws/lambda/${UNIT_PREFIX}*`;
  return [base, `${base}:*`];
}

export function serverlessExecRoleArn(scope: Pick<ServerlessRoleScope, 'accountId'>): string {
  return `arn:aws:iam::${scope.accountId}:role/${SERVERLESS_EXEC_ROLE}`;
}

/** The deploy role's inline policy, statement by statement. */
export function serverlessDeployPolicy(scope: ServerlessRoleScope): AwsPolicyDocument {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'EcrMh',
        Effect: 'Allow',
        Action: [
          'ecr:CreateRepository',
          'ecr:DescribeRepositories',
          'ecr:DescribeImages',
          'ecr:BatchGetImage',
          'ecr:GetDownloadUrlForLayer',
          // The push `docker push` makes after `./registry`'s login.
          'ecr:BatchCheckLayerAvailability',
          'ecr:InitiateLayerUpload',
          'ecr:UploadLayerPart',
          'ecr:CompleteLayerUpload',
          'ecr:PutImage',
          'ecr:DeleteRepository',
          'ecr:TagResource',
          // Lambda grants itself the pull of a same-account image on
          // CreateFunction, as the caller (MOTIR-11920).
          'ecr:GetRepositoryPolicy',
          'ecr:SetRepositoryPolicy',
        ],
        Resource: serverlessRepositoryArn(scope),
      },
      {
        Sid: 'SecretsMh',
        Effect: 'Allow',
        Action: [
          'secretsmanager:CreateSecret',
          'secretsmanager:DescribeSecret',
          'secretsmanager:PutSecretValue',
          'secretsmanager:UpdateSecret',
          'secretsmanager:DeleteSecret',
          'secretsmanager:TagResource',
        ],
        Resource: serverlessSecretArn(scope),
      },
      {
        Sid: 'LambdaMh',
        Effect: 'Allow',
        Action: [
          'lambda:CreateFunction',
          'lambda:GetFunction',
          'lambda:GetFunctionConfiguration',
          'lambda:ListVersionsByFunction',
          'lambda:UpdateFunctionCode',
          'lambda:UpdateFunctionConfiguration',
          'lambda:PublishVersion',
          'lambda:GetAlias',
          'lambda:CreateAlias',
          'lambda:UpdateAlias',
          'lambda:GetFunctionUrlConfig',
          'lambda:CreateFunctionUrlConfig',
          'lambda:TagResource',
          'lambda:UntagResource',
          'lambda:ListTags',
          'lambda:PutProvisionedConcurrencyConfig',
          'lambda:GetProvisionedConcurrencyConfig',
          'lambda:DeleteProvisionedConcurrencyConfig',
          'lambda:DeleteFunction',
          // Half of what an `AWS_IAM` function URL needs; the other half is
          // `ServerlessFunctionUrlInvoke` below.
          'lambda:InvokeFunctionUrl',
        ],
        Resource: serverlessFunctionArns(scope),
      },
      {
        Sid: 'PassExecRole',
        Effect: 'Allow',
        Action: 'iam:PassRole',
        Resource: serverlessExecRoleArn(scope),
        Condition: { StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com' } },
      },
      {
        Sid: 'LogsMh',
        Effect: 'Allow',
        Action: ['logs:CreateLogGroup', 'logs:DeleteLogGroup', 'logs:TagResource'],
        Resource: serverlessLogGroupArns(scope),
      },
      {
        Sid: 'LogsDescribe',
        Effect: 'Allow',
        Action: 'logs:DescribeLogGroups',
        Resource: `arn:aws:logs:${scope.region}:${scope.accountId}:log-group:*`,
      },
      {
        Sid: 'UnscopableReads',
        Effect: 'Allow',
        Action: [
          'lambda:ListFunctions',
          'ecr:GetAuthorizationToken',
          'cloudwatch:GetMetricData',
          'cloudwatch:GetMetricStatistics',
        ],
        Resource: '*',
      },
      {
        // An `AWS_IAM` function URL needs `lambda:InvokeFunction` beside
        // `lambda:InvokeFunctionUrl`; held only through a function URL, so the
        // role still cannot invoke a function directly (AWS, "Control access to
        // Lambda function URLs"; the signed probe's 403 on 2026-11-20).
        Sid: 'ServerlessFunctionUrlInvoke',
        Effect: 'Allow',
        Action: 'lambda:InvokeFunction',
        Resource: serverlessFunctionArns(scope),
        Condition: { Bool: { 'lambda:InvokedViaFunctionUrl': 'true' } },
      },
    ],
  };
}

/**
 * Who may assume the deploy role (MOTIR-9970): Motir's management role, which
 * every serverless call in production assumes the deploy role from, and the
 * operator who runs the deploy check by hand.
 *
 * ⚠️ THIS LIST IS THE DEFINITION, and the converge REPLACES the live trust with
 * it: dropping an entry here locks that principal out on the next converge.
 * Dropping `role/motir-add-shard` stops every serverless deploy and every
 * signed function-URL request in production. Change it in review, run
 * `converge-roles --dry-run` first, and read the `+arn` / `-arn` it prints.
 */
export const SERVERLESS_DEPLOY_TRUST_PRINCIPALS: readonly string[] = [
  'arn:aws:iam::576360162297:role/motir-add-shard',
  'arn:aws:iam::576360162297:user/zhuyue',
];

/** The deploy role's trust: `sts:AssumeRole` for exactly `principals`. */
export function serverlessDeployTrustPolicy(
  principals: readonly string[] = SERVERLESS_DEPLOY_TRUST_PRINCIPALS,
): AwsPolicyDocument {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { AWS: [...principals] },
        Action: 'sts:AssumeRole',
      },
    ],
  };
}

/** The execution role's inline policy: its own log streams and its overflow
 *  environment secret (`./env`). */
export function serverlessExecPolicy(scope: ServerlessRoleScope): AwsPolicyDocument {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'OwnLogs',
        Effect: 'Allow',
        Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        Resource: `${serverlessLogGroupArns(scope)[0]}:*`,
      },
      {
        Sid: 'OverflowEnv',
        Effect: 'Allow',
        Action: 'secretsmanager:GetSecretValue',
        Resource: serverlessSecretArn(scope),
      },
    ],
  };
}

/** The execution role's trust: Lambda only. */
export const SERVERLESS_EXEC_TRUST_POLICY: AwsPolicyDocument = {
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: { Service: 'lambda.amazonaws.com' },
      Action: 'sts:AssumeRole',
    },
  ],
};

/** Both roles' definitions, deploy role first. */
export function serverlessRoleDefinitions(
  scope: ServerlessRoleScope,
): [ServerlessRoleDefinition, ServerlessRoleDefinition] {
  const { accountId, region } = scope;
  return [
    {
      roleName: SERVERLESS_DEPLOY_ROLE,
      policyName: SERVERLESS_DEPLOY_POLICY,
      trustPolicy: serverlessDeployTrustPolicy(),
      policy: serverlessDeployPolicy({ accountId, region }),
    },
    {
      roleName: SERVERLESS_EXEC_ROLE,
      policyName: SERVERLESS_EXEC_POLICY,
      trustPolicy: SERVERLESS_EXEC_TRUST_POLICY,
      policy: serverlessExecPolicy({ accountId, region }),
    },
  ];
}
