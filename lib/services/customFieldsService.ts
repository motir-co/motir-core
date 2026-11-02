import {
  Prisma,
  type CustomFieldDefinition,
  type CustomFieldType,
} from '@/generated/prisma/client';
import { customFieldDefinitionRepository } from '@/lib/repositories/customFieldDefinitionRepository';
import { customFieldOptionRepository } from '@/lib/repositories/customFieldOptionRepository';
import { customFieldValueRepository } from '@/lib/repositories/customFieldValueRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { withWorkspaceContext, type WorkspaceContext } from '@/lib/workspaces/context';
import { keyForAppend } from '@/lib/workItems/positioning';
import { isRestrictViolation } from '@/lib/prisma/restrictViolation';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import {
  CustomFieldNotFoundError,
  CustomFieldOptionNotFoundError,
  FieldKeyConflictError,
  FieldLimitReachedError,
  InvalidFieldLabelError,
  InvalidFieldTypeError,
  InvalidPositionError,
  NotASelectFieldError,
  OptionInUseError,
  OptionLimitReachedError,
} from '@/lib/customFields/errors';
import {
  MAX_FIELDS_PER_PROJECT,
  MAX_LABEL_LENGTH,
  MAX_OPTIONS_PER_FIELD,
} from '@/lib/customFields/limits';
import {
  toCustomFieldDefinitionDTO,
  toCustomFieldOptionDTO,
  toDeletedCustomFieldDTO,
} from '@/lib/mappers/customFieldMappers';
import type {
  CustomFieldDefinitionDTO,
  CustomFieldOptionDTO,
  DeletedCustomFieldDTO,
} from '@/lib/dto/customFields';

// customFieldsService — the DEFINITIONS half of Story 5.3 (Subtask 5.3.2):
// per-project custom-field definition CRUD + the managed-option lifecycle,
// mirroring Jira team-managed "Project settings → Fields" (the rung-1
// verified behaviours recorded in the Story 5.3 description). The VALUES
// half (per-type validated set/clear + the detail-rail read) is Subtask
// 5.3.3 and extends this file.
//
// 4-layer (CLAUDE.md): this service owns the transactions (one method = one
// transaction, via withWorkspaceContext so the custom-field RLS policies see
// the workspace GUC under motir_app), the validation, the caps, the
// admin gate, and the DTO mapping; routes are thin HTTP transports; the
// single Prisma ops live in the three 5.3.1 repositories.
//
// AUTHORIZATION (the 6.4 two-tier shape, exactly the members-page pattern):
//   * MUTATIONS are project-admin-gated — workspace owner/admin always pass
//     (isWorkspaceManager), otherwise the actor needs a project membership
//     with role `admin`; everyone else → NotProjectAdminError (403).
//   * READS (listFields) are browse-gated (projectAccessService.assertCanBrowse,
//     the 6.4.3 policy): any member who can see the project can read its
//     field definitions — the detail rail needs them — including read-only
//     `viewer`s; a private project stays hidden (404, no existence leak).
//
// NO EXISTENCE LEAK (findings #26/#44): the project resolves by its
// workspace-scoped identifier and fields/options resolve through
// workspace-gated repo reads, so a cross-tenant key/id is indistinguishable
// from a non-existent one (404), never a 403.
//
// The verified mirror rules enforced here:
//   * caps — 50 fields/project, 55 options/field (typed 422s);
//   * `key` is generated from the label at create time (slug, uniquified
//     per project) and IMMUTABLE afterwards — renames touch `label` only;
//   * field delete is HARD (immediate, permanent; the DB cascade destroys
//     option + value rows) and the receipt names the destroyed value count;
//   * options archive any time (hidden from new selection, existing values
//     keep rendering) but DELETE only when unused — countByOption pre-check
//     inside the tx, with the value FK's ON DELETE RESTRICT as the DB
//     backstop (a RESTRICT violation → OptionInUseError; its Prisma code
//     depends on the server — see lib/prisma/restrictViolation.ts).

