// Re-records tests/fixtures/calculatorPinnedVector.json (MOTIR-8642 · MOTIR-10156): the
// PINNED CROSS-SURFACE ESTIMATE VECTOR — one calculator request in the engine's current
// shape and the engine's own answer to it, taken from the PUBLIC routes with curl and
// written down byte for byte, with where, when and on which engine versions it was taken.
// Nothing in the record is hand-written: when the engine's answer moves, run this again
// and commit the whole file. The routes take no credential.
//
//   node scripts/record-calculator-pinned-vector.mjs [origin]   (default https://motir-ai.fly.dev)
//
// The record is a JSON file, not a TypeScript module, so that motir-marketing can carry a
// BYTE-IDENTICAL copy (`tests/fixtures/calculator/pinned-vector.json` there): the billing
// tab's test here and the /price page's parity test there assert the same request and
// answer. After re-recording, copy the file over that one unchanged.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const origin = process.argv[2] ?? 'https://motir-ai.fly.dev';
const out = new URL('../tests/fixtures/calculatorPinnedVector.json', import.meta.url);

const CATEGORIES_PATH = '/v1/public/calculator/categories';
const ESTIMATE_PATH = '/v1/public/calculator/estimate';

// The shared input. Two DIFFERENT ranges, so a surface that copies one into the other
// is caught; two categories with UNEQUAL shares, so a surface that splits evenly is
// caught; and small enough to land inside the ladder with a top-up at the high end,
// so the plan, its price and the top-up all have a figure to compare.
const REQUEST = {
  plannedPerMonth: { low: 2, high: 6 },
  runPerMonth: { low: 1, high: 4 },
  categories: ['economy', 'balanced'],
  shares: { economy: 60, balanced: 40 },
  cadence: 'annual',
};

const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

function call(method, path, body) {
  const args = ['-sS', '-m', '60', '-X', method, '-w', '\n%{http_code}'];
  if (body) args.push('-H', 'content-type: application/json', '--data', JSON.stringify(body));
  args.push(origin + path);
  const raw = execFileSync('curl', args, { encoding: 'utf8' });
  const cut = raw.lastIndexOf('\n');
  const status = Number(raw.slice(cut + 1));
  const text = raw.slice(0, cut).trim();
  if (status !== 200) throw new Error(`${method} ${path} answered ${status}: ${text}`);
  JSON.parse(text); // a body that is not JSON is not recorded
  return text;
}

const categoriesRecordedAt = now();
const categoriesRawBody = call('GET', CATEGORIES_PATH);
const recordedAt = now();
const estimateRawBody = call('POST', ESTIMATE_PATH, REQUEST);
const answer = JSON.parse(estimateRawBody);
if (answer.kind !== 'estimate') {
  throw new Error(`the pinned request answered kind "${answer.kind}", not an estimate`);
}

const record = {
  $comment:
    'RECORDED by motir-core scripts/record-calculator-pinned-vector.mjs — never edited by hand. motir-marketing carries a byte-identical copy.',
  basis: {
    endpoint: `POST ${ESTIMATE_PATH}`,
    categoriesEndpoint: `GET ${CATEGORIES_PATH}`,
    host: origin,
    recordedAt,
    categoriesRecordedAt,
    engineVersion: answer.version,
    profilesVersion: answer.profilesVersion,
    categoryRuleVersion: answer.categoryRuleVersion,
    commands: [
      `curl -sS -X GET ${origin}${CATEGORIES_PATH}`,
      `curl -sS -X POST -H 'content-type: application/json' --data '${JSON.stringify(REQUEST)}' ${origin}${ESTIMATE_PATH}`,
    ],
  },
  request: REQUEST,
  estimateRawBody,
  categoriesRawBody,
};

writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
console.warn(`recorded the pinned vector from ${origin} at ${recordedAt}`);
