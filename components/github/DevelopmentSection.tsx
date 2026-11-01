import type { ComponentType, ReactNode } from 'react';
import {
  CircleCheck,
  CircleDashed,
  CircleX,
  CircleQuestionMark,
  ExternalLink,
  FolderGit2,
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestClosed,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Pill, type PillProps } from '@/components/ui/Pill';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { EmptyState } from '@/components/ui/EmptyState';
import type { LinkedPullRequestDto, WorkItemDeliveryDto } from '@/lib/dto/github';
import { awaitingRepoRows, type RepoDelivery } from '@/lib/workItems/repoDelivery';
import type { HowToTestDto } from '@/lib/dto/howToTest';
import type { PullRequestApprovalMemberDTO } from '@/lib/dto/approvalGate';
import type { DesignRefusalFacts } from '@/components/approvals/RefusalReason';
import { HowToTestBlock } from '@/components/howToTest/HowToTestBlock';
import type { WorkItemRepairViewDto } from '@/lib/dto/workItemRepair';
import { classOfQueueExit } from '@/lib/mergeQueue/queueExit';
import { GithubMark } from '@/components/icons/GithubMark';
import { RepairFixPart, type SentBackBy } from './RepairFixPart';
import {
  DevelopmentGateFrame,
  type DevelopmentGateActions,
  type DevelopmentGateRead,
} from './DevelopmentGateFrame';
import { MergeOutcomeSlot, PersistedMergeOutcomes } from './MergeOutcomeSlot';
import { PreviewLine } from './PreviewLine';
import { DecisionDocumentSlot } from './DecisionDocumentSlot';
import type { DecisionDocumentViewDTO } from '@/lib/dto/decisionDocument';
import type { AgentReviewViewDto } from '@/lib/dto/agentReview';
import { CI_STATE_META } from './ciStateMeta';
import { QueueExitAutoPart, type AutoQueueExits } from './QueueExitAutoPart';

// The work-item "Development" section (Story 7.10 · MOTIR-1579), per
// design/github Panels 3 + 4a: linked-PR rows — PR glyph + title +
// `owner/repo · #n` meta + a PR-state Pill + a CI-state Pill + an external
// link-out — or the EmptyState when the item has no linked PR. Purely
// presentational: the DTO arrives display-ready (title fallback, merged
// collapse, per-PR CI, URL all resolved server-side). Two hosts, one body
// (`DevelopmentSectionBody`): the quick-view peek (SectionLabel header, this
// file's `DevelopmentSection`) and the detail page's ContentSectionCard
// (design Panel 5a — mounted in `app/(authed)/items/[key]/page.tsx`).
// Read-only on both; MOTIR-1596 adds the explicit-link affordance (design
// Panel 5) into the detail card's header.
//
// Pill tones ride the SHIPPED axes only (the design's tone table — no new
// token / variant): Open → status="in-progress" (sky) · Merged →
// status="done" (mint) · Closed → severity="danger" (rose) · CI passing /
// failing / running → severity success / danger / warning. Each pill carries
// its leading glyph + label, so state never rides colour alone (AA), and the
// deliberate mint+mint of a merged+passing row stays distinguishable by
// glyph (the #108 two-green lesson).

type PillTone = Pick<PillProps, 'status' | 'severity'>;

/** State → glyph + Pill tone (the design's tone table), shared by the linked-PR
 *  rows here AND the explicit-link picker's option pills (MOTIR-1596) so both
 *  read from ONE mapping — no new token/variant. */
export const PR_STATE_META: Record<
  LinkedPullRequestDto['state'],
  { icon: ComponentType<{ className?: string }>; pill: PillTone }
> = {
  open: { icon: GitPullRequestArrow, pill: { status: 'in-progress' } },
  merged: { icon: GitMerge, pill: { status: 'done' } },
  closed: { icon: GitPullRequestClosed, pill: { severity: 'danger' } },
};

// `CI_STATE_META` MOVED to `./ciStateMeta` (MOTIR-5474) — the board card, the
// `/items` rows and the Workbench row render the same verdict now, and a second
// map would be a second vocabulary for one fact. Imported at the top of this file;
// the pill below is unchanged.

/**
 * A pull request that MERGED, but onto a base that is not its repository's
 * default branch (Story MOTIR-3655 · MOTIR-3660, design `delivery-set.mock.html`
 * panel 3) — `null` when the row is fine or when nothing is known about it.
 *
 * It is the ONE new element the delivery-set design adds, and it exists because
 * such a row renders today EXACTLY like one that delivered: `Merged`, mint, done.
 * A merge onto a side branch delivered nothing to the trunk, `deliverySetShortfall`
 * counts it as a shortfall, and the reader had no way to see the difference
 * without opening the pull request.
 */
type StrandedBase = string | null;

/**
 * WHICH review chip a row shows, or `null` for none (Story MOTIR-4910 · MOTIR-5599; design
 * `design/github/design-notes.md` § 23, Panels G1–G3).
 *
 * ⚠️ A PURE RESOLVER, NOT A COMPONENT, and that is load-bearing: the row chooses between
 * this chip and the CI pill, and a component that renders `null` is still a truthy JSX
 * element — so `chip ?? ciPill` would silently never reach the CI pill. Answering with a KEY
 * makes the choice something the row can actually make.
 *
 * `null` means the row keeps its CI pill: absence of a countable review is not a state,
 * exactly as `ci: null` draws no pill.
 */
type GithubReviewChipKey = 'approved' | 'changesRequested' | 'earlierCommit';

