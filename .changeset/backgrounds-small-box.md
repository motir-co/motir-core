---
'@motir/design-system': patch
---

Wave and Topography no longer throw under the Bento style when drawn into a box smaller than their tile gutters, such as a picker's chip swatch. The shared rounded-rectangle path leaves an empty path for a tile with no size and never passes `arcTo` a negative radius, which a browser throws on (MOTIR-11672).
