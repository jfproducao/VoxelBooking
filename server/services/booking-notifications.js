import { createHash, randomBytes } from 'node:crypto';
import nodemailer from 'nodemailer';
import { wallDateTimeToUtc } from '../time/venue-time.js';

const TOPIC = 'booking.notification.node';
const REMINDER_TOPIC = 'booking.reminder.node';
const MAX_ATTEMPTS = 8;
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function ulid(now = Date.now()) {
    let value = (BigInt(now) << 80n) | BigInt(`0x${randomBytes(10).toString('hex')}`);
    let result = '';
    for (let index = 0; index < 26; index++) { result = alphabet[Number(value & 31n)] + result; value >>= 5n; }
    return result;
}

function sqlDateTime(iso) { return iso.slice(0, 19).replace('T', ' '); }

function audienceFor(kind, staffEnabled) {
    return kind === 'created' ? ['customer', ...(staffEnabled ? ['staff'] : [])]
        : kind === 'cancellation' ? ['customer', ...(staffEnabled ? ['staff'] : [])]
            : kind === 'rescheduled' ? ['customer', ...(staffEnabled ? ['staff'] : [])] : ['customer'];
}

export async function queueBookingNotifications(client, tenant, bookingId, kind, { originalBookingId = null, now = Date.now() } = {}) {
    const booking = await client.query(
        'SELECT status FROM bookings WHERE id=$1 AND tenant_id=$2 LIMIT 1', [bookingId, tenant.id],
    );
    if (!booking.rows[0]) return { ids: [], customerQueued: false };
    const setting = kind === 'cancellation' ? 'notify_on_cancellation' : 'notify_on_booking';
    const audiences = audienceFor(kind, Boolean(tenant[setting]));
    const event = ulid(now);
    const ids = [];
    let customerQueued = false;
    for (const audience of audiences) {
        const id = ulid(now);
        const dedupe = createHash('sha256').update(`${TOPIC}\0${tenant.id}\0${event}:${audience}`).digest('hex');
        const payload = JSON.stringify({
            booking_id: bookingId, tenant_id: tenant.id, kind, audience,
            original_booking_id: originalBookingId, expected_status: booking.rows[0].status,
        });
        await client.query(
            `INSERT INTO delivery_outbox
             (id,topic,tenant_id,dedupe_hash,payload_cipher,status,attempts,available_at,created_at)
             VALUES ($1,$2,$3,$4,$5,'pending',0,$6::timestamp,$6::timestamp)
             ON CONFLICT (dedupe_hash) DO NOTHING`,
            [id, TOPIC, tenant.id, dedupe, payload, sqlDateTime(new Date(now).toISOString())],
        );
        const stored = await client.query('SELECT id FROM delivery_outbox WHERE dedupe_hash=$1', [dedupe]);
        if (stored.rows[0]) ids.push({ id: stored.rows[0].id, audience });
        if (audience === 'customer') customerQueued = true;
    }
    return { ids, customerQueued };
}

function settingValue(rows, key, envKey, fallback = '') {
    return rows.find((row) => row.key === key)?.value ?? process.env[envKey] ?? fallback;
}

async function mailSettings(db) {
    const { rows } = await db.query('SELECT "key",value FROM settings WHERE "key" = ANY($1::text[])', [[
        'mail_transport', 'smtp_host', 'smtp_port', 'smtp_username', 'smtp_encryption',
        'smtp_password', 'mail_from_address', 'mail_from_name',
    ]]);
    return {
        transport: settingValue(rows, 'mail_transport', 'MAIL_TRANSPORT', 'smtp').toLowerCase(),
        host: settingValue(rows, 'smtp_host', 'MAIL_HOST'),
        port: Number(settingValue(rows, 'smtp_port', 'MAIL_PORT', '587')) || 587,
        username: settingValue(rows, 'smtp_username', 'MAIL_USERNAME'),
        encryption: settingValue(rows, 'smtp_encryption', 'MAIL_ENCRYPTION', 'tls'),
        password: settingValue(rows, 'smtp_password', 'MAIL_PASSWORD'),
        from: settingValue(rows, 'mail_from_address', 'MAIL_FROM_ADDRESS'),
        fromName: settingValue(rows, 'mail_from_name', 'MAIL_FROM_NAME', 'VoxelBooking'),
    };
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
}

