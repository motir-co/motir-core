import { PreviewHostingNotConfiguredError } from './errors';

// Where previews are served (MOTIR-5769 §9): `MOTIR_PREVIEW_DOMAIN`, read at CALL
// time, never at module load, so a deployment that has not switched previews on
// still boots and only a preview call is refused.

export const PREVIEW_DOMAIN_ENV = 'MOTIR_PREVIEW_DOMAIN';

/** The preview domain (`preview.motir.site`), lowercased, or the typed refusal. */
export function previewDomain(): string {
  const value = process.env[PREVIEW_DOMAIN_ENV]?.trim().toLowerCase();
  if (!value) throw new PreviewHostingNotConfiguredError(`set ${PREVIEW_DOMAIN_ENV}`);
  return value;
}
