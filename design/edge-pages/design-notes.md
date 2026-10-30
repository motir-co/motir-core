# Edge pages — design notes

The documents the edge answers on a customer's own domain when the lookup
resolved but there is nothing to forward to. The reader is not a Motir user:
they typed a domain they associate with one business. Each page says whose
address it is and why nothing is shown — and nothing else.

| Surface    | Mock                                                         |
| ---------- | ------------------------------------------------------------ |
| Edge pages | [`edge-pages.mock.html`](edge-pages.mock.html) — panels 1–14 |

The design-system reading and the `--el-*` vocabulary are
`design/hosting/design-notes.md`'s; the two-file area convention and the ink
rule are `design/workspace-address/design-notes.md`'s. Neither is edited here.
This area names no work item.

## Panels

| #   | Panel                                                    |
| --- | -------------------------------------------------------- |
| 1   | No-application page · desktop 1280                       |
| 2   | No-application page · narrow 390                         |
| 3   | No-application page · a 60-character name                |
| 4   | Members-only page · with its address · focus shown       |
| 5   | Members-only page · without an address                   |
| 6   | Members-only page · narrow 390, a long address           |
| 7   | Unavailable page · desktop 1280                          |
| 8   | Unavailable page · narrow 390                            |
| 9   | Unavailable page · a 60-character name                   |
| 10  | Not-found page · desktop 1280                            |
| 11  | Not-found page · narrow 390                              |
| 12  | Not-found page · every reason that reveals nothing, once |
| 13  | All four · dark                                          |
| 14  | Index · each lookup answer and the page that answers it  |

## Outcome to page

Total over `PublicHostResolutionDto` (`application` | `members_only_application`
| `no_application`) and the lookup's 404:

| Lookup answer                                                                                    | Page                                         | Status       |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------- | ------------ |
| `application`, `upstream` well-formed, credential the edge can present                           | none — forwarded; the visitor meets the site | the target's |
| `application`, `upstream.credential` is `aws_sigv4`                                              | **Unavailable page**                         | 503          |
| `application` with no `upstream`, or `upstream.origin` not a valid `https:` URL                  | **Not-found page**                           | 404          |
| `no_application`                                                                                 | **No-application page**                      | 200          |
| `members_only_application`, `opensAt` set                                                        | **Members-only page**, with address          | 200          |
| `members_only_application`, `opensAt` null                                                       | **Members-only page**, without address       | 200          |
| 404 from the lookup — unknown domain, removed domain, a row not `issued`, the tenant base domain | **Not-found page**                           | 404          |

**One Not-found page, on purpose.** It is byte-identical for every reason it
answers. A page that varied by reason would tell an anonymous visitor which one
applied — the one thing a removed domain and a domain that never existed must
not reveal. A forward with no target, or with a target that is not an `https:`
origin, is a misconfiguration that must not confirm the domain exists, so it
takes this page too.

**Why the Unavailable page is not the Not-found page.** It is produced by ONE
condition: an `application` answer whose `upstream` names a credential kind the
edge cannot present (`aws_sigv4`). That domain IS issued, certified and bound,
and its site IS live; only this edge cannot reach it yet. Saying "there's no
site here" would be false, and a 404 tells a crawler the resource is gone when
it will serve again as soon as the edge can reach it — so it answers 503. Every
other unreachable reason keeps the Not-found page, because only this one is a
state that resolves.

**Why 200 for the No-application and Members-only pages.** They are the domain
owner's own states, not a missing resource: a 404 on a live, certified domain
would tell a crawler to drop it.

## Responses

Every page is served with:

- the status in the table above;
- `Content-Type: text/html; charset=utf-8`;
- `Cache-Control: no-store` — a page must not outlive the domain state that
  produced it; the next request may answer differently (the lookup itself is
  bounded at 30 seconds and a removed domain stops answering at once);
- `X-Robots-Tag: noindex, nofollow`, matching the document's own meta.

## Elements

Each element is named once.

- **No-application page** (panels 1–3, 13) — the **Eyebrow** (the site owner's
  name), the **Heading** and the **Sentence**. Nothing else.
