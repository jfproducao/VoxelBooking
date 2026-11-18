const config = JSON.parse(document.querySelector('#tenant-config').textContent);
const $ = (selector) => document.querySelector(selector);
const error = $('#error');
const eventsElement = $('#events');
const spotsInput = $('#spots');
const selection = $('#selection');
const submitButton = $('#submit');
let selectedEvent = null;

function escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
}

async function request(url, options) {
    const response = await fetch(url, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'request_failed');
    return body;
}

function setError(message = '') { error.textContent = message; }

function customFields() {
    for (const field of config.custom_fields ?? []) {
        const key = field.name ?? field.key;
        if (!key) continue;
        const wrapper = document.createElement('div'); wrapper.className = 'field';
        const label = document.createElement('label'); label.htmlFor = `custom-${key}`; label.textContent = `${field.label ?? key}${field.required ? ' *' : ''}`;
        let input;
        if (field.type === 'select') {
            input = document.createElement('select');
            input.innerHTML = `<option value="">Selecione</option>${(field.options ?? []).map((option) => {
                const value = typeof option === 'object' && option !== null ? option.value : option;
                const text = typeof option === 'object' && option !== null ? option.label ?? option.value : option;
                return `<option value="${escape(value)}">${escape(text)}</option>`;
            }).join('')}`;
        } else if (field.type === 'checkbox') { input = document.createElement('input'); input.type = 'checkbox'; }
        else { input = document.createElement('input'); input.type = ['email', 'date', 'number'].includes(field.type) ? field.type : 'text'; }
        input.id = `custom-${key}`; input.dataset.customKey = key; input.required = Boolean(field.required);
        wrapper.append(label, input); $('#custom-fields').append(wrapper);
    }
}

function canSubmit() {
    if (!selectedEvent) return false;
    const count = Number(spotsInput.value);
    if (!Number.isInteger(count) || count < Number(selectedEvent.min_spot_count ?? 1)) return false;
    if (selectedEvent.max_spot_count !== null && count > Number(selectedEvent.max_spot_count)) return false;
    if (count <= Number(selectedEvent.remaining)) return true;
    return selectedEvent.can_waitlist && count + Number(selectedEvent.waitlist_count) <= Number(selectedEvent.waitlist_max);
}

function updateSelection() {
    if (!selectedEvent) { selection.textContent = 'Selecione um evento.'; submitButton.disabled = true; return; }
    const count = Number(spotsInput.value);
    const waiting = count > Number(selectedEvent.remaining) && selectedEvent.can_waitlist
        && count + Number(selectedEvent.waitlist_count) <= Number(selectedEvent.waitlist_max);
    selection.textContent = `${selectedEvent.date} · ${selectedEvent.start_time}–${selectedEvent.end_time} · ${selectedEvent.location || 'Local a confirmar'}${waiting ? ' · Entrará na lista de espera' : ''}`;
    submitButton.textContent = waiting ? 'Entrar na lista de espera' : 'Confirmar inscrição';
    submitButton.disabled = !canSubmit();
}

function renderEvents(events) {
    eventsElement.replaceChildren();
    if (!events.length) { eventsElement.textContent = 'Não há eventos disponíveis no momento.'; return; }
    for (const event of events) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'event';
        const dateText = new Intl.DateTimeFormat('pt-BR', { timeZone: config.timezone, dateStyle: 'full' }).format(new Date(event.start_utc));
        const capacity = event.remaining > 0 ? `${event.remaining} vagas disponíveis` : event.can_waitlist ? 'Lotado · lista de espera aberta' : 'Lotado';
        button.innerHTML = `<h3>${escape(event.name)}</h3><div>${escape(dateText)} · ${escape(event.start_time)}–${escape(event.end_time)}</div><div>${escape(event.location || 'Local a confirmar')} · ${escape(capacity)}</div>${event.description ? `<p>${escape(event.description)}</p>` : ''}`;
        button.disabled = event.remaining < 1 && !event.can_waitlist;
        button.addEventListener('click', () => {
            selectedEvent = event;
            for (const item of eventsElement.querySelectorAll('.event')) item.classList.remove('selected');
            button.classList.add('selected');
            spotsInput.min = String(event.min_spot_count || 1);
            spotsInput.max = String(event.max_spot_count ?? Math.max(event.max_participants, event.waitlist_max || 1));
            if (Number(spotsInput.value) < Number(spotsInput.min)) spotsInput.value = spotsInput.min;
            updateSelection(); setError('');
        });
        eventsElement.append(button);
    }
}

