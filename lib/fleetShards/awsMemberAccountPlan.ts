import type { FleetWorkloadKind } from '@motir/orchestrator';

// THE NAME AND EMAIL OF A POOL ACCOUNT NO PERSON ASKED FOR (Story MOTIR-9362 ·
// MOTIR-9460). The unattended add-shard derives both, deterministically, from
// the fleet kind and the next free sequence number — so a run interrupted after
// `CreateAccount` recomputes the same name on its next pass and FINDS the account
// (`findOrganizationAccount(name)`) instead of creating a second.
//
// The email is plus-addressing on one Motir mailbox, from a template a person
// sets when production is turned on (the story's assumption r2), e.g.
// `aws+{name}@motir.co`. Pure functions: the one env read is the caller's.

/** The env variable holding the member-account email template. */
export const AWS_MEMBER_EMAIL_TEMPLATE_ENV = 'FLEET_AWS_MEMBER_EMAIL_TEMPLATE';
/** Where the account name goes in the template. */
export const AWS_MEMBER_EMAIL_PLACEHOLDER = '{name}';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** `ci_runner` → `ci-runner`: the kind as a name segment. */
function kindSlug(kind: FleetWorkloadKind): string {
  return kind.replace(/_/g, '-');
}

/** `<kind>-pool-<n>`, e.g. `ci-runner-pool-3` — a pool account's name. It names
 *  no role: the account is created a spare and is later promoted in place. */
export function poolAccountName(kind: FleetWorkloadKind, sequence: number): string {
  return `${kindSlug(kind)}-pool-${sequence}`;
}

/** The next free sequence for `kind`, given every account name that exists (in
 *  any state, a disabled one included, so a number is never reused). */
export function nextPoolAccountSequence(
  kind: FleetWorkloadKind,
  existingNames: readonly string[],
): number {
  const pattern = new RegExp(`^${kindSlug(kind)}-pool-(\\d+)$`);
  let max = 0;
  for (const name of existingNames) {
    const match = pattern.exec(name);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

/** Problems with the template; empty when it is usable. */
export function memberEmailTemplateProblems(template: string | undefined): string[] {
  const value = template?.trim() ?? '';
  if (!value) return [`set ${AWS_MEMBER_EMAIL_TEMPLATE_ENV} (e.g. aws+{name}@motir.co)`];
  if (value.split(AWS_MEMBER_EMAIL_PLACEHOLDER).length !== 2) {
    return [
      `${AWS_MEMBER_EMAIL_TEMPLATE_ENV} must hold ${AWS_MEMBER_EMAIL_PLACEHOLDER} exactly once`,
    ];
  }
  if (!EMAIL_PATTERN.test(value.replace(AWS_MEMBER_EMAIL_PLACEHOLDER, 'x'))) {
    return [
      `${AWS_MEMBER_EMAIL_TEMPLATE_ENV} is not an email address with ${AWS_MEMBER_EMAIL_PLACEHOLDER}`,
    ];
  }
  return [];
}

/** The member account's root email for `name`. Validate the template first. */
export function memberAccountEmail(template: string, name: string): string {
  return template.trim().replace(AWS_MEMBER_EMAIL_PLACEHOLDER, name);
}
