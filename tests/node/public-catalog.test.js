import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../../server/app.js';

process.env.NODE_ENV = 'test';

const tenant = { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', slug: 'studio', booking_pattern: 'timeslot' };

function fakeDb({ serviceRows = [], staffRows = [], resourceRows = [], tenantRow = tenant } = {}) {
    const calls = [];
    return {
        calls,
        async query(sql, values = []) {
            calls.push({ sql, values });
            if (sql.includes('FROM tenants')) return { rows: tenantRow ? [tenantRow] : [], rowCount: tenantRow ? 1 : 0 };
            if (sql.includes('SELECT id FROM services')) return { rows: [{ id: values[0] }], rowCount: 1 };
            if (sql.includes('FROM services')) return { rows: serviceRows, rowCount: serviceRows.length };
            if (sql.includes('FROM staff')) return { rows: staffRows, rowCount: staffRows.length };
            if (sql.includes('FROM resources')) return { rows: resourceRows, rowCount: resourceRows.length };
            throw new Error(`Unexpected SQL: ${sql}`);
        },
    };
}

test('services endpoint preserves public fields and scalar types', async () => {
    const db = fakeDb({ serviceRows: [{
        id: 'service-1', name: 'Consultation', description: null, duration_minutes: 45,
        price: '75.00', price_label: null, category: null, preparation_text: null,
        cover_image_path: 'uploads/studio/cover.webp', color: '#123456',
        is_virtual: false, requires_staff: true, sort_order: 2,
    }] });
    const app = buildApp({ db });
    try {
        const response = await app.inject({ method: 'GET', url: '/api/studio/services' });
        assert.equal(response.statusCode, 200);
        assert.deepEqual(response.json().services[0], {
            id: 'service-1', name: 'Consultation', description: null, duration_minutes: 45,
            price: '75.00', price_label: null, category: null, preparation_text: null,
            cover_image_path: '/uploads/studio/cover.webp', color: '#123456',
            is_virtual: false, requires_staff: true, sort_order: 2,
        });
        assert.equal(response.headers['cache-control'], 'no-store');
        assert.equal(response.headers['x-content-type-options'], 'nosniff');
        assert.equal(response.headers['x-frame-options'], 'SAMEORIGIN');
        assert.deepEqual(db.calls.at(-1).values, [tenant.id]);
    } finally {
        await app.close();
    }
});

test('staff endpoint scopes service filtering to the active tenant', async () => {
    const db = fakeDb({ staffRows: [{ id: 'staff-1', name: 'Ari', title: null, avatar_path: null, sort_order: '1' }] });
    const app = buildApp({ db });
    try {
        const response = await app.inject({ method: 'GET', url: '/api/studio/staff?service_id=service-1' });
        assert.equal(response.statusCode, 200);
        assert.deepEqual(response.json(), { staff: [{ id: 'staff-1', name: 'Ari', title: null, avatar_path: null, sort_order: 1 }] });
        assert.deepEqual(db.calls[1].values, ['service-1', tenant.id]);
        assert.match(db.calls[2].sql, /service_id = \$2/);
        assert.deepEqual(db.calls[2].values, [tenant.id, 'service-1']);
    } finally {
        await app.close();
    }
});

test('resources endpoint normalizes JSON, prices, numeric fields, and image paths', async () => {
    const db = fakeDb({ resourceRows: [{
        id: 'room-1', name: 'Room', description: null, capacity: '4', amenities: ['wifi'],
        price_per_night: '90.00', min_stay_nights: '2', max_stay_nights: '14',
        check_in_days: [1, 3], check_out_days: null, cover_image_path: '/uploads/room.jpg', sort_order: '5',
    }] });
    const app = buildApp({ db });
    try {
        const response = await app.inject({ method: 'GET', url: '/api/studio/resources' });
        assert.equal(response.statusCode, 200);
        assert.deepEqual(response.json().resources[0], {
            id: 'room-1', name: 'Room', description: null, capacity: 4, amenities: ['wifi'],
            price_per_night: '90.00', min_stay_nights: 2, max_stay_nights: 14,
            check_in_days: [1, 3], check_out_days: null, cover_image_path: '/uploads/room.jpg', sort_order: 5,
        });
    } finally {
        await app.close();
    }
});

test('catalog endpoints do not reveal archived or missing tenant catalogs', async () => {
    const db = fakeDb({ tenantRow: null });
    const app = buildApp({ db });
    try {
        for (const path of ['/api/studio/services', '/api/studio/staff', '/api/studio/resources']) {
            const response = await app.inject({ method: 'GET', url: path });
            assert.equal(response.statusCode, 404);
            assert.deepEqual(response.json(), { error: 'tenant_not_found' });
        }
    } finally {
        await app.close();
    }
});
