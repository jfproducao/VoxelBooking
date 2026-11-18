import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverBookingNotification, queueBookingNotifications, queueDueReminders } from '../../server/services/booking-notifications.js';

test('booking notification outbox writes the customer and opted-in staff messages with a status snapshot', async () => {
    const inserts = [];
    const client = { query: async (sql, values = []) => {
        if (sql.includes('SELECT status FROM bookings')) return { rows: [{ status: 'confirmed' }] };
        if (sql.includes('INSERT INTO delivery_outbox')) { inserts.push(values); return { rows: [] }; }
        if (sql.includes('SELECT id FROM delivery_outbox')) return { rows: [{ id: `01K${inserts.length}` }] };
        throw new Error(`Unexpected SQL: ${sql}`);
    } };
    const queued = await queueBookingNotifications(client, { id: 'tenant', notify_on_booking: true }, 'booking', 'created', { now: 1_700_000_000_000 });
    assert.equal(queued.ids.length, 2);
    assert.equal(queued.customerQueued, true);
    assert.equal(inserts[0][1], 'booking.notification.node');
    assert.deepEqual(JSON.parse(inserts[0][4]), {
        booking_id: 'booking', tenant_id: 'tenant', kind: 'created', audience: 'customer', original_booking_id: null,
        expected_status: 'confirmed',
    });
    assert.equal(inserts[1][1], 'booking.notification.node');
    assert.equal(JSON.parse(inserts[1][4]).audience, 'staff');
});

test('worker logs a customer confirmation without outbound mail and marks the outbox delivered', async () => {
    const previous = { APP_URL: process.env.APP_URL, MAIL_TRANSPORT: process.env.MAIL_TRANSPORT };
    process.env.APP_URL = 'https://booking.example';
    process.env.MAIL_TRANSPORT = 'log';
    const booking = {
        id: 'booking', tenant_id: 'tenant', customer_id: 'customer', slug: 'studio', business_name: 'Studio',
        business_email: 'studio@example.test', notification_email: 'owner@example.test', notify_on_booking: true,
        notify_on_cancellation: true, timezone: 'UTC', locale: 'en', currency: 'USD', brand_color: '#2563EB',
        status: 'confirmed', booking_pattern: 'timeslot', start_datetime: '2030-01-02 10:00:00',
        end_datetime: '2030-01-02 10:30:00', customer_name: 'A Customer', customer_email: 'customer@example.test',
        is_anonymized: false, service_name: 'Consultation', staff_name: null, resource_name: null, event_name: null,
        party_size: 1, price_total: '25.00', price_currency: 'USD',
    };
    const outbox = {
        id: 'outbox', topic: 'booking.notification.node', attempts: 0,
        payload_cipher: JSON.stringify({ booking_id: 'booking', tenant_id: 'tenant', kind: 'created', audience: 'customer', expected_status: 'confirmed' }),
    };
    const statements = [];
    let connectCalls = 0;
    const pool = {
        async connect() {
            connectCalls++;
            const claimConnection = connectCalls === 1;
            return {
                query: async (sql, values = []) => {
                    statements.push(sql);
                    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
                    if (sql.includes('SELECT * FROM delivery_outbox')) return { rows: [outbox] };
                    if (sql.includes('UPDATE delivery_outbox SET status=\'sending\'')) return { rows: [{ ...outbox, attempts: 1, lease_token: values[0] }] };
                    if (sql.includes('INSERT INTO customer_capabilities')) return { rows: [] };
                    if (claimConnection) throw new Error(`Unexpected claim SQL: ${sql}`);
                    throw new Error(`Unexpected capability SQL: ${sql}`);
                }, release() {},
            };
        },
        async query(sql, values = []) {
            statements.push(sql);
            if (sql.includes('SELECT b.*,t.slug')) return { rows: [booking] };
            if (sql.includes('SELECT subject,heading')) return { rows: [] };
            if (sql.includes('SELECT "key",value FROM settings')) return { rows: [{ key: 'mail_transport', value: 'log' }] };
            if (sql.includes('INSERT INTO email_log')) return { rows: [] };
            if (sql.includes('UPDATE delivery_outbox SET status=$1')) return { rows: [] };
            throw new Error(`Unexpected worker SQL: ${sql}`);
        },
    };
    try {
        const result = await deliverBookingNotification(pool, 'outbox');
        assert.deepEqual(result, { id: 'outbox', audience: 'customer', state: 'delivered', email_sent: false });
        assert(statements.some((sql) => sql.includes('INSERT INTO email_log')));
        assert(statements.some((sql) => sql.includes('UPDATE delivery_outbox SET status=$1')));
    } finally {
        if (previous.APP_URL === undefined) delete process.env.APP_URL; else process.env.APP_URL = previous.APP_URL;
        if (previous.MAIL_TRANSPORT === undefined) delete process.env.MAIL_TRANSPORT; else process.env.MAIL_TRANSPORT = previous.MAIL_TRANSPORT;
    }
});

test('reminder worker queues due reminders once using the durable outbox', async () => {
    const statements = [];
    const client = {
        async query(sql, values = []) {
            statements.push({ sql, values });
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
            if (sql.includes('SELECT r.id,r.booking_id,r.tenant_id FROM reminders')) {
                return { rows: [{ id: 'reminder', booking_id: 'booking', tenant_id: 'tenant' }] };
            }
            if (sql.includes('INSERT INTO delivery_outbox')) return { rows: [] };
            throw new Error(`Unexpected SQL: ${sql}`);
        },
        release() {},
    };
    const queued = await queueDueReminders({ connect: async () => client }, 10);
    assert.equal(queued, 1);
    const insert = statements.find((statement) => statement.sql.includes('INSERT INTO delivery_outbox'));
    assert.equal(insert.values[1], 'booking.reminder.node');
    assert.deepEqual(JSON.parse(insert.values[4]), {
        reminder_id: 'reminder', booking_id: 'booking', tenant_id: 'tenant', kind: 'reminder', audience: 'customer',
        expected_status: 'confirmed',
    });
});
