import {
  Caveat,
  Fira_Sans,
  Fraunces,
  IBM_Plex_Mono,
  Inter,
  JetBrains_Mono,
  LXGW_WenKai_TC,
  M_PLUS_Rounded_1c,
  Nanum_Gothic,
  Noto_Sans_JP,
  Noto_Sans_KR,
  Noto_Sans_SC,
  Noto_Sans_TC,
  Noto_Serif_JP,
  Noto_Serif_KR,
  Noto_Serif_SC,
  Noto_Serif_TC,
  Nunito,
  Roboto_Slab,
  Source_Serif_4,
  Space_Grotesk,
} from 'next/font/google';

// The app's font families, declared ONCE for the two documents that own an
// `<html>` element: the root layout (`app/layout.tsx`) and the root error
// boundary (`app/global-error.tsx`), which REPLACES that layout when it throws
// and so has to bring its own fonts (MOTIR-6855 · design MOTIR-6854,
// `design/shell/design-notes.md` § The server-error page). Each family exposes a
// CSS variable that `app/globals.css` composes into `--font-sans` / `--font-serif`
// / …; without these classes on `<html>` the serif title falls back to Georgia.

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans-source',
  display: 'swap',
});

const sourceSerif = Source_Serif_4({
  subsets: ['latin'],
  variable: '--font-serif-source',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono-source',
  display: 'swap',
});

// Mono-Technical type pairing (7.3.56) — IBM Plex Mono dresses the headline +
// meta/code roles; the Inter body is reused (one new face). Loaded here as its
// own `-source` var so the `[data-type='mono-technical']` block can point the
// `--font-serif` / `--font-mono` roles at it.
const ibmPlexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-mono-technical-source',
  display: 'swap',
});

// The Grotesk type pairing's display face (Subtask 7.3.54). Not a base role —
// it feeds ONLY the `[data-type='grotesk']` headline override in globals.css
// via `--font-grotesk-source`; the base roles stay Inter / Source Serif / mono
// when the pairing is not selected, so this adds payload only for that pairing.
const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-grotesk-source',
  display: 'swap',
});

// The Editorial type pairing's display serif (Subtask 7.3.55) — Fraunces. Not a
// base role: it feeds ONLY the `[data-type='editorial']` headline override in
// globals.css via `--font-editorial-source`, re-pointing the `--font-serif` role
// while body (Inter) and meta (JetBrains) keep the base roles. Loaded as the
// variable font (optical sizing for display) so it only pays its weight when a
// user picks Editorial.
const fraunces = Fraunces({
  subsets: ['latin'],
  variable: '--font-editorial-source',
  display: 'swap',
});

// The Marker type pairing's display face (MOTIR-10553) — Caveat, a casual
// hand-lettered marker. Not a base role: it feeds ONLY the `[data-type='marker']`
// headline override in theme.css via `--font-marker-source`, re-pointing the
// `--font-serif` role while body (Inter) and meta (JetBrains) keep the base roles.
// Loaded as the variable font, so it only pays its weight when a user picks
// Marker (or Hand-Drawn / Indie, whose default it is).
const caveat = Caveat({
  subsets: ['latin'],
  variable: '--font-marker-source',
  display: 'swap',
});

// The Rounded type pairing's face (MOTIR-10554) — Nunito, a rounded-terminal
// sans. Not a base role: it feeds ONLY the `[data-type='rounded']` override in
// theme.css via `--font-rounded-source`, which re-points both the headline and
// body/UI roles; the base roles stay Inter / Source Serif / mono when the pairing
// is not selected, so this adds payload only for that pairing.
const nunito = Nunito({
  subsets: ['latin'],
  variable: '--font-rounded-source',
  display: 'swap',
});

// The Slab type pairing's display face (MOTIR-10555) — Roboto Slab. Not a base
// role: it feeds ONLY the `[data-type='slab']` headline override in theme.css via
// `--font-slab-source`, re-pointing the `--font-serif` role while body (Inter)
// and meta (JetBrains) keep the base roles. Loaded as the variable font, so it
// only pays its weight when a user picks Slab.
const robotoSlab = Roboto_Slab({
  subsets: ['latin'],
  variable: '--font-slab-source',
  display: 'swap',
});

// The Humanist type pairing's face (MOTIR-10556) — Fira Sans, a humanist UI
// sans. Not a base role: it feeds ONLY the `[data-type='humanist']` override in
// theme.css via `--font-humanist-source`, which re-points both the headline and
// body/UI roles. A static family, so next/font needs its weights listed: the four
// the UI uses (regular, medium, semibold, bold).
const firaSans = Fira_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-humanist-source',
  display: 'swap',
});

