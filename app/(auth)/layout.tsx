import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { type ReactNode } from 'react';
import { BrandMark } from '@/components/brand/BrandMark';
import { Background } from '@motir/design-system';
import { AuthLanguageControl } from '@/components/i18n/AuthLanguageControl';

/**
 * Shared frame for the auth pages (sign-in, sign-up, reset-password,
 * reset-password/[token]). A white card centered on a tinted page
 * background — see design/auth/* for the original Story-1.1 mockups
 * and the v1.1.10 update note in MOTIR.md.
 *
 * THE WORDMARK IS NO LONGER ABSENT. The deferral this docstring used to record
 * is closed by MOTIR-1150: the horizontal lockup at 28px, top-left of the card,
 * `design/brand/design-notes.md` §7b. It lives HERE rather than on each page so
 * all five auth screens inherit it from one place.
 *
 * ⚠️ WITH ONE EXCEPTION — `/device`, and it is a MEASUREMENT, not a taste call.
 * That screen's confirm step is the product's one auth-time DECISION screen, and
 * its fold budget is measured: `design/cli-connect/design-notes.md` recorded the
 * single-column form at 1106px (which is why `AuthShell`'s `tight` mode and this
 * layout's `data-auth-wide` widening exist at all), and the wide rebuild landed
 * at a 622px page inside a 1366×648 viewport — 26px of headroom, all of it.
 * That figure was taken with THREE scope rows. The scope list is derived from
 * `CLI_TOKEN_GRANT`, which now carries ten, and at ten the same screen measured
 * a 754px page with Approve/Deny ending at 702px — below the fold (MOTIR-7818).
 * The budget is now held where the list lives, in `DeviceApproval`, and is
 * asserted by `tests/e2e/cli-connect.spec.ts` rather than recorded here.
 *
 * So the question this card had to answer was how tall the new row actually is.
 * Measured in Chromium at 1366×648 against `design/brand/brand-mark.mock.html`
 * (which inlines the real Tailwind output and the real theme.css, so the numbers
 * are the shipped ones): the 28px lockup renders 28px tall and the mark-only
 * form 24px. Both then pay this column's `gap-8` on top — 60px and 56px — which
 * puts the page at 682px or 678px against a 648px viewport and pushes
 * Approve/Deny below the fold. That is precisely the failure the wide rebuild
 * bought back, on the one screen where the reader must SEE what they are
 * approving. Neither of §7b's two options fits, so the third thing it allows is
 * what ships: the lockup is SUPPRESSED on the wide screen. Every other auth
 * screen keeps it.
 *
 * Width pinned to a literal value rather than `max-w-md`: the design
 * system's @theme block defines a custom `--spacing-md` (= 16px)
 * which Tailwind v4 resolves into the default `max-w-md` utility —
 * leaving the column 16px wide. Pinning the card width here keeps
 * the design-system token set un-touched and the layout predictable.
 *
 * ONE page in this group is wider, and it says so from the inside:
 * `/device`'s confirm screen (Subtask MOTIR-1867) renders a two-column
 * detail block at 40rem, because `design/cli-connect/design-notes.md`
 * MEASURED the single-column 28rem version at 1106px tall — overflowing
 * every laptop, which puts Approve below the fold and lets the reader
 * scroll PAST the four facts the screen exists to make them read. The
 * `has-[…]` variant is how a descendant widens an ancestor it cannot
 * otherwise reach; every other page renders no `data-auth-wide` and is
 * byte-identical to before.
 *
 * The wide state also tightens the page's and the card's own vertical
 * padding (py-12 → py-8, py-10 → py-5, the mock's figure). That is the
 * cheapest 36px in the fold budget: it is whitespace AROUND the content,
 * so nothing the reader has to read gets compressed to buy it. Measured
 * in Chromium at 1366×648 after the change — card 558px, page 622px,
 * both CTAs ending at 590px, no scroll (three scope rows). With the ten-key
 * grant and MOTIR-7818's rebalanced detail box: page 683px, both CTAs ending
 * at 631px — the page scrolls only through its own bottom padding, and both
 * buttons are on screen without it.
 *
 * ⚠️ AND ONE WIDE PAGE IS WIDER STILL — the OAuth consent screen, which
 * renders `data-auth-wide="consent"` (MOTIR-7380, built to
 * `design/auth/oauth-consent--sticky-actions.mock.html`). At `lg` its card is
 * 64rem in two panes; below `lg` it is the same 40rem as the bare variant. The
 * `lg:` prefix is what lets the one value override the other (a breakpoint
 * variant sorts after the bare one). Its card also gives up its bottom padding
 * (`pb-0`, marked important because it must beat the wide variant's own `py-5`, whose
 * sort order against it is not guaranteed) and its narrow side padding drops to `px-4`, because the pinned
 * action bar is the card's last child and carries both itself. `/device` and
 * `/two-factor-required` render the bare attribute and are unchanged.
 *
 * THE LANGUAGE CONTROL (MOTIR-7758) sits in the PAGE's top-right corner, on the
 * wash, OUTSIDE the card — `design/auth/design-notes.md` § _The language control
 * on the signed-out frame_, which measured the placements against this frame.
 * The outer `div` is `relative` and the control's `<header>` is its first
 * child, `absolute top-2 right-6 z-10`: out of the centred column's flow, so it adds
 * nothing to the card's height or the page's (the `/device` fold figures above
 * hold with it), and first in the DOM, so it is first in the tab order. It ends
 * at 44px, inside the 48px `py-12` top padding. The one frame change it needs is
 * that the wide screen's page tightening is scoped to `lg:`
 * (`lg:has-[[data-auth-wide]]:py-8`): between 640px and ~930px the 40rem card
 * would otherwise sit under the corner, so below `lg` the wide screen keeps
 * `py-12`. That costs `/device` 32px of PAGE height below `lg`, where no fold
 * budget was measured, and no card height anywhere.
 *
 * THE WAVE LINES behind the card are motir.co's hero background — the design
 * system's Wave (`<Background id="wave">`, MOTIR-11608), drawn in the visitor's
 * style, palette and mode — so arriving from the marketing site does not feel
 * like changing products. Motir's own sign-in page always draws the Wave; it is
 * not a per-project choice. The
 * canvas is `absolute inset-0 -z-10` inside this `relative isolate` frame: out of
 * flow (no fold cost), above the wash and under everything else. It comes after
 * the `<header>`, which stays the first child. The card carries `id="auth-card"`
 * because that is what the lines gather around.
 */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations('auth');
  return (
    <div className="relative isolate flex min-h-dvh w-full items-center justify-center overflow-x-clip bg-(--el-auth-wash) px-6 py-12 sm:px-10 lg:has-[[data-auth-wide]]:py-8">
      {/* A `<header>` (the banner landmark) rather than a bare `div`, so the
          control is inside a landmark like everything else on the page. */}
      <header className="absolute top-2 right-6 z-10">
        <AuthLanguageControl />
      </header>
      <Background id="wave" focusId="auth-card" />
      <main className="w-full max-w-[28rem] has-[[data-auth-wide]]:max-w-[40rem] lg:has-[[data-auth-wide=consent]]:max-w-[64rem]">
        {/* The card is the brand row's column: `gap-8` matches the rhythm
            `AuthShell` already sets inside itself, so the lockup reads as the
            first item of one stack rather than a header bolted on top.
            `display:none` (not `invisible`) is what removes the gap too, so the
            wide screen is byte-identical to what it measured at. The variant is
            written as ONE arbitrary selector rather than a stacked
            `has-…:[&_…]` pair so what it compiles to is not in doubt. */}
        <div
          id="auth-card"
          className="flex flex-col gap-8 rounded-(--radius-card) bg-(--el-page-bg) px-(--spacing-card-padding) py-10 shadow-(--shadow-elevated) [&:has([data-auth-wide])_[data-brand-lockup]]:hidden sm:px-10 has-[[data-auth-wide]]:py-(--spacing-card-padding-16) sm:has-[[data-auth-wide]]:px-8 has-[[data-auth-wide=consent]]:px-(--spacing-card-padding-16) has-[[data-auth-wide=consent]]:pb-0!"
        >
          {/* Decorative glyph + visible wordmark, so the link takes its name
              from the text and carries NO `aria-label` — §8's "never both". */}
          <Link href="/" data-brand-lockup className="self-start">
            <BrandMark size={28} label={t('brand')} />
          </Link>
          {children}
        </div>
      </main>
    </div>
  );
}
