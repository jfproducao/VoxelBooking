import {
    addCalendarDays,
    dayOfWeekMondayZero,
    hasWallTime,
    localNow,
    minutesFromTime,
    timeFromMinutes,
    utcRange,
} from '../time/venue-time.js';

export class AvailabilityProblem extends Error {
    constructor(code, statusCode = 422) {
        super(code);
        this.code = code;
        this.statusCode = statusCode;
    }
}

async function queryRows(db, sql, values) {
    return (await db.query(sql, values)).rows;
}

async function resolveStaff(db, tenantId, serviceId, selectedStaffId) {
    if (selectedStaffId) {
        const staff = await queryRows(
            db,
            'SELECT id FROM staff WHERE id = $1 AND tenant_id = $2 AND is_active = TRUE LIMIT 1',
            [selectedStaffId, tenantId],
        );
        if (staff.length === 0) throw new AvailabilityProblem('not_found', 404);
        if (serviceId) {
            const links = await queryRows(db, 'SELECT staff_id FROM service_staff WHERE service_id = $1', [serviceId]);
            if (links.length > 0 && !links.some((link) => link.staff_id === selectedStaffId)) {
                throw new AvailabilityProblem('staff_invalid');
            }
        }
        return [selectedStaffId];
    }

    if (serviceId) {
        const linked = await queryRows(
            db,
            `SELECT s.id FROM staff s
             JOIN service_staff ss ON ss.staff_id = s.id
             WHERE ss.service_id = $1 AND s.tenant_id = $2 AND s.is_active = TRUE
             ORDER BY s.sort_order ASC, s.id ASC`,
            [serviceId, tenantId],
        );
        if (linked.length > 0) return linked.map(({ id }) => id);
    }

    const all = await queryRows(
        db,
        'SELECT id FROM staff WHERE tenant_id = $1 AND is_active = TRUE ORDER BY sort_order ASC, id ASC',
        [tenantId],
    );
    return all.map(({ id }) => id);
}

async function availabilityWindows(db, tenantId, staffId, dayOfWeek) {
    if (staffId !== null) {
        const specific = await queryRows(
            db,
            `SELECT start_time, end_time FROM availability
             WHERE tenant_id = $1 AND staff_id = $2 AND day_of_week = $3 AND is_available = TRUE
             ORDER BY start_time ASC`,
            [tenantId, staffId, dayOfWeek],
        );
        const anySpecific = await queryRows(
            db,
            'SELECT EXISTS (SELECT 1 FROM availability WHERE tenant_id = $1 AND staff_id = $2) AS present',
            [tenantId, staffId],
        );
        if (specific.length > 0 || anySpecific[0]?.present) return specific;
    }
    return queryRows(
        db,
        `SELECT start_time, end_time FROM availability
         WHERE tenant_id = $1 AND staff_id IS NULL AND day_of_week = $2 AND is_available = TRUE
         ORDER BY start_time ASC`,
        [tenantId, dayOfWeek],
    );
}

