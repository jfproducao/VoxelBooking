import { localDateTime, utcRange, wallDateTimeToUtc } from '../time/venue-time.js';
import {
    BookingProblem, checkSubmission, customFields, emailIsValid, getOrCreateCustomer,
    issueManageCapability, takeRateLimit, text, ulid, validateCustomFields, validateTimezone,
} from './timeslot-booking.js';
import { checkEventAvailability, eventBookingWindowError } from './event-availability.js';
import { deliverQueuedBookingNotifications, queueBookingNotifications } from './booking-notifications.js';

function sqlDateTime(value) { return value.slice(0, 19).replace('T', ' '); }

function spotCount(value) {
    if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value))) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 10_000 ? parsed : null;
}

function cents(value) {
    const match = String(value).match(/^(\d+)(?:\.(\d{1,2}))?$/);
    if (!match) throw new Error('Invalid event price in database.');
    return BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0'));
}

function money(value) { return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`; }

function errorStatus(code) {
    if (code === 'event_not_found') return 404;
    if (['event_full', 'waitlist_full', 'too_soon', 'too_far'].includes(code)) return 409;
    return 422;
}

export async function createEventBooking(pool, slug, body, { origin, host, ip, now = Date.now() } = {}) {
    checkSubmission(body, origin, host, now);
    const forbidden = ['source', 'status', 'customer_id', 'internal_notes'];
    const supplied = forbidden.find((field) => Object.hasOwn(body, field));
    if (supplied) throw new BookingProblem('validation_failed', 422, { [supplied]: 'unsupported' });
    const customer = body.customer;
    if (!customer || Array.isArray(customer) || typeof customer !== 'object') throw new BookingProblem('validation_failed', 422, { customer: 'invalid' });
    const name = text(customer.name, 255, 'customer.name');
    const email = text(customer.email, 255, 'customer.email').toLowerCase();
    const phone = text(customer.phone, 50, 'customer.phone');
    const notes = text(body.notes, 10_000, 'notes');
    const customerTimezone = validateTimezone(text(body.customer_timezone, 100, 'customer_timezone'));
    if (!name) throw new BookingProblem('validation_failed', 422, { 'customer.name': 'required' });
    if (!emailIsValid(email)) throw new BookingProblem('validation_failed', 422, { 'customer.email': 'invalid' });
    const eventId = text(body.event_id, 26, 'event_id');
    const date = body.date;
    const count = spotCount(body.spot_count ?? body.party_size ?? 1);
    if (!eventId) throw new BookingProblem('validation_failed', 422, { event_id: 'required' });
    if (count === null) throw new BookingProblem('invalid_party_size', 422);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const found = await client.query("SELECT * FROM tenants WHERE slug=$1 AND status='active' FOR UPDATE", [slug]);
        const tenant = found.rows[0];
        if (!tenant) throw new BookingProblem('tenant_not_found', 404);
        if (tenant.booking_pattern !== 'event') throw new BookingProblem('pattern_not_supported', 422);
        await takeRateLimit(client, ip, now);
        const errors = {};
        if (tenant.require_phone && !phone) errors['customer.phone'] = 'required';
        if (tenant.requires_consent && body.consent_given !== true) errors.consent = 'required';
        if (Object.keys(errors).length) throw new BookingProblem('validation_failed', 422, errors);

        const availability = await checkEventAvailability(client, tenant, eventId, date, count, { now });
        if (!availability.available) throw new BookingProblem(availability.error, errorStatus(availability.error));
        const event = availability.event;
        const windowError = eventBookingWindowError(tenant, date, event.start_datetime.slice(11, 19), now);
        if (windowError) throw new BookingProblem(windowError, 409);
        const answers = validateCustomFields(customFields(tenant), body.custom_fields);
        const customerId = await getOrCreateCustomer(client, tenant.id, name, email, phone);
        const daily = await client.query(
            `SELECT COUNT(*)::int AS count FROM bookings WHERE tenant_id=$1 AND customer_id=$2
               AND start_datetime::date=$3::date
               AND (status IN ('pending','confirmed','waitlisted')
                 OR (status='rescheduled' AND NULLIF(rescheduled_to_id,'') IS NULL))`,
            [tenant.id, customerId, date],
        );
        if (Number(tenant.max_bookings_per_customer_per_day) > 0
            && Number(daily.rows[0].count) >= Number(tenant.max_bookings_per_customer_per_day)) {
            throw new BookingProblem('max_bookings_exceeded', 422);
        }

        const timezone = tenant.timezone || 'UTC';
        const start = event.start_datetime;
        const end = event.end_datetime;
        const status = availability.waitlisted ? 'waitlisted' : tenant.booking_requires_approval ? 'pending' : 'confirmed';
        const bookingId = ulid(now);
        const total = event.price === null ? null : money(cents(event.price) * BigInt(count));
        const consentRecorded = body.consent_given === true && Boolean(tenant.requires_consent);
        let consentText = null;
        if (consentRecorded) {
            consentText = String(tenant.consent_text || '').trim() || 'I agree to the processing of my personal data for booking purposes.';
            if (tenant.privacy_policy_url) consentText += ` Privacy policy: ${String(tenant.privacy_policy_url).trim()}`;
            if (consentText.length > 500) consentText = `${consentText.slice(0, 497)}...`;
        }
        await client.query(
            `INSERT INTO bookings (
                id,tenant_id,customer_id,booking_pattern,event_id,start_datetime,end_datetime,party_size,status,notes,
                custom_field_data,consent_given_at,consent_text_shown,customer_timezone,source,
                customer_name_snapshot,customer_email_snapshot,customer_phone_snapshot,price_total,price_currency
             ) VALUES ($1,$2,$3,'event',$4,$5::timestamp,$6::timestamp,$7,$8,$9,$10::jsonb,
                CASE WHEN $11 THEN $12::timestamp ELSE NULL END,$13,$14,'web',$15,$16,$17,$18::numeric,$19)`,
            [bookingId, tenant.id, customerId, eventId, start, end, count, status, notes || null, JSON.stringify(answers),
                consentRecorded, sqlDateTime(new Date(now).toISOString()), consentText, customerTimezone,
                name, email, phone || null, total, total === null ? null : tenant.currency],
        );
        await client.query(
            'UPDATE customers SET booking_count=booking_count+1,last_booking_at=$1::timestamp WHERE id=$2 AND tenant_id=$3',
            [sqlDateTime(new Date(now).toISOString()), customerId, tenant.id],
        );
        if (tenant.send_reminders && status === 'confirmed') {
            const eventInstant = Date.parse(wallDateTimeToUtc(date, event.start_time, timezone));
            const reminderInstant = eventInstant - Math.max(1, Number(tenant.reminder_hours_before ?? 24)) * 3_600_000;
            if (reminderInstant > now) await client.query(
                'INSERT INTO reminders (id,booking_id,tenant_id,scheduled_at) VALUES ($1,$2,$3,$4::timestamp)',
                [ulid(now), bookingId, tenant.id, localDateTime(reminderInstant, timezone)],
            );
        }
        await client.query(
            `INSERT INTO audit_log (id,tenant_id,actor_type,actor_id,action,entity_type,entity_id,details)
             VALUES ($1,$2,'customer',$3,'booking.created','booking',$4,$5::jsonb)`,
            [ulid(now), tenant.id, customerId, bookingId, JSON.stringify({
                booking_pattern: 'event', event_id: eventId, party_size: count, waitlisted: availability.waitlisted,
                consent_given: body.consent_given === true, consent_recorded: consentRecorded,
            })],
        );
        const manageUrl = await issueManageCapability(client, tenant, bookingId, customerId, now);
        const queuedNotifications = await queueBookingNotifications(client, tenant, bookingId, 'created', { now });
        await client.query('COMMIT');
        const notification = await deliverQueuedBookingNotifications(pool, queuedNotifications);
        const range = utcRange(date, event.start_time, event.end_datetime.slice(0, 10), event.end_time, timezone);
        return {
            id: bookingId, business_id: tenant.id, booking_pattern: 'event', status, consent_recorded: consentRecorded,
            email_sent: notification.email_sent, notification_state: notification.notification_state,
            manage_url: manageUrl, event_id: eventId,
            event_name: event.name, date, time: event.start_time, end_time: event.end_time,
            spot_count: count, waitlisted: availability.waitlisted, total, timezone, ...range,
        };
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve the domain failure. */ }
        throw error;
    } finally { client.release(); }
}
