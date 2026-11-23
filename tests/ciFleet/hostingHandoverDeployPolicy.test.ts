// MOTIR-12130 — the handover deploy role's policy, read against the tenant
// deploy role's: every action it grants is one `tenantDeployPolicies` already
// grants, and each on a resource of the handed-over repository that the deploy
// policy reaches too. It never writes a new broad grant. No AWS call.
import { describe, expect, it } from 'vitest';
import { handoverDeployPolicy } from '@motir/orchestrator';
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
const ACCOUNT = '210987654321';
const HANDOVER = handoverDeployPolicy(ACCOUNT, TENANT_ACCOUNT_REGION, ['cmrepoa', 'cmrepob'])
  .Statement as unknown as Statement[];

describe('the handover deploy policy (MOTIR-12130)', () => {
  it('grants only actions the tenant deploy policies grant, on resources they reach', () => {
    for (const statement of HANDOVER) {
      for (const action of list(statement.Action)) {
        for (const resource of list(statement.Resource)) {
          const granted = DEPLOY.some(
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