export async function getTimeslotAvailability(db, tenant, {
    date,
    serviceId = null,
    staffId = null,
    excludeBookingId = null,
    durationOverride = null,
    now = Date.now(),
} = {}) {
    const tenantId = tenant.id;
    let duration = Number(tenant.slot_duration_minutes ?? 30);
    if (serviceId) {
        const services = await queryRows(
            db,
            'SELECT duration_minutes FROM services WHERE id = $1 AND tenant_id = $2 AND is_active = TRUE LIMIT 1',
            [serviceId, tenantId],
        );
        if (services.length === 0) throw new AvailabilityProblem('not_found', 404);
        duration = Number(services[0].duration_minutes);
    }
    if (durationOverride !== null) duration = Math.max(1, Number(durationOverride));

    const tenantBlock = await queryRows(
        db,
        `SELECT EXISTS (
            SELECT 1 FROM blocked_dates
            WHERE tenant_id = $1 AND staff_id IS NULL AND resource_id IS NULL
              AND start_date <= $2 AND end_date >= $2
        ) AS blocked`,
        [tenantId, date],
    );
    if (tenantBlock[0]?.blocked) return [];

    const zone = tenant.timezone || 'UTC';
    const current = localNow(zone, now);
    const earliest = now + Number(tenant.min_advance_hours ?? 1) * 3_600_000;
    const lastDate = addCalendarDays(current.date, Number(tenant.max_advance_days ?? 90));
    if (date > lastDate) return [];

    let eligibleStaff = await resolveStaff(db, tenantId, serviceId, staffId);
    if (eligibleStaff.length === 0) {
        if (staffId !== null) return [];
        eligibleStaff = [null];
    }

    const allSlots = [];
    for (const currentStaffId of eligibleStaff) {
        if (currentStaffId !== null) {
            const blocked = await queryRows(
                db,
                `SELECT EXISTS (
                    SELECT 1 FROM blocked_dates
                    WHERE tenant_id = $1 AND staff_id = $2 AND start_date <= $3 AND end_date >= $3
                ) AS blocked`,
                [tenantId, currentStaffId, date],
            );
            if (blocked[0]?.blocked) continue;
        }

        const windows = await availabilityWindows(db, tenantId, currentStaffId, dayOfWeekMondayZero(date));
        if (windows.length === 0) continue;

        const bookingParameters = [tenantId, date, excludeBookingId, excludeBookingId];
        let staffClause = '';
        if (currentStaffId !== null) {
            bookingParameters.push(currentStaffId);
            staffClause = ` AND staff_id = $${bookingParameters.length}`;
        }
        const bookings = await queryRows(
            db,
            `SELECT start_datetime, end_datetime FROM bookings
             WHERE tenant_id = $1 AND status IN ('confirmed', 'rescheduled')
               AND (status <> 'rescheduled' OR NULLIF(rescheduled_to_id, '') IS NULL)
               AND start_datetime::date = $2::date
               AND ($3::char(26) IS NULL OR id <> $4::char(26))${staffClause}`,
            bookingParameters,
        );

        for (const window of windows) {
            const startOfWindow = minutesFromTime(String(window.start_time));
            const endOfWindow = minutesFromTime(String(window.end_time));
            const step = Math.max(1, Number(tenant.slot_duration_minutes ?? 30));
            for (let startMinute = startOfWindow; startMinute + duration <= endOfWindow; startMinute += step) {
                const endMinute = startMinute + duration;
                const startTime = timeFromMinutes(startMinute);
                const endTime = timeFromMinutes(endMinute);
                if (!hasWallTime(date, startTime, zone)) continue;
                if (Date.parse(utcRange(date, startTime, date, startTime, zone).start_utc) < earliest) continue;

                const overlaps = bookings.some((booking) => {
                    const bookingStart = minutesFromTime(String(booking.start_datetime).slice(11, 16));
                    const bookingEnd = minutesFromTime(String(booking.end_datetime).slice(11, 16));
                    const buffer = Number(tenant.buffer_minutes ?? 0);
                    return startMinute < bookingEnd + buffer && endMinute + buffer > bookingStart;
                });
                if (!overlaps) allSlots.push({ time: startTime, end_time: endTime, staff_id: currentStaffId });
            }
        }
    }

    let slots = allSlots;
    if (staffId === null && eligibleStaff.length > 1) {
        const seen = new Set();
        slots = allSlots.filter((slot) => {
            if (seen.has(slot.time)) return false;
            seen.add(slot.time);
            return true;
        });
    }
    return slots.sort((left, right) => left.time.localeCompare(right.time));
}

export async function getTimeslotAvailableDates(db, tenant, {
    year, month, serviceId = null, staffId = null, excludeBookingId = null,
    durationOverride = null, now = Date.now(),
}) {
    const dayCount = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const dates = [];
    for (let day = 1; day <= dayCount; day++) {
        const date = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        if ((await getTimeslotAvailability(db, tenant, {
            date, serviceId, staffId, excludeBookingId, durationOverride, now,
        })).length > 0) dates.push(date);
    }
    return dates;
}
