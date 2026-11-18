import { randomBytes } from 'node:crypto';
import { getTimeslotAvailability } from './timeslot-availability.js';
import { quoteResourceStay } from './resource-availability.js';
import { checkEventAvailability } from './event-availability.js';
import { queueBookingNotifications, deliverQueuedBookingNotifications } from './booking-notifications.js';
import { localDateTime, wallDateTimeToUtc } from '../time/venue-time.js';

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid(now = Date.now()) {
    let value = (BigInt(now) << 80n) | BigInt(`0x${randomBytes(10).toString('hex')}`);
    let result = '';
    for (let i = 0; i < 26; i++) { result = alphabet[Number(value & 31n)] + result; value >>= 5n; }
    return result;
}

function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function bookingTransitions(status) {
    if (['pending', 'waitlisted'].includes(status)) return ['confirmed', 'cancelled'];
    if (status === 'confirmed') return ['cancelled', 'completed', 'no_show'];
    if (['cancelled', 'completed', 'no_show'].includes(status)) return ['confirmed'];
    return [];
}

function filters(query, tenantId = null) {
    const where = [];
    const values = [];
    const bind = (value) => { values.push(value); return `$${values.length}`; };
    if (tenantId) where.push(`b.tenant_id=${bind(tenantId)}`);
    if (query.status && ['pending','confirmed','cancelled','completed','no_show','rescheduled','waitlisted'].includes(query.status)) where.push(`b.status=${bind(query.status)}`);
    if (validDate(query.from)) where.push(`b.start_datetime>=${bind(`${query.from} 00:00:00`)}::timestamp`);
    if (validDate(query.to)) where.push(`b.start_datetime<(${bind(query.to)}::date+INTERVAL '1 day')`);
    if (query.search) {
        const raw = String(query.search).slice(0, 200);
        const escaped = `%${raw.replace(/[!%_]/g, (m) => `!${m}`)}%`;
        where.push(`(COALESCE(b.customer_name_snapshot,c.name) ILIKE ${bind(escaped)} ESCAPE '!' OR COALESCE(b.customer_email_snapshot,c.email) ILIKE ${bind(escaped)} ESCAPE '!' OR b.id=${bind(raw)})`);
    }
    return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', values };
}

const BOOKING_JOINS = `FROM bookings b JOIN tenants t ON t.id=b.tenant_id
    JOIN customers c ON c.id=b.customer_id AND c.tenant_id=b.tenant_id
    LEFT JOIN services s ON s.id=b.service_id AND s.tenant_id=b.tenant_id
    LEFT JOIN staff st ON st.id=b.staff_id AND st.tenant_id=b.tenant_id
    LEFT JOIN resources r ON r.id=b.resource_id AND r.tenant_id=b.tenant_id
    LEFT JOIN events e ON e.id=b.event_id AND e.tenant_id=b.tenant_id`;
const BOOKING_FIELDS = `b.id,b.tenant_id,t.name AS tenant_name,t.slug AS tenant_slug,t.timezone,
    b.booking_pattern,b.status,b.start_datetime,b.end_datetime,b.party_size,b.service_id,b.staff_id,b.resource_id,b.event_id,
    b.notes,b.internal_notes,b.custom_field_data,b.customer_timezone,b.rescheduled_to_id,b.cancelled_at,b.cancellation_reason,
    b.price_total,b.price_currency,b.created_at,b.updated_at,
    COALESCE(b.customer_name_snapshot,c.name) AS customer_name,COALESCE(b.customer_email_snapshot,c.email) AS customer_email,
    COALESCE(b.customer_phone_snapshot,c.phone) AS customer_phone,s.name AS service_name,s.color AS service_color,
    st.name AS staff_name,r.name AS resource_name,e.name AS event_name`;

export async function listAdminBookings(db, query = {}, tenantId = null) {
    const { sql, values } = filters(query, tenantId);
    const count = await db.query(`SELECT COUNT(*)::int AS total ${BOOKING_JOINS} ${sql}`, values);
    const sortColumns = { date: 'b.start_datetime', customer: 'COALESCE(b.customer_name_snapshot,c.name)', service: 'COALESCE(s.name,r.name,e.name)', status: 'b.status' };
    const sort = sortColumns[query.sort] || sortColumns.date;
    const direction = query.direction === 'asc' ? 'ASC' : 'DESC';
    const limit = 25;
    const lastPage = Math.max(1, Math.ceil(Number(count.rows[0]?.total || 0) / limit));
    const page = Math.min(lastPage, Math.max(1, Math.min(1_000_000, Number.parseInt(query.page, 10) || 1)));
    const rows = await db.query(`SELECT ${BOOKING_FIELDS} ${BOOKING_JOINS} ${sql} ORDER BY ${sort} ${direction},b.id ${direction} LIMIT ${limit} OFFSET ${(page - 1) * limit}`, values);
    return { bookings: rows.rows, total: Number(count.rows[0]?.total || 0), page, perPage: limit };
}

