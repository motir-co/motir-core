// MOTIR-9808 — a Motir repo's row records its hosting target, use case and size.
// Real Postgres, no mocks (the repo convention): the set-once rule and the
// customer-row refusal are what every later hosting card trusts, so each is
// proved against the database, including that a refusal and a repeat write
// change nothing.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { HostingSize, HostingTarget, HostingUseCase } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { HOSTING_SIZES, HOSTING_TARGETS, HOSTING_USE_CASES } from '@/lib/hosting/vocabulary';
import { toProjectRepoDto, type ProjectRepoWithRealized } from '@/lib/mappers/projectRepoMappers';
import {
  ProjectRepoHostingTargetFixedError,
  ProjectRepoInvalidFieldError,
  ProjectRepoNotMotirHostedError,
} from '@/lib/projectRepos/errors';
import { SEED_SOURCE_ORGANIZATION } from '@/lib/projectRepos/vocabulary';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const HOSTING = { target: 'fly', useCase: 'internal_tool', size: 'small' } as const;

async function motirRow() {
  const fx = await makeWorkItemFixture();
  const row = await projectRepoSetService.addRow(
    fx.projectId,
    { role: 'web', name: 'acme' },
    fx.ctx,
  );
  return { fx, row };
}

async function stored(id: string) {
  return adminDb.projectRepo.findUniqueOrThrow({
    where: { id },
    select: { hostingTarget: true, hostingUseCase: true, hostingSize: true, updatedAt: true },
  });
}

describe('the hosting vocabulary', () => {
  it('matches the Prisma enums value for value', () => {
    expect([...HOSTING_TARGETS].sort()).toEqual(Object.values(HostingTarget).sort());
    expect([...HOSTING_USE_CASES].sort()).toEqual(Object.values(HostingUseCase).sort());
    expect([...HOSTING_SIZES].sort()).toEqual(Object.values(HostingSize).sort());
  });
});

describe('projectRepoSetService.setHosting', () => {
  it('starts null on a new row and sets all three on a Motir-created row', async () => {
    const { fx, row } = await motirRow();
    expect([row.hostingTarget, row.hostingUseCase, row.hostingSize]).toEqual([null, null, null]);

    const dto = await projectRepoSetService.setHosting(row.id, HOSTING, fx.ctx);
    expect(dto).toMatchObject({
      id: row.id,
      hostingTarget: 'fly',
      hostingUseCase: 'internal_tool',
      hostingSize: 'small',
    });
    expect(await stored(row.id)).toMatchObject({
      hostingTarget: 'fly',
      hostingUseCase: 'internal_tool',
      hostingSize: 'small',
    });
    // Every reader gets them from the row: the set read too.
    const [listed] = await projectRepoSetService.listByProject(fx.projectId, fx.ctx);
    expect(listed).toMatchObject({
      hostingTarget: 'fly',
      hostingUseCase: 'internal_tool',
      hostingSize: 'small',
    });
  });

  it('refuses a customer (organization) row and changes nothing', async () => {
    const { fx, row } = await motirRow();
    await adminDb.projectRepo.update({
      where: { id: row.id },
      data: { seedSource: SEED_SOURCE_ORGANIZATION },
    });
    await expect(projectRepoSetService.setHosting(row.id, HOSTING, fx.ctx)).rejects.toBeInstanceOf(
      ProjectRepoNotMotirHostedError,
    );
    expect(await stored(row.id)).toMatchObject({
      hostingTarget: null,
      hostingUseCase: null,
      hostingSize: null,
    });
  });

  it.each([
    ['target', { ...HOSTING, target: 'heroku' }],
    ['useCase', { ...HOSTING, useCase: 'prototype' }],
    ['size', { ...HOSTING, size: 'xl' }],
  ])('refuses an unknown %s by name', async (field, input) => {
    const { fx, row } = await motirRow();
    const err = await projectRepoSetService
      .setHosting(row.id, input, fx.ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProjectRepoInvalidFieldError);
    expect((err as ProjectRepoInvalidFieldError).field).toBe(field);
    expect(await stored(row.id)).toMatchObject({ hostingTarget: null });
  });

  it('refuses a different target on a row that has one — moving is a migration', async () => {
    const { fx, row } = await motirRow();
    await projectRepoSetService.setHosting(row.id, HOSTING, fx.ctx);
    const err = await projectRepoSetService
      .setHosting(row.id, { ...HOSTING, target: 'aws' }, fx.ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProjectRepoHostingTargetFixedError);
    expect(err).toMatchObject({ current: 'fly', requested: 'aws' });
    expect(await stored(row.id)).toMatchObject({ hostingTarget: 'fly' });
  });

  it('accepts the same values again without a write', async () => {
    const { fx, row } = await motirRow();
    await projectRepoSetService.setHosting(row.id, HOSTING, fx.ctx);
    const before = await stored(row.id);
    const dto = await projectRepoSetService.setHosting(row.id, HOSTING, fx.ctx);
    expect(dto.hostingTarget).toBe('fly');
    expect((await stored(row.id)).updatedAt).toEqual(before.updatedAt);
  });

  it('revises the use case and size on the same target', async () => {
    const { fx, row } = await motirRow();
    await projectRepoSetService.setHosting(row.id, HOSTING, fx.ctx);
    const dto = await projectRepoSetService.setHosting(
      row.id,
      { target: 'fly', useCase: 'planned_product', size: 'large' },
      fx.ctx,
    );
    expect(dto).toMatchObject({ hostingUseCase: 'planned_product', hostingSize: 'large' });
  });
});

describe('toProjectRepoDto hosting fields', () => {
  const base = {
    id: 'r1',
    workspaceId: 'w1',
    projectId: 'p1',
    role: 'web',
    label: null,
    name: 'acme',
    seedSource: 'platform-starter',
    state: 'proposed',
    failureReason: null,
    proposalSignal: null,
    seedMatch: null,
    githubRepoId: null,
    position: 'a0',
    seedHeadSha: null,
    ciActionsDisabled: false,
    ciActionsIntentAt: null,
    ciActionsAppliedAt: null,
    takeoverState: null,
    takeoverTargetOwner: null,
    takeoverRequestedAt: null,
    takeoverTransferredAt: null,
    takeoverCompletedAt: null,
    takeoverFailureReason: null,
    hostingTarget: null,
    hostingUseCase: null,
    hostingSize: null,
    previewPushNamespace: null,
    previewEnabledAt: null,
    previewCredentialExpiresAt: null,
    createdAt: new Date('2026-10-28T00:00:00Z'),
    updatedAt: new Date('2026-10-28T00:00:00Z'),
    githubRepo: null,
    collaborators: [],
  } satisfies ProjectRepoWithRealized;

  it('maps an unset row to nulls', () => {
    expect(toProjectRepoDto(base)).toMatchObject({
      hostingTarget: null,
      hostingUseCase: null,
      hostingSize: null,
    });
  });

  it('maps a set row to its values', () => {
    expect(
      toProjectRepoDto({
        ...base,
        hostingTarget: 'aws',
        hostingUseCase: 'mvp',
        hostingSize: 'medium',
      }),
    ).toMatchObject({ hostingTarget: 'aws', hostingUseCase: 'mvp', hostingSize: 'medium' });
  });
});
