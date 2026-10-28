// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import {
  ACCOUNT_SETTINGS_NAV,
  ACCOUNT_SETTINGS_ROUTES,
  groupAccountSettingsNav,
} from '@/lib/settings/accountSettingsNav';
import { GITHUB_RETURN_SURFACES } from '@/lib/github/returnSurface';
import { DisconnectAccountButton } from '@/app/(authed)/settings/account/git/_components/DisconnectAccountButton';

// Settings → Account → GIT ACCOUNTS (Story MOTIR-4669 · MOTIR-4682).
//
// Every other card in this story moves something UP a tier. This one moves the
// member's own credential DOWN, to the tier that owns it: `GithubIdentity` is
// `userId @unique` and has never belonged to a workspace.
//
// What this file guards, and why each is here rather than assumed:
//
//   1. THE ABSENCES. No repository list, no installation lifecycle. Those are the
//      organisation's, and a pane here offering "repositories you can see" would
//      re-introduce the tier confusion the whole story removes. An absence only
//      goes red if something asserts it.
//   2. THE DOOR. `/settings/project/code-access`'s connect link, which pointed at
//      a page MOTIR-4680 redirects away.
//   3. THE ROW, and its position — read off the registry's own stated rule.
//   4. THE INK. Danger on a page surface is `--el-danger-on-surface`.

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/account/git',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

const PAGE = readFileSync('app/(authed)/settings/account/git/page.tsx', 'utf8');
const ACTIONS = readFileSync('app/(authed)/settings/account/git/actions.ts', 'utf8');
const CODE_ACCESS = readFileSync('app/(authed)/settings/project/code-access/page.tsx', 'utf8');

afterEach(cleanup);

describe('⚠️ what this pane must NOT carry', () => {
  // The design says it in as many words: "No repository list. No installation
  // lifecycle." These assertions are how a later addition goes RED instead of
  // passing quietly, which is the only way an absence is a contract.

  it('never reads the organisation`s repositories', () => {
    expect(PAGE).not.toContain('listByOrganization');
    expect(PAGE).not.toContain('listAvailableForProject');
    expect(PAGE).not.toContain('projectRepoRepository');
    expect(PAGE).not.toContain('githubRepoRepository');
  });

  it('offers no installation ACTION — it may read one, and only to answer state C', () => {
    // The read is legitimate and necessary (below); performing the act is not.
    // Installing, managing and disconnecting the App are org-admin acts on the
    // ORGANISATION's surface, and a member sent to do one is sent to a door that
    // will not open for them.
    // ⚠️ THE READ IS THE ORGANISATION'S (MOTIR-4836). It was
    // `getWorkspaceInstallation` — a `workspace_id` lookup — while the page's own
    // comment said "the installation is the ORGANISATION's". From a SIBLING
    // workspace of the installing one that answered null, and state C's "the
    // organisation has no installation" note was shown to a member of an
    // organisation that has one. Pinned by NAME so the tier cannot drift back.
    expect(PAGE).toContain('listOrganizationInstallations');
    expect(PAGE).not.toContain('getWorkspaceInstallation');
    expect(PAGE).not.toContain('githubAppInstallUrl');
    expect(PAGE).not.toContain('bindInstallationForWorkspace');
    expect(PAGE).not.toContain('removeInstallation');
    expect(PAGE).not.toContain('manageOnGitHub');
  });

  it('the disconnect action touches the IDENTITY and nothing else', () => {
    // The two grants are INDEPENDENT. A member leaving is not an organisation
    // disconnecting, and the service's own comment records that the App is
    // uninstalled on GitHub, never here.
    expect(ACTIONS).toContain('githubIdentityService.disconnect');
    expect(ACTIONS).not.toContain('githubInstallationService');
  });
});

