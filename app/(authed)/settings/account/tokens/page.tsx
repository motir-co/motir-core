import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getWorkspaceContext } from '@/lib/workspaces';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { projectsService } from '@/lib/services/projectsService';
import { oauthConnectionsService } from '@/lib/services/oauthConnectionsService';
import { ApiDocsLinkPanel } from '../_components/ApiDocsLinkPanel';
import { ApiTokensManager } from '../_components/ApiTokensManager';
import { ConnectCliPanel } from '../_components/ConnectCliPanel';
import { ConnectedAppsSection, ConnectedAppsSkeleton } from '../_components/ConnectedAppsSection';

// The Tokens pane of the account-settings area (Story 7.8 · Subtask 7.8.3) —
// the Security → Tokens surface (design `account-settings.mock.html` Panels
// 3–8), the human face of the PAT substrate (7.8.1) the MCP bearer gate (7.8.4)
// consumes. A server component (gate + the initial reads); the `ApiTokensManager`
// client island owns the create / revoke / copy interactions and its own
// optimistic list state. Account-level: it lists ALL the user's tokens across
// their workspaces (each row labelled with the org → workspace it is bound to,
// bug 7.21). The create modal scopes a new token to a chosen workspace, so the
// page also loads the user's org → workspace tree + the active workspace to
// pre-select.
export default async function AccountApiTokensPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('settings.apiTokens');
  const [tokens, scopeOrgs, ctx] = await Promise.all([
    apiTokensService.listForUser(session.user.id),
    apiTokensService.listScopeOptions(session.user.id),
    getWorkspaceContext(),
  ]);

  // The ACTIVE project, for the create modal's default binding (MOTIR-4876). It
  // is a second round trip because `WorkspaceContext` carries the workspace and
  // not the project, and it is sequential because it takes the workspace the
  // read above resolves. A token BINDS to a project (MOTIR-2606), so the default
  // has to be the project the reader is in rather than the workspace's first —
  // see `CreateTokenModal`'s note for what those two stopped meaning together.
  const activeProject = ctx
    ? await projectsService.getActiveProject(ctx.userId, ctx.workspaceId)
    : null;

  // The tokens TABLE is wide (8 columns incl. the 7.7.19 Scopes column), so this
  // pane uses the table-pane width (the workspace-jobs precedent), NOT the 42rem
  // form-pane width its sibling account panes (language / notifications) use —
  // the design's token list panel is ~1180px. The header copy stays narrow for
  // reading (its own max-w below).
  return (
    <div className="mx-auto flex max-w-[64rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h2 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h2>
        <p className="max-w-[34rem] font-sans text-sm text-(--el-text-muted)">{t('subtitle')}</p>
      </header>

      {/* The DOCS route reads first of all (MOTIR-2188, design `design/api-docs`
          Panel 8): the reader with the sharpest need is someone who has just
          minted a token and is holding a secret with nothing to do with it.
          Same "the route out reads first" argument as the CLI panel below,
          one line higher — reading the docs is cheaper than either minting by
          hand or installing a CLI. This link is the ONLY thing Story 11.4 adds
          to this page. */}
      <ApiDocsLinkPanel />

      {/* The CLI route reads FIRST — above the tokens card AND above the empty
          state (MOTIR-1869, design `cli-connect` Panels 9–10). A first-time user
          has no tokens, so if this sat below, the person who could have run two
          commands is instead walked into minting and pasting a secret by hand.
          `hasTokens` only picks the tie line's tense; the panel itself is
          unconditional. */}
      <ConnectCliPanel hasTokens={tokens.length > 0} />

      <ApiTokensManager
        initialTokens={tokens}
        scopeOrgs={scopeOrgs}
        activeWorkspaceId={ctx?.workspaceId ?? null}
        activeProjectId={activeProject?.id ?? null}
        // A staff "View as" session cannot change a credential's authority
        // (MOTIR-749), so the edit controls render disabled with the reason.
        staffSession={Boolean(session.impersonation)}
      />

      {/* Connected apps — the LAST card, below the tokens, whatever the tokens
          card shows (MOTIR-6986, design `account-settings--connected-apps`
          Panel 1): the pane is still the tokens pane, and the CLI panel's tie
          line promises its terminal "appears below" in the tokens list. The
          frame is an in-page <Suspense> placed after the session gate above —
          never a `loading.tsx` (CLAUDE.md) — so only these rows wait. */}
      <Suspense fallback={<ConnectedAppsSkeleton />}>
        <ConnectedApps userId={session.user.id} multiOrg={scopeOrgs.length > 1} />
      </Suspense>
    </div>
  );
}

/** The Connected apps read, streamed behind its own boundary. A failed read
 * renders the card's inline error (Panel 5) — whose Try again re-reads through
 * the list route — rather than failing the whole pane. */
async function ConnectedApps({ userId, multiOrg }: { userId: string; multiOrg: boolean }) {
  const connections = await oauthConnectionsService.listForUser(userId).catch((err: unknown) => {
    console.error('[connected-apps] list read failed', err);
    return null;
  });
  return <ConnectedAppsSection initialConnections={connections} multiOrg={multiOrg} />;
}
