'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { FolderGit2, TriangleAlert } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { buttonVariants } from '@/components/ui/Button';
import { splitRoomSections } from '@/lib/projectRepos/roomSections';
import { TakeoverRow } from './TakeoverRow';
import type { SeedRefusalState } from './RowSeed';
import { TakeoverModal } from './TakeoverModal';
import { OrganizationRepositories } from './OrganizationRepositories';
import { AddRepositoryButton, AddRepositoryPicker } from './AddRepositoryPicker';
import type { OrgRepoOptionDto, OrgRepoProviderDto } from '@/lib/dto/organizationRepos';
import type {
  HostedRunRepoAccessMapDto,
  ProjectRepoDto,
  ProjectRepoRoomViewDto,
  ProjectRepoSeedRefusalDto,
} from '@/lib/dto/projectRepos';
import type { SeedRegistryEntryDto } from '@/lib/dto/seedRegistry';

// The TAKE-IT-OVER room's ROWS — the client island of
// `/settings/project/repositories` (Story MOTIR-1775 · MOTIR-1939).
//
// ⚠️ THE PAGE-STATE CONTRACT, ROUTED PER SURFACE (`CLAUDE.md`; design §14.10). A
// takeover changes surfaces that do NOT refresh the same way, and assuming
// `router.refresh()` covers all of them is the recurring bug:
//
//   1. THE ROW THAT WAS ACTED ON — the mutation's response IS the confirmation.
//      Its returned row is applied locally and deliberately NOT re-read; a
//      refresh here would re-read stale data and cause a visible revert.
//   2. THE HEADER SUMMARY + THE PAUSED BANNER — server-rendered from the room
//      read, so `router.refresh()` is what updates them. It is called after
//      every mutation for exactly that reason, and for nothing else.
//   3. THIS ISLAND — seeded from server props via `useState`, so
//      `router.refresh()` CANNOT reach it (the initializer runs once at mount).
//      It owns an explicit refetch, which is what `Check again` and the poll use.
//
// ⚠️ ROWS ARE INDEPENDENT (MOTIR-711: "taking over one row of three is
// legitimate and must not wedge the others"). `busyRowId` is a single row's id,
// never a set-level flag — one row's in-flight request leaves its siblings
// rendering and pressable.
//
// ⚠️ THE PAGE DRAWS THIS PROJECT'S LINKS, AND NOTHING THE ORGANISATION MERELY
// HAS (MOTIR-4954 · design §18). There are two sections and both are the
// project's own: the organisation-owned LINKS and the Motir-hosted ones. They are
// never merged into one list, because half its rows would carry a takeover that
// means nothing for them.
//
// ⚠️ WHAT WAS REMOVED, AND WHY IT IS NOT COMING BACK AS A SMALLER VERSION. This
// island used to hold a `connected` list — the repositories the LADDER
// (`lib/projectRepos/effectiveDomain.ts`) layers into the project's domain with no
// `project_repository` row — re-read it from `connectCandidates` on every refetch,
// and append it to the org section. On a project holding ONE link that rendered
// SEVEN rows, with `moooon-B-V/motir-core` drawn twice: once as its link carrying
// `Remove from this project`, once as a layered entry carrying nothing (§18.2,
// walked against the running app). Every control on the page — Add, Remove —
// operated on the link set while most of the rows were entries no control could
// touch.
//
// The layered list is not a smaller list to draw more carefully. It is the wrong
// QUESTION for this surface: the room asks *what does this project work on?* and
// the ladder answers *what can this project reach?*. The organisation's inventory
// is still reachable, at the two moments a person is choosing from it — the
// `Add repository` picker (§18.3 Panels 10–11) and the `See every repository in
// {org}` navigation block (§18.6).
//
// ⚠️ AND THE LADDER ITSELF IS UNTOUCHED. This card stops one PAGE from rendering
// the rung; `resolveEffectiveRepoDomain`, `targetRepo` validation and dispatch
// behave exactly as before. Retiring the rung is MOTIR-4955, which is a runtime
// change with a blast radius this one deliberately does not have.

/** How often an in-flight hand-off re-probes. `transfer_pending` and
 *  `awaiting_reinstall` resolve OUT OF BAND — a webhook, or an installation
 *  landing on GitHub — so neither is something a click on this page settles;
 *  the row is a polled async job, and this is that poll. Slow on purpose: the
 *  waits are measured in hours and days, and `Check again` is always there for a
 *  user who does not want to wait for the next tick. */
