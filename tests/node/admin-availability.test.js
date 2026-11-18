import test from 'node:test';
import assert from 'node:assert/strict';
import { AdminAvailabilityProblem, getAdminAvailabilityContext, getAdminSchedule, resetAdminStaffSchedule, saveAdminSchedule } from '../../server/services/admin-availability.js';

function makeDb() {
    const tenants = new Map([['tenant-1', { id: 'tenant-1', name: 'Studio', timezone: 'America/Sao_Paulo', booking_pattern: 'timeslot' }]]);
    const people = [{ id: 'staff-1', name: 'Ana', title: 'Especialista' }];
    const rows = [{ id: 'a1', tenant_id: 'tenant-1', staff_id: null, day_of_week: 0, start_time: '09:00:00', end_time: '17:00:00', is_available: true }];
    const query = async (sql, values = []) => {
        if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
        if (sql.includes('FROM tenants WHERE id=$1')) return { rows: tenants.has(values[0]) ? [tenants.get(values[0])] : [] };
        if (sql.includes('SELECT id FROM staff WHERE')) return { rows: people.filter((person) => person.id === values[1]) };
        if (sql.includes('SELECT id,name,title FROM staff')) return { rows: people };
        if (sql.includes('SELECT DISTINCT staff_id FROM availability')) return { rows: [...new Set(rows.filter((row) => row.tenant_id === values[0] && row.staff_id).map((row) => row.staff_id))].map((staff_id) => ({ staff_id })) };
        if (sql.includes('SELECT day_of_week,start_time,end_time,is_available FROM availability')) return { rows: rows.filter((row) => row.tenant_id === values[0] && (sql.includes('staff_id IS NULL') ? row.staff_id === null : row.staff_id === values[1])).sort((a,b) => a.day_of_week-b.day_of_week || a.start_time.localeCompare(b.start_time)).map(({ id, ...row }) => row) };
        if (sql.startsWith('DELETE FROM availability')) { const staffId = sql.includes('staff_id=$2') ? values[1] : null; for (let i = rows.length - 1; i >= 0; i--) if (rows[i].tenant_id === values[0] && rows[i].staff_id === staffId) rows.splice(i, 1); return { rows: [] }; }
        if (sql.includes('INSERT INTO availability')) { rows.push({ id: values[0], tenant_id: values[1], staff_id: values[2], day_of_week: values[3] ?? 0, start_time: values[4] ?? '00:00:00', end_time: values[5] ?? '00:00:00', is_available: sql.includes('TRUE') }); return { rows: [] }; }
        if (sql.includes('INSERT INTO audit_log')) return { rows: [] };
        throw new Error(`Unexpected SQL: ${sql}`);
    };
    return { rows, async query(sql, values) { return query(sql, values); }, async connect() { return { query, release() {} }; } };
}

const actor = { type: 'operator', id: 'operator-1' };

test('staff schedules inherit business defaults until an explicit override is set or reset', async () => {
    const db = makeDb(); const inherited = await getAdminSchedule(db, 'tenant-1', 'staff-1');
    assert.equal(inherited.inherits_business_schedule, true); assert.deepEqual(inherited.windows, [{ day_of_week: 0, start_time: '09:00', end_time: '17:00' }]);
    const closed = await saveAdminSchedule(db, { tenantId: 'tenant-1', staffId: 'staff-1', actor, input: { expected_version: inherited.version, windows: [] } });
    assert.equal(closed.inherits_business_schedule, false); assert.deepEqual(closed.windows, []);
    const reset = await resetAdminStaffSchedule(db, { tenantId: 'tenant-1', staffId: 'staff-1', actor, expectedVersion: closed.version });
    assert.equal(reset.inherits_business_schedule, true); assert.deepEqual(reset.windows, inherited.windows);
});

test('weekly schedule validates overlapping periods and saves tenant defaults', async () => {
    const db = makeDb(); const ctx = await getAdminAvailabilityContext(db, 'tenant-1');
    await assert.rejects(saveAdminSchedule(db, { tenantId: 'tenant-1', actor, input: { expected_version: ctx.schedule.version, windows: [
        { day_of_week: 0, start_time: '09:00', end_time: '13:00' }, { day_of_week: 0, start_time: '12:00', end_time: '15:00' },
    ] } }), (error) => error instanceof AdminAvailabilityProblem && error.details.windows === 'overlapping_windows');
    const saved = await saveAdminSchedule(db, { tenantId: 'tenant-1', actor, input: { expected_version: ctx.schedule.version, windows: [{ day_of_week: 1, start_time: '10:00', end_time: '16:30' }] } });
    assert.deepEqual(saved.windows, [{ day_of_week: 1, start_time: '10:00', end_time: '16:30' }]);
});

test('schedule writes reject stale versions', async () => {
    const db = makeDb();
    await assert.rejects(saveAdminSchedule(db, { tenantId: 'tenant-1', actor, input: { expected_version: 'stale', windows: [] } }), (error) => error instanceof AdminAvailabilityProblem && error.status === 409);
});
