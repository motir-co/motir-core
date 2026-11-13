// Re-records tests/fixtures/calculatorEngineCapture.ts (MOTIR-8640): the engine's
// PUBLIC calculator routes, called with curl and written down verbatim — status,
// content type, raw body — with the origin, the date and the command that produced
// each. Nothing is hand-written: when the engine answers differently the capture is
// taken again, never edited. The routes take no credential.
//
//   node scripts/record-calculator-capture.mjs [origin]   (default https://ai.motir.co)
//
// Each estimate asks the two ranges (MOTIR-9224): the same range planned and run, so
// a re-record stays comparable with the single-range capture it replaces.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const origin = process.argv[2] ?? 'https://ai.motir.co';
const out = new URL('../tests/fixtures/calculatorEngineCapture.ts', import.meta.url);
const range = { low: 2, high: 6 };
const both = (r) => ({ plannedPerMonth: r, runPerMonth: r });

const SAMPLES = [
  { name: 'categories', method: 'GET', path: '/v1/public/calculator/categories' },
  ...[1, 2, 3].map((n) => ({
    name: `estimate${n}`,
    method: 'POST',
    path: '/v1/public/calculator/estimate',
    body: {
      ...both(range),
      categories: ['economy', 'balanced', 'flagship'].slice(0, n),
      cadence: 'monthly',
    },
  })),
  {
    name: 'regularRung',
    method: 'POST',
    path: '/v1/public/calculator/estimate',
    body: { ...both(range), categories: ['economy', 'balanced'], cadence: 'annual' },
  },
  {
    name: 'overCeiling',
    method: 'POST',
    path: '/v1/public/calculator/estimate',
    body: {
      ...both({ low: 20, high: 60 }),
      categories: ['balanced', 'flagship'],
      cadence: 'annual',
    },
  },
  {
    name: 'validationError',
    method: 'POST',
    path: '/v1/public/calculator/estimate',
    body: { ...both({ low: 9, high: 6 }), categories: ['economy'], cadence: 'monthly' },
  },
];

const recorded = SAMPLES.map((s) => {
  const args = ['-sS', '-m', '60', '-X', s.method, '-w', '\n%{http_code}\n%{content_type}'];
  if (s.body) args.push('-H', 'content-type: application/json', '--data', JSON.stringify(s.body));
  args.push(origin + s.path);
  const raw = execFileSync('curl', args, { encoding: 'utf8' });
  const [rest, status, contentType] = [
    raw.slice(0, raw.lastIndexOf('\n', raw.lastIndexOf('\n') - 1)),
    ...raw.slice(raw.lastIndexOf('\n', raw.lastIndexOf('\n') - 1) + 1).split('\n'),
  ];
  return {
    name: s.name,
    command: [
      'curl -sS',
      `-X ${s.method}`,
      s.body ? `-H 'content-type: application/json' --data '${JSON.stringify(s.body)}'` : '',
      origin + s.path,
    ]
      .filter(Boolean)
      .join(' '),
    request: s.body ?? null,
    status: Number(status),
    contentType,
    body: rest.trim(),
    recordedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  };
});

const lit = (v) => JSON.stringify(v);
const src = `// RECORDED by scripts/record-calculator-capture.mjs — never edited by hand.
// The engine's public calculator routes as they really answered (Story MOTIR-8381 ·
// MOTIR-8640): real status, content type and body per sample, each with the command
// that produced it. Re-record the same way when the engine's answer moves.

export interface EngineSample {
  name: string;
  command: string;
  request: Record<string, unknown> | null;
  status: number;
  contentType: string;
  body: string;
  recordedAt: string;
}

export const CAPTURE_ORIGIN = ${lit(origin)};

export const ENGINE_CAPTURE: EngineSample[] = ${lit(recorded, null, 2)};
`;
writeFileSync(out, src);
console.log(`recorded ${recorded.length} samples from ${origin}`);