export function githubReviewChipKey(
  review: LinkedPullRequestDto['githubReview'],
): GithubReviewChipKey | null {
  if (!review) return null;
  // ⚠️ A STALE CHANGES-REQUESTED IS NOT DRAWN, and that is a reported gap rather than an
  // invented chip: § 23 draws an EARLIER-COMMIT chip for an approval only, and its copy
  // says "Approved an earlier commit", which would be false here. It counts for nothing
  // either way, so the row falls back to its CI pill until the design answers it.
  if (!review.atCurrentHead) return review.state === 'approved' ? 'earlierCommit' : null;
  return review.state === 'changes_requested' ? 'changesRequested' : 'approved';
}

/**
 * The review chip itself.
 *
 * ⚠️ IT NAMES NEITHER THE HOST NOR A REVIEWER (Yue, design review 2026-09-17). The row is
 * already a GitHub pull request and the pill it replaces says *Checks passing*, not *Checks
 * passing on GitHub*; and a pull request can carry SEVERAL reviewers, so one login here
 * would be a claim the row cannot make. It says the STATE.
 */
function GithubReviewChip({ chipKey }: { chipKey: GithubReviewChipKey }) {
  const t = useTranslations('approvalGate.pullRequestApproval.github.chip');
  // The SHIPPED tone axes, no new variant: an approval is the same `success` the CI pill it
  // replaces uses, changes requested is `warning` (something is asked of you, nothing is
  // broken), and a stale approval is deliberately TONELESS — it counts for nothing, and a
  // colour would claim it does.
  const pill: PillTone =
    chipKey === 'approved'
      ? { severity: 'success' }
      : chipKey === 'changesRequested'
        ? { severity: 'warning' }
        : {};
  return (
    <Pill {...pill}>
      <GithubMark className="h-3 w-3" aria-hidden />
      {t(chipKey)}
    </Pill>
  );
}

/** *Conflicts with {base}* (MOTIR-5916; § 30's row pill). The `NoBase` form when the row
 *  never recorded its base branch — a guessed `main` would be wrong (§ 30's decision). */
function ConflictPill({ baseRef }: { baseRef: string | null }) {
  const t = useTranslations('approvalGate.pullRequestApproval');
  return (
    <Pill severity="danger" data-testid="pr-row-conflict">
      <CircleX className="h-3 w-3" aria-hidden />
      {baseRef ? t('row.conflicts', { base: baseRef }) : t('row.conflictsNoBase')}
    </Pill>
  );
}

