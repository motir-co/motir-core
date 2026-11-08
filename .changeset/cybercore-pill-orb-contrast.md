---
'@motir/design-system': patch
---

`theme.css`: Cybercore / Y2K's plan-with-AI pill and orb clear WCAG AA in every palette and mode (MOTIR-10710). The pill's fill takes 6% / 5% black with the base 14% highlight share (was 12% / 22% black with 30% highlight), because black lowers the contrast of the palettes whose label ink is dark: sienna light was 3.18:1 and candy light 3.49:1, and every pair is now at least 4.5:1. The orb's highlight wash drops from 22% to 15%, which takes the cobalt dark glyph from 2.96:1 back over the 3:1 non-text floor.
