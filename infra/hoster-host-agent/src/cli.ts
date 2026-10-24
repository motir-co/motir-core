import { main } from './main';

// `node dist/cli.js` — what the hoster image's unit starts. A start-up failure
// exits non-zero with no detail: the reason could name a file's content.
main().catch(() => {
  process.stderr.write('motir host agent: could not start\n');
  process.exit(1);
});
