'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight, ExternalLink, FolderGit2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { GithubMark } from '@/components/icons/GithubMark';
import { GitlabMark } from '@/components/icons/GitlabMark';
import type { OrgRepoInventoryRowDto } from '@/lib/dto/organizationRepos';

// THE ORGANISATION'S REPOSITORY INVENTORY (Story MOTIR-4669 · MOTIR-4680), built
// to `design/github/github.mock.html` Panel 6.
//
// ⚠️ `Used by N projects` IS A COLUMN, AT REST, AND IT IS THE DISCLOSURE
// MECHANISM. A warning inside a dialog is read past; a count that was on screen
// all along is not — and the dialog naming *Atlas, Beacon* is then a
// confirmation rather than a revelation. Both read the SAME list
// (`organizationRepoService.listRepositoryUsage`), so the row and the dialog
// cannot disagree, and the count is the LIST'S LENGTH rather than a separate
// number: an org member may not browse every project, and a count of four beside
// two names is the same leak arriving as a digit.
//
// ⚠️ AND IT COUNTS WHAT A PROJECT HAS CHOSEN, NOT WHAT IT MAY REACH
// (MOTIR-4821). The service briefly answered this from the scope ladder, which
// hands a project with no repositories of its own the whole connected registry —
// so every empty project was named against every repository, on the disclosure a
// DESTRUCTIVE act rests on. A warning that names people who were never affected
// is how a reader learns to click through warnings. The permissive default is
// still real and is still disclosed: ONCE, in the card foot and in the dialog,
// as a property of the organisation.
//
// ⚠️ A REPOSITORY USED BY ZERO PROJECTS IS AN ORDINARY ROW. It belongs to the
// organisation, stays in the inventory and stays indexed — dropping the graph
// when the last project unlinks would re-introduce per-project ownership through
// the back door and make the next project that adds it pay for a full re-index.
//
// ⚠️ THE INDEX COLUMN NOW HAS ALL FOUR STATES (MOTIR-4724). It shipped with two
// — `Indexed` / `Never indexed` — because the substrate could compute two, and
// the two missing arms were asserted ABSENT rather than faked: saying `Current`
// for a graph that might be months behind tells a person their index matches
// their code at the exact moment they are deciding whether to trust a plan built
// from it. MOTIR-4724 built the substrate; the tone map below is the design's.
// ⚠️ AND THE WORD IT REFUSED STAYED REFUSED (MOTIR-4817): the four-state column
// briefly promoted `indexed` to `Current`, which is the same overclaim one state
// narrower — see the pill below for why a null head makes it permanent.
//
// The state is DERIVED IN ONE PLACE (`lib/codeGraph/indexState.ts`) and this
// component only chooses a pill for it. A second comparison written here would be
// a second definition of "stale".
//
// ⚠️ THE ROW ACTION NAMES THE ACT, AND A SECOND LINE NAMES THE VENUE.
// `Disconnect` on both providers — the act is identical and only the venue
// differs. `Remove on GitHub` read as "delete the repository FROM GitHub", the
// one act Motir cannot perform and must never appear to offer.

export interface RepositoryInventoryProps {
  rows: OrgRepoInventoryRowDto[];
  organizationName: string;
  /** Whether the actor may disconnect. Reading the inventory is org MEMBERSHIP. */
  canDisconnect: boolean;
  /**
   * GitHub's removal happens on github.com; this is where it hands off, PER
   * REPOSITORY (MOTIR-8223): keyed by `repo.id`, each the installation settings
   * of the account that repository came through. One page-wide href was right
   * only while an organisation had one account, and was null once it had two.
   */
  manageOnGithubHrefs: Readonly<Record<string, string>>;
  /** Resolves once the repository is disconnected (GitLab only). */
  onDisconnect: (row: OrgRepoInventoryRowDto) => Promise<void>;
  retentionDays: number;
}

