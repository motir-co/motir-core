---
'@motir/design-system': minor
---

`theme.css` adds `--spacing-shadow-elevated-drop` (MOTIR-10631): how far the solid edge of `--shadow-elevated` falls below the box that casts it. It is `0px` in every style whose elevated shadow is blurred, and `6px` in Neo-Brutalism, whose elevated shadow is a hard 6px offset block. A control hung over other content lifts itself by it, so its shadow clears what it floats above as its box does. No existing token changes.
