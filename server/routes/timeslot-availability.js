import { isValidDate, utcRange } from '../time/venue-time.js';
import { AvailabilityProblem, getTimeslotAvailability, getTimeslotAvailableDates } from '../services/timeslot-availability.js';
import { BookingManagementProblem, getManagedBooking } from '../services/booking-management.js';
import { readManageToken } from '../services/customer-capabilities.js';

async function activeTenant(db, slug) {
    const { rows } = await db.query(
        `SELECT id, slug, booking_pattern, timezone, slot_duration_minutes, buffer_minutes,
                min_advance_hours, max_advance_days
         FROM tenants WHERE slug = $1 AND status = 'active' LIMIT 1`,
        [slug],
    );
    return rows[0] ?? null;
}

function requestProblem(query, reply) {
    if (query.cursor) {
        reply.code(422).send({ error: 'invalid_cursor' });
        return true;
    }
    return false;
}

async function selectionForRequest(db, request) {
    const query = request.query;
    if (!query.reschedule_booking_id) {
        return { serviceId: query.service_id || null, staffId: query.staff_id || null };
    }
    try {
        const managed = await getManagedBooking(
            db,
            request.params.slug,
            query.reschedule_booking_id,
            readManageToken(request, query.reschedule_booking_id),
        );
        if (!managed.can_reschedule) {
            throw new AvailabilityProblem(managed.reschedule_reason || 'rescheduling_unavailable', 409);
        }
        const booking = managed.booking;
        if ((booking.service_id && query.service_id && query.service_id !== booking.service_id)
            || (booking.staff_id && query.staff_id && query.staff_id !== booking.staff_id)) {
            throw new AvailabilityProblem('reschedule_context_mismatch');
        }
        return {
            serviceId: booking.service_id,
            staffId: booking.staff_id ?? query.staff_id ?? null,
            excludeBookingId: booking.id,
            durationOverride: Math.max(1, Math.round((Date.parse(booking.end_utc) - Date.parse(booking.start_utc)) / 60_000)),
        };
    } catch (error) {
        if (error instanceof AvailabilityProblem) throw error;
        if (error instanceof BookingManagementProblem) throw new AvailabilityProblem(error.code, error.statusCode);
        throw error;
    }
}

function respondProblem(reply, error) {
    if (!(error instanceof AvailabilityProblem)) throw error;
    reply.code(error.statusCode).send({ error: error.code });
}

export async function registerTimeslotAvailabilityRoutes(app, { db }) {
    app.get('/api/:slug/availability', async (request, reply) => {
        if (requestProblem(request.query, reply)) return;
        const tenant = await activeTenant(db, request.params.slug);
        if (!tenant) return reply.code(404).send({ error: 'tenant_not_found' });
        if (tenant.booking_pattern !== 'timeslot') return reply.code(422).send({ error: 'pattern_not_supported' });

        const date = request.query.date;
        if (!isValidDate(date)) return reply.code(422).send({ error: date ? 'invalid_date' : 'validation_failed' });
        try {
            const selection = await selectionForRequest(db, request);
            const slots = await getTimeslotAvailability(db, tenant, {
                date,
                ...selection,
            });
            const choices = slots.map((slot) => ({
                ...slot,
                date,
                ...utcRange(date, slot.time, date, slot.end_time, tenant.timezone || 'UTC'),
            }));
            return reply.header('Cache-Control', 'no-store').send({ slots: choices, date, timezone: tenant.timezone || 'UTC' });
        } catch (error) {
            return respondProblem(reply, error);
        }
    });

    app.get('/api/:slug/available-dates', async (request, reply) => {
        if (requestProblem(request.query, reply)) return;
        const tenant = await activeTenant(db, request.params.slug);
        if (!tenant) return reply.code(404).send({ error: 'tenant_not_found' });
        if (tenant.booking_pattern !== 'timeslot') return reply.code(422).send({ error: 'pattern_not_supported' });

        const now = Date.now();
        const current = new Date(now);
        const year = request.query.year === undefined ? current.getUTCFullYear() : Number(request.query.year);
        const month = request.query.month === undefined ? current.getUTCMonth() + 1 : Number(request.query.month);
        const monthString = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
        if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(monthString)) return reply.code(422).send({ error: 'invalid_month' });

        try {
            const selection = await selectionForRequest(db, request);
            const dates = await getTimeslotAvailableDates(db, tenant, {
                year,
                month,
                ...selection,
                now,
            });
            return reply.header('Cache-Control', 'no-store').send({ dates, year, month });
        } catch (error) {
            return respondProblem(reply, error);
        }
    });
}
