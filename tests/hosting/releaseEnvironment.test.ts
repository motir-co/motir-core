// MOTIR-10030 — a production release's environment: the resolved entries, with
// DATABASE_URL always taken from the production database.
import { describe, expect, it } from 'vitest';
import { mergeProductionEnvironment } from '@/lib/hosting/releaseEnvironment';

const resolved = [
  { name: 'FEATURE_X', value: 'on', secret: false },
  { name: 'DATABASE_URL', value: 'postgresql://wrong@elsewhere/db', secret: false },
  { name: 'API_SECRET', value: 'shh', secret: true },
];

describe('mergeProductionEnvironment', () => {
  it("overrides a resolved DATABASE_URL with the production database's, as a secret", () => {
    const merged = mergeProductionEnvironment(resolved, {
      DATABASE_URL: 'postgresql://app@prod-pooler/app',
    });
    expect(merged).toEqual([
      { name: 'FEATURE_X', value: 'on', secret: false },
      { name: 'API_SECRET', value: 'shh', secret: true },
      { name: 'DATABASE_URL', value: 'postgresql://app@prod-pooler/app', secret: true },
    ]);
  });

  it('drops a resolved DATABASE_URL when the application has no database', () => {
    expect(mergeProductionEnvironment(resolved, null).map((v) => v.name)).toEqual([
      'FEATURE_X',
      'API_SECRET',
    ]);
  });

  it('does not change its input', () => {
    const input = [...resolved];
    mergeProductionEnvironment(input, { DATABASE_URL: 'x' });
    expect(input).toEqual(resolved);
  });
});
