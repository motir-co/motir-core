import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { isCloudBilling } from '@/lib/billing/availability';
import { orgAiModelsRoomService } from '@/lib/services/orgAiModelsRoomService';
import { resolveActiveOrganizationForPane } from '@/lib/workspaces/tierDisclosure.server';
import { EmptyState } from '@/components/ui/EmptyState';
import { OrgAiModelsRoom } from './_components/OrgAiModelsRoom';

// Settings › Organisation › AI models (MOTIR-10846 · Story MOTIR-10838, design
// `design/org-admin/org-admin--ai-models.mock.html`): which model each Motir AI
// function uses for the organisation.
//
// ⚠️ CLOUD ONLY, decided before anything renders: whether an org may choose
// depends on its plan tier, which only the cloud build has, so off-cloud the route
// is a 404 (the rail row is `cloudOnly`). No `loading.tsx` above this gate.
//
// ⚠️ NO ROLE GATE. Any member of the active org is served the room; the org routes
// it reads decide `canEdit`, so a plain member who opens the address gets the
// read-only room, not a forbidden panel (the Usage & cost posture). The island
// reads both route sets on mount, because its loading and unavailable states ARE
// those reads.

export default async function OrganizationAiModelsPage() {
  if (!isCloudBilling()) notFound();

  const session = await getSession();
  if (!session) redirect('/sign-in');

  const current = await resolveActiveOrganizationForPane(session.user.id);
  if (!current) {
    const tOrg = await getTranslations('orgAdmin');
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
  const context = await orgAiModelsRoomService.context(org.id);

  return (
    <OrgAiModelsRoom
      orgId={org.id}
      orgName={org.name}
      isMeta={context.isMeta}
      planName={context.planName}
    />
  );
}
