import { BookingProblem, createTimeslotBooking } from '../services/timeslot-booking.js';
import { getTimeslotAvailability } from '../services/timeslot-availability.js';
import { utcRange } from '../time/venue-time.js';
import { createResourceBooking } from '../services/resource-booking.js';
import { createCapacityBooking } from '../services/capacity-booking.js';
import { createEventBooking } from '../services/event-booking.js';

async function alternatives(db, slug, body) {
    try {
        const { rows } = await db.query(
            `SELECT id, slug, booking_pattern, timezone, slot_duration_minutes, buffer_minutes,
                    min_advance_hours, max_advance_days
             FROM tenants WHERE slug = $1 AND status = 'active' LIMIT 1`,
            [slug],
        );
        const tenant = rows[0];
        if (!tenant || tenant.booking_pattern !== 'timeslot') return [];
        const slots = await getTimeslotAvailability(db, tenant, {
            date: body.date,
            serviceId: body.service_id || null,
            staffId: body.staff_id || null,
        });
        return slots.slice(0, 3).map((slot) => ({
            ...slot,
            date: body.date,
            ...utcRange(body.date, slot.time, body.date, slot.end_time, tenant.timezone || 'UTC'),
        }));
    } catch {
        return [];
    }
}

export async function registerTimeslotBookingRoutes(app, { db }) {
    app.post('/api/:slug/bookings', async (request, reply) => {
        try {
            const create = request.body?.booking_pattern === 'resource' ? createResourceBooking
                : request.body?.booking_pattern === 'capacity' ? createCapacityBooking
                    : request.body?.booking_pattern === 'event' ? createEventBooking : createTimeslotBooking;
            const booking = await create(db, request.params.slug, request.body, {
                origin: request.headers.origin,
                host: request.hostname,
                ip: request.ip,
            });
            reply.header('Cache-Control', 'no-store, private');
            reply.header('Referrer-Policy', 'no-referrer');
            reply.header('X-Robots-Tag', 'noindex, nofollow');
            return reply.code(201).send({ booking });
        } catch (error) {
            if (error instanceof BookingProblem) {
                const body = { error: error.code };
                if (error.fields) body.errors = error.fields;
                if (error.code === 'slot_unavailable' && request.body?.booking_pattern === 'timeslot') {
                    body.alternatives = await alternatives(db, request.params.slug, request.body ?? {});
                }
                return reply.code(error.statusCode).send(body);
            }
            request.log.error({ err: error }, 'Booking creation failed');
            return reply.code(500).send({ error: 'booking_failed' });
        }
    });
}
