import { describe, expect, it } from 'vitest';
import { splitRoomSections, summarizeRepositories } from '@/lib/projectRepos/roomSections';
import { SEED_SOURCE_ORGANIZATION } from '@/lib/projectRepos/vocabulary';
import type { ProjectRepoDto, ProjectRepoTakeoverStateDto } from '@/lib/dto/projectRepos';

// THE ROOM'S SECTION SPLIT (MOTIR-3126) — pure, so it is ruled on here rather than
// through a render.
//
// The two functions are applied on BOTH sides of the wire (the server seeds the
// room with them; the client island re-applies them on every refetch), so what is
// asserted is the rule itself: which side of the split a repository falls on, and
// what the header's counts are over.

// ── ⚠️ WHAT MOTIR-4998 REMOVED FROM THIS FILE, AND WHY EACH WENT ─────────────
// Two `describe` blocks are gone, both because their SUBJECT is gone rather than
// because their assertions stopped being worth making. The functions they covered
// classified the LAYERED registry — the repositories the scope ladder supplied to
// a project holding no `project_repository` row — which MOTIR-4955 retired at the
// source (`effectiveDomain.ts` returns `connected: []`) and MOTIR-4954 stopped
// this page drawing. Neither had a production caller left.
//
//   - `describe('connectedNotInSet')` — five cases over a de-duplication of the
//     layered list against the set, keyed on the REALIZED repository name. It has
//     no successor and none is owed: there is no second list to de-duplicate
//     AGAINST any more, which is a stronger statement than the dedup was. The
//     name-preference rule it leaned on is `toProjectRepoNames`' own and is
//     covered where that function lives.
//
//   - `describe('a repository under the PROVISIONING organisation')` — four cases
//     over the MOTIR-4867 classification. ⚠️ THESE DID NOT LOSE THEIR PROPERTY,
//     THEY CHANGED ADDRESS. Three of them (the classification itself, its
//     case-insensitivity, and the `hostOwner: null` arm that classifies nothing on
//     a deployment which cannot provision) are properties of `isMotirHostedOwner`,
//     and they are asserted — as a captured comparison between the two surfaces
//     that still ask it — in `tests/projectRepos/hostOwnershipAgreement.test.ts`.
//     The fourth, reading the owner off a `repoRef` and degrading honestly on a
//     ref with no `/`, covered a private helper that parsed `owner/name` out of a
//     `ProjectRepoConnectedDto`; nothing constructs that shape any more, so that
//     case has no subject at either address and is not re-pointed.

// ⚠️ THE ORG SECTION IS THE LADDER'S ANSWER (bug MOTIR-4820).
//
// The rule under the defect, ruled on here because it is pure. The section used
// to be `rows.filter(seedSource === 'organization')`, which on a set-less project
// is EMPTY — while `/settings/organization/git`, moved onto the ladder by
// MOTIR-4802, reported every one of that project's connected repositories as
// `Used by <project>`. The two surfaces answered one question two ways, and each
// was internally consistent, which is why neither page's own tests could see it.
describe('splitRoomSections', () => {
  // ⚠️ RE-POINTED BY MOTIR-4954. These cases used to assert that a LAYERED
  // repository lands in the organisation section beside the links, that a
  // set-less project's section is therefore not empty, and that the ladder's own
  // boolean — never a count — decides whether layering happens at all. All three
  // were true of the merged shape and all three are now the opposite of the
  // product's contract: a project-scoped page draws the project's LINKS. So they
  // are re-pointed at the new rule rather than deleted, and each says what it now
  // holds.

  it('⚠️ NOW HOLDS THE INVERSE: a set-less project`s section is EMPTY, and that is the card', () => {
    // The exact fixture the old `⚠️ THE DEFECT` case used — Motir's own project
    // on the day MOTIR-4820 was filed: no repository SET, repositories connected
    // to the organisation. That card made the section draw all of them; this one
    // makes it draw none, because they are not this project's.
    //
    // ⚠️ AND THE CONNECTED LIST IS NOT AN ARGUMENT ANY MORE, which is the
    // strongest form this assertion can take: there is no parameter through which
    // an organisation repository could reach this page's rows.
    const { fromOrganization, motirHosted } = splitRoomSections([]);
    expect(fromOrganization).toEqual([]);
    expect(motirHosted).toEqual([]);
  });

  it('draws a LINK, and every entry it draws is one', () => {
    const { fromOrganization } = splitRoomSections([orgRow('picked')]);
    expect(fromOrganization.map((e) => e.kind)).toEqual(['link']);
    expect(fromOrganization.map((e) => e.id)).toEqual(['row-picked']);
  });

  it('keeps a Motir-HOSTED row out of the organisation section', () => {
    // `seedSource` still does this job, and now it is the ONLY job the split
    // consults: it says which set rows are links and which are rows Motir
    // created. A hosted row in the org section would lose its takeover, which is
    // the only action it has.
    const { fromOrganization, motirHosted } = splitRoomSections([
      row({ name: 'hosted' }),
      orgRow('picked'),
    ]);
    expect(motirHosted.map((r) => r.id)).toEqual(['row-hosted']);
    expect(fromOrganization.map((e) => e.id)).toEqual(['row-picked']);
  });

  it('the split over the SET is total — no row is lost and none is duplicated', () => {
    const rows = [row({ name: 'a' }), orgRow('b'), row({ name: 'c' })];
    const { fromOrganization, motirHosted } = splitRoomSections(rows);
    expect(fromOrganization.length + motirHosted.length).toBe(rows.length);
  });
});

