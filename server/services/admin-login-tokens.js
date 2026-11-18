import { createHash, randomBytes } from 'node:crypto';
import nodemailer from 'nodemailer';

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid(now = Date.now()) {
    let value = (BigInt(now) << 80n) | BigInt(`0x${randomBytes(10).toString('hex')}`);
    let result = '';
    for (let index = 0; index < 26; index++) { result = alphabet[Number(value & 31n)] + result; value >>= 5n; }
    return result;
}
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const emailAddress = (value) => String(value || '').trim().toLowerCase();
const sqlTime = (date) => date.toISOString().slice(0, 19).replace('T', ' ');

async function withEmailLock(db, email, callback) {
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext('login_token_email'))", [email]);
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve the original failure. */ }
        throw error;
    } finally { client.release(); }
}

export async function issueLoginToken(db, emailInput, type, ip, rememberMe = false) {
    const email = emailAddress(emailInput);
    if (!email || email.length > 255 || !['otp', 'magic_link', 'password_reset'].includes(type)) return { error: 'invalid_request' };
    return withEmailLock(db, email, async (client) => {
        const flood = await client.query(
            "SELECT COUNT(*)::int AS count FROM login_tokens WHERE email=$1 AND created_at>NOW()-INTERVAL '15 minutes'", [email],
        );
        if (Number(flood.rows[0]?.count || 0) >= 5) return { error: 'rate_limited' };
        if (type === 'otp') {
            const active = await client.query(
                "SELECT COUNT(*)::int AS count FROM login_tokens WHERE email=$1 AND type='otp' AND expires_at>NOW() AND used_at IS NULL", [email],
            );
            if (Number(active.rows[0]?.count || 0) >= 3) return { error: 'rate_limited' };
        }
        if (type === 'magic_link') await client.query("UPDATE login_tokens SET used_at=NOW() WHERE email=$1 AND type='magic_link' AND used_at IS NULL", [email]);
        const token = type === 'otp' ? String(randomBytes(4).readUInt32BE(0) % 900000 + 100000) : randomBytes(32).toString('hex');
        const id = ulid();
        const minutes = type === 'otp' ? 10 : type === 'magic_link' ? 15 : 60;
        await client.query(
            `INSERT INTO login_tokens (id,email,type,token_hash,remember_me,expires_at,ip_address)
             VALUES ($1,$2,$3,$4,$5,NOW()+($6::text||' minutes')::interval,$7)`,
            [id, email, type, sha256(token), type === 'magic_link' && rememberMe, minutes, String(ip || '').slice(0, 45) || null],
        );
        return { id, email, token };
    });
}

export async function consumeLoginToken(db, tokenInput, type, emailInput = null) {
    const token = String(tokenInput || '');
    if (!token || token.length > 128) return null;
    const email = emailInput === null ? null : emailAddress(emailInput);
    const result = await db.query(
        `UPDATE login_tokens SET used_at=NOW()
         WHERE id=(SELECT id FROM login_tokens WHERE type=$1 AND token_hash=$2 AND expires_at>NOW() AND used_at IS NULL
           AND ($3::varchar IS NULL OR email=$3) ORDER BY created_at DESC LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING id,email,remember_me`, [type, sha256(token), email],
    );
    return result.rows[0] || null;
}

export async function passwordResetUrlIsValid(db, tokenInput) {
    const token = String(tokenInput || '');
    if (!/^[a-f0-9]{64}$/.test(token)) return false;
    const result = await db.query(
        "SELECT 1 FROM login_tokens WHERE type='password_reset' AND token_hash=$1 AND expires_at>NOW() AND used_at IS NULL LIMIT 1", [sha256(token)],
    );
    return Boolean(result.rows[0]);
}

async function mailSettings(db) {
    const { rows } = await db.query('SELECT "key",value FROM settings WHERE "key"=ANY($1::text[])', [[
        'mail_transport', 'smtp_host', 'smtp_port', 'smtp_username', 'smtp_encryption', 'smtp_password', 'mail_from_address', 'mail_from_name',
    ]]);
    const value = (key, env, fallback = '') => rows.find((row) => row.key === key)?.value ?? process.env[env] ?? fallback;
    return { transport: value('mail_transport', 'MAIL_TRANSPORT', 'smtp').toLowerCase(), host: value('smtp_host', 'MAIL_HOST'),
        port: Number(value('smtp_port', 'MAIL_PORT', '587')) || 587, username: value('smtp_username', 'MAIL_USERNAME'),
        encryption: value('smtp_encryption', 'MAIL_ENCRYPTION', 'tls'), password: value('smtp_password', 'MAIL_PASSWORD') || process.env.RESEND_API_KEY || '',
        from: value('mail_from_address', 'MAIL_FROM_ADDRESS'), fromName: value('mail_from_name', 'MAIL_FROM_NAME', 'VoxelBooking') };
}

