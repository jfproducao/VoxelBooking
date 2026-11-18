import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../../server/app.js';

process.env.NODE_ENV = 'test';

const tenant = {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', slug: 'studio', name: '<Studio>', status: 'active',
    booking_pattern: 'timeslot', timezone: 'America/Sao_Paulo', currency: 'BRL',
    require_phone: true, requires_consent: true, consent_text: 'Aceito <termos>',
    custom_fields: [{ name: 'purpose', label: 'Motivo', type: 'text', required: true }],
    brand_color: '#123456', show_powered_by: true, booking_page_heading: 'Agenda & Cuidados',
    booking_page_description: 'Escolha um horário.', logo_path: '/uploads/logo.png',
};

function dbFor(row = tenant) {
    return {
        async query(sql, values) {
            assert.match(sql, /FROM tenants/);
            assert.deepEqual(values, ['studio']);
            return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
        },
    };
}

test('Node booking page safely renders tenant settings and exposes its client module', async () => {
    const app = buildApp({ db: dbFor() });
    try {
        const response = await app.inject('/book/studio');
        assert.equal(response.statusCode, 200);
        assert.match(response.headers['content-type'], /text\/html/);
        assert.match(response.headers['x-robots-tag'], /noindex/);
        assert.match(response.body, /&lt;Studio&gt;/);
        assert.match(response.body, /Agenda &amp; Cuidados/);
        assert.match(response.body, /Aceito \\u003ctermos\\u003e/);
        assert.match(response.body, /America\/Sao_Paulo/);
        assert.doesNotMatch(response.body, /password_hash|smtp_password|api_secret/i);

        const script = await app.inject('/node-booking.js');
        assert.equal(script.statusCode, 200);
        assert.match(script.headers['content-type'], /javascript/);
        assert.match(script.body, /\/api\/.*\/availability/);
        assert.match(script.body, /submission_started_at/);
    } finally { await app.close(); }
});

test('Node booking page does not render archived tenants', async () => {
    const archivedApp = buildApp({ db: dbFor(null) });
    try {
        assert.equal((await archivedApp.inject('/book/studio')).statusCode, 404);
    } finally { await archivedApp.close(); }

});

test('Node resource booking page loads a dedicated resource flow', async () => {
    const app = buildApp({ db: dbFor({ ...tenant, booking_pattern: 'resource', currency: 'BRL' }) });
    try {
        const response = await app.inject('/book/studio');
        assert.equal(response.statusCode, 200);
        assert.match(response.body, /node-resource-booking\.js/);
        assert.match(response.body, /check-in/);
        assert.match(response.body, /check-out/);
        const script = await app.inject('/node-resource-booking.js');
        assert.equal(script.statusCode, 200);
        assert.match(script.body, /\/availability\?\$\{query\}/);
        assert.match(script.body, /booking_pattern: 'resource'/);
    } finally { await app.close(); }
});

test('Node capacity booking page loads its dedicated flow', async () => {
    const app = buildApp({ db: dbFor({ ...tenant, booking_pattern: 'capacity' }) });
    try {
        const response = await app.inject('/book/studio');
        assert.equal(response.statusCode, 200);
        assert.match(response.body, /node-capacity-booking\.js/);
        assert.match(response.body, /party-size/);
        const script = await app.inject('/node-capacity-booking.js');
        assert.equal(script.statusCode, 200);
        assert.match(script.body, /capacity\/slots/);
        assert.match(script.body, /booking_pattern: 'capacity'/);
    } finally { await app.close(); }
});

test('Node event booking page loads event selection and waitlist flow', async () => {
    const app = buildApp({ db: dbFor({ ...tenant, booking_pattern: 'event' }) });
    try {
        const response = await app.inject('/book/studio');
        assert.equal(response.statusCode, 200);
        assert.match(response.body, /node-event-booking\.js/);
        assert.match(response.body, /id="spots"/);
        const script = await app.inject('/node-event-booking.js');
        assert.equal(script.statusCode, 200);
        assert.match(script.body, /events\?/);
        assert.match(script.body, /booking_pattern: 'event'/);
    } finally { await app.close(); }
});

test('Node customer management page is private and includes no capability token', async () => {
    const app = buildApp({ db: {
        async query(sql, values) {
            assert.match(sql, /FROM tenants/);
            assert.deepEqual(values, ['studio']);
            return { rows: [{ slug: 'studio', name: 'Studio', timezone: 'UTC', brand_color: '#123456' }], rowCount: 1 };
        },
    } });
    try {
        const response = await app.inject('/book/studio/manage/01ARZ3NDEKTSV4RRFFQ69G5FAV');
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers['cache-control'], 'no-store, private');
        assert.equal(response.headers['referrer-policy'], 'no-referrer');
        assert.match(response.body, /node-manage\.js/);
        assert.doesNotMatch(response.body, /access=[0-9a-f]{32}/);

        const script = await app.inject('/node-manage.js');
        assert.equal(script.statusCode, 200);
        assert.match(script.body, /customer-access/);
        assert.match(script.body, /reschedule/);
    } finally { await app.close(); }
});
