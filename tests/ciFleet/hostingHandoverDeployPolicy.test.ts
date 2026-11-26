// MOTIR-12130 — the handover deploy role's policy, read against the grants it
// inherits: every action it grants is one `tenantDeployPolicies` or the
// registry stack's production push role already grants, and each on a resource
// of the handed-over repository that grant reaches too. The push role's grant
// is in because, after the transfer, its trust names the PRE-transfer owner and
// the handover role is the only one the moved repository's CI can assume (the
// review of MOTIR-9800). It never writes a new broad grant. No AWS call.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, type ScalarTag } from 'yaml';
import { AWS_TENANT_STACKS_DIR, handoverDeployPolicy } from '@motir/orchestrator';
import {
  TENANT_ACCOUNT_REGION,
  tenantDeployPolicyDocument,
} from '@/lib/ciFleet/hostingTenantAccounts';

interface Statement {
  Sid?: string;
  Effect: 'Allow' | 'Deny';
  Action?: string | string[];
  Resource: string | string[];
}

const list = (value: string | string[] | undefined) => (value === undefined ? [] : [value].flat());

/** IAM's wildcard match: `*` is any run of characters, `?` one. */
function iamMatches(pattern: string, value: string, caseless = false): boolean {
  const source = pattern
    .split('')
    .map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${source}$`, caseless ? 'i' : '').test(value);
}

const DEPLOY = (tenantDeployPolicyDocument().Statement as unknown as Statement[]).filter(
  (s) => s.Effect === 'Allow',
);

/** The registry template's production push role's grant, its intrinsic
 *  resource read as the ARN pattern of any repository's production registry. */
const scalarTag = (tag: string): ScalarTag => ({
  tag,
  resolve: (value: string) => ({ [tag]: value }),
});
const REGISTRY = parse(readFileSync(join(AWS_TENANT_STACKS_DIR, 'registry.yaml'), 'utf8'), {
  customTags: ['!Sub', '!GetAtt', '!Ref'].map(scalarTag),
}) as {
  Resources: Record<
    string,
    { Properties: { Policies: { PolicyDocument: { Statement: Statement[] } }[] } }
  >;
};
const PUSH: Statement[] = REGISTRY.Resources['ProductionPushRole']!.Properties.Policies.flatMap(
  (p) => p.PolicyDocument.Statement,
).map((s) => ({
  ...s,
  Resource: list(s.Resource as string | string[]).map((r) =>
    typeof r === 'string' ? r : 'arn:aws:ecr:*:*:repository/mh/*/production',
  ),
}));
const GRANTS = [...DEPLOY, ...PUSH];
const ACCOUNT = '210987654321';
const HANDOVER = handoverDeployPolicy(ACCOUNT, TENANT_ACCOUNT_REGION, ['cmrepoa', 'cmrepob'])
  .Statement as unknown as Statement[];

describe('the handover deploy policy (MOTIR-12130)', () => {
  it('reads the production push role’s grant from the registry template', () => {
    expect(PUSH.flatMap((s) => list(s.Action))).toEqual(
      expect.arrayContaining(['ecr:PutImage', 'ecr:GetAuthorizationToken']),
    );
  });

  it('grants only actions the tenant deploy policies or the production push role grant, on resources they reach', () => {
    for (const statement of HANDOVER) {
      for (const action of list(statement.Action)) {
        for (const resource of list(statement.Resource)) {
          const granted = GRANTS.some(
            (d) =>
              list(d.Action).some((p) => iamMatches(p, action, true)) &&
              list(d.Resource).some((r) => iamMatches(r, resource)),
          );
          expect(granted, `${statement.Sid}: ${action} on ${resource}`).toBe(true);
        }
      }
    }
  });
});
