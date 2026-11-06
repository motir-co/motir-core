import { test, expect } from '@playwright/test';
import { resetDatabase } from './_helpers/db-reset';
import { signIn, startSignedOut } from './_helpers/shell-session';
import {
  openAgentSession,
  publishDesignResult,
  seedDesignApproval,
  servePublishedMock,
  type DesignApprovalSeed,
} from './_helpers/design-approval-seed';

// APPROVING A DESIGN THAT HAS NO PULL REQUEST — the story's end-to-end walk
// (Story MOTIR-4778 · Subtask MOTIR-4797).
//
// ⚠️ PROMOTED OUT OF THE ACCEPTANCE LANE (Bug MOTIR-5306, 2026-09-13). This was
// `acceptance-design-approval.spec.ts`, the story's acceptance RECEIPT. The story
// is `done`, so its receipt is frozen and — per
// `docs/decisions/acceptance-receipt-lifecycle.md` §3 — the spec leaves that lane.
// It is PROMOTED rather than retired because it is the only browser walk of the
// whole claim (a reader sees no verbs → the routed reviewer approves → the card
// the design blocked becomes ready); `approval-gate-repaint.spec.ts` covers the
// repaint alone. Every assertion is kept; the receipt's `chapter()`/`beat()`
// pacing and `acceptanceStory()` tag are gone (`test.step` keeps the structure),
// and the one assertion that had gone stale is updated to the product's current
// copy. It went red on main because MOTIR-5191 made the pending state name its
// approver — exactly the drift a lane that runs on every PR catches the day it
// happens, rather than when an unrelated PR next touches the acceptance lane.
//
// ════════════════════════════════════════════════════════════════════════════
// ⚠️ THE CARD'S 2026-09-08 AMENDMENT IS WHAT THIS FILE IS, and it is recorded
// here because a dropped criterion and an amended one look identical in a diff.
// ════════════════════════════════════════════════════════════════════════════
//
// MOTIR-4778 carried five features and now carries one. Everything about
// MERGING, the APPROVALS TAB, the ROUTING READ, `prMergeMode` and the REVIEW
// LINK moved to sibling stories under MOTIR-4878. So the walk the card's body
// describes is amended, not performed in full:
//
//   · step 3 (decide the MERGE gate)        — OUT: no merge gate in this story
//   · step 4 (a refusal, *not mergeable*)   — OUT: that refusal is the merge
//     seam's answer, and this story has no seam. The frame's OWN refusals
//     (`notAuthorised`, `superseded`, `alreadyDecided`) are covered at the
//     component altitude by `tests/components/approval-gate-control.test.tsx`
//   · step 6 (the tab's empty state)        — OUT: there is no Approvals tab in
//     this build. Verified rather than assumed — `ApprovalGateControl` has
//     exactly two mount points and both are the item page's design section
//   · steps 1 / 2 / 5 / 7                   — SURVIVE, and are the walk below
//
// VERIFIED BEFORE A LINE WAS WRITTEN, which is the card's own scaffold clause:
//
//   · the sign-in fixture — `shell-session.ts`, used by every acceptance spec
//   · a seedable design result — YES, and better than seedable: the awaiting
//     gate is created BY `designEvidenceService` at publish, so the spec
//     publishes for real through `publish_design_result` over `/api/mcp` with a
//     `CLI_TOKEN_GRANT` bearer. `design-result-publish.spec.ts` established
//     that this lane reaches `/api/mcp` and that the blob mock answers HEAD
//   · a second actor with a narrower permission — YES: `canDecide` is
//     *assignee OR reporter OR workspace manager*, so a plain workspace member
//     who is neither reaches the page and is offered nothing
//   · THE GITHUB SEAM — **NOT NEEDED, and that is the amendment's doing.** The
//     card asked for a merge stubbed at a seam the running server honours
//     because the original walk drove a merge. The design-only walk crosses no
//     process boundary at all: the decision is a server action, the status move
//     is `applyStatusTransition` in the same transaction, and readiness is
//     computed from the database. There is nothing outbound to stub, so the
//     card's own warning about `vi.mock` being unreachable from a spawned dev
//     server does not bite here. This is the finding the clause asked for,
//     reported rather than worked around
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// One thing, and it is the thing a green tick cannot show: that pressing
// Approve on THIS card moves work on ANOTHER one. The gate is not an opinion
// filed somewhere — it is the thing standing between a person and the next
// piece of work, and the clip's argument is the two item pages either side of
// one button.
//
// ⚠️ THE ROUTED REVIEWER DECIDES IN THE OVERLAY NOW (Story MOTIR-5215 · Subtask
// MOTIR-5229). The item page hands the decision over: an awaiting gate the reader
// may decide renders a call-to-action band with ONE control, *Review & approve*,
// which opens the approval overlay over the card. The walk's claim is unchanged —
// a reader sees no verbs, the routed reviewer approves, the blocked card becomes
// ready — and so is every assertion about it; the verbs are simply found, and
// pressed, inside the overlay, and the page is read after it closes.
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E): every wait is a rendered landmark
// or an element's own visible state — the state pill is set from the decide
// action's AUTHORITATIVE response (`setCurrent(result.gate)`), never
// optimistically. There is no `waitForTimeout`.

