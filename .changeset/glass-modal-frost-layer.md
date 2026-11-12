---
'@motir/design-system': patch
---

Under the Glassmorphism style the modal panel's frosting (`backdrop-filter`, fill, sheen and inset rim) now paints on a `[data-surface='modal']::before` layer behind the panel's content instead of on the panel itself. A `backdrop-filter` makes its element the containing block of `position: fixed` descendants, so on the panel it kept a `Combobox` menu inside a dialog cut to the panel's height in that style. The glass look is unchanged (MOTIR-11105).
