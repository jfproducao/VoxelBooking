import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';

const COOKIE = 'vb_session';
const SESSION_TTL = 30 * 24 * 60 * 60;
const INACTIVITY_TTL = 8 * 60 * 60;

function sessionId(request) {
    let selected = null;
    for (const part of String(request.headers.cookie || '').split(';')) {
        const separator = part.indexOf('=');
        if (separator < 0 || part.slice(0, separator).trim() !== COOKIE) continue;
        try {
            const value = decodeURIComponent(part.slice(separator + 1).trim());
            if (/^[a-f0-9]{64}$/.test(value)) selected = value;
        } catch { /* Ignore malformed duplicate cookies. */ }
    }
    return selected;
}

function digest(id) { return createHash('sha256').update(id).digest('hex'); }
function timestamp(value) { return new Date(value).toISOString().slice(0, 19).replace('T', ' '); }
function csrf() { return randomBytes(32).toString('hex'); }
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid(now = Date.now()) {
    let value = (BigInt(now) << 80n) | BigInt(`0x${randomBytes(10).toString('hex')}`);
    let result = '';
    for (let index = 0; index < 26; index++) { result = alphabet[Number(value & 31n)] + result; value >>= 5n; }
    return result;
}

async function auditAuth(db, action, actorType, actorId = null, details = {}, ip = null) {
    try {
        await db.query(
            `INSERT INTO audit_log (id,actor_type,actor_id,action,entity_type,entity_id,details,ip_address)
             VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
            [ulid(), actorType === 'system' ? 'system' : actorType, actorId, action,
                actorType === 'system' ? 'auth' : actorType, actorId, JSON.stringify(details), ip],
        );
    } catch { /* Authentication remains available if optional audit storage is temporarily unavailable. */ }
}

function setCookie(reply, id, maxAge = SESSION_TTL) {
    const secure = process.env.NODE_ENV === 'production' || process.env.FORCE_HTTPS !== 'false' ? '; Secure' : '';
    reply.header('Set-Cookie', `${COOKIE}=${id}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`);
}

function clearCookie(reply) {
    const secure = process.env.NODE_ENV === 'production' || process.env.FORCE_HTTPS !== 'false' ? '; Secure' : '';
    reply.header('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`);
}

async function removeSession(db, idHash) {
    await db.query('DELETE FROM admin_sessions WHERE id_hash=$1', [idHash]);
}

export async function loadAdminSession(db, request, reply) {
    const id = sessionId(request);
    if (!id) return null;
    const idHash = digest(id);
    const { rows } = await db.query('SELECT id_hash,data,last_activity,expires_at FROM admin_sessions WHERE id_hash=$1 LIMIT 1', [idHash]);
    const row = rows[0];
    if (!row) { clearCookie(reply); return null; }
    const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    const now = Date.now();
    const lastActivity = Date.parse(`${String(row.last_activity).slice(0, 19).replace(' ', 'T')}Z`);
    const expiresAt = Date.parse(`${String(row.expires_at).slice(0, 19).replace(' ', 'T')}Z`);
    if (expiresAt <= now || (data.auth_type && !data.remember_me && now - lastActivity > INACTIVITY_TTL)) {
        await removeSession(db, idHash); clearCookie(reply); return null;
    }

    let user = null;
    if (data.auth_type === 'operator') {
        const found = await db.query('SELECT id,name,email FROM operators WHERE id=$1 LIMIT 1', [data.auth_id]);
        if (found.rows[0]) user = { type: 'operator', ...found.rows[0] };
    } else if (data.auth_type === 'business_user') {
        const found = await db.query(
            `SELECT bu.id,bu.name,bu.email,bu.tenant_id,bu.role,bu.force_password_change,t.status AS tenant_status
             FROM business_users bu JOIN tenants t ON t.id=bu.tenant_id
             WHERE bu.id=$1 AND bu.is_active=TRUE LIMIT 1`, [data.auth_id],
        );
        if (found.rows[0] && found.rows[0].tenant_status !== 'archived') {
            user = { type: 'business_user', ...found.rows[0] };
            data.force_password_change = Boolean(user.force_password_change);
        }
    }
    if (data.auth_type && !user) { await removeSession(db, idHash); clearCookie(reply); return null; }

    const nowText = timestamp(new Date(now).toISOString());
    await db.query('UPDATE admin_sessions SET last_activity=$1::timestamp,expires_at=$2::timestamp WHERE id_hash=$3',
        [nowText, timestamp(new Date(now + SESSION_TTL * 1000).toISOString()), idHash]);
    const session = { id, idHash, data, user };
    request.adminSession = session;
    return session;
}

export async function ensureAdminSession(db, request, reply) {
    if (request.adminSession) return request.adminSession;
    const session = { id: randomBytes(32).toString('hex'), data: { csrf_token: csrf() }, user: null };
    session.idHash = digest(session.id);
    const now = timestamp(new Date().toISOString());
    const expires = timestamp(new Date(Date.now() + SESSION_TTL * 1000).toISOString());
    await db.query(
        'INSERT INTO admin_sessions (id_hash,data,created_at,last_activity,expires_at) VALUES ($1,$2::jsonb,$3::timestamp,$3::timestamp,$4::timestamp)',
        [session.idHash, JSON.stringify(session.data), now, expires],
    );
    request.adminSession = session;
    setCookie(reply, session.id);
    return session;
}

export function verifyCsrf(session, submitted) {
    if (!session?.data?.csrf_token || typeof submitted !== 'string' || !/^[a-f0-9]{64}$/.test(submitted)) return false;
    const expected = Buffer.from(session.data.csrf_token, 'hex');
    const actual = Buffer.from(submitted, 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function authenticatePassword(db, emailInput, password) {
    const email = String(emailInput || '').trim().toLowerCase();
    if (email.length > 255 || !email || typeof password !== 'string' || !password || password.length > 4096) return null;
    const operator = await db.query('SELECT id,name,email,password_hash FROM operators WHERE lower(email)=$1 LIMIT 1', [email]);
    const verify = async (row) => {
        if (!row) return false;
        const hash = String(row.password_hash || '').replace(/^\$2y\$/, '$2b$');
        try { return await bcrypt.compare(password, hash); }
        catch { return false; }
    };
    const operatorRow = operator.rows[0];
    if (operatorRow && await verify(operatorRow)) {
        return { type: 'operator', id: operatorRow.id, name: operatorRow.name, email: operatorRow.email };
    }
    const businessUser = await db.query(
        `SELECT id,name,email,password_hash,tenant_id,role,force_password_change
         FROM business_users WHERE lower(email)=$1 AND is_active=TRUE LIMIT 1`, [email],
    );
    const row = businessUser.rows[0];
    if (row && await verify(row)) return { type: 'business_user', id: row.id, name: row.name, email: row.email,
        tenant_id: row.tenant_id, role: row.role, force_password_change: Boolean(row.force_password_change) };
    return null;
}

async function recordLoginAttempt(db, ip) {
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext('auth_login'))", [ip]);
        const { rows } = await client.query(
            "SELECT COUNT(*)::int AS count FROM rate_limits WHERE ip=$1 AND endpoint_group='auth_login' AND created_at>NOW()-INTERVAL '15 minutes'", [ip],
        );
        if (Number(rows[0]?.count || 0) >= 10) { await client.query('ROLLBACK'); return false; }
        await client.query("INSERT INTO rate_limits (ip,endpoint_group,created_at) VALUES ($1,'auth_login',NOW())", [ip]);
        await client.query('COMMIT');
        return true;
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve the rate-limit failure. */ }
        throw error;
    } finally { client.release(); }
}

