import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
// A zero-dependency release-lane script, deliberately `.mjs`; its typed contract
// lives beside it in `push-with-retry.d.mts`.
import {
  backoffMs,
  classifyPushFailure,
  DEFAULT_ATTEMPTS,
  DEFAULT_BASE_DELAY_MS,
  lastErrorLine,
  main,
  nodeRun,
  parseArgs,
  pushWithRetry,
  readDigest,
  type PushAttemptResult,
} from '../sandbox/smoke/push-with-retry.mjs';

// The release lane's push retry (MOTIR-10884). The fixtures are the lines the
// release actually printed: `cli-v0.17.2` (run 42705348239) lost six of nine
// pushes to `denied: permission_denied: write_package`, and a build failure is
// the line buildx prints when a Dockerfile `RUN` exits non-zero.

const DENIED =
  'ERROR: failed to build: failed to solve: failed to push ' +
  'ghcr.io/motir-co/motir-sandbox:claude: denied: permission_denied: write_package';
const BUILD_FAILED =
  'ERROR: failed to build: failed to solve: process "/bin/sh -c /tmp/install-agent.sh" ' +
  'did not complete successfully: exit code: 1';
const DIGEST = `sha256:${'a'.repeat(64)}`;

const output = (...lines: string[]): string =>
  ['#78 writing layer sha256:5bf17baa 1.2s done', ...lines].join('\n');

/** A push whose attempts answer in order; the last answer repeats. */
const scripted = (...answers: PushAttemptResult[]) => {
  const run = vi.fn(async (attempt: number) => answers[Math.min(attempt, answers.length) - 1]!);
  return run;
};

describe('classifyPushFailure — what is worth asking the registry again', () => {
  it.each([
    ['the cli-v0.17.2 refusal', DENIED],
    [
      'a 5xx',
      'ERROR: failed to push x: unexpected status from PUT request to https://ghcr.io/v2/x: 502 Bad Gateway',
    ],
    ['a 429', 'ERROR: failed to push x: toomanyrequests: retry later'],
    [
      'a timeout',
      'ERROR: failed to do request: Head "https://ghcr.io/v2/x": dial tcp: i/o timeout',
    ],
    ['a reset connection', 'ERROR: failed to push x: write tcp: connection reset by peer'],
    ['an unauthorized', 'ERROR: failed to push x: unauthorized: authentication required'],
  ])('retries %s', (_name, line) => {
    const verdict = classifyPushFailure(output(line));
    expect(verdict.retry).toBe(true);
    expect(verdict.line).toBe(line);
  });

  it('never retries a BUILD failure, even one whose text says timeout', () => {
    expect(classifyPushFailure(output(BUILD_FAILED))).toMatchObject({
      retry: false,
      reason: expect.stringContaining('BUILD failed'),
    });
    // A `RUN curl` that timed out is the build's failure, not the registry's.
    const curl = `${BUILD_FAILED.replace('exit code: 1', 'exit code: 28')} (curl: operation timed out)`;
    expect(classifyPushFailure(output(curl)).retry).toBe(false);
  });

  it('does not retry an error that names no registry refusal', () => {
    const verdict = classifyPushFailure(
      output('ERROR: invalid tag "Bad:Tag": repository name must be lowercase'),
    );
    expect(verdict).toMatchObject({ retry: false, reason: 'not a recognised registry refusal' });
  });

  it('does not retry an output with no ERROR line at all', () => {
    expect(classifyPushFailure(output('Killed'))).toEqual({
      retry: false,
      reason: expect.stringContaining('no ERROR line'),
      line: null,
    });
  });

  it("reads the LAST error line, which is buildx's verdict", () => {
    const text = output('ERROR: an earlier warning-level error', DENIED, '');
    expect(lastErrorLine(text)).toBe(DENIED);
    expect(lastErrorLine('')).toBeNull();
  });
});

describe('backoffMs', () => {
  it('doubles from the base: 30 s, then 60 s', () => {
    expect(DEFAULT_BASE_DELAY_MS).toBe(30_000);
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(3, 10)).toBe(40);
  });
});

