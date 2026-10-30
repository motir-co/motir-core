import {
  FAKE_HOSTING_STATE_PATH_ENV,
  type FakeHostingControls,
  type HostingDeployPort,
  type HostingDeployTarget,
} from '@motir/orchestrator';
import { hostingFakeControls } from '@/lib/orchestrator/hosting';

// The spec's half of the fake hosting port (Story MOTIR-5766 · MOTIR-10098).
// The job worker deploys a preview and the app server's gate reads it; a spec
// arranges and inspects the same state through the fake's own controls, which
// read and write the shared store file the lane configs point all three
// processes at. Imports nothing that opens a database.

/** The fake hosting port this spec process holds — loud when the lane carries
 *  no shared store, because a spec's arrangement would then reach nobody. */
export function previewHostingFake(
  target: HostingDeployTarget = 'fly',
): HostingDeployPort & FakeHostingControls {
  if (!process.env[FAKE_HOSTING_STATE_PATH_ENV]?.trim()) {
    throw new Error(
      `${FAKE_HOSTING_STATE_PATH_ENV} is not set — run under an E2E lane, whose config defaults it`,
    );
  }
  return hostingFakeControls(target);
}

/** Forget every preview the lane's fake hosting holds, in every process. */
export function resetPreviewHosting(target: HostingDeployTarget = 'fly'): void {
  previewHostingFake(target).reset();
}
