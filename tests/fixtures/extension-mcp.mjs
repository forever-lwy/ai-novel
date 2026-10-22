// Local acceptance fixture. It never connects to an external service.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
const server = new McpServer({ name: 'extension-fixture', version: '1.0.0' });
server.registerTool('echo', { description: '回传测试文字', inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: 'text', text: `${text}:${process.env.MCP_FIXTURE_SECRET ?? 'no-secret'}` }] }));
await server.connect(new StdioServerTransport());
