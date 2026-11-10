import { readImageCreated } from '@motir/orchestrator';
import type {
  HostedAgentImageLagVerdictDTO,
  HostedAgentMainBuildDTO,
} from '@/lib/dto/hostedAgentImageLag';
import {
  HOSTED_AGENT_IMAGE_ENV_VAR,
  hostedAgentImage,
  isHostedAgentConfigured,
  OrchestratorNotConfiguredError,
  selectedOrchestratorProvider,
} from '@/lib/orchestrator';

// THE HOSTED-AGENT IMAGE LAG PROBE (MOTIR-10882) — a probe of
// `system.daily-health-check` that fails when the newest hosted-agent image the
// lane published on `main` has existed for more than a day without being pinned.
//
// WHY. `MOTIR_HOSTED_AGENT_IMAGE` moved only when a person re-pinned it, so
// production booted a CLI from 2026-10-02 five weeks later, and a merged fix
// (MOTIR-10705) never reached the hosted runs it was written for. The image lane
// now opens a pin pull request after every publish and the AWS deploy applies
// it; this probe is the NOTICE when that pull request sits unmerged, or the
// chain breaks somewhere else.
//
// THE QUESTION. The lane tags every publish `:main` beside `sha-<commit>`, so
// `:main` IS the newest main build. Its digest equal to the pin's is `current`.
// Otherwise the pin has been superseded, and it is `lagging` — loud — when
// either allowance is spent:
//
//   - the newest build has existed for more than a DAY: its pin pull request
//     has had a day to merge (the card's rule);
//   - the pinned build is more than a WEEK older than the newest one. The first
//     rule alone would never fire while `packages/cli` merges more than once a
//     day, because every merge makes `:main` younger and force-pushes the same
//     pin pull request; this one bounds how far behind that can drift.
//
// Inside both it is `pending`, recorded and quiet: the pull request is expected
// to be open. The pin read is the deployment's own `MOTIR_HOSTED_AGENT_IMAGE` —
// what this deployment's hosted runs boot, not what the pin file says.
//
// ⚠️ `indeterminate` IS RECORDED, NOT THROWN — the check's rule for every probe:
// a registry that did not answer is a statement about the read.

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long the newest `main` build may go unpinned before the probe is loud. */
export const HOSTED_AGENT_IMAGE_MAX_UNPINNED_MS = DAY_MS;

/** How much older than the newest `main` build the pinned one may be. */
export const HOSTED_AGENT_IMAGE_MAX_BEHIND_MS = 7 * DAY_MS;

const hours = (ms: number) => Math.round(ms / 360_000) / 10;

export const hostedAgentImageLagProbeService = {
  async check(now: Date = new Date()): Promise<HostedAgentImageLagVerdictDTO> {
    const checkedAt = now.toISOString();
    if (selectedOrchestratorProvider() === 'fake') {
      return {
        verdict: 'not_applicable',
        checkedAt,
        detail: 'the fake orchestrator is selected; no image is pulled',
      };
    }
    if (!isHostedAgentConfigured()) {
      return {
        verdict: 'not_applicable',
        checkedAt,
        detail: `this deployment runs no hosted agent (${HOSTED_AGENT_IMAGE_ENV_VAR} is unset)`,
      };
    }
    let pinned: string;
    try {
      pinned = hostedAgentImage('aws');
    } catch (err) {
      // The pullability preflight reports the same refusal loudly; here it only
      // means there is no digest to compare.
      return {
        verdict: 'indeterminate',
        checkedAt,
        phase: 'pin',
        reference: process.env[HOSTED_AGENT_IMAGE_ENV_VAR]?.trim() ?? '',
        detail: (err as OrchestratorNotConfiguredError).detail,
      };
    }
    const at = pinned.lastIndexOf('@');
    const pinnedDigest = pinned.slice(at + 1);
    const reference = `${pinned.slice(0, at)}:main`;
    const indeterminate = (detail: string): HostedAgentImageLagVerdictDTO => ({
      verdict: 'indeterminate',
      checkedAt,
      phase: 'registry',
      reference,
      detail,
    });

    const read = await readImageCreated(reference);
    if (!read.ok) return indeterminate(`${read.reason}: ${read.detail}`);
    if (!read.digest) return indeterminate('the registry named no digest for :main');
    if (read.digest === pinnedDigest) {
      return {
        verdict: 'current',
        checkedAt,
        pinned,
        main: { reference, digest: read.digest, createdAt: read.createdAt },
      };
    }
    if (!read.createdAt) return indeterminate("the :main image's config records no build time");
    const main: HostedAgentMainBuildDTO = {
      reference,
      digest: read.digest,
      createdAt: read.createdAt,
    };
    const newest = Date.parse(read.createdAt);
    // The pinned build's own time, for the second allowance. A failed read of it
    // is not a failed probe: the first allowance still decides.
    const pinnedRead = await readImageCreated(pinned);
    const pinnedCreatedAt = pinnedRead.ok ? pinnedRead.createdAt : null;
    const unpinnedMs = Math.max(0, now.getTime() - newest);
    const behindMs = pinnedCreatedAt === null ? null : newest - Date.parse(pinnedCreatedAt);
    const lagging =
      unpinnedMs > HOSTED_AGENT_IMAGE_MAX_UNPINNED_MS ||
      (behindMs !== null && behindMs > HOSTED_AGENT_IMAGE_MAX_BEHIND_MS);
    return {
      verdict: lagging ? 'lagging' : 'pending',
      checkedAt,
      pinned,
      main,
      lag: {
        unpinnedHours: hours(unpinnedMs),
        behindHours: behindMs === null ? null : hours(behindMs),
        pinnedCreatedAt,
      },
    };
  },
};
