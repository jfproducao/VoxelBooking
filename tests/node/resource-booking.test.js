import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../../server/app.js';
import { getResourceAvailableDates, quoteResourceStay } from '../../server/services/resource-availability.js';
import { createResourceBooking } from '../../server/services/resource-booking.js';

process.env.NODE_ENV = 'test';

const tenant = {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', slug: 'stay', booking_pattern: 'resource', timezone: 'UTC',
    min_advance_hours: 1, max_advance_days: 2000, require_phone: false, requires_consent: true,
    consent_text: 'Consent text', privacy_policy_url: null, custom_fields: [], booking_requires_approval: false,
    max_bookings_per_customer_per_day: 3, send_reminders: false, currency: 'BRL',
};
const resource = {
    id: 'resource-1', name: 'Chalé', capacity: 4, price_per_night: '100.00',
    min_stay_nights: 1, max_stay_nights: 30, check_in_days: null, check_out_days: null,
};

function quoteDb({ resourceRow = resource, blocked = [], bookings = [], seasons = [] } = {}) {
    const calls = [];
    return {
        calls,
        async query(sql, values = []) {
            calls.push({ sql, values });
            if (sql.includes('FROM resources')) return { rows: resourceRow ? [resourceRow] : [], rowCount: resourceRow ? 1 : 0 };
            if (sql.includes('FROM blocked_dates')) return { rows: blocked, rowCount: blocked.length };
            if (sql.includes('FROM bookings')) return { rows: bookings, rowCount: bookings.length };
            if (sql.includes('FROM seasonal_pricing')) return { rows: seasons, rowCount: seasons.length };
            throw new Error(`Unexpected SQL: ${sql}`);
        },
    };
}

test('resource quote applies seasonal prices per night using exact cent totals', async () => {
    const db = quoteDb({ seasons: [{
        start_date: '2030-01-02', end_date: '2030-01-02', price_per_night: '120.00', label: 'Alta temporada',
    }] });
    const result = await quoteResourceStay(db, tenant, resource.id, '2030-01-01', '2030-01-04', 2, {
        now: Date.parse('2030-01-01T12:00:00Z'),
    });
    assert.deepEqual(result, {
        available: true, error: null, nights: 3, total: '320.00',
        pricing: [
            { date: '2030-01-01', price: '100.00', label: null },
            { date: '2030-01-02', price: '120.00', label: 'Alta temporada' },
            { date: '2030-01-03', price: '100.00', label: null },
        ],
        resource: { id: resource.id, name: 'Chalé', capacity: 4 },
    });
});

test('resource quote uses checkout-exclusive nights and preserves unpriced stays as null totals', async () => {
    const db = quoteDb({ resourceRow: { ...resource, price_per_night: null } });
    const result = await quoteResourceStay(db, tenant, resource.id, '2030-01-01', '2030-01-02', 1, {
        now: Date.parse('2030-01-01T12:00:00Z'),
    });
    assert.equal(result.nights, 1);
    assert.equal(result.pricing.length, 1);
    assert.equal(result.pricing[0].date, '2030-01-01');
    assert.equal(result.pricing[0].price, null);
    assert.equal(result.total, null);
});

test('resource quote rejects weekday restrictions, capacity, blocked dates, and overlapping stays', async () => {
    const restricted = quoteDb({ resourceRow: { ...resource, check_in_days: [5], check_out_days: [0] } });
    const fridayStay = await quoteResourceStay(restricted, tenant, resource.id, '2030-01-07', '2030-01-13', 2, {
        now: Date.parse('2030-01-01T12:00:00Z'),
    });
    assert.equal(fridayStay.error, 'invalid_check_in_day');

    const tooMany = await quoteResourceStay(quoteDb(), tenant, resource.id, '2030-01-07', '2030-01-08', 5, {
        now: Date.parse('2030-01-01T12:00:00Z'),
    });
    assert.equal(tooMany.error, 'capacity_exceeded');

    const blocked = await quoteResourceStay(quoteDb({ blocked: [{ start_date: '2030-01-07', end_date: '2030-01-07' }] }), tenant, resource.id, '2030-01-07', '2030-01-09', 2, {
        now: Date.parse('2030-01-01T12:00:00Z'),
    });
    assert.equal(blocked.error, 'date_blocked');

    const occupied = await quoteResourceStay(quoteDb({ bookings: [{ id: 'occupied' }] }), tenant, resource.id, '2030-01-07', '2030-01-09', 2, {
        now: Date.parse('2030-01-01T12:00:00Z'),
    });
    assert.equal(occupied.error, 'already_booked');
});

test('resource monthly availability excludes past, blocked, and booked days but retains checkout day', async () => {
    const db = quoteDb({
        blocked: [{ start_date: '2030-01-15', end_date: '2030-01-15' }],
        bookings: [{ start_datetime: '2030-01-12 00:00:00', end_datetime: '2030-01-14 00:00:00' }],
    });
    const result = await getResourceAvailableDates(db, tenant, resource.id, 2030, 1, { now: Date.parse('2030-01-10T12:00:00Z') });
    assert.equal(result.dates.includes('2030-01-10'), true);
    assert.equal(result.dates.includes('2030-01-12'), false);
    assert.equal(result.dates.includes('2030-01-13'), false);
    assert.equal(result.dates.includes('2030-01-14'), true);
    assert.equal(result.dates.includes('2030-01-15'), false);
    assert.equal(result.dates.at(-1), '2030-01-31');
});

