import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../../server/app.js';
import { getCapacityAvailableDates, getCapacitySlots } from '../../server/services/capacity-availability.js';
import { createCapacityBooking } from '../../server/services/capacity-booking.js';

process.env.NODE_ENV = 'test';

const tenant = {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', slug: 'class', booking_pattern: 'capacity', timezone: 'UTC',
    min_advance_hours: 1, max_advance_days: 90, require_phone: false, requires_consent: true,
    consent_text: 'Consent text', custom_fields: [], booking_requires_approval: false,
    max_bookings_per_customer_per_day: 3, send_reminders: false,
};
const slot = {
    id: 'slot-one', day_of_week: 0, start_time: '19:00:00', end_time: '20:30:00',
    max_capacity: 10, min_party_size: 2, max_party_size: 8, label: 'Aula da noite', is_active: true,
};

function availabilityDb({ bookings = [], blocked = [], slots = [slot] } = {}) {
    return {
        async query(sql) {
            if (sql.includes('FROM blocked_dates')) return { rows: blocked, rowCount: blocked.length };
            if (sql.includes('FROM capacity_slots')) return { rows: slots, rowCount: slots.length };
            if (sql.includes('FROM bookings')) return { rows: bookings, rowCount: bookings.length };
            throw new Error(`Unexpected query: ${sql}`);
        },
    };
}

test('capacity availability enforces party limits, remaining seats, and blocked days', async () => {
    const db = availabilityDb({ bookings: [{ booking_date: '2030-01-07', slot_time: '19:00:00', booked: 6 }] });
    const now = Date.parse('2030-01-01T12:00:00Z');
    const available = await getCapacitySlots(db, tenant, '2030-01-07', 4, { now });
    assert.equal(available.length, 1);
    assert.equal(available[0].remaining, 4);
    assert.equal(available[0].start_utc, '2030-01-07T19:00:00Z');
    assert.deepEqual(await getCapacitySlots(db, tenant, '2030-01-07', 5, { now }), []);
    assert.deepEqual(await getCapacitySlots(db, tenant, '2030-01-07', 1, { now }), []);
    assert.deepEqual(await getCapacitySlots(availabilityDb({ blocked: [{ start_date: '2030-01-07', end_date: '2030-01-07' }] }), tenant, '2030-01-07', 2, { now }), []);
});

test('capacity calendar lists dates only when a matching slot remains bookable', async () => {
    const result = await getCapacityAvailableDates(availabilityDb(), tenant, 2030, 1, 2, {
        now: Date.parse('2030-01-01T12:00:00Z'),
    });
    assert.deepEqual(result, ['2030-01-07', '2030-01-14', '2030-01-21', '2030-01-28']);
});

test('capacity availability API returns slots for the tenant and pattern', async () => {
    const apiTenant = { ...tenant, max_advance_days: 2000 };
    const db = {
        async query(sql) {
            if (sql.includes('FROM tenants')) return { rows: [apiTenant], rowCount: 1 };
            if (sql.includes('FROM blocked_dates')) return { rows: [], rowCount: 0 };
            if (sql.includes('FROM capacity_slots')) return { rows: [slot], rowCount: 1 };
            if (sql.includes('FROM bookings')) return { rows: [], rowCount: 0 };
            throw new Error(`Unexpected query: ${sql}`);
        },
    };
    const app = buildApp({ db });
    try {
        const response = await app.inject('/api/class/capacity/slots?date=2030-01-07&party_size=2');
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().slots[0].id, slot.id);
    } finally { await app.close(); }
});

test('capacity booking rechecks slot capacity in a transaction and records guest count', async () => {
    const now = Date.parse('2030-01-01T12:00:00Z');
    const calls = [];
    const client = {
        async query(sql, values = []) {
            calls.push({ sql, values });
            if (sql.includes('FROM tenants')) return { rows: [tenant], rowCount: 1 };
            if (sql.includes('FROM capacity_slots')) return { rows: [slot], rowCount: 1 };
            if (sql.includes('FROM blocked_dates')) return { rows: [], rowCount: 0 };
            if (sql.includes('FROM bookings') && sql.includes('GROUP BY')) return { rows: [], rowCount: 0 };
            if (sql.includes('COUNT(*)::int AS count FROM rate_limits')) return { rows: [{ count: 0 }], rowCount: 1 };
            if (sql.includes('INSERT INTO customers')) return { rows: [{ id: 'customer-one' }], rowCount: 1 };
            if (sql.includes('COUNT(*)::int AS count FROM bookings')) return { rows: [{ count: 0 }], rowCount: 1 };
            return { rows: [], rowCount: 1 };
        },
        release() {},
    };
    const pool = { connect: async () => client };
    const booking = await createCapacityBooking(pool, 'class', {
        booking_pattern: 'capacity', __ts: now - 4_000, __hp: '', slot_id: slot.id,
        date: '2030-01-07', party_size: 3, consent_given: true,
        customer: { name: 'Ana Lima', email: 'ana@example.com', phone: '' }, custom_fields: {},
    }, { origin: 'https://class.example', host: 'class.example', ip: '127.0.0.1', now });
    assert.equal(booking.booking_pattern, 'capacity');
    assert.equal(booking.party_size, 3);
    assert.equal(booking.status, 'confirmed');
    assert.equal(calls.some(({ sql, values }) => sql.includes('INSERT INTO bookings') && values.includes(3)), true);
    assert.equal(calls.some(({ sql }) => sql === 'COMMIT'), true);
});
