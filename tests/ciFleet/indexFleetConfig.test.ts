import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  indexFleetConfig,
  isIndexFleetConfigured,
  isOrchestratorConfigured,
  OrchestratorNotConfiguredError,
} from '@/lib/orchestrator';
import { INDEXER_IMAGE_ENV_VAR } from '@motir/orchestrator';

// The INDEX FLEET's config gate (Story MOTIR-1981 · MOTIR-1989).
//
// The property under test is that UNCONFIGURED IS LOUD. §5 of
// `docs/decisions/code-graph-index-fleet.md` makes the ledger the hard
// constraint — one `job_run` per repo, `succeeded`, with one `output.repoRef` —
// and `listSucceededCodeGraphIndexRepoRefs` plus the onboarding wizard's
// per-repo rows both read exactly that. So a config gate that quietly answered
// "nothing to do" would let a repo read as INDEXED forever while nothing ever
// ran. Silence here is indistinguishable from success everywhere downstream.

const FLEET_VARS = [
  'MOTIR_FLEET_ORCHESTRATOR',
  'FLY_FLEET_API_TOKEN',
  'FLY_FLEET_APP',
  'FLY_FLEET_REGION',
  'MOTIR_RUNNER_IMAGE',
  'MOTIR_INDEX_FLEET_PROVIDER',
  INDEXER_IMAGE_ENV_VAR,
];

/** Start from a deployment that has NOTHING configured — the self-hosted shape. */
function clearFleetEnv(): void {
  for (const key of FLEET_VARS) vi.stubEnv(key, '');
}

/** Everything a real (non-fake) cloud deployment sets. */
function configureCloudFleet(): void {
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
  vi.stubEnv('FLY_FLEET_API_TOKEN', 'fly-token');
  vi.stubEnv('FLY_FLEET_APP', 'motir-fleet-app');
  vi.stubEnv('MOTIR_RUNNER_IMAGE', 'ghcr.io/motir-co/motir-ci-runner@sha256:' + 'a'.repeat(64));
  vi.stubEnv(INDEXER_IMAGE_ENV_VAR, 'registry.fly.io/motir-fleet-app@sha256:' + 'b'.repeat(64));
}

beforeEach(() => {
  clearFleetEnv();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isIndexFleetConfigured', () => {
  it('is FALSE on an unconfigured (self-hosted) deployment', () => {
    expect(isIndexFleetConfigured()).toBe(false);
  });

  it('is TRUE for the fake adapter — the test suites boot no real machine', () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
    expect(isIndexFleetConfigured()).toBe(true);
    // It agrees with the CI fleet's own predicate on the same deployment, so the
    // two workloads cannot disagree about whether the fake is usable.
    expect(isOrchestratorConfigured()).toBe(true);
  });

  it('is FALSE when the FLEET is wired but the INDEXER IMAGE is not', () => {
    // The case this predicate exists for: a deployment that runs CI runners
    // today and has not yet pasted the indexer digest. CI keeps working; the
    // index workload correctly reports itself unavailable.
    configureCloudFleet();
    vi.stubEnv(INDEXER_IMAGE_ENV_VAR, '');
    expect(isIndexFleetConfigured()).toBe(false);
    expect(isOrchestratorConfigured()).toBe(true);
  });

  it('is FALSE when the IMAGE is wired but the fleet is not', () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv(INDEXER_IMAGE_ENV_VAR, 'registry.fly.io/app@sha256:' + 'd'.repeat(64));
    expect(isIndexFleetConfigured()).toBe(false);
  });

  it('is TRUE on a fully-wired cloud deployment', () => {
    configureCloudFleet();
    expect(isIndexFleetConfigured()).toBe(true);
  });

  it('never throws, on any of those', () => {
    expect(() => isIndexFleetConfigured()).not.toThrow();
    configureCloudFleet();
    expect(() => isIndexFleetConfigured()).not.toThrow();
  });
});

