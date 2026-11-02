import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { customFieldsService } from '@/lib/services/customFieldsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { customFieldDefinitionRepository } from '@/lib/repositories/customFieldDefinitionRepository';
import { customFieldOptionRepository } from '@/lib/repositories/customFieldOptionRepository';
import { customFieldValueRepository } from '@/lib/repositories/customFieldValueRepository';
import {
  CustomFieldNotFoundError,
  CustomFieldOptionNotFoundError,
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
  PermissionDeniedError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import { keyForAppend, keyForPrepend } from '@/lib/workItems/positioning';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures';
import type { WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';

// Service-layer tests for customFieldsService — the DEFINITIONS half (Story
// 5.3 · Subtask 5.3.2): field CRUD (slug key generation + immutability, the
// 50-field cap, hard delete with the value-count receipt), the managed-option
// lifecycle (add w/ the 55 cap, rename, reorder, the verified
// archive-vs-delete-when-unused split), the bounded admin-list read, and the
// 6.4 two-tier permission matrix over a representative mutation set. Real
// Postgres, no DB mocks (CLAUDE.md); typed-error assertions use the real
// classes. The VALUE-side write path (per-type validation, revision diffs)
// is Subtask 5.3.3's suite; here value rows are inserted through the 5.3.1
// repository only to exercise the counts and the in-use rules.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** The owner-actor input for project-scoped calls on the fixture's project. */
function actorInput(fx: WorkItemFixture) {
  return { key: fx.projectIdentifier, actorUserId: fx.ownerId, ctx: fx.ctx };
}

/** Shorthand: create a field as the workspace owner. */
async function createField(
  fx: WorkItemFixture,
  label: string,
  fieldType = 'text',
  extra: { description?: string | null; options?: string[] } = {},
) {
  return customFieldsService.createField({ ...actorInput(fx), label, fieldType, ...extra });
}

/** Insert a value row directly through the 5.3.1 repo (the 5.3.3 write path). */
async function setTextValue(fx: WorkItemFixture, workItemId: string, fieldId: string) {
  await adminDb.$transaction(async (tx) =>
    customFieldValueRepository.upsert(
      workItemId,
      fieldId,
      {
        workspaceId: fx.workspaceId,
        valueText: 'on-prem',
        valueNumber: null,
        valueDate: null,
        valueUserId: null,
        valueOptionId: null,
      },
      tx,
    ),
  );
}

/** Insert a select-value row holding `optionId` (for the in-use rules). */
async function setOptionValue(
  fx: WorkItemFixture,
  workItemId: string,
  fieldId: string,
  optionId: string,
) {
  await adminDb.$transaction(async (tx) =>
    customFieldValueRepository.upsert(
      workItemId,
      fieldId,
      {
        workspaceId: fx.workspaceId,
        valueText: null,
        valueNumber: null,
        valueDate: null,
        valueUserId: null,
        valueOptionId: optionId,
      },
      tx,
    ),
  );
}

describe('createField', () => {
  it('creates a text field with a slugged key and returns the full DTO', async () => {
    const fx = await makeWorkItemFixture();
    const field = await createField(fx, '  Customer Name ', 'text', {
      description: ' Who reported it ',
    });

    expect(field).toMatchObject({
      key: 'customer-name',
      label: 'Customer Name',
      fieldType: 'text',
      description: 'Who reported it',
      options: [],
      valueCount: 0,
    });
    expect(field.position).toBeTruthy();

    const listed = await customFieldsService.listFields(actorInput(fx));
    expect(listed.map((f) => f.id)).toEqual([field.id]);
  });

  it('creates a select field and atomically seeds its option set in order', async () => {
    const fx = await makeWorkItemFixture();
    const field = await createField(fx, 'Severity', 'select', {
      options: ['Low', 'Medium', 'High'],
    });

    expect(field.options.map((o) => o.label)).toEqual(['Low', 'Medium', 'High']);
    expect(field.options.every((o) => !o.archived)).toBe(true);
    const positions = field.options.map((o) => o.position);
    expect([...positions].sort()).toEqual(positions); // fractional keys sort in seed order
  });

  it('appends each new field to the end of the position order', async () => {
    const fx = await makeWorkItemFixture();
    const a = await createField(fx, 'Alpha');
    const b = await createField(fx, 'Beta');
    expect(a.position < b.position).toBe(true);
  });

  it('uniquifies the generated key per project and falls back for symbol-only labels', async () => {
    const fx = await makeWorkItemFixture();
    const first = await createField(fx, 'Severity', 'number');
    const second = await createField(fx, 'severity!', 'number');
    const symbols = await createField(fx, '!!!', 'number');

    expect(first.key).toBe('severity');
    expect(second.key).toBe('severity-2');
    expect(symbols.key).toBe('field');
  });

  it('keys are scoped per project — a sibling project reuses the same key', async () => {
    const fx = await makeWorkItemFixture();
    const sibling = await projectsService.createProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Sibling',
    });
    const a = await createField(fx, 'Severity', 'number');
    const b = await customFieldsService.createField({
      key: sibling.identifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      label: 'Severity',
      fieldType: 'number',
    });
    expect(a.key).toBe('severity');
    expect(b.key).toBe('severity');
  });

  it('rejects an empty or over-long label with the typed 400', async () => {
    const fx = await makeWorkItemFixture();
    await expect(createField(fx, '   ')).rejects.toBeInstanceOf(InvalidFieldLabelError);
    await expect(createField(fx, 'x'.repeat(MAX_LABEL_LENGTH + 1))).rejects.toBeInstanceOf(
      InvalidFieldLabelError,
    );
  });

  it('rejects an unknown fieldType with the typed 400', async () => {
    const fx = await makeWorkItemFixture();
    await expect(createField(fx, 'Effort', 'formula')).rejects.toBeInstanceOf(
      InvalidFieldTypeError,
    );
  });

  it('rejects seed options on a non-select type, and empty option labels', async () => {
    const fx = await makeWorkItemFixture();
    await expect(createField(fx, 'Effort', 'number', { options: ['One'] })).rejects.toBeInstanceOf(
      NotASelectFieldError,
    );
    await expect(createField(fx, 'Sev', 'select', { options: ['Ok', ' '] })).rejects.toBeInstanceOf(
      InvalidFieldLabelError,
    );
  });

  it('rejects a seed option set beyond the 55 cap', async () => {
    const fx = await makeWorkItemFixture();
    const options = Array.from({ length: MAX_OPTIONS_PER_FIELD + 1 }, (_, i) => `Option ${i}`);
    await expect(createField(fx, 'Sev', 'select', { options })).rejects.toBeInstanceOf(
      OptionLimitReachedError,
    );
  });

  it('enforces the 50-fields-per-project cap with the typed 422', async () => {
    const fx = await makeWorkItemFixture();
    // Bulk-insert 49 definitions through the repo (one tx), then the 50th
    // lands through the service and the 51st trips the cap.
    await adminDb.$transaction(async (tx) => {
      let position: string | null = null;
      for (let i = 0; i < MAX_FIELDS_PER_PROJECT - 1; i++) {
        position = keyForAppend(position);
        await customFieldDefinitionRepository.create(
          {
            workspaceId: fx.workspaceId,
            projectId: fx.projectId,
            key: `bulk-${i}`,
            label: `Bulk ${i}`,
            fieldType: 'text',
            position,
          },
          tx,
        );
      }
    });

    const fiftieth = await createField(fx, 'Last One');
    expect(fiftieth.key).toBe('last-one');
    await expect(createField(fx, 'One Too Many')).rejects.toBeInstanceOf(FieldLimitReachedError);
  });
});

