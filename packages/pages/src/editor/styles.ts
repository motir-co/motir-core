// The page editor's OWN rules (Story MOTIR-5752 · MOTIR-7275).
//
// The body is styled by the shipped `.motir-prose` rules
// (`components/ui/markdown-editor.css`), which the host loads — the package
// cannot import an app file. What follows is only what a PAGE changes or adds,
// per `design/pages/design-notes.md` § _The body_:
//
//  • links take `--el-link`, not the description editor's `--el-highlight`
//    (about 2.6:1 on the white page — under AA, and a page is mostly read);
//  • blockquotes take `--el-text-secondary`, so a quote stays AA on any surface;
//  • an image is a block at full column width, `--radius-control`;
//  • a table scrolls inside its own wrapper rather than escaping the column, and
//    a selected cell carries the 2px inset `--el-highlight` ring;
//  • the empty body shows its placeholder in `--el-text-muted`, which the notes
//    allow only as placeholder ink directly on the white page.
//
//  • the work-item mention (MOTIR-7574, § _Mention a work item_): the typed
//    `@query` keeps the description editor's `--el-tint-yellow` mark; a selected
//    chip carries the focus ring; the archived chip's key and title are lifted
//    from the shipped muted / faint to `--el-text-secondary` (AA); and the
//    unavailable chip — deleted or hidden, drawn the same — is `.is-deleted`'s
//    shape (no border, no fill, struck through, not a link) in
//    `--el-text-secondary`. The live chip itself is the shipped `.wi-chip`.
//
//  • the Passage wash (MOTIR-10899, § _Commenting on a passage_): a decoration's
//    tint of `--el-highlight` under the page's own ink — 6% at rest, 7% on
//    hover and at emphasis, the ceiling the notes measured AA against every page
//    ink in every palette — cloned across line breaks; emphasis adds a 2px
//    `--el-accent-on-surface` underline (a change of shape, not only of tint); a
//    stretch two threads share carries a 1px hairline along its top; the
//    emphasised stretch takes the focus ring; and the Passage tooltip is the
//    inverted tooltip frame. Under reduced motion nothing transitions.
//
//  • the Selection action and the Inline composer (MOTIR-10900): the action is
//    `Button variant="secondary" size="sm"` copied (the package does not depend
//    on the design system) on `--el-page-bg` with `--shadow-elevated`; the
//    composer is a card on `--el-page-bg`, `--radius-card`, 12px padding and
//    `--shadow-elevated`, its head the panel's Quote slot frame (2px
//    `--el-border-strong` rule on `--el-surface-soft`, 13px
//    `--el-text-secondary`, clamped to three lines) beside a close icon button.
//    `data-side="above"` lifts either surface by its own height.
//
// It is rendered as a React 19 hoisted `<style href precedence>`, so it is
// unlayered like the shipped stylesheet and each rule is scoped one class
// deeper (`.motir-page-editor .motir-prose …`), which is what lets it win.
// Colour is `--el-*` only; shape is the element shape tokens only.

