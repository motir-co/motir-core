import type { DeployCredential, HostingApp } from '@motir/orchestrator';
import { repoActionsConfig } from '@/lib/github/repoActionsConfig';
import { seedPromotionGithub, type GithubRepoAccess } from '@/lib/github/seedPromotion';
import { deployEligibilityRefusal } from '@/lib/hosting/deployEligibility';
import {
  CustomerRepositoryNotDeployableError,
  HostingManifestInvalidError,
  HostingManifestMissingError,
  HostingTargetMissingError,
  ProductionEnablementFailedError,
  RepositoryNotEstablishedError,
  type ProductionEnablementStep,
} from '@/lib/hosting/errors';
import { parseHostingManifest } from '@/lib/hosting/manifest';
import { productionImageRepository } from '@/lib/hosting/productionArtifact';
import {
  HOSTING_TARGET_VARIABLE,
  PRODUCTION_BRANCH,
  PRODUCTION_ENVIRONMENT,
  PRODUCTION_IMAGE_VARIABLE,
  PRODUCTION_PUSH_TOKEN_SECRET,
  PRODUCTION_TOKEN_REMINT_AFTER_DAYS,
} from '@/lib/hosting/productionEnablementNames';
import { getHostingDeployPort } from '@/lib/orchestrator/hosting';
import { hostedApplicationRepository } from '@/lib/repositories/hostedApplicationRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { hostedApplicationService } from '@/lib/services/hostedApplicationService';
import { hostedRepositoryAccessService } from '@/lib/services/hostedRepositoryAccessService';
import { withSystemContext } from '@/lib/workspaces/context';

// SWITCH PRODUCTION ON for a Motir repository (Story MOTIR-9797 · MOTIR-10027):
// its application record, its production Fly app through the deploy port, an
// app-scoped deploy token as the `production` environment's secret, and the
// repository variables the starter's production-image workflow reads. The names
// are the hosting ADR's (`lib/hosting/productionEnablementNames.ts`).
//
// ⚠️ THE ORDER IS THE DESIGN. The checks that have no side effect come first —
// eligibility (a customer repository is refused before anything is called), then
// the manifest — so a refused or skipped repository has nothing written for it.
// Then the application row, the app, the credential, the environment and its
// secret, the image variable, and the TARGET VARIABLE LAST: every build workflow
// is gated on it, so a failure at any earlier step leaves the workflow unable to
// run against a missing app or secret. Every step is idempotent (the app is
// found by its deterministic `mh-<rid>` name, the GitHub writes are upserts), so
// running again repairs a failure. The row is marked enabled only at the end.
//
// The deploy token exists in plaintext only between the mint and the sealed PUT:
// it is never stored, logged, returned or put into an error.

/** How long a deploy token may age before enablement re-mints it. */
const REMINT_AFTER_MS = PRODUCTION_TOKEN_REMINT_AFTER_DAYS * 86_400_000;

/** Repositories the backfill reads per page. */
const BACKFILL_PAGE = 50;

/** Why a repository was left alone without an error. */
export type ProductionSkipReason =
  | 'manifest_missing'
  | 'manifest_invalid'
  | 'target_not_declared'
  | 'target_not_supported';

export type ProductionEnablementOutcome =
  | { outcome: 'enabled'; applicationId: string; appName: string }
  | { outcome: 'already_enabled'; applicationId: string; appName: string }
  | { outcome: 'token_reminted'; applicationId: string; appName: string }
  | { outcome: 'skipped'; reason: ProductionSkipReason; detail: string };

export interface BackfillEntry {
  projectRepositoryId: string;
  result: ProductionEnablementOutcome | { outcome: 'failed'; step: string; detail: string };
}

export interface ProductionEnablementDeps {
  /** The clock; tests move it to cross the re-mint age. */
  now?: () => Date;
}

type DeployFacts = NonNullable<
  Awaited<ReturnType<typeof projectRepoRepository.findDeployFactsInTx>>
>;

function readFacts(projectRepositoryId: string): Promise<DeployFacts | null> {
  return withSystemContext((tx) =>
    projectRepoRepository.findDeployFactsInTx(projectRepositoryId, tx),
  );
}

