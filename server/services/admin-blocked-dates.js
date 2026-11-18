import { createHash, randomBytes } from 'node:crypto';
import { localNow } from '../time/venue-time.js';

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid(now = Date.now()) { let value = (BigInt(now) << 80n) | BigInt(`0x${randomBytes(10).toString('hex')}`); let id = ''; for (let i = 0; i < 26; i++) { id = alphabet[Number(value & 31n)] + id; value >>= 5n; } return id; }
export class AdminBlockedDateProblem extends Error { constructor(code, status = 422, details = {}) { super(code); this.code = code; this.status = status; this.details = details; } }

function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const d = new Date(`${value}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
function project(row) {
    const item = { id: row.id, tenant_id: row.tenant_id, start_date: String(row.start_date).slice(0, 10), end_date: String(row.end_date).slice(0, 10), reason: row.reason,
        staff_id: row.staff_id, resource_id: row.resource_id, staff_name: row.staff_name, resource_name: row.resource_name, affected_booking_count: Number(row.affected_booking_count || 0) };
    const versioned = { ...item }; delete versioned.affected_booking_count;
    item.version = createHash('sha256').update(JSON.stringify(versioned)).digest('hex'); return item;
}
async function transaction(db, callback) {
    const client = await db.connect();
    try { await client.query('BEGIN'); const value = await callback(client); await client.query('COMMIT'); return value; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
}
async function tenant(db, tenantId, lock = false) {
    const result = await db.query(`SELECT id,name,timezone,booking_pattern FROM tenants WHERE id=$1 AND status<>'archived'${lock ? ' FOR UPDATE' : ''}`, [tenantId]);
    if (!result.rows[0] || !['timeslot', 'resource', 'capacity'].includes(result.rows[0].booking_pattern)) throw new AdminBlockedDateProblem('tenant_not_found', 404);
    return result.rows[0];
}
function validate(input, currentTenant) {
    const { start_date: start, end_date: end } = input || {}; const reason = input?.reason ?? null;
    if (!validDate(start) || !validDate(end) || end < start || start < localNow(currentTenant.timezone).date) throw new AdminBlockedDateProblem('validation_failed', 422, { dates: 'invalid_or_past_range' });
    if (reason !== null && (typeof reason !== 'string' || reason.length > 255)) throw new AdminBlockedDateProblem('validation_failed', 422, { reason: 'invalid_value' });
    const staffId = input.staff_id || null; const resourceId = input.resource_id || null;
    if (staffId && resourceId) throw new AdminBlockedDateProblem('validation_failed', 422, { scope: 'one_target_only' });
    if (staffId && currentTenant.booking_pattern !== 'timeslot') throw new AdminBlockedDateProblem('validation_failed', 422, { staff_id: 'unsupported_target' });
    if (resourceId && currentTenant.booking_pattern !== 'resource') throw new AdminBlockedDateProblem('validation_failed', 422, { resource_id: 'unsupported_target' });
    return { start_date: start, end_date: end, reason, staff_id: staffId, resource_id: resourceId };
}
async function impact(db, tenantId, row) {
    const start = `${String(row.start_date).slice(0, 10)} 00:00:00`;
    const endDate = new Date(`${String(row.end_date).slice(0, 10)}T00:00:00Z`); endDate.setUTCDate(endDate.getUTCDate() + 1);
    const values = [tenantId, `${endDate.toISOString().slice(0, 10)} 00:00:00`, start];
    let scope = '';
    if (row.staff_id) { values.push(row.staff_id); scope = ` AND staff_id=$${values.length}`; }
    if (row.resource_id) { values.push(row.resource_id); scope = ` AND resource_id=$${values.length}`; }
    const result = await db.query(`SELECT COUNT(*)::int AS total FROM bookings WHERE tenant_id=$1 AND status IN ('confirmed','pending') AND start_datetime<$2::timestamp AND end_datetime>$3::timestamp${scope}`, values);
    return Number(result.rows[0]?.total || 0);
}
async function getRecord(db, tenantId, id) {
    const result = await db.query(`SELECT bd.id,bd.tenant_id,bd.start_date,bd.end_date,bd.reason,bd.staff_id,bd.resource_id,st.name AS staff_name,r.name AS resource_name
        FROM blocked_dates bd LEFT JOIN staff st ON st.id=bd.staff_id AND st.tenant_id=bd.tenant_id
        LEFT JOIN resources r ON r.id=bd.resource_id AND r.tenant_id=bd.tenant_id WHERE bd.tenant_id=$1 AND bd.id=$2`, [tenantId, id]);
    if (!result.rows[0]) return null;
    const row = result.rows[0]; return project({ ...row, affected_booking_count: await impact(db, tenantId, row) });
}
async function audit(client, tenantId, actor, id, action, ip) {
    await client.query(`INSERT INTO audit_log (id,tenant_id,actor_type,actor_id,action,entity_type,entity_id,ip_address) VALUES ($1,$2,$3,$4,$5,'blocked_date',$6,$7)`, [ulid(), tenantId, actor.type, actor.id, action, id, ip || null]);
}

export async function getAdminBlockedDates(db, tenantId) {
    const currentTenant = await tenant(db, tenantId);
    const [staff, resources, rows] = await Promise.all([
        currentTenant.booking_pattern === 'timeslot' ? db.query('SELECT id,name,title FROM staff WHERE tenant_id=$1 AND is_active=TRUE ORDER BY sort_order,name,id', [tenantId]) : { rows: [] },
        currentTenant.booking_pattern === 'resource' ? db.query('SELECT id,name FROM resources WHERE tenant_id=$1 AND is_active=TRUE ORDER BY sort_order,name,id', [tenantId]) : { rows: [] },
        db.query(`SELECT bd.id,bd.tenant_id,bd.start_date,bd.end_date,bd.reason,bd.staff_id,bd.resource_id,st.name AS staff_name,r.name AS resource_name FROM blocked_dates bd
            LEFT JOIN staff st ON st.id=bd.staff_id AND st.tenant_id=bd.tenant_id LEFT JOIN resources r ON r.id=bd.resource_id AND r.tenant_id=bd.tenant_id
            WHERE bd.tenant_id=$1 ORDER BY bd.start_date DESC,bd.end_date DESC,bd.id`, [tenantId]),
    ]);
    const blockedDates = await Promise.all(rows.rows.map(async (row) => project({ ...row, affected_booking_count: await impact(db, tenantId, row) })));
    const today = localNow(currentTenant.timezone).date;
    return { tenant: currentTenant, staff: staff.rows, resources: resources.rows, upcoming: blockedDates.filter((item) => item.end_date >= today), past: blockedDates.filter((item) => item.end_date < today) };
}

export async function createAdminBlockedDate(db, { tenantId, actor, input, ip }) {
    return transaction(db, async (client) => {
        const currentTenant = await tenant(client, tenantId, true); const data = validate(input, currentTenant);
        for (const [key, table, id] of [['staff_id', 'staff', data.staff_id], ['resource_id', 'resources', data.resource_id]]) if (id) {
            const found = await client.query(`SELECT id FROM ${table} WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
            if (!found.rows.length) throw new AdminBlockedDateProblem('validation_failed', 422, { [key]: 'unknown_or_foreign_target' });
        }
        const overlap = await client.query(`SELECT id FROM blocked_dates WHERE tenant_id=$1 AND start_date<=$2::date AND end_date>=$3::date
            AND ${data.staff_id ? 'staff_id=$4' : 'staff_id IS NULL'} AND ${data.resource_id ? `resource_id=$${data.staff_id ? 5 : 4}` : 'resource_id IS NULL'} LIMIT 1`, [tenantId, data.end_date, data.start_date, ...(data.staff_id ? [data.staff_id] : []), ...(data.resource_id ? [data.resource_id] : [])]);
        if (overlap.rows.length) throw new AdminBlockedDateProblem('conflict', 409, { start_date: 'overlapping_block' });
        const id = ulid();
        await client.query('INSERT INTO blocked_dates (id,tenant_id,start_date,end_date,reason,staff_id,resource_id) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, tenantId, data.start_date, data.end_date, data.reason, data.staff_id, data.resource_id]);
        await audit(client, tenantId, actor, id, 'created', ip);
        return getRecord(client, tenantId, id);
    });
}

export async function deleteAdminBlockedDate(db, { tenantId, actor, id, expectedVersion, ip }) {
    return transaction(db, async (client) => {
        await tenant(client, tenantId, true);
        const before = await getRecord(client, tenantId, id);
        if (!before) throw new AdminBlockedDateProblem('blocked_date_not_found', 404);
        if (expectedVersion !== before.version) throw new AdminBlockedDateProblem('version_conflict', 409);
        await client.query('DELETE FROM blocked_dates WHERE tenant_id=$1 AND id=$2', [tenantId, id]);
        await audit(client, tenantId, actor, id, 'deleted', ip);
        return before;
    });
}