async function loadEvents() {
    const events = [];
    let cursor = null;
    do {
        const query = new URLSearchParams({ limit: '100' });
        if (cursor) query.set('cursor', cursor);
        const result = await request(`/api/${encodeURIComponent(config.slug)}/events?${query}`);
        events.push(...(result.events || []));
        cursor = result.next_cursor || null;
    } while (cursor);
    return events;
}

async function submit(event) {
    event.preventDefault(); setError('');
    if (!canSubmit()) { setError('Escolha um evento com vagas ou lista de espera disponível.'); return; }
    const custom = Object.fromEntries([...document.querySelectorAll('[data-custom-key]')].map((input) => [input.dataset.customKey, input.type === 'checkbox' ? input.checked : input.value]));
    const payload = {
        booking_pattern: 'event', __ts: config.submission_started_at, __hp: $('#website').value,
        event_id: selectedEvent.id, date: selectedEvent.date, spot_count: Number(spotsInput.value),
        customer: { name: $('#customer-name').value.trim(), email: $('#customer-email').value.trim(), phone: $('#customer-phone').value.trim() },
        notes: $('#notes').value, custom_fields: custom, consent_given: $('#consent')?.checked === true,
        customer_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    submitButton.disabled = true; submitButton.textContent = 'Enviando…';
    try {
        const result = await request(`/api/${encodeURIComponent(config.slug)}/bookings`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
        });
        $('#booking').classList.add('hidden');
        const done = $('#done'); done.classList.remove('hidden'); done.className = 'success';
        done.innerHTML = `<h2>${result.booking.status === 'waitlisted' ? 'Inscrição na lista de espera' : result.booking.status === 'pending' ? 'Inscrição solicitada' : 'Inscrição confirmada'}</h2><p>${escape(config.confirmation_message || 'Sua inscrição foi registrada.')}</p><p>${escape(result.booking.event_name)} · ${escape(result.booking.date)} · ${escape(result.booking.time)} · ${escape(result.booking.spot_count)} participante(s)</p><p><a href="${escape(result.booking.manage_url)}">Gerenciar inscrição</a></p>`;
        history.replaceState(null, '', location.pathname);
    } catch (problem) {
        const messages = {
            event_full: 'As vagas acabaram para este evento.', waitlist_full: 'A lista de espera também está cheia.',
            spot_count_too_few: 'A quantidade está abaixo do mínimo permitido.', spot_count_too_many: 'A quantidade excede o limite por inscrição.',
            too_soon: 'Este evento está fora da antecedência permitida.', too_far: 'Este evento está além do limite de reserva.',
            max_bookings_exceeded: 'Você atingiu o limite diário de inscrições.',
        };
        setError(messages[problem.message] || 'Não foi possível concluir a inscrição. Confira os dados e tente novamente.');
        try { renderEvents(await loadEvents()); } catch { /* Keep the current event list visible. */ }
        selectedEvent = null; updateSelection();
    } finally { submitButton.textContent = 'Confirmar inscrição'; updateSelection(); }
}

async function start() {
    $('#loading').classList.add('hidden'); $('#booking').classList.remove('hidden');
    $('#phone-required').textContent = config.require_phone ? ' *' : '';
    $('#customer-phone').required = config.require_phone;
    if (config.requires_consent) { $('#consent-wrap').classList.remove('hidden'); $('#consent').required = true; $('#consent-text').textContent = config.consent_text; }
    else $('#consent-wrap').remove();
    if (config.privacy_policy_url) { const link = document.createElement('a'); link.href = config.privacy_policy_url; link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'Política de privacidade'; $('#privacy-link').append(link); }
    if (config.show_powered_by) $('#powered').textContent = 'Agendamento por VoxelBooking';
    customFields(); spotsInput.addEventListener('input', updateSelection);
    $('#customer-form').addEventListener('submit', submit);
    renderEvents(await loadEvents());
}

start().catch((problem) => { $('#loading').textContent = 'Não foi possível carregar eventos.'; setError(problem.message); });
