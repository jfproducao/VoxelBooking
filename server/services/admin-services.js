import { createHash, randomBytes } from 'node:crypto';

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid(now = Date.now()) {
    let value = (BigInt(now) << 80n) | BigInt(`0x${randomBytes(10).toString('hex')}`);
    let result = '';
    for (let i = 0; i < 26; i++) { result = alphabet[Number(value & 31n)] + result; value >>= 5n; }
    return result;
}

export class AdminServiceProblem extends Error {
    constructor(code, status = 400, details = {}) { super(code); this.code = code; this.status = status; this.details = details; }
}

function project(row) {
    const record = {
        id: row.id, name: row.name, description: row.description, duration_minutes: Number(row.duration_minutes),
        price: row.price === null ? null : String(row.price), price_label: row.price_label, category: row.category,
        color: row.color, sort_order: Number(row.sort_order), is_active: Boolean(row.is_active),
        staff_ids: row.staff_ids || [],
    };
    record.version = createHash('sha256').update(JSON.stringify(record)).digest('hex');
    return record;
}

function validate(input, { partial = false } = {}) {
    const data = {};
    const fields = ['name', 'description', 'duration_minutes', 'price', 'price_label', 'category', 'color', 'staff_ids'];
    for (const key of fields) if (Object.hasOwn(input || {}, key)) data[key] = input[key];
    if (!partial && !Object.hasOwn(data, 'name')) throw new AdminServiceProblem('validation_failed', 422, { name: 'required' });
    if (!partial && !Object.hasOwn(data, 'duration_minutes')) data.duration_minutes = 30;
    if (Object.hasOwn(data, 'name') && (typeof data.name !== 'string' || !data.name.trim() || data.name.trim().length > 255)) throw new AdminServiceProblem('validation_failed', 422, { name: 'invalid_value' });
    if (Object.hasOwn(data, 'description') && data.description !== null && (typeof data.description !== 'string' || data.description.length > 20000)) throw new AdminServiceProblem('validation_failed', 422, { description: 'invalid_value' });
    if (Object.hasOwn(data, 'duration_minutes') && (!Number.isInteger(Number(data.duration_minutes)) || Number(data.duration_minutes) < 1 || Number(data.duration_minutes) > 1440)) throw new AdminServiceProblem('validation_failed', 422, { duration_minutes: 'out_of_range' });
    if (Object.hasOwn(data, 'price') && data.price !== null && (typeof data.price !== 'string' && typeof data.price !== 'number' || !/^[0-9]{1,8}(\.[0-9]{1,2})?$/.test(String(data.price)))) throw new AdminServiceProblem('validation_failed', 422, { price: 'invalid_value' });
    for (const key of ['price_label', 'category']) if (Object.hasOwn(data, key) && data[key] !== null && (typeof data[key] !== 'string' || data[key].length > (key === 'category' ? 100 : 100))) throw new AdminServiceProblem('validation_failed', 422, { [key]: 'invalid_value' });
    if (Object.hasOwn(data, 'color') && data.color !== null && (typeof data.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(data.color))) throw new AdminServiceProblem('validation_failed', 422, { color: 'invalid_value' });
    if (Object.hasOwn(data, 'staff_ids') && (!Array.isArray(data.staff_ids) || data.staff_ids.length > 1000 || data.staff_ids.some((id) => typeof id !== 'string' || !id || id.length > 26) || new Set(data.staff_ids).size !== data.staff_ids.length)) throw new AdminServiceProblem('validation_failed', 422, { staff_ids: 'invalid_list' });
    if (Object.hasOwn(data, 'name')) data.name = data.name.trim();
    if (Object.hasOwn(data, 'duration_minutes')) data.duration_minutes = Number(data.duration_minutes);
    if (Object.hasOwn(data, 'price') && data.price !== null) data.price = Number(data.price).toFixed(2);
    return data;
}

async function readRecord(db, tenantId, serviceId) {
    const result = await db.query(`SELECT s.id,s.name,s.description,s.duration_minutes,s.price,s.price_label,s.category,s.color,s.sort_order,s.is_active,
        COALESCE(array_agg(ss.staff_id ORDER BY ss.staff_id) FILTER (WHERE ss.staff_id IS NOT NULL), ARRAY[]::char(26)[]) AS staff_ids
        FROM services s LEFT JOIN service_staff ss ON ss.service_id=s.id
        WHERE s.tenant_id=$1 AND s.id=$2 GROUP BY s.id`, [tenantId, serviceId]);
    return result.rows[0] ? project(result.rows[0]) : null;
}

async function transaction(db, work) {
    const client = await db.connect();
    try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
}

async function audit(client, { tenantId, actor, action, serviceId, ip }) {
    await client.query(`INSERT INTO audit_log (id,tenant_id,actor_type,actor_id,action,entity_type,entity_id,ip_address)
        VALUES ($1,$2,$3,$4,$5,'service',$6,$7)`, [ulid(), tenantId, actor.type, actor.id, action, serviceId, ip || null]);
}

