import { BRAND_ACCENT_HEX, BRAND_ACCENT_INK_HEX, BRAND_LINK_HEX } from '@motir/brand';

// The brand colours an email paints with, in ONE place (design/brand/design-notes.md
// §10 · MOTIR-6474). Email reads no CSS variable — Gmail strips `<style>` and the
// Word renderer ignores custom properties — so these are baked literals, each the
// Motir palette's light value of the token named beside it, sourced from
// `@motir/brand` rather than retyped. The body greys (#111827 / #4b5563 / #6b7280)
// are NOT brand colours and stay inline where they are.

/** `--el-accent` — the primary button's FILL, the ink CTA (16.91:1 vs the white body). */
export const EMAIL_BUTTON_BG = BRAND_ACCENT_HEX;
/** `--el-accent-text` — the button's label ON that fill (16.91:1). */
export const EMAIL_BUTTON_INK = BRAND_ACCENT_INK_HEX;
/** `--el-link` — every body link (6.31:1 on the white body). */
export const EMAIL_LINK = BRAND_LINK_HEX;
