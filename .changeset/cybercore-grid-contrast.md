---
'@motir/design-system': patch
---

`theme.css`: Cybercore / Y2K's canvas grid lines drop from 6% to 5% `currentColor`, on the page and on the style-gallery vignette (MOTIR-10746). Where a horizontal and a vertical line cross, the page takes both tints, and at 6% that crossing took `--el-accent-on-surface` to 4.46:1 in sienna light. At 5% the worst crossing in any palette and mode is 4.63:1.
