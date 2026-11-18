import { createHash, randomBytes } from 'node:crypto';

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid(now = Date.now()) {
    let value = (BigInt(now) << 80n) | BigInt(`0x${randomBytes(10).toString('hex')}`); let result = '';
    for (let i = 0; i < 26; i++) { result = alphabet[Number(value & 31n)] + result; value >>= 5n; }
    return result;
}

export class AdminStaffProblem extends Error {
    constructor(code, status = 400, details = {}) { super(code); this.code = code; this.status = status; this.details = details; }
}

function validate(input, partial = false) {
    const data = {};
    for (const key of ['name', 'email', 'phone', 'title', 'bio', 'service_ids']) if (Object.hasOwn(input || {}, key)) data[key] = input[key];
    if (!partial && (!Object.hasOwn(data, 'name') || !Object.hasOwn(data, 'email'))) throw new AdminStaffProblem('validation_failed', 422, { required: 'name,email' });
    for (const key of ['name', 'email']) if (Object.hasOwn(data, key) && (typeof data[key] !== 'string' || !data[key].trim() || data[key].trim().length > 255)) throw new AdminStaffProblem('validation_failed', 422, { [key]: 'invalid_value' });
    if (Object.hasOwn(data, 'email') && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email.trim())) throw new AdminStaffProblem('validation_failed', 422, { email: 'invalid_email' });
    for (const [key, max] of [['phone', 50], ['title', 255], ['bio', 20000]]) if (Object.hasOwn(data, key) && data[key] !== null && (typeof data[key] !== 'string' || data[key].length > max)) throw new AdminStaffProblem('validation_failed', 422, { [key]: 'invalid_value' });
    if (Object.hasOwn(data, 'service_ids') && (!Array.isArray(data.service_ids) || data.service_ids.length > 1000 || data.service_ids.some((id) => typeof id !== 'string' || !id || id.length > 26) || new Set(data.service_ids).size !== data.service_ids.length)) throw new AdminStaffProblem('validation_failed', 422, { service_ids: 'invalid_list' });
    for (const key of ['name', 'email']) if (Object.hasOwn(data, key)) data[key] = data[key].trim();
    return data;
}

function project(row) {
    const result = { id: row.id, name: row.name, email: row.email, phone: row.phone, title: row.title, bio: row.bio,
        sort_order: Number(row.sort_order), is_active: Boolean(row.is_active), service_ids: row.service_ids || [] };
    result.version = createHash('sha256').update(JSON.stringify(result)).digest('hex'); return result;
}

async function readRecord(db, tenantId, staffId) {
    const { rows } = await db.query(`SELECT s.id,s.name,s.email,s.phone,s.title,s.bio,s.sort_order,s.is_active,
        COALESCE(array_agg(ss.service_id ORDER BY ss.service_id) FILTER (WHERE ss.service_id IS NOT NULL), ARRAY[]::char(26)[]) AS service_ids
        FROM staff s LEFT JOIN service_staff ss ON ss.staff_id=s.id WHERE s.tenant_id=$1 AND s.id=$2 GROUP BY s.id`, [tenantId, staffId]);
    return rows[0] ? project(rows[0]) : null;
}

async function transaction(db, callback) {
    const client = await db.connect();
    try { await client.query('BEGIN'); const result = await callback(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); if (error.code === '23505') throw new AdminStaffProblem('email_already_exists', 409, { email: 'already_exists' }); throw error; }
    finally { client.release(); }
}

async function audit(client, { tenantId, actor, action, staffId, ip }) {
    await client.query(`INSERT INTO audit_log (id,tenant_id,actor_type,actor_id,action,entity_type,entity_id,ip_address)
        VALUES ($1,$2,$3,$4,$5,'staff',$6,$7)`, [ulid(), tenantId, actor.type, actor.id, action, staffId, ip || null]);
}

async function syncServices(client, tenantId, staffId, serviceIds) {
    if (!serviceIds) return;
    if (serviceIds.length) {
        const found = await client.query('SELECT id FROM services WHERE tenant_id=$1 AND id=ANY($2::char(26)[])', [tenantId, serviceIds]);
        if (found.rows.length !== serviceIds.length) throw new AdminStaffProblem('validation_failed', 422, { service_ids: 'unknown_or_foreign_service' });
    }
    await client.query('DELETE FROM service_staff WHERE staff_id=$1', [staffId]);
    for (const serviceId of serviceIds) await client.query('INSERT INTO service_staff (service_id,staff_id) VALUES ($1,$2)', [serviceId, staffId]);
}

