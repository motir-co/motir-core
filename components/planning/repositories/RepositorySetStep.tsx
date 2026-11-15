'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  CircleCheckBig,
  ExternalLink,
  Loader2,
  Lock,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { IdentityHeader } from '@/app/(authed)/settings/workspace/_components/gitSettingsPrimitives';
import type { PlanCodeOutcome } from '@/components/planning/PlanReviewRail';
import {
  establishRepositorySet,
  fetchRepositorySet,
  refreshRepositoryAccess,
  RepositorySetRequestError,
} from '@/lib/planning/repositorySetClient';
import { BILLING_PLANS_PATH } from '@/components/ai/AiPaywall';
import type { ProjectRepoDto, ProjectRepoEstablishViewDto } from '@/lib/dto/projectRepos';
import {
  isSettledRow,
  rowIsReachable,
  setHasOrganizationRow,
} from '@/lib/projectRepos/establishStep';
import { needsCollaboratorInvite } from '@/lib/projectRepos/access';

// THE ESTABLISH STEP at plan approval (Story MOTIR-1775 · MOTIR-1782) — the step
// that gives an approved plan somewhere for its code to live. It takes the CANVAS
// pane of the plan-detail box; the review rail stays, still reading "Approved",
// which is what makes the step honest: the plan is already safe before the user
// answers anything here (ADR §4.3).
//
// ⚠️ THE DEFAULT PATH IS ONE SENTENCE, ONE PRIMARY, ONE QUIET SECONDARY. No
// repository name, role, target account, COUNT, row, table chrome, seed source or
// GitHub error string reaches it — a one-repository plan and a three-repository
// plan render the identical screen, which is the design's central claim and the
// reason the question is REMOVED rather than styled two ways. This is the
// `notes.html` #151 rule: an AI-derived artifact a non-technical user cannot
// meaningfully evaluate is derived, used automatically, and never put behind an
// approval gate or a bespoke editor.
//
// Everything technical — rows, roles, names, per-row state, the derivation's
// "why" — lives behind "I already have code", and appears only once the user has
// connected their own GitHub, which is how they self-identify as someone the word
// "repository" means something to.
//
// ⚠️ PROGRESS COMES FROM THE POLL, NOT FROM THE ESTABLISH RESPONSE. The creation
// primitive persists each row's outcome AS IT RESOLVES, so re-reading the set is
// what makes per-row progress real (spike §4.2: a `201` is not a ready
// repository, and how long seeding takes is unmeasured). The run is resumable, so
// a request that outlives the platform's limit costs nothing but a **Try again**.

/** How often the set is re-read while anything is in flight. Fast enough that a
 *  sub-second create still shows its transition; slow enough to be free. */
const POLL_MS = 1500;

/** The surface that OWNS access from here on — resend, the team matrix, the
 *  per-member state. Arm B's door, and the rail's `needs_access` outcome points
 *  the same way. Nothing about it is redrawn here (MOTIR-5015). */
const CODE_ACCESS_HREF = '/settings/project/code-access';

/** The three states the DEFAULT path renders. The ADR's six per-row states are
 *  the MODEL; this path shows only what the user can act on, and `proposed` /
 *  `connected` / `skipped` cannot occur on it at all — nothing is proposed for
 *  approval, nothing is adopted, and there is nothing to decline. */
type DefaultState = 'idle' | 'working' | 'ready' | 'failed' | 'refused';

/**
 * Why the paid-AI-plan gate refused the LAST Continue (MOTIR-6909's gate, bug
 * MOTIR-8985). The establish route answers it before any row is attempted —
 * `ai_plan_required` (402) or `plan_unknown` (503) — so the set it leaves behind
 * is exactly the set the user started from, and a step derived from the set
 * alone would read `idle` again: Continue pressed, nothing happened, nothing
 * said. The refusal is therefore the one fact this step keeps beside the set.
 */
type PlanRefusal = 'ai_plan_required' | 'plan_unknown';

function planRefusalOf(err: unknown): PlanRefusal | null {
  if (!(err instanceof RepositorySetRequestError)) return null;
  return err.code === 'ai_plan_required' || err.code === 'plan_unknown' ? err.code : null;
}

