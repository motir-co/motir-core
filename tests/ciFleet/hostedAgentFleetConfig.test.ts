import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOSTED_AGENT_IMAGE_ENV_VAR,
  hostedAgentFleetConfig,
  hostedAgentImage,
  OrchestratorNotConfiguredError,
} from '@/lib/orchestrator';

// The HOSTED-AGENT workload's config gate (Story MOTIR-683 · MOTIR-690;
// `docs/decisions/hosted-agent-run.md` §6). Two properties: an unconfigured
// deployment names EVERY missing variable at once, and an image pinned by a TAG
// is refused — a tag would let a publish change what a running deployment boots,
// and this image holds the agent a customer's code is handed to.

const FLEET_VARS = [
  'MOTIR_FLEET_ORCHESTRATOR',
  'MOTIR_RUNNER_IMAGE',
  'FLY_FLEET_API_TOKEN',
  'FLY_FLEET_APP',
  'FLY_FLEET_REGION',
  HOSTED_AGENT_IMAGE_ENV_VAR,
];

const DIGEST_IMAGE = 'ghcr.io/motir-co/motir-hosted-agent@sha256:' + 'c'.repeat(64);

function configureFlyFleet(): void {
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
  vi.stubEnv('FLY_FLEET_API_TOKEN', 'fly-token');
  vi.stubEnv('FLY_FLEET_APP', 'motir-fleet-app');
  vi.stubEnv('MOTIR_RUNNER_IMAGE', 'ghcr.io/motir-co/motir-ci-runner@sha256:' + 'a'.repeat(64));
}

beforeEach(() => {
  for (const key of FLEET_VARS) vi.stubEnv(key, '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('hostedAgentFleetConfig', () => {
  it('answers a well-formed fake digest under the fake orchestrator', () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
    const config = hostedAgentFleetConfig();
    expect(config.image).toMatch(/@sha256:/);
    expect(config.region).toBe('iad');
  });

  it('names the fleet AND the image when nothing is configured, in one error', () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv(HOSTED_AGENT_IMAGE_ENV_VAR, undefined);
    expect(() => hostedAgentFleetConfig()).toThrow(OrchestratorNotConfiguredError);
    let message = '';
    try {
      hostedAgentFleetConfig();
    } catch (err) {
      message = (err as Error).message;
    }
    // One sentence, one `set`, every variable — never the fleet's own sentence nested.
    expect(message.match(/not configured/g)).toHaveLength(1);
    expect(message).toMatch(/FLY_FLEET_API_TOKEN/);
    expect(message).toContain(HOSTED_AGENT_IMAGE_ENV_VAR);
  });

  it('names only the image when the fleet is configured and the image is not', () => {
    configureFlyFleet();
    expect(() => hostedAgentFleetConfig()).toThrow(
      `The container orchestrator is not configured: set ${HOSTED_AGENT_IMAGE_ENV_VAR}.`,
    );
  });

  it('refuses an image pinned by a tag', () => {
    configureFlyFleet();
    vi.stubEnv(HOSTED_AGENT_IMAGE_ENV_VAR, 'ghcr.io/motir-co/motir-hosted-agent:latest');
    expect(() => hostedAgentFleetConfig()).toThrow(/pinned by digest/);
  });

  it('returns the digest-pinned image and the fleet region', () => {
    configureFlyFleet();
    vi.stubEnv('FLY_FLEET_REGION', 'ams');
    vi.stubEnv(HOSTED_AGENT_IMAGE_ENV_VAR, `  ${DIGEST_IMAGE}  `);
    expect(hostedAgentFleetConfig()).toEqual({ image: DIGEST_IMAGE, region: 'ams' });
  });
});

// The image read ALONE (MOTIR-9420): one variable for both fleets, readable with
// no Fly fleet variable set, and refused on AWS when it names a registry an
// agent-runner VM — no instance profile, no Fly org credential — cannot pull from.
describe('hostedAgentImage', () => {
  const FLY_MIRROR = 'registry.fly.io/motir-hosted-agent@sha256:' + 'd'.repeat(64);
  const ECR_IMAGE =
    '123456789012.dkr.ecr.us-east-1.amazonaws.com/motir-hosted-agent@sha256:' + 'e'.repeat(64);

  function refusal(provider: 'aws' | 'fly'): OrchestratorNotConfiguredError {
    try {
      hostedAgentImage(provider);
    } catch (err) {
      return err as OrchestratorNotConfiguredError;
    }
    throw new Error('expected a refusal');
  }

  it('returns the trimmed digest reference on AWS with every Fly fleet variable unset', () => {
    vi.stubEnv(HOSTED_AGENT_IMAGE_ENV_VAR, `  ${DIGEST_IMAGE}\n`);
    expect(hostedAgentImage('aws')).toBe(DIGEST_IMAGE);
    expect(hostedAgentImage('fly')).toBe(DIGEST_IMAGE);
  });

  it.each(['aws', 'fly'] as const)('refuses a tag-pinned reference on %s', (provider) => {
    vi.stubEnv(HOSTED_AGENT_IMAGE_ENV_VAR, 'ghcr.io/motir-co/motir-hosted-agent:main');
    expect(refusal(provider)).toBeInstanceOf(OrchestratorNotConfiguredError);
    expect(refusal(provider).message).toMatch(/pinned by digest/);
  });

  it.each(['aws', 'fly'] as const)('refuses an unset variable on %s, naming it', (provider) => {
    vi.stubEnv(HOSTED_AGENT_IMAGE_ENV_VAR, undefined);
    expect(refusal(provider)).toBeInstanceOf(OrchestratorNotConfiguredError);
    expect(refusal(provider).detail).toBe(`set ${HOSTED_AGENT_IMAGE_ENV_VAR}`);
  });

  it.each([
    ['a registry.fly.io mirror', FLY_MIRROR, 'registry.fly.io'],
    ['an ECR repository', ECR_IMAGE, '123456789012.dkr.ecr.us-east-1.amazonaws.com'],
  ])('refuses %s on AWS: an agent-runner VM pulls anonymously', (_case, image, host) => {
    vi.stubEnv(HOSTED_AGENT_IMAGE_ENV_VAR, image);
    const err = refusal('aws');
    expect(err).toBeInstanceOf(OrchestratorNotConfiguredError);
    expect(err.detail).toContain(host);
    expect(err.detail).toContain('pulls anonymously');
    expect(err.detail).toContain(HOSTED_AGENT_IMAGE_ENV_VAR);
  });

  it('accepts the registry.fly.io mirror on Fly, whose machines pull as the org', () => {
    vi.stubEnv(HOSTED_AGENT_IMAGE_ENV_VAR, FLY_MIRROR);
    expect(hostedAgentImage('fly')).toBe(FLY_MIRROR);
  });

  it('judges the HOST, never a substring: a ghcr.io path naming registry.fly.io is accepted', () => {
    const image = 'ghcr.io/registry.fly.io/agent@sha256:' + 'f'.repeat(64);
    vi.stubEnv(HOSTED_AGENT_IMAGE_ENV_VAR, image);
    expect(hostedAgentImage('aws')).toBe(image);
  });

  it('answers the fake digest under the fake orchestrator', () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
    expect(hostedAgentImage('aws')).toBe('motir/hosted-agent@sha256:fake');
  });
});
