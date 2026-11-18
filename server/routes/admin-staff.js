import {
    AdminStaffProblem, changeAdminStaffState, createAdminStaff, getAdminStaff,
    listAdminStaff, reorderAdminStaff, updateAdminStaff,
} from '../services/admin-staff.js';
import { verifyCsrf } from '../services/admin-auth.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const protectedReply = (reply) => reply.header('Cache-Control', 'no-store, private').header('Referrer-Policy', 'no-referrer').header('X-Robots-Tag', 'noindex, nofollow');

function page(title, content) {
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · VoxelBooking</title><style>body{font:15px system-ui,sans-serif;background:#f4f6fa;color:#17212f;margin:0}.box{max-width:1050px;margin:5vh auto;background:white;border:1px solid #e1e6ee;border-radius:14px;padding:26px}a{color:#2563eb}label{display:block;font-weight:600;margin:14px 0 5px}input,textarea{box-sizing:border-box;padding:10px;border:1px solid #b9c3d0;border-radius:7px;font:inherit}input:not([type=checkbox]){width:100%}textarea{width:100%;min-height:90px}button{padding:9px 14px;border:0;border-radius:7px;background:#2563eb;color:white;font:inherit;cursor:pointer}.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;text-align:left;margin-top:20px}td,th{padding:10px;border-bottom:1px solid #e1e6ee}.error{color:#b42318}fieldset label{font-weight:400}</style></head><body><main class="box">${content}</main><script>
document.querySelectorAll('form[data-json]').forEach(form=>form.addEventListener('submit',async event=>{event.preventDefault();const data=Object.fromEntries(new FormData(form));for(const key of ['phone','title','bio'])if(data[key]==='')data[key]=null;data.service_ids=[...form.querySelectorAll('[name="service_ids"]:checked')].map(x=>x.value);if(data.is_active!==undefined)data.is_active=data.is_active==='true';const error=form.querySelector('.error');try{const response=await fetch(form.action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});const result=await response.json();if(!response.ok)throw new Error(result.error||'Falha ao salvar');location.href=result.redirect||location.pathname.replace(/\\/(create|[^/]+\\/edit)$/,'');}catch(e){error.textContent=e.message;}}));
</script></body></html>`;
}

function memberForm(tenant, member, services, csrfToken) {
    const editing = Boolean(member); const base = `/admin/tenants/${encodeURIComponent(tenant.id)}/staff`;
    const action = editing ? `${base}/${encodeURIComponent(member.id)}/update` : `${base}/create`;
    const selected = new Set(member?.service_ids || []);
    return page(`${editing ? 'Editar profissional' : 'Novo profissional'} · ${tenant.name}`, `<p><a href="${base}">← Profissionais</a> · <a href="/admin/tenants/${encodeURIComponent(tenant.id)}">Painel</a></p><h1>${editing ? 'Editar profissional' : 'Novo profissional'} · ${escapeHtml(tenant.name)}</h1>
<form data-json action="${action}"><input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">${editing ? `<input type="hidden" name="expected_version" value="${escapeHtml(member.version)}">` : ''}<label>Nome *</label><input name="name" required maxlength="255" value="${escapeHtml(member?.name || '')}"><label>E-mail *</label><input name="email" type="email" required maxlength="255" value="${escapeHtml(member?.email || '')}"><label>Telefone</label><input name="phone" maxlength="50" value="${escapeHtml(member?.phone || '')}"><label>Cargo</label><input name="title" maxlength="255" value="${escapeHtml(member?.title || '')}"><label>Biografia</label><textarea name="bio" maxlength="20000">${escapeHtml(member?.bio || '')}</textarea><fieldset><legend>Serviços associados</legend>${services.map((service) => `<label><input type="checkbox" name="service_ids" value="${escapeHtml(service.id)}" ${selected.has(service.id) ? 'checked' : ''}> ${escapeHtml(service.name)}</label>`).join('') || '<p>Nenhum serviço ativo cadastrado.</p>'}</fieldset><p>O cadastro de avatar será habilitado quando o módulo de uploads e armazenamento estiver migrado.</p><p class="error" role="alert"></p><div class="toolbar"><button>${editing ? 'Salvar alterações' : 'Criar profissional'}</button><a href="${base}">Cancelar</a></div></form>`);
}

