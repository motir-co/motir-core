import 'server-only';

import type { Prisma } from '@/generated/prisma/client';
import type { ProjectRepoRoleDto } from '@/lib/dto/projectRepos';
import type { SeedRegistryEntryDto } from '@/lib/dto/seedRegistry';
import { provisioningOrgLogin } from '@/lib/ciMetering/config';
import { resolveOrgAuth } from '@/lib/github/orgTarget';
import { provisioningAuth } from '@/lib/github/repoProvisioning';
import { seedPromotionGithub, type GithubRepoAccess } from '@/lib/github/seedPromotion';
import { HostingManifestInvalidError, HostingManifestMissingError } from '@/lib/hosting/errors';
import { HOSTING_MANIFEST_FILE_NAME, parseHostingManifest } from '@/lib/hosting/manifest';
import { toSeedRegistryEntryDto } from '@/lib/mappers/seedRegistryMappers';
import { requirePlatformStaff, type PlatformPrincipal } from '@/lib/platform/auth';
import { withPlatformRead, withPlatformWrite } from '@/lib/platform/context';
import { isOrganizationSeedSource } from '@/lib/projectRepos/vocabulary';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { seedRegistryEntryRepository } from '@/lib/repositories/seedRegistryEntryRepository';
import { isFixedDefaultSeedKey } from '@/lib/seedRegistry/defaults';
import {
  SeedEntryIsDefaultError,
  SeedPromotionManifestRefusedError,
  SeedPromotionSourceRefusedError,
  SeedRegistryEntryNotFoundError,
  SeedRegistryInvalidFieldError,
  SeedRegistryKeyTakenError,
} from '@/lib/seedRegistry/errors';
import { fleetGithubOrgAssignmentService } from '@/lib/services/fleetGithubOrgAssignmentService';
import { seedRegistryService } from '@/lib/services/seedRegistryService';

// PROMOTE-TO-STARTER and RETIRE, curated (Story MOTIR-704 · MOTIR-710; decision
// MOTIR-706 v2 §3.6, page cmvsezd8800eihnoikhllqqev). The starter library grows
// only when a Motir OPERATOR decides it should: both acts take
// `requirePlatformStaff('operator')`, write a platform audit entry with the
// operator's reason, and are called from the two operator routes under
// `app/api/platform/seed-registry/` and nowhere else — no job, webhook, plan
// approval or agent run (`tests/seedRegistry/seedRegistryCurationCallers.test.ts`).
//
// A PROMOTION, in order, writing nothing until every check passes:
//   1. the vocabulary check (708's write path, run dry);
//   2. the SOURCE check — a `created` row Motir's org still holds, not the
//      organisation's own repository, with no take-over under way or done; read
//      in an audited platform context, the one cross-tenant read it makes;
//   3. the ref resolved to a commit;
//   4. the MANIFEST check at that commit when targets are claimed (706 §3.2's
//      subset rule; an empty target list skips it);
//   5. the TEMPLATE COPY of that commit into Motir's org (skipped on a
//      re-promotion, whose copy at that commit already exists);
//   6. the entry, written with its audit row after the source is checked again
//      under the platform write's lock.
//
// ⚠️ THE GITHUB WORK RUNS BETWEEN TWO SHORT PLATFORM TRANSACTIONS, never inside
// one: a platform transaction holds the audit chain's lock until it commits, so
// a copy of a few hundred blobs inside it would hold every other staff action at
// the door (`lib/platform/context.ts`).

/** What an operator names to promote a repository. */
export interface SeedPromotionInput {
  /** The `project_repository` row the repository was created for. */
  sourceRowId: string;
  /** A branch, tag or commit SHA on that repository. */
  ref: string;
  key: string;
  /** Checked against the role vocabulary by 708's write path. */
  role: string;
  stack: string;
  label: string;
  useCases: string[];
  sizes: string[];
  hostingTargets: string[];
}

/** Take-over states in which the repository is leaving, or has left, Motir —
 *  refused here, and marked held in the console's picker (MOTIR-712). */
export const LEAVING_TAKEOVER_STATES: readonly string[] = [
  'requested',
  'transfer_pending',
  'awaiting_reinstall',
  'done',
];

type PromotionSource = NonNullable<
  Awaited<ReturnType<typeof projectRepoRepository.findForPromotionInTx>>
>;

