import 'server-only';

import { getAgentModels, getRunModelDefaults, type AgentModelsRead } from '@/lib/ai/motirAiClient';
import { MotirAiError } from '@/lib/ai/errors';
import type { RunModelDefaultsRead } from '@/lib/ai/types';
import type { PlatformRunModelListDTO } from '@/lib/dto/platformRunModel';
import { HostedModelsUnavailableError } from '@/lib/hostedRuns/errors';
import {
  platformDefaultLevelsOf,
  projectUsesOf,
  toPlatformRunModelListDTO,
} from '@/lib/mappers/platformRunModelMappers';
import {
  platformRoleAtLeast,
  requirePlatformStaff,
  type PlatformPrincipal,
} from '@/lib/platform/auth';
import { withPlatformRead, type PlatformAuditEntry } from '@/lib/platform/context';
import {
  RunModelAlreadyListedError,
  RunModelInUseError,
  RunModelNotListedError,
  RunModelNotOfferedError,
} from '@/lib/platform/errors';
import { platformRunModelRepository } from '@/lib/repositories/platformRunModelRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { assertReasonSatisfied } from '@/lib/services/platformAuditService';
import type { Prisma } from '@/generated/prisma/client';

/**
 * The platform HOSTED-RUN MODEL LIST — Story MOTIR-7521 · MOTIR-7525
 * (`docs/decisions/hosted-agent-run.md` §7, amended by MOTIR-7522).
 *
 * motir-ai owns which models EXIST for hosted runs (`GET /v1/agent-models`,
 * read live); motir-core owns which of them MAY BE USED (`platform_run_model`).
 * This service is how the operator console reads and curates the second: any
 * staff role reads, only a `superadmin` writes, and every write appends one
 * `PlatformAuditLog` row in the same transaction as the write.
 *
 * ---------------------------------------------------------------------------
 * THE FIRST READ SEEDS THE LIST, EXACTLY ONCE
 * ---------------------------------------------------------------------------
 * The table ships empty, and an empty list read as "nothing may run" would take
 * every project's hosted runs away on deploy. So the first `listModels` writes
 * motir-ai's current offer as the list, under the `platform_run_model_list`
 * marker, inside one audited transaction (`ai.run_model_list.seed`):
 *
 *   · the marker is inserted `ON CONFLICT DO NOTHING`; a concurrent first read
 *     blocks on its primary key until the first commits, then inserts nothing —
 *     and rolls its own transaction back, so it leaves no audit row either;
 *   · motir-ai is read BEFORE the transaction, and an unanswered read raises
 *     `HostedModelsUnavailableError` with nothing written: the list stays
 *     UNINITIALISED, never initialised to empty.
 *
 * After that the marker's presence is what tells "an operator emptied the list"
 * (offer nothing) from "never initialised" (offer what motir-ai offers).
 */

const SEED_REASON =
  "Initialised from motir-ai's hosted-run offer on the list's first read, so no project loses its model.";

/** Rolls back a seed that another first read already performed. */
class AlreadySeeded extends Error {}

/** Rolls back a list transaction that found the list never initialised. */
class NotSeeded extends Error {}

/** motir-ai's offer, or `HostedModelsUnavailableError` — never an empty list. */
async function readOffer(): Promise<Extract<AgentModelsRead, { state: 'ok' }>> {
  const read = await getAgentModels();
  if (read.state === 'unavailable') throw new HostedModelsUnavailableError(read.reason);
  return read;
}

/**
 * Seed the list from `offer`, in its own audited transaction. A concurrent first
 * read that seeded already makes the marker insert a no-op, and this rolls back
 * with no row.
 */