/**
 * ⚠️ THE STEP HAS ONE SURFACE NOW — the three that left are recorded here rather
 * than kept as dead union members.
 *
 * `own` (the short confirmation behind "I already have code") and `set` (the
 * technical path's editable rows) went to ONBOARDING with MOTIR-5014 — a project
 * with no repository cannot be planned at all, so a user standing here has
 * already answered that question.
 *
 * `access` went with MOTIR-5015: the collaborator invitation is SENT at establish
 * now, so there is nothing left to ask for. The `created` panel REPORTS which
 * account it went to (`AccessReport` below).
 */

export interface RepositorySetStepProps {
  /** The project's key — how the repository-set API is addressed. */
  projectKey: string;
  initialView: ProjectRepoEstablishViewDto;
  /** Where "Go to my backlog" leads. */
  backlogHref: string;
  /** The shipped 7.10 connect pane — this step hands off to it and redraws none
   *  of it. */
  connectHref: string;
  /**
   * Reports the ONE line the review rail's approved outcome carries about the
   * project's code — `ready` once every row has settled AND the user can reach
   * what Motir made them, `needs_access` when the code exists but nobody has been
   * invited to it (MOTIR-1900), `unfinished` while any row is still unresolved.
   *
   * A CALLBACK rather than a `router.refresh()`, because the rail is not a
   * server-rendered surface here: it is a sibling client component fed by the
   * plan-detail island's own state, so re-reading the server would be a round
   * trip to learn something this component already knows. (`router.refresh()`
   * remains the right mechanism for the surfaces that ARE server-rendered — the
   * three-surface page-state contract is about routing each surface to the
   * mechanism that reaches it, not about always reaching for the same one.)
   */
  onOutcomeChange?: (outcome: PlanCodeOutcome) => void;
}