export async function getAdminBooking(db, bookingId, tenantId = null) {
    const values = tenantId ? [bookingId, tenantId] : [bookingId];
    const where = tenantId ? 'WHERE b.id=$1 AND b.tenant_id=$2' : 'WHERE b.id=$1';
    const result = await db.query(`SELECT ${BOOKING_FIELDS} ${BOOKING_JOINS} ${where} LIMIT 1`, values);
    if (!result.rows[0]) return null;
    const timeline = await db.query('SELECT action,actor_type,actor_id,details,created_at FROM audit_log WHERE entity_type=$1 AND entity_id=$2 ORDER BY created_at DESC LIMIT 50', ['booking', bookingId]);
    return { ...result.rows[0], timeline: timeline.rows, transitions: bookingTransitions(result.rows[0].status) };
}

async function assertAvailable(client, tenant, booking, now) {
    const date = String(booking.start_datetime).slice(0, 10);
    if (booking.booking_pattern === 'timeslot') {
        const duration = Math.max(1, (Date.parse(`${String(booking.end_datetime).replace(' ', 'T')}Z`) - Date.parse(`${String(booking.start_datetime).replace(' ', 'T')}Z`)) / 60_000);
        let availability;
        try { availability = await getTimeslotAvailability(client, tenant, { date, serviceId: booking.service_id, staffId: booking.staff_id, excludeBookingId: booking.id, durationOverride: duration, now }); }
        catch { throw new AdminBookingProblem('inventory_conflict', 409); }
        const start = String(booking.start_datetime).slice(11, 16); const end = String(booking.end_datetime).slice(11, 16);
        if (!availability.some((slot) => slot.time === start && slot.end_time === end && (!booking.staff_id || slot.staff_id === booking.staff_id))) throw new AdminBookingProblem('inventory_conflict', 409);
    } else if (booking.booking_pattern === 'resource') {
        let quote;
        try { quote = await quoteResourceStay(client, tenant, booking.resource_id, date, String(booking.end_datetime).slice(0, 10), Number(booking.party_size), { excludeBookingId: booking.id, now, ignoreAdvanceWindow: true }); }
        catch { throw new AdminBookingProblem('inventory_conflict', 409); }
        if (!quote.available) throw new AdminBookingProblem('inventory_conflict', 409);
    } else if (booking.booking_pattern === 'capacity') {
        const slotQuery = await client.query('SELECT * FROM capacity_slots WHERE id=$1 AND tenant_id=$2 AND is_active=TRUE LIMIT 1', [booking.capacity_slot_id, tenant.id]);
        const slot = slotQuery.rows[0];
        const localDay = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
        if (!slot || Number(slot.day_of_week) !== localDay || String(slot.start_time).slice(0, 8) !== String(booking.start_datetime).slice(11, 19)
            || String(slot.end_time).slice(0, 8) !== String(booking.end_datetime).slice(11, 19)
            || Number(booking.party_size) < Number(slot.min_party_size) || Number(booking.party_size) > Number(slot.max_party_size)) throw new AdminBookingProblem('inventory_conflict', 409);
        const blocked = await client.query('SELECT 1 FROM blocked_dates WHERE tenant_id=$1 AND staff_id IS NULL AND resource_id IS NULL AND start_date<=$2::date AND end_date>=$2::date LIMIT 1', [tenant.id, date]);
        const used = await client.query(`SELECT COALESCE(SUM(party_size),0)::int AS amount FROM bookings WHERE tenant_id=$1 AND booking_pattern='capacity' AND start_datetime=$2::timestamp AND id<>$3 AND (status IN ('confirmed','rescheduled') AND (status<>'rescheduled' OR NULLIF(rescheduled_to_id,'') IS NULL))`, [tenant.id, booking.start_datetime, booking.id]);
        if (blocked.rows[0] || Number(used.rows[0]?.amount || 0) + Number(booking.party_size) > Number(slot.max_capacity)) throw new AdminBookingProblem('inventory_conflict', 409);
    } else if (booking.booking_pattern === 'event') {
        let check;
        try { check = await checkEventAvailability(client, tenant, booking.event_id, date, Number(booking.party_size), { excludeBookingId: booking.id, now }); }
        catch { throw new AdminBookingProblem('inventory_conflict', 409); }
        if (!check.available || check.waitlisted || check.event?.start_datetime !== booking.start_datetime || check.event?.end_datetime !== booking.end_datetime) throw new AdminBookingProblem('inventory_conflict', 409);
    } else throw new AdminBookingProblem('pattern_not_supported', 422);
}