- **Members-only page** (panels 4–6, 13) — the Eyebrow, the Heading and one of
  TWO different Sentences chosen by `opensAt`: with an address, the sentence
  holds the **Address link**; without one, a different sentence with no link.
  Never the with-address sentence with its link removed.
- **Unavailable page** (panels 7–9, 13) — the Eyebrow, the Heading and the
  Sentence saying the site exists and cannot be reached right now. No link, no
  retry control, no address, no platform or credential detail.
- **Not-found page** (panels 10–12, 13) — the Heading and the Sentence only. No
  Eyebrow, no name, no address, no link, no Motir product.
- **Document frame** — every page: `<!doctype html>`, `<html lang="en">`,
  `<meta charset="utf-8">`, `<meta name="viewport" content="width=device-width,
initial-scale=1">`, `<meta name="robots" content="noindex, nofollow">`, a
  `<title>` from the strings table, one inline `<style>` (the Token block), one
  `<main>`, one `<h1>`. No `<script>`, no `<img>`, no `<link>`, no webfont
  request.
- **Token block** — the one inline `<style>`; below.
- **Eyebrow** — `<p>`, 13px, letter-spacing 0.02em, `--el-text-secondary`,
  wrapping anywhere (a 60-character name wraps to two lines and truncates
  nothing), 12px below.
- **Heading** — `<h1>`, the serif stack, 30px / 1.15 / weight 700 / tracking
  -0.01em, `--el-text`, 12px below.
- **Sentence** — `<p>`, 16px / 1.6, `--el-text-secondary`; it may run to three
  lines at 390.
- **Address link** — `<a href="https://{opensAt}/">{opensAt}</a>` inside the
  members-only Sentence, the mono stack at 15px, `--el-link`, same tab, wrapping
  at its own dots and hyphens. The page's ONLY focusable element; on
  `:focus-visible` a 2px `--el-accent` outline at a 2px offset, never the
  browser default.
- **Absent chrome** — named so its absence is checkable: no site header, no
  navigation, no footer, no wordmark or logo, no link to motir.co, no product
  call to action, no cookie notice, no card, no rule, no border, no shadow. A
  visitor who met Motir's site chrome on a business's domain would be told they
  had reached the wrong product.

**Layout.** The `<main>` is a column `max-width: 30rem`, centred, its top at
`clamp(96px, 22vh, 200px)`; side padding 24px, 20px at a viewport of 420px or
less. Nothing is hidden at any width and nothing becomes a disclosure.