test.describe.configure({ timeout: 240_000 });

test.describe('a published design waits, the control clears it, and the work it held starts', () => {
  let seed: DesignApprovalSeed;

  test.beforeEach(async () => {
    await resetDatabase();
    seed = await seedDesignApproval('accept');
  });

  test('approving a design on the item page moves the card it was blocking', async ({
    page,
    baseURL,
  }) => {
    // The published mock's bytes, served at the app's content route so the
    // sandboxed frame can render them — and so the frame offers its verbs at all.
    // The why is at `servePublishedMock`; it moved there with this code so the
    // regression guard shares one copy (MOTIR-5118).
    await servePublishedMock(page);

    await test.step('An agent publishes the design — one call, a bearer, no browser', async () => {
      // The gate is not seeded: publishing is what CREATES it, with its subject
      // pinned to these bytes and its question routed to the card's assignee.
      const client = await openAgentSession(seed.token, baseURL!);
      const result = await publishDesignResult(client, seed.designKey);
      expect(result.isError ?? false, JSON.stringify(result.content)).toBe(false);
      await client.close();
    });

    await test.step('The work waiting on it cannot start — and says what it is waiting for', async () => {
      await signIn(page, seed.reviewerEmail, seed.password);
      await page.goto(`/items/${seed.dependentKey}`);
      await expect(page.getByRole('heading', { name: seed.dependentTitle })).toBeVisible();
      // The readiness banner, in its BLOCKED arm, naming the design card by key.
      // This is the "before" half of the story's whole claim.
      await expect(page.getByText('Blocked', { exact: true })).toBeVisible();
      await expect(page.getByText('Waiting on 1 work item')).toBeVisible();
      // ⚠️ `.first()` because the key is a link TWICE on this page — once in
      // the readiness banner's blocker list (`ReadinessBadge`) and once as
      // the blocked-by row in the relationships panel. Both are correct
      // evidence that this card names its blocker, and an unqualified
      // `getByRole` is a strict-mode violation rather than a stronger
      // assertion.
      await expect(page.getByRole('link', { name: seed.designKey }).first()).toBeVisible();
    });

    await test.step('A reader who may not decide is offered nothing to press', async () => {
      // ⚠️ THIS CHAPTER RUNS BEFORE THE DECISION, DELIBERATELY. The absence of
      // controls has to be read off an AWAITING gate — on a decided one every
      // verb is gone from everybody, and the assertion would pass without the
      // authority rule existing at all.
      await startSignedOut(page);
      await signIn(page, seed.readerEmail, seed.password);
      await page.goto(`/items/${seed.designKey}`);
      await expect(page.getByRole('heading', { name: seed.designTitle })).toBeVisible();

      // They see the QUESTION and the design — the frame is not hidden from them.
      //
      // The port group is the frame's own landmark and belongs to nothing else.
      // (`Design result` is the section card's title — since MOTIR-5569 the
      // frame renders flush in it and repeats no label of its own.)
      await expect(page.getByRole('group', { name: 'The subject being decided' })).toBeVisible();
      await expect(page.getByText('Awaiting', { exact: true })).toBeVisible();
      // The design inside the port: its mock frame. (AMENDMENT 4 — no inline note.)
      await expect(
        page.getByRole('group', { name: 'The subject being decided' }).locator('iframe').first(),
      ).toBeVisible();
      // Since MOTIR-5191 the pending state NAMES the person it waits on — the
      // seed's routed reviewer — rather than "this work item's assignee".
      // `exact`: since MOTIR-5528 the status control's held notice also says
      // "…is waiting on Robin Vale.", and a substring match finds both.
      await expect(
        page.getByRole('main').getByText('Waiting on Robin Vale.', { exact: true }),
      ).toBeVisible();

      // ⚠️ ABSENCE, NOT A DISABLED CONTROL — the card asks for exactly this
      // distinction. A disabled button still tells a reader the act is theirs
      // to be denied; the frame simply does not draw a verb it will not honour.
      await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Request changes' })).toHaveCount(0);
    });

    const dialog = page.getByRole('dialog', { name: `Design result for ${seed.designKey}` });

    await test.step('The person it was routed to is invited to decide — and decides full screen', async () => {
      await startSignedOut(page);
      await signIn(page, seed.reviewerEmail, seed.password);
      await page.goto(`/items/${seed.designKey}`);
      await expect(page.getByRole('heading', { name: seed.designTitle })).toBeVisible();

      // ⚠️ THE PAGE INVITES AND SUBMITS NOTHING (MOTIR-5229). One control, and no
      // verb anywhere on the card: the decision is made in ONE place.
      // Scoped to the SECTION that holds the gate: since MOTIR-4908 (MOTIR-5878) the page
      // header carries the decision-waiting marker, which also reads "Awaiting you".
      await expect(
        page
          .getByRole('main')
          .locator('[data-surface="card"]')
          .filter({ has: page.getByRole('heading', { level: 2, name: 'Design result' }) })
          .getByText('Awaiting you', { exact: true }),
      ).toBeVisible();
      // Scoped to the Design result section: the status control carries a
      // second door of the same name while this gate holds a move (MOTIR-5528).
      const door = page
        .getByRole('main')
        .locator('[data-surface="card"]')
        .filter({ has: page.getByRole('heading', { level: 2, name: 'Design result' }) })
        .getByRole('link', { name: 'Review & approve' });
      await expect(door).toHaveCount(1);
      await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Request changes' })).toHaveCount(0);

      await door.click();
      await expect(dialog).toBeVisible();

      // ⚠️ THE SHARED FRAME, ASSERTED AS THE FRAME. The card's surviving step 7
      // asks that this surface render the SAME control rather than a bespoke
      // panel of its own. The frame's OWN landmarks are what say so — the port
      // group `ApprovalGateControl` draws around whatever is being decided, its
      // state pill, and the kind-supplied consequence line — and none of them
      // is anything `DesignResultPanel` could produce by itself. (The band-1
      // kind label would read the same, but "Design result" is also the
      // enclosing `ContentSectionCard`'s title, so it identifies nothing.)
      await expect(dialog.getByRole('group', { name: 'The subject being decided' })).toBeVisible();
      await expect(dialog.getByText('Awaiting you', { exact: true })).toBeVisible();
      await expect(dialog.getByText(`Approving moves ${seed.designKey} to Done.`)).toBeVisible();

      // The design itself, inside the port — the thing they are deciding ABOUT.
      // Since AMENDMENT 4 that is the mock; the note is one link away.
      await expect(
        dialog.getByRole('group', { name: 'The subject being decided' }).locator('iframe').first(),
      ).toBeVisible();

      await expect(dialog.getByRole('button', { name: 'Request changes' })).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
    });

    await test.step('Approve — and the frame says what that will do before it does it', async () => {
      await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
      // The confirm band. Approving is TERMINAL for this kind, which is the
      // whole reason this verb confirms and Request changes does not.
      await expect(dialog.getByText('Approving this will:')).toBeVisible();
      await expect(
        dialog.getByText(`move ${seed.designKey} to Done, starting the work items waiting on it.`),
      ).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible();

      await dialog.getByRole('button', { name: 'Yes, Approve' }).click();

      // ⚠️ THE AUTHORITATIVE SIGNAL. This pill is rendered from the gate row the
      // decide action RETURNED (`setCurrent(result.gate)`), not from an
      // optimistic guess — so it is true only once the server has recorded the
      // decision, and it is what the rest of this walk waits on.
      await expect(dialog.getByText('Approved', { exact: true })).toBeVisible();
      // The verbs are gone because the question is answered, not because this
      // reader may not act.
      await expect(dialog.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);

      // Back to the card — the overlay closes onto the page it opened over.
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
      // After the decision nothing holds a move, so neither door remains.
      await expect(page.getByRole('link', { name: 'Review & approve' })).toHaveCount(0);
    });

    await test.step('The design card is Done, and the record says which version', async () => {
      // ⚠️ NO RELOAD — THE DEFECT IT WORKED AROUND IS FIXED (MOTIR-5118). This
      // chapter opened with `await page.reload()` and a block explaining that
      // the in-place refresh does not reach this rail. It does reach it; it was
      // not sufficient on its own, because the fresh tree arrived on a second
      // apply that intermittently went missing. `decideApprovalGateAction` now
      // revalidates this page on its own response, and the standing guard is
      // `tests/e2e/approval-gate-repaint.spec.ts`.
      //
      // So the receipt is stronger rather than merely shorter: a reviewer
      // watching the clip sees the card reach Done on the page they are already
      // looking at, which is what pressing Approve actually does.
      // At rest the status is a `StatusPill`, not a combobox — the picker only
      // exists while that field is being edited.
      // The rail's value — the header eyebrow's Done stamp says it too (MOTIR-10534).
      await expect(
        page.getByRole('complementary').getByText('Done', { exact: true }),
      ).toBeVisible();
      // The approval pinned the bytes it was about, so the record can still say
      // WHAT was approved rather than only that something was.
      await expect(page.getByText('Files kept')).toBeVisible();
    });

    await test.step('And the work it was holding up is ready to start', async () => {
      // ⚠️ THE ASSERTION THE WHOLE STORY IS FOR, and the one a
      // plausible-but-wrong build passes without. A gate that recorded an
      // opinion and moved nothing would leave this banner exactly as chapter
      // two found it — and everything the reviewer saw would still look right.
      await page.goto(`/items/${seed.dependentKey}`);
      await expect(page.getByRole('heading', { name: seed.dependentTitle })).toBeVisible();
      await expect(page.getByText('All blockers resolved')).toBeVisible();
      await expect(page.getByText('Blocked', { exact: true })).toHaveCount(0);
    });
  });
});
