import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { encodeInstallState, type InstallState } from '@/lib/github/installState';
import { organizationRepoService } from '@/lib/services/organizationRepoService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { adminDb } from '../helpers/adminDb';

// Bug MOTIR-9828 — the App Setup URL's PROJECT-ROOM arm. A Repositories room's
// `Connect a new one` now mints a state that names the organisation, the room
// and the project. On return the handler must:
//
//   · run the org link AND link the round trip's repositories into that project
//     (`organizationRepoService.linkInstallReturnIntoProject`), for a first
//     install and for an update of an existing installation alike;
//   · hand it the moment the link was MINTED, read off the signed state, as the
//     line between "this round trip connected it" and "the org already had it";
//   · send the person back to the room they started from.
//
// A state with no project keeps the org branch exactly as it was. The service
// seams are spied: their own suites run them against Postgres, and this suite
// is about which one the handler calls and where it returns.

const SECRET = 'test-better-auth-secret-abcdef0123456789';
const USER_ID = 'usr_setup_project_room';
const ROOM = '/settings/project/repositories';

const session: { current: { user: { id: string } } | null } = { current: null };

vi.mock('@/lib/services/twoFactorPolicyService', async () =>
  (await import('../helpers/noTwoFactorPolicy')).noTwoFactorPolicy(),
);
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));

const { GET } = await import('@/app/api/github/setup/route');

let intoProject: ReturnType<typeof vi.spyOn>;
let orgOnly: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubEnv('BETTER_AUTH_SECRET', SECRET);
  session.current = { user: { id: USER_ID } };
  intoProject = vi
    .spyOn(organizationRepoService, 'linkInstallReturnIntoProject')
    .mockResolvedValue({ linked: [] });
  orgOnly = vi
    .spyOn(githubInstallationService, 'linkExistingInstallation')
    .mockResolvedValue(
      {} as Awaited<ReturnType<typeof githubInstallationService.linkExistingInstallation>>,
    );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const ROOM_STATE: InstallState = {
  workspaceId: 'ws_room',
  userId: USER_ID,
  organizationId: 'org_room',
  origin: 'projectRepositories',
  projectKey: 'MOTIR',
};

async function returnFrom(state: InstallState, setupAction: string, mintedAt?: number) {
  const token = encodeInstallState(state, mintedAt);
  const res = await GET(
    new NextRequest(
      `http://localhost:3000/api/github/setup?installation_id=144235820&setup_action=${setupAction}&state=${encodeURIComponent(token)}`,
    ),
  );
  return new URL(res.headers.get('location')!);
}

describe('a Repositories room round trip links into the project and returns to the room', () => {
  it.each(['update', 'install'])(
    'setup_action=%s → links the round trip’s repositories into the named project',
    async (action) => {
      const mintedAt = Math.floor(Date.now() / 1000) - 30;

      const location = await returnFrom(ROOM_STATE, action, mintedAt);

      expect(intoProject).toHaveBeenCalledWith({
        projectKey: 'MOTIR',
        organizationId: 'org_room',
        installationId: '144235820',
        since: new Date(mintedAt * 1000),
        ctx: { userId: USER_ID, workspaceId: 'ws_room' },
      });
      // The project call already runs the org link; it is not run twice.
      expect(orgOnly).not.toHaveBeenCalled();
      expect(location.pathname).toBe(ROOM);
      expect(location.searchParams.get('github')).toBe('installed');
    },
  );

  it('returns to the room, told it was refused, when the project is gone', async () => {
    intoProject.mockRejectedValue(new ProjectNotFoundError('MOTIR'));
    const location = await returnFrom(ROOM_STATE, 'update');
    expect(location.pathname).toBe(ROOM);
    expect(location.searchParams.get('github')).toBe('install_forbidden');
  });
});

describe('a state with no project keeps the org branch as it was', () => {
  it('“Install on another account” still links the organisation only', async () => {
    const location = await returnFrom(
      {
        workspaceId: 'ws_room',
        userId: USER_ID,
        organizationId: 'org_room',
        origin: 'organizationGit',
      },
      'install',
    );
    expect(orgOnly).toHaveBeenCalledOnce();
    expect(intoProject).not.toHaveBeenCalled();
    expect(location.pathname).toBe('/settings/organization/git');
  });

  it('ignores a project key that did not come from the room', async () => {
    await returnFrom({ ...ROOM_STATE, origin: 'organizationGit' }, 'install');
    expect(orgOnly).toHaveBeenCalledOnce();
    expect(intoProject).not.toHaveBeenCalled();
  });
});
