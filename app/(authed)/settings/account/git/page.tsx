import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { GitBranch } from 'lucide-react';
import { getSession } from '@/lib/auth';
import { getWorkspaceContext } from '@/lib/workspaces';
import { githubIdentityService } from '@/lib/services/githubIdentityService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { GithubMark } from '@/components/icons/GithubMark';
import { Card } from '@/components/ui/Card';
import { buttonVariants } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { GitAccountCard } from './_components/GitAccountCard';

// SETTINGS → ACCOUNT → GIT ACCOUNTS (Story MOTIR-4669 · MOTIR-4682), built to
// `design/settings/account-settings.mock.html` Panels 9–10.
//
// Every other card in this story moves something UP a tier — the repository and
// its connection go from the workspace to the ORGANISATION. This one moves
// something DOWN, and it is the piece most likely to be lost in the shuffle,
// because it is small and because it currently lives on the same page as the
// thing being moved up.
//
// `GithubIdentity` is `userId @unique`. It has never belonged to a workspace, and
// `projectSettingsNav.ts` already calls connecting it "the one action nobody can
// take on [a member's] behalf." It belongs beside tokens and passkeys.
//
// ⚠️ WHAT THIS PANE IS NOT: no repository list, no installation lifecycle. Those
// are the ORGANISATION's (MOTIR-4680). A pane here showing "repositories you can
// see" would re-introduce the exact tier confusion this story removes — and
// `tests/settings/accountGitAccounts.test.tsx` asserts their ABSENCE, so a later
// addition goes red rather than passing quietly.
//
// ⚠️ NO ADMIN GATE, AND THAT IS THE POINT OF IT. Every authenticated user reaches
// this pane, because the credential it manages is theirs. The registry entry
// carries no permission for the same reason (`accountSettingsNav.ts` records why
// that registry has no access axis at all).

const OAUTH_START_PATH = '/api/github/oauth/start?from=accountGit';

export default async function AccountGitAccountsPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const [t, locale] = await Promise.all([getTranslations('settings.gitAccounts'), getLocale()]);

  // TWO INDEPENDENT READS, and the independence is the page's subject. The
  // identity is the USER's (`withUserContext`, RLS-narrowed to their own row);
  // the installation is the ORGANISATION's, read only to answer state C below.
  // A workspace context is not required to render this pane — an account is
  // configured with no workspace selected — so the second read is skipped rather
  // than made a precondition.
  //
  // ⚠️ AND IT NOW ASKS THE TIER THE SENTENCE ABOVE ALREADY CLAIMED (MOTIR-4836).
  // This read said "the ORGANISATION's" and went through the WORKSPACE-tier
  // lookup (`githubInstallationRepository.findByWorkspaceId`), which compares
  // `workspace_id`. From a SIBLING workspace of the installing one that answers
  // null, and state C ("connect the App") is offered to a member of an
  // organisation that has the App installed. The comment was right and the call
  // was the only installation lookup that existed when this page was written;
  // `listOrganizationInstallations` is the one it describes.
  //
  // Only PRESENCE is read here — this pane asks "does the organisation have the
  // App at all?", never which account — so the set collapses to a boolean and no
  // choice is made between N connections.
  const ctx = await getWorkspaceContext();
  const [identity, installations] = await Promise.all([
    githubIdentityService.getIdentityForUser(session.user.id),
    ctx
      ? githubInstallationService.listOrganizationInstallations({
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
        })
      : Promise.resolve([]),
  ]);
  const hasInstallation = installations.length > 0;

  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h2 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h2>
        <p className="font-sans text-sm text-(--el-text-muted)">{t('subtitle')}</p>
      </header>

      {identity ? (
        <GitAccountCard
          identity={identity}
          hasInstallation={hasInstallation}
          reconnectHref={OAUTH_START_PATH}
          copy={{
            host: t('host.github'),
            connected: t('state.connected'),
            needsReauth: t('state.needsReauth'),
            reauthTitle: t('reauth.title'),
            reauthBody: t('reauth.body'),
            reconnect: t('reconnect'),
            connectedOn: t('connectedOn', {
              date: new Date(identity.createdAt).toLocaleDateString(locale, {
                day: 'numeric',
                month: 'long',
                year: 'numeric',
              }),
            }),
            noInstallationTitle: t('noInstallation.title'),
            noInstallationBody: t('noInstallation.body'),
          }}
        />
      ) : (
        <Card>
          <EmptyState
            icon={<GitBranch aria-hidden />}
            title={t('empty.title')}
            description={t('empty.description')}
            action={
              <a href={OAUTH_START_PATH} className={buttonVariants({ variant: 'primary' })}>
                <GithubMark className="h-4 w-4" aria-hidden />
                {t('connect')}
              </a>
            }
          />
        </Card>
      )}
    </div>
  );
}
