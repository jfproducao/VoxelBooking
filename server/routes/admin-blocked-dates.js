import { AdminBlockedDateProblem, createAdminBlockedDate, deleteAdminBlockedDate, getAdminBlockedDates } from '../services/admin-blocked-dates.js';
import { verifyCsrf } from '../services/admin-auth.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const protectedReply = (reply) => reply.header('Cache-Control', 'no-store, private').header('Referrer-Policy', 'no-referrer').header('X-Robots-Tag', 'noindex, nofollow');
function page(title, content) {
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · VoxelBooking</title><style>body{font:15px system-ui,sans-serif;background:#f4f6fa;color:#17212f;margin:0}.box{max-width:1100px;margin:5vh auto;background:white;border:1px solid #e1e6ee;border-radius:14px;padding:26px}a{color:#2563eb}label{display:block;font-weight:600;margin:12px 0 5px}input,select{box-sizing:border-box;padding:10px;border:1px solid #b9c3d0;border-radius:7px;font:inherit}button{padding:9px 14px;border:0;border-radius:7px;background:#2563eb;color:white;font:inherit;cursor:pointer}.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.form-grid input,.form-grid select{width:100%}.toolbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.panel{padding:18px;border:1px solid #e1e6ee;border-radius:10px;margin:18px 0}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;text-align:left}th,td{padding:10px;border-bottom:1px solid #e1e6ee}.error{color:#b42318}.muted{color:#64748b}</style></head><body><main class="box">${content}</main><script>
document.querySelectorAll('form[data-json]').forEach(form=>form.addEventListener('submit',async event=>{event.preventDefault();const data=Object.fromEntries(new FormData(form));for(const key of ['staff_id','resource_id','reason'])if(data[key]==='')data[key]=null;const error=form.querySelector('.error');try{const response=await fetch(form.action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});const result=await response.json();if(!response.ok)throw new Error(result.error==='conflict'?'Já existe um bloqueio sobreposto para este escopo.':result.error||'Falha ao salvar');location.href=result.redirect||location.pathname;}catch(e){error.textContent=e.message;}}));
</script></body></html>`;
}
function blockedTable(rows, tenantId, csrf) {
    if (!rows.length) return '<p class="muted">Nenhum período bloqueado.</p>';
    return `<div class="table-wrap"><table><thead><tr><th>Datas</th><th>Escopo</th><th>Motivo</th><th>Reservas afetadas</th><th>Ação</th></tr></thead><tbody>${rows.map((row) => {
        const scope = row.staff_id ? row.staff_name || 'Profissional' : row.resource_id ? row.resource_name || 'Recurso' : 'Empresa';
        return `<tr><td>${escapeHtml(row.start_date)}${row.start_date === row.end_date ? '' : ` – ${escapeHtml(row.end_date)}`}</td><td>${escapeHtml(scope)}</td><td>${escapeHtml(row.reason || '—')}</td><td>${row.affected_booking_count}</td><td><form data-json action="/admin/tenants/${encodeURIComponent(tenantId)}/blocked-dates/${encodeURIComponent(row.id)}/delete"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><input type="hidden" name="expected_version" value="${escapeHtml(row.version)}"><p class="error"></p><button>Excluir</button></form></td></tr>`;
    }).join('')}</tbody></table></div>`;
}
function blockedDatesPage(context, csrf) {
    const { tenant, staff, resources, upcoming, past } = context; const base = `/admin/tenants/${encodeURIComponent(tenant.id)}/blocked-dates`;
    const staffOptions = staff.map((row) => `<option value="${escapeHtml(row.id)}">${escapeHtml(row.name)}${row.title ? ` · ${escapeHtml(row.title)}` : ''}</option>`).join('');
    const resourceOptions = resources.map((row) => `<option value="${escapeHtml(row.id)}">${escapeHtml(row.name)}</option>`).join('');
    const scope = tenant.booking_pattern === 'timeslot' ? `<label>Profissional (opcional)<select name="staff_id"><option value="">Toda a empresa</option>${staffOptions}</select></label>` : tenant.booking_pattern === 'resource' ? `<label>Recurso (opcional)<select name="resource_id"><option value="">Toda a empresa</option>${resourceOptions}</select></label>` : '';
    return page(`Datas bloqueadas · ${tenant.name}`, `<p><a href="/admin/tenants/${encodeURIComponent(tenant.id)}">← Painel</a></p><h1>Datas bloqueadas · ${escapeHtml(tenant.name)}</h1><p>Fuso horário: ${escapeHtml(tenant.timezone)}</p><section class="panel"><h2>Adicionar bloqueio</h2><form data-json action="${base}/create"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><div class="form-grid"><label>Data inicial<input name="start_date" type="date" required></label><label>Data final<input name="end_date" type="date" required></label><label>Motivo<input name="reason" maxlength="255"></label>${scope}</div><p class="error" role="alert"></p><button>Adicionar</button></form></section><section class="panel"><h2>Próximos e atuais</h2>${blockedTable(upcoming, tenant.id, csrf)}</section><details class="panel"><summary>Passados (${past.length})</summary>${blockedTable(past, tenant.id, csrf)}</details>`);
}

export async function registerAdminBlockedDateRoutes(app, { db }) {
    const base = '/admin/tenants/:tenantId/blocked-dates';
    async function context(request, reply) {
        const { tenantId } = request.params; const user = request.adminSession?.user;
        if (!(user?.type === 'operator' || (user?.type === 'business_user' && user.tenant_id === tenantId && user.role === 'owner'))) { protectedReply(reply).code(403).send({ error: 'forbidden' }); return null; }
        try { return { ...(await getAdminBlockedDates(db, tenantId)), user }; }
        catch (error) { if (error instanceof AdminBlockedDateProblem) { protectedReply(reply).code(error.status).send({ error: error.code }); return null; } throw error; }
    }
    const sendProblem = (reply, error) => { if (!(error instanceof AdminBlockedDateProblem)) throw error; return protectedReply(reply).code(error.status).send({ error: error.code, ...error.details }); };
    app.get(base, async (request, reply) => { const ctx = await context(request, reply); if (!ctx) return; return protectedReply(reply).type('text/html; charset=utf-8').send(blockedDatesPage(ctx, request.adminSession.data.csrf_token)); });
    app.post(`${base}/create`, async (request, reply) => {
        const ctx = await context(request, reply); if (!ctx) return;
        if (!verifyCsrf(request.adminSession, request.body?.csrf_token)) return protectedReply(reply).code(403).send({ error: 'csrf_mismatch' });
        try { const item = await createAdminBlockedDate(db, { tenantId: ctx.tenant.id, actor: ctx.user, input: request.body, ip: request.ip }); return protectedReply(reply).send({ created: true, id: item.id, redirect: `/admin/tenants/${encodeURIComponent(ctx.tenant.id)}/blocked-dates` }); }
        catch (error) { return sendProblem(reply, error); }
    });
    app.post(`${base}/:blockedDateId/delete`, async (request, reply) => {
        const ctx = await context(request, reply); if (!ctx) return;
        if (!verifyCsrf(request.adminSession, request.body?.csrf_token)) return protectedReply(reply).code(403).send({ error: 'csrf_mismatch' });
        try { await deleteAdminBlockedDate(db, { tenantId: ctx.tenant.id, actor: ctx.user, id: request.params.blockedDateId, expectedVersion: request.body?.expected_version, ip: request.ip }); return protectedReply(reply).send({ deleted: true, redirect: `/admin/tenants/${encodeURIComponent(ctx.tenant.id)}/blocked-dates` }); }
        catch (error) { return sendProblem(reply, error); }
    });
}
