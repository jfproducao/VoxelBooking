const formatterCache = new Map();
const DAY_MS = 86_400_000;

function formatters(timeZone) {
    if (!formatterCache.has(timeZone)) {
        formatterCache.set(timeZone, new Intl.DateTimeFormat('en-US', {
            timeZone,
            calendar: 'gregory',
            numberingSystem: 'latn',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
        }));
    }
    return formatterCache.get(timeZone);
}

function fields(instant, timeZone) {
    const parts = Object.fromEntries(formatters(timeZone).formatToParts(new Date(instant)).map(({ type, value }) => [type, value]));
    return {
        date: `${parts.year}-${parts.month}-${parts.day}`,
        time: `${parts.hour}:${parts.minute}`,
        second: parts.second,
    };
}

function wallMilliseconds(date, time) {
    const [year, month, day] = date.split('-').map(Number);
    const [hour, minute, second = 0] = time.split(':').map(Number);
    return Date.UTC(year, month - 1, day, hour, minute, second);
}

function offsetAt(instant, timeZone) {
    const local = fields(instant, timeZone);
    return instant - wallMilliseconds(local.date, `${local.time}:${local.second}`);
}

function exactCandidates(date, time, timeZone) {
    const wall = wallMilliseconds(date, time);
    const offsets = new Set([-2, -1, 0, 1, 2].map((days) => offsetAt(wall + days * DAY_MS, timeZone)));
    return [...offsets]
        .map((offset) => ({ instant: wall + offset, offset }))
        .filter(({ instant }) => {
            const local = fields(instant, timeZone);
            return local.date === date && local.time === time;
        });
}

function resolvedInstant(date, time, timeZone) {
    const candidates = exactCandidates(date, time, timeZone);
    if (candidates.length > 0) {
        // Match the source PHP policy: the later occurrence for zones on/east
        // of UTC, and the earlier occurrence for zones west of UTC.
        const offsets = candidates.map(({ offset }) => offset);
        const selectedOffset = Math.max(...offsets) <= 0 ? Math.max(...offsets) : Math.min(...offsets);
        return candidates.find(({ offset }) => offset === selectedOffset).instant;
    }

    // Match PHP's forward normalization for nonexistent spring-forward clocks.
    const wall = wallMilliseconds(date, time);
    const offsets = [-2, -1, 0, 1, 2].map((days) => offsetAt(wall + days * DAY_MS, timeZone));
    return wall + Math.max(...offsets);
}

export function isValidDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    if (year < 1) return false;
    const parsed = new Date(0);
    parsed.setUTCHours(0, 0, 0, 0);
    parsed.setUTCFullYear(year, month - 1, day);
    return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

export function addCalendarDays(date, days) {
    const [year, month, day] = date.split('-').map(Number);
    const result = new Date(Date.UTC(year, month - 1, day + days));
    return result.toISOString().slice(0, 10);
}

export function dayOfWeekMondayZero(date) {
    const [year, month, day] = date.split('-').map(Number);
    return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
}

export function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function hasWallTime(date, time, timeZone) {
    return exactCandidates(date, time, timeZone).length > 0;
}

export function wallDateTimeToUtc(date, time, timeZone) {
    return new Date(resolvedInstant(date, time, timeZone)).toISOString().replace('.000Z', 'Z');
}

export function utcRange(startDate, startTime, endDate, endTime, timeZone) {
    const start = resolvedInstant(startDate, startTime, timeZone);
    let end = resolvedInstant(endDate, endTime, timeZone);
    if (end <= start) {
        end = start + (wallMilliseconds(endDate, endTime) - wallMilliseconds(startDate, startTime));
    }
    return {
        start_utc: new Date(start).toISOString().replace('.000Z', 'Z'),
        end_utc: new Date(end).toISOString().replace('.000Z', 'Z'),
    };
}

export function minutesFromTime(value) {
    const [hour, minute] = value.split(':').map(Number);
    return hour * 60 + minute;
}

export function timeFromMinutes(value) {
    return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

export function localNow(timeZone, now = Date.now()) {
    const local = fields(now, timeZone);
    return { date: local.date, time: local.time, instant: now };
}

export function localDateTime(instant, timeZone) {
    const local = fields(instant, timeZone);
    return `${local.date} ${local.time}:${local.second}`;
}