export function RepositorySetStep({
  projectKey,
  initialView,
  backlogHref,
  connectHref,
  onOutcomeChange,
}: RepositorySetStepProps) {
  const [view, setView] = useState(initialView);
  const [establishing, setEstablishing] = useState(false);
  const [refusal, setRefusal] = useState<PlanRefusal | null>(null);

  const rows = view.set.rows;
  const anyCreating = rows.some((r) => r.state === 'creating');
  const running = establishing || anyCreating;

  const refetch = useCallback(
    async (signal?: AbortSignal) => {
      const fresh = await fetchRepositorySet(projectKey, signal);
      setView(fresh);
      return fresh;
    },
    [projectKey],
  );

  // POLL while anything is in flight. This is the fourth page-state mechanism
  // (design §12): a row's `creating → created` hop is settled by a readiness read
  // on the server, so it is an async job with its own poll — `router.refresh()`
  // is neither how it starts nor how it finishes.
  useEffect(() => {
    if (!running) return;
    const ctrl = new AbortController();
    const handle = setInterval(() => {
      void refetch(ctrl.signal).catch(() => {
        /* best-effort poll — a transient failure just retries next tick */
      });
    }, POLL_MS);
    return () => {
      ctrl.abort();
      clearInterval(handle);
    };
  }, [running, refetch]);

  // Tell the rail what to say about the code, and ONLY when the answer actually
  // changes — a poll tick that finds the same state must not re-render the rail.
  //
  // ACCESS is part of the answer (MOTIR-1900): a set whose rows all settled but
  // whose repositories the user cannot reach is not finished, and the rail says
  // so ("Finish setting up access") rather than claiming the code is ready. A
  // user who chose **Later** therefore leaves with an honest outcome and a door.
  const outcomeRef = useRef<PlanCodeOutcome | null>(null);
  useEffect(() => {
    if (rows.length === 0) return;
    const outcome: PlanCodeOutcome = !rows.every(isSettledRow)
      ? 'unfinished'
      : rows.every(rowIsReachable)
        ? 'ready'
        : 'needs_access';
    if (outcome === outcomeRef.current) return;
    outcomeRef.current = outcome;
    onOutcomeChange?.(outcome);
  }, [rows, onOutcomeChange]);

  const establish = useCallback(
    async (rowId?: string) => {
      setEstablishing(true);
      setRefusal(null);
      try {
        await establishRepositorySet(projectKey, rowId);
      } catch (err) {
        // The set's own state is the report: `establish` persists PER ROW, so a
        // request that failed part-way has committed real outcomes, and the
        // authoritative re-read below renders them as the `failed` panel. The
        // technical path's separate `actionError` line went with it (MOTIR-5014).
        //
        // ⚠️ EXCEPT the paid-AI-plan refusal (bug MOTIR-8985), which lands before
        // any row is touched and so leaves NOTHING in the set to report it. It is
        // kept here and drawn as its own state; every other failure still reads
        // from the set.
        setRefusal(planRefusalOf(err));
      } finally {
        setEstablishing(false);
        // The authoritative read, always — the run persists per row, so even a
        // request that failed part-way has committed real outcomes to show.
        await refetch().catch(() => {});
      }
    },
    [projectKey, refetch],
  );

  // Settle any PENDING invitation the user has since accepted on GitHub. GitHub
  // tells Motir nothing when an invitation is accepted, so a read is the only way
  // to learn it — but putting that read on the 1.5s set poll would spend a host
  // request per row per tick to discover something that changes once.
  //
  // ⚠️ ITS TRIGGER MOVED WITH THE ACCESS STEP (MOTIR-5015). It used to fire on
  // ENTERING that step, which was also the only moment the answer was rendered.
  // With the report on the `created` panel the two coincide again: it fires once
  // the set is SETTLED, which is exactly when the panel starts naming an account.
  // Guarded on `settled` rather than on a panel, so a set that arrives already
  // settled — a reload after establishing — still asks.
  const settled = rows.length > 0 && rows.every(isSettledRow);
  useEffect(() => {
    if (!settled) return;
    const ctrl = new AbortController();
    void refreshRepositoryAccess(projectKey, ctrl.signal)
      .then((fresh) => {
        // ⚠️ GUARDED, because this fold is now reachable on the ORDINARY path.
        // While the refresh only fired on entering the access step, a malformed
        // answer could reach one panel; it now fires whenever a set settles, so a
        // non-array would replace `rows` on the surface every user sees and turn
        // the next `rows.some(...)` into a TypeError. Best-effort means the row
        // keeps saying what it last knew — including when the answer is unusable.
        if (!Array.isArray(fresh)) return;
        setView((prev) => ({ ...prev, set: { ...prev.set, rows: fresh } }));
      })
      .catch(() => {
        /* best-effort — the row keeps saying what it last knew */
      });
    return () => ctrl.abort();
  }, [settled, projectKey]);

  return (
    <StepShell>
      <DefaultPath
        state={defaultStateOf(rows, running, refusal)}
        refusal={refusal}
        busy={running}
        backlogHref={backlogHref}
        connectHref={connectHref}
        login={view.githubLogin}
        avatarUrl={view.githubAvatarUrl}
        rows={rows}
        onContinue={() => void establish()}
      />
    </StepShell>
  );
}

