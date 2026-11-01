# ADR: A hosted run writes with the GitHub App the person already has

- **Status:** Proposed (2026-09-26), for acceptance at this card's `decision_approval` gate
- **Card:** MOTIR-6522 · **Story:** MOTIR-683 (9.1, "A card runs on the hosted agent")
- **Decided by:** Yue, 2026-09-26, reviewing the first draft of MOTIR-6518's design: _"For hosted
  motir repo, motir studio app is already linked, it should be used for the run too. For user's own
  repo, motir integration app should be used for the run. Otherwise the user needs to connect 2
  github apps, confusing!"_ This record writes that direction down; it does not re-open it.
- **Consumed by:**
  - MOTIR-6523 (manual: grant the permissions, turn on expiring tokens, retire the Motir Agent app)
  - MOTIR-6519 (the Motir Integration identity expires and refreshes)
  - MOTIR-6449 (the run's git credential)
  - MOTIR-6518 (the design) and MOTIR-1895 (the surfaces)
- **Supersedes:**
  - MOTIR-685 — `hosted-agent-run.md` §4's **user-owned branch** (the Motir Agent user token and
    its refusal reason). §4's Motir-created branch stands unchanged.
  - MOTIR-1894 — the Motir Agent App registration and its "a separate App keeps Motir Integration
    least-privileged" rationale.
  - MOTIR-6519's first scope (a separate Motir Agent account link) and MOTIR-6518's first draft (a
    second account row and a second install), both drawn to that branch.

---

## Context

A hosted run pushes a branch and opens a pull request, so it needs a git credential. §4 of
`hosted-agent-run.md` split that by who owns the repository:

- a repository **Motir created** is written with `motir-studio`'s installation token, narrowed to
  that repository;
- a repository **the person owns** was to be written with the dispatcher's user token for a
  **separate, opt-in Motir Agent App**, because Motir Integration — the App every project installs
  to track work — was kept read-only on purpose.

The reason for keeping Motir Integration read-only is real: GitHub Apps have no optional
permissions, so adding write access asks **every** installation for it, including a team that only
tracks work. But the price was paid by exactly the person hosted runs are for: they would install
and authorize two Apps from the same vendor, and the product would need screens explaining the
difference. The first draft of the surfaces showed it plainly, and the review refused it.

## Decision

1. **One App per repository, the one the person already has.**
   - **Motir-created repository → `motir-studio`**, unchanged: an installation token narrowed to
     that one repository with `contents: write` + `pull_requests: write`, revoked at run end with
     `DELETE /installation/token`. The pull request is opened by `motir-studio[bot]` and names the
     dispatcher; commits are authored as the dispatcher.
   - **The person's own repository → Motir Integration**: the dispatcher's existing Motir
     Integration user token (the identity linked through MOTIR-1498). Commits and the pull request
     are theirs, shown with the Motir Integration badge. GitHub limits a user token to what both the
     person and the App's installation can reach, so the run also verifies that the installation
     covers the repository and holds the permissions below.
2. **Motir Integration gains `contents: write` + `pull_requests: write`. ~~Never `workflows`~~, never
   `administration`.** _AMENDED 2026-10-29: Motir Integration also requests `workflows: write`;
   see [`hosted-run-runs-the-cli-as-the-app.md`](hosted-run-runs-the-cli-as-the-app.md) AMENDMENT
   2026-10-29. The reason below is kept as the record of what was decided then._ An agent must not hold a token that can rewrite the CI that runs with the
   repository's secrets; a change touching `.github/workflows/` fails at push, as §4 already said.
3. **Motir Integration's user tokens become expiring** (8 hours, with a refresh token). A stored
   token that can write code must not live for ever. An identity linked before the switch keeps its
   non-expiring token until it is reconnected.
4. **Revocation differs by branch, deliberately.** A `motir-studio` installation token is minted for
   one run and revoked at its end. The dispatcher's identity token is **not** revoked at run end:
   it is the person's own link, shared by every run they start. What bounds a run's use of it is
   that the container is destroyed at teardown and the token itself expires within 8 hours.
5. **A run that cannot write is refused before anything boots**, with the one fix the person needs,
   verbatim:
   - _"connect GitHub to Motir to run hosted on owner/name"_ — no linked identity, or it expired;
   - _"the Motir Integration app is not installed on owner/name"_;
   - _"the Motir Integration app on owner/name needs the updated permissions accepted"_.
6. **The Motir Agent App is retired**: the App is deleted and its `GITHUB_AGENT_APP_*` secrets are
   removed (MOTIR-6523). Nothing reads them after this decision.

**Rejected: a separate opt-in App for write access** (§4's user-owned branch). It keeps the
tracking App least-privileged, but every person who wants hosted runs connects two Apps, and the
product has to teach the difference on two screens. Tools in this space install one GitHub App that
asks for write access up front.

## Consequences

- **The accepted cost: every Motir Integration installation is asked for write access.** GitHub
  sends existing installations a request to accept the new permissions. Until an admin accepts, that
  installation stays read-only and a hosted run on its repositories is refused with the third reason
  above. Yue accepted this: a tracking-only team is an intermediate state on the way to full
  automation, and a team that sees the App asking for write access knows why.
- **A person connects GitHub once.** On their own repository, hosted runs need nothing beyond the
  Motir Integration install and link they already use for tracking.
- **MOTIR-6519 is re-scoped** to make the existing identity expire and refresh; the separate Motir
  Agent link it first built is reverted.
- **MOTIR-6518 and MOTIR-1895 lose the second account row and the second install.** What remains is
  a reconnect state on the existing identity and, per repository, _ready_ / _install_ / _accept the
  updated permissions_.
- **MOTIR-6449 implements the two branches and the three refusals above.**

---

## What this does NOT decide

- **The Motir-created branch.** `motir-studio`'s narrowed installation token is §4's, unchanged.
- **Moving Motir-created repositories to user-authored pull requests** — repository handover,
  MOTIR-711.
- **Any change to what Motir Integration reads or syncs** for project tracking.
- **The copy and layout of the surfaces** — MOTIR-6518's design.
- **How a hosted run is priced** — `hosted-agent-machine-charge.md` and the agent lane.
