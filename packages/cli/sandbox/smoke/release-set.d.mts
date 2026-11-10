// The typed contract of `release-set.mjs` (MOTIR-10884).
//
// Plain `.mjs` for the same reason as its neighbours — it runs on a bare release
// runner with no install. This file lets `test/sandboxReleaseSet.test.ts` drive it
// under strict TypeScript and is its published API.

import type { AnonymousPullVerdict, ProbeOptions } from './assert-public.mjs';

export declare const BASE: 'base';

export interface ReleaseProfile {
  id: string;
  tier: number;
  liveness: string;
}

export interface ReleaseEntry {
  name: string;
  /** `<image>:<name>-<version>`, the tag a release publishes for the name. */
  reference: string;
  verdict: AnonymousPullVerdict;
}

export interface ReleaseSet {
  control: AnonymousPullVerdict;
  published: ReleaseEntry[];
  /** A DEFINITE absence: the registry served a token and had no such manifest. */
  missing: ReleaseEntry[];
  /** Anything that is neither a pull nor a definite absence. */
  unknown: ReleaseEntry[];
}

export interface ReleaseSetOptions extends ProbeOptions {
  sleep?(ms: number): Promise<void>;
}

export interface ReleasePlan {
  profiles: ReleaseProfile[];
  basePublished: boolean;
  digests: Record<string, string | null>;
}

export declare function releaseNames(profiles: ReleaseProfile[]): string[];
export declare function versionTag(image: string, name: string, version: string): string;
export declare function probeReleaseSet(
  query: { image: string; version: string; names: string[] },
  options?: ReleaseSetOptions,
): Promise<ReleaseSet>;
export declare function planRelease(profiles: ReleaseProfile[], set: ReleaseSet): ReleasePlan;

/** The IO seam, so the CLI entrypoint can be driven from a test. */
export interface ReleaseSetIo {
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  appendFile(path: string, text: string): Promise<void>;
  mkdir(path: string): Promise<unknown>;
  log(line: string): void;
  error(line: string): void;
}

export declare function plan(
  argv: string[],
  io: ReleaseSetIo,
  options?: ReleaseSetOptions,
): Promise<0 | 2>;
export declare function verify(
  argv: string[],
  io: ReleaseSetIo,
  options?: ReleaseSetOptions,
): Promise<0 | 1 | 2>;
export declare function main(
  argv: string[],
  io: ReleaseSetIo,
  options?: ReleaseSetOptions,
): Promise<0 | 1 | 2>;