export const seedRegistryPromotionService = {
  /**
   * Promote a Motir-created repository at a ref to an ACTIVE registry entry, or
   * update the entry an earlier promotion of the same source at the same commit
   * wrote.
   *
   * @throws NotPlatformStaffError below `operator`.
   * @throws SeedRegistryInvalidFieldError / SeedRegistryKeyTakenError from 708's
   *   write path.
   * @throws SeedPromotionSourceRefusedError, SeedPromotionRefNotFoundError,
   *   SeedPromotionManifestRefusedError, SeedPromotionTemplateNameTakenError.
   */
  async promote(
    principal: PlatformPrincipal,
    input: SeedPromotionInput,
    reason: string,
  ): Promise<SeedRegistryEntryDto> {
    await requirePlatformStaff('operator');
    const motirOrg = provisioningOrgLogin();
    // `checkRole` refuses anything outside the role vocabulary, so after this
    // line the cast below is a fact rather than a hope.
    seedRegistryService.checkInput({
      ...input,
      role: input.role as ProjectRepoRoleDto,
      source: { owner: motirOrg ?? 'motir', repo: input.key },
    });
    const role = input.role as ProjectRepoRoleDto;

    const source = await withPlatformRead(
      principal,
      {
        action: 'seed_registry.promote_source_read',
        targetKind: 'platform',
        targetId: input.sourceRowId,
        metadata: { ref: input.ref },
      },
      async (tx) => checkedSource(input.sourceRowId, tx),
    );
    const access = await sourceAccess(source);
    const commit = await seedPromotionGithub.resolveCommit(access, input.ref);

    if (input.hostingTargets.length > 0) {
      await checkManifest(
        await seedPromotionGithub.readHostingManifest(access, commit.sha),
        input.hostingTargets,
      );
    }

    const previous = await seedRegistryEntryRepository.findByPromotion(source.id, commit.sha);
    if (previous && previous.key !== input.key) {
      throw new SeedRegistryInvalidFieldError(
        'key',
        input.key,
        `differs from "${previous.key}", the entry this repository at this commit was already promoted to.`,
      );
    }
    // A key another entry holds is refused BEFORE the copy, so the refusal leaves
    // nothing on GitHub either (the write re-checks it under the lock).
    const holder = previous
      ? null
      : await seedRegistryEntryRepository.findByKeyOrLegacyKey(input.key);
    if (holder) throw new SeedRegistryKeyTakenError(input.key);
    const template = previous
      ? { owner: previous.templateOwner!, repo: previous.templateRepo! }
      : await copyTemplate(access, commit, input.key);

    return withPlatformWrite(principal, async (tx, record) => {
      // Again, under the lock: a take-over started during the copy refuses here.
      await checkedSource(source.id, tx);
      const fields = {
        role,
        stack: input.stack,
        label: input.label,
        source: template,
        useCases: input.useCases,
        sizes: input.sizes,
        hostingTargets: input.hostingTargets,
        status: 'active' as const,
        promotedFrom: source.id,
        promotedRef: commit.sha,
        promotedBy: principal.userId,
        promotedAt: new Date(),
      };
      const existing = await seedRegistryEntryRepository.findByPromotionInTx(
        source.id,
        commit.sha,
        tx,
      );
      const entry = existing
        ? await seedRegistryService.update(existing.key, fields, tx)
        : await seedRegistryService.create({ key: input.key, ...fields }, tx);
      await record({
        action: 'seed_registry.promote',
        targetKind: 'platform',
        targetId: entry.key,
        targetLabel: entry.label,
        organizationId: source.githubRepo?.organizationId ?? null,
        reason,
        metadata: {
          sourceRowId: source.id,
          ref: input.ref,
          commit: commit.sha,
          template: `${template.owner}/${template.repo}`,
          useCases: entry.useCases,
          sizes: entry.sizes,
          hostingTargets: entry.hostingTargets,
          repromoted: existing !== null,
        },
      });
      return entry;
    });
  },

  /**
   * Retire an entry: never matched, offered or established from again, and kept
   * with its lists and provenance. Retiring a retired entry changes nothing and
   * writes no audit row.
   *
   * @throws NotPlatformStaffError below `operator`.
   * @throws SeedRegistryEntryNotFoundError for an unknown key.
   * @throws SeedEntryIsDefaultError for `initialised` or the web default (3.8).
   */
  async retire(
    principal: PlatformPrincipal,
    key: string,
    reason: string,
  ): Promise<SeedRegistryEntryDto> {
    await requirePlatformStaff('operator');
    const current = await seedRegistryEntryRepository.findByKeyOrLegacyKey(key);
    if (!current) throw new SeedRegistryEntryNotFoundError(key);
    const entry = toSeedRegistryEntryDto(current);
    // 706 §3.6 / §3.8: `initialised` is never retired, and the web default is
    // fixed by the decision — changing it amends the page, not the registry.
    if (isFixedDefaultSeedKey(entry.key)) {
      throw new SeedEntryIsDefaultError(entry.key, entry.role);
    }
    if (entry.status === 'retired') return entry;

    return withPlatformWrite(principal, async (tx, record) => {
      const retired = await seedRegistryService.update(entry.key, { status: 'retired' }, tx);
      await record({
        action: 'seed_registry.retire',
        targetKind: 'platform',
        targetId: retired.key,
        targetLabel: retired.label,
        reason,
      });
      return retired;
    });
  },
};

