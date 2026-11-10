#!/usr/bin/env node
//
// WHICH IMAGES OF A RELEASE ARE IN THE REGISTRY? (MOTIR-10884)
//
// A `cli-v<x.y.z>` release publishes one `:<name>-<x.y.z>` tag per name — the
// base plus every profile in `profiles.json`. `cli-v0.17.2` (run 42705348239)
// pushed three of the nine and ended red, and the run said so only as six red
// legs: the jobs that check the published set all `need` every leg, so they
// were SKIPPED, and nothing stated which images the release was missing. The
// re-run that followed re-ran every job, so it rebuilt and re-pushed the three
// images that had landed, moving their immutable tags to new bytes.
//
// This script answers the one question both of those needed, from the registry
// itself, anonymously, the way a consumer and the image catalog ask it:
//
//   plan    — before anything is built: which names are ALREADY published at
//             this version? The release lane builds and pushes only the others,
//             and records the published ones' digests for the verify jobs, so a
//             re-run of a tag (a dispatch, or "Re-run all jobs") fills in only
//             what is missing and never re-pushes an immutable tag.
//   verify  — after every leg has ended, however it ended: name each name that
//             still has no `:<name>-<version>` tag, and fail with that list.
//
// Three-valued, like its neighbours: 0 · 1 a definite answer the lane must act
// on (verify: something is missing) · 2 the registry could not be asked. The
// positive control runs first and a failure there is 2, because a broken probe
// says "absent" about everything, and "absent" is the answer `plan` acts on —
// a plan read through a broken probe would rebuild a release that is complete.
//
// Usage:
//   release-set.mjs plan   --image <repo> --version <x.y.z> --profiles <profiles.json>
//                          [--digests <dir>] [--github-output <path>] [--summary <path>]
//   release-set.mjs verify --image <repo> --version <x.y.z> --profiles <profiles.json>
//                          [--summary <path>]
//
// No Docker and no credential: it reads manifests over the registry API.

import { CONTROL_REFERENCE, probeAnonymousPull } from './assert-public.mjs';

/** How many times a "could not tell" is re-asked. An `absent` is never re-asked:
 *  a registry that answered 404 has answered. */
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 2_000;

/** The base is published beside the profiles, under the name `base`. */
export const BASE = 'base';

/** Every name a release publishes, in the order the README records them. */
export function releaseNames(profiles) {
  return [BASE, ...profiles.map((profile) => profile.id)];
}

/** The immutable tag a release publishes for one name. */
export const versionTag = (image, name, version) => `${image}:${name}-${version}`;

async function probe(reference, options) {
  const attempts = options.attempts ?? ATTEMPTS;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let verdict;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    verdict = await probeAnonymousPull(reference, options);
    if (verdict.pullable !== null) return verdict;
    if (attempt < attempts) await sleep(options.retryDelayMs ?? RETRY_DELAY_MS);
  }
  return verdict;
}

/**
 * Ask the registry for every name's `:<name>-<version>` tag.
 *
 * Returns `{ control, published, missing, unknown }`, each list of
 * `{ name, reference, verdict }`. A name is MISSING only on a definite answer —
 * the registry served a token and then had no such manifest — and UNKNOWN on
 * anything else that is not a pull: a transport failure, or a refusal, which
 * for a public package is not a statement that the tag is absent.
 */
export async function probeReleaseSet({ image, version, names }, options = {}) {
  const control = await probe(options.control ?? CONTROL_REFERENCE, options);
  const published = [];
  const missing = [];
  const unknown = [];
  if (control.pullable !== true) return { control, published, missing, unknown };

  for (const name of names) {
    const reference = versionTag(image, name, version);
    const verdict = await probe(reference, options);
    const entry = { name, reference, verdict };
    if (verdict.pullable === true) published.push(entry);
    else if (verdict.pullable === false && verdict.reason === 'absent') missing.push(entry);
    else unknown.push(entry);
  }
  return { control, published, missing, unknown };
}

const describe = (entry) =>
  `${entry.reference} (${entry.verdict.reason ?? 'no reason'}${
    entry.verdict.detail ? `: ${entry.verdict.detail}` : ''
  })`;

/**
 * The release plan: what to build, and what is already there.
 *
 * `profiles` is the profile objects still to build (the matrix the lane runs),
 * `basePublished` whether the base job can be skipped, and `digests` the
 * recorded digest of every name already published, keyed by name.
 */
export function planRelease(profiles, set) {
  const publishedNames = new Set(set.published.map((entry) => entry.name));
  return {
    profiles: profiles.filter((profile) => !publishedNames.has(profile.id)),
    basePublished: publishedNames.has(BASE),
    digests: Object.fromEntries(set.published.map((entry) => [entry.name, entry.verdict.digest])),
  };
}

