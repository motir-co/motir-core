import { Suspense, type CSSProperties, type ReactNode } from 'react';
import type { Metadata } from 'next';
import { ToastProvider } from '@/components/ui/Toast';
import { AppLayout } from '@/components/ui/AppLayout';
import { SidebarDrawer } from '@/components/ui/SidebarDrawer';
import { ApprovalOverlay } from '@/components/approvals/ApprovalOverlay';
import { PERMISSIONS } from '@/lib/permissions/catalog';
import { publicProjectUrl } from '@/lib/publicProjects/urls';
import { legalIndexUrl as resolveLegalIndexUrl } from '@/lib/legal/links';
import { docsIndexUrl as resolveDocsIndexUrl } from '@/lib/docs/links';
import { settleVisitor } from '@/lib/visitor/pageGate';
import { ReaderRoutesProvider } from '@/lib/visitor/useReaderRoutes';
import { CommandPaletteProvider } from '@/app/(authed)/_components/CommandPaletteProvider';
import { CreateIssueProvider } from '@/app/(authed)/_components/CreateIssueProvider';
import { ProjectAccessProvider } from '@/app/(authed)/_components/ProjectAccessProvider';
import { HelpMenu } from '@/app/(authed)/_components/HelpMenu';
import { ThemeToggle } from '@/app/(authed)/_components/ThemeToggle';
import { VisitorAddressFetch } from './_components/VisitorAddressFetch';
import { VisitorBanner } from './_components/VisitorBanner';
import { VisitorTopNav } from './_components/VisitorTopNav';
import { VisitorRail } from './_components/VisitorRail';

// THE VISITOR ROUTE TREE's layout (Story MOTIR-6170 · MOTIR-6648; design
// MOTIR-6641 panels 3–5, 9): `app.motir.co/p/<identifier>/<view>`, the URL a
// person outside the organisation opens to watch a public project being built.
//
// ⚠️ THE ORDER IS A PRIVACY BOUNDARY, and it lives in `settleVisitor`
// (`lib/visitor/pageGate.ts`): not-found FIRST — for a signed-out reader too —
// then sign in, then a member sent to their own view, then the consent screen.
// Only a signed-in, consented Visitor reaches the shell below. The consent screen
// is NOT in this group (`app/(auth)/p/[identifier]/consent`), or this layout
// would redirect into itself.
//
// ⚠️ NO `loading.tsx` AND NO `not-found.tsx` UNDER THIS TREE (CLAUDE.md): the
// not-found above must keep its 404, and it renders the app's own not-found —
// no banner, no chrome — identical to an unknown address.
//
// ⚠️ THE PERMISSION PROVIDER IS MOUNTED, NOT OMITTED. An unmounted
// `ProjectAccessProvider` fails OPEN (every `can()` true) and would draw every
// write control; mounted with the Visitor key set, `can('work_item:edit')` is
// false on every page. The create provider is mounted for the same reason the
// other way round: the shared bodies read it, and with `canCreate` off no New
// work item door renders at all.

/** The Visitor pages need a session now, so they are not an indexable surface. */
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function VisitorLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ identifier: string }>;
}) {
  const { identifier: raw } = await params;
  const identifier = decodeURIComponent(raw);
  const { ctx, actorName, actorEmail, actorImage } = await settleVisitor(identifier);
  const project = ctx.project;
  // The Visitor key set as the provider's array, in catalog order (it takes the
  // serialisable `ActorPermissionsDTO` shape).
  const permissions = PERMISSIONS.filter((key) => ctx.permissions.has(key));
  const helpMenu = (
    <HelpMenu docsIndexUrl={resolveDocsIndexUrl()} legalIndexUrl={resolveLegalIndexUrl()} />
  );

  // Every shared body under here builds its hrefs for this project's Visitor
  // paths (MOTIR-6888) — the ApprovalOverlay's included, so it sits inside —
  // and every request this tab makes names the project it reads (MOTIR-6892).
  return (
    <ReaderRoutesProvider identifier={project.identifier}>
      <VisitorAddressFetch identifier={project.identifier} />
      <ToastProvider>
        <CommandPaletteProvider>
          <CreateIssueProvider canEdit={false} canCreate={false}>
            <ProjectAccessProvider permissions={permissions}>
              <AppLayout
                banner={<VisitorBanner projectName={project.name} />}
                topNav={
                  <VisitorTopNav
                    projectName={project.name}
                    projectKey={project.identifier}
                    landingHref={publicProjectUrl(project.identifier)}
                    user={{ name: actorName, email: actorEmail, image: actorImage }}
                  />
                }
                sidebar={<VisitorRail identifier={project.identifier} helpMenu={helpMenu} />}
              >
                <div
                  style={{ '--shell-bottom-clearance': '1.5rem' } as CSSProperties}
                  className="px-4 pt-6 pb-(--shell-bottom-clearance) sm:px-6 lg:px-8"
                >
                  {children}
                </div>
              </AppLayout>
              <SidebarDrawer
                footer={
                  <>
                    <div className="min-w-0 flex-1" />
                    <HelpMenu
                      placement="drawer"
                      docsIndexUrl={resolveDocsIndexUrl()}
                      legalIndexUrl={resolveLegalIndexUrl()}
                    />
                    <ThemeToggle placement="drawer" />
                  </>
                }
              >
                <VisitorRail identifier={project.identifier} variant="drawer" />
              </SidebarDrawer>
              {/* The approval records' rows open the approval overlay from its
                  address, as they do for a member; its read by key is a Visitor
                  data door (MOTIR-6647), and a Visitor decides nothing in it. */}
              <Suspense fallback={null}>
                <ApprovalOverlay />
              </Suspense>
            </ProjectAccessProvider>
          </CreateIssueProvider>
        </CommandPaletteProvider>
      </ToastProvider>
    </ReaderRoutesProvider>
  );
}