/** The source row, or the typed refusal naming the rule it breaks. */
async function checkedSource(
  sourceRowId: string,
  tx: Prisma.TransactionClient,
): Promise<PromotionSource> {
  const row = await projectRepoRepository.findForPromotionInTx(sourceRowId, tx);
  if (!row) {
    throw new SeedPromotionSourceRefusedError('not_found', sourceRowId, 'no such repository row.');
  }
  if (isOrganizationSeedSource(row.seedSource)) {
    throw new SeedPromotionSourceRefusedError(
      'organization_row',
      sourceRowId,
      "it is the organisation's own repository, and Motir never copies a customer's code.",
    );
  }
  if (row.state !== 'created' || !row.githubRepo) {
    throw new SeedPromotionSourceRefusedError(
      'not_created',
      sourceRowId,
      `only a repository Motir created can be promoted, and this one is ${row.state}.`,
    );
  }
  if (row.takeoverState !== null && LEAVING_TAKEOVER_STATES.includes(row.takeoverState)) {
    throw new SeedPromotionSourceRefusedError(
      'taken_over',
      sourceRowId,
      'it is being handed over to its owner, or already has been.',
    );
  }
  return row;
}

/**
 * The credential that reads the source: Motir's own org's, or the org Motir
 * assigned the workspace's organisation (MOTIR-8966). A repository in neither is
 * no longer Motir's to copy.
 */
async function sourceAccess(source: PromotionSource): Promise<GithubRepoAccess> {
  const { owner, name } = source.githubRepo!;
  const ownOrg = provisioningOrgLogin();
  if (ownOrg !== null && owner.toLowerCase() === ownOrg.toLowerCase()) {
    const { token } = await provisioningAuth();
    return { owner, repo: name, token };
  }
  const hosted = await fleetGithubOrgAssignmentService.hostedTargetForWorkspace(source.workspaceId);
  if (hosted && hosted.org.toLowerCase() === owner.toLowerCase()) {
    const { token } = await resolveOrgAuth(hosted);
    return { owner, repo: name, token };
  }
  throw new SeedPromotionSourceRefusedError(
    'not_motir_held',
    source.id,
    `${owner}/${name} is no longer in a GitHub organisation Motir holds.`,
  );
}

/** 706 §3.2's subset rule: every claimed target must be one the manifest declares. */
async function checkManifest(text: string | null, claimed: string[]): Promise<void> {
  let declared: readonly string[];
  try {
    declared = parseHostingManifest(text).targets;
  } catch (err) {
    if (err instanceof HostingManifestMissingError) {
      throw new SeedPromotionManifestRefusedError(
        'missing',
        err.fileName,
        null,
        null,
        `the repository has no ${err.fileName} at that ref, so it cannot claim a hosting target.`,
      );
    }
    if (err instanceof HostingManifestInvalidError) {
      throw new SeedPromotionManifestRefusedError(
        'invalid',
        HOSTING_MANIFEST_FILE_NAME,
        err.field,
        null,
        `${err.field ?? 'the document'} ${err.reason}.`,
        err.reason,
      );
    }
    throw err;
  }
  const undeclared = claimed.find((target) => !declared.includes(target));
  if (undeclared !== undefined) {
    throw new SeedPromotionManifestRefusedError(
      'target_not_declared',
      HOSTING_MANIFEST_FILE_NAME,
      'targets',
      undeclared,
      `it does not list "${undeclared}" in targets (it lists ${declared.join(', ')}).`,
      null,
      declared,
    );
  }
}

/** The template copy in Motir's own org, named by the entry's key. */
async function copyTemplate(
  access: GithubRepoAccess,
  commit: { sha: string; treeSha: string },
  key: string,
): Promise<{ owner: string; repo: string }> {
  const { org, token } = await provisioningAuth();
  return seedPromotionGithub.copyCommitAsTemplate({
    source: access,
    commit,
    target: { org, token },
    name: key,
    key,
  });
}
