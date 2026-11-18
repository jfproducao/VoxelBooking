import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { AdminBlockedDateProblem, createAdminBlockedDate, deleteAdminBlockedDate, getAdminBlockedDates } from '../../server/services/admin-blocked-dates.js';
import { registerAdminBlockedDateRoutes } from '../../server/routes/admin-blocked-dates.js';

function futureDate(offset) { const date = new Date(); date.setUTCDate(date.getUTCDate() + offset); return date.toISOString().slice(0, 10); }
function makeDb(pattern = 'timeslot') {
    const tenant = { id: 'tenant-1', name: 'Studio', timezone: 'UTC', booking_pattern: pattern };
    const rows = []; const audits = [];
    const query = async (sql, values = []) => {
        if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
        if (sql.includes('FROM tenants WHERE id=$1')) return { rows: values[0] === tenant.id ? [tenant] : [] };
        if (sql.includes('SELECT id,name,title FROM staff')) return { rows: [{ id: 'staff-1', name: 'Ana', title: 'Especialista' }] };
        if (sql.includes('SELECT id,name FROM resources')) return { rows: [{ id: 'resource-1', name: 'Sala' }] };
        if (sql.includes('SELECT id FROM staff WHERE')) return { rows: values[1] === 'staff-1' ? [{ id: 'staff-1' }] : [] };
        if (sql.includes('SELECT id FROM resources WHERE')) return { rows: values[1] === 'resource-1' ? [{ id: 'resource-1' }] : [] };
        if (sql.includes('SELECT DISTINCT staff_id')) return { rows: [] };
        if (sql.includes('FROM blocked_dates bd')) {
            let found = rows.filter((row) => row.tenant_id === values[0]);
            if (sql.includes('bd.id=$2')) found = found.filter((row) => row.id === values[1]);
            return { rows: found.map((row) => ({ ...row, staff_name: row.staff_id ? 'Ana' : null, resource_name: row.resource_id ? 'Sala' : null })) };
        }
        if (sql.includes('SELECT COUNT(*)::int AS total FROM bookings')) return { rows: [{ total: 0 }] };
        if (sql.includes('SELECT id FROM blocked_dates')) {
            const [tenantId, end, start] = values;
            return { rows: rows.filter((row) => row.tenant_id === tenantId && row.start_date <= end && row.end_date >= start && (sql.includes('staff_id=$4') ? row.staff_id === values[3] : row.staff_id === null) && (sql.includes('resource_id=$4') ? row.resource_id === values[3] : sql.includes('resource_id=$5') ? row.resource_id === values[4] : row.resource_id === null)).map(({ id }) => ({ id })) };
        }
        if (sql.includes('INSERT INTO blocked_dates')) { const [id, tenant_id, start_date, end_date, reason, staff_id, resource_id] = values; rows.push({ id, tenant_id, start_date, end_date, reason, staff_id, resource_id }); return { rows: [] }; }
        if (sql.includes('DELETE FROM blocked_dates')) { const index = rows.findIndex((row) => row.tenant_id === values[0] && row.id === values[1]); if (index >= 0) rows.splice(index, 1); return { rows: [] }; }
        if (sql.includes('INSERT INTO audit_log')) { audits.push(values); return { rows: [] }; }
        throw new Error(`Unexpected SQL: ${sql}`);
    };
    return { rows, audits, async query(sql, values) { return query(sql, values); }, async connect() { return { query, release() {} }; } };
}

const actor = { type: 'operator', id: 'operator-1' };

test('blocked date administration creates, scopes, versions, lists and deletes a block', async () => {
    const db = makeDb(); const start = futureDate(3); const end = futureDate(4);
    const created = await createAdminBlockedDate(db, { tenantId: 'tenant-1', actor, input: { start_date: start, end_date: end, reason: 'Feriado', staff_id: 'staff-1' } });
    assert.equal(created.staff_name, 'Ana'); assert.equal(created.reason, 'Feriado');
    const lists = await getAdminBlockedDates(db, 'tenant-1'); assert.equal(lists.upcoming.length, 1); assert.equal(lists.upcoming[0].affected_booking_count, 0);
    await assert.rejects(deleteAdminBlockedDate(db, { tenantId: 'tenant-1', actor, id: created.id, expectedVersion: 'stale' }), (error) => error instanceof AdminBlockedDateProblem && error.status === 409);
    await deleteAdminBlockedDate(db, { tenantId: 'tenant-1', actor, id: created.id, expectedVersion: created.version });
    assert.equal(db.rows.length, 0); assert.equal(db.audits.length, 2);
});

test('blocked dates reject invalid ranges, incompatible scope and overlapping periods', async () => {
    const db = makeDb(); const start = futureDate(5); const end = futureDate(6);
    await assert.rejects(createAdminBlockedDate(db, { tenantId: 'tenant-1', actor, input: { start_date: end, end_date: start } }), (error) => error instanceof AdminBlockedDateProblem && error.status === 422);
    await assert.rejects(createAdminBlockedDate(db, { tenantId: 'tenant-1', actor, input: { start_date: start, end_date: end, staff_id: 'staff-1', resource_id: 'resource-1' } }), (error) => error instanceof AdminBlockedDateProblem && error.status === 422);
    await createAdminBlockedDate(db, { tenantId: 'tenant-1', actor, input: { start_date: start, end_date: end, staff_id: 'staff-1' } });
    await assert.rejects(createAdminBlockedDate(db, { tenantId: 'tenant-1', actor, input: { start_date: start, end_date: end, staff_id: 'staff-1' } }), (error) => error instanceof AdminBlockedDateProblem && error.status === 409);
    const capacity = makeDb('capacity');
    await assert.rejects(createAdminBlockedDate(capacity, { tenantId: 'tenant-1', actor, input: { start_date: start, end_date: end, staff_id: 'staff-1' } }), (error) => error instanceof AdminBlockedDateProblem && error.status === 422);
});

test('blocked date routes deny manager accounts under the PHP access rule', async () => {
    const app = Fastify();
    app.addHook('preHandler', async (request) => { request.adminSession = { user: { type: 'business_user', id: 'manager-1', tenant_id: 'tenant-1', role: 'manager' }, data: {} }; });
    await app.register(registerAdminBlockedDateRoutes, { db: { async query() { throw new Error('tenant lookup must not run for denied user'); } } });
    const response = await app.inject({ method: 'GET', url: '/admin/tenants/tenant-1/blocked-dates' });
    assert.equal(response.statusCode, 403);
    await app.close();
});
