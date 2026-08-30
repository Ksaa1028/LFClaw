import assert from 'node:assert/strict';
import test from 'node:test';

import { buildUsageReport, summarizeUsageEvents } from './usageReporting.mjs';

const events = Array.from({ length: 305 }, (_, index) => ({
  employeeId: index % 2 ? 'employee-b' : 'employee-a',
  modelId: index % 3 ? 'model-a' : 'model-b',
  credits: 0.5,
  inputTokens: 10,
  outputTokens: 5,
  createdAt: `2026-08-${String((index % 30) + 1).padStart(2, '0')}T10:00:00.000Z`,
}));

test('full summary is not capped at the last 300 usage events', () => {
  assert.deepEqual(summarizeUsageEvents(events), {
    callCount: 305,
    creditsUsed: 152.5,
  });
});

test('usage report filters and paginates rows while keeping full filtered totals', () => {
  const filtered = events.filter(event => event.employeeId === 'employee-a');
  const report = buildUsageReport(events, {
    employeeId: 'employee-a',
    page: 2,
    pageSize: 5,
  });
  assert.equal(report.callCount, filtered.length);
  assert.equal(report.creditsUsed, filtered.length * 0.5);
  assert.equal(report.page, 2);
  assert.equal(report.pageSize, 5);
  assert.equal(report.rows.length, 5);
  assert.ok(report.totalRows > report.rows.length);
});

test('usage report clamps invalid and out-of-range paging inputs', () => {
  const report = buildUsageReport(events.slice(0, 2), { page: 99, pageSize: 1000 });
  assert.equal(report.pageSize, 100);
  assert.equal(report.page, report.pageCount);
});
