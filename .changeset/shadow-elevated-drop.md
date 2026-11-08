---
'@motir/design-system': minor
---

`theme.css` adds `--spacing-shadow-elevated-drop` (MOTIR-10631): how far the solid edge of `--shadow-elevated` falls below the box that casts it. It is `0px` in every style whose elevated shadow is blurred, and `6px` in Neo-Brutalism, whose elevated shadow is a hard 6px offset block. A control hung over other content lifts itself by it, so its shadow clears what it floats above as its box does. Every style declares it beside its own `--shadow-elevated` (MOTIR-10677), so a `[data-style]` scope nested inside another never inherits the outer style's drop. No existing token changes.
