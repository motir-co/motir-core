import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runAgent } from '../src/agentRun.js';
import { resetHostedRun, setActiveHostedRun } from '../src/hostedAttribution.js';
import {
  EGRESS_DOCUMENT,
  egressConfig,
  LAUNCH_DECLARED_MODEL_PROVIDERS,
  HOSTED_AGENT_ENV_KEYS,
  hostedAgentEnv,
  hostedOpenCodeAgent,
} from '../src/hostedAgent.js';

// THE HOSTED RUN'S AGENT (MOTIR-6559) — OpenCode, launched by the CLI on the
// run's model through the gateway key, on an ALLOW-LISTED environment (AC3).

/**
 * The gateway's egress contract §2 (`motir-gateway` `docs/hosted-run-egress.md`),
 * pinned HERE as well as in the CLI — so an edit to `EGRESS_DOCUMENT` is a
 * visible, deliberate change to the security boundary rather than a silent one.
 * (The hosted image carried its own copy until MOTIR-6560; the CLI now owns the
 * only one, and this literal is what holds it to the contract.)
 *
 * Pinned to §2 as amended by MOTIR-7357 (story MOTIR-7351) — motir-gateway commit
 * `aa55517` on `parent/MOTIR-7351-hosted-kimi`: `anthropic`, `deepseek`, `z-ai`,
 * `qwen` and `moonshotai`, all at the gateway on the run key. The two custom
 * providers name their package (`@ai-sdk/openai-compatible`, bundled in the binary);
 * `moonshotai` is a bundled provider whose block only overrides `baseURL` and
 * `apiKey`, like `deepseek`. None of the three carries `models`: the CLI writes the
 * run's one model there at launch (§2's template note).
 * (Previously pinned to MOTIR-7243's amendment, `2a901eb`, with the first four, and
 * before that to MOTIR-7207's, `7d96eda`, with the first two.)
 */
const EGRESS_CONTRACT_SECTION_2 = {
  $schema: 'https://opencode.ai/config.json',
  enabled_providers: ['anthropic', 'deepseek', 'z-ai', 'qwen', 'moonshotai'],
  provider: {
    anthropic: {
      options: {
        baseURL: '{env:MOTIR_GATEWAY_URL}/v1',
        apiKey: '{env:MOTIR_RUN_KEY}',
      },
    },
    deepseek: {
      options: {
        baseURL: '{env:MOTIR_GATEWAY_URL}/v1',
        apiKey: '{env:MOTIR_RUN_KEY}',
      },
    },
    'z-ai': {
      npm: '@ai-sdk/openai-compatible',
      options: {
        baseURL: '{env:MOTIR_GATEWAY_URL}/v1',
        apiKey: '{env:MOTIR_RUN_KEY}',
      },
    },
    qwen: {
      npm: '@ai-sdk/openai-compatible',
      options: {
        baseURL: '{env:MOTIR_GATEWAY_URL}/v1',
        apiKey: '{env:MOTIR_RUN_KEY}',
      },
    },
    moonshotai: {
      options: {
        baseURL: '{env:MOTIR_GATEWAY_URL}/v1',
        apiKey: '{env:MOTIR_RUN_KEY}',
      },
    },
  },
  share: 'disabled',
  autoupdate: false,
};

const RUN_KEY = 'rk_live_the_gateway_key';
const RUN_TOKEN = 'mrt_the_run_credential';

/** The environment a hosted container boots the CLI with, plus things that must not leak. */
function containerEnv(): NodeJS.ProcessEnv {
  return {
    PATH: '/run/bin:/usr/bin',
    HOME: '/home/agent',
    LANG: 'C.UTF-8',
    MOTIR_MODEL: 'anthropic/claude-sonnet-5',
    MOTIR_GATEWAY_URL: 'https://gateway.motir.test',
    MOTIR_RUN_KEY: RUN_KEY,
    MOTIR_RUN_TOKEN: RUN_TOKEN,
    MOTIR_API_URL: 'https://app.motir.test',
    MOTIR_DISPATCH_RUN_ID: 'run_1',
    MOTIR_AGENT: 'claude --dangerously-skip-permissions',
    GITHUB_TOKEN: 'ghs_should_never_reach_the_agent',
    GIT_CONFIG_GLOBAL: '/tmp/state/gitconfig',
    GIT_TERMINAL_PROMPT: '0',
  };
}

