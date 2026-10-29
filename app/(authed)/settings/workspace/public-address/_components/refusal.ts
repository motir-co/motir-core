import {
  MAX_SUBDOMAIN_LENGTH,
  MIN_SUBDOMAIN_LENGTH,
  RESERVED_SEPARATOR,
  refuseLabel,
} from '@/lib/publicAddresses/reservedNames';

// THE REFUSAL MAP for the workspace address control (Story MOTIR-4528 ·
// MOTIR-9514; `design/workspace-address/design-notes.md` § Field refusal).
//
// ⚠️ A REFUSAL IS MAPPED FROM ITS `code` AND DISCRIMINATOR, NEVER FROM THE
// SERVER'S ENGLISH. The `error` string on a problem body is for logs; rendering
// it would throw ten catalogues away. This file turns `{ code, refusal,
// hostname, returnsAt, nextAllowedAt }` into a catalogue key plus its values, and
// says WHERE it belongs: on the field (the name is wrong) or in a toast (the
// change was refused, the name was fine).
//
// Pure (no React, no `next-intl`), so the component and its test share it. A
// date travels as the server's ISO string under `date`; the component formats it
// in the viewer's locale, long form.

/**
 * The longest label the FIELD accepts — the server's own cap.
 *
 * The address decision (MOTIR-9790) gives every application of a workspace the
 * host `<app>--<label>.<base>` and caps a workspace label at 30 so that host fits
 * one 63-octet DNS label; ADR §8 AMENDMENT 4 put that cap in
 * `MAX_SUBDOMAIN_LENGTH` (MOTIR-10025), so the field and the server now agree.
 */
export const FIELD_MAX_LABEL_LENGTH = MAX_SUBDOMAIN_LENGTH;

/** The decided `--` separator (MOTIR-9790) — application addresses own it. */
const DOUBLE_HYPHEN = RESERVED_SEPARATOR;

export type RefusalSurface = 'field' | 'toast';

export interface RefusalMessage {
  readonly surface: RefusalSurface;
  /** Key under `settings.workspaceAddress`. */
  readonly key: string;
  readonly values: Readonly<Record<string, string | number>>;
  /** An ISO instant the component formats into `values.date`. */
  readonly date?: string;
}

/** The label discriminators (`RESERVED_LABEL.refusal`, and the field's own check) → copy. */
const LABEL_REFUSAL_KEY: Record<string, string> = {
  bad_grammar: 'refusal.badGrammar',
  too_short: 'refusal.tooShort',
  too_long: 'refusal.tooLong',
  double_hyphen: 'refusal.doubleHyphen',
  // A structural reservation (`xn--`, `motir-`, `_`) is a reservation to the
  // customer: the next action is the same — choose another name.
  structurally_reserved: 'refusal.reserved',
  reserved: 'refusal.reserved',
};

function labelRefusal(discriminator: string, label: string): RefusalMessage | null {
  const key = LABEL_REFUSAL_KEY[discriminator];
  if (!key) return null;
  return {
    surface: 'field',
    key,
    values: { label, min: MIN_SUBDOMAIN_LENGTH, max: FIELD_MAX_LABEL_LENGTH },
  };
}

/**
 * What the field says about `label` BEFORE anything is sent — the grammar
 * refusals the design shows as the user types. `null` when the label may be
 * submitted (or is empty: an empty field says nothing, Claim is just disabled).
 *
 * The grammar is the SERVER's own `refuseLabel`, asked rather than restated. The
 * field names `--` with its own sentence (the server reports it as a structural
 * reservation) because the next action differs: drop the second hyphen, not the name.
 */
export function refuseLabelInput(label: string): RefusalMessage | null {
  if (label === '') return null;
  const server = refuseLabel(label);
  // A grammar refusal first: `acme_inc` is malformed before it is anything else.
  if (server === 'bad_grammar') return labelRefusal(server, label);
  if (label.includes(DOUBLE_HYPHEN) && !label.startsWith('xn--')) {
    return labelRefusal('double_hyphen', label);
  }
  if (label.length > FIELD_MAX_LABEL_LENGTH) return labelRefusal('too_long', label);
  return server ? labelRefusal(server, label) : null;
}

/** The body of a refused subdomain write, as `mapPublicAddressError` writes it. */
export interface RefusalBody {
  readonly code?: string;
  readonly refusal?: string;
  readonly hostname?: string;
  readonly returnsAt?: string;
  readonly nextAllowedAt?: string;
}

/**
 * Map a refused `PUT` / `DELETE` to its message.
 *
 * `act` decides one surface: on a CLAIM the field is open, so a taken or held
 * name is a field error; on a rename that has already passed its confirm, the
 * dialog closes and the refusal is a toast. `label` and `host` are what the
 * customer asked for, used when the body carries no hostname.
 */
export function refusalFromResponse(
  body: RefusalBody,
  ctx: { act: 'claim' | 'rename' | 'release'; label: string; host: string },
): RefusalMessage {
  const host = body.hostname ?? ctx.host;
  const onField = ctx.act === 'claim';

  switch (body.code) {
    case 'RESERVED_LABEL': {
      const mapped = labelRefusal(body.refusal ?? '', ctx.label);
      if (mapped) return onField ? mapped : { ...mapped, surface: 'toast' };
      break;
    }
    case 'HOSTNAME_TAKEN':
      return onField
        ? { surface: 'field', key: 'refusal.taken', values: { host } }
        : { surface: 'toast', key: 'toast.refusedTaken', values: { host } };
    case 'NAME_QUARANTINED':
      return onField
        ? { surface: 'field', key: 'refusal.quarantined', values: { host }, date: body.returnsAt }
        : {
            surface: 'toast',
            key: 'toast.refusedQuarantined',
            values: { host },
            date: body.returnsAt,
          };
    case 'SUBDOMAIN_CHANGE_LIMIT':
      return { surface: 'toast', key: 'toast.refusedLimit', values: {}, date: body.nextAllowedAt };
    case 'SUBDOMAIN_FORBIDDEN':
      return { surface: onField ? 'field' : 'toast', key: 'readOnly', values: {} };
    default:
      break;
  }
  return { surface: onField ? 'field' : 'toast', key: 'refusal.generic', values: {} };
}