describe('summarizeRepositories', () => {
  // ⚠️ RE-POINTED BY MOTIR-4954. The old first case asserted that a connected
  // repository counts as `yours` — "it is": the user owns it, Motir never bills
  // its CI, there is nothing to move. Every clause of that is still true about
  // the repository and the count was still wrong for this HEADER, which sits
  // above a list of the PROJECT's repositories. A number above a list must count
  // the things in that list.

  it('⚠️ NOW HOLDS THE INVERSE: an organisation repository this project has not added counts NOWHERE', () => {
    // §18.2's observed reading, as one assertion. The page reported
    // `0 moving · 0 hosted by Motir · 6 yours` on a project holding NO links —
    // six being the size of the organisation. It now reports three zeroes, which
    // is Panel 9's drawn state.
    expect(summarizeRepositories([])).toEqual({ moving: 0, hosted: 0, yours: 0 });
  });

  it('counts the three ownerships separately — they are legal at once', () => {
    const counts = summarizeRepositories([
      row({ name: 'hosted' }),
      row({ name: 'moving', takeover: 'transfer_pending' }),
      row({ name: 'taken', takeover: 'done' }),
      row({ name: 'brought', state: 'connected' }),
    ]);
    // One row moving must never make the whole project read as "moving".
    // `taken` and `brought` are both `yours` by §18.4: a completed takeover and
    // an organisation-owned link are the same answer to "who owns it now".
    expect(counts).toEqual({ moving: 1, hosted: 1, yours: 2 });
  });

  it('does not count a FAILED takeover as moving — a refused request is not in flight', () => {
    expect(summarizeRepositories([row({ name: 'x', takeover: 'failed' })])).toEqual({
      moving: 0,
      hosted: 1,
      yours: 0,
    });
  });

  it('⚠️ a completed takeover moves BUCKET without moving SECTION', () => {
    // §18.4's one genuinely surprising definition, and the reason the summary and
    // the split are asserted against ONE fixture here. The row counts as `yours`
    // — Motir no longer owns it or pays its CI — while it stays in the hosted
    // SECTION, where the takeover history and its finished state stay legible.
    // The section answers "where did this come from"; the count answers "who owns
    // it now". Reading either off the other is the bug this pins.
    const rows = [row({ name: 'taken', takeover: 'done' })];
    expect(summarizeRepositories(rows).yours).toBe(1);
    expect(splitRoomSections(rows).motirHosted.map((r) => r.id)).toEqual(['row-taken']);
    expect(splitRoomSections(rows).fromOrganization).toEqual([]);
  });
});

function row(opts: {
  name: string;
  realized?: string;
  state?: ProjectRepoDto['state'];
  takeover?: ProjectRepoTakeoverStateDto;
}): ProjectRepoDto {
  const realizedName = opts.realized ?? opts.name;
  return {
    id: `row-${opts.name}`,
    projectId: 'proj-1',
    role: 'web',
    label: null,
    name: opts.name,
    seedSource: 'platform-starter',
    state: opts.state ?? 'created',
    failureReason: null,
    proposalSignal: null,
    realizedRepo: {
      id: `gh-${realizedName}`,
      provider: 'github',
      owner: 'motir-projects',
      name: realizedName,
      repoRef: `motir-projects/${realizedName}`,
      defaultBranch: 'main',
      archived: false,
    },
    established: true,
    takeover: opts.takeover
      ? {
          state: opts.takeover,
          targetOwner: 'yue-personal',
          requestedAt: '2026-08-19T00:00:00.000Z',
          transferredAt: null,
          completedAt: null,
          failureReason: null,
        }
      : null,
    access: { state: 'accepted', login: 'yue-personal', invitationUrl: null },
    hostingTarget: null,
    hostingUseCase: null,
    hostingSize: null,
    position: 'a0',
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
  };
}

/** A set row that arrived through the picker — a LINK to an organisation
 *  repository, which is what `seedSource` records and all it records. */
function orgRow(name: string): ProjectRepoDto {
  return { ...row({ name }), seedSource: SEED_SOURCE_ORGANIZATION };
}
