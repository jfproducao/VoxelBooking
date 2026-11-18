const config = JSON.parse(document.querySelector('#tenant-config').textContent);
const $ = (selector) => document.querySelector(selector);
const error = $('#error');
const serviceSelect = $('#service');
const staffSelect = $('#staff');
const dateInput = $('#date');
const slotsElement = $('#slots');
const submitButton = $('#submit');
let selectedSlot = null;

function escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
}

function venueDate() {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
}

function setError(message = '') { error.textContent = message; }
function setSelectedSlot(slot) {
    selectedSlot = slot;
    document.querySelectorAll('.slot').forEach((button) => {
        button.classList.toggle('selected', button.dataset.time === slot?.time);
        button.setAttribute('aria-pressed', String(button.dataset.time === slot?.time));
    });
    submitButton.disabled = !selectedSlot;
}

async function request(url, options) {
    const response = await fetch(url, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Não foi possível concluir a solicitação.');
    return payload;
}

function addCustomFields() {
    const container = $('#custom-fields');
    for (const field of config.custom_fields ?? []) {
        const key = field.name ?? field.key;
        if (!key) continue;
        const wrapper = document.createElement('div');
        wrapper.className = 'field';
        const label = document.createElement('label');
        label.htmlFor = `custom-${key}`;
        label.textContent = `${field.label ?? key}${field.required ? ' *' : ''}`;
        let input;
        if (field.type === 'select') {
            input = document.createElement('select');
            input.innerHTML = `<option value="">Selecione</option>${(field.options ?? []).map((option) => {
                const value = typeof option === 'object' && option !== null ? option.value : option;
                const text = typeof option === 'object' && option !== null ? option.label ?? option.value : option;
                return `<option value="${escape(value)}">${escape(text)}</option>`;
            }).join('')}`;
        } else if (field.type === 'checkbox') {
            input = document.createElement('input'); input.type = 'checkbox';
        } else {
            input = document.createElement('input');
            input.type = ['email', 'date', 'number'].includes(field.type) ? field.type : 'text';
            if (field.type === 'number') { if (field.min !== undefined) input.min = field.min; if (field.max !== undefined) input.max = field.max; }
        }
        input.id = `custom-${key}`; input.dataset.customKey = key; input.required = Boolean(field.required);
        wrapper.append(label, input); container.append(wrapper);
    }
}

async function loadSlots() {
    setSelectedSlot(null);
    slotsElement.textContent = 'Buscando horários…';
    if (!serviceSelect.value || !dateInput.value) { slotsElement.textContent = 'Escolha um serviço e uma data.'; return; }
    try {
        const query = new URLSearchParams({ service_id: serviceSelect.value, date: dateInput.value });
        if (staffSelect.value) query.set('staff_id', staffSelect.value);
        const result = await request(`/api/${encodeURIComponent(config.slug)}/availability?${query}`);
        if (!result.slots.length) { slotsElement.textContent = 'Nenhum horário disponível nesta data.'; return; }
        slotsElement.replaceChildren(...result.slots.map((slot) => {
            const button = document.createElement('button');
            button.type = 'button'; button.className = 'slot'; button.textContent = slot.time;
            button.dataset.time = slot.time; button.setAttribute('aria-pressed', 'false');
            button.addEventListener('click', () => setSelectedSlot(slot));
            return button;
        }));
    } catch (problem) { slotsElement.textContent = 'Falha ao carregar os horários.'; setError(problem.message); }
}

async function start() {
    $('#loading').classList.add('hidden');
    $('#booking').classList.remove('hidden');
    $('#phone-required').textContent = config.require_phone ? ' *' : '';
    $('#customer-phone').required = config.require_phone;
    if (config.requires_consent) {
        $('#consent-wrap').classList.remove('hidden');
        $('#consent').required = true;
        $('#consent-text').textContent = config.consent_text;
    } else $('#consent-wrap').remove();
    if (config.privacy_policy_url) {
        const link = document.createElement('a'); link.href = config.privacy_policy_url; link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'Política de privacidade';
        $('#privacy-link').append(link);
    }
    if (config.show_powered_by) $('#powered').textContent = 'Agendamento por VoxelBooking';
    addCustomFields();
    dateInput.min = venueDate(); dateInput.value = venueDate();
    const result = await request(`/api/${encodeURIComponent(config.slug)}/services`);
    for (const service of result.services) {
        const option = document.createElement('option'); option.value = service.id;
        let label = `${service.name} · ${service.duration_minutes} min`;
        if (service.price !== null && service.price !== undefined) {
            try { label += ` · ${new Intl.NumberFormat('pt-BR', { style: 'currency', currency: config.currency }).format(Number(service.price))}`; }
            catch { label += ` · ${service.price} ${config.currency}`; }
        }
        option.textContent = label;
        serviceSelect.append(option);
    }
    if (!result.services.length) { serviceSelect.disabled = true; setError('Este negócio ainda não publicou serviços.'); return; }
    $('#customer-form').addEventListener('submit', submit);
    serviceSelect.addEventListener('change', async () => {
        setError(''); staffSelect.innerHTML = '<option value="">Qualquer profissional disponível</option>';
        if (serviceSelect.value) {
            try {
                const staff = await request(`/api/${encodeURIComponent(config.slug)}/staff?service_id=${encodeURIComponent(serviceSelect.value)}`);
                for (const person of staff.staff) {
                    const option = document.createElement('option'); option.value = person.id; option.textContent = person.name; staffSelect.append(option);
                }
            } catch (problem) { setError(problem.message); }
        }
        await loadSlots();
    });
    dateInput.addEventListener('change', () => { setError(''); loadSlots(); });
    staffSelect.addEventListener('change', () => { setError(''); loadSlots(); });
}

async function submit(event) {
    event.preventDefault(); setError('');
    if (!selectedSlot) { setError('Escolha um horário disponível.'); return; }
    const customer = {
        name: $('#customer-name').value.trim(), email: $('#customer-email').value.trim(),
        phone: $('#customer-phone').value.trim(),
    };
    const customFields = Object.fromEntries([...document.querySelectorAll('[data-custom-key]')].map((input) => [
        input.dataset.customKey, input.type === 'checkbox' ? input.checked : input.value,
    ]));
    const payload = {
        __ts: config.submission_started_at, __hp: $('#website').value,
        service_id: serviceSelect.value, staff_id: selectedSlot.staff_id || staffSelect.value || null,
        date: dateInput.value, time: selectedSlot.time, customer, notes: $('#notes').value,
        custom_fields: customFields, consent_given: $('#consent')?.checked === true,
        customer_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    submitButton.disabled = true; submitButton.textContent = 'Enviando…';
    try {
        const result = await request(`/api/${encodeURIComponent(config.slug)}/bookings`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
        });
        $('#booking').classList.add('hidden');
        const done = $('#done'); done.classList.remove('hidden'); done.className = 'notice success';
        done.innerHTML = `<h2>Agendamento ${result.booking.status === 'pending' ? 'solicitado' : 'confirmado'}</h2><p>${escape(config.confirmation_message || 'Seu horário foi registrado.')}</p><p>${escape(dateInput.value)} às ${escape(selectedSlot.time)} (${escape(config.timezone)})</p><p><a href="${escape(result.booking.manage_url)}">Gerenciar agendamento</a></p>`;
        history.replaceState(null, '', location.pathname);
    } catch (problem) {
        const messages = {
            slot_unavailable: 'Este horário acabou de ficar indisponível. Escolha outro.',
            too_soon: 'O horário precisa respeitar o prazo mínimo de antecedência.',
            too_far: 'A data está além do limite permitido para agendamento.',
            max_bookings_exceeded: 'Você atingiu o limite diário de agendamentos.',
            spam_detected: 'Aguarde alguns segundos antes de enviar o formulário.',
            validation_failed: 'Confira os campos obrigatórios e tente novamente.',
        };
        setError(messages[problem.message] || 'Não foi possível concluir o agendamento. Tente novamente.');
        if (problem.message === 'slot_unavailable') await loadSlots();
    } finally { submitButton.textContent = 'Confirmar agendamento'; submitButton.disabled = !selectedSlot; }
}

start().catch((problem) => { $('#loading').textContent = 'Não foi possível carregar os serviços.'; setError(problem.message); });
