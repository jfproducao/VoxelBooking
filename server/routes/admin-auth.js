import {
    ensureAdminSession, loadAdminSession, loginWithPassword, loginWithEmail, logoutAdmin,
    recordAuthRateLimit, setPasswordFromReset, updateAdminPassword, verifyCsrf,
} from '../services/admin-auth.js';
import { consumeLoginToken, issueLoginToken, passwordResetUrlIsValid, sendAdminAuthEmail } from '../services/admin-login-tokens.js';
import { AdminBookingProblem, changeAdminBookingStatus, getAdminBooking, listAdminBookings } from '../services/admin-bookings.js';
import { localNow, wallDateTimeToUtc } from '../time/venue-time.js';

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
}

function protectedReply(reply) {
    return reply.header('Cache-Control', 'no-store, private')
        .header('Referrer-Policy', 'no-referrer')
        .header('X-Robots-Tag', 'noindex, nofollow');
}

function authPage(title, inner) {
    const narrow = ['Entrar', 'Alterar senha', 'Redefinir senha', 'Recuperar senha'].includes(title) ? ' narrow' : '';
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · VoxelBooking</title>
<style>body{font-family:system-ui,sans-serif;background:#f4f6fa;color:#17212f;margin:0}.box{max-width:1100px;margin:5vh auto;background:white;border:1px solid #e1e6ee;border-radius:14px;padding:28px;box-shadow:0 12px 36px #17212f12}.box.narrow{max-width:420px}h1{font-size:1.5rem;margin-top:0}label{display:block;margin:16px 0 6px;font-weight:600}input,select{box-sizing:border-box;min-width:120px;height:42px;padding:8px 11px;border:1px solid #b9c3d0;border-radius:8px;font:inherit}button{margin-top:20px;min-width:140px;padding:0 16px;height:46px;border:0;border-radius:8px;background:#2563eb;color:white;font:inherit;font-weight:700;cursor:pointer}button:disabled{opacity:.65;cursor:wait}.error{min-height:1.4em;color:#b42318}a{color:#2563eb}.filters{display:flex;gap:14px;align-items:end;flex-wrap:wrap}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;text-align:left}th,td{padding:10px;border-bottom:1px solid #e1e6ee;white-space:nowrap}dt{font-weight:700;margin-top:12px}dd{margin:3px 0 0}.stats{display:flex;gap:12px;margin:22px 0}.stats article{min-width:120px;padding:18px;border:1px solid #e1e6ee;border-radius:10px}.stats b,.stats span{display:block}.stats b{font-size:1.6rem}.check input{min-width:0;width:auto;height:auto}</style></head><body><main class="box${narrow}">${inner}</main><script type="module" src="/admin-auth.js"></script></body></html>`;
}

function loginHtml(session) {
    const csrf = `<input type="hidden" name="csrf_token" value="${escapeHtml(session.data.csrf_token)}">`;
    return authPage('Entrar', `<h1>Entrar no VoxelBooking</h1><p>Acesse sua conta de administração.</p>
<form id="login-form" data-action="login">${csrf}<label for="email">E-mail</label><input id="email" name="email" type="email" autocomplete="username" required maxlength="255"><label for="password">Senha</label><input id="password" name="password" type="password" autocomplete="current-password" required><label class="check"><input name="remember_me" type="checkbox" value="1" style="width:auto;height:auto"> Manter conectado</label><p id="error" class="error" role="alert" aria-live="polite"></p><button type="submit">Entrar</button></form>
<hr><h2>Acesso sem senha</h2><form data-action="request-auth">${csrf}<label>E-mail</label><input name="email" type="email" required maxlength="255"><label>Método</label><select name="method"><option value="otp">Código por e-mail</option><option value="magic_link">Link de acesso</option></select><label class="check"><input name="remember_me" type="checkbox" value="1" style="width:auto;height:auto"> Manter conectado</label><p class="error" role="alert" aria-live="polite"></p><button type="submit">Enviar acesso</button></form>
<p><a href="/admin/forgot-password">Esqueci minha senha</a></p><section id="verify-section" hidden><h2>Confirmar código</h2><form data-action="verify-otp">${csrf}<label>E-mail</label><input name="email" type="email" required><label>Código</label><input name="code" inputmode="numeric" pattern="[0-9]{6}" required><label class="check"><input name="remember_me" type="checkbox" value="1"> Manter conectado</label><p class="error" role="alert" aria-live="polite"></p><button type="submit">Confirmar</button></form></section>`);
}

function resetHtml(session, token) {
    return authPage('Redefinir senha', `<h1>Redefinir senha</h1><form data-action="reset-password"><input type="hidden" name="csrf_token" value="${escapeHtml(session.data.csrf_token)}"><input type="hidden" name="token" value="${escapeHtml(token)}"><label>Nova senha (mínimo de 8 caracteres)</label><input name="password" type="password" autocomplete="new-password" minlength="8" required><label>Confirmar senha</label><input name="confirm_password" type="password" autocomplete="new-password" minlength="8" required><p class="error" role="alert" aria-live="polite"></p><button type="submit">Salvar senha</button></form>`);
}

function forgotHtml(session) {
    return authPage('Recuperar senha', `<h1>Recuperar senha</h1><p>Se o endereço estiver cadastrado, enviaremos um link de redefinição.</p><form data-action="forgot-password"><input type="hidden" name="csrf_token" value="${escapeHtml(session.data.csrf_token)}"><label>E-mail</label><input name="email" type="email" autocomplete="email" required maxlength="255"><p class="error" role="alert" aria-live="polite"></p><button type="submit">Enviar link</button></form><p><a href="/admin/login">Voltar ao acesso</a></p>`);
}

function passwordHtml(session, user) {
    return authPage('Alterar senha', `<h1>Alterar senha</h1><p>Conectado como ${escapeHtml(user.name)}.</p><form id="password-form" data-action="password"><input type="hidden" name="csrf_token" value="${escapeHtml(session.data.csrf_token)}"><label for="current-password">Senha atual</label><input id="current-password" name="current_password" type="password" autocomplete="current-password" required><label for="new-password">Nova senha (mínimo de 8 caracteres)</label><input id="new-password" name="new_password" type="password" autocomplete="new-password" minlength="8" required><label for="confirm-password">Confirmar senha</label><input id="confirm-password" name="confirm_password" type="password" autocomplete="new-password" minlength="8" required><p id="error" class="error" role="alert" aria-live="polite"></p><button type="submit">Salvar senha</button></form>`);
}

function dashboardHtml(user, tenantName = null) {
    return authPage('Administração', `<h1>Administração</h1><p>Olá, ${escapeHtml(user.name)}.</p>${tenantName ? `<p>Conta vinculada à empresa ${escapeHtml(tenantName)}.</p>` : ''}<p>A migração das páginas administrativas está em andamento.</p><form id="logout-form" data-action="logout"><input type="hidden" name="csrf_token" value="${escapeHtml(user.csrf_token)}"><button type="submit">Sair</button></form>`);
}

function statusLabel(status) {
    return ({ pending: 'Pendente', confirmed: 'Confirmada', cancelled: 'Cancelada', completed: 'Concluída', no_show: 'Não compareceu', rescheduled: 'Remarcada', waitlisted: 'Lista de espera' })[status] || status;
}

function bookingUrl(row, tenantId = null) {
    return tenantId ? `/admin/tenants/${encodeURIComponent(tenantId)}/bookings/${encodeURIComponent(row.id)}` : `/admin/bookings/${encodeURIComponent(row.id)}`;
}

function bookingRows(rows, tenantId = null) {
    if (!rows.length) return '<tr><td colspan="7">Nenhuma reserva encontrada.</td></tr>';
    return rows.map((row) => `<tr><td><a href="${bookingUrl(row, tenantId)}">${escapeHtml(row.customer_name)}</a></td><td>${escapeHtml(row.customer_email)}</td><td>${escapeHtml(row.service_name || row.resource_name || row.event_name || '—')}</td><td>${escapeHtml(String(row.start_datetime).slice(0,16))}</td><td>${escapeHtml(statusLabel(row.status))}</td>${tenantId ? '' : `<td><a href="/admin/tenants/${encodeURIComponent(row.tenant_id)}">${escapeHtml(row.tenant_name)}</a></td>`}<td>${escapeHtml(row.id)}</td></tr>`).join('');
}

function bookingsHtml({ user, result, query, csrfToken, tenantId = null }) {
    const base = tenantId ? `/admin/tenants/${encodeURIComponent(tenantId)}/bookings` : '/admin/bookings';
    const rows = result.bookings;
    const totalPages = Math.max(1, Math.ceil(result.total / result.perPage));
    const pageUrl = (page) => `${base}?${new URLSearchParams({ ...query, page: String(page) })}`;
    const filter = (key, label, type = 'text') => `<label>${label}<input type="${type}" name="${key}" value="${escapeHtml(query[key] || '')}"></label>`;
    return authPage('Reservas', `<h1>Reservas</h1><nav><a href="${tenantId ? `/admin/tenants/${encodeURIComponent(tenantId)}` : '/admin'}">Painel</a>${tenantId ? ` · <a href="/admin/tenants/${encodeURIComponent(tenantId)}/customers">Clientes</a>` : ''}</nav>
<form method="get" class="filters">${filter('search','Buscar cliente, e-mail ou ID')}<label>Status<select name="status"><option value="">Todos</option>${['pending','confirmed','cancelled','completed','no_show','rescheduled','waitlisted'].map((status) => `<option value="${status}" ${query.status === status ? 'selected' : ''}>${statusLabel(status)}</option>`).join('')}</select></label>${filter('from','De','date')}${filter('to','Até','date')}<button>Filtrar</button></form>
<p>${result.total} reserva(s) · página ${result.page} de ${totalPages}</p><div class="table-wrap"><table><thead><tr><th>Cliente</th><th>E-mail</th><th>Serviço / evento</th><th>Data e hora</th><th>Status</th>${tenantId ? '' : '<th>Empresa</th>'}<th>ID</th></tr></thead><tbody>${bookingRows(rows, tenantId)}</tbody></table></div><p>${result.page > 1 ? `<a href="${pageUrl(result.page - 1)}">← Anterior</a>` : ''} ${result.page < totalPages ? `<a href="${pageUrl(result.page + 1)}">Próxima →</a>` : ''}</p>`);
}

function bookingDetailHtml(session, booking, tenantId = null) {
    const back = tenantId ? `/admin/tenants/${encodeURIComponent(tenantId)}/bookings` : '/admin/bookings';
    const date = String(booking.start_datetime).slice(0, 16);
    const transitions = booking.transitions.map((status) => `<option value="${status}">${statusLabel(status)}</option>`).join('');
    const timeline = booking.timeline.length ? booking.timeline.map((entry) => `<li><b>${escapeHtml(entry.action)}</b> · ${escapeHtml(entry.actor_type)} · ${escapeHtml(String(entry.created_at))}</li>`).join('') : '<li>Sem eventos registrados.</li>';
    return authPage('Detalhe da reserva', `<p><a href="${back}">← Voltar às reservas</a></p><h1>${escapeHtml(booking.customer_name)}</h1><p>${escapeHtml(statusLabel(booking.status))} · ${escapeHtml(date)} · ${escapeHtml(booking.timezone)}</p>
<dl><dt>Cliente</dt><dd>${escapeHtml(booking.customer_name)} · ${escapeHtml(booking.customer_email)} · ${escapeHtml(booking.customer_phone || '')}</dd><dt>Empresa</dt><dd>${escapeHtml(booking.tenant_name)}</dd><dt>Serviço, recurso ou evento</dt><dd>${escapeHtml(booking.service_name || booking.resource_name || booking.event_name || '—')}</dd><dt>Profissional</dt><dd>${escapeHtml(booking.staff_name || '—')}</dd><dt>Término</dt><dd>${escapeHtml(String(booking.end_datetime))}</dd><dt>Tamanho do grupo</dt><dd>${escapeHtml(booking.party_size)}</dd><dt>Observações do cliente</dt><dd>${escapeHtml(booking.notes || '—')}</dd><dt>Observações internas</dt><dd>${escapeHtml(booking.internal_notes || '—')}</dd><dt>Preço</dt><dd>${escapeHtml(booking.price_total ?? '—')} ${escapeHtml(booking.price_currency || '')}</dd></dl>
${transitions ? `<h2>Atualizar status</h2><form data-action="admin-post" data-endpoint="${bookingUrl(booking, tenantId)}/status"><input type="hidden" name="csrf_token" value="${escapeHtml(session.data.csrf_token)}"><label>Novo status<select name="status">${transitions}</select></label><p class="error" role="alert" aria-live="polite"></p><button type="submit">Salvar status</button></form>` : ''}
<h2>Histórico</h2><ul>${timeline}</ul>`);
}

async function dashboardSummary(db, tenantId = null) {
    if (!tenantId) {
        const tenants = await db.query("SELECT id,name,slug,timezone FROM tenants WHERE status='active' ORDER BY id");
        let todayCount = 0; let pendingCount = 0; const upcoming = [];
        for (const tenant of tenants.rows) {
            const today = localNow(tenant.timezone || 'UTC').date;
            const counts = await db.query(`SELECT COUNT(*) FILTER (WHERE start_datetime >= $2::timestamp AND start_datetime < ($2::date+INTERVAL '1 day'))::int AS today,
                COUNT(*) FILTER (WHERE status='pending')::int AS pending FROM bookings WHERE tenant_id=$1`, [tenant.id, `${today} 00:00:00`]);
            todayCount += Number(counts.rows[0]?.today || 0); pendingCount += Number(counts.rows[0]?.pending || 0);
            const next = await db.query(`SELECT b.id,b.tenant_id,b.status,b.start_datetime,b.end_datetime,b.party_size,
                COALESCE(b.customer_name_snapshot,c.name) AS customer_name,COALESCE(b.customer_email_snapshot,c.email) AS customer_email,
                s.name AS service_name,r.name AS resource_name,e.name AS event_name
                FROM bookings b JOIN customers c ON c.id=b.customer_id AND c.tenant_id=b.tenant_id
                LEFT JOIN services s ON s.id=b.service_id AND s.tenant_id=b.tenant_id
                LEFT JOIN resources r ON r.id=b.resource_id AND r.tenant_id=b.tenant_id
                LEFT JOIN events e ON e.id=b.event_id AND e.tenant_id=b.tenant_id
                WHERE b.tenant_id=$1 AND b.status IN ('pending','confirmed','waitlisted') AND b.start_datetime >= $2::timestamp ORDER BY b.start_datetime ASC LIMIT 8`, [tenant.id, `${today} 00:00:00`]);
            for (const row of next.rows) upcoming.push({ ...row, tenant_name: tenant.name, tenant_slug: tenant.slug, timezone: tenant.timezone });
        }
        upcoming.sort((a, b) => Date.parse(wallDateTimeToUtc(String(a.start_datetime).slice(0,10), String(a.start_datetime).slice(11,16), a.timezone || 'UTC'))
            - Date.parse(wallDateTimeToUtc(String(b.start_datetime).slice(0,10), String(b.start_datetime).slice(11,16), b.timezone || 'UTC')));
        return { tenantCount: tenants.rows.length, today: todayCount, pending: pendingCount, upcoming: upcoming.slice(0, 8) };
    }
    const found = await db.query('SELECT * FROM tenants WHERE id=$1 LIMIT 1', [tenantId]);
    const tenant = found.rows[0];
    if (!tenant || tenant.status === 'archived') return null;
    const today = localNow(tenant.timezone || 'UTC').date;
    const week = new Date(`${today}T00:00:00Z`); week.setUTCDate(week.getUTCDate() - 6);
    const startMonth = `${today.slice(0, 7)}-01`;
    const stats = await db.query(`SELECT
        COUNT(*) FILTER (WHERE b.start_datetime::date=$2::date)::int AS today,
        COUNT(*) FILTER (WHERE b.start_datetime >= $3::date AND b.start_datetime < $2::date+INTERVAL '1 day')::int AS week,
        COUNT(*) FILTER (WHERE b.start_datetime >= $4::date AND b.start_datetime < $2::date+INTERVAL '1 day')::int AS month,
        COUNT(*) FILTER (WHERE b.status='pending')::int AS pending
        FROM bookings b WHERE b.tenant_id=$1`, [tenantId, today, week.toISOString().slice(0,10), startMonth]);
    const customers = await db.query('SELECT COUNT(*)::int AS total FROM customers WHERE tenant_id=$1', [tenantId]);
    const upcoming = await db.query(`SELECT b.id,b.tenant_id,t.name AS tenant_name,t.slug AS tenant_slug,t.timezone,b.status,b.start_datetime,b.end_datetime,b.party_size,COALESCE(b.customer_name_snapshot,c.name) AS customer_name,COALESCE(b.customer_email_snapshot,c.email) AS customer_email,s.name AS service_name,r.name AS resource_name,e.name AS event_name
        FROM bookings b JOIN tenants t ON t.id=b.tenant_id JOIN customers c ON c.id=b.customer_id LEFT JOIN services s ON s.id=b.service_id LEFT JOIN resources r ON r.id=b.resource_id LEFT JOIN events e ON e.id=b.event_id
        WHERE b.tenant_id=$1 AND b.status IN ('pending','confirmed','waitlisted') AND b.start_datetime >= $2::timestamp ORDER BY b.start_datetime ASC LIMIT 8`, [tenantId, `${today} 00:00:00`]);
    return { tenant, today, ...stats.rows[0], customers: Number(customers.rows[0]?.total || 0), upcoming: upcoming.rows };
}

function dashboardPage(session, summary, operator = false) {
    const user = session.user;
    const items = summary.upcoming.length ? summary.upcoming.map((booking) => `<li><a href="${bookingUrl(booking, operator ? null : summary.tenant.id)}">${escapeHtml(booking.customer_name)}</a> · ${escapeHtml(String(booking.start_datetime).slice(0,16))} · ${escapeHtml(booking.tenant_name || summary.tenant.name)}</li>`).join('') : '<li>Sem reservas próximas.</li>';
    const tenantBase = summary.tenant ? `/admin/tenants/${encodeURIComponent(summary.tenant.id)}` : '';
    const serviceLink = summary.tenant && (session.user.type === 'operator' || session.user.role === 'owner') && summary.tenant.booking_pattern === 'timeslot' ? ` · <a href="${tenantBase}/services">Serviços</a>` : '';
    const staffLink = summary.tenant && (session.user.type === 'operator' || session.user.role === 'owner') && summary.tenant.booking_pattern === 'timeslot' ? ` · <a href="${tenantBase}/staff">Profissionais</a>` : '';
    const availabilityLink = summary.tenant && (session.user.type === 'operator' || session.user.role === 'owner') && summary.tenant.booking_pattern === 'timeslot' ? ` · <a href="${tenantBase}/availability">Disponibilidade</a>` : '';
    const blockedDatesLink = summary.tenant && (session.user.type === 'operator' || session.user.role === 'owner') && ['timeslot', 'resource', 'capacity'].includes(summary.tenant.booking_pattern) ? ` · <a href="${tenantBase}/blocked-dates">Datas bloqueadas</a>` : '';
    const links = operator ? `<a href="/admin/bookings">Todas as reservas</a> · <a href="/admin/tenants">Empresas</a>` : `<a href="${tenantBase}/bookings">Reservas</a> · <a href="${tenantBase}/customers">Clientes</a> · <a href="${tenantBase}/calendar">Calendário</a>${serviceLink}${staffLink}${availabilityLink}${blockedDatesLink}`;
    return authPage('Painel', `<h1>Painel</h1><p>Olá, ${escapeHtml(user.name)}.</p><nav>${links}</nav><section class="stats">${operator ? `<article><b>${summary.tenantCount}</b><span>Empresas ativas</span></article>` : ''}<article><b>${summary.today}</b><span>Reservas hoje</span></article><article><b>${summary.pending}</b><span>Pendentes</span></article>${operator ? '' : `<article><b>${summary.customers}</b><span>Clientes</span></article>`}</section><h2>Próximas reservas</h2><ul>${items}</ul><form data-action="logout"><input type="hidden" name="csrf_token" value="${escapeHtml(session.data.csrf_token)}"><button type="submit">Sair</button></form>`);
}

async function listAdminCustomers(db, tenantId, query = {}) {
    const values = [tenantId]; let where = 'tenant_id=$1 AND is_anonymized=FALSE';
    const search = String(query.search || '').trim().slice(0, 200);
    if (search) {
        values.push(`%${search.replace(/[!%_]/g, (m) => `!${m}`)}%`);
        where += ` AND (name ILIKE $2 ESCAPE '!' OR email ILIKE $2 ESCAPE '!' OR phone ILIKE $2 ESCAPE '!')`;
    }
    const total = await db.query(`SELECT COUNT(*)::int AS total FROM customers WHERE ${where}`, values);
    const lastPage = Math.max(1, Math.ceil(Number(total.rows[0]?.total || 0) / 25));
    const page = Math.min(lastPage, Math.max(1, Math.min(1_000_000, Number.parseInt(query.page, 10) || 1)));
    const rows = await db.query(`SELECT id,name,email,phone,booking_count,last_booking_at,created_at FROM customers WHERE ${where} ORDER BY id DESC LIMIT 25 OFFSET ${(page-1)*25}`, values);
    return { rows: rows.rows, total: Number(total.rows[0]?.total || 0), page, perPage: 25, search };
}

function customersHtml(session, result, tenantId) {
    const base = `/admin/tenants/${encodeURIComponent(tenantId)}/customers`;
    const rows = result.rows.length ? result.rows.map((customer) => `<tr><td><a href="${base}/${encodeURIComponent(customer.id)}">${escapeHtml(customer.name)}</a></td><td>${escapeHtml(customer.email)}</td><td>${escapeHtml(customer.phone || '—')}</td><td>${escapeHtml(customer.booking_count)}</td><td>${escapeHtml(customer.last_booking_at || '—')}</td></tr>`).join('') : '<tr><td colspan="5">Nenhum cliente encontrado.</td></tr>';
    const pages = Math.max(1, Math.ceil(result.total/result.perPage));
    const url = (page) => `${base}?${new URLSearchParams({ search: result.search, page: String(page) })}`;
    return authPage('Clientes', `<h1>Clientes</h1><p><a href="/admin/tenants/${encodeURIComponent(tenantId)}">← Painel</a> · <a href="/admin/tenants/${encodeURIComponent(tenantId)}/bookings">Reservas</a></p><form method="get"><label>Buscar nome, e-mail ou telefone<input name="search" value="${escapeHtml(result.search)}"></label><button>Buscar</button></form><p>${result.total} cliente(s)</p><div class="table-wrap"><table><thead><tr><th>Nome</th><th>E-mail</th><th>Telefone</th><th>Reservas</th><th>Última reserva</th></tr></thead><tbody>${rows}</tbody></table></div><p>${result.page>1?`<a href="${url(result.page-1)}">← Anterior</a>`:''} ${result.page<pages?`<a href="${url(result.page+1)}">Próxima →</a>`:''}</p>`);
}

async function getAdminCustomer(db, tenantId, customerId, page = 1) {
    const customer = await db.query('SELECT id,name,email,phone,notes,created_at FROM customers WHERE id=$1 AND tenant_id=$2 AND is_anonymized=FALSE LIMIT 1', [customerId, tenantId]);
    if (!customer.rows[0]) return null;
    const stats = await db.query('SELECT COUNT(*)::int AS total,MAX(start_datetime) AS latest FROM bookings WHERE customer_id=$1 AND tenant_id=$2', [customerId, tenantId]);
    const pageNumber = Math.max(1, Math.min(1_000_000, Number(page) || 1));
    const history = await db.query(`SELECT b.id,b.status,b.start_datetime,b.end_datetime,b.booking_pattern,s.name AS service_name,r.name AS resource_name,e.name AS event_name
        FROM bookings b LEFT JOIN services s ON s.id=b.service_id AND s.tenant_id=b.tenant_id LEFT JOIN resources r ON r.id=b.resource_id AND r.tenant_id=b.tenant_id LEFT JOIN events e ON e.id=b.event_id AND e.tenant_id=b.tenant_id
        WHERE b.customer_id=$1 AND b.tenant_id=$2 ORDER BY b.id DESC LIMIT 26 OFFSET ${(pageNumber-1)*25}`, [customerId, tenantId]);
    const more = history.rows.length > 25;
    return { ...customer.rows[0], booking_count: Number(stats.rows[0]?.total || 0), last_booking_at: stats.rows[0]?.latest || null,
        history: history.rows.slice(0,25), page: pageNumber, hasPrevious: pageNumber > 1, hasNext: more };
}

function customerDetailHtml(customer, tenantId) {
    const list = `/admin/tenants/${encodeURIComponent(tenantId)}/customers`;
    const history = customer.history.length ? customer.history.map((booking) => `<tr><td><a href="/admin/tenants/${encodeURIComponent(tenantId)}/bookings/${encodeURIComponent(booking.id)}">${escapeHtml(String(booking.start_datetime))}</a></td><td>${escapeHtml(statusLabel(booking.status))}</td><td>${escapeHtml(booking.service_name || booking.resource_name || booking.event_name || booking.booking_pattern)}</td></tr>`).join('') : '<tr><td colspan="3">Sem reservas.</td></tr>';
    const pageUrl = (page) => `${list}/${encodeURIComponent(customer.id)}?page=${page}`;
    return authPage(customer.name, `<p><a href="${list}">← Clientes</a></p><h1>${escapeHtml(customer.name)}</h1><dl><dt>E-mail</dt><dd>${escapeHtml(customer.email)}</dd><dt>Telefone</dt><dd>${escapeHtml(customer.phone || '—')}</dd><dt>Notas</dt><dd>${escapeHtml(customer.notes || '—')}</dd><dt>Total de reservas</dt><dd>${escapeHtml(customer.booking_count)}</dd><dt>Última reserva</dt><dd>${escapeHtml(customer.last_booking_at || '—')}</dd></dl><h2>Histórico</h2><div class="table-wrap"><table><thead><tr><th>Data</th><th>Status</th><th>Tipo</th></tr></thead><tbody>${history}</tbody></table></div><p>${customer.hasPrevious?`<a href="${pageUrl(customer.page-1)}">← Anterior</a>`:''} ${customer.hasNext?`<a href="${pageUrl(customer.page+1)}">Próxima →</a>`:''}</p>`);
}

export function installAdminAuthHook(app, { db }) {
    app.addHook('preHandler', async (request, reply) => {
        if (!request.url.startsWith('/admin')) return;
        await loadAdminSession(db, request, reply);
        const path = request.url.split('?')[0];
        if (path === '/admin-auth.js' || ['/admin/login', '/admin/login/request', '/admin/login/verify', '/admin/login/verify-code', '/admin/forgot-password', '/admin/reset-password'].includes(path)) return;
        const session = request.adminSession;
        if (!session?.user) {
            if (request.headers.accept?.includes('application/json')) return protectedReply(reply).code(401).send({ error: 'authentication_required' });
            return reply.redirect('/admin/login');
        }
        if (session.data.force_password_change && !['/admin/password', '/admin/logout'].includes(path)) return reply.redirect('/admin/password');
        if (session.user.type === 'business_user') {
            if (path.startsWith('/admin/settings') || path.startsWith('/admin/deletion-queue')) {
                return protectedReply(reply).code(403).send({ error: 'forbidden' });
            }
            const tenantPath = path.match(/^\/admin\/tenants\/([^/]+)/);
            if (tenantPath && decodeURIComponent(tenantPath[1]) !== session.user.tenant_id) {
                return protectedReply(reply).code(403).send({ error: 'forbidden' });
            }
        }
    });
}

export async function registerAdminAuthRoutes(app, { db }) {
    app.get('/admin/login', async (request, reply) => {
        if (request.adminSession?.user) {
            const user = request.adminSession.user;
            if (request.adminSession.data.force_password_change) return reply.redirect('/admin/password');
            return reply.redirect(user.type === 'business_user' ? `/admin/tenants/${encodeURIComponent(user.tenant_id)}` : '/admin');
        }
        const session = await ensureAdminSession(db, request, reply);
        return protectedReply(reply).type('text/html; charset=utf-8').send(loginHtml(session));
    });

    app.post('/admin/login', async (request, reply) => {
        const session = request.adminSession;
        if (!verifyCsrf(session, request.body?.csrf_token)) return protectedReply(reply).code(403).send({ error: 'csrf_mismatch' });
        const result = await loginWithPassword(db, request, reply, request.body?.email, request.body?.password, request.body?.remember_me === true);
        if (result.error === 'rate_limited') return protectedReply(reply).code(429).send({ error: result.error });
        if (result.error) return protectedReply(reply).code(401).send({ error: result.error });
        return protectedReply(reply).send({ authenticated: true, redirect: result.redirect });
    });

    app.post('/admin/login/request', async (request, reply) => {
        const session = request.adminSession;
        if (!verifyCsrf(session, request.body?.csrf_token)) return protectedReply(reply).code(403).send({ error: 'csrf_mismatch' });
        if (!await recordAuthRateLimit(db, request.ip, 'auth_request', 10)) return protectedReply(reply).code(429).send({ error: 'rate_limited' });
        const method = request.body?.method === 'magic_link' ? 'magic_link' : 'otp';
        const email = String(request.body?.email || '').trim().toLowerCase();
        const { rows: registered } = await db.query('SELECT 1 FROM auth_emails WHERE lower(email)=$1 LIMIT 1', [email]);
        const mail = await db.query('SELECT "key",value FROM settings WHERE "key"=ANY($1::text[])', [['mail_transport','smtp_host','mail_from_address','smtp_password']]);
        const setting = (key) => mail.rows.find((row) => row.key === key)?.value;
        const transport = String(setting('mail_transport') || process.env.MAIL_TRANSPORT || 'smtp').toLowerCase();
        const hasConfig = transport === 'log' || (transport === 'resend' ? Boolean(setting('smtp_password') || process.env.MAIL_PASSWORD || process.env.RESEND_API_KEY) : Boolean(setting('smtp_host') || process.env.MAIL_HOST || transport === 'mailpit'));
        if (registered[0] && hasConfig) {
            const issued = await issueLoginToken(db, email, method, request.ip, request.body?.remember_me === true);
            if (issued.token) {
                const delivered = await sendAdminAuthEmail(db, { to: email, type: method, token: issued.token });
                if (!delivered.sent) await db.query('DELETE FROM login_tokens WHERE id=$1', [issued.id]);
                if (method === 'otp' && delivered.sent) return protectedReply(reply).send({ code_sent: true, email });
                if (method === 'magic_link' && !delivered.sent) return protectedReply(reply).code(502).send({ error: 'email_delivery_failed' });
            }
        }
        return protectedReply(reply).send({ requested: true });
    });

    app.post('/admin/login/verify-code', async (request, reply) => {
        if (!verifyCsrf(request.adminSession, request.body?.csrf_token)) return protectedReply(reply).code(403).send({ error: 'csrf_mismatch' });
        const limited = await recordAuthRateLimit(db, request.ip, 'auth_verify', 5);
        if (!limited) return protectedReply(reply).code(429).send({ error: 'rate_limited' });
        const email = String(request.body?.email || '').trim().toLowerCase();
        const token = await consumeLoginToken(db, request.body?.code, 'otp', email);
        if (!token) return protectedReply(reply).code(401).send({ error: 'invalid_code' });
        const result = await loginWithEmail(db, request, reply, token.email, request.body?.remember_me === true);
        if (result.error) return protectedReply(reply).code(401).send({ error: result.error });
        return protectedReply(reply).send({ authenticated: true, redirect: result.redirect });
    });

    app.get('/admin/login/verify', async (request, reply) => {
        const token = await consumeLoginToken(db, request.query?.token, 'magic_link');
        if (!token) return reply.redirect('/admin/login?error=link_invalid');
        const result = await loginWithEmail(db, request, reply, token.email, token.remember_me);
        if (result.error) return reply.redirect('/admin/login?error=link_invalid');
        return protectedReply(reply).redirect(result.redirect);
    });

    app.get('/admin/forgot-password', async (request, reply) => {
        const session = await ensureAdminSession(db, request, reply);
        return protectedReply(reply).type('text/html; charset=utf-8').send(forgotHtml(session));
    });

    app.post('/admin/forgot-password', async (request, reply) => {
        if (!verifyCsrf(request.adminSession, request.body?.csrf_token)) return protectedReply(reply).code(403).send({ error: 'csrf_mismatch' });
        const limited = await recordAuthRateLimit(db, request.ip, 'auth_reset', 5);
        if (!limited) return protectedReply(reply).code(429).send({ error: 'rate_limited' });
        const email = String(request.body?.email || '').trim().toLowerCase();
        const { rows } = await db.query('SELECT 1 FROM auth_emails WHERE lower(email)=$1 LIMIT 1', [email]);
        if (rows[0]) {
            const issued = await issueLoginToken(db, email, 'password_reset', request.ip);
            if (issued.token) {
                const delivered = await sendAdminAuthEmail(db, { to: email, type: 'password_reset', token: issued.token });
                if (delivered.sent) await db.query("UPDATE login_tokens SET used_at=NOW() WHERE email=$1 AND type='password_reset' AND used_at IS NULL AND id<>$2", [email, issued.id]);
                else await db.query('DELETE FROM login_tokens WHERE id=$1', [issued.id]);
            }
        }
        return protectedReply(reply).send({ requested: true });
    });

    app.get('/admin/reset-password', async (request, reply) => {
        if (!await passwordResetUrlIsValid(db, request.query?.token)) return reply.redirect('/admin/forgot-password?error=token_invalid');
        const session = await ensureAdminSession(db, request, reply);
        return protectedReply(reply).type('text/html; charset=utf-8').send(resetHtml(session, request.query.token));
    });

    app.post('/admin/reset-password', async (request, reply) => {
        if (!verifyCsrf(request.adminSession, request.body?.csrf_token)) return protectedReply(reply).code(403).send({ error: 'csrf_mismatch' });
        if (request.body?.password !== request.body?.confirm_password) return protectedReply(reply).code(422).send({ error: 'password_mismatch' });
        if (!await setPasswordFromReset(db, request.body?.token, request.body?.password)) return protectedReply(reply).code(422).send({ error: 'invalid_token' });
        return protectedReply(reply).send({ changed: true, redirect: '/admin/login?reset=success' });
    });

    app.post('/admin/logout', async (request, reply) => {
        const session = request.adminSession;
        if (!verifyCsrf(session, request.body?.csrf_token)) return protectedReply(reply).code(403).send({ error: 'csrf_mismatch' });
        await logoutAdmin(db, session, reply);
        return protectedReply(reply).send({ logged_out: true, redirect: '/admin/login' });
    });

    app.get('/admin/password', async (request, reply) => {
        const session = request.adminSession;
        if (!session?.user) return reply.redirect('/admin/login');
        return protectedReply(reply).type('text/html; charset=utf-8').send(passwordHtml(session, session.user));
    });

    app.post('/admin/password', async (request, reply) => {
        const session = request.adminSession;
        if (!session?.user) return protectedReply(reply).code(401).send({ error: 'authentication_required' });
        if (!verifyCsrf(session, request.body?.csrf_token)) return protectedReply(reply).code(403).send({ error: 'csrf_mismatch' });
        if (request.body?.new_password !== request.body?.confirm_password) return protectedReply(reply).code(422).send({ error: 'password_mismatch' });
        const changed = await updateAdminPassword(db, session, request.body?.current_password, request.body?.new_password);
        if (!changed) return protectedReply(reply).code(422).send({ error: 'password_change_failed' });
        return protectedReply(reply).send({ changed: true, redirect: session.user.type === 'business_user' ? `/admin/tenants/${encodeURIComponent(session.user.tenant_id)}` : '/admin' });
    });

    app.get('/admin', async (request, reply) => {
        const session = request.adminSession;
        if (!session?.user) return reply.redirect('/admin/login');
        if (session.data.force_password_change) return reply.redirect('/admin/password');
        if (session.user.type === 'business_user') return reply.redirect(`/admin/tenants/${encodeURIComponent(session.user.tenant_id)}`);
        const summary = await dashboardSummary(db);
        return protectedReply(reply).type('text/html; charset=utf-8').send(dashboardPage(session, summary, true));
    });

    app.get('/admin/tenants/:tenantId', async (request, reply) => {
        const session = request.adminSession;
        if (!session?.user) return reply.redirect('/admin/login');
        if (session.data.force_password_change) return reply.redirect('/admin/password');
        if (session.user.type === 'business_user' && session.user.tenant_id !== request.params.tenantId) {
            return protectedReply(reply).code(403).send({ error: 'forbidden' });
        }
        const summary = await dashboardSummary(db, request.params.tenantId);
        if (!summary) return protectedReply(reply).code(404).send({ error: 'tenant_not_found' });
        return protectedReply(reply).type('text/html; charset=utf-8').send(dashboardPage(session, summary));
    });

    app.get('/admin/tenants', async (request, reply) => {
        if (request.adminSession.user.type !== 'operator') return protectedReply(reply).code(403).send({ error: 'forbidden' });
        const { rows } = await db.query("SELECT id,name,slug,status,booking_pattern FROM tenants ORDER BY name,id LIMIT 500");
        const tenants = rows.map((tenant) => `<tr><td><a href="/admin/tenants/${encodeURIComponent(tenant.id)}">${escapeHtml(tenant.name)}</a></td><td>${escapeHtml(tenant.slug)}</td><td>${escapeHtml(tenant.booking_pattern)}</td><td>${escapeHtml(tenant.status)}</td></tr>`).join('');
        return protectedReply(reply).type('text/html; charset=utf-8').send(authPage('Empresas', `<h1>Empresas</h1><p><a href="/admin">← Painel</a></p><div class="table-wrap"><table><thead><tr><th>Empresa</th><th>Slug</th><th>Tipo</th><th>Status</th></tr></thead><tbody>${tenants || '<tr><td colspan="4">Nenhuma empresa encontrada.</td></tr>'}</tbody></table></div>`));
    });

    app.get('/admin/bookings', async (request, reply) => {
        if (request.adminSession.user.type !== 'operator') return protectedReply(reply).code(403).send({ error: 'forbidden' });
        const result = await listAdminBookings(db, request.query);
        return protectedReply(reply).type('text/html; charset=utf-8').send(bookingsHtml({ user: request.adminSession.user, result, query: request.query, csrfToken: request.adminSession.data.csrf_token }));
    });

    app.get('/admin/bookings/:bookingId', async (request, reply) => {
        if (request.adminSession.user.type !== 'operator') return protectedReply(reply).code(403).send({ error: 'forbidden' });
        const booking = await getAdminBooking(db, request.params.bookingId);
        if (!booking) return protectedReply(reply).code(404).send('Reserva não encontrada.');
        return protectedReply(reply).type('text/html; charset=utf-8').send(bookingDetailHtml(request.adminSession, booking));
    });

    app.post('/admin/bookings/:bookingId/status', async (request, reply) => {
        const session = request.adminSession;
        if (session.user.type !== 'operator') return protectedReply(reply).code(403).send({ error: 'forbidden' });
        if (!verifyCsrf(session, request.body?.csrf_token)) return protectedReply(reply).code(403).send({ error: 'csrf_mismatch' });
        try {
            const result = await changeAdminBookingStatus(db, { bookingId: request.params.bookingId, status: request.body?.status, actor: session.user, ip: request.ip });
            return protectedReply(reply).send({ updated: true, status: result.status, redirect: `/admin/bookings/${encodeURIComponent(request.params.bookingId)}` });
        } catch (error) {
            if (error instanceof AdminBookingProblem) return protectedReply(reply).code(error.statusCode).send({ error: error.code });
            throw error;
        }
    });

    app.get('/admin/tenants/:tenantId/bookings', async (request, reply) => {
        const result = await listAdminBookings(db, request.query, request.params.tenantId);
        return protectedReply(reply).type('text/html; charset=utf-8').send(bookingsHtml({ user: request.adminSession.user, result, query: request.query, csrfToken: request.adminSession.data.csrf_token, tenantId: request.params.tenantId }));
    });

    app.get('/admin/tenants/:tenantId/bookings/:bookingId', async (request, reply) => {
        const booking = await getAdminBooking(db, request.params.bookingId, request.params.tenantId);
        if (!booking) return protectedReply(reply).code(404).send('Reserva não encontrada.');
        return protectedReply(reply).type('text/html; charset=utf-8').send(bookingDetailHtml(request.adminSession, booking, request.params.tenantId));
    });

    app.post('/admin/tenants/:tenantId/bookings/:bookingId/status', async (request, reply) => {
        const session = request.adminSession;
        if (!verifyCsrf(session, request.body?.csrf_token)) return protectedReply(reply).code(403).send({ error: 'csrf_mismatch' });
        try {
            const result = await changeAdminBookingStatus(db, { bookingId: request.params.bookingId, tenantId: request.params.tenantId, status: request.body?.status, actor: session.user, ip: request.ip });
            return protectedReply(reply).send({ updated: true, status: result.status, redirect: `/admin/tenants/${encodeURIComponent(request.params.tenantId)}/bookings/${encodeURIComponent(request.params.bookingId)}` });
        } catch (error) {
            if (error instanceof AdminBookingProblem) return protectedReply(reply).code(error.statusCode).send({ error: error.code });
            throw error;
        }
    });

    app.get('/admin/tenants/:tenantId/customers', async (request, reply) => {
        const tenant = await db.query('SELECT id FROM tenants WHERE id=$1 AND status<>$2 LIMIT 1', [request.params.tenantId, 'archived']);
        if (!tenant.rows[0]) return protectedReply(reply).code(404).send('Empresa não encontrada.');
        const result = await listAdminCustomers(db, request.params.tenantId, request.query);
        return protectedReply(reply).type('text/html; charset=utf-8').send(customersHtml(request.adminSession, result, request.params.tenantId));
    });

    app.get('/admin/tenants/:tenantId/customers/:customerId', async (request, reply) => {
        const customer = await getAdminCustomer(db, request.params.tenantId, request.params.customerId, Number(request.query.page) || 1);
        if (!customer) return protectedReply(reply).code(404).send('Cliente não encontrado.');
        return protectedReply(reply).type('text/html; charset=utf-8').send(customerDetailHtml(customer, request.params.tenantId));
    });
}