export const PAGE_EDITOR_CSS = `
.motir-page-editor .motir-prose a { color: var(--el-link); }
.motir-page-editor .motir-prose blockquote { color: var(--el-text-secondary); }
.motir-page-editor .motir-prose img { display: block; max-width: 100%; border-radius: var(--radius-control); }
.motir-page-editor .motir-prose .tableWrapper { overflow-x: auto; }
.motir-page-editor .motir-prose .selectedCell { box-shadow: inset 0 0 0 2px var(--el-highlight); }
.motir-page-editor .motir-prose p.is-editor-empty:first-child::before {
  content: attr(data-placeholder);
  float: left;
  height: 0;
  pointer-events: none;
  color: var(--el-text-muted);
}
.motir-page-editor .motir-prose .suggestion {
  background: var(--el-tint-yellow);
  border-radius: var(--radius-kbd);
  padding: 0 1px;
  color: var(--el-text);
}
.motir-page-editor .motir-prose .motir-wi-mention.ProseMirror-selectednode {
  outline: var(--focus-ring-width) solid var(--focus-ring-color);
  outline-offset: 1px;
  border-radius: var(--radius-control);
}
.motir-page-editor .motir-prose .wi-chip.is-archived,
.motir-page-editor .motir-prose .wi-chip.is-archived .wi-key,
.motir-page-editor .motir-prose .wi-chip.is-archived .wi-title { color: var(--el-text-secondary); }
.motir-page-editor .motir-prose .wi-chip.is-unavailable,
.motir-page-editor .motir-prose .wi-chip.is-unavailable:hover {
  padding-left: 0;
  padding-right: 0;
  border-color: transparent;
  background: transparent;
  color: var(--el-text-secondary);
  text-decoration: line-through;
  cursor: default;
}
.motir-page-editor .motir-prose .wi-chip .wi-label { color: var(--el-text-secondary); text-decoration: line-through; }

.motir-page-editor .motir-prose .motir-wi-embed { position: relative; margin: 12px 0; }
.motir-page-editor .motir-prose .motir-wi-embed.ProseMirror-selectednode .wi-card-frame {
  outline: var(--focus-ring-width) solid var(--focus-ring-color);
  outline-offset: 1px;
  border-radius: var(--radius-card);
}
.motir-page-editor .motir-prose .wi-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: var(--spacing-card-padding-12) var(--spacing-card-padding-16);
  border: 1px solid var(--el-border);
  border-radius: var(--radius-card);
  background: var(--el-card);
  color: var(--el-text);
  text-decoration: none;
}
.motir-page-editor .motir-prose a.wi-card:hover { background: var(--el-surface-soft); }
.motir-page-editor .motir-prose a.wi-card:hover .wi-title { text-decoration: underline; }
.motir-page-editor .motir-prose .wi-card .wi-key { font-family: var(--font-mono, monospace); color: var(--el-text-identifier); }
.motir-page-editor .motir-prose .wi-card .wi-title { color: var(--el-text-strong); font-weight: 600; }
.motir-page-editor .motir-prose .wi-card.is-archived { background: var(--el-surface-soft); }
.motir-page-editor .motir-prose .wi-card.is-unavailable {
  border-style: dashed;
  color: var(--el-text-secondary);
  cursor: default;
}
.motir-page-editor .motir-prose .wi-card-cluster {
  position: absolute;
  top: 6px;
  right: 6px;
  display: none;
  gap: 2px;
}
.motir-page-editor .motir-prose .motir-wi-embed:hover .wi-card-cluster,
.motir-page-editor .motir-prose .motir-wi-embed:focus-within .wi-card-cluster,
.motir-page-editor .motir-prose .motir-wi-embed.ProseMirror-selectednode .wi-card-cluster { display: flex; }
.motir-page-editor .motir-prose .wi-card-menu {
  position: absolute;
  top: 100%;
  right: 0;
  z-index: 20;
  min-width: 11rem;
  padding: 4px;
  border: 1px solid var(--el-border);
  border-radius: var(--radius-card);
  background: var(--el-page-bg);
  box-shadow: var(--shadow-elevated);
}
.motir-page-editor .motir-prose .wi-card-convert {
  margin-left: 4px;
  vertical-align: middle;
  visibility: hidden;
}
.motir-page-editor .motir-prose .motir-wi-mention:hover .wi-card-convert,
.motir-page-editor .motir-prose .motir-wi-mention:focus-within .wi-card-convert,
.motir-page-editor .motir-prose .motir-wi-mention.ProseMirror-selectednode .wi-card-convert { visibility: visible; }
@media (max-width: 639px) {
  .motir-page-editor .motir-prose .wi-card { flex-wrap: wrap; }
}

.motir-page-editor .motir-prose .motir-wash {
  background-color: color-mix(in srgb, var(--el-highlight) 6%, transparent);
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
  cursor: pointer;
  transition:
    background-color var(--transition-duration) ease,
    text-decoration-color var(--transition-duration) ease;
}
.motir-page-editor .motir-prose .motir-wash[data-wash-hover],
.motir-page-editor .motir-prose .motir-wash[data-wash-state='emphasis'] {
  background-color: color-mix(in srgb, var(--el-highlight) 7%, transparent);
}
.motir-page-editor .motir-prose .motir-wash[data-wash-state='emphasis'] {
  text-decoration-line: underline;
  text-decoration-thickness: 2px;
  text-decoration-color: var(--el-accent-on-surface);
  text-underline-offset: 3px;
}
.motir-page-editor .motir-prose .motir-wash.is-overlap { box-shadow: inset 0 1px 0 var(--el-accent-on-surface); }
.motir-page-editor .motir-prose .motir-wash[data-wash-state='emphasis']:focus { outline: none; }
.motir-page-editor .motir-prose .motir-wash[data-wash-state='emphasis']:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring-color);
  outline-offset: 2px;
}
.motir-page-editor .motir-passage-tip {
  position: absolute;
  z-index: 40;
  transform: translateY(calc(-100% - 8px));
  pointer-events: none;
  white-space: nowrap;
  padding: var(--spacing-tooltip-y) var(--spacing-tooltip-x);
  border-radius: var(--radius-control);
  background: var(--el-tooltip-bg);
  color: var(--el-tooltip-text);
  box-shadow: var(--shadow-elevated);
  font-size: 12px;
  line-height: 16px;
}
@media (prefers-reduced-motion: reduce) {
  .motir-page-editor .motir-prose .motir-wash { transition: none; }
}

.motir-page-editor .motir-passage-action,
.motir-page-editor .motir-passage-composer {
  position: absolute;
  z-index: 50;
}
.motir-page-editor .motir-passage-action[data-side='above'],
.motir-page-editor .motir-passage-composer[data-side='above'] { transform: translateY(-100%); }
.motir-page-editor .motir-passage-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: var(--height-btn-sm);
  padding: 0 var(--spacing-btn-x-sm);
  border: 1px solid var(--el-button-border);
  border-radius: var(--radius-btn);
  background: var(--el-page-bg);
  color: var(--el-text);
  box-shadow: var(--shadow-elevated);
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
}
.motir-page-editor .motir-passage-action:hover { background: var(--el-surface); }
.motir-page-editor .motir-passage-action:active { background: var(--el-muted); border-color: var(--el-border-strong); }
.motir-page-editor .motir-passage-action:focus-visible,
.motir-page-editor .motir-passage-close:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring-color);
  outline-offset: 2px;
}
.motir-page-editor .motir-passage-composer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: var(--spacing-card-padding-12);
  border: 1px solid var(--el-border);
  border-radius: var(--radius-card);
  background: var(--el-page-bg);
  box-shadow: var(--shadow-elevated);
}
.motir-page-editor .motir-passage-composer:focus { outline: none; }
.motir-page-editor .motir-passage-composer-head { display: flex; align-items: flex-start; gap: 8px; }
.motir-page-editor .motir-passage-quote {
  flex: 1;
  min-width: 0;
  margin: 0;
  padding: var(--spacing-control-y) var(--spacing-control-x);
  border-left: 2px solid var(--el-border-strong);
  border-radius: var(--radius-control);
  background: var(--el-surface-soft);
  color: var(--el-text-secondary);
  font-size: 13px;
  font-style: normal;
}
.motir-page-editor .motir-passage-quote > span {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.motir-page-editor .motir-passage-close {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-icon-btn);
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--el-icon-muted);
  cursor: pointer;
}
.motir-page-editor .motir-passage-close:hover { background: var(--el-surface-soft); color: var(--el-text); }
`;
