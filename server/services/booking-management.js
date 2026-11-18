import { randomBytes } from 'node:crypto';
import { verifyManageCapability } from './customer-capabilities.js';
import { wallDateTimeToUtc, utcRange } from '../time/venue-time.js';
import { deliverQueuedBookingNotifications, queueBookingNotifications } from './booking-notifications.js';

export class BookingManagementProblem extends Error {
    constructor(code, statusCode = 409, fields = undefined) {
        super(code);
        this.code = code;
        this.statusCode = statusCode;
        this.fields = fields;
    }
}

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

async function tenantBySlug(db, slug) {
    const { rows } = await db.query("SELECT * FROM tenants WHERE slug = $1 AND status = 'active' LIMIT 1", [slug]);
    return rows[0] ?? null;
}

async function bookingDetails(db, tenantId, bookingId) {
    const { rows } = await db.query(
        `SELECT b.*, s.name AS service_name, s.is_virtual,
                st.name AS staff_name, r.name AS resource_name,
                e.name AS event_name, e.location AS event_location,
                COALESCE(b.customer_name_snapshot, c.name) AS customer_name,
                COALESCE(b.customer_email_snapshot, c.email) AS customer_email
         FROM bookings b
         LEFT JOIN services s ON s.id = b.service_id AND s.tenant_id = b.tenant_id
         LEFT JOIN staff st ON st.id = b.staff_id AND st.tenant_id = b.tenant_id
         LEFT JOIN resources r ON r.id = b.resource_id AND r.tenant_id = b.tenant_id
         LEFT JOIN events e ON e.id = b.event_id AND e.tenant_id = b.tenant_id
         JOIN customers c ON c.id = b.customer_id AND c.tenant_id = b.tenant_id
         WHERE b.id = $1 AND b.tenant_id = $2 LIMIT 1`,
        [bookingId, tenantId],
    );
    return rows[0] ?? null;
}

export function bookingPermission(booking, tenant, action, now) {
    const allowedColumn = action === 'cancel' ? 'allow_cancellation' : 'allow_rescheduling';
    const hoursColumn = action === 'cancel' ? 'cancellation_hours_before' : 'rescheduling_hours_before';
    const disabledCode = action === 'cancel' ? 'cancellation_disabled' : 'rescheduling_disabled';
    if (booking.status !== 'confirmed') return { allowed: false, reason: 'not_confirmed' };
    if (!tenant[allowedColumn]) return { allowed: false, reason: disabledCode };
    const localStart = String(booking.start_datetime).slice(0, 19).replace(' ', 'T');
    const startInstant = Date.parse(wallDateTimeToUtc(localStart.slice(0, 10), localStart.slice(11, 16), tenant.timezone || 'UTC'));
    const differenceHours = (startInstant - now) / 3_600_000;
    if (differenceHours < Number(tenant[hoursColumn] ?? 24)) return { allowed: false, reason: 'too_late' };
    return { allowed: true, reason: null };
}

