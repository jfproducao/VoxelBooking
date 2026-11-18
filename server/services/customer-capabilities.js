import { createHash, randomBytes } from 'node:crypto';

const COOKIE_PREFIX = 'vb_manage_';

export function manageCookieName(bookingId) {
    return `${COOKIE_PREFIX}${bookingId}`;
}

export function readManageToken(request, bookingId) {
    const headerToken = request.headers['x-customer-capability'];
    if (typeof headerToken === 'string' && /^[a-f0-9]{64}$/.test(headerToken)) return headerToken;
    const wanted = manageCookieName(bookingId);
    for (const segment of String(request.headers.cookie ?? '').split(';')) {
        const separator = segment.indexOf('=');
        if (separator < 0 || segment.slice(0, separator).trim() !== wanted) continue;
        try {
            const token = decodeURIComponent(segment.slice(separator + 1).trim());
            return /^[a-f0-9]{64}$/.test(token) ? token : null;
        } catch {
            return null;
        }
    }
    return null;
}

export async function verifyManageCapability(db, tenantId, bookingId, token, now = Date.now()) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const { rows } = await db.query(
        `SELECT capability.id, capability.customer_id
         FROM customer_capabilities capability
         JOIN bookings booking ON booking.id = capability.subject_id
             AND booking.tenant_id = capability.tenant_id
             AND booking.customer_id = capability.customer_id
         JOIN customers customer ON customer.id = booking.customer_id
             AND customer.tenant_id = booking.tenant_id
         JOIN tenants tenant ON tenant.id = booking.tenant_id
         WHERE capability.token_hash = $1 AND capability.purpose = 'booking.manage'
           AND capability.tenant_id = $2 AND capability.subject_id = $3
           AND capability.revoked_at IS NULL AND capability.expires_at > $4::timestamp
           AND customer.is_anonymized = FALSE AND tenant.status = 'active'
         LIMIT 1`,
        [tokenHash, tenantId, bookingId, new Date(now).toISOString().slice(0, 19).replace('T', ' ')],
    );
    return rows[0] ?? null;
}

export async function exchangeManageCapability(db, tenant, bookingId, token, now = Date.now()) {
    const grant = await verifyManageCapability(db, tenant.id, bookingId, token, now);
    if (!grant) return false;
    await db.query(
        `INSERT INTO audit_log (id, tenant_id, actor_type, actor_id, action, entity_type, entity_id, details)
         VALUES ($1, $2, 'customer', NULL, 'customer.access_verified', 'customer_capability', NULL, $3::jsonb)`,
        [
            createUlid(now), tenant.id,
            JSON.stringify({ purpose: 'booking.manage', subject_id: bookingId }),
        ],
    );
    return true;
}

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function createUlid(now) {
    let value = (BigInt(now) << 80n) | BigInt(`0x${cryptoRandom(10)}`);
    let result = '';
    for (let index = 0; index < 26; index++) {
        result = alphabet[Number(value & 31n)] + result;
        value >>= 5n;
    }
    return result;
}

function cryptoRandom(length) {
    return randomBytes(length).toString('hex');
}
