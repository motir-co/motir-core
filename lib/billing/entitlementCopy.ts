// The translated sentence for a §4 cap refusal (MOTIR-5133).
//
// `EntitlementExceededError` builds an English sentence at the throw site. That
// string stays — it is the server / log / agent-facing message — but it is never
// what a READER is shown: a template literal in a service cannot be translated,
// so a `zh` reader hitting a cap got English inside a translated UI. The error's
// `entitlement` discriminator crosses the boundary instead, and the layer that
// knows who is reading picks the words from the catalogue — the shape
// `CustomDomainsSection` (now `CustomDomainsPane`) already had.
//
// Directive-free on purpose: the server-action results, the HTTP bodies and the
// client components all key on the same kind, and both sides import it from here.

import type { EntitlementKind } from '@/lib/billing/entitlements';

/** A translator scoped to the `errors` namespace (next-intl's `useTranslations('errors')`). */
type ErrorsTranslator = (key: `entitlementExceeded.${EntitlementKind}`) => string;

/** The `errors`-namespace key holding the refusal for one kind. */
export function entitlementExceededKey(
  kind: EntitlementKind,
): `entitlementExceeded.${EntitlementKind}` {
  return `entitlementExceeded.${kind}`;
}

/** The translated refusal for one kind — what a toast or an inline notice renders. */
export function entitlementExceededMessage(t: ErrorsTranslator, kind: EntitlementKind): string {
  return t(entitlementExceededKey(kind));
}
