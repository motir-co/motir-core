/**
 * `pnpm tsx scripts/seed-registry/verify-starter-manifests.ts` — check every
 * ACTIVE seed registry entry against its live template on GitHub (Story MOTIR-704
 * · MOTIR-9813; decision MOTIR-706 v2 §3.4).
 *
 * For each entry that names a template it reads, through the GitHub contents
 * API, the repository (it must exist and be a template) and its default branch's
 * commit. An entry that deploys somewhere must ship `motir.hosting.json`, which
 * the shipped `parseHostingManifest` must accept, and the entry's
 * `hostingTargets` must be a subset of the manifest's `targets`. An entry with
 * no target (a non-web foundation, 706 3.2) needs no manifest.
 *
 * READ ONLY: it writes nothing to the database or to GitHub. It exits 1 when any
 * entry fails, so it doubles as a pre-release check. `GITHUB_TOKEN`, when set,
 * authenticates the reads (public templates need none).
 *
 * Usage:
 *   pnpm tsx scripts/seed-registry/verify-starter-manifests.ts
 */
/* eslint-disable no-console -- a CLI operator script: console IS its output surface */
import '../_loadEnv'; // MUST be first — populates DATABASE_URL before @/lib/db loads
import { db } from '@/lib/db';
import { HOSTING_MANIFEST_FILE_NAME, parseHostingManifest } from '@/lib/hosting/manifest';
import { seedRegistryService } from '@/lib/services/seedRegistryService';

const TAG = '[verify-starter-manifests]';
const API = 'https://api.github.com';

async function github<T>(path: string): Promise<{ status: number; body: T | null }> {
  const res = await fetch(`${API}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  });
  return { status: res.status, body: res.ok ? ((await res.json()) as T) : null };
}

async function main(): Promise<void> {
  if (process.argv.length > 2) throw new Error(`${TAG} takes no arguments`);
  const entries = (await seedRegistryService.listAllEntries()).filter((e) => e.status === 'active');
  let failures = 0;

  for (const entry of entries) {
    if (entry.source === 'initialised') {
      console.log(`${TAG} ${entry.key}: no template (initialised) — skipped`);
      continue;
    }
    const slug = `${entry.source.owner}/${entry.source.repo}`;
    const fail = (why: string) => {
      failures += 1;
      console.log(`${TAG} ${entry.key} (${slug}): FAIL — ${why}`);
    };

    const repo = await github<{ full_name: string; is_template: boolean; default_branch: string }>(
      `/repos/${slug}`,
    );
    if (!repo.body) {
      fail(`the repository is not readable (HTTP ${repo.status})`);
      continue;
    }
    const branch = repo.body.default_branch;
    const commit = await github<{ sha: string }>(`/repos/${slug}/commits/${branch}`);
    const at = `${repo.body.full_name}@${commit.body?.sha.slice(0, 12) ?? '?'}`;
    if (!repo.body.is_template) {
      fail(`${at} is not a template repository`);
      continue;
    }

    const file = await github<{ content: string }>(
      `/repos/${slug}/contents/${HOSTING_MANIFEST_FILE_NAME}?ref=${branch}`,
    );
    if (entry.hostingTargets.length === 0) {
      console.log(
        `${TAG} ${entry.key}: ok — ${at}, no hosting target` +
          (file.body ? ` (ships a ${HOSTING_MANIFEST_FILE_NAME})` : ', no manifest needed'),
      );
      continue;
    }
    let targets: readonly string[];
    try {
      const text = file.body ? Buffer.from(file.body.content, 'base64').toString('utf8') : null;
      targets = parseHostingManifest(text).targets;
    } catch (err) {
      fail(`${at}: ${(err as Error).message}`);
      continue;
    }
    const outside = entry.hostingTargets.filter((t) => !targets.includes(t));
    if (outside.length > 0) {
      fail(
        `${at}: entry targets [${outside.join(', ')}] are not in the manifest's [${targets.join(', ')}]`,
      );
      continue;
    }
    console.log(
      `${TAG} ${entry.key}: ok — ${at}, entry [${entry.hostingTargets.join(', ')}] ⊆ manifest [${targets.join(', ')}]`,
    );
  }

  console.log(`${TAG} ${entries.length} active entries, ${failures} failed`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    console.error(`${TAG}`, err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
