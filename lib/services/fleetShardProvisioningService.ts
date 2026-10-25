import type {
  FleetShardDTO,
  FleetShardLimitName,
  FleetShardLimitsDTO,
  FleetShardLimitSource,
} from '@/lib/dto/fleetShard';
import type { FleetWorkloadKind } from '@motir/orchestrator';
import { FleetShardProvisioningRefusedError } from '@/lib/ciFleet/errors';
import {
  GITHUB_INSTALLATION_API_PER_HOUR,
  poolAccountRaiseTargetVcpu,
  SHARD_VCPU_QUOTA_TARGET,
} from '@/lib/ciFleet/shardTargets';
import { FLEET_WORKLOAD_KINDS } from '@/lib/ciFleet/workloads';
import {
  AWS_DEFAULT_REGION,
  AWS_RUNTIME_CREDENTIAL_OPTION,
} from '@/lib/fleetShards/awsProvisioningProvider';
import {
  AWS_MEMBER_EMAIL_TEMPLATE_ENV,
  memberAccountEmail,
  memberEmailTemplateProblems,
  nextPoolAccountSequence,
  poolAccountName,
} from '@/lib/fleetShards/awsMemberAccountPlan';
import { fleetAutomationPrincipal } from '@/lib/fleetShards/fleetAutomationPrincipal';
import {
  findShardProvisioningProvider,
  findShardProvisioningProviderForRow,
  shardProvisioningProviderNames,
  type ProviderStepContext,
  type ShardProvisioningProvider,
} from '@/lib/fleetShards/provisioningProviders';
import {
  ENTERPRISE_ADMIN_TOKEN_ENV,
  ENTERPRISE_SLUG_ENV,
  enterpriseOrganizationsClient,
} from '@/lib/github/enterpriseOrganizations';
import { provisioningInstallationIdFor } from '@/lib/github/repoProvisioning';
import { GITHUB_RUNNER_REGISTRATIONS_PER_5_MIN } from '@/lib/github/runnerJitConfig';
import { platformPrincipalForStaffEmail, type PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import { platformAuditService } from '@/lib/services/platformAuditService';
import {
  fleetQuotaRaiseService,
  type FleetQuotaRaiseDeps,
} from '@/lib/services/fleetQuotaRaiseService';
import { fleetQuotaRequestService } from '@/lib/services/fleetQuotaRequestService';
import { fleetShardService } from '@/lib/services/fleetShardService';

// ADD A FLEET ACCOUNT (Story MOTIR-8953 · MOTIR-8967) — what `fleet-admin
// add-shard` and `refresh-limits` run, inside a motir-core machine so they use
// that deployment's secrets.
//
// `addShard` walks nine steps in order, and EVERY STEP LOOKS BEFORE IT ACTS, so
// re-running the same command resumes a half-finished account: preflight, the
// GitHub org, the App installation, the provider's account, network, quota read
// and runtime credential, the account row, and one audit entry. Each step answers
// `done` (this run did it), `already` (it was there) or `pending` (a person owes
// it — the run says exactly what). The row is written `provisioning` and moves to
// `active` only on a run where nothing is pending.
//
// ⚠️ IT NEVER DECIDES WHICH ORG'S JOBS LAND ON THE ACCOUNT. Admission picks an
// account per job from the kind's pool (`fleetShardAdmissionService`).
//
// ⚠️ NO SECRET IS EVER MINTED, RETURNED OR PRINTED. Tokens live inside the GitHub
// client's requests; the provider confirms a person-set key works with a
// read-only call; the audit row carries the steps' outcomes, never a value.
//
// ⚠️ EVERY REFUSAL COMES BEFORE THE FIRST EXTERNAL CALL — a non-staff operator, a
// missing env var, an unknown fleet kind or provider, a bad option or a name
// already used elsewhere — with every problem at once.

/** The documented Enterprise Cloud limits a new account records (source `documented`). */
const DOCUMENTED_REGISTRATIONS_PER_5_MIN = GITHUB_RUNNER_REGISTRATIONS_PER_5_MIN;
const DOCUMENTED_API_PER_HOUR = GITHUB_INSTALLATION_API_PER_HOUR;
/** The Studio App's env names — the App the account's GitHub calls are made with. */
const STUDIO_APP_ENV = ['GITHUB_STUDIO_APP_ID', 'GITHUB_STUDIO_APP_PRIVATE_KEY'];

export type ShardStepName =
  | 'preflight'
  | 'github_org'
  | 'app_installation'
  | 'provider_account'
  | 'network'
  | 'quota'
  | 'runtime_credential'
  | 'account_row'
  | 'quota_raise';

export interface ShardStepReport {
  step: ShardStepName;
  /** `failed` (MOTIR-9460): the step did not happen and the next run retries it. */
  outcome: 'done' | 'already' | 'pending' | 'failed';
  detail: string;
}

export interface ShardProvisioningResult {
  shard: FleetShardDTO;
  steps: ShardStepReport[];
  pendingManualSteps: string[];
}

/** What the unattended add-shard is handed (MOTIR-9460): the kind, nothing else. */
export interface AddSpareShardInput {
  fleetKind: string;
}

export interface AddSpareShardDeps {
  /** The quota raise's AWS seam; the default reaches real AWS. */
  raise?: FleetQuotaRaiseDeps;
  env?: Readonly<Record<string, string | undefined>>;
}

/** How one walk differs between the person-run command and the unattended one. */
interface WalkMode {
  role: 'primary' | 'spare';
  /** The raise filed after the row, or null for none (the person-run command,
   *  whose quota step words the raise as a person's step instead). */
  raiseTargetVcpu: number | null;
  raiseDeps?: FleetQuotaRaiseDeps;
}

export interface AddShardInput {
  provider: string;
  fleetKind: string;
  name: string;
  region: string;
  githubOrg: string;
  orgMode: 'create' | 'existing';
  operatorEmail: string;
  /** The provider's own options, by name. */
  providerOptions?: Record<string, string>;
  /** `--create-org` only: GitHub requires a billing email (default: the
   *  operator's) and at least one admin login. */
  billingEmail?: string;
  adminLogins?: string[];
  profileName?: string;
}

/** `FLEET_SHARD_<NAME_UPPER_SNAKE>` — where the account's runtime key lives. */
export function credentialPrefixFor(name: string): string {
  return `FLEET_SHARD_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

function missingEnv(names: readonly string[]): string[] {
  return [...new Set(names)].filter((name) => !process.env[name]?.trim());
}

async function resolveOperator(email: string): Promise<PlatformPrincipal> {
  try {
    return await platformPrincipalForStaffEmail(email, 'superadmin');
  } catch (err) {
    if (err instanceof NotPlatformStaffError) {
      throw new FleetShardProvisioningRefusedError([
        `--operator ${email || '(none)'} is not a superadmin on the platform staff`,
      ]);
    }
    throw err;
  }
}

/** True when the existing row is this account at this location. */
function sameLocation(
  shard: FleetShardDTO,
  input: AddShardInput,
  provider: ShardProvisioningProvider,
  ctx: ProviderStepContext,
): boolean {
  return (
    shard.fleetKind === input.fleetKind &&
    shard.github.org.toLowerCase() === input.githubOrg.toLowerCase() &&
    shard.credentialRef === ctx.credentialRef &&
    provider.matchesRow(shard, ctx)
  );
}

/** Preflight: every refusal, at once, before any external call. */
async function preflight(
  input: AddShardInput,
  operator: PlatformPrincipal,
  extraProblems: readonly string[] = [],
): Promise<{
  operator: PlatformPrincipal;
  provider: ShardProvisioningProvider;
  ctx: ProviderStepContext;
  existing: FleetShardDTO | null;
}> {
  const problems: string[] = [...extraProblems];

  if (!(FLEET_WORKLOAD_KINDS as string[]).includes(input.fleetKind)) {
    problems.push(
      `--fleet-kind ${input.fleetKind || '(none)'} is not one of ${FLEET_WORKLOAD_KINDS.join(', ')}`,
    );
  }
  const provider = findShardProvisioningProvider(input.provider);
  if (!provider) {
    const known = shardProvisioningProviderNames();
    problems.push(
      `--provider ${input.provider || '(none)'} is not registered` +
        (known.length > 0 ? ` (registered: ${known.join(', ')})` : ' (none is registered yet)'),
    );
  }
  if (!input.githubOrg.trim()) problems.push('--github-org is required');
  if (input.orgMode === 'create' && (input.adminLogins ?? []).length === 0) {
    problems.push('--create-org needs at least one --admin-login (GitHub requires an org admin)');
  }

  const ctx: ProviderStepContext = {
    name: input.name,
    fleetKind: input.fleetKind,
    region: input.region,
    options: input.providerOptions ?? {},
    credentialRef: credentialPrefixFor(input.name),
  };

  const env = [ENTERPRISE_SLUG_ENV, ...STUDIO_APP_ENV];
  if (input.orgMode === 'create') env.push(ENTERPRISE_ADMIN_TOKEN_ENV);
  if (provider) {
    problems.push(...provider.validate(ctx));
    env.push(...provider.requiredEnv(ctx));
  }
  const missing = missingEnv(env);
  if (missing.length > 0) problems.push(`missing env: ${missing.join(', ')}`);

  let existing: FleetShardDTO | null = null;
  if (input.name.trim()) {
    existing = await fleetShardService.findShardByName(input.name);
    if (existing && provider && !sameLocation(existing, input, provider, ctx)) {
      problems.push(
        `--name ${input.name} is already the ${existing.fleetKind} account of ${existing.github.org} ` +
          'at another location; pick another name',
      );
    }
  } else {
    problems.push('--name is required');
  }

  if (problems.length > 0 || !provider) throw new FleetShardProvisioningRefusedError(problems);
  return { operator, provider, ctx: { ...ctx, shard: existing }, existing };
}

function limitsOf(shard: FleetShardDTO): FleetShardLimitsDTO {
  return { ...shard.limits };
}

export const fleetShardProvisioningService = {
  /**
   * Add — or resume adding — one account to a fleet kind's pool.
   *
   * @throws FleetShardProvisioningRefusedError before any external call.
   */
  async addShard(input: AddShardInput): Promise<ShardProvisioningResult> {
    const operator = await resolveOperator(input.operatorEmail);
    return walk(await preflight(input, operator), input, {
      role: 'primary',
      raiseTargetVcpu: null,
    });
  },

  /**
   * THE UNATTENDED ADD-SHARD (Story MOTIR-9362 · MOTIR-9460): create — or resume
   * creating — the next AWS pool account of `fleetKind` as its `spare`, with no
   * person. The same walk as `addShard`; only where its inputs come from differs:
   *  - the name and member email are derived (`awsMemberAccountPlan`), so a run
   *    interrupted after `CreateAccount` recomputes them and FINDS the account;
   *  - the GitHub org is the kind's existing primary account's;
   *  - the runtime credential is the account's `motir-fleet-runner` role, assumed
   *    from the management credential — no key is minted or asked of a person;
   *  - the audit actor is Motir's system account;
   *  - the row stays `provisioning` until its quota is granted (the growth pass
   *    settles it), and the kind's raise is filed after the row, last, so a
   *    failure there leaves a usable account and a `failed` step to resume.
   *
   * @throws FleetShardProvisioningRefusedError before any external call;
   *   FleetShardAccountRefusedError when AWS refuses `CreateAccount`.
   */
  async addSpareShard(
    input: AddSpareShardInput,
    deps: AddSpareShardDeps = {},
  ): Promise<ShardProvisioningResult> {
    const env = deps.env ?? process.env;
    const problems: string[] = [];
    if (!(FLEET_WORKLOAD_KINDS as string[]).includes(input.fleetKind)) {
      throw new FleetShardProvisioningRefusedError([
        `fleet kind must be one of ${FLEET_WORKLOAD_KINDS.join(', ')}`,
      ]);
    }
    const kind = input.fleetKind as FleetWorkloadKind;
    const operator = await fleetAutomationPrincipal();
    const template = env[AWS_MEMBER_EMAIL_TEMPLATE_ENV];
    problems.push(...memberEmailTemplateProblems(template));

    const primary = (await fleetShardService.listShards({ fleetKind: kind, role: 'primary' }))
      .filter((shard) => shard.state !== 'disabled')
      .sort((a, b) => Number(b.state === 'active') - Number(a.state === 'active'))[0];
    if (!primary) {
      throw new FleetShardProvisioningRefusedError([
        `${kind} has no primary account to take its GitHub org from`,
      ]);
    }

    const target = poolAccountRaiseTargetVcpu(kind);
    const name = (await resumableSpareName(kind, target)) ?? (await nextPoolName(kind));
    const addInput: AddShardInput = {
      provider: 'aws',
      fleetKind: kind,
      name,
      region: primary.aws?.region ?? AWS_DEFAULT_REGION,
      githubOrg: primary.github.org,
      orgMode: 'existing',
      operatorEmail: operator.email,
      providerOptions: {
        'account-email': template ? memberAccountEmail(template, name) : '',
        [AWS_RUNTIME_CREDENTIAL_OPTION]: 'role',
      },
    };
    return walk(await preflight(addInput, operator, problems), addInput, {
      role: 'spare',
      raiseTargetVcpu: target,
      raiseDeps: deps.raise,
    });
  },

  /**
   * Re-read an account's vCPU quota through its provider after a raise, and write
   * it (`provider_read`). No other limit is touched.
   *
   * @throws FleetShardProvisioningRefusedError before any external call.
   */
  async refreshLimits(name: string, operatorEmail: string): Promise<ShardProvisioningResult> {
    return refreshLimits(name, operatorEmail);
  },
};

/** A spare of `kind` a previous unattended run left before its raise was filed:
 *  still `provisioning`, below the kind's target, with no raise ever recorded. */
async function resumableSpareName(kind: FleetWorkloadKind, target: number): Promise<string | null> {
  const spares = await fleetShardService.listShards({
    fleetKind: kind,
    role: 'spare',
    state: 'provisioning',
  });
  for (const spare of spares) {
    if ((spare.limits.vcpuQuota ?? 0) >= target) continue;
    if ((await fleetQuotaRequestService.listByShard(spare.id)).length === 0) return spare.name;
  }
  return null;
}

/** The next pool account name of `kind`, numbered past every name that exists. */
async function nextPoolName(kind: FleetWorkloadKind): Promise<string> {
  const names = (await fleetShardService.listShards({ role: 'any' })).map((s) => s.name);
  return poolAccountName(kind, nextPoolAccountSequence(kind, names));
}

/** Why a step failed, as text that cannot carry a credential: a typed error's
 *  own `reason` (AWS's code), else the error's class name. */
function failureReason(err: unknown): string {
  if (err && typeof err === 'object' && 'reason' in err && typeof err.reason === 'string') {
    return err.reason;
  }
  return err instanceof Error ? err.name : 'UnknownError';
}

/** The walk both commands share — every step looks before it acts. */
async function walk(
  prepared: Awaited<ReturnType<typeof preflight>>,
  input: AddShardInput,
  mode: WalkMode,
): Promise<ShardProvisioningResult> {
  const { operator, provider, ctx: baseCtx, existing } = prepared;
  const steps: ShardStepReport[] = [];
  const pending: string[] = [];
  const report = (step: ShardStepName, outcome: ShardStepReport['outcome'], detail: string) =>
    steps.push({ step, outcome, detail });

  report('preflight', 'done', `operator ${operator.email}, ${input.fleetKind} on ${provider.name}`);

  // 2. The GitHub org.
  const org = await enterpriseOrganizationsClient.getOrganization(input.githubOrg);
  if (org) {
    report('github_org', 'already', `${org.login} exists`);
  } else if (input.orgMode === 'existing') {
    throw new FleetShardProvisioningRefusedError([
      `--existing-org ${input.githubOrg} does not exist on GitHub`,
    ]);
  } else {
    const created = await enterpriseOrganizationsClient.createEnterpriseOrganization({
      login: input.githubOrg,
      profileName: input.profileName ?? input.githubOrg,
      billingEmail: input.billingEmail ?? operator.email,
      adminLogins: input.adminLogins ?? [],
    });
    report('github_org', 'done', `created ${created.login} in the Enterprise`);
  }

  // 3. The Studio App on that org.
  const clientId = await enterpriseOrganizationsClient.findAppClientId();
  const installations = await enterpriseOrganizationsClient.listEnterpriseOrgInstallations(
    input.githubOrg,
  );
  if (installations.some((row) => row.clientId === clientId)) {
    report('app_installation', 'already', `the Studio App is installed on ${input.githubOrg}`);
  } else {
    await enterpriseOrganizationsClient.installAppOnOrganization(input.githubOrg, clientId);
    report('app_installation', 'done', `installed the Studio App on ${input.githubOrg}`);
  }
  const installationId = await provisioningInstallationIdFor(input.githubOrg);

  // 4–7. The provider's steps.
  const account = await provider.account(baseCtx);
  report('provider_account', account.created ? 'done' : 'already', account.detail);
  const ctx: ProviderStepContext = { ...baseCtx, account: account.account };

  const network = await provider.network(ctx);
  report(
    'network',
    network.created.length > 0 ? 'done' : 'already',
    network.created.length > 0 ? `created ${network.created.join(', ')}` : 'already in place',
  );

  const quota = await provider.readQuota(ctx);
  if (mode.raiseTargetVcpu !== null) {
    // The unattended add-shard files the kind's raise itself, after the row.
    report(
      'quota',
      'already',
      quota.vcpuQuota < mode.raiseTargetVcpu
        ? `vCPU quota ${quota.vcpuQuota}; a raise to ${mode.raiseTargetVcpu} is filed after the row`
        : `vCPU quota ${quota.vcpuQuota}`,
    );
  } else if (quota.vcpuQuota < SHARD_VCPU_QUOTA_TARGET) {
    const owed =
      `raise the account's vCPU quota from ${quota.vcpuQuota} to at least ` +
      `${SHARD_VCPU_QUOTA_TARGET}, then run this command again`;
    report('quota', 'pending', owed);
    pending.push(owed);
  } else {
    report('quota', 'already', `vCPU quota ${quota.vcpuQuota}`);
  }

  const credential = await provider.runtimeCredential(ctx);
  if (credential.confirmed) {
    report(
      'runtime_credential',
      credential.created.length > 0 ? 'done' : 'already',
      `the key under ${ctx.credentialRef} resolves and works`,
    );
  } else {
    const owed = provider.manualCredentialStep(ctx);
    report(
      'runtime_credential',
      'pending',
      credential.created.length > 0
        ? `created ${credential.created.join(', ')}; the key is a person's step`
        : "the key is a person's step",
    );
    pending.push(owed);
  }

  // 8. The account row.
  const readLimits: Partial<Record<FleetShardLimitName, number>> = {
    ...Object.fromEntries(
      Object.entries(quota.limits ?? {}).filter(([, value]) => typeof value === 'number'),
    ),
    vcpuQuota: quota.vcpuQuota,
  };
  let shard: FleetShardDTO;
  if (!existing) {
    const limitsSource: Partial<Record<FleetShardLimitName, FleetShardLimitSource>> = {
      githubRegistrationsPer5Min: 'documented',
      githubApiPerHour: 'documented',
    };
    for (const name of Object.keys(readLimits) as FleetShardLimitName[]) {
      limitsSource[name] = 'provider_read';
    }
    shard = await fleetShardService.createShard({
      name: input.name,
      fleetKind: input.fleetKind,
      ...provider.location(ctx),
      role: mode.role,
      state: 'provisioning',
      githubOrg: input.githubOrg,
      githubInstallationId: installationId,
      githubAppRole: 'provisioning',
      credentialRef: ctx.credentialRef,
      limits: {
        githubRegistrationsPer5Min: DOCUMENTED_REGISTRATIONS_PER_5_MIN,
        githubApiPerHour: DOCUMENTED_API_PER_HOUR,
        ...readLimits,
      },
      limitsSource,
    });
    report('account_row', 'done', `wrote ${shard.name} (provisioning)`);
  } else {
    shard = existing;
    const changed = (Object.keys(readLimits) as FleetShardLimitName[]).filter(
      (name) => existing.limits[name] !== readLimits[name],
    );
    if (changed.length > 0) {
      const source = { ...existing.limitsSource };
      for (const name of changed) source[name] = 'provider_read';
      shard = await fleetShardService.setLimits(
        existing.id,
        { ...limitsOf(existing), ...readLimits },
        source,
      );
      report('account_row', 'done', `refreshed ${changed.join(', ')} on ${shard.name}`);
    } else {
      report('account_row', 'already', `${shard.name} is recorded (${shard.state})`);
    }
  }
  // A spare stays `provisioning` until its quota is granted: the growth pass
  // settles it (MOTIR-9461), as at most one spare per kind may be ready.
  if (mode.role === 'primary' && pending.length === 0 && shard.state === 'provisioning') {
    shard = await fleetShardService.setState(shard.id, 'active');
    steps[steps.length - 1]!.detail += '; now active';
  }

  // 8b. The kind's quota raise, LAST: a failure leaves a usable account and a
  // `failed` step the next run retries (`fileRaise` answers an open request).
  if (mode.raiseTargetVcpu !== null) {
    const target = mode.raiseTargetVcpu;
    const granted = shard.limits.vcpuQuota ?? 0;
    const open = await fleetQuotaRequestService.findOpen(shard.id);
    if (granted >= target) {
      report('quota_raise', 'already', `vCPU quota ${granted} is at the ${target} target`);
    } else if (open && open.desiredValue === target) {
      report('quota_raise', 'already', `a raise to ${target} vCPU is filed (${open.status})`);
    } else {
      try {
        const filed = await fleetQuotaRaiseService.fileRaise(shard.id, target, mode.raiseDeps);
        report('quota_raise', 'done', `filed a raise to ${target} vCPU (${filed.status})`);
      } catch (err) {
        report(
          'quota_raise',
          'failed',
          `could not file the raise to ${target} vCPU (${failureReason(err)}); run again to file it`,
        );
      }
    }
  }

  // 9. The audit row — outcomes only, never a value.
  await platformAuditService.record(operator, {
    action: 'fleet.shard.add',
    targetKind: 'platform',
    targetId: shard.id,
    targetLabel: shard.name,
    reason:
      mode.role === 'spare'
        ? `pool growth: add spare ${shard.name} (${shard.fleetKind} on ${provider.name})`
        : `fleet-admin add-shard ${shard.name} (${shard.fleetKind} on ${provider.name})`,
    metadata: {
      fleetKind: shard.fleetKind,
      provider: provider.name,
      state: shard.state,
      steps: steps.map((s) => ({ step: s.step, outcome: s.outcome, detail: s.detail })),
      pendingManualSteps: pending,
    },
  });

  return { shard, steps, pendingManualSteps: pending };
}