function PullRequestRow({
  pr,
  strandedBase,
  action,
}: {
  pr: LinkedPullRequestDto;
  strandedBase: StrandedBase;
  /** The row's trailing WRITE affordance — the remove control (Story
   *  MOTIR-4878 · MOTIR-5005, design Panels 5d–5f), LAST in the row, after the
   *  link-out. Supplied by the HOST rather than built here: this component is
   *  shared with the read-only peek, which passes nothing and therefore draws no
   *  control at all — not a disabled one (design Q1 / Q4). It is a `ReactNode`
   *  rather than a flag because the control is a client component owned by the
   *  detail page's route folder, and this file may not reach into it. */
  action?: ReactNode;
}) {
  const t = useTranslations('github');
  const state = PR_STATE_META[pr.state];
  const ci = pr.ci ? CI_STATE_META[pr.ci] : null;
  const chipKey = githubReviewChipKey(pr.githubReview);
  const StateGlyph = state.icon;
  const PrPillGlyph = state.icon;
  return (
    <li className="mt-2 flex items-center gap-2.5 gap-y-1 rounded-(--radius-control) border border-(--el-border) bg-(--el-surface) px-(--spacing-control-x) py-(--spacing-control-y) @max-[30rem]:flex-wrap">
      <StateGlyph className="h-[17px] w-[17px] shrink-0 text-(--el-icon-muted)" aria-hidden />
      <div className="min-w-0 flex-1 py-1">
        <div className="truncate font-sans text-[13.5px] font-medium text-(--el-text)">
          {pr.title}
        </div>
        <div className="truncate font-sans text-xs text-(--el-text-identifier)">
          {pr.repo} · #{pr.number}
          {strandedBase !== null ? (
            // The branch that swallowed the merge, NAMED — so the reader learns
            // where the work went without opening the pull request. Beside the
            // pill rather than instead of it: the pill says something is wrong,
            // this says what.
            <>
              {' · '}
              {t('development.intoBase', { base: strandedBase })}
            </>
          ) : null}
          {/* ⚠️ THE "linked manually" SUFFIX WAS HERE, and it is deleted by
              MOTIR-4894 rather than reworded. It was a CONTRAST — design Panel
              5a specified it to distinguish a link a person declared from one
              the MOTIR-892 auto-resolver inferred from a branch or title — and
              MOTIR-3674 deleted the inferring half. `resolveChangeRequestWorkItemSet`
              has two arms, a session branch and a stored delivery, and both are
              declared, so every row on this surface qualified for the suffix and
              it distinguished nothing. Worse, it fired on the ordinary case: a
              run links its own pull request over `link_pull_request`, so the
              label said "manually" about a coding agent. A reader who wants
              provenance back needs a fact this row does not have — WHO declared
              the link — and that is a new field, not this one. */}
        </div>
        {/* The PREVIEW (MOTIR-10099; design/github § 31): the text column's THIRD
            child — nothing when this pull request has no preview. */}
        <PreviewLine preview={pr.preview} />
      </div>
      {/* NARROW (MOTIR-5351, Panel 12n): below a 30rem column the pill group drops to
          its own line under the title, so the title keeps the first line instead
          of one or two characters. Indented 27px — the 17px glyph plus the row gap. */}
      <span className="flex shrink-0 items-center gap-1.5 @max-[30rem]:order-last @max-[30rem]:basis-full @max-[30rem]:flex-wrap @max-[30rem]:pb-1 @max-[30rem]:pl-[27px]">
        <Pill {...state.pill}>
          <PrPillGlyph className="h-3 w-3" aria-hidden />
          {t(`development.prState.${pr.state}`)}
        </Pill>
        {strandedBase !== null ? (
          // BESIDE `Merged`, never replacing it — both facts are true and the
          // reader needs both: it did merge, and it did not reach the trunk.
          <Pill severity="warning">
            <CircleQuestionMark className="h-3 w-3" aria-hidden />
            {t('development.notOnTrunk')}
          </Pill>
        ) : null}
        {/* The SECOND pill slot (MOTIR-5484, §20): the CI pill, until an approve-and-merge
            press has something to say about this pull request. */}
        <MergeOutcomeSlot repo={pr.repo} number={pr.number} merged={pr.state === 'merged'}>
          {/* THE REVIEW CHIP REPLACES THE CI PILL, IT DOES NOT SIT BESIDE IT (Story
              MOTIR-4910 · MOTIR-5599; design § 23, Panels G1–G3) — the same rule
              `MergeOutcomeSlot` states for an outcome, and for the same reason: the gate
              is raised only on an all-green set, so on a row carrying a review *Checks
              passing* has nothing left to say.

              ⚠️ IT NAMES NEITHER THE HOST NOR A REVIEWER (Yue, design review
              2026-09-17). The row is already a GitHub pull request and the pill beside it
              says *Checks passing*, not *Checks passing on GitHub*; and a pull request can
              carry SEVERAL reviewers, so one login here is a claim the row cannot make. */}
          {/* A CONFLICT TAKES THE SLOT (MOTIR-5916; design/github § 30 Panels 1–2): the host
              reports this member cannot combine with its base, so *Checks passing* — true, and
              beside the point — gives way to what the reader must act on. Only the conflicted
              row carries it; the others keep their own pills. The tone and glyph are § 28's
              *Cannot be merged*, which is the same class. */}
          {pr.conflicted ? (
            <ConflictPill baseRef={pr.baseRef} />
          ) : chipKey ? (
            <GithubReviewChip chipKey={chipKey} />
          ) : ci ? (
            <Pill {...ci.pill}>
              <ci.icon className="h-3 w-3" aria-hidden />
              {t(`development.ciState.${pr.ci!}`)}
            </Pill>
          ) : null}
        </MergeOutcomeSlot>
      </span>
      {/* aria-label, NOT an sr-only span (the shipped icon-only convention —
          RemoveLinkButton / QuickViewCloseButton): an sr-only span is
          position:absolute, and with no positioned ancestor it escapes the
          shell's overflow container and stretches the ROOT scroller — the
          "empty space past the bottom of the page" bug. */}
      <a
        href={pr.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t('development.openOnGithub')}
        className="shrink-0 rounded-(--radius-control) p-(--spacing-control-x-4) text-(--el-icon-muted) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none @max-[30rem]:order-2"
      >
        <ExternalLink className="h-4 w-4" aria-hidden />
      </a>
      {action}
    </li>
  );
}

/**
 * A repository the item CARRIES that has no pull request to show (Story
 * MOTIR-2725 · MOTIR-2415, design `repository-set.mock.html` panel 1) — the ONE
 * element that design adds, and the state the completion gate holds an item for.
 *
 * The shipped section has nothing to render for it today: it lists the pull
 * requests that exist, and the whole point of the repository SET is that a
 * repository whose PR was never opened is invisible to anything that counts
 * rows. So the row is drawn from the EXPECTED side instead.
 *
 * Deliberately the same row grammar as a real pull request — same height, same
 * columns, same pill slot — with a DASHED border and a soft fill, so it reads as
 * a placeholder in the list rather than as a different kind of thing. It carries
 * no link-out, because there is nothing to link to; the spacer keeps the pill
 * column aligned with the rows above it.
 */
