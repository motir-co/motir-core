# ADR: A hosted run is the Motir CLI's own run, in a container, writing as Motir's GitHub App

- **Status:** Proposed (2026-09-26), for acceptance at this card's `decision_approval` gate
- **Card:** MOTIR-6555 · **Story:** MOTIR-683 (9.1, "A card runs on the hosted agent")
- **Decided by:** Yue, 2026-09-26, reviewing the second draft of MOTIR-6518's design and the re-plan
  that followed. This record writes that direction down; it does not re-open it:
  - _"I thought hosted run should commit as the app, not a person account. A non-tech user won't
    even have a github account, it should not be required to trigger a hosted run."_
  - _"a run can touch multiple repos, it's never per run per repo"_ — _"a parent for example, and
    even a leaf run can carry multiple repos too"_.
  - _"the time limit is removed for the parent run"_ (MOTIR-6525).
  - _"cli is added specially for the hosted agent run"_.
- **Consumed by:**
  - MOTIR-683 (the story), MOTIR-690 (start), MOTIR-6450 (end), MOTIR-691 (UI), MOTIR-692 (test gate)
  - MOTIR-6558 (the CLI's hosted mode), MOTIR-6559 (the CLI's launcher and credential helper),
    MOTIR-6560 (the image), MOTIR-6557 (the run credential's allow-list)
  - MOTIR-6449 (the run's git credentials), MOTIR-6538 (the git-credential route), MOTIR-6539
    (checkpoints)
  - MOTIR-6518 (the design) and MOTIR-1895 (the Repositories room), MOTIR-6523 (manual: the Apps'
    permissions), MOTIR-6556 (the identity removal), MOTIR-6527 (Continue hosted)
- **Supersedes:**
  - MOTIR-685 — `hosted-agent-run.md` §2's _written by the entrypoint_ column (now the CLI), §3's
    allow-list (widened to the run's legs), and §4 in full: person authorship, the user token, one
    repository per run, and the rejection of _"the bot option everywhere"_.
  - MOTIR-687 — the bespoke one-card, one-repository entrypoint as the thing that runs a card.
  - MOTIR-688 — the run credential's one-card allow-list.
  - MOTIR-6522 — `hosted-run-one-github-app.md` §1's own-repository branch (the dispatcher's user
    token), §3 (expiring user tokens), §4 (the unrevoked identity token), §5's first refusal and the
    wording of the other two. **What stands:** which App writes which repository, Motir Integration
    gaining `contents` + `pull_requests` write, and the retirement of the Motir Agent App.
  - MOTIR-6519 — its expiring-identity half.

---

## Context

Story 9.1 was written as _"authenticates it to git and to Motir as the person who dispatched it"_
and _"opens a pull request authored as that person"_, and its container ran **one card on one
repository** through an entrypoint written for it (`MOTIR_REPOSITORY`, `MOTIR_BASE_REF`, one pull
request). Three re-plans in one day refined _how_ the person's GitHub identity would be obtained —
a second App, then the existing App's user token with refresh — without asking whether the person
has one. Both premises were wrong:

- **The dispatcher often has no GitHub account.** The person the hosted-agent epic serves is not
  necessarily a developer. Requiring a GitHub link to press Run hosted contradicts the product.
- **A run is not one card on one repository.** A card's repositories are a set
  (`work-item-repository-set.md`); the dispatch prompt already renders a worktree, a branch and a
  pull request per repository (`dispatch-prompt-assembly.md`, repository COUNT); and a parent card
  runs its children on one session branch per repository with one draft pull request per repository
  (`work-item-delivery-links.md`). Removing the wall-clock limit (MOTIR-6525) is what lets a parent
  run hosted at all.

The Motir CLI already runs every one of those shapes: `runCommand` runs a leaf over its whole
repository set, and `drainScope` runs a parent's claimed members in `blocked_by` order, with
`mark_integrated` per child, `ensureRepoPullRequest` per repository and the close-out. The hosted
entrypoint re-implemented a narrow slice of it, and that slice shaped everything downstream — a
per-repository git credential, a one-card allow-list, a single pull request in the end path.

## Decision

1. **The container runs the CLI.** The hosted image installs the CLI (with `git`, `gh`, OpenCode and
   codegraph) and runs `motir run <KEY>` — or `motir continue <KEY>` — in a hosted mode. A leaf, a
   multi-repository leaf and a parent then behave exactly as they do on a laptop: a checkout, a
   branch and a pull request per repository; for a parent, one session branch per repository, each
   child in order, `mark_integrated` per child, one draft pull request per repository opened at the
   first child that lands and made ready at close-out. The entrypoint is reduced to a launcher; what
   it did that the CLI does not — launching OpenCode on the gateway key per the egress contract,
   setting up codegraph — moves into the CLI's hosted mode.
2. **A run's unit is the RUN.** Its repositories are the union of its legs' `targetRepos`, in project
   repository order. Every credential, check, allow-list and end-path step below is sized to the
   run — never to one card or one repository.
3. **The server opens the run; the CLI adopts it.** `DispatchRun.id` stays the one id
   (`hosted-agent-run.md` §1). The start path opens the run with one leg per card — the leaf, or
   every member the parent's scope claim yields, in claim order — and the CLI adopts it
   (`reporter.adopt`, as `motir fix` already does) instead of opening its own. The CLI closes the
   run it adopted, exactly as a local run closes; the server's end path closes it only when the CLI
   never did (a crash, a cancel, a stall, the backstop, a lost supervision chain), and never links a
   pull request or writes a card status itself.
4. **The run credential reaches what `motir run` needs, for the run's legs only.** It is still one
   `ApiToken`, bound to the run and owned by the dispatcher (§3), but its allow-list is the set of
   routes a `motir run` / `motir continue` of that run calls: claim and scope claim, each leg's
   dispatch prompt, the run's events and close, integration, pull-request linking, session
   completion, status transitions, the reads they make, and the git-credential route. Each is
   honoured only for the run and its legs' cards. `POST /api/v1/dispatch-runs` stays refused, and it
   holds no `ai:*` key.
5. **Git writes as Motir's App, never as a person.**
   - A repository **Motir created** (`ProjectRepo.state = created`) is written by **`motir-studio`**;
     a **connected** one (`state = connected`) by its **Motir Integration** installation.
   - The credential is always an **installation access token**: uncached, minted **one per App
     installation the run's repositories span**, narrowed with `repository_ids` to exactly the run's
     repositories in that installation and to `contents: write` + `pull_requests: write` — ~~never
     `workflows`~~ plus `workflows: write` when the installation holds it (AMENDMENT 2026-10-29
     below), never `administration`.
   - It lives one hour. The CLI's `git` and `gh` obtain it through a credential helper that calls
     the run's git-credential route with the run credential — for the clone, every push and every
     pull request — so **no git token is ever in the container's environment**.
   - Every token minted is recorded against the run and revoked (`DELETE /installation/token`) when
     the run ends.
6. **Authorship.** Commits are authored and committed as the bot of the App that writes their
   repository (`<slug>[bot]`, `<bot user id>+<slug>[bot]@users.noreply.github.com`); pull requests
   are opened by that App. **Every pull request body names the dispatcher** by their Motir name and
   links the card and the run. No commit carries a person's name or email: a person's address is
   not written into a repository's permanent history, and Motir's run record already says who
   dispatched it.
7. **Where the lock is.** As in a local run, the agent itself commits and pushes, so the agent can
   reach git. The bound on it is the credential's own scope — the run's repositories, two
   permissions, dead within an hour and revoked at the run's end — which is where the egress
   contract (§4) already puts the lock. The run credential and the gateway key are kept out of the
   agent's environment, as before.
8. **A run that cannot write is refused before anything boots**, only for connected repositories,
   listing **every** repository of the run that cannot be written, each with its reason verbatim:
   - _"Motir Integration can no longer reach owner/name — reconnect it in the Repositories room"_ —
     the installation is gone or suspended, or no longer includes the repository;
   - _"hosted runs on owner/name need Motir Integration's updated permissions — an owner of
     &lt;account&gt; accepts them on GitHub"_ — the installation has not accepted write.

   A Motir-created repository has no refusal: a failed mint there is a run failure, recorded as
   such.

9. **The person's GitHub identity is untouched.** MOTIR-1498's link stays what it is (import,
   organisation listing) and plays no part in a hosted run. MOTIR-6519's expiring-token support has
   no consumer and is removed before the 9.1 branch merges (MOTIR-6556); Motir Integration's user
   tokens are **not** switched to expiring.

**Rejected alternatives:**

- **Person-authored pull requests** (§4, and MOTIR-6522's user-token branch). They make the pull
  request the dispatcher's, but only for a dispatcher with a linked GitHub account — and every
  dispatcher without one is refused. Copilot's cloud agent and Jules open their pull requests as
  their App and name the person, which is what this does.
- **Extending the bespoke entrypoint** to several repositories and to parents. It would be a second
  copy of the CLI's drain — claims, ordering, session branches, integration, draft pull requests,
  close-out — to keep in step with the first for ever.

## Consequences

- **A dispatcher needs a Motir account, credits and a ready card — nothing on GitHub.** The team
  that owns a connected repository accepts Motir Integration's write permissions once (an owner of
  that GitHub account); Motir-created repositories need nothing.
- **Hosted runs cover every shape local runs cover**, and a dead hosted run is continued with the
  same `motir continue`, in the same image (MOTIR-6527).
- **The CLI gains a hosted mode** (MOTIR-6558, MOTIR-6559): adopting a server-opened run, working
  without a `.motir.json`, the hosted environment names, a built-in OpenCode launcher and a git
  credential helper. Runs without `MOTIR_DISPATCH_RUN_ID` are unchanged.
- **The run credential is wider than §3's**, bounded by the run's legs rather than one card
  (MOTIR-6557). The accepted routes are one table in code, pinned against the CLI client's calls.
- **Pull requests show Motir's App as their author**, not the dispatcher. Who dispatched a run is in
  the pull request body and on the run.

---

## AMENDMENT 2026-10-29 — a run's token carries `workflows: write`

> **AMENDED 2026-10-29.** §5's _"never `workflows`"_ is withdrawn, struck through rather than
> deleted. It also withdraws `hosted-run-one-github-app.md` §2's _"Never `workflows`"_ and
> `hosted-agent-run.md` §4's _"`workflows: write` is deliberately NOT requested"_, which this record
> had left standing.

**Decided by:** Yue, 2026-10-29, after MOTIR-9928's `.github/workflows/aws-deploy.yml` never reached
`main`: _"motir-integration should be able to change the workflow, this happened too many times.
motir-integration will also update the user's repo too later"_.

**Why.** A card whose deliverable is a workflow file could not be delivered by a run. GitHub refused
the push, the run shipped the file as a patch for a person to apply, and nothing made sure anyone
did. PR #3850 merged without its workflow, and MOTIR-9928 was closed Done anyway. The failure was
silent, and it recurs, because CI is ordinary work on a card. Motir Integration will also maintain
CI in the repositories teams connect, which it cannot do without this permission.

**What changes.**

1. **Motir Integration requests `workflows: write`** beside `contents: write` and
   `pull_requests: write`. Existing installations get GitHub's request to accept the new
   permission, as they did for write access (`hosted-run-one-github-app.md` Consequences).
2. **A build run's token adds `workflows: write` when the installation holds it**
   (`RUN_GIT_WORKFLOWS_PERMISSION` in `lib/github/runGitCredential.ts`). It is not one of §8's
   preconditions: an installation that has not accepted it is not refused. Its runs push as before,
   and a change to `.github/workflows/` fails at push with GitHub's own message. The mint asks only
   for what the installation holds, because GitHub refuses the whole token when a narrowing names a
   permission the installation lacks.
3. **`motir-studio` follows the same rule.** It already holds `workflows: write`
   (`unlinked-pull-request-check.md`'s App table), so runs on Motir-created repositories gain it
   too. A review run stays at `contents: read`.

**What it accepts, plainly.** A run's branch can now change the CI that GitHub runs on that branch.
Workflows triggered by `push` or by a same-repository `pull_request` run with the repository's
Actions secrets, so an agent can, in principle, write a workflow that reads them. These still bound
it:

- the token is the run's: its repositories only, dead within an hour, revoked at the run's end
  (§5, §7);
- a run pushes branches and opens pull requests. Whether a change reaches the default branch is
  decided by that repository's branch protection, merge queue and review, not by this token;
- a secret scoped to a protected **environment**, or a cloud role whose OIDC trust names
  `refs/heads/main` (as motir-infra's deploy roles do), is unreachable from a run's branch.

`administration` stays withheld: a run must not be able to change the protection that gates its own
merge.

---

## What this does NOT decide

- **Moving Motir-created repositories to user-authored pull requests** — repository handover,
  MOTIR-711.
- **Anything Motir Integration reads or syncs** for project tracking.
- **The copy and layout of the surfaces** — MOTIR-6518's design.
- **How a dead hosted run is continued from the browser** beyond "it runs `motir continue` in the
  same image" — MOTIR-6527.
- **How a hosted run is priced** — `hosted-agent-machine-charge.md` and the agent lane.