async function refreshLimits(
  name: string,
  operatorEmail: string,
): Promise<ShardProvisioningResult> {
  const operator = await resolveOperator(operatorEmail);
  const shard = await fleetShardService.findShardByName(name);
  if (!shard) throw new FleetShardProvisioningRefusedError([`no fleet account is named ${name}`]);
  const provider = findShardProvisioningProviderForRow(shard.provider, shard);
  if (!provider) {
    throw new FleetShardProvisioningRefusedError([
      `no registered add-shard provider reads ${shard.provider} accounts`,
    ]);
  }
  const ctx: ProviderStepContext = {
    name: shard.name,
    fleetKind: shard.fleetKind,
    region: shard.fly?.region ?? shard.aws?.region ?? '',
    options: {},
    credentialRef: shard.credentialRef,
    shard,
  };
  const missing = missingEnv(provider.requiredEnv(ctx));
  if (missing.length > 0) {
    throw new FleetShardProvisioningRefusedError([`missing env: ${missing.join(', ')}`]);
  }

  const { vcpuQuota } = await provider.readQuota(ctx);
  const from = shard.limits.vcpuQuota;
  const updated = await fleetShardService.setLimits(
    shard.id,
    { ...limitsOf(shard), vcpuQuota },
    { ...shard.limitsSource, vcpuQuota: 'provider_read' },
  );
  const steps: ShardStepReport[] = [
    {
      step: 'quota',
      outcome: from === vcpuQuota ? 'already' : 'done',
      detail: from === vcpuQuota ? `vCPU quota ${vcpuQuota}` : `vCPU quota ${from} → ${vcpuQuota}`,
    },
  ];
  await platformAuditService.record(operator, {
    action: 'fleet.shard.limits',
    targetKind: 'platform',
    targetId: shard.id,
    targetLabel: shard.name,
    reason: `fleet-admin refresh-limits ${shard.name}`,
    metadata: { fleetKind: shard.fleetKind, provider: provider.name, from, to: vcpuQuota },
  });
  return { shard: updated, steps, pendingManualSteps: [] };
}
