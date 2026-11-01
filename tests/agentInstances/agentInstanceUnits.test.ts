import { afterEach, describe, expect, it, vi } from 'vitest';
import { INSTANCE_NAME_PATTERN } from '@/lib/agentInstances/config';
import { buildCloneCommand, installationBasicAuth } from '@/lib/agentInstances/cloneCommand';
import {
  AgentInstanceNameInvalidError,
  AgentInstanceNameTakenError,
  AgentInstanceNotFoundError,
  AgentInstanceStartRefusedError,
  AgentInstanceStateConflictError,
  AgentInstancesUnavailableError,
  AgentProfileNotOfferedError,
} from '@/lib/agentInstances/errors';
import { mapAgentInstanceError } from '@/lib/agentInstances/errorResponse';
import { imageDigestResolver, pinnedImageReference } from '@/lib/agentInstances/imageDigest';
import { toAgentInstanceIntervalDto } from '@/lib/mappers/agentInstanceMappers';
import {
  AGENT_SIGN_IN_HINTS,
  agentSignInHint,
  CHAT_PROFILES,
  chatProfile,
  isOfferedProfile,
  NOT_OFFERED_AGENT_PROFILES,
  OFFERED_AGENT_PROFILES,
  profileDisplayName,
  SANDBOX_IMAGE_REPOSITORY,
  sandboxImageTag,
} from '@/lib/agentInstances/profiles';
import {
  PermissionDeniedError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';

// The agent-instance lane's small pure modules (Story MOTIR-6860 · MOTIR-6872):
// the error mapper every route uses, the clone command, the digest pin, the
// offered profiles and the cap configuration.

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('mapAgentInstanceError — every typed refusal is a status, never a 500', () => {
  const statusOf = (err: unknown) => mapAgentInstanceError(err)?.status ?? null;

  it('maps access first: not found 404, permission 403 carrying the key', async () => {
    expect(statusOf(new ProjectNotFoundError('p'))).toBe(404);
    const denied = mapAgentInstanceError(new PermissionDeniedError('p', 'instance:use'))!;
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ permission: 'instance:use' });
    expect(statusOf(new ProjectAccessDeniedError('p', 'edit'))).toBe(403);
  });

  it('maps the lane’s own refusals', async () => {
    expect(statusOf(new AgentInstanceNotFoundError('i'))).toBe(404);
    expect(statusOf(new AgentInstanceNameInvalidError())).toBe(400);
    expect(statusOf(new AgentProfileNotOfferedError('cursor', 'Cursor'))).toBe(400);
    expect(statusOf(new AgentInstanceNameTakenError('x'))).toBe(409);
    expect(statusOf(new AgentInstanceStateConflictError('i', 'waking', 'woken'))).toBe(409);
    expect(statusOf(new AgentInstanceStartRefusedError('credits', 'no'))).toBe(402);
    expect(statusOf(new AgentInstanceStartRefusedError('credits_unknown', 'no'))).toBe(503);
    const cap = mapAgentInstanceError(new AgentInstanceStartRefusedError('user_cap', 'full'))!;
    expect(cap.status).toBe(429);
    expect(await cap.json()).toMatchObject({ reason: 'user_cap', error: 'full' });
    expect(statusOf(new AgentInstanceStartRefusedError('fleet_busy', 'busy'))).toBe(429);
    // MOTIR-6918: no paid plan is money (402), an unreadable plan a retry (503).
    expect(statusOf(new AgentInstanceStartRefusedError('ai_plan_required', 'no'))).toBe(402);
    expect(statusOf(new AgentInstanceStartRefusedError('ai_plan_unknown', 'no'))).toBe(503);
    // MOTIR-6926: the organisation's own cap is a cap (429) and carries its number.
    const orgCap = mapAgentInstanceError(
      new AgentInstanceStartRefusedError('org_cap', 'full', 50),
    )!;
    expect(orgCap.status).toBe(429);
    expect(await orgCap.json()).toMatchObject({ reason: 'org_cap', limit: 50 });
    expect(
      await mapAgentInstanceError(new AgentInstanceStartRefusedError('user_cap', 'full'))!.json(),
    ).not.toHaveProperty('limit');
    // MOTIR-9376: the plan's figure and name ride on both caps' 429s, beside each other.
    const userPlanCap = mapAgentInstanceError(
      new AgentInstanceStartRefusedError('user_cap', 'full', 1, 'Standard'),
    )!;
    expect(userPlanCap.status).toBe(429);
    expect(await userPlanCap.json()).toMatchObject({
      reason: 'user_cap',
      limit: 1,
      planName: 'Standard',
    });
    const orgPlanCap = mapAgentInstanceError(
      new AgentInstanceStartRefusedError('org_cap', 'full', 30, 'Pro'),
    )!;
    expect(orgPlanCap.status).toBe(429);
    expect(await orgPlanCap.json()).toMatchObject({
      reason: 'org_cap',
      limit: 30,
      planName: 'Pro',
    });
    expect(
      await mapAgentInstanceError(
        new AgentInstanceStartRefusedError('org_cap', 'full', 50),
      )!.json(),
    ).not.toHaveProperty('planName');
    expect(statusOf(new AgentInstancesUnavailableError('x'))).toBe(503);
    expect(statusOf(new Error('anything else'))).toBeNull();
  });
});

