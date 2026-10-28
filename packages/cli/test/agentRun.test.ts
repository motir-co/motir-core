import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { runAgent } from '../src/agentRun.js';
import { parseAgentCommand } from '../src/agentProfiles.js';
import { CliError } from '../src/errors.js';

// The agent seam, exercised against a REAL child process (node itself plays the
// coding agent). Mocking `spawn` would assert our own stub; spawning verifies
// the contract that actually matters — that a real agent finds the prompt on
// BOTH stdin and $MOTIR_PROMPT_FILE, and that its exit code reaches us.

const PROMPT = 'CONTEXT\nWHAT TO DO\nACCEPTANCE CRITERIA\n';

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'motir-agent-'));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

/** A fake agent: a `node -e` script, parsed exactly as a user's agent command
 *  would be. `script` runs with the child's cwd/env/stdin. */
function fakeAgent(script: string) {
  const parsed = parseAgentCommand(process.execPath);
  if (!parsed) throw new Error('unreachable: execPath is non-empty');
  return { ...parsed, args: ['-e', script] };
}

describe('runAgent', () => {
  it('delivers the prompt on STDIN', async () => {
    const out = join(work, 'stdin.txt');
    const result = await runAgent({
      command: fakeAgent(
        `let b='';process.stdin.on('data',d=>b+=d);` +
          `process.stdin.on('end',()=>require('fs').writeFileSync(${JSON.stringify(out)},b));`,
      ),
      prompt: PROMPT,
      cwd: work,
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe(PROMPT);
  });

  it('delivers the prompt at $MOTIR_PROMPT_FILE too (for agents that take a path)', async () => {
    const out = join(work, 'file.txt');
    const result = await runAgent({
      command: fakeAgent(
        `const fs=require('fs');` +
          `fs.writeFileSync(${JSON.stringify(out)}, fs.readFileSync(process.env.MOTIR_PROMPT_FILE,'utf8'));`,
      ),
      prompt: PROMPT,
      cwd: work,
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe(PROMPT);
  });

  it('runs the agent in the RESOLVED cwd', async () => {
    const out = join(work, 'cwd.txt');
    const repo = mkdtempSync(join(work, 'repo-'));
    await runAgent({
      command: fakeAgent(`require('fs').writeFileSync(${JSON.stringify(out)}, process.cwd());`),
      prompt: PROMPT,
      cwd: repo,
    });
    // realpath, because macOS temp dirs are symlinked (/var → /private/var).
    expect(readFileSync(out, 'utf8')).toContain('repo-');
  });

  it('surfaces a NON-ZERO exit code instead of throwing', async () => {
    const result = await runAgent({
      command: fakeAgent('process.exit(3)'),
      prompt: PROMPT,
      cwd: work,
    });
    expect(result.exitCode).toBe(3);
    expect(result.signal).toBeNull();
  });

  it('survives an agent that never reads stdin (EPIPE is not a failure)', async () => {
    const result = await runAgent({
      command: fakeAgent('process.stdin.destroy();process.exit(0)'),
      prompt: 'x'.repeat(200_000),
      cwd: work,
    });
    expect(result.exitCode).toBe(0);
  });

  it('removes the prompt temp file afterwards', async () => {
    const out = join(work, 'path.txt');
    await runAgent({
      command: fakeAgent(
        `require('fs').writeFileSync(${JSON.stringify(out)}, process.env.MOTIR_PROMPT_FILE);`,
      ),
      prompt: PROMPT,
      cwd: work,
    });
    expect(existsSync(readFileSync(out, 'utf8'))).toBe(false);
  });

  it('throws a guiding CliError when the agent binary does not exist', async () => {
    const parsed = parseAgentCommand('motir-no-such-agent-binary');
    if (!parsed) throw new Error('unreachable');
    await expect(runAgent({ command: parsed, prompt: PROMPT, cwd: work })).rejects.toThrow(
      CliError,
    );
    await expect(runAgent({ command: parsed, prompt: PROMPT, cwd: work })).rejects.toThrow(
      /not found/,
    );
  });
});

// ── the agent's SELF-REPORT (MOTIR-2419) ────────────────────────────────────
// The model is the one thing about a BYOK run nothing outside the agent process
// can observe, so it arrives at $MOTIR_AGENT_REPORT or not at all. Driven with a
// REAL child process for the same reason the prompt channel is: the contract
// that matters is the one a foreign binary can actually satisfy.

/** A fake agent that writes `body` verbatim to $MOTIR_AGENT_REPORT. */
function reportingAgent(body: string) {
  return fakeAgent(
    `require('fs').writeFileSync(process.env.MOTIR_AGENT_REPORT, ${JSON.stringify(body)});`,
  );
}

describe('the model self-report', () => {
  it('reports the model the agent named', async () => {
    const result = await runAgent({
      command: reportingAgent('{"model":"claude-opus-5"}'),
      prompt: PROMPT,
      cwd: work,
    });
    expect(result.exitCode).toBe(0);
    expect(result.model).toBe('claude-opus-5');
  });

  it('reports NULL when the agent writes nothing — never a default', async () => {
    // The whole point of the field: a guessed model is a wrong answer wearing
    // the shape of a right one, and this is the run that would produce it.
    const result = await runAgent({
      command: fakeAgent('process.exit(0)'),
      prompt: PROMPT,
      cwd: work,
    });
    expect(result.model).toBeNull();
  });

  it('reports NULL rather than throwing on a report it cannot trust', async () => {
    for (const body of [
      'not json at all',
      '[]',
      'null',
      '{}',
      '{"model":null}',
      '{"model":42}',
      '{"model":"   "}',
      // An agent that dumped its context into the field. This is untrusted
      // input on its way to a database column — rejected, never truncated,
      // because half an identifier is a wrong answer rather than a partial one.
      `{"model":"${'m'.repeat(201)}"}`,
    ]) {
      const result = await runAgent({ command: reportingAgent(body), prompt: PROMPT, cwd: work });
      expect(result.exitCode, body).toBe(0);
      expect(result.model, body).toBeNull();
    }
  });

  it('trims the reported model', async () => {
    const result = await runAgent({
      command: reportingAgent('{"model":"  gpt-5-codex \\n"}'),
      prompt: PROMPT,
      cwd: work,
    });
    expect(result.model).toBe('gpt-5-codex');
  });

  it('reads the STOP step’s `unbuildable` reason beside the model (MOTIR-8698)', async () => {
    const result = await runAgent({
      command: reportingAgent('{"model":"m-1","unbuildable":"  the table does not exist \\n"}'),
      prompt: PROMPT,
      cwd: work,
    });
    expect(result.model).toBe('m-1');
    expect(result.unbuildableReason).toBe('the table does not exist');
  });

  it('a reason with no model is still a reason; a bad one is null, never an error', async () => {
    const alone = await runAgent({
      command: reportingAgent('{"unbuildable":"no such table"}'),
      prompt: PROMPT,
      cwd: work,
    });
    expect(alone).toMatchObject({ model: null, unbuildableReason: 'no such table' });
    for (const body of ['{"unbuildable":42}', '{"unbuildable":"   "}', '{"model":"m-1"}']) {
      const result = await runAgent({ command: reportingAgent(body), prompt: PROMPT, cwd: work });
      expect(result.unbuildableReason, body).toBeNull();
    }
  });

  it('CUTS an over-long reason to the server’s bound rather than dropping the report', async () => {
    const result = await runAgent({
      command: reportingAgent(JSON.stringify({ unbuildable: 'r'.repeat(5000) })),
      prompt: PROMPT,
      cwd: work,
    });
    expect(result.unbuildableReason).toBe('r'.repeat(4000));
  });

  it('reads a build-through’s `discrepancy` points, dropping a point missing a field (MOTIR-8722)', async () => {
    const good = { planAsked: ' asked ', built: 'built', why: 'why' };
    const result = await runAgent({
      command: reportingAgent(
        JSON.stringify({ model: 'm-1', discrepancy: [good, { planAsked: 'a', built: 'b' }, 7] }),
      ),
      prompt: PROMPT,
      cwd: work,
    });
    expect(result.discrepancy).toEqual([{ planAsked: 'asked', built: 'built', why: 'why' }]);
    for (const body of ['{"discrepancy":[]}', '{"discrepancy":"x"}', '{"model":"m-1"}']) {
      const none = await runAgent({ command: reportingAgent(body), prompt: PROMPT, cwd: work });
      expect(none.discrepancy, body).toBeNull();
    }
    const many = await runAgent({
      command: reportingAgent(JSON.stringify({ discrepancy: Array(25).fill(good) })),
      prompt: PROMPT,
      cwd: work,
    });
    expect(many.discrepancy).toHaveLength(20);
  });

  it('reads the `decisions` the agent made, on the points’ terms (MOTIR-10000)', async () => {
    const good = { planSaid: ' nothing ', chose: 'cursor pages', why: 'the repo pages this way' };
    const result = await runAgent({
      command: reportingAgent(
        JSON.stringify({
          model: 'm-1',
          decisions: [
            good,
            { ...good, alternatives: ' offset pages ' },
            { ...good, alternatives: '   ' },
            { planSaid: 'a', chose: 'b' },
            'x',
          ],
        }),
      ),
      prompt: PROMPT,
      cwd: work,
    });
    const clean = { planSaid: 'nothing', chose: 'cursor pages', why: 'the repo pages this way' };
    expect(result.decisions).toEqual([clean, { ...clean, alternatives: 'offset pages' }, clean]);
    for (const body of ['{"decisions":[]}', '{"decisions":{}}', '{"model":"m-1"}']) {
      const none = await runAgent({ command: reportingAgent(body), prompt: PROMPT, cwd: work });
      expect(none.decisions, body).toBeNull();
    }
    const many = await runAgent({
      command: reportingAgent(JSON.stringify({ decisions: Array(25).fill(good) })),
      prompt: PROMPT,
      cwd: work,
    });
    expect(many.decisions).toHaveLength(20);
  });

  it('reads a STOP: its comment falls back to the `unbuildable` text, the brief is kept (MOTIR-8722)', async () => {
    const result = await runAgent({
      command: reportingAgent(
        JSON.stringify({
          unbuildable: 'no such table',
          stop: {
            toPlanning: true,
            requirement: { outcome: 'O', scopeEdge: '', behaviour: 42 },
          },
        }),
      ),
      prompt: PROMPT,
      cwd: work,
    });
    expect(result.stop).toEqual({
      comment: 'no such table',
      toPlanning: true,
      requirement: { outcome: 'O', scopeEdge: '' },
    });

    const own = await runAgent({
      command: reportingAgent(JSON.stringify({ stop: { comment: 'mine', toPlanning: 'yes' } })),
      prompt: PROMPT,
      cwd: work,
    });
    expect(own.stop).toEqual({ comment: 'mine', toPlanning: false, requirement: null });

    // Nothing to say on the card: no stop.
    const silent = await runAgent({
      command: reportingAgent(JSON.stringify({ stop: { toPlanning: true } })),
      prompt: PROMPT,
      cwd: work,
    });
    expect(silent.stop).toBeNull();
  });

  it('keeps the report of an agent that FAILED — it still ran on that model', async () => {
    const result = await runAgent({
      command: fakeAgent(
        `require('fs').writeFileSync(process.env.MOTIR_AGENT_REPORT,'{"model":"m-1"}');` +
          `process.exit(7);`,
      ),
      prompt: PROMPT,
      cwd: work,
    });
    expect(result.exitCode).toBe(7);
    expect(result.model).toBe('m-1');
  });

  it('puts the report in the PER-RUN temp dir, and takes it away with the dir', async () => {
    // Load-bearing against the staleness failure: a fixed path in the checkout
    // would carry item N's model onto item N+1 whenever the agent wrote nothing.
    const out = join(work, 'report-path.txt');
    const first = await runAgent({
      command: fakeAgent(
        `const fs=require('fs');const p=process.env.MOTIR_AGENT_REPORT;` +
          `fs.writeFileSync(${JSON.stringify(out)},p);fs.writeFileSync(p,'{"model":"m-1"}');`,
      ),
      prompt: PROMPT,
      cwd: work,
    });
    expect(first.model).toBe('m-1');
    const path = readFileSync(out, 'utf8');
    expect(existsSync(path)).toBe(false);

    // A SECOND run that reports nothing cannot inherit the first one's answer.
    const second = await runAgent({
      command: fakeAgent('process.exit(0)'),
      prompt: PROMPT,
      cwd: work,
    });
    expect(second.model).toBeNull();
  });

  it('sits beside the prompt file, so an agent gets both channels or neither', async () => {
    const out = join(work, 'both.txt');
    await runAgent({
      command: fakeAgent(
        `require('fs').writeFileSync(${JSON.stringify(out)},` +
          `JSON.stringify([process.env.MOTIR_PROMPT_FILE,process.env.MOTIR_AGENT_REPORT]));`,
      ),
      prompt: PROMPT,
      cwd: work,
    });
    const [promptFile, reportFile] = JSON.parse(readFileSync(out, 'utf8')) as string[];
    expect(promptFile).toBeTruthy();
    expect(reportFile).toBeTruthy();
    expect(join(reportFile as string, '..')).toBe(join(promptFile as string, '..'));
  });
});

// ── coverage gaps closed by 7.9.5 (MOTIR-883) ───────────────────────────────
// The launch-failure and death-by-signal edges. A BYOK agent is somebody else's
// binary, so "it wasn't there" and "it was killed" are ordinary outcomes the CLI
// has to distinguish: the first is a setup problem `motir doctor` fixes, the
// second is a failed run the loop records.

describe('launch + death edges', () => {
  it('a MISSING agent binary is a setup error pointing at `motir doctor`', async () => {
    await expect(
      runAgent({
        command: parseAgentCommand('motir-no-such-agent-binary')!,
        prompt: PROMPT,
        cwd: work,
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('not found'),
      hint: expect.stringContaining('motir doctor'),
    });
  });

  it('any OTHER spawn failure is reported with its own message, not swallowed', async () => {
    // A directory is not executable: spawn fails with EACCES/EISDIR rather than
    // ENOENT, which must still surface as a clean CliError.
    await expect(
      runAgent({ command: parseAgentCommand(work)!, prompt: PROMPT, cwd: work }),
    ).rejects.toBeInstanceOf(CliError);
  });

  it('an agent KILLED by a signal reports exit 1 and names the signal', async () => {
    const result = await runAgent({
      command: parseAgentCommand(`${process.execPath} -e process.kill(process.pid,"SIGKILL")`)!,
      prompt: PROMPT,
      cwd: work,
    });
    expect(result.exitCode).toBe(1);
    expect(result.signal).toBe('SIGKILL');
  });

  it('an agent that never reads stdin still gets the prompt on disk (EPIPE is not an error)', async () => {
    const marker = join(work, 'read-from-file.txt');
    const result = await runAgent({
      command: parseAgentCommand(
        `${process.execPath} -e process.stdin.destroy();require("fs").copyFileSync(process.env.MOTIR_PROMPT_FILE,${JSON.stringify(marker)})`,
      )!,
      prompt: PROMPT,
      cwd: work,
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe(PROMPT);
  });

  it('removes the prompt temp dir even when the launch fails', async () => {
    const dirs: string[] = [];
    await expect(
      runAgent({
        command: parseAgentCommand('motir-no-such-agent-binary')!,
        prompt: PROMPT,
        cwd: work,
        tempDirFactory: () => {
          const dir = mkdtempSync(join(tmpdir(), 'motir-prompt-'));
          dirs.push(dir);
          return dir;
        },
      }),
    ).rejects.toThrow();
    expect(dirs).toHaveLength(1);
    expect(existsSync(dirs[0]!)).toBe(false);
  });
});

describe('the injected spawn seam covers what a real child cannot show', () => {
  it('tolerates an agent process with NO stdin, and a close with neither code nor signal', async () => {
    // Both are shapes a real `spawn` under our stdio settings never produces,
    // but the code handles them deliberately: the prompt is also on disk, and a
    // close with no exit code is not success.
    const child = new EventEmitter() as EventEmitter & { stdin: null };
    child.stdin = null;
    const result = runAgent({
      command: parseAgentCommand('anything')!,
      prompt: PROMPT,
      cwd: work,
      spawnFn: () => child as never,
    });
    child.emit('close', null, null);

    expect(await result).toEqual({
      exitCode: 1,
      signal: null,
      model: null,
      unbuildableReason: null,
      discrepancy: null,
      decisions: null,
      stop: null,
    });
  });
});

describe('an agent-mode launcher (MOTIR-7024)', () => {
  it('appends its addendum on every channel, and spawns with ITS environment and nothing wider', async () => {
    const spawned: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    let stdin = '';
    const child = new EventEmitter() as EventEmitter & {
      stdin: { on: () => void; end: (s: string) => void };
    };
    child.stdin = { on: () => undefined, end: (s: string) => (stdin = s) };
    const result = runAgent({
      command: {
        ...parseAgentCommand('claude -p')!,
        env: { PATH: '/bin', CLAUDE_CONFIG_DIR: '/h/.claude' },
        promptArgs: (prompt) => [`ARG:${prompt}`],
        promptAddendum: () => '\nADDENDUM',
      },
      prompt: PROMPT,
      cwd: work,
      env: { MOTIR_TOKEN: 'never-inherited' },
      spawnFn: (_cmd, args, opts) => {
        spawned.push({ args, env: opts.env as NodeJS.ProcessEnv });
        return child as never;
      },
    });
    child.emit('close', 0, null);
    await result;

    expect(stdin).toBe(`${PROMPT}\nADDENDUM`);
    expect(spawned[0]!.args).toEqual(['-p', `ARG:${PROMPT}\nADDENDUM`]);
    const env = spawned[0]!.env;
    expect(env['MOTIR_TOKEN']).toBeUndefined();
    expect(env['CLAUDE_CONFIG_DIR']).toBe('/h/.claude');
    expect(Object.keys(env).sort()).toEqual([
      'CLAUDE_CONFIG_DIR',
      'MOTIR_AGENT_REPORT',
      'MOTIR_PROMPT_FILE',
      'PATH',
    ]);
  });
});

describe('a streaming run (MOTIR-8980)', () => {
  const line = (value: unknown) => JSON.stringify(value) + '\n';
  const init = line({ type: 'system', subtype: 'init', session_id: 'sess-from-stream' });
  const toolCall = line({
    type: 'assistant',
    message: {
      id: 'm1',
      content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'lib/x.ts' } }],
    },
  });
  const reply = line({
    type: 'assistant',
    message: { id: 'm2', content: [{ type: 'text', text: 'Done.' }] },
  });

  /** A child that writes `first`, waits for the test to say go, then writes `rest` and exits. */
  function streamingAgent(first: string, rest: string, goFile: string) {
    return {
      ...fakeAgent(
        `process.stdout.write(${JSON.stringify(first)});` +
          `const fs=require('fs');` +
          `const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(goFile)})){clearInterval(t);` +
          `process.stdout.write(${JSON.stringify(rest)});}},10);`,
      ),
      stream: { profile: 'claude', sessionId: null },
    };
  }

  it('hands the log a readable line WHILE the agent is still running, never the JSON event', async () => {
    const goFile = join(work, 'go');
    const chunks: string[] = [];
    let seenEarly: string | null = null;
    let finished = false;
    const run = runAgent({
      command: streamingAgent(init + toolCall, reply, goFile),
      prompt: PROMPT,
      cwd: work,
      onOutput: (chunk) => {
        chunks.push(chunk);
        if (!finished && seenEarly === null) seenEarly = chunks.join('');
      },
    }).finally(() => {
      finished = true;
    });
    // The agent has not exited, and its first action is already in the log.
    await vi.waitFor(() => expect(seenEarly).toBe('Edit lib/x.ts\n'));
    expect(finished).toBe(false);
    writeFileSync(goFile, '');
    const result = await run;
    expect(result.exitCode).toBe(0);
    expect(chunks.join('')).toBe('Edit lib/x.ts\nDone.\n');
    expect(chunks.join('')).not.toContain('{');
  });

  it('records the session id the stream named', async () => {
    const goFile = join(work, 'go');
    writeFileSync(goFile, '');
    const result = await runAgent({
      command: streamingAgent(init + toolCall, reply, goFile),
      prompt: PROMPT,
      cwd: work,
    });
    expect(result.sessionId).toBe('sess-from-stream');
  });

  it('falls back to the id Motir chose before the spawn when the stream names none', async () => {
    const goFile = join(work, 'go');
    writeFileSync(goFile, '');
    const result = await runAgent({
      command: {
        ...streamingAgent(toolCall, reply, goFile),
        stream: { profile: 'claude', sessionId: 'chosen-id' },
      },
      prompt: PROMPT,
      cwd: work,
    });
    expect(result.sessionId).toBe('chosen-id');
  });

  it('pipes stdout even with no log to tee, so the terminal never gets the JSON either', async () => {
    const goFile = join(work, 'go');
    writeFileSync(goFile, '');
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    try {
      await runAgent({
        command: streamingAgent(init + toolCall, reply, goFile),
        prompt: PROMPT,
        cwd: work,
      });
    } finally {
      spy.mockRestore();
    }
    expect(written.join('')).toBe('Edit lib/x.ts\nDone.\n');
  });

  it('flushes the line still open when the agent exits mid-sentence', async () => {
    const goFile = join(work, 'go');
    writeFileSync(goFile, '');
    const delta = line({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Half a thou' },
      },
    });
    const start = line({
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'm9' } },
    });
    const chunks: string[] = [];
    await runAgent({
      command: streamingAgent(start + delta, '', goFile),
      prompt: PROMPT,
      cwd: work,
      onOutput: (c) => chunks.push(c),
    });
    expect(chunks.join('')).toBe('Half a thou\n');
  });

  it('leaves a command with no stream alone: raw output, no session id', async () => {
    const chunks: string[] = [];
    const result = await runAgent({
      command: fakeAgent(`process.stdout.write('{"type":"x"}\\n')`),
      prompt: PROMPT,
      cwd: work,
      onOutput: (c) => chunks.push(c),
    });
    expect(chunks.join('')).toBe('{"type":"x"}\n');
    expect(result.sessionId).toBeUndefined();
  });
});
