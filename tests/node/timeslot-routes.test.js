import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../../server/app.js';

const tenant = {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    slug: 'studio',
    booking_pattern: 'timeslot',
    timezone: 'UTC',
    slot_duration_minutes: 30,
    buffer_minutes: 0,
    min_advance_hours: 1,
    max_advance_days: 2000,
};

function database() {
    return {
        async query(sql) {
            if (sql.includes('FROM tenants WHERE slug')) return { rows: [tenant], rowCount: 1 };
            if (sql.includes('FROM blocked_dates')) return { rows: [{ blocked: false }], rowCount: 1 };
            if (sql.includes('FROM staff WHERE tenant_id')) return { rows: [], rowCount: 0 };
            if (sql.includes('FROM availability')) return { rows: [{ start_time: '09:00:00', end_time: '10:00:00' }], rowCount: 1 };
            if (sql.includes('FROM bookings')) return { rows: [], rowCount: 0 };
            if (sql === 'SELECT 1') return { rows: [{ '?column?': 1 }], rowCount: 1 };
            throw new Error(`Unexpected SQL: ${sql}`);
        },
    };
}

test('public availability route returns slots with timezone and UTC ranges', async () => {
    const app = buildApp({ db: database() });
    try {
        const response = await app.inject({ url: '/api/studio/availability?date=2030-01-07' });
        assert.equal(response.statusCode, 200);
        assert.deepEqual(response.json(), {
            slots: [{
                time: '09:00',
                end_time: '09:30',
                staff_id: null,
                date: '2030-01-07',
                start_utc: '2030-01-07T09:00:00Z',
                end_utc: '2030-01-07T09:30:00Z',
            }, {
                time: '09:30',
                end_time: '10:00',
                staff_id: null,
                date: '2030-01-07',
                start_utc: '2030-01-07T09:30:00Z',
                end_utc: '2030-01-07T10:00:00Z',
            }],
            date: '2030-01-07',
            timezone: 'UTC',
        });
    } finally {
        await app.close();
    }
});

test('public availability route validates dates and only exposes active timeslot tenants', async () => {
    const db = database();
    const app = buildApp({ db });
    try {
        const invalid = await app.inject({ url: '/api/studio/availability?date=2030-02-30' });
        assert.equal(invalid.statusCode, 422);
        assert.equal(invalid.json().error, 'invalid_date');

        db.query = async (sql) => sql.includes('FROM tenants WHERE slug')
            ? { rows: [{ ...tenant, booking_pattern: 'resource' }], rowCount: 1 }
            : { rows: [], rowCount: 0 };
        const unsupported = await app.inject({ url: '/api/studio/availability?date=2030-01-07' });
        assert.equal(unsupported.statusCode, 422);
        assert.equal(unsupported.json().error, 'pattern_not_supported');
    } finally {
        await app.close();
    }
});
