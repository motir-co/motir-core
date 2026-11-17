---
'@motir/design-system': minor
---

`<Background still />` and `startBackground({ still: true })` draw one still frame and never animate, whatever the motion preference, for a picker's swatch; the frame still follows resizes and theme changes. The canvas now carries `data-background-focus`, naming the element it gathers around or clears behind (MOTIR-11618, MOTIR-11608).
