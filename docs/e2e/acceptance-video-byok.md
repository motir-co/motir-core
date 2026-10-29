# Acceptance-video recording + upload (BYOK)

> ## The uploader and its Action are back (MOTIR-7253, 2026-10-01)
>
> `scripts/upload-acceptance-video.mjs` and `.github/actions/upload-acceptance-video/`
> were retired on 2026-09-01 (MOTIR-4096), when the agent took over publishing over
> MCP, and RESTORED on 2026-10-01: for the repositories Motir writes itself —
> motir-core and every project generated from `nextjs-prisma-serverless-starter` — CI
> publishes the receipt again, from a green `pull_request` run, over keyless GitHub
> OIDC only (`docs/decisions/acceptance-video.md`, the 2026-10-01 amendment). Two
> things differ from the copy this page first described: `producedByKey` is no longer
> an input — the script sends the PR's own card key, so a CI and an MCP publish of
> one commit collapse to one receipt — and a closed story's
> `ACCEPTANCE_EVIDENCE_STORY_CLOSED` refusal is reported as skipped. The MCP door
> (`create_acceptance_upload` + `publish_acceptance_result`) stays open for every
> other repository.

Story **MOTIR-1627** closes the review loop with a human **acceptance gate**: a
story's E2E, on a green run, records a short **video**; CI ships it to the story
as pending acceptance evidence; a reviewer watches it in the acceptance panel and
Approves (`in_review → done`) or Requests changes.

This is the **BYOK** (bring-your-own-CI) delivery path — your own GitHub Actions
run the acceptance E2E and POST the clip to Motir. (Epic 9's hosted runner does
the same from its own sandbox — a separate concern.)

## Pieces (Subtask MOTIR-1632)

| Piece                                     | What it does                                                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `playwright.acceptance.config.ts`         | A dedicated lane that records `video: 'on'` (720p) + `trace: 'on'`, matching `**/acceptance-video.spec.ts`. |
| `tests/e2e/_helpers/acceptance-video.ts`  | `test` + `chapter(label, body)` — a chaptered `test.step` that also writes a `chapters.json` sidecar.       |
| `scripts/upload-acceptance-video.mjs`     | Reads the video + trace + chapters from the lane's `outputDir` and POSTs them to the publish endpoint.      |
| `.github/actions/upload-acceptance-video` | A composite Action wrapping the uploader for easy reuse.                                                    |

## The acceptance spec (authored by MOTIR-1638)

Import the harness and wrap each user-visible phase in a `chapter`:

```ts
import { test, expect } from './_helpers/acceptance-video';

test('story acceptance flow', async ({ page, chapter }) => {
  await chapter('Open the story', async () => {
    await page.goto('/items/MOTIR-1627');
    await expect(page.getByRole('heading', { name: /acceptance gate/i })).toBeVisible();
  });
  await chapter('Watch the evidence + approve', async () => {
    /* … */
  });
});
```

Keep the spec **short** (≤ ~60 s) — it is a focused happy-path drive, and the
clip is capped to a few MB per the ADR.

## Run + upload in CI (keyless — no secret)

If your repo is connected via the **Motir GitHub App**, publishing is **keyless**
— there is **no token to mint or store**. Grant the job `id-token: write` and the
uploader authenticates off the run's own GitHub **OIDC** identity:

```yaml
# In the acceptance E2E job, AFTER the app + acceptance E2E succeed:
jobs:
  acceptance:
    permissions:
      contents: read
      id-token: write # ← lets the uploader mint a keyless OIDC token
    steps:
      - name: Acceptance E2E (records the video)
        run: pnpm exec playwright test --config playwright.acceptance.config.ts

      - name: Publish the acceptance video (green only)
        if: success() && github.event_name == 'pull_request'
        uses: ./.github/actions/upload-acceptance-video
        with:
          # Resolve the target story from the PR instead of a hardcoded key
          # (MOTIR-1684): the PR's `MOTIR-<id>` → its parent story.
          pr-ref: ${{ github.head_ref }}
          pr-title: ${{ github.event.pull_request.title }}
          fallback-story-key: MOTIR-1627 # used when nothing else resolves a story
          # Publish only the specs THIS PR changed (MOTIR-1937 — see below).
          changed-specs: ${{ steps.owned-specs.outputs.specs }}
          # no `token:` — keyless OIDC. base-url defaults to https://app.motir.co
```

