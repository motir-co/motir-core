---
'@motir/design-system': minor
---

`renderMock`'s board is full width by default. 0.18 added `boardWidth` but kept `'narrow'` (a 64rem column) as the default, so a mock whose page has a narrower own column (a 46rem settings page) or a fixed one (an 80rem console) was still drawn centred in the middle of the screen. The default is now `'full'`: the page's own column sits inside a viewport-wide board as the page ships it. `'narrow'` keeps the old 64rem column for a mock that asks for it, and a value that is not one class now falls back to `'full'`.
