import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  generatePlanChangeFrameKinds,
  PLAN_CHANGE_FRAME_KINDS_FILE,
} from './generatePlanChangeFrameKinds';

// `pnpm generate:plan-change-frame-kinds` — the RUNNER for the published
// frame-kind contract (MOTIR-10427). All the work is in
// `scripts/generatePlanChangeFrameKinds.ts`; this file only writes, so the
// freshness guard in `tests/planning/frameKindParity.test.ts` can call the
// generator without writing anything.

async function main(): Promise<void> {
  const contents = await generatePlanChangeFrameKinds();
  await writeFile(join(process.cwd(), PLAN_CHANGE_FRAME_KINDS_FILE), contents);
  process.stdout.write(`generated ${PLAN_CHANGE_FRAME_KINDS_FILE}\n`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
