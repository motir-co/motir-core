import { describe, expect, it } from 'vitest';
import { dayDate, dayString, kindOfRecordType, toCostRows } from '@/lib/awsCost/costLines';

// THE STORED SHAPE OF A COST EXPLORER DAY (MOTIR-11712): the page draws a day as
// its services, then ONE Tax, ONE Credits and ONE Refund line.

describe('kindOfRecordType', () => {
  it('keeps Tax, Credit and Refund as their own kinds and folds every other record type into usage', () => {
    expect(kindOfRecordType('Tax')).toBe('tax');
    expect(kindOfRecordType('Credit')).toBe('credit');
    expect(kindOfRecordType('Refund')).toBe('refund');
    for (const other of ['Usage', 'Fee', 'SavingsPlanCoveredUsage', 'RIFee', '']) {
      expect(kindOfRecordType(other)).toBe('service');
    }
  });
});

describe('toCostRows', () => {
  it('folds a day into one line per service plus one tax, credit and refund line, sorted', () => {
    const rows = toCostRows([
      { day: '2026-11-18', recordType: 'Usage', service: 'EC2 - Other', amountMicroUsd: 5 },
      {
        day: '2026-11-17',
        recordType: 'Tax',
        service: 'Amazon Elastic Container Service',
        amountMicroUsd: 2,
      },
      { day: '2026-11-17', recordType: 'Tax', service: 'AmazonCloudWatch', amountMicroUsd: 3 },
      { day: '2026-11-17', recordType: 'Usage', service: 'AmazonCloudWatch', amountMicroUsd: 10 },
      { day: '2026-11-17', recordType: 'Fee', service: 'AmazonCloudWatch', amountMicroUsd: 1 },
      { day: '2026-11-17', recordType: 'Credit', service: 'AWS Support', amountMicroUsd: -4 },
      { day: '2026-11-17', recordType: 'Refund', service: 'AWS Support', amountMicroUsd: -1 },
      {
        day: '2026-11-17',
        recordType: 'Usage',
        service: 'Amazon Elastic Container Service',
        amountMicroUsd: 20,
      },
    ]);
    expect(rows).toEqual([
      {
        day: '2026-11-17',
        kind: 'service',
        service: 'Amazon Elastic Container Service',
        amountMicroUsd: 20,
      },
      { day: '2026-11-17', kind: 'service', service: 'AmazonCloudWatch', amountMicroUsd: 11 },
      { day: '2026-11-17', kind: 'tax', service: '', amountMicroUsd: 5 },
      { day: '2026-11-17', kind: 'credit', service: '', amountMicroUsd: -4 },
      { day: '2026-11-17', kind: 'refund', service: '', amountMicroUsd: -1 },
      { day: '2026-11-18', kind: 'service', service: 'EC2 - Other', amountMicroUsd: 5 },
    ]);
    // The rows of a day sum to Cost Explorer's unblended total for it.
    expect(
      rows.filter((r) => r.day === '2026-11-17').reduce((s, r) => s + r.amountMicroUsd, 0),
    ).toBe(31);
  });

  it('drops a line that sums to zero', () => {
    expect(
      toCostRows([
        { day: '2026-11-17', recordType: 'Usage', service: 'AWS Lambda', amountMicroUsd: 3 },
        { day: '2026-11-17', recordType: 'Fee', service: 'AWS Lambda', amountMicroUsd: -3 },
        { day: '2026-11-17', recordType: 'Usage', service: 'Amazon S3', amountMicroUsd: 0 },
      ]),
    ).toEqual([]);
  });
});

describe('dayDate and dayString', () => {
  it('round-trip a UTC day through a DATE column value', () => {
    expect(dayDate('2026-02-28').toISOString()).toBe('2026-02-28T00:00:00.000Z');
    expect(dayString(dayDate('2026-02-28'))).toBe('2026-02-28');
  });
});