export async function sendAdminAuthEmail(db, { to, type, token, appUrl }) {
    const settings = await mailSettings(db);
    const base = String(appUrl || process.env.APP_URL || '').replace(/\/$/, '');
    if (!base) return { sent: false, error: 'app_url_missing' };
    let parsed;
    try { parsed = new URL(base); } catch { return { sent: false, error: 'app_url_invalid' }; }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return { sent: false, error: 'app_url_invalid' };
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))) return { sent: false, error: 'app_url_invalid' };
    const route = type === 'otp' ? '/admin/login/verify-code' : type === 'magic_link' ? '/admin/login/verify' : '/admin/reset-password';
    const link = `${base}${route}?token=${encodeURIComponent(token)}`;
    const subject = type === 'otp' ? 'Seu código de acesso · VoxelBooking' : type === 'magic_link' ? 'Seu link de acesso · VoxelBooking' : 'Redefinir senha · VoxelBooking';
    const content = type === 'otp' ? `<p>Use este código para entrar no VoxelBooking:</p><p style="font-size:32px;font-weight:700;letter-spacing:.2em">${token}</p><p>O código expira em 10 minutos.</p>`
        : type === 'magic_link' ? `<p>Entre na sua conta pelo link abaixo. Ele expira em 15 minutos e só pode ser usado uma vez.</p><p><a href="${link}">Acessar VoxelBooking</a></p>`
            : `<p>Redefina sua senha pelo link abaixo. Ele expira em 60 minutos e só pode ser usado uma vez.</p><p><a href="${link}">Redefinir senha</a></p>`;
    try {
        let sent = true;
        if (settings.transport === 'log') sent = false;
        else if (settings.transport === 'resend') {
            if (!settings.password || !settings.from) throw new Error('mail_not_configured');
            const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${settings.password}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ from: `${settings.fromName} <${settings.from}>`, to: [to], subject, html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto">${content}<hr><small>VoxelBooking</small></div>`, text: `${subject}\n\n${type === 'otp' ? token : link}` }), signal: AbortSignal.timeout(10000) });
            if (!response.ok) throw new Error(`mail_provider_${response.status}`);
        } else {
            if (!['smtp', 'mailpit'].includes(settings.transport)) throw new Error('mail_transport_invalid');
            const host = settings.transport === 'mailpit' ? '127.0.0.1' : settings.host;
            if (!host || !settings.from) throw new Error('mail_not_configured');
            const transporter = nodemailer.createTransport({ host, port: settings.transport === 'mailpit' ? 1025 : settings.port,
                secure: settings.transport !== 'mailpit' && (settings.encryption === 'ssl' || settings.port === 465), ignoreTLS: settings.encryption === 'none',
                auth: settings.username ? { user: settings.username, pass: settings.password } : undefined, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 10000 });
            await transporter.sendMail({ from: { address: settings.from, name: settings.fromName }, to, subject,
                html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto">${content}<hr><small>VoxelBooking</small></div>`,
                text: `${subject}\n\n${type === 'otp' ? token : link}` });
        }
        await db.query('INSERT INTO email_log (id,type,to_email,subject,status,error,sent_at) VALUES ($1,$2,$3,$4,$5,NULL,NOW())',
            [ulid(), type === 'otp' ? 'login_code' : type, to, subject, 'sent']).catch(() => {});
        return { sent };
    } catch (error) {
        await db.query('INSERT INTO email_log (id,type,to_email,subject,status,error,sent_at) VALUES ($1,$2,$3,$4,\'failed\',$5,NOW())',
            [ulid(), type === 'otp' ? 'login_code' : type, to, subject, String(error?.message || 'delivery_failed').slice(0, 500)]).catch(() => {});
        return { sent: false, error: 'delivery_failed' };
    }
}
