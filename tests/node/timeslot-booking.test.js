import assert from 'node:assert/strict';
import test from 'node:test';
import { BookingProblem, createTimeslotBooking } from '../../server/services/timeslot-booking.js';
import { buildApp } from '../../server/app.js';

const now = Date.UTC(2030, 0, 6, 0);
const tenant = {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    slug: 'studio',
    booking_pattern: 'timeslot',
    timezone: 'UTC',
    slot_duration_minutes: 30,
    buffer_minutes: 0,
    min_advance_hours: 1,
    max_advance_days: 90,
    max_bookings_per_customer_per_day: 3,
    require_phone: false,
    requires_consent: true,
    consent_text: 'I agree to these booking terms.',
    privacy_policy_url: null,
    custom_fields: [],
    booking_requires_approval: false,
    send_reminders: false,
    currency: 'EUR',
};

function pool() {
    const calls = [];
    const client = {
        async query(sql, values = []) {
            calls.push({ sql, values });
            if (sql.includes('FROM tenants WHERE slug')) return { rows: [tenant], rowCount: 1 };
            if (sql.includes('COUNT(*)::int AS count FROM rate_limits')) return { rows: [{ count: 0 }], rowCount: 1 };
            if (sql.includes('SELECT duration_minutes FROM services')) return { rows: [{ duration_minutes: 60 }] };
            if (sql.includes('SELECT id, name, duration_minutes, price FROM services')) {
                return { rows: [{ id: values[0], name: 'Consultation', duration_minutes: 60, price: '30.00' }] };
            }
            if (sql.includes('AS blocked')) return { rows: [{ blocked: false }] };
            if (sql.includes('SELECT id FROM staff WHERE tenant_id')) return { rows: [] };
            if (sql.includes('FROM availability')) return { rows: [{ start_time: '09:00:00', end_time: '11:00:00' }] };
            if (sql.includes('FROM bookings') && sql.includes('start_datetime::date')) return { rows: [{ count: 0 }] };
            if (sql.includes('FROM bookings') && sql.includes('SELECT start_datetime')) return { rows: [] };
            if (sql.includes('INSERT INTO customers')) return { rows: [{ id: '01ARZ3NDEKTSV4RRFFQ69G5FAW' }] };
            if (sql.startsWith('SELECT name FROM staff')) return { rows: [] };
            if (sql.includes('INSERT INTO customer_capabilities')) return { rows: [] };
            return { rows: [], rowCount: 1 };
        },
        release() {},
    };
    return { calls, async connect() { return client; } };
}

const request = {
    __ts: now - 5000,
    __hp: '',
    customer: { name: 'Ana Silva', email: 'ANA@example.com', phone: '' },
    consent_given: true,
    customer_timezone: 'America/Sao_Paulo',
    service_id: '01ARZ3NDEKTSV4RRFFQ69G5FAX',
    date: '2030-01-07',
    time: '09:00',
};

test('rejects bot submissions and cross-origin requests before opening a database transaction', async () => {
    const db = pool();
    await assert.rejects(
        createTimeslotBooking(db, 'studio', { ...request, __ts: now - 1000 }, {
            origin: 'https://studio.example', host: 'studio.example', now,
        }),
        (error) => error instanceof BookingProblem && error.code === 'spam_detected',
    );
    await assert.rejects(
        createTimeslotBooking(db, 'studio', request, {
            origin: 'https://attacker.example', host: 'studio.example', now,
        }),
        (error) => error instanceof BookingProblem && error.code === 'csrf_mismatch',
    );
    assert.equal(db.calls.length, 0);
});

test('creates a confirmed booking atomically and returns the customer manage capability', async () => {
    const db = pool();
    const booking = await createTimeslotBooking(db, 'studio', request, {
        origin: 'https://studio.example', host: 'studio.example', ip: '127.0.0.1', now,
    });

    assert.equal(booking.status, 'confirmed');
    assert.equal(booking.service, 'Consultation');
    assert.equal(booking.duration, 60);
    assert.equal(booking.total, '30.00');
    assert.equal(booking.start_utc, '2030-01-07T09:00:00Z');
    assert.equal(booking.end_utc, '2030-01-07T10:00:00Z');
    assert.match(booking.manage_url, /^\/book\/studio\/manage\/[0-9A-HJKMNP-TV-Z]{26}#access=[a-f0-9]{64}$/);
    assert.equal(booking.consent_recorded, true);
    assert.equal(booking.notification_state, 'none');

    const sql = db.calls.map(({ sql: statement }) => statement);
    assert.ok(sql.some((statement) => statement.includes('FOR UPDATE')));
    assert.ok(sql.some((statement) => statement.includes('INSERT INTO bookings')));
    assert.ok(sql.some((statement) => statement.includes('INSERT INTO audit_log')));
    assert.ok(sql.at(-1) === 'COMMIT');
});

test('POST /api/:slug/bookings returns the booking contract expected by the booking page', async () => {
    const db = pool();
    const app = buildApp({ db });
    const date = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    try {
        const response = await app.inject({
            method: 'POST',
            url: '/api/studio/bookings',
            headers: { origin: 'https://studio.example', host: 'studio.example' },
            payload: { ...request, date, __ts: Date.now() - 5000 },
        });
        assert.equal(response.statusCode, 201);
        assert.equal(response.json().booking.date, date);
        assert.equal(response.json().booking.service, 'Consultation');
        assert.equal(response.json().booking.notification_state, 'none');
        assert.equal(response.headers['cache-control'], 'no-store, private');
    } finally {
        await app.close();
    }
});
