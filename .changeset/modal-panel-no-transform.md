---
'@motir/design-system': patch
---

`Modal` centres its panel with `inset-0 m-auto h-fit` instead of a translate, so the panel is no longer the containing block of `position: fixed` descendants. A `Combobox` menu inside `Modal.Body` now reaches past the panel's bottom edge, bounded only by the viewport, instead of being cut to the dialog's height. A `Combobox` list also grows to 20rem (was 16rem) when it has the room (MOTIR-11096).