/** The default path's three states, plus the pre-Continue hero. */
function DefaultPath({
  state,
  refusal,
  busy,
  backlogHref,
  connectHref,
  login,
  avatarUrl,
  rows,
  onContinue,
}: {
  state: DefaultState;
  /** Which refusal the `refused` state draws; null in every other state. */
  refusal: PlanRefusal | null;
  busy: boolean;
  backlogHref: string;
  /** The shipped 7.10 connect pane — reached only from the report's **Use a
   *  different account**, which re-runs the connect rather than opening a field. */
  connectHref: string;
  login: string | null;
  avatarUrl: string | null;
  rows: readonly ProjectRepoDto[];
  onContinue: () => void;
}) {
  const t = useTranslations('repositorySet');
  // ⚠️ THE MIXED SET (design §7b, v6 — bug MOTIR-5049). A project can hold a
  // repository the ORGANISATION already owns beside one Motir is creating:
  // `organizationRepoService` appends a `connected` / `organization` row to
  // whatever set the project has. The step is still drawn — there IS a row to
  // establish — but its two SET-WIDE sentences would otherwise speak for a
  // repository that is not Motir's to speak for.
  //
  // Both edits are SCOPE, not information, and that is what keeps the design's
  // #151 rule intact: the panel still names no repository, no role, no account,
  // no count and no rows. "the new code" and "the code it hosts" are narrower
  // SUBJECTS for the same two sentences, not a disclosure about the set — a
  // reader with an all-Motir set cannot tell the difference, which is the test a
  // scope edit has to pass. A set with NO organisation row keeps the unscoped
  // wording byte for byte.
  const mixed = setHasOrganizationRow(rows);
  return (
    <>
      <div className="flex flex-col gap-3">
        <SectionLabel label={t('overline')} />
        <h2 className="font-serif text-[28px] leading-tight font-semibold text-(--el-text)">
          {t(mixed ? 'titleMixed' : 'title')}
        </h2>
        {state === 'idle' ? (
          <p className="text-sm leading-relaxed text-(--el-text-secondary)">{t('lead')}</p>
        ) : null}
      </div>

      {state === 'working' ? (
        <>
          <p
            role="status"
            data-testid="repo-setup-status"
            className="flex items-center gap-2 text-base font-semibold text-(--el-text)"
          >
            <Loader2 className="size-5 shrink-0 animate-spin" aria-hidden="true" />
            {t('working')}
          </p>
          <p className="text-sm text-(--el-text-helper)">{t('workingDetail')}</p>
        </>
      ) : null}

      {state === 'ready' ? (
        <p
          data-testid="repo-setup-status"
          className="flex items-center gap-2 text-base font-semibold text-(--el-text)"
        >
          <CircleCheckBig className="size-5 shrink-0 text-(--el-success)" aria-hidden="true" />
          {t('ready')}
        </p>
      ) : null}

      {state === 'failed' ? (
        <>
          <p
            data-testid="repo-setup-status"
            className="flex items-center gap-2 text-base font-semibold text-(--el-text)"
          >
            <TriangleAlert className="size-5 shrink-0 text-(--el-danger)" aria-hidden="true" />
            {t('setupFailed')}
          </p>
          {/* The consequence, in the USER's terms — never a GitHub status code and
              never a repository name (those belong to the technical path). */}
          <p role="alert" className="text-sm text-(--el-text-helper)">
            {t('setupFailedDetail')}
          </p>
        </>
      ) : null}

      {state === 'refused' && refusal ? <PlanRefusalNote refusal={refusal} /> : null}

      {/* The ownership promise — a STANDING GUARANTEE on the main line, not a
          footnote and not a severity tint: it is a fact about the arrangement,
          which is why it sits on `--el-surface-soft` rather than a hue. */}
      {state === 'idle' || state === 'ready' ? <OwnershipPromise mixed={mixed} /> : null}

      {/* THE REPORT (design v5, panel 2's `created` state — MOTIR-5015). Two arms,
          and which one shows is what Motir KNOWS, never a branch the user picks. */}
      {state === 'ready' ? (
        <AccessReport login={login} avatarUrl={avatarUrl} rows={rows} connectHref={connectHref} />
      ) : null}

      <div className="flex flex-wrap items-center gap-4">
        {state === 'idle' ? (
          /* ONE action, and no branch. The quiet `iHaveCode` secondary led to the
             technical path, which left for onboarding (MOTIR-5014) — a user who
             already has code answered that question there, before any plan
             existed. */
          <Button variant="primary" onClick={onContinue} disabled={busy}>
            {t('continueCta')}
          </Button>
        ) : null}
        {state === 'ready' ? (
          /* ⚠️ ONE ACTION, and it is the JOURNEY's — not a question about the
             code. The invitation went out with the repositories (MOTIR-5015) and
             the report above has already said where; there is nothing here to ask
             for. Until this card the primary was labelled `connectGithub` while
             its handler navigated to the access step — a button wearing the
             connect button's name, which fetched nothing, shown to people who had
             connected GitHub months earlier. */
          <Link
            href={backlogHref}
            className="inline-flex h-(--height-btn-md) items-center gap-2 rounded-(--radius-btn) bg-(--el-accent) px-(--spacing-btn-x) font-sans text-sm font-medium text-(--el-accent-text) hover:opacity-90"
          >
            {t('goToBacklog')}
          </Link>
        ) : null}
        {state === 'refused' && refusal === 'ai_plan_required' ? (
          /* Nothing about the request is wrong and a retry would be refused the
             same way: the one thing that changes the answer is a plan, so the
             action is the door to one rather than Try again. */
          <Link
            href={BILLING_PLANS_PATH}
            className="inline-flex h-(--height-btn-md) items-center gap-2 rounded-(--radius-btn) bg-(--el-accent) px-(--spacing-btn-x) font-sans text-sm font-medium text-(--el-accent-text) hover:opacity-90"
          >
            {t('planRequiredDoor')}
          </Link>
        ) : null}
        {state === 'failed' || (state === 'refused' && refusal === 'plan_unknown') ? (
          /* The SECOND site the door appeared on, and the one a deletion that
             reads only the first leaves behind — a dead escape hatch on the error
             path, which is the state a user is most likely to be looking at when
             they want one. */
          <Button
            variant="primary"
            onClick={onContinue}
            disabled={busy}
            leftIcon={<RefreshCw className="size-4" aria-hidden="true" />}
          >
            {t('tryAgain')}
          </Button>
        ) : null}
      </div>
    </>
  );
}

