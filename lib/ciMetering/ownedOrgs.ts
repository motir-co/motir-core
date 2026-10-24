import type { GithubOrgTarget } from '@/lib/github/orgTarget';
import { fleetShardService } from '@/lib/services/fleetShardService';
import { isMotirHostedOwner } from '@/lib/git/hostOwnership';
import { provisioningOrgLogin } from './config';

// THE MOTIR-OWNED GITHUB ORG SET (MOTIR-1934) — the orgs whose Actions bill
// Motir pays, as CONFIGURATION rather than a literal.
//
// It is `GITHUB_FALLBACK_ORG` (`provisioningOrgLogin()` in `./config.ts`) PLUS
// every fleet account's GitHub org (Story MOTIR-8953 · MOTIR-8974): a tenant's
// hosted repositories may live in the org of the account it was assigned
// (MOTIR-8966), and every reader that asks "is this repository Motir's?" — the
// meter's §5.1 gate, the App-role resolver, the collaborator invite, an erased
// organisation's repo deletion — must answer yes for those too. With no account
// rows it is exactly the fallback org, and with the variable unset and no rows it
// is EMPTY — a self-hosted build owns no org at all.
//
// An org whose repositories were handed over to a customer (MOTIR-711) is not
// in it: the transfer moves the repo OUT of Motir's org, so the owner a run
// reports afterwards simply stops matching.
//
// ⚠️ READ IN SYSTEM CONTEXT, NEVER A TENANT'S. `fleet_shard` is a platform table
// whose RLS admits only the system context; `fleetShardService` opens it. A
// tenant-scoped read would see no rows and quietly shrink the set back to the
// fallback org — every shard-org repository would then read as the tenant's own.
//
// ⚠️ CACHED PER PROCESS FOR A SHORT WHILE. The set is read on billing, merge and
// access paths, some of them per webhook; an account row changes when an operator
// adds a shard, so a minute of staleness is the trade.

/** GitHub logins are case-insensitive, and an operator's value may carry spaces. */
function normaliseLogin(login: string): string {
  return login.trim().toLowerCase();
}

/** How long the account orgs are remembered. */
export const OWNED_ORG_CACHE_TTL_MS = 60_000;

interface ShardOrg {
  /** Lowercased login. */
  login: string;
  target: GithubOrgTarget;
}

let cached: { readAt: number; orgs: ShardOrg[] } | null = null;

/** Every fleet account's GitHub org, except a `disabled` account's, de-duplicated —
 *  of every role: a kind's spare runs Motir's own jobs in its org (MOTIR-9456). */
async function shardOrgs(): Promise<ShardOrg[]> {
  const now = Date.now();
  if (cached && now - cached.readAt < OWNED_ORG_CACHE_TTL_MS) return cached.orgs;
  const accounts = await fleetShardService.listShards({ role: 'any' });
  const byLogin = new Map<string, ShardOrg>();
  for (const account of accounts) {
    if (account.state === 'disabled') continue;
    const login = normaliseLogin(account.github.org);
    if (login.length === 0 || byLogin.has(login)) continue;
    byLogin.set(login, {
      login,
      target: {
        org: account.github.org,
        installationId: account.github.installationId,
        role: account.github.appRole,
      },
    });
  }
  const orgs = [...byLogin.values()];
  cached = { readAt: now, orgs };
  return orgs;
}

/** Every GitHub org login Motir owns, lowercased and de-duplicated. Empty when none is configured. */
export async function motirOwnedOrgLogins(): Promise<string[]> {
  const fallback = provisioningOrgLogin();
  const logins = new Set<string>(fallback ? [normaliseLogin(fallback)] : []);
  for (const org of await shardOrgs()) logins.add(org.login);
  return [...logins];
}

/**
 * The org and installation to act on an existing hosted repository WITH — for a
 * repository in a fleet account's org, that account's installation; `undefined`
 * for the fallback org (or an owner Motir does not own), which `resolveOrgAuth`
 * reads as `provisioningAuth()`, exactly as before.
 *
 * A shard org whose token mint fails surfaces as `OrgTargetAuthError` from
 * `resolveOrgAuth` — never a retry against the fallback org, which would act on
 * the wrong org.
 */
export async function ownedOrgTargetFor(
  ownerLogin: string | null | undefined,
): Promise<GithubOrgTarget | undefined> {
  if (typeof ownerLogin !== 'string' || ownerLogin.trim().length === 0) return undefined;
  if (isMotirHostedOwner(ownerLogin, provisioningOrgLogin())) return undefined;
  const owner = normaliseLogin(ownerLogin);
  return (await shardOrgs()).find((org) => org.login === owner)?.target;
}

/** Forget the cached account orgs — for tests, and after an account is written. */
export function resetOwnedOrgCache(): void {
  cached = null;
}
