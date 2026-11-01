import { Suspense } from 'react';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { isCloud } from '@/lib/billing/availability';
import { getWorkspaceContext } from '@/lib/workspaces';
import { isTenantDomainConfigured } from '@/lib/publicAddresses/tenantDomain';
import { EmptyState } from '@/components/ui/EmptyState';
import { SettingsPaneFrame } from '@/components/settings/SettingsPaneFrame';
import { PublicAddressBody } from './_components/PublicAddressBody';

// WORKSPACE SETTINGS › PUBLIC ADDRESS (Story MOTIR-4528 · MOTIR-9514), built to
// `design/workspace-address/workspace-address.mock.html`. The workspace's one
// name under the tenant base domain, moved up from project settings because ADR
// §3 makes a subdomain a property of the WORKSPACE.
//
// ── THE GATES, IN THIS ORDER ──────────────────────────────────────────────
//
// 1. `isCloud()` → `notFound()`. Public addresses are a CLOUD capability (ADR
//    §11): off-cloud the room is absent, and the registry row is `cloudOnly`.
// 2. The session, then the workspace context.
// 3. The base domain. A cloud build with no `MOTIR_PUBLIC_TENANT_DOMAIN` has
//    nothing to put a name under; that is an OPERATOR state, so it explains
//    itself rather than 404ing — the project page's reasoning, kept.
//
// ⚠️ NO REVEAL GATE, deliberately — the Roles room's carve-out. Below the
// workspace-tier reveal the rail is not taught, and the org settings page carries
// a door card to THIS route (`WorkspaceFoldInSection`), so the route must answer
// at every workspace count or the door lands on a 404.
//
// ⚠️ `canManage` IS THE WORKSPACE ROLE, asked through the service's own
// `roleMayManageAddress` rather than restated: the subdomain's writes assert that
// predicate, and a second copy here would drift into controls that appear and
// then refuse.
//
// ⚠️ NO `loading.tsx` at or above this segment: this page decides existence
// (`tests/navigation/loading-boundary-guard.test.ts`).

export default async function WorkspacePublicAddressPage() {
  if (!isCloud()) notFound();

  const session = await getSession();
  if (!session) redirect('/sign-in');

  const ctx = await getWorkspaceContext();
  if (!ctx) redirect('/dashboard');

  const t = await getTranslations('settings.workspaceAddress');

  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">{t('title')}</h1>
        <p className="font-sans text-sm text-(--el-text-secondary)">{t('subtitle')}</p>
      </header>

      {isTenantDomainConfigured() ? (
        <Suspense fallback={<SettingsPaneFrame />}>
          <PublicAddressBody workspaceId={ctx.workspaceId} actorUserId={ctx.userId} />
        </Suspense>
      ) : (
        <EmptyState title={t('unavailable.title')} description={t('unavailable.description')} />
      )}
    </div>
  );
}
