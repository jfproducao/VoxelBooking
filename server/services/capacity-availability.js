import {
    addCalendarDays, dayOfWeekMondayZero, hasWallTime, isValidDate, localNow, utcRange,
} from '../time/venue-time.js';

function time(value) { return String(value).slice(0, 8); }

function dateTime(date, value) { return `${date} ${time(value)}`; }

function withinWindow(tenant, date, slotTime, now) {
    const timezone = tenant.timezone || 'UTC';
    const current = localNow(timezone, now);
    const target = Date.parse(utcRange(date, time(slotTime), date, time(slotTime), timezone).start_utc);
    const earliest = now + Number(tenant.min_advance_hours ?? 1) * 3_600_000;
    const latestDate = addCalendarDays(current.date, Number(tenant.max_advance_days ?? 90));
    const latest = Date.parse(utcRange(latestDate, '23:59', latestDate, '23:59', timezone).start_utc) + 59_000;
    return target > now && target >= earliest && target <= latest;
}

async function blockedDates(db, tenantId, start, end) {
    const { rows } = await db.query(
        `SELECT start_date,end_date FROM blocked_dates
         WHERE tenant_id=$1 AND resource_id IS NULL AND staff_id IS NULL
           AND start_date <= $2::date AND end_date >= $3::date`,
        [tenantId, end, start],
    );
    return rows.map((row) => ({ start: String(row.start_date).slice(0, 10), end: String(row.end_date).slice(0, 10) }));
}

function blocked(date, ranges) { return ranges.some((range) => date >= range.start && date <= range.end); }

async function bookedMap(db, tenantId, start, end, excludeBookingId = null) {
    const { rows } = await db.query(
        `SELECT start_datetime::date AS booking_date,to_char(start_datetime,'HH24:MI:SS') AS slot_time,
                SUM(party_size)::int AS booked
         FROM bookings WHERE tenant_id=$1 AND booking_pattern='capacity'
           AND start_datetime >= $2::date AND start_datetime < ($3::date + INTERVAL '1 day')
           AND status IN ('confirmed','rescheduled')
           AND (status <> 'rescheduled' OR NULLIF(rescheduled_to_id,'') IS NULL)
           AND ($4::char(26) IS NULL OR id <> $4::char(26))
         GROUP BY start_datetime::date,to_char(start_datetime,'HH24:MI:SS')`,
        [tenantId, start, end, excludeBookingId],
    );
    return new Map(rows.map((row) => [`${String(row.booking_date).slice(0, 10)}|${row.slot_time}`, Number(row.booked)]));
}

async function activeSlots(db, tenantId, dayOfWeek = null) {
    const { rows } = await db.query(
        `SELECT id,day_of_week,start_time,end_time,max_capacity,min_party_size,max_party_size,label
         FROM capacity_slots WHERE tenant_id=$1 AND is_active=TRUE
           AND ($2::smallint IS NULL OR day_of_week=$2) ORDER BY day_of_week,start_time`,
        [tenantId, dayOfWeek],
    );
    return rows;
}

function enough(slot, date, partySize, booked, tenant, now) {
    const min = Number(slot.min_party_size ?? 1);
    const maxParty = Number(slot.max_party_size);
    const remaining = Number(slot.max_capacity) - booked;
    return partySize >= min && partySize <= maxParty && remaining >= partySize
        && hasWallTime(date, time(slot.start_time).slice(0, 5), tenant.timezone || 'UTC')
        && withinWindow(tenant, date, slot.start_time, now);
}

