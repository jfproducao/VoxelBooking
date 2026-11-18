import { randomBytes } from 'node:crypto';
import { verifyManageCapability } from './customer-capabilities.js';
import { bookingPermission, BookingManagementProblem } from './booking-management.js';
import { getTimeslotAvailability } from './timeslot-availability.js';
import { hasWallTime, isValidDate, localDateTime, localNow, utcRange, wallDateTimeToUtc } from '../time/venue-time.js';
import { deliverQueuedBookingNotifications, queueBookingNotifications } from './booking-notifications.js';

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid(now) {
    let value = (BigInt(now) << 80n) | BigInt(`0x${randomBytes(10).toString('hex')}`);
    let result = '';
    for (let index = 0; index < 26; index++) {
        result = alphabet[Number(value & 31n)] + result;
        value >>= 5n;
    }
    return result;
}

function sqlDateTime(iso) {
    return iso.slice(0, 19).replace('T', ' ');
}

function storedDateTime(value) {
    return String(value).slice(0, 19);
}

export async function rescheduleTimeslotBooking(pool, slug, bookingId, token, target, now = Date.now()) {
    const date = target?.new_date;
    const time = target?.new_time;
    if (!isValidDate(date)) throw new BookingManagementProblem('invalid_date', 422);
    if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
        throw new BookingManagementProblem('invalid_time', 422);
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const tenants = await client.query("SELECT * FROM tenants WHERE slug = $1 AND status = 'active' FOR UPDATE", [slug]);
        const tenant = tenants.rows[0];
        if (!tenant) throw new BookingManagementProblem('tenant_not_found', 404);
        const grant = await verifyManageCapability(client, tenant.id, bookingId, token, now);
        if (!grant) throw new BookingManagementProblem('verification_required', 403);
        const rows = await client.query(
            'SELECT * FROM bookings WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
            [bookingId, tenant.id],
        );
        const booking = rows.rows[0];
        if (!booking || booking.customer_id !== grant.customer_id) throw new BookingManagementProblem('booking_not_found', 404);
        if (booking.booking_pattern !== 'timeslot') throw new BookingManagementProblem('pattern_not_supported', 422);
        const permission = bookingPermission(booking, tenant, 'reschedule', now);
        if (!permission.allowed) throw new BookingManagementProblem(permission.reason, 409);

        const timezone = tenant.timezone || 'UTC';
        if (!hasWallTime(date, time, timezone)) throw new BookingManagementProblem('invalid_time', 422);
        const oldStart = storedDateTime(booking.start_datetime);
        const oldEnd = storedDateTime(booking.end_datetime);
        if (`${date} ${time}:00`.slice(0, 16) === oldStart.slice(0, 16)) {
            throw new BookingManagementProblem('same_slot', 422);
        }
        const durationMinutes = Math.max(1, Math.round((
            Date.parse(wallDateTimeToUtc(oldEnd.slice(0, 10), oldEnd.slice(11, 16), timezone))
            - Date.parse(wallDateTimeToUtc(oldStart.slice(0, 10), oldStart.slice(11, 16), timezone))
        ) / 60_000));
        const startInstant = Date.parse(wallDateTimeToUtc(date, time, timezone));
        const current = localNow(timezone, now);
        const latest = new Date(Date.UTC(
            Number(current.date.slice(0, 4)), Number(current.date.slice(5, 7)) - 1,
            Number(current.date.slice(8, 10)) + Number(tenant.max_advance_days ?? 90),
        )).toISOString().slice(0, 10);
        if (date > latest) throw new BookingManagementProblem('too_far', 409);
        if (startInstant <= now || startInstant < now + Number(tenant.min_advance_hours ?? 1) * 3_600_000) {
            throw new BookingManagementProblem('too_soon', 409);
        }

        const slots = await getTimeslotAvailability(client, tenant, {
            date,
            serviceId: booking.service_id,
            staffId: booking.staff_id,
            excludeBookingId: bookingId,
            durationOverride: durationMinutes,
            now,
        });
        const slot = slots.find((candidate) => candidate.time === time);
        if (!slot) throw new BookingManagementProblem('slot_unavailable', 409);

        const end = `${date} ${slot.end_time}:00`;
        const replacementId = ulid(now);
        const customFields = booking.custom_field_data === null
            ? null
            : JSON.stringify(booking.custom_field_data);
        await client.query(
            `INSERT INTO bookings (
                id, tenant_id, customer_id, booking_pattern, service_id, staff_id,
                start_datetime, end_datetime, party_size, status, rescheduled_to_id,
                notes, custom_field_data, consent_given_at, consent_text_shown,
                customer_timezone, source, customer_name_snapshot,
                customer_email_snapshot, customer_phone_snapshot, price_total, price_currency
             ) VALUES (
                $1, $2, $3, 'timeslot', $4, $5, $6::timestamp, $7::timestamp, $8, 'confirmed', NULL,
                $9, $10::jsonb, $11::timestamp, $12, $13, 'web', $14, $15, $16, $17::numeric, $18
             )`,
            [replacementId, tenant.id, booking.customer_id, booking.service_id, slot.staff_id,
                `${date} ${time}:00`, end, booking.party_size, booking.notes, customFields,
                booking.consent_given_at, booking.consent_text_shown, booking.customer_timezone,
                booking.customer_name_snapshot, booking.customer_email_snapshot,
                booking.customer_phone_snapshot, booking.price_total, booking.price_currency],
        );
        await client.query(
            `UPDATE bookings SET status = 'rescheduled', rescheduled_to_id = $1,
                 updated_at = $2::timestamp WHERE id = $3 AND tenant_id = $4`,
            [replacementId, sqlDateTime(new Date(now).toISOString()), bookingId, tenant.id],
        );
        await client.query(
            `UPDATE customer_capabilities SET subject_id = $1
             WHERE id = $2 AND purpose = 'booking.manage' AND tenant_id = $3
               AND subject_id = $4 AND customer_id = $5 AND revoked_at IS NULL`,
            [replacementId, grant.id, tenant.id, bookingId, grant.customer_id],
        );
        await client.query(
            `INSERT INTO audit_log (id, tenant_id, actor_type, actor_id, action, entity_type, entity_id, details)
             VALUES ($1, $2, 'customer', $3, 'booking.rescheduled', 'booking', $4, $5::jsonb)`,
            [ulid(now), tenant.id, grant.customer_id, bookingId, JSON.stringify({
                old_start: oldStart,
                old_end: oldEnd,
                new_booking_id: replacementId,
                new_start: `${date} ${time}:00`,
                new_end: end,
                actor_type: 'customer',
                pattern: 'timeslot',
            })],
        );
        const completedAt = sqlDateTime(new Date(now).toISOString());
        await client.query(
            'UPDATE reminders SET sent_at = $1::timestamp WHERE booking_id = $2 AND sent_at IS NULL',
            [completedAt, bookingId],
        );
        if (tenant.send_reminders) {
            const reminderInstant = startInstant - Math.max(1, Number(tenant.reminder_hours_before ?? 24)) * 3_600_000;
            if (reminderInstant > now) {
                await client.query(
                    'INSERT INTO reminders (id, booking_id, tenant_id, scheduled_at) VALUES ($1, $2, $3, $4::timestamp)',
                    [ulid(now), replacementId, tenant.id, localDateTime(reminderInstant, timezone)],
                );
            }
        }
        const service = await client.query(
            'SELECT name FROM services WHERE id = $1 AND tenant_id = $2',
            [booking.service_id, tenant.id],
        );
        const queuedNotifications = await queueBookingNotifications(client, tenant, replacementId, 'rescheduled', {
            originalBookingId: bookingId, now,
        });
        await client.query('COMMIT');
        const notification = await deliverQueuedBookingNotifications(pool, queuedNotifications);

        const range = utcRange(date, time, date, slot.end_time, timezone);
        return {
            rescheduled: true,
            new_booking_id: replacementId,
            new_booking: {
                id: replacementId,
                manage_url: `/book/${encodeURIComponent(tenant.slug)}/manage/${replacementId}#access=${token}`,
                date,
                time,
                end_time: slot.end_time,
                service: service.rows[0]?.name ?? null,
                ...range,
            },
            email_sent: notification.email_sent,
            notification_state: notification.notification_state,
            old_booking_id: bookingId,
        };
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* The connection may already be gone. */ }
        throw error;
    } finally {
        client.release();
    }
}
