import { buildApp } from './app.js';
import { secureDataDirectory } from './private-files.js';
try { process.loadEnvFile(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
process.env.NODE_ENV ||= import.meta.url.endsWith('.ts') ? 'development' : 'production';
secureDataDirectory(process.env.DATA_DIR || './data');
const { app } = await buildApp({ logger: true });
if (!process.env.TRUSTED_PROXIES && process.env.PUBLIC_ORIGIN) app.log.warn('未配置 TRUSTED_PROXIES；反向代理部署请填写明确的代理地址。');
if (!process.env.PUBLIC_ORIGIN && !['127.0.0.1', 'localhost', '::1'].includes(process.env.HOST || '127.0.0.1')) app.log.warn('首次安装码保存在数据目录 .setup-token；开放公网前请配置 PUBLIC_ORIGIN 和 HTTPS。');
else if (process.env.PUBLIC_ORIGIN || process.env.NODE_ENV === 'production') app.log.info('首次安装时请在服务器读取数据目录 .setup-token，完成设密后该文件自动删除。');
await app.listen({ host: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT || 4317) });
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => { if (closing) return; closing = true; await app.close(); process.exit(0); });
