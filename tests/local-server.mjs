import { once } from 'node:events';
import { createRequire } from 'node:module';

// Match the installed fetch implementation's actual forbidden ports. Windows
// can allocate these even for listen(0), which fails before a fixture sees HTTP.
const { badPortsSet } = createRequire(import.meta.url)('undici/lib/web/fetch/constants.js');

export async function listenLocalServer(server, host = '127.0.0.1') {
  for (let attempt = 0; attempt < 16; attempt++) {
    server.listen(0, host);
    await once(server, 'listening');
    if (!badPortsSet.has(String(server.address().port))) return;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  throw new Error('无法为本地测试服务分配 Fetch 可访问的端口。');
}