function localDateLabel(date, locale) {
    const instant = new Date(`${date}T12:00:00Z`);
    return new Intl.DateTimeFormat(locale || 'en', { dateStyle: 'long', timeZone: 'UTC' }).format(instant);
}

function placeholders(booking, tenant, manageUrl) {
    const start = String(booking.start_datetime).slice(0, 19);
    const end = String(booking.end_datetime).slice(0, 19);
    const locale = tenant.locale || 'en';
    let total = '';
    if (booking.price_total !== null) {
        try { total = new Intl.NumberFormat(locale, { style: 'currency', currency: booking.price_currency || tenant.currency }).format(Number(booking.price_total)); }
        catch { total = `${booking.price_total} ${booking.price_currency || tenant.currency}`; }
    }
    const values = {
        customer_name: booking.customer_name || '', service_name: booking.service_name || booking.event_name || booking.resource_name || '',
        booking_date: localDateLabel(start.slice(0, 10), locale), booking_time: start.slice(11, 16),
        booking_end_time: end.slice(11, 16), staff_name: booking.staff_name || '', business_name: tenant.name,
        booking_url: manageUrl, booking_id: booking.id, duration: String(booking.duration_minutes ?? ''),
        booking_total: total, booking_party_size: String(booking.party_size),
        check_in: localDateLabel(start.slice(0, 10), locale), check_out: localDateLabel(end.slice(0, 10), locale),
    };
    return values;
}

function renderTemplate(template, values, fallback) {
    const source = template || fallback;
    return source.replace(/\{([a-z_]+)\}/gi, (_match, key) => values[key.toLowerCase()] ?? '');
}

function mailCopy(kind, audience, status, values, custom) {
    const staff = audience === 'staff';
    const scenario = kind === 'reminder' ? 'Booking reminder' : staff
        ? kind === 'cancellation' ? 'Booking cancelled' : kind === 'rescheduled' ? 'Booking rescheduled' : 'New booking'
        : kind === 'cancellation' ? 'Booking cancelled'
            : kind === 'rescheduled' ? 'Booking rescheduled'
                : status === 'waitlisted' ? 'You are on the waitlist'
                    : status === 'pending' ? 'Booking request received' : 'Booking confirmed';
    const templateType = kind === 'reminder' ? 'reminder'
        : kind === 'cancellation' ? 'cancellation'
        : kind === 'rescheduled' ? 'reschedule_confirmation'
            : status === 'waitlisted' ? 'waitlist'
                : status === 'pending' ? 'approval_request' : 'confirmation';
    const subjectFallback = staff
        ? `${scenario}: ${values.service_name || values.business_name}`
        : `${scenario} · ${values.business_name}`;
    const subject = renderTemplate(custom?.subject, values, subjectFallback).replace(/[\r\n\0]/g, ' ').slice(0, 500);
    const heading = renderTemplate(custom?.heading, values, scenario);
    const intro = renderTemplate(custom?.body_intro, values,
        staff ? `A booking update was made for ${values.customer_name}.`
            : `Hello ${values.customer_name}, your booking details are below.`);
    const outro = renderTemplate(custom?.body_outro, values,
        staff ? 'Open the administration page to review this booking.' : 'Thank you.');
    const label = renderTemplate(custom?.cta_label, values, 'Manage booking');
    return { subject, heading, intro, outro, label, templateType };
}

