import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Lock } from 'lucide-react';
import { getSession } from '@/lib/auth';
import { BillingForbiddenError, BillingNotAvailableError } from '@/lib/billing/errors';
import { isCloudBilling } from '@/lib/billing/availability';
import { OrganizationNotFoundError } from '@/lib/organizations/errors';
import { orgFleetService } from '@/lib/services/orgFleetService';
import { resolveActiveOrganizationForPane } from '@/lib/workspaces/tierDisclosure.server';
import { EmptyState } from '@/components/ui/EmptyState';
import { buttonVariants } from '@/components/ui/Button';
import type { OrgFleetDTO } from '@/lib/dto/orgFleet';
import { FleetClient } from './_components/FleetClient';

// Settings › Organization › Fleet (MOTIR-10369 · Story MOTIR-10363, design
// `design/org-admin/org-admin--fleet.mock.html`): what the organisation runs on
// Motir's fleet right now, and the controls an owner or admin uses to stop it.
//
// ⚠️ THIS ROUTE DECIDES EXISTENCE before anything renders, as Billing & plans
// does: off-cloud (no fleet meter) and for a non-member it `notFound()`s, and
// there is no `loading.tsx` and no Suspense above the gate, so the 404 is settled
// before any frame flushes. A plain member gets the area's forbidden panel.
//
// ⚠️ ONE READ for the first paint — the same `orgFleetService.read` the island
// re-reads every 30 seconds over `GET /api/organizations/[orgId]/fleet`. The
// role is decided there, not here.

export default async function OrganizationFleetPage() {
  if (!isCloudBilling()) notFound();

  const session = await getSession();
  if (!session) redirect('/sign-in');

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

  let fleet: OrgFleetDTO;
  try {
    fleet = await orgFleetService.read({ organizationId: org.id, actorUserId: session.user.id });
  } catch (err) {
    if (err instanceof OrganizationNotFoundError || err instanceof BillingNotAvailableError) {
      notFound();
    }
    if (err instanceof BillingForbiddenError) {
      return (
        <div className="mx-auto max-w-[48rem]">
          <EmptyState
            icon={<Lock className="h-12 w-12" aria-hidden />}
            title={tOrg('states.forbiddenTitle')}
            description={tOrg('states.forbiddenDescription', { org: org.name })}
            action={
              <Link
                href="/dashboard"
                className={buttonVariants({ variant: 'secondary', size: 'md' })}
              >
                {tOrg('states.backToWorkspace')}
              </Link>
            }
          />
        </div>
      );
    }
    throw err;
  }

  return (
    <FleetClient
      orgId={org.id}
      orgName={org.name}
      initialFleet={fleet}
      initialReadAt={new Date().toISOString()}
    />
  );
}
