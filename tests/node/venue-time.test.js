import assert from 'node:assert/strict';
import test from 'node:test';
import { hasWallTime, isValidDate, utcRange } from '../../server/time/venue-time.js';

test('validates leap days across the full four-digit Gregorian year range', () => {
    assert.equal(isValidDate('0001-01-01'), true);
    assert.equal(isValidDate('0000-01-01'), false);
    assert.equal(isValidDate('2000-02-29'), true);
    assert.equal(isValidDate('1900-02-29'), false);
});

test('rejects venue wall times skipped by the spring clock change', () => {
    assert.equal(hasWallTime('2026-03-29', '02:30', 'Europe/Amsterdam'), false);
    assert.equal(hasWallTime('2026-03-29', '03:30', 'Europe/Amsterdam'), true);
});

test('uses PHP-compatible standard-time interpretation for repeated venue clocks', () => {
    assert.deepEqual(
        utcRange('2026-10-25', '02:30', '2026-10-25', '03:00', 'Europe/Amsterdam'),
        { start_utc: '2026-10-25T01:30:00Z', end_utc: '2026-10-25T02:00:00Z' },
    );
    assert.deepEqual(
        utcRange('2026-11-01', '01:30', '2026-11-01', '02:00', 'America/New_York'),
        { start_utc: '2026-11-01T05:30:00Z', end_utc: '2026-11-01T07:00:00Z' },
    );
});

test('keeps positive elapsed duration when an interval crosses the repeated hour', () => {
    assert.deepEqual(
        utcRange('2026-10-25', '02:30', '2026-10-25', '02:45', 'Europe/Amsterdam'),
        { start_utc: '2026-10-25T01:30:00Z', end_utc: '2026-10-25T01:45:00Z' },
    );
});
