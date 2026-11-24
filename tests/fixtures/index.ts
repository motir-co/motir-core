// Shared test fixtures (Subtask 1.4.7) — one import surface for the work-item
// suites and 1.4.8's Story-level E2E. Build real rows through the service /
// repository layers against the real Postgres (Yue's no-mocks rule); see each
// module for the per-entity contract.
//
//   createTestUser           → a user
//   createTestWorkspace      → { workspace, owner }
//   createTestProject        → a project (ProjectDTO)
//   createTestWorkItem       → a work item (allocate-key + create dance)
//   createTestLink           → a work-item link
//   makeWorkItemFixture      → user + workspace + project bundle (+ ctx)
//   nextTestPosition         → the real fractional-index `position` a seeded
//                              row must carry (never a zero-padded number —
//                              MOTIR-2196; read its doc comment before
//                              hand-writing a `position` anywhere)

export { createTestUser, TEST_PASSWORD } from './userFixtures';
export type { CreateTestUserOptions } from './userFixtures';

export { createTestWorkspace } from './workspaceFixtures';
export type { CreateTestWorkspaceOptions, CreateTestWorkspaceResult } from './workspaceFixtures';

export { createTestProject } from './projectFixtures';
export type { CreateTestProjectOptions } from './projectFixtures';

export {
  makeWorkItemFixture,
  createTestWorkItem,
  createTestWorkItems,
  createTestLink,
  nextTestPosition,
} from './workItemFixtures';
export type {
  WorkItemFixture,
  MakeWorkItemFixtureOptions,
  CreateTestWorkItemInput,
  CreateTestWorkItemsInput,
  CreateTestLinkInput,
} from './workItemFixtures';
