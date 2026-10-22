import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { RequestInit as UndiciRequestInit } from 'undici';
import type { McpConnection, McpToolDefinition, ScriptTool } from '../shared/extensions.js';
import { providerFetch } from './outbound.js';

export const EXTENSION_OUTPUT_BYTES = 64 * 1024;
const MCP_RESPONSE_BYTES = 2 * 1024 * 1024;
export function executionSignal(timeoutMs: number, signal?: AbortSignal) {
  return AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
}
const runner = `
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { code, args } = JSON.parse(input);
console.log = console.info = console.warn = (...values) => process.stderr.write(values.map(String).join(' ') + '\\n');
try {
  const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
  const result = await new AsyncFunction('args', code)(args);
  const output = JSON.stringify(result ?? null);
  process.stdout.write(output, () => process.exit(0));
} catch (error) { process.stderr.write(String(error?.message ?? error), () => process.exit(1)); }
`;

/** A separate process provides cancellation/resource bounds, not a security sandbox. */
export async function executeScript(tool: ScriptTool, args: Record<string, unknown>, cwd: string, parent?: AbortSignal): Promise<unknown> {
  const signal = executionSignal(tool.timeoutMs, parent);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--max-old-space-size=64', '--input-type=module', '-e', runner], { cwd, env: getDefaultEnvironment(), shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const output: Buffer[] = [], errors: Buffer[] = []; let size = 0, errorSize = 0; let failure: Error | undefined;
    const stop = () => {
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
        killer.on('error', () => child.kill('SIGKILL'));
        killer.on('exit', () => child.kill('SIGKILL'));
      } else if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const abort = () => { failure = new Error(parent?.aborted ? '工具执行已取消。' : '脚本执行超时，已停止进程。'); stop(); };
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > EXTENSION_OUTPUT_BYTES) { failure = new Error('脚本输出超过 64 KiB，已停止进程。'); stop(); } else output.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { errorSize += chunk.length; if (errorSize <= 16384) errors.push(chunk); });
    child.stdin.on('error', () => undefined);
    child.on('error', error => { signal.removeEventListener('abort', abort); reject(error); });
    child.on('close', code => {
      signal.removeEventListener('abort', abort);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(`脚本执行失败：${Buffer.concat(errors).toString('utf8').slice(0, 2000) || `退出码 ${code}`}`));
      try { resolve(JSON.parse(Buffer.concat(output).toString('utf8'))); }
      catch { reject(new Error('脚本没有返回可解析的 JSON 结果。请使用 return 返回数据。')); }
    });
    child.stdin.end(JSON.stringify({ code: tool.code, args }));
    if (signal.aborted) abort();
  });
}

async function withMcp<T>(server: McpConnection, cwd: string, parent: AbortSignal | undefined, action: (client: Client, signal: AbortSignal) => Promise<T>): Promise<T> {
  const signal = executionSignal(server.timeoutMs, parent); signal.throwIfAborted();
  const client = new Client({ name: 'ai-novel', version: '1.0.0' }, { capabilities: {} });
  const transport = server.transport === 'stdio'
    ? new StdioClientTransport({ command: server.command, args: server.args, env: { ...getDefaultEnvironment(), ...server.env }, cwd, stderr: 'ignore', maxBufferSize: MCP_RESPONSE_BYTES })
    : new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: server.headers, redirect: 'error' },
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
      fetch: async (input, init) => {
        const url = input;
        if (new URL(url).origin !== new URL(server.url).origin) throw new Error('MCP 请求不能转到其他来源。');
        const response = await providerFetch(url, { ...init, signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) } as UndiciRequestInit);
        // Bound JSON and SSE bytes before the SDK parses them.
        let bytes = 0;
        const reader = response.body?.getReader();
        const body = reader ? new ReadableStream<Uint8Array>({ async pull(controller) {
          const part = await reader.read();
          if (part.done) { reader.releaseLock(); controller.close(); return; }
          bytes += part.value.byteLength;
          if (bytes > MCP_RESPONSE_BYTES) { await reader.cancel(); throw new Error('MCP 响应超过 2 MiB。'); }
          controller.enqueue(part.value);
        }, async cancel() { await reader.cancel(); } }) : null;
        return new Response(body, { status: response.status, statusText: response.statusText, headers: [...response.headers] });
      },
    });
  const abort = () => { void client.close().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    await client.connect(transport, { signal, timeout: server.timeoutMs });
    return await action(client, signal);
  } catch (error) {
    if (error instanceof StreamableHTTPError && error.code) throw new Error(`MCP HTTP ${error.code}：${error.message}`);
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

export async function discoverMcp(server: McpConnection, cwd: string, parent?: AbortSignal): Promise<McpToolDefinition[]> {
  return withMcp(server, cwd, parent, async (client, signal) => {
    const tools: McpToolDefinition[] = []; const cursors = new Set<string>(); let cursor: string | undefined;
    do {
      const result = await client.listTools(cursor ? { cursor } : undefined, { signal, timeout: server.timeoutMs });
      for (const tool of result.tools) tools.push({ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema });
      if (tools.length > 200) throw new Error('每个 MCP 服务最多导入 200 个工具。');
      cursor = result.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('MCP 工具目录返回了重复分页标记。');
      if (cursor) cursors.add(cursor);
      if (cursors.size > 20) throw new Error('MCP 工具目录分页超过上限。');
    } while (cursor);
    return tools;
  });
}

export async function executeMcp(server: McpConnection, name: string, args: Record<string, unknown>, cwd: string, parent?: AbortSignal) {
  return withMcp(server, cwd, parent, async (client, signal) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { signal, timeout: server.timeoutMs });
    if (Buffer.byteLength(JSON.stringify(result)) > EXTENSION_OUTPUT_BYTES) throw new Error('MCP 工具已经执行，但结果超过 64 KiB；请缩小结果范围，不要盲目重复有副作用的操作。');
    return result.isError ? { error: 'MCP 工具返回失败。', ...result } : result;
  });
}