function listPage(tenant, members, csrfToken) {
    const base = `/admin/tenants/${encodeURIComponent(tenant.id)}/staff`;
    const rows = members.map((member) => `<tr><td>${escapeHtml(member.name)}${member.title ? `<small> · ${escapeHtml(member.title)}</small>` : ''}</td><td>${escapeHtml(member.email)}</td><td>${member.service_count}</td><td>${member.is_active ? 'Ativo' : 'Inativo'}</td><td><a href="${base}/${encodeURIComponent(member.id)}/edit">Editar</a><form data-json action="${base}/${encodeURIComponent(member.id)}/state"><input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}"><input type="hidden" name="expected_version" value="${escapeHtml(member.version)}"><input type="hidden" name="is_active" value="${member.is_active ? 'false' : 'true'}"><button>${member.is_active ? 'Desativar' : 'Ativar'}</button><p class="error"></p></form></td><td><div class="toolbar">${['up','down'].map((direction) => `<form data-json action="${base}/${encodeURIComponent(member.id)}/reorder"><input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}"><input type="hidden" name="expected_version" value="${escapeHtml(member.version)}"><input type="hidden" name="direction" value="${direction}"><button aria-label="Mover ${direction === 'up' ? 'para cima' : 'para baixo'}">${direction === 'up' ? '↑' : '↓'}</button><p class="error"></p></form>`).join('')}</div></td></tr>`).join('');
    return page(`Profissionais · ${tenant.name}`, `<p><a href="/admin/tenants/${encodeURIComponent(tenant.id)}">← Painel</a> · <a href="/admin/tenants/${encodeURIComponent(tenant.id)}/services">Serviços</a></p><div class="toolbar"><h1>Profissionais · ${escapeHtml(tenant.name)}</h1><a href="${base}/create">Novo profissional</a></div><div class="table-wrap"><table><thead><tr><th>Nome</th><th>E-mail</th><th>Serviços</th><th>Status</th><th>Ação</th><th>Ordem</th></tr></thead><tbody>${rows || '<tr><td colspan="6">Nenhum profissional cadastrado.</td></tr>'}</tbody></table></div>`);
}