function refuseIneligible(facts: DeployFacts): void {
  const refusal = deployEligibilityRefusal(facts);
  if (refusal === 'customer_repository') throw new CustomerRepositoryNotDeployableError(facts.id);
  if (refusal === 'not_established') throw new RepositoryNotEstablishedError(facts.id, facts.state);
  if (refusal === 'no_target') throw new HostingTargetMissingError(facts.id);
}

/** Run one step; any failure becomes the typed error naming it. The message
 *  kept is the failure's own, which never holds the token. */
async function step<T>(
  id: string,
  name: ProductionEnablementStep,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ProductionEnablementFailedError) throw err;
    throw new ProductionEnablementFailedError(
      id,
      name,
      err instanceof Error ? err.message : 'unknown',
    );
  }
}

/** The credential that reaches the repository (MOTIR-8966). */
function repositoryAccess(
  facts: DeployFacts & { githubRepo: NonNullable<DeployFacts['githubRepo']> },
): Promise<GithubRepoAccess> {
  return hostedRepositoryAccessService.accessFor(facts);
}

/** The manifest's verdict on production: null when it declares a web app for
 *  the target, else why not. */
async function manifestSkip(
  access: GithubRepoAccess,
  facts: DeployFacts,
): Promise<{ reason: ProductionSkipReason; detail: string } | null> {
  const text = await seedPromotionGithub.readHostingManifest(
    access,
    facts.githubRepo!.defaultBranch,
  );
  try {
    const manifest = parseHostingManifest(text);
    if ((manifest.targets as readonly string[]).includes(facts.hostingTarget!)) return null;
    return {
      reason: 'target_not_declared',
      detail: `the manifest does not list "${facts.hostingTarget}" in targets`,
    };
  } catch (err) {
    if (err instanceof HostingManifestMissingError) {
      return { reason: 'manifest_missing', detail: err.message };
    }
    if (err instanceof HostingManifestInvalidError) {
      return { reason: 'manifest_invalid', detail: err.message };
    }
    throw err;
  }
}

/** Mint the app-scoped token and write it as the environment's secret. */
async function installToken(id: string, access: GithubRepoAccess, app: HostingApp): Promise<void> {
  const port = getHostingDeployPort('fly');
  const credential: DeployCredential = await step(id, 'credential', () =>
    port.mintDeployCredential({ pushNamespace: app.pushNamespace }),
  );
  if (credential.kind !== 'secret' || credential.pushNamespace !== app.pushNamespace) {
    throw new ProductionEnablementFailedError(
      id,
      'credential',
      'the port returned no app-scoped secret',
    );
  }
  await step(id, 'environment', () =>
    repoActionsConfig.ensureBranchOnlyEnvironment(
      access,
      PRODUCTION_ENVIRONMENT,
      PRODUCTION_BRANCH,
    ),
  );
  await step(id, 'secret', () =>
    repoActionsConfig.putEnvironmentSecret(
      access,
      PRODUCTION_ENVIRONMENT,
      PRODUCTION_PUSH_TOKEN_SECRET,
      credential.value,
    ),
  );
}

