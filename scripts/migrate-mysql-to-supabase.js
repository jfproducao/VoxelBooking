import mysql from 'mysql2/promise';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const { Pool, types } = pg;
types.setTypeParser(1082, (value) => value);
types.setTypeParser(1114, (value) => value);

const batchSize = 100;
const ignoredMysqlTables = new Set(['migrations']);
const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'db', 'migrations', '0001_legacy_schema.sql');
const schemaSql = readFileSync(schemaPath, 'utf8');
const migrationTables = [...schemaSql.matchAll(/^CREATE TABLE IF NOT EXISTS ([a-z][a-z0-9_]*)\s*\(/gim)].map((match) => match[1]);

class ImportProblem extends Error {}

function safeIdentifier(name) {
    if (!/^[a-z][a-z0-9_]*$/i.test(name)) throw new ImportProblem('Unexpected database identifier in schema metadata.');
    return name;
}

function quotePg(name) { return `"${safeIdentifier(name)}"`; }
function quoteMysql(name) { return `\`${safeIdentifier(name)}\``; }

export function mysqlConfig(connectionString) {
    const url = new URL(connectionString);
    if (!['mysql:', 'mariadb:'].includes(url.protocol)) throw new ImportProblem('MYSQL_URL must use mysql:// or mariadb://.');
    const sslMode = (url.searchParams.get('ssl-mode') || url.searchParams.get('sslmode') || '').toUpperCase();
    const disabled = ['DISABLED', 'DISABLE', 'OFF', 'FALSE', '0'].includes(sslMode);
    const enabled = ['REQUIRED', 'VERIFY_CA', 'VERIFY_IDENTITY', 'TRUE', '1'].includes(sslMode);
    const ssl = disabled ? undefined : enabled || process.env.MYSQL_SSL_CA
        ? { rejectUnauthorized: true, ...(process.env.MYSQL_SSL_CA ? { ca: readFileSync(process.env.MYSQL_SSL_CA, 'utf8') } : {}) }
        : undefined;
    return {
        host: url.hostname,
        port: Number(url.port || 3306),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database: decodeURIComponent(url.pathname.replace(/^\//, '')),
        ssl,
        timezone: 'Z',
        dateStrings: true,
        supportBigNumbers: true,
        bigNumberStrings: true,
        decimalNumbers: false,
        connectionLimit: 2,
        connectTimeout: 10_000,
    };
}

async function getMysqlTables(pool) {
    const [rows] = await pool.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name`,
    );
    return rows.map((row) => row.TABLE_NAME ?? row.table_name);
}

async function getMysqlColumns(pool, table) {
    const [rows] = await pool.query(
        `SELECT column_name, ordinal_position, column_key, data_type FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position`,
        [table],
    );
    const names = rows.map((row) => row.COLUMN_NAME ?? row.column_name);
    const dataTypes = new Map(rows.map((row) => [
        row.COLUMN_NAME ?? row.column_name,
        String(row.DATA_TYPE ?? row.data_type).toLowerCase(),
    ]));
    const primaryKey = rows.filter((row) => (row.COLUMN_KEY ?? row.column_key) === 'PRI')
        .sort((a, b) => Number(a.ORDINAL_POSITION ?? a.ordinal_position) - Number(b.ORDINAL_POSITION ?? b.ordinal_position))
        .map((row) => row.COLUMN_NAME ?? row.column_name);
    return { names, primaryKey, dataTypes };
}

export function mysqlSelectColumns(sourceColumns) {
    return sourceColumns.names.map((name) => sourceColumns.dataTypes.get(name) === 'json'
        ? `CAST(${quoteMysql(name)} AS CHAR) AS ${quoteMysql(name)}`
        : quoteMysql(name)).join(', ');
}

async function getPgColumns(client, table) {
    const { rows } = await client.query(
        `SELECT column_name, ordinal_position, data_type, udt_name, is_nullable,
                column_default, is_generated, is_identity
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
        [table],
    );
    return rows;
}

async function countMysql(pool, table) {
    const [rows] = await pool.query(`SELECT COUNT(*) AS row_count FROM ${quoteMysql(table)}`);
    return Number(rows[0].row_count);
}

async function countPg(client, table) {
    const { rows } = await client.query(`SELECT COUNT(*)::bigint AS row_count FROM public.${quotePg(table)}`);
    return Number(rows[0].row_count);
}

export function mapRow(row, sourceColumns, targetColumns) {
    const targetByName = new Map(targetColumns.map((column) => [column.column_name, column]));
    return sourceColumns.map((name) => {
        const value = row[name];
        if (value === null || value === undefined) return null;
        const target = targetByName.get(name);
        if (target.data_type === 'boolean') {
            if (value === true || value === 1 || value === '1') return true;
            if (value === false || value === 0 || value === '0') return false;
            throw new ImportProblem(`Boolean conversion failed for ${name}.`);
        }
        if (target.data_type === 'json' || target.data_type === 'jsonb') {
            return typeof value === 'string' ? value : JSON.stringify(value);
        }
        return value;
    });
}

export function validateTableShape(table, source, target) {
    const sourceNames = new Set(source.names);
    const targetNames = new Set(target.map((column) => column.column_name));
    const sourceOnly = source.names.filter((name) => !targetNames.has(name));
    if (sourceOnly.length) throw new ImportProblem(`${table}: columns missing from PostgreSQL: ${sourceOnly.join(', ')}.`);
    const sourceTargetOnly = target.filter((column) => !sourceNames.has(column.column_name)
        && column.is_nullable === 'NO' && column.column_default === null
        && column.is_generated === 'NEVER' && column.is_identity === 'NO');
    if (sourceTargetOnly.length) {
        throw new ImportProblem(`${table}: PostgreSQL has required columns missing from MySQL: ${sourceTargetOnly.map((column) => column.column_name).join(', ')}.`);
    }
    if (!source.primaryKey.length) throw new ImportProblem(`${table}: MySQL table has no primary key, so a stable import order cannot be guaranteed.`);
}

export function insertSql(table, columns, rowCount) {
    const quotedTable = `public.${quotePg(table)}`;
    const quotedColumns = columns.map(quotePg).join(', ');
    const values = [];
    for (let row = 0; row < rowCount; row++) {
        const placeholders = columns.map((_, column) => `$${row * columns.length + column + 1}`);
        values.push(`(${placeholders.join(', ')})`);
    }
    return `INSERT INTO ${quotedTable} (${quotedColumns}) VALUES ${values.join(', ')}`;
}

export function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

export function canonicalCell(value, target) {
    if (value === null || value === undefined) return null;
    if (target.data_type === 'boolean') return value === true || value === 1 || value === '1';
    if (target.data_type === 'json' || target.data_type === 'jsonb') {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        return stableJson(parsed);
    }
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString('base64');
    if (['smallint', 'integer', 'bigint', 'numeric', 'decimal', 'real', 'double precision'].includes(target.data_type)) {
        return String(value);
    }
    return String(value);
}

async function checksumMysqlTable(mysqlPool, table, sourceColumns, targetColumns, rowCount) {
    const hash = createHash('sha256');
    const columns = mysqlSelectColumns(sourceColumns);
    const orderBy = sourceColumns.primaryKey.map(quoteMysql).join(', ');
    const targetByName = new Map(targetColumns.map((column) => [column.column_name, column]));
    for (let offset = 0; offset < rowCount; offset += batchSize) {
        const [rows] = await mysqlPool.query(
            `SELECT ${columns} FROM ${quoteMysql(table)} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
            [batchSize, offset],
        );
        for (const row of rows) {
            const canonical = sourceColumns.names.map((name) => canonicalCell(row[name], targetByName.get(name)));
            hash.update(stableJson(canonical)); hash.update('\n');
        }
    }
    return hash.digest('hex');
}

async function checksumPgTable(pgClient, table, sourceColumns, targetColumns, rowCount) {
    const hash = createHash('sha256');
    const columns = sourceColumns.names.map(quotePg).join(', ');
    const orderBy = sourceColumns.primaryKey.map(quotePg).join(', ');
    const targetByName = new Map(targetColumns.map((column) => [column.column_name, column]));
    for (let offset = 0; offset < rowCount; offset += batchSize) {
        const { rows } = await pgClient.query(
            `SELECT ${columns} FROM public.${quotePg(table)} ORDER BY ${orderBy} LIMIT $1 OFFSET $2`,
            [batchSize, offset],
        );
        for (const row of rows) {
            const canonical = sourceColumns.names.map((name) => canonicalCell(row[name], targetByName.get(name)));
            hash.update(stableJson(canonical)); hash.update('\n');
        }
    }
    return hash.digest('hex');
}

async function importTable(mysqlPool, pgPool, table, sourceColumns, targetColumns, sourceRowCount) {
    const pgClient = await pgPool.connect();
    let inserted = 0;
    try {
        await pgClient.query('BEGIN');
        const selectedColumns = mysqlSelectColumns(sourceColumns);
        const orderBy = sourceColumns.primaryKey.map(quoteMysql).join(', ');
        while (inserted < sourceRowCount) {
            const [rows] = await mysqlPool.query(
                `SELECT ${selectedColumns} FROM ${quoteMysql(table)} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
                [batchSize, inserted],
            );
            if (!rows.length) break;
            const values = rows.flatMap((row) => mapRow(row, sourceColumns.names, targetColumns));
            await pgClient.query(insertSql(table, sourceColumns.names, rows.length), values);
            inserted += rows.length;
            console.info(`  ${table}: ${inserted}/${sourceRowCount}`);
        }
        const finalCount = await countPg(pgClient, table);
        if (inserted !== sourceRowCount || finalCount !== sourceRowCount) {
            throw new ImportProblem(`${table}: expected ${sourceRowCount} rows, imported ${inserted}, found ${finalCount}.`);
        }
        const [sourceHash, targetHash] = await Promise.all([
            checksumMysqlTable(mysqlPool, table, sourceColumns, targetColumns, sourceRowCount),
            checksumPgTable(pgClient, table, sourceColumns, targetColumns, sourceRowCount),
        ]);
        if (sourceHash !== targetHash) throw new ImportProblem(`${table}: source and destination checksums differ.`);
        await pgClient.query('COMMIT');
        return inserted;
    } catch (error) {
        try { await pgClient.query('ROLLBACK'); } catch { /* Preserve the original error. */ }
        throw error;
    } finally {
        pgClient.release();
    }
}

async function main() {
    if (!process.env.MYSQL_URL || !process.env.DATABASE_URL) {
        throw new ImportProblem('Set MYSQL_URL (read-only source) and DATABASE_URL (empty Supabase target).');
    }
    const apply = process.argv.includes('--apply');
    const verifyOnly = process.argv.includes('--verify');
    if (apply && verifyOnly) throw new ImportProblem('Use either --apply or --verify, not both.');
    if (apply && !process.argv.includes('--confirm-empty-target')) {
        throw new ImportProblem('Import stopped. First run the dry-run, then pass --apply --confirm-empty-target for an empty Supabase project.');
    }
    if (process.env.NODE_ENV === 'production') throw new ImportProblem('Run the one-time importer outside the production web service.');

    const mysqlPool = mysql.createPool(mysqlConfig(process.env.MYSQL_URL));
    const pgPool = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: 2,
        connectionTimeoutMillis: 10_000,
        options: '-c timezone=UTC',
        ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' },
        application_name: 'voxelbooking-data-import',
    });

    try {
        const mysqlConnection = await mysqlPool.getConnection();
        const pgClient = await pgPool.connect();
        try {
            await mysqlConnection.ping();
            await pgClient.query('SELECT 1');
        } finally {
            mysqlConnection.release();
            pgClient.release();
        }

        const sourceTables = new Set(await getMysqlTables(mysqlPool));
        const targetTables = new Set((await pgPool.query(
            "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'",
        )).rows.map((row) => row.table_name));
        const missingSource = migrationTables.filter((table) => !sourceTables.has(table));
        const missingTarget = migrationTables.filter((table) => !targetTables.has(table));
        const unexpectedSource = [...sourceTables].filter((table) => !migrationTables.includes(table) && !ignoredMysqlTables.has(table));
        if (missingSource.length) throw new ImportProblem(`MySQL source is missing expected tables: ${missingSource.join(', ')}.`);
        if (missingTarget.length) throw new ImportProblem(`Supabase schema is missing tables; run npm run db:migrate first: ${missingTarget.join(', ')}.`);
        if (unexpectedSource.length) throw new ImportProblem(`Review unported MySQL tables before importing: ${unexpectedSource.join(', ')}.`);

        const summary = [];
        for (const table of migrationTables) {
            const sourceColumns = await getMysqlColumns(mysqlPool, table);
            const targetColumns = await getPgColumns(pgPool, table);
            validateTableShape(table, sourceColumns, targetColumns);
            const sourceCount = await countMysql(mysqlPool, table);
            const targetCount = await countPg(pgPool, table);
            summary.push({ table, sourceColumns, targetColumns, sourceCount, targetCount });
        }

        console.info(`Preflight: ${summary.length} tables from MySQL -> Supabase PostgreSQL`);
        for (const item of summary) console.info(`${item.table}: MySQL=${item.sourceCount}, Supabase=${item.targetCount}`);
        if (verifyOnly) {
            const mismatches = summary.filter((item) => item.sourceCount !== item.targetCount);
            for (const item of summary) {
                if (item.sourceCount !== item.targetCount) continue;
                const [sourceHash, targetHash] = await Promise.all([
                    checksumMysqlTable(mysqlPool, item.table, item.sourceColumns, item.targetColumns, item.sourceCount),
                    checksumPgTable(pgPool, item.table, item.sourceColumns, item.targetColumns, item.sourceCount),
                ]);
                if (sourceHash !== targetHash) mismatches.push(item);
                else console.info(`${item.table}: row count and SHA-256 content checksum match.`);
            }
            if (mismatches.length) throw new ImportProblem(`Verification failed for: ${mismatches.map((item) => item.table).join(', ')}.`);
            console.info(`Verification passed: ${summary.length} tables match MySQL row-for-row.`);
            return;
        }
        if (!apply) {
            console.info('Dry run only. No rows were written. Stop MySQL writes and rehearse on an empty staging Supabase project before importing.');
            return;
        }
        const occupied = summary.filter((item) => item.targetCount !== 0);
        if (occupied.length) throw new ImportProblem(`Supabase target must be empty. Non-empty tables: ${occupied.map((item) => `${item.table}(${item.targetCount})`).join(', ')}.`);

        const sourceFingerprint = createHash('sha256').update(summary.map(({ table, sourceCount }) => `${table}:${sourceCount}`).join('\n')).digest('hex');
        console.info(`Starting import. Source row-count fingerprint: ${sourceFingerprint}`);
        let total = 0;
        for (const item of summary) {
            if (item.sourceCount === 0) continue;
            const imported = await importTable(mysqlPool, pgPool, item.table, item.sourceColumns, item.targetColumns, item.sourceCount);
            total += imported;
        }
        console.info(`Import finished: ${total} rows across ${summary.length} tables.`);
        console.info('Run npm run db:verify:mysql next and compare business invariants before cutover.');
    } finally {
        await mysqlPool.end();
        await pgPool.end();
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        if (error instanceof ImportProblem) console.error(`MySQL to Supabase import failed: ${error.message}`);
        else console.error(`MySQL to Supabase import failed (${error.code || error.name || 'unknown error'}); database details were suppressed.`);
        process.exitCode = 1;
    });
}