afterEach(() => resetHostedRun());

describe('hostedOpenCodeAgent (AC3)', () => {
  it('launches `opencode run --model <model> --auto`, the prompt on argv, stdin unconnected', () => {
    const agent = hostedOpenCodeAgent(containerEnv());
    expect(agent.binary).toBe('opencode');
    expect(agent.args).toEqual(['run', '--model', 'anthropic/claude-sonnet-5', '--auto']);
    expect(agent.promptOnStdin).toBe(false);
  });

  it('gives the agent ONLY the allow-listed environment — no run credential, no git token', () => {
    const env = hostedOpenCodeAgent(containerEnv()).env!;
    for (const key of Object.keys(env)) {
      expect(HOSTED_AGENT_ENV_KEYS as readonly string[]).toContain(key);
    }
    expect(env['MOTIR_RUN_TOKEN']).toBeUndefined();
    expect(env['MOTIR_API_URL']).toBeUndefined();
    expect(env['GITHUB_TOKEN']).toBeUndefined();
    expect(env['MOTIR_AGENT']).toBeUndefined();
    // No value anywhere carries the run credential.
    expect(Object.values(env).some((v) => v?.includes(RUN_TOKEN))).toBe(false);
    // The gateway key appears ONLY under the one name the egress document reads.
    const holders = Object.entries(env).filter(([, v]) => v?.includes(RUN_KEY));
    expect(holders.map(([k]) => k)).toEqual(['MOTIR_RUN_KEY']);
    // …and the run's git setup travels with it.
    expect(env['GIT_CONFIG_GLOBAL']).toBe('/tmp/state/gitconfig');
  });

  it('the egress document the CLI owns is the egress contract §2, verbatim', () => {
    expect(EGRESS_DOCUMENT).toEqual(EGRESS_CONTRACT_SECTION_2);
  });

  it('configures OpenCode with exactly the egress contract document', () => {
    const env = hostedAgentEnv(containerEnv());
    expect(JSON.parse(env['OPENCODE_CONFIG_CONTENT']!)).toEqual(EGRESS_CONTRACT_SECTION_2);
    expect(JSON.parse(egressConfig()).provider.anthropic.options.apiKey).toBe(
      '{env:MOTIR_RUN_KEY}',
    );
    expect(JSON.parse(egressConfig()).provider.deepseek.options.apiKey).toBe('{env:MOTIR_RUN_KEY}');
    expect(env['OPENCODE_DISABLE_AUTOUPDATE']).toBe('true');
    expect(env['OPENCODE_DISABLE_MODELS_FETCH']).toBe('true');
    expect(env['OPENCODE_DISABLE_CLAUDE_CODE']).toBe('true');
  });

  it('refuses a missing run model, gateway or key, and a model outside the enabled providers', () => {
    const env = containerEnv();
    delete env['MOTIR_RUN_KEY'];
    expect(() => hostedOpenCodeAgent(env)).toThrow(/missing MOTIR_RUN_KEY/);
    for (const model of ['gpt-5', 'openai/gpt-5', 'deepseek/', '/deepseek-v4-pro']) {
      expect(() => hostedOpenCodeAgent({ ...containerEnv(), MOTIR_MODEL: model })).toThrow(
        /must be "<provider>\/<model id>" with provider one of anthropic, deepseek, z-ai, qwen, moonshotai/,
      );
    }
  });

  it('launches a DeepSeek model with both providers configured (MOTIR-7208)', () => {
    const agent = hostedOpenCodeAgent({
      ...containerEnv(),
      MOTIR_MODEL: 'deepseek/deepseek-v4-pro',
    });
    expect(agent.args).toEqual(['run', '--model', 'deepseek/deepseek-v4-pro', '--auto']);
    const config = JSON.parse(agent.env!['OPENCODE_CONFIG_CONTENT']!);
    expect(config).toEqual(EGRESS_CONTRACT_SECTION_2);
  });

  it('launches a GLM, Qwen or Kimi model with all five providers, its ONE model declared under its provider (MOTIR-7244, MOTIR-7361)', () => {
    for (const [model, provider, id] of [
      ['z-ai/glm-4.6', 'z-ai', 'glm-4.6'],
      ['qwen/qwen-plus', 'qwen', 'qwen-plus'],
      ['moonshotai/kimi-k2.6', 'moonshotai', 'kimi-k2.6'],
      // An id outside OpenCode 1.18.32's bundled Kimi snapshot (contract §2).
      ['moonshotai/kimi-probe-unlisted', 'moonshotai', 'kimi-probe-unlisted'],
    ] as const) {
      const agent = hostedOpenCodeAgent({ ...containerEnv(), MOTIR_MODEL: model });
      expect(agent.args).toEqual(['run', '--model', model, '--auto']);
      const config = JSON.parse(agent.env!['OPENCODE_CONFIG_CONTENT']!);
      const five = ['anthropic', 'deepseek', 'z-ai', 'qwen', 'moonshotai'];
      expect(config.enabled_providers).toEqual(five);
      expect(Object.keys(config.provider)).toEqual(five);
      // Exactly the run's model, under exactly its provider — and nothing else moved.
      expect(config.provider[provider].models).toEqual({ [id]: {} });
      const { models: _models, ...rest } = config.provider[provider];
      expect(rest).toEqual(EGRESS_CONTRACT_SECTION_2.provider[provider]);
      const others = Object.keys(config.provider).filter((p) => p !== provider);
      for (const other of others) {
        expect(config.provider[other]).toEqual(
          EGRESS_CONTRACT_SECTION_2.provider[
            other as keyof typeof EGRESS_CONTRACT_SECTION_2.provider
          ],
        );
      }
    }
    // The exported document stays the contract's static template.
    expect(EGRESS_DOCUMENT).toEqual(EGRESS_CONTRACT_SECTION_2);
  });

  it("refuses OpenCode's own bundled provider ids and non-catalog spellings before launching, naming the five (MOTIR-7244, MOTIR-7361)", () => {
    for (const model of [
      'zhipuai/glm-4.6',
      'zai/glm-4.6',
      'alibaba/qwen-plus',
      'moonshot/kimi-k2.6',
      'kimi/kimi-k2.6',
    ]) {
      expect(() => hostedOpenCodeAgent({ ...containerEnv(), MOTIR_MODEL: model })).toThrow(
        /provider one of anthropic, deepseek, z-ai, qwen, moonshotai, got "/,
      );
    }
  });

  it('declares the run model at launch for exactly the providers the contract calls a template (MOTIR-7361)', () => {
    expect(LAUNCH_DECLARED_MODEL_PROVIDERS).toEqual(['z-ai', 'qwen', 'moonshotai']);
    // Every one of them is an enabled provider of the document.
    for (const p of LAUNCH_DECLARED_MODEL_PROVIDERS) {
      expect(EGRESS_DOCUMENT.enabled_providers as readonly string[]).toContain(p);
    }
    // The serialised Kimi config carries exactly ONE model, under `moonshotai`, and none elsewhere.
    const config = JSON.parse(egressConfig('moonshotai/kimi-k2.6'));
    const declared = Object.entries(config.provider as Record<string, { models?: object }>)
      .filter(([, block]) => block.models !== undefined)
      .map(([name, block]) => [name, block.models]);
    expect(declared).toEqual([['moonshotai', { 'kimi-k2.6': {} }]]);
  });

  it('writes no model for a catalog provider, or with no model at all (MOTIR-7244)', () => {
    expect(JSON.parse(egressConfig('anthropic/claude-sonnet-5'))).toEqual(
      EGRESS_CONTRACT_SECTION_2,
    );
    expect(JSON.parse(egressConfig('deepseek/deepseek-v4-pro'))).toEqual(EGRESS_CONTRACT_SECTION_2);
    expect(JSON.parse(egressConfig())).toEqual(EGRESS_CONTRACT_SECTION_2);
    expect(JSON.parse(egressConfig('z-ai/'))).toEqual(EGRESS_CONTRACT_SECTION_2);
    expect(JSON.parse(egressConfig('moonshotai/'))).toEqual(EGRESS_CONTRACT_SECTION_2);
  });

  it('leaves an Anthropic model exactly as it was (MOTIR-7208)', () => {
    expect(hostedOpenCodeAgent(containerEnv()).args).toEqual([
      'run',
      '--model',
      'anthropic/claude-sonnet-5',
      '--auto',
    ]);
  });
});

