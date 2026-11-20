import {
  GetRoleCommand,
  GetRolePolicyCommand,
  IAMClient,
  PutRolePolicyCommand,
  UpdateAssumeRolePolicyCommand,
} from '@aws-sdk/client-iam';
import { OrchestratorApiError } from '../../errors';
import {
  ServerlessRoleMissingError,
  ServerlessRoleReadBackMismatchError,
} from '../../hosting/errors';
import type { AwsPolicyDocument } from '../aws/management';
import { awsErrorCode, type AwsCredentialIdentity, type ServerlessSdkClient } from './client';
import { serverlessRoleDefinitions, type ServerlessRoleDefinition } from './roles';

// CONVERGE THE SERVERLESS ACCOUNT'S TWO ROLES ON THEIR DEFINITIONS (MOTIR-11921),
// the serverless twin of `fleet-admin hosting-tenant converge-deploy-policy`
// (MOTIR-10005). For each role of `./roles` it reads the live trust policy and
// the live inline policy, writes each ONLY when it differs from the definition,
// reads it back, and refuses when the read-back still differs. It answers, per
// role, what changed and which statements differed, so an operator can see a
// drift before (`dryRun`) and after the write.
//
// ⚠️ IT RUNS AS AN ADMINISTRATOR OF THE SERVERLESS ACCOUNT, never as the scoped
// role: the scoped role holds no IAM action at all, and that stays true. The
// caller supplies the session (the member access role, from Motir's management
// role). It never creates or deletes a role: a missing role is refused, so a
// typo in an account id cannot plant roles somewhere new.
//
// Documents are compared CANONICALLY — statements by `Sid`, every list sorted, a
// single value equal to a one-element list — because IAM answers a document in
// its own order and shape, URL-encoded, and a byte compare would report drift
// on every run.

export type ServerlessRolePart = 'trust' | 'policy';

/** What one role's turn did to one part. `would_change` only in a dry run. */
export type ServerlessRolePartOutcome = 'unchanged' | 'changed' | 'would_change';

export interface ServerlessRoleConvergence {
  readonly roleName: string;
  readonly trust: ServerlessRolePartOutcome;
  readonly policy: ServerlessRolePartOutcome;
  /** How the trust differs, principal by principal: `+arn` (only in the
   *  definition, would be granted), `-arn` (only live, would be REMOVED).
   *  Statement-level (`~#0`) only when the principals agree and something else
   *  differs. Empty when unchanged. */
  readonly trustDiff: readonly string[];
  /** The statements that differ, as `+Sid` (only in the definition), `-Sid`
   *  (only live) or `~Sid` (both, different). Empty when unchanged. */
  readonly policyDiff: readonly string[];
}

export type ServerlessIamClientFactory = (options: {
  region: string;
  credentials: AwsCredentialIdentity;
}) => ServerlessSdkClient;

export interface ConvergeServerlessRolesInput {
  readonly accountId: string;
  readonly region: string;
  /** An administrator session in the serverless account. */
  readonly credentials: AwsCredentialIdentity;
  /** Read and report only; write nothing. */
  readonly dryRun?: boolean;
}

export interface ConvergeServerlessRolesDeps {
  /** The SDK seam: tests answer IAM in memory. */
  readonly iamClientFactory?: ServerlessIamClientFactory;
}

/** IAM is global; its endpoint answers in us-east-1. */
const IAM_REGION = 'us-east-1';

/** The real IAM client. */
export function defaultServerlessIamClientFactory(
  options: Parameters<ServerlessIamClientFactory>[0],
): ServerlessSdkClient {
  return new IAMClient(options);
}

// ── Canonical documents (pure) ──────────────────────────────────────────────

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** The keys whose value IAM accepts as one item or a list of them. */
const LIST_KEYS: ReadonlySet<string> = new Set(['Action', 'NotAction', 'Resource', 'NotResource']);

function sortedList(value: Json): Json[] {
  const list = Array.isArray(value) ? value : [value];
  return [...list].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/** A principal or condition block: every key's value as a sorted list. */
function canonicalBlock(value: Json): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const out: { [key: string]: Json } = {};
  for (const key of Object.keys(value).sort()) {
    const inner = value[key]!;
    out[key] =
      inner !== null && typeof inner === 'object' && !Array.isArray(inner)
        ? canonicalBlock(inner)
        : sortedList(inner);
  }
  return out;
}

