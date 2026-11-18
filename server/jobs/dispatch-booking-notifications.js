import { closePool, getPool } from '../db/pool.js';
import { dispatchBookingNotifications } from '../services/booking-notifications.js';

try {
    await getPool().query('DELETE FROM admin_sessions WHERE expires_at <= NOW()');
    const counts = await dispatchBookingNotifications(getPool(), Number(process.env.OUTBOX_BATCH_SIZE || 25));
    process.stdout.write(`${JSON.stringify(counts)}\n`);
} catch (error) {
    process.stderr.write(`booking notification dispatch failed: ${error.message}\n`);
    process.exitCode = 1;
} finally {
    await closePool();
}
