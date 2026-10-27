---
'@motir/design-system': minor
---

`renderMock` takes a `boardWidth` (MOTIR-9758). The board was a hard-coded 64rem column, so a mock of a page that ships wider (motir-core's Billing & plans, every motir.co page at `max-w-[1400px]`) was drawn squeezed into the middle, and authors widened it by string-replacing the class in the rendered HTML. `'narrow'`, the default, keeps the 64rem column byte for byte; `'full'` draws the board at the viewport's width; any other string is one max-width class such as `'max-w-[1400px]'`, compiled like the rest of the markup. A value that is not one class falls back to `'narrow'` and is named in a comment at the top of the document, as an unknown axis is. The `BoardWidth` type is exported from `@motir/design-system/mock`.