export async function listAdminStaff(db, tenantId) {
    const { rows } = await db.query(`SELECT s.id,s.name,s.email,s.phone,s.title,s.bio,s.sort_order,s.is_active,COUNT(ss.service_id)::int AS service_count
        FROM staff s LEFT JOIN service_staff ss ON ss.staff_id=s.id WHERE s.tenant_id=$1 GROUP BY s.id
        ORDER BY s.is_active DESC,s.sort_order,s.name,s.id`, [tenantId]);
    return rows;
}
export async function getAdminStaff(db, tenantId, staffId) { return readRecord(db, tenantId, staffId); }

export async function createAdminStaff(db, { tenantId, actor, input, ip }) {
    const data = validate(input);
    return transaction(db, async (client) => {
        const { rows } = await client.query('SELECT COALESCE(MAX(sort_order),-1)+1 AS next_order FROM staff WHERE tenant_id=$1', [tenantId]);
        const id = ulid();
        await client.query(`INSERT INTO staff (id,tenant_id,name,email,phone,title,bio,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [id, tenantId, data.name, data.email, data.phone ?? null, data.title ?? null, data.bio ?? null, Number(rows[0].next_order)]);
        await syncServices(client, tenantId, id, data.service_ids || []);
        await audit(client, { tenantId, actor, action: 'created', staffId: id, ip });
        return readRecord(client, tenantId, id);
    });
}

export async function updateAdminStaff(db, { tenantId, actor, staffId, input, ip }) {
    return transaction(db, async (client) => {
        const before = await readRecord(client, tenantId, staffId);
        if (!before) throw new AdminStaffProblem('staff_not_found', 404);
        if (input.expected_version !== before.version) throw new AdminStaffProblem('version_conflict', 409);
        const data = validate(input, true);
        if (!Object.keys(data).length) throw new AdminStaffProblem('validation_failed', 422, { body: 'empty' });
        const names = ['name', 'email', 'phone', 'title', 'bio']; const fields = names.filter((key) => Object.hasOwn(data, key));
        if (fields.length) {
            const values = fields.map((key) => data[key]);
            await client.query(`UPDATE staff SET ${fields.map((key, i) => `${key}=$${i + 1}`).join(',')} WHERE tenant_id=$${fields.length + 1} AND id=$${fields.length + 2}`, [...values, tenantId, staffId]);
        }
        await syncServices(client, tenantId, staffId, data.service_ids);
        await audit(client, { tenantId, actor, action: 'updated', staffId, ip });
        return readRecord(client, tenantId, staffId);
    });
}

export async function changeAdminStaffState(db, { tenantId, actor, staffId, input, ip }) {
    return transaction(db, async (client) => {
        const before = await readRecord(client, tenantId, staffId);
        if (!before) throw new AdminStaffProblem('staff_not_found', 404);
        if (input.expected_version !== before.version) throw new AdminStaffProblem('version_conflict', 409);
        if (typeof input.is_active !== 'boolean') throw new AdminStaffProblem('validation_failed', 422, { is_active: 'invalid_type' });
        await client.query('UPDATE staff SET is_active=$1 WHERE tenant_id=$2 AND id=$3', [input.is_active, tenantId, staffId]);
        await audit(client, { tenantId, actor, action: input.is_active ? 'activated' : 'deactivated', staffId, ip });
        return readRecord(client, tenantId, staffId);
    });
}

export async function reorderAdminStaff(db, { tenantId, actor, staffId, input, ip }) {
    return transaction(db, async (client) => {
        const member = await readRecord(client, tenantId, staffId);
        if (!member) throw new AdminStaffProblem('staff_not_found', 404);
        if (input.expected_version !== member.version) throw new AdminStaffProblem('version_conflict', 409);
        if (!['up', 'down'].includes(input.direction)) throw new AdminStaffProblem('validation_failed', 422, { direction: 'invalid_value' });
        const { rows } = await client.query('SELECT id FROM staff WHERE tenant_id=$1 AND is_active=$2 ORDER BY sort_order,name,id FOR UPDATE', [tenantId, member.is_active]);
        const ids = rows.map((row) => row.id); const index = ids.indexOf(staffId); const target = index + (input.direction === 'up' ? -1 : 1);
        if (index >= 0 && target >= 0 && target < ids.length) [ids[index], ids[target]] = [ids[target], ids[index]];
        for (let order = 0; order < ids.length; order++) await client.query('UPDATE staff SET sort_order=$1 WHERE tenant_id=$2 AND id=$3', [order, tenantId, ids[order]]);
        await audit(client, { tenantId, actor, action: 'reordered', staffId, ip });
        return readRecord(client, tenantId, staffId);
    });
}
