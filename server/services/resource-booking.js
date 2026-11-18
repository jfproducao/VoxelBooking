import { createHash, randomBytes } from 'node:crypto';
import { isValidDate, localDateTime, utcRange, wallDateTimeToUtc } from '../time/venue-time.js';
import { quoteResourceStay } from './resource-availability.js';
import { deliverQueuedBookingNotifications, queueBookingNotifications } from './booking-notifications.js';
import {
    BookingProblem, checkSubmission, customFields, emailIsValid, getOrCreateCustomer,
    issueManageCapability, takeRateLimit, text, ulid, validateCustomFields, validateTimezone,
} from './timeslot-booking.js';

function sqlDateTime(iso) { return iso.slice(0, 19).replace('T', ' '); }

function dateRangeFailureStatus(code) {
    if (code === 'resource_not_found') return 404;
    if (['too_soon', 'too_far', 'date_blocked', 'already_booked'].includes(code)) return 409;
    return 422;
}

function partySize(value) {
    if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value))) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 10_000 ? parsed : null;
}

export async function createResourceBooking(pool, slug, body, { origin, host, ip, now = Date.now() } = {}) {
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
    const checkIn = body.check_in;
    const checkOut = body.check_out;
    if (!isValidDate(checkIn) || !isValidDate(checkOut)) throw new BookingProblem('invalid_date', 422);
    const guests = partySize(body.guest_count ?? body.party_size ?? 1);
    if (guests === null) throw new BookingProblem('invalid_party_size', 422);
    const resourceId = text(body.resource_id, 26, 'resource_id');

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const found = await client.query("SELECT * FROM tenants WHERE slug=$1 AND status='active' FOR UPDATE", [slug]);
        const tenant = found.rows[0];
        if (!tenant) throw new BookingProblem('tenant_not_found', 404);
        if (tenant.booking_pattern !== 'resource') throw new BookingProblem('pattern_not_supported', 422);
        await takeRateLimit(client, ip, now);

        const errors = {};
        if (tenant.require_phone && !phone) errors['customer.phone'] = 'required';
        if (tenant.requires_consent && body.consent_given !== true) errors.consent = 'required';
        if (Object.keys(errors).length) throw new BookingProblem('validation_failed', 422, errors);

        const quote = await quoteResourceStay(client, tenant, resourceId, checkIn, checkOut, guests, { now });
        if (!quote.available) throw new BookingProblem(quote.error || 'resource_unavailable', dateRangeFailureStatus(quote.error));

        const customerId = await getOrCreateCustomer(client, tenant.id, name, email, phone);
        const daily = await client.query(
            `SELECT COUNT(*)::int AS count FROM bookings
             WHERE tenant_id=$1 AND customer_id=$2 AND start_datetime::date=$3::date
               AND (status IN ('pending','confirmed','waitlisted')
                 OR (status='rescheduled' AND NULLIF(rescheduled_to_id,'') IS NULL))`,
            [tenant.id, customerId, checkIn],
        );
        if (Number(tenant.max_bookings_per_customer_per_day) > 0
            && Number(daily.rows[0].count) >= Number(tenant.max_bookings_per_customer_per_day)) {
            throw new BookingProblem('max_bookings_exceeded', 422);
        }

        const customerFields = validateCustomFields(customFields(tenant), body.custom_fields);
        const timezone = tenant.timezone || 'UTC';
        const start = `${checkIn} 00:00:00`;
        const end = `${checkOut} 00:00:00`;
        const status = tenant.booking_requires_approval ? 'pending' : 'confirmed';
        const bookingId = ulid(now);
        const consentRecorded = body.consent_given === true && Boolean(tenant.requires_consent);
        let consentText = null;
        if (consentRecorded) {
            consentText = String(tenant.consent_text || '').trim()
                || 'I agree to the processing of my personal data for booking purposes.';
            if (tenant.privacy_policy_url) consentText += ` Privacy policy: ${String(tenant.privacy_policy_url).trim()}`;
            if (consentText.length > 500) consentText = `${consentText.slice(0, 497)}...`;
        }

        await client.query(
            `INSERT INTO bookings (
                id,tenant_id,customer_id,booking_pattern,resource_id,start_datetime,end_datetime,party_size,status,notes,
                custom_field_data,consent_given_at,consent_text_shown,customer_timezone,source,
                customer_name_snapshot,customer_email_snapshot,customer_phone_snapshot,price_total,price_currency
             ) VALUES ($1,$2,$3,'resource',$4,$5::timestamp,$6::timestamp,$7,$8,$9,$10::jsonb,
                CASE WHEN $11 THEN $12::timestamp ELSE NULL END,$13,$14,'web',$15,$16,$17,$18::numeric,$19)`,
            [bookingId, tenant.id, customerId, resourceId, start, end, guests, status, notes || null,
                JSON.stringify(customerFields), consentRecorded, sqlDateTime(new Date(now).toISOString()), consentText,
                customerTimezone, name, email, phone || null, quote.total, quote.total === null ? null : tenant.currency],
        );
        await client.query(
            'UPDATE customers SET booking_count=booking_count+1,last_booking_at=$1::timestamp WHERE id=$2 AND tenant_id=$3',
            [sqlDateTime(new Date(now).toISOString()), customerId, tenant.id],
        );

        if (tenant.send_reminders && status === 'confirmed') {
            const checkInInstant = Date.parse(wallDateTimeToUtc(checkIn, '00:00', timezone));
            const reminderInstant = checkInInstant - Math.max(1, Number(tenant.reminder_hours_before ?? 24)) * 3_600_000;
            if (reminderInstant > now) {
                await client.query(
                    'INSERT INTO reminders (id,booking_id,tenant_id,scheduled_at) VALUES ($1,$2,$3,$4::timestamp)',
                    [ulid(now), bookingId, tenant.id, localDateTime(reminderInstant, timezone)],
                );
            }
        }
        await client.query(
            `INSERT INTO audit_log (id,tenant_id,actor_type,actor_id,action,entity_type,entity_id,details)
             VALUES ($1,$2,'customer',$3,'booking.created','booking',$4,$5::jsonb)`,
            [ulid(now), tenant.id, customerId, bookingId, JSON.stringify({
                booking_pattern: 'resource', source: 'web', consent_given: body.consent_given === true, consent_recorded: consentRecorded,
            })],
        );
        const manageUrl = await issueManageCapability(client, tenant, bookingId, customerId, now);
        const queuedNotifications = await queueBookingNotifications(client, tenant, bookingId, 'created', { now });
        await client.query('COMMIT');
        const notification = await deliverQueuedBookingNotifications(pool, queuedNotifications);

        const range = utcRange(checkIn, '00:00', checkOut, '00:00', timezone);
        return {
            id: bookingId, business_id: tenant.id, booking_pattern: 'resource', status,
            consent_recorded: consentRecorded, email_sent: notification.email_sent,
            notification_state: notification.notification_state, manage_url: manageUrl,
            resource: quote.resource.name, resource_id: resourceId, check_in: checkIn, check_out: checkOut,
            date: checkIn, nights: quote.nights, guest_count: guests, total: quote.total,
            pricing: quote.pricing, timezone, ...range,
        };
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve the domain failure. */ }
        throw error;
    } finally { client.release(); }
}