/**
 * THE ACCESS STEP (MOTIR-1900 — design panels 3 + 3b): getting the user into the
 * code Motir just made them.
 *
 * Three properties are load-bearing and each is rendered, not merely asserted:
 *
 *   1. **It comes AFTER approval, and after the code exists.** Nothing about
 *      GitHub can cost the user their plan — it is already in the backlog — or
 *      their repositories, which are already made.
 *   2. **It is not a gate.** `Later` is a real answer that leaves everything
 *      intact; the rail's outcome then says what is unfinished.
 *   3. **It asks for no PERMISSION.** Motir needs exactly one thing — the user's
 *      GitHub username — which is grant 1 (identity) of the shipped connect pane.
 *      The repository-access install is grant 2 and is needed only for
 *      connect-existing. No re-consent, upgrade or org-owner state is rendered,
 *      because none is asked for.
 *
 * ⚠️ THE ACCOUNT IS CONNECTED, NEVER TYPED — and therefore SHOWN. There is no
 * "type your GitHub username" field: a typed handle proves nothing and a typo
 * would invite a STRANGER to a private repository. Once connected, the shipped
 * `IdentityHeader` renders which account it is, with a way to change it that
 * re-runs the connect rather than opening a field.
 */

/**
 * THE ACCESS REPORT (MOTIR-1900 · design/repository-set v5 panel 2 `created` —
 * MOTIR-5015): what happened to the user's access to the code Motir just made.
 *
 * ⚠️ IT REPORTS. IT DOES NOT ASK. The invitation is sent by `establishSet` in the
 * same run that creates the repositories, so by the time this renders the answer
 * already exists. Until this card the panel offered `repositorySet.connectGithub`
 * — a navigation button wearing the connect button's name, shown to people whose
 * account was already in the very view that rendered it.
 *
 * THREE ARMS, and which one shows is what Motir KNOWS rather than a branch the
 * user picks. They are PREDICATES over the DTO, checked in this order, and they
 * are written as predicates deliberately (design v7 · MOTIR-5038):
 *
 *   • **B** — `login === null` ⇒ there is no account to invite;
 *   • **C** — `login !== null` ∧ every INVITABLE row `not_invited` ⇒ Motir had
 *     an account, tried, and nothing stuck;
 *   • **A** — otherwise ⇒ some invitable row is `invited` or `accepted`, so the
 *     shipped `IdentityHeader` names the account, with the pending invitation's
 *     door beside it when there is exactly one.
 *
 * ⚠️ WHY ARM C EXISTS, AND WHY THE CONDITION IS THE FIX RATHER THAN THE SENTENCE
 * (bug MOTIR-5036). Arm B used to be guarded on `!login || !anyInvited` while
 * its copy said only the FIRST disjunct — "Motir doesn't know your GitHub
 * account yet". A GitHub refusal leaves every row `not_invited` (MOTIR-1900's
 * graceful degradation, working as designed), so the second disjunct fired with
 * `login` a real string and the panel told the reader a fact about THEMSELVES
 * that was untrue — four inches under "Your code is ready", and disagreeing
 * with the bell MOTIR-5016 had just rung about the same event. The drift was
 * between a condition written in prose and a guard written as a shape test;
 * stating all three as predicates is what stops the next reader re-introducing
 * it.
 *
 * ⚠️ ARM C IS DRAWN INSIDE THE SEVERITY RULING, NOT BESIDE IT. An invitation
 * failure never fails a row: the repositories are real, the plan is safe, and
 * the main line still says "Your code is ready". So arm C changes ONE SENTENCE
 * and nothing else — no red tint, no `failed` panel, no GitHub status code, no
 * repository name, and the same door. The settings surface tints ITS refusal
 * `--el-danger`, which is right there (a work list you went to in order to fix
 * something) and wrong here. {@link AccessNote} is what makes "the same
 * treatment" structural rather than two call sites that happen to agree.
 *
 * ⚠️ ARMS B AND C SAY THE RAIL'S WORDS BY REUSING ITS KEY. `PlanDetail.
 * codeOutcomeOf` resolves a `created` row nobody has been invited to as
 * `needs_access` and `PlanReviewRail` renders that as `outcomeNeedsAccess`;
 * this door is that same key, not a second string that happens to match today.
 * ⚠️ AND `codeOutcomeOf` IS DELIBERATELY UNCHANGED BY ARM C — see its own
 * header in `PlanDetail.tsx` for the reading and the reason.
 *
 * ⚠️ A REPORT IS NOT A SILENT SURFACE. Arm A keeps **Use a different account**,
 * which re-runs the connect rather than opening a field. That is not a residue of
 * the ask: the whole reason the account is SHOWN is that a typed handle could
 * invite a STRANGER to a private repository, and showing which account holds admin
 * while offering no way to correct it would make that guarantee worse.
 */
