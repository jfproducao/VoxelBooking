import rrule from 'rrule';
import { addCalendarDays, hasWallTime, isValidDate, localNow, utcRange, wallDateTimeToUtc } from '../time/venue-time.js';

const { rrulestr } = rrule;

function localParts(value) {
    const normalized = String(value).replace('T', ' ');
    return { date: normalized.slice(0, 10), time: normalized.slice(11, 19) || '00:00:00' };
}

function pseudoUtc(date, time = '00:00:00') { return new Date(`${date}T${time}Z`); }

function jsonArray(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; } }
    return [];
}

function occurrences(event, from, to) {
    const start = localParts(event.start_datetime);
    if (!event.is_recurring || !event.rrule) return start.date >= from && start.date <= to ? [start.date] : [];
    try {
        const rule = rrulestr(String(event.rrule), { dtstart: pseudoUtc(start.date, start.time) });
        return rule.between(pseudoUtc(from), pseudoUtc(to, '23:59:59'), true).map((date) => date.toISOString().slice(0, 10));
    } catch { return []; }
}

function eventRange(event, date, timezone) {
    const start = localParts(event.start_datetime);
    const end = localParts(event.end_datetime);
    const offset = Math.round((Date.parse(`${end.date}T00:00:00Z`) - Date.parse(`${start.date}T00:00:00Z`)) / 86_400_000);
    const endDate = addCalendarDays(date, offset);
    return {
        start: `${date} ${start.time}`,
        end: `${endDate} ${end.time}`,
        ...utcRange(date, start.time.slice(0, 5), endDate, end.time.slice(0, 5), timezone),
    };
}

function publicEvent(event, date, timezone, booked = 0, waitlisted = 0) {
    const range = eventRange(event, date, timezone);
    const max = Number(event.max_participants);
    const remaining = Math.max(0, max - booked);
    return {
        id: event.id, name: event.name, description: event.description, location: event.location,
        price: event.price === null ? null : String(event.price), start_datetime: range.start, end_datetime: range.end,
        date, start_time: range.start.slice(11, 16), end_time: range.end.slice(11, 16),
        max_participants: max, min_spot_count: Number(event.min_spot_count ?? 1),
        max_spot_count: event.max_spot_count === null ? null : Number(event.max_spot_count),
        allow_waitlist: Boolean(event.allow_waitlist), waitlist_max: Number(event.waitlist_max ?? 0),
        remaining, waitlist_count: waitlisted, is_full: remaining === 0,
        can_waitlist: remaining === 0 && Boolean(event.allow_waitlist) && waitlisted < Number(event.waitlist_max ?? 0),
        start_utc: range.start_utc, end_utc: range.end_utc,
    };
}

async function eventRow(db, tenantId, eventId) {
    const { rows } = await db.query(
        'SELECT * FROM events WHERE tenant_id=$1 AND id=$2 AND is_active=TRUE LIMIT 1', [tenantId, eventId],
    );
    return rows[0] ?? null;
}

async function counts(db, tenantId, eventId, date, excludeBookingId = null) {
    const { rows } = await db.query(
        `SELECT
            COALESCE(SUM(party_size) FILTER (WHERE status IN ('confirmed','rescheduled')
              AND (status <> 'rescheduled' OR NULLIF(rescheduled_to_id,'') IS NULL)),0)::int AS booked,
            COALESCE(SUM(party_size) FILTER (WHERE status='waitlisted'),0)::int AS waitlisted
         FROM bookings WHERE tenant_id=$1 AND event_id=$2 AND booking_pattern='event'
           AND start_datetime::date=$3::date AND ($4::char(26) IS NULL OR id<>$4::char(26))`,
        [tenantId, eventId, date, excludeBookingId],
    );
    return { booked: Number(rows[0]?.booked ?? 0), waitlisted: Number(rows[0]?.waitlisted ?? 0) };
}