function canonicalStatement(statement: { [key: string]: Json }): { [key: string]: Json } {
  const out: { [key: string]: Json } = {};
  for (const key of Object.keys(statement).sort()) {
    const value = statement[key]!;
    if (LIST_KEYS.has(key)) out[key] = sortedList(value);
    else if (key === 'Principal' || key === 'NotPrincipal' || key === 'Condition') {
      out[key] = canonicalBlock(value);
    } else out[key] = value;
  }
  return out;
}

/** A statement's identity in a diff: its `Sid`, else its position. */
function statementKey(statement: { [key: string]: Json }, index: number): string {
  return typeof statement['Sid'] === 'string' && statement['Sid'] ? statement['Sid'] : `#${index}`;
}

/** The document's statements, canonical, by key. */
export function iamCanonicalStatements(document: AwsPolicyDocument | string): Map<string, string> {
  const parsed = (typeof document === 'string' ? JSON.parse(document) : document) as {
    Statement?: Json;
  };
  const raw = parsed.Statement ?? [];
  const statements = (Array.isArray(raw) ? raw : [raw]) as Array<{ [key: string]: Json }>;
  const byKey = new Map<string, string>();
  statements.forEach((statement, index) => {
    // A repeated Sid (IAM refuses one on write, a hand-edited read might not)
    // keeps every statement: the second is keyed `Sid#index`, so it is compared.
    const key = statementKey(statement, index);
    byKey.set(
      byKey.has(key) ? `${key}#${index}` : key,
      JSON.stringify(canonicalStatement(statement)),
    );
  });
  return byKey;
}

/** How `live` differs from `wanted`, statement by statement; empty when equal. */
export function iamPolicyDiff(
  wanted: AwsPolicyDocument,
  live: AwsPolicyDocument | string | null,
): string[] {
  const want = iamCanonicalStatements(wanted);
  if (live === null) return [...want.keys()].map((key) => `+${key}`);
  const have = iamCanonicalStatements(live);
  const diff: string[] = [];
  for (const [key, statement] of want) {
    if (!have.has(key)) diff.push(`+${key}`);
    else if (have.get(key) !== statement) diff.push(`~${key}`);
  }
  for (const key of have.keys()) if (!want.has(key)) diff.push(`-${key}`);
  return diff;
}

function principalsOf(document: AwsPolicyDocument | string | null): Set<string> {
  const out = new Set<string>();
  if (document === null) return out;
  const parsed = (typeof document === 'string' ? JSON.parse(document) : document) as {
    Statement?: Json;
  };
  const raw = parsed.Statement ?? [];
  for (const statement of (Array.isArray(raw) ? raw : [raw]) as Array<{ [key: string]: Json }>) {
    const principal = statement['Principal'];
    if (typeof principal === 'string') out.add(principal);
    else if (principal !== null && typeof principal === 'object' && !Array.isArray(principal)) {
      for (const value of Object.values(principal)) {
        for (const item of Array.isArray(value) ? value : [value]) out.add(String(item));
      }
    }
  }
  return out;
}

/** How a live TRUST policy differs from `wanted`, principal by principal:
 *  `+arn` would be granted, `-arn` would be removed. Falls back to the
 *  statement diff when the principals agree but something else differs. */
export function iamTrustDiff(
  wanted: AwsPolicyDocument,
  live: AwsPolicyDocument | string | null,
): string[] {
  const statements = iamPolicyDiff(wanted, live);
  if (statements.length === 0) return [];
  const want = principalsOf(wanted);
  const have = principalsOf(live);
  const diff = [
    ...[...want].filter((p) => !have.has(p)).map((p) => `+${p}`),
    ...[...have].filter((p) => !want.has(p)).map((p) => `-${p}`),
  ];
  return diff.length > 0 ? diff : statements;
}

// ── The converge ────────────────────────────────────────────────────────────

/** IAM answers a policy document URL-encoded. */
function decoded(document: string | undefined): string | null {
  return document ? decodeURIComponent(document) : null;
}

function isNoSuchEntity(err: unknown): boolean {
  return awsErrorCode(err) === 'NoSuchEntityException' || awsErrorCode(err) === 'NoSuchEntity';
}

