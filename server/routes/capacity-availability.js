import { BookingManagementProblem, getManagedBooking } from '../services/booking-management.js';
import { getCapacityAvailableDates, getCapacitySlots } from '../services/capacity-availability.js';
import { readManageToken } from '../services/customer-capabilities.js';
import { isValidDate } from '../time/venue-time.js';

function partySize(value) {
    if (value === undefined) return 1;
    if (!/^\d+$/.test(String(value))) return null;
    const size = Number(value);
    return Number.isSafeInteger(size) && size >= 1 && size <= 10_000 ? size : null;
}

async function rescheduleContext(db, request) {
    const id = request.query.reschedule_booking_id;
    if (!id) return { excludeBookingId: null, booking: null };
    try {
        const managed = await getManagedBooking(db, request.params.slug, id, readManageToken(request, id));
        if (!managed.can_reschedule) return { error: managed.reschedule_reason || 'rescheduling_disabled', statusCode: 409 };
        if (managed.booking.booking_pattern !== 'capacity') return { error: 'reschedule_context_mismatch', statusCode: 422 };
        return { excludeBookingId: managed.booking.id, booking: managed.booking };
    } catch (error) {
        if (error instanceof BookingManagementProblem) return { error: error.code, statusCode: error.statusCode };
        throw error;
    }
}

export async function registerCapacityAvailabilityRoutes(app, { db }) {
    app.get('/api/:slug/capacity/available-dates', async (request, reply) => {
        const { rows } = await db.query(
            "SELECT id,booking_pattern,timezone,min_advance_hours,max_advance_days FROM tenants WHERE slug=$1 AND status='active' LIMIT 1", [request.params.slug],
        );
        const tenant = rows[0];
        if (!tenant) return reply.code(404).send({ error: 'tenant_not_found' });
        if (tenant.booking_pattern !== 'capacity') return reply.code(422).send({ error: 'pattern_not_supported' });
        const context = await rescheduleContext(db, request);
        if (context.error) return reply.code(context.statusCode).send({ error: context.error });
        const year = request.query.year === undefined ? Number(new Intl.DateTimeFormat('en', { timeZone: tenant.timezone || 'UTC', year: 'numeric' }).format(new Date())) : Number(request.query.year);
        const month = request.query.month === undefined ? Number(new Intl.DateTimeFormat('en', { timeZone: tenant.timezone || 'UTC', month: 'numeric' }).format(new Date())) : Number(request.query.month);
        const size = partySize(request.query.party_size ?? context.booking?.party_size);
        if (!Number.isInteger(year) || year < 1 || year > 9999 || !Number.isInteger(month) || month < 1 || month > 12) return reply.code(422).send({ error: 'invalid_month' });
        if (size === null) return reply.code(422).send({ error: 'invalid_party_size' });
        const dates = await getCapacityAvailableDates(db, tenant, year, month, size, context);
        return reply.header('Cache-Control', 'no-store').send({ dates, year, month });
    });
    app.get('/api/:slug/capacity/slots', async (request, reply) => {
        const { rows } = await db.query(
            "SELECT id,booking_pattern,timezone,min_advance_hours,max_advance_days FROM tenants WHERE slug=$1 AND status='active' LIMIT 1", [request.params.slug],
        );
        const tenant = rows[0];
        if (!tenant) return reply.code(404).send({ error: 'tenant_not_found' });
        if (tenant.booking_pattern !== 'capacity') return reply.code(422).send({ error: 'pattern_not_supported' });
        const context = await rescheduleContext(db, request);
        if (context.error) return reply.code(context.statusCode).send({ error: context.error });
        const size = partySize(request.query.party_size ?? context.booking?.party_size);
        if (size === null) return reply.code(422).send({ error: 'invalid_party_size' });
        if (!isValidDate(request.query.date)) return reply.code(422).send({ error: 'invalid_date' });
        const slots = await getCapacitySlots(db, tenant, request.query.date, size, context);
        return reply.header('Cache-Control', 'no-store').send({ slots, date: request.query.date, timezone: tenant.timezone || 'UTC' });
    });
}
