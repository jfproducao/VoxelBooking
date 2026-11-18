const config = JSON.parse(document.querySelector('#tenant-config').textContent);
const $ = (selector) => document.querySelector(selector);
const error = $('#error');
const resourceSelect = $('#resource');
const checkIn = $('#check-in');
const checkOut = $('#check-out');
const guests = $('#guests');
const quoteElement = $('#quote');
const submitButton = $('#submit');
let selectedResource = null;
let currentQuote = null;
let requestVersion = 0;

function escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
}

function venueDate() {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${value.year}-${value.month}-${value.day}`;
}

function setError(message = '') { error.textContent = message; }

async function request(url, options) {
    const response = await fetch(url, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'request_failed');
    return body;
}

function customFields() {
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

function paintQuote(quote) {
    currentQuote = quote;
    quoteElement.classList.remove('hidden');
    if (!quote.available) {
        quoteElement.textContent = ({
            min_stay_violation: 'A estadia não atinge o mínimo de noites.',
            max_stay_violation: 'A estadia excede o máximo de noites.',
            capacity_exceeded: 'O número de hóspedes excede a capacidade.',
            invalid_check_in_day: 'A entrada não é permitida neste dia da semana.',
            invalid_check_out_day: 'A saída não é permitida neste dia da semana.',
            too_soon: 'A data de entrada precisa respeitar a antecedência mínima.',
            too_far: 'A data está além do limite permitido para reserva.',
            date_blocked: 'Há uma data bloqueada durante a estadia.',
            already_booked: 'Esta acomodação já está reservada neste período.',
        })[quote.error] || 'Não há disponibilidade para este período.';
        submitButton.disabled = true;
        return;
    }
    const lines = quote.pricing.map((night) => `<div>${escape(night.date)}: ${night.price === null ? 'Sem preço definido' : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: config.currency }).format(Number(night.price))}${night.label ? ` · ${escape(night.label)}` : ''}</div>`).join('');
    const total = quote.total === null ? 'Total sob consulta' : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: config.currency }).format(Number(quote.total));
    quoteElement.innerHTML = `<strong>${quote.nights} ${quote.nights === 1 ? 'noite' : 'noites'} · ${total}</strong>${lines}`;
    submitButton.disabled = false;
}

async function refreshQuote() {
    const version = ++requestVersion;
    currentQuote = null; submitButton.disabled = true;
    if (!selectedResource || !checkIn.value || !checkOut.value) { quoteElement.classList.add('hidden'); return; }
    setError(''); quoteElement.classList.remove('hidden'); quoteElement.textContent = 'Verificando disponibilidade e preço…';
    try {
        const query = new URLSearchParams({ check_in: checkIn.value, check_out: checkOut.value, guests: guests.value || '1' });
        const quote = await request(`/api/${encodeURIComponent(config.slug)}/resources/${encodeURIComponent(selectedResource.id)}/availability?${query}`);
        if (version !== requestVersion) return;
        paintQuote(quote);
    } catch (problem) { if (version === requestVersion) { setError(problem.message); quoteElement.textContent = 'Falha ao verificar disponibilidade.'; } }
}

function daysForMonth(date) {
    if (!date) return null;
    const [year, month] = date.split('-').map(Number);
    return request(`/api/${encodeURIComponent(config.slug)}/resources/${encodeURIComponent(selectedResource.id)}/availability?year=${year}&month=${month}`);
}

function isAllowedDay(date, allowed) {
    if (!allowed || allowed.length === 0) return true;
    return allowed.includes(new Date(`${date}T00:00:00Z`).getUTCDay());
}

async function refreshCalendarAndQuote() {
    if (!selectedResource) return;
    const selectedDates = [checkIn.value, checkOut.value].filter(Boolean);
    const months = [...new Set(selectedDates.map((date) => date.slice(0, 7)))];
    try {
        const calendars = await Promise.all(months.map((month) => daysForMonth(`${month}-01`)));
        const available = new Set(calendars.flatMap((calendar) => calendar.dates));
        if (checkIn.value && !available.has(checkIn.value)) setError('A data de entrada não está disponível.');
        else if (checkOut.value && !available.has(checkOut.value)) setError('A data de saída não está disponível.');
        else if (checkIn.value && !isAllowedDay(checkIn.value, selectedResource.check_in_days)) setError('A entrada não é permitida neste dia da semana.');
        else if (checkOut.value && !isAllowedDay(checkOut.value, selectedResource.check_out_days)) setError('A saída não é permitida neste dia da semana.');
        else setError('');
    } catch (problem) { setError(problem.message); }
    await refreshQuote();
}

async function start() {
    $('#loading').classList.add('hidden'); $('#booking').classList.remove('hidden');
    const today = venueDate(); checkIn.min = today; checkOut.min = today;
    $('#phone-required').textContent = config.require_phone ? ' *' : '';
    $('#customer-phone').required = config.require_phone;
    if (config.requires_consent) { $('#consent-wrap').classList.remove('hidden'); $('#consent').required = true; $('#consent-text').textContent = config.consent_text; }
    else $('#consent-wrap').remove();
    if (config.privacy_policy_url) { const link = document.createElement('a'); link.href = config.privacy_policy_url; link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'Política de privacidade'; $('#privacy-link').append(link); }
    if (config.show_powered_by) $('#powered').textContent = 'Agendamento por VoxelBooking';
    customFields();
    const result = await request(`/api/${encodeURIComponent(config.slug)}/resources`);
    for (const resource of result.resources) {
        const option = document.createElement('option'); option.value = resource.id;
        option.textContent = `${resource.name} · ${resource.capacity} ${resource.capacity === 1 ? 'hóspede' : 'hóspedes'}`;
        resourceSelect.append(option);
    }
    if (!result.resources.length) { setError('Este negócio ainda não publicou acomodações.'); return; }
    $('#customer-form').addEventListener('submit', submit);
    resourceSelect.addEventListener('change', () => {
        selectedResource = result.resources.find((resource) => resource.id === resourceSelect.value) || null;
        const info = $('#resource-info');
        info.textContent = selectedResource ? [selectedResource.description, selectedResource.amenities?.join(' · ')].filter(Boolean).join(' · ') : '';
        if (selectedResource) { guests.max = String(selectedResource.capacity); if (Number(guests.value) > selectedResource.capacity) guests.value = String(selectedResource.capacity); }
        quoteElement.classList.add('hidden'); setError(''); refreshCalendarAndQuote();
    });
    for (const input of [checkIn, checkOut, guests]) input.addEventListener('change', refreshCalendarAndQuote);
}

async function submit(event) {
    event.preventDefault(); setError('');
    if (!currentQuote?.available) { setError('Escolha datas e hóspedes com disponibilidade.'); return; }
    const custom = Object.fromEntries([...document.querySelectorAll('[data-custom-key]')].map((input) => [input.dataset.customKey, input.type === 'checkbox' ? input.checked : input.value]));
    const payload = {
        booking_pattern: 'resource', __ts: config.submission_started_at, __hp: $('#website').value,
        resource_id: selectedResource.id, check_in: checkIn.value, check_out: checkOut.value, guest_count: Number(guests.value),
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
        done.innerHTML = `<h2>Reserva ${result.booking.status === 'pending' ? 'solicitada' : 'confirmada'}</h2><p>${escape(config.confirmation_message || 'Sua estadia foi registrada.')}</p><p>${escape(result.booking.resource)} · ${escape(result.booking.check_in)} a ${escape(result.booking.check_out)} · ${result.booking.nights} noites</p><p><a href="${escape(result.booking.manage_url)}">Gerenciar reserva</a></p>`;
        history.replaceState(null, '', location.pathname);
    } catch (problem) {
        setError(({ already_booked: 'A acomodação foi reservada para essas datas. Escolha outro período.', date_blocked: 'Há uma data bloqueada durante a estadia.', capacity_exceeded: 'O número de hóspedes excede a capacidade.', max_bookings_exceeded: 'Você atingiu o limite diário de reservas.' })[problem.message] || 'Não foi possível concluir a reserva. Confira os dados e tente novamente.');
        if (problem.message === 'already_booked' || problem.message === 'date_blocked') await refreshCalendarAndQuote();
    } finally { submitButton.textContent = 'Confirmar reserva'; submitButton.disabled = !currentQuote?.available; }
}

start().catch((problem) => { $('#loading').textContent = 'Não foi possível carregar as acomodações.'; setError(problem.message); });