// ── Font sets (Story MOTIR-7733 · MOTIR-7847) ─────────────────────────────
// One loader per FACE in `FONT_SET_REGISTRY` (`@motir/design-system`,
// `fontSets.ts`): the CJK faces each locale's script is drawn in, behind the
// pairing's Latin faces. `variable` is the name `fontSetMemberVar(set, role,
// member)` returns; next/font only accepts literal options, so the names are
// written out and `tests/theme/fontSetFaces.test.ts` holds them to the registry.
// A CJK mono role re-uses its set's sans face (`sameFaceAs`), so it has no
// loader of its own.
//
// Declaring a face downloads nothing by itself. It emits `@font-face` rules,
// one per `unicode-range` slice, and the browser fetches a slice only when an
// element's `font-family` names the family AND a rendered character falls in
// that slice. A family is named only under its own `:lang()` block in
// `theme.css`, so an English page fetches no CJK file and a ja page no zh or ko
// file. `preload: false` keeps every CJK file out of the preload list, which
// would otherwise download it on every page. No `subsets`: next/font fetches
// every slice regardless and uses `subsets` only to choose what to preload.
// Static faces declare dooooWeb's two weights, `400` and `700`
// (`docs/typography/font-sets.md`). The zh-Hant faces (MOTIR-9239) are named
// only under `:lang(zh-TW)`, which no core page renders, so they fetch nothing
// here; motir.co loads them for `/zh-tw`.

const notoSansSC = Noto_Sans_SC({
  variable: '--font-set-zh-Hans-sans-noto-sans-sc',
  display: 'swap',
  preload: false,
});

const notoSerifSC = Noto_Serif_SC({
  variable: '--font-set-zh-Hans-serif-noto-serif-sc',
  display: 'swap',
  preload: false,
});

const lxgwWenKaiTC = LXGW_WenKai_TC({
  weight: ['400', '700'],
  variable: '--font-set-zh-Hans-serif-lxgw-wenkai-tc',
  display: 'swap',
  preload: false,
});

const notoSansTC = Noto_Sans_TC({
  variable: '--font-set-zh-Hant-sans-noto-sans-tc',
  display: 'swap',
  preload: false,
});

const notoSerifTC = Noto_Serif_TC({
  variable: '--font-set-zh-Hant-serif-noto-serif-tc',
  display: 'swap',
  preload: false,
});

const lxgwWenKaiTCHant = LXGW_WenKai_TC({
  weight: ['400', '700'],
  variable: '--font-set-zh-Hant-serif-lxgw-wenkai-tc',
  display: 'swap',
  preload: false,
});

const notoSansJP = Noto_Sans_JP({
  variable: '--font-set-ja-sans-noto-sans-jp',
  display: 'swap',
  preload: false,
});

const mPlusRounded1c = M_PLUS_Rounded_1c({
  weight: ['400', '700'],
  variable: '--font-set-ja-sans-m-plus-rounded-1c',
  display: 'swap',
  preload: false,
});

const notoSerifJP = Noto_Serif_JP({
  variable: '--font-set-ja-serif-noto-serif-jp',
  display: 'swap',
  preload: false,
});

const notoSansKR = Noto_Sans_KR({
  variable: '--font-set-ko-sans-noto-sans-kr',
  display: 'swap',
  preload: false,
});

const nanumGothic = Nanum_Gothic({
  weight: ['400', '700'],
  variable: '--font-set-ko-sans-nanum-gothic',
  display: 'swap',
  preload: false,
});

const notoSerifKR = Noto_Serif_KR({
  variable: '--font-set-ko-serif-noto-serif-kr',
  display: 'swap',
  preload: false,
});

// MOTIR-2505 — a FUNCTION, not `export const metadata`. The object carries
// `metadataBase`, which is read from the environment, and a static export is
// evaluated at module load — build time for a statically-rendered route, where
// `MOTIR_BASE_URL` is deliberately unset (the Dockerfile sets only the
// placeholders module-load checks need). That would freeze the localhost
// fallback into the output. See `lib/rootMetadata.ts` for the whole reasoning;
// the two exports are mutually exclusive, so this replaced the const.

/** Every family's variable class, for an `<html>` element's `className`. */
export const fontVariables = [
  inter.variable,
  sourceSerif.variable,
  jetbrainsMono.variable,
  ibmPlexMono.variable,
  spaceGrotesk.variable,
  fraunces.variable,
  caveat.variable,
  nunito.variable,
  robotoSlab.variable,
  firaSans.variable,
  notoSansSC.variable,
  notoSerifSC.variable,
  lxgwWenKaiTC.variable,
  notoSansTC.variable,
  notoSerifTC.variable,
  lxgwWenKaiTCHant.variable,
  notoSansJP.variable,
  mPlusRounded1c.variable,
  notoSerifJP.variable,
  notoSansKR.variable,
  nanumGothic.variable,
  notoSerifKR.variable,
].join(' ');
