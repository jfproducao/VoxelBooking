import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { AdminStaffProblem, changeAdminStaffState, createAdminStaff, getAdminStaff, listAdminStaff, reorderAdminStaff, updateAdminStaff } from '../../server/services/admin-staff.js';
import { registerAdminStaffRoutes } from '../../server/routes/admin-staff.js';

function makeDb() {
    const staff = new Map(); const links = new Map(); const audits = [];
    const query = async (sql, values = []) => {
        if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
        if (sql.includes('SELECT COALESCE(MAX(sort_order)')) return { rows: [{ next_order: staff.size }] };
        if (sql.includes('INSERT INTO staff')) { const [id, tenant_id, name, email, phone, title, bio, sort_order] = values; staff.set(id, { id, tenant_id, name, email, phone, title, bio, sort_order, is_active: true }); return { rows: [] }; }
        if (sql.includes('SELECT id FROM services')) return { rows: values[1].filter((id) => id === 'service-1').map((id) => ({ id })) };
        if (sql.includes('DELETE FROM service_staff')) { links.set(values[0], []); return { rows: [] }; }
        if (sql.includes('INSERT INTO service_staff')) { links.set(values[1], [...(links.get(values[1]) || []), values[0]]); return { rows: [] }; }
        if (sql.includes('INSERT INTO audit_log')) { audits.push(values); return { rows: [] }; }
        if (sql.includes('UPDATE staff SET is_active')) { staff.get(values[2]).is_active = values[0]; return { rows: [] }; }
        if (sql.includes('UPDATE staff SET sort_order')) { staff.get(values[2]).sort_order = values[0]; return { rows: [] }; }
        if (sql.includes('UPDATE staff SET')) { const row = staff.get(values.at(-1)); const fields = sql.match(/SET (.+) WHERE/)[1].split(','); fields.forEach((field, i) => { row[field.split('=')[0]] = values[i]; }); return { rows: [] }; }
        if (sql.includes('SELECT s.id,s.name,s.email') && !sql.includes('COUNT(ss.service_id)')) { const row = staff.get(values[1]); return row && row.tenant_id === values[0] ? { rows: [{ ...row, service_ids: links.get(row.id) || [] }] } : { rows: [] }; }
        if (sql.includes('SELECT id FROM staff WHERE')) return { rows: [...staff.values()].filter((row) => row.tenant_id === values[0] && row.is_active === values[1]).sort((a,b) => a.sort_order-b.sort_order || a.name.localeCompare(b.name)).map(({ id }) => ({ id })) };
        if (sql.includes('SELECT s.id,s.name,s.email') && sql.includes('COUNT(ss.service_id)')) return { rows: [...staff.values()].filter((row) => row.tenant_id === values[0]).map((row) => ({ ...row, service_count: (links.get(row.id) || []).length })) };
        throw new Error(`Unexpected SQL: ${sql}`);
    };
    return { audits, async query(sql, values) { return query(sql, values); }, async connect() { return { query, release() {} }; } };
}

const actor = { type: 'operator', id: 'op-1' };

test('staff CRUD syncs services and records audited activation', async () => {
    const db = makeDb();
    const created = await createAdminStaff(db, { tenantId: 'tenant-1', actor, input: { name: 'Ana', email: 'ANA@example.test', service_ids: ['service-1'] } });
    assert.equal(created.email, 'ANA@example.test'); assert.deepEqual(created.service_ids, ['service-1']);
    const updated = await updateAdminStaff(db, { tenantId: 'tenant-1', actor, staffId: created.id, input: { expected_version: created.version, title: 'Especialista', service_ids: [] } });
    assert.equal(updated.title, 'Especialista'); assert.deepEqual(updated.service_ids, []);
    const inactive = await changeAdminStaffState(db, { tenantId: 'tenant-1', actor, staffId: created.id, input: { expected_version: updated.version, is_active: false } });
    assert.equal(inactive.is_active, false); assert.equal(db.audits.length, 3);
});

test('staff update rejects stale versions and another tenant cannot read the member', async () => {
    const db = makeDb(); const member = await createAdminStaff(db, { tenantId: 'tenant-1', actor, input: { name: 'Ana', email: 'ana@example.test' } });
    await assert.rejects(updateAdminStaff(db, { tenantId: 'tenant-1', actor, staffId: member.id, input: { expected_version: 'old', name: 'Bia' } }), (error) => error instanceof AdminStaffProblem && error.status === 409);
    assert.equal(await getAdminStaff(db, 'tenant-2', member.id), null);
});

test('staff ordering and validation preserve the PHP catalog constraints', async () => {
    const db = makeDb();
    const one = await createAdminStaff(db, { tenantId: 'tenant-1', actor, input: { name: 'Ana', email: 'ana@example.test' } });
    const two = await createAdminStaff(db, { tenantId: 'tenant-1', actor, input: { name: 'Bia', email: 'bia@example.test' } });
    await reorderAdminStaff(db, { tenantId: 'tenant-1', actor, staffId: two.id, input: { expected_version: two.version, direction: 'up' } });
    assert.equal((await listAdminStaff(db, 'tenant-1')).length, 2);
    assert.ok(one.id);
    await assert.rejects(createAdminStaff(db, { tenantId: 'tenant-1', actor, input: { name: 'Inválido', email: 'sem-email' } }), (error) => error instanceof AdminStaffProblem && error.status === 422);
    await assert.rejects(createAdminStaff(db, { tenantId: 'tenant-1', actor, input: { name: 'Inválido', email: 'bad@example.test', service_ids: ['foreign'] } }), (error) => error instanceof AdminStaffProblem && error.status === 422);
});

test('staff routes deny business managers, matching the PHP owner/operator rule', async () => {
    const app = Fastify();
    app.addHook('preHandler', async (request) => { request.adminSession = { user: { type: 'business_user', id: 'manager-1', tenant_id: 'tenant-1', role: 'manager' }, data: {} }; });
    await app.register(registerAdminStaffRoutes, { db: { async query() { throw new Error('tenant lookup must not run for a denied user'); } } });
    const response = await app.inject({ method: 'GET', url: '/admin/tenants/tenant-1/staff' });
    assert.equal(response.statusCode, 403);
    await app.close();
});
