import { Suspense } from 'react';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { isCloud } from '@/lib/billing/availability';
import { getWorkspaceContext } from '@/lib/workspaces';
import { isTenantDomainConfigured } from '@/lib/publicAddresses/tenantDomain';
import { EmptyState } from '@/components/ui/EmptyState';
import { SettingsPaneFrame } from '@/components/settings/SettingsPaneFrame';
import { CustomDomainsBody } from './_components/CustomDomainsBody';

// WORKSPACE SETTINGS › CUSTOM DOMAINS (Story MOTIR-4533 · MOTIR-9529), built to
// `design/workspace-address/custom-domains.mock.html`. A customer domain is the
// WORKSPACE's (ADR MOTIR-9521 §1), so it lives beside the workspace's Public
// address, and project settings keeps no control for it.
//
// The gates are the Public address room's, in its order and for its reasons:
// `isCloud()` → `notFound()` first, then the session and the workspace context,
// then the base domain as an OPERATOR state that explains itself. No reveal
// gate, like its neighbour: the address pane links here at every workspace count.
//
// ⚠️ NO `loading.tsx` at or above this segment: this page decides existence
// (`tests/navigation/loading-boundary-guard.test.ts`).

export default async function WorkspaceCustomDomainsPage() {
  if (!isCloud()) notFound();

  const session = await getSession();
  if (!session) redirect('/sign-in');

  const ctx = await getWorkspaceContext();
  if (!ctx) redirect('/dashboard');

  const t = await getTranslations('settings');

  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">
          {t('customDomains.title')}
        </h1>
        <p className="font-sans text-sm text-(--el-text-secondary)">
          {t('customDomains.subtitle')}
        </p>
      </header>

      {isTenantDomainConfigured() ? (
        <Suspense fallback={<SettingsPaneFrame />}>
          <CustomDomainsBody workspaceId={ctx.workspaceId} actorUserId={ctx.userId} />
        </Suspense>
      ) : (
        <EmptyState
          title={t('workspaceAddress.unavailable.title')}
          description={t('workspaceAddress.unavailable.description')}
        />
      )}
    </div>
  );
}
