const config = JSON.parse(document.querySelector('#tenant-config').textContent);
const $ = (selector) => document.querySelector(selector);
const error = $('#error');
const dateInput = $('#date');
const partyInput = $('#party-size');
const slotsElement = $('#slots');
const submitButton = $('#submit');
let selectedSlot = null;

function escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
}

function venueDate() {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
}

async function request(url, options) {
    const response = await fetch(url, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'request_failed');
    return body;
}

function setError(message = '') { error.textContent = message; }

function addCustomFields() {
    const container = $('#custom-fields');
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
        wrapper.append(label, input); container.append(wrapper);
    }
}

async function loadSlots() {
    selectedSlot = null; submitButton.disabled = true;
    if (!dateInput.value) { slotsElement.textContent = 'Escolha uma data.'; return; }
    slotsElement.textContent = 'Verificando horários…'; setError('');
    try {
        const query = new URLSearchParams({ date: dateInput.value, party_size: partyInput.value || '1' });
        const result = await request(`/api/${encodeURIComponent(config.slug)}/capacity/slots?${query}`);
        slotsElement.replaceChildren();
        if (!result.slots.length) { slotsElement.textContent = 'Não há horários disponíveis para esta data e tamanho de grupo.'; return; }
        for (const slot of result.slots) {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'slot';
            button.textContent = `${slot.label ? `${slot.label} · ` : ''}${slot.time} – ${slot.end_time} · ${slot.remaining} vagas`;
            button.addEventListener('click', () => {
                selectedSlot = slot;
                for (const other of slotsElement.querySelectorAll('.slot')) other.classList.remove('selected');
                button.classList.add('selected'); submitButton.disabled = false;
            });
            slotsElement.append(button);
        }
    } catch (problem) { slotsElement.textContent = 'Falha ao consultar horários.'; setError(problem.message); }
}

async function submit(event) {
    event.preventDefault(); setError('');
    if (!selectedSlot) { setError('Escolha um horário disponível.'); return; }
    const custom = Object.fromEntries([...document.querySelectorAll('[data-custom-key]')].map((input) => [input.dataset.customKey, input.type === 'checkbox' ? input.checked : input.value]));
    const payload = {
        booking_pattern: 'capacity', __ts: config.submission_started_at, __hp: $('#website').value,
        slot_id: selectedSlot.id, date: dateInput.value, party_size: Number(partyInput.value),
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
        done.innerHTML = `<h2>Reserva ${result.booking.status === 'pending' ? 'solicitada' : 'confirmada'}</h2><p>${escape(config.confirmation_message || 'Sua reserva foi registrada.')}</p><p>${escape(dateInput.value)} · ${escape(result.booking.time)} – ${escape(result.booking.end_time)} · ${escape(partyInput.value)} participantes</p><p><a href="${escape(result.booking.manage_url)}">Gerenciar reserva</a></p>`;
        history.replaceState(null, '', location.pathname);
    } catch (problem) {
        const messages = {
            capacity_exceeded: 'As vagas acabaram para esse horário. Escolha outro horário.',
            date_blocked: 'Esta data está bloqueada.', party_too_small: 'O grupo está abaixo do mínimo permitido.',
            party_too_large: 'O grupo excede o máximo permitido.', too_soon: 'Este horário está fora da antecedência permitida.',
            too_far: 'Esta data está além do limite permitido para reserva.', max_bookings_exceeded: 'Você atingiu o limite diário de reservas.',
        };
        setError(messages[problem.message] || 'Não foi possível concluir a reserva. Confira os dados e tente novamente.');
        await loadSlots();
    } finally { submitButton.textContent = 'Confirmar reserva'; submitButton.disabled = !selectedSlot; }
}

async function start() {
    $('#loading').classList.add('hidden'); $('#booking').classList.remove('hidden');
    dateInput.min = venueDate();
    $('#phone-required').textContent = config.require_phone ? ' *' : '';
    $('#customer-phone').required = config.require_phone;
    if (config.requires_consent) { $('#consent-wrap').classList.remove('hidden'); $('#consent').required = true; $('#consent-text').textContent = config.consent_text; }
    else $('#consent-wrap').remove();
    if (config.privacy_policy_url) { const link = document.createElement('a'); link.href = config.privacy_policy_url; link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'Política de privacidade'; $('#privacy-link').append(link); }
    if (config.show_powered_by) $('#powered').textContent = 'Agendamento por VoxelBooking';
    addCustomFields();
    dateInput.addEventListener('change', loadSlots);
    partyInput.addEventListener('change', loadSlots);
    $('#customer-form').addEventListener('submit', submit);
}

start().catch((problem) => { $('#loading').textContent = 'Não foi possível carregar o agendamento.'; setError(problem.message); });
