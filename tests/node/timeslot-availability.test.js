import assert from 'node:assert/strict';
import test from 'node:test';
import { getTimeslotAvailability } from '../../server/services/timeslot-availability.js';

const tenant = {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    timezone: 'UTC',
    slot_duration_minutes: 30,
    buffer_minutes: 0,
    min_advance_hours: 1,
    max_advance_days: 90,
};

function dbWith({ serviceDuration = 60, windows = [], bookings = [], blockTenant = false, blockStaff = false } = {}) {
    const calls = [];
    return {
        calls,
        async query(sql, values = []) {
            calls.push({ sql, values });
            if (sql.includes('SELECT duration_minutes FROM services')) return { rows: [{ duration_minutes: serviceDuration }] };
            if (sql.includes('AS blocked')) return { rows: [{ blocked: sql.includes('staff_id = $2') ? blockStaff : blockTenant }] };
            if (sql.includes('SELECT id FROM staff WHERE id =')) return { rows: [{ id: values[0] }] };
            if (sql.includes('SELECT staff_id FROM service_staff')) return { rows: [] };
            if (sql.includes('SELECT start_time, end_time FROM availability')) return { rows: windows };
            if (sql.includes('AS present')) return { rows: [{ present: true }] };
            if (sql.includes('SELECT start_datetime, end_datetime FROM bookings')) return { rows: bookings };
            throw new Error(`Unexpected SQL: ${sql}`);
        },
    };
}

test('generates wall-clock slots and authoritative UTC values from weekly windows', async () => {
    const db = dbWith({ windows: [{ start_time: '09:00:00', end_time: '11:00:00' }] });
    const slots = await getTimeslotAvailability(db, tenant, {
        date: '2030-01-07',
        serviceId: 'service-1',
        staffId: 'staff-1',
        now: Date.UTC(2030, 0, 6, 0),
    });
    assert.deepEqual(slots, [
        { time: '09:00', end_time: '10:00', staff_id: 'staff-1' },
        { time: '09:30', end_time: '10:30', staff_id: 'staff-1' },
        { time: '10:00', end_time: '11:00', staff_id: 'staff-1' },
    ]);
});

test('excludes overlaps and retains the PHP after-booking buffer rule', async () => {
    const db = dbWith({
        windows: [{ start_time: '09:00:00', end_time: '13:00:00' }],
        bookings: [{ start_datetime: '2030-01-07 10:00:00', end_datetime: '2030-01-07 11:00:00' }],
    });
    const slots = await getTimeslotAvailability(db, { ...tenant, buffer_minutes: 15 }, {
        date: '2030-01-07',
        serviceId: 'service-1',
        staffId: 'staff-1',
        now: Date.UTC(2030, 0, 6, 0),
    });
    assert.deepEqual(slots.map(({ time }) => time), ['11:30', '12:00']);
});

test('omits slots inside nonexistent daylight-saving wall times', async () => {
    const db = dbWith({ windows: [{ start_time: '01:30:00', end_time: '04:00:00' }] });
    const slots = await getTimeslotAvailability(db, {
        ...tenant,
        timezone: 'Europe/Amsterdam',
        slot_duration_minutes: 30,
    }, {
        date: '2026-03-29',
        serviceId: 'service-1',
        staffId: 'staff-1',
        now: Date.UTC(2026, 2, 28, 0),
    });
    assert.deepEqual(slots.map(({ time }) => time), ['01:30', '03:00']);
});
