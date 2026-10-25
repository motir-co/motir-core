import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FakeCapacityOperation } from '@motir/orchestrator';

// THE PER-ACCOUNT VIEWS OF THE PERSISTENT FAKE, ACROSS PROCESSES (Story
// MOTIR-9361 · MOTIR-9478). `fakePersistentOrchestratorForShard` records which of
// its operations each account was asked for, and holds an account's room. In one
// test process that lives in memory; in the E2E lane the web server, the job
// worker (which runs the boot passes) and the spec are three processes, so both
// also live beside the persistent fake's shared state file:
//
//   * `<state>.shard-calls.jsonl` — one line per call an account's view made:
//     the account, the operation and the machine (or disk) it named. Appended,
//     so two processes writing at once each keep their line.
//   * `<state>.shard-holds.json` — the operations each account refuses as full.
//
// Unset — every unit test and every real deployment — nothing here touches disk.

const STATE_PATH_ENV = 'MOTIR_FAKE_PERSISTENT_STATE_PATH';

/** One operation an account's view was asked for. */
export interface ShardFakeCall {
  readonly shardId: string;
  readonly op: string;
  /** The machine it named (a provision: the machine it made), else the disk; null when none. */
  readonly ref: string | null;
}

function statePath(): string | null {
  const raw = process.env[STATE_PATH_ENV];
  return raw ? raw : null;
}

function callsPath(): string | null {
  const path = statePath();
  return path ? `${path}.shard-calls.jsonl` : null;
}

function holdsPath(): string | null {
  const path = statePath();
  return path ? `${path}.shard-holds.json` : null;
}

/** Is the journal shared — a state file set? */
export function shardFakeJournalShared(): boolean {
  return statePath() !== null;
}

export function appendShardFakeCall(call: ShardFakeCall): void {
  const path = callsPath();
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(call)}\n`, 'utf8');
}

/** Every call recorded since the journal was last cleared, oldest first. */
export function readShardFakeCalls(): ShardFakeCall[] {
  const path = callsPath();
  if (!path || !existsSync(path)) return [];
  const out: ShardFakeCall[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as ShardFakeCall);
    } catch {
      // A line torn by a concurrent append: the next read has it whole.
    }
  }
  return out;
}

type Holds = Record<string, FakeCapacityOperation[]>;

function readHolds(): Holds {
  const path = holdsPath();
  if (!path || !existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Holds;
  } catch {
    return {};
  }
}

function writeHolds(holds: Holds): void {
  const path = holdsPath();
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(holds), 'utf8');
}

/** Does this account refuse `op` as full, by the shared holds? */
export function shardHeldShared(shardId: string, op: FakeCapacityOperation): boolean {
  return readHolds()[shardId]?.includes(op) ?? false;
}

/** Hold one account's room for `op`, for every process sharing the state file. */
export function holdShardShared(shardId: string, op: FakeCapacityOperation): void {
  const holds = readHolds();
  holds[shardId] = [...new Set([...(holds[shardId] ?? []), op])];
  writeHolds(holds);
}

/** Lift one account's holds (all of them, or one operation's). */
export function releaseShardShared(shardId: string, op?: FakeCapacityOperation): void {
  const holds = readHolds();
  holds[shardId] = op ? (holds[shardId] ?? []).filter((held) => held !== op) : [];
  writeHolds(holds);
}

/** Clear the calls and the holds — a spec's fresh start. */
export function resetShardFakeJournal(): void {
  const calls = callsPath();
  if (calls) {
    mkdirSync(dirname(calls), { recursive: true });
    writeFileSync(calls, '', 'utf8');
  }
  writeHolds({});
}