export async function listEventOccurrences(db, tenant, { date = null, month = null, eventId = null, excludeBookingId = null, limit = 101, offset = 0, snapshot = null, now = Date.now() } = {}) {
    const timezone = tenant.timezone || 'UTC';
    const current = localNow(timezone, now);
    const requestedFrom = date ?? (month ? `${month}-01` : current.date);
    const requestedTo = date ?? (month ? `${month}-${String(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')}`
        : addCalendarDays(current.date, Number(tenant.max_advance_days ?? 90)));
    if (!isValidDate(requestedFrom) || !isValidDate(requestedTo) || requestedTo < requestedFrom) return [];
    const from = requestedFrom < current.date ? current.date : requestedFrom;
    const horizon = addCalendarDays(current.date, Number(tenant.max_advance_days ?? 90));
    const to = requestedTo > horizon ? horizon : requestedTo;
    if (to < from) return [];
    const { rows: events } = await db.query(
        `SELECT * FROM events WHERE tenant_id=$1 AND is_active=TRUE
           AND ($2::char(26) IS NULL OR id <= $2::char(26))
           AND ($3::char(26) IS NULL OR id=$3::char(26)) ORDER BY start_datetime,id`, [tenant.id, snapshot, eventId],
    );
    const candidates = [];
    for (const event of events) {
        const exceptions = new Set(jsonArray(event.exception_dates).map(String));
        for (const eventDate of occurrences(event, from, to)) {
            const start = localParts(event.start_datetime);
            if (exceptions.has(eventDate) || !hasWallTime(eventDate, start.time.slice(0, 5), timezone)) continue;
            const range = eventRange(event, eventDate, timezone);
            if (Date.parse(range.start_utc) < now) continue;
            candidates.push({ event, date: eventDate, start: range.start });
        }
    }
    candidates.sort((a, b) => a.start.localeCompare(b.start) || a.event.id.localeCompare(b.event.id));
    const selected = candidates.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(1, Math.min(501, limit)));
    const result = [];
    for (const candidate of selected) {
        const { booked, waitlisted } = await counts(db, tenant.id, candidate.event.id, candidate.date, excludeBookingId);
        result.push(publicEvent(candidate.event, candidate.date, timezone, booked, waitlisted));
    }
    return result;
}

export async function getEventDetail(db, tenant, eventId, date = null, { now = Date.now(), excludeBookingId = null } = {}) {
    const event = await eventRow(db, tenant.id, eventId);
    if (!event) return null;
    const original = localParts(event.start_datetime);
    const selectedDate = date || original.date;
    if (!isValidDate(selectedDate)) return null;
    const exceptions = new Set(jsonArray(event.exception_dates).map(String));
    if (exceptions.has(selectedDate) || !occurrences(event, selectedDate, selectedDate).includes(selectedDate)) return null;
    const start = localParts(event.start_datetime);
    if (!hasWallTime(selectedDate, start.time.slice(0, 5), tenant.timezone || 'UTC')) return null;
    const range = eventRange(event, selectedDate, tenant.timezone || 'UTC');
    if (Date.parse(range.start_utc) < now) return null;
    const { booked, waitlisted } = await counts(db, tenant.id, eventId, selectedDate, excludeBookingId);
    return publicEvent(event, selectedDate, tenant.timezone || 'UTC', booked, waitlisted);
}

export async function checkEventAvailability(db, tenant, eventId, date, spotCount, { excludeBookingId = null, now = Date.now() } = {}) {
    const event = await eventRow(db, tenant.id, eventId);
    if (!event) return { available: false, waitlisted: false, remaining: 0, error: 'event_not_found', event: null };
    const instance = await getEventDetail(db, tenant, eventId, date, { now, excludeBookingId });
    if (!instance) return { available: false, waitlisted: false, remaining: 0, error: 'invalid_date', event };
    const min = Number(event.min_spot_count ?? 1);
    const max = event.max_spot_count === null ? Infinity : Number(event.max_spot_count);
    if (spotCount < min) return { available: false, waitlisted: false, remaining: instance.remaining, error: 'spot_count_too_few', event: instance };
    if (spotCount > max) return { available: false, waitlisted: false, remaining: instance.remaining, error: 'spot_count_too_many', event: instance };
    const { booked, waitlisted } = await counts(db, tenant.id, eventId, date, excludeBookingId);
    const remaining = Math.max(0, Number(event.max_participants) - booked);
    if (remaining >= spotCount) return { available: true, waitlisted: false, remaining: remaining - spotCount, error: null, event: instance };
    if (event.allow_waitlist) {
        if (waitlisted + spotCount <= Number(event.waitlist_max ?? 0)) return { available: true, waitlisted: true, remaining: 0, error: null, event: instance };
        return { available: false, waitlisted: false, remaining: 0, error: 'waitlist_full', event: instance };
    }
    return { available: false, waitlisted: false, remaining, error: 'event_full', event: instance };
}

export function eventBookingWindowError(tenant, date, time, now = Date.now()) {
    const start = Date.parse(wallDateTimeToUtc(date, time, tenant.timezone || 'UTC'));
    if (start <= now || start < now + Number(tenant.min_advance_hours ?? 1) * 3_600_000) return 'too_soon';
    const today = localNow(tenant.timezone || 'UTC', now).date;
    if (date > addCalendarDays(today, Number(tenant.max_advance_days ?? 90))) return 'too_far';
    return null;
}
