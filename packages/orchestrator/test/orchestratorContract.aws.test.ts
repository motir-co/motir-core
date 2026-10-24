import { afterEach, beforeEach, vi } from 'vitest';
import { describeOrchestratorContract } from './contract/orchestratorContract';
import { awsHarness } from './contract/awsHarness';

// The AWS adapter against the shared contract suite (MOTIR-9276), over an
// in-memory EC2. No network, no AWS account.

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describeOrchestratorContract('aws', awsHarness);
