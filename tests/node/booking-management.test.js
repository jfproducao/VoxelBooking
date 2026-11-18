import assert from 'node:assert/strict';
import test from 'node:test';
import { cancelManagedBooking, getManagedBooking } from '../../server/services/booking-management.js';
import { manageCookieName, readManageToken } from '../../server/services/customer-capabilities.js';
import { buildApp } from '../../server/app.js';

const bookingId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const customerId = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const tenant = {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAX',
    slug: 'studio',
    timezone: 'UTC',
    status: 'active',
    allow_cancellation: true,
    cancellation_hours_before: 24,
    allow_rescheduling: true,
    rescheduling_hours_before: 24,
};
const futureStart = new Date(Date.now() + 5 * 86_400_000);
futureStart.setUTCSeconds(0, 0);
const start = futureStart.toISOString().slice(0, 19).replace('T', ' ');
const end = new Date(Date.parse(`${start.replace(' ', 'T')}Z`) + 3_600_000).toISOString().slice(0, 19).replace('T', ' ');
const row = {
    id: bookingId,
    tenant_id: tenant.id,
    customer_id: customerId,
    booking_pattern: 'timeslot',
    status: 'confirmed',
    start_datetime: start,
    end_datetime: end,
    party_size: 1,
    service_id: '01ARZ3NDEKTSV4RRFFQ69G5FAY',
    service_name: 'Consultation',
    is_virtual: false,
    staff_id: null,
    staff_name: null,
    resource_id: null,
    resource_name: null,
    event_id: null,
    event_name: null,
    event_location: null,
    customer_name: 'Ana Silva',
    customer_email: 'ana@example.com',
    customer_timezone: 'America/Sao_Paulo',
    rescheduled_to_id: null,
    cancelled_at: null,
    cancellation_reason: null,
};

function mockDatabase({ canceled = false } = {}) {
    const calls = [];
    const client = {
        async query(sql, values = []) {
            calls.push({ sql, values });
            if (sql.includes('FROM tenants WHERE slug')) return { rows: [tenant] };
            if (sql.includes('FROM customer_capabilities capability')) return { rows: [{ id: 'capability', customer_id: customerId }] };
            if (sql.includes('FROM bookings WHERE id = $1 AND tenant_id = $2 FOR UPDATE')) {
                return { rows: [{ ...row, status: canceled ? 'cancelled' : 'confirmed' }] };
            }
            return { rows: [], rowCount: 1 };
        },
        release() {},
    };
    return {
        calls,
        async query(sql, values = []) {
            calls.push({ sql, values });
            if (sql.includes('SELECT id FROM tenants WHERE slug')) return { rows: [{ id: tenant.id }] };
            if (sql.includes('FROM tenants WHERE slug')) return { rows: [tenant] };
            if (sql.includes('FROM customer_capabilities capability')) return { rows: [{ id: 'capability', customer_id: customerId }] };
            if (sql.includes('FROM bookings b')) return { rows: [{ ...row, status: canceled ? 'cancelled' : 'confirmed' }] };
            if (sql.includes('SELECT id FROM bookings WHERE id =')) return { rows: [] };
            return { rows: [], rowCount: 1 };
        },
        async connect() { return client; },
    };
}

const token = 'a'.repeat(64);

test('reads the manage token from its scoped cookie or explicit capability header', () => {
    assert.equal(readManageToken({ headers: { cookie: `${manageCookieName(bookingId)}=${token}` } }, bookingId), token);
    assert.equal(readManageToken({ headers: { 'x-customer-capability': token } }, bookingId), token);
    assert.equal(readManageToken({ headers: { cookie: `${manageCookieName(bookingId)}=bad` } }, bookingId), null);
});

test('returns protected booking details and policy permissions for a verified capability', async () => {
    const db = mockDatabase();
    const result = await getManagedBooking(db, tenant.slug, bookingId, token);
    assert.equal(result.booking.id, bookingId);
    assert.equal(result.booking.service_name, 'Consultation');
    assert.equal(result.can_cancel, true);
    assert.equal(result.can_reschedule, true);
    assert.equal(result.booking.start_utc, `${start.replace(' ', 'T')}Z`);
});

test('cancels a confirmed booking in one transaction and rejects an expired/missing capability', async () => {
    const db = mockDatabase();
    const result = await cancelManagedBooking(db, tenant.slug, bookingId, token);
    assert.deepEqual(result, {
        cancelled: true,
        booking_id: bookingId,
        email_sent: false,
        notification_state: 'none',
    });
    const statements = db.calls.map(({ sql }) => sql);
    assert.equal(statements[0], 'BEGIN');
    assert.ok(statements.some((sql) => sql.includes("SET status = 'cancelled'")));
    assert.ok(statements.some((sql) => sql.includes('UPDATE reminders')));
    assert.ok(statements.some((sql) => sql.includes('INSERT INTO audit_log')));
    assert.equal(statements.at(-1), 'COMMIT');

    const denied = mockDatabase();
    denied.query = async (sql) => sql.includes('FROM tenants WHERE slug') ? { rows: [tenant] } : { rows: [] };
    await assert.rejects(
        getManagedBooking(denied, tenant.slug, bookingId, token),
        (error) => error.code === 'verification_required' && error.statusCode === 403,
    );
});

test('customer-access exchanges the fragment token for an HttpOnly manage cookie', async () => {
    const app = buildApp({ db: mockDatabase() });
    try {
        const response = await app.inject({
            method: 'POST',
            url: '/api/studio/customer-access',
            headers: { origin: 'https://studio.example', host: 'studio.example' },
            payload: { token, purpose: 'booking.manage', subject_id: bookingId },
        });
        assert.equal(response.statusCode, 200);
        assert.deepEqual(response.json(), { verified: true });
        assert.match(response.headers['set-cookie'], new RegExp(`^${manageCookieName(bookingId)}=${token};`));
        assert.match(response.headers['set-cookie'], /HttpOnly/);
        assert.match(response.headers['set-cookie'], /SameSite=Lax/);
        assert.equal(response.headers['cache-control'], 'no-store, private');
    } finally {
        await app.close();
    }
});