function AccessReport({
  login,
  avatarUrl,
  rows,
  connectHref,
}: {
  login: string | null;
  avatarUrl: string | null;
  rows: readonly ProjectRepoDto[];
  connectHref: string;
}) {
  const t = useTranslations('repositorySet');
  const tGithub = useTranslations('github');

  // The single pending invitation's door. Only offered when there is exactly ONE —
  // with a multi-repo set there is no single "the invitation" to open, and
  // `/settings/project/code-access` is where each is reached.
  const pending = rows.filter((r) => r.access.state === 'invited' && r.access.invitationUrl);
  const invitationUrl = pending.length === 1 ? pending[0]!.access.invitationUrl : null;

  // ⚠️ THE ROWS THE PRODUCT CAN ACTUALLY INVITE TO — never `rows` (design v7
  // amendment 2). A `connected` row is the ORGANISATION's and is `not_invited`
  // for ever by construction; a `skipped` / `failed` row has no repository
  // behind it. Quantifying arm C over every row would turn its condition on
  // rows nothing will ever invite to, which is how the MIXED set (§7b) would
  // have read as a refusal.
  const invitable = rows.filter((r) => needsCollaboratorInvite(r.state));

  // ARM B — there is no account to invite. "Connected" is a property of the
  // ACTOR, not of the project: a teammate who did not run onboarding can
  // approve a plan, and inventing an invitation for an account Motir does not
  // have would be worse than saying so.
  if (!login) {
    return <AccessNote detail={t('notInvitedDetail')} doorLabel={t('outcomeNeedsAccess')} />;
  }

  // ARM C — Motir HAD an account, sent the invitation at establish, and GitHub
  // refused it (design v7 · MOTIR-5038 · bug MOTIR-5036).
  //
  // ⚠️ WHY `every(not_invited)` IS SUFFICIENT HERE AND WOULD NOT BE ON ITS OWN.
  // `not_invited` is not a record of a refusal — `projectRepoAccessService`
  // stamps NOTHING on one, which is MOTIR-1900's graceful degradation working
  // as specified — so by itself it cannot tell REFUSED from NEVER ATTEMPTED.
  // The connected login is what closes that: since MOTIR-5015 the invitation is
  // sent at establish, in the same pass that creates the rows, so a set that
  // reached `created` while Motir held an identity has ALREADY had its
  // invitation attempted. A known account with nothing sent has one
  // explanation — which is why the sentence says what MOTIR could not do rather
  // than what GitHub's response was.
  //
  // ⚠️ AND `invitable` IS NEVER EMPTY WHERE THIS RENDERS, so the vacuous truth
  // of `[].every(…)` is not reachable: this report is drawn only at
  // `state === 'ready'` (every row SETTLED) inside a band drawn only when some
  // row is establish-work (`proposed` / `creating` / `created` / `failed`), and
  // `created` is the sole state in both sets. `arm C is never drawn for a set
  // with nothing to invite` pins it.
  if (invitable.every((r) => r.access.state === 'not_invited')) {
    return (
      <AccessNote
        detail={t('notInvitedRefusedDetail', { login })}
        doorLabel={t('outcomeNeedsAccess')}
      />
    );
  }

  // ARM A — some invitable row is `invited` or `accepted`.
  return (
    <div className="flex flex-col gap-3" data-testid="repo-access-report">
      {/* The shipped `IdentityHeader`, not a redrawn stand-in — the same component
          the Git settings pane puts a Disconnect button on, so the account the
          user sees here is the account the product knows. */}
      <IdentityHeader
        login={login}
        avatarUrl={avatarUrl}
        verified={tGithub('identity.verified')}
        caption={t('identityCaption')}
        trailing={
          <Link
            href={connectHref}
            className="text-sm font-medium text-(--el-link) hover:text-(--el-link-pressed)"
          >
            {t('useOtherAccount')}
          </Link>
        }
      />
      <p className="flex flex-wrap items-center gap-3 text-sm text-(--el-text-helper)">
        <span>{t('invitedDetail')}</span>
        {invitationUrl ? (
          <a
            href={invitationUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1.5 font-medium text-(--el-link) hover:text-(--el-link-pressed)"
          >
            {t('openInvitation')}
            <ExternalLink className="size-4 shrink-0" aria-hidden="true" />
          </a>
        ) : null}
      </p>
    </div>
  );
}

/**
 * THE ONE QUIET LINE ARMS B AND C SHARE — `AccessReport`'s non-invited note.
 *
 * ⚠️ ONE ELEMENT, TWO SENTENCES, AND THAT IS THE DESIGN RULING RATHER THAN a
 * convenience (design v7): the arms are mutually exclusive and only one is ever
 * on screen, so the DISTINCTION the reader needs is carried ENTIRELY by the
 * sentence. A second hue would be a severity claim, and the severity is settled
 * — an invitation failure never fails a row, so neither arm may read as a failed
 * setup four inches under "Your code is ready".
 *
 * Keeping the treatment in ONE place is what stops the two drifting: written as
 * two call sites, the next person to tint one of them has no reason to notice
 * the other. Same `role="status"` (nothing FAILED — this is a report), same
 * `--el-warning` `TriangleAlert`, same `--el-text-secondary` ink, and the same
 * door, which is `/settings/project/code-access` for both because that surface
 * OWNS the repair and already distinguishes the two states correctly.
 */
function AccessNote({ detail, doorLabel }: { detail: string; doorLabel: string }) {
  return (
    <p
      role="status"
      data-testid="repo-access-report"
      className="flex items-start gap-2 text-sm text-(--el-text-secondary)"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-(--el-warning)" aria-hidden="true" />
      <span>
        {detail}{' '}
        <Link
          href={CODE_ACCESS_HREF}
          className="font-medium text-(--el-link) hover:text-(--el-link-pressed)"
        >
          {doorLabel}
        </Link>
      </span>
    </p>
  );
}

/**
 * THE PAID-AI-PLAN REFUSAL (bug MOTIR-8985) — the `failed` panel's own shape
 * (the danger glyph on the status line, the consequence in the user's terms as
 * an alert), with the gate's sentence as the consequence. `plan_unknown` is a
 * read that did not answer, so its sentence says to try again; the action
 * under it is the step's own **Try again**.
 */
function PlanRefusalNote({ refusal }: { refusal: PlanRefusal }) {
  const t = useTranslations('repositorySet');
  return (
    <>
      <p
        data-testid="repo-setup-status"
        className="flex items-center gap-2 text-base font-semibold text-(--el-text)"
      >
        <TriangleAlert className="size-5 shrink-0 text-(--el-danger)" aria-hidden="true" />
        {t('setupFailed')}
      </p>
      <p role="alert" className="text-sm text-(--el-text-helper)">
        {t(refusal === 'ai_plan_required' ? 'planRequiredDetail' : 'planUnknownDetail')}
      </p>
    </>
  );
}

function OwnershipPromise({ mixed }: { mixed: boolean }) {
  const t = useTranslations('repositorySet');
  return (
    <div className="flex max-w-prose gap-3 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-surface-soft) p-(--spacing-card-padding)">
      <Lock className="mt-0.5 size-5 shrink-0 text-(--el-icon-muted)" aria-hidden="true" />
      {/* THE DOOR IS NOW LIT (MOTIR-1939). It was withheld until this commit
          because the room behind it did not exist — "a link to a 404 is a worse
          broken promise than no link, and a surface that draws a door owes a real
          entrance". `/settings/project/repositories` is that entrance, and this
          is door 1 of the three the design draws (§14.4). A plain `Link`, not a
          button: it is a navigation, and the promise is a standing statement
          rather than a control. */}
      <p className="min-w-0 text-sm leading-relaxed text-(--el-text-secondary)">
        {t.rich(mixed ? 'promiseMixed' : 'promise', {
          b: (chunks) => <strong className="font-semibold text-(--el-text)">{chunks}</strong>,
        })}{' '}
        <Link
          href="/settings/project/repositories"
          className="font-medium text-(--el-link) hover:text-(--el-link-pressed)"
        >
          {t('promiseDoor')}
        </Link>
      </p>
    </div>
  );
}

function StepShell({ children }: { children: ReactNode }) {
  return (
    <div className="h-full w-full overflow-y-auto bg-(--el-canvas) p-8">
      <div className="mx-auto flex w-full max-w-[40rem] flex-col gap-5">{children}</div>
    </div>
  );
}

/* ⚠️ `isSettled` AND `hasAccess` USED TO BE DEFINED HERE, and they were
   duplicated verbatim inside `PlanDetail.codeOutcomeOf` — two components
   answering "is this row settled?" from two hand-written copies of the same
   three-member list, with the REAL answer a third copy in `transitions.ts`.
   Both now come from `lib/projectRepos/establishStep.ts` as `isSettledRow` /
   `rowIsReachable` (bug MOTIR-5049). Neither is the predicate that decides
   whether this step RENDERS: `created` is settled and still the step's work, so
   establish-work is not the negation of settledness — that module's header
   carries the split. */

/**
 * The default path's state, derived from the SET — never from a local flag alone,
 * so a reload mid-run lands in the right state.
 *
 * Order matters: anything in flight is `working`; then a set with nothing left to
 * resolve is `ready`; then a failure. A `failed` row therefore only surfaces once
 * the run has stopped, which is what keeps the one status line honest while
 * siblings are still being created.
 */
function defaultStateOf(
  rows: readonly ProjectRepoDto[],
  running: boolean,
  refusal: PlanRefusal | null,
): DefaultState {
  if (running) return 'working';
  // The plan gate refused before any row moved, so the set alone would read
  // `idle` — the silent reset this state exists to replace (MOTIR-8985).
  if (refusal) return 'refused';
  if (rows.length === 0) return 'idle';
  if (rows.every(isSettledRow)) return 'ready';
  if (rows.some((r) => r.state === 'failed')) return 'failed';
  return 'idle';
}
