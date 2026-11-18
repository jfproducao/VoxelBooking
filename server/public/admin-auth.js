async function submit(form, action) {
    const values = Object.fromEntries(new FormData(form));
    const error = form.querySelector('.error') || document.querySelector('#error');
    const button = form.querySelector('button[type="submit"]');
    error.textContent = '';
    button.disabled = true;
    try {
        const paths = { login: '/admin/login', logout: '/admin/logout', password: '/admin/password',
            'request-auth': '/admin/login/request', 'verify-otp': '/admin/login/verify-code',
            'forgot-password': '/admin/forgot-password', 'reset-password': '/admin/reset-password' };
        const response = await fetch(form.dataset.endpoint || paths[action] || '/admin/password', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...values, remember_me: values.remember_me === '1' }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
            error.textContent = body.error === 'rate_limited' ? 'Muitas tentativas. Aguarde e tente novamente.'
                : body.error === 'csrf_mismatch' ? 'A sessão expirou. Recarregue a página.'
                    : body.error === 'password_mismatch' ? 'As senhas não coincidem.'
                        : body.error === 'invalid_code' ? 'Código inválido ou expirado.'
                            : body.error === 'email_delivery_failed' ? 'Não foi possível enviar o e-mail.'
                                    : body.error === 'inventory_conflict' ? 'O horário ou a vaga não está mais disponível.'
                                        : body.error === 'invalid_transition' ? 'Essa mudança de status não é permitida.'
                                            : action === 'login' ? 'E-mail ou senha inválidos.' : 'Não foi possível concluir a solicitação.';
            return;
        }
        if (body.code_sent) {
            const verify = document.querySelector('#verify-section');
            verify.hidden = false;
            verify.querySelector('[name="email"]').value = body.email;
            error.textContent = 'Código enviado. Confira seu e-mail.';
            return;
        }
        if (body.requested) {
            error.textContent = action === 'forgot-password' ? 'Se o endereço estiver cadastrado, enviaremos um link de redefinição.'
                : 'Se o endereço estiver cadastrado, enviaremos as instruções por e-mail.';
            form.reset();
            return;
        }
        if (body.redirect) location.assign(body.redirect);
    } catch {
        error.textContent = 'Falha de conexão. Tente novamente.';
    } finally {
        button.disabled = false;
    }
}

for (const form of document.querySelectorAll('form[data-action]')) {
    form.addEventListener('submit', (event) => {
        event.preventDefault();
        submit(form, form.dataset.action);
    });
}