async function createManageUrl(pool, booking, tenant, now) {
    let baseUrl;
    try {
        const candidate = new URL(process.env.APP_URL || '');
        const localHttp = candidate.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(candidate.hostname);
        if ((!localHttp && candidate.protocol !== 'https:') || candidate.username || candidate.password || candidate.search || candidate.hash) return '';
        baseUrl = candidate.toString().replace(/\/$/, '');
    } catch { return ''; }
    const token = randomBytes(32).toString('hex');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            `INSERT INTO customer_capabilities (id,token_hash,purpose,tenant_id,subject_id,customer_id,created_at,expires_at)
             VALUES ($1,$2,'booking.manage',$3,$4,$5,$6::timestamp,$7::timestamp)`,
            [ulid(now), createHash('sha256').update(token).digest('hex'), tenant.id, booking.id, booking.customer_id,
                sqlDateTime(new Date(now).toISOString()), sqlDateTime(new Date(now + 90 * 86_400_000).toISOString())],
        );
        await client.query('COMMIT');
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* Keep the original error. */ }
        throw error;
    } finally { client.release(); }
    return `${baseUrl}/book/${encodeURIComponent(tenant.slug)}/manage/${encodeURIComponent(booking.id)}#access=${token}`;
}

async function buildMessage(pool, db, payload) {
    const { rows } = await db.query(
        `SELECT b.*,t.slug,t.name AS business_name,t.email AS business_email,t.notification_email,t.notify_on_booking,t.notify_on_cancellation,t.send_reminders,
                t.timezone,t.locale,t.currency,t.brand_color,
                COALESCE(b.customer_name_snapshot,c.name) AS customer_name,
                COALESCE(b.customer_email_snapshot,c.email) AS customer_email,c.is_anonymized,
                s.name AS service_name,s.duration_minutes,st.name AS staff_name,r.name AS resource_name,e.name AS event_name
         FROM bookings b JOIN tenants t ON t.id=b.tenant_id
         JOIN customers c ON c.id=b.customer_id AND c.tenant_id=b.tenant_id
         LEFT JOIN services s ON s.id=b.service_id AND s.tenant_id=b.tenant_id
         LEFT JOIN staff st ON st.id=b.staff_id AND st.tenant_id=b.tenant_id
         LEFT JOIN resources r ON r.id=b.resource_id AND r.tenant_id=b.tenant_id
         LEFT JOIN events e ON e.id=b.event_id AND e.tenant_id=b.tenant_id
         WHERE b.id=$1 AND b.tenant_id=$2 AND t.status <> 'archived' LIMIT 1`,
        [payload.booking_id, payload.tenant_id],
    );
    const booking = rows[0];
    if (!booking || booking.is_anonymized || booking.status !== payload.expected_status) return { suppressed: true };
    if (payload.kind === 'cancellation' ? booking.status !== 'cancelled' : !['confirmed', 'pending', 'waitlisted'].includes(booking.status)) return { suppressed: true };
    if (payload.kind === 'reminder') {
        const start = String(booking.start_datetime).slice(0, 19);
        if (!booking.send_reminders || Date.parse(wallDateTimeToUtc(start.slice(0, 10), start.slice(11, 16), booking.timezone || 'UTC')) <= Date.now()) return { suppressed: true };
    }
    if (payload.kind === 'rescheduled') {
        const original = await db.query('SELECT rescheduled_to_id FROM bookings WHERE id=$1 AND tenant_id=$2', [payload.original_booking_id, payload.tenant_id]);
        if (original.rows[0]?.rescheduled_to_id !== booking.id) return { suppressed: true };
    }
    const tenant = { id: booking.tenant_id, slug: booking.slug, name: booking.business_name, email: booking.business_email,
        notification_email: booking.notification_email, timezone: booking.timezone, locale: booking.locale, currency: booking.currency,
        brand_color: booking.brand_color, notify_on_booking: booking.notify_on_booking,
        notify_on_cancellation: booking.notify_on_cancellation, send_reminders: booking.send_reminders };
    const staff = payload.audience === 'staff';
    if (staff && !tenant[payload.kind === 'cancellation' ? 'notify_on_cancellation' : 'notify_on_booking']) return { suppressed: true };
    if (staff && !booking.notification_email && !booking.business_email) return { suppressed: true };
    if (!staff && !booking.customer_email) return { suppressed: true };
    const now = Date.now();
    const manageUrl = staff ? '' : await createManageUrl(pool, booking, tenant, now);
    const values = placeholders(booking, tenant, manageUrl);
    const type = payload.kind === 'reminder' ? 'reminder'
        : staff ? 'staff_notification' : payload.kind === 'cancellation' ? 'cancellation'
        : payload.kind === 'rescheduled' ? 'reschedule_confirmation'
            : booking.status === 'waitlisted' ? 'waitlist'
                : booking.status === 'pending' ? 'approval_request'
                    : staff ? 'staff_notification' : 'confirmation';
    const customResult = await db.query(
        'SELECT subject,heading,body_intro,body_outro,cta_label,is_enabled FROM tenant_email_templates WHERE tenant_id=$1 AND type=$2 LIMIT 1',
        [tenant.id, type],
    );
    const custom = customResult.rows[0]?.is_enabled ? customResult.rows[0] : null;
    const copy = mailCopy(payload.kind, payload.audience, booking.status, values, custom);
    const details = booking.booking_pattern === 'resource'
        ? `<p><b>Check in:</b> ${escapeHtml(values.check_in)}<br><b>Check out:</b> ${escapeHtml(values.check_out)}<br><b>Guests:</b> ${escapeHtml(values.booking_party_size)}</p>`
        : `<p><b>Date:</b> ${escapeHtml(values.booking_date)}<br><b>Time:</b> ${escapeHtml(values.booking_time)}–${escapeHtml(values.booking_end_time)}<br><b>Guests:</b> ${escapeHtml(values.booking_party_size)}</p>`;
    const action = manageUrl ? `<p><a href="${escapeHtml(manageUrl)}">${escapeHtml(copy.label)}</a></p>` : '';
    const brandColor = /^#[0-9a-f]{6}$/i.test(tenant.brand_color || '') ? tenant.brand_color : '#2563EB';
    const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#182230"><h2 style="color:${brandColor}">${escapeHtml(copy.heading)}</h2><p>${escapeHtml(copy.intro).replace(/\n/g, '<br>')}</p><p><b>${escapeHtml(values.service_name)}</b></p>${details}${values.booking_total ? `<p><b>Total:</b> ${escapeHtml(values.booking_total)}</p>` : ''}${action}<p>${escapeHtml(copy.outro).replace(/\n/g, '<br>')}</p><hr><small>${escapeHtml(tenant.name)}</small></div>`;
    const text = `${copy.heading}\n\n${copy.intro}\n\n${values.service_name}\n${values.booking_date} ${values.booking_time}–${values.booking_end_time}\n${values.booking_total}\n${manageUrl}\n\n${copy.outro}`;
    return { booking, tenant, copy, html, text, to: staff ? booking.notification_email || booking.business_email : booking.customer_email, type };
}