export async function getManagedBooking(db, slug, bookingId, token, now = Date.now()) {
    const tenant = await tenantBySlug(db, slug);
    if (!tenant) throw new BookingManagementProblem('tenant_not_found', 404);
    const grant = await verifyManageCapability(db, tenant.id, bookingId, token, now);
    if (!grant) throw new BookingManagementProblem('verification_required', 403);
    const booking = await bookingDetails(db, tenant.id, bookingId);
    if (!booking) throw new BookingManagementProblem('booking_not_found', 404);

    let replacementId = null;
    if (booking.rescheduled_to_id && booking.rescheduled_to_id !== booking.id) {
        const replacement = await db.query(
            'SELECT id FROM bookings WHERE id = $1 AND tenant_id = $2 AND customer_id = $3 LIMIT 1',
            [booking.rescheduled_to_id, tenant.id, booking.customer_id],
        );
        replacementId = replacement.rows[0]?.id ?? null;
    }
    const start = String(booking.start_datetime).slice(0, 19);
    const end = String(booking.end_datetime).slice(0, 19);
    const date = start.slice(0, 10);
    const time = start.slice(11, 16);
    const endTime = end.slice(11, 16);
    const timezone = tenant.timezone || 'UTC';
    const range = booking.booking_pattern === 'resource'
        ? {
            check_in: date,
            check_out: end.slice(0, 10),
            nights: Math.round((Date.parse(`${end.slice(0, 10)}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000),
        }
        : utcRange(date, time, end.slice(0, 10), endTime, timezone);
    const cancel = bookingPermission(booking, tenant, 'cancel', now);
    const reschedule = bookingPermission(booking, tenant, 'reschedule', now);
    return {
        booking: {
            id: booking.id,
            status: booking.status,
            booking_pattern: booking.booking_pattern,
            date,
            time,
            end_time: endTime,
            start_datetime: start,
            end_datetime: end,
            ...range,
            party_size: Number(booking.party_size),
            service_id: booking.service_id,
            is_virtual: Boolean(booking.is_virtual),
            staff_id: booking.staff_id,
            resource_id: booking.resource_id,
            event_id: booking.event_id,
            service_name: booking.service_name,
            staff_name: booking.staff_name,
            resource_name: booking.resource_name,
            event_name: booking.event_name,
            event_location: booking.event_location,
            customer_id: booking.customer_id,
            customer_name: booking.customer_name,
            customer_email: booking.customer_email,
            customer_timezone: booking.customer_timezone,
            rescheduled_to_id: replacementId,
            cancelled_at: booking.cancelled_at,
            cancellation_reason: booking.cancellation_reason,
            check_in: booking.booking_pattern === 'resource' ? date : null,
            check_out: booking.booking_pattern === 'resource' ? end.slice(0, 10) : null,
        },
        can_cancel: cancel.allowed,
        cancel_reason: cancel.reason,
        can_reschedule: reschedule.allowed,
        reschedule_reason: reschedule.reason,
    };
}

export async function cancelManagedBooking(pool, slug, bookingId, token, reason = '', now = Date.now()) {
    if (typeof reason !== 'string' || [...reason].length > 255) {
        throw new BookingManagementProblem('validation_failed', 422, { reason: 'invalid' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const tenantResult = await client.query("SELECT * FROM tenants WHERE slug = $1 AND status = 'active' FOR UPDATE", [slug]);
        const tenant = tenantResult.rows[0];
        if (!tenant) throw new BookingManagementProblem('tenant_not_found', 404);
        const grant = await verifyManageCapability(client, tenant.id, bookingId, token, now);
        if (!grant) throw new BookingManagementProblem('verification_required', 403);
        const bookingResult = await client.query(
            'SELECT * FROM bookings WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
            [bookingId, tenant.id],
        );
        const booking = bookingResult.rows[0];
        if (!booking || booking.customer_id !== grant.customer_id) throw new BookingManagementProblem('booking_not_found', 404);
        if (booking.status === 'cancelled') {
            await client.query('COMMIT');
            return { cancelled: true, booking_id: bookingId, email_sent: false, notification_state: 'none' };
        }
        const permission = bookingPermission(booking, tenant, 'cancel', now);
        if (!permission.allowed) throw new BookingManagementProblem(permission.reason, 409);

        const cancelledAt = new Date(now).toISOString().slice(0, 19).replace('T', ' ');
        await client.query(
            `UPDATE bookings SET status = 'cancelled', cancelled_at = $1::timestamp,
                 cancellation_reason = $2, updated_at = $1::timestamp
             WHERE id = $3 AND tenant_id = $4`,
            [cancelledAt, reason.trim() || null, bookingId, tenant.id],
        );
        await client.query(
            'UPDATE customers SET booking_count = GREATEST(0, booking_count - 1) WHERE id = $1 AND tenant_id = $2',
            [booking.customer_id, tenant.id],
        );
        await client.query(
            'UPDATE reminders SET sent_at = $1::timestamp WHERE booking_id = $2 AND sent_at IS NULL',
            [cancelledAt, bookingId],
        );
        await client.query(
            `INSERT INTO audit_log (id, tenant_id, actor_type, actor_id, action, entity_type, entity_id, details)
             VALUES ($1, $2, 'customer', $3, 'booking.cancelled', 'booking', $4, $5::jsonb)`,
            [ulid(now), tenant.id, grant.customer_id, bookingId, JSON.stringify({ old_status: booking.status })],
        );
        const queuedNotifications = await queueBookingNotifications(client, tenant, bookingId, 'cancellation', { now });
        await client.query('COMMIT');
        const notification = await deliverQueuedBookingNotifications(pool, queuedNotifications);
        return { cancelled: true, booking_id: bookingId, email_sent: notification.email_sent, notification_state: notification.notification_state };
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* The connection may already be gone. */ }
        throw error;
    } finally {
        client.release();
    }
}