test('resource availability endpoint returns dates and quotes in the PHP response shape', async () => {
    const db = {
        async query(sql, values = []) {
            if (sql.includes('FROM tenants')) return { rows: [tenant], rowCount: 1 };
            if (sql.includes('FROM resources')) return { rows: [resource], rowCount: 1 };
            if (sql.includes('FROM blocked_dates')) return { rows: [], rowCount: 0 };
            if (sql.includes('FROM bookings')) return { rows: [], rowCount: 0 };
            if (sql.includes('FROM seasonal_pricing')) return { rows: [], rowCount: 0 };
            throw new Error(`Unexpected SQL: ${sql}`);
        },
    };
    const app = buildApp({ db });
    try {
        const quote = await app.inject('/api/stay/resources/resource-1/availability?check_in=2030-01-07&check_out=2030-01-09&guests=2');
        assert.equal(quote.statusCode, 200);
        assert.deepEqual(quote.json(), {
            available: true, error: null, nights: 2, total: '200.00',
            pricing: [
                { date: '2030-01-07', price: '100.00', label: null },
                { date: '2030-01-08', price: '100.00', label: null },
            ],
            resource: { id: resource.id, name: 'Chalé', capacity: 4 },
        });
        const month = await app.inject('/api/stay/resources/resource-1/availability?year=2030&month=1');
        assert.equal(month.statusCode, 200);
        assert.equal(month.json().year, 2030);
        assert.equal(month.json().month, 1);
        assert.ok(Array.isArray(month.json().dates));
        assert.equal(month.headers['cache-control'], 'no-store');
    } finally { await app.close(); }
});

test('resource booking commits customer, booking, consent, audit, reminder policy, and capability atomically', async () => {
    const calls = [];
    const client = {
        async query(sql, values = []) {
            calls.push({ sql, values });
            if (sql.includes('FROM tenants')) return { rows: [tenant], rowCount: 1 };
            if (sql === 'SELECT COUNT(*)::int AS count FROM rate_limits WHERE ip = $1 AND endpoint_group = \'booking_create\' AND created_at > $2::timestamp - INTERVAL \'1 minute\'') return { rows: [{ count: 0 }], rowCount: 1 };
            if (sql.includes('INSERT INTO customers')) return { rows: [{ id: 'customer-1' }], rowCount: 1 };
            if (sql.includes('FROM resources')) return { rows: [resource], rowCount: 1 };
            if (sql.includes('FROM blocked_dates') || sql.includes('FROM seasonal_pricing')) return { rows: [], rowCount: 0 };
            if (sql.includes('FROM bookings') && sql.includes('start_datetime <')) return { rows: [], rowCount: 0 };
            if (sql.includes('SELECT COUNT(*)::int AS count FROM bookings')) return { rows: [{ count: 0 }], rowCount: 1 };
            return { rows: [], rowCount: 1 };
        },
        release() { calls.push({ sql: 'RELEASE' }); },
    };
    const pool = { async connect() { return client; } };
    const now = Date.parse('2030-01-01T12:00:00Z');
    const result = await createResourceBooking(pool, tenant.slug, {
        booking_pattern: 'resource', __ts: now - 5000, __hp: '', resource_id: resource.id,
        check_in: '2030-01-07', check_out: '2030-01-09', guest_count: 2,
        customer: { name: 'Ana', email: 'ana@example.com', phone: '' }, consent_given: true,
        custom_fields: {}, customer_timezone: 'America/Sao_Paulo',
    }, { origin: 'https://studio.example', host: 'studio.example', ip: '127.0.0.1', now });

    assert.equal(result.booking_pattern, 'resource');
    assert.equal(result.total, '200.00');
    assert.equal(result.nights, 2);
    assert.equal(result.consent_recorded, true);
    assert.match(result.manage_url, /#access=[a-f0-9]{64}$/);
    assert.equal(calls[0].sql, 'BEGIN');
    assert.ok(calls.some((call) => call.sql.includes("VALUES ($1,$2,$3,'resource'")));
    assert.ok(calls.some((call) => call.sql === 'COMMIT'));
    assert.equal(calls.at(-1).sql, 'RELEASE');
});

test('POST /api/:slug/bookings dispatches a resource reservation and returns its customer link', async () => {
    const client = {
        async query(sql) {
            if (sql.includes('FROM tenants')) return { rows: [tenant], rowCount: 1 };
            if (sql.includes('COUNT(*)::int AS count FROM rate_limits')) return { rows: [{ count: 0 }], rowCount: 1 };
            if (sql.includes('INSERT INTO customers')) return { rows: [{ id: 'customer-1' }], rowCount: 1 };
            if (sql.includes('FROM resources')) return { rows: [resource], rowCount: 1 };
            if (sql.includes('FROM blocked_dates') || sql.includes('FROM seasonal_pricing')) return { rows: [], rowCount: 0 };
            if (sql.includes('FROM bookings') && sql.includes('start_datetime <')) return { rows: [], rowCount: 0 };
            if (sql.includes('COUNT(*)::int AS count FROM bookings')) return { rows: [{ count: 0 }], rowCount: 1 };
            return { rows: [], rowCount: 1 };
        },
        release() {},
    };
    const app = buildApp({ db: { async connect() { return client; } } });
    try {
        const response = await app.inject({
            method: 'POST', url: '/api/stay/bookings', headers: { origin: 'http://localhost' },
            payload: {
                booking_pattern: 'resource', __ts: Date.now() - 5000, __hp: '',
                resource_id: resource.id, check_in: '2030-01-07', check_out: '2030-01-09', guest_count: 2,
                customer: { name: 'Ana', email: 'ana@example.com' }, consent_given: true, custom_fields: {},
            },
        });
        assert.equal(response.statusCode, 201);
        assert.equal(response.json().booking.booking_pattern, 'resource');
        assert.equal(response.json().booking.total, '200.00');
        assert.match(response.json().booking.manage_url, /\/book\/stay\/manage\//);
    } finally { await app.close(); }
});
