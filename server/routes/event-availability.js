import { getEventDetail, listEventOccurrences } from '../services/event-availability.js';
import { isValidDate } from '../time/venue-time.js';
import { BookingManagementProblem, getManagedBooking } from '../services/booking-management.js';
import { readManageToken } from '../services/customer-capabilities.js';

async function rescheduleContext(db, request) {
    const id = request.query.reschedule_booking_id;
    if (!id) return { excludeBookingId: null, booking: null };
    try {
        const managed = await getManagedBooking(db, request.params.slug, id, readManageToken(request, id));
        if (!managed.can_reschedule) return { error: managed.reschedule_reason || 'rescheduling_disabled', statusCode: 409 };
        if (managed.booking.booking_pattern !== 'event') return { error: 'reschedule_context_mismatch', statusCode: 422 };
        return { excludeBookingId: managed.booking.id, booking: managed.booking };
    } catch (error) {
        if (error instanceof BookingManagementProblem) return { error: error.code, statusCode: error.statusCode };
        throw error;
    }
}

export async function registerEventAvailabilityRoutes(app, { db }) {
    app.get('/api/:slug/events', async (request, reply) => {
        const { rows } = await db.query(
            "SELECT id,booking_pattern,timezone,min_advance_hours,max_advance_days FROM tenants WHERE slug=$1 AND status='active' LIMIT 1",
            [request.params.slug],
        );
        const tenant = rows[0];
        if (!tenant) return reply.code(404).send({ error: 'tenant_not_found' });
        if (tenant.booking_pattern !== 'event') return reply.code(422).send({ error: 'pattern_not_supported' });
        const { date, month } = request.query;
        const context = await rescheduleContext(db, request);
        if (context.error) return reply.code(context.statusCode).send({ error: context.error });
        const eventId = request.query.event_id ?? context.booking?.event_id ?? null;
        if (context.booking && request.query.event_id && request.query.event_id !== context.booking.event_id) return reply.code(422).send({ error: 'reschedule_context_mismatch' });
        if (date !== undefined && month !== undefined) return reply.code(422).send({ error: 'choose_date_or_month' });
        if (date !== undefined && !isValidDate(date)) return reply.code(422).send({ error: 'invalid_date' });
        if (month !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return reply.code(422).send({ error: 'invalid_month' });
        const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) return reply.code(422).send({ error: 'invalid_limit' });
        let offset = 0; let snapshot;
        if (request.query.cursor) {
            try {
                const cursor = JSON.parse(Buffer.from(request.query.cursor, 'base64url').toString('utf8'));
                if (cursor.date !== (date ?? null) || cursor.month !== (month ?? null) || cursor.eventId !== eventId
                    || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0
                    || typeof cursor.snapshot !== 'string' || cursor.snapshot.length > 26) throw new Error('invalid_cursor');
                offset = cursor.offset; snapshot = cursor.snapshot;
            } catch { return reply.code(422).send({ error: 'invalid_cursor' }); }
        } else {
            const { rows: snapshots } = await db.query('SELECT MAX(id) AS id FROM events WHERE tenant_id=$1', [tenant.id]);
            snapshot = snapshots[0]?.id ?? '';
        }
        const found = await listEventOccurrences(db, tenant, { date, month, eventId, excludeBookingId: context.excludeBookingId, limit: limit + 1, offset, snapshot });
        const hasMore = found.length > limit;
        const events = hasMore ? found.slice(0, limit) : found;
        const nextCursor = hasMore ? Buffer.from(JSON.stringify({
            offset: offset + events.length, snapshot, date: date ?? null, month: month ?? null, eventId,
        })).toString('base64url') : null;
        return reply.header('Cache-Control', 'no-store').send({ events, next_cursor: nextCursor });
    });
    app.get('/api/:slug/events/:id', async (request, reply) => {
        const { rows } = await db.query(
            "SELECT id,booking_pattern,timezone,min_advance_hours,max_advance_days FROM tenants WHERE slug=$1 AND status='active' LIMIT 1",
            [request.params.slug],
        );
        const tenant = rows[0];
        if (!tenant) return reply.code(404).send({ error: 'tenant_not_found' });
        if (tenant.booking_pattern !== 'event') return reply.code(422).send({ error: 'pattern_not_supported' });
        const context = await rescheduleContext(db, request);
        if (context.error) return reply.code(context.statusCode).send({ error: context.error });
        if (context.booking && request.params.id !== context.booking.event_id) return reply.code(422).send({ error: 'reschedule_context_mismatch' });
        if (request.query.date !== undefined && !isValidDate(request.query.date)) return reply.code(422).send({ error: 'invalid_date' });
        const event = await getEventDetail(db, tenant, request.params.id, request.query.date, context);
        if (!event) return reply.code(404).send({ error: 'event_not_found' });
        return reply.header('Cache-Control', 'no-store').send({ event });
    });
}
