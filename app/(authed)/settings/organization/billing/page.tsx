import { Suspense } from 'react';
import { redirect, notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { organizationsService } from '@/lib/services/organizationsService';
import { resolveActiveOrganizationForPane } from '@/lib/workspaces/tierDisclosure.server';
import { isCloudBilling } from '@/lib/billing/availability';
import { EmptyState } from '@/components/ui/EmptyState';
import { SettingsPaneFrame } from '@/components/settings/SettingsPaneFrame';
import { BillingClient } from './_components/BillingClient';

// The org billing & plans surface (Story 8.1.7, design/billing panels 1–6, 8) —
// the org owner's home for money: the two billed lines (Motir seats + Motir AI),
// the lifecycle states, the role gate, the AI-plan storefront and the seat-plan
// screen. CLOUD-ONLY (ADR §6): off-cloud the whole surface does not exist, so the
// route 404s behind `isCloudBilling()`, matching the hidden org-menu row + the
// missing settings card. The figures live in motir-ai and are fetched client-side
// over the 8.1.6 boundary, so this server page only gates + resolves the active
// org and its seat count; the VIEW/MUTATE permission split (owner/admin vs owner)
// is decided server-side in billingService and rendered from the response.
export default async function OrganizationBillingPage() {
  // Off-cloud (self-hosted GPL build): the commercial surface does not exist.
  if (!isCloudBilling()) notFound();

  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('billing');
  const tOrg = await getTranslations('orgAdmin');

  const current = await resolveActiveOrganizationForPane(session.user.id);

  if (!current) {
    return (
      <div className="mx-auto max-w-[48rem]">
        <EmptyState
          title={tOrg('states.noActiveOrgTitle')}
          description={tOrg('states.noActiveOrgDescription')}
        />
      </div>
    );
  }

  const org = current.organization;

  // MOTIR-3448 — allocation row 14: THE FRAME ONLY, and a small one — the client
  // island already owns its per-screen states, so all this buys is that the seat
  // read no longer holds the whole route.
  //
  // ⚠️ THIS ROUTE DECIDES EXISTENCE, and it is the one the whole in-page decision
  // was measured on: off-cloud it `notFound()`s, and with a route-level boundary
  // above it that 404 came back 200 (`tests/e2e/billing-selfhost.spec.ts`,
  // `motir-core/CLAUDE.md`). The `notFound()` is the FIRST statement in this
  // function and the boundary is the last, so nothing can flush before the
  // status is settled.
  // No width cap here: BillingClient caps each view at 64rem except the Motir AI
  // plans view, which takes the full page width (design/billing § "Amendment
  // 2026-10-23 — the Host plan", point 7, MOTIR-9403).
  return (
    <div className="w-full">
      {/* The header lives inside BillingClient so it swaps with the active
          screen (home / Motir AI / Motir seats), each with its own breadcrumb. */}
      <span className="sr-only">{t('title')}</span>
      <Suspense fallback={<SettingsPaneFrame />}>
        <BillingPaneBody orgId={org.id} orgName={org.name} actorUserId={session.user.id} />
      </Suspense>
    </div>
  );
}

/** The seat count (one seat per member, ADR §3) for the seat preview + the
 *  panel-6 seat calc — resolved the same way the org settings page does. */
async function BillingPaneBody({
  orgId,
  orgName,
  actorUserId,
}: {
  orgId: string;
  orgName: string;
  actorUserId: string;
}) {
  const { total: memberCount } = await organizationsService.listMembers({
    organizationId: orgId,
    actorUserId,
    limit: 1,
  });
  return <BillingClient orgId={orgId} orgName={orgName} memberCount={memberCount} />;
}
