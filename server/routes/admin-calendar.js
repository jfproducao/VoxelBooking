import { loadAdminCalendar } from '../services/admin-calendar.js';

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
}

function page(calendar, view) {
    const { tenant, date, today, prev, next, days, weekStart } = calendar;
    const base = `/admin/tenants/${encodeURIComponent(tenant.id)}/calendar`;
    const path = view === 'month' ? base : `${base}/${view}`;
    const labels = ['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'];
    const weekdays = Array.from({ length: 7 }, (_unused, index) => labels[(weekStart + index) % 7]);
    const bookingUrl = (booking) => `/admin/tenants/${encodeURIComponent(tenant.id)}/bookings/${encodeURIComponent(booking.id)}`;
    const caption = (booking) => {
        const start = String(booking.start_datetime).slice(11, 16);
        const thing = booking.service_name || booking.resource_name || booking.event_name || 'Reserva';
        return `<a class="event" href="${bookingUrl(booking)}"><b>${escapeHtml(start)}</b> ${escapeHtml(booking.customer_name)}<small>${escapeHtml(thing)}${booking.staff_name ? ` · ${escapeHtml(booking.staff_name)}` : ''}</small><small>${escapeHtml(booking.status)}</small></a>`;
    };
    const dayCard = (item) => {
        const entries = item.bookings.slice(0, view === 'month' ? 3 : 100).map(caption).join('');
        const more = item.bookings.length > 3 && view === 'month' ? `<a href="${base}/day?date=${item.date}">+${item.bookings.length - 3} reserva(s)</a>` : '';
        return `<article class="day ${item.inMonth === false ? 'outside' : ''} ${item.isToday ? 'today' : ''} ${item.blocked ? 'blocked' : ''}"><header><a href="${base}/day?date=${item.date}">${escapeHtml(item.day)}</a>${item.blocked ? '<span>Fechado</span>' : !item.open ? '<span>Sem horário</span>' : ''}</header>${entries || '<small class="muted">Sem reservas</small>'}${more}</article>`;
    };
    const selector = `<form method="get" action="${path}" class="calendar-controls"><label>Data <input type="date" name="date" value="${escapeHtml(date)}"></label><button>Ir</button><a href="${path}?date=${today}">Hoje</a></form>`;
    const viewTabs = `<nav class="views"><a href="${base}?date=${date}">Mês</a><a href="${base}/week?date=${date}">Semana</a><a href="${base}/day?date=${date}">Dia</a></nav>`;
    const title = view === 'month' ? new Intl.DateTimeFormat(tenant.locale || 'pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date.slice(0,7)}-15T12:00:00Z`))
        : view === 'week' ? `${calendar.from} – ${calendar.to}` : date;
    let content;
    if (view === 'month') {
        const headers = weekdays.map((name) => `<div class="weekday">${name}</div>`).join('');
        content = `<div class="calendar-scroll"><div class="calendar-grid">${headers}${days.map(dayCard).join('')}</div></div>`;
    } else if (view === 'week') {
        const headers = days.map((day) => `<div class="weekday"><a href="${base}/day?date=${day.date}">${weekdays[mondayZero(day.date, weekStart)]} ${escapeHtml(day.date)}</a></div>`).join('');
        content = `<div class="calendar-scroll"><div class="calendar-grid">${headers}${days.map(dayCard).join('')}</div></div>`;
    } else {
        const schedule = Array.from({ length: 15 }, (_unused, index) => index + 7).map((hour) => {
            const entries = days[0].bookings.filter((booking) => Number(String(booking.start_datetime).slice(11, 13)) === hour);
            return `<section class="hour"><b>${String(hour).padStart(2,'0')}:00</b><div>${entries.length ? entries.map(caption).join('') : '<span class="muted">—</span>'}</div></section>`;
        }).join('');
        const state = days[0].blocked ? 'Dia fechado' : days[0].open ? 'Horário disponível' : 'Sem horário configurado';
        content = `<p class="day-state">${state} · ${days[0].bookings.length} reserva(s)</p>${schedule}`;
    }
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Calendário · ${escapeHtml(tenant.name)}</title><style>
body{margin:0;background:#f4f6fa;color:#17212f;font:15px system-ui,sans-serif}.box{max-width:1400px;margin:4vh auto;background:#fff;border:1px solid #e1e6ee;border-radius:14px;padding:26px;box-shadow:0 12px 36px #17212f12}a{color:#2563eb}h1{margin-bottom:6px}.top,.calendar-controls,.views{display:flex;align-items:center;gap:16px;flex-wrap:wrap}.top{justify-content:space-between}.calendar-controls label{font-weight:600}.calendar-controls input{padding:8px;border:1px solid #b9c3d0;border-radius:7px}button{border:0;border-radius:7px;padding:9px 16px;background:#2563eb;color:white;font:inherit}.calendar-grid{display:grid;grid-template-columns:repeat(7,minmax(135px,1fr));gap:1px;background:#dbe2ea;border:1px solid #dbe2ea}.calendar-scroll{overflow:auto}.weekday{background:#f4f6fa;padding:10px;text-align:center;text-transform:capitalize;font-weight:700}.day{min-height:128px;background:white;padding:8px;box-sizing:border-box}.day header{display:flex;justify-content:space-between;font-weight:700;margin-bottom:7px}.day header span{font-size:11px;color:#92400e}.outside{background:#f8fafc;color:#7b8794}.today{outline:2px solid #2563eb;outline-offset:-2px}.blocked{background:#fff7ed}.event{display:block;text-decoration:none;color:#17212f;font-size:12px;border-left:3px solid #2563eb;background:#eff6ff;margin:4px 0;padding:4px 6px;overflow:hidden}.event small{display:block;color:#526173}.muted{color:#98a2b3;font-size:12px}.hour{display:grid;grid-template-columns:72px 1fr;border-top:1px solid #e1e6ee;min-height:62px;padding:6px}.hour>b{color:#687587}.day-state{padding:12px;background:#f8fafc;border-radius:8px}.views a{padding:6px 10px;border:1px solid #dbe2ea;border-radius:7px;text-decoration:none}.top nav{display:flex;gap:12px}@media(max-width:600px){.box{margin:0;padding:16px;border-radius:0}.calendar-grid{grid-template-columns:repeat(7,minmax(125px,1fr))}}
</style></head><body><main class="box"><div class="top"><div><p><a href="/admin/tenants/${encodeURIComponent(tenant.id)}">← Painel</a> · <a href="/admin/tenants/${encodeURIComponent(tenant.id)}/bookings">Reservas</a></p><h1>Calendário</h1><p>${escapeHtml(tenant.name)} · ${escapeHtml(tenant.timezone)}</p></div><nav><a href="/admin/tenants/${encodeURIComponent(tenant.id)}/customers">Clientes</a></nav></div>${viewTabs}<div class="top"><h2>${escapeHtml(title)}</h2><nav><a href="${path}?date=${prev}">← Anterior</a><a href="${path}?date=${next}">Próximo →</a></nav></div>${selector}${content}</main></body></html>`;
}

function mondayZero(date, weekStart) {
    return ((new Date(`${date}T00:00:00Z`).getUTCDay() - weekStart + 7) % 7);
}

export async function registerAdminCalendarRoutes(app, { db }) {
    const add = (route, view) => app.get(route, async (request, reply) => {
        const result = await loadAdminCalendar(db, request.params.tenantId, { view, date: request.query.date });
        if (!result) return reply.code(404).type('text/plain; charset=utf-8').send('Empresa não encontrada.');
        return reply.header('Cache-Control', 'no-store, private').header('Referrer-Policy', 'no-referrer')
            .type('text/html; charset=utf-8').send(page(result, view));
    });
    add('/admin/tenants/:tenantId/calendar', 'month');
    add('/admin/tenants/:tenantId/calendar/week', 'week');
    add('/admin/tenants/:tenantId/calendar/day', 'day');
}

