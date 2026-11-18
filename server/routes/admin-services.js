import {
    AdminServiceProblem, changeAdminServiceState, createAdminService, getAdminService,
    listAdminServices, reorderAdminService, updateAdminService,
} from '../services/admin-services.js';
import { verifyCsrf } from '../services/admin-auth.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const protectedReply = (reply) => reply.header('Cache-Control', 'no-store, private').header('Referrer-Policy', 'no-referrer').header('X-Robots-Tag', 'noindex, nofollow');

function allowed(request, reply, tenantId) {
    const user = request.adminSession?.user;
    if (user?.type === 'operator') return true;
    if (user?.type !== 'business_user' || user.tenant_id !== tenantId || user.role !== 'owner') {
        protectedReply(reply).code(403).send({ error: 'forbidden' });
        return false;
    }
    return true;
}

async function tenantFor(db, tenantId) {
    const { rows } = await db.query('SELECT id,name,booking_pattern FROM tenants WHERE id=$1 LIMIT 1', [tenantId]);
    return rows[0] || null;
}

function page(title, body) {
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · VoxelBooking</title><style>body{font:15px system-ui,sans-serif;background:#f4f6fa;color:#17212f;margin:0}.box{max-width:1050px;margin:5vh auto;background:white;border:1px solid #e1e6ee;border-radius:14px;padding:26px}a{color:#2563eb}label{display:block;font-weight:600;margin:14px 0 5px}input,textarea{box-sizing:border-box;width:100%;padding:10px;border:1px solid #b9c3d0;border-radius:7px;font:inherit}textarea{min-height:90px}button{padding:9px 14px;border:0;border-radius:7px;background:#2563eb;color:white;font:inherit;cursor:pointer}.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;text-align:left;margin-top:20px}td,th{padding:10px;border-bottom:1px solid #e1e6ee}.error{color:#b42318}</style></head><body><main class="box">${body}</main><script>
document.querySelectorAll('form[data-json]').forEach(form=>form.addEventListener('submit',async event=>{event.preventDefault();const data=Object.fromEntries(new FormData(form));data.duration_minutes=Number(data.duration_minutes);for(const key of ['price','description','price_label','category','color'])if(data[key]==='')data[key]=null;data.staff_ids=[...form.querySelectorAll('[name="staff_ids"]:checked')].map(x=>x.value);if(data.is_active!==undefined)data.is_active=data.is_active==='true';const error=form.querySelector('.error');try{const response=await fetch(form.action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});const result=await response.json();if(!response.ok)throw new Error(result.error||'Falha ao salvar');location.href=result.redirect||location.pathname.replace(/\/(create|[^/]+\/edit)$/,'');}catch(e){error.textContent=e.message;}}));
</script></body></html>`;
}

function serviceForm(tenant, service, staff, csrfToken) {
    const isEdit = Boolean(service); const base = `/admin/tenants/${encodeURIComponent(tenant.id)}/services`;
    const action = isEdit ? `${base}/${encodeURIComponent(service.id)}/update` : `${base}/create`;
    const selected = new Set(service?.staff_ids || []);
    return page(isEdit ? 'Editar serviço' : 'Novo serviço', `<p><a href="${base}">← Serviços</a> · <a href="/admin/tenants/${encodeURIComponent(tenant.id)}">Painel</a></p><h1>${isEdit ? 'Editar serviço' : 'Novo serviço'} · ${escapeHtml(tenant.name)}</h1>
<form data-json action="${action}"><input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">${isEdit ? `<input type="hidden" name="expected_version" value="${escapeHtml(service.version)}">` : ''}<label>Nome</label><input name="name" maxlength="255" required value="${escapeHtml(service?.name || '')}"><label>Descrição</label><textarea name="description" maxlength="20000">${escapeHtml(service?.description || '')}</textarea><label>Duração (minutos)</label><input name="duration_minutes" type="number" min="1" max="1440" required value="${service?.duration_minutes ?? 30}"><label>Preço (opcional)</label><input name="price" inputmode="decimal" placeholder="0.00" value="${escapeHtml(service?.price || '')}"><label>Texto do preço</label><input name="price_label" maxlength="100" value="${escapeHtml(service?.price_label || '')}"><label>Categoria</label><input name="category" maxlength="100" value="${escapeHtml(service?.category || '')}"><label>Cor (hex)</label><input name="color" placeholder="#2563eb" value="${escapeHtml(service?.color || '')}"><fieldset><legend>Profissionais associados</legend>${staff.map((person) => `<label><input style="width:auto" type="checkbox" name="staff_ids" value="${escapeHtml(person.id)}" ${selected.has(person.id) ? 'checked' : ''}> ${escapeHtml(person.name)}${person.title ? ` · ${escapeHtml(person.title)}` : ''}</label>`).join('') || '<p>Nenhum profissional ativo cadastrado.</p>'}</fieldset><p class="error" role="alert"></p><div class="toolbar"><button>${isEdit ? 'Salvar alterações' : 'Criar serviço'}</button><a href="${base}">Cancelar</a></div></form>`);
}

