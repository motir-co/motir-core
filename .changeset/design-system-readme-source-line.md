---
'@motir/design-system': patch
---

README: the Usage block adds the `@source '../node_modules/@motir/design-system/dist';` line and says why. Without it Tailwind never generates the utilities used only inside the package's compiled components (MOTIR-10835).
