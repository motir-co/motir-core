import { redirect, notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { isCloud } from '@/lib/billing/availability';
import { EmptyState } from '@/components/ui/EmptyState';
import { isTenantDomainConfigured } from '@/lib/publicAddresses/tenantDomain';
import { publicSubdomainService } from '@/lib/services/publicSubdomainService';
import { customDomainService } from '@/lib/services/customDomainService';
import { guardSettingsPage } from '../_guard';
import { publicProjectPath, publicSiteOrigin } from '@/lib/publicProjects/urls';

import { PublicAddressEcho } from './_components/PublicAddressEcho';
import { CustomDomainsSection } from './_components/CustomDomainsSection';
import { NO_PROJECT_PATH } from '@/lib/navigation/landing';

// THE PUBLIC ADDRESS ROOM (Story MOTIR-3878 · MOTIR-4221) — where a project
// echoes its workspace's address (MOTIR-9515) and, once MOTIR-4229 lands, a project connects a domain
// the customer owns. Drawn by MOTIR-4211:
// `design/projects/public-address.mock.html` panels 0, 1, 2, 8, 9 +
// `design/projects/design-notes.md` § *Public address*.
//
// ── FOUR GATES, IN THIS ORDER ─────────────────────────────────────────────
//
// The first three are the Public page room's (MOTIR-4243), followed class for
// class because they are the same three questions in the same order:
//
// 1. `isCloud()` → `notFound()`. Public addresses are a CLOUD capability (ADR
//    §11): off-cloud the feature is ABSENT, not hidden, so the honest answer is
//    that there is no door. It runs FIRST — ahead of the session read — because
//    a capability this build does not have must not open a session to say so.
// 2. The session, then the active project.
// 3. THE DESTINATION GUARD (MOTIR-2469). Hiding is presentation and never
//    protection: the rail row is gone for a non-admin and this page is still one
//    typed URL away. The key comes from the registry entry `public-address` and
//    is never re-declared here.
//
// 4. ⚠️ AND A FOURTH THIS ROOM HAS THAT ITS NEIGHBOUR DOES NOT — the base
//    domain. A deployment that is cloud but has no `MOTIR_PUBLIC_TENANT_DOMAIN`
//    can serve every other public surface and cannot offer a subdomain, because
//    there is nothing to put one under. That is an OPERATOR state, not the
//    customer's, so it renders an explanation rather than a 404: a 404 here
//    would tell an admin the room does not exist when it does, and they would
//    go looking for the feature instead of for the variable.
//
// ── THE SUBDOMAIN IS ECHOED, NOT EDITED (Story MOTIR-4528 · MOTIR-9515) ────
//
// ADR §3 makes a subdomain a property of the WORKSPACE, and its control moved to
// `/settings/workspace/public-address` (MOTIR-9514). This room keeps a read-only
// echo, the same for every role, so it reads no workspace role at all; the
// custom-domain half below is still this project's own.
export default async function ProjectPublicAddressPage() {
  // Off-cloud (self-hosted GPL build): public addresses do not exist.
  if (!isCloud()) notFound();

  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('settings');

  const ctx = await getActiveProject();
  // No active project: the reader can enter none of the workspace's projects
  // (MOTIR-6548) — the no-project landing, never `/sign-in`, which would
  // bounce a signed-in reader straight back.
  if (!ctx) redirect(NO_PROJECT_PATH);

  const refused = await guardSettingsPage('public-address', ctx);
  if (refused) return refused;

  const header = (
    <header className="flex flex-col gap-1">
      <h1 className="font-serif text-3xl font-semibold text-(--el-text)">
        {t('publicAddress.title')}
      </h1>
      <p className="font-sans text-sm text-(--el-text-muted)">
        {t.rich('publicAddress.subtitle', {
          projectName: ctx.project.name,
          strong: (chunks) => <strong>{chunks}</strong>,
        })}
      </p>
    </header>
  );

  // Gate 4 — the operator state. See the note above for why this is not a 404.
  if (!isTenantDomainConfigured()) {
    return (
      <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
        {header}
        <EmptyState
          title={t('publicAddress.unavailable.title')}
          description={t('publicAddress.unavailable.description')}
        />
      </div>
    );
  }

  const [subdomain, addresses] = await Promise.all([
    publicSubdomainService.getForWorkspace(ctx.workspaceId, ctx.userId),
    customDomainService.list({ key: ctx.project.identifier, actorUserId: ctx.userId, ctx }),
  ]);

  // `MOTIR_PUBLIC_SITE_URL` is server configuration, so the project's own
  // address is resolved here and shown as text (scheme stripped: read, not
  // followed).
  const projectUrl = `${publicSiteOrigin()}${publicProjectPath(ctx.project.identifier)}`;

  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      {header}
      <PublicAddressEcho
        subdomain={subdomain}
        projectAddress={projectUrl.replace(/^https?:\/\//, '')}
        projectUrl={projectUrl}
      />
      {/* MOTIR-4229's half. ⚠️ `canManage` IS `true` BY CONSTRUCTION HERE and is
          passed anyway: the destination guard above already refused anyone
          without `project:manage_access`, which is the key every one of the
          section's writes asserts — so on THIS page the two cannot disagree. The
          prop exists so the section does not inherit its host's gate by
          assumption. */}
      <CustomDomainsSection projectKey={ctx.project.identifier} canManage addresses={addresses} />
    </div>
  );
}