function summaryTable(title, set) {
  const rows = [
    ...set.published.map((e) => `| \`${e.name}\` | published | \`${e.verdict.digest}\` |`),
    ...set.missing.map((e) => `| \`${e.name}\` | **missing** | — |`),
    ...set.unknown.map((e) => `| \`${e.name}\` | could not tell | ${e.verdict.reason ?? ''} |`),
  ];
  return [
    `### ${title}`,
    '',
    '| Name | At this version | Digest |',
    '| --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

function argOf(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

/** Read the shared flags and the profile table. */
async function resolveInputs(argv, io) {
  const image = argOf(argv, 'image');
  const version = argOf(argv, 'version');
  const profilesPath = argOf(argv, 'profiles');
  if (!image || !version || !profilesPath) {
    throw new Error(
      'usage: release-set.mjs plan|verify --image <repo> --version <x.y.z> --profiles <profiles.json>',
    );
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`--version must be a release version like 0.17.2, got '${version}'`);
  }
  const { profiles } = JSON.parse(await io.readFile(profilesPath));
  if (!Array.isArray(profiles) || profiles.length === 0) {
    // An empty table would plan an empty release and verify it green.
    throw new Error(`${profilesPath} lists no profiles — there is no release set to check`);
  }
  return { image, version, profiles };
}

/** `plan`: 0 planned (outputs written) · 2 the registry could not be asked. */
export async function plan(argv, io, options = {}) {
  const { image, version, profiles } = await resolveInputs(argv, io);
  const set = await probeReleaseSet({ image, version, names: releaseNames(profiles) }, options);

  if (set.control.pullable !== true) {
    io.error(
      `::error::The positive control ${set.control.reference} did not resolve anonymously ` +
        `(${set.control.reason ?? 'no reason'}), so the registry cannot say what is already ` +
        `published. Nothing is skipped on a guess: re-run once GHCR answers.`,
    );
    return 2;
  }
  if (set.unknown.length > 0) {
    io.error(
      `::error::Could not tell whether ${set.unknown.length} image(s) are already published at ` +
        `${version}: ${set.unknown.map(describe).join('; ')}. Building them anyway could move an ` +
        `immutable tag to new bytes, so the release stops here instead.`,
    );
    return 2;
  }

  const planned = planRelease(profiles, set);
  const digestsDir = argOf(argv, 'digests');
  if (digestsDir) {
    await io.mkdir(digestsDir);
    for (const [name, digest] of Object.entries(planned.digests)) {
      await io.writeFile(`${digestsDir}/${name}`, `${digest}\n`);
    }
  }
  const githubOutput = argOf(argv, 'github-output');
  if (githubOutput) {
    await io.appendFile(
      githubOutput,
      [
        `profiles=${JSON.stringify(planned.profiles)}`,
        `base_published=${planned.basePublished}`,
        `published=${set.published.map((e) => e.name).join(',')}`,
        '',
      ].join('\n'),
    );
  }
  const summary = argOf(argv, 'summary');
  if (summary) await io.appendFile(summary, summaryTable(`Release plan — ${version}`, set));

  const toBuild = [...(planned.basePublished ? [] : [BASE]), ...planned.profiles.map((p) => p.id)];
  io.log(
    set.published.length === 0
      ? `nothing is published at ${version} yet — building all ${toBuild.length}`
      : `already published at ${version}, skipped: ${set.published.map((e) => e.name).join(', ')}` +
          ` · to build: ${toBuild.length === 0 ? 'nothing' : toBuild.join(', ')}`,
  );
  return 0;
}

/** `verify`: 0 complete · 1 at least one image missing · 2 could not tell. */
export async function verify(argv, io, options = {}) {
  const { image, version, profiles } = await resolveInputs(argv, io);
  const names = releaseNames(profiles);
  const set = await probeReleaseSet({ image, version, names }, options);

  if (set.control.pullable !== true) {
    io.error(
      `::error::The positive control ${set.control.reference} did not resolve anonymously ` +
        `(${set.control.reason ?? 'no reason'}) — this run proves NOTHING about which images ` +
        `the ${version} release published.`,
    );
    return 2;
  }

  const summary = argOf(argv, 'summary');
  if (summary) await io.appendFile(summary, summaryTable(`Release set — ${version}`, set));
  for (const entry of set.published)
    io.log(`published  ${entry.reference}  ${entry.verdict.digest}`);
  for (const entry of set.missing) io.log(`MISSING    ${entry.reference}`);
  for (const entry of set.unknown) io.log(`UNKNOWN    ${describe(entry)}`);

  if (set.missing.length > 0) {
    io.error(
      `::error::The ${version} release is INCOMPLETE: ${set.missing.length} of ${names.length} ` +
        `images have no :<name>-${version} tag — ${set.missing.map((e) => e.name).join(', ')}. ` +
        `Re-run the release for this tag; it pushes only the missing images.`,
    );
    if (set.unknown.length > 0) {
      io.error(
        `::error::And ${set.unknown.length} could not be checked: ${set.unknown.map(describe).join('; ')}`,
      );
    }
    return 1;
  }
  if (set.unknown.length > 0) {
    io.error(
      `::error::Could not check ${set.unknown.length} of ${names.length} images: ` +
        `${set.unknown.map(describe).join('; ')} — a PROBE failure, not a verdict on the release.`,
    );
    return 2;
  }
  io.log(`all ${names.length} images are published at ${version}`);
  return 0;
}

export async function main(argv, io, options = {}) {
  const [command, ...rest] = argv;
  if (command === 'plan') return plan(rest, io, options);
  if (command === 'verify') return verify(rest, io, options);
  throw new Error(`unknown command '${command ?? ''}' — expected 'plan' or 'verify'`);
}

// Only when executed, never when imported by the unit tests. The block runs in
// a child process, which the coverage run does not measure, so it is driven as a
// real process by the script's own suite instead.
/* v8 ignore start */
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const { readFile, writeFile, appendFile, mkdir } = await import('node:fs/promises');
  const io = {
    readFile: (path) => readFile(path, 'utf8'),
    writeFile: (path, text) => writeFile(path, text),
    appendFile: (path, text) => appendFile(path, text),
    mkdir: (path) => mkdir(path, { recursive: true }),
    log: (line) => process.stdout.write(`${line}\n`),
    error: (line) => console.error(line),
  };
  main(process.argv.slice(2), io).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    },
  );
}
/* v8 ignore stop */
