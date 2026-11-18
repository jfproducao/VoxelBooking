import { createHash, randomBytes } from 'node:crypto';
import { getTimeslotAvailability } from './timeslot-availability.js';
import { deliverQueuedBookingNotifications, queueBookingNotifications } from './booking-notifications.js';
import { hasWallTime, isValidDate, localDateTime, localNow, utcRange, wallDateTimeToUtc } from '../time/venue-time.js';

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export class BookingProblem extends Error {
    constructor(code, statusCode = 422, fields = undefined) {
        super(code);
        this.code = code;
        this.statusCode = statusCode;
        this.fields = fields;
    }
}

export function ulid(now = Date.now()) {
    let value = (BigInt(now) << 80n) | BigInt(`0x${randomBytes(10).toString('hex')}`);
    let result = '';
    for (let index = 0; index < 26; index++) {
        result = alphabet[Number(value & 31n)] + result;
        value >>= 5n;
    }
    return result;
}

export function text(value, max, field) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string' || [...value].length > max) {
        throw new BookingProblem('validation_failed', 422, { [field]: 'invalid' });
    }
    return value.trim();
}

export function emailIsValid(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function validateCustomFields(definitions, answers) {
    if (answers === null || answers === undefined) answers = {};
    if (!answers || Array.isArray(answers) || typeof answers !== 'object' || Buffer.byteLength(JSON.stringify(answers)) > 20_000) {
        throw new BookingProblem('validation_failed', 422, { custom_fields: 'invalid' });
    }

    const allowed = {};
    const fields = {};
    for (const field of Array.isArray(definitions) ? definitions : []) {
        const name = field.name ?? field.key ?? '';
        if (!name) continue;
        const value = answers[name];
        const type = field.type ?? 'text';
        const missing = value === undefined || value === null || value === '' || (type === 'checkbox' && value !== true);
        if (field.required && missing) {
            fields[`custom_fields.${name}`] = 'required';
            continue;
        }
        if (missing) continue;

        let valid;
        switch (type) {
            case 'checkbox': valid = typeof value === 'boolean'; break;
            case 'number': valid = Number.isFinite(Number(value))
                && (field.min === undefined || Number(value) >= Number(field.min))
                && (field.max === undefined || Number(value) <= Number(field.max)); break;
            case 'email': valid = typeof value === 'string' && emailIsValid(value); break;
            case 'date': valid = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
                && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
                && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value; break;
            case 'select': valid = typeof value === 'string' && (field.options ?? []).some((option) =>
                String(typeof option === 'object' && option !== null ? option.value : option) === value); break;
            default: valid = typeof value === 'string' && [...value].length <= 2000;
        }
        if (!valid) fields[`custom_fields.${name}`] = 'invalid';
        else allowed[name] = value;
    }
    const names = new Set((Array.isArray(definitions) ? definitions : []).map((field) => field.name ?? field.key ?? ''));
    for (const key of Object.keys(answers)) {
        if (!names.has(key)) fields[`custom_fields.${key}`] = 'unsupported';
    }
    if (Object.keys(fields).length) throw new BookingProblem('validation_failed', 422, fields);
    return allowed;
}

export function checkSubmission(body, origin, host, now) {
    if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).length === 0) {
        throw new BookingProblem('invalid_json', 400);
    }
    if (!Number.isFinite(Number(body.__ts)) || now - Number(body.__ts) < 3000) {
        throw new BookingProblem('spam_detected', 422);
    }
    if (text(body.__hp ?? '', 1000, '__hp') !== '') throw new BookingProblem('spam_detected', 422);

    let originHost = '';
    try { originHost = new URL(origin).hostname.toLowerCase(); } catch { /* Missing and opaque origins fail closed. */ }
    const hostName = String(host ?? '').split(':')[0].replace(/^\[|\]$/g, '').toLowerCase();
    if (!originHost || originHost !== hostName) throw new BookingProblem('csrf_mismatch', 403);
}

