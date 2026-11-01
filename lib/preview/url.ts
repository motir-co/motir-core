// THE ONE COMPOSER OF A PREVIEW ADDRESS (Story MOTIR-5766 · MOTIR-10099).
//
// `preview_deployment` stores a HOST (`pr-<n>--<slug>.preview.motir.site`), never a
// URL, so whatever links a preview has to add a scheme. This is that one place: the
// Development row's link composes here, server-side, the way the mapper composes
// the row's GitHub link-out.
//
// The scheme is `https` on every deployed environment. `MOTIR_PREVIEW_SCHEME`
// exists only for a lane that serves the preview host over plain HTTP; it is read
// at call time, and an EMPTY or whitespace-only value counts as unset — the rule
// `lib/baseUrl.ts` states for its own variable.

export const PREVIEW_SCHEME_ENV = 'MOTIR_PREVIEW_SCHEME';

/** `https`, unless the lane set another scheme. Without its `:`. */
export function previewScheme(): string {
  const configured = process.env[PREVIEW_SCHEME_ENV]?.trim().replace(/:$/, '');
  return configured ? configured.toLowerCase() : 'https';
}

/** The preview's address — its origin: `<scheme>://<host>`. A host written with a
 *  path is reduced to the origin, so the link always opens the preview's root. */
export function previewUrl(host: string): string {
  return new URL(`${previewScheme()}://${host}`).origin;
}
