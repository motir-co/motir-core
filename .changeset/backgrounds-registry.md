---
'@motir/design-system': minor
---

Backgrounds join the design system. A background registry lists the seven backgrounds a page area can draw (`wave`, `topography`, `aurora`, `cyclic`, `brian`, `daynight`, `rule110`), each saying whether it follows the active style, with `resolveBackground` / `resolveBackgroundChoice` falling back to the style's default (the Wave) for an unknown or missing id and keeping `none`. `<Background id focusId />` draws one inside its parent's box: a decorative canvas whose inks are the live `--el-*` tokens, re-read when `data-theme`, `data-palette` or `data-style` change, capped at ~30 fps, paused off screen and in a hidden tab, one still frame under reduced motion, and a feathered clear area behind the focus element. Aurora is the first background drawn (MOTIR-11604).
