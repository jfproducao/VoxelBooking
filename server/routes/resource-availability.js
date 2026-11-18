import { isValidDate } from '../time/venue-time.js';
import { getResourceAvailableDates, quoteResourceStay } from '../services/resource-availability.js';
import { BookingManagementProblem, getManagedBooking } from '../services/booking-management.js';
import { readManageToken } from '../services/customer-capabilities.js';

async function rescheduleContext(db, request, business) {
    const id = request.query.reschedule_booking_id;
    if (!id) return { excludeBookingId: null };
    try {
        const managed = await getManagedBooking(db, request.params.slug, id, readManageToken(request, id));
        if (!managed.can_reschedule) return { error: managed.reschedule_reason || 'rescheduling_disabled', statusCode: 409 };
        if (managed.booking.booking_pattern !== 'resource' || managed.booking.resource_id !== request.params.id) {
            return { error: 'reschedule_context_mismatch', statusCode: 422 };
        }
        return { excludeBookingId: managed.booking.id };
    } catch (error) {
        if (error instanceof BookingManagementProblem) return { error: error.code, statusCode: error.statusCode };
        throw error;
    }
}

async function tenant(db, slug) {
    const { rows } = await db.query(
        "SELECT id,slug,booking_pattern,timezone,min_advance_hours,max_advance_days FROM tenants WHERE slug=$1 AND status='active' LIMIT 1",
        [slug],
    );
    return rows[0] ?? null;
}

function monthParts(query) {
    const year = query.year === undefined ? new Date().getUTCFullYear() : Number(query.year);
    const month = query.month === undefined ? new Date().getUTCMonth() + 1 : Number(query.month);
    if (!Number.isInteger(year) || year < 1 || year > 9999 || !Number.isInteger(month) || month < 1 || month > 12) return null;
    return { year, month };
}

export async function registerResourceAvailabilityRoutes(app, { db }) {
    app.get('/api/:slug/resources/:id/availability', async (request, reply) => {
        const business = await tenant(db, request.params.slug);
        if (!business) return reply.code(404).send({ error: 'tenant_not_found' });
        if (business.booking_pattern !== 'resource') return reply.code(422).send({ error: 'pattern_not_supported' });
        const context = await rescheduleContext(db, request, business);
        if (context.error) return reply.code(context.statusCode).send({ error: context.error });

        const checkIn = request.query.check_in;
        const checkOut = request.query.check_out;
        if (checkIn !== undefined || checkOut !== undefined) {
            if (!isValidDate(checkIn) || !isValidDate(checkOut)) return reply.code(422).send({ error: 'invalid_date' });
            const guestCount = Number(request.query.guests ?? request.query.guest_count ?? 1);
            const quote = await quoteResourceStay(db, business, request.params.id, checkIn, checkOut, guestCount, context);
            if (quote.error === 'resource_not_found') return reply.code(404).send({ error: quote.error });
            return reply.header('Cache-Control', 'no-store').send(quote);
        }

        const month = monthParts(request.query);
        if (!month) return reply.code(422).send({ error: 'invalid_month' });
        try {
            const result = await getResourceAvailableDates(db, business, request.params.id, month.year, month.month, context);
            return reply.header('Cache-Control', 'no-store').send(result);
        } catch (error) {
            if (error.code === 'not_found') return reply.code(404).send({ error: 'not_found' });
            throw error;
        }
    });
}