export async function registerAdminStaffRoutes(app, { db }) {
    const base = '/admin/tenants/:tenantId/staff';
    async function context(request, reply) {
        const { tenantId } = request.params; const user = request.adminSession?.user;
        if (!(user?.type === 'operator' || (user?.type === 'business_user' && user.tenant_id === tenantId && user.role === 'owner'))) {
            protectedReply(reply).code(403).send({ error: 'forbidden' }); return null;
        }
        const { rows } = await db.query('SELECT id,name,booking_pattern FROM tenants WHERE id=$1 LIMIT 1', [tenantId]);
        if (!rows[0]) { protectedReply(reply).code(404).send({ error: 'tenant_not_found' }); return null; }
        if (rows[0].booking_pattern !== 'timeslot') { protectedReply(reply).code(404).send({ error: 'staff_not_available' }); return null; }
        return { tenant: rows[0], user };
    }
    const problem = (reply, error) => { if (!(error instanceof AdminStaffProblem)) throw error; return protectedReply(reply).code(error.status).send({ error: error.code, ...error.details }); };
    async function formServices(tenantId) {
        const { rows } = await db.query('SELECT id,name FROM services WHERE tenant_id=$1 AND is_active=TRUE ORDER BY sort_order,name,id', [tenantId]); return rows;
    }
    app.get(base, async (request, reply) => {
        const ctx = await context(request, reply); if (!ctx) return;
        const members = await listAdminStaff(db, ctx.tenant.id);
        const versions = await Promise.all(members.map((member) => getAdminStaff(db, ctx.tenant.id, member.id)));
        const versionMap = new Map(versions.map((member) => [member.id, member.version]));
        return protectedReply(reply).type('text/html; charset=utf-8').send(listPage(ctx.tenant, members.map((member) => ({ ...member, version: versionMap.get(member.id) })), request.adminSession.data.csrf_token));
    });
    app.get(`${base}/create`, async (request, reply) => {
        const ctx = await context(request, reply); if (!ctx) return;
        return protectedReply(reply).type('text/html; charset=utf-8').send(memberForm(ctx.tenant, null, await formServices(ctx.tenant.id), request.adminSession.data.csrf_token));
    });
    app.get(`${base}/:staffId/edit`, async (request, reply) => {
        const ctx = await context(request, reply); if (!ctx) return;
        const member = await getAdminStaff(db, ctx.tenant.id, request.params.staffId);
        if (!member) return protectedReply(reply).code(404).send('Profissional não encontrado.');
        return protectedReply(reply).type('text/html; charset=utf-8').send(memberForm(ctx.tenant, member, await formServices(ctx.tenant.id), request.adminSession.data.csrf_token));
    });
    app.post(`${base}/create`, async (request, reply) => {
        const ctx = await context(request, reply); if (!ctx) return;
        if (!verifyCsrf(request.adminSession, request.body?.csrf_token)) return protectedReply(reply).code(403).send({ error: 'csrf_mismatch' });
        try { const member = await createAdminStaff(db, { tenantId: ctx.tenant.id, actor: ctx.user, input: request.body, ip: request.ip }); return protectedReply(reply).send({ created: true, id: member.id, redirect: `/admin/tenants/${encodeURIComponent(ctx.tenant.id)}/staff` }); }
        catch (error) { return problem(reply, error); }
    });
    app.post(`${base}/:staffId/update`, async (request, reply) => {
        const ctx = await context(request, reply); if (!ctx) return;
        if (!verifyCsrf(request.adminSession, request.body?.csrf_token)) return protectedReply(reply).code(403).send({ error: 'csrf_mismatch' });
        try { const member = await updateAdminStaff(db, { tenantId: ctx.tenant.id, actor: ctx.user, staffId: request.params.staffId, input: request.body, ip: request.ip }); return protectedReply(reply).send({ updated: true, id: member.id, redirect: `/admin/tenants/${encodeURIComponent(ctx.tenant.id)}/staff` }); }
        catch (error) { return problem(reply, error); }
    });
    app.post(`${base}/:staffId/state`, async (request, reply) => {
        const ctx = await context(request, reply); if (!ctx) return;
        if (!verifyCsrf(request.adminSession, request.body?.csrf_token)) return protectedReply(reply).code(403).send({ error: 'csrf_mismatch' });
        try { const member = await changeAdminStaffState(db, { tenantId: ctx.tenant.id, actor: ctx.user, staffId: request.params.staffId, input: request.body, ip: request.ip }); return protectedReply(reply).send({ updated: true, is_active: member.is_active, redirect: `/admin/tenants/${encodeURIComponent(ctx.tenant.id)}/staff` }); }
        catch (error) { return problem(reply, error); }
    });
    app.post(`${base}/:staffId/reorder`, async (request, reply) => {
        const ctx = await context(request, reply); if (!ctx) return;
        if (!verifyCsrf(request.adminSession, request.body?.csrf_token)) return protectedReply(reply).code(403).send({ error: 'csrf_mismatch' });
        try { await reorderAdminStaff(db, { tenantId: ctx.tenant.id, actor: ctx.user, staffId: request.params.staffId, input: request.body, ip: request.ip }); return protectedReply(reply).send({ updated: true, redirect: `/admin/tenants/${encodeURIComponent(ctx.tenant.id)}/staff` }); }
        catch (error) { return problem(reply, error); }
    });
}