function listPage(tenant, services, csrfToken) {
    const base = `/admin/tenants/${encodeURIComponent(tenant.id)}/services`;
    const rows = services.map((service) => `<tr><td><a href="${base}/${encodeURIComponent(service.id)}/edit">${escapeHtml(service.name)}</a></td><td>${service.duration_minutes} min</td><td>${service.price === null ? '—' : escapeHtml(service.price)}</td><td>${service.staff_count}</td><td>${service.is_active ? 'Ativo' : 'Inativo'}</td><td><form data-json action="${base}/${encodeURIComponent(service.id)}/state"><input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}"><input type="hidden" name="expected_version" value="${escapeHtml(service.version)}"><input type="hidden" name="is_active" value="${service.is_active ? 'false' : 'true'}"><button>${service.is_active ? 'Desativar' : 'Ativar'}</button><p class="error"></p></form></td><td><div class="toolbar">${['up','down'].map((direction) => `<form data-json action="${base}/${encodeURIComponent(service.id)}/reorder"><input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}"><input type="hidden" name="expected_version" value="${escapeHtml(service.version)}"><input type="hidden" name="direction" value="${direction}"><button aria-label="Mover ${direction === 'up' ? 'para cima' : 'para baixo'}">${direction === 'up' ? '↑' : '↓'}</button><p class="error"></p></form>`).join('')}</div></td></tr>`).join('');
    return page(`Serviços · ${tenant.name}`, `<p><a href="/admin/tenants/${encodeURIComponent(tenant.id)}">← Painel</a></p><div class="toolbar"><h1>Serviços · ${escapeHtml(tenant.name)}</h1><a href="${base}/create">Novo serviço</a></div><div class="table-wrap"><table><thead><tr><th>Serviço</th><th>Duração</th><th>Preço</th><th>Profissionais</th><th>Status</th><th>Ação</th><th>Ordem</th></tr></thead><tbody>${rows || '<tr><td colspan="7">Nenhum serviço cadastrado.</td></tr>'}</tbody></table></div>`);
}

