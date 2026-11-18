const catalog = {
    services: {
        fields: 'id, name, description, duration_minutes, price, price_label, category, preparation_text, cover_image_path, color, is_virtual, requires_staff, sort_order',
        numbers: ['duration_minutes', 'sort_order'],
        paths: ['cover_image_path'],
    },
    staff: {
        fields: 'id, name, title, avatar_path, sort_order',
        numbers: ['sort_order'],
        paths: ['avatar_path'],
    },
    resources: {
        fields: 'id, name, description, capacity, amenities, price_per_night, min_stay_nights, max_stay_nights, check_in_days, check_out_days, cover_image_path, sort_order',
        numbers: ['capacity', 'min_stay_nights', 'max_stay_nights', 'sort_order'],
        json: ['amenities', 'check_in_days', 'check_out_days'],
        paths: ['cover_image_path'],
    },
};

async function activeTenant(db, slug) {
    const { rows } = await db.query(
        "SELECT id, slug, booking_pattern FROM tenants WHERE slug = $1 AND status = 'active' LIMIT 1",
        [slug],
    );
    return rows[0] ?? null;
}

function normalizeRows(rows, definition) {
    return rows.map((source) => {
        const row = { ...source };
        for (const key of definition.numbers ?? []) {
            if (row[key] !== null && row[key] !== undefined) row[key] = Number(row[key]);
        }
        for (const key of definition.json ?? []) {
            if (typeof row[key] === 'string') {
                try { row[key] = JSON.parse(row[key]); } catch { row[key] = null; }
            }
        }
        for (const key of definition.paths ?? []) {
            if (row[key]) row[key] = `/${String(row[key]).replace(/^\/+/, '')}`;
        }
        for (const key of ['price', 'price_per_night']) {
            if (row[key] !== null && row[key] !== undefined) row[key] = String(row[key]);
        }
        return row;
    });
}

export async function registerPublicCatalogRoutes(app, { db }) {
    for (const [kind, definition] of Object.entries(catalog)) {
        app.get(`/api/:slug/${kind}`, async (request, reply) => {
            const tenant = await activeTenant(db, request.params.slug);
            if (!tenant) return reply.code(404).send({ error: 'tenant_not_found' });

            const parameters = [tenant.id];
            let where = 'tenant_id = $1 AND is_active = TRUE';
            if (kind === 'staff' && request.query.service_id) {
                const service = await db.query(
                    'SELECT id FROM services WHERE id = $1 AND tenant_id = $2 AND is_active = TRUE LIMIT 1',
                    [request.query.service_id, tenant.id],
                );
                if (service.rowCount === 0) return reply.code(404).send({ error: 'not_found' });
                parameters.push(request.query.service_id);
                where += ' AND id IN (SELECT staff_id FROM service_staff WHERE service_id = $2)';
            }

            const { rows } = await db.query(
                `SELECT ${definition.fields} FROM ${kind} WHERE ${where} ORDER BY ${kind === 'resources' || kind === 'services' || kind === 'staff' ? 'sort_order, id' : 'id'}`,
                parameters,
            );
            reply.header('Cache-Control', 'no-store');
            return { [kind]: normalizeRows(rows, definition) };
        });
    }
}