export async function recordAuthRateLimit(db, ip, group, maximum) {
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [ip, group]);
        const { rows } = await client.query('SELECT COUNT(*)::int AS count FROM rate_limits WHERE ip=$1 AND endpoint_group=$2 AND created_at>NOW()-INTERVAL \'15 minutes\'', [ip, group]);
        if (Number(rows[0]?.count || 0) >= maximum) { await client.query('ROLLBACK'); return false; }
        await client.query('INSERT INTO rate_limits (ip,endpoint_group,created_at) VALUES ($1,$2,NOW())', [ip, group]);
        await client.query('COMMIT'); return true;
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve original error. */ }
        throw error;
    } finally { client.release(); }
}

export async function loginWithPassword(db, request, reply, email, password, rememberMe = false) {
    if (!await recordLoginAttempt(db, request.ip)) return { error: 'rate_limited' };
    const user = await authenticatePassword(db, email, password);
    if (!user) {
        await auditAuth(db, 'auth.login_failed', 'system', null, {
            email_prefix: createHash('sha256').update(String(email || '').trim().toLowerCase()).digest('hex').slice(0, 8),
            reason: 'Invalid credentials',
        }, request.ip);
        return { error: 'invalid_credentials' };
    }
    const existing = request.adminSession;
    const data = {
        csrf_token: existing?.data?.csrf_token || csrf(),
        auth_type: user.type, auth_id: user.id, auth_name: user.name, auth_email: user.email,
        remember_me: Boolean(rememberMe), force_password_change: Boolean(user.force_password_change),
        ...(user.tenant_id ? { auth_tenant_id: user.tenant_id, auth_role: user.role } : {}),
    };
    const id = randomBytes(32).toString('hex');
    const idHash = digest(id);
    const now = timestamp(new Date().toISOString());
    const expires = timestamp(new Date(Date.now() + SESSION_TTL * 1000).toISOString());
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            'INSERT INTO admin_sessions (id_hash,data,created_at,last_activity,expires_at) VALUES ($1,$2::jsonb,$3::timestamp,$3::timestamp,$4::timestamp)',
            [idHash, JSON.stringify(data), now, expires],
        );
        if (existing) await client.query('DELETE FROM admin_sessions WHERE id_hash=$1', [existing.idHash]);
        if (user.type === 'operator') await client.query('UPDATE operators SET updated_at=NOW() WHERE id=$1', [user.id]);
        else await client.query('UPDATE business_users SET last_login_at=NOW() WHERE id=$1', [user.id]);
        await client.query('COMMIT');
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve login persistence failure. */ }
        throw error;
    } finally { client.release(); }
    await auditAuth(db, 'auth.login', user.type, user.id, {
        email_prefix: createHash('sha256').update(user.email.toLowerCase()).digest('hex').slice(0, 8),
    }, request.ip);
    const session = { id, idHash, data, user };
    request.adminSession = session;
    setCookie(reply, id);
    return { user, redirect: data.force_password_change ? '/admin/password' : user.type === 'business_user' ? `/admin/tenants/${encodeURIComponent(user.tenant_id)}` : '/admin' };
}