export const productionEnablementService = {
  /**
   * Switch production on for one repository. Throws the eligibility errors for a
   * customer, unestablished or target-less repository (before any call), skips a
   * repository whose target has no production path yet or whose manifest
   * declares no web app for it, and otherwise ends `enabled`, `already_enabled`
   * or `token_reminted`.
   *
   * @throws ProductionEnablementFailedError naming the step that failed.
   */
  async enableProduction(
    projectRepositoryId: string,
    deps: ProductionEnablementDeps = {},
  ): Promise<ProductionEnablementOutcome> {
    const now = deps.now ?? (() => new Date());
    const facts = await readFacts(projectRepositoryId);
    if (!facts) {
      throw new ProductionEnablementFailedError(
        projectRepositoryId,
        'repository',
        'no such repository',
      );
    }
    refuseIneligible(facts);
    if (facts.hostingTarget !== 'fly') {
      return {
        outcome: 'skipped',
        reason: 'target_not_supported',
        detail: `production on "${facts.hostingTarget}" is not switched on by this path`,
      };
    }
    const realized = facts.githubRepo;
    if (!realized) {
      throw new ProductionEnablementFailedError(facts.id, 'repository', 'no GitHub repository');
    }
    const access = await step(facts.id, 'repository', () =>
      repositoryAccess({ ...facts, githubRepo: realized }),
    );
    const skip = await step(facts.id, 'manifest', () => manifestSkip(access, facts));
    if (skip) return { outcome: 'skipped', ...skip };

    const application = await step(facts.id, 'application', () =>
      hostedApplicationService.ensureApplication(facts.id),
    );
    const record = await withSystemContext((tx) =>
      hostedApplicationRepository.findById(application.id, tx),
    );
    const enabledAt = record?.productionEnabledAt ?? null;
    const mintedAt = record?.productionTokenMintedAt ?? null;
    const fresh = mintedAt !== null && now().getTime() - mintedAt.getTime() < REMINT_AFTER_MS;
    if (enabledAt && record?.productionAppName && fresh) {
      return {
        outcome: 'already_enabled',
        applicationId: application.id,
        appName: record.productionAppName,
      };
    }

    const app = await step(facts.id, 'app', () =>
      getHostingDeployPort('fly').ensureApp({
        repositoryId: facts.id,
        environment: { kind: 'production' },
      }),
    );
    await installToken(facts.id, access, app);
    if (!enabledAt) {
      await step(facts.id, 'variables', async () => {
        await repoActionsConfig.setRepositoryVariable(
          access,
          PRODUCTION_IMAGE_VARIABLE,
          productionImageRepository(app.pushNamespace),
        );
        // LAST: the gate every build workflow reads.
        await repoActionsConfig.setRepositoryVariable(access, HOSTING_TARGET_VARIABLE, 'fly');
      });
    }
    const at = now();
    await step(facts.id, 'record', () =>
      withSystemContext((tx) =>
        hostedApplicationRepository.markProductionEnabled(
          application.id,
          { appName: app.appRef, enabledAt: enabledAt ?? at, mintedAt: at },
          tx,
        ),
      ),
    );
    return {
      outcome: enabledAt ? 'token_reminted' : 'enabled',
      applicationId: application.id,
      appName: app.appRef,
    };
  },

  /**
   * The repository-creation path's call: enablement for a newly established
   * repository that can have production, NEVER throwing. A repository that is
   * not a Fly-targeted Motir one is left alone silently; any failure is logged
   * with its step, and the backfill picks the repository up again.
   */
  async enableQuietly(projectRepositoryId: string): Promise<void> {
    try {
      const facts = await readFacts(projectRepositoryId);
      if (!facts || facts.hostingTarget !== 'fly' || deployEligibilityRefusal(facts) !== null) {
        return;
      }
      await productionEnablementService.enableProduction(projectRepositoryId);
    } catch (err) {
      console.warn(
        '[productionEnablementService] production not switched on; the backfill retries:',
        projectRepositoryId,
        err instanceof ProductionEnablementFailedError ? err.step : 'unknown',
        err instanceof Error ? err.message : 'unknown',
      );
    }
  },

  /**
   * Every established, non-customer, Fly-targeted repository, one at a time: a
   * failure is recorded and the walk continues. Customer repositories are never
   * read into the walk, so enablement is never called for one.
   */
  async backfillProductionEnablement(
    deps: ProductionEnablementDeps = {},
  ): Promise<BackfillEntry[]> {
    const entries: BackfillEntry[] = [];
    let after: string | null = null;
    for (;;) {
      const cursor: string | null = after;
      const page: Array<{ id: string }> = await withSystemContext((tx) =>
        projectRepoRepository.listProductionCandidatesInTx(cursor, BACKFILL_PAGE, tx),
      );
      for (const { id } of page) {
        entries.push({ projectRepositoryId: id, result: await backfillOne(id, deps) });
      }
      if (page.length < BACKFILL_PAGE) return entries;
      after = page[page.length - 1]!.id;
    }
  },
};

async function backfillOne(
  id: string,
  deps: ProductionEnablementDeps,
): Promise<BackfillEntry['result']> {
  try {
    return await productionEnablementService.enableProduction(id, deps);
  } catch (err) {
    return {
      outcome: 'failed',
      step: err instanceof ProductionEnablementFailedError ? err.step : 'unknown',
      detail: err instanceof Error ? err.message : 'unknown',
    };
  }
}