function AwaitingRepoRow({ delivery }: { delivery: RepoDelivery }) {
  const t = useTranslations('github');
  // SIX states, five of which reach this row (design MOTIR-3038 panel 2c;
  // `delivered` has a real pull-request row of its own). Each says something
  // different about what the reader should do next, so each gets its own copy
  // and its own glyph — a state that only differed in shade would be the false
  // "No pull request yet" row MOTIR-3036 fixed, wearing a new costume.
  const { state } = delivery;
  const unknown = state === 'unknown';
  // `delivered_without_change_request` (MOTIR-7180) reaches it too: there is no
  // pull request to draw, and its own copy says the work finished without one
  // rather than leaving the row to read "No pull request yet". So does
  // `delivered_by_child` (MOTIR-8811): the merge is linked to a CHILD card, so
  // this item has no row of its own for it, and the copy says where it landed.
  const Glyph =
    state === 'unknown'
      ? CircleQuestionMark
      : state === 'unestablished'
        ? FolderGit2
        : state === 'delivered_without_change_request' || state === 'delivered_by_child'
          ? CircleCheck
          : CircleDashed;
  const title =
    state === 'unknown'
      ? 'development.mergedBranchUnknown'
      : state === 'unestablished'
        ? 'development.repositoryNotCreated'
        : state === 'excluded'
          ? 'development.repositorySkipped'
          : state === 'delivered_without_change_request'
            ? 'development.shippedWithoutPullRequest'
            : state === 'delivered_by_child'
              ? 'development.deliveredByChildPullRequest'
              : 'development.noPullRequestYet';
  const pillKey = `development.repoState.${state}` as const;
  return (
    <li className="mt-2 flex items-center gap-2.5 rounded-(--radius-control) border border-dashed border-(--el-border) bg-(--el-surface-soft) px-(--spacing-control-x) py-(--spacing-control-y)">
      <Glyph className="h-[17px] w-[17px] shrink-0 text-(--el-icon-muted)" aria-hidden />
      <div className="min-w-0 flex-1 py-1">
        {/* `--el-text-secondary`, NOT `--el-text-muted`: this row's fill is
            `--el-surface-soft`, where muted measures 4.34:1 and fails AA — it
            clears only on the white page/card, by 0.04 (`CLAUDE.md`'s contrast
            table; `tests/theme/inkContrastLint.test.ts` enforces the pair).
            Secondary is 6.51:1 on the same fill and still reads as quieter than
            a real pull-request title beside it. */}
        <div className="truncate font-sans text-[13.5px] font-medium text-(--el-text-secondary)">
          {t(title)}
        </div>
        <div className="truncate font-sans text-xs text-(--el-text-identifier)">
          {delivery.repo}
        </div>
      </div>
      <span className="flex shrink-0 items-center gap-1.5">
        <Pill
          {...(unknown || state === 'unestablished'
            ? { severity: 'warning' as const }
            : { tone: 'neutral' as const })}
        >
          <Glyph className="h-3 w-3" aria-hidden />
          {t(pillKey)}
        </Pill>
      </span>
      {/* Keeps the pill column aligned with the linked rows, which end in a
          link-out button. An awaiting repository has nothing to link to. */}
      <span className="w-6 shrink-0" aria-hidden />
    </li>
  );
}

/** One row the section draws: the pull request, plus what its delivery knows. */
interface PullRequestRowModel {
  repo: string;
  number: number;
  pr: LinkedPullRequestDto;
  strandedBase: StrandedBase;
}

/**
 * MERGE the two sources of "which pull requests deliver this card" into the rows
 * the section draws (MOTIR-3660) — see the `deliveries` prop's note for why there
 * are two and why neither is dropped.
 *
 * Exported so a test can assert the merge over lists rather than over rendered
 * markup: the interesting cases here are ordering and identity, and asserting
 * those through the DOM measures the DOM.
 *
 * - Identity is `owner/name#number`, CASE-INSENSITIVELY on the repository half.
 *   A git host treats repository names case-insensitively and the two sides are
 *   written by different tables, so a case difference is the same pull request
 *   and must not become two rows.
 * - `pullRequests` keeps its order and comes first, because that is the order
 *   this section has always drawn and nothing here is a reason to change it.
 * - A pull request in BOTH keeps the `pullRequests` DTO — they are the same row
 *   read twice — and gains the delivery's base facts, which the DTO has not got.
 */
export function mergePullRequestRows(
  pullRequests: readonly LinkedPullRequestDto[],
  deliveries: readonly WorkItemDeliveryDto[],
): PullRequestRowModel[] {
  const identity = (repo: string, number: number): string => `${repo.toLowerCase()}#${number}`;
  // A pull request is STRANDED when it merged onto a base that is not its
  // repository's trunk. A null base is NOT stranded — it is unknown, and the
  // rail's glyph is where that question is asked; claiming "not on trunk" about
  // a merge nobody recorded a base for would assert something false.
  const strandedOf = (d: WorkItemDeliveryDto): StrandedBase =>
    d.pullRequest.state === 'merged' && d.baseRef !== null && d.baseRef !== d.defaultBranch
      ? d.baseRef
      : null;

  const byIdentity = new Map<string, WorkItemDeliveryDto>();
  for (const d of deliveries) {
    byIdentity.set(identity(d.pullRequest.repo, d.pullRequest.number), d);
  }

  const rows: PullRequestRowModel[] = [];
  const drawn = new Set<string>();
  for (const pr of pullRequests) {
    const key = identity(pr.repo, pr.number);
    if (drawn.has(key)) continue;
    drawn.add(key);
    const delivery = byIdentity.get(key);
    rows.push({
      repo: pr.repo,
      number: pr.number,
      pr,
      strandedBase: delivery === undefined ? null : strandedOf(delivery),
    });
  }
  for (const d of deliveries) {
    const key = identity(d.pullRequest.repo, d.pullRequest.number);
    if (drawn.has(key)) continue;
    drawn.add(key);
    rows.push({
      repo: d.pullRequest.repo,
      number: d.pullRequest.number,
      pr: d.pullRequest,
      strandedBase: strandedOf(d),
    });
  }
  return rows;
}

/** The section's BODY — rows or EmptyState + the auto-link caption. Shared by
 *  both hosts; the host supplies its own header (SectionLabel on the peek, the
 *  ContentSectionCard title on the detail page). */