export async function loginWithEmail(db, request, reply, emailInput, rememberMe = false) {
    const email = String(emailInput || '').trim().toLowerCase();
    const { rows } = await db.query('SELECT user_type,user_id FROM auth_emails WHERE lower(email)=$1 LIMIT 1', [email]);
    const registered = rows[0];
    let user = null;
    if (registered?.user_type === 'operator') {
        const found = await db.query('SELECT id,name,email FROM operators WHERE id=$1 LIMIT 1', [registered.user_id]);
        if (found.rows[0]) user = { type: 'operator', ...found.rows[0] };
    } else if (registered?.user_type === 'business_user') {
        const found = await db.query(
            `SELECT bu.id,bu.name,bu.email,bu.tenant_id,bu.role,bu.force_password_change
             FROM business_users bu JOIN tenants t ON t.id=bu.tenant_id
             WHERE bu.id=$1 AND bu.is_active=TRUE AND t.status<>'archived' LIMIT 1`, [registered.user_id],
        );
        if (found.rows[0]) user = { type: 'business_user', ...found.rows[0], force_password_change: Boolean(found.rows[0].force_password_change) };
    }
    if (!user) return { error: 'invalid_credentials' };
    const existing = request.adminSession;
    const data = { csrf_token: existing?.data?.csrf_token || csrf(), auth_type: user.type, auth_id: user.id,
        auth_name: user.name, auth_email: user.email, remember_me: Boolean(rememberMe),
        force_password_change: Boolean(user.force_password_change),
        ...(user.tenant_id ? { auth_tenant_id: user.tenant_id, auth_role: user.role } : {}) };
    const id = randomBytes(32).toString('hex'); const idHash = digest(id);
    const now = timestamp(new Date().toISOString()); const expires = timestamp(new Date(Date.now() + SESSION_TTL * 1000).toISOString());
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        await client.query('INSERT INTO admin_sessions (id_hash,data,created_at,last_activity,expires_at) VALUES ($1,$2::jsonb,$3::timestamp,$3::timestamp,$4::timestamp)',
            [idHash, JSON.stringify(data), now, expires]);
        if (existing) await client.query('DELETE FROM admin_sessions WHERE id_hash=$1', [existing.idHash]);
        if (user.type === 'operator') await client.query('UPDATE operators SET updated_at=NOW() WHERE id=$1', [user.id]);
        else await client.query('UPDATE business_users SET last_login_at=NOW() WHERE id=$1', [user.id]);
        await client.query('COMMIT');
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve original error. */ }
        throw error;
    } finally { client.release(); }
    await auditAuth(db, 'auth.login', user.type, user.id, { method: 'passwordless' }, request.ip);
    const session = { id, idHash, data, user }; request.adminSession = session; setCookie(reply, id);
    return { user, redirect: data.force_password_change ? '/admin/password' : user.type === 'business_user' ? `/admin/tenants/${encodeURIComponent(user.tenant_id)}` : '/admin' };
}

