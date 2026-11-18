import { BookingManagementProblem, cancelManagedBooking, getManagedBooking } from '../services/booking-management.js';
import { exchangeManageCapability, manageCookieName, readManageToken } from '../services/customer-capabilities.js';
import { rescheduleTimeslotBooking } from '../services/timeslot-reschedule.js';
import { rescheduleOtherPattern } from '../services/pattern-reschedule.js';

function sameOrigin(request) {
    let origin;
    try { origin = new URL(request.headers.origin).hostname.toLowerCase(); } catch { return false; }
    return origin !== '' && origin === request.hostname.toLowerCase();
}

function protect(reply) {
    return reply
        .header('Cache-Control', 'no-store, private')
        .header('Referrer-Policy', 'no-referrer')
        .header('X-Robots-Tag', 'noindex, nofollow');
}

function problem(reply, error) {
    if (!(error instanceof BookingManagementProblem)) throw error;
    const body = { error: error.code };
    if (error.fields) body.errors = error.fields;
    return protect(reply).code(error.statusCode).send(body);
}

async function tenantBySlug(db, slug) {
    const { rows } = await db.query("SELECT id FROM tenants WHERE slug = $1 AND status = 'active' LIMIT 1", [slug]);
    return rows[0] ?? null;
}

export async function registerCustomerManagementRoutes(app, { db }) {
    app.post('/api/:slug/customer-access', async (request, reply) => {
        if (!sameOrigin(request)) return protect(reply).code(403).send({ error: 'csrf_mismatch' });
        const body = request.body;
        const slug = request.params.slug;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return protect(reply).code(400).send({ error: 'invalid_json' });
        }
        const tenant = await tenantBySlug(db, slug);
        const subjectId = typeof body.subject_id === 'string' ? body.subject_id : '';
        const token = typeof body.token === 'string' ? body.token : '';
        if (body.purpose !== 'booking.manage' || !tenant
            || !await exchangeManageCapability(db, tenant, subjectId, token)) {
            return protect(reply).code(403).send({ error: 'verification_required' });
        }
        const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
        const cookie = `${manageCookieName(subjectId)}=${token}; Path=/; Max-Age=7776000; HttpOnly; SameSite=Lax${secure}`;
        return protect(reply).header('Set-Cookie', cookie).send({ verified: true });
    });

    app.get('/api/:slug/bookings/:id', async (request, reply) => {
        try {
            const result = await getManagedBooking(
                db, request.params.slug, request.params.id, readManageToken(request, request.params.id),
            );
            return protect(reply).send(result);
        } catch (error) {
            return problem(reply, error);
        }
    });

    app.post('/api/:slug/bookings/:id/cancel', async (request, reply) => {
        if (!sameOrigin(request)) return protect(reply).code(403).send({ error: 'csrf_mismatch' });
        try {
            const reason = request.body?.reason ?? '';
            const result = await cancelManagedBooking(
                db, request.params.slug, request.params.id, readManageToken(request, request.params.id), reason,
            );
            return protect(reply).send(result);
        } catch (error) {
            return problem(reply, error);
        }
    });

    app.post('/api/:slug/bookings/:id/reschedule', async (request, reply) => {
        if (!sameOrigin(request)) return protect(reply).code(403).send({ error: 'csrf_mismatch' });
        const token = readManageToken(request, request.params.id);
        try {
            const managed = await getManagedBooking(db, request.params.slug, request.params.id, token);
            if (!managed.can_reschedule) throw new BookingManagementProblem(managed.reschedule_reason, 409);
            const result = managed.booking.booking_pattern === 'timeslot'
                ? await rescheduleTimeslotBooking(db, request.params.slug, request.params.id, token, request.body)
                : await rescheduleOtherPattern(db, request.params.slug, request.params.id, token, request.body);
            const newId = result.new_booking_id;
            const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
            const cookies = [
                `${manageCookieName(newId)}=${token}; Path=/; Max-Age=7776000; HttpOnly; SameSite=Lax${secure}`,
                `${manageCookieName(request.params.id)}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`,
            ];
            return protect(reply).header('Set-Cookie', cookies).send(result);
        } catch (error) {
            return problem(reply, error);
        }
    });
}