export async function getCapacitySlots(db, tenant, date, partySize = 1, {
    excludeBookingId = null, now = Date.now(),
} = {}) {
    if (!isValidDate(date)) return [];
    const dayOfWeek = dayOfWeekMondayZero(date);
    const [ranges, slots, booked] = await Promise.all([
        blockedDates(db, tenant.id, date, date), activeSlots(db, tenant.id, dayOfWeek),
        bookedMap(db, tenant.id, date, date, excludeBookingId),
    ]);
    if (blocked(date, ranges)) return [];
    return slots.filter((slot) => enough(slot, date, partySize, booked.get(`${date}|${time(slot.start_time)}`) || 0, tenant, now))
        .map((slot) => ({
            id: slot.id, time: time(slot.start_time).slice(0, 5), end_time: time(slot.end_time).slice(0, 5),
            label: slot.label, remaining: Number(slot.max_capacity) - (booked.get(`${date}|${time(slot.start_time)}`) || 0),
            max: Number(slot.max_capacity), min_party_size: Number(slot.min_party_size ?? 1),
            max_party_size: Number(slot.max_party_size),
            ...utcRange(date, time(slot.start_time).slice(0, 5), date, time(slot.end_time).slice(0, 5), tenant.timezone || 'UTC'),
        }));
}

export async function getCapacityAvailableDates(db, tenant, year, month, partySize = 1, {
    excludeBookingId = null, now = Date.now(),
} = {}) {
    const timezone = tenant.timezone || 'UTC';
    const today = localNow(timezone, now).date;
    const first = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
    const monthEnd = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0')}`;
    const lastBookable = addCalendarDays(today, Number(tenant.max_advance_days ?? 90));
    const start = first > today ? first : today;
    const end = monthEnd < lastBookable ? monthEnd : lastBookable;
    if (start > end) return [];
    const [ranges, slots, booked] = await Promise.all([
        blockedDates(db, tenant.id, start, end), activeSlots(db, tenant.id), bookedMap(db, tenant.id, start, end, excludeBookingId),
    ]);
    const byDay = new Map();
    for (const slot of slots) byDay.set(Number(slot.day_of_week), [...(byDay.get(Number(slot.day_of_week)) || []), slot]);
    const dates = [];
    for (let date = start; date <= end; date = addCalendarDays(date, 1)) {
        if (blocked(date, ranges)) continue;
        if ((byDay.get(dayOfWeekMondayZero(date)) || []).some((slot) =>
            enough(slot, date, partySize, booked.get(`${date}|${time(slot.start_time)}`) || 0, tenant, now))) dates.push(date);
    }
    return dates;
}

export async function checkCapacitySlot(db, tenant, slotId, date, partySize, { now = Date.now(), excludeBookingId = null } = {}) {
    if (!isValidDate(date)) return { available: false, remaining: 0, error: 'invalid_date' };
    const { rows } = await db.query(
        `SELECT id,day_of_week,start_time,end_time,max_capacity,min_party_size,max_party_size,label,is_active
         FROM capacity_slots WHERE id=$1 AND tenant_id=$2 LIMIT 1`, [slotId, tenant.id],
    );
    const slot = rows[0];
    if (!slot || !slot.is_active) return { available: false, remaining: 0, error: 'slot_not_found' };
    if (Number(slot.day_of_week) !== dayOfWeekMondayZero(date) || !hasWallTime(date, time(slot.start_time).slice(0, 5), tenant.timezone || 'UTC')) {
        return { available: false, remaining: 0, error: 'slot_not_on_day' };
    }
    if (!withinWindow(tenant, date, slot.start_time, now)) {
        const current = localNow(tenant.timezone || 'UTC', now);
        return { available: false, remaining: 0, error: date > addCalendarDays(current.date, Number(tenant.max_advance_days ?? 90)) ? 'too_far' : 'too_soon' };
    }
    const ranges = await blockedDates(db, tenant.id, date, date);
    if (blocked(date, ranges)) return { available: false, remaining: 0, error: 'date_blocked' };
    if (partySize < Number(slot.min_party_size ?? 1)) return { available: false, remaining: 0, error: 'party_too_small' };
    if (partySize > Number(slot.max_party_size)) return { available: false, remaining: 0, error: 'party_too_large' };
    const booked = await bookedMap(db, tenant.id, date, date, excludeBookingId);
    const remaining = Number(slot.max_capacity) - (booked.get(`${date}|${time(slot.start_time)}`) || 0);
    if (remaining < partySize) return { available: false, remaining: Math.max(0, remaining), error: 'capacity_exceeded' };
    return { available: true, remaining: remaining - partySize, slot };
}

export { dateTime };
