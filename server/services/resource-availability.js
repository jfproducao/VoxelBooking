import { addCalendarDays, daysInMonth, isValidDate, localNow } from '../time/venue-time.js';

export class ResourceAvailabilityProblem extends Error {
    constructor(code, statusCode = 422) {
        super(code);
        this.code = code;
        this.statusCode = statusCode;
    }
}

const DAY_MS = 86_400_000;

function dayRules(value) {
    let decoded = value;
    if (typeof decoded === 'string') {
        try { decoded = JSON.parse(decoded); } catch { decoded = null; }
    }
    if (!Array.isArray(decoded) || decoded.length === 0) return null;
    return decoded.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
}

async function findResource(db, tenantId, resourceId) {
    const { rows } = await db.query(
        'SELECT id,name,capacity,price_per_night,min_stay_nights,max_stay_nights,check_in_days,check_out_days FROM resources WHERE id=$1 AND tenant_id=$2 AND is_active=TRUE LIMIT 1',
        [resourceId, tenantId],
    );
    return rows[0] ?? null;
}

async function blockedRanges(db, tenantId, resourceId, startDate, endDate) {
    const { rows } = await db.query(
        `SELECT start_date,end_date FROM blocked_dates
         WHERE tenant_id=$1 AND ((resource_id=$2) OR (resource_id IS NULL AND staff_id IS NULL))
           AND start_date <= $3::date AND end_date >= $4::date ORDER BY start_date ASC`,
        [tenantId, resourceId, endDate, startDate],
    );
    return rows.map((row) => ({ start: String(row.start_date).slice(0, 10), end: String(row.end_date).slice(0, 10) }));
}

function isBlocked(date, ranges) {
    return ranges.some((range) => date >= range.start && date <= range.end);
}