**Interpolation.** Only `workspace.name` (the Eyebrow and the Sentences) and
`opensAt` (the Address link's text and `href`) are interpolated, both
HTML-escaped. The requested `Host` is never echoed.

## Token block

The values a renderer with no packages emits, read from
`packages/design-system/theme.css` at the shipped defaults (`data-palette`
motir):

| Token                 | Light                                                               | Dark      | Read from                                                                                      |
| --------------------- | ------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------- |
| `--el-page-bg`        | `#ffffff`                                                           | `#0c0d0f` | `--color-background` in `[data-palette='motir']` / `[data-palette='motir'][data-theme='dark']` |
| `--el-text`           | `#16191d`                                                           | `#edeef0` | `--color-foreground`, same selectors                                                           |
| `--el-text-secondary` | `#565c64`                                                           | `#a9adb5` | `--color-slate`, same selectors                                                                |
| `--el-link`           | `#155bc4`                                                           | `#7db1ff` | `--color-link`, same selectors                                                                 |
| `--el-accent`         | `#1a1d21`                                                           | `#edeef0` | `--color-primary-fill`, same selectors                                                         |
| serif stack           | `Georgia, 'Times New Roman', serif`                                 | —         | `--font-serif-pairing` (`Georgia`) and `--font-serif-tail` (`serif`) on `:root`                |
| mono stack            | `'SF Mono', Menlo, monospace`                                       | —         | `--font-mono-pairing` and `--font-mono-tail` on `:root`                                        |
| sans stack (body)     | `'Segoe UI', Roboto, -apple-system, BlinkMacSystemFont, sans-serif` | —         | `--font-sans-pairing` and `--font-sans-tail` on `:root`                                        |

The image ships no webfont, so the serif resolves to the system stack and no
line depends on a font metric. Dark is one `@media (prefers-color-scheme: dark)`
block that redefines the five colour values; there is no second layout.

The block, complete:

```css
:root {
  --el-page-bg: #ffffff;
  --el-text: #16191d;
  --el-text-secondary: #565c64;
  --el-link: #155bc4;
  --el-accent: #1a1d21;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --el-page-bg: #0c0d0f;
    --el-text: #edeef0;
    --el-text-secondary: #a9adb5;
    --el-link: #7db1ff;
    --el-accent: #edeef0;
  }
}
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  background: var(--el-page-bg);
  color: var(--el-text);
  font-family:
    'Segoe UI',
    Roboto,
    -apple-system,
    BlinkMacSystemFont,
    sans-serif;
}
main {
  max-width: 30rem;
  margin: 0 auto;
  padding: clamp(96px, 22vh, 200px) 24px 48px;
}
@media (max-width: 420px) {
  main {
    padding-inline: 20px;
  }
}
.eyebrow {
  margin: 0 0 12px;
  font-size: 13px;
  letter-spacing: 0.02em;
  color: var(--el-text-secondary);
  overflow-wrap: anywhere;
}
h1 {
  margin: 0 0 12px;
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 30px;
  line-height: 1.15;
  font-weight: 700;
  letter-spacing: -0.01em;
}
p.sentence {
  margin: 0;
  font-size: 16px;
  line-height: 1.6;
  color: var(--el-text-secondary);
}
a {
  font-family: 'SF Mono', Menlo, monospace;
  font-size: 15px;
  color: var(--el-link);
  overflow-wrap: anywhere;
}
a:focus-visible {
  outline: 2px solid var(--el-accent);
  outline-offset: 2px;
}
```

A complete page is that block inside the Document frame plus one page's strings
— for example the No-application page:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>Nothing published yet</title>
    <style>
      /* the Token block */
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">{workspace.name}</p>
      <h1>Nothing is published here yet</h1>
      <p class="sentence">{workspace.name} hasn’t published a site at this address yet.</p>
    </main>
  </body>
</html>
```

## Strings (en)

Literal strings in the edge renderer, not a locale catalogue: the image has no
i18n pipeline. The pages say "site" and name the site owner; they never say
the product's own words for the request.

| Key                                       | String                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------ |
| `edge.noApplication.title`                | Nothing published yet                                                                |
| `edge.noApplication.heading`              | Nothing is published here yet                                                        |
| `edge.noApplication.sentence`             | {name} hasn’t published a site at this address yet.                                  |
| `edge.membersOnly.title`                  | Members only                                                                         |
| `edge.membersOnly.heading`                | This site is for members only                                                        |
| `edge.membersOnly.sentenceWithAddress`    | {name} opens this site to its members at {address}.                                  |
| `edge.membersOnly.sentenceWithoutAddress` | {name} has made this site available to its members only.                             |
| `edge.unavailable.title`                  | Temporarily unavailable                                                              |
| `edge.unavailable.heading`                | This site can’t be reached right now                                                 |
| `edge.unavailable.sentence`               | {name}’s site exists, but it can’t be reached at the moment. Please try again later. |
| `edge.notFound.title`                     | Not found                                                                            |
| `edge.notFound.heading`                   | There’s no site here                                                                 |
| `edge.notFound.sentence`                  | Check the address you typed and try again.                                           |

`{name}` is `workspace.name`; `{address}` is the Address link over `opensAt`.

## Ink and accessibility

Every text pair clears WCAG AA in both token sets (measured):

| Pair                                    | Light   | Dark    |
| --------------------------------------- | ------- | ------- |
| `--el-text` on `--el-page-bg`           | 17.63:1 | 16.75:1 |
| `--el-text-secondary` on `--el-page-bg` | 6.75:1  | 8.64:1  |
| `--el-link` on `--el-page-bg`           | 6.31:1  | 8.89:1  |
| `--el-accent` outline on `--el-page-bg` | 16.91:1 | 16.75:1 |

`--el-text-muted` and `--el-text-faint` carry no text. No state is conveyed by
colour alone: each page's state is its words. The one link is underlined by the
browser default and announced by its own text; the heading order is one `<h1>`.
