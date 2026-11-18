import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { closePool, getPool } from './pool.js';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const lockId = '762908314207';

async function migrate() {
    const pool = getPool();
    const client = await pool.connect();
    let locked = false;

    try {
        await client.query('SELECT pg_advisory_lock($1::bigint)', [lockId]);
        locked = true;
        await client.query(`
            CREATE TABLE IF NOT EXISTS app_migrations (
                version text PRIMARY KEY,
                applied_at timestamptz NOT NULL DEFAULT now()
            )
        `);

        const applied = new Set(
            (await client.query('SELECT version FROM app_migrations')).rows.map((row) => row.version),
        );
        const files = (await readdir(migrationsDir))
            .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
            .sort();

        let count = 0;
        for (const file of files) {
            if (applied.has(file)) continue;
            const sql = await readFile(path.join(migrationsDir, file), 'utf8');
            await client.query('BEGIN');
            try {
                await client.query(sql);
                await client.query('INSERT INTO app_migrations (version) VALUES ($1)', [file]);
                await client.query('COMMIT');
            } catch (error) {
                await client.query('ROLLBACK');
                throw new Error(`Migration ${file} failed: ${error.message}`, { cause: error });
            }
            console.info(`Applied ${file}`);
            count++;
        }

        console.info(count === 0 ? 'PostgreSQL schema is current.' : `Applied ${count} migration(s).`);
    } finally {
        if (locked) await client.query('SELECT pg_advisory_unlock($1::bigint)', [lockId]);
        client.release();
        await closePool();
    }
}

migrate().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
