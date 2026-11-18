import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAdminCalendar } from '../../server/services/admin-calendar.js';

test('month calendar uses tenant week start, shows 42 cells, working days, and whole-business closures', async () => {
    const booking = { id: 'b1', start_datetime: '2031-05-01 09:00:00', end_datetime: '2031-05-01 09:30:00', status: 'confirmed', customer_name: 'Ana', service_name: 'Consulta' };
    const db = { async query(sql, values = []) {
        if (sql.includes('FROM tenants WHERE id=$1')) return { rows: [{ id: 't1', name: 'Studio', timezone: 'America/Sao_Paulo', week_start: 1, booking_pattern: 'timeslot' }] };
        if (sql.includes('FROM bookings b JOIN customers')) {
            assert.equal(values[1], '2031-04-28 00:00:00');
            assert.equal(values[2], '2031-06-08');
            return { rows: [booking] };
        }
        if (sql.includes('FROM blocked_dates')) return { rows: [{ start_date: '2031-05-02', end_date: '2031-05-03' }] };
        if (sql.includes('FROM availability')) return { rows: [{ day_of_week: 0 }, { day_of_week: 3 }] };
        throw new Error(`Unexpected SQL: ${sql}`);
    } };
    const calendar = await loadAdminCalendar(db, 't1', { view: 'month', date: '2031-05-15' });
    assert.equal(calendar.from, '2031-04-28');
    assert.equal(calendar.to, '2031-06-08');
    assert.equal(calendar.days.length, 42);
    const first = calendar.days.find((day) => day.date === '2031-05-01');
    const closure = calendar.days.find((day) => day.date === '2031-05-02');
    assert.equal(first.bookings.length, 1);
    assert.equal(first.open, true);
    assert.equal(closure.blocked, true);
    assert.equal(calendar.prev, '2031-04-01');
    assert.equal(calendar.next, '2031-06-01');
});

test('resource stays occupy arrival through the day before checkout and staff blocks do not close the business', async () => {
    const stay = { id: 'stay1', booking_pattern: 'resource', start_datetime: '2031-05-31 15:00:00', end_datetime: '2031-06-02 00:00:00' };
    const db = { async query(sql) {
        if (sql.includes('FROM tenants WHERE id=$1')) return { rows: [{ id: 't1', name: 'Stay', timezone: 'UTC', week_start: 0, booking_pattern: 'resource' }] };
        if (sql.includes('FROM bookings b JOIN customers')) return { rows: [stay] };
        if (sql.includes('FROM blocked_dates')) return { rows: [] };
        if (sql.includes('FROM availability')) return { rows: [{ day_of_week: 1 }] };
        throw new Error(`Unexpected SQL: ${sql}`);
    } };
    const calendar = await loadAdminCalendar(db, 't1', { view: 'week', date: '2031-06-01' });
    assert.equal(calendar.from, '2031-06-01');
    assert.equal(calendar.to, '2031-06-07');
    assert.equal(calendar.days.find((day) => day.date === '2031-06-01').bookings.length, 1);
    assert.equal(calendar.days.find((day) => day.date === '2031-06-02').bookings.length, 0);
});