export async function setPasswordFromReset(db, tokenInput, newPassword) {
    if (typeof tokenInput !== 'string' || !/^[a-f0-9]{64}$/.test(tokenInput) || typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 4096) return false;
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const consumed = await client.query("UPDATE login_tokens SET used_at=NOW() WHERE type='password_reset' AND token_hash=$1 AND used_at IS NULL AND expires_at>NOW() RETURNING email", [createHash('sha256').update(tokenInput).digest('hex')]);
        const auth = consumed.rows[0] && await client.query('SELECT user_type,user_id FROM auth_emails WHERE email=$1 LIMIT 1', [consumed.rows[0].email]);
        if (!auth?.rows[0]) { await client.query('ROLLBACK'); return false; }
        const { user_type: type, user_id: id } = auth.rows[0];
        if (!['operator', 'business_user'].includes(type)) { await client.query('ROLLBACK'); return false; }
        const table = type === 'operator' ? 'operators' : 'business_users';
        const hash = await bcrypt.hash(newPassword, 12);
        const updated = await client.query(`UPDATE ${table} SET password_hash=$1${type === 'business_user' ? ',force_password_change=FALSE' : ''},updated_at=NOW() WHERE id=$2`, [hash, id]);
        if (!updated.rowCount) { await client.query('ROLLBACK'); return false; }
        await client.query("UPDATE login_tokens SET used_at=NOW() WHERE email=$1 AND type='password_reset' AND used_at IS NULL", [consumed.rows[0].email]);
        await client.query("DELETE FROM admin_sessions WHERE data->>'auth_type'=$1 AND data->>'auth_id'=$2", [type, id]);
        await client.query('COMMIT');
        await auditAuth(db, 'auth.password_reset', type, id);
        return true;
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* Keep original error. */ }
        throw error;
    } finally { client.release(); }
}

export async function updateAdminPassword(db, session, currentPassword, newPassword) {
    if (!session?.user || typeof currentPassword !== 'string' || typeof newPassword !== 'string'
        || newPassword.length < 8 || newPassword.length > 4096) return false;
    const user = session.user;
    const table = user.type === 'operator' ? 'operators' : 'business_users';
    const found = await db.query(`SELECT password_hash FROM ${table} WHERE id=$1 LIMIT 1`, [user.id]);
    if (!found.rows[0]) return false;
    const existingHash = String(found.rows[0].password_hash).replace(/^\$2y\$/, '$2b$');
    try { if (!await bcrypt.compare(currentPassword, existingHash)) return false; }
    catch { return false; }
    const newHash = await bcrypt.hash(newPassword, 12);
    if (user.type === 'operator') await db.query('UPDATE operators SET password_hash=$1,updated_at=NOW() WHERE id=$2', [newHash, user.id]);
    else await db.query('UPDATE business_users SET password_hash=$1,force_password_change=FALSE,updated_at=NOW() WHERE id=$2', [newHash, user.id]);
    session.data.force_password_change = false;
    await db.query('UPDATE admin_sessions SET data=$1::jsonb WHERE id_hash=$2', [JSON.stringify(session.data), session.idHash]);
    await auditAuth(db, 'auth.password_changed', user.type, user.id);
    return true;
}

export async function logoutAdmin(db, session, reply) {
    if (session?.user) await auditAuth(db, 'auth.logout', session.user.type, session.user.id);
    if (session?.idHash) await removeSession(db, session.idHash);
    clearCookie(reply);
}
