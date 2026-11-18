import { createHash, randomBytes } from 'node:crypto';

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid(now = Date.now()) { let value = (BigInt(now) << 80n) | BigInt(`0x${randomBytes(10).toString('hex')}`); let id = ''; for (let i = 0; i < 26; i++) { id = alphabet[Number(value & 31n)] + id; value >>= 5n; } return id; }
export class AdminAvailabilityProblem extends Error { constructor(code, status = 422, details = {}) { super(code); this.code = code; this.status = status; this.details = details; } }

function normalizeWindows(windows) {
    if (!Array.isArray(windows) || windows.length > 100) throw new AdminAvailabilityProblem('validation_failed', 422, { windows: 'invalid_list' });
    const normalized = windows.map((window) => {
        const day = window?.day_of_week; const start = window?.start_time; const end = window?.end_time;
        if (!Number.isInteger(day) || day < 0 || day > 6 || typeof start !== 'string' || typeof end !== 'string' || !/^([01][0-9]|2[0-3]):[0-5][0-9](:00)?$/.test(start) || !/^([01][0-9]|2[0-3]):[0-5][0-9](:00)?$/.test(end) || start.slice(0, 5) >= end.slice(0, 5)) throw new AdminAvailabilityProblem('validation_failed', 422, { windows: 'invalid_time' });
        return { day_of_week: day, start_time: `${start.slice(0, 5)}:00`, end_time: `${end.slice(0, 5)}:00` };
    }).sort((a, b) => a.day_of_week - b.day_of_week || a.start_time.localeCompare(b.start_time));
    for (let i = 1; i < normalized.length; i++) if (normalized[i - 1].day_of_week === normalized[i].day_of_week && normalized[i - 1].end_time > normalized[i].start_time) throw new AdminAvailabilityProblem('validation_failed', 422, { windows: 'overlapping_windows' });
    return normalized;
}

async function loadSchedule(db, tenant, staffId = null) {
    let rows = (await db.query(`SELECT day_of_week,start_time,end_time,is_available FROM availability WHERE tenant_id=$1 AND ${staffId === null ? 'staff_id IS NULL' : 'staff_id=$2'} ORDER BY day_of_week,start_time,id`, staffId === null ? [tenant.id] : [tenant.id, staffId])).rows;
    const inherits = staffId !== null && rows.length === 0;
    if (inherits) rows = (await db.query('SELECT day_of_week,start_time,end_time,is_available FROM availability WHERE tenant_id=$1 AND staff_id IS NULL ORDER BY day_of_week,start_time,id', [tenant.id])).rows;
    const windows = rows.filter((row) => row.is_available).map((row) => ({ day_of_week: Number(row.day_of_week), start_time: String(row.start_time).slice(0, 5), end_time: String(row.end_time).slice(0, 5) }));
    const version = createHash('sha256').update(JSON.stringify([tenant.id, staffId, inherits, rows])).digest('hex');
    return { business_id: tenant.id, staff_id: staffId, timezone: tenant.timezone, inherits_business_schedule: inherits, windows, version };
}

async function transaction(db, callback) {
    const client = await db.connect();
    try { await client.query('BEGIN'); const result = await callback(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
}

async function getTenant(db, tenantId, lock = false) {
    const result = await db.query(`SELECT id,name,timezone,booking_pattern FROM tenants WHERE id=$1 AND status<>'archived'${lock ? ' FOR UPDATE' : ''}`, [tenantId]);
    const tenant = result.rows[0];
    if (!tenant || tenant.booking_pattern !== 'timeslot') throw new AdminAvailabilityProblem('tenant_not_found', 404);
    return tenant;
}

async function audit(client, tenantId, actor, staffId, action, ip) {
    await client.query(`INSERT INTO audit_log (id,tenant_id,actor_type,actor_id,action,entity_type,entity_id,ip_address)
        VALUES ($1,$2,$3,$4,$5,'availability',$6,$7)`, [ulid(), tenantId, actor.type, actor.id, action, staffId || tenantId, ip || null]);
}

export async function getAdminSchedule(db, tenantId, staffId = null) {
    const tenant = await getTenant(db, tenantId);
    if (staffId) {
        const staff = await db.query('SELECT id FROM staff WHERE tenant_id=$1 AND id=$2', [tenantId, staffId]);
        if (!staff.rows.length) throw new AdminAvailabilityProblem('staff_not_found', 404);
    }
    return loadSchedule(db, tenant, staffId);
}

export async function getAdminAvailabilityContext(db, tenantId) {
    const tenant = await getTenant(db, tenantId);
    const [staff, overrides, schedule] = await Promise.all([
        db.query('SELECT id,name,title FROM staff WHERE tenant_id=$1 AND is_active=TRUE ORDER BY sort_order,name,id', [tenantId]),
        db.query('SELECT DISTINCT staff_id FROM availability WHERE tenant_id=$1 AND staff_id IS NOT NULL', [tenantId]),
        loadSchedule(db, tenant, null),
    ]);
    return { tenant, staff: staff.rows, staffOverrides: overrides.rows.map((row) => row.staff_id), schedule };
}

export async function saveAdminSchedule(db, { tenantId, staffId = null, actor, input, ip }) {
    const windows = normalizeWindows(input.windows);
    return transaction(db, async (client) => {
        const tenant = await getTenant(client, tenantId, true);
        if (staffId) {
            const found = await client.query('SELECT id FROM staff WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenantId, staffId]);
            if (!found.rows.length) throw new AdminAvailabilityProblem('staff_not_found', 404);
        }
        const current = await loadSchedule(client, tenant, staffId);
        if (input.expected_version !== current.version) throw new AdminAvailabilityProblem('version_conflict', 409);
        await client.query(`DELETE FROM availability WHERE tenant_id=$1 AND ${staffId ? 'staff_id=$2' : 'staff_id IS NULL'}`, staffId ? [tenantId, staffId] : [tenantId]);
        for (const window of windows) await client.query(`INSERT INTO availability (id,tenant_id,staff_id,day_of_week,start_time,end_time,is_available) VALUES ($1,$2,$3,$4,$5,$6,TRUE)`, [ulid(), tenantId, staffId, window.day_of_week, window.start_time, window.end_time]);
        if (staffId && windows.length === 0) await client.query(`INSERT INTO availability (id,tenant_id,staff_id,day_of_week,start_time,end_time,is_available) VALUES ($1,$2,$3,0,'00:00:00','00:00:00',FALSE)`, [ulid(), tenantId, staffId]);
        await audit(client, tenantId, actor, staffId, staffId ? 'staff_override_set' : 'updated', ip);
        return loadSchedule(client, tenant, staffId);
    });
}

export async function resetAdminStaffSchedule(db, { tenantId, staffId, actor, expectedVersion, ip }) {
    return transaction(db, async (client) => {
        const tenant = await getTenant(client, tenantId, true);
        const found = await client.query('SELECT id FROM staff WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenantId, staffId]);
        if (!found.rows.length) throw new AdminAvailabilityProblem('staff_not_found', 404);
        const current = await loadSchedule(client, tenant, staffId);
        if (expectedVersion !== current.version) throw new AdminAvailabilityProblem('version_conflict', 409);
        await client.query('DELETE FROM availability WHERE tenant_id=$1 AND staff_id=$2', [tenantId, staffId]);
        await audit(client, tenantId, actor, staffId, 'staff_override_reset', ip);
        return loadSchedule(client, tenant, staffId);
    });
}