export class AdminBookingProblem extends Error {
    constructor(code, statusCode = 409) { super(code); this.code = code; this.statusCode = statusCode; }
}

export async function changeAdminBookingStatus(pool, { bookingId, tenantId = null, status, actor, ip = null, now = Date.now() }) {
    if (!['pending','confirmed','cancelled','completed','no_show','rescheduled','waitlisted'].includes(status)) throw new AdminBookingProblem('invalid_status', 422);
    const client = await pool.connect();
    let queued;
    try {
        await client.query('BEGIN');
        const bookingResult = await client.query(`SELECT b.*
            FROM bookings b JOIN tenants t ON t.id=b.tenant_id WHERE b.id=$1 ${tenantId ? 'AND b.tenant_id=$2' : ''} FOR UPDATE OF t,b`, tenantId ? [bookingId, tenantId] : [bookingId]);
        const booking = bookingResult.rows[0];
        if (!booking) throw new AdminBookingProblem('booking_not_found', 404);
        const tenantResult = await client.query('SELECT * FROM tenants WHERE id=$1 LIMIT 1', [booking.tenant_id]);
        const tenant = tenantResult.rows[0];
        if (status === booking.status) { await client.query('COMMIT'); return { booking_id: bookingId, status }; }
        if (!bookingTransitions(booking.status).includes(status)) throw new AdminBookingProblem('invalid_transition', 409);
        if (status === 'confirmed') await assertAvailable(client, tenant, booking, now);
        const when = new Date(now).toISOString().slice(0, 19).replace('T', ' ');
        if (status === 'cancelled') {
            await client.query("UPDATE bookings SET status='cancelled',cancelled_at=$1::timestamp,cancellation_reason=NULL,updated_at=$1::timestamp WHERE id=$2 AND tenant_id=$3", [when, bookingId, booking.tenant_id]);
            await client.query('UPDATE customers SET booking_count=GREATEST(0,booking_count-1) WHERE id=$1 AND tenant_id=$2', [booking.customer_id, booking.tenant_id]);
            await client.query('UPDATE reminders SET sent_at=$1::timestamp WHERE booking_id=$2 AND sent_at IS NULL', [when, bookingId]);
            queued = await queueBookingNotifications(client, tenant, bookingId, 'cancellation', { now });
        } else {
            await client.query('UPDATE bookings SET status=$1,cancelled_at=NULL,cancellation_reason=NULL,updated_at=$2::timestamp WHERE id=$3 AND tenant_id=$4', [status, when, bookingId, booking.tenant_id]);
            if (booking.status === 'cancelled') await client.query('UPDATE customers SET booking_count=booking_count+1 WHERE id=$1 AND tenant_id=$2', [booking.customer_id, booking.tenant_id]);
            if (status !== 'confirmed') await client.query('UPDATE reminders SET sent_at=$1::timestamp WHERE booking_id=$2 AND sent_at IS NULL', [when, bookingId]);
            if (status === 'confirmed' && ['pending','waitlisted'].includes(booking.status)) queued = await queueBookingNotifications(client, tenant, bookingId, 'created', { now });
            if (status === 'confirmed' && tenant.send_reminders) {
                const start = String(booking.start_datetime).slice(0, 19); const zone = tenant.timezone || 'UTC';
                const instant = Date.parse(wallDateTimeToUtc(start.slice(0,10), start.slice(11,16), zone)) - Math.max(1, Number(tenant.reminder_hours_before || 24)) * 3_600_000;
                if (instant > now) {
                    const pending = await client.query('SELECT 1 FROM reminders WHERE booking_id=$1 AND sent_at IS NULL LIMIT 1', [bookingId]);
                    if (!pending.rows[0]) await client.query('INSERT INTO reminders (id,booking_id,tenant_id,scheduled_at) VALUES ($1,$2,$3,$4::timestamp)', [ulid(now), bookingId, booking.tenant_id, localDateTime(instant, zone)]);
                }
            }
        }
        await client.query('INSERT INTO audit_log (id,tenant_id,actor_type,actor_id,action,entity_type,entity_id,details,ip_address) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)',
            [ulid(now), booking.tenant_id, actor.type, actor.id, status === 'cancelled' ? 'booking.cancelled' : 'booking.status_changed', 'booking', bookingId,
                JSON.stringify({ old_status: booking.status, new_status: status }), ip]);
        await client.query('COMMIT');
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve the original failure. */ }
        throw error;
    } finally { client.release(); }
    const notifications = queued ? await deliverQueuedBookingNotifications(pool, queued) : { email_sent: false, notification_state: 'none' };
    return { booking_id: bookingId, status, ...notifications };
}