function apiError(err: unknown): OrchestratorApiError {
  if (err instanceof OrchestratorApiError) return err;
  const status = (err as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
    ?.httpStatusCode;
  return new OrchestratorApiError(
    'aws',
    typeof status === 'number' ? status : null,
    `iam: ${awsErrorCode(err)}`,
  );
}

function roleReader(iam: ServerlessSdkClient) {
  async function send<T>(command: unknown): Promise<T> {
    try {
      return (await iam.send(command)) as T;
    } catch (err) {
      throw apiError(err);
    }
  }

  return {
    send,
    /** The role's live trust policy; refused when the role does not exist. */
    async trust(roleName: string): Promise<string | null> {
      try {
        const answer = (await iam.send(new GetRoleCommand({ RoleName: roleName }))) as {
          Role?: { AssumeRolePolicyDocument?: string };
        };
        return decoded(answer.Role?.AssumeRolePolicyDocument);
      } catch (err) {
        if (isNoSuchEntity(err)) throw new ServerlessRoleMissingError(roleName);
        throw apiError(err);
      }
    },
    /** The role's live inline policy, or null when it has none of that name. */
    async policy(roleName: string, policyName: string): Promise<string | null> {
      try {
        const answer = (await iam.send(
          new GetRolePolicyCommand({ RoleName: roleName, PolicyName: policyName }),
        )) as { PolicyDocument?: string };
        return decoded(answer.PolicyDocument);
      } catch (err) {
        if (isNoSuchEntity(err)) return null;
        throw apiError(err);
      }
    },
  };
}

async function convergeRole(
  role: ServerlessRoleDefinition,
  reader: ReturnType<typeof roleReader>,
  dryRun: boolean,
): Promise<ServerlessRoleConvergence> {
  const trustDiff = iamTrustDiff(role.trustPolicy, await reader.trust(role.roleName));
  const livePolicyDiff = iamPolicyDiff(
    role.policy,
    await reader.policy(role.roleName, role.policyName),
  );
  const pending = dryRun ? 'would_change' : 'changed';

  if (!dryRun && trustDiff.length > 0) {
    await reader.send(
      new UpdateAssumeRolePolicyCommand({
        RoleName: role.roleName,
        PolicyDocument: JSON.stringify(role.trustPolicy),
      }),
    );
    const readBack = iamPolicyDiff(role.trustPolicy, await reader.trust(role.roleName));
    if (readBack.length > 0) throw new ServerlessRoleReadBackMismatchError(role.roleName, 'trust');
  }
  if (!dryRun && livePolicyDiff.length > 0) {
    await reader.send(
      new PutRolePolicyCommand({
        RoleName: role.roleName,
        PolicyName: role.policyName,
        PolicyDocument: JSON.stringify(role.policy),
      }),
    );
    const readBack = iamPolicyDiff(
      role.policy,
      await reader.policy(role.roleName, role.policyName),
    );
    if (readBack.length > 0) throw new ServerlessRoleReadBackMismatchError(role.roleName, 'policy');
  }
  return {
    roleName: role.roleName,
    trust: trustDiff.length > 0 ? pending : 'unchanged',
    policy: livePolicyDiff.length > 0 ? pending : 'unchanged',
    trustDiff,
    policyDiff: livePolicyDiff,
  };
}

/**
 * Bring `motir-hosting-serverless-deploy` and `mh-shared-exec` onto their
 * definitions in `./roles`, deploy role first. Writes only what differs, reads
 * every write back, and answers one result per role. Throws on the first role
 * that is missing or whose write does not read back, and on an IAM refusal
 * (its error code only).
 */
export async function convergeServerlessRoles(
  input: ConvergeServerlessRolesInput,
  deps: ConvergeServerlessRolesDeps = {},
): Promise<ServerlessRoleConvergence[]> {
  const roles = serverlessRoleDefinitions(input);
  const factory = deps.iamClientFactory ?? defaultServerlessIamClientFactory;
  const reader = roleReader(factory({ region: IAM_REGION, credentials: input.credentials }));
  const results: ServerlessRoleConvergence[] = [];
  for (const role of roles) results.push(await convergeRole(role, reader, input.dryRun ?? false));
  return results;
}