`if: success()` (plus the uploader's own no-video no-op) guarantees a **red run
publishes nothing**. The endpoint verifies the run's OIDC token, resolves the
repo → your Motir workspace (via the GitHub App connection), and attributes the
evidence to the **workspace owner** — subject to the same eligibility gate as the
in-app path (an org without the paid AI plan is rejected `402`).

### Which recordings a run may publish — `changed-specs` (MOTIR-1937)

**Publish only the receipts for the acceptance specs the run actually changed.**
Publishing **supersedes**: a new green run retires the story's previous evidence and
unlinks its video for the orphan-GC. And the target story comes from the
**recording's own sidecar**, which outranks the PR ref — so each recording resolves
to _its_ story regardless of which branch ran the lane. Put those together and a lane
that runs on every PR replaces the receipts of every story that has a chaptered spec,
with clips no reviewer watched. That happened in Motir's own CI: one backend PR
republished **seven** already-accepted stories.

Compute the list from the PR diff and pass it in:

```yaml
- name: Which acceptance specs does this run own?
  id: owned-specs
  env:
    BASE_SHA: ${{ github.event.pull_request.base.sha }}
  run: |
    set -euo pipefail
    if [ -z "${BASE_SHA}" ]; then echo "specs=" >> "$GITHUB_OUTPUT"; exit 0; fi
    echo "specs=$(git diff --name-only "${BASE_SHA}" HEAD -- 'tests/e2e/acceptance*.spec.ts' | tr '\n' ' ')" >> "$GITHUB_OUTPUT"
```

**Do not gate on the branch instead.** "Publish only from `main`" looks equivalent and
breaks the flow: the acceptance panel's approve edge is `in_review → done`, and
`in_review` is the **PR-open** state (the status sync flips the card to `done` on
merge). The receipt must exist while the PR is open, or the reviewer never gets to
watch-then-approve.

An un-owned recording is still discovered, resolved and checked against the
watchability floor — only the WRITE is scoped — so a PR keeps the full signal,
including a non-zero exit for an unpaced clip. The gate **fails closed**: an empty or
unset `changed-specs` owns nothing, and so does a recording whose sidecar carries no
`specFile`.

### The per-file size cap — `max-artifact-bytes` (MOTIR-1911)

Every artifact a recording publishes — the video AND the trace — is uploaded against
the workspace's **per-file entitlement** (`resolvePerFileLimitBytes`: **10 MB**
baseline, **100 MB** on a cloud `scaled` org), bound into the client upload token as
`maximumSizeInBytes`. This is Motir's own cap, **not** a Vercel Blob platform limit,
even though the failure reads like one ("File is too large, the file length cannot be
greater than 104857600 bytes").

The uploader measures both artifacts **before authenticating**, beside the
watchability verdict, and reports through the same annotation + job-summary channels.
The policy differs per artifact, because they are not equally important:

- an over-cap **trace** is **DROPPED** — the video publishes without it, with a
  `::warning::`, and the step stays green. The trace is a debugging aid; refusing to
  publish the receipt over it is what cost MOTIR-813 its evidence (a 113 MB trace
  beside a 6 MB clip);
- an over-cap **video** is **NOT published** — a `::error::` annotation, and the step
  exits non-zero. The video is the receipt; there is nothing to fall back to.

`max-artifact-bytes` defaults to **100 MB**, and **on Motir Cloud that is always the
right number** — so most callers never touch it. Publishing is gated on a paid AI plan
(`hasPaidAiPlan`), and a paid AI plan is the _same_ flag that lifts the cap
(`pmTierForOrg`: `aiIncludedSeat → 'scaled'` → 100 MB). An org without one is capped at
10 MB but gets a **402 before any upload**, so those 10 MB never bind anything. Every
org that can publish at all has 100 MB.

**Set it to `10485760` if you are SELF-HOSTING.** That is the one configuration where
the gate is open and the cap is tight: `resolvePerFileLimitBytes` returns the 10 MB
baseline from its `!isCloudBilling()` branch _before_ any tier is consulted, while
eligibility is separately ungated off-cloud (`applicable:false ⇒ eligible`). Leave it at
the default there and the up-front gate waves through artifacts your own store will
reject, and you get the failure at `put` time instead. The mint also returns its real
`maxBytes`, so that late failure at least names the file, its size and the cap.

Worth knowing at 10 MB: these clips run ~59 KiB/s at 720p (measured — MOTIR-813's is
104.7 s / 6,340,169 B), so the **video** arm trips at roughly **three minutes** of
recording off-cloud, versus ~29 minutes on cloud. Self-hosted, a long story's receipt is
a real possibility, not a theoretical one.

### How the target story is resolved (MOTIR-1684)

The publish is **not** pinned to a hardcoded story. `resolveStoryKey` picks the
target in precedence: **(1)** an explicit `story-key` (override); **(2)** the
recording's **self-declared story** — the `acceptance-story.json` sidecar the
acceptance harness writes when a spec calls `acceptanceStory('MOTIR-<id>')`
(authoritative for what the clip depicts, so the self-test dogfood always pins
to MOTIR-1627 and is never mis-attributed to an unrelated PR); **(3)** the PR's
`MOTIR-<id>` from `pr-ref` / `pr-title` — a **subtask** key resolves UP to its
**parent story** server-side (acceptance is story-level, Principle #18);
**(4)** `fallback-story-key`. Acceptance E2Es published from CI should pass
`pr-ref` + `pr-title` + `fallback-story-key`, or self-declare via the harness —
not a hardcoded `story-key`.

## Fallback — a `MOTIR_PUBLISH_TOKEN` secret (unconnected repos only)

If your repo is **not** connected via the Motir GitHub App, authenticate with a
token instead of OIDC:

1. In Motir, mint a **token** scoped to **`integration`** (Settings → Account →
   Tokens), bound to the workspace that owns the story.
2. Add it to your repo as a **`MOTIR_PUBLISH_TOKEN`** secret and pass it to the
   Action — you can then drop the `id-token: write` permission:

```yaml
- name: Publish the acceptance video (green only)
  if: success()
  uses: ./.github/actions/upload-acceptance-video
  with:
    story-key: MOTIR-1627
    token: ${{ secrets.MOTIR_PUBLISH_TOKEN }}
```

Same endpoint (`POST /api/work-items/<storyKey>/acceptance-evidence`) and the
same eligibility gate — only the authentication differs.