function calendarDay(date) {
    return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function nightsBetween(checkIn, checkOut) {
    return Math.round((Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / DAY_MS);
}

function cents(value) {
    const match = String(value).trim().match(/^(-?)(\d+)(?:\.(\d*))?$/);
    if (!match) throw new Error('Invalid price value in database.');
    const result = BigInt(match[2]) * 100n + BigInt((match[3] || '').slice(0, 2).padEnd(2, '0') || '0');
    return match[1] === '-' ? -result : result;
}

function money(value) {
    const negative = value < 0n;
    const absolute = negative ? -value : value;
    return `${negative ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

async function getSeasonalPrices(db, tenantId, resourceId, checkIn, checkOut) {
    const { rows } = await db.query(
        `SELECT start_date,end_date,price_per_night,label FROM seasonal_pricing
         WHERE tenant_id=$1 AND resource_id=$2 AND start_date <= $3::date AND end_date >= $4::date
         ORDER BY start_date ASC`,
        [tenantId, resourceId, checkOut, checkIn],
    );
    return rows.map((row) => ({
        start: String(row.start_date).slice(0, 10), end: String(row.end_date).slice(0, 10),
        price: String(row.price_per_night), label: row.label ?? null,
    }));
}

export async function quoteResourceStay(db, tenant, resourceId, checkIn, checkOut, guestCount = 1, {
    excludeBookingId = null, now = Date.now(), ignoreAdvanceWindow = false,
} = {}) {
    if (!isValidDate(checkIn) || !isValidDate(checkOut)) return { available: false, error: 'invalid_date_range', nights: 0, total: null, pricing: [], resource: null };
    const resource = await findResource(db, tenant.id, resourceId);
    if (!resource) return { available: false, error: 'resource_not_found', nights: 0, total: null, pricing: [], resource: null };

    const fail = (error) => ({ available: false, error, nights: 0, total: null, pricing: [], resource: null });
    if (checkOut <= checkIn) return fail('invalid_date_range');
    const nights = nightsBetween(checkIn, checkOut);
    if (nights < Number(resource.min_stay_nights ?? 1)) return fail('min_stay_violation');
    if (nights > Number(resource.max_stay_nights ?? 30)) return fail('max_stay_violation');
    if (!Number.isInteger(guestCount) || guestCount < 1 || guestCount > 10_000) return fail('invalid_party_size');
    if (guestCount > Number(resource.capacity)) return fail('capacity_exceeded');

    const checkInDays = dayRules(resource.check_in_days);
    const checkOutDays = dayRules(resource.check_out_days);
    if (checkInDays && !checkInDays.includes(calendarDay(checkIn))) return fail('invalid_check_in_day');
    if (checkOutDays && !checkOutDays.includes(calendarDay(checkOut))) return fail('invalid_check_out_day');

    const timezone = tenant.timezone || 'UTC';
    const current = localNow(timezone, now);
    if (!ignoreAdvanceWindow) {
        const earliest = localNow(timezone, now + Number(tenant.min_advance_hours ?? 1) * 3_600_000).date;
        if (checkIn < earliest) return fail('too_soon');
        const latest = addCalendarDays(current.date, Number(tenant.max_advance_days ?? 90));
        if (checkIn > latest) return fail('too_far');
    }

    const ranges = await blockedRanges(db, tenant.id, resourceId, checkIn, checkOut);
    for (let date = checkIn; date < checkOut; date = addCalendarDays(date, 1)) {
        if (isBlocked(date, ranges)) return fail('date_blocked');
    }
    const conflicts = await db.query(
        `SELECT id FROM bookings WHERE tenant_id=$1 AND resource_id=$2
           AND status IN ('confirmed','rescheduled')
           AND (status <> 'rescheduled' OR NULLIF(rescheduled_to_id,'') IS NULL)
           AND ($3::char(26) IS NULL OR id <> $3::char(26))
           AND start_datetime < $4::timestamp AND end_datetime > $5::timestamp LIMIT 1`,
        [tenant.id, resourceId, excludeBookingId, `${checkOut} 00:00:00`, `${checkIn} 00:00:00`],
    );
    if (conflicts.rowCount > 0) return fail('already_booked');

    const seasonal = await getSeasonalPrices(db, tenant.id, resourceId, checkIn, checkOut);
    const pricing = [];
    let total = 0n;
    let fullyPriced = true;
    for (let date = checkIn; date < checkOut; date = addCalendarDays(date, 1)) {
        const season = seasonal.find((entry) => date >= entry.start && date <= entry.end);
        const price = season?.price ?? (resource.price_per_night === null ? null : String(resource.price_per_night));
        pricing.push({ date, price: price === null ? null : money(cents(price)), label: season?.label ?? null });
        if (price === null) fullyPriced = false;
        else total += cents(price);
    }
    return {
        available: true,
        error: null,
        nights,
        total: fullyPriced ? money(total) : null,
        pricing,
        resource: { id: resource.id, name: resource.name, capacity: Number(resource.capacity) },
    };
}

export async function getResourceAvailableDates(db, tenant, resourceId, year, month, {
    excludeBookingId = null, now = Date.now(),
} = {}) {
    const resource = await findResource(db, tenant.id, resourceId);
    if (!resource) throw new ResourceAvailabilityProblem('not_found', 404);
    const first = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
    const last = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(daysInMonth(year, month)).padStart(2, '0')}`;
    const timezone = tenant.timezone || 'UTC';
    const current = localNow(timezone, now);
    const lastBookable = addCalendarDays(current.date, Number(tenant.max_advance_days ?? 90));

    const [ranges, bookingRows] = await Promise.all([
        blockedRanges(db, tenant.id, resourceId, first, last),
        db.query(
            `SELECT start_datetime,end_datetime FROM bookings WHERE tenant_id=$1 AND resource_id=$2
               AND status IN ('confirmed','rescheduled')
               AND (status <> 'rescheduled' OR NULLIF(rescheduled_to_id,'') IS NULL)
               AND ($3::char(26) IS NULL OR id <> $3::char(26))
               AND start_datetime < ($4::date + INTERVAL '1 day') AND end_datetime > $5::date`,
            [tenant.id, resourceId, excludeBookingId, last, first],
        ),
    ]);
    const booked = new Set();
    for (const booking of bookingRows.rows) {
        const start = String(booking.start_datetime).slice(0, 10);
        const end = String(booking.end_datetime).slice(0, 10);
        for (let date = start > first ? start : first; date < end && date <= last; date = addCalendarDays(date, 1)) booked.add(date);
    }

    const dates = [];
    for (let day = 1; day <= daysInMonth(year, month); day++) {
        const date = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        if (date < current.date || date > lastBookable || booked.has(date) || isBlocked(date, ranges)) continue;
        dates.push(date);
    }
    return {
        dates,
        year,
        month,
        check_in_days: dayRules(resource.check_in_days),
        check_out_days: dayRules(resource.check_out_days),
    };
}