const POLL_MS = 20_000;

/** The takeover states that are still waiting on something to happen. */
const IN_FLIGHT = new Set(['requested', 'transfer_pending', 'awaiting_reinstall']);

/** The hosted section's accessible name — the two lists differ by NAME, not by
 *  order, which is the whole a11y content of drawing them apart (design §16.9). */
const HOSTED_HEADING_ID = 'project-repositories-hosted';

export interface RepositoriesRoomProps {
  projectKey: string;
  view: ProjectRepoRoomViewDto;
  /** Where the connect prompt hands off — the shipped 7.10 Git-settings pane. */
  connectHref: string;
  /**
   * Whether the actor administers the ORGANISATION (Story MOTIR-4669 ·
   * MOTIR-4681). Decides whether the room draws its add door or the sentence
   * that says who can — NOT whether an add succeeds, which
   * `organizationRepoService` asserts inside the transaction that performs it.
   * A gate on a button is a gate one caller away from being missing.
   */
  canAddRepositories: boolean;
  /** The organisation's display name, for the section heading and the picker. */
  organizationName: string;
  /**
   * This project's display name — the navigation block asks about it by name
   * ("Looking for a repository that is not linked to {projectName}?", §18.6).
   * The prompt only does its job if it names the boundary the reader just hit.
   */
  projectName: string;
  /** `See every repository in <org>` — the org's own inventory. */
  organizationInventoryHref: string;
  /** The request's `now`, stamped once on the server (see `TakeoverRow`). */
  nowIso: string;
  /**
   * Whether Motir's app can write each organisation repository, keyed by row id
   * (MOTIR-1895 · design §18.1). A PROP, read on every render and never copied
   * into state: `router.refresh()` re-renders it after an add or remove, and
   * after a return from GitHub (below) — a `useState` seed would ignore both.
   */
  hostedRunAccess?: HostedRunRepoAccessMapDto;
}