export function RepositoryInventory({
  rows,
  organizationName,
  canDisconnect,
  manageOnGithubHrefs,
  onDisconnect,
  retentionDays,
}: RepositoryInventoryProps) {
  const t = useTranslations('github.inventory');
  const td = useTranslations('github.orgDisconnect');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<OrgRepoInventoryRowDto | null>(null);
  const [busy, setBusy] = useState(false);

  const disconnect = async (row: OrgRepoInventoryRowDto) => {
    setBusy(true);
    try {
      await onDisconnect(row);
      setConfirming(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      header={
        <div className="flex flex-col gap-1">
          <h2 className="font-sans text-base font-semibold text-(--el-text)">{t('title')}</h2>
          <p className="font-sans text-sm text-(--el-text-muted)">{t('caption')}</p>
        </div>
      }
      footer={<p className="font-sans text-sm text-(--el-text-secondary)">{t('foot')}</p>}
    >
      {rows.length === 0 ? (
        <p className="font-sans text-sm text-(--el-text-secondary)">{t('empty')}</p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((row) => {
            const isOpen = expanded === row.repo.id;
            return (
              <li
                key={row.repo.id}
                className="flex flex-col gap-2 border-b border-(--el-border-soft) py-3 last:border-b-0"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <FolderGit2
                    className="h-[18px] w-[18px] shrink-0 text-(--el-icon-muted)"
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate font-sans text-sm">
                    {/* --el-text-secondary, not --el-text-muted: the row tints on
                        hover and muted fails AA on that surface. */}
                    <span className="text-(--el-text-secondary)">{row.repo.owner}/</span>
                    <span className="font-medium text-(--el-text)">{row.repo.name}</span>
                  </span>

                  <span className="flex shrink-0 items-center gap-1.5 font-sans text-xs text-(--el-text-secondary)">
                    {row.repo.provider === 'gitlab' ? (
                      <GitlabMark className="h-3.5 w-3.5" aria-hidden />
                    ) : (
                      <GithubMark className="h-3.5 w-3.5" aria-hidden />
                    )}
                    {t(`provider.${row.repo.provider}`)}
                  </span>

                  {/* The design's tones: Indexed mint · Stale peach · Indexing
                      sky · Never indexed the neutral chip.
                      ⚠️ `indexed` renders as `Indexed`, NOT `Current` (MOTIR-4817).
                      It read `Current` on the reasoning that the state now MEANS
                      "the graph matches the head, as last observed" — and that
                      holds only when BOTH shas are known. `deriveCodeGraphIndexState`
                      falls through to `indexed` when `defaultBranchHeadSha` is null,
                      and the ONLY writer of that column is the push webhook
                      (`githubWebhookService.ts`), so a repository nobody pushes never
                      acquires a head and would claim `Current` for ever — the quiet
                      repository, whose graph is likeliest to be an old snapshot. The
                      derivation's own header says `indexed` "never claims currency it
                      cannot support"; `Indexed` is the word that keeps that promise,
                      and `Stale` remains the signal that carries drift. */}
                  {row.indexState === 'indexing' ? (
                    <Pill severity="info">{t('index.indexing')}</Pill>
                  ) : row.indexState === 'stale' ? (
                    <Pill severity="warning">{t('index.stale')}</Pill>
                  ) : row.indexState === 'indexed' ? (
                    <Pill severity="success">{t('index.indexed')}</Pill>
                  ) : (
                    <Pill tone="neutral">{t('index.never')}</Pill>
                  )}

                  {row.projects.length === 0 ? (
                    // A LEGAL state, drawn as an ordinary row — not an empty
                    // state and not a warning.
                    <span className="shrink-0 font-sans text-sm text-(--el-text-secondary)">
                      {t('usedByNone')}
                    </span>
                  ) : (
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      onClick={() => setExpanded(isOpen ? null : row.repo.id)}
                      className="flex shrink-0 items-center gap-1 font-sans text-sm text-(--el-text-secondary) hover:text-(--el-text)"
                    >
                      {isOpen ? (
                        <ChevronDown className="h-4 w-4" aria-hidden />
                      ) : (
                        <ChevronRight className="h-4 w-4" aria-hidden />
                      )}
                      {t('usedBy', { count: row.projects.length })}
                    </button>
                  )}

                  {/* No row here is a repository Motir hosts (bug MOTIR-12192):
                      the service leaves them out of the inventory, so every row
                      is the organisation's own and its Disconnect keeps its
                      promise. The service still refuses a hosted one
                      (`MotirHostedRepoIsTakenOverError`) for a caller that never
                      rendered this page. */}
                  {canDisconnect ? (
                    <span className="flex shrink-0 flex-col items-end gap-0.5">
                      {row.repo.provider === 'gitlab' ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setConfirming(row)}
                          className="border border-(--el-border) text-(--el-danger-on-surface) hover:bg-(--el-danger-surface)"
                        >
                          {td('confirm')}
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setConfirming(row)}
                          className="border border-(--el-border) text-(--el-danger-on-surface) hover:bg-(--el-danger-surface)"
                        >
                          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                          {td('confirm')}
                        </Button>
                      )}
                      {/* The VENUE, under the button — never inside its label. */}
                      <span className="font-sans text-[11px] leading-tight text-(--el-text-secondary)">
                        {row.repo.provider === 'gitlab' ? td('happensHere') : td('happensOnGithub')}
                      </span>
                    </span>
                  ) : null}
                </div>

                {isOpen ? (
                  <div className="flex flex-wrap items-center gap-2 pl-8">
                    <span className="font-sans text-xs text-(--el-text-secondary)">
                      {t('usedByExpanded')}
                    </span>
                    {row.projects.map((project) => (
                      <span
                        key={project.id}
                        className="rounded-(--radius-badge) border border-(--el-chip-border) bg-(--el-chip-bg) px-(--spacing-chip-x) py-(--spacing-chip-y) font-sans text-xs text-(--el-text-secondary)"
                      >
                        {project.name}
                      </span>
                    ))}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <Modal
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title={
          confirming?.repo.provider === 'gitlab'
            ? td('gitlabTitle', { repo: confirming?.repo.fullName ?? '' })
            : td('title', { repo: confirming?.repo.fullName ?? '' })
        }
      >
        {/* ⚠️ `Modal.Body` (MOTIR-2491): the affected-project chips are as many
            as the organisation has projects using the repository — the count this
            dialog exists to disclose — so they scroll and the actions stay
            pinned. A dialog whose primary action is below the fold on exactly the
            repositories with the widest blast radius is the worst possible place
            for one. */}
        <Modal.Body className="gap-4">
          {/* ⚠️ FOR GITHUB THE DISCLOSURE COMES BEFORE THE LINK-OUT, because once
              the admin is on github.com there is no dialog left to show them.
              GitLab's removal is in-app, so it is an ordinary destructive
              confirm at the moment of the act. */}
          <p className="font-sans text-sm text-(--el-text-secondary)">
            {confirming?.repo.provider === 'gitlab'
              ? td('gitlabLead', { org: organizationName })
              : td('lead')}
          </p>
          <p className="font-sans text-sm text-(--el-text)">
            {td('projects', { count: confirming?.projects.length ?? 0 })}
          </p>
          {/* ⚠️ THE LIST IS COMPLETE, AND THIS LINE SAYS SO (MOTIR-4997).
              It used to widen the list: a project with no repositories of its own
              was said to reach this one anyway, through the scope ladder's first
              rung. MOTIR-4955 RETIRED that rung — the project link is the
              repository isolation boundary, and `resolveEffectiveRepoDomain`
              returns `layersConnected: false` with an empty `connected` — so a
              set-less project reaches nothing and the sentence became false on
              the one surface a DESTRUCTIVE act rests on.
              It is re-pointed rather than deleted: the dialogue still owes the
              reader a statement about who is affected, and `design/github/`
              settles what that is — `Used by N projects` is the disclosure, and
              this dialogue is "a confirmation rather than a revelation". Saying
              the named list is exhaustive is what makes it one. */}
          <p className="font-sans text-sm text-(--el-text-secondary)">{td('onlyLinked')}</p>
          {confirming && confirming.projects.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {confirming.projects.map((project) => (
                <span
                  key={project.id}
                  className="rounded-(--radius-badge) border border-(--el-chip-border) bg-(--el-chip-bg) px-(--spacing-chip-x) py-(--spacing-chip-y) font-sans text-xs text-(--el-text-secondary)"
                >
                  {project.name}
                </span>
              ))}
            </div>
          ) : null}
          {/* ⚠️ NOT A PERMANENCE WARNING. The window is real and re-adding inside
              it cancels the removal, so "this cannot be undone" would be FALSE —
              and false in the direction that teaches people to click through
              warnings. The number is INTERPOLATED, never retyped. */}
          <p className="font-sans text-sm text-(--el-text-secondary)">
            {td('codeIndex', { days: retentionDays })}
          </p>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(null)}>
              {td('cancel')}
            </Button>
            {confirming?.repo.provider === 'gitlab' ? (
              <Button
                type="button"
                variant="danger"
                size="sm"
                loading={busy}
                onClick={() => confirming && void disconnect(confirming)}
              >
                {td('confirm')}
              </Button>
            ) : confirming && manageOnGithubHrefs[confirming.repo.id] ? (
              <a
                href={manageOnGithubHrefs[confirming.repo.id]}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-(--radius-btn) bg-(--el-accent) px-(--spacing-btn-x) py-(--spacing-btn-y) font-sans text-sm font-medium text-(--el-accent-text)"
              >
                <ExternalLink className="h-4 w-4" aria-hidden />
                {td('continueOnGithub')}
              </a>
            ) : null}
          </div>
        </Modal.Body>
      </Modal>
    </Card>
  );
}