describe('runAgent with the hosted launcher', () => {
  /** A spawn that records what it was given and exits 0. */
  function recordingSpawn() {
    const seen: { cmd: string; args: string[]; opts: SpawnOptions }[] = [];
    const spawnFn = (cmd: string, args: string[], opts: SpawnOptions): ChildProcess => {
      seen.push({ cmd, args, opts });
      const child = new EventEmitter() as ChildProcess;
      Object.assign(child, { stdin: null, stdout: null, stderr: null });
      setImmediate(() => child.emit('close', 0, null));
      return child;
    };
    return { seen, spawnFn };
  }

  it('spawns OpenCode with the prompt plus the hosted addendum, on the allow-listed env', async () => {
    setActiveHostedRun({
      runId: 'run_1',
      serverUrl: 'https://app.motir.test',
      targetKey: 'PROD-7',
      dispatchedBy: 'Yue Zhu',
      stateDir: '/tmp/state',
    });
    const { seen, spawnFn } = recordingSpawn();
    const dir = mkdtempSync(join(tmpdir(), 'motir-hosted-agent-'));
    try {
      const result = await runAgent({
        command: hostedOpenCodeAgent(containerEnv()),
        prompt: 'PROMPT PROD-7',
        cwd: dir,
        spawnFn,
        tempDirFactory: () => mkdtempSync(join(tmpdir(), 'motir-hosted-prompt-')),
      });
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const { cmd, args, opts } = seen[0]!;
    expect(cmd).toBe('opencode');
    expect(args.slice(0, 4)).toEqual(['run', '--model', 'anthropic/claude-sonnet-5', '--auto']);
    const message = args[4]!;
    expect(message.startsWith('PROMPT PROD-7')).toBe(true);
    expect(message).toContain('Dispatched by Yue Zhu');
    expect(message).toContain('https://app.motir.test/runs?run=run_1');
    expect((opts.stdio as unknown[])[0]).toBe('ignore');
    const env = opts.env!;
    expect(env['MOTIR_RUN_TOKEN']).toBeUndefined();
    expect(env['MOTIR_PROMPT_FILE']).toBeTruthy();
  });

  it('attaches a prompt too long for argv as a file', async () => {
    const { seen, spawnFn } = recordingSpawn();
    await runAgent({
      command: hostedOpenCodeAgent(containerEnv()),
      prompt: 'x'.repeat(200 * 1024),
      cwd: tmpdir(),
      spawnFn,
      tempDirFactory: () => mkdtempSync(join(tmpdir(), 'motir-hosted-prompt-')),
    });
    const args = seen[0]!.args;
    expect(args[4]).toBe('--file');
    expect(args[5]).toMatch(/prompt\.md$/);
    expect(args[6]).toMatch(/^Carry out the task described in the attached file\./);
  });
});