describe('listFields', () => {
  it('returns definitions in position order with option sets and value counts', async () => {
    const fx = await makeWorkItemFixture();
    const select = await createField(fx, 'Severity', 'select', { options: ['Low', 'High'] });
    const text = await createField(fx, 'Customer', 'text');
    const issueA = await createTestWorkItem(fx, { kind: 'task', title: 'A' });
    const issueB = await createTestWorkItem(fx, { kind: 'task', title: 'B' });
    await setTextValue(fx, issueA.id, text.id);
    await setTextValue(fx, issueB.id, text.id);
    await setOptionValue(fx, issueA.id, select.id, select.options[0]!.id);

    const listed = await customFieldsService.listFields(actorInput(fx));

    expect(listed.map((f) => f.key)).toEqual(['severity', 'customer']);
    expect(listed[0]).toMatchObject({ valueCount: 1 });
    expect(listed[0]!.options.map((o) => o.label)).toEqual(['Low', 'High']);
    expect(listed[1]).toMatchObject({ valueCount: 2, options: [] });
  });

  it('is readable by a project viewer (the rail needs definitions)', async () => {
    const fx = await makeWorkItemFixture();
    await createField(fx, 'Customer');
    const viewer = await usersService.createUser({
      email: 'viewer-list@example.com',
      password: 'hunter2hunter2',
      name: 'Viewer',
    });
    await workspacesService.addMember({
      userId: viewer.id,
      workspaceId: fx.workspaceId,
      workspaceRole: 'member',
    });
    await addToProjectAs({
      ...actorInput(fx),
      targetUserId: viewer.id,
      role: 'viewer',
    });

    const listed = await customFieldsService.listFields({
      key: fx.projectIdentifier,
      actorUserId: viewer.id,
      ctx: { userId: viewer.id, workspaceId: fx.workspaceId },
    });
    expect(listed).toHaveLength(1);
  });

  it('hides a private project from a non-member (browse-denied 404 shape)', async () => {
    const fx = await makeWorkItemFixture();
    await createField(fx, 'Customer');
    await projectMembersService.setAccessMode({ ...actorInput(fx), mode: 'members' });
    // Never added to the private project, so no project membership.
    const outsider = await usersService.createUser({
      email: 'outsider-list@example.com',
      password: 'hunter2hunter2',
      name: 'Outsider',
    });
    await workspacesService.addMember({
      userId: outsider.id,
      workspaceId: fx.workspaceId,
      workspaceRole: 'member',
    });

    await expect(
      customFieldsService.listFields({
        key: fx.projectIdentifier,
        actorUserId: outsider.id,
        ctx: { userId: outsider.id, workspaceId: fx.workspaceId },
      }),
    ).rejects.toBeInstanceOf(ProjectAccessDeniedError);
  });

  it('404s an unknown key and a cross-workspace probe alike (no existence leak)', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      customFieldsService.listFields({ ...actorInput(fx), key: 'NOPE' }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);

    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    await expect(
      customFieldsService.listFields({
        key: fx.projectIdentifier, // the FIRST workspace's project key
        actorUserId: other.ownerId,
        ctx: other.ctx,
      }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe('renameField / reorderField', () => {
  it('rename touches the label ONLY — the machine key is immutable', async () => {
    const fx = await makeWorkItemFixture();
    const field = await createField(fx, 'Severity', 'select', { options: ['Low'] });

    const renamed = await customFieldsService.renameField({
      fieldId: field.id,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      label: 'Impact',
    });

    expect(renamed.label).toBe('Impact');
    expect(renamed.key).toBe('severity');
    expect(renamed.options.map((o) => o.label)).toEqual(['Low']);
  });

  it('reorder is a single-row fractional write that re-sorts the list', async () => {
    const fx = await makeWorkItemFixture();
    const a = await createField(fx, 'Alpha');
    const b = await createField(fx, 'Beta');

    await customFieldsService.reorderField({
      fieldId: b.id,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      position: keyForPrepend(a.position),
    });

    const listed = await customFieldsService.listFields(actorInput(fx));
    expect(listed.map((f) => f.id)).toEqual([b.id, a.id]);
  });

  it('rejects an empty label / position, unknown ids, and cross-workspace ids', async () => {
    const fx = await makeWorkItemFixture();
    const field = await createField(fx, 'Alpha');
    const base = { fieldId: field.id, actorUserId: fx.ownerId, ctx: fx.ctx };

    await expect(customFieldsService.renameField({ ...base, label: ' ' })).rejects.toBeInstanceOf(
      InvalidFieldLabelError,
    );
    await expect(
      customFieldsService.reorderField({ ...base, position: '  ' }),
    ).rejects.toBeInstanceOf(InvalidPositionError);
    await expect(
      customFieldsService.renameField({ ...base, fieldId: 'missing', label: 'X' }),
    ).rejects.toBeInstanceOf(CustomFieldNotFoundError);

    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    await expect(
      customFieldsService.renameField({
        fieldId: field.id,
        actorUserId: other.ownerId,
        ctx: other.ctx,
        label: 'Hijack',
      }),
    ).rejects.toBeInstanceOf(CustomFieldNotFoundError);
  });
});

describe('deleteField', () => {
  it('hard-deletes, returns the value-count receipt, and cascades options + values', async () => {
    const fx = await makeWorkItemFixture();
    const field = await createField(fx, 'Severity', 'select', { options: ['Low', 'High'] });
    const issue = await createTestWorkItem(fx, { kind: 'task', title: 'Holder' });
    await setOptionValue(fx, issue.id, field.id, field.options[0]!.id);

    const receipt = await customFieldsService.deleteField({
      fieldId: field.id,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
    });

    expect(receipt).toEqual({ id: field.id, key: 'severity', label: 'Severity', valueCount: 1 });
    expect(await customFieldsService.listFields(actorInput(fx))).toEqual([]);
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        customFieldOptionRepository.listByField(field.id, fx.workspaceId, tx),
      ),
    ).toEqual([]);
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        customFieldValueRepository.listByWorkItem(issue.id, fx.workspaceId, tx),
      ),
    ).toEqual([]);
  });
});

describe('option lifecycle', () => {
  it('addOption appends to the order and enforces the 55 cap', async () => {
    const fx = await makeWorkItemFixture();
    const field = await createField(fx, 'Severity', 'select', { options: ['Low'] });

    const added = await customFieldsService.addOption({
      fieldId: field.id,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      label: 'High',
    });
    expect(added).toMatchObject({ label: 'High', archived: false });

    const listed = await customFieldsService.listFields(actorInput(fx));
    expect(listed[0]!.options.map((o) => o.label)).toEqual(['Low', 'High']);

    // Fill to the cap, then one more trips it.
    const full = await createField(fx, 'Big', 'select', {
      options: Array.from({ length: MAX_OPTIONS_PER_FIELD }, (_, i) => `O${i}`),
    });
    await expect(
      customFieldsService.addOption({
        fieldId: full.id,
        actorUserId: fx.ownerId,
        ctx: fx.ctx,
        label: 'Overflow',
      }),
    ).rejects.toBeInstanceOf(OptionLimitReachedError);
  });

  it('rejects option operations on a non-select field and unknown ids', async () => {
    const fx = await makeWorkItemFixture();
    const text = await createField(fx, 'Customer', 'text');
    await expect(
      customFieldsService.addOption({
        fieldId: text.id,
        actorUserId: fx.ownerId,
        ctx: fx.ctx,
        label: 'X',
      }),
    ).rejects.toBeInstanceOf(NotASelectFieldError);
    await expect(
      customFieldsService.addOption({
        fieldId: 'missing',
        actorUserId: fx.ownerId,
        ctx: fx.ctx,
        label: 'X',
      }),
    ).rejects.toBeInstanceOf(CustomFieldNotFoundError);
    await expect(
      customFieldsService.renameOption({
        optionId: 'missing',
        actorUserId: fx.ownerId,
        ctx: fx.ctx,
        label: 'X',
      }),
    ).rejects.toBeInstanceOf(CustomFieldOptionNotFoundError);
  });

  it('renames, reorders, archives and un-archives an option', async () => {
    const fx = await makeWorkItemFixture();
    const field = await createField(fx, 'Severity', 'select', { options: ['Low', 'High'] });
    const [low, high] = field.options;
    const base = { actorUserId: fx.ownerId, ctx: fx.ctx };

    const renamed = await customFieldsService.renameOption({
      ...base,
      optionId: low!.id,
      label: 'Lowest',
    });
    expect(renamed.label).toBe('Lowest');

    await customFieldsService.reorderOption({
      ...base,
      optionId: high!.id,
      position: keyForPrepend(low!.position),
    });
    let listed = await customFieldsService.listFields(actorInput(fx));
    expect(listed[0]!.options.map((o) => o.id)).toEqual([high!.id, low!.id]);

    const archived = await customFieldsService.archiveOption({ ...base, optionId: low!.id });
    expect(archived.archived).toBe(true);
    // Archived options stay in the read (existing values must keep rendering).
    listed = await customFieldsService.listFields(actorInput(fx));
    expect(listed[0]!.options.find((o) => o.id === low!.id)?.archived).toBe(true);

    const unarchived = await customFieldsService.unarchiveOption({ ...base, optionId: low!.id });
    expect(unarchived.archived).toBe(false);

    await expect(
      customFieldsService.renameOption({ ...base, optionId: low!.id, label: '' }),
    ).rejects.toBeInstanceOf(InvalidFieldLabelError);
    await expect(
      customFieldsService.reorderOption({ ...base, optionId: low!.id, position: '' }),
    ).rejects.toBeInstanceOf(InvalidPositionError);
  });

  it('deletes an option only when unused — in-use throws the typed 409 until cleared', async () => {
    const fx = await makeWorkItemFixture();
    const field = await createField(fx, 'Severity', 'select', { options: ['Low', 'High'] });
    const [low, high] = field.options;
    const issue = await createTestWorkItem(fx, { kind: 'task', title: 'Holder' });
    await setOptionValue(fx, issue.id, field.id, low!.id);
    const base = { actorUserId: fx.ownerId, ctx: fx.ctx };

    // Unused option deletes cleanly.
    await customFieldsService.deleteOption({ ...base, optionId: high!.id });

    // In-use option is refused with the holding count…
    const err = await customFieldsService
      .deleteOption({ ...base, optionId: low!.id })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OptionInUseError);
    expect((err as OptionInUseError).valueCount).toBe(1);

    // …and deletes once the value is cleared (the no-tombstones row delete).
    await adminDb.$transaction(async (tx) =>
      customFieldValueRepository.deleteByWorkItemAndField(issue.id, field.id, tx),
    );
    await customFieldsService.deleteOption({ ...base, optionId: low!.id });
    const listed = await customFieldsService.listFields(actorInput(fx));
    expect(listed[0]!.options).toEqual([]);
  });

  it('turns the ON DELETE RESTRICT backstop into the typed 409 when the pre-check counts zero (MOTIR-10227)', async () => {
    // The race the backstop exists for — a value set between the count and the
    // delete — made deterministic: the holding value row carries ANOTHER
    // workspace's id, so the workspace-scoped countByOption sees none while the
    // value FK, which knows nothing of workspaces, still refuses the delete. The
    // refusal is a 23503 / P2003 on PostgreSQL <= 17 and a 23001 / P2039 on 18
    // under adapter-pg 7.9; the service owes OptionInUseError on both.
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    const field = await createField(fx, 'Severity', 'select', { options: ['Low'] });
    const [low] = field.options;
    const issue = await createTestWorkItem(fx, { kind: 'task', title: 'Holder' });
    await setOptionValue(other, issue.id, field.id, low!.id);
    const base = { actorUserId: fx.ownerId, ctx: fx.ctx };

    const err = await customFieldsService
      .deleteOption({ ...base, optionId: low!.id })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OptionInUseError);
    expect((err as OptionInUseError).valueCount).toBe(1);
    // The refused delete rolled back: the option is still there.
    const listed = await customFieldsService.listFields(actorInput(fx));
    expect(listed[0]!.options.map((o) => o.id)).toEqual([low!.id]);
  });

  it('404s a cross-workspace option id (no existence leak)', async () => {
    const fx = await makeWorkItemFixture();
    const field = await createField(fx, 'Severity', 'select', { options: ['Low'] });
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });

    await expect(
      customFieldsService.archiveOption({
        optionId: field.options[0]!.id,
        actorUserId: other.ownerId,
        ctx: other.ctx,
      }),
    ).rejects.toBeInstanceOf(CustomFieldOptionNotFoundError);
  });
});

