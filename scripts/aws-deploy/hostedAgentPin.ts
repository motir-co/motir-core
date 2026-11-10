/**
 * The hosted-agent image PIN (MOTIR-10882): the one place the production
 * `MOTIR_HOSTED_AGENT_IMAGE` is written down.
 *
 * `infra/hosted-agent-image.ref` holds one line, the image by digest. The
 * hosted-agent image lane opens a pull request that rewrites it after every
 * publish on `main` (`.github/workflows/hosted-agent-image.yml`, job `pin`), and
 * the AWS deploy writes it into the `<prefix>/core/motir-hosted-agent-image`
 * secret before it rolls the services (`awsDeploy.ts`). So a publish alone never
 * changes what production boots: merging the bump is the deliberate pin, and
 * reverting it is the rollback.
 *
 * The file lives OUTSIDE `packages/cli/**` on purpose: that tree is the image
 * lane's trigger, so a pin kept there would make every bump publish a new image
 * and open the next bump.
 */

/** The pin file, relative to the repository root. */
export const HOSTED_AGENT_PIN_FILE = 'infra/hosted-agent-image.ref';

/** The repository production boots the hosted agent from (public on GHCR). */
export const HOSTED_AGENT_IMAGE_REPOSITORY = 'ghcr.io/motir-co/motir-hosted-agent';

/** What a pin must be: that repository, by digest — never a tag. */
export const HOSTED_AGENT_PIN_PATTERN =
  /^ghcr\.io\/motir-co\/motir-hosted-agent@sha256:[a-f0-9]{64}$/;

/** The Secrets Manager entry core's web and worker read it from (motir-infra `CORE_SECRETS`). */
export const hostedAgentImageSecretName = (prefix: string) =>
  `${prefix}/core/motir-hosted-agent-image`;

/**
 * The image a pin file's text names. Throws, saying what is wrong, unless the
 * text is exactly one line holding a reference {@link HOSTED_AGENT_PIN_PATTERN}
 * accepts (a trailing newline is fine).
 */
export function parseHostedAgentPin(text: string): string {
  const lines = text.split('\n').filter((line, i, all) => line !== '' || i < all.length - 1);
  if (lines.length !== 1) {
    throw new Error(`${HOSTED_AGENT_PIN_FILE} must hold exactly one line, not ${lines.length}`);
  }
  const image = lines[0]!;
  if (!HOSTED_AGENT_PIN_PATTERN.test(image)) {
    throw new Error(
      `${HOSTED_AGENT_PIN_FILE} must name ${HOSTED_AGENT_IMAGE_REPOSITORY}@sha256:<64 hex>, not "${image}"`,
    );
  }
  return image;
}
