import { AdminAvailabilityProblem, getAdminAvailabilityContext, getAdminSchedule, resetAdminStaffSchedule, saveAdminSchedule } from '../services/admin-availability.js';
import { verifyCsrf } from '../services/admin-auth.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const protectedReply = (reply) => reply.header('Cache-Control', 'no-store, private').header('Referrer-Policy', 'no-referrer').header('X-Robots-Tag', 'noindex, nofollow');
const dayLabels = ['Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado', 'Domingo'];

function page(title, content, staffId = null) {
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · VoxelBooking</title><style>body{font:15px system-ui,sans-serif;background:#f4f6fa;color:#17212f;margin:0}.box{max-width:1000px;margin:5vh auto;background:white;border:1px solid #e1e6ee;border-radius:14px;padding:26px}a{color:#2563eb}label{font-weight:600}.day{display:grid;grid-template-columns:180px 1fr;align-items:start;gap:14px;padding:14px 0;border-top:1px solid #e1e6ee}.day textarea{box-sizing:border-box;width:100%;min-height:48px;padding:10px;border:1px solid #b9c3d0;border-radius:7px;font:inherit}.toolbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:18px 0}button{padding:9px 14px;border:0;border-radius:7px;background:#2563eb;color:white;font:inherit;cursor:pointer}.secondary{background:#64748b}.error{color:#b42318}.badge{padding:4px 9px;border-radius:6px;background:#eff6ff;color:#1d4ed8}@media(max-width:600px){.day{grid-template-columns:1fr}.box{margin:0;border-radius:0}}</style></head><body><main class="box">${content}</main><script>
document.querySelectorAll('form[data-json]').forEach(form=>form.addEventListener('submit',async event=>{event.preventDefault();const data=Object.fromEntries(new FormData(form));const error=form.querySelector('.error');try{if(data.windows_text!==undefined){data.windows=[];for(let day=0;day<7;day++){const value=data['day_'+day]||'';for(const item of value.split(',').map(x=>x.trim()).filter(Boolean)){const match=item.match(/^(\\d{2}:\\d{2})\\s*-\\s*(\\d{2}:\\d{2})$/);if(!match)throw new Error('Use horários no formato 09:00-12:00, separados por vírgula.');data.windows.push({day_of_week:day,start_time:match[1],end_time:match[2]});}delete data['day_'+day];}delete data.windows_text;}const response=await fetch(form.action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});const result=await response.json();if(!response.ok)throw new Error(result.error==='version_conflict'?'A agenda mudou. Recarregue e tente de novo.':result.error||'Falha ao salvar');location.href=result.redirect||location.pathname;}catch(e){error.textContent=e.message;}}));
</script></body></html>`;
}

function schedulePage(context, schedule, csrf, staffId = null) {
    const { tenant, staff, staffOverrides } = context;
    const base = `/admin/tenants/${encodeURIComponent(tenant.id)}/availability`;
    const existing = Array.from({ length: 7 }, () => []);
    for (const window of schedule.windows) existing[window.day_of_week].push(`${window.start_time}-${window.end_time}`);
    const rows = dayLabels.map((label, day) => `<div class="day"><label for="day-${day}">${label}</label><textarea id="day-${day}" name="day_${day}" placeholder="09:00-12:00, 13:00-17:00">${escapeHtml(existing[day].join(', '))}</textarea></div>`).join('');
    const selected = staff.find((person) => person.id === staffId);
    const selector = `<form method="get"><label for="staff-picker">Profissional</label> <select id="staff-picker" onchange="location.href=this.value"><option value="${base}" ${staffId ? '' : 'selected'}>Agenda padrão da empresa</option>${staff.map((person) => `<option value="${base}/staff/${encodeURIComponent(person.id)}" ${person.id === staffId ? 'selected' : ''}>${escapeHtml(person.name)}${staffOverrides.includes(person.id) ? ' · horário próprio' : ' · herdado'}</option>`).join('')}</select></form>`;
    const reset = staffId && !schedule.inherits_business_schedule ? `<form data-json action="${base}/staff/${encodeURIComponent(staffId)}/reset"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><input type="hidden" name="expected_version" value="${escapeHtml(schedule.version)}"><p class="error" role="alert"></p><button class="secondary">Voltar à agenda padrão</button></form>` : '';
    const action = staffId ? `${base}/staff/${encodeURIComponent(staffId)}` : base;
    return page(`Disponibilidade · ${tenant.name}`, `<p><a href="/admin/tenants/${encodeURIComponent(tenant.id)}">← Painel</a> · <a href="${base}/staff">Profissionais</a></p><h1>Disponibilidade · ${escapeHtml(tenant.name)}</h1><p>Fuso horário: ${escapeHtml(tenant.timezone)}</p><div class="toolbar">${selector}${staffId ? (schedule.inherits_business_schedule ? '<span class="badge">Herdando horários padrão</span>' : '<span class="badge">Horário próprio</span>') : ''}</div>
<form data-json action="${action}"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><input type="hidden" name="expected_version" value="${escapeHtml(schedule.version)}"><input type="hidden" name="windows_text" value="1">${rows}<p>Informe uma ou mais janelas por dia, por exemplo: <code>09:00-12:00, 13:00-17:00</code>. Deixe vazio para fechar o dia.</p><p class="error" role="alert"></p><div class="toolbar"><button>Salvar horários</button>${selected ? `<span>Editando ${escapeHtml(selected.name)}</span>` : ''}</div></form><div class="toolbar">${reset}</div>` , staffId);
}

export async function registerAdminAvailabilityRoutes(app, { db }) {
    const base = '/admin/tenants/:tenantId/availability';
    async function context(request, reply) {
        const tenantId = request.params.tenantId; const user = request.adminSession?.user;
        if (!(user?.type === 'operator' || (user?.type === 'business_user' && user.tenant_id === tenantId && user.role === 'owner'))) { protectedReply(reply).code(403).send({ error: 'forbidden' }); return null; }
        try { return { ...(await getAdminAvailabilityContext(db, tenantId)), user }; }
        catch (error) { if (error instanceof AdminAvailabilityProblem) { protectedReply(reply).code(error.status).send({ error: error.code }); return null; } throw error; }
    }
    function handleProblem(reply, error) { if (!(error instanceof AdminAvailabilityProblem)) throw error; return protectedReply(reply).code(error.status).send({ error: error.code, ...error.details }); }
    app.get(base, async (request, reply) => {
        const ctx = await context(request, reply); if (!ctx) return;
        return protectedReply(reply).type('text/html; charset=utf-8').send(schedulePage(ctx, ctx.schedule, request.adminSession.data.csrf_token));
    });
    app.get(`${base}/staff/:staffId`, async (request, reply) => {
        const ctx = await context(request, reply); if (!ctx) return;
        try { const schedule = await getAdminSchedule(db, ctx.tenant.id, request.params.staffId); return protectedReply(reply).type('text/html; charset=utf-8').send(schedulePage(ctx, schedule, request.adminSession.data.csrf_token, request.params.staffId)); }
        catch (error) { return handleProblem(reply, error); }
    });
    app.post(base, async (request, reply) => {
        const ctx = await context(request, reply); if (!ctx) return;
        if (!verifyCsrf(request.adminSession, request.body?.csrf_token)) return protectedReply(reply).code(403).send({ error: 'csrf_mismatch' });
        try { await saveAdminSchedule(db, { tenantId: ctx.tenant.id, actor: ctx.user, input: request.body, ip: request.ip }); return protectedReply(reply).send({ saved: true, redirect: `/admin/tenants/${encodeURIComponent(ctx.tenant.id)}/availability` }); }
        catch (error) { return handleProblem(reply, error); }
    });
    app.post(`${base}/staff/:staffId`, async (request, reply) => {
        const ctx = await context(request, reply); if (!ctx) return;
        if (!verifyCsrf(request.adminSession, request.body?.csrf_token)) return protectedReply(reply).code(403).send({ error: 'csrf_mismatch' });
        try { await saveAdminSchedule(db, { tenantId: ctx.tenant.id, staffId: request.params.staffId, actor: ctx.user, input: request.body, ip: request.ip }); return protectedReply(reply).send({ saved: true, redirect: `/admin/tenants/${encodeURIComponent(ctx.tenant.id)}/availability/staff/${encodeURIComponent(request.params.staffId)}` }); }
        catch (error) { return handleProblem(reply, error); }
    });
    app.post(`${base}/staff/:staffId/reset`, async (request, reply) => {
        const ctx = await context(request, reply); if (!ctx) return;
        if (!verifyCsrf(request.adminSession, request.body?.csrf_token)) return protectedReply(reply).code(403).send({ error: 'csrf_mismatch' });
        try { await resetAdminStaffSchedule(db, { tenantId: ctx.tenant.id, staffId: request.params.staffId, actor: ctx.user, expectedVersion: request.body?.expected_version, ip: request.ip }); return protectedReply(reply).send({ reset: true, redirect: `/admin/tenants/${encodeURIComponent(ctx.tenant.id)}/availability/staff/${encodeURIComponent(request.params.staffId)}` }); }
        catch (error) { return handleProblem(reply, error); }
    });
}
