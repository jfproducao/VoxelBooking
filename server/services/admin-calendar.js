import { localNow } from '../time/venue-time.js';

function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function addDays(value, days) {
    const date = new Date(`${value}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}
function firstOfMonth(value) { return `${value.slice(0, 7)}-01`; }
function monthMove(value, delta) {
    const date = new Date(`${firstOfMonth(value)}T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + delta);
    return date.toISOString().slice(0, 10);
}
function mondayZero(date) { return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7; }

function calendarWindow(view, date, weekStart) {
    if (view === 'day') return { from: date, to: date };
    if (view === 'month') {
        const first = firstOfMonth(date);
        const sundayZero = new Date(`${first}T00:00:00Z`).getUTCDay();
        const daysBack = (sundayZero - weekStart + 7) % 7;
        const from = addDays(first, -daysBack);
        return { from, to: addDays(from, 41) };
    }
    const sundayZero = new Date(`${date}T00:00:00Z`).getUTCDay();
    const daysBack = (sundayZero - weekStart + 7) % 7;
    const from = addDays(date, -daysBack);
    return { from, to: addDays(from, 6) };
}

function occupiedBookings(bookings, from, to) {
    const byDate = new Map();
    for (const booking of bookings) {
        const start = String(booking.start_datetime).slice(0, 10);
        const end = String(booking.end_datetime).slice(0, 19);
        const endDate = end.slice(0, 10);
        const endIsMidnight = end.slice(11) === '00:00:00';
        const last = endIsMidnight ? addDays(endDate, -1) : endDate;
        const firstDay = start < from ? from : start;
        const lastDay = last > to ? to : last;
        if (lastDay < firstDay) continue;
        for (let date = firstDay; date <= lastDay; date = addDays(date, 1)) {
            const list = byDate.get(date) || [];
            list.push(booking); byDate.set(date, list);
        }
    }
    return byDate;
}

export async function loadAdminCalendar(db, tenantId, { view = 'month', date: requestedDate } = {}) {
    if (!['day', 'week', 'month'].includes(view)) return null;
    const tenantResult = await db.query('SELECT id,name,timezone,week_start,booking_pattern FROM tenants WHERE id=$1 LIMIT 1', [tenantId]);
    const tenant = tenantResult.rows[0];
    if (!tenant) return null;
    const timezone = tenant.timezone || 'UTC';
    const today = localNow(timezone).date;
    const date = validDate(requestedDate) ? requestedDate : today;
    const weekStart = Number.isInteger(Number(tenant.week_start)) && Number(tenant.week_start) >= 0 && Number(tenant.week_start) <= 6 ? Number(tenant.week_start) : 1;
    const { from, to } = calendarWindow(view, date, weekStart);

    const bookingRows = await db.query(`SELECT b.id,b.tenant_id,b.booking_pattern,b.status,b.start_datetime,b.end_datetime,b.party_size,b.service_id,b.staff_id,b.resource_id,b.event_id,
        COALESCE(b.customer_name_snapshot,c.name) AS customer_name,COALESCE(b.customer_email_snapshot,c.email) AS customer_email,
        s.name AS service_name,st.name AS staff_name,r.name AS resource_name,e.name AS event_name
        FROM bookings b JOIN customers c ON c.id=b.customer_id AND c.tenant_id=b.tenant_id
        LEFT JOIN services s ON s.id=b.service_id AND s.tenant_id=b.tenant_id
        LEFT JOIN staff st ON st.id=b.staff_id AND st.tenant_id=b.tenant_id
        LEFT JOIN resources r ON r.id=b.resource_id AND r.tenant_id=b.tenant_id
        LEFT JOIN events e ON e.id=b.event_id AND e.tenant_id=b.tenant_id
        WHERE b.tenant_id=$1 AND b.status<>'cancelled' AND (b.status<>'rescheduled' OR NULLIF(b.rescheduled_to_id,'') IS NULL)
          AND b.end_datetime>$2::timestamp AND b.start_datetime<($3::date+INTERVAL '1 day')
        ORDER BY b.start_datetime,b.id`, [tenantId, `${from} 00:00:00`, to]);
    const blockedRows = await db.query(`SELECT start_date,end_date FROM blocked_dates
        WHERE tenant_id=$1 AND staff_id IS NULL AND resource_id IS NULL AND start_date<=$3::date AND end_date>=$2::date
        ORDER BY start_date,id`, [tenantId, from, to]);
    let availableDays;
    if (tenant.booking_pattern === 'capacity') {
        const slots = await db.query('SELECT DISTINCT day_of_week FROM capacity_slots WHERE tenant_id=$1 AND is_active=TRUE', [tenantId]);
        availableDays = new Set(slots.rows.map((row) => Number(row.day_of_week)));
    } else {
        const hours = await db.query('SELECT DISTINCT day_of_week FROM availability WHERE tenant_id=$1 AND staff_id IS NULL AND is_available=TRUE', [tenantId]);
        availableDays = new Set(hours.rows.map((row) => Number(row.day_of_week)));
    }
    const blocked = new Set();
    for (const range of blockedRows.rows) {
        const start = String(range.start_date).slice(0, 10) < from ? from : String(range.start_date).slice(0, 10);
        const end = String(range.end_date).slice(0, 10) > to ? to : String(range.end_date).slice(0, 10);
        for (let current = start; current <= end; current = addDays(current, 1)) blocked.add(current);
    }
    const grouped = occupiedBookings(bookingRows.rows, from, to);
    const days = [];
    for (let current = from; current <= to; current = addDays(current, 1)) {
        days.push({ date: current, day: Number(current.slice(8, 10)), inMonth: current.slice(0, 7) === date.slice(0, 7), isToday: current === today,
            open: availableDays.has(mondayZero(current)), blocked: blocked.has(current), bookings: grouped.get(current) || [] });
    }
    const prev = view === 'month' ? monthMove(date, -1) : addDays(from, view === 'week' ? -7 : -1);
    const next = view === 'month' ? monthMove(date, 1) : addDays(from, view === 'week' ? 7 : 1);
    return { tenant, view, date, today, from, to, weekStart, prev, next, days, bookings: bookingRows.rows };
}

