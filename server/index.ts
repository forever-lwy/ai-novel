import { buildApp } from './app.js';
try { process.loadEnvFile(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
const { app } = await buildApp({ logger: true });
await app.listen({ host: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT || 4317) });
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => { if (closing) return; closing = true; await app.close(); process.exit(0); });
