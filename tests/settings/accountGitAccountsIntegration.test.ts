import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { githubIdentityService } from '@/lib/services/githubIdentityService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { encryptToken } from '@/lib/github/tokenCrypto';

// Settings → Account → Git accounts — THE STATE INPUTS (Story MOTIR-4669 ·
// MOTIR-4682), against a real Postgres.
//
// The pane's states are not a UI enum; each is a different ANSWER from two
// independent reads, and this file pins those answers. `accountGitAccounts.test.tsx`
// covers the rendering contract and the absences; this covers what the page is
// rendering FROM.
//
// ⚠️ WHAT IS NOT RE-ASSERTED HERE, deliberately. `tests/github/githubIdentityService.test.ts`
// already owns three of this card's acceptance criteria and asserts them against
// the same real database:
//
//   * "one user cannot read another's identity row" — its
//     "is RLS-isolated — the migration policy hides another member's row under the
//     app role" case;
//   * disconnect unbinds, and is idempotent;
//   * disconnect "removes only the acting member's identity, not another member's".
//
// A second copy of a covered claim is not a stronger guarantee — it is two places
// to update when the claim changes, and one of them will be missed.
//
// What that file does NOT cover, and this one adds, is the OTHER half of
// disconnect: that it leaves the ORGANISATION's installation standing. That is
// the two-grants-are-independent contract, and it is the half a future
// "tidy up on disconnect" would break.

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Bind an identity directly — the OAuth round trip is `githubIdentityService`'s
 *  own suite's subject, and stubbing GitHub again here would test its mock. */
async function bindIdentity(userId: string, login = 'yue') {
  return adminDb.githubIdentity.create({
    data: {
      userId,
      githubUserId: `gh-${userId}`,
      githubLogin: login,
      avatarUrl: null,
      accessTokenEncrypted: encryptToken('gho_test_token'),
    },
  });
}

/** The organisation's grant — a different tenant's row entirely. */
async function bindInstallation() {
  return githubInstallationService.persistInstallation({
    workspaceId: fx.workspaceId,
    installation: {
      installationId: `inst-${fx.workspaceId}`,
      accountLogin: 'moooon',
      accountType: 'Organization',
    },
    repos: [
      {
        providerRepoId: 'r-1',
        owner: 'moooon',
        name: 'motir-core',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
}

describe('the THREE states the substrate can answer', () => {
  it('NONE CONNECTED — no identity, and that is a valid state rather than an error', async () => {
    // The service says so on itself: "A null result is a valid state (an identity
    // with no installation, or no identity yet), NOT an error."
    expect(await githubIdentityService.getIdentityForUser(fx.ownerId)).toBeNull();
  });

  it('CONNECTED — the identity, token-free, with the date the pane prints', async () => {
    await bindIdentity(fx.ownerId);
    const identity = await githubIdentityService.getIdentityForUser(fx.ownerId);

    expect(identity?.githubLogin).toBe('yue');
    expect(identity?.createdAt).toBeTruthy();
    // ⚠️ The DTO carries NO token, and the pane could not leak one if it tried.
    expect(identity).not.toHaveProperty('accessToken');
    expect(identity).not.toHaveProperty('accessTokenEncrypted');
  });

  it('⚠️ CONNECTED, ORG HAS NO INSTALLATION — a complete, working state', async () => {
    // Asserted BY NAME because it is the arm an implementer would otherwise
    // improvise as an error. The two grants are INDEPENDENT — the shipped connect
    // page says so in as many words — so an identity with no installation is
    // VALID. Nothing is wrong and nothing is pending; connecting the organisation
    // is an org-admin act, and a member sent to do it is sent to a door that will
    // not open for them.
    await bindIdentity(fx.ownerId);

    const identity = await githubIdentityService.getIdentityForUser(fx.ownerId);
    const installation = await githubInstallationService.getWorkspaceInstallation({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
    });

    expect(identity).not.toBeNull();
    expect(installation).toBeNull();
  });

  it('…and the same reads answer the ORDINARY state, so the pair is a real discriminator', async () => {
    // The counterfactual. Without it, a page that always rendered the note would
    // pass the case above.
    await bindIdentity(fx.ownerId);
    await bindInstallation();

    const installation = await githubInstallationService.getWorkspaceInstallation({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
    });
    expect(installation).not.toBeNull();
  });
});

describe('DISCONNECT leaves the ORGANISATION`s installation untouched', () => {
  it('unbinds the identity and the installation stands', async () => {
    // The half `githubIdentityService`'s own suite does not assert, and the half a
    // future "tidy up on disconnect" would break. A member leaving is not an
    // organisation disconnecting: the App is uninstalled on GitHub, never here.
    await bindIdentity(fx.ownerId);
    await bindInstallation();

    await githubIdentityService.disconnect(fx.ownerId);

    expect(await githubIdentityService.getIdentityForUser(fx.ownerId)).toBeNull();
    const installation = await githubInstallationService.getWorkspaceInstallation({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
    });
    expect(installation).not.toBeNull();
    // …and the organisation's repositories with it.
    expect(await adminDb.githubRepo.count({ where: { workspaceId: fx.workspaceId } })).toBe(1);
  });

  it('and the reverse holds — removing the installation leaves the identity', async () => {
    // Independence is a property of a PAIR, so asserting it in one direction
    // only would leave the other free to grow a cascade.
    await bindIdentity(fx.ownerId);
    await bindInstallation();

    await githubInstallationService.removeInstallation(`inst-${fx.workspaceId}`);

    expect(await githubIdentityService.getIdentityForUser(fx.ownerId)).not.toBeNull();
  });
});
