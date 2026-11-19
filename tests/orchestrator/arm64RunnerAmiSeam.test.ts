import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AWS_RUNNER_ARM64_AMI_ENV_VAR,
  readArm64RunnerAmiId,
  setArm64RunnerAmiOverrideForTests,
} from '@/lib/orchestrator';

// THE ARM64 RUNNER AMI SEAM (MOTIR-11790). `readArm64RunnerAmiId()` is the one
// arm64-readiness read; the acceptance lane's fleet-org-ci mock may install an
// override over it so a browser spec chooses, per test, whether an arm64 AMI is
// pinned. With no override it is the env read, unchanged.

const ENV_ID = 'ami-0env000000000000a';
const ARMED = 'ami-0e2e0000000000000';

afterEach(() => {
  setArm64RunnerAmiOverrideForTests(null);
  vi.unstubAllEnvs();
});

describe('with no override installed', () => {
  it('reads the trimmed env, and null when it is unset or blank', () => {
    vi.stubEnv(AWS_RUNNER_ARM64_AMI_ENV_VAR, `  ${ENV_ID}\n`);
    expect(readArm64RunnerAmiId()).toBe(ENV_ID);
    vi.stubEnv(AWS_RUNNER_ARM64_AMI_ENV_VAR, '   ');
    expect(readArm64RunnerAmiId()).toBeNull();
    delete process.env[AWS_RUNNER_ARM64_AMI_ENV_VAR];
    expect(readArm64RunnerAmiId()).toBeNull();
  });
});

describe('with an override that is not armed', () => {
  it('returns the env read unchanged, set and unset', () => {
    setArm64RunnerAmiOverrideForTests(() => ({ armed: false }));
    vi.stubEnv(AWS_RUNNER_ARM64_AMI_ENV_VAR, ENV_ID);
    expect(readArm64RunnerAmiId()).toBe(ENV_ID);
    vi.stubEnv(AWS_RUNNER_ARM64_AMI_ENV_VAR, '');
    expect(readArm64RunnerAmiId()).toBeNull();
  });
});

describe('with an armed override', () => {
  it('returns its id even with the env unset, trimmed', () => {
    vi.stubEnv(AWS_RUNNER_ARM64_AMI_ENV_VAR, '');
    setArm64RunnerAmiOverrideForTests(() => ({ armed: true, amiId: ` ${ARMED} ` }));
    expect(readArm64RunnerAmiId()).toBe(ARMED);
  });

  it('returns null for a null or blank id even with the env set', () => {
    vi.stubEnv(AWS_RUNNER_ARM64_AMI_ENV_VAR, ENV_ID);
    setArm64RunnerAmiOverrideForTests(() => ({ armed: true, amiId: null }));
    expect(readArm64RunnerAmiId()).toBeNull();
    setArm64RunnerAmiOverrideForTests(() => ({ armed: true, amiId: '  ' }));
    expect(readArm64RunnerAmiId()).toBeNull();
  });

  it('asks the reader on every call, never caching an answer', () => {
    let amiId: string | null = ARMED;
    const reader = vi.fn(() => ({ armed: true as const, amiId }));
    setArm64RunnerAmiOverrideForTests(reader);
    expect(readArm64RunnerAmiId()).toBe(ARMED);
    amiId = null;
    expect(readArm64RunnerAmiId()).toBeNull();
    expect(reader).toHaveBeenCalledTimes(2);
  });
});

describe('removing the override', () => {
  it('setArm64RunnerAmiOverrideForTests(null) restores the env read', () => {
    vi.stubEnv(AWS_RUNNER_ARM64_AMI_ENV_VAR, ENV_ID);
    setArm64RunnerAmiOverrideForTests(() => ({ armed: true, amiId: null }));
    expect(readArm64RunnerAmiId()).toBeNull();
    setArm64RunnerAmiOverrideForTests(null);
    expect(readArm64RunnerAmiId()).toBe(ENV_ID);
    expect(
      (globalThis as Record<symbol, unknown>)[Symbol.for('motir.orchestrator.e2eArm64RunnerAmi')],
    ).toBeUndefined();
  });

  it('lib/orchestrator/index.ts imports no lib/test-* module', () => {
    const source = readFileSync(join(process.cwd(), 'lib/orchestrator/index.ts'), 'utf8');
    expect(source).not.toMatch(/from ['"]@\/lib\/test-|import\(['"]@\/lib\/test-/);
    expect(source).not.toMatch(/from ['"]\.\.\/test-/);
  });
});