describe('the 6.4 two-tier admin gate', () => {
  async function addUser(
    fx: WorkItemFixture,
    email: string,
    wsRole: 'admin' | 'member',
    projectRole?: 'admin' | 'member' | 'viewer',
  ) {
    const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: email });
    await workspacesService.addMember({
      userId: user.id,
      workspaceId: fx.workspaceId,
      workspaceRole: wsRole === 'admin' ? 'manager' : 'member',
    });
    if (projectRole) {
      await addToProjectAs({
        ...actorInput(fx),
        targetUserId: user.id,
        role: projectRole,
      });
    }
    return { userId: user.id, ctx: { userId: user.id, workspaceId: fx.workspaceId } };
  }

  it('workspace admin and project admin mutate; member and viewer are 403', async () => {
    const fx = await makeWorkItemFixture();
    const field = await createField(fx, 'Severity', 'select', { options: ['Low'] });

    const wsAdmin = await addUser(fx, 'ws-admin@example.com', 'admin');
    const projAdmin = await addUser(fx, 'proj-admin@example.com', 'member', 'admin');
    const plainMember = await addUser(fx, 'plain-member@example.com', 'member');
    const projMember = await addUser(fx, 'proj-member@example.com', 'member', 'member');
    const projViewer = await addUser(fx, 'proj-viewer@example.com', 'member', 'viewer');

    // The two passing tiers.
    await customFieldsService.createField({
      key: fx.projectIdentifier,
      actorUserId: wsAdmin.userId,
      ctx: wsAdmin.ctx,
      label: 'From WS Admin',
      fieldType: 'date',
    });
    await customFieldsService.renameField({
      fieldId: field.id,
      actorUserId: projAdmin.userId,
      ctx: projAdmin.ctx,
      label: 'Renamed by project admin',
    });

    // Everyone else: PermissionDeniedError on every mutation family.
    for (const denied of [plainMember, projMember, projViewer]) {
      await expect(
        customFieldsService.createField({
          key: fx.projectIdentifier,
          actorUserId: denied.userId,
          ctx: denied.ctx,
          label: 'Nope',
          fieldType: 'text',
        }),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
    }
    await expect(
      customFieldsService.deleteField({
        fieldId: field.id,
        actorUserId: projMember.userId,
        ctx: projMember.ctx,
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      customFieldsService.archiveOption({
        optionId: field.options[0]!.id,
        actorUserId: projViewer.userId,
        ctx: projViewer.ctx,
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe('the 5.3.2 repository additions', () => {
  it('countGroupedByField groups counts in one query and guards empty input', async () => {
    const fx = await makeWorkItemFixture();
    const a = await createField(fx, 'A');
    const b = await createField(fx, 'B');
    const issue1 = await createTestWorkItem(fx, { kind: 'task', title: 'One' });
    const issue2 = await createTestWorkItem(fx, { kind: 'task', title: 'Two' });
    await setTextValue(fx, issue1.id, a.id);
    await setTextValue(fx, issue2.id, a.id);
    await setTextValue(fx, issue1.id, b.id);

    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        customFieldValueRepository.countGroupedByField([], fx.workspaceId, tx),
      ),
    ).toEqual([]);

    const counts = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      customFieldValueRepository.countGroupedByField([a.id, b.id], fx.workspaceId, tx),
    );
    expect(new Map(counts.map((c) => [c.fieldId, c.count]))).toEqual(
      new Map([
        [a.id, 2],
        [b.id, 1],
      ]),
    );
  });

  it('option listByProject spans fields in position order and is workspace-gated', async () => {
    const fx = await makeWorkItemFixture();
    await createField(fx, 'Severity', 'select', { options: ['Low', 'High'] });
    await createField(fx, 'Env', 'select', { options: ['Prod'] });

    const options = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      customFieldOptionRepository.listByProject(fx.projectId, fx.workspaceId, tx),
    );
    expect(options.map((o) => o.label).sort()).toEqual(['High', 'Low', 'Prod']);

    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        customFieldOptionRepository.listByProject(fx.projectId, other.workspaceId, tx),
      ),
    ).toEqual([]);
  });
});

describe('the 5.3.6 additions — description edit + per-option usage counts', () => {
  it('updateFieldDescription sets, trims, and clears the description', async () => {
    const fx = await makeWorkItemFixture();
    const field = await createField(fx, 'Customer');
    const base = { fieldId: field.id, actorUserId: fx.ownerId, ctx: fx.ctx };

    const set = await customFieldsService.updateFieldDescription({
      ...base,
      description: '  Who reported it.  ',
    });
    expect(set.description).toBe('Who reported it.');
    // The other definition columns are untouched.
    expect(set.label).toBe('Customer');
    expect(set.key).toBe('customer');

    const cleared = await customFieldsService.updateFieldDescription({
      ...base,
      description: '   ',
    });
    expect(cleared.description).toBeNull();
  });

  it('updateFieldDescription is admin-gated and 404s unknown ids', async () => {
    const fx = await makeWorkItemFixture();
    const field = await createField(fx, 'Customer');

    await expect(
      customFieldsService.updateFieldDescription({
        fieldId: 'missing',
        actorUserId: fx.ownerId,
        ctx: fx.ctx,
        description: 'X',
      }),
    ).rejects.toBeInstanceOf(CustomFieldNotFoundError);

    // A plain workspace member (no project-admin tier) is the canonical 403.
    const member = await usersService.createUser({
      email: 'desc-member@example.com',
      password: 'hunter2hunter2',
      name: 'desc-member@example.com',
    });
    await workspacesService.addMember({
      userId: member.id,
      workspaceId: fx.workspaceId,
      workspaceRole: 'member',
    });
    await expect(
      customFieldsService.updateFieldDescription({
        fieldId: field.id,
        actorUserId: member.id,
        ctx: { userId: member.id, workspaceId: fx.workspaceId },
        description: 'X',
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('listFields and the option mutations carry per-option usage counts', async () => {
    const fx = await makeWorkItemFixture();
    const field = await createField(fx, 'Severity', 'select', { options: ['Low', 'High'] });
    const issue = await createTestWorkItem(fx, { kind: 'task', title: 'Holder' });
    await setOptionValue(fx, issue.id, field.id, field.options[0]!.id);

    const [listed] = await customFieldsService.listFields(actorInput(fx));
    expect(listed!.options.map((o) => ({ label: o.label, valueCount: o.valueCount }))).toEqual([
      { label: 'Low', valueCount: 1 },
      { label: 'High', valueCount: 0 },
    ]);

    // Mutation DTOs carry the count too (the archive flow keeps the gloss).
    const archived = await customFieldsService.archiveOption({
      optionId: field.options[0]!.id,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
    });
    expect(archived.valueCount).toBe(1);

    const renamed = await customFieldsService.renameOption({
      optionId: field.options[1]!.id,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      label: 'Critical',
    });
    expect(renamed.valueCount).toBe(0);
  });

  it('countGroupedByOption groups counts in one query and guards empty input', async () => {
    const fx = await makeWorkItemFixture();
    const field = await createField(fx, 'Severity', 'select', { options: ['Low', 'High'] });
    const issue1 = await createTestWorkItem(fx, { kind: 'task', title: 'One' });
    const issue2 = await createTestWorkItem(fx, { kind: 'task', title: 'Two' });
    const otherField = await createField(fx, 'Env', 'select', { options: ['Prod'] });
    await setOptionValue(fx, issue1.id, field.id, field.options[0]!.id);
    await setOptionValue(fx, issue2.id, otherField.id, otherField.options[0]!.id);

    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        customFieldValueRepository.countGroupedByOption([], fx.workspaceId, tx),
      ),
    ).toEqual([]);

    const counts = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      customFieldValueRepository.countGroupedByOption(
        [field.options[0]!.id, field.options[1]!.id, otherField.options[0]!.id],
        fx.workspaceId,
        tx,
      ),
    );
    expect(new Map(counts.map((c) => [c.optionId, c.count]))).toEqual(
      new Map([
        [field.options[0]!.id, 1],
        [otherField.options[0]!.id, 1],
      ]),
    );
  });
});
