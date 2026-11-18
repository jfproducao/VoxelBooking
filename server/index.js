import { buildApp } from './app.js';
import { closePool, getPool } from './db/pool.js';

const app = buildApp({ db: getPool() });

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const host = process.env.HOST ?? '0.0.0.0';

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
        app.log.info({ signal }, 'Shutting down');
        await app.close();
        await closePool();
        process.exit(0);
    });
}

try {
    await app.listen({ port, host });
} catch (error) {
    app.log.error(error);
    await closePool();
    process.exit(1);
}
