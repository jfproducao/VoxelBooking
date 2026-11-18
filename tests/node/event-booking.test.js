import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../../server/app.js';
import { getEventDetail, listEventOccurrences } from '../../server/services/event-availability.js';
import { createEventBooking } from '../../server/services/event-booking.js';

process.env.NODE_ENV = 'test';

const tenant = {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', slug: 'workshop', booking_pattern: 'event', timezone: 'UTC',
    min_advance_hours: 1, max_advance_days: 90, require_phone: false, requires_consent: true,
    consent_text: 'Consent text', custom_fields: [], booking_requires_approval: false,
    max_bookings_per_customer_per_day: 3, send_reminders: false, currency: 'BRL',
};
const event = {
    id: 'event-one', tenant_id: tenant.id, name: 'Oficina de cerâmica', description: 'Faça uma peça.', location: 'Sala 2',
    price: '50.00', max_participants: 5, min_spot_count: 1, max_spot_count: 4,
    start_datetime: '2030-01-07 19:00:00', end_datetime: '2030-01-07 21:00:00',
    is_recurring: false, rrule: null, exception_dates: [], allow_waitlist: true, waitlist_max: 3, is_active: true,
};

function readDb({ rows = [event], booked = 2, waitlisted = 0 } = {}) {
    return {
        async query(sql) {
            if (sql.includes('FROM events')) return { rows, rowCount: rows.length };
            if (sql.includes('FROM bookings')) return { rows: [{ booked, waitlisted }], rowCount: 1 };
            throw new Error(`Unexpected query: ${sql}`);
        },
    };
}

test('event discovery expands recurrence rules, removes exceptions, and reports live inventory', async () => {
    const recurring = {
        ...event, is_recurring: true, rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=4',
        exception_dates: ['2030-01-14'],
    };
    const result = await listEventOccurrences(readDb({ rows: [recurring], booked: 4, waitlisted: 0 }), tenant, {
        month: '2030-01', now: Date.parse('2030-01-01T12:00:00Z'),
    });
    assert.deepEqual(result.map((item) => item.date), ['2030-01-07', '2030-01-21', '2030-01-28']);
    assert.equal(result[0].remaining, 1);
    assert.equal(result[0].can_waitlist, false);
});

test('event details validate one-off dates and expose a full event waitlist', async () => {
    const db = readDb({ booked: 5, waitlisted: 1 });
    const detail = await getEventDetail(db, tenant, event.id, event.start_datetime.slice(0, 10), {
        now: Date.parse('2030-01-01T12:00:00Z'),
    });
    assert.equal(detail.remaining, 0);
    assert.equal(detail.can_waitlist, true);
    assert.equal(await getEventDetail(db, tenant, event.id, '2030-01-08', { now: Date.parse('2030-01-01T12:00:00Z') }), null);
});

test('event API serves upcoming instances and event details only for event tenants', async () => {
    const apiTenant = { ...tenant, max_advance_days: 2000 };
    const recurring = { ...event, is_recurring: true, rrule: 'FREQ=DAILY;COUNT=3' };
    const db = {
        async query(sql) {
            if (sql.includes('FROM tenants')) return { rows: [apiTenant], rowCount: 1 };
            if (sql.includes('SELECT MAX(id) AS id FROM events')) return { rows: [{ id: event.id }], rowCount: 1 };
            if (sql.includes('FROM events')) return { rows: [recurring], rowCount: 1 };
            if (sql.includes('FROM bookings')) return { rows: [{ booked: 0, waitlisted: 0 }], rowCount: 1 };
            throw new Error(`Unexpected query: ${sql}`);
        },
    };
    const app = buildApp({ db });
    try {
        const listing = await app.inject('/api/workshop/events?limit=1');
        assert.equal(listing.statusCode, 200);
        assert.equal(listing.json().events[0].id, event.id);
        assert.equal(listing.json().events[0].date, '2030-01-07');
        assert.ok(listing.json().next_cursor);
        const second = await app.inject(`/api/workshop/events?limit=1&cursor=${encodeURIComponent(listing.json().next_cursor)}`);
        assert.equal(second.json().events[0].date, '2030-01-08');
        const third = await app.inject(`/api/workshop/events?limit=1&cursor=${encodeURIComponent(second.json().next_cursor)}`);
        assert.equal(third.json().events[0].date, '2030-01-09');
        assert.equal(third.json().next_cursor, null);
        const detail = await app.inject(`/api/workshop/events/${event.id}?date=2030-01-07`);
        assert.equal(detail.statusCode, 200);
        assert.equal(detail.json().event.start_utc, '2030-01-07T19:00:00Z');
    } finally { await app.close(); }
});

test('event registration checks capacity and records confirmed guest count transactionally', async () => {
    const now = Date.parse('2030-01-01T12:00:00Z');
    const calls = [];
    const client = {
        async query(sql, values = []) {
            calls.push({ sql, values });
            if (sql.includes('FROM tenants')) return { rows: [tenant], rowCount: 1 };
            if (sql.includes('FROM events')) return { rows: [event], rowCount: 1 };
            if (sql.includes('FILTER (WHERE status')) return { rows: [{ booked: 2, waitlisted: 0 }], rowCount: 1 };
            if (sql.includes('COUNT(*)::int AS count FROM rate_limits')) return { rows: [{ count: 0 }], rowCount: 1 };
            if (sql.includes('INSERT INTO customers')) return { rows: [{ id: 'customer-one' }], rowCount: 1 };
            if (sql.includes('COUNT(*)::int AS count FROM bookings')) return { rows: [{ count: 0 }], rowCount: 1 };
            return { rows: [], rowCount: 1 };
        },
        release() {},
    };
    const booking = await createEventBooking({ connect: async () => client }, tenant.slug, {
        booking_pattern: 'event', __ts: now - 4_000, __hp: '', event_id: event.id, date: '2030-01-07', spot_count: 3,
        consent_given: true, customer: { name: 'Ana Lima', email: 'ana@example.com', phone: '' }, custom_fields: {},
    }, { origin: 'https://workshop.example', host: 'workshop.example', ip: '127.0.0.1', now });
    assert.equal(booking.booking_pattern, 'event');
    assert.equal(booking.status, 'confirmed');
    assert.equal(booking.spot_count, 3);
    assert.equal(booking.total, '150.00');
    assert.equal(calls.some(({ sql, values }) => sql.includes('INSERT INTO bookings') && values.includes(3) && values.includes(event.id)), true);
    assert.equal(calls.some(({ sql }) => sql === 'COMMIT'), true);
});
