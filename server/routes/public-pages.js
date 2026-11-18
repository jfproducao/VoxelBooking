import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const clientScript = await readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'booking.js'),
    'utf8',
);
const manageScript = await readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'manage.js'),
    'utf8',
);
const resourceScript = await readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'resource-booking.js'),
    'utf8',
);
const capacityScript = await readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'capacity-booking.js'),
    'utf8',
);
const eventScript = await readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'event-booking.js'),
    'utf8',
);
const adminAuthScript = await readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'admin-auth.js'),
    'utf8',
);

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
}

function safeJson(value) {
    return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

function safeColor(value) {
    const color = String(value ?? '');
    return /^#[0-9a-f]{3,8}$/i.test(color) ? color : '#2563EB';
}

function page(tenant) {
    const config = {
        slug: tenant.slug,
        name: tenant.name,
        timezone: tenant.timezone || 'UTC',
        currency: tenant.currency || 'USD',
        booking_pattern: tenant.booking_pattern,
        require_phone: Boolean(tenant.require_phone),
        requires_consent: Boolean(tenant.requires_consent),
        consent_text: tenant.consent_text || 'I agree to the processing of my personal data for booking purposes.',
        privacy_policy_url: tenant.privacy_policy_url || null,
        custom_fields: Array.isArray(tenant.custom_fields) ? tenant.custom_fields : [],
        brand_color: tenant.brand_color || '#2563EB',
        show_powered_by: tenant.show_powered_by !== false,
        heading: tenant.booking_page_heading || tenant.name,
        description: tenant.booking_page_description || '',
        confirmation_message: tenant.confirmation_message || '',
        submission_started_at: Date.now(),
    };
    const brand = safeColor(config.brand_color);
    const title = escapeHtml(config.heading);
    const description = escapeHtml(config.description);
    const name = escapeHtml(config.name);
    const logo = tenant.logo_path ? `<img class="logo" src="/${escapeHtml(String(tenant.logo_path).replace(/^\/+/, ''))}" alt="${name}">` : '';
    const cover = tenant.cover_image_path ? `<img class="cover" src="/${escapeHtml(String(tenant.cover_image_path).replace(/^\/+/, ''))}" alt="">` : '';
    const json = safeJson(config);
    return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="Agende um horário com ${name}"><title>${title} · Agendamento</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#182230;background:#f5f7fb;font-synthesis:none;--brand:${brand};--brand-ink:#fff}*{box-sizing:border-box}body{margin:0}.shell{max-width:780px;margin:32px auto;padding:0 18px}.hero,.panel{background:#fff;border:1px solid #e4e8ef;border-radius:18px;box-shadow:0 8px 32px #1822300b}.hero{overflow:hidden}.cover{width:100%;height:180px;object-fit:cover}.hero-content{padding:24px 28px}.logo{max-width:120px;max-height:54px;object-fit:contain;margin-bottom:12px}.hero h1{margin:0;font-size:clamp(1.5rem,4vw,2rem)}.hero p{color:#647184;margin:9px 0 0;line-height:1.5}.panel{padding:24px 28px;margin-top:18px}h2{font-size:1.15rem;margin:0 0 14px}.field{margin:16px 0}.field label{display:block;font-weight:600;margin-bottom:7px}.field input,.field select,.field textarea{width:100%;min-height:44px;border:1px solid #cbd3df;border-radius:9px;padding:10px 12px;font:inherit;background:white}.field input[type=checkbox]{width:20px;min-height:20px;vertical-align:middle}.choices{display:grid;gap:9px}.choice,.slot{width:100%;text-align:left;border:1px solid #d7dde7;background:#fff;border-radius:10px;padding:13px 14px;font:inherit;cursor:pointer}.choice:hover,.slot:hover,.selected{border-color:var(--brand);box-shadow:0 0 0 2px color-mix(in srgb,var(--brand) 15%,transparent)}.muted{color:#697586}.slots{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:9px}.slot{text-align:center}.btn{background:var(--brand);color:var(--brand-ink);border:0;border-radius:10px;min-height:46px;padding:11px 18px;font:inherit;font-weight:700;cursor:pointer}.btn:disabled{opacity:.55;cursor:wait}.notice{padding:12px 14px;background:#f1f5f9;border-radius:10px;margin:12px 0}.error{color:#b42318}.success{border-left:4px solid #12a36b}.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}.hidden{display:none!important}a{color:var(--brand)}footer{text-align:center;color:#748094;font-size:.82rem;padding:20px}@media(max-width:560px){.shell{margin:14px auto;padding:0 12px}.hero-content,.panel{padding:19px}.row{grid-template-columns:1fr}}
</style></head><body><main class="shell"><header class="hero">${cover}<div class="hero-content">${logo}<h1>${title}</h1>${description ? `<p>${description}</p>` : ''}<p class="muted">Horário local: ${escapeHtml(config.timezone)}</p></div></header>
<section class="panel"><div id="error" class="error" role="alert" aria-live="polite"></div><div id="loading" class="muted">Carregando serviços…</div><div id="booking" class="hidden">
<div class="field"><label for="service">Serviço</label><select id="service" required><option value="">Selecione um serviço</option></select></div>
<div class="field"><label for="staff">Profissional</label><select id="staff"><option value="">Qualquer profissional disponível</option></select></div>
<div class="row"><div class="field"><label for="date">Data</label><input id="date" type="date" required></div><div class="field"><label>Horários disponíveis</label><div id="slots" class="slots muted">Escolha um serviço e uma data.</div></div></div>
<form id="customer-form"><h2>Seus dados</h2><div class="field"><label for="customer-name">Nome</label><input id="customer-name" name="name" autocomplete="name" required maxlength="255"></div><div class="field"><label for="customer-email">E-mail</label><input id="customer-email" name="email" type="email" autocomplete="email" required maxlength="255"></div>
<div id="phone-wrap" class="field"><label for="customer-phone">Telefone<span id="phone-required"></span></label><input id="customer-phone" name="phone" type="tel" autocomplete="tel" maxlength="50"></div><div id="custom-fields"></div>
<div class="field"><label for="notes">Observações (opcional)</label><textarea id="notes" maxlength="10000" rows="3"></textarea></div><div id="consent-wrap" class="field hidden"><label><input id="consent" type="checkbox"> <span id="consent-text"></span></label></div><div id="privacy-link" class="muted"></div>
<input type="text" id="website" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px"><button class="btn" id="submit" type="submit" disabled>Confirmar agendamento</button></form></div><div id="done" class="hidden" role="status"></div></section><footer id="powered"></footer></main>
<script type="application/json" id="tenant-config">${json}</script><script src="/node-booking.js" defer></script></body></html>`;
}

function resourcePage(tenant) {
    const config = {
        slug: tenant.slug,
        name: tenant.name,
        timezone: tenant.timezone || 'UTC',
        currency: tenant.currency || 'USD',
        require_phone: Boolean(tenant.require_phone),
        requires_consent: Boolean(tenant.requires_consent),
        consent_text: tenant.consent_text || 'I agree to the processing of my personal data for booking purposes.',
        privacy_policy_url: tenant.privacy_policy_url || null,
        custom_fields: Array.isArray(tenant.custom_fields) ? tenant.custom_fields : [],
        brand_color: tenant.brand_color || '#2563EB',
        show_powered_by: tenant.show_powered_by !== false,
        heading: tenant.booking_page_heading || tenant.name,
        description: tenant.booking_page_description || '',
        confirmation_message: tenant.confirmation_message || '',
        submission_started_at: Date.now(),
    };
    const json = safeJson(config);
    const title = escapeHtml(config.heading);
    const description = escapeHtml(config.description);
    const color = safeColor(config.brand_color);
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Agende uma estadia com ${escapeHtml(config.name)}"><title>${title} · Agendamento</title><style>
:root{font-family:Inter,system-ui,sans-serif;color:#182230;background:#f5f7fb;--brand:${color}}*{box-sizing:border-box}body{margin:0}.shell{max-width:760px;margin:32px auto;padding:0 16px}.hero,.panel{background:white;border:1px solid #e4e8ef;border-radius:16px}.hero{padding:24px}.hero h1{margin:0}.hero p,.muted{color:#697586}.panel{padding:24px;margin-top:16px}.field{margin:15px 0}.field label{display:block;font-weight:600;margin-bottom:7px}.field input,.field select,.field textarea{width:100%;min-height:44px;padding:10px;border:1px solid #cbd3df;border-radius:9px;font:inherit}.field input[type=checkbox]{width:20px;min-height:20px;vertical-align:middle}.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}.price{background:#f1f5f9;padding:12px;border-radius:10px}.btn{background:var(--brand);color:white;border:0;border-radius:9px;padding:12px 18px;min-height:44px;font:inherit;font-weight:700;cursor:pointer}.btn:disabled{opacity:.55}.hidden{display:none!important}.error{color:#b42318}.success{border-left:4px solid #12a36b;padding:12px}a{color:var(--brand)}footer{text-align:center;color:#748094;font-size:.83rem;padding:18px}@media(max-width:540px){.shell{margin:14px auto}.hero,.panel{padding:18px}.row{grid-template-columns:1fr}}
</style></head><body><main class="shell"><header class="hero"><h1>${title}</h1>${description ? `<p>${description}</p>` : ''}<p class="muted">Horário local: ${escapeHtml(config.timezone)}</p></header><section class="panel"><div id="error" class="error" role="alert" aria-live="polite"></div><div id="loading" class="muted">Carregando acomodações…</div><div id="booking" class="hidden"><div class="field"><label for="resource">Acomodação</label><select id="resource"><option value="">Selecione</option></select></div><div id="resource-info" class="muted"></div><div class="row"><div class="field"><label for="check-in">Entrada</label><input id="check-in" type="date" required></div><div class="field"><label for="check-out">Saída</label><input id="check-out" type="date" required></div></div><div class="field"><label for="guests">Hóspedes</label><input id="guests" type="number" min="1" max="10000" value="1" required></div><div id="quote" class="price hidden"></div><form id="customer-form"><h2>Seus dados</h2><div class="field"><label for="customer-name">Nome</label><input id="customer-name" autocomplete="name" required maxlength="255"></div><div class="field"><label for="customer-email">E-mail</label><input id="customer-email" type="email" autocomplete="email" required maxlength="255"></div><div class="field"><label for="customer-phone">Telefone<span id="phone-required"></span></label><input id="customer-phone" type="tel" autocomplete="tel" maxlength="50"></div><div id="custom-fields"></div><div class="field"><label for="notes">Observações (opcional)</label><textarea id="notes" maxlength="10000" rows="3"></textarea></div><div id="consent-wrap" class="field"><label><input id="consent" type="checkbox"> <span id="consent-text"></span></label></div><div id="privacy-link" class="muted"></div><input type="text" id="website" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px"><button id="submit" class="btn" disabled>Confirmar reserva</button></form></div><div id="done" class="hidden" role="status"></div></section><footer id="powered"></footer></main><script type="application/json" id="tenant-config">${json}</script><script src="/node-resource-booking.js" defer></script></body></html>`;
}

function capacityPage(tenant) {
    const config = {
        slug: tenant.slug, name: tenant.name, timezone: tenant.timezone || 'UTC',
        require_phone: Boolean(tenant.require_phone), requires_consent: Boolean(tenant.requires_consent),
        consent_text: tenant.consent_text || 'Concordo com o tratamento dos meus dados pessoais para fins de agendamento.',
        privacy_policy_url: tenant.privacy_policy_url || null,
        custom_fields: Array.isArray(tenant.custom_fields) ? tenant.custom_fields : [],
        brand_color: tenant.brand_color || '#2563EB', show_powered_by: tenant.show_powered_by !== false,
        heading: tenant.booking_page_heading || tenant.name, description: tenant.booking_page_description || '',
        confirmation_message: tenant.confirmation_message || '', submission_started_at: Date.now(),
    };
    const json = safeJson(config); const title = escapeHtml(config.heading);
    const description = escapeHtml(config.description); const color = safeColor(config.brand_color);
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Agende com ${escapeHtml(config.name)}"><title>${title} · Agendamento</title><style>
:root{font-family:Inter,system-ui,sans-serif;color:#182230;background:#f5f7fb;--brand:${color}}*{box-sizing:border-box}body{margin:0}.shell{max-width:760px;margin:32px auto;padding:0 16px}.hero,.panel{background:#fff;border:1px solid #e4e8ef;border-radius:16px}.hero,.panel{padding:24px}.panel{margin-top:16px}.hero h1{margin:0}.hero p,.muted{color:#697586}.field{margin:15px 0}.field label{display:block;font-weight:600;margin-bottom:7px}.field input,.field select,.field textarea{width:100%;min-height:44px;padding:10px;border:1px solid #cbd3df;border-radius:9px;font:inherit}.field input[type=checkbox]{width:20px;min-height:20px;vertical-align:middle}.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}.slots{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:9px}.slot{padding:12px;border:1px solid #cbd3df;border-radius:9px;background:white;text-align:left;font:inherit;cursor:pointer}.slot.selected{border-color:var(--brand);box-shadow:0 0 0 2px color-mix(in srgb,var(--brand) 16%,transparent)}.btn{background:var(--brand);color:white;border:0;border-radius:9px;padding:12px 18px;min-height:44px;font:inherit;font-weight:700;cursor:pointer}.btn:disabled{opacity:.55}.hidden{display:none!important}.error{color:#b42318}.success{border-left:4px solid #12a36b;padding:12px}a{color:var(--brand)}footer{text-align:center;color:#748094;font-size:.83rem;padding:18px}@media(max-width:540px){.shell{margin:14px auto}.hero,.panel{padding:18px}.row{grid-template-columns:1fr}}
</style></head><body><main class="shell"><header class="hero"><h1>${title}</h1>${description ? `<p>${description}</p>` : ''}<p class="muted">Horário local: ${escapeHtml(config.timezone)}</p></header><section class="panel"><div id="error" class="error" role="alert" aria-live="polite"></div><div id="loading" class="muted">Carregando…</div><div id="booking" class="hidden"><div class="row"><div class="field"><label for="date">Data</label><input id="date" type="date" required></div><div class="field"><label for="party-size">Participantes</label><input id="party-size" type="number" min="1" max="10000" value="1" required></div></div><div class="field"><label>Horários disponíveis</label><div id="slots" class="slots muted">Escolha uma data.</div></div><form id="customer-form"><h2>Seus dados</h2><div class="field"><label for="customer-name">Nome</label><input id="customer-name" autocomplete="name" required maxlength="255"></div><div class="field"><label for="customer-email">E-mail</label><input id="customer-email" type="email" autocomplete="email" required maxlength="255"></div><div class="field"><label for="customer-phone">Telefone<span id="phone-required"></span></label><input id="customer-phone" type="tel" autocomplete="tel" maxlength="50"></div><div id="custom-fields"></div><div class="field"><label for="notes">Observações (opcional)</label><textarea id="notes" maxlength="10000" rows="3"></textarea></div><div id="consent-wrap" class="field"><label><input id="consent" type="checkbox"> <span id="consent-text"></span></label></div><div id="privacy-link" class="muted"></div><input type="text" id="website" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px"><button id="submit" class="btn" disabled>Confirmar reserva</button></form></div><div id="done" class="hidden" role="status"></div></section><footer id="powered"></footer></main><script type="application/json" id="tenant-config">${json}</script><script src="/node-capacity-booking.js" defer></script></body></html>`;
}

function eventPage(tenant) {
    const config = {
        slug: tenant.slug, name: tenant.name, timezone: tenant.timezone || 'UTC',
        require_phone: Boolean(tenant.require_phone), requires_consent: Boolean(tenant.requires_consent),
        consent_text: tenant.consent_text || 'Concordo com o tratamento dos meus dados pessoais para fins de agendamento.',
        privacy_policy_url: tenant.privacy_policy_url || null,
        custom_fields: Array.isArray(tenant.custom_fields) ? tenant.custom_fields : [],
        brand_color: tenant.brand_color || '#2563EB', show_powered_by: tenant.show_powered_by !== false,
        heading: tenant.booking_page_heading || tenant.name, description: tenant.booking_page_description || '',
        confirmation_message: tenant.confirmation_message || '', submission_started_at: Date.now(),
    };
    const json = safeJson(config); const title = escapeHtml(config.heading);
    const description = escapeHtml(config.description); const color = safeColor(config.brand_color);
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Inscreva-se em um evento de ${escapeHtml(config.name)}"><title>${title} · Eventos</title><style>
:root{font-family:Inter,system-ui,sans-serif;color:#182230;background:#f5f7fb;--brand:${color}}*{box-sizing:border-box}body{margin:0}.shell{max-width:760px;margin:32px auto;padding:0 16px}.hero,.panel{background:#fff;border:1px solid #e4e8ef;border-radius:16px;padding:24px}.panel{margin-top:16px}.hero h1{margin:0}.hero p,.muted{color:#697586}.event{width:100%;display:block;text-align:left;border:1px solid #d7dde7;border-radius:12px;background:#fff;padding:14px;margin:9px 0;font:inherit;cursor:pointer}.event.selected{border-color:var(--brand);box-shadow:0 0 0 2px color-mix(in srgb,var(--brand) 16%,transparent)}.event h3{margin:0 0 5px}.field{margin:15px 0}.field label{display:block;font-weight:600;margin-bottom:7px}.field input,.field select,.field textarea{width:100%;min-height:44px;padding:10px;border:1px solid #cbd3df;border-radius:9px;font:inherit}.field input[type=checkbox]{width:20px;min-height:20px;vertical-align:middle}.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}.btn{background:var(--brand);color:white;border:0;border-radius:9px;padding:12px 18px;min-height:44px;font:inherit;font-weight:700;cursor:pointer}.btn:disabled{opacity:.55}.hidden{display:none!important}.error{color:#b42318}.success{border-left:4px solid #12a36b;padding:12px}a{color:var(--brand)}footer{text-align:center;color:#748094;font-size:.83rem;padding:18px}@media(max-width:540px){.shell{margin:14px auto}.hero,.panel{padding:18px}.row{grid-template-columns:1fr}}
</style></head><body><main class="shell"><header class="hero"><h1>${title}</h1>${description ? `<p>${description}</p>` : ''}<p class="muted">Horário local: ${escapeHtml(config.timezone)}</p></header><section class="panel"><div id="error" class="error" role="alert" aria-live="polite"></div><div id="loading" class="muted">Carregando eventos…</div><div id="booking" class="hidden"><div id="events"></div><div class="row"><div class="field"><label for="spots">Participantes</label><input id="spots" type="number" min="1" max="10000" value="1" required></div><div id="selection" class="field muted">Selecione um evento.</div></div><form id="customer-form"><h2>Seus dados</h2><div class="field"><label for="customer-name">Nome</label><input id="customer-name" autocomplete="name" required maxlength="255"></div><div class="field"><label for="customer-email">E-mail</label><input id="customer-email" type="email" autocomplete="email" required maxlength="255"></div><div class="field"><label for="customer-phone">Telefone<span id="phone-required"></span></label><input id="customer-phone" type="tel" autocomplete="tel" maxlength="50"></div><div id="custom-fields"></div><div class="field"><label for="notes">Observações (opcional)</label><textarea id="notes" maxlength="10000" rows="3"></textarea></div><div id="consent-wrap" class="field"><label><input id="consent" type="checkbox"> <span id="consent-text"></span></label></div><div id="privacy-link" class="muted"></div><input type="text" id="website" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px"><button id="submit" class="btn" disabled>Confirmar inscrição</button></form></div><div id="done" class="hidden" role="status"></div></section><footer id="powered"></footer></main><script type="application/json" id="tenant-config">${json}</script><script src="/node-event-booking.js" defer></script></body></html>`;
}

export async function registerPublicPageRoutes(app, { db }) {
    app.get('/admin-auth.js', async (_request, reply) => reply.type('text/javascript; charset=utf-8').send(adminAuthScript));
    app.get('/node-booking.js', async (_request, reply) => reply.type('text/javascript; charset=utf-8').send(clientScript));
    app.get('/node-resource-booking.js', async (_request, reply) => reply.type('text/javascript; charset=utf-8').send(resourceScript));
    app.get('/node-capacity-booking.js', async (_request, reply) => reply.type('text/javascript; charset=utf-8').send(capacityScript));
    app.get('/node-event-booking.js', async (_request, reply) => reply.type('text/javascript; charset=utf-8').send(eventScript));
    app.get('/node-manage.js', async (_request, reply) => reply.type('text/javascript; charset=utf-8').send(manageScript));
    app.get('/book/:slug', async (request, reply) => {
        const { rows } = await db.query(
            `SELECT id,slug,name,timezone,currency,booking_pattern,require_phone,requires_consent,consent_text,
                    privacy_policy_url,custom_fields,brand_color,show_powered_by,booking_page_heading,
                    booking_page_description,confirmation_message,logo_path,cover_image_path
             FROM tenants WHERE slug=$1 AND status='active' LIMIT 1`,
            [request.params.slug],
        );
        const tenant = rows[0];
        if (!tenant) return reply.code(404).type('text/html; charset=utf-8').send('<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Não encontrado</title><h1>Agendamento não encontrado</h1></html>');
        reply.header('Cache-Control', 'no-store').header('X-Robots-Tag', 'noindex, nofollow');
        if (tenant.booking_pattern === 'resource') return reply.type('text/html; charset=utf-8').send(resourcePage(tenant));
        if (tenant.booking_pattern === 'capacity') return reply.type('text/html; charset=utf-8').send(capacityPage(tenant));
        if (tenant.booking_pattern === 'event') return reply.type('text/html; charset=utf-8').send(eventPage(tenant));
        if (tenant.booking_pattern !== 'timeslot') return reply.code(501).type('text/html; charset=utf-8').send('<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Em migração</title><h1>Este tipo de agendamento ainda está sendo migrado.</h1></html>');
        return reply.type('text/html; charset=utf-8').send(page(tenant));
    });
    app.get('/book/:slug/manage/:id', async (request, reply) => {
        const { rows } = await db.query(
            "SELECT slug,name,timezone,brand_color FROM tenants WHERE slug=$1 AND status='active' LIMIT 1",
            [request.params.slug],
        );
        if (!rows[0]) return reply.code(404).type('text/html; charset=utf-8').send('<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Não encontrado</title><h1>Agendamento não encontrado</h1></html>');
        const tenant = rows[0];
        const config = safeJson({ slug: tenant.slug, bookingId: request.params.id, name: tenant.name, timezone: tenant.timezone || 'UTC' });
        reply.header('Cache-Control', 'no-store, private').header('Referrer-Policy', 'no-referrer').header('X-Robots-Tag', 'noindex, nofollow');
        return reply.type('text/html; charset=utf-8').send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gerenciar agendamento · ${escapeHtml(tenant.name)}</title><style>:root{font-family:system-ui,sans-serif;color:#182230;background:#f5f7fb;--brand:${safeColor(tenant.brand_color)}}body{margin:0}.panel{max-width:640px;margin:36px auto;padding:24px;background:white;border:1px solid #e4e8ef;border-radius:16px}h1{font-size:1.45rem}button,input{font:inherit}button{background:var(--brand);color:white;border:0;border-radius:9px;padding:11px 16px;margin:8px 8px 0 0;cursor:pointer}button.secondary{background:#eef2f7;color:#182230}input{padding:10px;border:1px solid #cbd3df;border-radius:8px}a{color:var(--brand)}.error{color:#b42318}.muted{color:#697586}.hidden{display:none!important}.slots{display:flex;gap:8px;flex-wrap:wrap}.slots button{margin:0}</style></head><body><main class="panel"><h1>Gerenciar agendamento</h1><p class="muted">${escapeHtml(tenant.name)}</p><div id="status" role="status">Verificando acesso…</div><div id="error" class="error" role="alert"></div><section id="details" class="hidden"></section><section id="reschedule" class="hidden"><h2>Escolher novo horário</h2><label for="date">Data</label> <input id="date" type="date"><div id="slots" class="slots"></div></section></main><script type="application/json" id="manage-config">${config}</script><script src="/node-manage.js" defer></script></body></html>`);
    });
}
