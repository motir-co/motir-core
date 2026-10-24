// `@motir/orchestrator` — the CONTAINER ORCHESTRATOR PORT and its adapters
// (Story MOTIR-4292 · MOTIR-4299), extracted from `lib/orchestrator/` under
// `docs/decisions/app-shell-over-packages.md`.
//
// ⚠️ THIS BARREL IS THE PACKAGE'S WHOLE SURFACE. The app imports
// `@motir/orchestrator`, never a path inside `src/` — the deep-import half of
// that ADR's §3 rule, asserted by `tests/packages/importDirection.test.ts`.
//
// It re-exports each module WHOLE rather than curating a list, deliberately: a
// hand-written export list is a second place to remember, and the failure it
// produces is an export that silently is not there. Every name below was already
// reachable from the app as `@/lib/orchestrator/<module>` before the move, so
// `export *` is the surface staying the same size rather than growing.
//
// What is NOT here, and deliberately: the SELECTOR. Choosing between the Fly
// adapter and the fake reads this deployment's environment and binds the app's
// cost meter, so it is composition, and composition lives in the app —
// `lib/orchestrator/index.ts`, which is this package's one composition root
// (`ci-runner-fleet.md` §4's "a new file under `adapters/` plus one branch here"
// is that file).

export * from './types';
export * from './errors';
export * from './rates';
export * from './usage';
export * from './usageSink';
export * from './reap';
export * from './imagePull';
export * from './persistentLiveness';
export * from './adapters/fly';
export * from './adapters/fly/flyMachines';
export * from './adapters/fly/indexImage';
export * from './adapters/fake';
export * from './adapters/fly/persistent';
export * from './adapters/fake/persistent';
export * from './adapters/fly/inventory';
export * from './adapters/fake/inventory';
export * from './adapters/aws/ec2Client';
export * from './adapters/aws/network';
export * from './adapters/aws';
