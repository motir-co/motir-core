// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

// THE /settings/project/approvals PAGE hands the review-agent island the stored
// source and bot-posting values from the settings DTO (Story MOTIR-10327 ·
// Subtask MOTIR-10337). Every read is stubbed at its module boundary; the island
// records the props it was given. The cards' own behaviour is
// `tests/components/ReviewAgentCard.test.tsx`'s.

const h = vi.hoisted(() => ({
  islandProps: [] as Array<Record<string, unknown>>,
  getSettings: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ getSession: vi.fn(async () => ({ user: { id: 'u' } })) }));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
}));
vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const messages = (await import('@/messages/en.json')).default;
  return {
    getTranslations: async (namespace: string) =>
      createTranslator({ locale: 'en', messages, namespace } as never),
  };
});
vi.mock('@/lib/projects', () => ({
  getActiveProject: vi.fn(async () => ({
    userId: 'u',
    workspaceId: 'w',
    projectId: 'p',
    project: { identifier: 'ACME' },
  })),
}));
vi.mock('@/app/(authed)/settings/project/_guard', () => ({
  guardSettingsPage: vi.fn(async () => null),
}));
vi.mock('@/lib/services/approvalGateSettingsService', () => ({
  approvalGateSettingsService: { getSettings: h.getSettings },
}));
vi.mock('@/lib/services/acceptanceVideoEligibilityService', () => ({
  acceptanceVideoEligibilityService: { resolve: vi.fn(async () => ({ reason: 'eligible' })) },
}));
vi.mock('@/lib/services/projectPrMergeModeService', () => ({
  projectPrMergeModeService: { getPrMergeMode: vi.fn(async () => ({ prMergeMode: 'manual' })) },
}));
vi.mock('@/app/(authed)/settings/project/approvals/_components/AcceptanceVideoGateCard', () => ({
  AcceptanceVideoGateCard: () => null,
}));
vi.mock('@/app/(authed)/settings/project/approvals/_components/DesignApprovalGateCard', () => ({
  DesignApprovalGateCard: () => null,
}));
vi.mock(
  '@/app/(authed)/settings/project/approvals/_components/MergeModeAndReviewAgentCards',
  () => ({
    MergeModeAndReviewAgentCards: (props: Record<string, unknown>) => {
      h.islandProps.push(props);
      return null;
    },
  }),
);

import ProjectApprovalsPage from '@/app/(authed)/settings/project/approvals/page';

beforeEach(() => {
  cleanup();
  h.islandProps.length = 0;
});

describe('the Approvals page seeds the review-agent island from the DTO', () => {
  it.each([
    ['own', false],
    ['hosted', true],
  ] as const)('source %s, bot posting %s', async (source, botPosts) => {
    h.getSettings.mockResolvedValue({
      acceptanceVideoEnabled: false,
      reviewAgentEnabled: true,
      designApprovalGate: true,
      reviewAgentSource: source,
      reviewBotPostsEnabled: botPosts,
    });
    render((await ProjectApprovalsPage()) as ReactElement);
    expect(h.islandProps).toHaveLength(1);
    expect(h.islandProps[0]).toEqual({
      projectKey: 'ACME',
      initialPrMergeMode: 'manual',
      initialReviewAgentEnabled: true,
      initialReviewAgentSource: source,
      initialReviewBotPostsEnabled: botPosts,
    });
  });
});