async function syncStaff(client, tenantId, serviceId, staffIds) {
    if (!staffIds) return;
    if (staffIds.length) {
        const found = await client.query('SELECT id FROM staff WHERE tenant_id=$1 AND id=ANY($2::char(26)[])', [tenantId, staffIds]);
        if (found.rows.length !== staffIds.length) throw new AdminServiceProblem('validation_failed', 422, { staff_ids: 'unknown_or_foreign_staff' });
    }
    await client.query('DELETE FROM service_staff WHERE service_id=$1', [serviceId]);
    for (const staffId of staffIds) await client.query('INSERT INTO service_staff (service_id,staff_id) VALUES ($1,$2)', [serviceId, staffId]);
}

export async function listAdminServices(db, tenantId) {
    const result = await db.query(`SELECT s.id,s.name,s.description,s.duration_minutes,s.price,s.price_label,s.category,s.color,s.sort_order,s.is_active,
        COUNT(ss.staff_id)::int AS staff_count
        FROM services s LEFT JOIN service_staff ss ON ss.service_id=s.id
        WHERE s.tenant_id=$1 GROUP BY s.id ORDER BY s.is_active DESC,s.sort_order,s.name,s.id`, [tenantId]);
    return result.rows;
}

export async function getAdminService(db, tenantId, serviceId) { return readRecord(db, tenantId, serviceId); }

export async function createAdminService(db, { tenantId, actor, input, ip }) {
    const data = validate(input);
    return transaction(db, async (client) => {
        const { rows } = await client.query('SELECT COALESCE(MAX(sort_order),-1)+1 AS next_order FROM services WHERE tenant_id=$1', [tenantId]);
        const id = ulid();
        await client.query(`INSERT INTO services (id,tenant_id,name,description,duration_minutes,price,price_label,category,color,sort_order)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, tenantId, data.name, data.description ?? null, data.duration_minutes, data.price ?? null, data.price_label ?? null, data.category ?? null, data.color ?? null, Number(rows[0].next_order)]);
        await syncStaff(client, tenantId, id, data.staff_ids || []);
        await audit(client, { tenantId, actor, action: 'created', serviceId: id, ip });
        return readRecord(client, tenantId, id);
    });
}

export async function updateAdminService(db, { tenantId, actor, serviceId, input, ip }) {
    return transaction(db, async (client) => {
        const before = await readRecord(client, tenantId, serviceId);
        if (!before) throw new AdminServiceProblem('service_not_found', 404);
        if (input.expected_version !== before.version) throw new AdminServiceProblem('version_conflict', 409);
        const data = validate(input, { partial: true });
        if (!Object.keys(data).length) throw new AdminServiceProblem('validation_failed', 422, { body: 'empty' });
        const names = { name: 'name', description: 'description', duration_minutes: 'duration_minutes', price: 'price', price_label: 'price_label', category: 'category', color: 'color' };
        const fields = Object.keys(data).filter((key) => names[key]);
        if (fields.length) {
            const values = fields.map((key) => data[key]);
            await client.query(`UPDATE services SET ${fields.map((key, i) => `${names[key]}=$${i + 1}`).join(',')} WHERE tenant_id=$${fields.length + 1} AND id=$${fields.length + 2}`, [...values, tenantId, serviceId]);
        }
        await syncStaff(client, tenantId, serviceId, data.staff_ids);
        await audit(client, { tenantId, actor, action: 'updated', serviceId, ip });
        return readRecord(client, tenantId, serviceId);
    });
}

export async function changeAdminServiceState(db, { tenantId, actor, serviceId, input, ip }) {
    return transaction(db, async (client) => {
        const before = await readRecord(client, tenantId, serviceId);
        if (!before) throw new AdminServiceProblem('service_not_found', 404);
        if (input.expected_version !== before.version) throw new AdminServiceProblem('version_conflict', 409);
        if (typeof input.is_active !== 'boolean') throw new AdminServiceProblem('validation_failed', 422, { is_active: 'invalid_type' });
        await client.query('UPDATE services SET is_active=$1 WHERE tenant_id=$2 AND id=$3', [input.is_active, tenantId, serviceId]);
        await audit(client, { tenantId, actor, action: input.is_active ? 'activated' : 'deactivated', serviceId, ip });
        return readRecord(client, tenantId, serviceId);
    });
}

export async function reorderAdminService(db, { tenantId, actor, serviceId, input, ip }) {
    return transaction(db, async (client) => {
        const record = await readRecord(client, tenantId, serviceId);
        if (!record) throw new AdminServiceProblem('service_not_found', 404);
        if (input.expected_version !== record.version) throw new AdminServiceProblem('version_conflict', 409);
        if (!['up', 'down'].includes(input.direction)) throw new AdminServiceProblem('validation_failed', 422, { direction: 'invalid_value' });
        const { rows } = await client.query('SELECT id FROM services WHERE tenant_id=$1 AND is_active=$2 ORDER BY sort_order,name,id FOR UPDATE', [tenantId, record.is_active]);
        const ids = rows.map((row) => row.id); const index = ids.indexOf(serviceId); const target = index + (input.direction === 'up' ? -1 : 1);
        if (index >= 0 && target >= 0 && target < ids.length) [ids[index], ids[target]] = [ids[target], ids[index]];
        for (let order = 0; order < ids.length; order++) await client.query('UPDATE services SET sort_order=$1 WHERE tenant_id=$2 AND id=$3', [order, tenantId, ids[order]]);
        await audit(client, { tenantId, actor, action: 'reordered', serviceId, ip });
        return readRecord(client, tenantId, serviceId);
    });
}