async function sendMessage(db, message, deliveryId) {
    const settings = await mailSettings(db);
    if (settings.transport === 'log') return { accepted: true, sent: false };
    if (settings.transport === 'resend') {
        if (!settings.password || !settings.from) throw new Error('mail_not_configured');
        const response = await fetch('https://api.resend.com/emails', {
            method: 'POST', headers: { Authorization: `Bearer ${settings.password}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: `${settings.fromName} <${settings.from}>`, to: [message.to], subject: message.copy.subject,
                html: message.html, text: message.text, reply_to: message.tenant.email }),
            signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`mail_provider_${response.status}`);
        return { accepted: true, sent: true };
    }
    if (!['smtp', 'mailpit'].includes(settings.transport)) throw new Error('mail_transport_invalid');
    const host = settings.transport === 'mailpit' ? '127.0.0.1' : settings.host;
    if (!host || !settings.from) throw new Error('mail_not_configured');
    const transporter = nodemailer.createTransport({
        host, port: settings.transport === 'mailpit' ? 1025 : settings.port,
        secure: settings.transport !== 'mailpit' && (settings.encryption === 'ssl' || settings.port === 465),
        ignoreTLS: settings.encryption === 'none',
        auth: settings.username ? { user: settings.username, pass: settings.password } : undefined,
        connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 10_000,
    });
    await transporter.sendMail({
        messageId: `<vb.${createHash('sha256').update(deliveryId).digest('hex')}@notifications.voxelbooking.local>`,
        from: { address: settings.from, name: settings.fromName }, to: message.to,
        replyTo: message.tenant.email, subject: message.copy.subject, html: message.html, text: message.text,
    });
    return { accepted: true, sent: true };
}

async function claim(db, id = null, topics = [TOPIC]) {
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query(
            `SELECT * FROM delivery_outbox WHERE topic=ANY($1::varchar[])
             AND ((status='pending' AND available_at <= NOW()) OR (status='sending' AND lease_until < NOW()))
             ${id ? 'AND id=$2' : ''} ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`, id ? [topics, id] : [topics],
        );
        const row = result.rows[0];
        if (!row) { await client.query('COMMIT'); return null; }
        const lease = randomBytes(32).toString('hex');
        const claimed = await client.query(
            `UPDATE delivery_outbox SET status='sending',attempts=attempts+1,lease_token=$1,lease_until=NOW()+INTERVAL '10 minutes'
             WHERE id=$2 RETURNING *`, [lease, row.id],
        );
        await client.query('COMMIT');
        return { ...claimed.rows[0], lease_token: lease };
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* Keep the claim error. */ }
        throw error;
    } finally { client.release(); }
}

async function finish(db, row, status, errorCode = null) {
    const attempts = Number(row.attempts);
    const delay = Math.min(86_400, 30 * (2 ** Math.min(attempts, 12)));
    await db.query(
        `UPDATE delivery_outbox SET status=$1,delivered_at=CASE WHEN $1='delivered' THEN NOW() ELSE delivered_at END,
         available_at=CASE WHEN $1='pending' THEN NOW()+($2::text||' seconds')::interval ELSE available_at END,
         lease_until=NULL,lease_token=NULL,last_error_code=$3 WHERE id=$4 AND lease_token=$5`,
        [status === 'failed' && attempts < MAX_ATTEMPTS ? 'pending' : status, delay, errorCode, row.id, row.lease_token],
    );
}

async function deliverClaimed(pool, row) {
    let payload;
    try { payload = JSON.parse(row.payload_cipher); }
    catch {
        await finish(pool, row, 'failed', 'invalid_payload');
        return { state: 'queued', email_sent: false };
    }
    let message;
    try {
        if (row.topic === REMINDER_TOPIC) payload.kind = 'reminder';
        message = await buildMessage(pool, pool, payload);
        if (message.suppressed) {
            await finish(pool, row, 'delivered');
            if (payload.reminder_id) await pool.query('UPDATE reminders SET sent_at=NOW(),last_error=NULL WHERE id=$1', [payload.reminder_id]);
            return { id: row.id, audience: payload.audience, state: 'delivered', email_sent: false };
        }
        const outcome = await sendMessage(pool, message, row.id);
        await pool.query(
            `INSERT INTO email_log (id,tenant_id,booking_id,type,to_email,subject,status,error,sent_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,NOW())`,
            [ulid(Date.now()), payload.tenant_id, payload.booking_id, message.type, message.to, message.copy.subject, outcome.sent ? 'sent' : 'sent'],
        );
        await finish(pool, row, 'delivered');
        if (payload.reminder_id) await pool.query('UPDATE reminders SET sent_at=NOW(),last_error=NULL WHERE id=$1', [payload.reminder_id]);
        return { id: row.id, audience: payload.audience, state: 'delivered', email_sent: outcome.sent };
    } catch (error) {
        await pool.query(
            `INSERT INTO email_log (id,tenant_id,booking_id,type,to_email,subject,status,error,sent_at)
             VALUES ($1,$2,$3,$4,$5,$6,'failed',$7,NOW())`,
            [ulid(Date.now()), payload.tenant_id, payload.booking_id, message?.type || payload.kind, message?.to || '', message?.copy?.subject || 'Booking notification', 'delivery_failed'],
        );
        await finish(pool, row, Number(row.attempts) >= MAX_ATTEMPTS ? 'failed' : 'failed', 'delivery_failed');
        if (payload.reminder_id) {
            await pool.query("UPDATE reminders SET attempts=attempts+1,last_error='delivery_failed' WHERE id=$1", [payload.reminder_id]);
            if (Number(row.attempts) >= MAX_ATTEMPTS) await pool.query('UPDATE reminders SET sent_at=NOW() WHERE id=$1', [payload.reminder_id]);
        }
        return { id: row.id, audience: payload.audience, state: Number(row.attempts) >= MAX_ATTEMPTS ? 'failed' : 'queued', email_sent: false };
    }
}

export async function deliverBookingNotification(pool, id) {
    const row = await claim(pool, id);
    if (!row) return { state: 'none', email_sent: false };
    return deliverClaimed(pool, row);
}

export async function queueDueReminders(pool, limit = 25) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            `SELECT r.id,r.booking_id,r.tenant_id FROM reminders r
             JOIN bookings b ON b.id=r.booking_id AND b.tenant_id=r.tenant_id
             JOIN tenants t ON t.id=r.tenant_id
             WHERE r.sent_at IS NULL AND r.scheduled_at <= NOW() AND r.attempts < $1
               AND t.status <> 'archived' AND t.send_reminders=TRUE AND b.status='confirmed'
             ORDER BY r.scheduled_at,r.id LIMIT $2 FOR UPDATE OF r SKIP LOCKED`, [MAX_ATTEMPTS, limit],
        );
        for (const reminder of rows) {
            const dedupe = createHash('sha256').update(`${REMINDER_TOPIC}\0${reminder.tenant_id}\0${reminder.id}`).digest('hex');
            const payload = JSON.stringify({ reminder_id: reminder.id, booking_id: reminder.booking_id,
                tenant_id: reminder.tenant_id, kind: 'reminder', audience: 'customer', expected_status: 'confirmed' });
            await client.query(
                `INSERT INTO delivery_outbox (id,topic,tenant_id,dedupe_hash,payload_cipher,status,attempts,available_at,created_at)
                 VALUES ($1,$2,$3,$4,$5,'pending',0,NOW(),NOW()) ON CONFLICT (dedupe_hash) DO NOTHING`,
                [ulid(), REMINDER_TOPIC, reminder.tenant_id, dedupe, payload],
            );
        }
        await client.query('COMMIT');
        return rows.length;
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* Keep the queue error. */ }
        throw error;
    } finally { client.release(); }
}

export async function deliverQueuedBookingNotifications(pool, queued) {
    const outcomes = [];
    for (const item of queued?.ids || []) {
        try { outcomes.push(await deliverBookingNotification(pool, item.id)); }
        catch { outcomes.push({ id: item.id, audience: item.audience, state: 'queued', email_sent: false }); }
    }
    const customer = outcomes.find((outcome) => outcome.audience === 'customer');
    return {
        email_sent: customer?.email_sent ?? false,
        notification_state: customer?.state ?? (queued?.customerQueued ? 'queued' : 'none'),
        notifications: outcomes,
    };
}

export async function dispatchBookingNotifications(pool, limit = 25) {
    const counts = { delivered: 0, retrying: 0, failed: 0 };
    await queueDueReminders(pool, Math.min(100, Math.max(1, limit)));
    for (let index = 0; index < Math.min(100, Math.max(1, limit)); index++) {
        const row = await claim(pool, null, [TOPIC, REMINDER_TOPIC]);
        if (!row) break;
        const result = await deliverClaimed(pool, row);
        counts[result.state === 'failed' ? 'failed' : result.state === 'delivered' ? 'delivered' : 'retrying']++;
    }
    return counts;
}
