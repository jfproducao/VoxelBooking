import test from 'node:test';
import assert from 'node:assert/strict';
import {
    AdminServiceProblem, changeAdminServiceState, createAdminService, getAdminService,
    listAdminServices, reorderAdminService, updateAdminService,
} from '../../server/services/admin-services.js';

function makeDb() {
    const services = new Map(); const links = new Map(); const audits = [];
    const execute = async (sql, values = []) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
        if (sql.includes('SELECT COALESCE(MAX(sort_order)')) return { rows: [{ next_order: services.size }] };
        if (sql.includes('INSERT INTO services')) {
            const [id, tenant_id, name, description, duration_minutes, price, price_label, category, color, sort_order] = values;
            services.set(id, { id, tenant_id, name, description, duration_minutes, price, price_label, category, color, sort_order, is_active: true }); return { rows: [] };
        }
        if (sql.includes('SELECT id FROM staff WHERE')) return { rows: values[1].map((id) => ({ id })) };
        if (sql.includes('DELETE FROM service_staff')) { links.set(values[0], []); return { rows: [] }; }
        if (sql.includes('INSERT INTO service_staff')) { links.set(values[0], [...(links.get(values[0]) || []), values[1]]); return { rows: [] }; }
        if (sql.includes('INSERT INTO audit_log')) { audits.push(values); return { rows: [] }; }
        if (sql.includes('UPDATE services SET is_active')) { const item = services.get(values[2]); item.is_active = values[0]; return { rows: [] }; }
        if (sql.includes('UPDATE services SET sort_order')) { services.get(values[2]).sort_order = values[0]; return { rows: [] }; }
        if (sql.includes('UPDATE services SET')) {
            const tenantId = values.at(-2), serviceId = values.at(-1); const item = services.get(serviceId);
            const columns = sql.match(/SET (.+) WHERE/)[1].split(',');
            columns.forEach((entry, i) => { item[entry.split('=')[0]] = values[i]; });
            assert.equal(item.tenant_id, tenantId); return { rows: [] };
        }
        if (sql.includes('SELECT s.id,s.name') && !sql.includes('COUNT(ss.staff_id)')) {
            const tenantId = values[0]; const serviceId = values[1]; const item = services.get(serviceId);
            if (!item || item.tenant_id !== tenantId) return { rows: [] };
            return { rows: [{ ...item, staff_ids: links.get(serviceId) || [] }] };
        }
        if (sql.includes('SELECT id FROM services')) return { rows: [...services.values()].filter((x) => x.tenant_id === values[0] && x.is_active === values[1]).sort((a,b) => a.sort_order-b.sort_order || a.name.localeCompare(b.name)).map(({ id }) => ({ id })) };
        if (sql.includes('SELECT s.id,s.name,s.description')) return { rows: [...services.values()].filter((x) => x.tenant_id === values[0]).map((x) => ({ ...x, staff_count: (links.get(x.id) || []).length })) };
        throw new Error(`Unexpected SQL: ${sql}`);
    };
    return {
        audits,
        async query(sql, values) { return execute(sql, values); },
        async connect() { return { query: execute, release() {} }; },
    };
}

const actor = { type: 'operator', id: 'operator-1' };

test('service catalog supports create, linked staff, optimistic updates and state changes', async () => {
    const db = makeDb();
    const created = await createAdminService(db, { tenantId: 'tenant-1', actor, input: { name: 'Consulta', duration_minutes: 45, price: '25', staff_ids: ['staff-1'] } });
    assert.equal(created.name, 'Consulta'); assert.equal(created.price, '25.00'); assert.deepEqual(created.staff_ids, ['staff-1']);
    const updated = await updateAdminService(db, { tenantId: 'tenant-1', actor, serviceId: created.id, input: { expected_version: created.version, name: 'Consulta inicial', staff_ids: [] } });
    assert.equal(updated.name, 'Consulta inicial'); assert.deepEqual(updated.staff_ids, []);
    const inactive = await changeAdminServiceState(db, { tenantId: 'tenant-1', actor, serviceId: created.id, input: { expected_version: updated.version, is_active: false } });
    assert.equal(inactive.is_active, false); assert.equal(db.audits.length, 3);
});

test('service updates reject stale versions and cross-tenant records', async () => {
    const db = makeDb();
    const created = await createAdminService(db, { tenantId: 'tenant-1', actor, input: { name: 'Consulta' } });
    await assert.rejects(updateAdminService(db, { tenantId: 'tenant-1', actor, serviceId: created.id, input: { expected_version: 'stale', name: 'X' } }), (error) => error instanceof AdminServiceProblem && error.status === 409);
    assert.equal(await getAdminService(db, 'tenant-2', created.id), null);
});

test('service list and reorder preserve active groups and sort order', async () => {
    const db = makeDb();
    const first = await createAdminService(db, { tenantId: 'tenant-1', actor, input: { name: 'A' } });
    const second = await createAdminService(db, { tenantId: 'tenant-1', actor, input: { name: 'B' } });
    const moved = await reorderAdminService(db, { tenantId: 'tenant-1', actor, serviceId: second.id, input: { expected_version: second.version, direction: 'up' } });
    assert.equal(moved.sort_order, 0);
    const rows = await listAdminServices(db, 'tenant-1');
    assert.equal(rows.length, 2); assert.equal(rows[0].id, first.id);
});

test('service input validation rejects invalid durations and duplicate staff', async () => {
    const db = makeDb();
    await assert.rejects(createAdminService(db, { tenantId: 'tenant-1', actor, input: { name: 'A', duration_minutes: 0 } }), (error) => error instanceof AdminServiceProblem && error.status === 422);
    await assert.rejects(createAdminService(db, { tenantId: 'tenant-1', actor, input: { name: 'A', staff_ids: ['staff-1', 'staff-1'] } }), (error) => error instanceof AdminServiceProblem && error.status === 422);
});