const FIELD_TYPES: readonly CustomFieldType[] = ['text', 'number', 'date', 'select', 'user'];

function asFieldType(value: string): CustomFieldType | null {
  return (FIELD_TYPES as readonly string[]).includes(value) ? (value as CustomFieldType) : null;
}

/** Trim + bound a field/option label, or throw the typed 400. */
function validateLabel(raw: string, what: 'field' | 'option'): string {
  const label = raw.trim();
  if (!label || label.length > MAX_LABEL_LENGTH) throw new InvalidFieldLabelError(what);
  return label;
}

/** A client-minted fractional position key must be a non-empty string. */
function validatePosition(raw: string): string {
  const position = raw.trim();
  if (!position) throw new InvalidPositionError();
  return position;
}

/**
 * Slug-generate the immutable machine `key` from the label (the
 * `workflow_status` key/label split): lowercase, alphanumerics dashed,
 * bounded — then uniquify against the project's existing keys with a
 * numeric suffix (`severity`, `severity-2`, …). `existingKeys` comes from
 * the same-tx definitions read, so the loop is bounded by the 50-field cap.
 */
function generateFieldKey(label: string, existingKeys: ReadonlySet<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'field';
  if (!existingKeys.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!existingKeys.has(candidate)) return candidate;
  }
}

/**
 * Resolve the project by its workspace-scoped identifier ("PROD") inside the
 * tx — a cross-tenant or unknown key throws ProjectNotFoundError (404, no
 * existence leak). The projectMembersService resolution, verbatim.
 */
async function resolveProjectInTx(
  key: string,
  ctx: WorkspaceContext,
  tx: Prisma.TransactionClient,
) {
  const identifier = key.trim().toUpperCase();
  const project = await projectRepository.findByIdentifier(ctx.workspaceId, identifier, tx);
  if (!project) throw new ProjectNotFoundError(key);
  return project;
}

/**
 * Assert the actor may manage this project's vocabulary (Story MOTIR-2256 ·
 * Subtask MOTIR-2298). A thin adapter onto the ONE shared gate.
 *
 * It replaces a MODULE-PRIVATE re-implementation of the two-tier check — the
 * workspace-manager rail, then `projectMembership?.role === 'admin'` — which is
 * the shape this story exists to end: several services each grew their own copy,
 * they agreed by coincidence, and nothing kept them that way. This one agreed, so
 * the change is BEHAVIOUR-NEUTRAL: `field:manage` resolves to exactly the actors
 * `project:administer` resolves to, on every access level and both rails, proved
 * over all 64 inputs in `tests/permissions/accessParity.test.ts`. What changes is
 * that there is now one answer instead of five, and the 403 names the key.
 */
async function assertCanManage(
  actorUserId: string,
  workspaceId: string,
  projectId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  await projectAccessService.assertPermission(
    projectId,
    { userId: actorUserId, workspaceId },
    'field:manage',
    tx,
  );
}

/**
 * Resolve a field by id (workspace-gated — null for unknown AND cross-tenant
 * ids, finding #44) and assert the actor may manage its project. The shared
 * preamble of every field-scoped mutation.
 */
async function resolveFieldForManage(
  fieldId: string,
  actorUserId: string,
  ctx: WorkspaceContext,
  tx: Prisma.TransactionClient,
): Promise<CustomFieldDefinition> {
  const field = await customFieldDefinitionRepository.findById(fieldId, ctx.workspaceId, tx);
  if (!field) throw new CustomFieldNotFoundError(fieldId);
  await assertCanManage(actorUserId, ctx.workspaceId, field.projectId, tx);
  return field;
}

/** As {@link resolveFieldForManage}, but the field must be a `select`. */
async function resolveSelectFieldForManage(
  fieldId: string,
  actorUserId: string,
  ctx: WorkspaceContext,
  tx: Prisma.TransactionClient,
): Promise<CustomFieldDefinition> {
  const field = await resolveFieldForManage(fieldId, actorUserId, ctx, tx);
  if (field.fieldType !== 'select') throw new NotASelectFieldError(fieldId);
  return field;
}

