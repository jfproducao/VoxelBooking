import Fastify from 'fastify';
import { getPool } from './db/pool.js';
import { registerPublicCatalogRoutes } from './routes/public-catalog.js';
import { registerTimeslotAvailabilityRoutes } from './routes/timeslot-availability.js';
import { registerTimeslotBookingRoutes } from './routes/timeslot-bookings.js';
import { registerCustomerManagementRoutes } from './routes/customer-management.js';
import { registerPublicPageRoutes } from './routes/public-pages.js';
import { registerResourceAvailabilityRoutes } from './routes/resource-availability.js';
import { registerCapacityAvailabilityRoutes } from './routes/capacity-availability.js';
import { registerEventAvailabilityRoutes } from './routes/event-availability.js';
import { installAdminAuthHook, registerAdminAuthRoutes } from './routes/admin-auth.js';
import { registerAdminCalendarRoutes } from './routes/admin-calendar.js';
import { registerAdminServiceRoutes } from './routes/admin-services.js';
import { registerAdminStaffRoutes } from './routes/admin-staff.js';
import { registerAdminAvailabilityRoutes } from './routes/admin-availability.js';
import { registerAdminBlockedDateRoutes } from './routes/admin-blocked-dates.js';

export function buildApp({ db = getPool() } = {}) {
    const app = Fastify({
        logger: process.env.NODE_ENV !== 'test',
        trustProxy: process.env.TRUST_PROXY === 'true',
        bodyLimit: 1_048_576,
    });

    app.addHook('onSend', async (request, reply, payload) => {
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header('X-XSS-Protection', '0');
        if (!reply.hasHeader('Referrer-Policy')) {
            reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
        }
        reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
        reply.header('X-Frame-Options', 'SAMEORIGIN');
        reply.header(
            'Content-Security-Policy',
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
        );
        if (request.url.startsWith('/api/') && !reply.hasHeader('Cache-Control')) {
            reply.header('Cache-Control', 'no-store');
        }
        return payload;
    });

    installAdminAuthHook(app, { db });

    app.get('/healthz', async (_request, reply) => {
        try {
            await db.query('SELECT 1');
            return { status: 'ok', database: 'connected' };
        } catch {
            return reply.code(503).send({ status: 'unavailable', database: 'unavailable' });
        }
    });

    app.register(registerPublicCatalogRoutes, { db });
    app.register(registerTimeslotAvailabilityRoutes, { db });
    app.register(registerResourceAvailabilityRoutes, { db });
    app.register(registerCapacityAvailabilityRoutes, { db });
    app.register(registerEventAvailabilityRoutes, { db });
    app.register(registerTimeslotBookingRoutes, { db });
    app.register(registerCustomerManagementRoutes, { db });
    app.register(registerPublicPageRoutes, { db });
    app.register(registerAdminAuthRoutes, { db });
    app.register(registerAdminCalendarRoutes, { db });
    app.register(registerAdminServiceRoutes, { db });
    app.register(registerAdminStaffRoutes, { db });
    app.register(registerAdminAvailabilityRoutes, { db });
    app.register(registerAdminBlockedDateRoutes, { db });

    app.setNotFoundHandler((_request, reply) => {
        reply.code(404).send({ error: 'not_found' });
    });

    app.setErrorHandler((error, _request, reply) => {
        app.log.error({ err: error }, 'Unhandled request error');
        reply.code(500).send({ error: 'internal_error' });
    });

    return app;
}