describe('the disconnect action cannot reach ANOTHER user`s identity', () => {
  it('takes no argument — the identity is the SESSION`s, by construction', () => {
    // Not "validates the id" — there IS no id. `GithubIdentity` is
    // `userId @unique`, so the only row this action can name is the session's,
    // and `githubIdentityService.disconnect` runs under `withUserContext` so RLS
    // narrows the delete a second time. A signature with a parameter would be a
    // surface to tamper with; this one has none.
    expect(ACTIONS).toMatch(/export async function disconnectGitAccountAction\(\): Promise<void>/);
    expect(ACTIONS).toContain('session.user.id');
  });

  it('redirects an unauthenticated caller rather than acting', () => {
    expect(ACTIONS).toMatch(/if \(!session\) redirect\('\/sign-in'\)/);
  });
});

describe('the DOOR — `code-access` reaches the connect action without a redirected route', () => {
  it('points at the account pane, not the workspace page MOTIR-4680 redirects away', () => {
    expect(CODE_ACCESS).toContain("'/settings/account/git'");
    expect(CODE_ACCESS).not.toContain("'/settings/workspace/github'");
  });

  it('the destination is a REAL registry route, so it cannot rot behind a rename', () => {
    // The failure this replaces was not a wrong link; it was a link that went
    // stale when the page under it moved. Pinning the destination to the
    // registry — which the route↔entry totality test pairs 1:1 with the
    // filesystem — is what makes a rename fail loudly somewhere.
    expect(ACCOUNT_SETTINGS_ROUTES.map((e) => e.href)).toContain('/settings/account/git');
  });

  it('and the OAuth round trip returns HERE, by a registered surface id', () => {
    // MOTIR-4676 made the return an ID rather than a path, so a flow started from
    // this pane comes back to it. The page names the id; the registry resolves it.
    expect(PAGE).toContain('from=accountGit');
    expect(GITHUB_RETURN_SURFACES.accountGit).toBe('/settings/account/git');
  });
});

describe('the nav ROW — offered to EVERY authenticated user', () => {
  const entry = ACCOUNT_SETTINGS_NAV.find((e) => e.id === 'gitAccounts');

  it('exists, in the security group', () => {
    expect(entry).toBeTruthy();
    expect(entry?.group).toBe('security');
    expect(entry?.href).toBe('/settings/account/git');
  });

  it('⚠️ carries NO gate of any kind — that is the point of this pane', () => {
    // The credential is the member's own. `accountSettingsNav.ts` records why the
    // registry has no access axis at all: "there is no role/permission to gate a
    // row on (every entry is always visible to its owner)". This asserts the
    // entry did not grow one.
    expect(entry).not.toHaveProperty('permission');
    expect(entry).not.toHaveProperty('access');
    expect(entry).not.toHaveProperty('cloudOnly');
  });

  it('sits THIRD in the group, by the rule the group already states', () => {
    const security = groupAccountSettingsNav(ACCOUNT_SETTINGS_NAV).find(
      (g) => g.group === 'security',
    );
    expect(security?.entries.map((e) => e.id)).toEqual(['twoFactor', 'apiTokens', 'gitAccounts']);
  });
});

describe('the INK — danger on a page surface', () => {
  it('`Disconnect` uses --el-danger-on-surface, never --el-danger-text', () => {
    // `--el-danger-text` is the ink FOR a danger FILL and measures 1.00–1.04:1
    // painted on a light page in all ten palettes. Raw `--el-danger` is the
    // subtler trap the sibling still carries: 4.11–4.25:1 on the DARK page in
    // three palettes. `--el-danger-on-surface` is ≥ 4.77:1 in all twenty
    // palette × theme combinations, which is why it is the token for ink that
    // could land on any surface.
    const { container } = renderWithIntl(<DisconnectAccountButton />);
    const button = container.querySelector('button');
    expect(button?.className).toContain('--el-danger-on-surface');
    expect(button?.className).not.toContain('(--el-danger-text)');
    expect(button?.className).not.toMatch(/text-\(--el-danger\)/);
  });

  it('renders the label from the catalogue, not a literal', () => {
    renderWithIntl(<DisconnectAccountButton />);
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy();
  });
});
