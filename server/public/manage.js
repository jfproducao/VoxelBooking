const config = JSON.parse(document.querySelector('#manage-config').textContent);
const $ = (selector) => document.querySelector(selector);
const status = $('#status');
const error = $('#error');
const details = $('#details');
const reschedulePanel = $('#reschedule');
const bookingApi = `/api/${encodeURIComponent(config.slug)}/bookings/${encodeURIComponent(config.bookingId)}`;

function escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
}

function showError(code) {
    const messages = {
        verification_required: 'O link expirou ou já foi utilizado. Solicite um novo link de acesso.',
        cancellation_disabled: 'O cancelamento não está disponível para esta reserva.',
        rescheduling_disabled: 'O reagendamento não está disponível para esta reserva.',
        too_late: 'O prazo para alterar esta reserva já passou.',
        not_confirmed: 'Somente reservas confirmadas podem ser alteradas.',
        slot_unavailable: 'Este horário acabou de ficar indisponível. Escolha outro.',
    };
    error.textContent = messages[code] || 'Não foi possível carregar ou atualizar a reserva.';
}

async function request(url, options) {
    const response = await fetch(url, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'request_failed');
    return body;
}

async function load() {
    const fragment = new URLSearchParams(location.hash.slice(1));
    const token = fragment.get('access');
    if (token) {
        await request(`/api/${encodeURIComponent(config.slug)}/customer-access`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ purpose: 'booking.manage', subject_id: config.bookingId, token }),
        });
        history.replaceState(null, '', location.pathname);
    }
    const result = await request(bookingApi);
    status.classList.add('hidden');
    details.classList.remove('hidden');
    const booking = result.booking;
    const date = booking.date;
    const time = booking.time;
    const title = booking.service_name || booking.resource_name || booking.event_name || 'Agendamento';
    const period = booking.booking_pattern === 'resource'
        ? `<p><strong>Entrada:</strong> ${escape(booking.check_in)} · <strong>Saída:</strong> ${escape(booking.check_out)} (${escape(config.timezone)})</p>`
        : `<p><strong>Data e horário:</strong> ${escape(date)} às ${escape(time)} (${escape(config.timezone)})</p>`;
    details.innerHTML = `<h2>${escape(title)}</h2>${period}<p><strong>Status:</strong> ${escape(booking.status === 'confirmed' ? 'Confirmado' : booking.status)}</p>${booking.staff_name ? `<p><strong>Profissional:</strong> ${escape(booking.staff_name)}</p>` : ''}<p><strong>Cliente:</strong> ${escape(booking.customer_name)}</p><div id="actions"></div>`;
    const actions = $('#actions');
    if (result.can_cancel) {
        const cancel = document.createElement('button'); cancel.textContent = 'Cancelar agendamento';
        cancel.addEventListener('click', async () => {
            if (!confirm('Deseja cancelar este agendamento?')) return;
            try { await request(`${bookingApi}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: '' }) }); location.reload(); }
            catch (problem) { showError(problem.message); }
        });
        actions.append(cancel);
    }
    if (result.can_reschedule) {
        const reschedule = document.createElement('button'); reschedule.className = 'secondary'; reschedule.textContent = 'Reagendar';
        reschedule.addEventListener('click', () => reschedulePanel.classList.remove('hidden'));
        actions.append(reschedule);
        setupReschedule(booking);
    }
    if (booking.status === 'cancelled') error.textContent = 'Este agendamento já foi cancelado.';
}

function venueDate() {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${value.year}-${value.month}-${value.day}`;
}

function rescheduleForm(content) {
    reschedulePanel.innerHTML = `<h2>Escolher nova data</h2>${content}`;
    const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Confirmar nova data'; button.disabled = true;
    button.addEventListener('click', () => submitReschedule(booking, button.dataset.target ? JSON.parse(button.dataset.target) : {}, button));
    reschedulePanel.append(button);
    return button;
}

async function submitReschedule(booking, target, button) {
    button.disabled = true;
    try {
        const updated = await request(`${bookingApi}/reschedule`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(target),
        });
        status.classList.remove('hidden'); status.textContent = 'Agendamento reagendado.';
        location.assign(`/book/${encodeURIComponent(config.slug)}/manage/${encodeURIComponent(updated.new_booking_id)}`);
    } catch (problem) { button.disabled = false; showError(problem.message); }
}

function setupReschedule(booking) {
    const minDate = venueDate();
    if (booking.booking_pattern === 'resource') {
        const button = rescheduleForm(`<div><label for="check-in">Entrada</label> <input id="check-in" type="date" min="${minDate}"></div><div><label for="check-out">Saída</label> <input id="check-out" type="date" min="${minDate}"></div><div id="quote" role="status"></div>`);
        const refresh = async () => {
            button.disabled = true;
            const checkIn = $('#check-in').value; const checkOut = $('#check-out').value;
            if (!checkIn || !checkOut || checkOut <= checkIn) { $('#quote').textContent = ''; return; }
            $('#quote').textContent = 'Verificando período e preço…';
            try {
                const query = new URLSearchParams({ check_in: checkIn, check_out: checkOut, guests: String(booking.party_size), reschedule_booking_id: config.bookingId });
                const quote = await request(`/api/${encodeURIComponent(config.slug)}/resources/${encodeURIComponent(booking.resource_id)}/availability?${query}`);
                $('#quote').textContent = quote.available ? `${quote.nights} noite(s) · ${quote.total === null ? 'Total sob consulta' : `Total: ${quote.total}`}` : `Período indisponível: ${quote.error}`;
                button.dataset.target = JSON.stringify({ check_in: checkIn, check_out: checkOut }); button.disabled = !quote.available;
            } catch (problem) { $('#quote').textContent = ''; showError(problem.message); }
        };
        for (const input of [$('#check-in'), $('#check-out')]) input.addEventListener('change', refresh);
        return;
    }
    if (booking.booking_pattern === 'capacity') {
        const button = rescheduleForm(`<div><label for="date">Nova data</label> <input id="date" type="date" min="${minDate}" value="${minDate}"></div><div id="slots" class="slots" role="group" aria-label="Horários disponíveis"></div>`);
        const date = $('#date');
        const refresh = async () => {
            const container = $('#slots'); container.textContent = 'Buscando horários…'; button.disabled = true;
            try {
                const query = new URLSearchParams({ date: date.value, party_size: String(booking.party_size), reschedule_booking_id: config.bookingId });
                const result = await request(`/api/${encodeURIComponent(config.slug)}/capacity/slots?${query}`);
                const choices = result.slots.filter((slot) => !(slot.time === booking.time && date.value === booking.date));
                container.replaceChildren(...choices.map((slot) => {
                    const option = document.createElement('button'); option.type = 'button'; option.textContent = `${slot.label ? `${slot.label} · ` : ''}${slot.time}–${slot.end_time}`;
                    option.addEventListener('click', () => {
                        for (const item of container.querySelectorAll('button')) item.classList.remove('selected');
                        option.classList.add('selected'); button.dataset.target = JSON.stringify({ date: date.value, slot_id: slot.id }); button.disabled = false;
                    });
                    return option;
                }));
                if (!choices.length) container.textContent = 'Nenhum outro horário disponível nesta data.';
            } catch (problem) { container.textContent = ''; showError(problem.message); }
        };
        date.addEventListener('change', refresh); refresh();
        return;
    }
    if (booking.booking_pattern === 'event') {
        const button = rescheduleForm('<div id="slots" class="slots" role="group" aria-label="Próximas datas disponíveis"></div>');
        const container = $('#slots'); container.textContent = 'Buscando próximas datas…';
        (async () => {
            try {
                const options = []; let cursor = null;
                do {
                    const query = new URLSearchParams({ event_id: booking.event_id, limit: '100', reschedule_booking_id: config.bookingId });
                    if (cursor) query.set('cursor', cursor);
                    const result = await request(`/api/${encodeURIComponent(config.slug)}/events?${query}`);
                    options.push(...(result.events || [])); cursor = result.next_cursor || null;
                } while (cursor);
                const choices = options.filter((event) => event.date !== booking.date && event.remaining >= Number(booking.party_size));
                container.replaceChildren(...choices.map((event) => {
                    const option = document.createElement('button'); option.type = 'button'; option.textContent = `${event.date} · ${event.start_time} · ${event.remaining} vaga(s)`;
                    option.addEventListener('click', () => {
                        for (const item of container.querySelectorAll('button')) item.classList.remove('selected');
                        option.classList.add('selected'); button.dataset.target = JSON.stringify({ date: event.date }); button.disabled = false;
                    });
                    return option;
                }));
                if (!choices.length) container.textContent = 'Nenhuma outra data com vagas disponíveis para este evento.';
            } catch (problem) { container.textContent = ''; showError(problem.message); }
        })();
        return;
    }
    const button = rescheduleForm(`<div><label for="date">Nova data</label> <input id="date" type="date" min="${minDate}" value="${minDate}"></div><div id="slots" class="slots" role="group" aria-label="Horários disponíveis"></div>`);
    const date = $('#date');
    date.addEventListener('change', async () => {
        const container = $('#slots'); container.textContent = 'Buscando horários…'; button.disabled = true;
        try {
            const query = new URLSearchParams({ date: date.value, reschedule_booking_id: config.bookingId });
            const result = await request(`/api/${encodeURIComponent(config.slug)}/availability?${query}`);
            container.replaceChildren(...result.slots.filter((slot) => !(slot.time === booking.time && date.value === booking.date)).map((slot) => {
                const option = document.createElement('button'); option.type = 'button'; option.textContent = slot.time;
                option.addEventListener('click', () => {
                    for (const item of container.querySelectorAll('button')) item.classList.remove('selected');
                    option.classList.add('selected'); button.dataset.target = JSON.stringify({ new_date: date.value, new_time: slot.time }); button.disabled = false;
                });
                return option;
            }));
            if (!result.slots.length) container.textContent = 'Nenhum horário disponível nesta data.';
        } catch (problem) { container.textContent = ''; showError(problem.message); }
    });
    date.dispatchEvent(new Event('change'));
}

load().catch((problem) => { status.textContent = 'Não foi possível carregar o agendamento.'; showError(problem.message); });
