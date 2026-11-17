---
'@motir/design-system': patch
---

`AxisField` draws its help text and note in `--el-text-secondary`, which clears AA on every surface (it was `--el-text-muted`, 4.12–4.34:1 on `--el-surface`), and `StyleVignette`'s modal scrim derives from `--el-overlay-scrim` instead of a raw `bg-black/10` (MOTIR-11621, MOTIR-11622).
