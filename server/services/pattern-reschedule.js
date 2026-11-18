import { randomBytes } from 'node:crypto';
import { quoteResourceStay } from './resource-availability.js';
import { checkCapacitySlot } from './capacity-availability.js';
import { checkEventAvailability, eventBookingWindowError } from './event-availability.js';
import { BookingManagementProblem, bookingPermission } from './booking-management.js';
import { verifyManageCapability } from './customer-capabilities.js';
import { isValidDate, localDateTime, utcRange, wallDateTimeToUtc } from '../time/venue-time.js';
import { deliverQueuedBookingNotifications, queueBookingNotifications } from './booking-notifications.js';

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid(now) {
    let value = (BigInt(now) << 80n) | BigInt(`0x${randomBytes(10).toString('hex')}`);
    let result = '';
    for (let index = 0; index < 26; index++) { result = alphabet[Number(value & 31n)] + result; value >>= 5n; }
    return result;
}
function sqlDateTime(iso) { return iso.slice(0, 19).replace('T', ' '); }
function stored(value) { return String(value).slice(0, 19); }
function requiredDate(value, field) {
    if (!isValidDate(value)) {
        throw new BookingManagementProblem('invalid_date', 422, { [field]: 'invalid' });
    }
    return value;
}
function statusFor(code) {
    if (code === 'event_not_found' || code === 'resource_not_found' || code === 'slot_not_found') return 404;
    if (['too_soon', 'too_far', 'date_blocked', 'already_booked', 'capacity_exceeded', 'event_full'].includes(code)) return 409;
    return 422;
}
function cents(value) {
    const match = String(value).match(/^(\d+)(?:\.(\d{1,2}))?$/);
    if (!match) throw new Error('Invalid persisted event price.');
    return BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0'));
}
function money(value) { return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`; }

export async function rescheduleOtherPattern(pool, slug, bookingId, token, target, now = Date.now()) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const tenantResult = await client.query("SELECT * FROM tenants WHERE slug=$1 AND status='active' FOR UPDATE", [slug]);
        const tenant = tenantResult.rows[0];
        if (!tenant) throw new BookingManagementProblem('tenant_not_found', 404);
        const grant = await verifyManageCapability(client, tenant.id, bookingId, token, now);
        if (!grant) throw new BookingManagementProblem('verification_required', 403);
        const bookingResult = await client.query('SELECT * FROM bookings WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [bookingId, tenant.id]);
        const booking = bookingResult.rows[0];
        if (!booking || booking.customer_id !== grant.customer_id) throw new BookingManagementProblem('booking_not_found', 404);
        if (booking.booking_pattern === 'timeslot') throw new BookingManagementProblem('pattern_not_supported', 422);
        const permission = bookingPermission(booking, tenant, 'reschedule', now);
        if (!permission.allowed) throw new BookingManagementProblem(permission.reason, 409);

        const timezone = tenant.timezone || 'UTC';
        const originalStart = stored(booking.start_datetime);
        const originalEnd = stored(booking.end_datetime);
        const size = Number(booking.party_size);
        let start; let end; let date; let time; let endTime; let slotId = null; let eventName = null; let resourceName = null; let newTotal = booking.price_total === null ? null : String(booking.price_total);

        if (booking.booking_pattern === 'resource') {
            const checkIn = requiredDate(target?.check_in, 'check_in');
            const checkOut = requiredDate(target?.check_out, 'check_out');
            if (checkOut <= checkIn) throw new BookingManagementProblem('invalid_date', 422);
            if (checkIn === originalStart.slice(0, 10) && checkOut === originalEnd.slice(0, 10)) throw new BookingManagementProblem('same_slot', 422);
            const quote = await quoteResourceStay(client, tenant, booking.resource_id, checkIn, checkOut, size, { excludeBookingId: bookingId, now });
            if (!quote.available) throw new BookingManagementProblem(quote.error, statusFor(quote.error));
            start = `${checkIn} 00:00:00`; end = `${checkOut} 00:00:00`; date = checkIn; time = '00:00'; endTime = '00:00';
            newTotal = quote.total; resourceName = quote.resource.name;
        } else if (booking.booking_pattern === 'capacity') {
            date = requiredDate(target?.date, 'date');
            if (typeof target?.slot_id !== 'string' || target.slot_id.length < 1 || target.slot_id.length > 26) throw new BookingManagementProblem('invalid_slot', 422);
            const result = await checkCapacitySlot(client, tenant, target.slot_id, date, size, { now, excludeBookingId: bookingId });
            if (!result.available) throw new BookingManagementProblem(result.error, statusFor(result.error));
            slotId = result.slot.id; time = String(result.slot.start_time).slice(0, 5); endTime = String(result.slot.end_time).slice(0, 5);
            start = `${date} ${time}:00`; end = `${date} ${endTime}:00`;
            if (end <= start) throw new BookingManagementProblem('invalid_time', 422);
            if (start.slice(0, 16) === originalStart.slice(0, 16)) throw new BookingManagementProblem('same_slot', 422);
        } else if (booking.booking_pattern === 'event') {
            date = requiredDate(target?.date, 'date');
            const eventId = booking.event_id;
            if (target?.event_id !== undefined && target.event_id !== eventId) throw new BookingManagementProblem('reschedule_context_mismatch', 422);
            const result = await checkEventAvailability(client, tenant, eventId, date, size, { now, excludeBookingId: bookingId });
            if (!result.available || result.waitlisted) throw new BookingManagementProblem(result.error || 'event_full', statusFor(result.error || 'event_full'));
            const windowError = eventBookingWindowError(tenant, date, result.event.start_time, now);
            if (windowError) throw new BookingManagementProblem(windowError, 409);
            start = result.event.start_datetime; end = result.event.end_datetime; time = result.event.start_time; endTime = result.event.end_time;
            eventName = result.event.name;
            if (date === originalStart.slice(0, 10)) throw new BookingManagementProblem('same_slot', 422);
        } else throw new BookingManagementProblem('pattern_not_supported', 422);

        const replacementId = ulid(now);
        const customFields = booking.custom_field_data === null ? null : JSON.stringify(booking.custom_field_data);
        const consentAt = booking.consent_given_at ? stored(booking.consent_given_at) : null;
        const bookingColumns = booking.booking_pattern === 'capacity'
            ? `id,tenant_id,customer_id,booking_pattern,capacity_slot_id,resource_id,event_id,start_datetime,end_datetime,party_size,status,rescheduled_to_id,notes,custom_field_data,consent_given_at,consent_text_shown,customer_timezone,source,customer_name_snapshot,customer_email_snapshot,customer_phone_snapshot,price_total,price_currency`
            : `id,tenant_id,customer_id,booking_pattern,resource_id,event_id,start_datetime,end_datetime,party_size,status,rescheduled_to_id,notes,custom_field_data,consent_given_at,consent_text_shown,customer_timezone,source,customer_name_snapshot,customer_email_snapshot,customer_phone_snapshot,price_total,price_currency`;
        const bookingValues = booking.booking_pattern === 'capacity'
            ? `$1,$2,$3,'capacity',$4,$5,$6,$7::timestamp,$8::timestamp,$9,'confirmed',NULL,$10,$11::jsonb,$12::timestamp,$13,$14,'web',$15,$16,$17,$18::numeric,$19`
            : `$1,$2,$3,'${booking.booking_pattern}',$4,$5,$6::timestamp,$7::timestamp,$8,'confirmed',NULL,$9,$10::jsonb,$11::timestamp,$12,$13,'web',$14,$15,$16,$17::numeric,$18`;
        const insertValues = booking.booking_pattern === 'capacity'
            ? [replacementId, tenant.id, booking.customer_id, slotId, booking.resource_id, booking.event_id, start, end, size, booking.notes, customFields, consentAt, booking.consent_text_shown, booking.customer_timezone, booking.customer_name_snapshot, booking.customer_email_snapshot, booking.customer_phone_snapshot, newTotal, newTotal === null ? booking.price_currency : tenant.currency]
            : [replacementId, tenant.id, booking.customer_id, booking.resource_id, booking.event_id, start, end, size, booking.notes, customFields, consentAt, booking.consent_text_shown, booking.customer_timezone, booking.customer_name_snapshot, booking.customer_email_snapshot, booking.customer_phone_snapshot, newTotal, booking.booking_pattern === 'resource' || newTotal !== null ? tenant.currency : booking.price_currency];
        await client.query(`INSERT INTO bookings (${bookingColumns}) VALUES (${bookingValues})`, insertValues);
        await client.query(
            `UPDATE bookings SET status='rescheduled',rescheduled_to_id=$1,updated_at=$2::timestamp WHERE id=$3 AND tenant_id=$4`,
            [replacementId, sqlDateTime(new Date(now).toISOString()), bookingId, tenant.id],
        );
        await client.query(
            `UPDATE customer_capabilities SET subject_id=$1
             WHERE id=$2 AND purpose='booking.manage' AND tenant_id=$3 AND subject_id=$4 AND customer_id=$5 AND revoked_at IS NULL`,
            [replacementId, grant.id, tenant.id, bookingId, grant.customer_id],
        );
        await client.query(
            `INSERT INTO audit_log (id,tenant_id,actor_type,actor_id,action,entity_type,entity_id,details)
             VALUES ($1,$2,'customer',$3,'booking.rescheduled','booking',$4,$5::jsonb)`,
            [ulid(now), tenant.id, grant.customer_id, bookingId, JSON.stringify({
                old_start: originalStart, old_end: originalEnd, new_booking_id: replacementId,
                new_start: start, new_end: end, actor_type: 'customer', pattern: booking.booking_pattern,
            })],
        );
        const completedAt = sqlDateTime(new Date(now).toISOString());
        await client.query('UPDATE reminders SET sent_at=$1::timestamp WHERE booking_id=$2 AND sent_at IS NULL', [completedAt, bookingId]);
        const startTime = booking.booking_pattern === 'resource' ? '00:00' : time;
        const startDate = booking.booking_pattern === 'resource' ? start.slice(0, 10) : date;
        const startInstant = Date.parse(wallDateTimeToUtc(startDate, startTime, timezone));
        const reminderInstant = startInstant - Math.max(1, Number(tenant.reminder_hours_before ?? 24)) * 3_600_000;
        if (tenant.send_reminders && reminderInstant > now) {
            await client.query('INSERT INTO reminders (id,booking_id,tenant_id,scheduled_at) VALUES ($1,$2,$3,$4::timestamp)',
                [ulid(now), replacementId, tenant.id, localDateTime(reminderInstant, timezone)]);
        }
        const queuedNotifications = await queueBookingNotifications(client, tenant, replacementId, 'rescheduled', {
            originalBookingId: bookingId, now,
        });
        await client.query('COMMIT');
        const notification = await deliverQueuedBookingNotifications(pool, queuedNotifications);
        const range = booking.booking_pattern === 'resource'
            ? { check_in: start.slice(0, 10), check_out: end.slice(0, 10) }
            : utcRange(start.slice(0, 10), start.slice(11, 16), end.slice(0, 10), end.slice(11, 16), timezone);
        const manageUrl = `/book/${encodeURIComponent(tenant.slug)}/manage/${encodeURIComponent(replacementId)}#access=${token}`;
        return {
            rescheduled: true, new_booking_id: replacementId, old_booking_id: bookingId,
            new_booking: {
                id: replacementId, manage_url: manageUrl, date: start.slice(0, 10), time, end_time: endTime,
                check_in: booking.booking_pattern === 'resource' ? start.slice(0, 10) : null,
                check_out: booking.booking_pattern === 'resource' ? end.slice(0, 10) : null,
                slot_id: slotId, event_name: eventName, resource: resourceName, ...range,
            },
            email_sent: notification.email_sent, notification_state: notification.notification_state,
        };
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* Retain the original error. */ }
        throw error;
    } finally { client.release(); }
}