export async function registerAdminServiceRoutes(app, { db }) {
    const base = '/admin/tenants/:tenantId/services';
    async function context(request, reply) {
        const tenantId = request.params.tenantId;
        if (!allowed(request, reply, tenantId)) return null;
        const tenant = await tenantFor(db, tenantId);
        if (!tenant) { protectedReply(reply).code(404).send({ error: 'tenant_not_found' }); return null; }
        if (tenant.booking_pattern !== 'timeslot') { protectedReply(reply).code(404).send({ error: 'services_not_available' }); return null; }
        return { tenant, user: request.adminSession.user };
    }
    const sendProblem = (reply, error) => {
        if (!(error instanceof AdminServiceProblem)) throw error;
        return protectedReply(reply).code(error.status).send({ error: error.code, ...error.details });
    };
    app.get(base, async (request, reply) => {
        const ctx = await context(request, reply); if (!ctx) return;
        const services = await listAdminServices(db, ctx.tenant.id);
        const versions = await Promise.all(services.map((row) => getAdminService(db, ctx.tenant.id, row.id)));
        const versionMap = new Map(versions.map((row) => [row.id, row.version]));
        return protectedReply(reply).type('text/html; charset=utf-8').send(listPage(ctx.tenant, services.map((row) => ({ ...row, version: versionMap.get(row.id) })), request.adminSession.data.csrf_token));
    });
    app.get(`${base}/create`, async (request, reply) => {
        const ctx = await context(request, reply); if (!ctx) return;
        const { rows } = await db.query('SELECT id,name,title FROM staff WHERE tenant_id=$1 AND is_active=TRUE ORDER BY sort_order,name,id', [ctx.tenant.id]);
        return protectedReply(reply).type('text/html; charset=utf-8').send(serviceForm(ctx.tenant, null, rows, request.adminSession.data.csrf_token));
    });
    app.get(`${base}/:serviceId/edit`, async (request, reply) => {
        const ctx = await context(request, reply); if (!ctx) return;
        const service = await getAdminService(db, ctx.tenant.id, request.params.serviceId);
        if (!service) return protectedReply(reply).code(404).send('Serviço não encontrado.');
        const { rows } = await db.query('SELECT id,name,title FROM staff WHERE tenant_id=$1 AND is_active=TRUE ORDER BY sort_order,name,id', [ctx.tenant.id]);
        return protectedReply(reply).type('text/html; charset=utf-8').send(serviceForm(ctx.tenant, service, rows, request.adminSession.data.csrf_token));
    });
    app.post(`${base}/create`, async (request, reply) => {
        const ctx = await context(request, reply); if (!ctx) return;
        if (!verifyCsrf(request.adminSession, request.body?.csrf_token)) return protectedReply(reply).code(403).send({ error: 'csrf_mismatch' });
        try { const service = await createAdminService(db, { tenantId: ctx.tenant.id, actor: ctx.user, input: request.body, ip: request.ip }); return protectedReply(reply).send({ created: true, id: service.id, redirect: `/admin/tenants/${encodeURIComponent(ctx.tenant.id)}/services` }); }
        catch (error) { return sendProblem(reply, error); }
    });
    app.post(`${base}/:serviceId/update`, async (request, reply) => {
        const ctx = await context(request, reply); if (!ctx) return;
        if (!verifyCsrf(request.adminSession, request.body?.csrf_token)) return protectedReply(reply).code(403).send({ error: 'csrf_mismatch' });
        try { const service = await updateAdminService(db, { tenantId: ctx.tenant.id, actor: ctx.user, serviceId: request.params.serviceId, input: request.body, ip: request.ip }); return protectedReply(reply).send({ updated: true, id: service.id, redirect: `/admin/tenants/${encodeURIComponent(ctx.tenant.id)}/services` }); }
        catch (error) { return sendProblem(reply, error); }
    });
    app.post(`${base}/:serviceId/state`, async (request, reply) => {
        const ctx = await context(request, reply); if (!ctx) return;
        if (!verifyCsrf(request.adminSession, request.body?.csrf_token)) return protectedReply(reply).code(403).send({ error: 'csrf_mismatch' });
        try { const service = await changeAdminServiceState(db, { tenantId: ctx.tenant.id, actor: ctx.user, serviceId: request.params.serviceId, input: request.body, ip: request.ip }); return protectedReply(reply).send({ updated: true, is_active: service.is_active, redirect: `/admin/tenants/${encodeURIComponent(ctx.tenant.id)}/services` }); }
        catch (error) { return sendProblem(reply, error); }
    });
    app.post(`${base}/:serviceId/reorder`, async (request, reply) => {
        const ctx = await context(request, reply); if (!ctx) return;
        if (!verifyCsrf(request.adminSession, request.body?.csrf_token)) return protectedReply(reply).code(403).send({ error: 'csrf_mismatch' });
        try { await reorderAdminService(db, { tenantId: ctx.tenant.id, actor: ctx.user, serviceId: request.params.serviceId, input: request.body, ip: request.ip }); return protectedReply(reply).send({ updated: true, redirect: `/admin/tenants/${encodeURIComponent(ctx.tenant.id)}/services` }); }
        catch (error) { return sendProblem(reply, error); }
    });
}