/**
 * Resolve an option by id (workspace-gated through its parent definition),
 * then its field, asserting manage rights — the shared preamble of every
 * option-scoped mutation. Returns both rows.
 */
async function resolveOptionForManage(
  optionId: string,
  actorUserId: string,
  ctx: WorkspaceContext,
  tx: Prisma.TransactionClient,
) {
  const option = await customFieldOptionRepository.findById(optionId, ctx.workspaceId, tx);
  if (!option) throw new CustomFieldOptionNotFoundError(optionId);
  // The parent definition resolves by construction (the option's workspace
  // gate just passed through it); the manage gate is what's being asserted.
  const field = await resolveFieldForManage(option.fieldId, actorUserId, ctx, tx);
  return { option, field };
}

/** Map the DTO for one definition from same-tx option + value-count reads. */
async function readFieldDTO(
  field: CustomFieldDefinition,
  ctx: WorkspaceContext,
  tx: Prisma.TransactionClient,
): Promise<CustomFieldDefinitionDTO> {
  const options =
    field.fieldType === 'select'
      ? await customFieldOptionRepository.listByField(field.id, ctx.workspaceId, tx)
      : [];
  const valueCount = await customFieldValueRepository.countByField(field.id, ctx.workspaceId, tx);
  const optionCounts = new Map(
    (
      await customFieldValueRepository.countGroupedByOption(
        options.map((o) => o.id),
        ctx.workspaceId,
        tx,
      )
    ).map((c) => [c.optionId, c.count]),
  );
  return toCustomFieldDefinitionDTO(field, options, valueCount, optionCounts);
}

/** Read one option's usage count (the per-option gloss / delete affordance). */
async function optionDTOWithCount(
  option: Parameters<typeof toCustomFieldOptionDTO>[0],
  ctx: WorkspaceContext,
  tx: Prisma.TransactionClient,
): Promise<CustomFieldOptionDTO> {
  const count = await customFieldValueRepository.countByOption(option.id, ctx.workspaceId, tx);
  return toCustomFieldOptionDTO(option, count);
}

export interface ActorScopedInput {
  /** The project identifier ("PROD") — resolved workspace-scoped. */
  key: string;
  actorUserId: string;
  ctx: WorkspaceContext;
}

export interface FieldScopedInput {
  fieldId: string;
  actorUserId: string;
  ctx: WorkspaceContext;
}

export interface OptionScopedInput {
  optionId: string;
  actorUserId: string;
  ctx: WorkspaceContext;
}

