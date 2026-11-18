import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import bcrypt from 'bcryptjs';
import { installAdminAuthHook, registerAdminAuthRoutes } from '../../server/routes/admin-auth.js';
import { registerAdminCalendarRoutes } from '../../server/routes/admin-calendar.js';

test('admin login rotates the server-side session, accepts PHP bcrypt hashes, and checks CSRF', async () => {
    const prior = { NODE_ENV: process.env.NODE_ENV, FORCE_HTTPS: process.env.FORCE_HTTPS };
    process.env.NODE_ENV = 'test'; process.env.FORCE_HTTPS = 'false';
    const passwordHash = (await bcrypt.hash('correct horse', 4)).replace('$2b$', '$2y$');
    const sessions = new Map();
    const operator = { id: '01J00000000000000000000000', name: 'Operator', email: 'owner@example.test', password_hash: passwordHash };
    const db = {
        async connect() {
            return {
                async query(sql, values = []) {
                    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
                    if (sql.includes('SELECT pg_advisory_xact_lock')) return { rows: [] };
                    if (sql.includes('SELECT COUNT(*)::int AS count FROM rate_limits')) return { rows: [{ count: 0 }] };
                    if (sql.includes("INSERT INTO rate_limits")) return { rows: [] };
                    if (sql.includes('INSERT INTO admin_sessions')) {
                        sessions.set(values[0], { id_hash: values[0], data: JSON.parse(values[1]), last_activity: values[2], expires_at: values[3] });
                        return { rows: [] };
                    }
                    if (sql.includes('DELETE FROM admin_sessions')) { sessions.delete(values[0]); return { rows: [] }; }
                    if (sql.includes('UPDATE operators SET updated_at')) return { rows: [] };
                    throw new Error(`Unexpected transaction SQL: ${sql}`);
                },
                release() {},
            };
        },
        async query(sql, values = []) {
            if (sql.includes("SELECT id,name,slug,timezone FROM tenants WHERE status='active'")) return { rows: [] };
            if (sql.includes('SELECT id,name,timezone,week_start,booking_pattern FROM tenants')) return { rows: [{ id: values[0], name: 'Studio', timezone: 'UTC', week_start: 1, booking_pattern: 'timeslot' }] };
            if (sql.includes('SELECT * FROM tenants WHERE id=$1 LIMIT 1')) return { rows: [{ id: values[0], name: 'Studio', timezone: 'UTC', week_start: 1, booking_pattern: 'timeslot', status: 'active' }] };
            if (sql.includes('COUNT(*) FILTER (WHERE b.start_datetime::date=$2::date)')) return { rows: [{ today: 0, week: 0, month: 0, pending: 0 }] };
            if (sql.includes('SELECT COUNT(*)::int AS total FROM customers WHERE tenant_id=$1')) return { rows: [{ total: 0 }] };
            if (sql.includes('FROM bookings b JOIN tenants t ON t.id=b.tenant_id JOIN customers c')) return { rows: [] };
            if (sql.includes('FROM bookings b JOIN customers c')) return { rows: [] };
            if (sql.includes('FROM blocked_dates')) return { rows: [] };
            if (sql.includes('FROM availability WHERE tenant_id=$1 AND staff_id IS NULL')) return { rows: [] };
            if (sql.includes('SELECT COUNT(*)::int AS total FROM bookings b JOIN tenants t')) return { rows: [{ total: 0 }] };
            if (sql.includes('SELECT b.id,b.tenant_id,t.name AS tenant_name')) return { rows: [] };
            if (sql.includes('SELECT id FROM tenants WHERE id=$1 AND status<>$2')) return { rows: [{ id: values[0] }] };
            if (sql.includes('SELECT COUNT(*)::int AS total FROM customers')) return { rows: [{ total: 0 }] };
            if (sql.includes('SELECT id,name,email,phone,booking_count,last_booking_at,created_at FROM customers')) return { rows: [] };
            if (sql.includes('SELECT id_hash,data,last_activity,expires_at FROM admin_sessions')) return { rows: sessions.has(values[0]) ? [sessions.get(values[0])] : [] };
            if (sql.includes('INSERT INTO admin_sessions')) {
                sessions.set(values[0], { id_hash: values[0], data: JSON.parse(values[1]), last_activity: values[2], expires_at: values[3] });
                return { rows: [] };
            }
            if (sql.includes('SELECT id,name,email,password_hash FROM operators')) return { rows: [operator] };
            if (sql.includes('SELECT id,name,email FROM operators')) return { rows: [operator] };
            if (sql.includes('UPDATE admin_sessions SET last_activity')) {
                const row = sessions.get(values[2]);
                if (row) { row.last_activity = values[0]; row.expires_at = values[1]; }
                return { rows: [] };
            }
            if (sql.includes('INSERT INTO audit_log')) return { rows: [] };
            throw new Error(`Unexpected SQL: ${sql}`);
        },
    };
    const app = Fastify();
    installAdminAuthHook(app, { db });
    app.register(registerAdminAuthRoutes, { db });
    app.register(registerAdminCalendarRoutes, { db });
    try {
        const privateCalendar = await app.inject({ method: 'GET', url: '/admin/tenants/tenant-1/calendar' });
        assert.equal(privateCalendar.statusCode, 302);
        const loginPage = await app.inject({ method: 'GET', url: '/admin/login' });
        assert.equal(loginPage.statusCode, 200);
        const csrf = loginPage.body.match(/name="csrf_token" value="([a-f0-9]{64})"/)?.[1];
        const initialCookie = loginPage.headers['set-cookie'].split(';')[0];
        assert(csrf);
        const rejected = await app.inject({ method: 'POST', url: '/admin/login', headers: { cookie: initialCookie }, payload: { email: 'owner@example.test', password: 'wrong', csrf_token: '0'.repeat(64) } });
        assert.equal(rejected.statusCode, 403);
        const loggedIn = await app.inject({
            method: 'POST', url: '/admin/login', headers: { cookie: initialCookie },
            payload: { email: 'OWNER@example.test', password: 'correct horse', csrf_token: csrf, remember_me: true },
        });
        assert.equal(loggedIn.statusCode, 200);
        assert.equal(loggedIn.json().redirect, '/admin');
        const authenticatedCookie = loggedIn.headers['set-cookie'].split(';')[0];
        assert.notEqual(authenticatedCookie, initialCookie);
        assert.equal(sessions.size, 1);
        const dashboard = await app.inject({ method: 'GET', url: '/admin', headers: { cookie: authenticatedCookie } });
        assert.equal(dashboard.statusCode, 200);
        assert.match(dashboard.body, /Olá, Operator/);
        const tenantDashboard = await app.inject({ method: 'GET', url: '/admin/tenants/tenant-1', headers: { cookie: authenticatedCookie } });
        assert.equal(tenantDashboard.statusCode, 200);
        assert.match(tenantDashboard.body, /Calendário/);
        const bookingPage = await app.inject({ method: 'GET', url: '/admin/bookings', headers: { cookie: authenticatedCookie } });
        assert.equal(bookingPage.statusCode, 200);
        assert.match(bookingPage.body, /Reservas/);
        const customerPage = await app.inject({ method: 'GET', url: '/admin/tenants/tenant-1/customers', headers: { cookie: authenticatedCookie } });
        assert.equal(customerPage.statusCode, 200);
        assert.match(customerPage.body, /Clientes/);
        const calendarPage = await app.inject({ method: 'GET', url: '/admin/tenants/tenant-1/calendar?date=2031-05-15', headers: { cookie: authenticatedCookie } });
        assert.equal(calendarPage.statusCode, 200);
        assert.match(calendarPage.body, /Calendário/);
        assert.match(calendarPage.body, /2031-04-28/);
    } finally {
        await app.close();
        if (prior.NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prior.NODE_ENV;
        if (prior.FORCE_HTTPS === undefined) delete process.env.FORCE_HTTPS; else process.env.FORCE_HTTPS = prior.FORCE_HTTPS;
    }
});
