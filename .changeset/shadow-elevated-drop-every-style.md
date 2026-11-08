---
'@motir/design-system': patch
---

`theme.css` declares `--spacing-shadow-elevated-drop` in every style (MOTIR-10677), each beside its own `--shadow-elevated`. Before, only the `@theme` default, Warm Editorial and Neo-Brutalism declared it, so a `[data-style]` scope nested inside a Neo-Brutalism one inherited its 6px drop instead of 0px. No value changes for an un-nested style.
