---
'@motir/design-system': minor
---

`Modal` takes `describedBy`, `onOpenAutoFocus` and `onCloseAutoFocus` (MOTIR-10544). `describedBy` adds element ids to the dialog's `aria-describedby` after its `description`'s own id, so a dialog whose meaning lives in its body as well as its one-line description (an alert that lists its reasons) has the body read with its title. The two focus props pass through to Radix: a dialog opened without a `Modal.Trigger` can land focus on its safe action when it opens and return focus to the control that opened it when it closes. A `Modal` given none of them renders exactly as before.
