import { readImageLabels } from '@motir/orchestrator';
import { parseRunnerImageTools } from '@/lib/ciFleet/runnerImageTools';
import { configuredFleetRunnerImage } from '@/lib/orchestrator';

// THE TOOL LIST OF THE RUNNER IMAGE THIS DEPLOYMENT PINS (MOTIR-10290) — read
// from the image itself, through its registry, so the fleet readiness verdict
// compares jobs against the image production boots and no second list exists.
// `lib/ciFleet/runnerImageTools.ts` says how the list gets onto the image.
//
// Four answers, and the split matters to the page: `unset` (this deployment pins
// no image), `unrecorded` (the pinned image predates the label — a definite
// fact, so the condition is unmet), `unreadable` (the registry did not answer —
// a statement about the read, so the condition is unknown), and `read`.

export type RunnerImageToolsRead =
  | { state: 'read'; image: string; digest: string | null; tools: ReadonlySet<string> }
  | { state: 'unset' }
  | { state: 'unrecorded'; image: string }
  | { state: 'unreadable'; image: string; reason: string; detail: string };

/** Answers per pinned reference. A digest names immutable bytes, so a definite
 *  answer about it never changes; a failed read is never kept. */
const cache = new Map<string, RunnerImageToolsRead>();

/** Tests only: forget every cached answer. */
export function _resetRunnerImageToolsCache(): void {
  cache.clear();
}

export const runnerImageToolsService = {
  /** The pinned runner image's tool list. Never throws. */
  async read(): Promise<RunnerImageToolsRead> {
    const image = configuredFleetRunnerImage();
    if (!image) return { state: 'unset' };
    const cached = cache.get(image);
    if (cached) return cached;
    const read = await readImageLabels(image);
    if (!read.ok) {
      // ⚠️ `absent` and `unauthorized` are definite registry answers, but about the
      // IMAGE's availability — which the daily boot preflight already reports
      // loudly. Here they only mean the list could not be read.
      return { state: 'unreadable', image, reason: read.reason, detail: read.detail };
    }
    const tools = parseRunnerImageTools(read.labels);
    const answer: RunnerImageToolsRead = tools
      ? { state: 'read', image, digest: read.digest, tools }
      : { state: 'unrecorded', image };
    cache.set(image, answer);
    return answer;
  },
};
