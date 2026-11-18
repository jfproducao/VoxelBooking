import assert from 'node:assert/strict';
import test from 'node:test';
import {
    canonicalCell, insertSql, mapRow, mysqlConfig, mysqlSelectColumns,
    stableJson, validateTableShape,
} from '../../scripts/migrate-mysql-to-supabase.js';

test('MySQL-to-PostgreSQL conversion retains JSON nulls, boolean values, and decimal strings', () => {
    const source = {
        names: ['id', 'enabled', 'price', 'payload'],
        primaryKey: ['id'],
        dataTypes: new Map([['id', 'char'], ['enabled', 'tinyint'], ['price', 'decimal'], ['payload', 'json']]),
    };
    const target = [
        { column_name: 'id', data_type: 'character' },
        { column_name: 'enabled', data_type: 'boolean' },
        { column_name: 'price', data_type: 'numeric' },
        { column_name: 'payload', data_type: 'jsonb' },
    ];
    const selected = mysqlSelectColumns(source);
    assert.match(selected, /CAST\(`payload` AS CHAR\) AS `payload`/);
    assert.deepEqual(mapRow({ id: '01', enabled: 0, price: '12.30', payload: 'null' }, source.names, target), [
        '01', false, '12.30', 'null',
    ]);
    assert.equal(canonicalCell('null', target[3]), 'null');
    assert.equal(mapRow({ id: '02', enabled: 1, price: '0.10', payload: '{"b":2,"a":1}' }, source.names, target)[1], true);
});

test('import preflight rejects schema drift and a table without a primary key', () => {
    const source = { names: ['id', 'legacy_value'], primaryKey: ['id'] };
    assert.throws(() => validateTableShape('example', source, [
        { column_name: 'id', is_nullable: 'NO', column_default: null, is_generated: 'NEVER', is_identity: 'NO' },
    ]), /columns missing from PostgreSQL: legacy_value/);
    assert.throws(() => validateTableShape('example', { names: ['id'], primaryKey: [] }, [
        { column_name: 'id', is_nullable: 'NO', column_default: null, is_generated: 'NEVER', is_identity: 'NO' },
    ]), /no primary key/);
    assert.throws(() => validateTableShape('example', { names: ['id'], primaryKey: ['id'] }, [
        { column_name: 'id', is_nullable: 'NO', column_default: null, is_generated: 'NEVER', is_identity: 'NO' },
        { column_name: 'required_target_only', is_nullable: 'NO', column_default: null, is_generated: 'NEVER', is_identity: 'NO' },
    ]), /required columns missing from MySQL/);
});

test('checksums normalize JSON object key order and SQL stays parameterized', () => {
    const target = { data_type: 'jsonb' };
    assert.equal(canonicalCell('{"z":1,"a":[true,null]}', target), canonicalCell('{"a":[true,null],"z":1}', target));
    assert.equal(stableJson({ b: 1, a: ['x', 2] }), '{"a":["x",2],"b":1}');
    assert.equal(insertSql('customers', ['id', 'name'], 2), 'INSERT INTO public."customers" ("id", "name") VALUES ($1, $2), ($3, $4)');
    assert.throws(() => insertSql('customers;DROP TABLE tenants', ['id'], 1), /Unexpected database identifier/);
});

test('MySQL source URL enables UTC wall-clock reads and TLS when requested', () => {
    const config = mysqlConfig('mysql://readonly:secret@db.example:3306/voxelbooking?ssl-mode=REQUIRED');
    assert.equal(config.host, 'db.example');
    assert.equal(config.database, 'voxelbooking');
    assert.equal(config.timezone, 'Z');
    assert.equal(config.dateStrings, true);
    assert.equal(config.decimalNumbers, false);
    assert.equal(config.ssl.rejectUnauthorized, true);
    assert.equal(config.password, 'secret');
});