async function seed(
  principal: PlatformPrincipal,
  offer: Extract<AgentModelsRead, { state: 'ok' }>,
): Promise<void> {
  const models = offer.models.map((m) => m.id);
  const entry: PlatformAuditEntry = {
    action: 'ai.run_model_list.seed',
    targetKind: 'platform',
    targetLabel: 'hosted-run model list',
    reason: SEED_REASON,
    metadata: { models },
  };
  try {
    await withPlatformRead(principal, entry, async (tx) => {
      if (!(await platformRunModelRepository.insertMarkerIfAbsent(tx))) {
        throw new AlreadySeeded();
      }
      await platformRunModelRepository.createSeeded(models, tx);
    });
  } catch (err) {
    if (!(err instanceof AlreadySeeded)) throw err;
  }
}

/**
 * Run `fn` in an audited transaction over an INITIALISED list. When the list was
 * never initialised, that transaction rolls back (leaving no row), the list is
 * seeded in a transaction of its own, and `fn` runs once more. The two are kept
 * apart because `withPlatformRead` locks the audit chain's head, so one opened
 * inside another would wait on itself.
 */
async function onSeededList<T>(
  principal: PlatformPrincipal,
  offer: Extract<AgentModelsRead, { state: 'ok' }>,
  entry: PlatformAuditEntry,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const attempt = () =>
    withPlatformRead(principal, entry, async (tx) => {
      if (!(await platformRunModelRepository.isInitialized(tx))) throw new NotSeeded();
      return fn(tx);
    });
  try {
    return await attempt();
  } catch (err) {
    if (!(err instanceof NotSeeded)) throw err;
  }
  await seed(principal, offer);
  return attempt();
}

/**
 * The run-side defaults' STORED models (MOTIR-10844), or
 * `HostedModelsUnavailableError` — a remove must know what the review-agent and
 * design-run defaults hold, set or withdrawn, before it takes a model away.
 */
async function readRunDefaults(): Promise<RunModelDefaultsRead> {
  try {
    return await getRunModelDefaults();
  } catch (err) {
    if (err instanceof MotirAiError) throw new HostedModelsUnavailableError(err.message);
    /* v8 ignore next -- the client raises only MotirAiError; anything else is a bug, rethrown */
    throw err;
  }
}

/** Which of the review-agent and design-run defaults store `model`. */
function platformRolesOf(model: string, read: RunModelDefaultsRead): ('review' | 'design')[] {
  return (['review', 'design'] as const).filter(
    (key) => read.settings.find((s) => s.key === key)?.model === model,
  );
}

/** The estate's override rows and the adders' users — the page's joined reads. */
async function readPage(
  offer: Extract<AgentModelsRead, { state: 'ok' }>,
  tx: Prisma.TransactionClient,
  canEdit: boolean,
): Promise<PlatformRunModelListDTO> {
  const [rows, projects] = await Promise.all([
    platformRunModelRepository.list(tx),
    projectRepository.findLiveWithHostedModelOverrides(tx),
  ]);
  const adders = [...new Set(rows.map((r) => r.addedById).filter((id): id is string => !!id))];
  const users = await userRepository.findByIds(adders, tx);
  return toPlatformRunModelListDTO(rows, offer, projects, users, canEdit);
}

/** The read every list view audits: the page joins every project's overrides. */
const LIST_READ: PlatformAuditEntry = {
  action: 'estate.read',
  targetKind: 'platform',
  targetLabel: 'hosted-run model list',
};

