import { describe, expect, it } from 'vitest';
import {
  AGENT_PROFILES,
  parseAgentCommand,
  unattendedAgentCommand,
  withFreshSessionId,
  type ParsedAgentCommand,
} from '../src/agentProfiles.js';
import { agentModeAgent, resumeFixAgent } from '../src/commands/dispatch.js';

// `withFreshSessionId` (MOTIR-10983): a run resolves its agent once, so the session id a
// profile lets Motir choose is baked into one command. Each spawn asks this for its own,
// and it must change NOTHING ELSE — and nothing at all about a command Motir did not stamp.

const launched = (profile: string, env: NodeJS.ProcessEnv = {}): ParsedAgentCommand => {
  const command = unattendedAgentCommand(profile, env);
  if (!command) throw new Error(`${profile} has no unattended command`);
  return command;
};

describe('withFreshSessionId', () => {
  it('swaps ONLY the id after the flag, on the args, the command line and the stamp', () => {
    const agent = agentModeAgent({ MOTIR_SANDBOX_AGENT: 'claude' });
    const old = agent.stream!.sessionId!;
    const fresh = withFreshSessionId(agent, () => 'sess-new');

    const form = AGENT_PROFILES.find((p) => p.id === 'claude')!.agentStream!;
    expect(fresh.args).toEqual([...form.args, '--session-id', 'sess-new']);
    expect(fresh.command).toBe(['claude', ...form.args, '--session-id', 'sess-new'].join(' '));
    expect(fresh.stream).toEqual({ profile: 'claude', sessionId: 'sess-new' });
    expect(fresh.binary).toBe(agent.binary);
    expect(fresh.env).toBe(agent.env);
    expect(fresh.promptAddendum).toBe(agent.promptAddendum);
    // The resolved command is left as it was — the next leg swaps from the same one.
    expect(agent.stream!.sessionId).toBe(old);
    expect(agent.args).toContain(old);
  });

  it('mints a NEW random id on every call by default', () => {
    const agent = launched('claude');
    const ids = [1, 2, 3].map(() => withFreshSessionId(agent).stream!.sessionId);
    expect(new Set([...ids, agent.stream!.sessionId]).size).toBe(4);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns the same command for one Motir did not stamp', () => {
    const typed = parseAgentCommand('claude -p --session-id fixed')!;
    expect(withFreshSessionId(typed, () => 'x')).toBe(typed);
  });

  it('returns the same command for every profile whose agent picks its own id', () => {
    for (const profile of AGENT_PROFILES.filter(
      (p) => p.agentCommand && p.agentStream && !p.agentStream.sessionIdFlag,
    )) {
      const agent = launched(profile.id);
      expect(agent.stream?.sessionId).toBeNull();
      expect(withFreshSessionId(agent, () => 'x')).toBe(agent);
    }
  });

  it('returns the same command for the plain-text form and a profile with no stream', () => {
    const text = launched('claude', { MOTIR_AGENT_OUTPUT: 'text' });
    expect(withFreshSessionId(text, () => 'x')).toBe(text);
    const aider = launched('aider');
    expect(withFreshSessionId(aider, () => 'x')).toBe(aider);
  });

  it('never replaces the id of a RESUME, which is the point of that command', () => {
    const resumed = resumeFixAgent(launched('claude'), 'sess-9', {})!;
    expect(withFreshSessionId(resumed, () => 'x')).toBe(resumed);
  });

  it('leaves a stamp whose args do not carry its id after the flag', () => {
    const stamped: ParsedAgentCommand = {
      command: 'claude -p',
      binary: 'claude',
      args: ['-p'],
      stream: { profile: 'claude', sessionId: 'chosen' },
    };
    expect(withFreshSessionId(stamped, () => 'x')).toBe(stamped);
    const other = { ...stamped, args: ['-p', '--session-id', 'someone-else'] };
    expect(withFreshSessionId(other, () => 'x')).toBe(other);
    const unknown = { ...stamped, stream: { profile: 'nope', sessionId: 'chosen' } };
    expect(withFreshSessionId(unknown, () => 'x')).toBe(unknown);
  });
});
