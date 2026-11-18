import assert from 'node:assert/strict';
import test from 'node:test';
import { rescheduleOtherPattern } from '../../server/services/pattern-reschedule.js';

const now = Date.parse('2030-01-06T00:00:00Z');
const tenantId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const bookingId = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const customerId = '01ARZ3NDEKTSV4RRFFQ69G5FAX';
const capabilityId = '01ARZ3NDEKTSV4RRFFQ69G5FAY';
const token = 'b'.repeat(64);
const tenantDefaults = {
    id: tenantId, slug: 'studio', timezone: 'UTC', min_advance_hours: 1, max_advance_days: 90,
    allow_rescheduling: true, rescheduling_hours_before: 24, send_reminders: false,
    max_bookings_per_customer_per_day: 3, currency: 'BRL',
};

function makeDb(pattern) {
    const tenant = { ...tenantDefaults, booking_pattern: pattern };
    const booking = {
        id: bookingId, tenant_id: tenantId, customer_id: customerId, booking_pattern: pattern,
        resource_id: pattern === 'resource' ? 'resource-one' : null,
        capacity_slot_id: pattern === 'capacity' ? 'slot-old' : null,
        event_id: pattern === 'event' ? 'event-one' : null,
        start_datetime: '2030-01-07 19:00:00', end_datetime: '2030-01-07 21:00:00',
        party_size: 2, status: 'confirmed', notes: 'Observação', custom_field_data: { color: 'azul' },
        consent_given_at: '2030-01-01 10:00:00', consent_text_shown: 'Aceito os termos.', customer_timezone: 'UTC',
        customer_name_snapshot: 'Ana', customer_email_snapshot: 'ana@example.com', customer_phone_snapshot: null,
        price_total: '100.00', price_currency: 'BRL', rescheduled_to_id: null,
    };
    const resource = { id: 'resource-one', name: 'Cabana', capacity: 4, price_per_night: '100.00', min_stay_nights: 1, max_stay_nights: 30, check_in_days: null, check_out_days: null };
    const slot = { id: 'slot-new', day_of_week: 1, start_time: '18:00:00', end_time: '20:00:00', max_capacity: 8, min_party_size: 1, max_party_size: 6, label: 'Noite', is_active: true };
    const event = {
        id: 'event-one', tenant_id: tenantId, name: 'Aula', location: 'Sala', description: null, price: '50.00',
        max_participants: 8, min_spot_count: 1, max_spot_count: 4, start_datetime: '2030-01-07 19:00:00',
        end_datetime: '2030-01-07 21:00:00', is_recurring: true, rrule: 'FREQ=WEEKLY;COUNT=4', exception_dates: [],
        allow_waitlist: true, waitlist_max: 4, is_active: true,
    };
    const calls = [];
    const client = {
        async query(sql, values = []) {
            calls.push({ sql, values });
            if (sql.includes('FROM tenants WHERE slug')) return { rows: [tenant], rowCount: 1 };
            if (sql.includes('FROM customer_capabilities capability')) return { rows: [{ id: capabilityId, customer_id: customerId }], rowCount: 1 };
            if (sql.includes('FROM bookings WHERE id=$1 AND tenant_id=$2 FOR UPDATE')) return { rows: [booking], rowCount: 1 };
            if (sql.includes('FROM resources')) return { rows: [resource], rowCount: 1 };
            if (sql.includes('FROM blocked_dates')) return { rows: [], rowCount: 0 };
            if (sql.includes('FROM seasonal_pricing')) return { rows: [], rowCount: 0 };
            if (sql.includes('FROM capacity_slots')) return { rows: [slot], rowCount: 1 };
            if (sql.includes('GROUP BY start_datetime::date')) return { rows: [], rowCount: 0 };
            if (sql.includes('FROM events')) return { rows: [event], rowCount: 1 };
            if (sql.includes('FILTER (WHERE status')) return { rows: [{ booked: 0, waitlisted: 0 }], rowCount: 1 };
            if (sql.includes('SELECT id FROM bookings WHERE tenant_id=$1 AND resource_id=$2')) return { rows: [], rowCount: 0 };
            return { rows: [], rowCount: 1 };
        },
        release() {},
    };
    return { calls, booking, async connect() { return client; } };
}

test('resource self-reschedule reprices stay and preserves customer evidence', async () => {
    const db = makeDb('resource');
    const result = await rescheduleOtherPattern(db, 'studio', bookingId, token, { check_in: '2030-01-10', check_out: '2030-01-12' }, now);
    assert.equal(result.rescheduled, true);
    assert.equal(result.new_booking.check_in, '2030-01-10');
    assert.equal(result.new_booking.check_out, '2030-01-12');
    const insert = db.calls.find(({ sql }) => sql.includes('INSERT INTO bookings'));
    assert.ok(insert.values.includes('200.00'));
    assert.ok(insert.values.includes(db.booking.consent_text_shown));
    assert.ok(db.calls.some(({ sql }) => sql.includes('UPDATE customer_capabilities SET subject_id')));
});

test('capacity self-reschedule excludes the original booking and updates capacity slot id', async () => {
    const db = makeDb('capacity');
    const result = await rescheduleOtherPattern(db, 'studio', bookingId, token, { date: '2030-01-08', slot_id: 'slot-new' }, now);
    assert.equal(result.rescheduled, true);
    assert.equal(result.new_booking.time, '18:00');
    const slotCheck = db.calls.find(({ sql }) => sql.includes('FROM bookings WHERE tenant_id=$1 AND booking_pattern=\'capacity\''));
    assert.ok(slotCheck.values.includes(bookingId));
    const insert = db.calls.find(({ sql }) => sql.includes('INSERT INTO bookings'));
    assert.ok(insert.sql.includes('capacity_slot_id'));
    assert.ok(insert.values.includes('slot-new'));
});

test('event self-reschedule rejects waitlist placement and preserves the event booking', async () => {
    const db = makeDb('event');
    const result = await rescheduleOtherPattern(db, 'studio', bookingId, token, { date: '2030-01-14' }, now);
    assert.equal(result.rescheduled, true);
    assert.equal(result.new_booking.date, '2030-01-14');
    assert.equal(result.new_booking.event_name, 'Aula');
    const insert = db.calls.find(({ sql }) => sql.includes('INSERT INTO bookings'));
    assert.ok(insert.values.includes('event-one'));
    assert.ok(insert.values.includes(db.booking.consent_text_shown));
});
