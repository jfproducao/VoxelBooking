import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingTransitions, changeAdminBookingStatus, listAdminBookings } from '../../server/services/admin-bookings.js';

test('admin booking state machine matches the PHP management transitions', () => {
    assert.deepEqual(bookingTransitions('pending'), ['confirmed', 'cancelled']);
    assert.deepEqual(bookingTransitions('waitlisted'), ['confirmed', 'cancelled']);
    assert.deepEqual(bookingTransitions('confirmed'), ['cancelled', 'completed', 'no_show']);
    assert.deepEqual(bookingTransitions('cancelled'), ['confirmed']);
    assert.deepEqual(bookingTransitions('completed'), ['confirmed']);
    assert.deepEqual(bookingTransitions('rescheduled'), []);
});

test('admin booking list binds tenant and filters and caps a page at 25 rows', async () => {
    const queries = [];
    const db = { async query(sql, values) {
        queries.push({ sql, values });
        return sql.startsWith('SELECT COUNT') ? { rows: [{ total: 31 }] } : { rows: [] };
    } };
    const result = await listAdminBookings(db, { status: 'confirmed', from: '2031-02-03', to: '2031-02-04', search: '50%', page: '2', sort: 'customer', direction: 'asc' }, 'tenant-1');
    assert.equal(result.total, 31);
    assert.equal(result.page, 2);
    assert.equal(queries[0].values[0], 'tenant-1');
    assert(queries[0].sql.includes('b.tenant_id=$1'));
    assert(queries[0].sql.includes("ESCAPE '!'"));
    assert.equal(queries[0].values[4], '%50!%%');
    assert(queries[1].sql.includes('ORDER BY COALESCE(b.customer_name_snapshot,c.name) ASC'));
    assert(queries[1].sql.includes('LIMIT 25 OFFSET 25'));
});

test('admin cancellation preserves transaction, customer count, reminder, audit, and notification updates', async () => {
    const calls = [];
    let status = 'confirmed';
    const booking = { id: 'booking-1', tenant_id: 'tenant-1', customer_id: 'customer-1', booking_pattern: 'timeslot', start_datetime: '2031-02-03 09:00:00', end_datetime: '2031-02-03 09:30:00', status };
    const tenant = { id: 'tenant-1', timezone: 'UTC', notify_on_cancellation: false, notify_on_booking: false, send_reminders: false };
    const db = {
        async connect() {
            return { async query(sql, values = []) {
                calls.push(sql);
                if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
                if (sql.includes('SELECT b.*')) return { rows: [booking] };
                if (sql.includes('SELECT * FROM tenants')) return { rows: [tenant] };
                if (sql.includes("UPDATE bookings SET status='cancelled'")) { status = 'cancelled'; return { rows: [], rowCount: 1 }; }
                if (sql.includes('UPDATE customers SET booking_count')) return { rows: [] };
                if (sql.includes('UPDATE reminders SET sent_at')) return { rows: [] };
                if (sql.includes('SELECT status FROM bookings')) return { rows: [{ status }] };
                if (sql.includes('INSERT INTO delivery_outbox')) return { rows: [] };
                if (sql.includes('SELECT id FROM delivery_outbox')) return { rows: [{ id: 'outbox-1' }] };
                if (sql.includes('INSERT INTO audit_log')) return { rows: [] };
                if (sql.includes('SELECT * FROM delivery_outbox')) return { rows: [] };
                throw new Error(`Unexpected query: ${sql}`);
            }, release() {} };
        },
    };
    const result = await changeAdminBookingStatus(db, { bookingId: 'booking-1', tenantId: 'tenant-1', status: 'cancelled', actor: { type: 'business_user', id: 'user-1' }, ip: '127.0.0.1' });
    assert.equal(result.status, 'cancelled');
    assert(calls.includes('BEGIN'));
    assert(calls.includes('COMMIT'));
    assert(calls.some((sql) => sql.includes('UPDATE customers SET booking_count')));
    assert(calls.some((sql) => sql.includes('UPDATE reminders SET sent_at')));
    assert(calls.some((sql) => sql.includes('INSERT INTO audit_log')));
});