export function DevelopmentSectionBody({
  pullRequests,
  itemIdentifier,
  manualLinkable = false,
  rowAction,
  repoDelivery = [],
  deliveries = [],
  howToTest = null,
  mergeGate = null,
  gateActions,
  gateLayout = 'flush',
  onShowCurrentVersion,
  gateKey,
  gateNotice,
  gateVerbsDisabled = false,
  handOver,
  canReplan,
  designRefusal,
  cardTerminal = false,
  designResult = null,
  repair = null,
  continuePart = null,
  autoQueueExits = null,
  decision = null,
  agentReview = null,
  repairHostedDoor,
  repairMyAgentDoor,
}: {
  pullRequests: LinkedPullRequestDto[];
  /** The item's `MOTIR-<n>` key — the empty-state / caption copy names it. */
  itemIdentifier: string;
  /** True on the detail-page host, where the "+ Link pull request" affordance
   *  lives — the caption then adds "— or linked by hand from here" (design Panel
   *  5a). The read-only peek leaves it false (its caption names only auto-link). */
  manualLinkable?: boolean;
  /**
   * The trailing WRITE affordance for ONE linked-PR row (Story MOTIR-4878 ·
   * MOTIR-5005) — called per row, its result rendered last in that row.
   *
   * Omitted by the read-only peek, which is the whole of design Q1: the peek's
   * shipped contract is *"Read-only — editing lives on the full page"*, so it
   * draws no control rather than a disabled one. The detail page passes the
   * remove control, itself gated on `work_item:edit` by its host.
   */
  rowAction?: (pr: LinkedPullRequestDto) => ReactNode;
  /**
   * EVERY repository the item carries, with its delivery state (Story MOTIR-2725
   * · MOTIR-2415) — the item's own set, passed VERBATIM. The rows that get drawn
   * for it are derived here, by `awaitingRepoRows`.
   *
   * ⚠️ The host does NOT pre-filter this (MOTIR-3036). Both hosts used to hand
   * over `delivery.filter((d) => d.state !== 'delivered')`, and two copies of one
   * editorial decision is how the detail page and the quick view came to disagree
   * — and how they both came to say "No pull request yet" about a repository
   * whose pull request was on the row above. A host that supplies the set and
   * decides nothing cannot drift from the other host.
   *
   * Still defaulted to `[]`, which is the state most cards are in: an item that
   * carries no repositories renders exactly the shipped section.
   */
  repoDelivery?: RepoDelivery[];
  /**
   * The card's DELIVERY SET (Story MOTIR-3655 · MOTIR-3660) — every pull request
   * recorded as delivering this card, with the two facts a pull-request row
   * cannot carry on its own: the base it targets and its repository's trunk.
   *
   * ⚠️ IT IS UNIONED WITH `pullRequests`, NOT SUBSTITUTED FOR IT, and that is a
   * statement about the EXPAND window rather than a preference. Two writers still
   * set the singular `github_pull_request.work_item_id`: the explicit link arms —
   * which dual-write a delivery row (MOTIR-3658) — and
   * `historicalPullRequestBackfillService`, which resolves a card by parsing the
   * title and does NOT. So neither source is complete on its own today: the table
   * holds rows the column structurally cannot (a `motir auto` pull request
   * delivering twelve cards), and the column holds rows the table has not been
   * told about. A surface that picked one would silently drop the other's, and a
   * dropped row is strictly worse than a duplicated one — so they are merged, on
   * `owner/name#number`, and the pull request appears exactly once.
   *
   * The union collapses to one source when MOTIR-3672 retires the title parse.
   */
  deliveries?: WorkItemDeliveryDto[];
  /**
   * The run's HOW TO TEST (Story MOTIR-4906 · MOTIR-5336, design §20) — rendered
   * BELOW the rows, inside this same card, never as a section of its own. It is
   * the approve-to-merge gate's evidence. Omitted by the read-only peek, whose
   * contract keeps its rows only.
   */
  howToTest?: HowToTestDto | null;
  /**
   * The card's approve-and-merge gate read (`pull_request_approval`), in ANY state.
   * The rows plus How to test become the PORT of ONE `ApprovalGateControl` —
   * Panel 12c, and Panels 12p–12w once it is pressed or withdrawn (MOTIR-5484).
   * NO GATE ⇒ NO FRAME: null renders exactly the block.
   */
  mergeGate?: DevelopmentGateRead | null;
  /**
   * The item page's server actions for that frame's verbs (MOTIR-5484). Omitted, the
   * frame draws no verbs — which is every host but the detail page.
   */
  gateActions?: DevelopmentGateActions;
  /**
   * WHICH BOX that frame sits in (Story MOTIR-5437 · Subtask MOTIR-5440) — passed
   * straight to `DevelopmentGateFrame`. `flush` (the default) is the item page's
   * section card; `fill` is the approval overlay, where the viewport is the box.
   * The BLOCK is identical either way, which is the point: the overlay composes
   * this component rather than drawing a second one.
   */
  gateLayout?: 'flush' | 'fill';
  /** The frame's *Show the current version* re-read, from a host that owns its read — the
   *  approval overlay (MOTIR-5235). Omitted, the frame re-reads the page. */
  onShowCurrentVersion?: () => void;
  /** Which of that host's re-reads is on screen — the frame remounts on a new one. */
  gateKey?: number;
  /** A HOST's notice for the frame's alert band, and whether it disables the verbs — the
   *  overlay's live withdrawal (MOTIR-5917, § 30 Panel 4a). Passed straight to the frame. */
  gateNotice?: ReactNode;
  gateVerbsDisabled?: boolean;
  /**
   * THE ITEM PAGE HANDS THE DECISION OVER (Bug MOTIR-6323) — passed straight to the frame.
   * An awaiting gate this reader may decide draws the block unframed, closed by the
   * call-to-action band into the approval overlay. The overlay and the peek omit it.
   */
  handOver?: { routedToViewer: boolean };
  /**
   * THE RE-PLAN WITH AI DOOR (Story MOTIR-6068 · MOTIR-6211) — passed straight to the frame:
   * whether this reader may open the planner on the card (`WorkItemPlanEntrance`'s
   * condition). Omitted, a decision sent back offers no door.
   */
  canReplan?: boolean;
  /**
   * A DESIGN SENT BACK IS A VERDICT (Story MOTIR-6070 · MOTIR-6427) — passed straight to the
   * frame: where a design's Re-plan opens (the card's parent) and the status either verdict
   * returns it to. Only the approval overlay passes it; a design-led frame without it still
   * asks for the verdict, naming the card itself and no status.
   */
  designRefusal?: DesignRefusalFacts;
  /**
   * The card sits in a DONE-category status (Bug MOTIR-5884; § 29's cite table). A
   * withdrawn merge question on such a card is never asked again, so its cite promises
   * nothing. Omitted — every host but the item page — the frame reads the card as live.
   */
  cardTerminal?: boolean;
  /**
   * The card's DESIGN RESULT, rendered by the host as the Development block's
   * slot (Story MOTIR-5488 · MOTIR-5498; `design-result.md` AMENDMENT 4 Q8,
   * design `design-result--what-to-review.mock.html` states 7–8). Supplied only
   * for a card whose open linked pull requests carry the design's decision.
   *
   * ⚠️ IT REORDERS THE BLOCK: the slot first, then How to test, then every row
   * and the caption behind a soft rule — what to review and how to test it lead,
   * the pull requests the approval merges follow. It renders ONCE however many
   * pull requests the card links. Without it the block is exactly §20's: rows,
   * caption, How to test. A `ReactNode` rather than the evidence because the
   * panel lives in the item page's route folder and owns its own probes.
   */
  designResult?: ReactNode;
  /**
   * The FIX PART (Story MOTIR-5460 · MOTIR-5466, design § 21) — the copyable
   * `motir fix`, a repair in progress, a repair that gave up, or a child's
   * pointer to its run target. Drawn below the rows' caption and above How to
   * test. Omitted (the peek) or `hidden`, it renders nothing.
   */
  repair?: WorkItemRepairViewDto | null;
  /**
   * The CONTINUE PART (Story MOTIR-6526 · MOTIR-6534, design `design/runs` § Run
   * died) — a run that died, the copyable `motir continue`, or who is continuing.
   * A sibling of the fix part, drawn in the same place: below the rows' caption
   * (or the EmptyState, when the card has no pull request) and above How to test.
   * The host builds it; the peek omits it.
   */
  continuePart?: ReactNode;
  /**
   * The standing merge-queue exits of a card with NO approval gate — an `auto` project
   * (Story MOTIR-5461 · MOTIR-5635, design § 22 E5). Drawn as a flush *Merge queue* part
   * below the rows, and read by the rows' outcome slot. Ignored when a gate frame is
   * drawn: under a gate the frame reads the exits itself.
   */
  autoQueueExits?: AutoQueueExits | null;
  /**
   * THE DECISION PORT (Story MOTIR-4907 · Subtask MOTIR-5678; design `design/github`
   * §27) — supplied only for a card that asks the decision question and holds a decision
   * gate. The document leads the block, the pull requests follow behind the soft rule,
   * and ⚠️ there is NO How to test, in any state: a decision ships a document, not
   * something to run (§27, *Revised on review*). `gate` is the card's decision gate —
   * read so that, when the merge question leads (Panel 5b), the slot can say the decision
   * stands.
   */
  decision?: {
    document: DecisionDocumentViewDTO | null;
    gate: DevelopmentGateRead['gate'] | null;
  } | null;
  /**
   * THE RUN TARGET'S LATEST AGENT REVIEW (Story MOTIR-1626 · MOTIR-6825; design
   * `design/github` § 30) — passed straight to the frame, which draws its states when it
   * leads and its pass or override above the approve-and-merge gate. The item page passes
   * it, and so does the approval overlay for an `agent_review` it opens on; omitted, the
   * frame is as it was.
   */
  agentReview?: AgentReviewViewDto | null;
  /**
   * THE HOSTED REPAIR DOOR (MOTIR-6930; design § 30 Panels 3–3e): *Fix on the hosted
   * agent*, drawn in the fix part beside the copyable `motir fix <KEY>` for a card a review
   * sent back. The item page passes it for a viewer who may run the card hosted; every other
   * host omits it, and the part draws the command alone.
   */
  repairHostedDoor?: ReactNode;
  /** *Fix in my agent* (MOTIR-9053): the door beside the command of a red-checks repair. */
  repairMyAgentDoor?: ReactNode;
}) {
  const t = useTranslations('github');
  const locale = useLocale();
  const tDecision = useTranslations('approvalGate.decision');
  const mono = (chunks: ReactNode) => <span className="font-mono">{chunks}</span>;
  // The rows to draw, and what each one's delivery knows about it. `pullRequests`
  // keeps its order and its place at the front — it is what this section has
  // always drawn — and a delivery the column never named is appended.
  const rows = mergePullRequestRows(pullRequests, deliveries);
  // The repositories still owed a row of their own — never the raw set (see the
  // prop's note). Derived BEFORE the empty-state gate, because the gate asks
  // whether there is anything to draw, and the raw set can be non-empty while
  // every one of its repositories already has a pull-request row.
  // ⚠️ Cross-referenced against the MERGED rows, not the prop: a repository whose
  // only pull request came from the delivery set would otherwise be handed a
  // "No pull request yet" placeholder directly beneath the pull request it was
  // asserting it about — MOTIR-3036's defect, re-entered through the new door.
  const awaiting = awaitingRepoRows(repoDelivery, rows);
  // WHO SENT THE COMMITS BACK (MOTIR-6825; § 30 Panels 3 and 3e) — the fix part's first line
  // for a `review` repair: the gate the frame leads with, refused by the review agent or by
  // a person. Read off the frame's own read; never a second one.
  const refusedGate = mergeGate?.gate.state === 'changes_requested' ? mergeGate.gate : null;
  const sentBackBy: SentBackBy | null =
    refusedGate?.kind === 'agent_review'
      ? { by: 'agent' }
      : refusedGate?.kind === 'pull_request_approval'
        ? { by: 'person', name: refusedGate.decidedByLabel }
        : null;
  // The big EmptyState is for an item with NOTHING to show. An item that carries
  // repositories always has rows — the awaiting ones — so it never lands here.
  const nothingLinked = rows.length === 0 && awaiting.length === 0;
  const howToTestPart = howToTest ? <HowToTestBlock howToTest={howToTest} /> : null;
  const rowsPart = (
    <>
      {/* `@container`: the rows wrap their pill group below a 30rem COLUMN, not a
          30rem viewport (MOTIR-5351, design/github Panel 12n) — a narrow late-stack
          column is narrow on a wide screen. */}
      <ul className="@container list-none">
        {rows.map((row) => (
          <PullRequestRow
            key={`${row.repo}#${row.number}`}
            pr={row.pr}
            strandedBase={row.strandedBase}
            action={rowAction?.(row.pr)}
          />
        ))}
        {/* After the real rows: a placeholder per repository still owed one.
            Ordered by the item's own repository order, so the list reads in the
            same sequence the rail does. */}
        {awaiting.map((d) => (
          <AwaitingRepoRow key={d.repo} delivery={d} />
        ))}
      </ul>
      {/* `--el-text-secondary`, NOT `--el-text-muted` (design §20 Decisions): the
          caption also renders inside the approval frame's port, whose
          `--el-surface` fill measures muted at 4.17:1 and fails AA. */}
      <p className="mt-3 font-sans text-xs text-(--el-text-secondary)">
        {t.rich(
          manualLinkable ? 'development.autoLinkCaptionManual' : 'development.autoLinkCaption',
          {
            key: itemIdentifier,
            mono,
          },
        )}
      </p>
      {repair ? (
        <RepairFixPart
          repair={repair}
          itemIdentifier={itemIdentifier}
          sentBackBy={sentBackBy}
          hostedDoor={repairHostedDoor}
          myAgentDoor={repairMyAgentDoor}
        />
      ) : null}
      {continuePart}
    </>
  );
  // An `auto` card's standing exits (§ 22 E5): the rows and How to test sit inside the
  // part's outcome context, the part between them. Never under a gate frame.
  const exitsRead =
    !mergeGate && autoQueueExits && autoQueueExits.exits.length > 0 ? autoQueueExits : null;
  const rowsThen = (after: ReactNode) =>
    exitsRead ? (
      <QueueExitAutoPart read={exitsRead} itemIdentifier={itemIdentifier} rows={rowsPart}>
        {after}
      </QueueExitAutoPart>
    ) : (
      <>
        {rowsPart}
        {after}
      </>
    );
  // Panel 5b: the merge question leads, and the decision's answer stands as a line.
  const decisionStands =
    decision?.gate?.state === 'approved' &&
    mergeGate !== null &&
    mergeGate.gate.kind !== 'decision_approval' &&
    decision.gate.decidedByLabel
      ? tDecision.rich('acceptedUnchanged', {
          name: decision.gate.decidedByLabel,
          when: decision.gate.decidedAt
            ? new Date(decision.gate.decidedAt).toLocaleString(locale)
            : '',
          b: (chunks: ReactNode) => <b className="font-semibold text-(--el-text)">{chunks}</b>,
        })
      : null;
  const pullRequestsGroup = (
    <div
      role="group"
      aria-label={t('development.pullRequestsGroup')}
      className="mt-4 min-w-0 border-t border-(--el-border-soft) pt-2"
    >
      {nothingLinked ? (
        <EmptyState
          className="mt-2"
          icon={<GitPullRequestArrow className="h-12 w-12" aria-hidden />}
          title={t('development.emptyTitle')}
          description={t.rich('development.emptyDescription', { key: itemIdentifier, mono })}
        />
      ) : (
        rowsThen(null)
      )}
    </div>
  );
  const block = decision ? (
    // THE DECISION CARD'S ORDER (§27): the document, then the pull requests — and no How
    // to test between them, whatever the run wrote.
    <>
      <DecisionDocumentSlot document={decision.document} acceptedLine={decisionStands} />
      {/* A page decision ships no pull request (MOTIR-5761), so nothing linked is the
          expected state: no "No linked pull request" prompt under it. */}
      {decision.document?.outcome === 'page' && nothingLinked ? null : pullRequestsGroup}
    </>
  ) : designResult ? (
    // THE DESIGN CARD'S ORDER (Q8, revised on review 2026-09-14): design result,
    // How to test, then the pull requests behind the rule How to test used to carry.
    <>
      {designResult}
      {howToTestPart}
      {pullRequestsGroup}
    </>
  ) : nothingLinked ? (
    <>
      <EmptyState
        className="mt-2"
        icon={<GitPullRequestArrow className="h-12 w-12" aria-hidden />}
        title={t('development.emptyTitle')}
        description={t.rich('development.emptyDescription', { key: itemIdentifier, mono })}
      />
      {continuePart}
      {howToTestPart}
    </>
  ) : (
    rowsThen(howToTestPart)
  );
  // NO GATE ⇒ NO FRAME (the `DesignResultSection` rule): a card's approve-and-merge
  // gate wraps the block in every state, and it wraps ALL of it — one frame for every
  // pull request the run delivered, never one per row. A decided gate keeps its frame,
  // because what the merges did is drawn after the decision (MOTIR-5484).
  if (mergeGate) {
    // The head each row's pull request is at NOW — what names the member a push moved
    // when the question is withdrawn (state `G`). Read off the ROW, which is where a
    // pull request's head belongs (MOTIR-5691); it used to come from How to test's
    // per-repository read, which only knew the pull requests the record covered.
    const currentHeads = rows.flatMap((row) =>
      row.pr.headSha ? [{ repo: row.repo, number: row.number, headSha: row.pr.headSha }] : [],
    );
    return (
      <DevelopmentGateFrame
        read={mergeGate}
        decision={
          decision
            ? {
                document: decision.document,
                openPullRequests: rows
                  .filter((row) => row.pr.state === 'open')
                  .map((row) => `${row.repo} · #${row.number}`),
              }
            : null
        }
        itemIdentifier={itemIdentifier}
        // Band 1's meta names the RUN that delivered the pull requests, so it
        // reads a run author and nothing else (MOTIR-5455, which deleted the
        // record's `run` field). A person's record names no run — correctly:
        // a person wrote the instructions, they did not deliver the set — and
        // the band falls back to its count.
        runLabel={howToTest?.record?.author.kind === 'run' ? howToTest.record.author.label : null}
        currentHeads={currentHeads}
        // What splits a `member_closed` withdrawal into merged and closed (MOTIR-5884):
        // the state each ROW already draws, never a second read.
        rowStates={rows.map((row) => {
          // What names the member in a `queue_failed` withdrawal (MOTIR-6596; design § 31
          // panel 5): its delivery's STANDING queue exit, a failure the class holds — read
          // off the delivery the block already has, never a second read.
          const exit = deliveries.find(
            (d) =>
              d.pullRequest.repo.toLowerCase() === row.repo.toLowerCase() &&
              d.pullRequest.number === row.number,
          )?.queueExit;
          return {
            repo: row.repo,
            number: row.number,
            state: row.pr.state,
            conflicted: row.pr.conflicted,
            baseRef: row.pr.baseRef,
            leftQueue:
              !!exit &&
              exit.rawReason !== 'MERGE_CONFLICT' &&
              classOfQueueExit(exit) === 'cant_land',
          };
        })}
        terminal={cardTerminal}
        actions={gateActions}
        layout={gateLayout}
        onShowCurrentVersion={onShowCurrentVersion}
        gateKey={gateKey}
        notice={gateNotice}
        verbsDisabled={gateVerbsDisabled}
        handOver={handOver}
        canReplan={canReplan}
        designRefusal={designRefusal}
        agentReview={agentReview}
      >
        {block}
      </DevelopmentGateFrame>
    );
  }
  return block;
}

