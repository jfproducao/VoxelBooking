import assert from 'node:assert/strict';
import test from 'node:test';
import { rescheduleTimeslotBooking } from '../../server/services/timeslot-reschedule.js';

const now = Date.UTC(2030, 0, 6, 0);
const bookingId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const customerId = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const capabilityId = '01ARZ3NDEKTSV4RRFFQ69G5FAX';
const tenant = {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAY',
    slug: 'studio',
    booking_pattern: 'timeslot',
    timezone: 'UTC',
    slot_duration_minutes: 30,
    buffer_minutes: 0,
    min_advance_hours: 1,
    max_advance_days: 90,
    allow_rescheduling: true,
    rescheduling_hours_before: 24,
    send_reminders: false,
};
const booking = {
    id: bookingId,
    tenant_id: tenant.id,
    customer_id: customerId,
    booking_pattern: 'timeslot',
    service_id: '01ARZ3NDEKTSV4RRFFQ69G5FAZ',
    staff_id: null,
    start_datetime: '2030-01-07 09:00:00',
    end_datetime: '2030-01-07 10:00:00',
    party_size: 1,
    status: 'confirmed',
    notes: 'Original note',
    custom_field_data: { favorite: 'blue' },
    consent_given_at: '2030-01-01 12:00:00',
    consent_text_shown: 'I agree to these terms.',
    customer_timezone: 'America/Sao_Paulo',
    customer_name_snapshot: 'Ana Silva',
    customer_email_snapshot: 'ana@example.com',
    customer_phone_snapshot: null,
    price_total: '30.00',
    price_currency: 'EUR',
};
const token = 'b'.repeat(64);

function database({ conflict = false } = {}) {
    const calls = [];
    const client = {
        async query(sql, values = []) {
            calls.push({ sql, values });
            if (sql.includes('FROM tenants WHERE slug')) return { rows: [tenant] };
            if (sql.includes('FROM customer_capabilities capability')) return { rows: [{ id: capabilityId, customer_id: customerId }] };
            if (sql.includes('FROM bookings WHERE id = $1 AND tenant_id = $2 FOR UPDATE')) return { rows: [booking] };
            if (sql.includes('SELECT duration_minutes FROM services')) return { rows: [{ duration_minutes: 60 }] };
            if (sql.includes('AS blocked')) return { rows: [{ blocked: false }] };
            if (sql.includes('SELECT id FROM staff WHERE tenant_id')) return { rows: [] };
            if (sql.includes('FROM availability')) return { rows: [{ start_time: '09:00:00', end_time: '11:00:00' }] };
            if (sql.includes('SELECT start_datetime, end_datetime FROM bookings')) {
                return { rows: conflict ? [{ start_datetime: '2030-01-08 09:00:00', end_datetime: '2030-01-08 10:00:00' }] : [] };
            }
            if (sql.includes('SELECT name FROM services')) return { rows: [{ name: 'Consultation' }] };
            return { rows: [], rowCount: 1 };
        },
        release() {},
    };
    return { calls, async connect() { return client; } };
}

test('reschedules a timeslot, carries consent and customer data, and moves its capability', async () => {
    const db = database();
    const result = await rescheduleTimeslotBooking(
        db, tenant.slug, bookingId, token, { new_date: '2030-01-08', new_time: '09:00' }, now,
    );
    assert.equal(result.rescheduled, true);
    assert.notEqual(result.new_booking_id, bookingId);
    assert.equal(result.new_booking.service, 'Consultation');
    assert.equal(result.new_booking.date, '2030-01-08');
    assert.equal(result.new_booking.time, '09:00');
    assert.equal(result.new_booking.end_time, '10:00');
    assert.equal(result.new_booking.start_utc, '2030-01-08T09:00:00Z');

    const insert = db.calls.find(({ sql }) => sql.includes('INSERT INTO bookings'));
    assert.ok(insert);
    assert.equal(insert.values[10], booking.consent_given_at);
    assert.equal(insert.values[11], booking.consent_text_shown);
    assert.equal(insert.values[12], booking.customer_timezone);
    assert.equal(insert.values[17], booking.price_currency);
    const statements = db.calls.map(({ sql }) => sql);
    assert.ok(statements.some((sql) => sql.includes("SET status = 'rescheduled'")));
    assert.ok(statements.some((sql) => sql.includes('UPDATE customer_capabilities SET subject_id')));
    assert.ok(statements.some((sql) => sql.includes('INSERT INTO audit_log')));
    assert.equal(statements.at(-1), 'COMMIT');
});

test('rolls back when the replacement time is no longer available', async () => {
    const db = database({ conflict: true });
    await assert.rejects(
        rescheduleTimeslotBooking(db, tenant.slug, bookingId, token, { new_date: '2030-01-08', new_time: '09:00' }, now),
        (error) => error.code === 'slot_unavailable' && error.statusCode === 409,
    );
    const statements = db.calls.map(({ sql }) => sql);
    assert.equal(statements[0], 'BEGIN');
    assert.ok(statements.includes('ROLLBACK'));
    assert.equal(statements.some((sql) => sql.includes('INSERT INTO bookings')), false);
});