describe('the clone command', () => {
  it('runs as node, passes the token only as a one-shot basic-auth header, and names each repository', () => {
    const cmd = buildCloneCommand(['acme/web', 'acme/api'], 'ghs_secret');
    expect(cmd.slice(0, 4)).toEqual(['runuser', '-u', 'node', '--']);
    expect(cmd.slice(-3)).toEqual([installationBasicAuth('ghs_secret'), 'acme/web', 'acme/api']);
    expect(installationBasicAuth('ghs_secret')).toBe(
      Buffer.from('x-access-token:ghs_secret').toString('base64'),
    );
    const script = cmd[8]!;
    expect(script).toContain('extraheader=AUTHORIZATION: basic $auth');
    expect(script).toContain('clone --quiet "https://github.com/$repo.git"');
    expect(script).toContain('if [ -d "$dest/.git" ]; then continue; fi');
    expect(cmd.join(' ')).not.toContain('ghs_secret');
  });
});

describe('the digest pin', () => {
  it('on the fake fleet, derives a stable stand-in digest without asking a registry', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
    const a = await imageDigestResolver.resolve(sandboxImageTag('claude'));
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await imageDigestResolver.resolve(sandboxImageTag('claude'))).toBe(a);
    expect(await imageDigestResolver.resolve(sandboxImageTag('codex'))).not.toBe(a);
  });

  it('on Fly, asks the registry and refuses an image it cannot resolve', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 404 })),
    );
    try {
      await expect(imageDigestResolver.resolve(sandboxImageTag('claude'))).rejects.toThrow(
        AgentInstancesUnavailableError,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('on Fly, pins the digest the registry names', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{}', {
            status: 200,
            headers: { 'docker-content-digest': 'sha256:feed' },
          }),
      ),
    );
    try {
      expect(await imageDigestResolver.resolve(sandboxImageTag('claude'))).toBe('sha256:feed');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('on Fly, refuses an image the registry serves with no digest', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    );
    try {
      await expect(imageDigestResolver.resolve(sandboxImageTag('claude'))).rejects.toThrow(
        /the registry named no digest/,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('pins a tag to repository@digest', () => {
    expect(pinnedImageReference('ghcr.io/motir-co/motir-sandbox:claude', 'sha256:abc')).toBe(
      'ghcr.io/motir-co/motir-sandbox@sha256:abc',
    );
  });
});

describe('profiles and caps', () => {
  // GHCR does not follow a GitHub org rename: the old `moooon-b-v` path refuses
  // every pull (MOTIR-9346), so the repository must name the org's current owner.
  it('pulls the sandbox from the motir-co registry path', () => {
    expect(SANDBOX_IMAGE_REPOSITORY).toBe('ghcr.io/motir-co/motir-sandbox');
    expect(sandboxImageTag('claude')).toBe('ghcr.io/motir-co/motir-sandbox:claude');
  });

  it('offers exactly §9’s six and names the two it does not', () => {
    expect(isOfferedProfile('claude')).toBe(true);
    expect(isOfferedProfile('cursor')).toBe(false);
    expect(NOT_OFFERED_AGENT_PROFILES.map((p) => p.id)).toEqual(['antigravity', 'cursor']);
    expect(profileDisplayName('kimi')).toBe('Kimi Code');
    expect(profileDisplayName('cursor')).toBe('Cursor');
    expect(profileDisplayName('unknown')).toBe('unknown');
  });

  it('has a sign-in hint for every offered profile, and none for one it does not know', () => {
    expect(Object.keys(AGENT_SIGN_IN_HINTS).sort()).toEqual(
      OFFERED_AGENT_PROFILES.map((p) => p.id).sort(),
    );
    expect(agentSignInHint('claude')).toEqual({ checkable: true, values: ['claude', '/login'] });
    expect(agentSignInHint('aider')).toEqual({
      checkable: false,
      values: ['ANTHROPIC_API_KEY=…', '~/.env'],
    });
    expect(agentSignInHint('cursor')).toBeNull();
    expect(agentSignInHint('unknown')).toBeNull();
  });

  it('accepts a lower-case dashed name and refuses the rest', () => {
    expect(INSTANCE_NAME_PATTERN.test('yue-claude')).toBe(true);
    expect(INSTANCE_NAME_PATTERN.test('Yue Claude')).toBe(false);
    expect(INSTANCE_NAME_PATTERN.test('-leading')).toBe(false);
    expect(INSTANCE_NAME_PATTERN.test('a'.repeat(41))).toBe(false);
  });
});

describe('the chat verdict per profile (agent-chat.md Q1)', () => {
  it('supports the five streaming profiles and refuses aider with its reason', () => {
    for (const id of ['claude', 'codex', 'opencode', 'kimi', 'goose']) {
      expect(chatProfile(id)).toEqual({ supported: true });
    }
    expect(chatProfile('aider')).toEqual(CHAT_PROFILES.aider);
    expect(chatProfile('aider').supported).toBe(false);
  });

  it("leaves a profile it does not name to the server's hello", () => {
    expect(chatProfile('some-future-agent')).toEqual({ supported: true });
  });
});

describe('the interval mapper', () => {
  it('maps an open and a closed interval', () => {
    const base = {
      id: 'i',
      workspaceId: 'w',
      organizationId: 'o',
      agentInstanceId: 'a',
      runId: 'i',
      runStartedAt: new Date('2026-09-29T10:00:00.000Z'),
      startedAt: new Date('2026-09-29T10:00:00.000Z'),
      endedAt: null,
      endReason: null,
      billableSeconds: null,
      credits: null,
      chargeReference: 'agent-instance-interval:i',
      chargeOutcome: null,
      chargeDetail: null,
      chargeAttempts: 0,
      chargedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(toAgentInstanceIntervalDto(base)).toMatchObject({ endedAt: null, endReason: null });
    expect(
      toAgentInstanceIntervalDto({
        ...base,
        endedAt: new Date('2026-09-29T10:05:00.000Z'),
        endReason: 'rolled',
        billableSeconds: 300,
        credits: 5,
        chargeOutcome: 'charged',
      }),
    ).toMatchObject({ endedAt: '2026-09-29T10:05:00.000Z', endReason: 'rolled', credits: 5 });
  });
});