describe('indexFleetConfig — unconfigured must be LOUD', () => {
  it('THROWS the typed error when nothing is configured', () => {
    // Not a null, not a placeholder, not a no-op verdict. A silent answer here
    // is what would let a `succeeded` job_run carry an output.repoRef for a repo
    // nothing indexed.
    expect(() => indexFleetConfig()).toThrow(OrchestratorNotConfiguredError);
  });

  it('names EVERY missing variable at once, not just the first', () => {
    // A misconfigured deployment otherwise discovers its gaps one boot at a
    // time, and each of those boots is a billed machine and a dead-lettered run.
    const err = (() => {
      try {
        indexFleetConfig();
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(OrchestratorNotConfiguredError);
    expect(err!.message).toContain('FLY_FLEET_API_TOKEN');
    expect(err!.message).toContain('FLY_FLEET_APP');
    expect(err!.message).toContain(INDEXER_IMAGE_ENV_VAR);
  });

  it('says it in ONE sentence — the fleet refusal merged by its detail, not its rendered message', () => {
    // MOTIR-6571: merging the fleet's RENDERED message nested one sentence in the
    // other ("… not configured: set The container orchestrator is not configured:
    // set …"), and the `toContain` checks above cannot see that.
    expect(() => indexFleetConfig()).toThrow(
      'The container orchestrator is not configured: set FLY_FLEET_API_TOKEN, FLY_FLEET_APP, ' +
        `MOTIR_RUNNER_IMAGE, ${INDEXER_IMAGE_ENV_VAR}.`,
    );
  });

  it('names ONLY the indexer image when the rest of the fleet is wired', () => {
    configureCloudFleet();
    vi.stubEnv(INDEXER_IMAGE_ENV_VAR, '');
    const err = (() => {
      try {
        indexFleetConfig();
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(OrchestratorNotConfiguredError);
    expect(err!.message).toBe(
      `The container orchestrator is not configured: set ${INDEXER_IMAGE_ENV_VAR}.`,
    );
  });

  it('returns the image + region on a wired deployment', () => {
    configureCloudFleet();
    vi.stubEnv('FLY_FLEET_REGION', 'ams');
    expect(indexFleetConfig()).toEqual({
      image: 'registry.fly.io/motir-fleet-app@sha256:' + 'b'.repeat(64),
      region: 'ams',
    });
  });

  it('defaults the region to iad (§11 fixes the fleet there)', () => {
    configureCloudFleet();
    expect(indexFleetConfig().region).toBe('iad');
  });

  it('returns a DIGEST-pinned placeholder for the fake adapter', () => {
    // The fake boots nothing, so the reference is never pulled — but it is still
    // a digest and not a tag, so a downstream test asserting "the spec is
    // digest-pinned" exercises the real shape rather than a special case.
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
    const config = indexFleetConfig();
    expect(config.image).toContain('@sha256:');
    expect(config.image).not.toMatch(/:latest$/);
    expect(() => indexFleetConfig()).not.toThrow();
  });

  it('is read at CALL time — configuring the deployment flips it without a reimport', () => {
    expect(() => indexFleetConfig()).toThrow();
    configureCloudFleet();
    expect(() => indexFleetConfig()).not.toThrow();
  });
});

describe('on the indexer pool (MOTIR_INDEX_FLEET_PROVIDER=aws), the Fly fleet is not required', () => {
  // The AWS deployment's shape: indexing placed on its pool, the indexer image set,
  // and no Fly fleet app. Every index job used to fail terminally here with
  // "set FLY_FLEET_APP" before admission could defer it.
  const IMAGE =
    '944842271421.dkr.ecr.us-east-1.amazonaws.com/motir-indexer@sha256:' + 'e'.repeat(64);

  function configurePoolDeployment(): void {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('MOTIR_INDEX_FLEET_PROVIDER', 'aws');
    vi.stubEnv(INDEXER_IMAGE_ENV_VAR, IMAGE);
  }

  it('returns the image with no Fly fleet variable set', () => {
    configurePoolDeployment();
    expect(indexFleetConfig()).toEqual({ image: IMAGE, region: 'iad' });
    expect(isIndexFleetConfigured()).toBe(true);
  });

  it('ignores FLY_FLEET_REGION — the admitted account supplies the region', () => {
    configurePoolDeployment();
    vi.stubEnv('FLY_FLEET_REGION', 'ams');
    expect(indexFleetConfig().region).toBe('iad');
  });

  it('is still LOUD about the image, and names only the image', () => {
    configurePoolDeployment();
    vi.stubEnv(INDEXER_IMAGE_ENV_VAR, '');
    expect(() => indexFleetConfig()).toThrow(
      `The container orchestrator is not configured: set ${INDEXER_IMAGE_ENV_VAR}.`,
    );
    expect(isIndexFleetConfigured()).toBe(false);
  });

  it('still requires the Fly fleet when the switch reads fly', () => {
    configurePoolDeployment();
    vi.stubEnv('MOTIR_INDEX_FLEET_PROVIDER', 'fly');
    expect(() => indexFleetConfig()).toThrow('FLY_FLEET_APP');
    expect(isIndexFleetConfigured()).toBe(false);
  });
});