export function validateTimezone(timezone) {
    if (!timezone) return null;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone });
        return timezone;
    } catch {
        throw new BookingProblem('validation_failed', 422, { customer_timezone: 'invalid' });
    }
}

export function customFields(tenant) {
    if (Array.isArray(tenant.custom_fields)) return tenant.custom_fields;
    if (typeof tenant.custom_fields === 'string') {
        try { return JSON.parse(tenant.custom_fields); } catch { return []; }
    }
    return [];
}

function addMinutes(date, time, minutes) {
    const instant = Date.parse(`${date}T${time}:00Z`) + minutes * 60_000;
    return new Date(instant).toISOString().slice(0, 16).replace('T', ' ');
}

function sqlDateTime(iso) {
    return iso.slice(0, 19).replace('T', ' ');
}

export async function takeRateLimit(client, ip, now) {
    const address = String(ip || 'unknown').slice(0, 45);
    await client.query('SELECT pg_advisory_xact_lock(0, hashtext($1))', [`booking:${address}`]);
    const { rows: [{ count }] } = await client.query(
        "SELECT COUNT(*)::int AS count FROM rate_limits WHERE ip = $1 AND endpoint_group = 'booking_create' AND created_at > $2::timestamp - INTERVAL '1 minute'",
        [address, sqlDateTime(new Date(now).toISOString())],
    );
    if (count >= 10) throw new BookingProblem('rate_limited', 429);
    await client.query(
        "INSERT INTO rate_limits (ip, endpoint_group, created_at) VALUES ($1, 'booking_create', $2)",
        [address, sqlDateTime(new Date(now).toISOString())],
    );
}

export async function getOrCreateCustomer(client, tenantId, name, email, phone) {
    const inserted = await client.query(
        `INSERT INTO customers (id, tenant_id, name, email, phone)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, (lower(email))) DO NOTHING
         RETURNING id`,
        [ulid(), tenantId, name, email, phone || null],
    );
    if (inserted.rows[0]) return inserted.rows[0].id;
    const existing = await client.query(
        'SELECT id FROM customers WHERE tenant_id = $1 AND lower(email) = lower($2) LIMIT 1',
        [tenantId, email],
    );
    if (!existing.rows[0]) throw new Error('Customer insert conflict could not be resolved.');
    return existing.rows[0].id;
}

export async function issueManageCapability(client, tenant, bookingId, customerId, now) {
    const token = randomBytes(32).toString('hex');
    await client.query(
        `INSERT INTO customer_capabilities
            (id, token_hash, purpose, tenant_id, subject_id, customer_id, created_at, expires_at)
         VALUES ($1, $2, 'booking.manage', $3, $4, $5, $6, $7)`,
        [ulid(now), createHash('sha256').update(token).digest('hex'), tenant.id, bookingId, customerId,
            sqlDateTime(new Date(now).toISOString()), sqlDateTime(new Date(now + 90 * 86_400_000).toISOString())],
    );
    return `/book/${encodeURIComponent(tenant.slug)}/manage/${encodeURIComponent(bookingId)}#access=${token}`;
}