export function RepositoriesRoom({
  projectKey,
  view,
  connectHref,
  canAddRepositories,
  organizationName,
  projectName,
  organizationInventoryHref,
  nowIso,
  hostedRunAccess = {},
}: RepositoriesRoomProps) {
  const t = useTranslations('repositoryTakeover');
  // The inventory link keeps its own namespace: the STRING is the picker's
  // (`section.seeAll`, unchanged words per §18.5) even though its PLACE moved out
  // of the picker's section. Re-keying it would make the copy diff look like a
  // rewrite when only the placement changed.
  const tPicker = useTranslations('repositoryPicker');
  const router = useRouter();

  const [rows, setRows] = useState<ProjectRepoDto[]>(view.rows);
  const [busyRowId, setBusyRowId] = useState<string | null>(null);
  // Mirrors `busyRowId` for the poll to read without re-creating the interval on
  // every busy flip. Written from EVENT handlers only — never during render.
  const busyRef = useRef(false);
  // Mirrors `rows` for the refetch, which needs the CURRENT rows to split the
  // connected list against them and must not do that inside a state updater. Same
  // idiom (and same discipline) as `busyRef`: written from event handlers only.
  const rowsRef = useRef(view.rows);
  const [failed, setFailed] = useState(false);
  const [modalRow, setModalRow] = useState<ProjectRepoDto | null>(null);
  // A refused re-point per row (MOTIR-712, design MOTIR-705 §1.4) — shown under
  // that row's picker until its next pick, and never on a sibling.
  const [seedRefusals, setSeedRefusals] = useState<Record<string, SeedRefusalState>>({});
  // The PICKER's own state. Its list is fetched when the modal opens rather than
  // on every room render: it is an ORG-scoped read across workspaces, and a room
  // that never opens the picker should not pay for it.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [options, setOptions] = useState<OrgRepoOptionDto[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [optionsFailed, setOptionsFailed] = useState(false);

  const takeoverUrl = (rowId: string) =>
    `/api/projects/${encodeURIComponent(projectKey)}/repositories/${encodeURIComponent(rowId)}/takeover`;

  /** The ONE writer of the rows — keeps the mirror and the state in step. */
  const putRows = useCallback((next: ProjectRepoDto[]) => {
    rowsRef.current = next;
    setRows(next);
  }, []);

  /** Surface 1 — keep what the mutation returned. Never re-read it. */
  const applyRow = useCallback(
    (row: ProjectRepoDto) => {
      putRows(rowsRef.current.map((r) => (r.id === row.id ? row : r)));
    },
    [putRows],
  );

  /** The picker's list — the ORGANISATION's repositories this project does not
   *  hold. Fetched on OPEN, so a room nobody adds from pays nothing for it. */
  const loadOptions = useCallback(async () => {
    setOptionsLoading(true);
    setOptionsFailed(false);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectKey)}/repositories/available`,
        { cache: 'no-store' },
      );
      if (!res.ok) {
        setOptionsFailed(true);
        return;
      }
      setOptions((await res.json()) as OrgRepoOptionDto[]);
    } catch {
      setOptionsFailed(true);
    } finally {
      setOptionsLoading(false);
    }
  }, [projectKey]);

  const openPicker = useCallback(() => {
    setPickerOpen(true);
    void loadOptions();
  }, [loadOptions]);

  /**
   * PICK — link an organisation repository into this project.
   *
   * ⚠️ BOTH SURFACES OF THE PAGE-STATE CONTRACT, and the room's own comment says
   * getting this split wrong is the recurring bug. The new row is inserted into
   * THIS ISLAND optimistically (surface 3 — `router.refresh()` provably cannot
   * reach a `useState`-seeded list), and `router.refresh()` is called for the
   * server-rendered HEADER SUMMARY (surface 2), which counts over both registries
   * and would otherwise keep reporting the pre-add total beside a list that grew.
   */
  const onPick = useCallback(
    async (option: OrgRepoOptionDto) => {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectKey)}/repositories/add`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ githubRepoId: option.id, role: 'other' }),
      });
      if (!res.ok) {
        setFailed(true);
        return;
      }
      const row = (await res.json()) as ProjectRepoDto;
      putRows([...rowsRef.current, row]);
      setOptions((prev) => prev.filter((o) => o.id !== option.id));
      setPickerOpen(false);
      router.refresh();
    },
    [projectKey, putRows, router],
  );

  /** REMOVE FROM THIS PROJECT — one row, and nothing else. Same two surfaces. */
  const onRemoveFromProject = useCallback(
    async (row: ProjectRepoDto) => {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectKey)}/repositories/${encodeURIComponent(row.id)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        setFailed(true);
        return;
      }
      putRows(rowsRef.current.filter((r) => r.id !== row.id));
      router.refresh();
    },
    [projectKey, putRows, router],
  );

  /** Surface 3 — the island's own refetch. Silent: a background re-read must not
   *  flash the rows the user is looking at. */
  const refetch = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectKey)}/repositories`, {
        cache: 'no-store',
      });
      if (!res.ok) return;
      const body = (await res.json()) as { set?: { rows?: ProjectRepoDto[] } };
      const nextRows = body.set?.rows ?? null;
      if (nextRows) putRows(nextRows);
      // ⚠️ THE REST OF THE PAYLOAD IS DELIBERATELY UNREAD (MOTIR-4954). This
      // block used to rebuild a `connected` list out of `connectCandidates` and
      // append it to the org section, because that section held layered entries
      // the server render alone would leave stale on an island `router.refresh()`
      // cannot reach. The section holds LINKS now, `set.rows` is the whole of what
      // it draws, and `connectCandidates` is the PICKER's list — fetched when the
      // picker opens, which is the only moment anybody is choosing from it.
    } catch {
      // A failed background read leaves the rendered rows alone — they are the
      // last thing the server actually said, which beats an error banner over
      // state that is still correct.
    }
  }, [projectKey, putRows]);

  /**
   * The two writes, which are the same endpoint at two moments: naming a target
   * STARTS the saga; naming none re-probes whether the re-install has landed.
   * Re-running any step is a no-op (MOTIR-711), so the probe is always safe.
   */
  const call = useCallback(
    async (row: ProjectRepoDto, body: { newOwner?: string }) => {
      setBusyRowId(row.id);
      busyRef.current = true;
      setFailed(false);
      try {
        const res = await fetch(takeoverUrl(row.id), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          setFailed(true);
          // The row may still have MOVED (a refused transfer records `failed` on
          // it), so re-read rather than leaving the surface asserting a state the
          // server has since contradicted.
          await refetch();
          return;
        }
        const payload = (await res.json()) as ProjectRepoDto | { row: ProjectRepoDto };
        applyRow('row' in payload ? payload.row : payload);
        // Surface 2 — the server-rendered header summary + paused banner.
        router.refresh();
      } catch {
        setFailed(true);
      } finally {
        busyRef.current = false;
        setBusyRowId(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applyRow, refetch, router, projectKey],
  );

  const onConfirm = useCallback(
    (row: ProjectRepoDto, newOwner: string) => {
      setModalRow(null);
      void call(row, { newOwner });
    },
    [call],
  );

  const onCheckAgain = useCallback((row: ProjectRepoDto) => void call(row, {}), [call]);

  /**
   * RE-POINT a not-yet-created row's starter (MOTIR-712; design MOTIR-705 §1.3),
   * sent at once as the row's other edits are. The row the PATCH returns is
   * applied locally (surface 1), and `router.refresh()` re-reads the seeds — a
   * PROP of this island, so the refresh reaches it — for the new "why" and the
   * picker's list. A REFUSAL keeps the saved starter, shows the rule under the
   * picker and refreshes too: it means the library or the row changed after the
   * list loaded, so the list is stale (§1.4).
   */
  const onRepoint = useCallback(
    async (row: ProjectRepoDto, entry: SeedRegistryEntryDto) => {
      setBusyRowId(row.id);
      busyRef.current = true;
      setFailed(false);
      setSeedRefusals(({ [row.id]: _cleared, ...rest }) => rest);
      try {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(projectKey)}/repositories/${encodeURIComponent(row.id)}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ seedSource: entry.key }),
          },
        );
        if (res.ok) {
          applyRow((await res.json()) as ProjectRepoDto);
        } else {
          const body = (await res.json().catch(() => null)) as {
            code?: string;
            refusal?: ProjectRepoSeedRefusalDto;
            error?: string;
          } | null;
          if (body?.code !== 'PROJECT_REPO_SEED_REFUSED') {
            setFailed(true);
            return;
          }
          setSeedRefusals((prev) => ({
            ...prev,
            [row.id]: { refusal: body.refusal ?? null, picked: entry, message: body.error ?? '' },
          }));
        }
        router.refresh();
      } catch {
        setFailed(true);
      } finally {
        busyRef.current = false;
        setBusyRowId(null);
      }
    },
    [applyRow, projectKey, router],
  );

  // The poll. Keyed on WHETHER anything is in flight rather than on the rows
  // themselves, so a re-render that only changed copy does not restart the
  // interval; and it never ticks while a row is busy, so a user's own click and
  // the tick cannot race for the same row.
  //
  // ONE quiet re-read of the SET beats N per-row probes: the set read already
  // carries every row's fresh takeover state. `Check again` stays the per-row,
  // user-driven probe — the one that can also SETTLE `awaiting_reinstall`.
  const inFlight = rows.some((row) => row.takeover && IN_FLIGHT.has(row.takeover.state));

  useEffect(() => {
    if (!inFlight) return;
    const id = setInterval(() => {
      if (busyRef.current) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void refetch();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [inFlight, refetch]);

  // ⚠️ BACK FROM GITHUB, THE WARNING RE-READS ITSELF (MOTIR-1895 · design §18.2).
  // `Review permissions on GitHub` and `Reconnect` open GitHub in a new tab, and
  // accepting permissions there may never redirect back — so when this tab is
  // shown again while any line still warns, the server render is re-run and the
  // lines come back from `hostedRunWriteAccess` fresh. A just-accepted
  // installation then reads *ready* without a reload. Nothing warns, nothing to
  // re-ask: the listener is only attached while a warning is on screen.
  const hostedRunWarns = Object.values(hostedRunAccess).some((a) => a.state !== 'ready');
  useEffect(() => {
    if (!hostedRunWarns) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') router.refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [hostedRunWarns, router]);

  // ⚠️ ONE SPLIT, ONE PLACE (MOTIR-4681 · MOTIR-4820 · MOTIR-4954). `seedSource`
  // decides which set rows are Motir-hosted takeover rows and which are
  // organisation LINKS — a FACT the write records rather than a heuristic the
  // reader infers. It is now the ONLY thing the split consults: the ladder's
  // `connectedInDomain` and the `hostOwner` that classified the layered half both
  // left the signature with the half they were about.
  const { fromOrganization, motirHosted } = splitRoomSections(rows);

  // ⚠️ PANEL 10 — THE PICKER LISTS WHAT THIS PROJECT ALREADY HAS, UNPICKABLE.
  // `AddRepositoryPicker` has always rendered this, under a comment reading
  // "LISTED AND UNPICKABLE, never filtered out: a reader who came looking for it
  // should find it and see why it is not offered" — and it has always been fed
  // `alreadyHeld={[]}`, so the drawn behaviour has never once rendered. The
  // organisation's repositories are only reachable from a project context through
  // this dialog now, which is what makes the difference matter: a person opening
  // it to add the repository they are already looking at should be told that is
  // why it is not on offer, not left to conclude the list is broken.
  //
  // ⚠️ DERIVED FROM THE ROWS, NOT FETCHED. `/available` filters held repositories
  // OUT server-side (`organizationRepoService.listAvailableForProject`), and this
  // island already holds them: they are the org links it is rendering. Asking the
  // server for a list it defines by their absence would be a second read that can
  // disagree with the first — and it would put the answer one network round trip
  // behind the optimistic insert that `onPick` performs.
  //
  // A link with no `realizedRepo` is skipped: it names a repository that has not
  // been realized on the host yet, so it has no `github_repo` id to match the
  // picker's options on, and a row the picker cannot identify cannot be marked.
  const alreadyHeld: OrgRepoOptionDto[] = fromOrganization.flatMap((entry) => {
    const repo = entry.row.realizedRepo;
    if (!repo) return [];
    return [
      {
        id: repo.id,
        owner: repo.owner,
        name: repo.name,
        fullName: repo.repoRef,
        defaultBranch: repo.defaultBranch,
        provider: repo.provider as OrgRepoProviderDto,
        archived: repo.archived,
        connectedFromWorkspaceId: null,
        hostedByMotir: false,
      },
    ];
  });

  // ⚠️ THE WHOLE-ROOM EMPTY STATE IS FOR A READER WHO CANNOT ADD — nothing else.
  // The room's ordinary zero case is Panel 9: the sections render, the summary
  // reads `0 · 0 · 0`, and the add door is right there. That is a normal starting
  // condition — every project in the estate is in it today — and it belongs in the
  // page, not behind a signpost.
  //
  // ⚠️ IT NO LONGER CONSULTS A SECOND REGISTRY, AND ITS OLD REASON IS RETIRED
  // (MOTIR-4954). This condition used to guard against telling a project holding
  // five LAYERED repositories that it had none (MOTIR-3126). That project now
  // genuinely has none *of its own*, which is the true and useful thing to say —
  // the organisation's repositories are one block below under
  // `See every repository in {org}`, and inside the picker, and saying "you have
  // none linked" while offering both is not the false absence MOTIR-3126 fixed.
  //
  // ⚠️ AND IT STILL DOES NOT APPLY TO SOMEBODY WHO CAN ADD (MOTIR-4669 ·
  // MOTIR-4685). This is a SIGNPOST — a panel whose one action is a link to
  // another page — and `design/repository-set/design-notes.md` §17.4 forbids that
  // shape for exactly this moment: *"'Nothing to pick' must never render as a
  // message whose job is to send somebody to another page: that turns one intent
  // into two errands."* An actor who may add falls through to Panel 9, whose own
  // zero case is the picker. THE ACCEPTANCE WALK IS WHAT FOUND THAT (MOTIR-4685,
  // chapter 1), which is the whole argument for walking a story in a browser.
  if (fromOrganization.length === 0 && motirHosted.length === 0 && !canAddRepositories) {
    return (
      <EmptyState
        icon={<FolderGit2 className="h-12 w-12" aria-hidden />}
        title={t('title')}
        description={t('empty', { org: organizationName })}
        action={
          <Link href={connectHref} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
            {t('emptyAction')}
          </Link>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {failed ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-danger-surface) p-(--spacing-card-padding) text-sm text-(--el-danger-surface-text)"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0">{t('actionError')}</span>
        </p>
      ) : null}

      {/* FROM YOUR ORGANISATION (MOTIR-4681 · MOTIR-4820) — every repository this
          project has from the organisation: the ones somebody added, and the ones
          the LADDER layers into its domain. The room's ONE add door lives here.
          ⚠️ It renders when the project HOLDS one OR when the actor may add:
          without the second arm a project with nothing yet would have no way to
          get its first repository, which is the two-errands shape §17.4 forbids.
          ⚠️ The empty arm is now for a project with GENUINELY nothing. It used to
          fire for a set-less project holding seven layered repositories, which is
          an empty section asserting an absence that is false — the defect
          MOTIR-4820 fixed. */}
      {fromOrganization.length > 0 || canAddRepositories ? (
        <OrganizationRepositories
          entries={fromOrganization}
          organizationName={organizationName}
          canAdd={canAddRepositories}
          hostedRunAccess={hostedRunAccess}
          onRemove={onRemoveFromProject}
          addButton={<AddRepositoryButton onClick={openPicker} />}
        />
      ) : null}

      {/* THE MOTIR-HOSTED SET. Absent — not empty-stated — when the project has
          no rows: an empty section asserts an absence, and for a project whose
          repositories are all its own there is no such absence to assert.
          ⚠️ `motirHosted`, not `rows` (MOTIR-4681): a repository PICKED from the
          organisation has a set row too, and rendering it here would offer
          **Take it over** for something the organisation already owns. */}
      {motirHosted.length > 0 ? (
        <section aria-labelledby={HOSTED_HEADING_ID} className="flex flex-col gap-2">
          <SectionLabel id={HOSTED_HEADING_ID}>{t('hostedHeading')}</SectionLabel>
          <p className="max-w-prose font-sans text-sm text-(--el-text-secondary)">
            {t('hostedHint')}
          </p>
          <div className="flex flex-col gap-3">
            {motirHosted.map((row) => (
              <TakeoverRow
                key={row.id}
                row={row}
                githubLogin={view.githubLogin}
                installHref={view.installHref}
                nowIso={nowIso}
                busy={busyRowId === row.id}
                onMove={setModalRow}
                onCheckAgain={onCheckAgain}
                onRetry={setModalRow}
                seed={view.seeds[row.id]}
                seedRefusal={seedRefusals[row.id] ?? null}
                onRepoint={onRepoint}
              />
            ))}
          </div>
        </section>
      ) : null}

      {/* ⚠️ THE ORGANISATION INVENTORY, AS NAVIGATION — design §18.6, and the one
          element MOTIR-4954's card never named (amended onto it by the run).

          `See every repository in {org}` used to be a footnote in the org
          section's card footer, under the rows it was not about. It is now the
          ONLY route from a project context to the organisation's whole inventory,
          and a route is navigation: it sits AFTER both project sections, in its
          own landmark, with a prompt naming the boundary the reader has just hit.

          ⚠️ IT IS NOT AN ADD PATH, and the distinction is the point of drawing it
          separately. §18.6 lists what it is not: a way to add a repository (Panels
          10–11 own that), provenance for the rows above it, permission-recovery
          copy, or a disclosure that expands organisation rows back onto this page.
          The last of those is what this whole card removed, so a link that reads
          as "expand to see the rest" would undo it in one click.

          ⚠️ A `nav` WITH ITS OWN ACCESSIBLE NAME, not a bare paragraph. It is the
          third landmark on a page that already has two named sections, and a
          screen-reader user moving by landmark is exactly the reader who needs to
          find the route out without reading both lists first. */}
      <nav
        aria-label={t('inventoryNavLabel')}
        className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-(--el-border-soft) pt-4"
      >
        <p className="font-sans text-sm text-(--el-text-secondary)">
          {t('inventoryPrompt', { projectName })}
        </p>
        <Link
          href={organizationInventoryHref}
          className="font-sans text-sm font-medium text-(--el-link) hover:text-(--el-link-pressed)"
        >
          {tPicker('section.seeAll', { org: organizationName })}
        </Link>
      </nav>

      <AddRepositoryPicker
        options={options}
        alreadyHeld={alreadyHeld}
        projectName={projectName}
        organizationName={organizationName}
        installHref={view.installHref}
        loading={optionsLoading}
        error={optionsFailed}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onPick={onPick}
      />

      {modalRow ? (
        <TakeoverModal
          row={modalRow}
          githubLogin={view.githubLogin}
          connectHref={connectHref}
          busy={busyRowId === modalRow.id}
          onClose={() => setModalRow(null)}
          onConfirm={onConfirm}
        />
      ) : null}
    </div>
  );
}