export const customFieldsService = {
  /**
   * The Fields admin-page read: the project's definitions in `position`
   * order, each with its option set + its issue-value count (the number the
   * delete confirm names). Browse-gated (any member who can see the project
   * — viewers included — can read definitions; the rail needs them), and
   * BOUNDED: ≤50 definitions (the cap), four queries total (definitions,
   * options-by-project, grouped value counts by field AND by option — no
   * N+1, finding #57).
   */
  async listFields(input: ActorScopedInput): Promise<CustomFieldDefinitionDTO[]> {
    return withWorkspaceContext(input.ctx, async (tx) => {
      const project = await resolveProjectInTx(input.key, input.ctx, tx);
      await projectAccessService.assertCanBrowse(project.id, input.ctx, tx);

      const definitions = await customFieldDefinitionRepository.listByProject(
        project.id,
        input.ctx.workspaceId,
        tx,
      );
      const options = await customFieldOptionRepository.listByProject(
        project.id,
        input.ctx.workspaceId,
        tx,
      );
      const counts = await customFieldValueRepository.countGroupedByField(
        definitions.map((d) => d.id),
        input.ctx.workspaceId,
        tx,
      );
      const optionCounts = new Map(
        (
          await customFieldValueRepository.countGroupedByOption(
            options.map((o) => o.id),
            input.ctx.workspaceId,
            tx,
          )
        ).map((c) => [c.optionId, c.count]),
      );

      const optionsByField = new Map<string, typeof options>();
      for (const option of options) {
        const list = optionsByField.get(option.fieldId);
        if (list) list.push(option);
        else optionsByField.set(option.fieldId, [option]);
      }
      const countByField = new Map(counts.map((c) => [c.fieldId, c.count]));

      return definitions.map((d) =>
        toCustomFieldDefinitionDTO(
          d,
          optionsByField.get(d.id) ?? [],
          countByField.get(d.id) ?? 0,
          optionCounts,
        ),
      );
    });
  },

  /**
   * Create a field definition (project-admin-gated). Slug-generates the
   * immutable per-project `key` from the label, appends to the end of the
   * field order, enforces the 50-field cap (typed 422), and — for `select`
   * fields — atomically seeds the initial option set (≤55). `options` on a
   * non-select type is a typed 400 (NotASelectFieldError): only `select`
   * has managed options.
   */
  async createField(
    input: ActorScopedInput & {
      label: string;
      fieldType: string;
      description?: string | null;
      options?: string[];
    },
  ): Promise<CustomFieldDefinitionDTO> {
    const label = validateLabel(input.label, 'field');
    const fieldType = asFieldType(input.fieldType);
    if (!fieldType) throw new InvalidFieldTypeError(input.fieldType);

    const seedOptions = (input.options ?? []).map((o) => validateLabel(o, 'option'));
    if (seedOptions.length > 0 && fieldType !== 'select') {
      throw new NotASelectFieldError('(new field)');
    }
    if (seedOptions.length > MAX_OPTIONS_PER_FIELD) {
      throw new OptionLimitReachedError(MAX_OPTIONS_PER_FIELD);
    }
    const description = input.description?.trim() || null;

    return withWorkspaceContext(input.ctx, async (tx) => {
      const project = await resolveProjectInTx(input.key, input.ctx, tx);
      await assertCanManage(input.actorUserId, input.ctx.workspaceId, project.id, tx);

      // One in-tx read feeds the cap check, the key uniquify, AND the
      // append position — bounded by the 50-field cap.
      const existing = await customFieldDefinitionRepository.listByProject(
        project.id,
        input.ctx.workspaceId,
        tx,
      );
      if (existing.length >= MAX_FIELDS_PER_PROJECT) {
        throw new FieldLimitReachedError(MAX_FIELDS_PER_PROJECT);
      }
      const key = generateFieldKey(label, new Set(existing.map((d) => d.key)));
      const position = keyForAppend(
        existing.length ? existing[existing.length - 1]!.position : null,
      );

      let field: CustomFieldDefinition;
      try {
        field = await customFieldDefinitionRepository.create(
          {
            workspaceId: input.ctx.workspaceId,
            projectId: project.id,
            key,
            label,
            fieldType,
            description,
            position,
          },
          tx,
        );
      } catch (err) {
        // Backstop the in-tx uniquify against a concurrent create winning
        // the same generated key between the read and this insert.
        /* istanbul ignore next -- defensive: P2002 only fires on a concurrent same-key insert race; not deterministically testable (mirrors workflowsService's guard) */
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new FieldKeyConflictError(key);
        }
        /* istanbul ignore next -- rethrow of the non-P2002 branch above */
        throw err;
      }

      let lastOptionPosition: string | null = null;
      for (const optionLabel of seedOptions) {
        lastOptionPosition = keyForAppend(lastOptionPosition);
        await customFieldOptionRepository.create(
          { fieldId: field.id, label: optionLabel, position: lastOptionPosition },
          tx,
        );
      }

      return readFieldDTO(field, input.ctx, tx);
    });
  },

  /**
   * Rename a field (project-admin-gated). Touches `label` ONLY — the machine
   * `key` is immutable after create (revision diffs + Epic-6 predicates hold
   * it), which this service enforces by never passing it to the repo.
   */
  async renameField(
    input: FieldScopedInput & { label: string },
  ): Promise<CustomFieldDefinitionDTO> {
    const label = validateLabel(input.label, 'field');
    return withWorkspaceContext(input.ctx, async (tx) => {
      await resolveFieldForManage(input.fieldId, input.actorUserId, input.ctx, tx);
      const updated = await customFieldDefinitionRepository.update(input.fieldId, { label }, tx);
      return readFieldDTO(updated, input.ctx, tx);
    });
  },

  /**
   * Update a field's description (project-admin-gated) — the edit-modal
   * Description input (Subtask 5.3.6; the 5.3.4 mockup's edit panel, and the
   * mirror: Jira team-managed field descriptions stay editable). Trimmed;
   * an empty string clears to null (the createField convention).
   */
  async updateFieldDescription(
    input: FieldScopedInput & { description: string | null },
  ): Promise<CustomFieldDefinitionDTO> {
    const description = input.description?.trim() || null;
    return withWorkspaceContext(input.ctx, async (tx) => {
      await resolveFieldForManage(input.fieldId, input.actorUserId, input.ctx, tx);
      const updated = await customFieldDefinitionRepository.update(
        input.fieldId,
        { description },
        tx,
      );
      return readFieldDTO(updated, input.ctx, tx);
    });
  },

  /**
   * Reorder a field (project-admin-gated) — a single-row fractional-index
   * write (the board-settings precedent: the client mints the key between
   * its new neighbours; no renumber sweeps).
   */
  async reorderField(
    input: FieldScopedInput & { position: string },
  ): Promise<CustomFieldDefinitionDTO> {
    const position = validatePosition(input.position);
    return withWorkspaceContext(input.ctx, async (tx) => {
      await resolveFieldForManage(input.fieldId, input.actorUserId, input.ctx, tx);
      const updated = await customFieldDefinitionRepository.update(input.fieldId, { position }, tx);
      return readFieldDTO(updated, input.ctx, tx);
    });
  },

  /**
   * HARD-delete a field (project-admin-gated) — the verified team-managed
   * semantics: immediate, permanent, no trash; the DB cascade destroys the
   * option rows and every stored value. The value count is read in the SAME
   * transaction and returned, so the receipt names exactly what the cascade
   * took (the UI confirm reads the count from `listFields` beforehand).
   */
  async deleteField(input: FieldScopedInput): Promise<DeletedCustomFieldDTO> {
    return withWorkspaceContext(input.ctx, async (tx) => {
      const field = await resolveFieldForManage(input.fieldId, input.actorUserId, input.ctx, tx);
      const valueCount = await customFieldValueRepository.countByField(
        field.id,
        input.ctx.workspaceId,
        tx,
      );
      await customFieldDefinitionRepository.delete(field.id, tx);
      return toDeletedCustomFieldDTO(field, valueCount);
    });
  },

  /**
   * Add an option to a `select` field (project-admin-gated). Appends to the
   * end of the option order; enforces the 55-option cap (typed 422).
   */
  async addOption(input: FieldScopedInput & { label: string }): Promise<CustomFieldOptionDTO> {
    const label = validateLabel(input.label, 'option');
    return withWorkspaceContext(input.ctx, async (tx) => {
      const field = await resolveSelectFieldForManage(
        input.fieldId,
        input.actorUserId,
        input.ctx,
        tx,
      );
      const existing = await customFieldOptionRepository.listByField(
        field.id,
        input.ctx.workspaceId,
        tx,
      );
      if (existing.length >= MAX_OPTIONS_PER_FIELD) {
        throw new OptionLimitReachedError(MAX_OPTIONS_PER_FIELD);
      }
      const position = keyForAppend(
        existing.length ? existing[existing.length - 1]!.position : null,
      );
      const option = await customFieldOptionRepository.create(
        { fieldId: field.id, label, position },
        tx,
      );
      // A just-created option has zero usage by construction.
      return toCustomFieldOptionDTO(option, 0);
    });
  },

  /** Rename an option (project-admin-gated). Archived options rename too. */
  async renameOption(input: OptionScopedInput & { label: string }): Promise<CustomFieldOptionDTO> {
    const label = validateLabel(input.label, 'option');
    return withWorkspaceContext(input.ctx, async (tx) => {
      await resolveOptionForManage(input.optionId, input.actorUserId, input.ctx, tx);
      const updated = await customFieldOptionRepository.update(input.optionId, { label }, tx);
      return optionDTOWithCount(updated, input.ctx, tx);
    });
  },

  /**
   * Reorder an option (project-admin-gated) — the same client-minted
   * fractional-key single-row write as `reorderField`.
   */
  async reorderOption(
    input: OptionScopedInput & { position: string },
  ): Promise<CustomFieldOptionDTO> {
    const position = validatePosition(input.position);
    return withWorkspaceContext(input.ctx, async (tx) => {
      await resolveOptionForManage(input.optionId, input.actorUserId, input.ctx, tx);
      const updated = await customFieldOptionRepository.update(input.optionId, { position }, tx);
      return optionDTOWithCount(updated, input.ctx, tx);
    });
  },

  /**
   * Archive an option (project-admin-gated) — legal ANY time, the verified
   * mirror split: archived options are hidden from new selection while
   * existing values keep rendering (5.3.3 enforces the new-write rejection).
   */
  async archiveOption(input: OptionScopedInput): Promise<CustomFieldOptionDTO> {
    return withWorkspaceContext(input.ctx, async (tx) => {
      await resolveOptionForManage(input.optionId, input.actorUserId, input.ctx, tx);
      const updated = await customFieldOptionRepository.update(
        input.optionId,
        { archived: true },
        tx,
      );
      return optionDTOWithCount(updated, input.ctx, tx);
    });
  },

  /** Un-archive an option (project-admin-gated) — the free inverse. */
  async unarchiveOption(input: OptionScopedInput): Promise<CustomFieldOptionDTO> {
    return withWorkspaceContext(input.ctx, async (tx) => {
      await resolveOptionForManage(input.optionId, input.actorUserId, input.ctx, tx);
      const updated = await customFieldOptionRepository.update(
        input.optionId,
        { archived: false },
        tx,
      );
      return optionDTOWithCount(updated, input.ctx, tx);
    });
  },

  /**
   * Delete an option (project-admin-gated) — ONLY when unused (the verified
   * "Optimize" rule): an in-tx countByOption pre-check throws the typed 409
   * (OptionInUseError — the UI offers archive instead), and the value FK's
   * ON DELETE RESTRICT backstops any concurrent set that slips between the
   * check and the delete (a RESTRICT violation, read by `isRestrictViolation`
   * → the same typed error).
   */
  async deleteOption(input: OptionScopedInput): Promise<CustomFieldOptionDTO> {
    return withWorkspaceContext(input.ctx, async (tx) => {
      const { option } = await resolveOptionForManage(
        input.optionId,
        input.actorUserId,
        input.ctx,
        tx,
      );
      const inUse = await customFieldValueRepository.countByOption(
        option.id,
        input.ctx.workspaceId,
        tx,
      );
      if (inUse > 0) throw new OptionInUseError(option.id, inUse);

      try {
        await customFieldOptionRepository.delete(option.id, tx);
      } catch (err) {
        // The DB backstop of the only-when-unused rule (see above). The refusal's
        // shape depends on the server and the client — `isRestrictViolation` is
        // the one reader of it (MOTIR-10227).
        if (isRestrictViolation(err)) throw new OptionInUseError(option.id, 1);
        /* istanbul ignore next -- rethrow of any other failure of the delete */
        throw err;
      }
      // Deleted only when unused — the receipt's count is zero by the rule.
      return toCustomFieldOptionDTO(option, 0);
    });
  },
};