export const platformRunModelService = {
  /**
   * The HOSTED-RUN MODELS page: every listed model with whether motir-ai offers
   * it now, who added it, what uses it (motir-ai's platform default per level,
   * and every live project overriding a level to it), the models that could be
   * added, and whether this principal may edit.
   *
   * Audited as `estate.read`: naming the projects that use a model reads every
   * tenant's project row. The first call after deploy also SEEDS the list (this
   * file's header).
   *
   * @throws NotPlatformStaffError for a non-staff caller.
   * @throws HostedModelsUnavailableError when motir-ai cannot answer — no list
   *   is drawn, and an uninitialised list stays uninitialised.
   */
  async listModels(principal: PlatformPrincipal): Promise<PlatformRunModelListDTO> {
    await requirePlatformStaff('support');
    const offer = await readOffer();
    return onSeededList(principal, offer, LIST_READ, (tx) =>
      readPage(offer, tx, platformRoleAtLeast(principal.role, 'superadmin')),
    );
  },

  /**
   * Add a model motir-ai offers for hosted runs right now. The order is
   * `platformPlannerModelService.setModel`'s: superadmin, the reason, the
   * remote read, then the audited transaction — so a refusal leaves no row.
   *
   * @throws NotPlatformStaffError below `superadmin`.
   * @throws MissingAuditReasonError for a blank reason.
   * @throws HostedModelsUnavailableError when motir-ai cannot answer.
   * @throws RunModelNotOfferedError when motir-ai does not offer it.
   * @throws RunModelAlreadyListedError when it is listed already.
   */
  async addModel(
    principal: PlatformPrincipal,
    rawModel: string,
    reason: string,
  ): Promise<PlatformRunModelListDTO> {
    await requirePlatformStaff('superadmin');
    const model = rawModel.trim();
    const entry: PlatformAuditEntry = {
      action: 'ai.run_model_list.add',
      targetKind: 'platform',
      targetId: model,
      reason,
      metadata: { action: 'add', model },
    };
    assertReasonSatisfied(entry);
    const offer = await readOffer();
    if (!offer.models.some((m) => m.id === model)) throw new RunModelNotOfferedError(model);
    // An add before the first read seeds first, so the rest of the offer is
    // not left unlisted for ever.
    return onSeededList(principal, offer, entry, async (tx) => {
      if (await platformRunModelRepository.findByModel(model, tx)) {
        throw new RunModelAlreadyListedError(model);
      }
      await platformRunModelRepository.create(model, principal.userId, tx);
      return readPage(offer, tx, true);
    });
  },

  /**
   * Remove a listed model, refused while anything uses it: motir-ai's platform
   * default for a level, the platform review-agent or design-run default
   * (MOTIR-10844, read from the run-model-defaults read, so a stored default is
   * guarded even while it reads withdrawn), or a live project's override. All are
   * checked inside the audited transaction, so the refusal rolls its row back.
   *
   * @throws NotPlatformStaffError below `superadmin`.
   * @throws MissingAuditReasonError for a blank reason.
   * @throws HostedModelsUnavailableError when motir-ai cannot answer — the
   *   platform defaults are unknown, so nothing is removed.
   * @throws RunModelNotListedError when it is not listed.
   * @throws RunModelInUseError naming the projects and levels that use it.
   */
  async removeModel(
    principal: PlatformPrincipal,
    rawModel: string,
    reason: string,
  ): Promise<PlatformRunModelListDTO> {
    await requirePlatformStaff('superadmin');
    const model = rawModel.trim();
    const entry: PlatformAuditEntry = {
      action: 'ai.run_model_list.remove',
      targetKind: 'platform',
      targetId: model,
      reason,
      metadata: { action: 'remove', model },
    };
    assertReasonSatisfied(entry);
    const [offer, runDefaults] = await Promise.all([readOffer(), readRunDefaults()]);

    return onSeededList(principal, offer, entry, async (tx) => {
      if (!(await platformRunModelRepository.findByModel(model, tx))) {
        throw new RunModelNotListedError(model);
      }
      const platformLevels = platformDefaultLevelsOf(model, offer.defaultsByDifficulty);
      const platformRoles = platformRolesOf(model, runDefaults);
      const projects = projectUsesOf(
        model,
        await projectRepository.findLiveWithHostedModelOverrides(tx),
      );
      if (platformLevels.length > 0 || platformRoles.length > 0 || projects.length > 0) {
        throw new RunModelInUseError(model, projects, platformLevels, platformRoles);
      }
      await platformRunModelRepository.deleteByModel(model, tx);
      return readPage(offer, tx, true);
    });
  },
};