/**
 * Does the card have an OPEN linked pull request — the condition under which its
 * design result renders inside the Development block rather than as a section of
 * its own (`design-result.md` AMENDMENT 4 Q8). Read over the SAME merged rows the
 * block draws, so the slot and the rows can never disagree about it; the server
 * side of the rule (`designEvidenceService`) reads the delivery set's
 * `countOpenByWorkItem`, which those rows include.
 */
export function hasOpenPullRequest(
  pullRequests: readonly LinkedPullRequestDto[],
  deliveries: readonly WorkItemDeliveryDto[],
): boolean {
  return mergePullRequestRows(pullRequests, deliveries).some((row) => row.pr.state === 'open');
}

/** The PEEK host — SectionLabel header over the shared body (design Panel 3). */
export function DevelopmentSection({
  pullRequests,
  itemIdentifier,
  className,
  repoDelivery = [],
  deliveries = [],
  designResult = null,
  mergeMembers = [],
}: {
  pullRequests: LinkedPullRequestDto[];
  itemIdentifier: string;
  className?: string;
  /** The item's repository set (MOTIR-2416) — passed straight through to the
   *  shared body, so the peek shows the same rows the detail page does rather
   *  than a reduced second form. Unfiltered, per the body's prop note. */
  repoDelivery?: RepoDelivery[];
  /** The card's delivery set (MOTIR-3660) — passed straight through, so the peek
   *  draws the same rows and the same `Not on trunk` pill the detail page does. */
  deliveries?: WorkItemDeliveryDto[];
  /** The design result's slot, when the card's open pull requests carry it (Q8)
   *  — the same element the detail page passes, so the peek shows the design in
   *  the same place. Read-only: the panel has no verbs of its own. */
  designResult?: ReactNode;
  /** What a reload knows about each member of the card's APPROVED approve-and-merge gate
   *  (Bug MOTIR-5650) — so a row reads *Queued to merge* / *Not merged yet* here exactly as
   *  it does on the item page. The peek draws no frame, so no Retry. Empty for every other
   *  gate state, and for a card with no gate. */
  mergeMembers?: readonly PullRequestApprovalMemberDTO[];
}) {
  const t = useTranslations('github');
  return (
    <section className={className} data-testid="development-section">
      <SectionLabel label={t('development.title')} />
      <PersistedMergeOutcomes members={mergeMembers}>
        <DevelopmentSectionBody
          pullRequests={pullRequests}
          itemIdentifier={itemIdentifier}
          repoDelivery={repoDelivery}
          deliveries={deliveries}
          designResult={designResult}
        />
      </PersistedMergeOutcomes>
    </section>
  );
}
