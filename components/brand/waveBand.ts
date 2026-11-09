// The wave-band geometry, its baked colour literals and the email-mark
// constants now ship from `@motir/brand` (MOTIR-1456 · ADR
// docs/decisions/brand-asset-distribution.md). This file is a thin re-export
// shim so `app/manifest.ts`, both `opengraph-image.tsx` routes,
// `PlanWithAIFab` and the `scripts/brand/*` generators keep importing
// `@/components/brand/waveBand` unchanged. The email templates import
// `@motir/brand` directly: they are in the lib layer's type-check project
// (`tsconfig.lib.json`, MOTIR-10798), which may not import from `components/`.
export * from '@motir/brand';
