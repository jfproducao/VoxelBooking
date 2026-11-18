import pg from 'pg';
import { readFileSync } from 'node:fs';

const { Pool, types } = pg;

// The legacy app stores venue wall-clock values as MySQL DATETIME. Keep these
// values as strings; the default pg parser turns them into JS Dates and applies
// the host timezone, which can silently shift appointments.
types.setTypeParser(1082, (value) => value); // date
types.setTypeParser(1114, (value) => value); // timestamp without time zone

let pool;

export function getPool() {
    if (pool) return pool;

    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        throw new Error('DATABASE_URL must point to the Supabase PostgreSQL database.');
    }

    const ssl = process.env.DATABASE_SSL === 'false'
        ? false
        : {
            rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false',
            ...(process.env.DATABASE_SSL_CA ? { ca: readFileSync(process.env.DATABASE_SSL_CA, 'utf8') } : {}),
        };

    pool = new Pool({
        connectionString,
        max: Number.parseInt(process.env.DATABASE_POOL_MAX ?? '5', 10),
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
        options: '-c timezone=UTC',
        ssl,
        application_name: 'voxelbooking-node',
    });

    pool.on('error', (error) => {
        // Pool-level errors happen on idle clients and must not expose connection details.
        console.error('Unexpected PostgreSQL pool error:', error.message);
    });

    return pool;
}

export async function closePool() {
    if (!pool) return;
    const current = pool;
    pool = undefined;
    await current.end();
}