export async function createTimeslotBooking(pool, slug, body, { origin, host, ip, now = Date.now() } = {}) {
    checkSubmission(body, origin, host, now);

    const forbidden = ['source', 'status', 'customer_id', 'internal_notes'];
    const supplied = forbidden.find((field) => Object.hasOwn(body, field));
    if (supplied) throw new BookingProblem('validation_failed', 422, { [supplied]: 'unsupported' });

    const customer = body.customer;
    if (!customer || Array.isArray(customer) || typeof customer !== 'object') {
        throw new BookingProblem('validation_failed', 422, { customer: 'invalid' });
    }
    const name = text(customer.name, 255, 'customer.name');
    const email = text(customer.email, 255, 'customer.email').toLowerCase();
    const phone = text(customer.phone, 50, 'customer.phone');
    const notes = text(body.notes, 10_000, 'notes');
    const customerTimezone = validateTimezone(text(body.customer_timezone, 100, 'customer_timezone'));
    if (!name) throw new BookingProblem('validation_failed', 422, { 'customer.name': 'required' });
    if (!emailIsValid(email)) throw new BookingProblem('validation_failed', 422, { 'customer.email': 'invalid' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const found = await client.query("SELECT * FROM tenants WHERE slug = $1 AND status = 'active' FOR UPDATE", [slug]);
        const tenant = found.rows[0];
        if (!tenant) throw new BookingProblem('tenant_not_found', 404);
        if (tenant.booking_pattern !== 'timeslot') throw new BookingProblem('pattern_not_supported', 422);

        await takeRateLimit(client, ip, now);

        const errors = {};
        if (tenant.require_phone && !phone) errors['customer.phone'] = 'required';
        if (tenant.requires_consent && body.consent_given !== true) errors.consent = 'required';
        if (Object.keys(errors).length) throw new BookingProblem('validation_failed', 422, errors);

        const serviceId = text(body.service_id, 26, 'service_id');
        const date = body.date;
        const time = body.time;
        if (!isValidDate(date)) {
            throw new BookingProblem('invalid_date', 422);
        }
        if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)
            || !hasWallTime(date, time, tenant.timezone || 'UTC')) {
            throw new BookingProblem('invalid_time', 422);
        }

        const serviceResult = await client.query(
            'SELECT id, name, duration_minutes, price FROM services WHERE id = $1 AND tenant_id = $2 AND is_active = TRUE LIMIT 1',
            [serviceId, tenant.id],
        );
        const service = serviceResult.rows[0];
        if (!service) throw new BookingProblem('not_found', 404);

        const staffId = text(body.staff_id, 26, 'staff_id') || null;
        const timezone = tenant.timezone || 'UTC';
        const nowLocal = localNow(timezone, now);
        const earliest = now + Number(tenant.min_advance_hours ?? 1) * 3_600_000;
        const latestDate = new Date(Date.UTC(
            Number(nowLocal.date.slice(0, 4)), Number(nowLocal.date.slice(5, 7)) - 1,
            Number(nowLocal.date.slice(8, 10)) + Number(tenant.max_advance_days ?? 90),
        )).toISOString().slice(0, 10);
        if (date > latestDate) throw new BookingProblem('too_far', 409);
        const instant = Date.parse(wallDateTimeToUtc(date, time, timezone));
        if (instant <= now || instant < earliest) throw new BookingProblem('too_soon', 409);

        const available = await getTimeslotAvailability(client, tenant, {
            date, serviceId, staffId, now,
        });
        const slot = available.find((candidate) => candidate.time === time);
        if (!slot) throw new BookingProblem('slot_unavailable', 409);
        const staffName = slot.staff_id
            ? (await client.query('SELECT name FROM staff WHERE id = $1 AND tenant_id = $2', [slot.staff_id, tenant.id])).rows[0]?.name ?? null
            : null;

        const answers = validateCustomFields(customFields(tenant), body.custom_fields);
        const customerId = await getOrCreateCustomer(client, tenant.id, name, email, phone);
        const daily = await client.query(
            `SELECT COUNT(*)::int AS count FROM bookings
             WHERE tenant_id = $1 AND customer_id = $2 AND start_datetime::date = $3::date
               AND (status IN ('pending', 'confirmed', 'waitlisted')
                 OR (status = 'rescheduled' AND NULLIF(rescheduled_to_id, '') IS NULL))`,
            [tenant.id, customerId, date],
        );
        if (Number(tenant.max_bookings_per_customer_per_day) > 0
            && daily.rows[0].count >= Number(tenant.max_bookings_per_customer_per_day)) {
            throw new BookingProblem('max_bookings_exceeded', 422);
        }

        const endDateTime = addMinutes(date, time, Number(service.duration_minutes));
        const endDate = endDateTime.slice(0, 10);
        const endTime = endDateTime.slice(11, 16);
        const startDateTime = `${date} ${time}:00`;
        const status = tenant.booking_requires_approval ? 'pending' : 'confirmed';
        const bookingId = ulid(now);
        const consentRecorded = Boolean(body.consent_given === true && tenant.requires_consent);
        let consentText = null;
        if (consentRecorded) {
            consentText = String(tenant.consent_text || '').trim()
                || 'I agree to the processing of my personal data for booking purposes.';
            if (tenant.privacy_policy_url) consentText += ` Privacy policy: ${String(tenant.privacy_policy_url).trim()}`;
            if (consentText.length > 500) consentText = `${consentText.slice(0, 497)}...`;
        }
        const price = service.price === null ? null : String(service.price);
        await client.query(
            `INSERT INTO bookings (
                id, tenant_id, customer_id, booking_pattern, service_id, staff_id,
                start_datetime, end_datetime, party_size, status, notes,
                custom_field_data, consent_given_at, consent_text_shown,
                customer_timezone, source, customer_name_snapshot,
                customer_email_snapshot, customer_phone_snapshot, price_total, price_currency
             ) VALUES (
                $1, $2, $3, 'timeslot', $4, $5, $6::timestamp, $7::timestamp, 1, $8, $9,
                $10::jsonb, CASE WHEN $11 THEN $12::timestamp ELSE NULL END, $13,
                $14, 'web', $15, $16, $17, $18::numeric, $19
             )`,
            [bookingId, tenant.id, customerId, serviceId, slot.staff_id, startDateTime,
                `${endDateTime}:00`, status, notes || null, JSON.stringify(answers), consentRecorded,
                sqlDateTime(new Date(now).toISOString()), consentText, customerTimezone,
                name, email, phone || null, price, price === null ? null : tenant.currency],
        );
        await client.query(
            `UPDATE customers SET booking_count = booking_count + 1, last_booking_at = $1::timestamp
             WHERE id = $2 AND tenant_id = $3`,
            [sqlDateTime(new Date(now).toISOString()), customerId, tenant.id],
        );

        if (tenant.send_reminders && status === 'confirmed') {
            const reminderInstant = Date.parse(wallDateTimeToUtc(date, time, timezone))
                - Math.max(1, Number(tenant.reminder_hours_before ?? 24)) * 3_600_000;
            if (reminderInstant > now) {
                await client.query(
                    'INSERT INTO reminders (id, booking_id, tenant_id, scheduled_at) VALUES ($1, $2, $3, $4::timestamp)',
                    [ulid(now), bookingId, tenant.id, localDateTime(reminderInstant, timezone)],
                );
            }
        }

        const details = {
            booking_pattern: 'timeslot', source: 'web',
            consent_given: body.consent_given === true, consent_recorded: consentRecorded,
        };
        await client.query(
            `INSERT INTO audit_log (id, tenant_id, actor_type, actor_id, action, entity_type, entity_id, details)
             VALUES ($1, $2, 'customer', $3, 'booking.created', 'booking', $4, $5::jsonb)`,
            [ulid(now), tenant.id, customerId, bookingId, JSON.stringify(details)],
        );
        const manageUrl = await issueManageCapability(client, tenant, bookingId, customerId, now);
        const queuedNotifications = await queueBookingNotifications(client, tenant, bookingId, 'created', { now });
        await client.query('COMMIT');
        const notification = await deliverQueuedBookingNotifications(pool, queuedNotifications);

        const range = utcRange(date, time, endDate, endTime, timezone);
        return {
            id: bookingId,
            business_id: tenant.id,
            booking_pattern: 'timeslot',
            status,
            consent_recorded: consentRecorded,
            email_sent: notification.email_sent,
            notification_state: notification.notification_state,
            manage_url: manageUrl,
            service: service.name,
            staff: staffName,
            duration: Number(service.duration_minutes),
            total: price,
            date,
            time,
            end_time: endTime,
            timezone,
            ...range,
        };
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* The connection may already be gone. */ }
        throw error;
    } finally {
        client.release();
    }
}
