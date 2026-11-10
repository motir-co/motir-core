---
'@motir/design-system': patch
---

An unregistered `data-palette` id, or a root with no `data-palette`, now renders the default `motir` palette (`DEFAULT_PALETTE_ID`) instead of the `amethyst` stylesheet base, so the palette axis falls back to its default id like the style and type axes do. Every registered palette renders exactly as before. The `motir` block carries two extra fallback selectors that name every registered id; a new palette must add its id to them (MOTIR-10834).