describe('pushWithRetry', () => {
  it('publishes within the same run when the FIRST push is refused with denied', async () => {
    // Acceptance criterion 1 of MOTIR-10884, driven through the real decision.
    const run = scripted({ code: 1, output: output(DENIED) }, { code: 0, output: 'pushed' });
    const sleep = vi.fn(async () => {});
    const log = vi.fn();
    const result = await pushWithRetry({ run, sleep, label: 'claude', log });
    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(result.failures).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(30_000);
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      expect.stringMatching(
        /^::warning::Push of claude refused on attempt 1 of 3 .*retrying in 30 s\.$/,
      ),
      '::notice::Pushed claude on attempt 2 of 3, after 1 registry refusal.',
    ]);
  });

  it('says how many refusals it took when there was more than one', async () => {
    const run = scripted(
      { code: 1, output: DENIED },
      { code: 1, output: DENIED },
      { code: 0, output: '' },
    );
    const log = vi.fn();
    const result = await pushWithRetry({ run, sleep: async () => {}, log, baseDelayMs: 1 });
    expect(result).toMatchObject({ ok: true, attempts: 3 });
    expect(log).toHaveBeenLastCalledWith(
      '::notice::Pushed image on attempt 3 of 3, after 2 registry refusals.',
    );
  });

  it('succeeds first time without waiting or annotating', async () => {
    const sleep = vi.fn(async () => {});
    const log = vi.fn();
    const result = await pushWithRetry({ run: scripted({ code: 0, output: '' }), sleep, log });
    expect(result).toEqual({ ok: true, attempts: 1, failures: [] });
    expect(sleep).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('gives up after the last attempt, still refused', async () => {
    const run = scripted({ code: 1, output: DENIED });
    const sleep = vi.fn(async () => {});
    const log = vi.fn();
    const result = await pushWithRetry({ run, sleep, log });
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(DEFAULT_ATTEMPTS);
    expect(run).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[30_000], [60_000]]);
    expect(log).toHaveBeenLastCalledWith(
      `::error::Push of image was refused on all 3 attempts — last: ${DENIED}`,
    );
  });

  it('stops at once on a build failure, without a second attempt', async () => {
    const run = scripted({ code: 1, output: output(BUILD_FAILED) }, { code: 0, output: '' });
    const sleep = vi.fn(async () => {});
    const log = vi.fn();
    const result = await pushWithRetry({ run, sleep, log, label: 'kimi' });
    expect(result).toMatchObject({ ok: false, attempts: 1 });
    expect(run).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(
        /^::error::Push of kimi failed on attempt 1 and is not retried — the BUILD failed/,
      ),
    );
  });

  it('reports a final failure with no ERROR line without a trailing quote', async () => {
    const log = vi.fn();
    await pushWithRetry({
      run: scripted({ code: 137, output: 'Killed' }),
      sleep: async () => {},
      log,
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/so there is no registry refusal to retry$/),
    );
  });

  it('pushes nothing for a zero attempt count', async () => {
    const run = vi.fn();
    expect(await pushWithRetry({ run, sleep: async () => {}, attempts: 0 })).toEqual({
      ok: false,
      attempts: 0,
      failures: [],
    });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('readDigest', () => {
  it('reads the image digest buildx recorded', () => {
    expect(readDigest(JSON.stringify({ 'containerimage.digest': DIGEST }))).toBe(DIGEST);
  });

  it('refuses a file that is not JSON, or names no sha256 digest', () => {
    expect(() => readDigest('not json')).toThrow('not JSON');
    expect(() => readDigest('{}')).toThrow("no sha256 image digest (got '')");
    expect(() => readDigest(JSON.stringify({ 'containerimage.digest': 'sha256:abc' }))).toThrow(
      "got 'sha256:abc'",
    );
    expect(() => readDigest('null')).toThrow('no sha256 image digest');
  });
});

describe('parseArgs', () => {
  it('splits its own flags from the command at --', () => {
    expect(
      parseArgs([
        '--label',
        'codex',
        '--metadata-file',
        '/tmp/m.json',
        '--github-output',
        '/tmp/out',
        '--attempts',
        '5',
        '--base-delay-ms',
        '0',
        '--',
        'docker',
        'buildx',
        'build',
        '--push',
        '.',
      ]),
    ).toEqual({
      command: ['docker', 'buildx', 'build', '--push', '.'],
      metadataFile: '/tmp/m.json',
      githubOutput: '/tmp/out',
      label: 'codex',
      attempts: 5,
      baseDelayMs: 0,
    });
  });

  it('defaults what it can', () => {
    expect(parseArgs(['--metadata-file', 'm', '--', 'true'])).toMatchObject({
      label: 'image',
      attempts: DEFAULT_ATTEMPTS,
      baseDelayMs: DEFAULT_BASE_DELAY_MS,
      githubOutput: undefined,
    });
  });

  it('refuses a missing command, a missing metadata file and a bad number', () => {
    expect(() => parseArgs(['--metadata-file', 'm'])).toThrow('usage:');
    expect(() => parseArgs(['--metadata-file', 'm', '--'])).toThrow('usage:');
    expect(() => parseArgs(['--', 'true'])).toThrow('--metadata-file is required');
    expect(() => parseArgs(['--metadata-file', 'm', '--attempts', '0', '--', 'true'])).toThrow(
      "--attempts must be a whole number, got '0'",
    );
    expect(() => parseArgs(['--metadata-file', 'm', '--base-delay-ms', 'x', '--', 'true'])).toThrow(
      '--base-delay-ms must be a whole number',
    );
  });
});

describe('main', () => {
  const io = (
    answers: PushAttemptResult[],
    metadata = JSON.stringify({ 'containerimage.digest': DIGEST }),
  ) => {
    let call = 0;
    return {
      run: vi.fn(async () => answers[Math.min(call++, answers.length - 1)]!),
      sleep: vi.fn(async () => {}),
      readFile: vi.fn(async () => metadata),
      appendFile: vi.fn(async () => {}),
      log: vi.fn(),
    };
  };
  const argv = [
    '--label',
    'claude',
    '--metadata-file',
    '/m.json',
    '--github-output',
    '/out',
    '--',
    'docker',
    'push',
  ];

  it('retries the refused push, then writes the digest the record step reads', async () => {
    const seam = io([
      { code: 1, output: DENIED },
      { code: 0, output: '' },
    ]);
    expect(await main(argv, seam)).toBe(0);
    expect(seam.run).toHaveBeenCalledWith(['docker', 'push']);
    expect(seam.run).toHaveBeenCalledTimes(2);
    expect(seam.readFile).toHaveBeenCalledWith('/m.json');
    expect(seam.appendFile).toHaveBeenCalledWith('/out', `digest=${DIGEST}\n`);
    expect(seam.log).toHaveBeenCalledWith(`claude pushed as ${DIGEST}`);
  });

  it('writes no output when none is asked for', async () => {
    const seam = io([{ code: 0, output: '' }]);
    expect(await main(['--metadata-file', '/m.json', '--', 'true'], seam)).toBe(0);
    expect(seam.appendFile).not.toHaveBeenCalled();
  });

  it('exits 1 and reads no digest when the push fails for good', async () => {
    const seam = io([{ code: 1, output: BUILD_FAILED }]);
    expect(await main(argv, seam)).toBe(1);
    expect(seam.readFile).not.toHaveBeenCalled();
    expect(seam.appendFile).not.toHaveBeenCalled();
  });
});

describe('nodeRun', () => {
  class FakeChild extends EventEmitter {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
  }

  it('passes output through, keeps it to classify, and resolves the exit code', async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child);
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const pending = nodeRun(spawn, stdout, stderr)(['docker', 'buildx', 'build']);
    child.stdout.emit('data', Buffer.from('#1 pushing\n'));
    child.stderr.emit('data', `${DENIED}\n`);
    child.emit('close', 1);
    expect(await pending).toEqual({ code: 1, output: `#1 pushing\n${DENIED}\n` });
    expect(spawn).toHaveBeenCalledWith('docker', ['buildx', 'build'], {
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    expect(stdout.write).toHaveBeenCalledTimes(1);
    expect(stderr.write).toHaveBeenCalledTimes(1);
  });

  it('keeps only the tail of a long output', async () => {
    const child = new FakeChild();
    const pending = nodeRun(() => child, { write() {} }, { write() {} })(['x']);
    child.stdout.emit('data', 'a'.repeat(70 * 1024));
    child.stdout.emit('data', 'END');
    child.emit('close', null);
    const result = await pending;
    expect(result.code).toBe(1);
    expect(result.output.length).toBe(64 * 1024);
    expect(result.output.endsWith('END')).toBe(true);
  });

  it('reports a command that cannot start as a final failure', async () => {
    const child = new FakeChild();
    const pending = nodeRun(() => child, { write() {} }, { write() {} })(['nope']);
    child.emit('error', new Error('spawn nope ENOENT'));
    const result = await pending;
    expect(result).toEqual({ code: 127, output: '\nspawn nope ENOENT' });
    expect(classifyPushFailure(result.output).retry).toBe(false);
  });
});

describe('as a process', () => {
  const script = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'sandbox',
    'smoke',
    'push-with-retry.mjs',
  );

  it('runs the real command, then writes the digest from its metadata file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'push-retry-'));
    const metadata = join(dir, 'metadata.json');
    const out = join(dir, 'out');
    // A stand-in push that does what `buildx --metadata-file` does on success.
    const push = `require('fs').writeFileSync(${JSON.stringify(metadata)}, JSON.stringify({'containerimage.digest': '${DIGEST}'}))`;
    const run = spawnSync(
      process.execPath,
      [
        script,
        '--label',
        'claude',
        '--metadata-file',
        metadata,
        '--github-output',
        out,
        '--',
        process.execPath,
        '-e',
        push,
      ],
      { encoding: 'utf8' },
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`claude pushed as ${DIGEST}`);
    expect(readFileSync(out, 'utf8')).toBe(`digest=${DIGEST}\n`);
  });

  it('exits 1 on a build failure without retrying it', () => {
    const run = spawnSync(
      process.execPath,
      [
        script,
        '--metadata-file',
        '/nonexistent',
        '--',
        process.execPath,
        '-e',
        `console.error(${JSON.stringify(BUILD_FAILED)}); process.exit(1)`,
      ],
      { encoding: 'utf8' },
    );
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/::error::Push of image failed on attempt 1 and is not retried/);
  });

  it('exits 1 with one annotation on a usage error', () => {
    const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr.trim()).toMatch(/^::error::usage: push-with-retry\.mjs/);
  });
});
